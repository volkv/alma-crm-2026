import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiProductDetailSchema, apiProductSchema, toApiProductDetail } from '$lib/contracts/api';
import { id } from '$lib/contracts/common';
import { createProductSchema } from '$lib/contracts/directory';
import { apiHandler, type ApiEndpointConfig } from '$lib/server/api/handler';
import { registerRoute } from '$lib/server/api/openapi';
import { getProduct } from '$lib/server/directory/read';
import { updateProduct } from '$lib/server/directory/write';

const params = z.object({ id: id('Некорректный идентификатор продукта') });

const getProductEndpoint = {
	auth: 'key',
	params,
	output: apiProductDetailSchema,
	permission: 'products.read'
} satisfies ApiEndpointConfig;

const updateProductEndpoint = {
	auth: 'key',
	params,
	body: createProductSchema,
	output: apiProductSchema,
	permission: 'products.write'
} satisfies ApiEndpointConfig;

registerRoute({
	method: 'get',
	path: '/v1/products/{id}',
	summary: 'Продукт',
	description:
		'Карточка продукта вместе с кратким наименованием вендора. Каталог общий, областью ' +
		'доступа владельца ключа не сужается.',
	tags: ['Справочники'],
	config: getProductEndpoint,
	example: {
		id: '7b2c9a41-3d4e-4f50-9a1b-2c3d4e5f6a7b',
		code: 'PRD-CLOUD',
		name: 'Облачная платформа',
		vendorOrganizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		description: 'Учебные стенды и лицензии для кафедры',
		status: 'active',
		vendorName: 'РТК ИТ'
	}
});

registerRoute({
	method: 'put',
	path: '/v1/products/{id}',
	summary: 'Изменить продукт',
	description:
		'Карточка заменяется целиком — тело то же, что при заведении; не переданные необязательные ' +
		'поля становятся пустыми, а `status` — `draft`. Поэтому тело собирают из текущей карточки. ' +
		'Вендор проверяется так же, как при заведении; занятый код отвечает 409.',
	tags: ['Справочники'],
	config: updateProductEndpoint,
	bodyExample: {
		code: 'PRD-CLOUD',
		name: 'Облачная платформа',
		vendorOrganizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		description: 'Учебные стенды и лицензии для кафедры',
		status: 'active'
	},
	example: {
		id: '7b2c9a41-3d4e-4f50-9a1b-2c3d4e5f6a7b',
		code: 'PRD-CLOUD',
		name: 'Облачная платформа',
		vendorOrganizationId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
		description: 'Учебные стенды и лицензии для кафедры',
		status: 'active'
	}
});

export const GET: RequestHandler = apiHandler(getProductEndpoint, async (ctx, { params }) =>
	toApiProductDetail(await getProduct(ctx, params.id))
);

export const PUT: RequestHandler = apiHandler(updateProductEndpoint, (ctx, { params, body }) =>
	updateProduct(ctx, { ...body, id: params.id })
);
