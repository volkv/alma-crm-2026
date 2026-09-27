/**
 * Модуль — единица поставки: папка `src/modules/<key>/` с манифестом, который
 * объявляет, что модуль добавляет в слоты ядра. Ядро открывает слоты (панели
 * карточки, факты шапки, действия, пункты меню, шаблоны документов), модуль их
 * заполняет, а установка перечисляет свои модули в `crm.config.ts`.
 *
 * Манифест — чистые данные и функции без зависимостей от сборки: его читает не
 * только приложение, но и миграция с сидом, которые идут обычным процессом Node
 * (`scripts/seed/aliases.ts`). Поэтому здесь и в манифестах — только стираемый
 * TypeScript: без `.svelte`, без `import.meta.glob`, без `enum`. Импорты из
 * контрактов — только типами.
 */
import type { InteractionAction, StageView } from '$lib/contracts/interactions';
import type { PermissionKey } from '$lib/server/rbac/permissions';

/**
 * Ключ модуля. Им подписана строка `workspace_modules`, он стоит в адресе
 * страниц модуля и в журнале, поэтому формат узкий и тот же, что держит
 * проверка в базе (`workspace_modules_key_format`).
 */
export const MODULE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Вид основной стороны карточки: вуз, физическое лицо или юридическое лицо. */
export type CounterpartyShape = 'institution' | 'person' | 'company';

/**
 * Панель карточки. `order` — место на экране среди панелей ядра и всех модулей:
 * порядок задаёт каталог, а не процесс, иначе одна и та же карточка в двух
 * пространствах читалась бы по-разному.
 */
export type PanelSpec<K extends string = string> = {
	readonly key: K;
	readonly label: string;
	/** Что панель показывает — подсказка в редакторе процесса. */
	readonly hint: string;
	readonly order: number;
};

/** Факт в шапке карточки: короткая строка о главном для контрагента этого вида. */
export type HeaderFactSpec<K extends string = string> = {
	readonly key: K;
	readonly label: string;
	readonly shapes: readonly CounterpartyShape[];
};

/**
 * Действие карточки, которое приносит модуль. Право — то же действие над
 * взаимодействием, которое сервер отдаёт в `summary.canDo.actions`: отдельного
 * каталога прав у модулей нет, отказ говорит тем же языком, что у ядра.
 */
export type CardActionSpec<K extends string = string> = {
	readonly key: K;
	readonly label: string;
	/** `null` — действие доступно всякому, кто видит карточку. */
	readonly requires: InteractionAction | null;
	readonly deniedReason: string;
	/**
	 * Пункт в меню «Ещё». Кнопку у пункта чек-листа ставит процесс: действие
	 * выбирают в описании пункта (`action` = `<модуль>:<действие>`).
	 */
	readonly menu: boolean;
};

/** Пункт меню пространства со страницей модуля. */
export type SectionSpec<K extends string = string> = {
	readonly key: K;
	readonly label: string;
	/** `null` — пункт виден всякому, кто вошёл в пространство. */
	readonly permission: PermissionKey | null;
};

/**
 * Какие шаблоны и виды документов принадлежат модулю. Каталог шаблонов остаётся
 * закрытым в ядре — на нём держатся снимок стадии и публичный API, — модуль
 * только объявляет владение.
 */
export type DocumentsSpec = {
	readonly templates: readonly string[];
	readonly kinds: readonly string[];
};

/** Та часть стадии, по которой модуль решает, нужен ли он ей. */
export type StageRuleInput = Pick<
	StageView,
	'key' | 'name' | 'requiresLmsData' | 'lmsGroupPurposes' | 'requiresDocumentTemplate' | 'checklist'
>;

/**
 * Манифест модуля. Все поля обязательны, пустые массивы законны: иначе
 * выведенные из конфига типы (`M['panels'][number]['key']`) превратились бы в
 * `undefined` у модуля, который слот не заполняет.
 */
export type ModuleManifest = {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly panels: readonly PanelSpec[];
	readonly headerFacts: readonly HeaderFactSpec[];
	readonly cardActions: readonly CardActionSpec[];
	readonly sections: readonly SectionSpec[];
	readonly documents: DocumentsSpec;
	/**
	 * Нужен ли модуль стадии. Модуль, который нужен хотя бы одной стадии
	 * действующей редакции, действует в пространстве, даже если его не включали
	 * явно, и выключить его нельзя: стадия, которую подтверждают данными
	 * обучения, без обучения не закрывается. `null` — стадиям модуль не нужен.
	 */
	readonly requiredByStage: ((stage: StageRuleInput) => boolean) | null;
};

/**
 * Объявление модуля. `const`-параметр сохраняет литеральные ключи панелей,
 * фактов и действий: из них выводятся строгие типы каталога, и связь частей
 * модуля с манифестом проверяет компилятор.
 */
export function defineModule<const M extends ModuleManifest>(manifest: M): M {
	if (!MODULE_KEY_PATTERN.test(manifest.key)) {
		throw new Error(
			`Ключ модуля «${manifest.key}»: строчная латинская буква, затем буквы, цифры или дефис, от 2 до 32 символов`
		);
	}

	return Object.freeze(manifest);
}
