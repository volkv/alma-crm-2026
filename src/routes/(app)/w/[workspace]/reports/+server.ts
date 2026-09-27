import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { scopedReportAddress } from '$lib/server/reports/query';
import type { RequestHandler } from './$types';

/**
 * Отчёт пространства — это общий отчёт с фильтром по одному пространству.
 *
 * Своей реализации у адреса нет: экран, выгрузка и машинный вызов собираются
 * одним сервисом, и второй экран отчёта однажды разошёлся бы с первым. Ссылка
 * из пространства и закладка ведут в общий отчёт с явным охватом
 * (`workspace=<ключ>`) и со всеми остальными фильтрами — ровно тот же вопрос.
 * Доступ проверяет сам отчёт: чужое и незнакомое пространство отвечают там
 * одним и тем же «не найдено».
 */
export const GET: RequestHandler = (event) => {
	redirect(307, scopedReportAddress(resolve('/reports'), event.url, event.params.workspace));
};
