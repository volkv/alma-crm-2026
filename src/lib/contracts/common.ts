/**
 * Кирпичи, из которых собраны остальные контракты.
 *
 * Контракты — единственное описание того, что можно прислать серверу и что он
 * отдаёт наружу. Они не импортируют ничего из `$lib/server`, поэтому одна и та
 * же схема валидирует форму в браузере, тело запроса к API и строку импорта.
 */
import { z } from 'zod';

/** Обязательное текстовое поле формы: пробелы по краям не значимы. */
export function requiredText(max: number, error: string) {
	return z
		.string({ error })
		.trim()
		.min(1, { error })
		.max(max, { error: `${error} — не длиннее ${max} символов` });
}

/**
 * Необязательное текстовое поле. Пустая строка из формы и отсутствие значения —
 * это одно и то же `null`, чтобы в базе не появлялось двух видов «пусто».
 */
export function optionalText(max: number) {
	return z
		.string()
		.trim()
		.max(max, { error: `Не длиннее ${max} символов` })
		.nullable()
		.default(null)
		.transform((value) => (value === null || value === '' ? null : value));
}

/** Идентификатор записи; сообщение подставляет вызывающая схема. */
export function id(error: string) {
	return z.uuid({ error });
}

/** Необязательная ссылка на другую запись. */
export function optionalId(error: string) {
	return z.uuid({ error }).nullable().default(null);
}

/** Календарная дата без времени: учебные и договорные сроки живут в днях. */
export function isoDate(error: string) {
	return z.iso.date({ error });
}

/** Необязательная календарная дата. */
export function optionalIsoDate(error: string) {
	return z.iso
		.date({ error })
		.nullable()
		.default(null)
		.transform((value) => (value === null || value === '' ? null : value));
}

/** Постраничный запрос. `coerce` — потому что из query-строки приходят строки. */
export const pageQuerySchema = z.object({
	page: z.coerce.number({ error: 'Номер страницы — целое число' }).int().min(1).default(1),
	pageSize: z.coerce
		.number({ error: 'Размер страницы — целое число' })
		.int()
		.min(1)
		.max(100, { error: 'За один раз отдаём не больше 100 записей' })
		.default(20)
});

export type PageQuery = z.output<typeof pageQuerySchema>;

/** Страница результатов вместе со счётчиком для пагинации. */
export type PageResult<TItem> = {
	items: TItem[];
	total: number;
	page: number;
	pageSize: number;
};

/**
 * Поисковая строка списка. Пустая строка означает «без фильтра», а не «искать
 * пустоту», поэтому превращается в `null`.
 */
export const searchQuery = z
	.string()
	.trim()
	.max(200, { error: 'Поисковый запрос не длиннее 200 символов' })
	.nullable()
	.default(null)
	.transform((value) => (value === null || value === '' ? null : value));
