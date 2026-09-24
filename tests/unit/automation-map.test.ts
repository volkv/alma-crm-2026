/**
 * Карта автоматизации против процесса и дерева маршрутов.
 *
 * Карта обещает: у каждого из четырнадцати шагов базового процесса есть хотя бы
 * одна автоматизация, и каждая показана на экране, куда ведёт ссылка. Обещание
 * держится, пока реестр сверен с процессом (шаг назван существующей стадией, в
 * её порядке) и со страницами приложения (ссылка — на маршрут, который есть).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_CROSS_CUTTING, AUTOMATION_STEPS, automationScreen } from '$lib/automation-map';
import { B2B_PROCESS, B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';

const APP_ROUTES = fileURLToPath(new URL('../../src/routes/(app)', import.meta.url));

describe('карта автоматизации', () => {
	it('идёт по всем стадиям базового процесса в их порядке', () => {
		expect(AUTOMATION_STEPS.map((step) => step.stageKey)).toEqual(
			B2B_PROCESS.stages.map((stage) => stage.key)
		);
		expect(AUTOMATION_STEPS).toHaveLength(14);
	});

	it('даёт каждому шагу от одного до трёх пунктов', () => {
		for (const step of AUTOMATION_STEPS) {
			expect(step.actions.length, step.stageKey).toBeGreaterThanOrEqual(1);
			expect(step.actions.length, step.stageKey).toBeLessThanOrEqual(3);
		}
	});

	it('ведёт каждой ссылкой на существующую страницу', () => {
		const actions = [
			...AUTOMATION_STEPS.flatMap((step) => step.actions),
			...AUTOMATION_CROSS_CUTTING
		];

		for (const action of actions) {
			const screen = automationScreen(action.screen, B2B_WORKSPACE_KEY);
			// Адрес собран из маршрута реестра подсказок; страница по нему — это
			// `+page.svelte` в каталоге маршрута, с тем же ключом пространства.
			const route = screen.href.replace(`/w/${B2B_WORKSPACE_KEY}/`, '/w/[workspace]/');

			expect(existsSync(`${APP_ROUTES}${route}/+page.svelte`), action.title).toBe(true);
			expect(screen.help, action.title).not.toBeNull();
		}
	});
});
