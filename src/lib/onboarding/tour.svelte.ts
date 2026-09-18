/**
 * Состояние подсказок первого входа.
 *
 * **Где лежит признак «тур показан».** В `localStorage` браузера, ключом на
 * учётную запись и её роль. Своей колонки в базе у признака нет намеренно:
 * таблицы `users` под настройки человека в системе не существует, а заводить
 * миграцию ради подсказки — это столбец, который ничего не решает, зато едет во
 * все среды. Плата известна и названа в справке: признак принадлежит устройству,
 * и с другого браузера подсказки покажутся заново. На публичном стенде это
 * оказывается не платой, а тем, что нужно: учётная запись там общая, и признак
 * на стороне сервера первый же посетитель израсходовал бы на всех остальных.
 *
 * Роль входит в ключ, потому что тур у ролей разный: человек, которому подняли
 * права, увидит подсказки своей новой работы.
 *
 * Само состояние — обычный контекст компонента, а не модульная переменная: на
 * сервере модуль один на все запросы, и открытый тур одного человека оказался бы
 * открытым у следующего.
 */
import { getContext, setContext } from 'svelte';
import { browser } from '$app/environment';
import type { SessionUser } from '$lib/server/auth/types';
import { tourFor, type OnboardingStep } from './steps';

const STORAGE_PREFIX = 'lct-crm:onboarding:';

/** Ключ признака «тур показан» для этой учётной записи и её роли. */
export function onboardingStorageKey(userId: string, roleId: string): string {
	return `${STORAGE_PREFIX}${userId}:${roleId}`;
}

export type OnboardingTour = {
	readonly steps: readonly OnboardingStep[];
	readonly open: boolean;
	readonly index: number;
	readonly step: OnboardingStep | null;
	/** Показать тур, если этот человек его ещё не видел. Зовётся один раз за загрузку страницы. */
	autoStart(): void;
	/** Показать тур по просьбе человека — из справки или из профиля. */
	restart(): void;
	next(): void;
	back(): void;
	skip(): void;
};

export function createOnboardingTour(user: () => SessionUser | null): OnboardingTour {
	let open = $state(false);
	let index = $state(0);
	/** Кому в этой загрузке страницы тур уже предлагали: второй раз не предлагаем. */
	let offeredTo = $state<string | null>(null);

	const steps = $derived.by(() => {
		const account = user();

		return account === null ? [] : tourFor(account.roleId, account.permissions);
	});

	function markSeen(): void {
		const account = user();

		if (account === null) {
			return;
		}

		// Значение — момент показа: читается только его наличие, но по нему видно,
		// когда подсказки закрыли, если человек спросит, почему их больше нет.
		localStorage.setItem(onboardingStorageKey(account.id, account.roleId), String(Date.now()));
	}

	function close(): void {
		markSeen();
		open = false;
	}

	return {
		get steps() {
			return steps;
		},
		get open() {
			return open && steps.length > 0;
		},
		get index() {
			return index;
		},
		get step() {
			return steps[index] ?? null;
		},
		autoStart() {
			const account = user();

			// Признак лежит в браузере, и до гидратации его не прочитать: на сервере
			// тура нет вовсе.
			if (!browser || account === null || offeredTo === account.id) {
				return;
			}

			offeredTo = account.id;

			if (steps.length === 0) {
				return;
			}

			if (localStorage.getItem(onboardingStorageKey(account.id, account.roleId)) !== null) {
				return;
			}

			index = 0;
			open = true;
		},
		restart() {
			if (steps.length === 0) {
				return;
			}

			index = 0;
			open = true;
		},
		next() {
			if (index + 1 < steps.length) {
				index += 1;

				return;
			}

			close();
		},
		back() {
			index = Math.max(index - 1, 0);
		},
		skip() {
			close();
		}
	};
}

const TOUR_KEY = Symbol('onboarding-tour');

/** Кладёт тур в контекст оболочки: его зовут и страницы, и сам компонент тура. */
export function setOnboardingTour(tour: OnboardingTour): OnboardingTour {
	setContext(TOUR_KEY, tour);

	return tour;
}

export function getOnboardingTour(): OnboardingTour {
	const tour = getContext<OnboardingTour | undefined>(TOUR_KEY);

	if (tour === undefined) {
		throw new Error('Подсказки доступны только внутри оболочки приложения');
	}

	return tour;
}
