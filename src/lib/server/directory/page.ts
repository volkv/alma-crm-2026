/**
 * Перевод ошибок предметной области в ответ страницы.
 *
 * У загрузчика, в отличие от действия формы, нет формы, куда положить
 * претензию: страница либо рисуется, либо не существует для этого человека.
 * Поэтому `ForbiddenError` и `NotFoundError` становятся 403 и 404 с тем же
 * текстом, который сервис написал по-русски, а незнакомая ошибка летит дальше
 * и становится 500 — неизвестный сбой нельзя показывать как отказ по правилам.
 *
 * Соответствие кодов и статусов то же, что у `toActionFailure`
 * (`$lib/server/http`): когда страницы появятся и в других разделах, эту
 * функцию стоит поднять туда же.
 */
import { error } from '@sveltejs/kit';
import { AppError } from '../errors';

const STATUS_BY_CODE = {
	validation: 400,
	forbidden: 403,
	not_found: 404,
	conflict: 409
} as const;

export function toPageError(cause: unknown): never {
	if (!(cause instanceof AppError)) {
		throw cause;
	}

	error(STATUS_BY_CODE[cause.code], { message: cause.message });
}
