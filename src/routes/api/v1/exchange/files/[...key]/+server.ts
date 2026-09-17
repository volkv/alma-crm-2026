import { z } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '$lib/contracts/api';
import { registerRoute } from '$lib/server/api/openapi';
import { recordApiRequest, type ApiEndpointConfig } from '$lib/server/api/handler';
import { authenticateApiKey, parseBearerToken } from '$lib/server/api/keys';
import {
	API_RATE_LIMIT_PER_IP,
	API_RATE_LIMIT_PER_KEY,
	consumeRateLimit,
	rateLimitHeaders,
	tighter
} from '$lib/server/api/rate-limit';
import type { AccessScope, ActorContext } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import { contentDisposition, documentFileName } from '$lib/server/documents/filename';
import { openStoredFile } from '$lib/server/documents/storage';
import { AppError, statusForError } from '$lib/server/errors';
import { readExchangeFile } from '$lib/server/integrations/exchange/files';
import type { RequestHandler } from './$types';

/**
 * Вложение обмена по ключу объекта.
 *
 * Свой обработчик, а не `apiHandler`: тот отдаёт только JSON и проверяет ответ
 * схемой, а здесь ответ — тело файла с `content-type` и `content-length` из
 * записи документа (`docs/exchange-contract.md`, раздел 2). Всё остальное —
 * ключ вместо сессии, лимит частоты, граница машинного субъекта и запись в
 * журнал — взято из того же кода, что у остальных эндпоинтов API: второй
 * реализации ни у чего из перечисленного не появляется.
 *
 * Файл читается потоком из хранилища: класть документ на 25 МиБ целиком в
 * память ради того, чтобы тут же отдать его в сокет, незачем.
 */
const fileEndpoint = {
	auth: 'key',
	params: z.object({ key: z.string().describe('Ключ объекта в хранилище, `files/<uuid>`') }),
	// Ответ этого маршрута — файл, а не JSON. Схема названа, чтобы документация
	// не обещала интегратору объект: тела у неё нет.
	output: z.never(),
	permission: 'exchange.intake',
	service: true
} satisfies ApiEndpointConfig;

/**
 * Свой обработчик записывает в журнал сам — тем же правилом, что `apiHandler`:
 * отказ «ключ негоден», «слишком часто» и «такого файла нет» — это то, о чём
 * администратор должен узнать, и молчащий маршрут ничем не отличается от
 * маршрута, которого перебирают ключи.
 */

registerRoute({
	method: 'get',
	path: '/v1/exchange/files/{key}',
	summary: 'Вложение обмена',
	description:
		'Отдаёт файл по ключу объекта хранилища. Ответ — тело файла с `Content-Type` и ' +
		'`Content-Length` из записи документа, а не JSON.\n\n' +
		'Проверяется принадлежность: объект обязан относиться к взаимодействию, связанному с ' +
		'**подключением того ключа, которым пришли**, — заявкой этого экземпляра CMS либо учебной ' +
		'группой этого экземпляра LMS. Чужой ключ отвечает `404`, а не `403`: перебором ключей ' +
		'нельзя узнать, что у нас лежит.',
	tags: ['Обмен'],
	config: fileEndpoint,
	// Ответ — байты файла, а не объект: схема `output` этого маршрута ничего не
	// описывает, и документация читает тип отсюда.
	responseContentType: 'application/octet-stream'
});

/** Область доступа того, кто ещё не представился: ничего. */
const NO_ACCESS: AccessScope = { kind: 'delegated', userIds: new Set() };

function errorResponse(
	status: number,
	code: ApiErrorCode,
	message: string,
	requestId: string,
	headers: Record<string, string> = {}
): Response {
	const body: ApiErrorBody = { error: { code, message, requestId } };

	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers
		}
	});
}

export const GET: RequestHandler = async (event) => {
	const requestId = event.locals.requestId;
	const ip = event.getClientAddress();
	const route = event.route.id ?? event.url.pathname;

	let ctx: ActorContext = {
		requestId,
		source: 'api',
		user: null,
		apiKeyId: null,
		ip,
		userAgent: event.request.headers.get('user-agent'),
		scope: NO_ACCESS
	};

	/** Ответ складывается здесь — вместе с записью о нём в журнале. */
	const refuse = async (
		status: number,
		code: ApiErrorCode,
		message: string,
		headers: Record<string, string> = {}
	): Promise<Response> => {
		await recordApiRequest(ctx, { route, method: 'GET', status });

		return errorResponse(status, code, message, requestId, headers);
	};

	const ipVerdict = await consumeRateLimit(`ip:${ip}`, API_RATE_LIMIT_PER_IP);

	if (!ipVerdict.allowed) {
		return refuse(429, 'rate_limited', 'Слишком много запросов с этого адреса', {
			'Retry-After': String(ipVerdict.resetSeconds),
			...rateLimitHeaders(ipVerdict)
		});
	}

	const token = parseBearerToken(event.request.headers.get('authorization'));
	const authenticated = token === null ? null : await authenticateApiKey(token);

	if (authenticated === null) {
		return refuse(401, 'unauthorized', 'Ключ доступа недействителен');
	}

	const keyVerdict = await consumeRateLimit(`key:${authenticated.key.id}`, API_RATE_LIMIT_PER_KEY);
	const verdict = tighter(ipVerdict, keyVerdict);

	if (!keyVerdict.allowed) {
		return refuse(429, 'rate_limited', 'Слишком много запросов по этому ключу', {
			'Retry-After': String(keyVerdict.resetSeconds),
			...rateLimitHeaders(verdict)
		});
	}

	ctx = {
		...ctx,
		user: authenticated.owner,
		apiKeyId: authenticated.key.id,
		scope: authenticated.owner.scope
	};

	// Вложение обмена забирает внешняя система, а не человек: у ключа на
	// сотрудника подключения нет, и принадлежность файла сверять не с чем.
	const binding = authenticated.key.exchange;

	if (binding === null) {
		return refuse(
			403,
			'forbidden',
			'Вложения обмена забирает ключ внешней системы: этот ключ не привязан к подключению'
		);
	}

	try {
		const file = await readExchangeFile(ctx, event.params.key, binding);
		const stream = await openStoredFile(file.filePath);

		await recordAuditEvent(ctx, {
			type: 'documents.downloaded',
			outcome: 'success',
			subject: { type: 'document', id: file.documentId },
			details: { documentId: file.documentId, interactionId: file.interactionId }
		});

		return new Response(stream, {
			headers: {
				'Content-Type': file.mime,
				'Content-Length': String(file.sizeBytes),
				'Content-Disposition': contentDisposition(documentFileName(file.name, file.mime)),
				'X-Exchange-Sha256': file.sha256,
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
				...rateLimitHeaders(verdict)
			}
		});
	} catch (failure) {
		if (failure instanceof AppError) {
			return refuse(
				statusForError(failure),
				failure.code,
				failure.message,
				rateLimitHeaders(verdict)
			);
		}

		// Наружу не уходит ни текст ошибки, ни стек: связь с этой строкой лога
		// даёт `requestId` в ответе.
		console.error(`[api] не удалось отдать вложение обмена (запрос ${requestId})`, failure);

		return refuse(500, 'internal', 'Внутренняя ошибка сервера');
	}
};
