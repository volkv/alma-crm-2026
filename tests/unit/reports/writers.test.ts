/**
 * Писатели отчёта на готовом объекте: без базы и без сети.
 *
 * Проверяется то, из-за чего файл врёт молча: число строк, обезвреживание
 * формул, пустая ячейка вместо нуля, пометка сорта колонки в заголовке и
 * экранирование в HTML для печати.
 */
import { describe, expect, it } from 'vitest';
import { REPORT_PDF_ROWS } from '$lib/contracts/reports';
import { writeXls, writeXlsx } from '$lib/server/spreadsheet/write';
import { XLSX } from '$lib/server/spreadsheet/sheetjs';
import { checkExportInvariant, checkReportInvariants } from '$lib/server/reports/invariants';
import { reportFileName } from '$lib/server/reports/writers/filename';
import { reportFooterHtml, reportHtml } from '$lib/server/reports/writers/html';
import { reportJson } from '$lib/server/reports/writers/json';
import { reportSheets } from '$lib/server/reports/writers/sheets';
import { sampleReportView } from '../../fixtures/reports/view';

const VIEW = sampleReportView();

describe('листы книги', () => {
	const sheets = reportSheets(VIEW);

	it('собирает три листа с короткими именами', () => {
		expect(sheets.map((sheet) => sheet.name)).toStrictEqual(['Отчёт', 'Фильтры', 'Сводка']);
		expect(sheets.every((sheet) => sheet.name.length <= 31)).toBe(true);
	});

	it('пишет заголовок колонки вместе с пометкой сорта', () => {
		expect(sheets[0].rows[0]).toStrictEqual([
			'Взаимодействие (сейчас)',
			'Вуз или контрагент (сейчас)',
			'Продукты (сейчас)',
			'Дней на стадии (на 31.12.2026)',
			'Адрес карточки'
		]);
	});

	it('строк на листе ровно столько, сколько в таблице', () => {
		expect(sheets[0].rows.length - 1).toBe(VIEW.rows.length);
	});

	it('число пишет числом, а пустое значение оставляет пустым', () => {
		expect(sheets[0].rows[1][3]).toBe(12);
		// Пустая ячейка — не ноль: ноль означает записанный ноль.
		expect(sheets[0].rows[2][3]).toBeNull();
	});

	it('список значений кладёт в одну ячейку, а не размножает строку', () => {
		expect(sheets[0].rows[1][2]).toBe('П-1, П-1б');
		expect(sheets[0].rows[2][2]).toBeNull();
	});

	it('обезвреживает значение, начинающееся со знака формулы', () => {
		const workbook = XLSX.read(writeXlsx(sheets), { type: 'buffer' });
		const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets['Отчёт'], {
			header: 1,
			raw: false,
			defval: ''
		});

		// `=Опасное название` открылось бы формулой у того, кто открыл файл.
		expect(rows[2][0]).toBe("'=Опасное название");
	});

	it('адрес карточки пишет текстом в отдельной колонке', () => {
		expect(sheets[0].rows[1][4]).toBe(
			'http://localhost:5173/interactions/11111111-1111-4111-8111-111111111111'
		);
	});

	it('на листе фильтров есть режим, период, область и правило', () => {
		const text = sheets[1].rows.map((row) => row.join(' ')).join('\n');

		expect(text).toContain('Режим Срез');
		expect(text).toContain('все взаимодействия');
		expect(text).toContain('Срез на 31.12.2026.');
	});

	it('на сводке стоят числа диаграмм и предупреждение о двойном счёте', () => {
		const text = sheets[2].rows.map((row) => row.join(' ')).join('\n');

		expect(text).toContain('Поиск контактных лиц 1');
		expect(text).toContain('Завершено 1');
		expect(text).toContain('Учтено дважды и более 1');
	});
});

describe('JSON', () => {
	const payload = JSON.parse(reportJson(VIEW).toString('utf8')) as {
		schemaVersion: number;
		rows: {
			rowKey: string;
			interactionId: string;
			stageEntryId: string | null;
			values: Record<string, unknown>;
			documents: unknown[];
			learningGroups: unknown[];
		}[];
	};

	it('несёт версию схемы и все строки', () => {
		expect(payload.schemaVersion).toBe(1);
		expect(payload.rows.length).toBe(VIEW.rows.length);
	});

	it('называет ячейки ключами колонок, а не порядком', () => {
		expect(payload.rows[0].values).toStrictEqual({
			interaction: 'Первое взаимодействие',
			organization: 'Вуз А',
			products: ['П-1', 'П-1б'],
			daysOnStage: 12
		});
	});

	it('держит устойчивое имя строки и идентификатор записи о стадии', () => {
		expect(payload.rows.map((row) => row.rowKey)).toStrictEqual(VIEW.rows.map((row) => row.rowKey));
		expect(payload.rows[0].stageEntryId).toBe('22222222-2222-4222-8222-222222222222');
		expect(payload.rows[1].stageEntryId).toBeNull();
	});

	it('несёт ключи документов и учебных групп, и ни одного персонального поля', () => {
		// Путь «от числа к подтверждению» в файле держится только на них: ни
		// названия документа, ни того, кто его загрузил, в строке нет и не должно
		// быть.
		expect(payload.rows[0].documents).toStrictEqual([
			{
				id: '55555555-5555-4555-8555-555555555555',
				kind: 'agreement',
				storageKey: 'files/55555555-5555-4555-8555-555555555555',
				sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
			}
		]);
		expect(payload.rows[0].learningGroups).toStrictEqual([
			{
				id: '66666666-6666-4666-8666-666666666666',
				externalId: 'LMS-2026-1',
				resultId: '77777777-7777-4777-8777-777777777777'
			}
		]);

		// Подтвердить нечем — пустой список, а не отсутствие поля: читающий не
		// должен гадать, не потерялся ли ключ по дороге.
		expect(payload.rows[1].documents).toStrictEqual([]);
		expect(payload.rows[1].learningGroups).toStrictEqual([]);
	});

	it('пишется в UTF-8 без метки порядка байтов', () => {
		const bytes = reportJson(VIEW);

		expect(bytes.subarray(0, 3).toString('hex')).not.toBe('efbbbf');
		expect(bytes.toString('utf8')).toContain('Вуз А');
	});
});

describe('страница на печать', () => {
	const html = reportHtml(VIEW);

	it('повторяет шапку таблицы на каждой странице', () => {
		expect(html).toContain('display: table-header-group');
	});

	it('несёт правило семантики и число строк', () => {
		expect(html).toContain('Срез на 31.12.2026.');
		expect(html).toContain('Строк в отчёте');
	});

	it('обезвреживает разметку в значении ячейки', () => {
		const dangerous = reportHtml(
			sampleReportView({
				rows: [
					{
						rowKey: '44444444-4444-4444-8444-444444444444',
						interactionId: '44444444-4444-4444-8444-444444444444',
						stageEntryId: null,
						cells: [
							{ kind: 'link', value: '<script>alert(1)</script>', url: null },
							{ kind: 'text', value: 'Вуз "А" & Б' },
							{ kind: 'list', values: [] },
							{ kind: 'number', value: null }
						],
						documents: [],
						learningGroups: []
					}
				]
			})
		);

		expect(dangerous).not.toContain('<script>alert(1)</script>');
		expect(dangerous).toContain('&lt;script&gt;');
		expect(dangerous).toContain('Вуз &quot;А&quot; &amp; Б');
	});

	it('на пустой выборке объясняет пустоту словами', () => {
		expect(reportHtml(sampleReportView({ rows: [] }))).toContain('не попало ни одной строки');
	});

	it('печатает первые N строк и говорит, сколько их всего', () => {
		const total = REPORT_PDF_ROWS + 100;
		const many = sampleReportView({
			rows: Array.from({ length: total }, (_, index) => ({
				...VIEW.rows[0],
				rowKey: `row-${index}`,
				interactionId: `row-${index}`
			})),
			totals: { rowCount: total, interactionCount: total, paused: 0, overdue: 0 }
		});

		const html = reportHtml(many);

		// Строк в таблице ровно столько, сколько сводка обещает показать: одна
		// строка шапки плюс `REPORT_PDF_ROWS` строк тела.
		expect(html.split('</tr>').length - 1).toBe(REPORT_PDF_ROWS + 1);
		expect(html).toContain(`Показаны первые ${REPORT_PDF_ROWS} строк из ${total}`);
		expect(html).toContain('XLSX');
	});

	it('на выборке меньше потолка о сокращении не пишет', () => {
		expect(reportHtml(VIEW)).not.toContain('Показаны первые');
	});

	it('печатает числа обеих диаграмм таблицами, а не отсылает к экрану', () => {
		const snapshot = reportHtml(VIEW);

		expect(snapshot).toContain('Стадия на дату среза');
		expect(snapshot).toContain('Закрыто за период');

		const movement = reportHtml(
			sampleReportView({
				meta: { ...VIEW.meta, mode: 'movement' },
				charts: {
					funnel: null,
					movement: {
						step: 'week',
						buckets: [{ key: '2026-10-01', label: '01.10', from: '2026-10-01', to: '2026-10-07' }],
						series: [{ key: 'forward', label: 'Вперёд', values: [2] }],
						migrated: 3,
						note: 'Недели по московскому календарю.'
					},
					breakdowns: []
				}
			})
		);

		expect(movement).toContain('Динамика переходов');
		expect(movement).toContain('Вперёд');
		expect(movement).toContain('Перенос при изменении процесса: 3');
	});
});

describe('каждый файл называет свою сборку', () => {
	// Идентификатор и момент сборки читаются из самого файла, а не из объекта:
	// проверяется то, что увидит получивший файл.
	const { reportId } = VIEW.meta;
	const generated = '17.09.2026';

	function workbookText(body: Buffer): string {
		const workbook = XLSX.read(body, { type: 'buffer' });

		return XLSX.utils
			.sheet_to_json<string[]>(workbook.Sheets['Фильтры'], { header: 1, raw: false, defval: '' })
			.map((row) => row.join(' | '))
			.join('\n');
	}

	it.each([
		['xlsx', writeXlsx],
		['xls', writeXls]
	] as const)('%s: идентификатор, момент сборки и период на листе фильтров', (_, write) => {
		const text = workbookText(write(reportSheets(VIEW)));

		expect(text).toContain(`Идентификатор отчёта | ${reportId}`);
		expect(text).toMatch(new RegExp(`Отчёт собран \\| ${generated.replaceAll('.', '\\.')}`));
		expect(text).toContain('Период | 01.10.2026 — 31.12.2026');
	});

	it('pdf: в шапке и в подвале каждой страницы', () => {
		const html = reportHtml(VIEW);

		expect(html).toContain(`<dt>Идентификатор отчёта</dt><dd>${reportId}</dd>`);
		expect(html).toMatch(/<dt>Отчёт собран<\/dt><dd>17\.09\.2026/);
		expect(html).toContain('<dt>Период</dt><dd>01.10.2026 — 31.12.2026</dd>');
		expect(reportFooterHtml(reportId)).toContain(reportId);
	});

	it('json: идентификатор, момент сборки, срез, период и фильтры', () => {
		const payload = JSON.parse(reportJson(VIEW).toString('utf8')) as Record<string, unknown>;

		expect(payload.reportId).toBe(reportId);
		expect(payload.generatedAt).toBe(VIEW.meta.generatedAt);
		expect(payload.asOf).toBe(VIEW.meta.asOf);
		expect(payload.period).toStrictEqual(VIEW.meta.period);
		expect(payload.filters).toStrictEqual(VIEW.meta.filters);
	});
});

describe('имя файла', () => {
	it('в срезе называет дату среза и день сборки', () => {
		expect(reportFileName(VIEW, 'xlsx', '2026-09-17')).toBe(
			'Отчёт по взаимодействиям — срез на 31.12.2026 (собран 17.09.2026).xlsx'
		);
	});

	it('в движении называет весь период', () => {
		const movement = sampleReportView({
			meta: { ...VIEW.meta, mode: 'movement' }
		});

		expect(reportFileName(movement, 'json', '2026-09-17')).toBe(
			'Отчёт по взаимодействиям — движение 01.10.2026 — 31.12.2026 (собран 17.09.2026).json'
		);
	});
});

describe('инварианты', () => {
	it('на согласованном отчёте претензий нет', () => {
		expect(checkReportInvariants(VIEW)).toStrictEqual([]);
	});

	it('И1 ловит расхождение суммы по стадиям с числом строк', () => {
		const broken = sampleReportView({
			charts: {
				...VIEW.charts,
				funnel: {
					...VIEW.charts.funnel!,
					workspaces: [
						{
							workspaceId: '88888888-8888-4888-8888-888888888888',
							workspaceKey: 'b2b',
							workspaceName: 'Работа с вузами',
							stages: [{ key: 'g:contact', label: 'Контакты', value: 5, filter: null }]
						}
					]
				}
			}
		});

		expect(checkReportInvariants(broken).map((issue) => issue.invariant)).toStrictEqual(['И1']);
	});

	it('И2 ловит взаимодействие, попавшее в срез дважды', () => {
		const duplicated = sampleReportView({ rows: [VIEW.rows[0], VIEW.rows[0]] });

		expect(checkReportInvariants(duplicated).map((issue) => issue.invariant)).toStrictEqual(['И2']);
	});

	it('И3 ловит расхождение суммы по видам событий с числом строк', () => {
		const movement = sampleReportView({
			charts: {
				funnel: null,
				movement: {
					step: 'week',
					buckets: [{ key: '2026-10-01', label: '01.10', from: '2026-10-01', to: '2026-10-07' }],
					series: [{ key: 'forward', label: 'Вперёд', values: [9] }],
					migrated: 0,
					note: ''
				},
				breakdowns: []
			}
		});

		expect(checkReportInvariants(movement).map((issue) => issue.invariant)).toStrictEqual(['И3']);
	});

	it('И5 ловит файл, в котором строк меньше, чем на экране', () => {
		expect(checkExportInvariant(VIEW, { xlsx: 2, json: 1 })).toStrictEqual([
			{ invariant: 'И5', message: 'в файле json строк 1, ожидалось 2' }
		]);
	});

	it('И5 ждёт от PDF сводку: первые N строк, а не всю таблицу', () => {
		const total = REPORT_PDF_ROWS + 10;
		const many = sampleReportView({
			rows: Array.from({ length: total }, (_, index) => ({
				...VIEW.rows[0],
				rowKey: `row-${index}`,
				interactionId: `row-${index}`
			})),
			totals: { rowCount: total, interactionCount: total, paused: 0, overdue: 0 }
		});

		expect(checkExportInvariant(many, { pdf: REPORT_PDF_ROWS, xlsx: total })).toStrictEqual([]);
		expect(
			checkExportInvariant(many, { pdf: total }).map((issue) => issue.invariant)
		).toStrictEqual(['И5']);
	});
});
