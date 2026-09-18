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
	type PersonView,
	type SetRetentionInput
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { invalidateDirectoryOptions } from '../cache/directory';
import { getDb } from '../db';
import {
	exchangeMessages,
	interactionParties,
	interactions,
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
 * Следы человека за пределами карточки: контрагент-физлицо, названный его ФИО,
 * взаимодействия с этим ФИО в заголовке и тела сообщений обмена по ним.
 *
 * Заявка физического лица с сайта заводит организацию, у которой название и
 * есть ФИО (`exchange/intake.ts`), заголовок взаимодействия собирается из того
 * же ФИО, а сообщение, которым заявка приехала, лежит в журнале обмена. Стереть
 * только строку `people` значит объявить данные уничтоженными, оставив три их
 * копии в соседних таблицах.
 *
 * Название организации заменяется, а не стирается: это её единственное имя, и
 * пустая строка сделала бы справочник нечитаемым. В заголовках меняется ровно
 * прежнее название — точной подстрокой, а не по образцу: заголовок сотрудник
 * правит руками, и угадывать в нём ФИО значит однажды испортить чужой текст.
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
	}
}

/**
 * Обезличивание состоялось: подбор контактов, собранный раньше, больше не
 * показывать — выбирать контактом того, чьи данные уничтожены, незачем.
 */
async function forgotten<TResult>(result: Promise<TResult>): Promise<TResult> {
	const value = await result;

	await invalidateDirectoryOptions();

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
			const [row] = await tx
				.update(people)
				.set({
					lastName: ANONYMIZED_PERSON_LAST_NAME,
					// Пустое имя, а не прочерк: собранное из частей ФИО показывает одно
					// слово «Обезличено», и подставлять вместо стёртого имени значок,
					// который выглядит как данные, незачем.
					firstName: '',
					middleName: null,
					email: null,
					phone: null,
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
