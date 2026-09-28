/**
 * Кто видит дело.
 *
 * Вопрос обратный обычному: не «что видит этот сотрудник», а «кто из
 * сотрудников видит эту запись». Отдельного правила для него нет и быть не
 * должно — второе правило однажды разошлось бы с первым, и список «у кого
 * доступ» показывал бы тех, кому карточка отвечает «не найдено». Поэтому
 * ответ собирается перебором: для каждого возможного читателя строится его
 * область доступа так же, как на его собственном запросе (`loadSessionUser`),
 * и спрашивается то же условие, что у карточки (`interactionScopeFilter` плюс
 * право `interactions.read`).
 *
 * Кандидаты — действующие сотрудники, которые могут работать в пространстве
 * дела: его члены и роли с полной областью. Остальным граница пространства
 * закрывает запись при любых назначениях, и строить их область незачем.
 *
 * Этой же функцией пользуются упоминания: кого можно позвать в обсуждение
 * дела — ровно тех, кто его видит.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { LiveRelation } from '$lib/contracts/live';
import type { ActorContext } from '../actor';
import type { SessionUser } from '../auth/types';
import { loadSessionUser } from '../auth/session';
import { getDb } from '../db';
import { interactions, users, workspaces } from '../db/schema';
import { interactionScopeFilter } from '../interactions/access';
import { can } from '../rbac';
import { workspaceAccessCondition } from '../rbac/workspaces';

export type InteractionViewer = {
	userId: string;
	fullName: string;
	relation: LiveRelation;
};

/**
 * Сколько живёт собранный список. Перебор — десяток запросов на сотрудника, а
 * открытых карточек одного дела бывает несколько; полминуты — столько же,
 * сколько поток ждёт между проверками своего доступа.
 */
const VIEWERS_TTL_MS = 30_000;

const cache = new Map<string, { at: number; viewers: Promise<InteractionViewer[]> }>();

/** Контекст чужого сотрудника: только для вопроса «видит ли он». */
function viewerContext(user: SessionUser): ActorContext {
	return {
		requestId: 'live-viewers',
		source: 'ui',
		user,
		apiKeyId: null,
		ip: null,
		userAgent: null,
		scope: user.scope
	};
}

/**
 * Видит ли уже собранный пользователь дело — то же условие, что у
 * `getInteraction`. `workspaceKey` дополнительно сверяет пространство из
 * адреса: карточка открыта по `/w/<ключ>/…`, и поток по чужому ключу с верным
 * идентификатором дела должен получить отказ, как и страница.
 */
export async function userSeesInteraction(
	user: SessionUser,
	interactionId: string,
	workspaceKey?: string
): Promise<boolean> {
	const ctx = viewerContext(user);

	if (!can(ctx, 'interactions.read')) {
		return false;
	}

	const conditions = [eq(interactions.id, interactionId), interactionScopeFilter(ctx)];

	if (workspaceKey !== undefined) {
		conditions.push(
			sql`${interactions.workspaceId} = (select ${workspaces.id} from ${workspaces} where ${workspaces.key} = ${workspaceKey})`
		);
	}

	const [row] = await getDb()
		.select({ id: interactions.id })
		.from(interactions)
		.where(and(...conditions))
		.limit(1);

	return row !== undefined;
}

/**
 * Видит ли сотрудник дело прямо сейчас. Для проверки адресата упоминания — и
 * при сохранении, и перед доставкой: список, собранный браузером, доверия не
 * заслуживает, а доступ мог пропасть между постановкой письма и отправкой.
 */
export async function canUserSeeInteraction(
	userId: string,
	interactionId: string
): Promise<boolean> {
	const user = await loadSessionUser(userId);

	return user !== null && (await userSeesInteraction(user, interactionId));
}

function relationOf(user: SessionUser, ownerUserId: string | null): LiveRelation {
	if (user.id === ownerUserId) {
		return 'responsible';
	}

	if (user.roleId === 'lead') {
		return 'lead';
	}

	if (user.scope.kind === 'all') {
		return 'admin';
	}

	return 'member';
}

const RELATION_ORDER: Record<LiveRelation, number> = {
	responsible: 0,
	lead: 1,
	member: 2,
	admin: 3
};

async function collectViewers(interactionId: string): Promise<InteractionViewer[]> {
	const [interaction] = await getDb()
		.select({ workspaceId: interactions.workspaceId, ownerUserId: interactions.ownerUserId })
		.from(interactions)
		.where(eq(interactions.id, interactionId))
		.limit(1);

	if (interaction === undefined) {
		return [];
	}

	const candidates = await getDb()
		.select({ id: users.id })
		.from(users)
		.where(
			and(
				eq(users.isActive, true),
				ne(users.roleId, 'service'),
				workspaceAccessCondition(
					{ id: users.id, roleId: users.roleId },
					sql`${interaction.workspaceId}::uuid`
				)
			)
		);

	const checked = await Promise.all(
		candidates.map(async ({ id }) => {
			const user = await loadSessionUser(id);

			if (user === null || !(await userSeesInteraction(user, interactionId))) {
				return null;
			}

			return {
				userId: user.id,
				fullName: user.fullName,
				relation: relationOf(user, interaction.ownerUserId)
			};
		})
	);

	return checked
		.filter((viewer) => viewer !== null)
		.sort(
			(left, right) =>
				RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation] ||
				left.fullName.localeCompare(right.fullName, 'ru')
		);
}

/**
 * Сотрудники, которые видят дело, с подписью «кем приходятся». Список
 * помнится полминуты на процесс; изменение дела его сбрасывает
 * ({@link forgetInteractionViewers}).
 */
export function listInteractionViewers(interactionId: string): Promise<InteractionViewer[]> {
	const now = Date.now();
	const known = cache.get(interactionId);

	if (known !== undefined && now - known.at < VIEWERS_TTL_MS) {
		return known.viewers;
	}

	const viewers = collectViewers(interactionId);

	cache.set(interactionId, { at: now, viewers });
	// Отказ не остаётся в памяти на полминуты: следующий вопрос спросит базу
	// заново. Сам отказ получает тот, кто спросил.
	viewers.catch(() => cache.delete(interactionId));

	return viewers;
}

/** Дело изменилось — ответственный мог смениться: список собрать заново. */
export function forgetInteractionViewers(interactionId: string): void {
	cache.delete(interactionId);
}
