/**
 * Подсказки первого входа: что показывается роли и на каком экране.
 *
 * Две вещи здесь важнее остальных. Шаг обещает экран — и если право на этот
 * экран роли не досталось, обещание ложное: проверка сверяет тур каждой роли с
 * её собственным набором прав из каталога. И шаг обязан узнавать «свой» адрес,
 * включая адрес открытой записи: карточка взаимодействия — тот же раздел, что и
 * список, иначе тур на ней предлагал бы перейти туда, где человек уже стоит.
 */
import { describe, expect, it } from 'vitest';
import { isStepScreen, ONBOARDING_TOURS, tourFor } from '$lib/onboarding/steps';
import { DEFAULT_ROLES } from '$lib/server/rbac/permissions';

/** Права роли из каталога — те же, что сидируются в базу. */
function permissionsOf(roleId: string): ReadonlySet<string> {
	const role = DEFAULT_ROLES.find((candidate) => candidate.id === roleId);

	if (role === undefined) {
		throw new Error(`Роль «${roleId}» не заведена в каталоге`);
	}

	return new Set<string>(role.permissions);
}

const ROLE_IDS = Object.keys(ONBOARDING_TOURS);

/**
 * Роли, которыми в систему входит человек. `service` — ключи обмена: войти ею
 * нельзя (`src/lib/server/auth/identity.ts`), и показывать ей нечего.
 */
const HUMAN_ROLE_IDS = DEFAULT_ROLES.map((role) => role.id).filter((id) => id !== 'service');

describe('тур по ролям', () => {
	it('заведён каждой роли человека и держится в границах трёх-пяти шагов', () => {
		expect([...ROLE_IDS].sort()).toEqual([...HUMAN_ROLE_IDS].sort());

		for (const roleId of ROLE_IDS) {
			const steps = ONBOARDING_TOURS[roleId] ?? [];

			expect(steps.length, roleId).toBeGreaterThanOrEqual(3);
			expect(steps.length, roleId).toBeLessThanOrEqual(5);
		}
	});

	it('шаги роли называются и метятся по одному разу', () => {
		for (const roleId of ROLE_IDS) {
			const steps = ONBOARDING_TOURS[roleId] ?? [];

			expect(new Set(steps.map((step) => step.id)).size, roleId).toBe(steps.length);
			expect(new Set(steps.map((step) => step.target)).size, roleId).toBe(steps.length);

			for (const step of steps) {
				expect(step.title.length, `${roleId}/${step.id}`).toBeGreaterThan(0);
				expect(step.body.length, `${roleId}/${step.id}`).toBeGreaterThan(0);
				expect(step.route.href.startsWith('/'), `${roleId}/${step.id}`).toBe(true);
			}
		}
	});

	it('не обещает роли экран, которого ей не откроют', () => {
		for (const roleId of ROLE_IDS) {
			const allowed = tourFor(roleId, permissionsOf(roleId));

			expect(allowed, roleId).toEqual(ONBOARDING_TOURS[roleId]);
		}
	});

	it('шаг с правом выпадает, когда права нет', () => {
		const admin = ONBOARDING_TOURS.admin ?? [];
		const open = admin.filter((step) => step.permission === undefined);

		// Демонстрационная сессия и урезанная роль приходят сюда одинаково: с
		// набором прав, из которого что-то вынули.
		expect(tourFor('admin', new Set())).toEqual(open);
		expect(open.length).toBeGreaterThan(0);
		expect(open.length).toBeLessThan(admin.length);
	});

	it('роли без тура показывать нечего', () => {
		expect(tourFor('auditor', new Set(['interactions.read']))).toEqual([]);
	});
});

describe('экран шага', () => {
	const cardStep = (ONBOARDING_TOURS.manager ?? []).find((step) => step.id === 'card');
	const homeStep = (ONBOARDING_TOURS.manager ?? []).find((step) => step.id === 'home');

	it('узнаёт открытую запись своего раздела', () => {
		if (cardStep === undefined) {
			throw new Error('Шаг карточки взаимодействия пропал из тура менеджера');
		}

		expect(isStepScreen(cardStep, '/interactions')).toBe(true);
		expect(isStepScreen(cardStep, '/interactions/2f0b0d3c-0000-4000-8000-000000000001')).toBe(true);
		expect(isStepScreen(cardStep, '/')).toBe(false);
		// Чужой раздел с тем же началом адреса — не свой экран.
		expect(isStepScreen(cardStep, '/interactions-board')).toBe(false);
	});

	it('главная — это только корень', () => {
		if (homeStep === undefined) {
			throw new Error('Шаг сводки пропал из тура менеджера');
		}

		expect(isStepScreen(homeStep, '/')).toBe(true);
		expect(isStepScreen(homeStep, '/reports')).toBe(false);
	});
});
