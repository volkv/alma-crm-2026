/**
 * Маршруты стадий: как процесс описан и как эта запись версионируется.
 *
 * Маршрут — это данные: стадии с нормативами и чек-листами плюс переходы между
 * ними. Пока `published_at` пуст, маршрут черновик и его можно править; после
 * публикации он заморожен, а изменения оформляются новой версией с тем же
 * ключом. Причина простая: взаимодействие ссылается на конкретную версию, и
 * правка опубликованного маршрута задним числом переписала бы историю уже
 * пройденных стадий.
 */
import { and, asc, desc, eq, isNotNull, max, ne } from 'drizzle-orm';
import {
	createRouteSchema,
	updateRouteSchema,
	type CreateRouteInput,
	type StageRouteView,
	type StageTransitionView,
	type StageView,
	type UpdateRouteInput
} from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { stageRoutes, stages, stageTransitions } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { DEMO_ROUTE, DEMO_ROUTE_KEY } from './demo-route';

/** Любой исполнитель запроса: транзакция вызывающего или общий пул. */
type Executor = Tx | ReturnType<typeof getDb>;

function toStageView(row: typeof stages.$inferSelect): StageView {
	return {
		id: row.id,
		routeId: row.routeId,
		position: row.position,
		key: row.key,
		name: row.name,
		category: row.category,
		slaDays: row.slaDays,
		staleAfterDays: row.staleAfterDays,
		requiresResult: row.requiresResult,
		requiresConfirmation: row.requiresConfirmation,
		checklist: row.checklist
	};
}

function toTransitionView(row: typeof stageTransitions.$inferSelect): StageTransitionView {
	return {
		id: row.id,
		fromStageId: row.fromStageId,
		toStageId: row.toStageId,
		kind: row.kind,
		requiredPermissionKey: row.requiredPermissionKey,
		requiresReason: row.requiresReason
	};
}

/**
 * Маршрут вместе со стадиями и переходами. Без проверки прав: её делает тот,
 * кто решает, зачем маршрут читают, — карточка, список или конфигуратор.
 */
export async function readRoute(executor: Executor, routeId: string): Promise<StageRouteView> {
	const [route] = await executor.select().from(stageRoutes).where(eq(stageRoutes.id, routeId));

	if (route === undefined) {
		throw new NotFoundError('Маршрут стадий не найден');
	}

	const [stageRows, transitionRows] = await Promise.all([
		executor.select().from(stages).where(eq(stages.routeId, routeId)).orderBy(asc(stages.position)),
		executor.select().from(stageTransitions).where(eq(stageTransitions.routeId, routeId))
	]);

	return {
		id: route.id,
		key: route.key,
		version: route.version,
		name: route.name,
		description: route.description,
		isDefault: route.isDefault,
		publishedAt: route.publishedAt,
		stages: stageRows.map(toStageView),
		transitions: transitionRows.map(toTransitionView)
	};
}

/** Стадии и переходы одной версии маршрута. Черновик не трогаем. */
async function writeRouteContent(
	tx: Tx,
	routeId: string,
	input: CreateRouteInput
): Promise<Map<string, string>> {
	const inserted = await tx
		.insert(stages)
		.values(
			input.stages.map((stage, index) => ({
				routeId,
				position: index + 1,
				key: stage.key,
				name: stage.name,
				category: stage.category,
				slaDays: stage.slaDays,
				staleAfterDays: stage.staleAfterDays,
				requiresResult: stage.requiresResult,
				requiresConfirmation: stage.requiresConfirmation,
				checklist: stage.checklist
			}))
		)
		.returning({ id: stages.id, key: stages.key });

	const idByKey = new Map(inserted.map((stage) => [stage.key, stage.id]));

	if (input.transitions.length > 0) {
		await tx.insert(stageTransitions).values(
			input.transitions.map((transition) => {
				const fromStageId = idByKey.get(transition.fromStageKey);
				const toStageId = idByKey.get(transition.toStageKey);

				// Схема контракта это уже проверила; здесь остаётся только снять
				// неопределённость типа — карта построена из тех же ключей.
				if (fromStageId === undefined || toStageId === undefined) {
					throw new ValidationError('Переход ссылается на стадию, которой нет в маршруте', [
						`${transition.fromStageKey} → ${transition.toStageKey}`
					]);
				}

				return {
					routeId,
					fromStageId,
					toStageId,
					kind: transition.kind,
					requiredPermissionKey: transition.requiredPermissionKey,
					requiresReason: transition.requiresReason
				};
			})
		);
	}

	return idByKey;
}

/** Следующий номер версии для ключа маршрута. */
async function nextVersion(executor: Executor, key: string): Promise<number> {
	const [row] = await executor
		.select({ value: max(stageRoutes.version) })
		.from(stageRoutes)
		.where(eq(stageRoutes.key, key));

	return (row?.value ?? 0) + 1;
}

/**
 * Новая версия маршрута. Создаётся черновиком: опубликовать её — отдельное
 * решение, потому что после публикации править уже нечего.
 */
export async function createRoute(
	ctx: ActorContext,
	input: CreateRouteInput
): Promise<StageRouteView> {
	requirePermission(ctx, 'stages.configure');

	const parsed = createRouteSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Конфигурация маршрута не прошла проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const definition = parsed.data;

	return withTransaction(ctx, async (tx) => {
		const [route] = await tx
			.insert(stageRoutes)
			.values({
				key: definition.key,
				version: await nextVersion(tx, definition.key),
				name: definition.name,
				description: definition.description,
				isDefault: definition.isDefault
			})
			.returning({ id: stageRoutes.id });

		await writeRouteContent(tx, route.id, definition);

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.route_created',
				outcome: 'success',
				subject: { type: 'stage_route', id: route.id }
			},
			tx
		);

		return readRoute(tx, route.id);
	});
}

/**
 * Правка черновика: стадии и переходы переписываются целиком. Опубликованный
 * маршрут не меняется ни на поле — для него заводят новую версию.
 */
export async function updateRoute(
	ctx: ActorContext,
	input: UpdateRouteInput
): Promise<StageRouteView> {
	requirePermission(ctx, 'stages.configure');

	const parsed = updateRouteSchema.safeParse(input);

	if (!parsed.success) {
		throw new ValidationError(
			'Конфигурация маршрута не прошла проверку',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const definition = parsed.data;

	return withTransaction(ctx, async (tx) => {
		const [route] = await tx
			.select({ id: stageRoutes.id, publishedAt: stageRoutes.publishedAt })
			.from(stageRoutes)
			.where(eq(stageRoutes.id, definition.id))
			.for('update');

		if (route === undefined) {
			throw new NotFoundError('Маршрут стадий не найден');
		}

		if (route.publishedAt !== null) {
			throw new ConflictError(
				'Опубликованный маршрут изменить нельзя: заведите новую версию с тем же ключом'
			);
		}

		await tx.delete(stageTransitions).where(eq(stageTransitions.routeId, route.id));
		await tx.delete(stages).where(eq(stages.routeId, route.id));

		await tx
			.update(stageRoutes)
			.set({
				key: definition.key,
				name: definition.name,
				description: definition.description,
				isDefault: definition.isDefault,
				updatedAt: new Date()
			})
			.where(eq(stageRoutes.id, route.id));

		await writeRouteContent(tx, route.id, definition);

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.route_updated',
				outcome: 'success',
				subject: { type: 'stage_route', id: route.id }
			},
			tx
		);

		return readRoute(tx, route.id);
	});
}

/**
 * Публикация. С этого момента маршрут неизменяем, и на него можно ставить
 * взаимодействия; маршрут по умолчанию при этом ровно один.
 */
export async function publishRoute(ctx: ActorContext, routeId: string): Promise<StageRouteView> {
	requirePermission(ctx, 'stages.configure');

	return withTransaction(ctx, async (tx) => {
		const [route] = await tx
			.select({
				id: stageRoutes.id,
				publishedAt: stageRoutes.publishedAt,
				isDefault: stageRoutes.isDefault
			})
			.from(stageRoutes)
			.where(eq(stageRoutes.id, routeId))
			.for('update');

		if (route === undefined) {
			throw new NotFoundError('Маршрут стадий не найден');
		}

		if (route.publishedAt !== null) {
			throw new ConflictError('Маршрут уже опубликован');
		}

		const [stageCount] = await tx
			.select({ id: stages.id })
			.from(stages)
			.where(eq(stages.routeId, routeId))
			.limit(1);

		if (stageCount === undefined) {
			throw new ConflictError('В маршруте нет ни одной стадии');
		}

		await publishRouteRow(tx, routeId, route.isDefault);

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.route_published',
				outcome: 'success',
				subject: { type: 'stage_route', id: routeId }
			},
			tx
		);

		return readRoute(tx, routeId);
	});
}

/** Отметка публикации и снятие признака «по умолчанию» с прежнего маршрута. */
async function publishRouteRow(tx: Tx, routeId: string, isDefault: boolean): Promise<void> {
	const now = new Date();

	await tx
		.update(stageRoutes)
		.set({ publishedAt: now, updatedAt: now })
		.where(eq(stageRoutes.id, routeId));

	if (isDefault) {
		await clearOtherDefaults(tx, routeId, now);
	}
}

/**
 * Маршрут по умолчанию ровно один: иначе «какой предлагать для нового
 * взаимодействия» становится вопросом порядка строк.
 */
async function clearOtherDefaults(tx: Tx, routeId: string, now: Date): Promise<void> {
	await tx
		.update(stageRoutes)
		.set({ isDefault: false, updatedAt: now })
		.where(and(eq(stageRoutes.isDefault, true), ne(stageRoutes.id, routeId)));
}

export async function getRoute(ctx: ActorContext, routeId: string): Promise<StageRouteView> {
	requirePermission(ctx, 'interactions.read');

	return readRoute(getDb(), routeId);
}

/** Маршрут, который предлагается для новых взаимодействий. */
export async function getDefaultRoute(ctx: ActorContext): Promise<StageRouteView> {
	requirePermission(ctx, 'interactions.read');

	const db = getDb();

	// Черновик в ответе не годится: на него нельзя поставить взаимодействие.
	const [route] = await db
		.select({ id: stageRoutes.id })
		.from(stageRoutes)
		.where(and(eq(stageRoutes.isDefault, true), isNotNull(stageRoutes.publishedAt)))
		.orderBy(desc(stageRoutes.version))
		.limit(1);

	if (route === undefined) {
		throw new NotFoundError('Маршрут стадий по умолчанию не настроен');
	}

	return readRoute(db, route.id);
}

/**
 * Демонстрационный маршрут в базе. Идемпотентно: если опубликованная версия с
 * тем же ключом уже есть, возвращается её идентификатор и ничего не пишется.
 * Зовут сиды и тесты, поэтому функция принимает транзакцию вызывающего и не
 * проверяет прав — решение принял код, который её позвал.
 */
export async function ensureDemoRoute(tx: Tx): Promise<string> {
	const [existing] = await tx
		.select({ id: stageRoutes.id })
		.from(stageRoutes)
		.where(eq(stageRoutes.key, DEMO_ROUTE_KEY))
		.orderBy(desc(stageRoutes.version))
		.limit(1);

	if (existing !== undefined) {
		return existing.id;
	}

	const definition = createRouteSchema.parse(DEMO_ROUTE);
	const now = new Date();

	const [route] = await tx
		.insert(stageRoutes)
		.values({
			key: definition.key,
			version: await nextVersion(tx, definition.key),
			name: definition.name,
			description: definition.description,
			isDefault: definition.isDefault,
			publishedAt: now
		})
		.returning({ id: stageRoutes.id });

	await writeRouteContent(tx, route.id, definition);

	if (definition.isDefault) {
		await clearOtherDefaults(tx, route.id, now);
	}

	return route.id;
}
