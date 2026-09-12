import { error } from '@sveltejs/kit';
import { parseStatPeriodKey } from '$lib/contracts/stats';
import { actorFromEvent } from '$lib/server/actor';
import { contentDisposition } from '$lib/server/documents/filename';
import { toPageError } from '$lib/server/http';
import { getStatsDashboard } from '$lib/server/stats/dashboard';
import { buildStatsReport } from '$lib/server/stats/export';
import { listPeriods } from '$lib/server/stats/read';
import type { RequestHandler } from './$types';

/**
 * Отчёт по данным об обучении за период — книгой XLSX.
 *
 * Маршрут лежит внутри оболочки приложения, а не в `/api`: это ссылка со
 * страницы, сюда приходят с сессионной кукой и ошибку ждут страницей, а не
 * конвертом JSON. Право — то же `stats.read`, что и на сам раздел: выгрузка
 * показывает ровно те числа, которые уже на экране, и проверяет его сервис
 * дашборда, а не этот маршрут.
 *
 * Период обязателен и берётся из того же адреса, что и на дашборде: период —
 * часть вопроса, а не настройка выгрузки, и складывать периоды между собой
 * нельзя.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = actorFromEvent(event);
	const requested = parseStatPeriodKey(event.url.searchParams.get('period'));

	// Испорченный параметр адреса — не предметная ошибка: до сервиса такой
	// запрос не доходит, и переводить тут нечего.
	if (requested === null) {
		error(400, 'Укажите отчётный период выгрузки');
	}

	try {
		const period = (await listPeriods(ctx)).find(
			(entry) => entry.start === requested.start && entry.end === requested.end
		);

		if (period === undefined) {
			error(404, 'За этот период подтверждённых данных нет');
		}

		const file = await buildStatsReport(await getStatsDashboard(ctx, period));

		return new Response(file.body, {
			headers: {
				'Content-Type': file.contentType,
				'Content-Disposition': contentDisposition(file.fileName),
				// Отчёт собран под область доступа того, кто его запросил: ни
				// браузеру, ни промежуточному кэшу хранить его нельзя.
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (failure) {
		toPageError(failure);
	}
};
