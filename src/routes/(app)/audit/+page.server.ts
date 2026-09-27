import { error } from '@sveltejs/kit';
import { readTableQuery } from '$lib/components/data-table/query';
import { maskAuditEvent } from '$lib/contracts/audit';
import { actorFromEvent } from '$lib/server/actor';
import { AUDIT_EXPORT_MAX_ROWS, listAuditEvents } from '$lib/server/audit';
import { listUsers } from '$lib/server/auth/users';
import { can } from '$lib/server/rbac';
import { AUDIT_DENIED_PARAM, readAuditFilter } from './filters';
import type { PageServerLoad } from './$types';
import { PERMISSIONS } from '$lib/server/rbac/permissions';

/**
 * Журнал действий. Страница ничего не решает сама: фильтр приезжает из адреса,
 * страница — из `DataTable`, а порядок задаёт сервис (всегда от новых к
 * старым), поэтому сортировка колонок здесь выключена.
 */

/** Сколько действующих лиц предлагает выбор в фильтре. */
const ACTOR_CHOICES = 100;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	// Вошёл — не значит «можно»: журнал видит тот, у кого есть право на него.
	if (!can(ctx, 'audit.read')) {
		error(403, `Журнал действий доступен только с правом «${PERMISSIONS['audit.read']}»`);
	}

	const filter = readAuditFilter(event.url);
	const query = readTableQuery(event.url);

	const events = await listAuditEvents(ctx, filter, { page: query.page, pageSize: query.size });

	// Данные стенда синтетические, а вот адрес и клиент в журнале — настоящие, и
	// приезжают они от живых посетителей. Демонстрации журнал оставлен целиком,
	// кроме этих двух полей: читать в ленте, откуда и чем заходили до тебя,
	// незачем ни для показа, ни вообще.
	const items = ctx.user?.isDemo === true ? events.items.map(maskAuditEvent) : events.items;

	// Выбор действующего лица строится по списку пользователей, а он доступен
	// только тому, кто ими управляет. Без этого права фильтр по актору остаётся
	// в адресе и ставится со строки журнала — просто без выпадающего списка.
	const actors = can(ctx, 'users.manage')
		? (await listUsers(ctx, { page: 1, pageSize: ACTOR_CHOICES })).items.map((user) => ({
				id: user.id,
				fullName: user.fullName
			}))
		: [];

	return {
		events: { ...events, items },
		actors,
		canExport: can(ctx, 'audit.export'),
		exportLimit: AUDIT_EXPORT_MAX_ROWS,
		// Сюда разворачивают того, кто открыл ссылку выгрузки без права на неё:
		// отказ объясняется на списке, а не страницей ошибки вместо него.
		exportDenied: event.url.searchParams.get(AUDIT_DENIED_PARAM) === 'export'
	};
};
