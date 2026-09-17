/**
 * Вход в систему и пользователи.
 *
 * Пароли здесь не описаны и описаны быть не могут: их проверяет каталог
 * учётных записей, а приложение получает от него проверенный токен
 * (`docs/auth.md`). Осталось то, что видят обе стороны, — учётные записи
 * демонстрационного стенда и представление пользователя в настройках.
 */

/**
 * Учётная запись демонстрационного стенда: то, что человек вводит в форму
 * каталога. Пароль у всех трёх общий и здесь не хранится — его знает стенд
 * (`SEED_DEMO_PASSWORD`), а не приложение.
 */
export type DemoAccount = {
	/** Имя входа в каталоге. */
	login: string;
	/** Роль системы, которую даёт эта запись. */
	roleId: string;
	roleName: string;
};

/**
 * Демонстрационные записи, которые перечисляет страница входа при
 * `DEMO_MODE=true`. Список закрытый и совпадает с `keycloak/realm-lct.json` и
 * таблицей в `README.md`: карточка на странице входа — это подсказка к чужой
 * форме, и разойтись с realm ей нельзя.
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
	{ login: 'admin', roleId: 'admin', roleName: 'Администратор' },
	{ login: 'lead', roleId: 'lead', roleName: 'Руководитель' },
	{ login: 'manager', roleId: 'manager', roleName: 'Менеджер' }
];

/** Пользователь в списке управления доступом. */
export type UserView = {
	id: string;
	email: string;
	fullName: string;
	roleId: string;
	roleName: string;
	/** Руководитель сотрудника; `null` — не задан. */
	managerUserId: string | null;
	managerFullName: string | null;
	/** Запись хотя бы раз входила через каталог. */
	isLinked: boolean;
	isActive: boolean;
	isDemo: boolean;
	lastLoginAt: Date | null;
	createdAt: Date;
};
