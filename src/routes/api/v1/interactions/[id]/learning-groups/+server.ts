import { z } from 'zod';
import type { RequestHandler } from './$types';
import {
	apiCollectionSchema,
	apiLearningGroupSchema,
	toApiLearningGroup
} from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { assertInteractionAccessible } from '$lib/server/documents/read';
import { listLearningGroups } from '$lib/server/integrations/exchange/groups';

const learningGroupsEndpoint = {
	auth: 'key',
	params: z.object({ id: id('Некорректный идентификатор взаимодействия') }),
	output: apiCollectionSchema(apiLearningGroupSchema),
	permission: 'interactions.read'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/interactions/{id}/learning-groups',
	summary: 'Учебные группы взаимодействия',
	description:
		'Потоки, заявленные в систему обучения, вместе с состоянием заявки в журнале обмена и ' +
		'последним пришедшим результатом: сколько зачислено, завершило и отчислено. Страницами ' +
		'список не режется — потоков у взаимодействия единицы.\n\n' +
		'Подать сюда результат нельзя: его принимает `POST /v1/exchange/learning-groups/results` и ' +
		'только ключом системы обучения.',
	tags: ['Обучение'],
	config: learningGroupsEndpoint,
	example: {
		items: [
			{
				id: 'f5a6b7c8-d9e0-4f1a-9b2c-3d4e5f6a7b8c',
				streamNumber: 1,
				system: 'lms',
				instance: 'moodle-prod',
				groupExternalId: 'LMS-2026-000412',
				requestedAt: '2026-09-10T07:00:00.000Z',
				plannedSeats: 30,
				startsOn: '2026-10-01',
				endsOn: '2026-12-20',
				lastResultAt: '2026-12-21T06:00:00.000Z',
				messageState: 'sent',
				lastError: null,
				enrolled: 28,
				completed: 25,
				expelled: 3
			}
		],
		total: 1
	}
});

export const GET: RequestHandler = apiHandler(learningGroupsEndpoint, async (ctx, { params }) => {
	// Область доступа применяет и сама выборка групп, но чужая запись отвечала бы
	// пустым списком: «групп нет» не должно быть неотличимо от «записи нет».
	await assertInteractionAccessible(ctx, params.id);

	const groups = await listLearningGroups(ctx, params.id);

	return { items: groups.map(toApiLearningGroup), total: groups.length };
});
