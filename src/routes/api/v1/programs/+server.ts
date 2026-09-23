import type { RequestHandler } from './$types';
import { apiPageSchema, apiProgramSchema } from '$lib/contracts/api';
import { catalogListQuerySchema, createProgramSchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { listPrograms } from '$lib/server/directory/read';
import { createProgram } from '$lib/server/directory/write';

const listProgramsEndpoint = {
	auth: 'key',
	query: catalogListQuerySchema,
	output: apiPageSchema(apiProgramSchema),
	permission: 'programs.read'
} satisfies ApiEndpointConfig;

const createProgramEndpoint = {
	auth: 'key',
	body: createProgramSchema,
	output: apiProgramSchema,
	permission: 'programs.write',
	// Код программы уникален, но повтор после разрыва связи должен вернуть
	// созданную запись, а не конфликт по собственному же коду.
	idempotent: true
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/programs',
	summary: 'Список образовательных программ',
	description:
		'Страница каталога программ с фильтром по состоянию и поиском по названию и коду. ' +
		'Областью доступа владельца ключа список не сужается: программа — общий каталог оператора, ' +
		'а не имущество отдельного вуза.',
	tags: ['Справочники'],
	config: listProgramsEndpoint,
	example: {
		items: [
			{
				id: '5c1a8f3e-1b2c-4d5e-8f90-1a2b3c4d5e6f',
				code: 'PRG-09.03.01',
				name: 'Информатика и вычислительная техника',
				level: 'bachelor',
				directionCode: '09.03.01',
				priority: 1,
				status: 'active'
			}
		],
		total: 1,
		page: 1,
		pageSize: 20
	}
});

registerRoute({
	method: 'post',
	path: '/v1/programs',
	summary: 'Завести образовательную программу',
	description:
		'Программа попадает в общий каталог оператора. Код уникален: занятый отвечает 409. ' +
		'Без явного `status` программа заводится черновиком (`draft`).',
	tags: ['Справочники'],
	config: createProgramEndpoint,
	bodyExample: {
		code: 'PRG-09.03.01',
		name: 'Информатика и вычислительная техника',
		level: 'bachelor',
		directionCode: '09.03.01',
		priority: 1,
		status: 'active'
	},
	example: {
		id: '5c1a8f3e-1b2c-4d5e-8f90-1a2b3c4d5e6f',
		code: 'PRG-09.03.01',
		name: 'Информатика и вычислительная техника',
		level: 'bachelor',
		directionCode: '09.03.01',
		priority: 1,
		status: 'active'
	}
});

export const GET: RequestHandler = apiHandler(listProgramsEndpoint, (ctx, { query }) =>
	listPrograms(ctx, query)
);

export const POST: RequestHandler = apiHandler(createProgramEndpoint, (ctx, { body }) =>
	createProgram(ctx, body)
);
