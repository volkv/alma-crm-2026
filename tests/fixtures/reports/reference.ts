/**
 * Эталонный набор отчётов — тот самый, что посчитан руками в `docs/reports.md`,
 * раздел «Эталонный набор».
 *
 * Восемь взаимодействий, два вуза, два направления, три продукта, один договор
 * с двумя позициями. Каждая запись набора интересна чем-то одним: несколько
 * продуктов в одном договоре, возврат и повторный проход, пропуск и завершение,
 * отмена, незакрытая пауза, создание после первой даты среза, переименование
 * стадии, закрытие до начала периода.
 *
 * События описаны данными, а не запросами: таблица ниже читается рядом с
 * таблицей документа, и расхождение видно глазами. Записи о стадиях
 * укладываются напрямую, потому что движок ставит `now()`, а набору нужна
 * история за полгода.
 */
import { eq, isNull, and, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { StageOutcome } from '$lib/contracts/interactions';
import * as schema from '$lib/server/db/schema';
import { B2B_GROUP_KEY, B2B_PROCESS } from '$lib/server/stages/definitions';
import { readRevision, stageSnapshot } from '$lib/server/stages/process';

type Database = PostgresJsDatabase<typeof schema>;

/** Код взаимодействия из документа: `В-1` … `В-8`. */
export type ReferenceCode = 'В-1' | 'В-2' | 'В-3' | 'В-4' | 'В-5' | 'В-6' | 'В-7' | 'В-8';

/**
 * Событие набора. Закрытие и отмена описаны отдельными вариантами, а не одним с
 * двумя ключами: с составным ключом разбор по `kind` перестаёт сужать тип, и
 * обращение к полю перехода приходится подпирать приведением.
 */
export type ReferenceEvent =
	| { day: string; code: ReferenceCode; kind: 'start'; stage: string }
	| {
			day: string;
			code: ReferenceCode;
			kind: 'forward' | 'return' | 'skip';
			from: string;
			to: string;
	  }
	| { day: string; code: ReferenceCode; kind: 'complete'; reason: string }
	| { day: string; code: ReferenceCode; kind: 'cancel'; reason: string }
	| { day: string; code: ReferenceCode; kind: 'pause'; note: string };

/**
 * События набора в том же порядке, в каком они перечислены в документе.
 * Публикация правки процесса 28.12 событием не является и живёт отдельно —
 * см. {@link renameStage}.
 */
export const REFERENCE_EVENTS: readonly ReferenceEvent[] = [
	{ day: '2026-06-01', code: 'В-8', kind: 'start', stage: 'contact_search' },
	{ day: '2026-07-04', code: 'В-8', kind: 'forward', from: 'contact_search', to: 'communication' },
	{ day: '2026-07-15', code: 'В-3', kind: 'start', stage: 'contact_search' },
	{ day: '2026-08-02', code: 'В-7', kind: 'start', stage: 'contact_search' },
	{ day: '2026-08-10', code: 'В-1', kind: 'start', stage: 'contact_search' },
	{ day: '2026-08-20', code: 'В-3', kind: 'forward', from: 'contact_search', to: 'communication' },
	{ day: '2026-08-30', code: 'В-8', kind: 'cancel', reason: 'Вуз отказался от сотрудничества' },
	{ day: '2026-09-01', code: 'В-2', kind: 'start', stage: 'contact_search' },
	{ day: '2026-09-05', code: 'В-4', kind: 'start', stage: 'contact_search' },
	{ day: '2026-09-10', code: 'В-3', kind: 'forward', from: 'communication', to: 'meeting' },
	{ day: '2026-09-12', code: 'В-5', kind: 'start', stage: 'contact_search' },
	{ day: '2026-09-15', code: 'В-7', kind: 'forward', from: 'contact_search', to: 'communication' },
	{ day: '2026-09-25', code: 'В-2', kind: 'forward', from: 'contact_search', to: 'communication' },
	{ day: '2026-09-28', code: 'В-3', kind: 'forward', from: 'meeting', to: 'document_exchange' },
	{ day: '2026-10-02', code: 'В-5', kind: 'forward', from: 'contact_search', to: 'communication' },
	{ day: '2026-10-05', code: 'В-1', kind: 'forward', from: 'contact_search', to: 'communication' },
	{ day: '2026-10-12', code: 'В-2', kind: 'forward', from: 'communication', to: 'meeting' },
	{ day: '2026-10-18', code: 'В-3', kind: 'skip', from: 'document_exchange', to: 'signing' },
	{ day: '2026-10-20', code: 'В-5', kind: 'pause', note: 'Ждём ответа контрагента' },
	{ day: '2026-11-02', code: 'В-2', kind: 'return', from: 'meeting', to: 'communication' },
	{ day: '2026-11-10', code: 'В-4', kind: 'cancel', reason: 'Работу остановили на стороне вуза' },
	{ day: '2026-11-15', code: 'В-6', kind: 'start', stage: 'contact_search' },
	{ day: '2026-11-20', code: 'В-1', kind: 'forward', from: 'communication', to: 'meeting' },
	{ day: '2026-12-05', code: 'В-2', kind: 'forward', from: 'communication', to: 'meeting' },
	{ day: '2026-12-10', code: 'В-7', kind: 'forward', from: 'communication', to: 'meeting' },
	{ day: '2026-12-20', code: 'В-3', kind: 'complete', reason: 'Договор подписан досрочно' }
];

/** Состав взаимодействий: вуз, направление, продукты. */
const INTERACTIONS: readonly {
	code: ReferenceCode;
	title: string;
	organization: 'a' | 'b';
	products: readonly ('П-1' | 'П-1б' | 'П-2')[];
}[] = [
	{ code: 'В-1', title: 'В-1 несколько продуктов', organization: 'a', products: ['П-1', 'П-1б'] },
	{ code: 'В-2', title: 'В-2 возврат и повторный проход', organization: 'a', products: ['П-2'] },
	{ code: 'В-3', title: 'В-3 пропуск и завершение', organization: 'b', products: ['П-1'] },
	{ code: 'В-4', title: 'В-4 отмена', organization: 'b', products: ['П-2'] },
	{ code: 'В-5', title: 'В-5 незакрытая пауза', organization: 'a', products: ['П-1'] },
	{ code: 'В-6', title: 'В-6 создано позже', organization: 'b', products: ['П-2'] },
	{ code: 'В-7', title: 'В-7 стадия переименована', organization: 'a', products: ['П-1'] },
	{ code: 'В-8', title: 'В-8 закрыто до периода', organization: 'b', products: ['П-1'] }
];

export type ReferenceIds = {
	groupId: string;
	revisionId: string;
	ownerUserId: string;
	organizations: { a: string; b: string };
	directions: { devops: string; qa: string };
	products: Record<'П-1' | 'П-1б' | 'П-2', string>;
	contractId: string;
	interactions: Record<ReferenceCode, string>;
};

/**
 * Момент события — полдень по Москве. Полночь была бы ровно на границе суток, и
 * тест перестал бы различать строгую границу слева от нестрогой справа; полдень
 * оставляет обе половины правила проверяемыми.
 */
function moment(day: string): Date {
	return new Date(`${day}T12:00:00.000+03:00`);
}

async function openEntry(db: Database, interactionId: string) {
	const [entry] = await db
		.select({ id: schema.stageEntries.id })
		.from(schema.stageEntries)
		.where(
			and(eq(schema.stageEntries.interactionId, interactionId), isNull(schema.stageEntries.leftAt))
		);

	if (entry === undefined) {
		throw new Error(`У взаимодействия ${interactionId} нет открытой записи о стадии`);
	}

	return entry.id;
}

/**
 * Действующая редакция процесса B2B из общего описания
 * (`stages/definitions.ts`). Пишется напрямую, а не публикацией: набору нужны
 * только стадии — переходы он не использует, потому что записи о стадиях
 * укладывает сам.
 */
async function ensureRevision(db: Database, groupId: string): Promise<string> {
	const [revision] = await db
		.insert(schema.processRevisions)
		.values({
			groupId,
			version: 1,
			name: B2B_PROCESS.name,
			note: B2B_PROCESS.note,
			publishedAt: new Date('2026-01-01T00:00:00.000+03:00')
		})
		.returning({ id: schema.processRevisions.id });

	await db.insert(schema.stages).values(
		B2B_PROCESS.stages.map((stage, index) => ({
			...stage,
			revisionId: revision.id,
			position: index + 1
		}))
	);

	await db
		.update(schema.processGroups)
		.set({ activeRevisionId: revision.id })
		.where(eq(schema.processGroups.id, groupId));

	return revision.id;
}

/** Заливает эталонный набор и возвращает идентификаторы его записей. */
export async function seedReferenceSet(db: Database, ownerUserId: string): Promise<ReferenceIds> {
	const [group] = await db
		.select({ id: schema.processGroups.id })
		.from(schema.processGroups)
		.where(eq(schema.processGroups.key, B2B_GROUP_KEY));

	const revisionId = await ensureRevision(db, group.id);
	const revision = await readRevision(db, revisionId);
	const stageByKey = new Map(revision.stages.map((stage) => [stage.key, stage]));

	const [devops, qa] = await db
		.insert(schema.directions)
		.values([
			{ code: 'devops', name: 'DevOps', position: 1 },
			{ code: 'qa', name: 'QA', position: 2 }
		])
		.returning({ id: schema.directions.id });

	const [organizationA, organizationB] = await db
		.insert(schema.organizations)
		.values([
			{
				kind: 'educational_institution',
				educationLevel: 'vo',
				legalName: 'Вуз А',
				shortName: 'Вуз А'
			},
			{
				kind: 'educational_institution',
				educationLevel: 'vo',
				legalName: 'Вуз Б',
				shortName: 'Вуз Б'
			}
		])
		.returning({ id: schema.organizations.id });

	const productRows = await db
		.insert(schema.products)
		.values([
			{ code: 'p-1', name: 'П-1', status: 'active' },
			{ code: 'p-1b', name: 'П-1б', status: 'active' },
			{ code: 'p-2', name: 'П-2', status: 'active' }
		])
		.returning({ id: schema.products.id, code: schema.products.code });

	const products = {
		'П-1': productRows.find((row) => row.code === 'p-1')!.id,
		'П-1б': productRows.find((row) => row.code === 'p-1b')!.id,
		'П-2': productRows.find((row) => row.code === 'p-2')!.id
	};

	// П-1 и П-1б относятся к DevOps, П-2 — к QA: поэтому разрез по направлениям
	// здесь однозначен, а разрез по продуктам — нет, и это проверяется.
	await db.insert(schema.productDirections).values([
		{ productId: products['П-1'], directionId: devops.id },
		{ productId: products['П-1б'], directionId: devops.id },
		{ productId: products['П-2'], directionId: qa.id }
	]);

	const [contract] = await db
		.insert(schema.contracts)
		.values({ organizationId: organizationA.id, number: 'Д-2026/1', status: 'active' })
		.returning({ id: schema.contracts.id });

	const items = await db
		.insert(schema.contractItems)
		.values([
			{ contractId: contract.id, productId: products['П-1'], transferStatus: 'передан' },
			{ contractId: contract.id, productId: products['П-1б'], transferStatus: 'готовится' }
		])
		.returning({ id: schema.contractItems.id });

	const interactions = {} as Record<ReferenceCode, string>;

	for (const definition of INTERACTIONS) {
		const organizationId = definition.organization === 'a' ? organizationA.id : organizationB.id;

		const [interaction] = await db
			.insert(schema.interactions)
			.values({
				title: definition.title,
				processGroupId: group.id,
				ownerUserId,
				contractId: definition.code === 'В-1' ? contract.id : null
			})
			.returning({ id: schema.interactions.id });

		interactions[definition.code] = interaction.id;

		await db.insert(schema.interactionParties).values({
			interactionId: interaction.id,
			organizationId,
			partyRole: 'educational_institution',
			isPrimary: true
		});

		await db.insert(schema.interactionProducts).values(
			definition.products.map((code) => ({
				interactionId: interaction.id,
				productId: products[code]
			}))
		);

		if (definition.code === 'В-1') {
			await db.insert(schema.interactionContractItems).values(
				items.map((item) => ({
					interactionId: interaction.id,
					contractItemId: item.id,
					contractId: contract.id
				}))
			);
		}
	}

	for (const event of REFERENCE_EVENTS) {
		const interactionId = interactions[event.code];
		const at = moment(event.day);

		if (event.kind === 'start') {
			const stage = stageByKey.get(event.stage)!;

			await db.insert(schema.stageEntries).values({
				interactionId,
				stageId: stage.id,
				stageSnapshot: stageSnapshot(stage),
				enteredAt: at,
				responsibleUserId: ownerUserId
			});
			continue;
		}

		if (event.kind === 'pause') {
			await db.insert(schema.stagePauses).values({
				stageEntryId: await openEntry(db, interactionId),
				reason: 'waiting_counterparty',
				note: event.note,
				startedAt: at
			});
			continue;
		}

		const entryId = await openEntry(db, interactionId);

		if (event.kind === 'complete' || event.kind === 'cancel') {
			// Закрытие: запись стадии закрывается, следующая не открывается.
			// У завершения исход `completed`, у отмены исхода нет вовсе — стадию
			// не прошли и не пропустили, работу на ней прекратили.
			await db
				.update(schema.stageEntries)
				.set({
					leftAt: at,
					outcome: event.kind === 'complete' ? 'completed' : null,
					outcomeReason: event.reason
				})
				.where(eq(schema.stageEntries.id, entryId));

			await db
				.update(schema.interactions)
				.set({ status: event.kind === 'complete' ? 'completed' : 'cancelled', lastActivityAt: at })
				.where(eq(schema.interactions.id, interactionId));
			continue;
		}

		// Переход: та же транзакция закрывает предыдущую запись и открывает
		// следующую одним и тем же моментом.
		const outcome: StageOutcome =
			event.kind === 'forward' ? 'completed' : event.kind === 'return' ? 'returned' : 'skipped';
		const target = stageByKey.get(event.to)!;

		await db
			.update(schema.stageEntries)
			.set({ leftAt: at, outcome, outcomeReason: null })
			.where(eq(schema.stageEntries.id, entryId));

		await db.insert(schema.stageEntries).values({
			interactionId,
			stageId: target.id,
			stageSnapshot: stageSnapshot(target),
			enteredAt: at,
			responsibleUserId: ownerUserId
		});
	}

	return {
		groupId: group.id,
		revisionId,
		ownerUserId,
		organizations: { a: organizationA.id, b: organizationB.id },
		directions: { devops: devops.id, qa: qa.id },
		products,
		contractId: contract.id,
		interactions
	};
}

/**
 * Публикация правки процесса: стадию переименовали, ключ прежний.
 *
 * Делается так же, как это делает публикация: новая редакция становится
 * действующей, а снимки открытых записей пересобираются. Снимки закрытых
 * записей не трогаются — на этом держится обещание «отчёт на прошлую дату до и
 * после публикации даёт те же числа».
 */
export async function renameStage(
	db: Database,
	ids: ReferenceIds,
	stageKey: string,
	name: string
): Promise<void> {
	await db
		.update(schema.stages)
		.set({ name })
		.where(and(eq(schema.stages.revisionId, ids.revisionId), eq(schema.stages.key, stageKey)));

	await db
		.update(schema.stageEntries)
		.set({
			stageSnapshot: sql`jsonb_set(${schema.stageEntries.stageSnapshot}, '{name}', ${JSON.stringify(name)}::jsonb)`
		})
		.where(
			and(
				isNull(schema.stageEntries.leftAt),
				sql`${schema.stageEntries.stageSnapshot} ->> 'key' = ${stageKey}`
			)
		);
}

/** Момент, ровно совпадающий с границей суток: 01.11.2026, 00:00 по Москве. */
export const BOUNDARY_MOMENT = new Date('2026-11-01T00:00:00.000+03:00');

/**
 * Взаимодействие, перешедшее ровно в момент среза.
 *
 * Эталонный набор двигается в полдень, поэтому строгую границу слева от
 * нестрогой справа он не различает: и `<`, и `<=` дают на нём одни и те же
 * числа. Эта запись существует ровно для того, чтобы разница была видна —
 * переход ровно в `T` обязан относиться уже к следующим суткам.
 */
export async function addBoundaryInteraction(
	db: Database,
	ids: ReferenceIds,
	ownerUserId: string
): Promise<string> {
	const revision = await readRevision(db, ids.revisionId);
	const stageByKey = new Map(revision.stages.map((stage) => [stage.key, stage]));
	const from = stageByKey.get('contact_search')!;
	const to = stageByKey.get('communication')!;

	const [interaction] = await db
		.insert(schema.interactions)
		.values({
			title: 'В-9 переход ровно в полночь',
			processGroupId: ids.groupId,
			ownerUserId
		})
		.returning({ id: schema.interactions.id });

	await db.insert(schema.interactionParties).values({
		interactionId: interaction.id,
		organizationId: ids.organizations.a,
		partyRole: 'educational_institution',
		isPrimary: true
	});

	await db.insert(schema.stageEntries).values([
		{
			interactionId: interaction.id,
			stageId: from.id,
			stageSnapshot: stageSnapshot(from),
			enteredAt: moment('2026-10-10'),
			leftAt: BOUNDARY_MOMENT,
			outcome: 'completed',
			responsibleUserId: ownerUserId
		},
		{
			interactionId: interaction.id,
			stageId: to.id,
			stageSnapshot: stageSnapshot(to),
			enteredAt: BOUNDARY_MOMENT,
			responsibleUserId: ownerUserId
		}
	]);

	return interaction.id;
}

/** Срез на конец сентября: период, которым его спрашивают. */
export const SEPTEMBER_PERIOD = { from: '2026-09-01', to: '2026-09-30' } as const;

/** Период движения и срез на его конец — тот же, что в документе. */
export const QUARTER_PERIOD = { from: '2026-10-01', to: '2026-12-31' } as const;

/** Ожидаемое распределение по стадиям, из таблицы документа. */
export const EXPECTED_SNAPSHOT: Readonly<
	Record<'september' | 'december', Readonly<Record<string, number>>>
> = {
	september: {
		contact_search: 3,
		communication: 2,
		meeting: 0,
		document_exchange: 1,
		document_revision: 0,
		signing: 0,
		completed: 0,
		cancelled: 0,
		rows: 6
	},
	december: {
		contact_search: 1,
		communication: 1,
		meeting: 3,
		document_exchange: 0,
		document_revision: 0,
		signing: 0,
		completed: 1,
		cancelled: 1,
		rows: 7
	}
};

/** Разрезы из документа: по вузам, направлениям и продуктам. */
export const EXPECTED_BREAKDOWNS = {
	september: {
		organizations: { 'Вуз А': 4, 'Вуз Б': 2 },
		directions: { DevOps: 4, QA: 2 },
		products: { 'П-1': 4, 'П-1б': 1, 'П-2': 2 },
		productsTotal: 7
	},
	december: {
		organizations: { 'Вуз А': 4, 'Вуз Б': 3 },
		directions: { DevOps: 4, QA: 3 },
		products: { 'П-1': 4, 'П-1б': 1, 'П-2': 3 },
		productsTotal: 8
	}
} as const;

/** Движение за квартал: одиннадцать строк, разложенные по видам событий. */
export const EXPECTED_MOVEMENT = {
	rows: 11,
	kinds: { forward: 6, return: 1, skip: 1, started: 1, completed: 1, cancelled: 1 },
	organizations: { 'Вуз А': 7, 'Вуз Б': 4 },
	directions: { DevOps: 6, QA: 5 }
} as const;

/** Сверка режимов из документа: вошло и вышло по каждой стадии. */
export const EXPECTED_RECONCILIATION: readonly {
	stage: string;
	entered: number;
	left: number;
}[] = [
	{ stage: 'contact_search', entered: 1, left: 3 },
	{ stage: 'communication', entered: 3, left: 4 },
	{ stage: 'meeting', entered: 4, left: 1 },
	{ stage: 'document_exchange', entered: 0, left: 1 },
	{ stage: 'signing', entered: 1, left: 1 },
	{ stage: 'completed', entered: 1, left: 0 },
	{ stage: 'cancelled', entered: 1, left: 0 }
];
