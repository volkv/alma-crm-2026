import { browser } from '$app/environment';

const STORAGE_KEY = 'lct-crm:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Что человек выбрал. `system` означает «спросить браузер». */
export type ThemePreference = 'light' | 'dark' | 'system';

/** Что в итоге на экране: значение атрибута `data-theme` на <html>. */
export type Theme = 'light' | 'dark';

/** Порядок в переключателе; он же порядок обхода с клавиатуры. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export const THEME_LABELS: Record<ThemePreference, string> = {
	light: 'Светлая тема',
	dark: 'Тёмная тема',
	system: 'Как в системе'
};

function readPreference(): ThemePreference {
	if (!browser) {
		return 'light';
	}

	const stored = localStorage.getItem(STORAGE_KEY);

	// Умолчание — светлая, а не «как в системе»: продукт показывают на светлом,
	// и человек с тёмной системой не должен увидеть не ту тему, которой его ждут
	// на экране рядом. Чужое значение в ключе (чужая версия, правка руками) —
	// тоже умолчание, выбирать наугад тут нечего.
	return stored === 'dark' || stored === 'system' ? stored : 'light';
}

/*
 * Состояние на весь документ, а не на компонент: переключателей на экране
 * бывает несколько (меню учётной записи и витрина `/ui-kit`), и они обязаны
 * показывать один и тот же выбор. На сервере это просто «светлая»: читать
 * `localStorage` там нечем, а меняют состояние только обработчики событий
 * браузера — поделённый между запросами модуль остаётся неизменным.
 */
let preference = $state<ThemePreference>(readPreference());
let systemDark = $state(browser && window.matchMedia(DARK_QUERY).matches);

function resolved(): Theme {
	return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

function apply(): void {
	document.documentElement.dataset.theme = resolved();
	// Второй атрибут — сам выбор, вместе с неразрешённым `system`: по нему
	// `app.css` показывает на кнопке темы тот значок, который выбран. Держать
	// это в разметке кнопки нельзя — сервер выбора не знает.
	document.documentElement.dataset.themePreference = preference;
}

if (browser) {
	// Системную тему меняют при открытой вкладке — по расписанию дня, например.
	// При выборе «как в системе» экран обязан переехать вместе с ней.
	window.matchMedia(DARK_QUERY).addEventListener('change', (event) => {
		systemDark = event.matches;
		apply();
	});
}

/**
 * Тема оформления: что выбрано, что из этого вышло и как выбрать другое.
 *
 * Выбор принадлежит устройству, а не учётной записи: человек за тёмным
 * монитором и он же за светлым ноутбуком — один и тот же пользователь системы.
 * Поэтому `localStorage`, а не профиль в базе.
 *
 * Атрибут на <html> ставит `static/theme.js` ещё до отрисовки; здесь он только
 * переставляется при выборе. Значения тем — в `src/app.css`.
 */
export const theme = {
	get preference(): ThemePreference {
		return preference;
	},
	get resolved(): Theme {
		return resolved();
	},
	select(next: ThemePreference): void {
		preference = next;
		localStorage.setItem(STORAGE_KEY, next);
		apply();
	}
};
