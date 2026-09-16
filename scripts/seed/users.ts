/**
 * Учётные записи демонстрационного стенда.
 *
 * Записи с `is_demo = true` — те, под которые пускает кнопка «Войти как …»
 * на странице входа при `DEMO_MODE=true`; у них общий пароль из окружения,
 * чтобы стенд можно было показать и без кнопок. Ещё две — обычные сотрудники:
 * они нужны, чтобы списки владельцев, авторов версий и исполнителей не
 * состояли из одного «Менеджера Демо».
 *
 * У менеджеров проставлен руководитель: на этой иерархии держится и область
 * доступа руководителя, и адрес эскалации. Без неё роль «Руководитель» на
 * стенде показывала бы ровно то же, что роль «Менеджер».
 *
 * Пароля у сотрудников нет: в столбец лёг хеш случайной строки, которой никто
 * не видел. Войти под ними нельзя и не нужно — настоящие учётные записи
 * заводят в настройках, там же назначают пароль.
 *
 * Отдельно стоит администратор стенда: единственная запись, которую сид
 * заводит для работы, а не для показа, — и только если ему дали её пароль.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { hashPassword } from '$lib/server/auth/password';
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
};

/** Записи публичной демонстрации: по одной на системную роль. */
const DEMO_ACCOUNTS: readonly AccountSeed[] = [
	{
		key: 'demo-admin',
		email: 'admin@demo.lct-crm.local',
		fullName: 'Администратор Демо',
		roleId: 'admin'
	},
	{
		key: 'demo-lead',
		email: 'lead@demo.lct-crm.local',
		fullName: 'Руководитель Демо',
		roleId: 'lead'
	},
	{
		key: 'demo-manager',
		email: 'manager@demo.lct-crm.local',
		fullName: 'Менеджер Демо',
		roleId: 'manager',
		managerKey: 'demo-lead'
	},
	{
		key: 'demo-viewer',
		email: 'viewer@demo.lct-crm.local',
		fullName: 'Наблюдатель Демо',
		roleId: 'viewer'
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
 * пользователей, ключи и настройки — какой бы ролью ни вошли, — поэтому без
 * этой записи управлять стендом некому. Её пароль приходит переменной
 * окружения и только ею и задаётся: завести себе доступ изнутри демонстрации
 * невозможно, на то она и граница.
 */
const STAFF_ADMIN: AccountSeed = {
	key: 'staff-admin',
	email: 'admin@staff.lct-crm.local',
	fullName: 'Администратор стенда',
	roleId: 'admin'
};

/** Адрес администратора стенда — для документации, прогона e2e и тестов. */
export const STAFF_ADMIN_EMAIL = STAFF_ADMIN.email;

export type SeededUsers = {
	/** Идентификаторы демонстрационных записей по роли. */
	demo: Record<string, string>;
	/** Идентификаторы обычных сотрудников в порядке объявления. */
	employees: string[];
};

export async function seedUsers(
	tx: Tx,
	options: { demoPassword: string; staffAdminPassword?: string }
): Promise<SeededUsers> {
	const demoHash = await hashPassword(options.demoPassword);

	const rows = [
		...DEMO_ACCOUNTS.map((account) => ({ account, passwordHash: demoHash, isDemo: true })),
		...(await Promise.all(
			EMPLOYEES.map(async (account) => ({
				account,
				// Случайная строка, которую никто не видел: пароля у этих записей нет.
				passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
				isDemo: false
			}))
		))
	];

	await tx
		.insert(users)
		.values(
			rows.map(({ account, passwordHash, isDemo }) => ({
				id: seedId('user', account.key),
				email: account.email,
				fullName: account.fullName,
				roleId: account.roleId,
				managerUserId: account.managerKey === undefined ? null : seedId('user', account.managerKey),
				passwordHash,
				isDemo
			}))
		)
		// Пароль, роль и имя уже заведённой записи — дело администратора стенда:
		// повторный сид не возвращает их к тому, что записано здесь.
		.onConflictDoNothing({ target: users.id });

	if (options.staffAdminPassword !== undefined) {
		const passwordHash = await hashPassword(options.staffAdminPassword);

		// Единственная запись, которой сид переписывает пароль. Правило «пароль
		// заведённой записи не трогаем» здесь не работает: поменять его из
		// интерфейса может только сам администратор стенда, и если пароль забыт
		// или стенд поднимают заново, вернуть доступ больше нечем.
		//
		// Запись узнаётся по почте, а не по вычисляемому идентификатору: почта —
		// это то, чем входят, и она уникальна без учёта регистра. Учётная запись
		// с этим адресом могла появиться на стенде и раньше сида; завести рядом
		// вторую с тем же адресом всё равно нельзя, а менять пароль надо той,
		// которая есть.
		const existing = await tx
			.update(users)
			.set({ passwordHash, passwordChangedAt: sql`now()`, updatedAt: sql`now()` })
			.where(sql`lower(${users.email}) = ${STAFF_ADMIN.email}`)
			.returning({ id: users.id });

		if (existing.length === 0) {
			await tx.insert(users).values({
				id: seedId('user', STAFF_ADMIN.key),
				email: STAFF_ADMIN.email,
				fullName: STAFF_ADMIN.fullName,
				roleId: STAFF_ADMIN.roleId,
				passwordHash,
				isDemo: false
			});
		}
	}

	return {
		demo: Object.fromEntries(
			DEMO_ACCOUNTS.map((account) => [account.roleId, seedId('user', account.key)])
		),
		employees: EMPLOYEES.map((account) => seedId('user', account.key))
	};
}

/** Адреса демонстрационных записей — для документации и для тестов. */
export const DEMO_EMAILS: Record<string, string> = Object.fromEntries(
	DEMO_ACCOUNTS.map((account) => [account.roleId, account.email])
);
