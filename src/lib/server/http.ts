/**
 * Перевод ошибок предметной области в ответ браузерного контура.
 *
 * Сервисы бросают ошибки из `$lib/server/errors`, ничего не зная про HTTP.
 * Здесь они становятся ответом: у действия формы — отказом с текстом рядом с
 * полями, у загрузчика страницы — статусом, который рисует страница ошибки.
 * Статус в обоих случаях берётся из одной таблицы (`statusForError`), а
 * публичный API читает её же. Ошибка, которой нет в словаре, не подменяется
 * статусом «на всякий случай»: она летит дальше и становится 500, потому что
 * неизвестный сбой нельзя показывать как отказ по правилам.
 */
import { error, fail, type ActionFailure } from '@sveltejs/kit';
import { AppError, statusForError, ValidationError } from './errors';

export type ActionErrorPayload = {
	message: string;
	/** Претензии к отдельным полям; пусто у всего, кроме `ValidationError`. */
	issues: string[];
};

/** Претензии к полям в том виде, в каком их показывают человеку. */
export function errorIssues(cause: AppError): string[] {
	return cause instanceof ValidationError ? [...cause.issues] : [];
}

export function toActionFailure(cause: unknown): ActionFailure<ActionErrorPayload> {
	if (!(cause instanceof AppError)) {
		throw cause;
	}

	return fail(statusForError(cause), { message: cause.message, issues: errorIssues(cause) });
}

/**
 * То же самое для загрузчика страницы.
 *
 * У загрузчика, в отличие от действия формы, нет формы, куда положить
 * претензию: страница либо рисуется, либо не существует для этого человека.
 * Поэтому `ForbiddenError` и `NotFoundError` становятся 403 и 404 с тем же
 * текстом, который сервис написал по-русски, а претензии к запросу
 * дописываются к сообщению — терять их по дороге незачем.
 */
export function toPageError(cause: unknown): never {
	if (!(cause instanceof AppError)) {
		throw cause;
	}

	error(statusForError(cause), { message: [cause.message, ...errorIssues(cause)].join('. ') });
}
