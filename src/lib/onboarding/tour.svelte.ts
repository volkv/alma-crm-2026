/**
 * Состояние подсказок.
 *
 * **Где лежат признаки «показано».** В `localStorage` браузера: один на полный
 * тур учётной записи и её роли и по одному на каждый экран, вступление которого
 * человек уже видел. Своей таблицы под настройки человека в системе нет, а
 * заводить миграцию ради подсказки — это столбцы, которые ничего не решают,
 * зато едут во все среды. Плата известна и названа в справке: признак
 * принадлежит устройству, и с другого браузера подсказки покажутся заново. На
 * публичном стенде это оказывается не платой, а тем, что нужно: учётная запись
 * там общая, и признак на стороне сервера первый же посетитель израсходовал бы
 * на всех остальных.
 *
 * Роль входит в ключ, потому что тур у ролей разный: человек, которому подняли
 * права, увидит подсказки своей новой работы.
 *
 * Само состояние — обычный контекст компонента, а не модульная переменная: на
 * сервере модуль один на все запросы, и открытый тур одного человека оказался
 * бы открытым у следующего.
 */
import { getContext, setContext } from 'svelte';
import { browser } from '$app/environment';
import type { SessionUser } from '$lib/server/auth/types';
import { TOUR_SAMPLES_PATH, type TourSamples, type TourScreen } from './screens';
import { onboardingScreenKey, onboardingStorageKey } from './storage';
import {
	fullTourFor,
	hasRoleTour,
	screenTourFor,
	tourChapters,
	type TourChapter,
	type TourStop
} from './tours';

export type OnboardingTour = {
	readonly stops: readonly TourStop[];
	readonly open: boolean;
	readonly index: number;
	readonly stop: TourStop | null;
	/** Оглавление полного тура; у тура экрана оно пустое. */
	readonly chapters: readonly TourChapter[];
	/** Сколько остановок в полном туре этой роли. Ноль — показывать нечего. */
	readonly fullLength: number;
	/**
	 * Список записей не ответил, и экраны карточек в тур не попали. Карточка
	 * говорит об этом вслух: молча укоротившийся тур выглядел бы правильным.
	 */
	readonly samplesFailed: boolean;
	/** Сколько остановок в туре этого экрана при текущих правах. */
	screenLength(screen: TourScreen): number;
	/**
	 * Видели ли на этом устройстве вступление экрана. До того, как признаки
	 * прочитаны из браузера, ответ «да»: точка-напоминание, мелькнувшая на долю
	 * секунды после загрузки страницы, — это не напоминание, а рябь.
	 */
	screenSeen(screenId: string): boolean;
	/** Прочитать признаки экранов из браузера. Зовётся оболочкой после гидратации. */
	syncSeen(): void;
	/** Спросить образцы записей заранее: зовётся, когда открывают меню «?». */
	prepare(): void;
	/** Показать полный тур, если этот человек его ещё не видел. */
	autoStart(): void;
	/** Полный тур по просьбе человека. */
	startFull(): void;
	/** Тур текущего экрана: вступление и его элементы. */
	startScreen(screen: TourScreen, href: string): void;
	/** Перейти к вступлению экрана из оглавления. */
	goToScreen(screenId: string): void;
	next(): void;
	back(): void;
	/** Закрыть подсказки и запомнить, что полный тур человеку уже предлагали. */
	close(): void;
};

export function createOnboardingTour(user: () => SessionUser | null): OnboardingTour {
	let open = $state(false);
	let index = $state(0);
	let mode = $state<'full' | 'screen'>('full');
	/** Тур экрана держит свой список остановок: он зависит от открытого адреса. */
	let ownStops = $state<readonly TourStop[]>([]);
	let samples = $state<TourSamples | null>(null);
	let samplesFailed = $state(false);
	/**
	 * Экраны, вступление которых на этом устройстве уже показывали. Список, а не
	 * множество: он заменяется целиком, а не правится, и длиной он в десятки —
	 * реактивная коллекция здесь была бы лишним слоем.
	 */
	let seen = $state<readonly string[]>([]);
	/** Прочитаны ли признаки из браузера: до этого точек-напоминаний нет. */
	let seenKnown = $state(false);
	/** Кому в этой загрузке страницы тур уже предлагали: второй раз не предлагаем. */
	let offeredTo = $state<string | null>(null);
	/** Запрос образцов идёт один на загрузку страницы. */
	let pending: Promise<void> | null = null;

	const fullStops = $derived.by(() => {
		const account = user();

		return account === null ? [] : fullTourFor(account.roleId, account.permissions, samples);
	});

	const stops = $derived(mode === 'full' ? fullStops : ownStops);

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

	function markFullSeen(): void {
		const account = user();

		if (account === null) {
			return;
		}

		// Значение — момент показа: читается только его наличие, но по нему видно,
		// когда подсказки закрыли, если человек спросит, почему их больше нет.
		localStorage.setItem(onboardingStorageKey(account.id, account.roleId), String(Date.now()));
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

	/** Перевести тур на остановку и отметить экран, вступление которого показали. */
	function show(next: number): void {
		index = next;

		const stop = stops[next];

		if (stop !== undefined && stop.kind === 'intro' && stop.screen !== null) {
			markScreenSeen(stop.screen.id);
		}
	}

	function close(): void {
		// Признак «полный тур предлагали» ставит только полный тур: закрытая
		// подсказка по одному экрану не должна отменять первый обход системы.
		if (mode === 'full') {
			markFullSeen();
		}

		open = false;
	}

	/**
	 * Спросить у сервера, какие записи туру разрешено открыть. Запрос один на
	 * загрузку страницы: платить за него на каждом переходе незачем — нужен он
	 * тому, кто открыл подсказки, и один раз.
	 */
	function loadSamples(): Promise<void> {
		if (pending !== null) {
			return pending;
		}

		pending = fetch(TOUR_SAMPLES_PATH, { headers: { accept: 'application/json' } })
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`Образцы записей: сервер ответил ${response.status}`);
				}

				samples = (await response.json()) as TourSamples;
				samplesFailed = false;
			})
			.catch(() => {
				// Отказ не прячется: тур покажет то, что может, и скажет карточкой,
				// что экраны с записями в него не попали.
				samples = null;
				samplesFailed = true;
			});

		return pending;
	}

	/** Открыть полный тур, когда образцы записей уже спрошены. */
	function openFull(): void {
		if (fullStops.length === 0) {
			return;
		}

		mode = 'full';
		show(0);
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
		get chapters() {
			return mode === 'full' ? tourChapters(stops) : [];
		},
		get fullLength() {
			return fullStops.length;
		},
		get samplesFailed() {
			return samplesFailed;
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
		prepare() {
			if (browser) {
				void loadSamples();
			}
		},
		autoStart() {
			const account = user();

			// Признак лежит в браузере, и до гидратации его не прочитать: на сервере
			// тура нет вовсе.
			if (!browser || account === null || offeredTo === account.id) {
				return;
			}

			offeredTo = account.id;

			if (!hasRoleTour(account.roleId)) {
				return;
			}

			if (localStorage.getItem(onboardingStorageKey(account.id, account.roleId)) !== null) {
				return;
			}

			void loadSamples().then(openFull);
		},
		startFull() {
			void loadSamples().then(openFull);
		},
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
			show(0);
			open = true;
		},
		goToScreen(screenId: string) {
			const position = stops.findIndex(
				(stop) => stop.kind === 'intro' && stop.screen?.id === screenId
			);

			if (position !== -1) {
				show(position);
			}
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
