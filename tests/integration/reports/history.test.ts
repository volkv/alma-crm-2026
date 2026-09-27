/**
 * Исторический отчёт по обе стороны публикации изменения процесса.
 *
 * Отдельный файл, потому что это единственная проверка, где встречаются две
 * подсистемы: настоящая `publishProcess` меняет структуру и переносит записи, а
 * настоящий `buildReport` считает по ним срез на дату **раньше** публикации.
 * Проверки движка сверяют числа своим запросом по `stage_entries`, и совпадение
 * там доказывает только целость данных — не то, что отчёт читает их так же.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportQuerySchema, type ReportQuery, type ReportView } from '$lib/contracts/reports';
import type { ActorContext } from '$lib/server/actor';
import { formatIsoDay } from '$lib/format';
import { buildReport } from '$lib/server/reports/rows';
import {
	createDraft,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import { startTestDatabase, testActor, type TestDatabase } from '../helpers/db';
import {
	advanceTo,
	B2C_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess,
	threeStageProcess
} from '../stages/fixture';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

/**
 * Переменные входа через внешнего провайдера: `getConfig()` проверяет
 * конфигурацию целиком, а отчёт в провайдер не ходит (так же в
 * `reference.test.ts`).
 */
process.env.OIDC_ISSUER_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_PUBLIC_URL ??= 'http://localhost:8080/realms/lct';
process.env.OIDC_CLIENT_ID ??= 'lct-crm';
process.env.OIDC_CLIENT_SECRET ??= 'test-secret';

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

const admin = (): ActorContext => testActor({ roleId: 'admin' });

/** Весь набор уезжает в прошлое: отчёт спрашивают о дате раньше публикации. */
async function backdate(moment: string): Promise<void> {
	await database.db.execute(
		sql`update stage_entries set entered_at = ${moment}::timestamptz, updated_at = ${moment}::timestamptz where left_at is null`
	);
	await database.db.execute(
		sql`update stage_entries set entered_at = ${moment}::timestamptz, left_at = ${moment}::timestamptz, updated_at = ${moment}::timestamptz where left_at is not null`
	);
	await database.db.execute(
		sql`update interactions set created_at = ${moment}::timestamptz, updated_at = ${moment}::timestamptz`
	);
}

/** Отчёт строится внутри пространства; здесь всё происходит в B2C. */
function query(input: Record<string, unknown>): ReportQuery {
	return reportQuerySchema.parse({ workspace: B2C_WORKSPACE_KEY, ...input });
}

/**
 * Сопоставимая часть отчёта. `generatedAt` у двух сборок разный всегда, а
 * подписи строк меняться **обязаны**: стадию переименовали, и отчёт называет её
 * новым именем — это одна и та же стадия.
 */
function shape(view: ReportView) {
	return {
		rowKeys: view.rows.map((row) => row.rowKey).sort(),
		interactions: view.rows.map((row) => row.interactionId).sort(),
		totals: { rowCount: view.totals.rowCount, interactionCount: view.totals.interactionCount },
		funnel: view.charts.funnel?.stages.map((bucket) => `${bucket.key}=${bucket.value}`).sort(),
		closed: view.charts.funnel?.closed.map((bucket) => `${bucket.key}=${bucket.value}`).sort()
	};
}

const PERIOD = { mode: 'snapshot' as const, from: '2026-09-01', to: '2026-09-10' };
const MOVEMENT = { mode: 'movement' as const, from: '2026-09-01', to: '2026-09-10' };

describe('отчёт на прошлую дату до и после применения изменений', () => {
	it('даёт то же распределение по стадиям, то же движение и ту же просрочку', async () => {
		const ctx = admin();
		await seedProcess(database, B2C_WORKSPACE_KEY, threeStageProcess());

		const first = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		const second = await createInteractionOn(ctx, database, { kind: 'legal_entity' });
		const third = await createInteractionOn(ctx, database, { kind: 'legal_entity' });

		await advanceTo(ctx, database, first.interactionId, 'offer');
		await advanceTo(ctx, database, second.interactionId, 'offer');

		// Всё, что уже есть, случилось 1 сентября; отчёт спрашивают на 10-е.
		await backdate('2026-09-01T09:00:00+03:00');

		const before = await buildReport(ctx, query(PERIOD));
		const beforeMovement = await buildReport(ctx, query(MOVEMENT));
		const beforeOverdue = await buildReport(ctx, query({ ...PERIOD, overdue: 'true' }));

		// Публикация делает всё разом: «Приём» удаляется (его записи переезжают
		// на «Предложение»), «Предложение» переименовывается и получает другой
		// норматив.
		const draft = await createDraft(ctx, B2C_WORKSPACE_KEY);
		const definition = processDefinition(draft);

		await updateDraft(ctx, B2C_WORKSPACE_KEY, {
			...definition,
			migrationRules: [{ removedStageKey: 'intake', targetStageKey: 'offer' }],
			stages: definition.stages
				.filter((stage) => stage.key !== 'intake')
				.map((stage) =>
					stage.key === 'offer' ? { ...stage, name: 'Предложение вузу', slaDays: 90 } : stage
				),
			transitions: [
				{
					fromStageKey: 'offer',
					toStageKey: 'done',
					kind: 'forward' as const,
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		});

		const published = await publishProcess(ctx, B2C_WORKSPACE_KEY);

		expect(published.migratedCount).toBe(1);
		expect(published.reboundCount).toBe(2);

		const after = await buildReport(ctx, query(PERIOD));
		const afterMovement = await buildReport(ctx, query(MOVEMENT));

		// Распределение по стадиям и движение не меняются
		// (`docs/reports.md`, «Историческая семантика при изменении процесса»).
		expect(shape(after)).toStrictEqual(shape(before));
		expect(shape(afterMovement)).toStrictEqual(shape(beforeMovement));

		// Подпись строки при этом сменилась: стадия та же, название новое.
		const stageCell = (view: ReportView) =>
			view.rows.map((row) => JSON.stringify(row.cells)).join('|');

		expect(stageCell(after)).not.toBe(stageCell(before));
		expect(stageCell(after)).toMatch(/Предложение вузу/);

		// Просрочка на прошлую дату тоже не меняется: она считается по нормативу,
		// действовавшему для записи на дату среза, а не по снимку, который
		// публикация пересобрала. Норматив «Предложения» вырос с 5 до 90 дней, но
		// 10 сентября он был пятидневным — и все три строки просрочены, как и до
		// публикации. Третья стоит на «Приёме», его запись закрыта переездом.
		const afterOverdue = await buildReport(ctx, query({ ...PERIOD, overdue: 'true' }));
		const overdueRows = (view: ReportView) => view.rows.map((row) => row.interactionId).sort();

		expect(before.totals.overdue).toBe(3);
		expect(after.totals.overdue).toBe(3);
		expect(overdueRows(afterOverdue)).toStrictEqual(overdueRows(beforeOverdue));
		expect(overdueRows(afterOverdue)).toStrictEqual(
			[first.interactionId, second.interactionId, third.interactionId].sort()
		);

		// Колонка просрочки считает дни тем же нормативом: девять с лишним дней на
		// «Предложении» против пяти — пять дней просрочки, а не ноль.
		const overdueCell = (view: ReportView, interactionId: string) =>
			view.rows.find((row) => row.interactionId === interactionId)?.cells.at(-1);
		const withOverdue = await buildReport(
			ctx,
			query({ ...PERIOD, cols: 'interaction,organization,overdueDays' })
		);

		expect(overdueCell(withOverdue, first.interactionId)).toStrictEqual({
			kind: 'number',
			value: 5
		});

		// После публикации действует новый норматив: на сегодня девяносто дней
		// ещё не прошли ни у кого, и ни одна строка не просрочена.
		const today = await buildReport(
			ctx,
			query({ mode: 'snapshot', from: '2026-09-01', to: formatIsoDay() })
		);

		expect(today.totals.overdue).toBe(0);
	});
});
