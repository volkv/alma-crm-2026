/**
 * Граница модульной архитектуры против кода, который её может нарушить.
 *
 * Модуль (`src/modules/<key>/**`, кастомные — `src/modules/custom/<key>/**`)
 * общается с ядром только через фасад `$lib/platform/**` и общий словарь
 * `$lib/contracts/**`. Всё остальное — включая другой модуль и внутренности
 * ядра — модулю недоступно: иначе его нельзя было бы подключить, отключить
 * или поставить отдельно. ESLint (`eslint.config.js`) ловит часть этого при
 * линте изменённых файлов, но не два свойства, которые важны для всего
 * дерева сразу: (1) относительные импорты не должны выходить за пределы
 * папки своего модуля, и (2) «чистая цепочка» — манифесты и ядро платформы,
 * которые сборка семян (`scripts/seed/aliases.ts`) исполняет обычным Node, —
 * не должна тянуть за собой Svelte, `import.meta.glob` или `enum` (раздел 0
 * плана модулей: без этого сид на стенде и в e2e падает).
 *
 * Проверка идёт по тексту файлов, а не по типам: часть перечисленных здесь
 * файлов создаёт другая, ещё не выполненная задача, и до тех пор пропускается
 * через `existsSync`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = `${ROOT}src/`;
const MODULES_DIR = `${SRC}modules/`;

/** Читает файлы `.ts`/`.svelte` рекурсивно; отсутствующий каталог — пустой список. */
function sourceFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];

	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);

		if (entry.isDirectory()) return sourceFiles(entryPath);

		return /\.(ts|svelte)$/.test(entry.name) ? [entryPath] : [];
	});
}

/** Каталоги отдельных модулей: `src/modules/<key>` и `src/modules/custom/<key>`. */
function moduleDirs(): string[] {
	if (!existsSync(MODULES_DIR)) return [];

	return readdirSync(MODULES_DIR, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isDirectory()) return [];

		if (entry.name === 'custom') {
			const customDir = path.join(MODULES_DIR, 'custom');
			return readdirSync(customDir, { withFileTypes: true }).flatMap((custom) =>
				custom.isDirectory() ? [path.join(customDir, custom.name)] : []
			);
		}

		return [path.join(MODULES_DIR, entry.name)];
	});
}

/**
 * Убирает комментарии, оставляя строки как есть (в них живут спецификаторы
 * импорта). Без этого прозаическое упоминание запрета в комментарии — здесь
 * такие есть буквально, файлы описывают сами себя — читалось бы как нарушение.
 */
function stripComments(source: string): string {
	let out = '';
	let i = 0;

	while (i < source.length) {
		const char = source[i];

		if (char === '"' || char === "'" || char === '`') {
			let j = i + 1;
			while (j < source.length && source[j] !== char) {
				j += source[j] === '\\' ? 2 : 1;
			}
			out += source.slice(i, j + 1);
			i = j + 1;
			continue;
		}

		if (source.startsWith('//', i)) {
			const end = source.indexOf('\n', i);
			i = end === -1 ? source.length : end;
			continue;
		}

		if (source.startsWith('/*', i)) {
			const end = source.indexOf('*/', i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}

		out += char;
		i++;
	}

	return out;
}

/** Специфструкторы `from '...'` и `import('...')`, включая `export … from`. */
function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const code = stripComments(source);
	const patterns = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g];

	for (const pattern of patterns) {
		for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
	}

	return specifiers;
}

/** Уходит ли относительный импорт файла за пределы каталога `moduleDir`. */
function escapesModule(filePath: string, moduleDir: string, specifier: string): boolean {
	if (!specifier.startsWith('.')) return false;

	const resolved = path.resolve(path.dirname(filePath), specifier);
	const relative = path.relative(moduleDir, resolved);

	return relative === '..' || relative.startsWith(`..${path.sep}`);
}

describe('граница модуля: относительные импорты', () => {
	it('не выходят за пределы папки своего модуля', () => {
		const offenders: string[] = [];

		for (const dir of moduleDirs()) {
			for (const file of sourceFiles(dir)) {
				const source = readFileSync(file, 'utf8');

				for (const specifier of importSpecifiers(source)) {
					if (escapesModule(file, dir, specifier)) {
						offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
					}
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it('не обращаются к $lib/server — внутренности ядра модулю не видны', () => {
		const offenders: string[] = [];

		for (const dir of moduleDirs()) {
			for (const file of sourceFiles(dir)) {
				const source = readFileSync(file, 'utf8');

				for (const specifier of importSpecifiers(source)) {
					if (specifier === '$lib/server' || specifier.startsWith('$lib/server/')) {
						offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
					}
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});

describe('чистая цепочка (сид исполняет её обычным Node)', () => {
	/**
	 * `crm.config.ts`, манифесты модулей и ядро платформы, от которого они
	 * зависят. У кастомных модулей манифест — тоже часть цепочки: заказчик
	 * подключает свой модуль той же строкой в `crm.config.ts`.
	 */
	function cleanChainFiles(): string[] {
		const platform = ['define.ts', 'config.ts', 'core-panels.ts', 'registry.ts'].map(
			(name) => `${SRC}lib/platform/${name}`
		);
		const manifests = moduleDirs().map((dir) => path.join(dir, 'index.ts'));

		return [
			`${ROOT}crm.config.ts`,
			...manifests,
			...platform,
			`${SRC}lib/contracts/process-card.ts`
		].filter((file) => existsSync(file));
	}

	it('не импортирует .svelte', () => {
		const offenders: string[] = [];

		for (const file of cleanChainFiles()) {
			for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
				if (specifier.endsWith('.svelte')) {
					offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it('не использует import.meta.glob', () => {
		const offenders = cleanChainFiles().filter((file) =>
			stripComments(readFileSync(file, 'utf8')).includes('import.meta.glob')
		);

		expect(offenders).toEqual([]);
	});

	it('не использует enum', () => {
		const offenders = cleanChainFiles().filter((file) =>
			/\benum\s+\w/.test(stripComments(readFileSync(file, 'utf8')))
		);

		expect(offenders).toEqual([]);
	});
});
