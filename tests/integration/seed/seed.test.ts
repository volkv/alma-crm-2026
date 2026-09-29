import { spawn } from 'node:child_process';
import { and, count, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidInn } from '$lib/validation/inn';
import {
	affiliations,
	apiKeys,
	blockers,
	comments,
	contractItems,
	contracts,
	directions,
	documentContractItems,
	documents,
	interactionChanges,
	interactionContractItems,
	interactionParties,
	interactions,
	learningGroupLearners,
	learningGroupResults,
	learningGroups,
	organizationResponsibles,
	organizations,
	workspaces,
	workflows,
	people,
	permissions,
	processStageKeys,
	productDirections,
	products,
	programDocuments,
	programs,
	programVersions,
	rolePermissions,
	roles,
	sites,
	stageEntries,
	stageEntryStatus,
	statProgramIndicators,
	statRows,
	statSnapshots,
	users
} from '$lib/server/db/schema';
import { hashApiKey } from '$lib/server/api/keys';
import { exchangeSettingsDefault } from '$lib/server/integrations/settings';
import { DEFAULT_ROLES, PERMISSION_KEYS, type PermissionKey } from '$lib/server/rbac/permissions';
import { closeRedis } from '$lib/server/redis';
import { B2B_PROCESS, B2C_PROCESS } from '$lib/server/stages/definitions';
import { CONTRACT_SEED_SIZES } from '../../../scripts/seed/contracts';
import { DIRECTORY_SEED_SIZES } from '../../../scripts/seed/directory';
import { STATS_SEED_SIZES } from '../../../scripts/seed/stats';
import { INTERACTION_SEED_SIZES } from '../../../scripts/seed/interactions';
import { ROSTER_SEED_SIZES } from '../../../scripts/seed/rosters';
import { main, seedAll, seedRolesOnly } from '../../../scripts/seed/run';
import { seedId } from '../../../scripts/seed/ids';
import { DEMO_EMAILS, SERVICE_USER_EMAIL, STAFF_ADMIN_EMAIL } from '../../../scripts/seed/users';
import { startTestDatabase, type TestDatabase } from '../helpers/db';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Маршруты обмена: ими проверяется, что заведённый сидом ключ не просто лежит в
 * таблице, а проходит вход — и проходит ровно на своём направлении. Обработчик
 * типизирован своим маршрутом, а поддельное событие — общим типом события,
 * поэтому подпись сужается один раз здесь.
 */
type Endpoint = (event: RequestEvent) => Response | Promise<Response>;

const applications = (await import('../../../src/routes/api/v1/applications/+server'))
	.POST as Endpoint;
const groupResults = (
	await import('../../../src/routes/api/v1/exchange/learning-groups/results/+server')
).POST as Endpoint;

let database: TestDatabase;

async function runSeed(): Promise<void> {
	await seedAll();
}

/** Записи стадий, на которых взаимодействия стоят прямо сейчас. */
async function openEntries(): Promise<
	{ interactionId: string; isOverdue: boolean; isPaused: boolean }[]
> {
	return database.db
		.select({
			interactionId: stageEntries.interactionId,
			isOverdue: stageEntryStatus.isOverdue,
			isPaused: stageEntryStatus.isPaused
		})
		.from(stageEntries)
		.innerJoin(stageEntryStatus, eq(stageEntryStatus.stageEntryId, stageEntries.id))
		.where(isNull(stageEntries.leftAt));
}

async function countRows(table: PgTable): Promise<number> {
	const [row] = await database.db.select({ value: count() }).from(table);

	return row.value;
}

beforeAll(async () => {
	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	// Обращение к маршруту API поднимает клиент Redis — там живут счётчики
	// лимита частоты; без явного закрытия прогон держал бы открытый сокет.
	await closeRedis();
	await database.stop();
});

beforeEach(async () => {
	await database.reset();
});

describe('сид', () => {
	it('заполняет справочники на пустой базе', async () => {
		await runSeed();

		await expect(countRows(organizations)).resolves.toBe(DIRECTORY_SEED_SIZES.organizations);
		await expect(countRows(sites)).resolves.toBe(DIRECTORY_SEED_SIZES.sites);
		// Слушателей групп заводит загрузка их списков, а не справочник.
		await expect(countRows(people)).resolves.toBe(
			DIRECTORY_SEED_SIZES.people + ROSTER_SEED_SIZES.learners
		);
		await expect(countRows(affiliations)).resolves.toBe(
			DIRECTORY_SEED_SIZES.affiliations + ROSTER_SEED_SIZES.affiliations
		);
		await expect(countRows(programs)).resolves.toBe(DIRECTORY_SEED_SIZES.programs);
		await expect(countRows(programVersions)).resolves.toBe(DIRECTORY_SEED_SIZES.programVersions);
		await expect(countRows(products)).resolves.toBe(DIRECTORY_SEED_SIZES.products);
		await expect(countRows(directions)).resolves.toBe(DIRECTORY_SEED_SIZES.directions);
		await expect(countRows(productDirections)).resolves.toBe(
			DIRECTORY_SEED_SIZES.productDirections
		);
		await expect(countRows(organizationResponsibles)).resolves.toBe(
			DIRECTORY_SEED_SIZES.responsibles
		);

		const demo = await database.db
			.select({ email: users.email, roleId: users.roleId })
			.from(users)
			.where(eq(users.isDemo, true))
			.orderBy(users.email);

		expect(demo.map((account) => account.email)).toStrictEqual([
			DEMO_EMAILS.admin,
			DEMO_EMAILS.lead,
			DEMO_EMAILS.manager
		]);
		expect(demo.map((account) => account.roleId)).toStrictEqual(['admin', 'lead', 'manager']);
	});

	it('ставит менеджерам руководителя: на иерархии держится область и эскалация', async () => {
		await runSeed();

		const rows = await database.db
			.select({
				id: users.id,
				email: users.email,
				roleId: users.roleId,
				managerUserId: users.managerUserId
			})
			.from(users)
			.orderBy(users.email);

		const lead = rows.find((row) => row.email === DEMO_EMAILS.lead);
		const demoManager = rows.find((row) => row.email === DEMO_EMAILS.manager);

		expect(lead?.managerUserId).toBeNull();
		expect(demoManager?.managerUserId).toBe(lead?.id);

		// Демонстрационный менеджер и два сотрудника оператора: подготовка
		// прогона заводит своих пользователей на роль, и они здесь ни при чём.
		const reporting = rows.filter((row) => row.managerUserId === lead?.id);
		expect(reporting).toHaveLength(3);
	});

	it('назначает процесс пространству и проставляет его взаимодействиям', async () => {
		await runSeed();

		const [b2b] = await database.db
			.select({
				id: workspaces.id,
				workflowId: workflows.id,
				activeRevisionId: workflows.activeRevisionId
			})
			.from(workspaces)
			.innerJoin(workflows, eq(workflows.id, workspaces.workflowId))
			.where(eq(workspaces.key, 'b2b'));

		// Действующая редакция процесса — та самая, которую завёл набор.
		expect(b2b.activeRevisionId).not.toBeNull();

		// Реестр ключей висит на процессе, а не на месте: если два пространства
		// работают по одному процессу, стадия `signing` в них одна и та же.
		const keys = await database.db
			.select({ key: processStageKeys.key })
			.from(processStageKeys)
			.where(eq(processStageKeys.workflowId, b2b.workflowId));

		expect(keys.map((row) => row.key).sort()).toStrictEqual(
			B2B_PROCESS.stages.map((stage) => stage.key).sort()
		);

		// Сид заводит записи в том пространстве, которое назвал сам: вуз — в
		// `b2b`, физическое и юридическое лицо — в `b2c`.
		const grouped = await database.db
			.select({ count: count() })
			.from(interactions)
			.where(eq(interactions.workspaceId, b2b.id));

		expect(grouped[0].count).toBe(INTERACTION_SEED_SIZES.interactions - INTERACTION_SEED_SIZES.b2c);
		const ungrouped = await database.db
			.select({ count: count() })
			.from(interactions)
			.where(isNull(interactions.workspaceId));

		expect(ungrouped[0].count).toBe(0);
	});

	it('ведёт обучение лиц по группе b2c: и физическое лицо, и юридическое', async () => {
		await runSeed();

		const [b2c] = await database.db
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(eq(workspaces.key, 'b2c'));

		// Основная сторона такой записи — сам контрагент, и его вид решает группу.
		const parties = await database.db
			.select({ kind: organizations.kind })
			.from(interactions)
			.innerJoin(
				interactionParties,
				and(
					eq(interactionParties.interactionId, interactions.id),
					eq(interactionParties.isPrimary, true)
				)
			)
			.innerJoin(organizations, eq(organizations.id, interactionParties.organizationId))
			.where(eq(interactions.workspaceId, b2c.id));

		expect(parties).toHaveLength(INTERACTION_SEED_SIZES.b2c);
		expect(new Set(parties.map((row) => row.kind))).toStrictEqual(
			new Set(['individual', 'legal_entity'])
		);

		// Физическое лицо — это строка организации со ссылкой на человека, а не
		// вторая копия ФИО: контур персональных данных у него один.
		const [individual] = await database.db
			.select({ personId: organizations.personId, shortName: organizations.shortName })
			.from(organizations)
			.where(eq(organizations.kind, 'individual'));

		expect(individual.personId).not.toBeNull();
		expect(individual.shortName).toBe('Сорокин Артём Павлович');
	});

	it('подтверждает стадию обучения фактом из системы обучения', async () => {
		await runSeed();

		// Поток и его результат — на каждую запись, дошедшую до стадии с данными
		// обучения, в обеих группах.
		await expect(countRows(learningGroups)).resolves.toBe(INTERACTION_SEED_SIZES.learningGroups);
		await expect(countRows(learningGroupResults)).resolves.toBe(
			INTERACTION_SEED_SIZES.learningResults
		);

		// Поток закрепляет, что и для кого обучается: программу записи и
		// назначение.
		const [group] = await database.db
			.select({ programId: learningGroups.programId, purpose: learningGroups.purpose })
			.from(learningGroups)
			.where(eq(learningGroups.interactionId, seedId('interaction', 'sorokin-obuchenie')));

		expect(group).toEqual({ programId: seedId('program', 'dpo-01'), purpose: 'upskilling' });

		// Стадия «Зачисление и обучение» стоит на промежуточном результате:
		// данные получены, обучение идёт, — и стадия не подтверждена. Стенду
		// нужно и это состояние, а не только завершённые потоки.
		const [open] = await database.db
			.select({ evidence: stageEntries.lmsEvidence })
			.from(stageEntries)
			.where(
				and(
					eq(stageEntries.interactionId, seedId('interaction', 'sorokin-obuchenie')),
					isNull(stageEntries.leftAt)
				)
			);

		expect(open.evidence).toBeNull();

		// Пройденную «Ведение занятий» подтвердил итог: завершившие и дата
		// окончания.
		const [passed] = await database.db
			.select({ evidence: stageEntries.lmsEvidence })
			.from(stageEntries)
			.where(
				and(
					eq(stageEntries.interactionId, seedId('interaction', 'szpu-2025')),
					sql`${stageEntries.stageSnapshot} ->> 'key' = 'classes'`
				)
			);

		expect(passed.evidence).toMatchObject({ kind: 'result', completed: 48 });
	});

	it('заводит договоры и привязывает к взаимодействиям их позиции', async () => {
		await runSeed();

		await expect(countRows(contracts)).resolves.toBe(CONTRACT_SEED_SIZES.contracts);
		await expect(countRows(contractItems)).resolves.toBe(CONTRACT_SEED_SIZES.items);
		await expect(countRows(interactionContractItems)).resolves.toBe(
			CONTRACT_SEED_SIZES.interactionItems
		);

		// Один договор обслуживает несколько взаимодействий: он принадлежит
		// контрагенту, а не записи процесса.
		const shared = await database.db
			.select({ contractId: interactions.contractId })
			.from(interactions)
			.where(isNotNull(interactions.contractId));

		expect(shared.length).toBeGreaterThan(new Set(shared.map((row) => row.contractId)).size);

		// Позиции договоров с вузами передал акт: «передан» стоит ровно на тех,
		// что названы в утверждённом акте передачи, и ни на одной другой.
		const inActs = await database.db
			.selectDistinct({ id: documentContractItems.contractItemId })
			.from(documentContractItems)
			.innerJoin(documents, eq(documents.id, documentContractItems.documentId))
			.where(and(eq(documents.templateKey, 'handover_act'), isNotNull(documents.approvedAt)));
		const institutionItems = await database.db
			.select({ id: contractItems.id, transferStatus: contractItems.transferStatus })
			.from(contractItems)
			.innerJoin(contracts, eq(contracts.id, contractItems.contractId))
			.innerJoin(organizations, eq(organizations.id, contracts.organizationId))
			.where(eq(organizations.kind, 'educational_institution'));

		expect(inActs.map((row) => row.id).sort()).toStrictEqual(
			institutionItems
				.filter((item) => item.transferStatus === 'передан')
				.map((item) => item.id)
				.sort()
		);
		expect(inActs.map((row) => row.id).sort()).toStrictEqual(
			[
				['szpu-2026', 'lms'],
				['szpu-2026', 'analytics'],
				['szpu-2026', 'cloud'],
				['ukct-2026', 'lms'],
				['vkgtu-2026', 'docs'],
				['vkgtu-2026', 'security'],
				['uguis-licenses', 'lab'],
				['sivt-licenses', 'lms'],
				['batse-licenses', 'docs'],
				['sruit-licenses', 'docs'],
				['puts-licenses', 'lab'],
				['yutus-licenses', 'lab'],
				['bit-licenses', 'lab'],
				['nkis-licenses', 'analytics']
			]
				.map(([contract, product]) => seedId('contract-item', `${contract}:${product}`))
				.sort()
		);

		// Акт с позициями — у каждого дела с договором, прошедшего передачу.
		const actsWithItems = await database.db
			.selectDistinct({ interactionId: documents.interactionId })
			.from(documents)
			.innerJoin(documentContractItems, eq(documentContractItems.documentId, documents.id));

		expect(actsWithItems.map((row) => row.interactionId).sort()).toStrictEqual(
			[
				'szpu-vnedrenie',
				'vkgtu-prepod',
				'ukct-zanyatiya',
				'szpu-2025',
				'uguis-vnedr',
				'uguis-documentation_update-70',
				'uguis-2025b',
				'sivt-implementation_support-54',
				'batse-implementation_support-56',
				'sruit-teacher_training-58',
				'sruit-2025',
				'puts-teacher_training-60',
				'ukct-program_update-62',
				'ukct-2025-spo',
				'szpu-classes-68',
				'yutus-documentation_update-72',
				'vkgtu-qualification_upgrade-74',
				'vkgtu-2025-mag',
				'bit-execution_control-76',
				'nkis-2025'
			]
				.map((key) => seedId('interaction', key))
				.sort()
		);
	});

	it('заводит поимённые списки учебных групп, часть из них передана', async () => {
		await runSeed();

		const rows = await database.db
			.select({
				learningGroupId: learningGroupLearners.learningGroupId,
				status: learningGroupLearners.status
			})
			.from(learningGroupLearners);

		expect(rows).toHaveLength(ROSTER_SEED_SIZES.learners);
		expect(new Set(rows.map((row) => row.learningGroupId)).size).toBe(ROSTER_SEED_SIZES.groups);
		expect(rows.filter((row) => row.status === 'transferred')).toHaveLength(
			ROSTER_SEED_SIZES.transferred
		);

		// Контакты слушателей лежат шифртекстом, как у остальных людей набора.
		const [learner] = await database.db
			.select({ email: people.email, emailHash: people.emailHash })
			.from(learningGroupLearners)
			.innerJoin(people, eq(people.id, learningGroupLearners.personId))
			.limit(1);

		expect(learner.emailHash).not.toBeNull();
		expect(learner.email).not.toContain('@');
	});

	it('заводит взаимодействия на стадиях маршрута', async () => {
		await runSeed();

		await expect(countRows(interactions)).resolves.toBe(INTERACTION_SEED_SIZES.interactions);

		const open = await openEntries();
		const active =
			INTERACTION_SEED_SIZES.interactions -
			INTERACTION_SEED_SIZES.completed -
			INTERACTION_SEED_SIZES.cancelled;

		// Открытая запись ровно одна у каждого незакрытого взаимодействия, и ни
		// одной у завершённых или отменённых: закрытие выводит взаимодействие с
		// маршрута в обоих случаях.
		expect(open).toHaveLength(active);
		expect(new Set(open.map((entry) => entry.interactionId)).size).toBe(active);
		expect(open.filter((entry) => entry.isOverdue)).toHaveLength(INTERACTION_SEED_SIZES.overdue);
		expect(open.filter((entry) => entry.isPaused)).toHaveLength(INTERACTION_SEED_SIZES.paused);

		const completed = await database.db
			.select({ id: interactions.id })
			.from(interactions)
			.where(eq(interactions.status, 'completed'));

		expect(completed).toHaveLength(INTERACTION_SEED_SIZES.completed);

		// Отменённое дело тоже сходит с маршрута: у него нет открытой записи
		// стадии, но, в отличие от завершённого, нет и записи на каждую стадию
		// маршрута — она есть только на пройденные.
		const cancelled = await database.db
			.select({ id: interactions.id })
			.from(interactions)
			.where(eq(interactions.status, 'cancelled'));

		expect(cancelled).toHaveLength(INTERACTION_SEED_SIZES.cancelled);

		await expect(countRows(comments)).resolves.toBe(INTERACTION_SEED_SIZES.comments);
		await expect(countRows(blockers)).resolves.toBe(INTERACTION_SEED_SIZES.blockers);
		// Смена ответственного попадает в историю плана: вкладка «Правки плана»
		// на стенде не должна быть пустой у всех до единого.
		await expect(countRows(interactionChanges)).resolves.toBe(INTERACTION_SEED_SIZES.handovers);
		// Каждое соглашение и каждый акт передачи собираются сразу в двух форматах:
		// DOCX и PDF, к одному делу приложен скан и его вторая редакция, у каждого
		// дела, прошедшего подписание, лежит подписанный экземпляр с отметкой
		// «Утверждён», а у завершённого обучения лица — документ об обучении.
		// Дело, ушедшее со стадии обмена вперёд, собрало на ней пакет —
		// соглашение в тех же двух форматах. Сверх документов дел — по описанию
		// в PDF у каждой программы.
		await expect(countRows(documents)).resolves.toBe(
			INTERACTION_SEED_SIZES.documents * 2 +
				INTERACTION_SEED_SIZES.scans +
				INTERACTION_SEED_SIZES.signedAgreements +
				INTERACTION_SEED_SIZES.handoverActs * 2 +
				INTERACTION_SEED_SIZES.packageAgreements * 2 +
				INTERACTION_SEED_SIZES.trainingDocuments +
				DIRECTORY_SEED_SIZES.programMaterials
		);

		// Отметка «Утверждён» стоит ровно на них: стадии подписания и передачи
		// без неё вперёд не отпускают, а лишних отметок набор не ставит. Акт
		// передачи узнаётся по шаблону — иначе передачу закрыло бы соглашение.
		const approved = await database.db
			.select({ templateKey: documents.templateKey })
			.from(documents)
			.where(isNotNull(documents.approvedAt));

		expect(approved).toHaveLength(
			INTERACTION_SEED_SIZES.signedAgreements + INTERACTION_SEED_SIZES.handoverActs
		);
		expect(approved.filter((row) => row.templateKey === 'handover_act')).toHaveLength(
			INTERACTION_SEED_SIZES.handoverActs
		);

		// Завершённое взаимодействие прошло маршрут целиком: по записи на каждую
		// стадию, и все они закрыты.
		const completedEntries = await database.db
			.select({ leftAt: stageEntries.leftAt })
			.from(stageEntries)
			.innerJoin(interactions, eq(interactions.id, stageEntries.interactionId))
			.where(eq(interactions.status, 'completed'));

		expect(completedEntries).toHaveLength(
			INTERACTION_SEED_SIZES.completedB2b * B2B_PROCESS.stages.length +
				INTERACTION_SEED_SIZES.completedB2c * B2C_PROCESS.stages.length
		);
		expect(completedEntries.filter((entry) => entry.leftAt === null)).toStrictEqual([]);
	});

	it('заливает данные об обучении и считает по ним показатели', async () => {
		await runSeed();

		await expect(countRows(statSnapshots)).resolves.toBe(STATS_SEED_SIZES.snapshots);
		await expect(countRows(statRows)).resolves.toBe(STATS_SEED_SIZES.rows);

		const current = await database.db
			.select({ id: statSnapshots.id })
			.from(statSnapshots)
			.where(eq(statSnapshots.isCurrent, true));

		expect(current).toHaveLength(STATS_SEED_SIZES.confirmed);

		const invalid = await database.db
			.select({ id: statRows.id })
			.from(statRows)
			.where(eq(statRows.isValid, false));

		// Снимок, который ждёт решения, обязан быть на стенде: без ошибочных
		// строк проверка выглядит формальностью.
		expect(invalid).toHaveLength(STATS_SEED_SIZES.invalidRows);

		const indicators = await database.db
			.select({
				applications: statProgramIndicators.applications,
				completed: statProgramIndicators.completed
			})
			.from(statProgramIndicators);

		expect(indicators.length).toBeGreaterThan(0);
		// В наборе есть и ноль, и пропуск: показатель обязан их различать.
		expect(indicators.some((row) => row.applications === 0)).toBe(true);
		expect(indicators.some((row) => row.completed === null)).toBe(true);
	});

	it('называет в строках снимков те коды программ, что есть в справочнике', async () => {
		await runSeed();

		const [snapshots, rows, catalog] = await Promise.all([
			database.db
				.select({ id: statSnapshots.id, mapping: statSnapshots.mapping })
				.from(statSnapshots),
			database.db.select({ snapshotId: statRows.snapshotId, raw: statRows.raw }).from(statRows),
			database.db.select({ code: programs.code }).from(programs)
		]);

		const known = new Set(catalog.map((program) => program.code));
		// Колонку с программой называет сопоставление снимка — то же самое, по
		// которому её читает и продукт, а не имя колонки, переписанное в тест.
		const programColumn = new Map(
			snapshots.map((snapshot) => [
				snapshot.id,
				Object.entries(snapshot.mapping).find(([, field]) => field === 'program')?.[0]
			])
		);

		const codes = rows.map((row) => {
			const column = programColumn.get(row.snapshotId);

			if (column === undefined) {
				throw new Error('у снимка сида колонка программы обязана быть сопоставлена');
			}

			return row.raw[column];
		});

		// Есть на чём проверять: иначе тест зелен от того, что строк нет.
		expect(codes.length).toBe(STATS_SEED_SIZES.rows);
		expect(codes.filter((code) => !known.has(code))).toStrictEqual([]);
	});

	it('повторный сид не плодит строк данных об обучении', async () => {
		await runSeed();
		await runSeed();

		await expect(countRows(statSnapshots)).resolves.toBe(STATS_SEED_SIZES.snapshots);
		await expect(countRows(statRows)).resolves.toBe(STATS_SEED_SIZES.rows);
	});

	it('заполняет срок соглашения у каждого взаимодействия', async () => {
		await runSeed();

		// Соглашение по шаблону собирается из срока в плане: запись без него —
		// тупик ровно на том пути, которым стенд и открывают.
		const rows = await database.db
			.select({
				id: interactions.id,
				start: interactions.agreementPeriodStart,
				end: interactions.agreementPeriodEnd
			})
			.from(interactions);

		expect(rows).toHaveLength(INTERACTION_SEED_SIZES.interactions);
		expect(rows.filter((row) => row.start === null || row.end === null)).toStrictEqual([]);
	});

	it('разводит события истории по времени', async () => {
		await runSeed();

		const [commentRows, blockerRows, changeRows] = await Promise.all([
			database.db
				.select({ interactionId: comments.interactionId, at: comments.createdAt })
				.from(comments),
			database.db
				.select({ interactionId: blockers.interactionId, at: blockers.raisedAt })
				.from(blockers),
			database.db
				.select({
					interactionId: interactionChanges.interactionId,
					at: interactionChanges.changedAt
				})
				.from(interactionChanges)
		]);

		const byInteraction = new Map<string, number[]>();

		for (const row of [...commentRows, ...blockerRows, ...changeRows]) {
			byInteraction.set(row.interactionId, [
				...(byInteraction.get(row.interactionId) ?? []),
				row.at.getTime()
			]);
		}

		const crowded = [...byInteraction.values()].filter((moments) => moments.length > 1);

		// Есть на чём проверять: иначе тест зелен от того, что событий нет.
		expect(crowded.length).toBeGreaterThan(0);
		// Слипшиеся в одну отметку события читаются как сбой системы, а не как
		// ход работы: у каждого события записи свой момент.
		expect(crowded.filter((moments) => new Set(moments).size !== moments.length)).toStrictEqual([]);
	});

	it('повторный сид не пересоздаёт историю взаимодействий', async () => {
		await runSeed();

		const before = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.orderBy(stageEntries.id);

		await runSeed();

		const after = await database.db
			.select({ id: stageEntries.id })
			.from(stageEntries)
			.orderBy(stageEntries.id);

		expect(after).toStrictEqual(before);
		await expect(countRows(interactions)).resolves.toBe(INTERACTION_SEED_SIZES.interactions);
		await expect(countRows(comments)).resolves.toBe(INTERACTION_SEED_SIZES.comments);

		const open = await openEntries();

		expect(open.filter((entry) => entry.isOverdue)).toHaveLength(INTERACTION_SEED_SIZES.overdue);
	});

	it('на повторном запуске не плодит строк и не меняет идентификаторов', async () => {
		await runSeed();

		const organizationsBefore = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.orderBy(organizations.id);
		const peopleBefore = await database.db
			.select({ id: people.id })
			.from(people)
			.orderBy(people.id);

		await runSeed();

		const organizationsAfter = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.orderBy(organizations.id);
		const peopleAfter = await database.db.select({ id: people.id }).from(people).orderBy(people.id);

		expect(organizationsAfter).toStrictEqual(organizationsBefore);
		expect(peopleAfter).toStrictEqual(peopleBefore);
		await expect(countRows(affiliations)).resolves.toBe(
			DIRECTORY_SEED_SIZES.affiliations + ROSTER_SEED_SIZES.affiliations
		);
		await expect(countRows(learningGroupLearners)).resolves.toBe(ROSTER_SEED_SIZES.learners);
		await expect(countRows(programVersions)).resolves.toBe(DIRECTORY_SEED_SIZES.programVersions);
		await expect(countRows(programDocuments)).resolves.toBe(DIRECTORY_SEED_SIZES.programMaterials);
		// По записи на роль от подготовки прогона плюс семь от сида: три
		// демонстрационные, два сотрудника, администратор стенда и машинный
		// субъект обмена.
		await expect(countRows(users)).resolves.toBe(DEFAULT_ROLES.length + 7);
	});

	it('не затирает правку, сделанную на стенде', async () => {
		await runSeed();

		const [target] = await database.db
			.select({ id: organizations.id })
			.from(organizations)
			.orderBy(organizations.id)
			.limit(1);

		await database.db
			.update(organizations)
			.set({ shortName: 'Переименовано руками', notes: null })
			.where(eq(organizations.id, target.id));

		await runSeed();

		const [after] = await database.db
			.select({ shortName: organizations.shortName, notes: organizations.notes })
			.from(organizations)
			.where(eq(organizations.id, target.id));

		expect(after.shortName).toBe('Переименовано руками');
		expect(after.notes).toBeNull();
	});

	it('заводит записи стенда без паролей: их спрашивает каталог учётных записей', async () => {
		await runSeed();

		// Три демонстрационные записи, двое сотрудников, администратор стенда и
		// машинный субъект обмена — плюс по записи на роль от подготовки прогона.
		await expect(countRows(users)).resolves.toBe(DEFAULT_ROLES.length + 7);

		const [staff] = await database.db
			.select({ roleId: users.roleId, isDemo: users.isDemo, isActive: users.isActive })
			.from(users)
			.where(eq(users.email, STAFF_ADMIN_EMAIL));

		expect(staff).toStrictEqual({ roleId: 'admin', isDemo: false, isActive: true });

		// `external_subject` пуст у всех: связывание идёт при первом входе по
		// подтверждённой почте, а не сидом.
		const linked = await database.db
			.select({ email: users.email })
			.from(users)
			.where(isNotNull(users.externalSubject));

		expect(linked).toStrictEqual([]);
	});

	it('заводит машинного субъекта, на которого выпускаются ключи обмена', async () => {
		await runSeed();

		const [service] = await database.db
			.select({ roleId: users.roleId, isDemo: users.isDemo })
			.from(users)
			.where(eq(users.email, SERVICE_USER_EMAIL));

		expect(service).toStrictEqual({ roleId: 'service', isDemo: false });
	});

	it('не переписывает роль и руководителя уже заведённой записи', async () => {
		const id = '00000000-0000-4000-8000-0000000051a1';

		await database.db.insert(users).values({
			id,
			email: STAFF_ADMIN_EMAIL,
			fullName: 'Администратор, заведённый руками',
			roleId: 'admin'
		});

		await runSeed();

		const rows = await database.db
			.select({ id: users.id, fullName: users.fullName })
			.from(users)
			.where(eq(users.email, STAFF_ADMIN_EMAIL));

		expect(rows).toStrictEqual([{ id, fullName: 'Администратор, заведённый руками' }]);
	});

	it('кладёт в базу только ИНН, проходящие контрольную сумму', async () => {
		await runSeed();

		// Физическое лицо из счёта исключено: ИНН у него набор не собирает вовсе —
		// это персональные данные, без которых процесс обучения обходится.
		const rows = await database.db
			.select({ inn: organizations.inn })
			.from(organizations)
			.where(ne(organizations.kind, 'individual'));
		const filled = rows.map((row) => row.inn).filter((inn): inn is string => inn !== null);

		expect(filled).toHaveLength(
			DIRECTORY_SEED_SIZES.organizations - DIRECTORY_SEED_SIZES.individuals
		);
		expect(filled.filter((inn) => !isValidInn(inn))).toStrictEqual([]);
		expect(new Set(filled).size).toBe(filled.length);
	});

	/**
	 * Названия вузов и продуктов в наборе публичные, поэтому ИНН рядом с ними
	 * обязан быть заведомо чужим: `0000` — код налогового органа, которого не
	 * существует, и настоящий ИНН так начаться не может (`docs/seeds.md`).
	 * Контрольную сумму такой номер всё равно проходит — её сторожит проверка
	 * выше.
	 */
	it('берёт ИНН только из синтетического диапазона «0000…»', async () => {
		await runSeed();

		const rows = await database.db
			.select({ shortName: organizations.shortName, inn: organizations.inn })
			.from(organizations)
			.where(ne(organizations.kind, 'individual'));

		expect(rows.filter((row) => row.inn === null || !row.inn.startsWith('0000'))).toStrictEqual([]);
	});

	/**
	 * Пометка о демонстрационных данных: набор называет настоящие вузы и
	 * продукты, и человек на стенде обязан видеть, что люди, договоры и числа
	 * рядом с ними выдуманы. Место пометки — примечание организации-оператора,
	 * от чьего имени ведётся весь процесс.
	 */
	it('несёт пометку о демонстрационных данных в примечании оператора', async () => {
		await runSeed();

		const [operator] = await database.db
			.select({ notes: organizations.notes })
			.from(organizations)
			.where(eq(organizations.kind, 'operator'));

		expect(operator?.notes).toMatch(/Демонстрационные данные/);
		expect(operator?.notes).toMatch(/вымышлен/);
	});
});

/**
 * Ключи обмена стенда.
 *
 * Значение задаёт окружение, а не выпуск из интерфейса: на публичном стенде
 * выпустить ключ некому — демонстрационная сессия не получает права
 * `api_keys.manage`, а у штатного администратора нет учётной записи в каталоге
 * (`docs/seeds.md`, «Ключи обмена»).
 */
describe('ключи обмена', () => {
	/** Формат тот же, в каком ключ выпускает система: «lct_» и 32 символа. */
	const CMS_KEY = 'lct_seedCmsKey0123456789abcdefghijkl';
	const LMS_KEY = 'lct_seedLmsKey0123456789abcdefghijkl';
	const ROTATED_CMS_KEY = 'lct_seedCmsKeyRotated0123456789abcde';

	/**
	 * Запрос к маршруту обмена этим ключом. Тело намеренно пустое: проверяется
	 * не приём заявки — у него свой файл, — а граница ключа. Отказ границы даёт
	 * 403 до всякого разбора тела, а разбор пустого тела — 400.
	 */
	async function exchangePost(endpoint: Endpoint, routeId: string, key: string): Promise<number> {
		const url = new URL(`http://localhost${routeId}`);

		const response = await endpoint({
			request: new Request(url, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: '{}'
			}),
			url,
			params: {},
			route: { id: routeId },
			locals: { requestId: crypto.randomUUID(), user: null, apiKey: null },
			getClientAddress: () => '198.51.100.90',
			setHeaders: () => {},
			isDataRequest: false,
			isSubRequest: false
		} as unknown as RequestEvent);

		return response.status;
	}

	/** Ключи в порядке подключения: что заведено и на кого. */
	async function issuedKeys(): Promise<
		{
			id: string;
			keyHash: string;
			exchangeSystem: string | null;
			exchangeInstance: string | null;
			ownerUserId: string;
			revokedAt: Date | null;
		}[]
	> {
		return database.db
			.select({
				id: apiKeys.id,
				keyHash: apiKeys.keyHash,
				exchangeSystem: apiKeys.exchangeSystem,
				exchangeInstance: apiKeys.exchangeInstance,
				ownerUserId: apiKeys.ownerUserId,
				revokedAt: apiKeys.revokedAt
			})
			.from(apiKeys)
			.orderBy(apiKeys.exchangeSystem);
	}

	afterEach(() => {
		delete process.env.EXCHANGE_API_KEY_CMS;
		delete process.env.EXCHANGE_API_KEY_LMS;
	});

	it('заводит по ключу на подключение, на машинном субъекте обмена', async () => {
		process.env.EXCHANGE_API_KEY_CMS = CMS_KEY;
		process.env.EXCHANGE_API_KEY_LMS = LMS_KEY;

		await runSeed();

		const [service] = await database.db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, SERVICE_USER_EMAIL));

		const defaults = exchangeSettingsDefault();
		const rows = await issuedKeys();

		expect(rows).toStrictEqual([
			{
				id: seedId('api-key', 'exchange-cms'),
				keyHash: hashApiKey(CMS_KEY),
				exchangeSystem: 'cms',
				exchangeInstance: defaults.cms.instance,
				ownerUserId: service.id,
				revokedAt: null
			},
			{
				id: seedId('api-key', 'exchange-lms'),
				keyHash: hashApiKey(LMS_KEY),
				exchangeSystem: 'lms',
				exchangeInstance: defaults.lms.instance,
				ownerUserId: service.id,
				revokedAt: null
			}
		]);
	});

	it('без переменных не заводит ни одного ключа', async () => {
		await runSeed();

		await expect(countRows(apiKeys)).resolves.toBe(0);
	});

	it('заводит ключ только того направления, чья переменная задана', async () => {
		process.env.EXCHANGE_API_KEY_LMS = LMS_KEY;

		await runSeed();

		const rows = await issuedKeys();

		expect(rows.map((row) => row.exchangeSystem)).toStrictEqual(['lms']);
	});

	it('повторный сид не плодит ключей и не переписывает значение', async () => {
		process.env.EXCHANGE_API_KEY_CMS = CMS_KEY;
		process.env.EXCHANGE_API_KEY_LMS = LMS_KEY;

		await runSeed();
		await runSeed();

		await expect(countRows(apiKeys)).resolves.toBe(2);

		// Смена значения переменной заведённый ключ не трогает: хеш нового
		// значения означал бы новый ключ, а прежний перестал бы работать без
		// единого следа. Сид сообщает об этом строкой, а не молча.
		process.env.EXCHANGE_API_KEY_CMS = ROTATED_CMS_KEY;

		await runSeed();

		const rows = await issuedKeys();

		expect(rows).toHaveLength(2);
		expect(rows[0].keyHash).toBe(hashApiKey(CMS_KEY));
	});

	it('пускает ключ сайта на заявки и не пускает его на результаты учебных групп', async () => {
		process.env.EXCHANGE_API_KEY_CMS = CMS_KEY;
		process.env.EXCHANGE_API_KEY_LMS = LMS_KEY;

		await runSeed();

		// 400 — тело не разобрано, то есть границу ключ прошёл: право, роль
		// `service` и направление подключения сошлись.
		await expect(exchangePost(applications, '/api/v1/applications', CMS_KEY)).resolves.toBe(400);
		await expect(
			exchangePost(groupResults, '/api/v1/exchange/learning-groups/results', LMS_KEY)
		).resolves.toBe(400);

		// А чужим направлением — не проходит: права у обоих ключей одни и те же,
		// и различает их только подключение, на которое ключ выпущен.
		await expect(
			exchangePost(groupResults, '/api/v1/exchange/learning-groups/results', CMS_KEY)
		).resolves.toBe(403);
		await expect(exchangePost(applications, '/api/v1/applications', LMS_KEY)).resolves.toBe(403);
	});

	it('не рвётся на значении, которое уже выпущено другим ключом', async () => {
		// Так выглядит стенд, который жил с ключом, выпущенным из интерфейса, а
		// потом положил его значение в `.env`: хеш уникален, и вторая строка с
		// ним остановила бы контейнер на сиде.
		const [owner] = await database.db.select({ id: users.id }).from(users).limit(1);

		await database.db.insert(apiKeys).values({
			name: 'Выпущен из интерфейса',
			keyHash: hashApiKey(CMS_KEY),
			ownerUserId: owner.id
		});

		process.env.EXCHANGE_API_KEY_CMS = CMS_KEY;
		process.env.EXCHANGE_API_KEY_LMS = LMS_KEY;

		await runSeed();

		// Чужой ключ остался как был, свой заведён только у второго направления.
		const rows = await issuedKeys();

		expect(rows.map((row) => row.exchangeSystem)).toStrictEqual(['lms', null]);
	});

	it('отвергает значение, которого система не выпустила бы', async () => {
		process.env.EXCHANGE_API_KEY_CMS = 'exchange-key';
		process.env.EXCHANGE_API_KEY_LMS = LMS_KEY;

		// Ключ не того формата не прошёл бы вход вовсе, и стенд молчал бы об этом
		// до первой заявки.
		await expect(runSeed()).rejects.toThrow('EXCHANGE_API_KEY_CMS');
		await expect(countRows(apiKeys)).resolves.toBe(0);

		// Одно значение на оба направления снимает границу между ними.
		process.env.EXCHANGE_API_KEY_CMS = LMS_KEY;

		await expect(runSeed()).rejects.toThrow('совпадают');
		await expect(countRows(apiKeys)).resolves.toBe(0);
	});
});

describe('каталог прав', () => {
	/** Право, которое проверка отбирает у базы: в коде его держат две роли из трёх. */
	const REVOKED: PermissionKey = 'stats.import';

	/** Сколько строк «роль — право» описано в коде: столько же обязано быть в базе. */
	const GRANTS = DEFAULT_ROLES.reduce((total, role) => total + role.permissions.length, 0);

	it('«--roles-only» возвращает отобранное право и не заливает ничего больше', async () => {
		// Подготовка прогона каталог уже залила, поэтому право сначала отбирается:
		// выдачи по нему уносит внешний ключ. Это тот же случай, что и релиз,
		// добавивший право, — в базе его нет, а в коде есть.
		await database.db.delete(permissions).where(eq(permissions.key, REVOKED));

		await expect(countRows(permissions)).resolves.toBe(PERMISSION_KEYS.length - 1);

		await seedRolesOnly();

		await expect(countRows(permissions)).resolves.toBe(PERMISSION_KEYS.length);
		await expect(countRows(roles)).resolves.toBe(DEFAULT_ROLES.length);
		await expect(countRows(rolePermissions)).resolves.toBe(GRANTS);

		const holders = await database.db
			.select({ roleId: rolePermissions.roleId })
			.from(rolePermissions)
			.where(eq(rolePermissions.permissionKey, REVOKED))
			.orderBy(rolePermissions.roleId);

		expect(holders.map((row) => row.roleId)).toStrictEqual(
			DEFAULT_ROLES.filter((role) => role.permissions.includes(REVOKED))
				.map((role) => role.id)
				.sort()
		);

		// Ни учётных записей сида, ни справочников: в базе остались ровно те
		// пользователи, которых завела подготовка прогона, — по одному на роль.
		await expect(countRows(users)).resolves.toBe(DEFAULT_ROLES.length);
		await expect(countRows(organizations)).resolves.toBe(0);
		await expect(countRows(people)).resolves.toBe(0);
		await expect(countRows(programs)).resolves.toBe(0);
		await expect(countRows(interactions)).resolves.toBe(0);

		const seeded = await database.db
			.select({ email: users.email })
			.from(users)
			.where(
				inArray(users.email, [...Object.values(DEMO_EMAILS), STAFF_ADMIN_EMAIL, SERVICE_USER_EMAIL])
			);

		expect(seeded).toStrictEqual([]);
	});

	it('не принимает «--roles-only» вместе с «--if-demo»', async () => {
		// Флаги противоречат друг другу: каталог прав нужен любой установке, и
		// «залей, если это стенд» о нём сказать нечего.
		await expect(main(['--roles-only', '--if-demo'])).rejects.toThrow('вместе бессмысленны');

		// Упасть разбор обязан до базы: каталог остался таким, каким был.
		await expect(countRows(permissions)).resolves.toBe(PERMISSION_KEYS.length);
	});
});

describe('запуск сида', () => {
	/**
	 * Код выхода процесса сида. Процесс, который не завершился за отведённое,
	 * убивается, и проверка получает `null`: так выглядит зависший сид.
	 */
	function runSeedProcess(args: string[], timeoutMs: number): Promise<number | null> {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ['scripts/seed/index.ts', ...args], {
				env: { ...process.env, DEMO_MODE: 'true' },
				stdio: ['ignore', 'ignore', 'inherit']
			});
			const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

			child.on('error', reject);
			child.on('exit', (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
	}

	it('на пустой базе заливает стенд и завершает процесс сам', async () => {
		// Команды движка после фиксации сообщают открытым карточкам через Redis:
		// процесс, не закрывший это соединение, живёт вечно, и контейнер так и не
		// доходит до запуска сервера.
		await expect(runSeedProcess(['--if-demo'], 120_000)).resolves.toBe(0);
		await expect(countRows(interactions)).resolves.toBeGreaterThan(0);
	}, 150_000);
});
