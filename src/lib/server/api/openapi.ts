/**
 * Описание публичного API в формате OpenAPI 3.1.
 *
 * Документ собирается из тех же схем Zod, которыми эндпоинт проверяет запрос и
 * ответ: другого описания API не существует, поэтому документация не может
 * разойтись с поведением. Маршрут регистрируется в своём же файле, рядом с
 * обработчиком, а `GET /api/openapi.json` загружает файлы маршрутов и собирает
 * из накопленного документ.
 */
import {
	OpenAPIRegistry,
	OpenApiGeneratorV31,
	type RouteConfig
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { apiErrorSchema } from '$lib/contracts/api';
import { getConfig } from '../config';
import type { ApiEndpointConfig } from './handler';

const registry = new OpenAPIRegistry();

const BEARER_SCHEME = 'bearerAuth';

registry.registerComponent('securitySchemes', BEARER_SCHEME, {
	type: 'http',
	scheme: 'bearer',
	description: 'Ключ доступа целиком, вместе с префиксом `lct_`.'
});

/**
 * Конверт ошибки объявлен один раз, а ответы на него ссылаются: иначе описание
 * каждой ошибки каждого маршрута повторяло бы его целиком.
 *
 * Схема переводится в JSON Schema средствами самого Zod, а не методом
 * `.openapi()` из `zod-to-openapi`: тот метод появляется в прототипе Zod только
 * после `extendZodWithOpenApi()` и работает лишь на схемах, созданных после
 * этого вызова, — а контракты создаются при загрузке своих модулей, задолго до
 * первого обращения к документации.
 */
const errorComponent = (() => {
	const { $schema: _draft, ...schema } = z.toJSONSchema(apiErrorSchema, {
		target: 'draft-2020-12',
		io: 'output'
	});

	return schema;
})();

/**
 * Тип компонента — объединение `SchemaObject` трёх версий OpenAPI из пакета
 * `openapi3-ts`, который лежит внутри зависимости и напрямую не подключается.
 * Поэтому он берётся у той же функции, которой передаётся.
 */
type SchemaComponent = Parameters<typeof registry.registerComponent<'schemas'>>[2];

registry.registerComponent('schemas', 'Error', errorComponent as SchemaComponent);

const ERROR_REF = { $ref: '#/components/schemas/Error' };

function errorResponse(description: string): RouteConfig['responses'][string] {
	return { description, content: { 'application/json': { schema: ERROR_REF } } };
}

export type RouteDefinition = {
	method: 'get' | 'post' | 'put' | 'patch' | 'delete';
	/** Путь в нотации OpenAPI и относительно `/api`: `/v1/organizations/{id}`. */
	path: string;
	summary: string;
	description?: string;
	tags?: string[];
	/** Тот же объект, что получает `apiHandler`. */
	config: ApiEndpointConfig;
};

/**
 * Уже зарегистрированные маршруты. Модуль маршрута может быть загружен дважды
 * (пересборка на лету в разработке), а документ от этого раздваиваться не
 * должен.
 */
const registered = new Set<string>();

export function registerRoute(definition: RouteDefinition): void {
	const identity = `${definition.method} ${definition.path}`;
	if (registered.has(identity)) {
		return;
	}
	registered.add(identity);

	const responses: RouteConfig['responses'] = {
		200: {
			description: 'Успешный ответ',
			content: { 'application/json': { schema: definition.config.output } }
		},
		400: errorResponse('Запрос не прошёл проверку; поля перечислены в `details.issues`'),
		401: errorResponse('Ключ доступа не предъявлен, недействителен или отозван'),
		403: errorResponse('Владельцу ключа не хватает права на это действие'),
		404: errorResponse('Записи нет или она вне области доступа владельца ключа'),
		429: errorResponse('Превышен лимит частоты; повторить через `Retry-After` секунд'),
		500: errorResponse('Внутренняя ошибка сервера')
	};

	if (definition.config.idempotent === true) {
		responses[409] = errorResponse('Запрос с этим ключом идемпотентности ещё выполняется');
		responses[422] = errorResponse('Ключ идемпотентности уже использован с другим телом запроса');
	}

	registry.registerPath({
		method: definition.method,
		path: definition.path,
		summary: definition.summary,
		description: definition.description,
		tags: definition.tags,
		security: [{ [BEARER_SCHEME]: [] }],
		request: {
			params: definition.config.params,
			query: definition.config.query,
			body:
				definition.config.body === undefined
					? undefined
					: {
							required: true,
							content: { 'application/json': { schema: definition.config.body } }
						}
		},
		responses
	});
}

const DESCRIPTION = `
Машинный интерфейс CRM взаимодействия с учебными заведениями.

Запрос подписывается ключом доступа: \`Authorization: Bearer lct_…\`. Ключ действует правами
выпустившего его пользователя; сессия браузера здесь не работает, а ключ в браузере не нужен.

Лимит частоты — 120 запросов в минуту на ключ и 600 на адрес; остаток сообщают заголовки
\`RateLimit-*\`. Изменяющие запросы принимают \`Idempotency-Key\`: повтор с тем же телом вернёт
тот же ответ, повтор с другим телом — 422.

Ошибка всегда приходит одним и тем же телом \`{ "error": { "code", "message", "requestId" } }\`;
\`requestId\` совпадает с заголовком \`x-request-id\` — с ним обращение находится в журнале.
`.trim();

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
	return new OpenApiGeneratorV31(registry.definitions).generateDocument({
		openapi: '3.1.0',
		info: {
			title: 'LCT CRM API',
			version: '1',
			description: DESCRIPTION
		},
		servers: [{ url: `${getConfig().ORIGIN}/api` }],
		security: [{ [BEARER_SCHEME]: [] }]
	});
}
