import * as oauth from 'oauth4webapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_EMAILS } from '../../../scripts/seed/users';
import { decodeJwtPayload, startTestKeycloak, type TestKeycloak } from '../helpers/keycloak';

/**
 * Каталог учётных записей: realm из `keycloak/realm-lct.json` поднимается
 * контейнером и проверяется снаружи — метаданными OIDC и выданными токенами.
 *
 * Вход приложения пока свой, поэтому здесь проверяется не он, а то, на чём он
 * будет стоять: realm читается, демонстрационные учётные записи заведены с теми
 * же почтами, что и в базе (по ним свяжутся записи при первом входе, —
 * docs/access-matrix.md, раздел 6), роль приезжает в токен, а неверный пароль
 * получает отказ.
 */
describe('каталог учётных записей Keycloak', () => {
	let keycloak: TestKeycloak;

	beforeAll(async () => {
		keycloak = await startTestKeycloak();
	}, 300_000);

	afterAll(async () => {
		await keycloak?.stop();
	});

	it('отдаёт метаданные realm с обязательным PKCE S256', async () => {
		const response = await fetch(`${keycloak.issuerUrl()}/.well-known/openid-configuration`);

		expect(response.status).toBe(200);

		const metadata = (await response.json()) as {
			issuer: string;
			authorization_endpoint: string;
			token_endpoint: string;
			code_challenge_methods_supported: string[];
			grant_types_supported: string[];
		};

		expect(metadata.issuer).toBe(keycloak.issuerUrl());
		expect(metadata.authorization_endpoint).toBe(
			`${keycloak.issuerUrl()}/protocol/openid-connect/auth`
		);
		expect(metadata.token_endpoint).toBe(`${keycloak.issuerUrl()}/protocol/openid-connect/token`);
		expect(metadata.code_challenge_methods_supported).toContain('S256');
		expect(metadata.grant_types_supported).toContain('authorization_code');
	});

	it('выдаёт токены демонстрационному менеджеру и кладёт в них роль realm', async () => {
		const tokens = await keycloak.passwordGrantToken('manager', keycloak.demoPassword);

		// Access-токен: роль приезжает областью `roles`, которая у клиента по
		// умолчанию. Срок — из настроек realm, пять минут; точное значение не
		// проверяем строгим равенством, потому что каталог считает `expires_in`
		// от момента выпуска токена, а между выпуском и получением ответа в тесте
		// проходит время — допускаем разброс в несколько секунд.
		const access = decodeJwtPayload(tokens.accessToken);
		expect(access.realm_access).toEqual({ roles: ['crm-user'] });
		expect(tokens.expiresIn).toBeGreaterThan(290);
		expect(tokens.expiresIn).toBeLessThanOrEqual(300);

		// Id-токен: ту же роль кладёт отображение, объявленное на клиенте
		// приложения. Без него приложению пришлось бы ходить за ролью отдельным
		// запросом на каждый вход.
		const id = decodeJwtPayload(tokens.idToken);
		expect(id.realm_access).toEqual({ roles: ['crm-user'] });

		// Почта — ключ связывания с уже заведённой учётной записью, и связывание
		// принимает только подтверждённую.
		expect(id.email).toBe(DEMO_EMAILS.manager);
		expect(id.email_verified).toBe(true);
		expect(id.preferred_username).toBe('manager');
		expect(id.name).toBe('Менеджер Демо');
		expect(typeof id.sub).toBe('string');
	});

	it('выдаёт руководителю и администратору их собственные роли', async () => {
		const lead = await keycloak.passwordGrantToken('lead', keycloak.demoPassword);
		const admin = await keycloak.passwordGrantToken('admin', keycloak.demoPassword);

		expect(decodeJwtPayload(lead.idToken).realm_access).toEqual({ roles: ['crm-lead'] });
		expect(decodeJwtPayload(lead.idToken).email).toBe(DEMO_EMAILS.lead);
		expect(decodeJwtPayload(admin.idToken).realm_access).toEqual({ roles: ['crm-admin'] });
		expect(decodeJwtPayload(admin.idToken).email).toBe(DEMO_EMAILS.admin);
	});

	it('проверяет подпись своего же id-токена опубликованными ключами realm', async () => {
		// Вход проверяет подпись отдельным вызовом библиотеки по `jwks_uri`
		// (`src/lib/server/auth/oidc.ts`). Здесь тот же вызов встречается с
		// настоящими ключами realm: подделка в модульном тесте доказывает, что
		// чужой ключ не проходит, а это — что свой проходит.
		const tokens = await keycloak.passwordGrantToken('manager', keycloak.demoPassword);
		const clientId = decodeJwtPayload(tokens.idToken).aud;

		expect(typeof clientId).toBe('string');

		const server = await oauth.processDiscoveryResponse(
			new URL(keycloak.issuerUrl()),
			await fetch(`${keycloak.issuerUrl()}/.well-known/openid-configuration`)
		);

		// Библиотека помнит разобранный токен по самому ответу, поэтому проверке
		// подписи отдаётся тот же `Response`, что и разбору утверждений.
		const response = (): Response =>
			new Response(
				JSON.stringify({
					access_token: tokens.accessToken,
					token_type: 'Bearer',
					id_token: tokens.idToken
				}),
				{ headers: { 'content-type': 'application/json' } }
			);

		const transport = { [oauth.allowInsecureRequests]: true } as const;
		const accepted = response();

		await oauth.processAuthorizationCodeResponse(
			server,
			{ client_id: clientId as string },
			accepted,
			// Прямой грант заходом в браузере не сопровождается, и `nonce` в
			// токене нет; всё остальное проверяется как при входе.
			{ expectedNonce: oauth.expectNoNonce, requireIdToken: true, ...transport }
		);

		await expect(
			oauth.validateApplicationLevelSignature(server, accepted, transport)
		).resolves.toBeUndefined();
	});

	it('отказывает по неверному паролю', async () => {
		await expect(keycloak.passwordGrantToken('manager', 'не тот пароль')).rejects.toThrow(
			/invalid_grant/
		);
	});
});
