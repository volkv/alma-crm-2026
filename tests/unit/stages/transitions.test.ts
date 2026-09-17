/**
 * Готовность перехода — правило, а не подсказка интерфейса: по одному и тому же
 * ответу рисуется кнопка в карточке и отказывает команда. Поэтому каждая
 * причина отказа проверяется по отдельности.
 */
import { describe, expect, it } from 'vitest';
import type {
	ChecklistState,
	StageSnapshot,
	StageTransitionView
} from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { evaluateTransition, type StageState } from '$lib/server/stages/transitions';
import type { PermissionKey } from '$lib/server/rbac/permissions';

const STAGE_ID = '11111111-1111-4111-8111-111111111111';
const NEXT_STAGE_ID = '22222222-2222-4222-8222-222222222222';

function actor(permissions: PermissionKey[]): ActorContext {
	return {
		requestId: '00000000-0000-4000-8000-00000000fee1',
		source: 'ui',
		user: {
			id: '33333333-3333-4333-8333-333333333333',
			email: 'tester@example.org',
			fullName: 'Тестовый Пользователь',
			roleId: 'manager',
			permissions: new Set<string>(permissions),
			isDemo: false,
			scope: { kind: 'all' }
		},
		apiKeyId: null,
		ip: null,
		userAgent: null,
		scope: { kind: 'all' }
	};
}

function snapshot(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		key: 'document_exchange',
		name: 'Обмен пакетом документов',
		position: 4,
		category: 'documents',
		slaDays: 10,
		staleAfterDays: 7,
		requiresResult: false,
		requiresConfirmation: false,
		requiresLmsData: false,
		isFinal: false,
		checklist: [],
		...overrides
	};
}

function state(overrides: Partial<StageState> = {}): StageState {
	return {
		stageId: STAGE_ID,
		snapshot: snapshot(),
		checklistState: {},
		resultText: null,
		confirmation: null,
		lmsEvidence: null,
		isPaused: false,
		blockingBlockers: 0,
		...overrides
	};
}

function transition(overrides: Partial<StageTransitionView> = {}): StageTransitionView {
	return {
		id: '44444444-4444-4444-8444-444444444444',
		fromStageId: STAGE_ID,
		toStageId: NEXT_STAGE_ID,
		kind: 'forward',
		requiredPermissionKey: 'stages.transition',
		requiresReason: false,
		...overrides
	};
}

const worker = actor(['stages.transition']);

const REQUIRED_ITEM = { key: 'package_sent', label: 'Пакет документов отправлен', required: true };
const OPTIONAL_ITEM = { key: 'package_received', label: 'Получен ответный пакет', required: false };

describe('evaluateTransition', () => {
	it('разрешает шаг вперёд, когда стадии ничего не нужно', () => {
		expect(evaluateTransition(worker, state(), transition())).toEqual({
			allowed: true,
			reasons: []
		});
	});

	it('требует право, которое назначено переходу', () => {
		const verdict = evaluateTransition(actor(['interactions.read']), state(), transition());

		expect(verdict.allowed).toBe(false);
		expect(verdict.reasons).toContain('Недостаточно прав: требуется «stages.transition»');
	});

	it('не пускает по праву, которого нет в каталоге', () => {
		const verdict = evaluateTransition(
			worker,
			state(),
			transition({ requiredPermissionKey: 'stages.teleport' })
		);

		expect(verdict.allowed).toBe(false);
		expect(verdict.reasons).toContain(
			'Переход требует права «stages.teleport», которого нет в каталоге'
		);
	});

	it('отказывает, если взаимодействие уже на другой стадии', () => {
		const verdict = evaluateTransition(worker, state({ stageId: NEXT_STAGE_ID }), transition());

		expect(verdict.allowed).toBe(false);
		expect(verdict.reasons).toContain(
			'Взаимодействие уже не на той стадии, с которой возможен этот переход'
		);
	});

	it('отказывает при открытой помехе, запрещающей переход', () => {
		const verdict = evaluateTransition(worker, state({ blockingBlockers: 1 }), transition());

		expect(verdict.allowed).toBe(false);
		expect(verdict.reasons).toContain('Есть открытые помехи, запрещающие переход');
	});

	it('не пускает вперёд со стадии на паузе', () => {
		const verdict = evaluateTransition(worker, state({ isPaused: true }), transition());

		expect(verdict.allowed).toBe(false);
		expect(verdict.reasons).toContain('Стадия на паузе: сначала снимите паузу');
	});

	it('перечисляет каждый незакрытый обязательный пункт чек-листа', () => {
		const verdict = evaluateTransition(
			worker,
			state({ snapshot: snapshot({ checklist: [REQUIRED_ITEM, OPTIONAL_ITEM] }) }),
			transition()
		);

		expect(verdict.allowed).toBe(false);
		expect(verdict.reasons).toEqual([
			'Не закрыт обязательный пункт чек-листа: «Пакет документов отправлен»'
		]);
	});

	it('засчитывает отметки, которые команда применит вместе с переходом', () => {
		const checklistState: ChecklistState = { [REQUIRED_ITEM.key]: true };

		const verdict = evaluateTransition(
			worker,
			state({ snapshot: snapshot({ checklist: [REQUIRED_ITEM] }) }),
			transition(),
			{ checklistState }
		);

		expect(verdict).toEqual({ allowed: true, reasons: [] });
	});

	it('требует результат там, где стадия его требует', () => {
		const requiring = state({ snapshot: snapshot({ requiresResult: true }) });

		expect(evaluateTransition(worker, requiring, transition()).reasons).toContain(
			'У стадии не записан результат'
		);
		expect(
			evaluateTransition(worker, requiring, transition(), { resultText: 'Материалы переданы' })
		).toEqual({ allowed: true, reasons: [] });
		expect(
			evaluateTransition(worker, { ...requiring, resultText: '   ' }, transition()).reasons
		).toContain('У стадии не записан результат');
	});

	it('требует подтверждение там, где стадия его требует', () => {
		const requiring = state({ snapshot: snapshot({ requiresConfirmation: true }) });

		expect(evaluateTransition(worker, requiring, transition()).reasons).toContain(
			'Стадия не подтверждена'
		);
		expect(
			evaluateTransition(
				worker,
				{
					...requiring,
					confirmation: {
						kind: 'mark',
						byUserId: '33333333-3333-4333-8333-333333333333',
						at: '2026-09-12T10:00:00+03:00'
					}
				},
				transition()
			)
		).toEqual({ allowed: true, reasons: [] });
	});

	it('требует данные обучения там, где стадия их требует', () => {
		const requiring = state({ snapshot: snapshot({ requiresLmsData: true }) });

		expect(evaluateTransition(worker, requiring, transition()).reasons).toContain(
			'По стадии не получены данные системы обучения'
		);

		// Факты приходят по взаимодействию, а не по стадии: важно, что они есть,
		// а не когда именно пришли.
		expect(
			evaluateTransition(
				worker,
				{ ...requiring, lmsEvidence: { system: 'moodle', groupId: 'g-1' } },
				transition()
			)
		).toEqual({ allowed: true, reasons: [] });

		// На возврате пятый вопрос не задаётся: возврат — выход из тупика.
		expect(
			evaluateTransition(worker, requiring, transition({ kind: 'return' }), {
				reason: 'Поток отменён вузом'
			})
		).toEqual({ allowed: true, reasons: [] });
	});

	it('требует причину, когда команда уже собрана, и молчит про неё в сводке', () => {
		const returning = transition({ kind: 'return', requiresReason: true });

		// Сводка спрашивает без команды: причину человек введёт в диалоге.
		expect(evaluateTransition(worker, state(), returning)).toEqual({ allowed: true, reasons: [] });
		expect(evaluateTransition(worker, state(), returning, { reason: '  ' }).reasons).toContain(
			'Нужно объяснить причину'
		);
		expect(
			evaluateTransition(worker, state(), returning, { reason: 'Вуз переоформляет документы' })
		).toEqual({ allowed: true, reasons: [] });
	});

	it('требует причину и от шага вперёд, если так настроен переход', () => {
		const forward = transition({ requiresReason: true });

		// Требование принадлежит переходу, а не его виду: включённое на шаге
		// вперёд, оно обязано и проверяться, и быть выполнимым.
		expect(evaluateTransition(worker, state(), forward)).toEqual({ allowed: true, reasons: [] });
		expect(evaluateTransition(worker, state(), forward, { reason: null }).reasons).toContain(
			'Нужно объяснить причину'
		);
		expect(
			evaluateTransition(worker, state(), forward, { reason: 'Программа согласована деканатом' })
		).toEqual({ allowed: true, reasons: [] });
	});

	it('не требует от возврата закрытого чек-листа, результата и подтверждения', () => {
		const stuck = state({
			snapshot: snapshot({
				checklist: [REQUIRED_ITEM],
				requiresResult: true,
				requiresConfirmation: true,
				requiresLmsData: true
			}),
			isPaused: true
		});

		const forward = evaluateTransition(worker, stuck, transition());
		const back = evaluateTransition(worker, stuck, transition({ kind: 'return' }), {
			reason: 'Документы отозваны'
		});

		expect(forward.allowed).toBe(false);
		expect(forward.reasons).toHaveLength(5);
		// Возврат — это выход из тупика: требовать для него то, из-за чего застряли,
		// значит запереть процесс.
		expect(back).toEqual({ allowed: true, reasons: [] });
	});

	it('перечисляет все причины сразу, а не только первую', () => {
		const verdict = evaluateTransition(
			actor([]),
			state({ stageId: NEXT_STAGE_ID, blockingBlockers: 2, isPaused: true }),
			transition()
		);

		expect(verdict.allowed).toBe(false);
		expect(verdict.reasons).toHaveLength(4);
	});
});
