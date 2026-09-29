/**
 * Вход в систему и пользователи.
 *
 * Пароли здесь не описаны и описаны быть не могут: их проверяет каталог
 * учётных записей, а приложение получает от него проверенный токен
 * (`docs/auth.md`). Осталось то, что видят обе стороны, — представление
 * пользователя в настройках.
 */

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
