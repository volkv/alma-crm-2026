/**
 * Переходы, которые доска предлагает карточке.
 *
 * Доска не решает, можно ли двигать запись, — она показывает приговор
 * `evaluateTransition`, того же, которым отказывает команда. Здесь проверяется
 * ровно это: с какой стадии берутся переходы, в каком порядке они едут и что
 * причина отказа доезжает до карточки словами.
 */
import { describe, expect, it } from 'vitest';
import type {
	ProcessRevisionView,
	StageSnapshot,
	StageTransitionView,
	StageView
} from '$lib/contracts/interactions';
import type { ActorContext } from '$lib/server/actor';
import { boardTransitions } from '$lib/server/interactions/board';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import type { StageState } from '$lib/server/stages/transitions';

const REVISION_ID = '11111111-1111-4111-8111-111111111111';

function actor(permissions: PermissionKey[]): ActorContext {
	return {
		requestId: '00000000-0000-4000-8000-00000000fee1',
		source: 'ui',
		user: {
			id: '33333333-3333-4333-8333-333333333333',
			email: 'tester@example.org',
			fullName: 'Тестовый Пользователь',
			roleId: 'manager',
			roleName: 'Менеджер',
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

function stage(position: number, key: string, name: string): StageView {
	return {
		id: `stage-${key}`,
		revisionId: REVISION_ID,
		position,
		key,
		name,
		category: 'contact',
		slaDays: 5,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: false,
		requiresLmsData: false,
		requiresDocumentMark: null,
		onEnterNotify: null,
		isFinal: false,
		checklist: []
	};
}

function snapshot(overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		key: 'contact',
		name: 'Поиск контактов',
		position: 1,
		category: 'contact',
		slaDays: 5,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: false,
		requiresLmsData: false,
		requiresDocumentMark: null,
		isFinal: false,
		checklist: [],
		...overrides
	};
}

function transition(
	from: string,
	to: string,
	overrides: Partial<StageTransitionView> = {}
): StageTransitionView {
	return {
		id: `${from}->${to}`,
		fromStageId: from,
		toStageId: to,
		kind: 'forward',
		requiredPermissionKey: 'stages.transition',
		requiresReason: false,
		...overrides
	};
}

const CONTACT = stage(1, 'contact', 'Поиск контактов');
const MEETING = stage(2, 'meeting', 'Встреча с представителями');
const DOCUMENTS = stage(3, 'documents', 'Обмен документами');

function route(transitions: StageTransitionView[]): ProcessRevisionView {
	return {
		id: REVISION_ID,
		workflowId: '22222222-2222-4222-8222-222222222222',
		version: 1,
		name: 'Процесс',
		note: null,
		publishedAt: new Date('2026-01-01T00:00:00.000Z'),
		stages: [CONTACT, MEETING, DOCUMENTS],
		transitions,
		migrationRules: []
	};
}

function state(overrides: Partial<StageState> = {}): StageState {
	return {
		stageId: MEETING.id,
		snapshot: snapshot(),
		checklistState: {},
		resultText: null,
		confirmation: null,
		lmsEvidence: null,
		documentMarkEvidence: null,
		isPaused: false,
		blockingBlockers: 0,
		...overrides
	};
}

describe('boardTransitions', () => {
	it('берёт только переходы с текущей стадии карточки', () => {
		const options = boardTransitions(
			actor(['stages.transition']),
			state(),
			route([
				transition(MEETING.id, DOCUMENTS.id),
				transition(CONTACT.id, MEETING.id),
				transition(MEETING.id, CONTACT.id, { kind: 'return', requiresReason: true })
			])
		);

		expect(options.map((option) => option.toStageId)).toEqual([CONTACT.id, DOCUMENTS.id]);
	});

	it('ставит переходы в порядке стадий маршрута, а не конфигурации', () => {
		const options = boardTransitions(
			actor(['stages.transition']),
			state(),
			route([
				transition(MEETING.id, DOCUMENTS.id),
				transition(MEETING.id, CONTACT.id, { kind: 'return', requiresReason: true })
			])
		);

		expect(options.map((option) => option.toStageName)).toEqual([CONTACT.name, DOCUMENTS.name]);
	});

	it('несёт вид перехода и требование причины', () => {
		const [back] = boardTransitions(
			actor(['stages.transition']),
			state(),
			route([transition(MEETING.id, CONTACT.id, { kind: 'return', requiresReason: true })])
		);

		expect(back).toMatchObject({ kind: 'return', requiresReason: true, allowed: true });
	});

	it('несёт требование причины и на шаге вперёд, не считая его отказом', () => {
		const [forward] = boardTransitions(
			actor(['stages.transition']),
			state(),
			route([transition(MEETING.id, DOCUMENTS.id, { requiresReason: true })])
		);

		// Причину человек вводит в диалоге карточки: отказ до ввода погасил бы
		// пункт меню, которым её как раз и вводят.
		expect(forward).toMatchObject({ kind: 'forward', requiresReason: true, allowed: true });
		expect(forward.reasons).toEqual([]);
	});

	it('отказывает без права перехода и называет причину словами', () => {
		const [forward] = boardTransitions(
			actor(['interactions.read']),
			state(),
			route([transition(MEETING.id, DOCUMENTS.id)])
		);

		expect(forward.allowed).toBe(false);
		expect(forward.reasons.join(' ')).toContain('stages.transition');
	});

	it('называет незакрытый чек-лист причиной отказа шага вперёд', () => {
		const [forward] = boardTransitions(
			actor(['stages.transition']),
			state({
				snapshot: snapshot({
					checklist: [{ key: 'call', label: 'Созвон проведён', required: true }]
				})
			}),
			route([transition(MEETING.id, DOCUMENTS.id)])
		);

		expect(forward.allowed).toBe(false);
		expect(forward.reasons.join(' ')).toContain('Созвон проведён');
	});

	it('не выдумывает названия стадии, которой в процессе нет', () => {
		const [outside] = boardTransitions(
			actor(['stages.transition']),
			state(),
			route([transition(MEETING.id, 'stage-unknown')])
		);

		expect(outside.toStageName).toBe('Стадия вне процесса');
	});
});
