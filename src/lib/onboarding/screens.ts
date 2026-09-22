/**
 * Реестр экранов: единственный источник истины о том, что система рассказывает
 * о себе сама.
 *
 * Каждый экран приложения описан здесь один раз: как он называется, по какому
 * адресу живёт, каким правом открывается, какая статья справки его объясняет,
 * с чего начинается рассказ о нём (`intro`) и какие элементы на нём стоит
 * показать пальцем (`steps`). Из этой одной таблицы собираются оба тура —
 * полный обход системы и обход текущего экрана, — меню значка «?» в шапке и
 * модульные проверки. Второго списка экранов в продукте нет намеренно: два
 * списка однажды разошлись бы, и подсказки стали бы рассказывать о том, чего на
 * экране уже нет.
 *
 * Файл обычный, без рун и без импортов сборки: его читают и компоненты, и
 * проверки, которые запускаются обычным Node.
 *
 * Право экрана — это право его загрузчика (или пункта меню, если экран корень
 * раздела). Экран, на который у роли нет права, из тура выпадает целиком: тур,
 * обещающий раздел с ответом 403, врёт о системе.
 *
 * Как добавить экран или шаг — `docs/onboarding.md`.
 */
import type { HelpSectionKey } from '$lib/help/article';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import { ADMIN_SCREENS } from './screens/admin';
import { USER_SCREENS } from './screens/user';

/**
 * Метка заголовка страницы. Вокруг неё встаёт рамка вступления: заголовок есть
 * у каждого экрана внутри оболочки (`$lib/components/header.svelte`), и «вот этот экран»
 * можно показать, ничего не зная о его содержимом.
 */
export const INTRO_TARGET = 'page-header';

/**
 * Образцы записей, которыми тур подставляет `[id]` в адрес экрана карточки.
 *
 * Считает их сервер, в границах прав и области доступа спрашивающего
 * (`$lib/server/onboarding/samples`). `null` означает «показать нечего»: такой
 * экран из тура выпадает, а не ведёт на несуществующий адрес.
 */
export type TourSamples = {
	/**
	 * Ключ пространства, в которое тур поведёт показывать взаимодействия.
	 * Стоит особняком от остальных образцов: это не запись, которую открывают,
	 * а сегмент адреса, без которого раздела просто нет.
	 */
	workspace: string | null;
	interaction: string | null;
	organization: string | null;
	person: string | null;
	program: string | null;
	product: string | null;
	direction: string | null;
	document: string | null;
	dataSnapshot: string | null;
};

export type TourSampleKey = keyof TourSamples;

/** Адрес, по которому тур спрашивает, какие записи ему разрешено открыть. */
export const TOUR_SAMPLES_PATH = '/tour/samples';

export type TourStep = {
	/** Идентификатор шага внутри экрана: он же ключ в проверках. */
	id: string;
	title: string;
	body: string;
	/** Значение `data-tour` элемента, вокруг которого встаёт рамка. */
	target: string;
	/**
	 * Что сказать, когда человек уже на нужном экране, а элемента на нём нет:
	 * список пуст, блок закрыт фильтром. Без этого шаг выглядел бы поломкой.
	 */
	hint?: string;
	/** Право, без которого шага не будет: элемент под ним тоже не отрисован. */
	permission?: PermissionKey;
};

export type TourScreen = {
	/** Идентификатор экрана: по нему его зовут туры и признак «смотрели». */
	id: string;
	/** Название экрана так, как оно стоит в навигации или в заголовке страницы. */
	title: string;
	/**
	 * Маршрут SvelteKit со всеми параметрами и сопоставителями, ровно как
	 * называется каталог в `src/routes/(app)`. Сопоставитель оставлен нарочно:
	 * по нему видно, что `[id=uuid]` — это адрес записи, а не любое слово, и
	 * проверка сверяет реестр с деревом маршрутов буква в букву.
	 */
	route: string;
	/** Чем подставить параметр записи в адрес. Есть только у экранов карточек. */
	sample?: TourSampleKey;
	/** Право, которым экран открывается; без поля — экран доступен всем вошедшим. */
	permission?: PermissionKey;
	/** Статья справки об этом экране. Заголовок сверяется с самой статьёй. */
	help?: { section: HelpSectionKey; page: string; title: string };
	/** Вступление: зачем экран, что на нём главное, откуда сюда приходят. */
	intro: { title: string; body: string };
	/** Шаги по элементам экрана; у форм их может не быть вовсе. */
	steps: readonly TourStep[];
};

/**
 * Все экраны приложения. Порядок здесь — порядок разделов в меню; порядок
 * обхода задаёт тур роли (`tours.ts`), и это разные вещи: меню перечисляет, а
 * тур ведёт.
 */
export const TOUR_SCREENS: readonly TourScreen[] = [...USER_SCREENS, ...ADMIN_SCREENS];

const BY_ID = new Map(TOUR_SCREENS.map((screen) => [screen.id, screen]));

export function screenById(id: string): TourScreen | null {
	return BY_ID.get(id) ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Части маршрута без пустых: `/a/[id=uuid]` даёт `['a', '[id=uuid]']`. */
function segments(path: string): string[] {
	return path.split('/').filter((part) => part !== '');
}

/**
 * Стоит ли человек на этом экране.
 *
 * Сравниваются части адреса, а не его начало: раздел и открытая в нём запись —
 * разные экраны, и «начинается с» сделало бы карточку продолжением списка.
 * Параметр с сопоставителем `uuid` принимает только идентификатор — поэтому
 * `/interactions/new` не выдаёт себя за открытую запись.
 */
export function isScreenPath(screen: TourScreen, pathname: string): boolean {
	const pattern = segments(screen.route);
	const actual = segments(pathname);

	if (pattern.length !== actual.length) {
		return false;
	}

	return pattern.every((part, index) => {
		const value = actual[index];

		if (!part.startsWith('[')) {
			return part === value;
		}

		return part.endsWith('=uuid]') ? UUID.test(value) : value !== '';
	});
}

/** Насколько маршрут конкретен: чем больше постоянных частей, тем он точнее. */
function specificity(screen: TourScreen): number {
	return segments(screen.route).filter((part) => !part.startsWith('[')).length;
}

/**
 * Экран, которому принадлежит адрес. Побеждает самый конкретный: `/data/new` —
 * это шаг мастера, а не открытый снимок с идентификатором `new`.
 */
export function screenForPath(pathname: string): TourScreen | null {
	let best: TourScreen | null = null;

	for (const screen of TOUR_SCREENS) {
		if (!isScreenPath(screen, pathname)) {
			continue;
		}

		if (best === null || specificity(screen) > specificity(best)) {
			best = screen;
		}
	}

	return best;
}

/**
 * Адрес экрана для перехода. У экрана записи параметр подставляется образцом;
 * без образца адреса нет вовсе — вести некуда, и такой экран из тура выпадает.
 */
export function screenHref(screen: TourScreen, samples: TourSamples | null): string | null {
	const parts: string[] = [];

	for (const part of segments(screen.route)) {
		if (!part.startsWith('[')) {
			parts.push(part);
			continue;
		}

		// Пространство подставляется по имени параметра, а не по образцу экрана:
		// у карточки взаимодействия их два — место в пути и сама запись, — и
		// подставить один и тот же идентификатор в оба значило бы собрать адрес,
		// которого не существует.
		if (part === '[workspace]') {
			const workspace = samples?.workspace ?? null;

			if (workspace === null) {
				return null;
			}

			parts.push(workspace);
			continue;
		}

		// Экран без образца — тот, на который приходят из записи, а не из тура:
		// его адрес остаётся шаблоном, и открыть его тур не предлагает.
		if (screen.sample === undefined) {
			parts.push(part);
			continue;
		}

		const sample = samples?.[screen.sample] ?? null;

		if (sample === null) {
			return null;
		}

		parts.push(sample);
	}

	return `/${parts.join('/')}`;
}

/** Адрес статьи справки об экране. */
export function screenHelpHref(screen: TourScreen): string | null {
	return screen.help === undefined ? null : `/help/${screen.help.section}/${screen.help.page}`;
}
