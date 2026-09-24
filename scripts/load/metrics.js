/**
 * Что считает нагрузочный прогон.
 *
 * Три разреза, и они отвечают на разные вопросы. **По операциям** — это
 * требование ТЗ: «отклик интерфейса не дольше секунды» сказано про открытие
 * списка, открытие карточки, переход по процессу и отчёт, и порог стоит именно
 * на них. У каждой операции две метрики: время ответа (`op_<операция>`, в
 * сводке — медиана, p95 и максимум) и доля ответов дольше секунды
 * (`op_<операция>_over_1s`) — порог обещан человеку, который открыл экран, и
 * сколько раз он его не дождался, видно только долей. **По видам запроса** —
 * SSR-страница, отправка формы, публичный API — это про то, где искать
 * причину, когда порог не выдержан: страница и form action упираются в разное.
 * **Ошибки** — доля ответов «не тот, что ждали» по каждому виду: это не
 * «медленно», а «не работает», и смешивать их в одном числе нельзя.
 */
import { Counter, Rate, Trend } from 'k6/metrics';

/** Порог требования N1, миллисекунды. */
export const N1_MS = 1000;

function operation(name) {
	return { duration: new Trend(`op_${name}`, true), slow: new Rate(`op_${name}_over_1s`) };
}

/** Операции: названные в ТЗ и те, что идут рядом с ними в рабочем круге. */
export const operations = {
	list: operation('list'),
	card: operation('card'),
	transition: operation('transition'),
	comment: operation('comment'),
	reportFilter: operation('report_filter'),
	reportXlsx: operation('report_xlsx'),
	reportPdf: operation('report_pdf')
};

/** Виды запроса: страница, отправка формы, публичный API. */
export const kinds = {
	ssr: { duration: new Trend('ssr_duration', true), failed: new Rate('ssr_failed') },
	action: { duration: new Trend('action_duration', true), failed: new Rate('action_failed') },
	api: { duration: new Trend('api_duration', true), failed: new Rate('api_failed') }
};

/**
 * Состоявшиеся изменения: переход и комментарий, которые сервер принял.
 * `run.sh` сверяет их с тем, что легло в базу (`fixture.ts --verify`).
 */
export const applied = {
	transition: new Counter('applied_transition'),
	comment: new Counter('applied_comment')
};

/**
 * Куда ушло время ответа по словам самого сервера — заголовок `Server-Timing`:
 * ожидание базы (`db`) и работа приложения (`app`). Сводке они не нужны, их
 * читает разбивка (`run.sh breakdown`) по метке операции: когда операция не держит
 * секунду, первым делом надо знать, во что она упёрлась — в базу или в процесс
 * приложения. Разница между `op_*` и `db + app` — очередь до того, как запрос
 * начали обслуживать, и сеть.
 */
const serverDb = new Trend('server_db', true);
const serverApp = new Trend('server_app', true);

/** Разобрать `Server-Timing` ответа и записать его под меткой операции. */
export function serverTiming(response, op) {
	const header = response.headers['Server-Timing'];

	if (header === undefined) {
		return;
	}

	for (const entry of header.split(',')) {
		const match = /^\s*(db|app);dur=([\d.]+)/.exec(entry);

		if (match !== null) {
			(match[1] === 'db' ? serverDb : serverApp).add(Number(match[2]), { op });
		}
	}
}

/** Ответ страницы или выгрузки: ждали ровно этот статус без перенаправления. */
export function statusIs(expected) {
	return (response) => response.status === expected;
}

/**
 * Ответ отправки формы так, как его получает страница с `use:enhance`: JSON
 * `{ type, status, data }`. Отказ формы (`fail(409, …)`) приходит **с HTTP
 * 200** и `type: "failure"`, а потерянная сессия — перенаправлением на вход,
 * поэтому статус ответа ничего не доказывает: действие состоялось, только если
 * `type` — `success`.
 */
export function actionSucceeded(response) {
	// Не JSON — значит, ответила не форма, а страница входа или ошибки.
	const type = response.headers['Content-Type'] || '';

	if (response.status !== 200 || !type.startsWith('application/json')) {
		return false;
	}

	return JSON.parse(response.body).type === 'success';
}

/**
 * Записать ответ: в метрику операции, в долю медленных, в метрику вида и в
 * долю ошибок. Возвращает признак «ответ тот, что ждали», чтобы сценарий мог
 * не идти дальше по сломанному шагу.
 */
export function record(name, kind, response, accept) {
	const ok = accept(response);

	serverTiming(response, name);

	operations[name].duration.add(response.timings.duration);
	operations[name].slow.add(response.timings.duration > N1_MS);
	kinds[kind].duration.add(response.timings.duration);
	kinds[kind].failed.add(!ok);

	return ok;
}
