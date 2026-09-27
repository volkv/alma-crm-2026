/**
 * Реестр экранов против самого приложения.
 *
 * Подсказки обещают, что система документирует себя сама, а обещание такого
 * рода проверяется только сверкой с тем, что в системе есть на самом деле. Эти
 * проверки читают дерево маршрутов, разметку и статьи справки — и падают, как
 * только реестр разошёлся хоть с одним из них: появился экран без записи,
 * осталась метка без шага, шаг сослался на метку, которой нет в разметке,
 * статья справки переименована, а тур обещает роли раздел, закрытый ей правами.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHelpArticle } from '$lib/help/article';
import { navSections, visibleSections, type NavWorkspace } from '$lib/nav';
import {
	INTRO_TARGET,
	isScreenPath,
	screenForPath,
	screenHref,
	TOUR_SAMPLES_PATH,
	TOUR_SCREENS,
	type TourSamples
} from '$lib/onboarding/screens';
import {
	fullTourFor,
	hasRoleTour,
	ROLE_TOURS,
	screenTourFor,
	SHELL_STEPS,
	tourChapters
} from '$lib/onboarding/tours';
import { onboardingScreenKey, onboardingStorageKey } from '$lib/onboarding/storage';
import { DEFAULT_ROLES } from '$lib/server/rbac/permissions';

/** Пространства стенда: меню собирается из базы, и подсказки — по нему же. */
const NAV_WORKSPACES: NavWorkspace[] = [
	{ key: 'b2b', name: 'Работа с ВУЗ', hasWorkflow: true },
	{ key: 'b2c', name: 'Корпоративное обучение', hasWorkflow: true }
];

/** Меню в том составе, в каком его видит человек на стенде. */
const MENU = navSections(NAV_WORKSPACES);

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP_ROUTES = `${REPO}src/routes/(app)`;

/**
 * Экраны, которых в реестре нет намеренно: витрина компонентов — не рабочий
 * экран, печатная версия справки и сама статья живут вне
 * подсказок (подсказка о статье справки была бы справкой о справке).
 * Диспетчер страниц модулей — тоже: страницы модулей описывает сам модуль, а
 * ядро не знает, что на них. Страница одного пространства своих подсказок не
 * заводит: к ней приходят из списка пространств, и его тур уже рассказывает,
 * что на ней настраивается.
 */
const WITHOUT_SCREEN = [
	'/ui-kit',
	'/help/print',
	'/help/[section]/[page]',
	'/w/[workspace]/m/[module]/[...path]',
	'/settings/workspaces/[key]'
];

/** Файлы по дереву каталога: путь целиком, вместе с корнем. */
function filesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;

		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

/** Маршруты приложения так, как их называет SvelteKit: `/interactions/[id=uuid]`. */
function appRoutes(): string[] {
	return filesUnder(APP_ROUTES)
		.filter((path) => path.endsWith('/+page.svelte'))
		.map((path) => path.slice(APP_ROUTES.length, -'/+page.svelte'.length))
		.map((route) => (route === '' ? '/' : route))
		.sort();
}

/** Права роли из каталога — те же, что сидируются в базу. */
function permissionsOf(roleId: string): ReadonlySet<string> {
	const role = DEFAULT_ROLES.find((candidate) => candidate.id === roleId);

	if (role === undefined) {
		throw new Error(`Роль «${roleId}» не заведена в каталоге`);
	}

	return new Set<string>(role.permissions);
}

/**
 * Исходник без комментариев.
 *
 * Метку ищут по тексту файла, а комментарии рядом с ней эту метку называют —
 * и снятая с элемента `data-tour` осталась бы «найденной» по объяснению того,
 * зачем она когда-то стояла. Проверка обязана видеть разметку, а не рассказ о
 * ней.
 */
function withoutComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '');
}

/** Все метки `data-tour`, которые стоят на элементах разметки. */
function markedTargets(): Set<string> {
	const targets = new Set<string>();

	for (const path of filesUnder(`${REPO}src`)) {
		if (!path.endsWith('.svelte')) {
			continue;
		}

		const source = withoutComments(readFileSync(path, 'utf8'));

		for (const match of source.matchAll(/data-tour="([a-z0-9-]+)"/g)) {
			targets.add(match[1]);
		}
	}

	return targets;
}

/** Все метки, которые называет реестр: вступление, оболочка и шаги экранов. */
function declaredTargets(): Set<string> {
	return new Set([
		INTRO_TARGET,
		...SHELL_STEPS.map((step) => step.target),
		...TOUR_SCREENS.flatMap((screen) => screen.steps.map((step) => step.target))
	]);
}

/** Статьи встроенной справки, разобранные тем же кодом, что и в приложении. */
function helpArticles(): Map<string, string> {
	const root = `${REPO}src/lib/help/content`;
	const articles = new Map<string, string>();

	for (const path of filesUnder(root)) {
		if (!path.endsWith('.md')) {
			continue;
		}

		const article = parseHelpArticle(path, readFileSync(path, 'utf8'));

		articles.set(`${article.section}/${article.slug}`, article.title);
	}

	return articles;
}

const FULL_SAMPLES: TourSamples = {
	workspace: 'b2b',
	interaction: '2f0b0d3c-0000-4000-8000-000000000001',
	organization: '2f0b0d3c-0000-4000-8000-000000000002',
	person: '2f0b0d3c-0000-4000-8000-000000000003',
	program: '2f0b0d3c-0000-4000-8000-000000000004',
	product: '2f0b0d3c-0000-4000-8000-000000000005',
	direction: '2f0b0d3c-0000-4000-8000-000000000006',
	document: '2f0b0d3c-0000-4000-8000-000000000007',
	dataSnapshot: '2f0b0d3c-0000-4000-8000-000000000008'
};

describe('реестр экранов', () => {
	it('покрывает каждый экран приложения и не выдумывает своих', () => {
		const routes = appRoutes().filter((route) => !WITHOUT_SCREEN.includes(route));

		expect(routes.length).toBeGreaterThan(40);
		expect([...TOUR_SCREENS].map((screen) => screen.route).sort()).toEqual(routes);
	});

	it('называет экраны по одному разу и снабжает каждый вступлением', () => {
		expect(new Set(TOUR_SCREENS.map((screen) => screen.id)).size).toBe(TOUR_SCREENS.length);

		for (const screen of TOUR_SCREENS) {
			expect(screen.title.length, screen.id).toBeGreaterThan(0);
			expect(screen.intro.title.length, screen.id).toBeGreaterThan(0);
			// Вступление объясняет экран, а не называет его ещё раз: две-три фразы.
			expect(screen.intro.body.length, screen.id).toBeGreaterThan(80);
			expect(new Set(screen.steps.map((step) => step.id)).size, screen.id).toBe(
				screen.steps.length
			);
		}
	});

	it('даёт образец каждому экрану записи и никому больше', () => {
		for (const screen of TOUR_SCREENS) {
			// Пространство в пути — не открываемая запись, а сегмент адреса:
			// образца экрана оно не требует, но без ключа адрес не собирается.
			const hasRecord = screen.route.replaceAll('[workspace]', '').includes('[');
			const hasWorkspace = screen.route.includes('[workspace]');

			if (screen.sample !== undefined) {
				expect(hasRecord, screen.id).toBe(true);
			}

			if (screen.sample !== undefined || hasWorkspace) {
				expect(screenHref(screen, FULL_SAMPLES), screen.id).not.toBeNull();
				expect(screenHref(screen, null), screen.id).toBeNull();
			} else {
				expect(screenHref(screen, null), screen.id).toBe(screen.route);
			}
		}
	});
});

describe('адрес экрана', () => {
	it('узнаёт открытую запись и не путает её с формой', () => {
		const card = screenForPath('/w/b2b/interactions/2f0b0d3c-0000-4000-8000-000000000001');
		const created = screenForPath('/w/b2b/interactions/new');

		expect(card?.id).toBe('interaction');
		expect(created?.id).toBe('interaction-new');
		expect(screenForPath('/w/b2b/interactions')?.id).toBe('interactions');
	});

	it('главная — это только корень', () => {
		expect(screenForPath('/')?.id).toBe('home');
		expect(screenForPath('/w/b2b/reports')?.id).toBe('reports');
		// Чужой раздел с тем же началом адреса — не свой экран.
		expect(screenForPath('/interactions-board')).toBeNull();
	});

	it('различает шаги мастера импорта', () => {
		const id = '2f0b0d3c-0000-4000-8000-000000000009';

		expect(screenForPath(`/organizations/import/${id}/mapping`)?.id).toBe(
			'organizations-import-mapping'
		);
		expect(screenForPath(`/organizations/import/${id}/check`)?.id).toBe(
			'organizations-import-check'
		);
		expect(screenForPath(`/organizations/import/${id}`)?.id).toBe('organizations-import-run');
		expect(screenForPath('/organizations/import')?.id).toBe('organizations-import');
	});

	it('принимает в параметр записи только идентификатор', () => {
		const card = TOUR_SCREENS.find((screen) => screen.id === 'interaction');

		if (card === undefined) {
			throw new Error('Экран карточки взаимодействия пропал из реестра');
		}

		expect(isScreenPath(card, '/w/b2b/interactions/2f0b0d3c-0000-4000-8000-000000000001')).toBe(
			true
		);
		expect(isScreenPath(card, '/w/b2b/interactions/new')).toBe(false);
		expect(isScreenPath(card, '/w/b2b/interactions')).toBe(false);
		expect(
			isScreenPath(card, '/w/b2b/interactions/2f0b0d3c-0000-4000-8000-000000000001/edit')
		).toBe(false);
	});

	it('ключ процесса — любой сегмент, а не идентификатор', () => {
		expect(screenForPath('/settings/workflows/b2b')?.id).toBe('settings-process-group');
		expect(screenForPath('/settings/workflows')?.id).toBe('settings-process');
	});
});

describe('право экрана', () => {
	it('совпадает с правом пункта меню у корней разделов', () => {
		// Сопоставление по образцу маршрута, а не по строке: у секции пространства
		// в адресе стоит ключ, а у экрана — параметр `[workspace]`.
		const roots = MENU.filter((section) =>
			TOUR_SCREENS.some((screen) => isScreenPath(screen, section.href))
		);

		// Каждый пункт меню обязан найтись экраном: подсказки объясняют ровно то,
		// что человек видит в меню, и пункт без экрана остался бы без объяснения.
		expect(roots.length).toBe(MENU.length);

		for (const section of roots) {
			const screen = TOUR_SCREENS.find((candidate) => isScreenPath(candidate, section.href));

			expect(screen?.permission ?? null, section.href).toBe(section.permission);
		}
	});
});

describe('статьи справки', () => {
	it('существуют и названы так же, как в реестре', () => {
		const articles = helpArticles();

		expect(articles.size).toBeGreaterThan(10);

		for (const screen of TOUR_SCREENS) {
			if (screen.help === undefined) {
				continue;
			}

			const key = `${screen.help.section}/${screen.help.page}`;

			expect(articles.get(key), `${screen.id} → ${key}`).toBe(screen.help.title);
		}
	});

	it('есть почти у каждого экрана', () => {
		const without = TOUR_SCREENS.filter((screen) => screen.help === undefined).map(
			(screen) => screen.id
		);

		// Статья про саму справку была бы справкой о справке.
		expect(without).toEqual(['help']);
	});
});

describe('метки в разметке', () => {
	it('реестр называет только те метки, что стоят на элементах', () => {
		const marked = markedTargets();

		expect(marked.size).toBeGreaterThan(10);

		for (const target of declaredTargets()) {
			expect(marked.has(target), `метка «${target}» не найдена в разметке`).toBe(true);
		}
	});

	it('в разметке нет меток, о которых реестр не знает', () => {
		const declared = declaredTargets();

		for (const target of markedTargets()) {
			expect(
				declared.has(target),
				`метка «${target}» стоит в разметке, но её никто не показывает`
			).toBe(true);
		}
	});
});

describe('полный тур роли', () => {
	const HUMAN_ROLES = DEFAULT_ROLES.map((role) => role.id).filter((id) => id !== 'service');

	it('заведён каждой роли человека и только ей', () => {
		expect([...Object.keys(ROLE_TOURS)].sort()).toEqual([...HUMAN_ROLES].sort());
		// `service` — ключи обмена: войти этой ролью нельзя, и показывать ей нечего.
		expect(hasRoleTour('service')).toBe(false);
		expect(hasRoleTour('auditor')).toBe(false);
	});

	it('доходит до каждого раздела, который роль видит в меню', () => {
		for (const roleId of Object.keys(ROLE_TOURS)) {
			const permissions = permissionsOf(roleId);
			const stops = fullTourFor(roleId, permissions, FULL_SAMPLES);
			const screens = tourChapters(stops).map((chapter) => chapter.screenId);

			for (const section of visibleSections(MENU, permissions)) {
				// Сопоставление по образцу маршрута, а не по строке: у секции
				// пространства в адресе стоит ключ, а у экрана — параметр. Тур
				// объясняет раздел один раз: показать одно и то же дважды, по разу
				// на направление, значило бы утомить ради полноты.
				const covered = screens.some((id) => {
					const screen = TOUR_SCREENS.find((candidate) => candidate.id === id);

					if (screen === undefined) {
						return false;
					}

					return (
						isScreenPath(screen, section.href) ||
						(section.href !== '/' && screen.route.startsWith(`${section.href}/`))
					);
				});

				expect(covered, `${roleId} → ${section.href}`).toBe(true);
			}
		}
	});

	it('не обещает роли экран, которого ей не откроют', () => {
		for (const roleId of Object.keys(ROLE_TOURS)) {
			const permissions = permissionsOf(roleId);
			const stops = fullTourFor(roleId, permissions, FULL_SAMPLES);

			for (const chapter of tourChapters(stops)) {
				const screen = TOUR_SCREENS.find((candidate) => candidate.id === chapter.screenId);
				const required = screen?.permission;

				expect(
					required === undefined || permissions.has(required),
					`${roleId} → ${chapter.screenId}`
				).toBe(true);
			}
		}
	});

	it('начинается приветствием с картой и кончается финалом', () => {
		const stops = fullTourFor('manager', permissionsOf('manager'), FULL_SAMPLES);
		const chapters = tourChapters(stops);

		expect(stops[0].kind).toBe('welcome');
		expect(stops[0].map).toEqual(chapters.map((chapter) => chapter.title));
		expect(stops[stops.length - 1].kind).toBe('finish');
		// Оболочка идёт сразу за приветствием: дальше тур ею пользуется.
		expect(stops.slice(1, 1 + SHELL_STEPS.length).map((stop) => stop.kind)).toEqual(
			SHELL_STEPS.map(() => 'shell')
		);
	});

	it('шаг, закрытый правом, из тура выпадает', () => {
		const lead = permissionsOf('lead');
		const manager = permissionsOf('manager');
		const withReassign = fullTourFor('lead', lead, FULL_SAMPLES);
		const withoutReassign = fullTourFor('manager', manager, FULL_SAMPLES);

		expect(lead.has('interactions.reassign')).toBe(true);
		expect(manager.has('interactions.reassign')).toBe(false);
		expect(withReassign.some((stop) => stop.id === 'interactions:reassign')).toBe(true);
		expect(withoutReassign.some((stop) => stop.id === 'interactions:reassign')).toBe(false);
	});

	it('без образца записи экран карточки выпадает вместе со своими шагами', () => {
		const permissions = permissionsOf('manager');
		const withSamples = fullTourFor('manager', permissions, FULL_SAMPLES);
		const withoutSamples = fullTourFor('manager', permissions, {
			...FULL_SAMPLES,
			interaction: null
		});

		const card = TOUR_SCREENS.find((screen) => screen.id === 'interaction');

		if (card === undefined) {
			throw new Error('Экран карточки взаимодействия пропал из реестра');
		}

		expect(tourChapters(withSamples).some((chapter) => chapter.screenId === 'interaction')).toBe(
			true
		);
		expect(tourChapters(withoutSamples).some((chapter) => chapter.screenId === 'interaction')).toBe(
			false
		);
		// Вступление плюс шаги экрана — ровно столько остановок и пропадает.
		expect(withSamples.length - withoutSamples.length).toBe(card.steps.length + 1);
		// Карта приветствия и число остановок пересчитываются вместе с туром.
		expect(withoutSamples[0].map).toEqual(
			tourChapters(withoutSamples).map((chapter) => chapter.title)
		);
	});

	it('нумерует остановки внутри экрана', () => {
		const stops = fullTourFor('manager', permissionsOf('manager'), FULL_SAMPLES);
		const home = stops.filter((stop) => stop.screen?.id === 'home');

		expect(home.map((stop) => stop.screen?.position)).toEqual([1, 2, 3]);
		expect(new Set(home.map((stop) => stop.screen?.total))).toEqual(new Set([3]));
	});
});

describe('тур экрана', () => {
	it('начинается вступлением и кончается ссылкой на статью справки', () => {
		const screen = TOUR_SCREENS.find((candidate) => candidate.id === 'reports');

		if (screen === undefined) {
			throw new Error('Экран отчётов пропал из реестра');
		}

		const stops = screenTourFor(screen, permissionsOf('lead'), '/w/b2b/reports');
		const last = stops[stops.length - 1];

		expect(stops[0].kind).toBe('intro');
		expect(stops[0].target).toBe(INTRO_TARGET);
		expect(stops.some((stop) => stop.kind === 'welcome')).toBe(false);
		expect(last.link).toEqual({
			href: '/help/user/reports',
			label: 'Подробнее: Отчёты'
		});
	});

	it('ведёт по тому адресу, на котором человек стоит', () => {
		const screen = TOUR_SCREENS.find((candidate) => candidate.id === 'interaction');

		if (screen === undefined) {
			throw new Error('Экран карточки взаимодействия пропал из реестра');
		}

		const href = '/interactions/2f0b0d3c-0000-4000-8000-000000000001';
		const stops = screenTourFor(screen, permissionsOf('manager'), href);

		expect(stops.every((stop) => stop.screen?.href === href)).toBe(true);
	});
});

describe('признаки на устройстве', () => {
	it('разводят учётные записи, роли и экраны', () => {
		expect(onboardingStorageKey('u1', 'manager')).toBe('lct-crm:onboarding:u1:manager');
		expect(onboardingScreenKey('u1', 'manager', 'reports')).toBe(
			'lct-crm:onboarding:u1:manager:screen:reports'
		);
		// Ключ экрана начинается с ключа полного тура: очистка одной учётной
		// записи уносит и её экраны.
		expect(
			onboardingScreenKey('u1', 'manager', 'reports').startsWith(
				onboardingStorageKey('u1', 'manager')
			)
		).toBe(true);
		expect(onboardingStorageKey('u1', 'admin')).not.toBe(onboardingStorageKey('u1', 'manager'));
	});

	it('образцы спрашиваются у маршрута приложения', () => {
		expect(TOUR_SAMPLES_PATH).toBe('/tour/samples');
		expect(appRoutes()).not.toContain(TOUR_SAMPLES_PATH);
	});
});
