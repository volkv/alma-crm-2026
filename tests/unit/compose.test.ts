import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_KEY_PATTERN } from '$lib/server/api/keys';

/**
 * Умолчания обмена в compose-файлах.
 *
 * Значения набраны прямо в `docker-compose.yml`: их читает Docker, а не код, и
 * импортировать их неоткуда. Проверяется поэтому сам файл — в нём и живёт
 * решение. Держать проверку стоит по трём причинам: ключ, который система не
 * выпустила бы, не прошёл бы вход и стенд молчал бы об этом до первой заявки;
 * одно значение на два направления сняло бы границу между подключениями
 * (`scripts/seed/api-keys.ts`); а умолчание, доехавшее до промышленного файла,
 * означало бы установку с ключом, напечатанным в репозитории.
 */
const dev = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
const prod = readFileSync(new URL('../../docker-compose.prod.yml', import.meta.url), 'utf8');

/** Умолчания переменной во всех местах файла: `${ИМЯ:-значение}`. */
function defaults(file: string, variable: string): string[] {
	const pattern = new RegExp(`\\$\\{${variable}:-([^}]*)\\}`, 'g');

	return [...file.matchAll(pattern)].map((match) => match[1]);
}

describe('ключи обмена в docker-compose.yml', () => {
	it('подставляются двумя разными значениями того вида, который выпускает система', () => {
		const cms = defaults(dev, 'EXCHANGE_API_KEY_CMS');
		const lms = defaults(dev, 'EXCHANGE_API_KEY_LMS');

		// По два места на ключ: приложение (его читает сид) и имитатор, который
		// этим ключом представляется. Разойдись они — имитатор стучался бы в CRM
		// ключом, которого она не знает.
		expect(cms).toHaveLength(2);
		expect(lms).toHaveLength(2);
		expect(new Set(cms).size).toBe(1);
		expect(new Set(lms).size).toBe(1);

		expect(cms[0]).toMatch(API_KEY_PATTERN);
		expect(lms[0]).toMatch(API_KEY_PATTERN);
		expect(cms[0]).not.toBe(lms[0]);
	});

	it('в промышленном файле умолчаний нет вовсе', () => {
		expect(defaults(prod, 'EXCHANGE_API_KEY_CMS')).toHaveLength(0);
		expect(defaults(prod, 'EXCHANGE_API_KEY_LMS')).toHaveLength(0);

		// `?` без двоеточия: переменная обязана быть названа в `.env`
		// развёртывания, а пустое значение остаётся его решением — «ключей обмена
		// нет». Умолчание базового файла туда не доезжает.
		for (const variable of ['EXCHANGE_API_KEY_CMS', 'EXCHANGE_API_KEY_LMS']) {
			expect(prod).toContain(`\${${variable}?`);
		}
	});

	it('токен управления имитаторами обязан быть непустым', () => {
		// `:?` с двоеточием, в отличие от ключей обмена: пустой токен — это не
		// решение «управлять нечем», а снятая граница. Имитатор без токена пускает
		// к `__state`, `__scenario` и к собственному телу заявки всякого, кто до
		// него дотянулся, а на стенде страница и триггер выходят наружу.
		expect(defaults(prod, 'MOCK_CONTROL_TOKEN')).toHaveLength(0);
		expect(prod).not.toContain('${MOCK_CONTROL_TOKEN?');
		// Три места: оба имитатора и приложение — оно предъявляет токен, ставя
		// имитатору сценарий отказа с экрана «Внешние системы».
		expect(prod.match(/\$\{MOCK_CONTROL_TOKEN:\?/g)).toHaveLength(3);
	});
});

describe('пароли СУБД в docker-compose.prod.yml', () => {
	/** Строки файла без комментариев: в них живут значения, а не объяснения. */
	const lines = prod.split('\n').filter((line) => !line.trim().startsWith('#'));

	it('не набраны строкой: каждый пароль — подстановка из .env', () => {
		// Базовый файл поднимает базу с паролем `lct` — умолчание локального
		// стека. Доехав до развёртывания, оно означало бы угадываемый пароль в
		// сети compose, где рядом стоят имитаторы профиля `stand`, а в той же СУБД
		// лежит realm каталога.
		const typed = lines.filter((line) =>
			/^\s*[A-Z_]*(?:PASSWORD|SECRET_KEY):\s*(?!\$\{)\S/.test(line)
		);

		expect(typed).toStrictEqual([]);
	});

	it('требуют непустого значения — и база, и Redis, и realm каталога', () => {
		for (const variable of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD']) {
			expect(defaults(prod, variable)).toHaveLength(0);
			expect(prod).toContain(`\${${variable}:?`);
		}

		// Realm каталога лежит в той же СУБД и ходит в неё тем же пользователем:
		// второй пароль здесь означал бы стенд, который поднимается с одним
		// значением, а подключается с другим.
		expect(prod).toMatch(/KC_DB_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
	});

	it('строки подключения приложения собираются из тех же переменных', () => {
		// Набранные отдельной строкой в `.env`, они разъехались бы с паролем
		// контейнера на первой же его смене.
		expect(prod).toContain('DATABASE_URL: postgres://lct:${POSTGRES_PASSWORD:?');
		expect(prod).toContain('REDIS_URL: redis://:${REDIS_PASSWORD:?');
	});
});
