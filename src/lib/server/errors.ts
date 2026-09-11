/**
 * Ошибки предметной области.
 *
 * Сервисы бросают их, не зная ничего про HTTP: превращает ошибку в ответ
 * транспорт — form action, эндпоинт API или консольный скрипт. Соответствие
 * кодов и статусов описано в `docs/data-model.md`.
 */

/** Машиночитаемый код ошибки; по нему транспорт выбирает статус ответа. */
export type AppErrorCode = 'validation' | 'forbidden' | 'not_found' | 'conflict';

export abstract class AppError extends Error {
	abstract readonly code: AppErrorCode;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
	}
}

/**
 * Данные не прошли проверку. `issues` — претензии в том виде, в каком их можно
 * показать человеку: по одной на поле или общие.
 */
export class ValidationError extends AppError {
	readonly code = 'validation';
	readonly issues: readonly string[];

	constructor(message: string, issues: readonly string[] = []) {
		super(message);
		this.issues = issues;
	}
}

/** Действие запрещено правами. */
export class ForbiddenError extends AppError {
	readonly code = 'forbidden';

	constructor(message = 'Недостаточно прав для этого действия') {
		super(message);
	}
}

/**
 * Записи нет — или она есть, но вне области доступа вызывающего. Второй случай
 * намеренно неотличим от первого: иначе перебором идентификаторов можно узнать,
 * что существует за пределами своей области.
 */
export class NotFoundError extends AppError {
	readonly code = 'not_found';

	constructor(message = 'Запись не найдена') {
		super(message);
	}
}

/** Действие противоречит текущему состоянию записи или нарушает уникальность. */
export class ConflictError extends AppError {
	readonly code = 'conflict';

	constructor(message: string) {
		super(message);
	}
}
