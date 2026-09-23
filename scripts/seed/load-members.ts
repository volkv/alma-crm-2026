/**
 * Членство нагрузочной команды в пространствах.
 *
 * Вся команда ведёт вузы, поэтому вся она — в пространстве вузовского
 * направления. Без членства замер ходил бы по пустым спискам: пространство —
 * граница доступа, и КАМ вне него не видит собственных записей.
 *
 * Отдельно от самого набора, потому что набор заливается один раз, а членство
 * доводится до нужного на каждом прогоне: база, залитая до того, как
 * пространства стали границей, получает его без перезаливки объёма.
 */
import { workspaceMembers } from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import { readWorkspaceByKey } from '$lib/server/stages/process';
import { seedId } from './ids';
import { LOAD_TEAM } from './load';

export async function seedLoadMembers(tx: Tx): Promise<void> {
	const workspace = await readWorkspaceByKey(tx, B2B_WORKSPACE_KEY);

	await tx
		.insert(workspaceMembers)
		.values(
			LOAD_TEAM.map((account) => ({
				workspaceId: workspace.id,
				userId: seedId('user', account.key)
			}))
		)
		.onConflictDoNothing();
}
