/**
 * Состояние подсказок.
 *
 * **Где лежат признаки «показано».** В `localStorage` браузера: один —
 * «знакомство предлагали» — на учётную запись и её роль и по одному на каждый
 * экран, тур которого человек прошёл до конца или пропустил. Своей таблицы
 * под настройки человека в системе нет, а заводить миграцию ради подсказки —
 * это столбцы, которые ничего не решают, зато едут во все среды. Плата
 * известна и названа в справке: признак принадлежит устройству, и с другого
 * браузера подсказки покажутся заново. На публичном стенде это оказывается не
 * платой, а тем, что нужно: учётная запись там общая, и признак на стороне
 * сервера первый же посетитель израсходовал бы на всех остальных.
 *
 * Роль входит в ключ, потому что меню у ролей разное: человеку, которому
 * подняли права, покажут его новые разделы.
 *
 * Само состояние — обычный контекст компонента, а не модульная переменная: на
 * сервере модуль один на все запросы, и открытый тур одного человека оказался
 * бы открытым у следующего.
 */
import { getContext, setContext } from 'svelte';
import { browser } from '$app/environment';
import type { SessionUser } from '$lib/server/auth/types';
import type { TourScreen } from './screens';
import { guideStorageKey, onboardingScreenKey, onboardingStorageKey } from './storage';
import { guideFor, screenTourFor, type GuideLink, type TourStop } from './tours';

export type OnboardingTour = {
	readonly stops: readonly TourStop[];
	readonly open: boolean;
	readonly index: number;
	readonly stop: TourStop | null;
	/** Сколько остановок в знакомстве для этого меню. Ноль — показывать нечего. */
	readonly guideLength: number;
	/** Сколько остановок в туре этого экрана при текущих правах. */
	screenLength(screen: TourScreen): number;
	/**
	 * Прошли или пропустили ли на этом устройстве тур экрана. До того, как
	 * признаки прочитаны из браузера, ответ «да»: волны на кнопке тура,
	 * мелькнувшие на долю секунды после загрузки страницы, — это не
	 * приглашение, а рябь.
	 */
	screenSeen(screenId: string): boolean;
	/** Прочитать признаки экранов из браузера. Зовётся оболочкой после гидратации. */
	syncSeen(): void;
	/** Предложить знакомство, если этому человеку его ещё не предлагали. */
	autoStart(): void;
	/** Знакомство по просьбе человека. */
	startGuide(): void;
	/** Тур текущего экрана: вступление и его элементы. */
	startScreen(screen: TourScreen, href: string): void;
	next(): void;
	back(): void;
	/** Закрыть подсказки; у знакомства — запомнить, что его уже предлагали. */
	close(): void;
};

export function createOnboardingTour(
	user: () => SessionUser | null,
	/** Меню, которое видит человек: из него собирается знакомство. */
	links: () => readonly GuideLink[]
): OnboardingTour {
	let open = $state(false);
	let index = $state(0);
	let mode = $state<'guide' | 'screen'>('guide');
	/** Тур экрана держит свой список остановок: он зависит от открытого адреса. */
	let ownStops = $state<readonly TourStop[]>([]);
	/**
	 * Экраны, тур которых на этом устройстве прошли или пропустили. Список, а не
	 * множество: он заменяется целиком, а не правится, и длиной он в десятки —
	 * реактивная коллекция здесь была бы лишним слоем.
	 */
	let seen = $state<readonly string[]>([]);
	/** Прочитаны ли признаки из браузера: до этого волн на кнопке тура нет. */
	let seenKnown = $state(false);
	/** Кому в этой загрузке страницы знакомство уже предлагали: второй раз не предлагаем. */
	let offeredTo = $state<string | null>(null);

	const guideStops = $derived(user() === null ? [] : guideFor(links()));
	const stops = $derived(mode === 'guide' ? guideStops : ownStops);

	/** Признаки экранов, лежащие в браузере у этой учётной записи и роли. */
	function readSeen(): string[] {
		const account = user();

		if (!browser || account === null) {
			return [];
		}

		const prefix = `${onboardingStorageKey(account.id, account.roleId)}:screen:`;
		const ids: string[] = [];

		for (let position = 0; position < localStorage.length; position += 1) {
			const key = localStorage.key(position);

			if (key !== null && key.startsWith(prefix)) {
				ids.push(key.slice(prefix.length));
			}
		}

		return ids;
	}

	function markGuideSeen(): void {
		const account = user();

		if (account === null) {
			return;
		}

		// Значение — момент показа: читается только его наличие, но по нему видно,
		// когда знакомство закрыли, если человек спросит, почему его больше нет.
		localStorage.setItem(guideStorageKey(account.id, account.roleId), String(Date.now()));
	}

	function markScreenSeen(screenId: string): void {
		const account = user();

		if (!browser || account === null) {
			return;
		}

		localStorage.setItem(
			onboardingScreenKey(account.id, account.roleId, screenId),
			String(Date.now())
		);
		seen = seen.includes(screenId) ? seen : [...seen, screenId];
	}

	/**
	 * Экран, тур которого идёт на этой остановке. Раздел знакомства страницу
	 * открывает, но о ней не рассказывает, — её тур этим не пройден.
	 */
	function tourScreenOf(stop: TourStop | undefined): string | null {
		return stop !== undefined && (stop.kind === 'intro' || stop.kind === 'step')
			? (stop.screen?.id ?? null)
			: null;
	}

	/**
	 * Перевести тур на остановку. Экран, с последнего шага которого ушли
	 * вперёд, считается пройденным и больше не зовёт к себе волнами. Шаг назад
	 * экран не закрывает — его ещё не дослушали.
	 */
	function show(next: number): void {
		const left = tourScreenOf(stops[index]);

		if (open && next === index + 1 && left !== null && tourScreenOf(stops[next]) !== left) {
			markScreenSeen(left);
		}

		index = next;
	}

	function close(): void {
		// Признак «знакомство предлагали» ставит только знакомство: закрытый тур
		// одного экрана не должен отменять первое знакомство с системой.
		if (mode === 'guide') {
			markGuideSeen();
		}

		// Закрыть тур посреди экрана — значит пропустить тур этого экрана: он
		// больше не зовёт к себе.
		const current = tourScreenOf(stops[index]);

		if (open && current !== null) {
			markScreenSeen(current);
		}

		open = false;
	}

	function openGuide(): void {
		if (guideStops.length === 0) {
			return;
		}

		mode = 'guide';
		index = 0;
		open = true;
	}

	return {
		get stops() {
			return stops;
		},
		get open() {
			return open && stops.length > 0;
		},
		get index() {
			return index;
		},
		get stop() {
			return stops[index] ?? null;
		},
		get guideLength() {
			return guideStops.length;
		},
		screenLength(screen: TourScreen) {
			const account = user();

			return account === null ? 0 : screenTourFor(screen, account.permissions, screen.route).length;
		},
		screenSeen(screenId: string) {
			return !seenKnown || seen.includes(screenId);
		},
		syncSeen() {
			if (!browser) {
				return;
			}

			seen = readSeen();
			seenKnown = true;
		},
		autoStart() {
			const account = user();

			// Признак лежит в браузере, и до гидратации его не прочитать: на сервере
			// тура нет вовсе.
			if (!browser || account === null || offeredTo === account.id) {
				return;
			}

			offeredTo = account.id;

			if (localStorage.getItem(guideStorageKey(account.id, account.roleId)) !== null) {
				return;
			}

			openGuide();
		},
		startGuide: openGuide,
		startScreen(screen: TourScreen, href: string) {
			const account = user();

			if (account === null) {
				return;
			}

			const built = screenTourFor(screen, account.permissions, href);

			if (built.length === 0) {
				return;
			}

			mode = 'screen';
			ownStops = built;
			index = 0;
			open = true;
		},
		next() {
			if (index + 1 < stops.length) {
				show(index + 1);

				return;
			}

			close();
		},
		back() {
			show(Math.max(index - 1, 0));
		},
		close
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
