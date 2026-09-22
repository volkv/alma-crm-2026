import type { RequestEvent } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { lookupUsers } from '$lib/server/auth/users';
import { can } from '$lib/server/rbac';

/** Кого можно назначить ответственным: идентификатор, имя и роль для списка. */
export type ResponsibleOption = { id: string; name: string; roleName: string };

/**
 * Ответственного выбирают из действующих сотрудников — всех, а не из одного
 * себя: вести взаимодействие может любой менеджер, и назначение работы коллеге
 * и есть смысл этого поля. Право на список то же, что и на само назначение
 * (`interactions.write`); без него выбирать некого, и список пуст.
 */
export async function responsibleOptions(event: RequestEvent): Promise<ResponsibleOption[]> {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'interactions.write')) {
		return [];
	}

	const staff = await lookupUsers(ctx);

	return staff.map((user) => ({ id: user.id, name: user.fullName, roleName: user.roleName }));
}
