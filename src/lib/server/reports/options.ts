/**
 * Значения, из которых выбирают фильтры отчёта.
 *
 * Списки читаются под областью доступа того, кто открыл раздел: подсказка,
 * называющая вуз за пределами области, рассказывает о нём не меньше, чем строка
 * отчёта. Стадии берутся из действующих редакций — по ключу, потому что фильтр
 * бьёт по ключу, а показывается актуальное название.
 */
import { asc, eq, isNotNull } from 'drizzle-orm';
import {
	REPORT_PARTY_LABELS,
	REPORT_STATE_LABELS,
	type ReportFilterOptions
} from '$lib/contracts/reports';
import { INTERACTION_STATUSES } from '$lib/contracts/interactions';
import { ORGANIZATION_KINDS } from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { contractItems, directions, organizations, products, programs, users } from '../db/schema';
import { scopeFilter } from '../rbac';
import { readActiveProcessGroups } from './stages';

export async function readFilterOptions(ctx: ActorContext): Promise<ReportFilterOptions> {
	const db = getDb();

	const [
		organizationRows,
		directionRows,
		programRows,
		productRows,
		ownerRows,
		transferRows,
		groups
	] = await Promise.all([
		db
			.select({ value: organizations.id, label: organizations.shortName })
			.from(organizations)
			.where(scopeFilter(ctx, organizations.id))
			.orderBy(asc(organizations.shortName)),
		db
			.select({ value: directions.id, label: directions.name })
			.from(directions)
			.orderBy(asc(directions.position)),
		db
			.select({ value: programs.id, label: programs.name })
			.from(programs)
			.orderBy(asc(programs.name)),
		db
			.select({ value: products.id, label: products.name })
			.from(products)
			.orderBy(asc(products.name)),
		// Ответственным может быть только действующая учётная запись: в списке
		// уволенного нет, а в старом отчёте он остаётся — это разные вопросы.
		db
			.select({ value: users.id, label: users.fullName })
			.from(users)
			.where(eq(users.isActive, true))
			.orderBy(asc(users.fullName)),
		db
			.selectDistinct({ value: contractItems.transferStatus })
			.from(contractItems)
			.where(isNotNull(contractItems.transferStatus))
			.orderBy(asc(contractItems.transferStatus)),
		readActiveProcessGroups()
	]);

	const stages = new Map<string, string>();

	for (const group of groups.values()) {
		for (const stage of group.stages) {
			// Ключ один на все группы, где он встретился: фильтр бьёт по ключу, и
			// два пункта с одним ключом означали бы выбор без разницы.
			if (!stages.has(stage.key)) {
				stages.set(stage.key, stage.name);
			}
		}
	}

	return {
		organizations: organizationRows,
		directions: directionRows,
		programs: programRows,
		products: productRows,
		owners: ownerRows,
		stages: [...stages].map(([value, label]) => ({ value, label })),
		groups: [...groups.values()].map((group) => ({ value: group.key, label: group.name })),
		parties: ORGANIZATION_KINDS.map((kind) => ({
			value: kind,
			label: REPORT_PARTY_LABELS[kind]
		})),
		states: INTERACTION_STATUSES.map((state) => ({
			value: state,
			label: REPORT_STATE_LABELS[state]
		})),
		transferStatuses: transferRows.map((row) => ({ value: row.value, label: row.value }))
	};
}
