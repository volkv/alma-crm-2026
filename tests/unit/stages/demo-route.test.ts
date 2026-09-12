/**
 * Демонстрационный маршрут — это конфигурация, а конфигурацию ломают молча:
 * переход на несуществующую стадию или разъехавшиеся позиции видно только в
 * работающей системе. Поэтому он проверяется теми же правилами, что и любой
 * маршрут, заведённый руками.
 */
import { describe, expect, it } from 'vitest';
import { createRouteSchema } from '$lib/contracts/interactions';
import { DEMO_ROUTE, DEMO_ROUTE_KEY } from '$lib/server/stages/demo-route';
import { PERMISSION_KEYS } from '$lib/server/rbac/permissions';

const route = createRouteSchema.parse(DEMO_ROUTE);
const stageKeys = route.stages.map((stage) => stage.key);

describe('демонстрационный маршрут', () => {
	it('проходит проверку схемы маршрута', () => {
		expect(createRouteSchema.safeParse(DEMO_ROUTE).success).toBe(true);
		expect(route.key).toBe(DEMO_ROUTE_KEY);
		expect(route.isDefault).toBe(true);
	});

	it('описывает четырнадцать стадий с уникальными ключами и названиями', () => {
		expect(route.stages).toHaveLength(14);
		expect(new Set(stageKeys).size).toBe(14);
		expect(new Set(route.stages.map((stage) => stage.name)).size).toBe(14);
	});

	it('называет стадию, а не её смысловую группу', () => {
		for (const stage of route.stages) {
			expect(stage.name).not.toBe(stage.category);
			expect(stage.name).toMatch(/[А-Яа-я]/);
		}
	});

	it('держит правдоподобные нормативы и сроки протухания', () => {
		for (const stage of route.stages) {
			expect(stage.slaDays).toBeGreaterThanOrEqual(5);
			expect(stage.slaDays).toBeLessThanOrEqual(30);
			expect(stage.staleAfterDays).not.toBeNull();
			expect(stage.staleAfterDays ?? 0).toBeLessThanOrEqual(stage.slaDays);
		}
	});

	it('даёт каждой стадии чек-лист с обязательными пунктами', () => {
		for (const stage of route.stages) {
			expect(stage.checklist.length).toBeGreaterThanOrEqual(2);
			expect(stage.checklist.length).toBeLessThanOrEqual(4);
			expect(stage.checklist.some((item) => item.required)).toBe(true);
			expect(new Set(stage.checklist.map((item) => item.key)).size).toBe(stage.checklist.length);
		}
	});

	it('ссылается переходами только на свои стадии и на существующие права', () => {
		const known = new Set(stageKeys);
		const permissions = new Set<string>(PERMISSION_KEYS);

		for (const transition of route.transitions) {
			expect(known.has(transition.fromStageKey)).toBe(true);
			expect(known.has(transition.toStageKey)).toBe(true);
			expect(permissions.has(transition.requiredPermissionKey)).toBe(true);
		}
	});

	it('ведёт вперёд по цепочке и назад на предыдущую стадию с объяснением', () => {
		const forward = route.transitions.filter((transition) => transition.kind === 'forward');
		const back = route.transitions.filter((transition) => transition.kind === 'return');

		expect(forward).toHaveLength(13);
		expect(back).toHaveLength(13);

		forward.forEach((transition, index) => {
			expect(transition.fromStageKey).toBe(stageKeys[index]);
			expect(transition.toStageKey).toBe(stageKeys[index + 1]);
			expect(transition.requiresReason).toBe(false);
		});

		for (const transition of back) {
			const from = stageKeys.indexOf(transition.fromStageKey);
			expect(transition.toStageKey).toBe(stageKeys[from - 1]);
			// Возврат всегда объясняют: иначе в истории останется «кто-то передумал».
			expect(transition.requiresReason).toBe(true);
		}
	});

	it('позволяет перешагнуть корректировку документов', () => {
		const skips = route.transitions.filter((transition) => transition.kind === 'skip');

		expect(skips).toHaveLength(1);
		expect(skips[0].fromStageKey).toBe('document_exchange');
		expect(skips[0].toStageKey).toBe('signing');
		expect(skips[0].requiresReason).toBe(true);
		// Перешагнуть можно ровно одну стадию — ту, без которой процесс бывает.
		expect(stageKeys.indexOf('signing') - stageKeys.indexOf('document_exchange')).toBe(2);
	});

	it('между двумя стадиями держит не больше одного перехода', () => {
		const pairs = route.transitions.map(
			(transition) => `${transition.fromStageKey}→${transition.toStageKey}`
		);

		expect(new Set(pairs).size).toBe(pairs.length);
	});

	it('требует результат и подтверждение там, где стадия что-то передаёт', () => {
		const byKey = new Map(route.stages.map((stage) => [stage.key, stage]));

		for (const key of ['materials_handover', 'teacher_training', 'classes']) {
			expect(byKey.get(key)?.requiresResult).toBe(true);
			expect(byKey.get(key)?.requiresConfirmation).toBe(true);
		}

		expect(byKey.get('contact_search')?.requiresResult).toBe(false);
		expect(byKey.get('documentation_update')?.requiresResult).toBe(true);
		expect(byKey.get('documentation_update')?.requiresConfirmation).toBe(false);
	});
});
