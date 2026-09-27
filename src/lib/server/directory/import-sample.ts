/**
 * Образец файла для загрузки справочника: заголовки — ровно те подписи полей,
 * которые шаг сопоставления узнаёт сам, строка-пример и лист с допущениями.
 *
 * Строки примера вымышлены: ИНН проходят контрольную сумму, но реальным
 * организациям не принадлежат, контакты — на домене `example.org`.
 */
import {
	IMPORT_FIELDS_BY_KIND,
	type CatalogField,
	type DirectoryImportKind,
	type VendorField
} from '$lib/contracts/directory-import';
import { writeXlsx, type SpreadsheetWriteCell } from '../spreadsheet/write';

const CATALOG_EXAMPLE: Record<CatalogField, SpreadsheetWriteCell> = {
	organization: 'Университет-пример',
	organizationInn: '7701000019',
	vendor: 'Вендор-пример',
	product: 'Среда разработки',
	productCode: 'IDE-01',
	direction: 'Разработка ПО',
	contractNumber: 'ПР-2026-001',
	contractSignedOn: '01.09.2026',
	contractValidUntil: '31.08.2027',
	licenseSignedAt: '15.09.2026',
	licenseUntil: '2027',
	transferStatus: 'в работе',
	manager: 'Фамилия Имя Отчество',
	contacts: 'Иванова Мария Петровна, проректор, +7 900 111-22-33, m.ivanova@example.org',
	comment: 'Опорный вуз региона'
};

const VENDOR_EXAMPLE: Record<VendorField, SpreadsheetWriteCell> = {
	company: 'Вендор-пример',
	companyInn: '7801000020',
	products: '«Среда разработки», «Система контроля версий»',
	contactName: 'Петров Пётр Петрович',
	contactPhone: '+7 900 222-33-44',
	contactEmail: 'p.petrov@example.org',
	contactChannel: 'Почта, Чат в ТГ'
};

const EXAMPLES: Record<DirectoryImportKind, Readonly<Record<string, SpreadsheetWriteCell>>> = {
	catalog: CATALOG_EXAMPLE,
	vendors: VENDOR_EXAMPLE
};

/** Колонки образца по порядку полей: подпись поля — это и есть заголовок. */
export function importSampleHeaders(kind: DirectoryImportKind): string[] {
	const { fields, labels } = IMPORT_FIELDS_BY_KIND[kind];

	return fields.map((field) => labels[field]);
}

/** Образец XLSX: лист данных с одной строкой-примером и лист «Как заполнять». */
export function importSample(kind: DirectoryImportKind): Buffer {
	const { fields, labels, hints, required } = IMPORT_FIELDS_BY_KIND[kind];
	const example = EXAMPLES[kind];

	return writeXlsx([
		{
			name: 'Данные',
			columns: fields.map(() => ({ width: 24 })),
			rows: [importSampleHeaders(kind), fields.map((field) => example[field] ?? null)]
		},
		{
			name: 'Как заполнять',
			columns: [{ width: 28 }, { width: 14 }, { width: 90 }],
			rows: [
				['Колонка', 'Обязательна', 'Как читается'],
				...fields.map((field) => [
					labels[field],
					required.includes(field) ? 'да' : '',
					hints[field]
				])
			]
		}
	]);
}
