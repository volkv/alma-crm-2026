/**
 * Ключи доступа к публичному API.
 *
 * Ключ показывается один раз — при выпуске; в базе остаётся только его
 * `sha256`. Поэтому утечка дампа не даёт доступа к системе, а потерянный ключ
 * не восстанавливают, а отзывают и выпускают заново. Отзыв не удаляет строку:
 * иначе записи журнала, ссылающиеся на ключ, потеряли бы смысл.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ApiKeyView, CreateApiKeyInput, CreatedApiKey } from '$lib/contracts/api';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { loadSessionUser } from '../auth/session';
import { getDb } from '../db';
import { apiKeys, users } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import type { AuthenticatedApiKey } from './types';

/** Префикс ключа: по нему ключ узнают в логах и в утечках на публичных хостингах. */
export const API_KEY_PREFIX = 'lct_';

/** 24 байта случайности — ровно 32 символа base64url, без выравнивания. */
const API_KEY_BYTES = 24;

/** Как выглядит ключ целиком. Всё, что не подошло, до базы не доходит. */
export const API_KEY_PATTERN = /^lct_[A-Za-z0-9_-]{32}$/;

/** Реже одного раза в минуту отметка о последнем использовании не обновляется. */
const LAST_USED_THROTTLE_MS = 60_000;

export function generateApiKey(): string {
	return `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString('base64url')}`;
}

/**
 * Хеш ключа для хранения и поиска. Соли нет намеренно: ключ — это 192 бита
 * случайности, перебирать его нечем, а искать в базе нужно ровно по хешу.
 */
export function hashApiKey(rawKey: string): string {
	return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * Значение заголовка `Authorization` → ключ. Схема сравнивается без учёта
 * регистра, пробелы по краям не значимы; всё остальное — не наш заголовок.
 */
export function parseBearerToken(header: string | null): string | null {
	if (header === null) {
		return null;
	}

	const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
	return match === null ? null : match[1];
}

function toApiKeyView(row: typeof apiKeys.$inferSelect): ApiKeyView {
	return {
		id: row.id,
		name: row.name,
		ownerUserId: row.ownerUserId,
		lastUsedAt: row.lastUsedAt,
		revokedAt: row.revokedAt,
		createdAt: row.createdAt
	};
}

export async function createApiKey(
	ctx: ActorContext,
	input: CreateApiKeyInput
): Promise<CreatedApiKey> {
	requirePermission(ctx, 'api_keys.manage');

	const rawKey = generateApiKey();

	return withTransaction(ctx, async (tx) => {
		const [owner] = await tx
			.select({ id: users.id, isActive: users.isActive })
			.from(users)
			.where(eq(users.id, input.ownerUserId))
			.limit(1);

		if (owner === undefined || !owner.isActive) {
			throw new ValidationError('Владелец ключа недоступен', [
				'ownerUserId: пользователь не найден или деактивирован'
			]);
		}

		const [row] = await tx
			.insert(apiKeys)
			.values({ name: input.name, keyHash: hashApiKey(rawKey), ownerUserId: owner.id })
			.returning();

		await recordAuditEvent(
			ctx,
			{
				type: 'api_keys.created',
				outcome: 'success',
				subject: { type: 'api_key', id: row.id },
				details: { apiKeyId: row.id, ownerUserId: owner.id }
			},
			tx
		);

		return { ...toApiKeyView(row), key: rawKey };
	});
}

export async function revokeApiKey(ctx: ActorContext, apiKeyId: string): Promise<ApiKeyView> {
	requirePermission(ctx, 'api_keys.manage');

	return withTransaction(ctx, async (tx) => {
		const [row] = await tx
			.update(apiKeys)
			.set({ revokedAt: new Date(), updatedAt: new Date() })
			.where(and(eq(apiKeys.id, apiKeyId), isNull(apiKeys.revokedAt)))
			.returning();

		if (row === undefined) {
			throw new NotFoundError('Действующий ключ с таким идентификатором не найден');
		}

		await recordAuditEvent(
			ctx,
			{
				type: 'api_keys.revoked',
				outcome: 'success',
				subject: { type: 'api_key', id: row.id },
				details: { apiKeyId: row.id, ownerUserId: row.ownerUserId }
			},
			tx
		);

		return toApiKeyView(row);
	});
}

/** Отозванные ключи остаются в списке: их видно в журнале, и это часть истории. */
export async function listApiKeys(ctx: ActorContext): Promise<ApiKeyView[]> {
	requirePermission(ctx, 'api_keys.manage');

	const rows = await getDb().select().from(apiKeys).orderBy(desc(apiKeys.createdAt));

	return rows.map(toApiKeyView);
}

/**
 * Ключ из заголовка → действующее лицо запроса, или `null`, если такого ключа
 * нет, он отозван либо его владелец деактивирован. Все три случая для
 * вызывающего неотличимы: по разнице в ответах перебором узнают, какие ключи
 * существовали.
 *
 * Владельца собирает тот же `loadSessionUser`, что и пользователя сессии: права,
 * признак демонстрационной учётной записи и область доступа обязаны значить для
 * ключа ровно то же, что и для браузера. Второе описание того же пользователя
 * однажды разошлось бы с первым, и ограничение обходилось бы сменой транспорта.
 */
export async function authenticateApiKey(rawKey: string): Promise<AuthenticatedApiKey | null> {
	if (!API_KEY_PATTERN.test(rawKey)) {
		return null;
	}

	const db = getDb();

	const [row] = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			ownerUserId: apiKeys.ownerUserId,
			lastUsedAt: apiKeys.lastUsedAt,
			revokedAt: apiKeys.revokedAt
		})
		.from(apiKeys)
		.where(eq(apiKeys.keyHash, hashApiKey(rawKey)))
		.limit(1);

	if (row === undefined || row.revokedAt !== null) {
		return null;
	}

	const owner = await loadSessionUser(row.ownerUserId);
	if (owner === null) {
		return null;
	}

	const now = new Date();
	if (
		row.lastUsedAt === null ||
		now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS
	) {
		await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
	}

	return {
		key: { id: row.id, name: row.name, ownerUserId: owner.id },
		owner
	};
}
