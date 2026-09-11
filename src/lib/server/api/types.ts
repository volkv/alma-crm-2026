import type { SessionUser } from '$lib/server/auth/types';

/**
 * The API key behind the current request, when it arrived over the public API
 * instead of a browser session. Machine callers have no session and no cookies.
 */
export type ApiKeyContext = {
	id: string;
	/** Human-readable label shown in settings and written to the audit log. */
	name: string;
	/** The user who issued the key and whose permissions it inherits. */
	ownerUserId: string;
};

/**
 * Проверенный ключ вместе с владельцем. Ключ сам по себе ничего не разрешает:
 * права и область доступа берутся у человека, который его выпустил, поэтому
 * дальше по запросу едут оба.
 */
export type AuthenticatedApiKey = {
	key: ApiKeyContext;
	owner: SessionUser;
};
