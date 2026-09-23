import type { RequestHandler } from './$types';
import { apiReportSchema, toApiReport } from '$lib/contracts/api';
import { periodIssues, reportQuerySchema } from '$lib/contracts/reports';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { ValidationError } from '$lib/server/errors';
import { buildReport } from '$lib/server/reports/rows';

const reportEndpoint = {
	auth: 'key',
	query: reportQuerySchema,
	output: apiReportSchema,
	// Своего права у отчёта нет: он показывает ровно то, что владелец ключа и так
	// видит в списке взаимодействий, и сужается той же областью доступа.
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/reports',
	summary: 'Отчёт: срез или движение',
	description:
		'Тот же объект, который показывает экран отчётов и из которого собираются выгрузки XLSX, ' +
		'XLS, PDF и JSON: таблица со строками и ячейками в порядке `meta.columns`, итоги и ' +
		'диаграммы. Одна сборка на все форматы — числа интегратора и числа сотрудника сойтись ' +
		'обязаны.\n\n' +
		'`mode=snapshot` — срез на дату `to`: строка на взаимодействие, «где всё стоит». ' +
		'`mode=movement` — движение за период: строка на переход, «что произошло». Период ' +
		'обязателен: у машинного отчёта не бывает периода по умолчанию, иначе две одинаково ' +
		'названные выгрузки в разные дни считали бы разное.\n\n' +
		'Фильтры многозначны и складываются: `org`, `dir`, `prog`, `prod`, `owner`, `assignee`, ' +
		'`stage`, `state`, `transfer`, `party`, `group`, плюс флаги `overdue` и `paused`. ' +
		'`prod=a,b` и `prod=a&prod=b` — одно и то же; непонятное значение фильтром просто не ' +
		'становится. Слишком широкая выборка (больше 50 000 строк) отвечает 400 с подсказкой, ' +
		'чем её сузить.\n\n' +
		'`meta.scope` говорит словами, чья это область доступа: отчёты по двум разным ключам ' +
		'законно дают разные числа, и файл обязан об этом сообщать.\n\n' +
		'У каждой строки едут ключи связи: `documents` — вид, ключ в хранилище и `sha256` ' +
		'документов взаимодействия, `learningGroups` — группы в системе обучения и их последние ' +
		'результаты. По ним число из отчёта проверяется самим подтверждением, а персональных ' +
		'данных в них нет. Воронка среза разложена по группам процесса (`charts.funnel.groups`): ' +
		'одинаковые ключи стадий в B2B и B2C законны, и в общем списке две разные стадии слились ' +
		'бы в одну строку.',
	tags: ['Отчёты'],
	config: reportEndpoint,
	example: {
		meta: {
			schemaVersion: 1,
			reportId: '5b0f3c1e-8d2a-4e6f-9a7b-1c3d5e7f9a0b',
			generatedAt: '2026-09-18T09:00:00.000Z',
			asOf: '2026-09-18T20:59:59.999Z',
			mode: 'snapshot',
			period: { start: '2026-07-01', end: '2026-09-18' },
			filters: [{ label: 'Период', value: '01.07.2026 — 18.09.2026' }],
			scope: 'все взаимодействия',
			semantics: 'Срез на 18.09.2026.',
			columns: [
				{
					key: 'title',
					label: 'Взаимодействие',
					kind: 'link',
					sort: 'current',
					note: 'сейчас'
				}
			]
		},
		rows: [
			{
				rowKey: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
				interactionId: 'a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
				stageEntryId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
				cells: [
					{
						kind: 'link',
						value: 'Переговоры с СПбПУ',
						url: 'https://crm.example.org/interactions/a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
					}
				],
				documents: [
					{
						id: 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f',
						kind: 'agreement',
						storageKey: 'files/c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f',
						sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
					}
				],
				learningGroups: [
					{
						id: 'd5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f80',
						externalId: 'LMS-2026-114',
						resultId: null
					}
				]
			}
		],
		totals: { rowCount: 1, interactionCount: 1, paused: 0, overdue: 0 },
		charts: {
			funnel: {
				workspaces: [
					{
						workspaceId: '7c1e2f3a-4b5c-4d6e-8f70-1a2b3c4d5e6f',
						workspaceKey: 'b2b',
						workspaceName: 'Работа с вузами',
						stages: [
							{
								key: '7c1e2f3a-4b5c-4d6e-8f70-1a2b3c4d5e6f:document_exchange',
								label: 'Обмен пакетом документов',
								value: 1,
								filter: { param: 'stage', value: 'document_exchange' }
							}
						]
					}
				],
				closed: [],
				note: 'Распределение на дату, а не конверсия.'
			},
			movement: null,
			breakdowns: [
				{
					key: 'organizations',
					label: 'По вузам и контрагентам',
					points: [
						{
							key: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
							label: 'СПбПУ',
							value: 1,
							filter: { param: 'org', value: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10' }
						}
					],
					doubleCounted: 0
				}
			]
		}
	}
});

export const GET: RequestHandler = apiHandler(reportEndpoint, async (ctx, { query }) => {
	// Тот же разбор, что у экрана: период задом наперёд отчётом не является, и
	// молча подставленный вместо него квартал означал бы отчёт не за тот период.
	const issues = periodIssues(query);

	if (issues.length > 0) {
		throw new ValidationError('Отчёт по такому периоду не собрать', issues);
	}

	return toApiReport(await buildReport(ctx, query));
});
