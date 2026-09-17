/**
 * Готовый объект отчёта для проверок, которым база не нужна: писателей,
 * инвариантов и подписей. Числа здесь вымышленные и маленькие — важна форма,
 * а не правдоподобие.
 */
import type { ReportView } from '$lib/contracts/reports';

export function sampleReportView(overrides: Partial<ReportView> = {}): ReportView {
	const view: ReportView = {
		meta: {
			schemaVersion: 1,
			generatedAt: '2026-09-17T09:00:00.000Z',
			asOf: '2026-12-31T21:00:00.000Z',
			mode: 'snapshot',
			period: { start: '2026-10-01', end: '2026-12-31' },
			filters: [
				{ label: 'Режим', value: 'Срез' },
				{ label: 'Период', value: '01.10.2026 — 31.12.2026' }
			],
			scope: 'все взаимодействия',
			semantics: 'Срез на 31.12.2026.',
			columns: [
				{
					key: 'interaction',
					label: 'Взаимодействие',
					kind: 'link',
					sort: 'current',
					note: 'сейчас'
				},
				{
					key: 'organization',
					label: 'Вуз или контрагент',
					kind: 'text',
					sort: 'current',
					note: 'сейчас'
				},
				{ key: 'products', label: 'Продукты', kind: 'list', sort: 'current', note: 'сейчас' },
				{
					key: 'daysOnStage',
					label: 'Дней на стадии',
					kind: 'number',
					sort: 'historical',
					note: 'на 31.12.2026'
				}
			]
		},
		rows: [
			{
				interactionId: '11111111-1111-4111-8111-111111111111',
				stageEntryId: '22222222-2222-4222-8222-222222222222',
				cells: [
					{
						kind: 'link',
						value: 'Первое взаимодействие',
						url: 'http://localhost:5173/interactions/11111111-1111-4111-8111-111111111111'
					},
					{ kind: 'text', value: 'Вуз А' },
					{ kind: 'list', values: ['П-1', 'П-1б'] },
					{ kind: 'number', value: 12 }
				]
			},
			{
				interactionId: '33333333-3333-4333-8333-333333333333',
				stageEntryId: null,
				cells: [
					{
						kind: 'link',
						value: '=Опасное название',
						url: 'http://localhost:5173/interactions/33333333-3333-4333-8333-333333333333'
					},
					{ kind: 'text', value: 'Вуз Б' },
					{ kind: 'list', values: [] },
					{ kind: 'number', value: null }
				]
			}
		],
		totals: { rowCount: 2, interactionCount: 2, paused: 0, overdue: 1 },
		charts: {
			funnel: {
				stages: [
					{
						key: 'group:contact_search',
						label: 'Поиск контактных лиц',
						value: 1,
						filter: { param: 'stage', value: 'contact_search' }
					},
					{
						key: 'group:meeting',
						label: 'Встреча',
						value: 0,
						filter: { param: 'stage', value: 'meeting' }
					}
				],
				closed: [
					{ key: 'completed', label: 'Завершено', value: 1, filter: null },
					{ key: 'cancelled', label: 'Отменено', value: 0, filter: null }
				],
				note: 'Распределение на дату, не конверсия.'
			},
			movement: null,
			breakdowns: [
				{
					key: 'products',
					label: 'По продуктам',
					points: [
						{ key: 'p1', label: 'П-1', value: 1, filter: { param: 'prod', value: 'p1' } },
						{ key: 'p1b', label: 'П-1б', value: 1, filter: { param: 'prod', value: 'p1b' } }
					],
					doubleCounted: 1
				}
			]
		}
	};

	return { ...view, ...overrides };
}
