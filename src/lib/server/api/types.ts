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
