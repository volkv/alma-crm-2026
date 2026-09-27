import { describe, expect, it } from 'vitest';
import { isAffiliationCurrent } from '$lib/contracts/directory';

describe('действующая роль', () => {
	it('с будущей датой окончания действует до этого дня включительно', () => {
		expect(isAffiliationCurrent({ validTo: null }, '2026-09-28')).toBe(true);
		expect(isAffiliationCurrent({ validTo: '2027-09-30' }, '2026-09-28')).toBe(true);
		expect(isAffiliationCurrent({ validTo: '2026-09-28' }, '2026-09-28')).toBe(true);
		expect(isAffiliationCurrent({ validTo: '2026-09-27' }, '2026-09-28')).toBe(false);
	});
});
