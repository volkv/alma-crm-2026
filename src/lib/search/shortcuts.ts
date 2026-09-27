import type { LucideIcon } from '$lib/icon';
import BarChart3Icon from '@lucide/svelte/icons/bar-chart-3';
import BuildingIcon from '@lucide/svelte/icons/building';
import DatabaseIcon from '@lucide/svelte/icons/database';
import TrophyIcon from '@lucide/svelte/icons/trophy';
import UploadIcon from '@lucide/svelte/icons/upload';
import type { PermissionKey } from '$lib/server/rbac/permissions';

/**
 * Страницы внутри разделов, до которых палитра доводит одной строкой.
 *
 * Меню называет разделы, а за словом «импорт» или «рейтинг» человек идёт на
 * конкретную страницу внутри раздела, которой в меню нет. Подпись палитры
 * обещает поиск по разделам — значит, и по таким страницам тоже.
 *
 * Право у строки — то, которым страница открывается сама: ссылку, отвечающую
 * 403, палитра не показывает так же, как меню (`visibleSections`).
 */
export type SearchShortcut = {
	href: string;
	label: string;
	/** Раздел, в котором страница живёт: подпись строки в палитре. */
	section: string;
	/** Слова, по которым страница находится кроме названия. */
	keywords: readonly string[];
	icon: LucideIcon;
	permission: PermissionKey | null;
};

export const SEARCH_SHORTCUTS: readonly SearchShortcut[] = [
	{
		href: '/organizations/import',
		label: 'Импорт справочника',
		section: 'Организации',
		keywords: ['импорт', 'загрузка', 'каталог', 'таблица', 'xlsx', 'excel', 'вузы', 'договоры'],
		icon: UploadIcon,
		permission: 'directory.import'
	},
	{
		href: '/organizations/new',
		label: 'Новая организация',
		section: 'Организации',
		keywords: ['завести', 'создать', 'добавить', 'вуз', 'контрагент'],
		icon: BuildingIcon,
		permission: 'organizations.write'
	},
	{
		href: '/data/new',
		label: 'Загрузка данных об обучении',
		section: 'Данные об обучении',
		keywords: ['импорт', 'загрузка', 'статистика', 'снимок', 'файл', 'xlsx', 'csv'],
		icon: UploadIcon,
		permission: 'stats.import'
	},
	{
		href: '/data/dashboard',
		label: 'Дашборд данных',
		section: 'Данные об обучении',
		keywords: ['дашборд', 'статистика', 'обучающиеся', 'охват', 'портфель'],
		icon: DatabaseIcon,
		permission: 'stats.read'
	},
	{
		href: '/data/ranking',
		label: 'Рейтинг программ и направлений',
		section: 'Данные об обучении',
		keywords: ['рейтинг', 'места', 'балл', 'приоритет'],
		icon: TrophyIcon,
		permission: 'stats.read'
	},
	{
		href: '/data/indicators',
		label: 'Показатели',
		section: 'Данные об обучении',
		keywords: ['показатели', 'статистика', 'заявки', 'потоки'],
		icon: BarChart3Icon,
		permission: 'stats.read'
	}
];

/** Подходит ли страница строке запроса: по названию или ключевому слову. */
export function shortcutMatches(shortcut: SearchShortcut, term: string): boolean {
	const needle = term.toLowerCase();

	return [shortcut.label, ...shortcut.keywords].some((text) => text.toLowerCase().includes(needle));
}
