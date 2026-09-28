import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiProgramDetailSchema, apiProgramSchema, toApiProgramDetail } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { createProgramSchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getProgram } from '$lib/server/directory/read';
import { updateProgram } from '$lib/server/directory/write';

const params = z.object({ id: id('Некорректный идентификатор программы') });

const getProgramEndpoint = {
	auth: 'key',
	params,
	output: apiProgramDetailSchema,
	permission: 'programs.read'
} satisfies ApiEndpointConfig;

const updateProgramEndpoint = {
	auth: 'key',
	params,
	body: createProgramSchema,
	output: apiProgramSchema,
	permission: 'programs.write'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/programs/{id}',
	summary: 'Образовательная программа',
	description:
		'Карточка программы вместе с историей версий: что в ней менялось и с какого дня версия ' +
		'действует. Каталог общий, областью доступа владельца ключа не сужается.',
	tags: ['Справочники'],
	config: getProgramEndpoint,
	example: {
		id: '5c1a8f3e-1b2c-4d5e-8f90-1a2b3c4d5e6f',
		code: 'PRG-09.03.01',
		name: 'Информатика и вычислительная техника',
		level: 'bachelor',
		directionCode: '09.03.01',
		description: 'Разработка программного обеспечения и вычислительных систем.',
		priority: 1,
		status: 'active',
		versions: [
			{
				id: '8e9f0a1b-2c3d-4e5f-8a6b-7c8d9e0f1a2b',
				version: 2,
				summary: 'Добавлен модуль по контейнерной оркестрации',
				effectiveFrom: '2026-09-01',
				createdAt: '2026-08-20T09:00:00.000Z'
			}
		]
	}
});

registerRoute({
	method: 'put',
	path: '/v1/programs/{id}',
	summary: 'Изменить образовательную программу',
	description:
		'Карточка заменяется целиком — тело то же, что при заведении; не переданные необязательные ' +
		'поля становятся пустыми, а `status` — `draft`. Поэтому тело собирают из текущей карточки. ' +
		'Занятый код отвечает 409.',
	tags: ['Справочники'],
	config: updateProgramEndpoint,
	bodyExample: {
		code: 'PRG-09.03.01',
		name: 'Информатика и вычислительная техника',
		level: 'bachelor',
		directionCode: '09.03.01',
		description: 'Разработка программного обеспечения и вычислительных систем.',
		priority: 1,
		status: 'active'
	},
	example: {
		id: '5c1a8f3e-1b2c-4d5e-8f90-1a2b3c4d5e6f',
		code: 'PRG-09.03.01',
		name: 'Информатика и вычислительная техника',
		level: 'bachelor',
		directionCode: '09.03.01',
		description: 'Разработка программного обеспечения и вычислительных систем.',
		priority: 1,
		status: 'active'
	}
});

export const GET: RequestHandler = apiHandler(getProgramEndpoint, async (ctx, { params }) =>
	toApiProgramDetail(await getProgram(ctx, params.id))
);

export const PUT: RequestHandler = apiHandler(updateProgramEndpoint, (ctx, { params, body }) =>
	updateProgram(ctx, { ...body, id: params.id })
);
