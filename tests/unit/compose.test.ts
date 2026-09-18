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
});
