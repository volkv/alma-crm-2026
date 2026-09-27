/**
 * Конфигурация установки: какие модули в неё входят. Сам список живёт в
 * корневом `crm.config.ts`, здесь — проверка, что модули друг другу не мешают.
 *
 * Проверка идёт при загрузке конфига, то есть на сборке, на старте приложения
 * и в сиде: два модуля с одной панелью или одним шаблоном — это ошибка поставки,
 * и узнать о ней на показе карточки было бы поздно.
 */
import { CORE_PANELS } from './core-panels';
import type { ModuleManifest } from './define';

export type CrmConfig<Mods extends readonly ModuleManifest[] = readonly ModuleManifest[]> = {
	readonly modules: Mods;
};

/** Первое повторяющееся значение или `undefined`. */
function firstDuplicate(values: readonly string[]): string | undefined {
	const seen = new Set<string>();

	for (const value of values) {
		if (seen.has(value)) {
			return value;
		}

		seen.add(value);
	}

	return undefined;
}

function assertUnique(values: readonly string[], describe: (value: string) => string): void {
	const duplicate = firstDuplicate(values);

	if (duplicate !== undefined) {
		throw new Error(describe(duplicate));
	}
}

/** У шаблона или вида документа — один владелец среди модулей. */
function assertSingleOwner(
	modules: readonly ModuleManifest[],
	pick: (module: ModuleManifest) => readonly string[],
	noun: string
): void {
	const owners = new Map<string, string>();

	for (const module of modules) {
		for (const value of pick(module)) {
			const owner = owners.get(value);

			if (owner !== undefined && owner !== module.key) {
				throw new Error(`${noun} «${value}» объявляют два модуля: «${owner}» и «${module.key}»`);
			}

			owners.set(value, module.key);
		}
	}
}

export function defineConfig<const Mods extends readonly ModuleManifest[]>(config: {
	modules: Mods;
}): CrmConfig<Mods> {
	const { modules } = config;

	assertUnique(
		modules.map((module) => module.key),
		(key) => `Модуль «${key}» подключён в конфиге дважды`
	);

	// Панели хранятся в процессе одним списком ключей, без имени модуля, поэтому
	// ключ панели уникален на всю установку, вместе с панелями ядра.
	assertUnique(
		[
			...CORE_PANELS.map((panel) => panel.key),
			...modules.flatMap((module) => module.panels.map((panel) => panel.key))
		],
		(key) => `Панель карточки «${key}» объявлена дважды`
	);

	for (const module of modules) {
		assertUnique(
			module.headerFacts.map((fact) => fact.key),
			(key) => `Модуль «${module.key}»: факт шапки «${key}» объявлен дважды`
		);
		assertUnique(
			module.cardActions.map((action) => action.key),
			(key) => `Модуль «${module.key}»: действие «${key}» объявлено дважды`
		);
		assertUnique(
			module.sections.map((section) => section.key),
			(key) => `Модуль «${module.key}»: пункт меню «${key}» объявлен дважды`
		);
	}

	assertSingleOwner(modules, (module) => module.documents.templates, 'Шаблон документа');
	assertSingleOwner(modules, (module) => module.documents.kinds, 'Вид документа');

	return Object.freeze({ modules });
}
