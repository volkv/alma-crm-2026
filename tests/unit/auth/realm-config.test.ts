import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Файл импорта realm читается как данные.
 *
 * Проверять здесь есть что: `docker compose config` в этот файл не заглядывает,
 * а Keycloak разбирает его уже внутри контейнера — опечатка в нём видна только
 * поднятым стендом, то есть через полторы минуты и на чужой машине. Поэтому
 * разбор JSON и те три решения, которые приняты про демонстрационный стенд,
 * закрыты проверкой, а не договорённостью.
 */

const realm = JSON.parse(
	readFileSync(new URL('../../../keycloak/realm-lct.json', import.meta.url), 'utf8')
) as {
	passwordPolicy: string;
	bruteForceProtected: boolean;
	permanentLockout: boolean;
	failureFactor: number;
	waitIncrementSeconds: number;
	maxFailureWaitSeconds: number;
	clients: { clientId: string; redirectUris: string[] }[];
	users: { username: string; credentials: { value: string }[] }[];
};

/** Значение подстановки `${VAR:умолчание}` — то, с чем realm поднимается локально. */
function substitutionDefault(value: string): string {
	const match = /^\$\{[A-Z_]+:(.*)\}$/.exec(value);

	expect(match, `«${value}» — не подстановка вида \${VAR:умолчание}`).not.toBeNull();

	return match?.[1] ?? '';
}

/** Минимальная длина пароля, которую требует политика realm. */
function requiredLength(policy: string): number {
	const match = /length\((\d+)\)/.exec(policy);

	expect(match, `в политике «${policy}» нет правила length(N)`).not.toBeNull();

	return Number(match?.[1]);
}

describe('realm каталога учётных записей', () => {
	it('общий пароль демонстрации отвечает политике самого realm', () => {
		const policy = realm.passwordPolicy;
		const length = requiredLength(policy);

		// Пароль стенда публичный (`README.md`, `docs/security.md`): его набирают
		// с экрана зрители показа. Но политика realm остаётся политикой — пароль,
		// который ей не отвечает, импорт примет, а сменить его потом можно будет
		// только в консоли.
		expect(policy).toContain('notUsername');

		for (const user of realm.users) {
			const password = substitutionDefault(user.credentials[0].value);

			expect(password.length).toBeGreaterThanOrEqual(length);
			expect(password).not.toBe(user.username);
		}

		// Пароль у всех трёх один: карточка на странице входа показывает его
		// одной строкой на три учётные записи.
		const passwords = new Set(realm.users.map((user) => user.credentials[0].value));

		expect(passwords.size).toBe(1);
	});

	it('защита от перебора включена, но не запирает стенд на четверть часа', () => {
		// Стенд общий и публичный: зрители входят с одного адреса и ошибаются в
		// пароле по очереди. Пятнадцатиминутная пауза (умолчание Keycloak) в этих
		// условиях закрывает вход всем сразу, поэтому потолок паузы — минута, а
		// порог поднят. Защита при этом остаётся: подбор упирается в неё же.
		expect(realm.bruteForceProtected).toBe(true);
		expect(realm.permanentLockout).toBe(false);
		expect(realm.failureFactor).toBeGreaterThanOrEqual(30);
		expect(realm.maxFailureWaitSeconds).toBeLessThanOrEqual(60);
		expect(realm.waitIncrementSeconds).toBeLessThanOrEqual(realm.maxFailureWaitSeconds);
	});

	it('адреса возврата покрывают порты параллельных прогонов e2e', () => {
		const client = realm.clients.find((item) => item.clientId === 'lct-crm');

		expect(client).toBeDefined();

		const uris = client?.redirectUris ?? [];

		// `E2E_PORT` выбирается из этого списка и ниоткуда больше: адрес возврата,
		// которого нет в realm, каталог разворачивает — прогон падает на входе, а
		// причина видна только в логе Keycloak (`docs/development.md`).
		for (const port of [4173, 4174, 4175, 4176, 4177]) {
			expect(uris).toContain(`http://localhost:${port}/*`);
		}

		expect(uris).toContain('http://localhost:5173/*');
		expect(uris.some((uri) => uri.startsWith('${CRM_ORIGIN'))).toBe(true);
	});
});
