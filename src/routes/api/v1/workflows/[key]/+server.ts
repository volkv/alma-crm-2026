import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiWorkflowDetailSchema, toApiWorkflowDetail } from '$lib/contracts/api';
import { workflowKeySchema } from '$lib/contracts/interactions';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getWorkflow } from '$lib/server/stages/process';

const workflowEndpoint = {
	auth: 'key',
	params: z.object({ key: workflowKeySchema }),
	output: apiWorkflowDetailSchema,
	permission: 'stages.configure'
} satisfies ApiEndpointConfig;

const stage = {
	id: 'c8d9e0f1-a2b3-4c4d-8e5f-6a7b8c9d0e1f',
	key: 'contact_search',
	name: 'Поиск контактных лиц',
	position: 1,
	category: 'contact',
	slaDays: 7,
	staleAfterDays: 5,
	requiresResult: false,
	requiresConfirmation: false,
	requiresLmsData: false,
	requiresDocumentMark: null,
	onEnterNotify: null,
	isFinal: false,
	checklist: []
};

registerRoute({
	method: 'get',
	path: '/v1/workflows/{key}',
	summary: 'Процесс с черновиком',
	description:
		'Процесс целиком, как его видит настройщик: действующая редакция, черновик изменений, ' +
		'пространства, чью работу изменит публикация, и замечания, которые мешают применить ' +
		'черновик. Пустой `issues` при непустом `draft` — черновик можно публиковать ' +
		'(`POST /v1/workflows/{key}/publication`).\n\n' +
		'Внешней системе, которая ведёт взаимодействия, нужен не этот адрес, а ' +
		'`GET /v1/workspaces/{key}`: там только опубликованный маршрут.',
	tags: ['Процесс'],
	config: workflowEndpoint,
	example: {
		workflow: {
			id: 'e0f1a2b3-c4d5-4e6f-8a7b-8c9d0e1f2a3b',
			key: 'university',
			name: 'Работа с вузом',
			description: 'Путь от поиска контакта до отчёта по обучению',
			stageCount: 7,
			workspaces: 1,
			activeInteractions: 12,
			hasDraft: true
		},
		workspaces: [{ key: 'b2b', name: 'Работа с ВУЗ' }],
		active: {
			version: 2,
			name: 'Работа с вузом',
			note: null,
			publishedAt: '2026-09-01T06:00:00.000Z',
			stages: [stage],
			transitions: []
		},
		draft: {
			version: 3,
			name: 'Работа с вузом',
			note: 'Срок поиска контакта сокращён',
			publishedAt: null,
			stages: [{ ...stage, id: 'f1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c', slaDays: 5 }],
			transitions: []
		},
		issues: []
	}
});

export const GET: RequestHandler = apiHandler(workflowEndpoint, async (ctx, { params }) =>
	toApiWorkflowDetail(await getWorkflow(ctx, params.key))
);
