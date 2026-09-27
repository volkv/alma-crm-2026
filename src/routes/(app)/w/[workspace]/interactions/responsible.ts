import type { RequestEvent } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { lookupUsers } from '$lib/server/auth/users';
import { can } from '$lib/server/rbac';

/**
 * Кого можно назначить ответственным: идентификатор, имя и роль для списка.
 * Ключ роли — чтобы отличить тех, кто ведёт дела, от учёток с полной областью.
 */
export type ResponsibleOption = { id: string; name: string; roleId: string; roleName: string };

/**
 * Ответственного выбирают из действующих сотрудников пространства — всех, а не
 * из одного себя: вести взаимодействие может любой менеджер направления, и
 * назначение работы коллеге и есть смысл этого поля. Сотрудник, не включённый в
 * пространство, в списке не стоит: запись, поручённая ему, ушла бы у него из
 * виду в ту же секунду, и команда такое назначение отклонит
 * (`assertMayWorkIn`). Администратор стоит — он видит все пространства по роли.
 *
 * Право на список то же, что и на само назначение (`interactions.write`); без
 * него выбирать некого, и список пуст.
 */
export async function responsibleOptions(event: RequestEvent): Promise<ResponsibleOption[]> {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'interactions.write')) {
		return [];
	}

	const workspaceKey = event.params.workspace;

	if (workspaceKey === undefined) {
		throw new Error('Список ответственных собирается только внутри пространства');
	}

	const staff = await lookupUsers(ctx, { workspaceKey });

	return staff.map((user) => ({
		id: user.id,
		name: user.fullName,
		roleId: user.roleId,
		roleName: user.roleName
	}));
}
