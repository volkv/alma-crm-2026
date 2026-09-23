import { getContext, setContext } from 'svelte';
import { browser } from '$app/environment';
import {
	NAV_GROUPS_STORAGE_KEY,
	navGroupCollapsed,
	parseNavGroups,
	type NavGroupChoices
} from './nav-groups';

/**
 * Свёрнутые группы меню.
 *
 * Выбор принадлежит человеку и переживает страницу, поэтому лежит в
 * `localStorage`, а не в адресе и не на сервере: никому, кроме самого человека,
 * он ничего не меняет. Своей таблицы под настройки вида в системе нет, и заводить
 * миграцию ради свёрнутого заголовка — это столбцы, которые ничего не решают.
 * Плата та же, что у свёрнутой панели: выбор принадлежит устройству.
 *
 * Сервер рисует группы по умолчанию — знать чужой `localStorage` он не может, —
 * а браузер применяет сохранённое при гидратации. «Настройки» свёрнуты и там, и
 * там: по умолчанию, а не по записи, поэтому обычный случай обходится без
 * рывка.
 *
 * Состояние — контекст оболочки, а не модульная переменная: на сервере модуль
 * один на все запросы. Экземпляр при этом один на оба меню — боковое и
 * выдвижное на телефоне, — и группа, свёрнутая в одном, свёрнута и в другом.
 */
export type NavGroups = {
	/** Свёрнута ли группа. `holdsActive` — держит ли она открытую страницу. */
	collapsed(groupId: string, holdsActive: boolean): boolean;
	/** Свернуть или развернуть группу и запомнить это решение. */
	toggle(groupId: string, holdsActive: boolean): void;
};

export function createNavGroups(): NavGroups {
	let choices = $state<NavGroupChoices>(
		browser ? parseNavGroups(localStorage.getItem(NAV_GROUPS_STORAGE_KEY)) : {}
	);

	// До этой строки группы держит стиль, поставленный в <head> до первой
	// отрисовки (`static/nav-groups.js`): меню приезжает с сервера раскрытым, и
	// без него свёрнутые группы схлопывались бы уже на глазах. Теперь разметка
	// знает то же самое сама, а стиль сильнее её классов — и первое же нажатие
	// на заголовок упёрлось бы в него.
	$effect(() => {
		delete document.documentElement.dataset.navBoot;
	});

	return {
		collapsed(groupId, holdsActive) {
			return navGroupCollapsed(choices, groupId, holdsActive);
		},
		toggle(groupId, holdsActive) {
			choices = { ...choices, [groupId]: !navGroupCollapsed(choices, groupId, holdsActive) };
			localStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(choices));
		}
	};
}

const NAV_GROUPS_KEY = Symbol('nav-groups');

/** Кладёт состояние групп в контекст оболочки: его читают оба меню. */
export function setNavGroups(groups: NavGroups): NavGroups {
	setContext(NAV_GROUPS_KEY, groups);

	return groups;
}

export function getNavGroups(): NavGroups {
	const groups = getContext<NavGroups | undefined>(NAV_GROUPS_KEY);

	if (groups === undefined) {
		throw new Error('Группы меню доступны только внутри оболочки приложения');
	}

	return groups;
}
