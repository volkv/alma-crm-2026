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
	/**
	 * Permission codes this session may act on, as a set for O(1) checks. Those
	 * of the role, minus what a demo session never gets — see
	 * `demoSessionPermissions` in `$lib/server/rbac`.
	 */
	permissions: ReadonlySet<string>;
	/**
	 * This session belongs to the public demo: it was opened on an account
	 * marked `is_demo` while `DEMO_MODE` is on. Outside demo mode such an account
	 * is an ordinary one and this is `false`.
	 *
	 * It is a boundary, not a badge: permissions are already narrowed by it, and
	 * what is still readable is narrowed where it is read (the audit log masks
	 * the addresses and clients of everyone who visited before).
	 */
	isDemo: boolean;
	/**
	 * Чьи записи этот пользователь видит. Считается при сборке пользователя — то
	 * есть на каждом запросе, — и оттуда копируется в `ActorContext`.
	 */
	scope: AccessScope;
};
