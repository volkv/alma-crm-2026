import type { AccessScope } from '../actor';

/**
 * The user behind the current request, resolved from the session cookie.
 * Kept free of database types on purpose: everything a request handler needs
 * for authorisation is here, so nothing has to reach back into the ORM.
 */
export type SessionUser = {
	id: string;
	email: string;
	fullName: string;
	roleId: string;
	/** Permission codes granted by the role, as a set for O(1) checks. */
	permissions: ReadonlySet<string>;
	/** The read-only account the public demo signs in as. */
	isDemo: boolean;
	/**
	 * Which organisations this user may see. Decided once, when the session is
	 * built, and copied into every `ActorContext` from there.
	 */
	scope: AccessScope;
};
