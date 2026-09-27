/**
 * Путь дела после правки процесса: пройденная стадия, которую убрали из
 * процесса, остаётся в пути на своём месте, а стадия, вставленная туда, где
 * завершённое дело уже прошло, не стоит у него «впереди».
 */
import { describe, expect, it } from 'vitest';
import type { StageView } from '$lib/contracts/interactions';
import { buildProgress, type ProgressEntry } from '$lib/server/stages/status';

function stage(key: string, position: number): StageView {
	return {
		id: `stage-${key}`,
		revisionId: 'revision-2',
		position,
		key,
		name: `Стадия ${key}`,
		category: 'contact',
		slaDays: 5,
		staleAfterDays: null,
		requiresResult: false,
		requiresConfirmation: false,
		requiresLmsData: false,
		requiresDocumentMark: null,
		requiresDocumentTemplate: null,
		lmsGroupPurposes: null,
		onEnterNotify: null,
		isFinal: false,
		checklist: []
	};
}

function entry(key: string, position: number, day: number): ProgressEntry {
	return {
		stageId: `old-${key}`,
		stageKey: key,
		name: `Было ${key}`,
		position,
		category: 'contact',
		enteredAt: new Date(`2026-09-${String(day).padStart(2, '0')}T10:00:00Z`),
		leftAt: new Date(`2026-09-${String(day + 1).padStart(2, '0')}T10:00:00Z`)
	};
}

describe('путь завершённого дела после правки процесса', () => {
	it('удалённая пройденная стадия — на своём месте, вставленная позже — «добавлена после прохождения»', () => {
		// Дело прошло a → b → c; потом b убрали, а между a и c вставили new.
		const revision = [stage('a', 1), stage('new', 2), stage('c', 3)];
		const entries = [entry('a', 1, 1), entry('b', 2, 3), entry('c', 3, 5)];
		const introduced = new Map([
			['a', new Date('2026-09-01T00:00:00Z')],
			['new', new Date('2026-09-20T00:00:00Z')],
			['c', new Date('2026-09-01T00:00:00Z')]
		]);

		const progress = buildProgress(revision, entries, null, false, introduced);

		expect(progress.map((item) => [item.key, item.state, item.note, item.removed])).toEqual([
			['a', 'done', null, false],
			['b', 'done', 'удалена из процесса', true],
			['new', 'skipped', 'добавлена в процесс после прохождения', false],
			['c', 'done', null, false]
		]);
		expect(progress[1]).toMatchObject({ name: 'Было b', position: 2, checklist: [] });
	});
});
