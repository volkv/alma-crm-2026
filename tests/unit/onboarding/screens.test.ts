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
	matchesQuery,
	screenForPath,
	TOUR_SCREENS,
	withQuery
} from '$lib/onboarding/screens';
import {
	guideFor,
	NAV_WORKSPACES_TARGET,
	navLinkHref,
	screenTourFor,
	SHELL_STEPS
} from '$lib/onboarding/tours';
import {
	guideStorageKey,
	onboardingScreenKey,
	onboardingStorageKey
} from '$lib/onboarding/storage';
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
 * ядро не знает, что на них.
 */
const WITHOUT_SCREEN = [
	'/ui-kit',
	'/help/print',
	'/help/[section]/[page]',
	'/w/[workspace]/m/[module]/[...path]'
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
});

describe('адрес экрана', () => {
	it('узнаёт открытую запись и не путает её со списком', () => {
		const card = screenForPath('/w/b2b/interactions/2f0b0d3c-0000-4000-8000-000000000001');

		expect(card?.id).toBe('interaction');
		expect(screenForPath('/w/b2b/interactions')?.id).toBe('interactions');
	});

	it('главная — это только корень', () => {
		expect(screenForPath('/')?.id).toBe('home');
		expect(screenForPath('/reports')?.id).toBe('reports');
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

describe('знакомство', () => {
	const HUMAN_ROLES = DEFAULT_ROLES.map((role) => role.id).filter((id) => id !== 'service');

	/** Меню роли так, как его видит знакомство. */
	const menuOf = (roleId: string) => visibleSections(MENU, permissionsOf(roleId));

	it('начинается приветствием и оболочкой, кончается финалом', () => {
		const stops = guideFor(menuOf('manager'));

		expect(stops[0].kind).toBe('welcome');
		expect(stops.slice(1, 1 + SHELL_STEPS.length).map((stop) => stop.kind)).toEqual(
			SHELL_STEPS.map(() => 'shell')
		);
		expect(stops[stops.length - 1].kind).toBe('finish');
	});

	it('первым разделом показывает пространства и называет каждое', () => {
		for (const roleId of HUMAN_ROLES) {
			const stops = guideFor(menuOf(roleId));
			const workspaces = stops[1 + SHELL_STEPS.length];

			expect(workspaces.target, roleId).toBe(NAV_WORKSPACES_TARGET);

			for (const workspace of NAV_WORKSPACES) {
				expect(workspaces.body, roleId).toContain(`«${workspace.name}»`);
			}
		}
	});

	it('показывает только пункты меню, которые роль видит, и открывает их страницы', () => {
		for (const roleId of HUMAN_ROLES) {
			const menu = menuOf(roleId);
			const hrefs = new Set(menu.map((link) => link.href));

			for (const stop of guideFor(menu).filter((candidate) => candidate.kind === 'section')) {
				if (stop.target === NAV_WORKSPACES_TARGET) {
					continue;
				}

				const href = navLinkHref(stop.target ?? '');

				expect(href !== null && hrefs.has(href), `${roleId} → ${stop.id}`).toBe(true);
				expect(stop.screen?.href, `${roleId} → ${stop.id}`).toBe(href);
			}
		}
	});

	it('администратору показывает настройки пространств и процессов раньше взаимодействий', () => {
		const ids = guideFor(menuOf('admin')).map((stop) => stop.id);
		const at = (id: string) => ids.indexOf(`guide:${id}`);

		expect(at('workspaces')).toBeGreaterThan(0);
		expect(at('settings-workspaces')).toBeGreaterThan(at('workspaces'));
		expect(at('settings-workflows')).toBeGreaterThan(at('settings-workspaces'));
		expect(at('interactions')).toBeGreaterThan(at('settings-workflows'));
		expect(at('organizations')).toBeGreaterThan(at('interactions'));
		expect(at('data')).toBe(ids.length - 2);
	});

	it('менеджеру настроек не показывает', () => {
		const ids = guideFor(menuOf('manager')).map((stop) => stop.id);

		expect(ids).not.toContain('guide:settings-workspaces');
		expect(ids).not.toContain('guide:users');
		expect(ids).toContain('guide:interactions');
	});

	it('без разделов в меню знакомить не с чем', () => {
		expect(guideFor([])).toEqual([]);
	});
});

describe('тур экрана', () => {
	it('начинается вступлением и кончается ссылкой на статью справки', () => {
		const screen = TOUR_SCREENS.find((candidate) => candidate.id === 'reports');

		if (screen === undefined) {
			throw new Error('Экран отчётов пропал из реестра');
		}

		const stops = screenTourFor(screen, permissionsOf('lead'), '/reports');
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
		// Все ключи начинаются с ключа учётной записи и роли: очистка одной
		// учётной записи уносит и знакомство, и её экраны.
		expect(
			onboardingScreenKey('u1', 'manager', 'reports').startsWith(
				onboardingStorageKey('u1', 'manager')
			)
		).toBe(true);
		expect(onboardingStorageKey('u1', 'admin')).not.toBe(onboardingStorageKey('u1', 'manager'));
		// Знакомство — свой признак, не прежнего полного тура: закрывшим старый тур
		// его предложат заново.
		expect(guideStorageKey('u1', 'manager')).toBe('lct-crm:onboarding:u1:manager:guide');
	});

	it('режим шага меняет только свои параметры адреса, отбор человека остаётся', () => {
		const query = { view: 'table', overdue: null };
		const href = withQuery('/w/b2b/interactions', '?owner=u1&overdue=true&view=board', query);

		expect(href).toBe('/w/b2b/interactions?owner=u1&view=table');
		expect(matchesQuery(new URL(`http://x${href}`), query)).toBe(true);
		expect(matchesQuery(new URL('http://x/w/b2b/interactions?view=board'), query)).toBe(false);
		expect(matchesQuery(new URL('http://x/w/b2b/interactions?any=1'), null)).toBe(true);
	});
});
