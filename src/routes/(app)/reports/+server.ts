import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { actorFromEvent } from '$lib/server/actor';
import { can, canEnterWorkspace } from '$lib/server/rbac';
import { listWorkspacesForNav } from '$lib/server/stages/process';
import type { RequestHandler } from './$types';

/**
 * Прежний адрес отчётов — перенаправление в отчёт пространства.
 *
 * Отчёт живёт внутри пространства: у направлений разные процессы, и сквозного
 * отчёта больше нет. Старые ссылки и закладки ведут в отчёт первого
 * пространства, доступного сотруднику, — в том же порядке, в каком пространства
 * стоят в меню. Если в старой ссылке было названо ровно одно пространство и
 * сотрудник в него включён, ведут туда: это и был вопрос ссылки.
 *
 * Строка запроса переезжает целиком, кроме `workspace`: на новом адресе
 * пространство стоит в пути, и параметр в строке только сбивал бы с толку.
 *
 * Обработчик, а не страница: экрана здесь нет — ни в реестре подсказок, ни в
 * обходе системы. Выгрузки по прежнему адресу нет вовсе: её ссылку собирал
 * только экран, и перенаправлять файл в чужое пространство молча — хуже, чем
 * ответить «не найдено».
 */
export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'interactions.read')) {
		error(403, 'Отчёты доступны только с правом «Просмотр взаимодействий»');
	}

	const entered = (await listWorkspacesForNav()).filter((workspace) =>
		canEnterWorkspace(ctx, workspace.id)
	);
	const named = event.url.searchParams.getAll('workspace');
	const target =
		(named.length === 1 ? entered.find((workspace) => workspace.key === named[0]) : undefined) ??
		entered[0];

	if (target === undefined) {
		error(
			403,
			'Отчёты строятся внутри пространства, а вы не включены ни в одно — обратитесь к администратору'
		);
	}

	const params = new URLSearchParams(event.url.searchParams);

	params.delete('workspace');

	const query = params.toString();
	const path = resolve('/(app)/w/[workspace]/reports', { workspace: target.key });

	redirect(307, query === '' ? path : `${path}?${query}`);
};
