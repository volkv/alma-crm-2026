/**
 * Коммерческие условия дела: стоимость обучения в рублях.
 *
 * Стоимость — атрибут дела, а не факт оплаты: её называют в предложении и
 * договоре, а оплату отмечают отдельно (`payments.ts`). Хранится в копейках
 * целым числом; человек вводит рубли так, как привык их писать: «45 000»,
 * «45000,50», «45 000 ₽».
 */
import { z } from 'zod';
import { id } from './common';

/** Потолок стоимости: миллиард рублей. Больше — опечатка, а не цена курса. */
const MAX_PRICE_KOPECKS = 100_000_000_000;

/** Стоимость из поля формы в копейках; пустое поле — стоимость снята (`null`). */
export function parsePriceRub(raw: string): number | null | 'invalid' {
	const text = raw
		.replace(/[\s\u00a0\u202f]/gu, '')
		.replace(/(₽|руб\.?|р\.)$/iu, '')
		.replace(',', '.');

	if (text === '') {
		return null;
	}

	const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(text);

	if (match === null) {
		return 'invalid';
	}

	const kopecks = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));

	return Number.isSafeInteger(kopecks) ? kopecks : 'invalid';
}

/** Стоимость словами для экрана: «45 000 ₽», «45 000,50 ₽». */
export function formatPriceRub(kopecks: number): string {
	return new Intl.NumberFormat('ru-RU', {
		style: 'currency',
		currency: 'RUB',
		minimumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
		maximumFractionDigits: 2
	}).format(kopecks / 100);
}

/**
 * Стоимость словами для документа: «45 000 руб.», «45 000,50 руб.». Знак ₽
 * в договор не идёт: шрифт службы печати PDF может его не знать.
 */
export function formatDocumentPrice(kopecks: number): string {
	const rubles = new Intl.NumberFormat('ru-RU', {
		minimumFractionDigits: kopecks % 100 === 0 ? 0 : 2,
		maximumFractionDigits: 2
	}).format(kopecks / 100);

	return `${rubles} руб.`;
}

export const setInteractionTermsSchema = z.object({
	interactionId: id('Некорректный идентификатор взаимодействия'),
	/**
	 * Версия условий, которую видел человек: `0` — условий ещё не записывали.
	 * Разошлась — значит, стоимость успели поменять в другой вкладке.
	 */
	version: z.coerce
		.number({ error: 'Не указана версия условий' })
		.int({ error: 'Не указана версия условий' })
		.min(0, { error: 'Не указана версия условий' }),
	price: z
		.string()
		.nullable()
		.default(null)
		.transform((value, context) => {
			const parsed = parsePriceRub(value ?? '');

			if (parsed === 'invalid') {
				context.addIssue({
					code: 'custom',
					message: 'Стоимость — число рублей, например 45 000 или 45 000,50'
				});

				return z.NEVER;
			}

			if (parsed !== null && parsed > MAX_PRICE_KOPECKS) {
				context.addIssue({ code: 'custom', message: 'Стоимость больше миллиарда рублей' });

				return z.NEVER;
			}

			return parsed;
		})
});

export type SetInteractionTermsInput = z.output<typeof setInteractionTermsSchema>;

/** Условия дела в карточке. */
export type InteractionTermsView = {
	/** Стоимость в копейках; `null` — не названа. */
	priceKopecks: number | null;
	/** Версия для следующей правки; `0` — условий ещё не записывали. */
	version: number;
	/** Когда и кто назвал стоимость последним; `null` — ещё никто. */
	updatedAt: Date | null;
	updatedByName: string | null;
};
