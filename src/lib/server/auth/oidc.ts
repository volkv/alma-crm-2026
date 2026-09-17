/**
 * Вход через внешний каталог учётных записей: OIDC Authorization Code + PKCE.
 *
 * Своих паролей у системы нет — ни в базе, ни в форме. Кто перед нами, решает
 * каталог (Keycloak, realm `lct`), а приложение проверяет его ответ и заводит
 * собственную серверную сессию. Отсюда граница модуля: здесь всё про протокол —
 * метаданные realm, отправка в каталог, обмен кода на токены и проверка
 * токена, — и ничего про наших пользователей. Кем человек становится в системе,
 * решает `./identity`.
 *
 * Проверки не сокращаются ни одна: подпись по ключам realm (JWKS), `iss`,
 * `aud`, `nonce`, срок годности. Каждая из них отвечает на свой вопрос — «токен
 * ли это нашего каталога», «нам ли он выдан», «наш ли это заход», — и снятая
 * поодиночке ни одна не заметна, пока её не используют.
 *
 * Подпись стоит отдельным вызовом, потому что в `oauth4webapi` разбор
 * утверждений и проверка подписи разнесены: обмен кода читает `iss`, `aud`,
 * `nonce` и сроки, а к ключам realm не ходит вовсе. Спецификация это
 * допускает — токен приехал прямо с token endpoint, — но ровно при условии,
 * что до каталога идёт TLS. Внутри стека транспорт до Keycloak — HTTP
 * (`docker-compose.prod.yml`), поэтому условие не выполняется и подпись
 * проверяется явно; полное закрытие — TLS до каталога, см. `docs/auth.md`.
 */
import * as oauth from 'oauth4webapi';
import { getConfig } from '../config';

/** Утверждения токена, на которые приложение смотрит. */
export type IdentityClaims = {
	/** Идентификатор субъекта в каталоге: ключ связывания с нашей записью. */
	subject: string;
	/** Почта из токена; `null` — каталог её не отдал. */
	email: string | null;
	/** Каталог подтвердил владение почтой. Неподтверждённая в связывании не участвует. */
	emailVerified: boolean;
	/** Имя человека, как его знает каталог. */
	fullName: string | null;
	/** Роли realm целиком, без разбора: отображение на наши роли — в `./roles`. */
	realmRoles: readonly string[];
};

/**
 * Метаданные realm читаются по сети и кэшируются на процесс: ключи подписи и
 * адреса эндпоинтов меняются не чаще, чем перезапускается приложение, а тянуть
 * их на каждый вход значило бы поставить вход в зависимость от ещё одного
 * запроса.
 *
 * Кэш хранит и `authorizationServer`, и набор ключей: `oauth4webapi` держит
 * JWKS в карте по самому объекту метаданных, поэтому ключи realm скачиваются
 * один раз на процесс, а не на каждую проверку подписи, и обновляются сами,
 * когда проверке встречается незнакомый `kid`.
 */
let discovered: Promise<oauth.AuthorizationServer> | undefined;

/**
 * Адрес, по которому каталог знает сам себя, — и адрес, по которому до него
 * достаёт сервер, — разные вещи.
 *
 * Браузер ходит к каталогу по публичному адресу, и этим же адресом каталог
 * подписывается в `iss` каждого токена и в собственных метаданных. Сервер из
 * контейнера туда может и не достать: в стеке приложение и каталог стоят в
 * одной сети, и опубликованный порт для них — чужой адрес. Поэтому серверные
 * запросы (метаданные, ключи подписи, обмен кода) переносятся на
 * `OIDC_INTERNAL_URL`, а проверка `iss` остаётся по публичному: подменять то,
 * чем токен подписан, нельзя ни при каких удобствах.
 *
 * Переменная необязательна: где приложение достаёт каталог по тому же адресу,
 * что и человек, переносить нечего.
 */
export function rebaseEndpoint(endpoint: string, publicBase: string, internalBase: string): string {
	if (!endpoint.startsWith(publicBase)) {
		// Метаданные разошлись с настройкой: каталог называет себя не тем
		// адресом, который объявлен публичным, и подставить внутренний адрес
		// не к чему. Молчать здесь нельзя — вход упрётся в это позже и непонятно.
		throw new Error(
			`Адрес каталога «${endpoint}» не начинается с публичного «${publicBase}»: проверьте OIDC_PUBLIC_URL и KC_HOSTNAME`
		);
	}

	return `${internalBase}${endpoint.slice(publicBase.length)}`;
}

/** Тот же перенос, но по текущей конфигурации; без `OIDC_INTERNAL_URL` — тождество. */
function toInternal(endpoint: string): string {
	const { OIDC_PUBLIC_URL, OIDC_INTERNAL_URL } = getConfig();

	return OIDC_INTERNAL_URL === undefined
		? endpoint
		: rebaseEndpoint(endpoint, OIDC_PUBLIC_URL, OIDC_INTERNAL_URL);
}

/**
 * Адреса, по которым ходит **сервер**. Адрес авторизации и адрес выхода в этот
 * список не входят: по ним идёт браузер, и они обязаны остаться публичными.
 */
const SERVER_ENDPOINTS = [
	'token_endpoint',
	'jwks_uri',
	'userinfo_endpoint',
	'introspection_endpoint',
	'revocation_endpoint'
] as const;

async function authorizationServer(): Promise<oauth.AuthorizationServer> {
	discovered ??= (async () => {
		const issuer = new URL(getConfig().OIDC_ISSUER_URL);

		// Метаданные читаются по внутреннему адресу, а сверяются с публичным
		// именем: `processDiscoveryResponse` требует, чтобы `issuer` в ответе
		// совпал с ожидаемым, и это единственная защита от чужого каталога.
		const response = await fetch(
			toInternal(`${issuer.href.replace(/\/$/, '')}/.well-known/openid-configuration`),
			{ headers: { accept: 'application/json' } }
		);

		const server = await oauth.processDiscoveryResponse(issuer, response);

		return {
			...server,
			...Object.fromEntries(
				SERVER_ENDPOINTS.filter((name) => typeof server[name] === 'string').map((name) => [
					name,
					toInternal(server[name] as string)
				])
			)
		};
	})();

	try {
		return await discovered;
	} catch (error) {
		// Неудачное чтение не остаётся в кэше: каталог мог ещё подниматься, и
		// первый неудачный вход не должен закрывать вход до перезапуска.
		discovered = undefined;
		throw error;
	}
}

/**
 * Разрешить запрос к каталогу по `http`.
 *
 * Библиотека по умолчанию отказывается ходить куда-либо, кроме `https`, и это
 * верное умолчание: токен, уехавший по открытому каналу, — это чужая сессия.
 * Исключение делается ровно тогда, когда развёртывание само объявило незашифрованным
 * тот адрес, по которому **ходит сервер**: внутри сети стека TLS не нужен и
 * негде взять, а снаружи от неё этот адрес не виден. Подставить `http` извне
 * нельзя — адрес приходит из конфигурации.
 */
function transport(): { [oauth.allowInsecureRequests]?: boolean } {
	const { OIDC_ISSUER_URL, OIDC_INTERNAL_URL } = getConfig();
	const serverFacing = OIDC_INTERNAL_URL ?? OIDC_ISSUER_URL;

	return serverFacing.startsWith('http://') ? { [oauth.allowInsecureRequests]: true } : {};
}

function client(): oauth.Client {
	return { client_id: getConfig().OIDC_CLIENT_ID };
}

function clientAuth(): oauth.ClientAuth {
	return oauth.ClientSecretPost(getConfig().OIDC_CLIENT_SECRET);
}

/** Одноразовые значения одного захода; живут до возврата из каталога. */
export type LoginAttempt = {
	state: string;
	nonce: string;
	codeVerifier: string;
};

export function newLoginAttempt(): LoginAttempt {
	return {
		state: oauth.generateRandomState(),
		nonce: oauth.generateRandomNonce(),
		codeVerifier: oauth.generateRandomCodeVerifier()
	};
}

/**
 * Куда отправить браузер, чтобы человек назвался каталогу.
 *
 * Адрес берётся из метаданных как есть: каталог называет себя публичным именем
 * (`KC_HOSTNAME`), им же подписывает токены, и по нему же идёт браузер. На
 * внутренний адрес переносятся только серверные запросы — см. `toInternal`.
 */
export async function authorizationUrl(
	attempt: LoginAttempt,
	redirectUri: string
): Promise<string> {
	const server = await authorizationServer();

	if (server.authorization_endpoint === undefined) {
		throw new Error('В метаданных realm нет адреса авторизации');
	}

	const url = new URL(server.authorization_endpoint);

	url.searchParams.set('client_id', getConfig().OIDC_CLIENT_ID);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', 'openid email profile');
	url.searchParams.set('state', attempt.state);
	url.searchParams.set('nonce', attempt.nonce);
	url.searchParams.set(
		'code_challenge',
		await oauth.calculatePKCECodeChallenge(attempt.codeVerifier)
	);
	url.searchParams.set('code_challenge_method', 'S256');

	return url.toString();
}

/**
 * Код из каталога → проверенные утверждения о человеке.
 *
 * `validateAuthResponse` сверяет `state` и отвергает ответ с ошибкой; обмен
 * кода читает `iss`, `aud`, `nonce` и сроки id-токена; подпись по ключам realm
 * проверяется следом отдельным вызовом. Всё, что не прошло хоть одну проверку,
 * приезжает сюда исключением — и наружу уходит отказом входа, а не половиной
 * сессии.
 */
export async function exchangeCode(input: {
	currentUrl: URL;
	attempt: LoginAttempt;
	redirectUri: string;
}): Promise<{ claims: IdentityClaims; idToken: string }> {
	const server = await authorizationServer();

	const params = oauth.validateAuthResponse(
		server,
		client(),
		input.currentUrl,
		input.attempt.state
	);

	const response = await oauth.authorizationCodeGrantRequest(
		server,
		client(),
		clientAuth(),
		params,
		input.redirectUri,
		input.attempt.codeVerifier,
		transport()
	);

	const tokens = await oauth.processAuthorizationCodeResponse(server, client(), response, {
		expectedNonce: input.attempt.nonce,
		requireIdToken: true,
		...transport()
	});

	// Подпись id-токена: ключи берутся по `jwks_uri` из метаданных realm, то
	// есть по внутреннему адресу — как и остальные серверные запросы. Проверка
	// идёт по тому же `response`: библиотека помнит разобранный токен по нему.
	// Без неё принимался бы любой токен с верными утверждениями, кем бы он ни
	// был подписан.
	await oauth.validateApplicationLevelSignature(server, response, transport());

	const claims = oauth.getValidatedIdTokenClaims(tokens);

	if (claims === undefined || tokens.id_token === undefined) {
		// `requireIdToken` уже это проверил; условие оставлено ради типа — и ради
		// того, чтобы смена настройки не проехала молча.
		throw new Error('Каталог вернул ответ без id-токена');
	}

	return {
		claims: {
			subject: claims.sub,
			email: stringClaim(claims.email),
			emailVerified: claims.email_verified === true,
			fullName: stringClaim(claims.name),
			realmRoles: realmRoles(claims.realm_access)
		},
		// Id-токен нужен выходу: каталог принимает его подсказкой о том, чью
		// сессию гасить, и без неё показал бы человеку лишний вопрос.
		idToken: tokens.id_token
	};
}

function stringClaim(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** `realm_access.roles` — массив строк; всё остальное в этом утверждении не роли. */
function realmRoles(value: unknown): string[] {
	if (typeof value !== 'object' || value === null) {
		return [];
	}

	const roles = (value as { roles?: unknown }).roles;

	return Array.isArray(roles)
		? roles.filter((role): role is string => typeof role === 'string')
		: [];
}

/**
 * Куда отправить браузер, чтобы каталог закрыл и свою сессию.
 *
 * Без этого шага «Выйти» гасит только нашу сессию: следующий вход каталог
 * пропустил бы молча, по своей ещё живой куке, и человек на общем компьютере
 * оказался бы в чужой учётной записи, не увидев формы.
 */
export async function endSessionUrl(input: {
	idToken: string;
	returnTo: string;
}): Promise<string | null> {
	const server = await authorizationServer();

	if (server.end_session_endpoint === undefined) {
		return null;
	}

	const url = new URL(server.end_session_endpoint);

	url.searchParams.set('id_token_hint', input.idToken);
	url.searchParams.set('post_logout_redirect_uri', input.returnTo);
	url.searchParams.set('client_id', getConfig().OIDC_CLIENT_ID);

	return url.toString();
}
