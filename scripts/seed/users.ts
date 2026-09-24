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
 * Записи с `is_demo = true` — граница демонстрации: выключить их, пока включён
 * демо-режим, нельзя, и открытая ими сессия не получает прав из
 * `DEMO_DENIED_PERMISSIONS` — сейчас там одно право на адреса интеграций. Записи
 * без этого признака открытая ими сессия не выключает, не включает, не
 * отвязывает и не перевешивает (`src/lib/server/auth/users.ts`). Подчинение
 * демонстрационных записей показу открыто, и сброс возвращает его к эталону
 * (`restoreSeededAccounts`). Ещё две — обычные сотрудники: они нужны, чтобы списки
 * владельцев, авторов версий и исполнителей не состояли из одного «Менеджера
 * Демо», и чтобы у руководителя было чью работу видеть.
 *
 * У менеджеров проставлен руководитель: на этой иерархии держится и область
 * доступа руководителя, и адрес эскалации. Без неё роль «Руководитель» на
 * стенде показывала бы ровно то же, что роль «Менеджер».
 */
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { users, workspaceMembers, workspaces } from '$lib/server/db/schema';
import { B2B_WORKSPACE_KEY, B2C_WORKSPACE_KEY } from '$lib/server/stages/definitions';
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
	/**
	 * Пространства, в которые сотрудник включён. У администратора и машинного
	 * субъекта их нет: их область — всё и без членства.
	 */
	workspaceKeys?: readonly string[];
};

/** Оба направления стенда: демонстрационные записи показывают оба. */
const BOTH_WORKSPACES = [B2B_WORKSPACE_KEY, B2C_WORKSPACE_KEY] as const;

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
		isDemo: true,
		workspaceKeys: BOTH_WORKSPACES
	},
	{
		key: 'demo-manager',
		email: 'manager@demo.lct-crm.local',
		fullName: 'Менеджер Демо',
		roleId: 'manager',
		managerKey: 'demo-lead',
		isDemo: true,
		// Все покупатели курсов на стенде за ним: без коммерческого обучения
		// демонстрация не показала бы второе направление ни одной ролью, кроме
		// администратора.
		workspaceKeys: BOTH_WORKSPACES
	}
];

/** Сотрудники оператора: владельцы записей справочника и авторы версий программ. */
const EMPLOYEES: readonly AccountSeed[] = [
	{
		key: 'veresova',
		email: 'a.veresova@example.org',
		fullName: 'Вересова Анна Сергеевна',
		roleId: 'manager',
		managerKey: 'demo-lead',
		// КАМы вузовского направления: коммерческого обучения они не видят —
		// ровно то разделение, ради которого пространства стали границей.
		workspaceKeys: [B2B_WORKSPACE_KEY]
	},
	{
		key: 'zotov',
		email: 'p.zotov@example.org',
		fullName: 'Зотов Павел Игоревич',
		roleId: 'manager',
		managerKey: 'demo-lead',
		workspaceKeys: [B2B_WORKSPACE_KEY]
	}
];

/**
 * Администратор стенда: обычная учётная запись оператора, не демонстрационная.
 *
 * Прав у неё столько же, сколько у демонстрационного администратора, кроме
 * адресов интеграций: их демонстрации не отдают ни при какой роли
 * (`DEMO_DENIED_PERMISSIONS`), и правит их на стенде только эта запись. В realm
 * её нет: настоящие учётные записи заводит администратор в консоли каталога, и
 * эта строка ждёт его первого входа, чтобы связаться с ним по почте.
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

/**
 * Возвращает эталонные учётные записи к тому виду, в котором их завёл сид: вход
 * открыт, руководитель тот же.
 *
 * Нужно с тех пор, как раздел пользователей открыт демонстрации: посетитель
 * стенда перевешивает подчинение демонстрационных записей, а
 * `on conflict do nothing` выше про уже заведённую строку не меняет ничего.
 * Записи вне демонстрации посетитель не трогает вовсе, но их может выключить
 * штатный администратор, и сброс стенда возвращает к эталону и их: дороже всего
 * обходится машинный субъект — ключи обмена проверяют, что владелец включён
 * (`$lib/server/api/keys.ts`), и выключенный останавливает сцену «сайт → CRM →
 * система обучения» до ручной правки базы.
 *
 * Ключ — почта, а не вычисляемый идентификатор: строка с такой почтой могла
 * появиться на стенде раньше сида (её заводит первый вход), и тогда `id` у неё
 * другой. Сравнение по `lower()` — той же уникальностью, какой почта уникальна
 * в схеме.
 *
 * Роль, имя и `external_subject` не трогаются: первые две на каждом входе
 * приносит каталог, а отвязанная запись связывается следующим входом сама.
 */
async function restoreSeededAccounts(tx: Tx, accounts: readonly AccountSeed[]): Promise<void> {
	const emails = accounts.map((account) => account.email.toLowerCase());
	const rows = await tx
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(inArray(sql`lower(${users.email})`, emails));

	const idByEmail = new Map(rows.map((row) => [row.email.toLowerCase(), row.id]));
	const emailByKey = new Map(accounts.map((account) => [account.key, account.email.toLowerCase()]));

	for (const account of accounts) {
		const managerEmail =
			account.managerKey === undefined ? undefined : emailByKey.get(account.managerKey);
		const managerUserId = managerEmail === undefined ? null : (idByEmail.get(managerEmail) ?? null);

		await tx
			.update(users)
			.set({ isActive: true, deactivatedAt: null, managerUserId, updatedAt: sql`now()` })
			.where(sql`lower(${users.email}) = ${account.email.toLowerCase()}`);
	}
}

/**
 * Доводит членство эталонных учётных записей в пространствах до эталона:
 * недостающее включает, лишнее закрывает.
 *
 * Лишнее закрывается, а не оставляется, по той же причине, по какой
 * `restoreSeededAccounts` возвращает руководителя: раздел пользователей открыт
 * показу, и КАМ вузовского направления, включённый посетителем в коммерческое
 * обучение, иначе остался бы в нём навсегда. Членство сотрудников вне эталона
 * сид не трогает — это не его записи.
 *
 * Учётные записи ищутся по почте, как и выше: строка с этой почтой могла
 * появиться раньше сида, со своим идентификатором.
 */
async function restoreWorkspaceMembers(tx: Tx, accounts: readonly AccountSeed[]): Promise<void> {
	const emails = accounts.map((account) => account.email.toLowerCase());
	const [userRows, workspaceRows] = await Promise.all([
		tx
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(inArray(sql`lower(${users.email})`, emails)),
		tx.select({ id: workspaces.id, key: workspaces.key }).from(workspaces)
	]);

	const idByEmail = new Map(userRows.map((row) => [row.email.toLowerCase(), row.id]));
	const workspaceIdByKey = new Map(workspaceRows.map((row) => [row.key, row.id]));

	for (const account of accounts) {
		const userId = idByEmail.get(account.email.toLowerCase());

		if (userId === undefined) {
			throw new Error(`Учётная запись «${account.key}» не заведена: членство ставить некому`);
		}

		const wanted = (account.workspaceKeys ?? []).map((key) => {
			const workspaceId = workspaceIdByKey.get(key);

			if (workspaceId === undefined) {
				throw new Error(`Пространство «${key}» не заведено: его заводит миграция`);
			}

			return workspaceId;
		});

		await tx
			.update(workspaceMembers)
			.set({ validTo: sql`now()`, updatedAt: sql`now()` })
			.where(
				and(
					eq(workspaceMembers.userId, userId),
					isNull(workspaceMembers.validTo),
					wanted.length === 0 ? undefined : notInArray(workspaceMembers.workspaceId, wanted)
				)
			);

		if (wanted.length > 0) {
			await tx
				.insert(workspaceMembers)
				.values(wanted.map((workspaceId) => ({ workspaceId, userId })))
				.onConflictDoNothing();
		}
	}
}

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
		// вычисляемый идентификатор у неё будет другой. Роль и имя уже заведённой
		// записи повторный сид не трогает: их приносит каталог при каждом входе.
		// А вход и подчинение доводит до эталона шаг ниже — с тех пор, как
		// раздел пользователей открыт демонстрации, их правит посетитель стенда.
		.onConflictDoNothing();

	await restoreSeededAccounts(tx, accounts);
	await restoreWorkspaceMembers(tx, accounts);

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
