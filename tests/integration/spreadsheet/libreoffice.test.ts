/**
 * Книга, собранная продуктом, глазами настоящей таблицы.
 *
 * Прочитать свой же файл своей же библиотекой мало: у BIFF8 много записей, и
 * SheetJS одинаково легко читает и правильную книгу, и ту, которую Excel
 * откажется открывать. Поэтому файл отдаётся LibreOffice — тому же движку,
 * которым таблицу откроет человек, — и проверяется то, что он из неё
 * достал.
 *
 * Тесту нужен `soffice` в системе. Если его нет, тест падает с объяснением:
 * молчаливый пропуск означал бы зелёный прогон, который ничего не проверил.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSpreadsheet } from '$lib/server/spreadsheet/read';
import { XLSX } from '$lib/server/spreadsheet/sheetjs';
import { writeXls, type SpreadsheetWriteSheet } from '$lib/server/spreadsheet/write';

const SHEET: SpreadsheetWriteSheet = {
	name: 'Визиты',
	// Первая колонка заметно шире третьей: по этому и проверяется, что ширины
	// вообще доехали до файла.
	columns: [{ width: 42 }, { width: 14 }, { width: 8 }],
	rows: [
		['Организация', 'Дата визита', 'Участников'],
		['МГТУ им. Баумана', new Date(Date.UTC(2026, 8, 12)), 42],
		['Университет (филиал)', null, 0],
		['Казанский федеральный', new Date(Date.UTC(2027, 0, 15)), 128]
	]
};

let workspace: string;

/**
 * Запуск LibreOffice в отдельном профиле: общий профиль в домашнем каталоге
 * блокируется первым же процессом, и параллельный прогон повис бы на нём.
 */
function convert(source: string, target: string): string {
	const outputDirectory = join(workspace, target.replaceAll(':', '-'));

	try {
		execFileSync(
			'soffice',
			[
				'--headless',
				`-env:UserInstallation=file://${join(workspace, 'profile')}`,
				'--convert-to',
				target,
				'--outdir',
				outputDirectory,
				source
			],
			{ timeout: 120_000, stdio: 'pipe' }
		);
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
			throw new Error(
				'Для этой проверки нужен LibreOffice: команда `soffice` не найдена. ' +
					'Установите пакет libreoffice-calc — проверку того, что книга открывается ' +
					'настоящей таблицей, заменить нечем.',
				{ cause }
			);
		}

		throw cause;
	}

	const produced = readdirSync(outputDirectory);

	expect(produced).toHaveLength(1);

	return join(outputDirectory, produced[0]);
}

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), 'spreadsheet-'));
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true });
});

describe('книга XLS глазами LibreOffice', () => {
	it('открывается и отдаёт те же значения', { timeout: 180_000 }, () => {
		const source = join(workspace, 'выгрузка.xls');

		writeFileSync(source, writeXls([SHEET]));

		const text = readFileSync(
			convert(source, 'csv:Text - txt - csv (StarCalc):59,34,76,1,,1033,false,true,true'),
			'utf8'
		);

		expect(text).toContain('Организация;Дата визита;Участников');
		expect(text).toContain('МГТУ им. Баумана;12.09.2026;42');
		// Пустая ячейка осталась пустой, ноль — нулём.
		expect(text).toContain('Университет (филиал);;0');
	});

	it('сохраняет имя листа, ширины колонок и типы ячеек', { timeout: 180_000 }, () => {
		const source = join(workspace, 'колонки.xls');

		writeFileSync(source, writeXls([SHEET]));

		const converted = readFileSync(convert(source, 'xlsx'));
		const content = readSpreadsheet(converted, 'колонки.xlsx');

		expect(content.info.format).toBe('xlsx');
		expect(content.info.sheetNames).toEqual(['Визиты']);
		expect(content.sheets[0].rows[1]).toEqual([
			'МГТУ им. Баумана',
			new Date(Date.UTC(2026, 8, 12)),
			42
		]);

		// Ширины SheetJS обратно из BIFF не читает, поэтому смотрим их в книге,
		// которую пересобрал LibreOffice: точные числа он пересчитывает, а
		// соотношение колонок сохраняет.
		// `cellStyles` — иначе SheetJS пропускает описание колонок при разборе XLSX.
		const columns = XLSX.read(converted, { type: 'array', dense: true, cellStyles: true }).Sheets[
			'Визиты'
		]['!cols'];

		const wide = columns?.[0]?.wch;
		const narrow = columns?.[2]?.wch;

		if (wide === undefined || narrow === undefined) {
			expect.unreachable('в книге, пересобранной LibreOffice, нет ширин колонок');
		}

		expect(wide).toBeGreaterThan(narrow);
	});
});
