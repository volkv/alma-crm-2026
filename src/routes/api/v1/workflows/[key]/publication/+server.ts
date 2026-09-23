import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiPublicationSchema } from '$lib/contracts/api';
import { workflowKeySchema } from '$lib/contracts/interactions';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { publishProcess } from '$lib/server/stages/process';

const publishEndpoint = {
	auth: 'key',
	params: z.object({ key: workflowKeySchema }),
	output: apiPublicationSchema,
	permission: 'stages.configure',
	// Второй вызов после успешного первого ответил бы 404 «нет черновика», и
	// клиент не узнал бы, что публикация прошла и с какими числами.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'post',
	path: '/v1/workflows/{key}/publication',
	summary: 'Опубликовать черновик процесса',
	description:
		'Применяет черновик ко всем пространствам процесса — та же операция, что кнопка «Применить ' +
		'ко всем» в редакторе. Черновик проверяется целиком под блокировкой: замечания отвечают 400 ' +
		'со списком в `details.issues`, отсутствие черновика — 404. Незавершённые взаимодействия ' +
		'переезжают на новую структуру: к стадии с тем же ключом или по правилу переноса.\n\n' +
		'Тела нет. В ответе — фактические числа из транзакции публикации, они же уходят в журнал.',
	tags: ['Процесс'],
	config: publishEndpoint,
	example: {
		workflowId: 'e0f1a2b3-c4d5-4e6f-8a7b-8c9d0e1f2a3b',
		workflowKey: 'university',
		version: 3,
		reboundCount: 12,
		migratedCount: 2,
		archivedKeyCount: 1
	}
});

export const POST: RequestHandler = apiHandler(publishEndpoint, (ctx, { params }) =>
	publishProcess(ctx, params.key)
);
