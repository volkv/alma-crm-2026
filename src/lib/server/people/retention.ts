/**
 * Срок хранения персональных данных и их уничтожение.
 *
 * Персональные данные хранят не дольше, чем нужно для цели, ради которой их
 * собрали, и уничтожают по её достижении. В системе это два действия: назначить
 * срок и, когда он прошёл, обезличить запись — стереть фамилию, имя и контакты,
 * оставив саму строку. Удалить её нельзя: на человека ссылаются роли в
 * организациях и взаимодействия, где он был контактом, и «этого контакта у нас
 * никогда не было» — неправда.
 *
 * Обезличивание необратимо. Отменяющей команды здесь нет намеренно: то, что
 * стёрли, в базе не лежит и восстановлению не подлежит.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
	ANONYMIZED_PERSON_LAST_NAME,
	ANONYMIZED_TEXT,
	type PersonView,
	type SetRetentionInput
} from '$lib/contracts/directory';
import { EXCHANGE_EVENT_TYPES } from '$lib/contracts/exchange';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { invalidateDirectoryOptions } from '../cache/directory';
import { invalidateInteractionCards } from '../cache/interactions';
import { getDb } from '../db';
import {
	comments,
	exchangeMessages,
	interactionChanges,
	interactionParties,
	interactions,
	learningGroupLearners,
	notificationDeliveries,
	organizations,
	people
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, NotFoundError } from '../errors';
import { assertPersonVisible } from './access';
import { requirePermission } from '../rbac';
import { toPersonView } from './serialize';
import { withPiiTrace } from './pii-trace';

/**
 * Условие «срок хранения прошёл, а данные ещё на месте». Сутки считает база:
 * «сегодня» у приложения и у базы должно быть одно, иначе запись то попадает в
 * очередь на уничтожение, то нет.
 *
 * Отдельного списка под это правило нет намеренно: очередь на уничтожение —
 * тот же справочник людей с включённым фильтром, и второй список с собственным
 * поиском, сортировкой и областью доступа разошёлся бы с первым.
 */
export const retentionExpired = sql<boolean>`(
	${people.retentionUntil} is not null
	and ${people.retentionUntil} <= current_date
	and ${people.anonymizedAt} is null
)`;

/**
 * Назначает или снимает срок хранения. Снятие — это не «хранить вечно», а
 * «срок ещё не назначен»: решение принимает человек, и до него запись просто
 * ждёт.
 */
export async function setRetention(
	ctx: ActorContext,
	input: SetRetentionInput
): Promise<PersonView> {
	await requirePermission(ctx, 'people.manage_consents', {
		type: 'people.retention_changed',
		subject: { type: 'person', id: input.personId }
	});

	// Область — до всякой записи: человек вне области отвечает «не найден», как
	// и на своей карточке, и до строки в базе дело не доходит.
	await assertPersonVisible(ctx, input.personId);

	const [before] = await getDb()
		.select()
		.from(people)
		.where(eq(people.id, input.personId))
		.limit(1);

	if (before === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	if (before.anonymizedAt !== null) {
		throw new ConflictError('Данные человека обезличены: срок хранения им больше не нужен');
	}

	if (before.retentionUntil === input.retentionUntil) {
		throw new ConflictError('Срок хранения уже такой');
	}

	return withPiiTrace(ctx, () =>
		withTransaction(ctx, async (tx) => {
			const [row] = await tx
				.update(people)
				.set({ retentionUntil: input.retentionUntil, updatedAt: sql`now()` })
				.where(eq(people.id, input.personId))
				.returning();

			await recordAuditEvent(
				ctx,
				{
					type: 'people.retention_changed',
					outcome: 'success',
					subject: { type: 'person', id: row.id },
					details: { changedFields: ['retentionUntil'] }
				},
				tx
			);

			return toPersonView(ctx, row);
		})
	);
}

/**
 * Поля предметной истории правок, в прежнем значении которых стоит текст, а не
 * ссылка или срок.
 *
 * Перечислением, а не догадкой по содержимому: в `old_value` лежит `jsonb`, и
 * «похоже на фамилию» — правило, которое однажды сотрёт сумму или срок.
 * Заголовок заявки физлица и есть его ФИО, остальные поля истории —
 * ответственный, периоды, списки идентификаторов — персональных данных не
 * несут.
 */
const TEXT_CHANGE_FIELDS = ['title'] as const;

/**
 * Следы человека за пределами карточки: контрагент-физлицо, названный его ФИО,
 * взаимодействия с этим ФИО в заголовке, тела сообщений обмена по ним, текст
 * отправленных уведомлений, прежние значения правленого заголовка и текст
 * заявки, который человек написал о себе сам.
 *
 * Заявка физического лица с сайта заводит организацию, у которой название и
 * есть ФИО (`exchange/intake.ts`), заголовок взаимодействия собирается из того
 * же ФИО, а сообщение, которым заявка приехала, лежит в журнале обмена. Дальше
 * этот заголовок расходится копиями: письмо о зависшей записи уносит его в
 * `notification_deliveries` темой и телом, всякая его правка — в
 * `interaction_changes` прежним значением. Стереть только строку `people`
 * значит объявить данные уничтоженными, оставив их копии в шести соседних
 * таблицах.
 *
 * Название организации заменяется, а не стирается: это её единственное имя, и
 * пустая строка сделала бы справочник нечитаемым. В заголовках меняется ровно
 * прежнее название — точной подстрокой, а не по образцу: заголовок сотрудник
 * правит руками, и угадывать в нём ФИО значит однажды испортить чужой текст.
 *
 * Сохранённые тексты — письмо, прежнее значение поля, комментарий заявки —
 * заменяются целиком пометкой {@link ANONYMIZED_TEXT}, а не чистятся по
 * образцу: подстрока не найдёт «Иванов И.И.» и номер, разорванный переносом, а
 * найдя лишнее, испортит текст. Что было письмо, что поле правили и что заявка
 * несла текст, при этом видно — пропадает только содержание.
 *
 * Чего эта функция не трогает: комментарии сотрудников (это содержание работы,
 * а не данные человека — их писали о деле, и своей фамилии человек в них не
 * оставлял), причину правки и файлы документов. Границы названы в
 * `docs/security.md`.
 */
async function eraseCounterpartyTraces(tx: Tx, personId: string): Promise<void> {
	const counterparties = await tx
		.select({
			id: organizations.id,
			legalName: organizations.legalName,
			shortName: organizations.shortName
		})
		.from(organizations)
		.where(and(eq(organizations.personId, personId), eq(organizations.kind, 'individual')));

	for (const counterparty of counterparties) {
		await tx
			.update(organizations)
			.set({
				legalName: ANONYMIZED_PERSON_LAST_NAME,
				shortName: ANONYMIZED_PERSON_LAST_NAME,
				updatedAt: sql`now()`
			})
			.where(eq(organizations.id, counterparty.id));

		const titled = tx
			.select({ id: interactionParties.interactionId })
			.from(interactionParties)
			.where(
				and(
					eq(interactionParties.organizationId, counterparty.id),
					eq(interactionParties.isPrimary, true)
				)
			);

		await tx
			.update(interactions)
			.set({
				title: sql`replace(replace(${interactions.title}, ${counterparty.legalName}, ${ANONYMIZED_PERSON_LAST_NAME}), ${counterparty.shortName}, ${ANONYMIZED_PERSON_LAST_NAME})`,
				updatedAt: sql`now()`
			})
			.where(inArray(interactions.id, titled));

		// Тела сообщений обмена по этим взаимодействиям. Свежие несут только
		// идентификаторы и отпечатки, но журнал живёт годами, и в строках,
		// приехавших до этого правила, лежит и почта, и фамилия. Ответ и отпечаток
		// запроса остаются: по ним повтор того же сообщения по-прежнему узнаётся.
		//
		// Замороженный конверт исходящего стирается совсем: он и есть отправленное
		// тело, и «обезличенного конверта» не бывает — есть тело или его нет.
		await tx
			.update(exchangeMessages)
			.set({ payload: sql`jsonb_build_object('anonymizedAt', now())`, envelope: null })
			.where(inArray(exchangeMessages.interactionId, titled));

		// Тема и тело писем, которые система отправила по этим взаимодействиям:
		// заголовок и название стороны уходят в них снимком, собранным
		// `notifications/message.ts`, и переживают правку заголовка — ради этого их
		// и хранят. Строка журнала остаётся: «письмо было, и вот его исход».
		await tx
			.update(notificationDeliveries)
			.set({ subject: ANONYMIZED_TEXT, body: ANONYMIZED_TEXT, updatedAt: sql`now()` })
			.where(inArray(notificationDeliveries.interactionId, titled));

		// Прежние значения правленого заголовка. Замена заголовка подстрокой их не
		// достаёт: в истории лежит текст, каким он был до правки, а правка могла
		// быть и переименованием заявки в «Договор с колледжем» — тогда ФИО
		// осталось бы только здесь. Причина правки — текст сотрудника и остаётся.
		await tx
			.update(interactionChanges)
			.set({
				oldValue: sql`to_jsonb(${ANONYMIZED_TEXT}::text)`,
				newValue: sql`to_jsonb(${ANONYMIZED_TEXT}::text)`
			})
			.where(
				and(
					inArray(interactionChanges.interactionId, titled),
					inArray(interactionChanges.field, [...TEXT_CHANGE_FIELDS])
				)
			);

		// Свободный текст заявки: до четырёх тысяч знаков, которые человек написал
		// о себе сам, — интерес, комментарий, иногда второй телефон. Комментарии
		// сотрудников той же карточки не трогаются: их различает источник, а не
		// автор — подписаны и те и другие сотрудником, принимающим входящие.
		await tx
			.update(comments)
			.set({ body: ANONYMIZED_TEXT, updatedAt: sql`now()` })
			.where(
				and(inArray(comments.interactionId, titled), eq(comments.source, 'application_intake'))
			);
	}
}

/**
 * Отпечаток почты в журнале обмена.
 *
 * Заявка не кладёт в журнал ни ФИО, ни адреса — только ключ сравнения адреса,
 * тот же HMAC, что в `people.email_hash` (`exchange/intake.ts`). Ключ сравнения
 * — это по-прежнему сведения о человеке: по нему «он ли писал нам с этой почты»
 * проверяется одним сравнением, и пережить уничтожение данных он не должен.
 *
 * Ищется он ровно потому, что считается тем же ключом: значение из карточки
 * подставляется в запрос как есть, без перебора и без разбора чужих тел. Для
 * контактного лица вуза это единственный путь — организации-физлица у него нет,
 * и {@link eraseCounterpartyTraces} до его сообщений не доходит вовсе.
 *
 * Заменяется отпечаток, а не строка журнала: сообщение с заявкой вуза — история
 * обмена с организацией, и стереть её тело значило бы уничтожить чужие данные
 * заодно. Пометка на месте контакта говорит ровно то, что произошло: контакт в
 * сообщении был, и его уничтожили.
 */
async function eraseExchangeContactFingerprint(tx: Tx, emailHash: string | null): Promise<void> {
	if (emailHash === null) {
		return;
	}

	await tx
		.update(exchangeMessages)
		.set({
			payload: sql`jsonb_set(${exchangeMessages.payload}, '{data,contact}', jsonb_build_object('anonymizedAt', now()))`
		})
		.where(sql`${exchangeMessages.payload} #>> '{data,contact,emailHash}' = ${emailHash}`);
}

/**
 * Человек в поимённых списках учебных групп.
 *
 * Связь с группой удаляется: «в потоке был кто-то обезличенный» — сведение,
 * которое ни отчёту, ни процессу не нужно, а числа потока приходят из системы
 * обучения и от списка не зависят.
 *
 * Список, переданный в систему обучения, лежит в журнале обмена замороженным
 * конвертом — с ФИО и почтой открытым текстом. Такой конверт стирается совсем,
 * как у заявки физлица: «обезличенного конверта» не бывает. Ищется он по
 * нашему идентификатору человека в теле, а не по текущему составу группы:
 * человека могли убрать из списка после передачи, а отправленное от этого не
 * исчезло. Семя сообщения персональных данных не несёт и остаётся — сообщение,
 * которое ещё не ушло, соберётся заново уже без этого человека.
 */
async function eraseLearnerTraces(tx: Tx, personId: string): Promise<void> {
	await tx.delete(learningGroupLearners).where(eq(learningGroupLearners.personId, personId));

	await tx
		.update(exchangeMessages)
		.set({ envelope: null })
		.where(
			and(
				eq(exchangeMessages.direction, 'outbound'),
				eq(exchangeMessages.eventType, EXCHANGE_EVENT_TYPES.learningGroupRequested),
				sql`${exchangeMessages.payload} ->> 'includeLearners' = 'true'`,
				sql`(${exchangeMessages.envelope})::jsonb #> '{data,learners}' @> jsonb_build_array(jsonb_build_object('personId', ${personId}::text))`
			)
		);
}

/**
 * Обезличивание состоялось: собранное раньше больше не показывать.
 *
 * Подбор контактов — выбирать контактом того, чьи данные уничтожены, незачем.
 * Карточки взаимодействий — потому что `eraseCounterpartyTraces` переписывает
 * заголовки, в которых стояло ФИО, а момента последнего события по записи не
 * трогает: работы по ней не было, и двигать его ради сброса кэша значило бы
 * подделать активность. Без этой строки карточка до минуты отдавала бы из Redis
 * данные, объявленные уничтоженными.
 *
 * Обе отметки ставятся **после** фиксации транзакции: обесценить кэш до неё
 * значит открыть окно, в котором чтение соберёт заново то же самое старое.
 */
async function forgotten<TResult>(result: Promise<TResult>): Promise<TResult> {
	const value = await result;

	await Promise.all([invalidateDirectoryOptions(), invalidateInteractionCards()]);

	return value;
}

/**
 * Плановое уничтожение персональных данных: фамилия заменяется словом
 * «Обезличено», имя, отчество, контакты и заметки стираются. Роли человека и
 * его след во взаимодействиях остаются — там он больше никем не назван.
 *
 * Условие «ещё не обезличен» живёт в самом `UPDATE`: между чтением и записью
 * то же самое мог сделать кто-то другой, и второй проход стёр бы уже пустое,
 * но переписал бы дату уничтожения.
 *
 * Право своё, а не общее с учётом согласий: назначить срок и отозвать согласие
 * — решения, которые переигрывают, а это не переигрывают никак. Поэтому вести
 * основания обработки может тот, кто с данными работает, а стирать их —
 * только тот, кому это поручено отдельно.
 */
export async function anonymizePerson(ctx: ActorContext, personId: string): Promise<PersonView> {
	await requirePermission(ctx, 'people.anonymize', {
		type: 'people.anonymized',
		subject: { type: 'person', id: personId }
	});

	await assertPersonVisible(ctx, personId);

	const [before] = await getDb().select().from(people).where(eq(people.id, personId)).limit(1);

	if (before === undefined) {
		throw new NotFoundError('Человек не найден');
	}

	if (before.anonymizedAt !== null) {
		throw new ConflictError('Данные человека уже обезличены');
	}

	return forgotten(
		withTransaction(ctx, async (tx) => {
			// Ключ сравнения адреса — до того, как он будет стёрт: по нему
			// уничтожение находит отпечаток человека в журнале обмена. Строка берётся
			// под блокировку, иначе правка контакта, прошедшая между чтением до
			// транзакции и этим шагом, оставила бы в журнале отпечаток нового адреса.
			const [locked] = await tx
				.select({ emailHash: people.emailHash })
				.from(people)
				.where(eq(people.id, personId))
				.for('update');

			if (locked === undefined) {
				throw new NotFoundError('Человек не найден');
			}

			const [row] = await tx
				.update(people)
				.set({
					lastName: ANONYMIZED_PERSON_LAST_NAME,
					// Пустое имя, а не прочерк: собранное из частей ФИО показывает одно
					// слово «Обезличено», и подставлять вместо стёртого имени значок,
					// который выглядит как данные, незачем.
					firstName: '',
					middleName: null,
					// Вместе с шифртекстом стираются и ключи сравнения: HMAC адреса —
					// это по-прежнему сведения о человеке («он ли писал нам с этой
					// почты» проверяется одним сравнением), и пережить уничтожение
					// данных они не должны.
					email: null,
					emailHash: null,
					phone: null,
					phoneHash: null,
					notes: null,
					anonymizedAt: sql`now()`,
					updatedAt: sql`now()`
				})
				.where(and(eq(people.id, personId), isNull(people.anonymizedAt)))
				.returning();

			if (row === undefined) {
				throw new ConflictError('Данные человека уже обезличены');
			}

			await eraseCounterpartyTraces(tx, personId);
			await eraseExchangeContactFingerprint(tx, locked.emailHash);
			await eraseLearnerTraces(tx, personId);

			await recordAuditEvent(
				ctx,
				{
					type: 'people.anonymized',
					outcome: 'success',
					subject: { type: 'person', id: row.id },
					details: { personId: row.id }
				},
				tx
			);

			return toPersonView(ctx, row);
		})
	);
}
