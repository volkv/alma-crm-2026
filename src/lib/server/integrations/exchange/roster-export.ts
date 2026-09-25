/**
 * Поимённый список потока книгой по шаблону загрузки пользователей в систему
 * обучения заказчика.
 *
 * Шаблон чужой, и повторяется он дословно: 30 колонок в том же порядке, с теми
 * же названиями — включая потерянные открывающие скобки в «Отчествопри
 * наличии)» и трёх колонках дательного падежа. Загрузчик системы обучения
 * сверяет шапку по строкам, и «исправленное» название там — неизвестная
 * колонка. Второй лист со справочниками пола и уровня образования и проверки
 * данных на колонках «Пол» и «Образование» тоже из шаблона: сотрудник
 * дозаполняет их выбором из списка, а не свободным текстом.
 *
 * Заполняются только фамилия, имя, отчество, телефон и почта. Паспорт, СНИЛС,
 * адрес, диплом, пол, дату рождения и ФИО в дательном падеже CRM не собирает:
 * для списка слушателей достаточно ФИО и почты, а лишние персональные данные
 * — это лишнее, что придётся защищать. Эти колонки остаются пустыми, и их
 * дозаполняют перед загрузкой.
 */
import ExcelJS from 'exceljs';
import { normalizePhone } from '../../people/pii';
import { spreadsheetText } from '../../spreadsheet';

/** Шапка листа загрузки: колонки A–AD шаблона, байт в байт. */
export const LMS_USER_TEMPLATE_HEADERS = [
	'Фамилия',
	'Имя',
	'Отчествопри наличии)',
	'Номер телефона',
	'Email',
	'СНИЛС',
	'Серия паспорта',
	'Номер паспорта',
	'Кем выдан паспорт',
	'Дата выдачи паспорта',
	'Код подразделения',
	'Пол',
	'Дата рождения',
	'Регион регистрации',
	'Населенный пункт регистрации',
	'Улица регистрации',
	'Дом регистрации',
	'Квартира регистрации',
	'Индекс регистрации',
	'Имядательный падеж)',
	'Фамилиядательный падеж)',
	'Отчестводательный падеж)',
	'Образование',
	'Профессия по диплому',
	'Учебное заведение по диплому',
	'Фамилия, указанная в дипломе',
	'Номер диплома',
	'Серия диплома',
	'Регистрационный номер диплома',
	'Дата выдачи диплома'
] as const;

/** Справочник пола: колонка A второго листа шаблона. */
export const LMS_USER_TEMPLATE_GENDERS = ['М', 'Ж'] as const;

/**
 * Справочник уровня образования: колонка B второго листа шаблона. Тире —
 * как в оригинале: длинное в трёх «Высшее образование – …», дефис в «9 классов»
 * и «11 классов».
 */
export const LMS_USER_TEMPLATE_EDUCATION = [
	'Без образования',
	'Основное общее образование - 9 классов',
	'Среднее общее образование - 11 классов',
	'Среднее профессиональное образование',
	'Высшее образование – бакалавриат',
	'Высшее образование – специалитет, магистратура',
	'Высшее образование – подготовка кадров высшей квалификации'
] as const;

const USERS_SHEET = 'Лист1';
const LISTS_SHEET = 'Лист2';

/** Колонки со справочником из второго листа: буква колонки → диапазон списка. */
const LIST_COLUMNS = [
	{ column: 'L', range: `${LISTS_SHEET}!$A$1:$A$${LMS_USER_TEMPLATE_GENDERS.length}` },
	{ column: 'W', range: `${LISTS_SHEET}!$B$1:$B$${LMS_USER_TEMPLATE_EDUCATION.length}` }
] as const;

/**
 * До какой строки действует проверка данных, даже когда слушателей меньше: в
 * шаблоне она заранее растянута вниз, и сотрудник дописывает строки руками.
 */
const VALIDATION_MIN_LAST_ROW = 1001;

/** Сколько первых колонок шаблона выделены: в оригинале шапка A–F жирная, по центру. */
const EMPHASIZED_HEADER_COLUMNS = 6;

/** Слушатель в строке книги: ровно то, что CRM о нём знает. */
export type LmsUserRow = {
	lastName: string;
	firstName: string;
	middleName: string | null;
	phone: string | null;
	email: string | null;
};

/**
 * Телефон числом, если это обычный российский номер из 11 цифр: так его
 * пишет шаблон, и так он проходит загрузку. Всё остальное — строкой как есть,
 * чтобы не потерять ни знак, ни добавочный номер.
 */
function phoneCell(phone: string | null): number | string | null {
	if (phone === null) {
		return null;
	}

	const digits = normalizePhone(phone);

	return digits !== null && digits.length === 11 ? Number(digits) : spreadsheetText(phone);
}

function textCell(value: string | null): string | null {
	return value === null || value === '' ? null : spreadsheetText(value);
}

/** Книга загрузки пользователей. Чистая функция: байты зависят только от строк. */
export async function buildLmsUserWorkbook(
	rows: readonly LmsUserRow[]
): Promise<Uint8Array<ArrayBuffer>> {
	const workbook = new ExcelJS.Workbook();
	const users = workbook.addWorksheet(USERS_SHEET);
	const lists = workbook.addWorksheet(LISTS_SHEET);

	const header = users.addRow([...LMS_USER_TEMPLATE_HEADERS]);

	for (let column = 1; column <= EMPHASIZED_HEADER_COLUMNS; column += 1) {
		const cell = header.getCell(column);

		cell.font = { bold: true };
		cell.alignment = { horizontal: 'center' };
	}

	users.columns.forEach((column) => {
		column.width = 20;
	});

	for (const row of rows) {
		const added = users.addRow([
			spreadsheetText(row.lastName),
			spreadsheetText(row.firstName),
			textCell(row.middleName),
			phoneCell(row.phone),
			textCell(row.email)
		]);

		// Без формата большое целое показывается экспонентой: 7,92E+10 вместо
		// номера телефона.
		added.getCell(4).numFmt = '0';
	}

	LMS_USER_TEMPLATE_GENDERS.forEach((value, index) => {
		lists.getCell(index + 1, 1).value = value;
	});
	LMS_USER_TEMPLATE_EDUCATION.forEach((value, index) => {
		lists.getCell(index + 1, 2).value = value;
	});

	const lastRow = Math.max(VALIDATION_MIN_LAST_ROW, rows.length + 1);

	for (const { column, range } of LIST_COLUMNS) {
		for (let row = 2; row <= lastRow; row += 1) {
			users.getCell(`${column}${row}`).dataValidation = {
				type: 'list',
				allowBlank: true,
				formulae: [range]
			};
		}
	}

	// `writeBuffer` объявлен через собственный `Buffer extends ArrayBuffer`
	// (см. `stats/export.ts`), а телу ответа нужен `Uint8Array` над обычным
	// `ArrayBuffer`.
	const written = (await workbook.xlsx.writeBuffer()) as ArrayBuffer;

	return new Uint8Array(written);
}
