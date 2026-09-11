/**
 * Перевод ошибок предметной области в ответ формы.
 *
 * Сервисы бросают ошибки из `$lib/server/errors`, ничего не зная про HTTP.
 * Соответствие кодов и статусов одно на всё приложение — здесь; в API те же
 * коды превращаются в тело ответа. Ошибка, которой нет в словаре, не
 * подменяется статусом «на всякий случай»: она летит дальше и становится 500,
 * потому что неизвестный сбой нельзя показывать как отказ по правилам.
 */
import { fail, type ActionFailure } from '@sveltejs/kit';
import { AppError, ValidationError, type AppErrorCode } from './errors';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
	validation: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409
};

export type ActionErrorPayload = {
	message: string;
	/** Претензии к отдельным полям; пусто у всего, кроме `ValidationError`. */
	issues: string[];
};

export function toActionFailure(error: unknown): ActionFailure<ActionErrorPayload> {
	if (!(error instanceof AppError)) {
		throw error;
	}

	return fail(STATUS_BY_CODE[error.code], {
		message: error.message,
		issues: error instanceof ValidationError ? [...error.issues] : []
	});
}
