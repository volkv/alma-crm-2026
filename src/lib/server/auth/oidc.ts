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
 * JWKS внутри объекта, который сам же и обновляет, когда встречает незнакомый
 * `kid`.
 */
let discovered: Promise<oauth.AuthorizationServer> | undefined;

async function authorizationServer(): Promise<oauth.AuthorizationServer> {
	discovered ??= (async () => {
		const issuer = new URL(getConfig().OIDC_ISSUER_URL);
		const response = await oauth.discoveryRequest(issuer, { algorithm: 'oidc', ...transport() });

		return oauth.processDiscoveryResponse(issuer, response);
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
 * Исключение делается ровно тогда, когда развёртывание само объявило адрес
 * каталога незашифрованным (`OIDC_ISSUER_URL` начинается с `http://`): так
 * работает локальный стек, прогон e2e и контур за прокси, который TLS уже снял.
 * Подставить `http` снаружи нельзя — адрес приходит из конфигурации.
 */
function transport(): { [oauth.allowInsecureRequests]?: boolean } {
	return getConfig().OIDC_ISSUER_URL.startsWith('http://')
		? { [oauth.allowInsecureRequests]: true }
		: {};
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
 * Адрес собирается из метаданных realm, но происхождение берётся из
 * `OIDC_PUBLIC_URL`: метаданные приходят от имени, которым каталог знает сам
 * себя (`keycloak:8080` внутри сети стека), а идти по ссылке браузеру человека.
 * Путь, включая относительный путь установки Keycloak, при этом сохраняется —
 * подменяется ровно происхождение.
 */
export async function authorizationUrl(
	attempt: LoginAttempt,
	redirectUri: string
): Promise<string> {
	const server = await authorizationServer();

	if (server.authorization_endpoint === undefined) {
		throw new Error('В метаданных realm нет адреса авторизации');
	}

	const url = toPublicUrl(server.authorization_endpoint);

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

/** Адрес каталога, переложенный на то происхождение, по которому к нему ходит браузер. */
function toPublicUrl(endpoint: string): URL {
	const url = new URL(endpoint);
	const publicOrigin = new URL(getConfig().OIDC_PUBLIC_URL);

	url.protocol = publicOrigin.protocol;
	url.host = publicOrigin.host;

	return url;
}

/**
 * Код из каталога → проверенные утверждения о человеке.
 *
 * `validateAuthResponse` сверяет `state` и отвергает ответ с ошибкой; обмен
 * кода проверяет подпись id-токена по ключам realm, `iss`, `aud`, `nonce` и
 * сроки. Всё, что не прошло хоть одну проверку, приезжает сюда исключением —
 * и наружу уходит отказом входа, а не половиной сессии.
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

	const url = toPublicUrl(server.end_session_endpoint);

	url.searchParams.set('id_token_hint', input.idToken);
	url.searchParams.set('post_logout_redirect_uri', input.returnTo);
	url.searchParams.set('client_id', getConfig().OIDC_CLIENT_ID);

	return url.toString();
}
