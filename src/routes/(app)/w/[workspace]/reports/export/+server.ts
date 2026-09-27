import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { scopedReportAddress } from '$lib/server/reports/query';
import type { RequestHandler } from './$types';

/**
 * Выгрузка отчёта пространства — выгрузка общего отчёта с фильтром по нему.
 * Как и у экрана (`../+server.ts`): охват переезжает в параметр явно, а файл
 * собирает один сервис.
 */
export const GET: RequestHandler = (event) => {
	redirect(307, scopedReportAddress(resolve('/reports/export'), event.url, event.params.workspace));
};
