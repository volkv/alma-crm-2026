/**
 * Группы процесса на демонстрационном стенде.
 *
 * Сами группы и соответствие «вид контрагента → группа» кладёт миграция: без
 * них у взаимодействия нет процесса, и это не демонстрационные данные, а часть
 * продукта. Набору остаётся привязать к группе `b2b` тот процесс, который он
 * завёл (`ensureDemoRoute`), и проставить группу заведённым взаимодействиям.
 */
import { eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { processGroups } from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';

/** Ключ группы, по которой идёт работа с учебными заведениями. */
const B2B_GROUP_KEY = 'b2b';

/**
 * Связывает демонстрационный процесс с группой: действующая редакция и реестр
 * ключей стадий.
 *
 * Реестр заполняется здесь, а не публикацией, потому что публикации ещё нет:
 * ключи появляются вместе с первой редакцией, и с этого момента они заняты.
 * Действующая редакция не переписывается, если она уже назначена: на стенде
 * могли опубликовать изменения руками.
 */
export async function seedProcessGroup(tx: Tx, options: { routeId: string }): Promise<void> {
	const [group] = await tx
		.select({ id: processGroups.id })
		.from(processGroups)
		.where(eq(processGroups.key, B2B_GROUP_KEY));

	if (group === undefined) {
		throw new Error(`Группа процесса «${B2B_GROUP_KEY}» не заведена миграцией`);
	}

	await tx
		.update(processGroups)
		.set({ activeRevisionId: options.routeId, updatedAt: sql`now()` })
		.where(sql`${processGroups.id} = ${group.id} and ${isNull(processGroups.activeRevisionId)}`);

	await tx.execute(sql`
		insert into process_stage_keys (group_id, key)
		select ${group.id}::uuid, stages.key from stages where stages.route_id = ${options.routeId}::uuid
		on conflict do nothing
	`);
}

/**
 * Проставляет группу процесса заведённым взаимодействиям.
 *
 * Правило то же, что у приёма заявки: группа выводится из вида основной
 * стороны по единственной таблице соответствий. Команда создания взаимодействия
 * начнёт делать это сама в задаче живого процесса — она же сделает колонку
 * обязательной; до тех пор группу проставляет набор, и только там, где её нет.
 */
export async function assignProcessGroups(): Promise<void> {
	await getDb().execute(sql`
		update interactions set process_group_id = groups.id
		from interaction_parties parties
		join organizations on organizations.id = parties.organization_id
		join process_group_counterparty_kinds kinds on kinds.kind = organizations.kind
		join process_groups groups on groups.id = kinds.group_id
		where parties.interaction_id = interactions.id
			and parties.is_primary
			and interactions.process_group_id is null
	`);
}
