/**
 * Настоящий Keycloak для интеграционных тестов.
 *
 * Контейнер поднимается на файл тестов, а не прогоном, как PostgreSQL, Redis и
 * MinIO: каталог нужен одному файлу, и платить его подъёмом за каждый прогон,
 * который до этого файла не дойдёт, незачем. Заглушка здесь не годится совсем:
 * проверяется ровно то, что отдаёт каталог — состав realm, роли в токене, отказ
 * по неверному паролю, — и подделка проверяла бы подделку.
 *
 * Realm берётся из `keycloak/realm-lct.json`, того же файла, которым поднимается
 * стенд: тест обязан видеть тот самый realm, а не его копию, которая разойдётся
 * с ним на первой правке. Пароли и секрет клиента realm-файл читает из окружения
 * (`${VAR:умолчание}` разворачивается при импорте), поэтому здесь они свои.
 *
 * Отличие ровно одно и оно объявлено ниже: к импорту добавляется клиент
 * `lct-crm-tests` с Direct Access Grants. Приложению этот поток не нужен и на
 * стенде его быть не должно — пароль в обмен на токен обходит и PKCE, и страницу
 * входа, — а тесту нужен способ получить токен без браузера.
 */
import { readFileSync } from 'node:fs';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/** Тот же образ, что в `docker-compose.yml`: тесты и стенд ходят в одну версию. */
const IMAGE = 'quay.io/keycloak/keycloak:26.7.4';

const REALM = 'lct';
const REALM_FILE = new URL('../../../keycloak/realm-lct.json', import.meta.url);
const IMPORT_PATH = '/opt/keycloak/data/import/realm-lct.json';

/** Клиент приложения; его же копия — клиент тестов. */
const APP_CLIENT_ID = 'lct-crm';
const TEST_CLIENT_ID = 'lct-crm-tests';

/**
 * Пароль демонстрационных учётных записей в этом прогоне. Нарочно не тот, что
 * стоит умолчанием в realm-файле: если подстановка окружения при импорте
 * перестанет работать, тест это увидит, а не разойдётся с реальностью молча.
 */
const DEMO_PASSWORD = 'Keycloak-Test-Password-2026!';

/** Минимум структуры realm-файла, который нужен помощнику. */
type RealmClient = { clientId: string } & Record<string, unknown>;
type RealmExport = { clients: RealmClient[] } & Record<string, unknown>;

export type TestTokens = {
	accessToken: string;
	idToken: string;
	/** Сколько секунд живёт access-токен по ответу самого Keycloak. */
	expiresIn: number;
};

export type TestKeycloak = {
	/** Адрес realm: `<issuer>/.well-known/openid-configuration` — его метаданные. */
	issuerUrl: () => string;
	/** Пароль демонстрационных учётных записей этого прогона. */
	demoPassword: string;
	/**
	 * Токены по паре «учётная запись и пароль» (Direct Access Grants клиента
	 * тестов). Отказ каталога — исключение с кодом ошибки OAuth в тексте: в
	 * тесте, который не про отказ, молча продолжать не с чем.
	 */
	passwordGrantToken: (username: string, password: string) => Promise<TestTokens>;
	stop: () => Promise<void>;
};

/** Полезная нагрузка JWT без проверки подписи: подпись проверяет приложение, не тест. */
export function decodeJwtPayload(token: string): Record<string, unknown> {
	const part = token.split('.')[1];

	if (part === undefined) {
		throw new Error('Это не JWT: в токене нет второй части');
	}

	return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Realm приложения плюс клиент тестов: копия клиента приложения с паролем вместо кода. */
function realmWithTestClient(): string {
	const realm = JSON.parse(readFileSync(REALM_FILE, 'utf8')) as RealmExport;
	const appClient = realm.clients.find((client) => client.clientId === APP_CLIENT_ID);

	if (appClient === undefined) {
		throw new Error(`В realm-файле нет клиента «${APP_CLIENT_ID}»`);
	}

	// Копия, а не своя запись: отображение ролей в токен задано на клиенте
	// приложения, и тест обязан проверять именно её. Меняется только способ
	// получить токен.
	const testClient: RealmClient = {
		...structuredClone(appClient),
		clientId: TEST_CLIENT_ID,
		name: TEST_CLIENT_ID,
		description: 'Direct Access Grants для интеграционных тестов',
		publicClient: true,
		standardFlowEnabled: false,
		directAccessGrantsEnabled: true,
		redirectUris: [],
		webOrigins: []
	};
	delete testClient.secret;

	realm.clients.push(testClient);

	return JSON.stringify(realm);
}

export async function startTestKeycloak(): Promise<TestKeycloak> {
	const container: StartedTestContainer = await new GenericContainer(IMAGE)
		.withCommand(['start-dev', '--import-realm'])
		.withEnvironment({
			KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
			KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
			// Готовность контейнера видна на management-порту и по умолчанию выключена.
			KC_HEALTH_ENABLED: 'true',
			// Подстановки realm-файла.
			KEYCLOAK_DEMO_PASSWORD: DEMO_PASSWORD,
			OIDC_CLIENT_SECRET: 'keycloak-test-client-secret',
			CRM_ORIGIN: 'http://localhost:4173'
		})
		.withCopyContentToContainer([{ content: realmWithTestClient(), target: IMPORT_PATH }])
		.withExposedPorts(8080, 9000)
		.withWaitStrategy(Wait.forHttp('/health/ready', 9000).forStatusCode(200))
		.withStartupTimeout(180_000)
		.start();

	const issuer = `http://${container.getHost()}:${container.getMappedPort(8080)}/realms/${REALM}`;

	return {
		issuerUrl: () => issuer,
		demoPassword: DEMO_PASSWORD,
		passwordGrantToken: async (username, password) => {
			const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'password',
					client_id: TEST_CLIENT_ID,
					scope: 'openid',
					username,
					password
				})
			});

			const body = (await response.json()) as {
				access_token?: string;
				id_token?: string;
				expires_in?: number;
				error?: string;
				error_description?: string;
			};

			if (!response.ok) {
				throw new Error(
					`Keycloak отказал в токене (${response.status}): ${body.error ?? 'без кода'} — ${body.error_description ?? 'без описания'}`
				);
			}

			if (body.access_token === undefined || body.id_token === undefined) {
				throw new Error('Keycloak вернул ответ без токенов');
			}

			return {
				accessToken: body.access_token,
				idToken: body.id_token,
				expiresIn: body.expires_in ?? 0
			};
		},
		stop: async () => {
			await container.stop();
		}
	};
}
