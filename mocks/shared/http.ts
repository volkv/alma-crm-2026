/**
 * Каркас имитатора: разбор запроса, маршрутизация, сценарий отказов.
 *
 * Обычный `node:http` без фреймворка — имитатор обязан оставаться тем, чем он
 * назван в контракте: двумя файлами на стандартной библиотеке, которые
 * поднимаются и в контейнере, и прямо в процессе теста (`listen(0)`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Journal } from './journal.ts';
import type { Scenario } from './scenario.ts';
import { escapeHtml } from './state-page.ts';

/**
 * Предел тела одного сообщения — 1 МиБ, как в контракте обмена (раздел 2).
 * Больше — `413`, и запрос не дочитывается: смысл предела в том, чтобы не
 * читать, а не в том, чтобы прочитать и пожаловаться.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

export type MockRequest = {
	method: string;
	url: URL;
	/** Путь без строки запроса. */
	path: string;
	/** Заголовки в нижнем регистре. */
	headers: Record<string, string>;
	/** Тело как есть: подпись считается от тех же байт, что пришли. */
	rawBody: string;
	/** Переменные сегменты пути: `/api/groups/{id}` → `{ id: '2481' }`. */
	params: Record<string, string>;
};

export type MockReply = {
	status: number;
	json?: unknown;
	html?: string;
	headers?: Record<string, string>;
};

export type MockRoute = {
	method: 'GET' | 'POST';
	/** Шаблон пути; `{имя}` — переменный сегмент. */
	path: string;
	/**
	 * Эндпоинт контракта — тот, которым пользуется CRM. Сценарий отказов
	 * действует только на такие: управление имитатором обязано отвечать и
	 * тогда, когда сценарий велел «отвечать 503», иначе его нечем снять.
	 */
	contract: boolean;
	handle: (request: MockRequest) => MockReply | Promise<MockReply>;
};

export type MockService = {
	name: string;
	port: number;
	/** Адрес, по которому сервис отвечает: `http://127.0.0.1:<порт>`. */
	url: string;
	stop: () => Promise<void>;
};

/** Отказ имитатора: свой конверт, а не конверт ошибки API — это чужая система. */
export function problem(status: number, code: string, message: string): MockReply {
	return { status, json: { code, message } };
}

/**
 * Куда вернуть браузер после нажатия кнопки на странице состояния: на неё же.
 *
 * Адрес относительный намеренно: на стенде имитатор живёт под префиксом пути
 * (`/mock-cms/`), и `/` увёл бы посетителя на главную страницу стенда.
 */
export function backToStatePage(): MockReply {
	return { status: 303, headers: { location: './' } };
}

/**
 * Отказ триггера, нажатого кнопкой со страницы состояния: страница со ссылкой
 * назад, а не JSON. Нажавший смотрит в браузер, и конверт ошибки на весь экран
 * ему ничего не скажет. Код ответа тот же, что у запроса из проверки.
 */
export function formProblem(status: number, message: string): MockReply {
	return {
		status,
		html: `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Ошибка: заявка не отправлена</title></head>
<body>
<h1>Ошибка: не отправлено</h1>
<p>${escapeHtml(message)}</p>
<p><a href="./">Вернуться к странице имитатора</a></p>
</body>
</html>
`
	};
}

/** Разобранное тело триггера: поля и то, пришли ли они из формы страницы. */
export type TriggerBody =
	{ ok: true; body: Record<string, unknown>; fromForm: boolean } | { ok: false; message: string };

/**
 * Тело триггера: JSON запроса или поля HTML-формы со страницы состояния.
 *
 * Форма отправляет `application/x-www-form-urlencoded` — это единственный
 * способ нажать триггер со страницы, не добавляя к имитатору ни строки
 * скрипта. Пустое поле формы отбрасывается: незаполненное поле значит «как
 * обычно», а не «пустая строка», иначе кнопка присылала бы ключ заявки `''`.
 */
export function parseTriggerBody(request: MockRequest): TriggerBody {
	const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

	if (type === 'application/x-www-form-urlencoded') {
		const body: Record<string, unknown> = {};

		for (const [name, value] of new URLSearchParams(request.rawBody)) {
			if (value !== '') {
				body[name] = value;
			}
		}

		return { ok: true, body, fromForm: true };
	}

	let parsed: unknown;

	try {
		parsed = request.rawBody === '' ? {} : JSON.parse(request.rawBody);
	} catch {
		return { ok: false, message: 'Тело запроса не разбирается как JSON' };
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { ok: false, message: 'Тело запроса — объект' };
	}

	return { ok: true, body: parsed as Record<string, unknown>, fromForm: false };
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
	const expected = pattern.split('/');
	const actual = path.split('/');

	if (expected.length !== actual.length) {
		return null;
	}

	const params: Record<string, string> = {};

	for (let index = 0; index < expected.length; index += 1) {
		const segment = expected[index];

		if (segment.startsWith('{') && segment.endsWith('}')) {
			params[segment.slice(1, -1)] = decodeURIComponent(actual[index]);
			continue;
		}

		if (segment !== actual[index]) {
			return null;
		}
	}

	return params;
}

/**
 * Тело запроса целиком; `null` — предел превышен.
 *
 * После превышения запрос дочитывается, но больше не копится: соединение
 * рвать нельзя — отправитель не получил бы `413` и решил бы, что имитатор
 * недоступен, то есть повторил бы тот же слишком большой запрос.
 */
function readBody(request: IncomingMessage): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;

		request.on('data', (chunk: Buffer) => {
			if (overflow) {
				return;
			}

			size += chunk.byteLength;

			if (size > MAX_BODY_BYTES) {
				overflow = true;
				chunks.length = 0;
				resolve(null);
				return;
			}

			chunks.push(chunk);
		});

		request.on('end', () => {
			if (!overflow) {
				resolve(Buffer.concat(chunks).toString('utf8'));
			}
		});
		request.on('error', reject);
	});
}

function send(response: ServerResponse, reply: MockReply): void {
	const headers: Record<string, string> = { 'cache-control': 'no-store', ...reply.headers };

	if (reply.html !== undefined) {
		headers['content-type'] = 'text/html; charset=utf-8';
		response.writeHead(reply.status, headers);
		response.end(reply.html);
		return;
	}

	if (reply.json === undefined) {
		response.writeHead(reply.status, headers);
		response.end();
		return;
	}

	headers['content-type'] = 'application/json; charset=utf-8';
	response.writeHead(reply.status, headers);
	response.end(JSON.stringify(reply.json));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function startMockService(options: {
	name: string;
	/** `0` — любой свободный порт: так имитатор поднимается в тестах. */
	port: number;
	/** В контейнере `0.0.0.0`, в тестах — петля. */
	host?: string;
	routes: MockRoute[];
	scenario: Scenario;
	journal: Journal;
}): Promise<MockService> {
	const { name, routes, scenario, journal } = options;
	const host = options.host ?? '127.0.0.1';

	const server: Server = createServer((request, response) => {
		void handle(request, response);
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
		const method = request.method ?? 'GET';
		const path = url.pathname.replace(/\/+$/, '') === '' ? '/' : url.pathname.replace(/\/+$/, '');

		let matched: { route: MockRoute; params: Record<string, string> } | null = null;

		for (const candidate of routes) {
			if (candidate.method !== method) {
				continue;
			}

			const params = matchPath(candidate.path, path);

			if (params !== null) {
				matched = { route: candidate, params };
				break;
			}
		}

		if (matched === null) {
			send(response, problem(404, 'not_found', `Нет такого адреса: ${method} ${path}`));
			return;
		}

		const { route, params } = matched;

		const rawBody = method === 'POST' ? await readBody(request) : '';

		if (rawBody === null) {
			send(
				response,
				problem(413, 'payload_too_large', `Тело сообщения больше ${MAX_BODY_BYTES} байт`)
			);
			return;
		}

		if (route.contract) {
			const state = scenario.read();
			// Сценарий может быть сужен до одного объекта (`match`): на стенде
			// имитатор один, и сломанная доставка одной заявки не должна задевать
			// соседнюю — в том числе чужую проверку, идущую рядом.
			const targeted = state.match === null || path.includes(state.match);

			if (targeted && state.mode === 'offline') {
				journal.add({
					direction: 'inbound',
					summary: `${method} ${path}`,
					status: null,
					eventId: null,
					eventType: null,
					note: 'сценарий: offline — соединение оборвано без ответа',
					payload: null
				});
				request.socket.destroy();
				return;
			}

			if (targeted && state.delayMs > 0) {
				await delay(state.delayMs);
			}

			const failure = targeted ? scenario.takeFailure() : null;

			if (failure !== null) {
				journal.add({
					direction: 'inbound',
					summary: `${method} ${path}`,
					status: failure,
					eventId: null,
					eventType: null,
					note: `сценарий: отказ ${failure}, осталось испортить ${scenario.read().failNext}`,
					payload: null
				});
				send(
					response,
					problem(failure, 'scenario', `Имитатор ${name} отвечает отказом по сценарию`)
				);
				return;
			}
		}

		const headers: Record<string, string> = {};

		for (const [header, value] of Object.entries(request.headers)) {
			headers[header] = Array.isArray(value) ? value.join(', ') : (value ?? '');
		}

		try {
			send(response, await route.handle({ method, url, path, headers, rawBody, params }));
		} catch (error) {
			// Ошибка обработчика — это ошибка имитатора, и она обязана быть видной:
			// в журнале стенда и в логе процесса. Тихая пятисотка выглядела бы как
			// сценарий отказа, которого никто не задавал.
			const message = error instanceof Error ? error.message : String(error);

			journal.add({
				direction: 'inbound',
				summary: `${method} ${path}`,
				status: 500,
				eventId: null,
				eventType: null,
				note: `сбой имитатора: ${message}`,
				payload: null
			});
			console.error(`[${name}] ${method} ${path}:`, error);
			send(response, problem(500, 'internal', `Сбой имитатора: ${message}`));
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, host, resolve);
	});

	const port = (server.address() as AddressInfo).port;

	return {
		name,
		port,
		url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
		stop: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)));
				// Открытые соединения не держат остановку: в тестах сервис поднимается
				// и гасится десятки раз за прогон.
				server.closeAllConnections();
			})
	};
}
