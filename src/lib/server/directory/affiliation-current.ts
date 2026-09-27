import { gte, isNull, or, type SQL } from 'drizzle-orm';
import { formatIsoDay } from '$lib/format';
import { affiliations } from '../db/schema';

/**
 * Условие «роль действует» для запросов — то же, что `isAffiliationCurrent` в
 * контракте: без даты окончания или с ещё не прошедшей. День — по Москве.
 */
export function currentAffiliationFilter(today: string = formatIsoDay()): SQL {
	return or(isNull(affiliations.validTo), gte(affiliations.validTo, today)) as SQL;
}
