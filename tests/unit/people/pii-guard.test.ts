/**
 * Один вход к контактам человека.
 *
 * В базе почта и телефон лежат шифртекстом, а рядом с ними — ключ сравнения.
 * Обе колонки обязаны меняться одним оператором, и знать об этом обязано одно
 * место: `people/pii.ts` собирает их на запись, `people/serialize.ts`
 * расшифровывает на чтение. Стоит любому другому модулю сравнить `people.email`
 * со строкой или записать его сам — и дедупликация начнёт заводить второго того
 * же человека, а сравнение молча перестанет находить что-либо вовсе: шифртекст
 * одного и того же адреса каждый раз разный, и такой запрос не падает, а просто
 * ничего не возвращает.
 *
 * Проверка идёт по тексту файлов, как и у словаря журнала: колонку называют
 * литералом (`people.email`), и статического потребителя у этой строки нет.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = ['src/', 'scripts/'].map((relative) => `${REPO}${relative}`);

/**
 * Кому колонки контактов принадлежат: схема их объявляет, `pii.ts` собирает и
 * читает, `pii-backfill.ts` переводит в шифртекст уже лежащие значения.
 */
const OWNERS = [
	'src/lib/server/db/schema/directory.ts',
	'src/lib/server/people/pii.ts',
	'src/lib/server/people/pii-backfill.ts'
];

/**
 * Ссылка на колонку шифртекста: `people.email`, `people.phone`. Колонки ключей
 * сравнения (`people.emailHash`) под запрет не попадают — они для того и
 * заведены, чтобы по ним сравнивали снаружи.
 */
const COLUMN = /\bpeople\.(email|phone)\b/;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}${entry.name}`;

		return entry.isDirectory()
			? sourceFiles(`${path}/`)
			: /\.(ts|svelte)$/.test(entry.name)
				? [path]
				: [];
	});
}

describe('колонки контактов человека', () => {
	it('называются только там, где им положено', () => {
		const files = ROOTS.flatMap((root) => sourceFiles(root));
		expect(files.length).toBeGreaterThan(0);

		// Путь от корня репозитория: так его читают в сообщении об отказе.
		const outsiders = files
			.filter((path) => !OWNERS.includes(path.slice(REPO.length)))
			.filter((path) => COLUMN.test(readFileSync(path, 'utf8')))
			.map((path) => path.slice(REPO.length));

		expect(outsiders).toEqual([]);
	});

	it('в промышленном образе едут вместе с ключом из окружения', () => {
		const compose = readFileSync(`${REPO}docker-compose.prod.yml`, 'utf8');

		// `?` без двоеточия: переменная обязана быть названа, умолчания нет.
		// Пустой ключ означал бы установку, которая не читает ни одного контакта.
		expect(compose).toContain('PII_ENCRYPTION_KEY: ${PII_ENCRYPTION_KEY?');
	});
});
