/**
 * Ошибки предметной области.
 *
 * Сервисы бросают их, не зная ничего про HTTP: превращает ошибку в ответ
 * транспорт — form action, эндпоинт API или консольный скрипт. Но статус,
 * которым отвечает каждый код, один на все транспорты, поэтому таблица
 * `code → status` лежит здесь же, рядом с кодами (`docs/data-model.md`).
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

/**
 * Статус ответа для каждого кода. Таблица закрыта типом: новый вид отказа
 * заводится вместе со своим статусом, а не подбирается транспортом на месте.
 */
const STATUS_BY_CODE: Record<AppErrorCode, number> = {
	validation: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409
};

/**
 * Каким статусом отвечать на эту ошибку. Единственный источник соответствия для
 * страниц (`toPageError`), форм (`toActionFailure`) и публичного API.
 */
export function statusForError(error: AppError): number {
	return STATUS_BY_CODE[error.code];
}
