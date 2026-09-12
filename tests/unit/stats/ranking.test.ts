/**
 * Объяснение рейтинга.
 *
 * Проверяется ровно одно обещание интерфейса: сумма слагаемых в колонке
 * «почему» равна баллу. Разошлись бы они — и объяснение перестало бы объяснять,
 * а рейтинг превратился в число, которое предлагают принять на веру.
 */
import { describe, expect, it } from 'vitest';
import {
	explainScore,
	RANKING_COMPONENT_KEYS,
	RANKING_WEIGHTS,
	type RankingComponentKey
} from '$lib/contracts/stats';

function values(
	input: Partial<Record<RankingComponentKey, number | null>>
): Record<RankingComponentKey, number | null> {
	return {
		applications: input.applications ?? null,
		enrolled: input.enrolled ?? null,
		parallelStreams: input.parallelStreams ?? null
	};
}

describe('балл программы', () => {
	it('складывается из вкладов, и сумма вкладов равна баллу', () => {
		const { score, explanation } = explainScore(
			values({ applications: 120, enrolled: 90, parallelStreams: 4 })
		);

		expect(score).toBe(
			120 * RANKING_WEIGHTS.applications +
				90 * RANKING_WEIGHTS.enrolled +
				4 * RANKING_WEIGHTS.parallelStreams
		);
		expect(explanation.reduce((total, part) => total + part.contribution, 0)).toBe(score);
	});

	it('называет каждое слагаемое вместе с его весом', () => {
		const { explanation } = explainScore(values({ applications: 10 }));

		expect(explanation.map((part) => part.component)).toStrictEqual(RANKING_COMPONENT_KEYS);

		for (const part of explanation) {
			expect(part.weight).toBe(RANKING_WEIGHTS[part.component]);
			expect(part.contribution).toBe((part.value ?? 0) * part.weight);
		}
	});

	it('отличает отсутствие данных от нуля, но в сумму берёт и то и другое нулём', () => {
		const empty = explainScore(values({}));
		const zero = explainScore(values({ applications: 0, enrolled: 0, parallelStreams: 0 }));

		expect(empty.score).toBe(0);
		expect(zero.score).toBe(0);
		expect(empty.explanation[0].value).toBeNull();
		expect(zero.explanation[0].value).toBe(0);
	});

	it('даёт большему набору больший балл', () => {
		const small = explainScore(values({ applications: 10, enrolled: 5, parallelStreams: 1 }));
		const big = explainScore(values({ applications: 100, enrolled: 80, parallelStreams: 3 }));

		expect(big.score).toBeGreaterThan(small.score);
	});
});
