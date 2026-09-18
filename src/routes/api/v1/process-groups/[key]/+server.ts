import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiProcessSchema, toApiProcess } from '$lib/contracts/api';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getProcessGroup } from '$lib/server/stages/process';

const processEndpoint = {
	auth: 'key',
	// Ключ, а не идентификатор: адрес группы читают люди, и в сообщениях обмена
	// стоит он же.
	params: z.object({
		key: z
			.string()
			.min(1, { error: 'Укажите ключ группы процесса' })
			.max(100, { error: 'Ключ группы процесса не длиннее 100 символов' })
	}),
	output: apiProcessSchema,
	permission: 'stages.configure'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/process-groups/{key}',
	summary: 'Действующий процесс группы',
	description:
		'Стадии действующей редакции с ключами, сроками и требованиями — результат, подтверждение, ' +
		'данные обучения, чек-лист — и разрешённые переходы между ними. Идентификатор стадии здесь ' +
		'тот самый, который принимает `POST /v1/interactions/{id}/transitions`; ключ стадии, в ' +
		'отличие от него, переживает изменение процесса.\n\n' +
		'Черновик и его замечания в ответ не входят: внешняя система работает по опубликованному ' +
		'маршруту, а незавершённая настройка — дело сотрудника.',
	tags: ['Процесс'],
	config: processEndpoint,
	example: {
		group: {
			id: 'b7c8d9e0-f1a2-4b3c-8d4e-5f6a7b8c9d0e',
			key: 'b2b',
			name: 'Учебные заведения',
			description: 'Работа с вузами и колледжами',
			position: 1,
			stageCount: 2,
			activeInteractions: 12,
			hasDraft: false
		},
		counterpartyKinds: ['educational_institution'],
		revision: {
			version: 2,
			name: 'Процесс работы с учебными заведениями',
			note: null,
			publishedAt: '2026-09-01T06:00:00.000Z',
			stages: [
				{
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
					isFinal: false,
					checklist: []
				},
				{
					id: 'd9e0f1a2-b3c4-4d5e-8f6a-7b8c9d0e1f20',
					key: 'communication',
					name: 'Коммуникация и сверка программ',
					position: 2,
					category: 'contact',
					slaDays: 10,
					staleAfterDays: 7,
					requiresResult: true,
					requiresConfirmation: false,
					requiresLmsData: false,
					isFinal: false,
					checklist: [
						{ key: 'brief', label: 'Отправлено коммерческое предложение', required: true }
					]
				}
			],
			transitions: [
				{
					fromStageId: 'c8d9e0f1-a2b3-4c4d-8e5f-6a7b8c9d0e1f',
					toStageId: 'd9e0f1a2-b3c4-4d5e-8f6a-7b8c9d0e1f20',
					kind: 'forward',
					requiredPermissionKey: 'stages.transition',
					requiresReason: false
				}
			]
		}
	}
});

export const GET: RequestHandler = apiHandler(processEndpoint, async (ctx, { params }) =>
	toApiProcess(await getProcessGroup(ctx, params.key))
);
