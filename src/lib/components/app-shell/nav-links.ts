import { resolve } from '$app/paths';
import type { ResolvedPathname, Pathname } from '$app/types';
import { navSections, type NavSection } from '$lib/nav';

/** A section of the main navigation with its href already resolved. */
export type NavLink = Omit<NavSection, 'href'> & { href: ResolvedPathname };

/**
 * The navigation as the shell renders it. `nav.ts` stores plain paths because
 * most sections get their route later in the project; the assertion here states
 * what that list already promises — every entry is a path of this app — and
 * keeps it in one place instead of at every link.
 */
export const navLinks: readonly NavLink[] = navSections.map((section) => ({
	...section,
	// `resolve()` разбирает аргумент по ветвям объединения `Pathname`, и начиная
	// примерно с двадцати пяти маршрутов TypeScript перестаёт сопоставлять
	// объединение целиком хоть с одной ветвью. Путь раздела параметров не
	// содержит — `resolve()` только добавит базовый путь, — поэтому он подаётся
	// как одна ветвь объединения.
	href: resolve(section.href as Pathname & '/')
}));

/**
 * The section a pathname belongs to, or `undefined` for a page outside the
 * navigation (the overview, the kit). A section owns its own path and
 * everything under it, so a record page keeps its section highlighted.
 */
export function sectionFor(pathname: string): NavLink | undefined {
	return navLinks.find((link) => pathname === link.href || pathname.startsWith(`${link.href}/`));
}
