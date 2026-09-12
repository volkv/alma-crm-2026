/**
 * Разрешение импортов кода приложения за пределами сборки.
 *
 * Скрипты пользуются схемой базы, каталогом прав, контрактами и хешированием
 * паролей из `src/lib`, но запускаются обычным процессом Node, а не через Vite.
 * Vite понимает две вещи, которых в Node нет: специи SvelteKit (`$lib/…`,
 * `$env/dynamic/private`) и импорт без расширения (`./api`, `../db/schema`).
 * Оба правила объявлены здесь явно, синхронными хуками модулей, — это дешевле,
 * чем собирать ради скрипта второй бандл, и честнее, чем держать копию схемы
 * рядом с ним.
 *
 * Хуки ставятся до загрузки первого модуля с такими импортами, поэтому и вход
 * сида (`scripts/seed/index.ts`), и миграция (`scripts/migrate.ts`) зовут
 * `installKitAliases()` и лишь затем подтягивают код приложения динамическим
 * импортом.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const LIB_PREFIX = '$lib/';
const ENV_SPECIFIER = '$env/dynamic/private';

const libRoot = new URL('../../src/lib/', import.meta.url);
const envStandIn = new URL('./env.ts', import.meta.url);

/** Модуль — это либо файл `<путь>.ts`, либо каталог с `index.ts`. */
function findModule(base: URL): string | undefined {
	for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
		if (existsSync(fileURLToPath(candidate))) {
			return candidate;
		}
	}

	return undefined;
}

function resolveLib(specifier: string): string {
	const found = findModule(new URL(specifier.slice(LIB_PREFIX.length), libRoot));

	if (found === undefined) {
		throw new Error(
			`Не удалось разрешить «${specifier}» относительно ${fileURLToPath(libRoot)}: нет ни файла, ни каталога с index.ts`
		);
	}

	return found;
}

export function installKitAliases(): void {
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === ENV_SPECIFIER) {
				return { url: envStandIn.href, shortCircuit: true };
			}

			if (specifier.startsWith(LIB_PREFIX)) {
				return { url: resolveLib(specifier), shortCircuit: true };
			}

			// Импорт без расширения. Если рядом нет подходящего файла — молчим и
			// отдаём специю дальше: ошибку про ненайденный модуль должен писать
			// сам Node, а не этот хук.
			if (
				(specifier.startsWith('./') || specifier.startsWith('../')) &&
				context.parentURL !== undefined &&
				!/\.[a-z]+$/i.test(specifier)
			) {
				const found = findModule(new URL(specifier, context.parentURL));

				if (found !== undefined) {
					return { url: found, shortCircuit: true };
				}
			}

			return nextResolve(specifier, context);
		}
	});
}
