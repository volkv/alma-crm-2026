/**
 * Обёртка эндпоинта публичного API.
 *
 * Всё, что одинаково для любого машинного запроса, живёт здесь: ключ вместо
 * сессии, лимит частоты, разбор и проверка входа, идемпотентность, единый
 * формат ошибки и запись в журнал. Эндпоинт остаётся описанием предметного
 * действия — схема входа, схема выхода, право и вызов сервиса.
 *
 * Сессию API не смотрит вовсе. Куки браузера к машинному интерфейсу отношения
 * не имеют, а если бы имели, то запрос со страницы приложения выполнялся бы от
 * лица пользователя без всякого ключа — это и есть CSRF.
 */
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { z } from 'zod';
import type { ApiErrorBody, ApiErrorCode } from '$lib/contracts/api';
import type { AuditOutcome } from '$lib/contracts/audit';
import type { AccessScope, ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { AppError, statusForError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import type { PermissionKey } from '../rbac/permissions';
import {
	completeIdempotency,
	hashRequestBody,
	releaseIdempotency,
	reserveIdempotency
} from './idempotency';
import { authenticateApiKey, parseBearerToken } from './keys';
import {
	API_RATE_LIMIT_PER_IP,
	API_RATE_LIMIT_PER_KEY,
	consumeRateLimit,
	rateLimitHeaders,
	tighter,
	type RateLimitVerdict
} from './rate-limit';

/**
 * Описание эндпоинта. Тот же объект передаётся в `registerRoute`, поэтому
 * документация и поведение не могут разойтись: они читают одни и те же схемы.
 */
export type ApiEndpointConfig = {
	/** Единственный способ представиться машине — ключ. */
	auth: 'key';
	/** Параметры пути; обязательны там, где путь их содержит. */
	params?: z.ZodObject;
	query?: z.ZodObject;
	body?: z.ZodType;
	/** Схема ответа. Ответ проверяется ею же перед отправкой. */
	output: z.ZodType;
	permission?: PermissionKey;
	/** Разрешить `Idempotency-Key`; имеет смысл только для POST, PUT и PATCH. */
	idempotent?: boolean;
};

type Parsed<TSchema> = TSchema extends z.ZodType ? z.output<TSchema> : undefined;

export type ApiRequest<TConfig extends ApiEndpointConfig> = {
	params: Parsed<TConfig['params']>;
	query: Parsed<TConfig['query']>;
	body: Parsed<TConfig['body']>;
};

/** Методы, для которых повтор без идемпотентности создал бы вторую запись. */
const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Область доступа того, кто ещё не представился: ничего. */
const NO_ACCESS: AccessScope = { kind: 'organizations', organizationIds: new Set() };

/**
 * Отказ, случившийся в транспорте: до сервиса запрос не дошёл, и предметной
 * ошибки для него нет. Наружу выглядит так же, как любая другая ошибка API.
 */
class ApiFailure extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiErrorCode,
		message: string,
		readonly details?: Record<string, unknown>,
		readonly headers?: Record<string, string>
	) {
		super(message);
		this.name = 'ApiFailure';
	}
}

/** Претензии Zod в том виде, в каком их можно показать: «поле: что не так». */
function zodIssues(error: z.ZodError, where: string): string[] {
	return error.issues.map((issue) => {
		const path = [where, ...issue.path.map(String)].join('.');
		return `${path}: ${issue.message}`;
	});
}

function parseSection<TSchema extends z.ZodType | undefined>(
	schema: TSchema,
	value: unknown,
	where: string
): Parsed<TSchema> {
	if (schema === undefined) {
		return undefined as Parsed<TSchema>;
	}

	const result = schema.safeParse(value);
	if (!result.success) {
		throw new ValidationError('Запрос не прошёл проверку', zodIssues(result.error, where));
	}

	return result.data as Parsed<TSchema>;
}

/** Повторяющийся параметр запроса становится списком, одиночный — строкой. */
function queryObject(url: URL): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};

	for (const key of new Set(url.searchParams.keys())) {
		const values = url.searchParams.getAll(key);
		result[key] = values.length === 1 ? values[0] : values;
	}

	return result;
}

function parseJsonBody(raw: string): unknown {
	if (raw === '') {
		return undefined;
	}

	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new ValidationError('Тело запроса не является корректным JSON', [
			`body: ${error instanceof Error ? error.message : String(error)}`
		]);
	}
}

function outcomeFor(status: number): AuditOutcome {
	if (status < 400) {
		return 'success';
	}

	return status === 401 || status === 403 || status === 429 ? 'denied' : 'failure';
}

function toFailure(error: unknown, requestId: string): ApiFailure {
	if (error instanceof ApiFailure) {
		return error;
	}

	if (error instanceof AppError) {
		const details =
			error instanceof ValidationError && error.issues.length > 0
				? { issues: [...error.issues] }
				: undefined;

		return new ApiFailure(statusForError(error), error.code, error.message, details);
	}

	// Наружу не уходит ни текст ошибки, ни тем более стек: по ним восстанавливают
	// устройство системы. Связь с этой строкой лога даёт `requestId` в ответе.
	console.error(`[api] необработанная ошибка запроса ${requestId}`, error);

	return new ApiFailure(500, 'internal', 'Внутренняя ошибка сервера');
}

export function apiHandler<TConfig extends ApiEndpointConfig>(
	config: TConfig,
	run: (ctx: ActorContext, request: ApiRequest<TConfig>) => Promise<z.input<TConfig['output']>>
): RequestHandler {
	return async (event: RequestEvent): Promise<Response> => {
		const method = event.request.method;
		const route = event.route.id ?? event.url.pathname;
		const ip = event.getClientAddress();

		let ctx: ActorContext = {
			requestId: event.locals.requestId,
			source: 'api',
			user: null,
			apiKeyId: null,
			ip,
			userAgent: event.request.headers.get('user-agent'),
			scope: NO_ACCESS
		};

		let verdict: RateLimitVerdict | null = null;
		let reservation: { apiKeyId: string; key: string; bodyHash: string } | null = null;

		/** Ответ складывается ровно здесь — вместе с записью о нём в журнале. */
		const finish = async (
			status: number,
			payload: unknown,
			extra?: Record<string, string>
		): Promise<Response> => {
			const headers = new Headers({
				'content-type': 'application/json; charset=utf-8',
				// Ответ API персонален для владельца ключа: ни в общий кэш, ни в
				// историю браузера он попадать не должен.
				'cache-control': 'no-store'
			});

			if (verdict !== null) {
				for (const [name, value] of Object.entries(rateLimitHeaders(verdict))) {
					headers.set(name, value);
				}
			}

			for (const [name, value] of Object.entries(extra ?? {})) {
				headers.set(name, value);
			}

			try {
				await recordAuditEvent(ctx, {
					type: 'api.request',
					outcome: outcomeFor(status),
					details: { route, method, status }
				});
			} catch (error) {
				// Ответ уже сложился: запрос либо выполнен, либо отклонён, и клиент
				// должен узнать именно это, а не про неудачу записи в журнал. Сама
				// неудача не теряется — она уходит в лог сервера.
				console.error(`[api] не удалось записать событие журнала для ${ctx.requestId}`, error);
			}

			return new Response(JSON.stringify(payload), { status, headers });
		};

		try {
			// Адрес считается первым: у запроса без ключа и с негодным ключом
			// должна быть цена, иначе перебор ключей ничем не ограничен.
			const ipVerdict = await consumeRateLimit(`ip:${ip}`, API_RATE_LIMIT_PER_IP);
			verdict = ipVerdict;
			if (!ipVerdict.allowed) {
				throw new ApiFailure(
					429,
					'rate_limited',
					'Слишком много запросов с этого адреса',
					undefined,
					{ 'Retry-After': String(ipVerdict.resetSeconds) }
				);
			}

			const token = parseBearerToken(event.request.headers.get('authorization'));
			if (token === null) {
				throw new ApiFailure(
					401,
					'unauthorized',
					'Запрос к API подписывается ключом: заголовок «Authorization: Bearer <ключ>»'
				);
			}

			const authenticated = await authenticateApiKey(token);
			if (authenticated === null) {
				throw new ApiFailure(401, 'unauthorized', 'Ключ доступа недействителен');
			}

			ctx = {
				...ctx,
				user: authenticated.owner,
				apiKeyId: authenticated.key.id,
				scope: authenticated.owner.scope
			};

			const keyVerdict = await consumeRateLimit(
				`key:${authenticated.key.id}`,
				API_RATE_LIMIT_PER_KEY
			);
			verdict = tighter(ipVerdict, keyVerdict);
			if (!keyVerdict.allowed) {
				throw new ApiFailure(
					429,
					'rate_limited',
					'Слишком много запросов по этому ключу',
					undefined,
					{
						'Retry-After': String(keyVerdict.resetSeconds)
					}
				);
			}

			if (config.permission !== undefined) {
				requirePermission(ctx, config.permission);
			}

			const needsBody = config.body !== undefined || config.idempotent === true;
			const rawBody = needsBody ? await event.request.text() : '';

			// Приведение здесь неизбежно: разбор идёт по схемам, которые известны
			// только в момент вызова, а `Parsed<>` над необязательным полем родового
			// параметра вывести из трёх независимых вызовов TypeScript не может.
			const request = {
				params: parseSection(config.params, event.params, 'params'),
				query: parseSection(config.query, queryObject(event.url), 'query'),
				body: parseSection(config.body, parseJsonBody(rawBody), 'body')
			} as ApiRequest<TConfig>;

			const idempotencyKey = event.request.headers.get('idempotency-key');
			if (config.idempotent === true && IDEMPOTENT_METHODS.has(method) && idempotencyKey !== null) {
				const bodyHash = hashRequestBody(rawBody);
				const lookup = await reserveIdempotency(authenticated.key.id, idempotencyKey, bodyHash);

				if (lookup.state === 'mismatch') {
					throw new ApiFailure(
						422,
						'idempotency_mismatch',
						'Этот ключ идемпотентности уже использован с другим телом запроса'
					);
				}

				if (lookup.state === 'in_progress') {
					throw new ApiFailure(
						409,
						'conflict',
						'Запрос с этим ключом идемпотентности ещё выполняется'
					);
				}

				if (lookup.state === 'replay') {
					return await finish(lookup.status, lookup.body, { 'Idempotency-Replay': 'true' });
				}

				reservation = { apiKeyId: authenticated.key.id, key: idempotencyKey, bodyHash };
			}

			const result = await run(ctx, request);
			const validated = config.output.safeParse(result);

			if (!validated.success) {
				// Ответ, не сошедшийся со своей же схемой, — это ошибка нашего кода,
				// а не запроса: наружу он не уходит ни в каком виде.
				console.error(
					`[api] ответ ${route} не сошёлся со схемой (запрос ${ctx.requestId})`,
					validated.error.issues
				);
				throw new ApiFailure(500, 'internal', 'Внутренняя ошибка сервера');
			}

			if (reservation !== null) {
				await completeIdempotency(reservation.apiKeyId, reservation.key, reservation.bodyHash, {
					status: 200,
					body: validated.data
				});
			}

			return await finish(200, validated.data);
		} catch (error) {
			if (reservation !== null) {
				// Неудача — не результат: бронь снимается, чтобы повтор мог
				// выполниться, а не упирался сутки в «уже выполняется».
				await releaseIdempotency(reservation.apiKeyId, reservation.key);
			}

			const failure = toFailure(error, ctx.requestId);
			const body: ApiErrorBody = {
				error: {
					code: failure.code,
					message: failure.message,
					requestId: ctx.requestId,
					...(failure.details === undefined ? {} : { details: failure.details })
				}
			};

			return await finish(failure.status, body, failure.headers);
		}
	};
}
