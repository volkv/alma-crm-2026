import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	auditEvents,
	consents,
	contractItems,
	contracts,
	directions,
	exchangeMessages,
	interactionContractItems,
	interactionParties,
	learningGroupResults,
	learningGroups,
	organizationResponsibles,
	organizations,
	processGroupCounterpartyKinds,
	workspaces,
	stageEntries,
	stageEntryStatus,
	stagePauses,
	users
} from '$lib/server/db/schema';
import {
	daysFrom,
	failureCode,
	insertDocument,
	insertInteractionWithStage,
	insertOrganization,
	insertPerson,
	insertUser,
	startTestDatabase,
	type TestDatabase
} from './helpers/db';

// Vitest поднимает этот вызов выше импортов. Без него `$env/dynamic/private`
// остаётся слепком `.env`, снятым при старте Vitest, и сервисы пойдут в базу
// разработчика вместо контейнера.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const DAY_SECONDS = 24 * 60 * 60;

let database: TestDatabase;

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
});

describe('миграции', () => {
	it('создают таблицы схемы и представление статуса стадии', async () => {
		const rows = await database.raw<{ name: string | null }[]>`
			select to_regclass('public.' || name)::text as name
			from unnest(array[
				'users', 'roles', 'permissions', 'role_permissions', 'app_settings',
				'audit_events', 'organizations', 'sites', 'people', 'affiliations',
				'programs', 'program_versions', 'products', 'process_revisions', 'stages',
				'stage_transitions', 'interactions', 'interaction_parties',
				'interaction_party_sites', 'interaction_programs', 'interaction_products',
				'interaction_changes', 'stage_entries', 'stage_pauses', 'blockers',
				'comments', 'document_templates', 'documents', 'api_keys',
				'consents', 'stage_entry_status',
				'directions', 'product_directions', 'organization_responsibles',
				'workspaces', 'workflows', 'process_group_counterparty_kinds', 'process_stage_keys',
				'stage_migration_rules', 'contracts', 'contract_items',
				'interaction_contract_items', 'stage_entry_documents',
				'learning_groups', 'learning_group_results', 'exchange_messages'
			]) as name
		`;

		expect(rows).toHaveLength(46);
		expect(rows.filter((row) => row.name === null)).toEqual([]);
	});

	it('снимают маршруты вместе с их колонками', async () => {
		// Маршрут превратился в редакцию процесса группы; старой таблицы и ссылки
		// на неё быть не должно, иначе рядом с процессом останется второй способ
		// сказать, по каким стадиям идёт взаимодействие.
		const gone = await database.raw<{ name: string | null }[]>`
			select to_regclass('public.stage_routes')::text as name
		`;

		const columns = await database.raw<{ table: string; column: string }[]>`
			select table_name as "table", column_name as "column"
			from information_schema.columns
			where table_schema = 'public'
				and (
					(table_name = 'interactions' and column_name = 'route_id')
					or (table_name in ('stages', 'stage_transitions') and column_name = 'route_id')
					or (table_name = 'process_revisions' and column_name in ('key', 'is_default'))
				)
		`;

		expect(gone[0].name).toBeNull();
		expect(columns).toEqual([]);
	});

	it('делают группу процесса обязательной у взаимодействия', async () => {
		const [row] = await database.raw<{ nullable: string }[]>`
			select is_nullable as nullable
			from information_schema.columns
			where table_schema = 'public'
				and table_name = 'interactions'
				and column_name = 'workspace_id'
		`;

		expect(row.nullable).toBe('NO');
	});

	it('держат один черновик на процесс частичным уникальным индексом', async () => {
		const [row] = await database.raw<{ name: string }[]>`
			select indexname as name
			from pg_indexes
			where schemaname = 'public'
				and tablename = 'process_revisions'
				and indexname = 'process_revisions_one_draft_per_workflow'
		`;

		expect(row?.name).toBe('process_revisions_one_draft_per_workflow');
	});
});

describe('журнал действий', () => {
	async function insertEvent(): Promise<void> {
		await database.db.insert(auditEvents).values({
			requestId: 'req-1',
			source: 'ui',
			eventType: 'auth.login',
			outcome: 'success',
			actorLabel: 'Тестовый Пользователь'
		});
	}

	it('не позволяет изменить запись', async () => {
		await insertEvent();

		expect(await failureCode(database.raw`update audit_events set outcome = 'failure'`)).toBe(
			'23001'
		);
	});

	it('не позволяет удалить запись', async () => {
		await insertEvent();

		expect(await failureCode(database.raw`delete from audit_events`)).toBe('23001');

		const [row] = await database.raw<{ count: string }[]>`select count(*) from audit_events`;
		expect(Number(row.count)).toBe(1);
	});
});

describe('редакции документов', () => {
	async function insertRevision(supersedesId: string | null): Promise<string> {
		return insertDocument(database.db, { supersedesId, title: 'Соглашение' });
	}

	it('не даёт заменить одну редакцию дважды', async () => {
		const first = await insertRevision(null);
		await insertRevision(first);

		// Частичный уникальный индекс: у документа не бывает двух «следующих»
		// редакций, иначе на вопрос «какая действует» ответа нет.
		expect(await failureCode(insertRevision(first))).toBe('23505');
	});

	it('не мешает первым редакциям — их в базе сколько угодно', async () => {
		await insertRevision(null);
		await insertRevision(null);

		const rows = await database.raw<{ count: string }[]>`select count(*) from documents`;
		expect(Number(rows[0].count)).toBe(2);
	});

	it('не позволяет документу заменить сам себя', async () => {
		const id = await insertRevision(null);

		expect(
			await failureCode(database.raw`update documents set supersedes_id = id where id = ${id}`)
		).toBe('23514');
	});
});

describe('согласия на обработку данных', () => {
	it('не принимает отзыв раньше получения согласия', async () => {
		const personId = await insertPerson(database.db);

		expect(
			await failureCode(
				database.db.insert(consents).values({
					personId,
					basis: 'consent',
					textVersion: '2026-01-01',
					givenAt: '2026-02-01',
					withdrawnAt: '2026-01-15'
				})
			)
		).toBe('23514');
	});

	it('не принимает автора отзыва без самого отзыва', async () => {
		const personId = await insertPerson(database.db);
		const userId = await insertUser(database.db);

		expect(
			await failureCode(
				database.db.insert(consents).values({
					personId,
					basis: 'consent',
					textVersion: '2026-01-01',
					givenAt: '2026-02-01',
					withdrawnBy: userId
				})
			)
		).toBe('23514');
	});

	it('уходит вместе с человеком: согласие без субъекта ничего не значит', async () => {
		const personId = await insertPerson(database.db);

		await database.db.insert(consents).values({
			personId,
			basis: 'legal',
			textVersion: '2026-01-01',
			givenAt: '2026-02-01'
		});

		await database.raw`delete from people where id = ${personId}`;

		const rows = await database.raw<{ count: string }[]>`select count(*) from consents`;
		expect(Number(rows[0].count)).toBe(0);
	});
});

describe('ограничения справочника', () => {
	it('требует уровень образования ровно у учебных заведений', async () => {
		expect(
			await failureCode(
				database.db.insert(organizations).values({
					kind: 'customer_company',
					educationLevel: 'vo',
					legalName: 'ООО «Заказчик»',
					shortName: 'Заказчик'
				})
			)
		).toBe('23514');

		expect(
			await failureCode(
				database.db.insert(organizations).values({
					kind: 'educational_institution',
					legalName: 'Университет',
					shortName: 'Университет'
				})
			)
		).toBe('23514');

		await database.db.insert(organizations).values({
			kind: 'educational_institution',
			educationLevel: 'vo',
			legalName: 'Университет',
			shortName: 'Университет'
		});

		const rows = await database.db.select({ id: organizations.id }).from(organizations);
		expect(rows).toHaveLength(1);
	});

	it('не пускает две записи с одной внешней ссылкой и не мешает записям без неё', async () => {
		await database.db.insert(organizations).values({
			kind: 'operator',
			legalName: 'Оператор',
			shortName: 'Оператор',
			externalSource: 'moodle',
			externalId: '42'
		});

		expect(
			await failureCode(
				database.db.insert(organizations).values({
					kind: 'operator',
					legalName: 'Оператор-двойник',
					shortName: 'Двойник',
					externalSource: 'moodle',
					externalId: '42'
				})
			)
		).toBe('23505');

		// Другая система с тем же идентификатором — другая запись.
		await database.db.insert(organizations).values({
			kind: 'operator',
			legalName: 'Оператор из 1С',
			shortName: '1С',
			externalSource: '1c',
			externalId: '42'
		});

		// Записей без внешней ссылки может быть сколько угодно.
		await database.db.insert(organizations).values([
			{ kind: 'customer_company', legalName: 'Первая', shortName: 'Первая' },
			{ kind: 'customer_company', legalName: 'Вторая', shortName: 'Вторая' }
		]);

		const rows = await database.db.select({ id: organizations.id }).from(organizations);
		expect(rows).toHaveLength(4);
	});
});

describe('стадии', () => {
	it('допускает только одну открытую запись на взаимодействие', async () => {
		const ownerUserId = await insertUser(database.db);
		const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
			ownerUserId
		});

		await database.db.insert(stageEntries).values({
			interactionId,
			stageId,
			stageSnapshot: snapshot
		});

		expect(
			await failureCode(
				database.db.insert(stageEntries).values({ interactionId, stageId, stageSnapshot: snapshot })
			)
		).toBe('23505');

		// Закрытая запись освобождает место следующей.
		await database.db.update(stageEntries).set({ leftAt: new Date(), outcome: 'completed' });
		await database.db
			.insert(stageEntries)
			.values({ interactionId, stageId, stageSnapshot: snapshot });

		const rows = await database.db.select({ id: stageEntries.id }).from(stageEntries);
		expect(rows).toHaveLength(2);
	});

	it('допускает только одну открытую паузу на записи стадии', async () => {
		const ownerUserId = await insertUser(database.db);
		const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
			ownerUserId
		});

		const [entry] = await database.db
			.insert(stageEntries)
			.values({ interactionId, stageId, stageSnapshot: snapshot })
			.returning({ id: stageEntries.id });

		await database.db.insert(stagePauses).values({
			stageEntryId: entry.id,
			reason: 'waiting_counterparty',
			note: 'Ждём ответа вуза'
		});

		expect(
			await failureCode(
				database.db.insert(stagePauses).values({
					stageEntryId: entry.id,
					reason: 'waiting_internal',
					note: 'И ещё чего-то ждём'
				})
			)
		).toBe('23505');

		const rows = await database.db.select({ id: stagePauses.id }).from(stagePauses);
		expect(rows).toHaveLength(1);
	});
});

describe('представление stage_entry_status', () => {
	type Entry = { entryId: string; interactionId: string };

	async function makeEntry(
		ownerUserId: string,
		options: { enteredAt: Date; leftAt?: Date; slaDays?: number }
	): Promise<Entry> {
		const { interactionId, stageId, snapshot } = await insertInteractionWithStage(database.db, {
			ownerUserId,
			slaDays: options.slaDays ?? 5
		});

		const [entry] = await database.db
			.insert(stageEntries)
			.values({
				interactionId,
				stageId,
				stageSnapshot: snapshot,
				enteredAt: options.enteredAt,
				leftAt: options.leftAt ?? null,
				outcome: options.leftAt === undefined ? null : 'completed'
			})
			.returning({ id: stageEntries.id });

		return { entryId: entry.id, interactionId };
	}

	async function status(entryId: string) {
		const [row] = await database.db
			.select()
			.from(stageEntryStatus)
			.where(eq(stageEntryStatus.stageEntryId, entryId));

		return row;
	}

	it('сдвигает срок ровно на длительность пересечения паузы с окном', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();
		const enteredAt = daysFrom(base, -10);

		const plain = await makeEntry(ownerUserId, { enteredAt });
		const paused = await makeEntry(ownerUserId, { enteredAt });
		const overlapping = await makeEntry(ownerUserId, { enteredAt });

		// Пауза целиком внутри окна: двое суток.
		await database.db.insert(stagePauses).values({
			stageEntryId: paused.entryId,
			reason: 'waiting_counterparty',
			note: 'Ждём подписи',
			startedAt: daysFrom(base, -8),
			endedAt: daysFrom(base, -6)
		});

		// Пауза началась до входа на стадию: считается только пересечение — сутки.
		await database.db.insert(stagePauses).values({
			stageEntryId: overlapping.entryId,
			reason: 'other',
			note: 'Началась раньше входа',
			startedAt: daysFrom(base, -12),
			endedAt: daysFrom(base, -9)
		});

		const plainStatus = await status(plain.entryId);
		const pausedStatus = await status(paused.entryId);
		const overlappingStatus = await status(overlapping.entryId);

		expect(plainStatus.pausedSeconds).toBe(0);
		expect(pausedStatus.pausedSeconds).toBe(2 * DAY_SECONDS);
		expect(overlappingStatus.pausedSeconds).toBe(DAY_SECONDS);

		const shift = pausedStatus.dueAt.getTime() - plainStatus.dueAt.getTime();
		expect(shift).toBe(2 * DAY_SECONDS * 1000);
		expect(plainStatus.dueAt.getTime()).toBe(enteredAt.getTime() + 5 * DAY_SECONDS * 1000);
	});

	it('останавливает закрытую запись на моменте выхода со стадии', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();
		const enteredAt = daysFrom(base, -10);
		const leftAt = daysFrom(base, -4);

		const closed = await makeEntry(ownerUserId, { enteredAt, leftAt });

		// Пауза осталась открытой: у закрытой записи она обрезается по `left_at`.
		await database.db.insert(stagePauses).values({
			stageEntryId: closed.entryId,
			reason: 'waiting_internal',
			note: 'Забыли закрыть',
			startedAt: daysFrom(base, -5)
		});

		const closedStatus = await status(closed.entryId);

		expect(closedStatus.windowEnd.getTime()).toBe(leftAt.getTime());
		expect(closedStatus.pausedSeconds).toBe(DAY_SECONDS);
		expect(closedStatus.isPaused).toBe(false);
		// Срок: вход + 5 дней норматива + сутки паузы — и он не зависит от `now()`.
		expect(closedStatus.dueAt.getTime()).toBe(enteredAt.getTime() + 6 * DAY_SECONDS * 1000);
		expect(closedStatus.remainingSeconds).toBe(
			(closedStatus.dueAt.getTime() - leftAt.getTime()) / 1000
		);
		expect(closedStatus.activeSeconds).toBe(5 * DAY_SECONDS);
	});

	it('отмечает просрочку и не отмечает её раньше срока', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();

		const overdue = await makeEntry(ownerUserId, { enteredAt: daysFrom(base, -10), slaDays: 5 });
		const onTime = await makeEntry(ownerUserId, { enteredAt: daysFrom(base, -1), slaDays: 5 });

		const overdueStatus = await status(overdue.entryId);
		const onTimeStatus = await status(onTime.entryId);

		expect(overdueStatus.isOverdue).toBe(true);
		expect(overdueStatus.remainingSeconds).toBeLessThan(0);
		expect(overdueStatus.overdueSeconds).toBeCloseTo(-overdueStatus.remainingSeconds, 6);

		expect(onTimeStatus.isOverdue).toBe(false);
		expect(onTimeStatus.remainingSeconds).toBeGreaterThan(0);
		expect(onTimeStatus.overdueSeconds).toBe(0);
	});

	it('открытая пауза держит запись на паузе, закрытая — нет', async () => {
		const ownerUserId = await insertUser(database.db);
		const base = new Date();
		const open = await makeEntry(ownerUserId, { enteredAt: daysFrom(base, -2) });

		const before = await status(open.entryId);
		expect(before.isPaused).toBe(false);

		const [pause] = await database.db
			.insert(stagePauses)
			.values({
				stageEntryId: open.entryId,
				reason: 'waiting_counterparty',
				note: 'Ждём',
				startedAt: daysFrom(base, -1)
			})
			.returning({ id: stagePauses.id });

		expect((await status(open.entryId)).isPaused).toBe(true);

		await database.db
			.update(stagePauses)
			.set({ endedAt: new Date() })
			.where(eq(stagePauses.id, pause.id));

		expect((await status(open.entryId)).isPaused).toBe(false);
	});
});

describe('группы процесса', () => {
	/**
	 * Строки групп кладёт миграция; `reset()` чистит таблицы целиком и
	 * возвращает их снимком (`helpers/db.ts`). Что их кладёт именно миграция,
	 * проверяет `db.test.ts` — там база не чистится.
	 */
	async function workspaceId(key: string): Promise<string> {
		const [row] = await database.db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(eq(workspaces.key, key));

		expect(row).toBeDefined();

		return row.id;
	}

	it('не позволяет виду контрагента принадлежать двум группам', async () => {
		const b2c = await workspaceId('b2c');

		// Первичный ключ по виду и есть ограничение «вид принадлежит ровно одной
		// группе»: проверка в сервисе такого не удержит.
		expect(
			await failureCode(
				database.db
					.insert(processGroupCounterpartyKinds)
					.values({ kind: 'educational_institution', groupId: b2c })
			)
		).toBe('23505');

		const rows = await database.db
			.select({ kind: processGroupCounterpartyKinds.kind, key: workspaces.key })
			.from(processGroupCounterpartyKinds)
			.innerJoin(workspaces, eq(workspaces.id, processGroupCounterpartyKinds.groupId))
			.orderBy(processGroupCounterpartyKinds.kind);

		expect(rows.map((row) => `${row.kind}:${row.key}`)).toStrictEqual([
			'educational_institution:b2b',
			'individual:b2c',
			'legal_entity:b2c'
		]);
	});
});

describe('контрагент-физлицо', () => {
	it('требует ссылку на человека ровно у вида «физическое лицо»', async () => {
		const personId = await insertPerson(database.db);

		// Физлицо без человека — контрагент без имени.
		expect(
			await failureCode(
				database.db
					.insert(organizations)
					.values({ kind: 'individual', legalName: 'Иванов И. И.', shortName: 'Иванов И. И.' })
			)
		).toBe('23514');

		// Человек у вуза — связь, по которой обезличивание дошло бы до организации.
		expect(
			await failureCode(
				database.db.insert(organizations).values({
					kind: 'customer_company',
					legalName: 'ООО «Заказчик»',
					shortName: 'Заказчик',
					personId
				})
			)
		).toBe('23514');

		await database.db.insert(organizations).values({
			kind: 'individual',
			legalName: 'Иванов И. И.',
			shortName: 'Иванов И. И.',
			personId
		});

		const rows = await database.db.select({ id: organizations.id }).from(organizations);
		expect(rows).toHaveLength(1);
	});
});

describe('основная сторона взаимодействия', () => {
	it('бывает ровно одна: от неё зависят и группа процесса, и область доступа', async () => {
		const ownerUserId = await insertUser(database.db);
		const { interactionId } = await insertInteractionWithStage(database.db, { ownerUserId });
		const institution = await insertOrganization(database.db, { shortName: 'Вуз' });
		const customer = await insertOrganization(database.db, { shortName: 'Заказчик' });

		await database.db.insert(interactionParties).values({
			interactionId,
			organizationId: institution,
			partyRole: 'educational_institution',
			isPrimary: true
		});

		expect(
			await failureCode(
				database.db.insert(interactionParties).values({
					interactionId,
					organizationId: customer,
					partyRole: 'customer',
					isPrimary: true
				})
			)
		).toBe('23505');

		// Неосновных сторон сколько угодно: плательщик и оператор стоят рядом.
		await database.db.insert(interactionParties).values({
			interactionId,
			organizationId: customer,
			partyRole: 'customer',
			isPrimary: false
		});

		const rows = await database.db.select({ id: interactionParties.id }).from(interactionParties);
		expect(rows).toHaveLength(2);
	});
});

describe('ответственные за вуз', () => {
	async function insertDirection(code: string): Promise<string> {
		const [row] = await database.db
			.insert(directions)
			.values({ code, name: `Направление ${code}`, position: code.length + code.charCodeAt(0) })
			.returning({ id: directions.id });

		return row.id;
	}

	it('допускает одно действующее назначение на вуз и направление', async () => {
		const organizationId = await insertOrganization(database.db);
		const first = await insertUser(database.db);
		const second = await insertUser(database.db);
		const devops = await insertDirection('OPS');
		const analytics = await insertDirection('ANL');

		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId, userId: first, directionId: devops });

		// По разным направлениям — разные ответственные: это рабочая картина.
		await database.db
			.insert(organizationResponsibles)
			.values({ organizationId, userId: second, directionId: analytics });

		expect(
			await failureCode(
				database.db
					.insert(organizationResponsibles)
					.values({ organizationId, userId: second, directionId: devops })
			)
		).toBe('23505');
	});

	it('считает два общих назначения столкновением, хотя направление пусто', async () => {
		const organizationId = await insertOrganization(database.db);
		const first = await insertUser(database.db);
		const second = await insertUser(database.db);

		await database.db.insert(organizationResponsibles).values({ organizationId, userId: first });

		// NULLS NOT DISTINCT: без него «ответственный за вуз целиком» размножился
		// бы, и вопрос «чей это вуз» остался бы без одного ответа.
		expect(
			await failureCode(
				database.db.insert(organizationResponsibles).values({ organizationId, userId: second })
			)
		).toBe('23505');

		// Закрытое назначение места не занимает: история и есть история.
		await database.db
			.update(organizationResponsibles)
			.set({ validTo: new Date() })
			.where(eq(organizationResponsibles.userId, first));

		await database.db.insert(organizationResponsibles).values({ organizationId, userId: second });

		const rows = await database.db
			.select({ id: organizationResponsibles.id })
			.from(organizationResponsibles);
		expect(rows).toHaveLength(2);
	});
});

describe('договоры', () => {
	async function insertProduct(code: string): Promise<string> {
		const [row] = await database.raw<{ id: string }[]>`
			insert into products (code, name) values (${code}, ${`Продукт ${code}`}) returning id
		`;

		return row.id;
	}

	it('не пускает во взаимодействие позицию чужого договора', async () => {
		const ownerUserId = await insertUser(database.db);
		const { interactionId } = await insertInteractionWithStage(database.db, { ownerUserId });
		const organizationId = await insertOrganization(database.db);
		const productId = await insertProduct('PRD-01');

		const [own, alien] = await database.db
			.insert(contracts)
			.values([
				{ organizationId, number: 'Д-1' },
				{ organizationId, number: 'Д-2' }
			])
			.returning({ id: contracts.id });

		const [item] = await database.db
			.insert(contractItems)
			.values({ contractId: alien.id, productId, transferStatus: 'pending' })
			.returning({ id: contractItems.id });

		// Составной внешний ключ: позиция обязана принадлежать названному договору,
		// и проверяет это база, а не сервис.
		expect(
			await failureCode(
				database.db
					.insert(interactionContractItems)
					.values({ interactionId, contractItemId: item.id, contractId: own.id })
			)
		).toBe('23503');

		await database.db
			.insert(interactionContractItems)
			.values({ interactionId, contractItemId: item.id, contractId: alien.id });

		const rows = await database.db
			.select({ interactionId: interactionContractItems.interactionId })
			.from(interactionContractItems);
		expect(rows).toHaveLength(1);
	});
});

describe('обмен с внешними системами', () => {
	async function insertMessage(eventId: string): Promise<void> {
		await database.db.insert(exchangeMessages).values({
			direction: 'inbound',
			system: 'cms',
			instance: 'site',
			eventType: 'application.submitted',
			eventId,
			state: 'processed',
			payload: {}
		});
	}

	it('не заводит второй строки на повторную доставку того же сообщения', async () => {
		await insertMessage('e-1');

		expect(await failureCode(insertMessage('e-1'))).toBe('23505');

		await insertMessage('e-2');

		const rows = await database.db.select({ id: exchangeMessages.id }).from(exchangeMessages);
		expect(rows).toHaveLength(2);
	});

	it('не заводит второй поток на повторное нажатие «отправить группу»', async () => {
		const ownerUserId = await insertUser(database.db);
		const { interactionId } = await insertInteractionWithStage(database.db, { ownerUserId });

		const [workspace] = await database.db
			.insert(learningGroups)
			.values({ interactionId, streamNumber: 1, system: 'lms', instance: 'moodle' })
			.returning({ id: learningGroups.id });

		expect(
			await failureCode(
				database.db
					.insert(learningGroups)
					.values({ interactionId, streamNumber: 1, system: 'lms', instance: 'moodle' })
			)
		).toBe('23505');

		// Счётчики результата не противоречат друг другу.
		expect(
			await failureCode(
				database.db.insert(learningGroupResults).values({
					learningGroupId: workspace.id,
					occurredAt: new Date(),
					enrolled: 10,
					completed: 8,
					expelled: 5
				})
			)
		).toBe('23514');

		await database.db.insert(learningGroupResults).values({
			learningGroupId: workspace.id,
			occurredAt: new Date(),
			enrolled: 10,
			completed: 8,
			expelled: 2
		});

		const results = await database.db
			.select({ id: learningGroupResults.id })
			.from(learningGroupResults);
		expect(results).toHaveLength(1);
	});
});

describe('иерархия сотрудников', () => {
	it('не даёт сотруднику быть руководителем самому себе', async () => {
		const userId = await insertUser(database.db);

		expect(
			await failureCode(
				database.raw`update users set manager_user_id = id where id = ${userId}::uuid`
			)
		).toBe('23514');
	});

	it('связывает запись с внешним субъектом ровно один раз', async () => {
		const first = await insertUser(database.db);
		const second = await insertUser(database.db);

		await database.db
			.update(users)
			.set({ externalSubject: 'keycloak:1' })
			.where(eq(users.id, first));

		expect(
			await failureCode(
				database.db.update(users).set({ externalSubject: 'keycloak:1' }).where(eq(users.id, second))
			)
		).toBe('23505');

		// Записей без внешнего субъекта в базе сколько угодно.
		const rows = await database.db
			.select({ count: sql<number>`count(*)::int` })
			.from(users)
			.where(sql`${users.externalSubject} is null`);
		expect(rows[0].count).toBeGreaterThan(0);
	});
});
