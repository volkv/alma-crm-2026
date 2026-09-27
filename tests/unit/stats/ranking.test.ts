/**
 * Рейтинг по фактам системы.
 *
 * Два обещания экрана: сумма слагаемых вместе с поправкой за приоритет равна
 * баллу — иначе объяснение не объясняет, — и одни и те же люди не считаются
 * дважды: у группы берётся последний результат, а заявка с двумя программами
 * одного направления даёт направлению одну заявку.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RANKING_WEIGHTS,
	explainPlace,
	rankSubjects,
	scoreFacts
} from '$lib/contracts/ranking';
import { aggregateFacts, latestResults, type GroupFact } from '$lib/server/stats/facts';

const WEIGHTS = DEFAULT_RANKING_WEIGHTS;

describe('балл', () => {
	it('равен сумме вкладов и поправки за ручной приоритет', () => {
		const score = scoreFacts(
			{ applications: 4, streams: 2, enrolled: 50, completed: 40 },
			WEIGHTS,
			1
		);

		expect(score.priorityBonus).toBe(5 * WEIGHTS.priorityStep);
		expect(score.score).toBe(
			score.components.reduce((total, part) => total + part.contribution, 0) + score.priorityBonus
		);
	});

	it('объясняет место отрывом от соседа и называет приоритет решением человека', () => {
		const ranked = rankSubjects(
			[
				{
					id: 'a',
					code: 'A',
					name: 'Первая',
					facts: { applications: 0, streams: 1, enrolled: 20, completed: null },
					priority: null,
					organizationCount: 1
				},
				{
					id: 'b',
					code: 'B',
					name: 'Вторая',
					facts: { applications: 0, streams: 1, enrolled: 20, completed: null },
					priority: 2,
					organizationCount: 1
				}
			],
			WEIGHTS
		);

		expect(ranked.map((entry) => entry.id)).toStrictEqual(['b', 'a']);
		expect(explainPlace(ranked, 1)).toContain(`На ${4 * WEIGHTS.priorityStep} баллов меньше`);
		expect(explainPlace(ranked, 0)).toContain('Ручной приоритет 2');
		// Места по одним фактам: при равных фактах выше тот, чей код меньше, —
		// итоговое первое место «Вторая» получила приоритетом, и это сказано.
		expect(ranked.map((entry) => [entry.id, entry.place, entry.factPlace])).toStrictEqual([
			['b', 1, 2],
			['a', 2, 1]
		]);
		expect(explainPlace(ranked, 0)).toContain(
			'По одним фактам, без ручного приоритета, — 2-е место'
		);
	});
});

describe('без двойного счёта', () => {
	it('у группы берётся последний результат, а не сумма всех', () => {
		const latest = latestResults([
			{
				learningGroupId: 'g',
				occurredAt: new Date('2026-06-30T10:00:00Z'),
				enrolled: 25,
				completed: 20,
				finishedOn: '2026-06-30'
			},
			{
				learningGroupId: 'g',
				occurredAt: new Date('2026-03-01T10:00:00Z'),
				enrolled: 25,
				completed: 0,
				finishedOn: null
			}
		]);

		expect(latest.get('g')?.completed).toBe(20);
	});

	it('заявка с двумя программами одного направления даёт ему одну заявку', () => {
		const direction = () => 'd';
		const groups: GroupFact[] = [
			{
				groupId: 'g1',
				label: 'LMS-1',
				programId: 'p1',
				organizationId: 'o1',
				hasResult: true,
				enrolled: 25,
				completed: 20
			}
		];
		const byDirection = aggregateFacts(
			[
				{ interactionId: 'i1', programId: 'p1', organizationId: 'o1' },
				{ interactionId: 'i1', programId: 'p2', organizationId: 'o1' }
			],
			groups,
			direction
		);
		const byProgram = aggregateFacts(
			[
				{ interactionId: 'i1', programId: 'p1', organizationId: 'o1' },
				{ interactionId: 'i1', programId: 'p2', organizationId: 'o1' }
			],
			groups,
			(programId) => programId
		);

		expect(byDirection.get('d')).toStrictEqual({
			applications: 1,
			streams: 1,
			enrolled: 25,
			completed: 20,
			organizationCount: 1
		});
		expect(byProgram.get('p1')?.applications).toBe(1);
		expect(byProgram.get('p2')?.applications).toBe(1);
	});
});
