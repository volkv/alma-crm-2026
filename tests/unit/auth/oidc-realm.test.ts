import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Разговор с каталогом на поддельном realm.
 *
 * Здесь проверяется то, что на живом Keycloak не проверить: как приложение
 * ведёт себя, когда каталог отвечает не то. Realm подменяется целиком — своими
 * метаданными, своим набором ключей и своим ответом token endpoint, — а сам
 * модуль ходит в него настоящим кодом, без единой заглушки внутри.
 *
 * Доказываются три вещи (`docs/auth.md`, «Вход»):
 *
 * 1. **Подпись id-токена проверяется по ключам realm.** Токен с верными
 *    утверждениями, но подписанный чужим ключом, вход не открывает. Разбор
 *    утверждений и проверка подписи в `oauth4webapi` разнесены, поэтому без
 *    отдельного вызова такой токен проходит насквозь — и проверить это можно
 *    только подделкой.
 * 2. **Серверные запросы уходят на внутреннее основание**, а адреса браузера
 *    остаются публичными. На живом стенде оба основания совпадают, и перенос
 *    выглядит работающим, даже если его нет.
 * 3. **`issuer` метаданных сверяется с ожидаемым**: каталог, назвавшийся чужим
 *    именем, не принимается вовсе.
 */

const PUBLIC_BASE = 'http://localhost:58080';
const INTERNAL_BASE = 'http://keycloak:8080';
const ISSUER = `${PUBLIC_BASE}/realms/lct`;
const CLIENT_ID = 'lct-crm';
const REDIRECT_URI = 'http://localhost:5173/login/callback';
const KID = 'realm-signing-key';

/** Адреса, по которым отвечает поддельный каталог: метаданные публичные, запросы внутренние. */
const PUBLIC = {
	authorization: `${ISSUER}/protocol/openid-connect/auth`,
	token: `${ISSUER}/protocol/openid-connect/token`,
	jwks: `${ISSUER}/protocol/openid-connect/certs`,
	endSession: `${ISSUER}/protocol/openid-connect/logout`,
	userinfo: `${ISSUER}/protocol/openid-connect/userinfo`
} as const;

const INTERNAL = {
	discovery: `${INTERNAL_BASE}/realms/lct/.well-known/openid-configuration`,
	token: `${INTERNAL_BASE}/realms/lct/protocol/openid-connect/token`,
	jwks: `${INTERNAL_BASE}/realms/lct/protocol/openid-connect/certs`
} as const;

// Конфигурация читается целиком, поэтому и задаётся целиком: `getConfig()`
// справедливо упадёт на первой же недостающей переменной. Внутреннее основание
// здесь отличается от публичного — иначе перенос был бы тождеством и проверять
// в нём было бы нечего.
vi.mock('$env/dynamic/private', () => ({
	env: {
		NODE_ENV: 'test',
		DATABASE_URL: 'postgres://lct:lct@localhost:55432/lct',
		REDIS_URL: 'redis://localhost:56379',
		GOTENBERG_URL: 'http://localhost:3001',
		SMTP_HOST: 'localhost',
		SMTP_PORT: '1025',
		ORIGIN: 'http://localhost:5173',
		DEMO_MODE: 'false',
		TRUST_PROXY: 'false',
		S3_ENDPOINT: 'http://localhost:59000',
		S3_REGION: 'us-east-1',
		S3_BUCKET: 'lct-documents',
		S3_ACCESS_KEY: 'lct',
		S3_SECRET_KEY: 'lct-secret-key',
		S3_FORCE_PATH_STYLE: 'true',
		OIDC_ISSUER_URL: 'http://localhost:58080/realms/lct',
		OIDC_PUBLIC_URL: 'http://localhost:58080',
		OIDC_INTERNAL_URL: 'http://keycloak:8080',
		OIDC_CLIENT_ID: 'lct-crm',
		OIDC_CLIENT_SECRET: 'lct-crm-dev-secret'
	}
}));

const encoder = new TextEncoder();

function base64url(input: string | ArrayBuffer): string {
	const bytes = typeof input === 'string' ? encoder.encode(input) : new Uint8Array(input);

	return Buffer.from(bytes).toString('base64url');
}

/**
 * Запись набора ключей realm. `kid` в типе `JsonWebKey` не объявлен, а в JWKS
 * он и есть то, по чему проверка выбирает ключ, — поэтому тип расширен.
 */
type PublicJwk = JsonWebKey & { kid: string; alg: string; use: 'sig' };

type RealmKey = { privateKey: CryptoKey; publicJwk: PublicJwk };

/** Ключ подписи realm: закрытый — чтобы подписывать, открытый — чтобы отдать в JWKS. */
async function generateKey(): Promise<RealmKey> {
	const pair = await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['sign', 'verify']
	);

	const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

	return { privateKey: pair.privateKey, publicJwk: { ...jwk, kid: KID, alg: 'RS256', use: 'sig' } };
}

/**
 * Id-токен с заданными утверждениями. `kid` всегда настоящий: подделка тем и
 * опасна, что называет себя ключом realm.
 */
async function signIdToken(key: RealmKey, claims: Record<string, unknown>): Promise<string> {
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
	const payload = base64url(JSON.stringify(claims));
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key.privateKey,
		encoder.encode(`${header}.${payload}`)
	);

	return `${header}.${payload}.${base64url(signature)}`;
}

function tokenClaims(nonce: string): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);

	return {
		iss: ISSUER,
		aud: CLIENT_ID,
		sub: 'a5f2f0c8-9f4c-4b2e-9d51-2f1d5a1f0b77',
		nonce,
		exp: now + 300,
		iat: now,
		email: 'chief@example.org',
		email_verified: true,
		name: 'Иван Директоров',
		realm_access: { roles: ['crm-admin'] }
	};
}

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		issuer: ISSUER,
		authorization_endpoint: PUBLIC.authorization,
		token_endpoint: PUBLIC.token,
		jwks_uri: PUBLIC.jwks,
		end_session_endpoint: PUBLIC.endSession,
		userinfo_endpoint: PUBLIC.userinfo,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code'],
		id_token_signing_alg_values_supported: ['RS256'],
		...overrides
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

/** Адреса, по которым модуль ходил: по ним и видно, публичное основание или внутреннее. */
let requested: string[] = [];

/**
 * Поддельный каталог вместо сети. Неизвестный адрес — ошибка, а не пустой
 * ответ: запрос не туда обязан быть виден тестом, а не выглядеть отказом
 * каталога.
 */
function installRealm(options: {
	metadata: Record<string, unknown>;
	idToken?: string;
	jwks?: unknown;
}): void {
	vi.stubGlobal('fetch', async (input: unknown): Promise<Response> => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: (input as Request).url;

		requested.push(url);

		if (url === INTERNAL.discovery) {
			return jsonResponse(options.metadata);
		}

		if (url === INTERNAL.jwks && options.jwks !== undefined) {
			return jsonResponse(options.jwks);
		}

		if (url === INTERNAL.token && options.idToken !== undefined) {
			return jsonResponse({
				access_token: 'access-token-value',
				token_type: 'Bearer',
				expires_in: 300,
				id_token: options.idToken
			});
		}

		throw new Error(`Поддельный каталог не отвечает по адресу ${url}`);
	});
}

const attempt = {
	state: 'state-of-this-login-attempt',
	nonce: 'nonce-of-this-login-attempt',
	codeVerifier: 'verifier-that-is-long-enough-for-pkce-0123456789'
};

const callbackUrl = new URL(`${REDIRECT_URI}?code=authorization-code&state=${attempt.state}`);

let realmKey: RealmKey;
let foreignKey: RealmKey;

beforeAll(async () => {
	[realmKey, foreignKey] = await Promise.all([generateKey(), generateKey()]);
}, 30_000);

beforeEach(() => {
	// Метаданные и ключи кэшируются на процесс, а каждый тест поднимает свой
	// realm: без сброса модулей второй тест читал бы первый каталог.
	vi.resetModules();
	requested = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('подпись id-токена', () => {
	it('отвергает токен, подписанный не ключом realm', async () => {
		installRealm({
			metadata: metadata(),
			jwks: { keys: [realmKey.publicJwk] },
			// Ключ чужой, а `kid` в заголовке — настоящий: так выглядит подмена
			// ответа token endpoint для того, кто стоит между сервером и каталогом.
			idToken: await signIdToken(foreignKey, {
				...tokenClaims(attempt.nonce),
				sub: 'attacker-subject'
			})
		});

		const { exchangeCode } = await import('$lib/server/auth/oidc');

		await expect(
			exchangeCode({ currentUrl: callbackUrl, attempt, redirectUri: REDIRECT_URI })
		).rejects.toThrowError(/signature/i);

		// Проверка состоялась именно по ключам realm, а не по чему-то своему.
		expect(requested).toContain(INTERNAL.jwks);
	});

	it('пропускает токен, подписанный ключом realm, и отдаёт его утверждения', async () => {
		installRealm({
			metadata: metadata(),
			jwks: { keys: [realmKey.publicJwk] },
			idToken: await signIdToken(realmKey, tokenClaims(attempt.nonce))
		});

		const { exchangeCode } = await import('$lib/server/auth/oidc');

		const { claims } = await exchangeCode({
			currentUrl: callbackUrl,
			attempt,
			redirectUri: REDIRECT_URI
		});

		expect(claims.subject).toBe('a5f2f0c8-9f4c-4b2e-9d51-2f1d5a1f0b77');
		expect(claims.email).toBe('chief@example.org');
		expect(claims.emailVerified).toBe(true);
		expect(claims.realmRoles).toStrictEqual(['crm-admin']);
	});

	it('отвергает токен, у которого ключа в наборе realm нет вовсе', async () => {
		installRealm({
			metadata: metadata(),
			// Каталог отдал другой ключ: так выглядит и подмена ответа, и
			// рассинхронизация с перезаведённым realm.
			jwks: { keys: [{ ...foreignKey.publicJwk, kid: 'some-other-key' }] },
			idToken: await signIdToken(realmKey, tokenClaims(attempt.nonce))
		});

		const { exchangeCode } = await import('$lib/server/auth/oidc');

		await expect(
			exchangeCode({ currentUrl: callbackUrl, attempt, redirectUri: REDIRECT_URI })
		).rejects.toThrowError(/key/i);
	});
});

describe('публичное и внутреннее основание', () => {
	it('обмен кода и ключи подписи уходят на внутреннее основание', async () => {
		installRealm({
			metadata: metadata(),
			jwks: { keys: [realmKey.publicJwk] },
			idToken: await signIdToken(realmKey, tokenClaims(attempt.nonce))
		});

		const { exchangeCode } = await import('$lib/server/auth/oidc');

		await exchangeCode({ currentUrl: callbackUrl, attempt, redirectUri: REDIRECT_URI });

		// Метаданные, обмен кода и ключи — три серверных запроса, и все три по
		// внутреннему адресу. Публичного основания среди них быть не должно:
		// изнутри сети стека опубликованный порт — чужой адрес.
		expect(requested).toStrictEqual([INTERNAL.discovery, INTERNAL.token, INTERNAL.jwks]);
		expect(requested.some((url) => url.startsWith(PUBLIC_BASE))).toBe(false);
	});

	it('адрес авторизации остаётся публичным: по нему идёт браузер', async () => {
		installRealm({ metadata: metadata() });

		const { authorizationUrl } = await import('$lib/server/auth/oidc');
		const url = new URL(await authorizationUrl(attempt, REDIRECT_URI));

		expect(`${url.origin}${url.pathname}`).toBe(PUBLIC.authorization);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	});

	it('адрес выхода остаётся публичным: по нему тоже идёт браузер', async () => {
		installRealm({ metadata: metadata() });

		const { endSessionUrl } = await import('$lib/server/auth/oidc');
		const url = new URL(
			(await endSessionUrl({ idToken: 'id-token-value', returnTo: 'http://localhost:5173/' })) ?? ''
		);

		expect(`${url.origin}${url.pathname}`).toBe(PUBLIC.endSession);
		expect(url.searchParams.get('id_token_hint')).toBe('id-token-value');
	});
});

describe('метаданные realm', () => {
	it('не принимает каталог, назвавшийся чужим именем', async () => {
		// Ответ приехал по нашему адресу, но `issuer` в нём чужой. Принять его
		// значило бы взять чужие адреса эндпоинтов и чужие ключи подписи.
		installRealm({ metadata: metadata({ issuer: 'http://evil.example/realms/lct' }) });

		const { authorizationUrl } = await import('$lib/server/auth/oidc');

		await expect(authorizationUrl(attempt, REDIRECT_URI)).rejects.toThrowError(/issuer/i);
	});

	it('не кэширует неудачное чтение метаданных', async () => {
		installRealm({ metadata: metadata({ issuer: 'http://evil.example/realms/lct' }) });

		const { authorizationUrl } = await import('$lib/server/auth/oidc');

		await expect(authorizationUrl(attempt, REDIRECT_URI)).rejects.toThrowError(/issuer/i);

		// Каталог мог ещё подниматься: первый неудачный вход не должен закрывать
		// вход до перезапуска приложения.
		installRealm({ metadata: metadata() });

		await expect(authorizationUrl(attempt, REDIRECT_URI)).resolves.toContain(PUBLIC.authorization);
		expect(requested).toStrictEqual([INTERNAL.discovery, INTERNAL.discovery]);
	});
});
