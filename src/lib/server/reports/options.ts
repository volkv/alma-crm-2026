/**
 * Значения, из которых выбирают фильтры отчёта.
 *
 * Списки читаются под областью доступа того, кто открыл раздел: подсказка,
 * называющая вуз за пределами области, рассказывает о нём не меньше, чем строка
 * отчёта. Стадии берутся из действующих редакций — по ключу, потому что фильтр
 * бьёт по ключу, а показывается актуальное название.
 *
 * Семь выборок на каждое открытие раздела, и ни одна не зависит от того, что
 * человек ищет: меняются они вместе со справочником и с публикацией процесса,
 * то есть несопоставимо реже, чем открывается отчёт. Поэтому собранное лежит в
 * том же кэше, что и подбор из справочника (`cache/directory.ts`): область
 * доступа и отпечаток действующих назначений уже в ключе, а запись в справочник
 * уже обесценивает поколение. Структура процесса своей точкой сброса в ключ не
 * входит, поэтому её поколение добавляется частью имени — публикация меняет имя,
 * и список стадий собирается заново.
 *
 * Чего кэш не покрывает: словарь статусов передачи собирается из позиций
 * договоров, а правка договора поколения справочника не двигает. Новый статус
 * появляется в фильтре в пределах срока жизни записи — полминуты; цена вопроса
 * — одна строка выпадающего списка, и платить за неё точкой сброса в каждой
 * правке договора незачем.
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
import { cachedDirectoryOptions } from '../cache/directory';
import { readProcessEpoch } from '../cache/process';
import { getDb } from '../db';
import { contractItems, directions, organizations, products, programs, users } from '../db/schema';
import { scopeFilter } from '../rbac';
import { readActiveProcessGroups } from './stages';

export async function readFilterOptions(ctx: ActorContext): Promise<ReportFilterOptions> {
	return cachedDirectoryOptions(
		ctx,
		`reports:${await readProcessEpoch()}`,
		() => buildFilterOptions(ctx),
		// Ни одного поля со временем: в списках только пара «значение и подпись».
		(stored) => stored as ReportFilterOptions
	);
}

async function buildFilterOptions(ctx: ActorContext): Promise<ReportFilterOptions> {
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
