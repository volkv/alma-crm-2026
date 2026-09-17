import { describe, expect, it } from 'vitest';
import { rebaseEndpoint } from '$lib/server/auth/oidc';

/**
 * Каталог называет себя одним адресом, а сервер достаёт его другим.
 *
 * Публичный адрес — то, что видит браузер и чем каталог подписывается в `iss`;
 * внутренний — то, по чему до него достаёт приложение из своей сети. Перенос
 * касается только серверных запросов (метаданные, ключи, обмен кода); проверка
 * `iss` остаётся по публичному имени, поэтому подмена основания обязана быть
 * ровно подменой основания, а не «похожим адресом».
 */
describe('перенос адреса каталога на внутреннее основание', () => {
	it('меняет основание, сохраняя путь и строку запроса', () => {
		expect(
			rebaseEndpoint(
				'http://localhost:58080/realms/lct/protocol/openid-connect/token',
				'http://localhost:58080',
				'http://keycloak:8080'
			)
		).toBe('http://keycloak:8080/realms/lct/protocol/openid-connect/token');
	});

	it('переносит и установку с относительным путём', () => {
		// На стенде Keycloak стоит за nginx на `/auth`, и внутреннее основание
		// обязано нести тот же путь — иначе запрос уедет в корень контейнера.
		expect(
			rebaseEndpoint(
				'https://crm.example.org/auth/realms/lct/.well-known/openid-configuration',
				'https://crm.example.org/auth',
				'http://keycloak:8080/auth'
			)
		).toBe('http://keycloak:8080/auth/realms/lct/.well-known/openid-configuration');
	});

	it('оставляет адрес как есть, когда основания совпадают', () => {
		const endpoint = 'https://crm.example.org/auth/realms/lct/protocol/openid-connect/certs';

		expect(
			rebaseEndpoint(endpoint, 'https://crm.example.org/auth', 'https://crm.example.org/auth')
		).toBe(endpoint);
	});

	it('отказывается переносить адрес, который не начинается с публичного', () => {
		// Так выглядит расхождение настройки: каталог называет себя не тем
		// именем, которое объявлено публичным. Молча подставить внутреннее
		// основание значило бы отправить запрос неизвестно куда.
		expect(() =>
			rebaseEndpoint(
				'http://keycloak:8080/realms/lct/protocol/openid-connect/token',
				'http://localhost:58080',
				'http://keycloak:8080'
			)
		).toThrowError(/OIDC_PUBLIC_URL/);
	});
});
