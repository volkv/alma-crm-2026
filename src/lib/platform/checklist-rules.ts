/**
 * Правила проверки пунктов-фактов чек-листа — закрытый каталог (см.
 * `checklist.ts`). Отдельным файлом без зависимостей: его читает и реестр
 * модулей (правило модуля делает модуль нужным стадии), и каталог действий,
 * который сам стоит на реестре.
 */
export type ChecklistRuleSpec = {
	readonly key: string;
	/** Что проверяется — словами для редактора процесса и подсказки у пункта. */
	readonly label: string;
	/**
	 * Чей это факт: ядра (`null`) или модуля, без которого его нечем выполнить.
	 * Строкой, а не ключом установки: правило модуля, которого в установке нет,
	 * редактор просто не предлагает (`offeredChecklistRules`).
	 */
	readonly module: string | null;
};

/**
 * Правила проверки. Порядок — порядок в списке редактора процесса. Ключ
 * уезжает в описание стадии и её снимок: переименовать его значит оставить
 * пройденные стадии с правилом, которого установка не знает.
 */
export const CHECKLIST_RULES = [
	{
		key: 'party_department',
		label: 'У стороны выбрано подразделение (площадка вида «Подразделение»)',
		module: null
	},
	{
		key: 'contact_channel',
		label: 'У контактного лица стороны указан канал связи',
		module: null
	},
	{ key: 'stage_result', label: 'Записан результат этой стадии', module: null },
	{
		key: 'program_version_new',
		label: 'Закреплена версия программы, заведённая после входа на стадию',
		module: null
	},
	{
		key: 'licenses_issued',
		label: 'По каждому продукту дела выбрана позиция договора с датой лицензии',
		module: 'contracts'
	},
	{
		key: 'handover_act_approved',
		label: 'Акт передачи, собранный по шаблону, отмечен «Утверждён»',
		module: 'contracts'
	},
	{
		key: 'teachers_group_formed',
		label: 'Заявлен поток «Преподаватели» со слушателями',
		module: 'learning'
	},
	{
		key: 'teachers_training_completed',
		label: 'Обучение потока «Преподаватели» завершено',
		module: 'learning'
	},
	{
		key: 'upskilling_group_program',
		label: 'Заявлен поток «Повышение квалификации» по программе дела',
		module: 'learning'
	},
	{
		key: 'upskilling_enrolled',
		label: 'Система обучения прислала зачисление по потоку «Повышение квалификации»',
		module: 'learning'
	},
	{
		key: 'training_document',
		label: 'К делу приложен документ вида «Документ об обучении»',
		module: 'learning'
	},
	{
		key: 'contract_concluded',
		label: 'Договор заключён: документ договора отмечен «Утверждён» или оферта акцептована оплатой',
		module: 'payment'
	}
] as const satisfies readonly ChecklistRuleSpec[];

export type ChecklistRuleKey = (typeof CHECKLIST_RULES)[number]['key'];

export const CHECKLIST_RULE_KEYS = CHECKLIST_RULES.map((rule) => rule.key) as unknown as readonly [
	ChecklistRuleKey,
	...ChecklistRuleKey[]
];

const RULES_BY_KEY = new Map<string, ChecklistRuleSpec>(
	CHECKLIST_RULES.map((rule) => [rule.key, rule])
);

/** Правило по ключу; `undefined` — установка такого правила не знает. */
export function checklistRule(key: string): ChecklistRuleSpec | undefined {
	return RULES_BY_KEY.get(key);
}
