/**
 * Загрузка оплат с сайта: запись файла, предпросмотр и итог.
 *
 * Сайт заказчика выгружает оплаченные заказы списком — JSON-массивом или
 * таблицей с теми же колонками. Сумм и дат в выгрузке нет, поэтому оплата здесь
 * не денежная запись, а факт: запись файла — это подтверждённая оплата заказа
 * (`docs/exchange-contract.md`, «Загрузка оплат с сайта»).
 */
import { z } from 'zod';
import { optionalText, requiredText } from './common';

/**
 * Что значит запись файла. Одна формулировка на экран, справку и контракт:
 * выгрузка сумм не несёт, и считать записью что-то кроме подтверждённой оплаты
 * не из чего.
 */
export const PAYMENTS_ASSUMPTION =
	'Каждая запись файла считается подтверждённой оплатой заказа: выгрузка сайта не несёт ни суммы, ни даты платежа, поэтому в систему попадает сам факт оплаты с номером заявки и потоком.';

/** Ключ пункта чек-листа, которым процесс отмечает поступление оплаты. */
export const PAYMENT_CHECKLIST_KEY = 'payment_received';

/** Сколько записей принимает один файл: выгрузка за период, а не архив сайта. */
export const PAYMENTS_MAX_ROWS = 2000;

/** Форматы файла — словами, для подписи поля выбора. */
export const PAYMENTS_FILE_FORMATS_HINT =
	'JSON-массив или таблица XLSX, XLS, CSV: «Номер заявки», «Курс», «Фамилия», «Имя», «Отчество», «Телефон», «Email», «Номер потока»';

/**
 * Номер потока — целое от единицы. Поток не глобален: «поток 1» есть у каждого
 * курса, и сам по себе номер ничего не называет, поэтому хранится он только
 * рядом с курсом, в факте оплаты.
 */
const streamNumberField = z
	.string({ error: 'Не указан номер потока' })
	.trim()
	.min(1, { error: 'Не указан номер потока' })
	.regex(/^\d+$/, { error: 'Номер потока — целое число' })
	.transform(Number)
	.pipe(
		z
			.number()
			.int()
			.min(1, { error: 'Номер потока начинается с единицы' })
			.max(99, { error: 'Номер потока — не больше 99' })
	);

/**
 * Запись файла после приведения ячеек к тексту.
 *
 * Номер заявки непрозрачен: длина цифр в нём разная, а дата внутри бывает
 * невалидной, поэтому он хранится как есть и ни на что не раскладывается.
 * Телефон приходит без «+», почта — в разном регистре: сравнивает их
 * нормализация справочника людей, а не эта схема.
 */
export const paymentRecordSchema = z.object({
	orderId: requiredText(200, 'Не указан номер заявки'),
	course: requiredText(500, 'Не указан курс'),
	lastName: requiredText(100, 'Не указана фамилия'),
	firstName: requiredText(100, 'Не указано имя'),
	middleName: optionalText(100),
	phone: optionalText(50).refine((value) => value === null || /^[\d\s+()-]{5,}$/.test(value), {
		error: 'Телефон может содержать только цифры, пробелы и знаки + ( ) -'
	}),
	email: z
		.string()
		.trim()
		.pipe(z.email({ error: 'Электронная почта указана неверно' })),
	streamNumber: streamNumberField
});

export type PaymentRecord = z.output<typeof paymentRecordSchema>;

/**
 * Что станет с записью: `create` — заведём взаимодействие, `update` — факт
 * ляжет на уже заведённое (заявка с тем же номером пришла с сайта раньше),
 * `unchanged` — эту оплату уже загружали, `error` — запись не загрузится.
 */
export const PAYMENT_ROW_ACTIONS = ['create', 'update', 'unchanged', 'error'] as const;

export type PaymentRowAction = (typeof PAYMENT_ROW_ACTIONS)[number];

export const PAYMENT_ROW_ACTION_LABELS: Record<PaymentRowAction, string> = {
	create: 'Создать',
	update: 'Обновить',
	unchanged: 'Без изменений',
	error: 'Ошибка'
};

/** Запись файла после разбора и сверки. */
export type PaymentRowView = {
	/** Где запись в файле — словами: «элемент 3» у JSON, «строка 4» у таблицы. */
	place: string;
	orderId: string | null;
	fullName: string;
	course: string | null;
	streamNumber: number | null;
	action: PaymentRowAction;
	/** Почему запись не загрузится. */
	issues: string[];
	/** Что ещё важно знать о записи: где отметится оплата, найден ли человек. */
	notes: string[];
};

/** Предпросмотр или итог загрузки оплат. */
export type PaymentsView = {
	rows: PaymentRowView[];
	counts: Record<PaymentRowAction, number>;
	/** Претензии к файлу целиком: нет колонки, записей больше предела. */
	fileIssues: string[];
	/** `true` — это итог загрузки, а не предпросмотр. */
	applied: boolean;
};

/**
 * Факт оплаты с сайта в том виде, в каком его показывает карточка дела: номер
 * заявки, поток и день загрузки. `streamNumber` — `null`, когда данные
 * человека уничтожены и тело строки журнала стёрто.
 */
export type PaymentFactView = {
	orderId: string;
	streamNumber: number | null;
	loadedAt: Date;
};
