/**
 * Каталоги пункта чек-листа: чем пункт проверяется и какое действие стоит рядом.
 *
 * Пункт чек-листа закрывают двумя способами. Ручной пункт отмечает человек —
 * «отправил описание программ», «сверил реквизиты»: система этого не видит и
 * изображать проверку не должна. Пункт-факт закрывают данные дела — выбранное
 * подразделение, записанный результат, поток в системе обучения, приложенный
 * документ, — и галочка его не заменяет. Способы проверки — закрытый список
 * правил ниже, а не язык условий: каждое правило читает свои данные одним
 * серверным механизмом (`$lib/server/stages/facts`), и процесс выбирает правило
 * по ключу.
 *
 * Действие рядом с пунктом — отдельная вещь: кнопка открывает форму карточки,
 * где делают работу, но пункт не закрывает. Закрывает сохранённый факт или
 * человек.
 *
 * Правило принадлежит ядру или модулю: правило модуля читает данные, которые
 * живут в карточке, пока модуль действует (потоки, договор с позициями,
 * оплата), и процесс, выбравший его, делает модуль нужным стадии
 * (`requiredModules` в `registry.ts`). Действия модулей — их `cardActions`.
 *
 * Чистый файл без Svelte и без серверных зависимостей: каталог читают контракт
 * процесса, редактор, карточка, сид и миграция.
 */
import { CHECKLIST_RULES, type ChecklistRuleSpec } from './checklist-rules';
import { INSTALLED_MODULES, isModuleKey } from './registry';

/** Правила, которые предлагает редактор: ядра и установленных модулей. */
export function offeredChecklistRules(): ChecklistRuleSpec[] {
	return CHECKLIST_RULES.filter((rule) => rule.module === null || isModuleKey(rule.module));
}

export type ChecklistActionSpec = {
	readonly key: string;
	/** Подпись кнопки у пункта. */
	readonly label: string;
	/** Чьё действие: ядра (`null`) или модуля — без него кнопки у пункта нет. */
	readonly module: string | null;
};

/**
 * Действия ядра. Каждое открывает форму карточки, в которой делают работу по
 * пункту, либо раскрывает панель стороны: контакт, подразделение и канал связи
 * правятся там.
 */
const CORE_ACTIONS = [
	{ key: 'result', label: 'Записать результат', module: null },
	{ key: 'confirm', label: 'Подтвердить стадию', module: null },
	{ key: 'upload', label: 'Приложить файл', module: null },
	{ key: 'mark', label: 'Отметить документ', module: null },
	{ key: 'package', label: 'Собрать пакет документов', module: null },
	{ key: 'plan', label: 'Изменить план', module: null },
	{ key: 'contract', label: 'Выбрать договор и позиции', module: 'contracts' },
	{ key: 'party', label: 'Открыть сторону', module: null },
	{ key: 'send_group', label: 'Заявить поток', module: 'learning' },
	{ key: 'complete_group', label: 'Отметить завершение обучения', module: 'learning' }
] as const satisfies readonly ChecklistActionSpec[];

export type CoreChecklistActionKey = (typeof CORE_ACTIONS)[number]['key'];

/** Ключ действия модуля у пункта: `<модуль>:<действие>`, как в `cardActions`. */
export function moduleActionKey(module: string, action: string): string {
	return `${module}:${action}`;
}

/** Все действия: ядра и установленных модулей, в порядке конфига. */
export const CHECKLIST_ACTIONS: readonly ChecklistActionSpec[] = [
	...CORE_ACTIONS,
	...INSTALLED_MODULES.flatMap((module) =>
		module.cardActions.map((action): ChecklistActionSpec => ({
			key: moduleActionKey(module.key, action.key),
			label: action.label,
			module: module.key
		}))
	)
];

export const CHECKLIST_ACTION_KEYS = CHECKLIST_ACTIONS.map(
	(action) => action.key
) as unknown as readonly [string, ...string[]];

const ACTIONS_BY_KEY = new Map<string, ChecklistActionSpec>(
	CHECKLIST_ACTIONS.map((action) => [action.key, action])
);

/** Действия, которые предлагает редактор: ядра и установленных модулей. */
export function offeredChecklistActions(): ChecklistActionSpec[] {
	return CHECKLIST_ACTIONS.filter((action) => action.module === null || isModuleKey(action.module));
}

/** Действие по ключу; `undefined` — установка такого действия не знает. */
export function checklistAction(key: string): ChecklistActionSpec | undefined {
	return ACTIONS_BY_KEY.get(key);
}
