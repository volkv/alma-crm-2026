/**
 * Swagger UI, собранный из локальных файлов.
 *
 * Ни одного обращения наружу: файлы интерфейса едут из пакета
 * `swagger-ui-dist`, который и так лежит в образе. Страница документации,
 * которая тянет скрипты с чужого CDN, — это чужой код, исполняемый в сессии
 * администратора, и заодно неработающая документация в закрытом контуре.
 *
 * Список файлов закрыт: путь из запроса ищется в нём, а не склеивается с
 * каталогом, поэтому выйти за пределы пакета нечем.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const requireFromHere = createRequire(import.meta.url);

let packageDirectory: string | undefined;

function swaggerUiDirectory(): string {
	packageDirectory ??= (requireFromHere('swagger-ui-dist/absolute-path.js') as () => string)();
	return packageDirectory;
}

/** Файлы Swagger UI, которые нужны странице, и с каким типом их отдавать. */
const BUNDLED_ASSETS = new Map<string, string>([
	['swagger-ui.css', 'text/css; charset=utf-8'],
	['swagger-ui-bundle.js', 'text/javascript; charset=utf-8'],
	['favicon-32x32.png', 'image/png'],
	['favicon-16x16.png', 'image/png']
]);

/**
 * Запуск интерфейса вынесен в отдельный файл, а не в тег на странице: со
 * встроенным скриптом странице потребовалось бы `unsafe-inline` в политике
 * безопасности, то есть ровно то послабление, которое эту политику и отменяет.
 */
const INITIALIZER = `window.ui = SwaggerUIBundle({
	url: '/api/openapi.json',
	dom_id: '#swagger-ui',
	deepLinking: true,
	layout: 'BaseLayout',
	presets: [SwaggerUIBundle.presets.apis],
	tryItOutEnabled: true,
	persistAuthorization: false
});
`;

const INITIALIZER_NAME = 'initializer.js';

export const DOCS_PAGE = `<!doctype html>
<html lang="ru">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex, nofollow" />
		<title>Альма CRM API</title>
		<link rel="icon" type="image/png" sizes="32x32" href="/api/docs/favicon-32x32.png" />
		<link rel="stylesheet" href="/api/docs/swagger-ui.css" />
	</head>
	<body>
		<div id="swagger-ui"></div>
		<script src="/api/docs/swagger-ui-bundle.js"></script>
		<script src="/api/docs/${INITIALIZER_NAME}"></script>
	</body>
</html>
`;

/**
 * Политика для страницы документации. Собственный заголовок нужен потому, что
 * ответ отдаёт эндпоинт, а не отрисовка страницы, и политику от SvelteKit он не
 * получает. `unsafe-inline` для стилей — требование самого Swagger UI, который
 * расставляет стили на элементах; для скриптов такого послабления нет.
 */
const DOCS_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self'",
	"connect-src 'self'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'"
].join('; ');

/** Заголовки, общие для страницы документации и её файлов. */
export function docsHeaders(contentType: string): Headers {
	return new Headers({
		'content-type': contentType,
		'content-security-policy': DOCS_CSP,
		// Документация доступна только вошедшему пользователю, значит, это не
		// материал для общих кэшей.
		'cache-control': 'no-store'
	});
}

const cache = new Map<string, Uint8Array<ArrayBuffer>>();

export type DocsAsset = { body: Uint8Array<ArrayBuffer> | string; contentType: string };

/** Файл интерфейса по имени, или `null`, если такого файла мы не отдаём. */
export async function readDocsAsset(name: string): Promise<DocsAsset | null> {
	if (name === INITIALIZER_NAME) {
		return { body: INITIALIZER, contentType: 'text/javascript; charset=utf-8' };
	}

	const contentType = BUNDLED_ASSETS.get(name);
	if (contentType === undefined) {
		return null;
	}

	const cached = cache.get(name);
	if (cached !== undefined) {
		return { body: cached, contentType };
	}

	// Копия в обычный `Uint8Array`: `Buffer` из Node описан над `ArrayBufferLike`,
	// а телу ответа нужен именно `ArrayBuffer`. Чтение и копия делаются один раз.
	const body = new Uint8Array(await readFile(join(swaggerUiDirectory(), name)));
	cache.set(name, body);

	return { body, contentType };
}

/**
 * Ответ на запрос файла интерфейса от того, кто не вошёл в систему. Именно
 * ответ, а не перенаправление на вход: за файлом идёт тег `<script>`, и страница
 * входа в ответ на него — это невнятная ошибка вместо внятной.
 *
 * Документация описывает внутренний процесс, а не только формат запросов,
 * поэтому она за той же дверью, что и само приложение.
 */
export function docsUnauthorized(): Response {
	return new Response('Документация API доступна пользователям, вошедшим в систему.\n', {
		status: 401,
		headers: docsHeaders('text/plain; charset=utf-8')
	});
}
