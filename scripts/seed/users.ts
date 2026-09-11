/**
 * Учётные записи демонстрационного стенда.
 *
 * Три записи с `is_demo = true` — те, под которые пускает кнопка «Войти как …»
 * на странице входа при `DEMO_MODE=true`; у них общий пароль из окружения,
 * чтобы стенд можно было показать и без кнопок. Ещё две — обычные сотрудники:
 * они нужны, чтобы списки владельцев, авторов версий и исполнителей не
 * состояли из одного «Менеджера Демо».
 *
 * Пароля у сотрудников нет: в столбец лёг хеш случайной строки, которой никто
 * не видел. Войти под ними нельзя и не нужно — настоящие учётные записи
 * заводят в настройках, там же назначают пароль.
 */
import { randomBytes } from 'node:crypto';
import { hashPassword } from '$lib/server/auth/password';
import { users } from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { seedId } from './ids';

type AccountSeed = {
	key: string;
	email: string;
	fullName: string;
	roleId: string;
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
		key: 'demo-manager',
		email: 'manager@demo.lct-crm.local',
		fullName: 'Менеджер Демо',
		roleId: 'manager'
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
		roleId: 'manager'
	},
	{
		key: 'zotov',
		email: 'p.zotov@example.org',
		fullName: 'Зотов Павел Игоревич',
		roleId: 'manager'
	}
];

export type SeededUsers = {
	/** Идентификаторы демонстрационных записей по роли. */
	demo: Record<string, string>;
	/** Идентификаторы обычных сотрудников в порядке объявления. */
	employees: string[];
};

export async function seedUsers(tx: Tx, options: { demoPassword: string }): Promise<SeededUsers> {
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
				passwordHash,
				isDemo
			}))
		)
		// Пароль, роль и имя уже заведённой записи — дело администратора стенда:
		// повторный сид не возвращает их к тому, что записано здесь.
		.onConflictDoNothing({ target: users.id });

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
