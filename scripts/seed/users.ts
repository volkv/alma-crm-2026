/**
 * Учётные записи демонстрационного стенда.
 *
 * Паролей здесь нет ни у кого: их спрашивает каталог учётных записей, а в базе
 * приложения остаётся только карточка человека — имя, почта, роль, руководитель
 * (`docs/auth.md`). `external_subject` у всех записей пуст: связывание идёт при
 * первом входе по подтверждённой почте, и почты этих записей нарочно те же, что
 * у демонстрационных записей realm (`keycloak/realm-lct.json`) — иначе человек
 * вошёл бы двойником, а весь его портфель остался бы за строкой, в которую уже
 * никто не войдёт.
 *
 * Записи с `is_demo = true` — граница демонстрации: открытая ими сессия не
 * получает прав из `DEMO_DENIED_PERMISSIONS`, и выключить их, пока включён
 * демо-режим, нельзя. Ещё две — обычные сотрудники: они нужны, чтобы списки
 * владельцев, авторов версий и исполнителей не состояли из одного «Менеджера
 * Демо», и чтобы у руководителя было чью работу видеть.
 *
 * У менеджеров проставлен руководитель: на этой иерархии держится и область
 * доступа руководителя, и адрес эскалации. Без неё роль «Руководитель» на
 * стенде показывала бы ровно то же, что роль «Менеджер».
 */
import { users } from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { seedId } from './ids';

type AccountSeed = {
	key: string;
	email: string;
	fullName: string;
	roleId: string;
	/** Ключ учётной записи руководителя. */
	managerKey?: string;
	isDemo?: boolean;
};

/** Записи публичной демонстрации: по одной на роль человека. */
const DEMO_ACCOUNTS: readonly AccountSeed[] = [
	{
		key: 'demo-admin',
		email: 'admin@demo.lct-crm.local',
		fullName: 'Администратор Демо',
		roleId: 'admin',
		isDemo: true
	},
	{
		key: 'demo-lead',
		email: 'lead@demo.lct-crm.local',
		fullName: 'Руководитель Демо',
		roleId: 'lead',
		isDemo: true
	},
	{
		key: 'demo-manager',
		email: 'manager@demo.lct-crm.local',
		fullName: 'Менеджер Демо',
		roleId: 'manager',
		managerKey: 'demo-lead',
		isDemo: true
	}
];

/** Сотрудники оператора: владельцы записей справочника и авторы версий программ. */
const EMPLOYEES: readonly AccountSeed[] = [
	{
		key: 'veresova',
		email: 'a.veresova@example.org',
		fullName: 'Вересова Анна Сергеевна',
		roleId: 'manager',
		managerKey: 'demo-lead'
	},
	{
		key: 'zotov',
		email: 'p.zotov@example.org',
		fullName: 'Зотов Павел Игоревич',
		roleId: 'manager',
		managerKey: 'demo-lead'
	}
];

/**
 * Администратор стенда: обычная учётная запись оператора, не демонстрационная.
 *
 * При `DEMO_MODE=true` демонстрационная сессия не получает прав на
 * пользователей и ключи, какой бы ролью ни вошли, — поэтому без этой записи
 * управлять стендом некому. В realm её нет: настоящие учётные записи заводит
 * администратор в консоли каталога, и эта строка ждёт его первого входа, чтобы
 * связаться с ним по почте.
 */
const STAFF_ADMIN: AccountSeed = {
	key: 'staff-admin',
	email: 'admin@staff.lct-crm.local',
	fullName: 'Администратор стенда',
	roleId: 'admin'
};

/**
 * Машинный субъект обмена: владелец ключей, которыми ходят CMS и система
 * обучения.
 *
 * Живого владельца у такого ключа нет, а привязка к сотруднику отдала бы чужой
 * системе его права и его область. Роль `service` невходящая: запись с ней не
 * проходит вход ни при каких утверждениях токена, и `external_subject` у неё не
 * появится никогда. Она одна на все подключения: ключи различаются именем, а
 * набор прав у обмена общий и закрытый (`docs/access-matrix.md`, раздел 1).
 */
const SERVICE_ACCOUNT: AccountSeed = {
	key: 'service-exchange',
	email: 'service@exchange.lct-crm.local',
	fullName: 'Внешние системы (обмен)',
	roleId: 'service'
};

/** Адрес администратора стенда — для документации, прогона e2e и тестов. */
export const STAFF_ADMIN_EMAIL = STAFF_ADMIN.email;

/** Адрес машинного субъекта — на него выпускаются ключи обмена. */
export const SERVICE_USER_EMAIL = SERVICE_ACCOUNT.email;

export type SeededUsers = {
	/** Идентификаторы демонстрационных записей по роли. */
	demo: Record<string, string>;
	/** Идентификаторы обычных сотрудников в порядке объявления. */
	employees: string[];
	/** Идентификатор машинного субъекта: на него выпускаются ключи обмена. */
	serviceUserId: string;
};

export async function seedUsers(tx: Tx): Promise<SeededUsers> {
	const accounts = [...DEMO_ACCOUNTS, ...EMPLOYEES, STAFF_ADMIN, SERVICE_ACCOUNT];

	await tx
		.insert(users)
		.values(
			accounts.map((account) => ({
				id: seedId('user', account.key),
				email: account.email,
				fullName: account.fullName,
				roleId: account.roleId,
				managerUserId: account.managerKey === undefined ? null : seedId('user', account.managerKey),
				isDemo: account.isDemo ?? false
			}))
		)
		// Конфликт по любой уникальности, а не только по идентификатору: учётная
		// запись с такой почтой могла появиться на стенде раньше сида — её
		// заводит администратор в каталоге и связывает первым входом, — и
		// вычисляемый идентификатор у неё будет другой. Роль, имя и руководителя
		// уже заведённой записи повторный сид тоже не трогает: роль приходит из
		// каталога при каждом входе, а руководителя ведёт администратор в
		// настройках.
		.onConflictDoNothing();

	return {
		demo: Object.fromEntries(
			DEMO_ACCOUNTS.map((account) => [account.roleId, seedId('user', account.key)])
		),
		employees: EMPLOYEES.map((account) => seedId('user', account.key)),
		serviceUserId: seedId('user', SERVICE_ACCOUNT.key)
	};
}

/** Адреса демонстрационных записей — для документации и для тестов. */
export const DEMO_EMAILS: Record<string, string> = Object.fromEntries(
	DEMO_ACCOUNTS.map((account) => [account.roleId, account.email])
);

/**
 * Имена входа демонстрационных записей в каталоге. Совпадают с
 * `keycloak/realm-lct.json` и с карточкой на странице входа: под ними человек
 * входит, а не под почтой из `DEMO_EMAILS`.
 */
export const DEMO_LOGINS: Record<string, string> = {
	admin: 'admin',
	lead: 'lead',
	manager: 'manager'
};
