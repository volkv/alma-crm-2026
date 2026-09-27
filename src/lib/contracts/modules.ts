/**
 * Модули пространства на границе сервера: форма включения и то, что видят
 * настройки пространств.
 *
 * Ключ модуля схема проверяет только по формату: каталог установленных модулей
 * знает сервис (`isModuleKey`), и незнакомый модуль — это отказ словами, а не
 * претензия формы.
 */
import { z } from 'zod';
import { workspaceKeySchema } from './interactions';

export const setWorkspaceModuleSchema = z.object({
	workspaceKey: workspaceKeySchema,
	moduleKey: z
		.string({ error: 'Не указан модуль' })
		.trim()
		.regex(/^[a-z][a-z0-9-]{1,31}$/, { error: 'Такого модуля нет' }),
	// Флажок приезжает из формы строкой: `true` — включить, `false` — выключить.
	enabled: z
		.union([z.boolean(), z.enum(['true', 'false'])], {
			error: 'Не указано, включить модуль или выключить'
		})
		.transform((value) => value === true || value === 'true')
});

export type SetWorkspaceModuleInput = z.output<typeof setWorkspaceModuleSchema>;

/** Модуль в настройках одного пространства. */
export type WorkspaceModuleState = {
	key: string;
	label: string;
	description: string;
	/** Включён явно — строка `workspace_modules` есть. */
	enabled: boolean;
	/**
	 * Названия стадий действующей редакции, которым модуль нужен. Непустой
	 * список — модуль действует без включения и выключить его нельзя.
	 */
	requiredBy: string[];
	/** Действует: включён или нужен стадиям. */
	active: boolean;
	/** Что модуль даёт пространству — словами, для подписи в настройках. */
	contributions: string[];
	/**
	 * Названия панелей модуля, которых процесс пространства не выбрал в состав
	 * карточки: модуль действует, а панели в карточке всё равно нет. Пусто —
	 * выбраны все или панелей у модуля нет.
	 */
	unchosenPanels: string[];
};

/** Модули одного пространства — строка карточки «Модули пространств». */
export type WorkspaceModulesView = {
	workspaceId: string;
	workspaceKey: string;
	workspaceName: string;
	modules: WorkspaceModuleState[];
};
