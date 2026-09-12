import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { AUDIT_EXPORT_FORMATS, type AuditExportFormat } from '$lib/contracts/audit';
import { actorFromEvent } from '$lib/server/actor';
import { exportAuditEvents } from '$lib/server/audit';
import { contentDisposition } from '$lib/server/documents/filename';
import { ForbiddenError } from '$lib/server/errors';
import { toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import { readAuditFilter } from '../filters';
import type { RequestHandler } from './$types';

/**
 * Выгрузка журнала под тем же фильтром, что стоит на списке.
 *
 * Маршрут лежит внутри оболочки приложения, а не в `/api`: это ссылка со
 * страницы, сюда приходят с сессионной кукой и ошибку ждут страницей, а не
 * конвертом JSON. Файл собирается целиком в памяти — потолок в 50 000 строк
 * держит сервис, и он же объясняет словами, что фильтр надо сузить.
 *
 * Отказ по правам сначала ложится в журнал: выгрузка уносит из системы адреса,
 * клиентов и всю историю действий, поэтому попытка её забрать — то, о чём
 * администратор должен узнать, а не молчаливая ошибка в ответе. Сервис проверяет
 * право ещё раз: маршрут — не единственный способ его позвать.
 *
 * Браузеру отказ показывается страницей журнала, а не страницей ошибки: сюда
 * приходят по ссылке со списка, и вернуть человека надо туда же — с объяснением
 * рядом с кнопками, которых он не может нажать. Тому, кто пришёл не из браузера
 * (`curl`, выгрузка по расписанию), нужен код ответа, а не разметка, и он его
 * получает.
 */

/** Ждёт ли вызывающий страницу. Ссылку со списка открывает именно браузер. */
function wantsPage(request: Request): boolean {
	return request.headers.get('accept')?.includes('text/html') === true;
}

export const GET: RequestHandler = async (event) => {
	const requested = event.url.searchParams.get('format') ?? 'csv';

	// Формат — часть адреса, а не предметная ошибка: до сервиса такой запрос не
	// доходит, и переводить тут нечего.
	if (!AUDIT_EXPORT_FORMATS.includes(requested as AuditExportFormat)) {
		error(400, `Неизвестный формат выгрузки: ${requested}`);
	}

	const ctx = actorFromEvent(event);
	const filter = readAuditFilter(event.url);

	try {
		await requirePermission(ctx, 'audit.export', { type: 'audit.exported' });

		const file = await exportAuditEvents(ctx, filter, requested as AuditExportFormat);

		return new Response(file.body, {
			headers: {
				'Content-Type': file.contentType,
				'Content-Disposition': contentDisposition(file.fileName),
				// В журнале видно, кто и что делал: ни браузеру, ни промежуточному
				// кэшу хранить такую выгрузку нельзя.
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (failure) {
		if (failure instanceof ForbiddenError && wantsPage(event.request)) {
			redirect(303, `${resolve('/audit')}?denied=export`);
		}

		toPageError(failure);
	}
};
