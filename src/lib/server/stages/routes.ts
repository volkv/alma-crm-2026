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
import { and, asc, count, desc, eq, isNotNull, isNull, max, ne } from 'drizzle-orm';
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
import { interactions, stageRoutes, stages, stageTransitions } from '../db/schema';
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
	await requirePermission(ctx, 'stages.configure', { type: 'stages.route_created' });

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
	// Отказ отмечается до разбора входа, поэтому записи, над которой действовали,
	// в событии нет: идентификатор в `input` пока никем не проверен, а журнал —
	// не место для строки, про которую неизвестно, идентификатор ли это вообще.
	await requirePermission(ctx, 'stages.configure', { type: 'stages.route_updated' });

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
	await requirePermission(ctx, 'stages.configure', { type: 'stages.route_published' });

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

		// Публикация — последний момент, когда конфигурацию ещё можно поправить:
		// дальше по ней пойдут взаимодействия и снимут слепки стадий. Поэтому
		// связность проверяется здесь, а не только в схеме контракта, — в базу
		// маршрут мог приехать и мимо неё.
		const issues = validateRouteDraft(await readRoute(tx, routeId));

		if (issues.length > 0) {
			throw new ValidationError('Маршрут не готов к публикации', issues);
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

/**
 * Маршрут по умолчанию назначается отдельным решением, а не правкой поля:
 * признак ровно один на всю базу, и переносить его — это менять то, что
 * предложат следующему заведённому взаимодействию.
 */
export async function setDefaultRoute(ctx: ActorContext, routeId: string): Promise<StageRouteView> {
	// Отказ отмечается до того, как запись прочитана, поэтому записи в событии
	// нет: `routeId` пока никем не проверен, а `subject_id` в журнале — столбец
	// `uuid`, и строка «не идентификатор» превратила бы отказ по правам в
	// ошибку базы.
	await requirePermission(ctx, 'stages.configure', { type: 'stages.route_default_changed' });

	return withTransaction(ctx, async (tx) => {
		const [route] = await tx
			.select({ id: stageRoutes.id, publishedAt: stageRoutes.publishedAt })
			.from(stageRoutes)
			.where(eq(stageRoutes.id, routeId))
			.for('update');

		if (route === undefined) {
			throw new NotFoundError('Маршрут стадий не найден');
		}

		// На черновик нельзя поставить взаимодействие, поэтому маршрутом по
		// умолчанию он быть не может: предложение, которым нельзя воспользоваться,
		// хуже отсутствия предложения.
		if (route.publishedAt === null) {
			throw new ConflictError(
				'Черновик не может быть маршрутом по умолчанию: сначала опубликуйте версию'
			);
		}

		const now = new Date();

		await tx
			.update(stageRoutes)
			.set({ isDefault: true, updatedAt: now })
			.where(eq(stageRoutes.id, routeId));

		await clearOtherDefaults(tx, routeId, now);

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.route_default_changed',
				outcome: 'success',
				subject: { type: 'stage_route', id: routeId }
			},
			tx
		);

		return readRoute(tx, routeId);
	});
}

export async function getRoute(ctx: ActorContext, routeId: string): Promise<StageRouteView> {
	requirePermission(ctx, 'interactions.read');

	return readRoute(getDb(), routeId);
}

/** Одна версия маршрута в списке конфигуратора. */
export type StageRouteSummary = {
	id: string;
	key: string;
	version: number;
	name: string;
	isDefault: boolean;
	publishedAt: Date | null;
	stageCount: number;
	/** Сколько взаимодействий идут по этой версии прямо сейчас. */
	activeInteractions: number;
};

/**
 * Все версии всех маршрутов: список конфигуратора.
 *
 * Счётчики считаются отдельными запросами, а не соединением: маршрут, стадии и
 * взаимодействия — три разных множества, и одно соединение перемножило бы
 * стадии на взаимодействия, дав правдоподобное, но неверное число.
 *
 * Область доступа на счётчик не влияет намеренно: «сколько записей опирается на
 * эту версию» — свойство версии, а не того, кто на неё смотрит. Число, зависящее
 * от смотрящего, отвечало бы на вопрос «можно ли эту версию оставить в покое»
 * по-разному у двух администраторов.
 */
export async function listRoutes(ctx: ActorContext): Promise<StageRouteSummary[]> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.routes_viewed' });

	const db = getDb();

	const [routes, stageCounts, activeCounts] = await Promise.all([
		db
			.select({
				id: stageRoutes.id,
				key: stageRoutes.key,
				version: stageRoutes.version,
				name: stageRoutes.name,
				isDefault: stageRoutes.isDefault,
				publishedAt: stageRoutes.publishedAt
			})
			.from(stageRoutes)
			.orderBy(asc(stageRoutes.key), desc(stageRoutes.version)),
		db.select({ routeId: stages.routeId, value: count() }).from(stages).groupBy(stages.routeId),
		db
			.select({ routeId: interactions.routeId, value: count() })
			.from(interactions)
			.where(eq(interactions.status, 'active'))
			.groupBy(interactions.routeId)
	]);

	const stagesByRoute = new Map(stageCounts.map((row) => [row.routeId, row.value]));
	const activeByRoute = new Map(activeCounts.map((row) => [row.routeId, row.value]));

	return routes.map((route) => ({
		...route,
		stageCount: stagesByRoute.get(route.id) ?? 0,
		activeInteractions: activeByRoute.get(route.id) ?? 0
	}));
}

/** Версия маршрута со всем, что нужно её карточке. */
export type StageRouteDetail = {
	route: StageRouteView;
	/** Сколько взаимодействий идут по этой версии прямо сейчас. */
	activeInteractions: number;
	/**
	 * Черновая версия того же маршрута, если она уже заведена. Карточка
	 * опубликованной версии объясняет ею, почему «Новая версия» недоступна.
	 */
	draft: { id: string; version: number } | null;
	/** Что мешает опубликовать черновик; у опубликованной версии — пусто. */
	issues: string[];
};

export async function getRouteDetail(
	ctx: ActorContext,
	routeId: string
): Promise<StageRouteDetail> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.routes_viewed' });

	const db = getDb();
	const route = await readRoute(db, routeId);

	const [[active], [draft]] = await Promise.all([
		db
			.select({ value: count() })
			.from(interactions)
			.where(and(eq(interactions.routeId, routeId), eq(interactions.status, 'active'))),
		db
			.select({ id: stageRoutes.id, version: stageRoutes.version })
			.from(stageRoutes)
			.where(
				and(
					eq(stageRoutes.key, route.key),
					isNull(stageRoutes.publishedAt),
					ne(stageRoutes.id, routeId)
				)
			)
			.orderBy(desc(stageRoutes.version))
			.limit(1)
	]);

	return {
		route,
		activeInteractions: active.value,
		draft: draft ?? null,
		issues: route.publishedAt === null ? validateRouteDraft(route) : []
	};
}

/** Маршрут в том виде, в каком его принимают `createRoute` и `updateRoute`. */
export function routeDefinition(route: StageRouteView): CreateRouteInput {
	const keyByStageId = new Map(route.stages.map((stage) => [stage.id, stage.key]));

	return {
		key: route.key,
		name: route.name,
		description: route.description,
		isDefault: route.isDefault,
		stages: [...route.stages]
			.sort((left, right) => left.position - right.position)
			.map((stage) => ({
				key: stage.key,
				name: stage.name,
				category: stage.category,
				slaDays: stage.slaDays,
				staleAfterDays: stage.staleAfterDays,
				requiresResult: stage.requiresResult,
				requiresConfirmation: stage.requiresConfirmation,
				checklist: stage.checklist
			})),
		transitions: route.transitions.map((transition) => {
			const fromStageKey = keyByStageId.get(transition.fromStageId);
			const toStageKey = keyByStageId.get(transition.toStageId);

			// Переход на стадию чужого маршрута — испорченная конфигурация, а не
			// то, что можно перенести в новую версию: `validateRouteDraft` называет
			// такой переход словами, и чинить его надо в исходной версии.
			if (fromStageKey === undefined || toStageKey === undefined) {
				throw new ValidationError('Маршрут ссылается на стадию, которой в нём нет', [
					`Переход ${transition.id} ведёт мимо стадий маршрута`
				]);
			}

			return {
				fromStageKey,
				toStageKey,
				kind: transition.kind,
				requiredPermissionKey: transition.requiredPermissionKey,
				requiresReason: transition.requiresReason
			};
		})
	};
}

/**
 * Новая черновая версия — копия существующей.
 *
 * Так меняется процесс: опубликованную версию править нельзя, а писать её
 * заново руками значит переписать четырнадцать стадий ради правки одного
 * норматива. Копия заводится не по умолчанию и неопубликованной: и то и другое
 * — отдельные решения, а не следствие «завёл новую версию».
 *
 * Черновик у ключа один. Два незаконченных описания одного процесса
 * невозможно свести: обе версии опубликуются, и какая из них описывает работу —
 * станет вопросом порядка нажатий.
 */
export async function createDraftFrom(ctx: ActorContext, routeId: string): Promise<StageRouteView> {
	await requirePermission(ctx, 'stages.configure', { type: 'stages.route_created' });

	return withTransaction(ctx, async (tx) => {
		const source = await readRoute(tx, routeId);

		// Блокируются все версии ключа: две одновременные «Новые версии» иначе
		// прочитали бы один и тот же максимум и столкнулись бы на уникальном
		// индексе «ключ + версия».
		const siblings = await tx
			.select({
				id: stageRoutes.id,
				version: stageRoutes.version,
				publishedAt: stageRoutes.publishedAt
			})
			.from(stageRoutes)
			.where(eq(stageRoutes.key, source.key))
			.for('update');

		const existingDraft = siblings.find((row) => row.publishedAt === null);

		if (existingDraft !== undefined) {
			throw new ConflictError(
				`У маршрута уже есть черновая версия ${existingDraft.version}: доведите её до публикации или правьте её`
			);
		}

		const definition = routeDefinition(source);

		const [created] = await tx
			.insert(stageRoutes)
			.values({
				key: source.key,
				version: Math.max(...siblings.map((row) => row.version)) + 1,
				name: source.name,
				description: source.description,
				// Признак «по умолчанию» не наследуется: он принадлежит той версии,
				// по которой сейчас заводят взаимодействия, а не её черновику.
				isDefault: false
			})
			.returning({ id: stageRoutes.id });

		await writeRouteContent(tx, created.id, definition);

		await recordAuditEvent(
			ctx,
			{
				type: 'stages.route_created',
				outcome: 'success',
				subject: { type: 'stage_route', id: created.id },
				details: { sourceRouteId: routeId }
			},
			tx
		);

		return readRoute(tx, created.id);
	});
}

/**
 * Что мешает опубликовать эту конфигурацию — по фразе на претензию.
 *
 * Чистая функция: на входе версия маршрута целиком, на выходе список претензий
 * словами. Схема контракта проверяет форму конфигурации (ключи, связность
 * пары «откуда — куда»), а здесь — её пригодность к работе: по маршруту, из
 * которого некуда идти дальше, взаимодействие встанет на первой же стадии.
 */
export function validateRouteDraft(route: StageRouteView): string[] {
	const issues: string[] = [];
	const ordered = [...route.stages].sort((left, right) => left.position - right.position);

	if (ordered.length === 0) {
		return ['В маршруте нет ни одной стадии'];
	}

	const positions = new Map<number, string>();

	for (const stage of ordered) {
		const taken = positions.get(stage.position);

		if (taken !== undefined) {
			issues.push(`Позиция ${stage.position} занята двумя стадиями: «${taken}» и «${stage.name}»`);
		} else {
			positions.set(stage.position, stage.name);
		}

		// Группа говорит, на каком участке процесса мы стоим, название — что на
		// нём делают. Стадия, названная кодом своей группы, не отвечает ни на
		// один из двух вопросов.
		if (stage.name.trim().toLowerCase() === stage.category) {
			issues.push(
				`Стадия «${stage.name}» названа кодом своей смысловой группы: название должно говорить, что на ней делают`
			);
		}
	}

	const names = new Map(ordered.map((stage) => [stage.id, stage.name]));
	const forwardFrom = new Set<string>();

	for (const transition of route.transitions) {
		const from = names.get(transition.fromStageId);
		const to = names.get(transition.toStageId);

		if (from === undefined || to === undefined) {
			issues.push(
				`Переход ${transition.kind === 'forward' ? 'вперёд' : transition.kind === 'return' ? 'назад' : 'мимо стадии'} ведёт на стадию, которой нет в маршруте`
			);
			continue;
		}

		if (transition.kind === 'forward') {
			forwardFrom.add(transition.fromStageId);
		}
	}

	for (const stage of ordered.slice(0, -1)) {
		if (!forwardFrom.has(stage.id)) {
			issues.push(`У стадии «${stage.name}» нет перехода вперёд: с неё не уйти дальше по маршруту`);
		}
	}

	return issues;
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
