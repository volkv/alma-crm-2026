/**
 * Процессы поставки — это конфигурация, а конфигурацию ломают молча: переход на
 * несуществующую стадию или разъехавшиеся позиции видно только в работающей
 * системе. Поэтому они проверяются теми же правилами, что и любой черновик,
 * заведённый руками.
 */
import { describe, expect, it } from 'vitest';
import { processDefinitionSchema } from '$lib/contracts/interactions';
import { B2B_PROCESS, B2C_PROCESS } from '$lib/server/stages/definitions';
import { PERMISSION_KEYS } from '$lib/server/rbac/permissions';

const route = processDefinitionSchema.parse(B2B_PROCESS);
const b2c = processDefinitionSchema.parse(B2C_PROCESS);
const stageKeys = route.stages.map((stage) => stage.key);

describe('процесс учебных заведений', () => {
	it('проходит проверку схемы процесса', () => {
		expect(processDefinitionSchema.safeParse(B2B_PROCESS).success).toBe(true);
		expect(route.migrationRules).toEqual([]);
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

	it('заканчивается ровно одной финальной стадией — контролем исполнения', () => {
		const finals = route.stages.filter((stage) => stage.isFinal);

		expect(finals.map((stage) => stage.key)).toEqual(['execution_control']);
	});

	it('требует отметку «Утверждён» по документу ровно на стадии подписания', () => {
		// Стадия, исполнение которой доказывает сам документ. Требовать отметку от
		// стадий, на которых документ ещё не подписан, значит запереть процесс, а
		// не проверить его.
		const requiring = route.stages.filter((stage) => stage.requiresDocumentMark !== null);

		expect(requiring.map((stage) => stage.key)).toEqual(['signing']);
		expect(requiring[0].requiresDocumentMark).toBe('approved');
	});

	it('требует данных обучения ровно на стадии занятий', () => {
		// Факт из системы обучения — единственное доказательство исполнения,
		// которое пишет не сам исполнитель. Требовать его от стадий, работа
		// которых в системе обучения не отражается, значит запереть процесс.
		expect(route.stages.filter((stage) => stage.requiresLmsData).map((stage) => stage.key)).toEqual(
			['classes']
		);
	});
});

describe('процесс физических и юридических лиц', () => {
	it('проходит проверку схемы процесса и описывает пять стадий', () => {
		expect(processDefinitionSchema.safeParse(B2C_PROCESS).success).toBe(true);
		expect(b2c.stages.map((stage) => stage.key)).toEqual([
			'lead_intake',
			'offer',
			'contract_payment',
			'learning',
			'completion'
		]);
	});

	it('ведёт цепочкой вперёд, возвращает с каждой стадии и пропускает предложение', () => {
		const keys = b2c.stages.map((stage) => stage.key);
		const forward = b2c.transitions.filter((transition) => transition.kind === 'forward');
		const back = b2c.transitions.filter((transition) => transition.kind === 'return');
		const skips = b2c.transitions.filter((transition) => transition.kind === 'skip');

		expect(forward).toHaveLength(4);
		expect(back).toHaveLength(4);

		forward.forEach((transition, index) => {
			expect(transition.fromStageKey).toBe(keys[index]);
			expect(transition.toStageKey).toBe(keys[index + 1]);
		});

		for (const transition of back) {
			const from = keys.indexOf(transition.fromStageKey);
			expect(transition.toStageKey).toBe(keys[from - 1]);
			expect(transition.requiresReason).toBe(true);
		}

		// Повторному слушателю предложение не нужно: с приёма заявки идут сразу
		// к договору.
		expect(skips).toHaveLength(1);
		expect(skips[0].fromStageKey).toBe('lead_intake');
		expect(skips[0].toStageKey).toBe('contract_payment');
	});

	it('заканчивается выдачей документа об обучении и требует файл на договоре', () => {
		const byKey = new Map(b2c.stages.map((stage) => [stage.key, stage]));

		expect(b2c.stages.filter((stage) => stage.isFinal).map((stage) => stage.key)).toEqual([
			'completion'
		]);
		expect(byKey.get('contract_payment')?.requiresConfirmation).toBe(true);
		expect(byKey.get('completion')?.requiresResult).toBe(true);
	});

	it('не требует отметок по документам ни на одной стадии', () => {
		// Короткий процесс физических лиц идёт без соглашения сторон: требование
		// отметки заперло бы его на первой же стадии.
		expect(b2c.stages.filter((stage) => stage.requiresDocumentMark !== null)).toEqual([]);
	});

	it('требует данных обучения ровно на стадии обучения', () => {
		// Обучение идёт в чужой системе — и здесь, и у учебных заведений: стадия
		// отпускает вперёд, когда результат потока пришёл оттуда.
		expect(b2c.stages.filter((stage) => stage.requiresLmsData).map((stage) => stage.key)).toEqual([
			'learning'
		]);
	});

	it('не делит ключи стадий с процессом учебных заведений', () => {
		// Делить их было бы законно — идентичность стадии это пара «группа + ключ»,
		// — но одинаковые ключи в двух процессах путают того, кто читает журнал.
		const shared = b2c.stages.map((stage) => stage.key).filter((key) => stageKeys.includes(key));

		expect(shared).toEqual([]);
	});
});
