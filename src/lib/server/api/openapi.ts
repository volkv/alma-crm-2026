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
	/**
	 * Тип тела успешного ответа, когда это не JSON.
	 *
	 * Такой маршрут отдаёт файл (`GET /v1/exchange/files/{key}`), и схема ответа
	 * у него не описывает ничего: документации важно назвать тип и сказать, что
	 * это байты, а не объект. Схему `output` этот случай не читает вовсе.
	 */
	responseContentType?: string;
	/**
	 * Пример успешного ответа. Не украшение: по примеру интегратор понимает
	 * форму ответа быстрее, чем по дереву схемы, и он же проверяется схемой
	 * `output` в тестах — разойтись примеру с ответом негде.
	 */
	example?: unknown;
	/** Пример тела запроса; имеет смысл там, где тело есть. */
	bodyExample?: unknown;
};

/**
 * Схема запроса в том виде, в каком её понимает генератор документации.
 *
 * `catch` у поля фильтра — обычное дело: непонятное значение в адресе не ошибка
 * запроса, а просто не фильтр, и список обязан открыться, а не ответить отказом.
 * Генератор OpenAPI такого узла не знает и падает на нём, поэтому здесь он
 * снимается: в документ едет внутренняя схема, объявленная необязательной, —
 * именно так поле и ведёт себя на входе. Разбирает запрос при этом прежняя
 * схема: снятие идёт только ради описания и только для параметров пути и
 * строки запроса, где `catch` и встречается.
 *
 * Появись `catch` в схеме тела — документ перестанет собираться, и об этом
 * скажет проверка `tests/unit/api/routes.test.ts`, которая собирает его целиком.
 */
/**
 * Узел `catch` вместе с его внутренней схемой. Признак объявлен предикатом,
 * потому что `ZodCatch` из типов библиотеки отдаёт внутреннюю схему общим типом
 * ядра Zod: здесь же известно, что поля контрактов собраны обычным `z.*`.
 */
function isCatch(schema: z.ZodType): schema is z.ZodCatch<z.ZodType> {
	return schema instanceof z.ZodCatch;
}

function withoutCatch(schema: z.ZodType): z.ZodType {
	return isCatch(schema) ? withoutCatch(schema.unwrap()).optional() : schema;
}

function documented(schema: z.ZodObject | undefined): z.ZodObject | undefined {
	if (schema === undefined) {
		return undefined;
	}

	const shape: Record<string, z.ZodType> = {};
	let changed = false;

	for (const [name, field] of Object.entries(schema.shape)) {
		const unwrapped = withoutCatch(field);

		changed ||= unwrapped !== field;
		shape[name] = unwrapped;
	}

	return changed ? z.object(shape) : schema;
}

/**
 * Все зарегистрированные маршруты в порядке регистрации. Нужны проверке
 * контракта: у каждого маршрута обязаны быть описание, тег, право и пример,
 * сходящийся со схемой ответа, — и спросить об этом можно только весь список.
 */
const definitions: RouteDefinition[] = [];

export function registeredRoutes(): readonly RouteDefinition[] {
	return definitions;
}

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
	definitions.push(definition);

	const responses: RouteConfig['responses'] = {
		200:
			definition.responseContentType === undefined
				? {
						description: 'Успешный ответ',
						content: {
							'application/json': {
								schema: definition.config.output,
								...(definition.example === undefined ? {} : { example: definition.example })
							}
						}
					}
				: {
						description: 'Тело файла',
						content: {
							[definition.responseContentType]: { schema: { type: 'string', format: 'binary' } }
						}
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
		// Право читается из того же объекта, которым эндпоинт его требует:
		// расширение документа не может пообещать не то, что проверит обёртка.
		...(definition.config.permission === undefined
			? {}
			: { 'x-permission': definition.config.permission }),
		// Маршрут обмена: сюда допускается только ключ машинного субъекта, и
		// только выпущенный на названное подключение.
		...(definition.config.service === true
			? {
					'x-service-key': true,
					...(definition.config.exchangeSystem === undefined
						? {}
						: { 'x-exchange-system': definition.config.exchangeSystem })
				}
			: {}),
		request: {
			params: documented(definition.config.params),
			query: documented(definition.config.query),
			body:
				definition.config.body === undefined
					? undefined
					: {
							required: true,
							content: {
								'application/json': {
									schema: definition.config.body,
									...(definition.bodyExample === undefined
										? {}
										: { example: definition.bodyExample })
								}
							}
						}
		},
		responses
	});
}

/**
 * Граница API словами. Она стоит первой в документации не ради вежливости:
 * интегратор должен узнать, чего здесь нет, раньше, чем начнёт искать это в
 * списке маршрутов.
 */
const DESCRIPTION = `
Интеграционный API CRM взаимодействия с учебными заведениями.

**Что это.** Машинный интерфейс для трёх задач: обмен с сайтом (CMS) и системой обучения (LMS);
чтение данных внешними системами — выгрузками, отчётными роботами, витринами заказчика; ведение
справочников и настройки работы — организации, контакты, программы, продукты, ответственные,
процессы. За ним стоят те же сервисы, что и за экранами приложения: права, область доступа и
проверки у ключа и у формы одни и те же, и отчёт по ключу и отчёт на экране считает один и тот же
код.

**Чем подписан запрос.** Ключом доступа, выпущенным на учётную запись системы:
\`Authorization: Bearer lct_…\`.
Ключ действует правами и областью доступа того, на кого он выпущен: у машины не может быть прав
больше, чем у человека, от имени которого она ходит, а записи вне его области для неё не
существуют — такие отдаются как \`404\`, а не \`403\`. Сессия браузера здесь не работает вовсе.
Ключи обмена CMS и LMS выпускаются на машинного субъекта и допускаются только к маршрутам с тегом
«Обмен» — и каждый только к своему направлению.

**Персональные данные.** Почта и телефон людей открыты только при праве \`people.read_pii\`
владельца ключа, иначе замаскированы (\`contactsMasked: true\`); каждая выдача контактов оставляет
след просмотра в журнале действий.

**Что в API не входит.** Управление пользователями, ролями, составом пространств и ключами
доступа; согласия, сроки хранения и обезличивание; редактирование стадий процесса (публикуется
черновик, собранный в редакторе); настройки приложения и подключений обмена; содержимое документов
(отдаются только метаданные). Это работа сотрудника в интерфейсе, и следы в журнале у неё другие.

**Идемпотентность.** Изменяющие запросы принимают \`Idempotency-Key\`: повтор с тем же телом
вернёт сохранённый ответ и заголовок \`Idempotency-Replay: true\`, повтор с другим телом —
\`422\`. Ответ помнится сутки.

**Лимиты частоты.** 120 запросов в минуту на ключ и 600 в минуту на адрес; остаток сообщают
заголовки \`RateLimit-*\`, отказ — \`429\` и \`Retry-After\` в секундах.

**Версия схемы.** Первая: путь каждого маршрута начинается с \`/v1\`. Внутри версии поля
добавляются, но не переименовываются и не меняют смысл; несовместимое изменение — это \`/v2\`.
У отчёта есть собственный номер схемы — \`meta.schemaVersion\`.

**Ошибки.** Любой неуспех приходит одним телом
\`{ "error": { "code", "message", "requestId" } }\`, где \`requestId\` совпадает с заголовком
\`x-request-id\`: по нему обращение находится в журнале действий одной строкой.
`.trim();

/**
 * Разделы документации. Обмен с внешними системами отделён от чтения намеренно:
 * это разные ключи и разные права, и видеть это интегратор должен в оглавлении,
 * а не выяснять по отказам.
 */
const TAGS = [
	{
		name: 'Организации',
		description: 'Вузы и другие контрагенты: карточки справочника и работа по ним.'
	},
	{
		name: 'Контакты',
		description:
			'Люди и их роли в организациях. Почта и телефон открыты только при праве ' +
			'`people.read_pii`; выдача контактов пишется в журнал действий.'
	},
	{
		name: 'Взаимодействия',
		description: 'Работа по вузу: карточка, история стадий и изменений, комментарии, переходы.'
	},
	{
		name: 'Справочники',
		description:
			'Общие каталоги оператора: программы, продукты, направления. Областью доступа не сужаются — ' +
			'это каталог, а не имущество отдельного вуза.'
	},
	{
		name: 'Документы',
		description: 'Метаданные файлов взаимодействия. Содержимое через API не отдаётся.'
	},
	{
		name: 'Обучение',
		description:
			'Учебные группы взаимодействия и последние результаты, пришедшие из системы обучения.'
	},
	{
		name: 'Процесс',
		description:
			'Пространства и их состав, процессы и действующий маршрут стадий: ключи, сроки, ' +
			'разрешённые переходы; публикация черновика процесса.'
	},
	{
		name: 'Отчёты',
		description: 'Срез и движение — тот же объект, что на экране отчётов и в выгрузках.'
	},
	{
		name: 'Журнал обмена',
		description: 'Хроника сообщений CMS и LMS: что ушло, что пришло, что не дошло и почему.'
	},
	{
		name: 'Обмен',
		description:
			'Приём данных от внешних систем. Только ключ машинного субъекта и только выпущенный на это ' +
			'подключение: ключ сайта не подаёт результаты учебных групп, ключ системы обучения — заявки.'
	}
];

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
	return new OpenApiGeneratorV31(registry.definitions).generateDocument({
		openapi: '3.1.0',
		info: {
			title: 'Альма CRM API',
			version: '1',
			description: DESCRIPTION
		},
		servers: [{ url: `${getConfig().ORIGIN}/api` }],
		tags: TAGS,
		security: [{ [BEARER_SCHEME]: [] }]
	});
}
