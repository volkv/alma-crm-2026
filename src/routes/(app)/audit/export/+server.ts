import { error } from '@sveltejs/kit';
import { AUDIT_EXPORT_FORMATS, type AuditExportFormat } from '$lib/contracts/audit';
import { actorFromEvent } from '$lib/server/actor';
import { exportAuditEvents, recordAuditEvent } from '$lib/server/audit';
import { contentDisposition } from '$lib/server/documents/filename';
import { ForbiddenError, ValidationError } from '$lib/server/errors';
import { can } from '$lib/server/rbac';
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
 */
export const GET: RequestHandler = async (event) => {
	const requested = event.url.searchParams.get('format') ?? 'csv';

	if (!AUDIT_EXPORT_FORMATS.includes(requested as AuditExportFormat)) {
		error(400, `Неизвестный формат выгрузки: ${requested}`);
	}

	const ctx = actorFromEvent(event);

	if (!can(ctx, 'audit.export')) {
		await recordAuditEvent(ctx, { type: 'audit.exported', outcome: 'denied' });

		error(403, 'Выгрузка журнала доступна только с правом «Выгрузка журнала действий»');
	}

	const filter = readAuditFilter(event.url);

	try {
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
		if (failure instanceof ValidationError) {
			error(400, [failure.message, ...failure.issues].join('. '));
		}

		if (failure instanceof ForbiddenError) {
			error(403, failure.message);
		}

		throw failure;
	}
};
