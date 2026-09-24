/**
 * Поимённый список слушателей учебной группы: загрузка файлом, показ и
 * передача в систему обучения.
 *
 * Путь у человека тот же, что у других импортов: файл → предпросмотр с
 * построчными претензиями → подтверждение. Предпросмотр и подтверждение зовут
 * один и тот же разбор и одну и ту же сверку со справочником: «новый человек /
 * уже в справочнике / уже в группе» на экране — не прогноз по другим правилам,
 * а тот же расчёт.
 *
 * Человек узнаётся **по ключу сравнения почты** (`people/pii.ts`): контакты
 * лежат шифртекстом, и сравнивать можно только ключи. Совпал — связываем
 * существующего, не совпал — заводим нового; второй записи об одном человеке
 * загрузка не плодит. Ищутся только люди, которых загружающий видит: связать
 * группу с человеком чужого вуза значило бы показать его в своей карточке.
 *
 * Файл читает общий разбор таблиц (`stats/parse.ts` поверх `spreadsheet/`),
 * колонки сопоставляет общее правило синонимов, ФИО разбирает тот же разбор
 * имени, что у контактов каталога, а строку человека проверяет схема
 * справочника людей. Своего второго разбора здесь нет.
 */
import { and, asc, count, eq, exists, inArray, isNull, sql } from 'drizzle-orm';
import { createPersonSchema } from '$lib/contracts/directory';
import {
	EXCHANGE_EVENT_TYPES,
	ROSTER_MAX_ROWS,
	ROSTER_ROW_ACTIONS,
	type LearningGroupLearnerView,
	type LearningGroupRosterInput,
	type RemoveLearnerInput,
	type RosterRowAction,
	type RosterRowView,
	type RosterView
} from '$lib/contracts/exchange';
import { formatIsoDay } from '$lib/format';
import type { ActorContext } from '../../actor';
import { recordAuditEvent } from '../../audit';
import { invalidateDirectoryOptions } from '../../cache/directory';
import { getDb } from '../../db';
import {
	affiliations,
	consents,
	exchangeMessages,
	interactionParties,
	interactions,
	learningGroupLearners,
	learningGroups,
	organizations,
	people
} from '../../db/schema';
import { withTransaction, type Tx } from '../../db/transaction';
import { publishAfterCommit } from '../../live/publish';
import { contactFullName, parsePersonName, type ContactName } from '../../directory/contacts';
import { createAffiliation, createPerson } from '../../directory/write';
import { NotFoundError, ValidationError } from '../../errors';
import { interactionScopeFilter } from '../../interactions/access';
import { personVisible } from '../../people/access';
import { hashEmail, normalizeEmail } from '../../people/pii';
import { withPiiTrace } from '../../people/pii-trace';
import { toPersonView } from '../../people/serialize';
import { can, requirePermission } from '../../rbac';
import { suggestFieldMapping, type FieldSynonyms } from '../../spreadsheet/mapping';
import { readStatTable } from '../../stats/parse';
import { getExchangeSettings } from '../settings';
import { deliverMessage } from './delivery';
import { enqueueOutbound } from './outbox';
import { groupRequestExternalId } from './payloads';

/* ------------------------------------------------------------ разбор файла */

const ROSTER_FIELDS = [
	'fullName',
	'lastName',
	'firstName',
	'middleName',
	'email',
	'phone'
] as const;

type RosterField = (typeof ROSTER_FIELDS)[number];

/** Как колонки списка называют в выгрузках деканатов и в шаблонах. */
const SYNONYMS: FieldSynonyms<RosterField> = {
	fullName: ['фио', 'ф и о', 'фамилия имя отчество', 'слушатель', 'студент', 'full name'],
	lastName: ['фамилия', 'last name', 'surname'],
	firstName: ['имя', 'first name'],
	middleName: ['отчество', 'middle name', 'patronymic'],
	email: ['почта', 'электронная почта', 'email', 'e mail', 'адрес электронной почты'],
	phone: ['телефон', 'тел', 'phone', 'мобильный']
};

/**
 * Должность роли слушателя в организации. Кем человек работает или учится,
 * файл не говорит; роль закрытым списком — «другое», а должность называет,
 * откуда связь взялась.
 */
const LEARNER_POSITION = 'Слушатель учебной группы';

/** Основание обработки данных слушателя: договор с вузом, как у импорта каталога. */
const ROSTER_CONSENT_BASIS = 'contract';

/** Строка файла после разбора — до сверки со справочником. */
type ParsedRow = {
	rowNo: number;
	fullName: string;
	name: ContactName | null;
	email: string | null;
	phone: string | null;
	issues: string[];
};

type ParsedFile = { rows: ParsedRow[]; fileIssues: string[] };

function cellOf(cells: readonly string[], column: number | undefined): string {
	return column === undefined ? '' : (cells[column] ?? '').trim();
}

/** Колонки файла, сопоставленные полям: поле → номер колонки. */
function columnsOf(headers: readonly string[]): Partial<Record<RosterField, number>> {
	const mapping = suggestFieldMapping(headers, ROSTER_FIELDS, SYNONYMS);
	const columns: Partial<Record<RosterField, number>> = {};

	for (const [header, field] of Object.entries(mapping)) {
		columns[field] = headers.indexOf(header);
	}

	return columns;
}

/**
 * Файл списка: колонки, строки и претензии к каждой.
 *
 * ФИО бывает одной колонкой или тремя — оба вида встречаются в выгрузках
 * одинаково часто. Почта обязательна: по ней система обучения заводит
 * учётную запись, и по ней же мы узнаём человека. Дубль почты в файле — это
 * одна строка лишняя: загружается первая, у повтора претензия с номером
 * первой.
 */
export function readRosterFile(fileName: string, bytes: Uint8Array): ParsedFile {
	const table = readStatTable(fileName, bytes, ROSTER_MAX_ROWS);
	const columns = columnsOf(table.headers);
	const fileIssues: string[] = [...table.warnings];

	if (table.totalRows > ROSTER_MAX_ROWS) {
		fileIssues.push(
			`В файле ${table.totalRows} строк — загружаются первые ${ROSTER_MAX_ROWS}. Поток больше этого делят на несколько файлов.`
		);
	}

	const hasName =
		columns.fullName !== undefined ||
		(columns.lastName !== undefined && columns.firstName !== undefined);

	if (!hasName) {
		fileIssues.push('Нет колонки «ФИО» (или колонок «Фамилия» и «Имя»)');
	}

	if (columns.email === undefined) {
		fileIssues.push('Нет колонки «Почта»: по ней слушатель входит в систему обучения');
	}

	if (!hasName || columns.email === undefined) {
		return { rows: [], fileIssues };
	}

	const firstByEmail = new Map<string, number>();

	const rows = table.rows.map((row): ParsedRow => {
		const issues: string[] = [];
		let name: ContactName | null;
		let fullName: string;

		if (columns.fullName !== undefined) {
			fullName = cellOf(row.cells, columns.fullName).replaceAll(/\s+/g, ' ');
			name = fullName === '' ? null : parsePersonName(fullName);
		} else {
			const lastName = cellOf(row.cells, columns.lastName);
			const firstName = cellOf(row.cells, columns.firstName);
			const middleName = cellOf(row.cells, columns.middleName);

			fullName = [lastName, firstName, middleName].filter((part) => part !== '').join(' ');
			name =
				lastName === '' || firstName === ''
					? null
					: { lastName, firstName, middleName: middleName === '' ? null : middleName };
		}

		if (fullName === '') {
			issues.push('Не указано ФИО');
		} else if (name === null) {
			issues.push('ФИО не разобрано: нужны фамилия и имя, отчество — по желанию');
		}

		const emailText = cellOf(row.cells, columns.email);
		const phoneText = cellOf(row.cells, columns.phone);
		const email = emailText === '' ? null : emailText;
		const phone = phoneText === '' ? null : phoneText;

		if (email === null) {
			issues.push('Не указана почта: по ней слушатель входит в систему обучения');
		}

		// Строка человека проверяется той же схемой, что форма справочника:
		// почта и телефон, которые не пройдут там, не пройдут и здесь.
		const checked = createPersonSchema.safeParse({
			lastName: name?.lastName ?? '—',
			firstName: name?.firstName ?? '—',
			middleName: name?.middleName ?? null,
			email,
			phone,
			notes: null
		});

		if (!checked.success) {
			issues.push(...checked.error.issues.map((issue) => issue.message));
		}

		const key = email === null ? null : normalizeEmail(email);

		if (key !== null) {
			const first = firstByEmail.get(key);

			if (first === undefined) {
				firstByEmail.set(key, row.origin);
			} else {
				issues.push(`Почта повторяет строку ${first}: загрузится только первая`);
			}
		}

		return { rowNo: row.origin, fullName, name, email, phone, issues };
	});

	return { rows, fileIssues };
}

/* ------------------------------------------------------------ группа и сверка */

type RosterGroup = {
	id: string;
	interactionId: string;
	streamNumber: number;
	plannedSeats: number | null;
	startsOn: string | null;
	endsOn: string | null;
	/** Основная сторона; `null` — её нет, и роль в организации заводить не к чему. */
	organization: { id: string; kind: string } | null;
};

/**
 * Группа взаимодействия, видимого вызывающему, или `NotFoundError`. Под
 * транзакцией строка группы берётся под блокировку: две загрузки одного списка
 * одновременно иначе завели бы одного и того же нового человека дважды. Перед
 * ней — строка взаимодействия.
 */
async function readGroup(
	ctx: ActorContext,
	executor: Tx | ReturnType<typeof getDb>,
	input: LearningGroupRosterInput,
	lock: boolean
): Promise<RosterGroup> {
	const query = executor
		.select({
			id: learningGroups.id,
			interactionId: learningGroups.interactionId,
			streamNumber: learningGroups.streamNumber,
			plannedSeats: learningGroups.plannedSeats,
			startsOn: learningGroups.startsOn,
			endsOn: learningGroups.endsOn
		})
		.from(learningGroups)
		.innerJoin(interactions, eq(interactions.id, learningGroups.interactionId))
		.where(
			and(
				eq(learningGroups.id, input.learningGroupId),
				eq(learningGroups.interactionId, input.interactionId),
				interactionScopeFilter(ctx)
			)
		);

	if (lock) {
		// Порядок блокировок общий для команд группы: взаимодействие, затем
		// группа (`results.ts`, `groups.ts`). Одним запросом с соединением его не
		// задать — строки блокируются в порядке плана.
		await executor
			.select({ id: interactions.id })
			.from(interactions)
			.where(and(eq(interactions.id, input.interactionId), interactionScopeFilter(ctx)))
			.for('update');
	}

	const [group] = lock ? await query.for('update', { of: learningGroups }) : await query;

	if (group === undefined) {
		throw new NotFoundError('Учебная группа не найдена у этого взаимодействия');
	}

	const [organization] = await executor
		.select({ id: organizations.id, kind: organizations.kind })
		.from(interactionParties)
		.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
		.where(
			and(
				eq(interactionParties.interactionId, group.interactionId),
				eq(interactionParties.isPrimary, true)
			)
		)
		.limit(1);

	return { ...group, organization: organization ?? null };
}

/** Строка файла вместе с решением, что с ней делать. */
type PlannedRow = ParsedRow & { action: RosterRowAction; personId: string | null };

/**
 * Сверка строк с справочником и составом группы.
 *
 * Из нескольких людей с одной почтой берётся тот, у кого есть роль в основной
 * стороне, а из равных — заведённый раньше: так повторная загрузка того же
 * файла всегда приходит к тем же людям.
 */
async function planRows(
	ctx: ActorContext,
	executor: Tx | ReturnType<typeof getDb>,
	group: RosterGroup,
	rows: readonly ParsedRow[]
): Promise<PlannedRow[]> {
	const hashes = [
		...new Set(
			rows
				.filter((row) => row.issues.length === 0 && row.email !== null)
				.map((row) => hashEmail(row.email as string))
				.filter((hash): hash is string => hash !== null)
		)
	];

	const affiliated =
		group.organization === null
			? sql<boolean>`false`
			: exists(
					executor
						.select({ one: sql`1` })
						.from(affiliations)
						.where(
							and(
								eq(affiliations.personId, people.id),
								eq(affiliations.organizationId, group.organization.id),
								isNull(affiliations.validTo)
							)
						)
				);

	const [matches, members] = await Promise.all([
		hashes.length === 0
			? []
			: executor
					.select({ id: people.id, emailHash: people.emailHash })
					.from(people)
					.where(
						and(inArray(people.emailHash, hashes), isNull(people.anonymizedAt), personVisible(ctx))
					)
					.orderBy(sql`${affiliated} desc`, asc(people.createdAt), asc(people.id)),
		executor
			.select({ personId: learningGroupLearners.personId })
			.from(learningGroupLearners)
			.where(eq(learningGroupLearners.learningGroupId, group.id))
	]);

	const byHash = new Map<string, string>();

	for (const match of matches) {
		if (match.emailHash !== null && !byHash.has(match.emailHash)) {
			byHash.set(match.emailHash, match.id);
		}
	}

	const inGroup = new Set(members.map((member) => member.personId));

	return rows.map((row) => {
		if (row.issues.length > 0 || row.email === null) {
			return { ...row, action: 'error', personId: null };
		}

		const hash = hashEmail(row.email);
		const personId = hash === null ? null : (byHash.get(hash) ?? null);

		if (personId === null) {
			return { ...row, action: 'create', personId: null };
		}

		return { ...row, action: inGroup.has(personId) ? 'present' : 'link', personId };
	});
}

function toRosterView(rows: readonly PlannedRow[], fileIssues: string[]): RosterView {
	const counts = Object.fromEntries(ROSTER_ROW_ACTIONS.map((action) => [action, 0])) as Record<
		RosterRowAction,
		number
	>;

	for (const row of rows) {
		counts[row.action] += 1;
	}

	return {
		rows: rows.map((row): RosterRowView => ({
			rowNo: row.rowNo,
			fullName: row.name === null ? row.fullName : contactFullName(row.name),
			email: row.email,
			phone: row.phone,
			action: row.action,
			issues: row.issues
		})),
		counts,
		fileIssues
	};
}

/**
 * Предпросмотр загрузки: что станет с каждой строкой. Ничего не пишет.
 *
 * Почта и телефон в ответе — ровно те, что человек сам принёс в файле: это не
 * раскрытие данных справочника, и маскировать их незачем.
 */
export async function previewLearningGroupRoster(
	ctx: ActorContext,
	input: LearningGroupRosterInput,
	file: { name: string; bytes: Uint8Array }
): Promise<RosterView> {
	requirePermission(ctx, 'people.write');

	const db = getDb();
	const group = await readGroup(ctx, db, input, false);
	const parsed = readRosterFile(file.name, file.bytes);

	return toRosterView(await planRows(ctx, db, group, parsed.rows), parsed.fileIssues);
}

/**
 * Загрузка списка: заводит новых людей, связывает найденных и кладёт всех в
 * группу. Строка с претензией не загружается — остальные загружаются, и итог
 * показывает, какая строка чем кончилась.
 *
 * Новый человек получает основание обработки «договор» — как у импорта
 * каталога: слушателя присылает вуз по договору, а не сам человек через форму
 * согласия. Существующему основание не дописывается: у него своё, и отозванное
 * согласие загрузка файла не должна перекрывать.
 *
 * Роль в основной стороне заводится, когда сторона — организация, а не сам
 * человек, и открытой роли там у него ещё нет: без неё слушатель вуза не
 * виден среди людей этого вуза, а область доступа к нему держится именно на
 * ролях.
 */
export async function importLearningGroupRoster(
	ctx: ActorContext,
	input: LearningGroupRosterInput,
	file: { name: string; bytes: Uint8Array }
): Promise<RosterView> {
	requirePermission(ctx, 'people.write');

	const parsed = readRosterFile(file.name, file.bytes);

	if (parsed.rows.length === 0) {
		throw new ValidationError(
			'Список не загружен',
			parsed.fileIssues.length > 0 ? parsed.fileIssues : ['В файле нет ни одной строки слушателя']
		);
	}

	const view = await withTransaction(ctx, async (tx) => {
		const group = await readGroup(ctx, tx, input, true);
		publishAfterCommit(tx, group.interactionId, { type: 'interaction.changed' });
		const planned = await planRows(ctx, tx, group, parsed.rows);
		const day = formatIsoDay();
		const organization =
			group.organization !== null && group.organization.kind !== 'individual'
				? group.organization
				: null;
		let created = 0;
		let linked = 0;

		for (const row of planned) {
			if (row.action === 'error' || row.action === 'present' || row.name === null) {
				continue;
			}

			let personId = row.personId;

			if (personId === null) {
				const person = await createPerson(
					ctx,
					{
						lastName: row.name.lastName,
						firstName: row.name.firstName,
						middleName: row.name.middleName,
						email: row.email,
						phone: row.phone,
						notes: null
					},
					tx
				);

				personId = person.id;
				row.personId = personId;
				created += 1;

				// Своей вставкой, как у импорта каталога: `recordConsent` — путь
				// карточки, он открывает свою транзакцию и проверяет видимость
				// человека, которого общий пул ещё не видит.
				const [consent] = await tx
					.insert(consents)
					.values({
						personId,
						basis: ROSTER_CONSENT_BASIS,
						textVersion: day,
						givenAt: day,
						recordedBy: ctx.user?.id ?? null
					})
					.returning({ id: consents.id });

				await recordAuditEvent(
					ctx,
					{
						type: 'people.consent_recorded',
						outcome: 'success',
						subject: { type: 'consent', id: consent.id },
						details: { personId }
					},
					tx
				);
			}

			if (organization !== null) {
				const [role] = await tx
					.select({ id: affiliations.id })
					.from(affiliations)
					.where(
						and(
							eq(affiliations.personId, personId),
							eq(affiliations.organizationId, organization.id),
							isNull(affiliations.validTo)
						)
					)
					.limit(1);

				if (role === undefined) {
					await createAffiliation(
						ctx,
						{
							personId,
							organizationId: organization.id,
							siteId: null,
							position: LEARNER_POSITION,
							roleKind: 'other',
							isPrimary: false,
							validFrom: day,
							validTo: null,
							channel: null
						},
						tx
					);
				}
			}

			const inserted = await tx
				.insert(learningGroupLearners)
				.values({ learningGroupId: group.id, personId, addedBy: ctx.user?.id ?? null })
				.onConflictDoNothing()
				.returning({ personId: learningGroupLearners.personId });

			linked += inserted.length;
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'exchange.roster_loaded',
				outcome: 'success',
				subject: { type: 'interaction', id: group.interactionId },
				details: { learningGroupId: group.id, learnerCount: linked, personCount: created }
			},
			tx
		);

		return toRosterView(planned, parsed.fileIssues);
	});

	await invalidateDirectoryOptions();

	return view;
}

/* ------------------------------------------------------------ показ и правка */

/**
 * Слушатели групп взаимодействия. `null` — вызывающему люди не видны вовсе: в
 * карточке тогда только числа.
 *
 * Контакты идут через сериализатор людей: без права на персональные данные
 * они замаскированы, с правом — остаются следом просмотра в журнале.
 */
export async function listInteractionLearners(
	ctx: ActorContext,
	interactionId: string
): Promise<LearningGroupLearnerView[] | null> {
	requirePermission(ctx, 'interactions.read');

	if (!can(ctx, 'people.read')) {
		return null;
	}

	return withPiiTrace(ctx, async () => {
		const rows = await getDb()
			.select({
				learningGroupId: learningGroupLearners.learningGroupId,
				status: learningGroupLearners.status,
				addedAt: learningGroupLearners.createdAt,
				transferredAt: learningGroupLearners.transferredAt,
				person: people
			})
			.from(learningGroupLearners)
			.innerJoin(learningGroups, eq(learningGroups.id, learningGroupLearners.learningGroupId))
			.innerJoin(interactions, eq(interactions.id, learningGroups.interactionId))
			.innerJoin(people, eq(people.id, learningGroupLearners.personId))
			.where(and(eq(learningGroups.interactionId, interactionId), interactionScopeFilter(ctx)))
			.orderBy(asc(people.lastName), asc(people.firstName), asc(people.id));

		return rows.map((row) => {
			const person = toPersonView(ctx, row.person);

			return {
				learningGroupId: row.learningGroupId,
				personId: person.id,
				fullName: contactFullName(person),
				email: person.email,
				phone: person.phone,
				status: row.status,
				addedAt: row.addedAt,
				transferredAt: row.transferredAt
			};
		});
	});
}

/** Сколько человек в списках групп и сколько из них передано. */
export async function countGroupLearners(
	groupIds: readonly string[]
): Promise<Map<string, { total: number; transferred: number }>> {
	const counts = new Map<string, { total: number; transferred: number }>();

	if (groupIds.length === 0) {
		return counts;
	}

	const rows = await getDb()
		.select({
			learningGroupId: learningGroupLearners.learningGroupId,
			total: count(),
			transferred: sql<number>`count(*) filter (where ${learningGroupLearners.status} = 'transferred')::int`
		})
		.from(learningGroupLearners)
		.where(inArray(learningGroupLearners.learningGroupId, [...groupIds]))
		.groupBy(learningGroupLearners.learningGroupId);

	for (const row of rows) {
		counts.set(row.learningGroupId, { total: row.total, transferred: row.transferred });
	}

	return counts;
}

/**
 * Убрать человека из списка группы. Человек в справочнике остаётся — он мог
 * попасть в список по ошибке, а быть контактом вуза по праву. В системе
 * обучения он пропадёт со следующей передачей списка: список уходит снимком.
 */
export async function removeLearner(ctx: ActorContext, input: RemoveLearnerInput): Promise<void> {
	requirePermission(ctx, 'people.write');

	await withTransaction(ctx, async (tx) => {
		const group = await readGroup(ctx, tx, input, true);
		publishAfterCommit(tx, group.interactionId, { type: 'interaction.changed' });

		const removed = await tx
			.delete(learningGroupLearners)
			.where(
				and(
					eq(learningGroupLearners.learningGroupId, group.id),
					eq(learningGroupLearners.personId, input.personId)
				)
			)
			.returning({ personId: learningGroupLearners.personId });

		if (removed.length === 0) {
			throw new NotFoundError('Этого человека нет в списке группы');
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'exchange.learner_removed',
				outcome: 'success',
				subject: { type: 'interaction', id: group.interactionId },
				details: { learningGroupId: group.id, personId: input.personId }
			},
			tx
		);
	});
}

/* ------------------------------------------------------------ передача в LMS */

/**
 * Передать список в систему обучения — действием сотрудника, как и саму
 * заявку: поимённый список — это персональные данные, и уезжают они из CRM
 * только тогда, когда человек это решил.
 *
 * Уходит та же заявка на группу (`learning_group.requested`) с тем же ключом
 * `externalId` и полем `learners` — полным снимком состава. Отдельного
 * сообщения не нужно: система обучения по контракту узнаёт повторную заявку по
 * ключу и возвращает ту же группу, а необязательное поле — совместимое
 * добавление (`docs/exchange-contract.md`, раздел 5). Повтор той же передачи
 * дублей не даёт по той же причине: снимок заменяет состав, а не дописывает.
 *
 * Пустой список уходит, если состав этой группы уже передавали: так убранные
 * из списка пропадают и у получателя. Первой передачей пустой список не
 * уходит — получателю нечего заменять, а сотруднику нечего передавать.
 *
 * Новая передача гасит прежние, которые ещё ждут отправки или повтора: их
 * состав устарел, и отложенный повтор затёр бы им новый. Состояние у них —
 * `dismissed` с причиной словами, как у разобранных вручную; от гонки с
 * попыткой, которая уже в пути, защищает правило получателя «список старше
 * применённого не применяется» (раздел 2).
 */
export async function sendLearningGroupRoster(
	ctx: ActorContext,
	input: LearningGroupRosterInput
): Promise<{ messageId: string; delivered: boolean; error: string | null }> {
	requirePermission(ctx, 'exchange.send');

	const settings = await getExchangeSettings();

	if (settings.lms.groupsUrl === null || settings.lms.secret === null) {
		throw new ValidationError('Список не передан', [
			'Обмен с системой обучения не настроен: укажите адрес и секрет в разделе «Интеграции»'
		]);
	}

	const messageId = await withTransaction(ctx, async (tx) => {
		const group = await readGroup(ctx, tx, input, true);
		publishAfterCommit(tx, group.interactionId, { type: 'interaction.changed' });

		const [interaction] = await tx
			.select({ status: interactions.status })
			.from(interactions)
			.where(eq(interactions.id, group.interactionId))
			.limit(1);

		if (interaction?.status !== 'active') {
			throw new ValidationError('Список не передан', [
				'Взаимодействие закрыто: менять состав группы в системе обучения не для чего'
			]);
		}

		const [learners] = await tx
			.select({ value: count() })
			.from(learningGroupLearners)
			.where(eq(learningGroupLearners.learningGroupId, group.id));

		const externalId = groupRequestExternalId(group.interactionId, group.streamNumber);
		const rosterMessages = and(
			eq(exchangeMessages.direction, 'outbound'),
			eq(exchangeMessages.system, 'lms'),
			eq(exchangeMessages.eventType, EXCHANGE_EVENT_TYPES.learningGroupRequested),
			eq(exchangeMessages.externalId, externalId),
			sql`${exchangeMessages.payload} ->> 'includeLearners' = 'true'`
		);

		if ((learners?.value ?? 0) === 0) {
			const [previous] = await tx
				.select({ id: exchangeMessages.id })
				.from(exchangeMessages)
				.where(and(rosterMessages, eq(exchangeMessages.state, 'sent')))
				.limit(1);

			if (previous === undefined) {
				throw new ValidationError('Список не передан', [
					'В группе нет ни одного слушателя, и состав её ещё не передавали: сначала загрузите список'
				]);
			}
		}

		await tx
			.update(exchangeMessages)
			.set({
				state: 'dismissed',
				closedAt: sql`now()`,
				nextAttemptAt: null,
				lastError: sql`coalesce(${exchangeMessages.lastError} || ' — ', '') || 'заменено новой передачей состава'`
			})
			.where(
				and(rosterMessages, inArray(exchangeMessages.state, ['pending', 'retrying', 'failed']))
			);

		const id = await enqueueOutbound(tx, {
			system: 'lms',
			instance: settings.lms.instance,
			eventType: EXCHANGE_EVENT_TYPES.learningGroupRequested,
			externalId,
			interactionId: group.interactionId,
			// Семя той же формы, что у первой заявки, плюс признак списка: тело
			// собирается в момент отправки, и состав уедет тот, что будет тогда.
			payload: {
				interactionId: group.interactionId,
				streamNumber: group.streamNumber,
				plannedSeats: group.plannedSeats,
				startsOn: group.startsOn,
				endsOn: group.endsOn,
				includeLearners: true
			}
		});

		await recordAuditEvent(
			ctx,
			{
				type: 'exchange.group_requested',
				outcome: 'success',
				subject: { type: 'interaction', id: group.interactionId },
				details: {
					exchangeMessageId: id,
					learningGroupId: group.id,
					learnerCount: learners?.value ?? 0
				}
			},
			tx
		);

		return id;
	});

	const attempt = await deliverMessage(ctx, messageId);

	return { messageId, delivered: attempt?.ok ?? false, error: attempt?.error ?? null };
}
