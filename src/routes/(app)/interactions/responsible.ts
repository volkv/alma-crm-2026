import type { RequestEvent } from '@sveltejs/kit';
import { pageQuerySchema } from '$lib/contracts/common';
import { actorFromEvent } from '$lib/server/actor';
import { listUsers } from '$lib/server/auth/users';
import { can } from '$lib/server/rbac';

/** Кого можно назначить ответственным: идентификатор и подпись для списка. */
export type ResponsibleOption = { id: string; name: string };

/**
 * Полный список сотрудников — право администратора (`users.manage`). Менеджеру
 * оно не положено, поэтому ему предлагается он сам: назначить ответственным
 * себя можно всегда, а знать поимённо весь штат ради одной кнопки не нужно.
 */
export async function responsibleOptions(event: RequestEvent): Promise<ResponsibleOption[]> {
	const ctx = actorFromEvent(event);
	const user = event.locals.user;

	if (!can(ctx, 'users.manage')) {
		return user === null ? [] : [{ id: user.id, name: user.fullName }];
	}

	const page = await listUsers(ctx, pageQuerySchema.parse({ pageSize: 100 }));

	return page.items
		.filter((item) => item.isActive)
		.map((item) => ({ id: item.id, name: item.fullName }));
}
