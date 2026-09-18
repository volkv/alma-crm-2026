/**
 * Что считает нагрузочный прогон.
 *
 * Два разреза, и они отвечают на разные вопросы. **По операциям** — это
 * требование ТЗ: «отклик интерфейса не дольше секунды» сказано про открытие
 * списка, открытие карточки, переход по процессу и отчёт, и порог стоит именно
 * на них. **По видам запроса** — SSR-страница, отправка формы, публичный API —
 * это про то, где искать причину, когда порог не выдержан: страница и form
 * action упираются в разное.
 *
 * Доля ошибок считается отдельно для каждого вида: ответ не тот, что ожидали,
 * — это не «медленно», а «не работает», и смешивать их в одном числе нельзя.
 */
import { Rate, Trend } from 'k6/metrics';

/** Операции требования N1. */
export const operations = {
	list: new Trend('op_list', true),
	card: new Trend('op_card', true),
	transition: new Trend('op_transition', true),
	reportFilter: new Trend('op_report_filter', true),
	reportXlsx: new Trend('op_report_xlsx', true),
	reportPdf: new Trend('op_report_pdf', true)
};

/** Виды запроса: страница, отправка формы, публичный API. */
export const kinds = {
	ssr: { duration: new Trend('ssr_duration', true), failed: new Rate('ssr_failed') },
	action: { duration: new Trend('action_duration', true), failed: new Rate('action_failed') },
	api: { duration: new Trend('api_duration', true), failed: new Rate('api_failed') }
};

/**
 * Записать ответ: в метрику операции, в метрику вида и в долю ошибок.
 * Возвращает признак «ответ тот, что ждали», чтобы сценарий мог не идти дальше
 * по сломанному шагу.
 */
export function record(operation, kind, response, expected = 200) {
	const ok = response.status === expected;

	operations[operation].add(response.timings.duration);
	kinds[kind].duration.add(response.timings.duration);
	kinds[kind].failed.add(!ok);

	return ok;
}
