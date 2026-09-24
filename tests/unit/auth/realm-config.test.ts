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

type Execution = {
	authenticator?: string;
	authenticatorConfig?: string;
	flowAlias?: string;
	requirement: string;
};

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(new URL(`../../../keycloak/${file}`, import.meta.url), 'utf8'));
}

const realm = readJson('realm-lct.json') as {
	passwordPolicy: string;
	bruteForceProtected: boolean;
	permanentLockout: boolean;
	failureFactor: number;
	waitIncrementSeconds: number;
	maxFailureWaitSeconds: number;
	clients: { clientId: string; redirectUris: string[] }[];
	users?: unknown[];
	groups: { name: string; path: string; attributes?: Record<string, string[]> }[];
	browserFlow: string;
	authenticationFlows: { alias: string; authenticationExecutions: Execution[] }[];
	authenticatorConfig: { alias: string; config: Record<string, string> }[];
};

/** Демонстрационные записи — отдельным файлом: установка без демо его не монтирует. */
const demo = readJson('demo-users.json') as {
	realm: string;
	users: { id?: string; username: string; groups?: string[]; credentials: { value: string }[] }[];
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
	/**
	 * `id` пользователя Keycloak — это `sub` его токенов, а `sub` — ключ, которым
	 * приложение связывает запись каталога со своей (`users.external_subject`).
	 * Без `id` в файле Keycloak выдаёт новый UUID на каждом импорте, то есть на
	 * каждом пересоздании контейнера, и те же люди приезжают неузнанными: вход
	 * отклоняется с «ваша почта уже числится за другой учётной записью системы»,
	 * а отвязать их может только администратор — под которого тоже надо войти.
	 *
	 * Проверка стоит здесь, потому что пропажа `id` ничего не ломает ни в
	 * импорте, ни в первом входе: она видна вторым входом после пересоздания
	 * контейнера, то есть в чужой день и на чужой машине.
	 */
	it('у демонстрационных записей постоянные идентификаторы', () => {
		const ids = demo.users.map((user) => {
			expect(user.id, `у записи «${user.username}» нет id`).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
			);

			return user.id;
		});

		// Один и тот же id у двух записей импорт принял бы не целиком.
		expect(new Set(ids).size).toBe(demo.users.length);
	});

	it('общий пароль демонстрации отвечает политике самого realm', () => {
		const policy = realm.passwordPolicy;
		const length = requiredLength(policy);

		// Пароль стенда публичный (`README.md`, `docs/security.md`): его набирают
		// с экрана зрители показа. Но политика realm остаётся политикой — пароль,
		// который ей не отвечает, импорт примет, а сменить его потом можно будет
		// только в консоли.
		expect(policy).toContain('notUsername');

		for (const user of demo.users) {
			const password = substitutionDefault(user.credentials[0].value);

			expect(password.length).toBeGreaterThanOrEqual(length);
			expect(password).not.toBe(user.username);
		}

		// Пароль у всех трёх один: карточка на странице входа показывает его
		// одной строкой на три учётные записи.
		const passwords = new Set(demo.users.map((user) => user.credentials[0].value));

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

	/**
	 * Второй фактор обязателен штатным `crm-admin` и `crm-lead` и не нужен
	 * демонстрационным записям стенда. Обе половины живут в файле realm и видны
	 * только входом через поднятый каталог, поэтому разбираются здесь: снятое
	 * условие по роли открыло бы вход администратору по одному паролю, а
	 * пропавшее исключение группы `demo` закрыло бы показ всем зрителям.
	 */
	it('одноразовый код обязателен штатным crm-admin и crm-lead, группе demo — нет', () => {
		const flows = new Map(realm.authenticationFlows.map((flow) => [flow.alias, flow]));
		const configs = new Map(realm.authenticatorConfig.map((item) => [item.alias, item.config]));
		const top = flows.get(realm.browserFlow);

		expect(top, `поток входа «${realm.browserFlow}» не описан в realm`).toBeDefined();

		/** Все исполнения потока вместе с вложенными, по ссылкам `flowAlias`. */
		const branches = (alias: string): Execution[][] =>
			(flows.get(alias)?.authenticationExecutions ?? []).flatMap((item) =>
				item.flowAlias === undefined
					? []
					: [flows.get(item.flowAlias)?.authenticationExecutions ?? [], ...branches(item.flowAlias)]
			);

		const conditionOf = (branch: Execution[], authenticator: string) =>
			branch
				.filter(
					(item) => item.authenticator === authenticator && item.authenticatorConfig !== undefined
				)
				.map((item) => configs.get(item.authenticatorConfig as string) ?? {});

		for (const role of ['crm-admin', 'crm-lead']) {
			const branch = branches(realm.browserFlow).find((items) =>
				conditionOf(items, 'conditional-user-role').some(
					(config) => config.condUserRole === role && config.negate !== 'true'
				)
			);

			expect(branch, `нет ветки второго фактора для ${role}`).toBeDefined();
			expect(
				branch?.find((item) => item.authenticator === 'auth-otp-form')?.requirement,
				`ветка ${role} не требует одноразового кода`
			).toBe('REQUIRED');

			// Исключение — только признак группы, и в этой ветке оно отрицается.
			const exempt = conditionOf(branch ?? [], 'conditional-user-attribute');

			expect(exempt).toContainEqual(
				expect.objectContaining({
					attribute_name: 'otp-exempt',
					attribute_expected_value: 'true',
					include_group_attributes: 'true',
					not: 'true'
				})
			);
		}

		const group = realm.groups.find((item) => item.name === 'demo');

		expect(group?.attributes?.['otp-exempt']).toEqual(['true']);
		// В файле realm нет ни одной учётной записи: иначе установка без демо
		// получила бы их вместе с realm.
		expect(realm.users ?? []).toHaveLength(0);
		expect(demo.realm).toBe('lct');

		for (const user of demo.users) {
			expect(user.groups, `«${user.username}» вне группы demo`).toContain('/demo');
		}
	});
});
