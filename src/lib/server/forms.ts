/**
 * Разбор форм в действиях страниц: поля в объект для схемы контракта, отказ
 * формы с претензиями, общая обёртка действия.
 *
 * Общие для карточки взаимодействия и действий модулей: отказ формы обязан
 * выглядеть одинаково, чья бы кнопка его ни вызвала, — `{ message, issues }`
 * рядом с действием.
 */
import { fail } from '@sveltejs/kit';
import type { z } from 'zod';
import { DocumentConversionError } from './documents/errors';
import { toActionFailure } from './http';

/** Поля формы в объекте, пригодном для схемы контракта. */
export function fields(data: FormData): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const key of new Set(data.keys())) {
		const values = data.getAll(key);
		result[key] = values.length === 1 ? values[0] : values;
	}

	return result;
}

/**
 * Разбор тела формы по схеме контракта. Претензии показываются рядом с
 * действием, а не превращаются в отказ без объяснения.
 */
export function parse<TSchema extends z.ZodType>(schema: TSchema, input: unknown) {
	const parsed = schema.safeParse(input);

	if (!parsed.success) {
		return {
			ok: false as const,
			failure: fail(400, {
				message: 'Данные действия не прошли проверку',
				issues: parsed.error.issues.map((issue) => issue.message)
			})
		};
	}

	return { ok: true as const, data: parsed.data };
}

/** Общая обёртка действия: предметная ошибка становится отказом формы. */
export async function run(action: () => Promise<unknown>) {
	try {
		await action();

		return { ok: true };
	} catch (cause) {
		// Отказ внешней службы преобразования — не ошибка предметной области и не
		// наш сбой: человеку нужно сказать, что документ не собрался, и почему.
		if (cause instanceof DocumentConversionError) {
			return fail(502, { message: cause.message, issues: [] as string[] });
		}

		return toActionFailure(cause);
	}
}

/** Файл из поля формы; `null` — файла не выбрали. */
export function fileField(data: FormData, key: string): File | null {
	const file = data.get(key);

	return file instanceof File && file.size > 0 ? file : null;
}

/** Значение поля формы как строка или `null` для пустого. */
export function text(data: FormData, key: string): string | null {
	const value = data.get(key);

	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
