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
	 * marked `is_demo` while `DEMO_MODE` is on, whether through the password
	 * form or the "sign in as …" button. Outside demo mode such an account is an
	 * ordinary one and this is `false`.
	 *
	 * It is a boundary, not a badge: permissions are already narrowed by it, and
	 * what is still readable is narrowed where it is read (the audit log masks
	 * the addresses and clients of everyone who visited before).
	 */
	isDemo: boolean;
	/**
	 * Пароль приняли, второго фактора ещё нет. Такая сессия существует только
	 * ради второго шага входа: гвардия уводит её на `/login/mfa` и никуда
	 * больше, а публичный API сессий не смотрит вовсе.
	 *
	 * Признак принадлежит сессии, а не учётной записи, поэтому ставит его хук,
	 * прочитавший запись в Redis, а `loadSessionUser` — тот, кто собирает
	 * пользователя и для браузера, и для ключа доступа, — проставляет `false`
	 * явно. Поле необязательное: подделки пользователя в тестах и сидах
	 * описывают обычную, уже открытую сессию, и перечислять в каждой из них
	 * «второго шага не было» значит повторять то, что и так верно.
	 */
	mfaPending?: boolean;
	/**
	 * Which organisations this user may see. Decided once, when the session is
	 * built, and copied into every `ActorContext` from there.
	 */
	scope: AccessScope;
};
