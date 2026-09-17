/**
 * Транспортный слой HTTP: перевод ошибок предметной области в ответ и адрес
 * вызывающего.
 *
 * Сервисы бросают ошибки из `$lib/server/errors`, ничего не зная про HTTP.
 * Здесь они становятся ответом: у действия формы — отказом с текстом рядом с
 * полями, у загрузчика страницы — статусом, который рисует страница ошибки.
 * Статус в обоих случаях берётся из одной таблицы (`statusForError`), а
 * публичный API читает её же. Ошибка, которой нет в словаре, не подменяется
 * статусом «на всякий случай»: она летит дальше и становится 500, потому что
 * неизвестный сбой нельзя показывать как отказ по правилам.
 *
 * Адрес вызывающего живёт здесь по той же причине: он нужен обоим контурам —
 * и странице, и публичному API, — а правило у него обязано быть одно.
 */
import { error, fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { getConfig } from './config';
import { AppError, statusForError, ValidationError } from './errors';

export type ActionErrorPayload = {
	message: string;
	/** Претензии к отдельным полям; пусто у всего, кроме `ValidationError`. */
	issues: string[];
};

/** Претензии к полям в том виде, в каком их показывают человеку. */
export function errorIssues(cause: AppError): string[] {
	return cause instanceof ValidationError ? [...cause.issues] : [];
}

export function toActionFailure(cause: unknown): ActionFailure<ActionErrorPayload> {
	if (!(cause instanceof AppError)) {
		throw cause;
	}

	return fail(statusForError(cause), { message: cause.message, issues: errorIssues(cause) });
}

/**
 * То же самое для загрузчика страницы.
 *
 * У загрузчика, в отличие от действия формы, нет формы, куда положить
 * претензию: страница либо рисуется, либо не существует для этого человека.
 * Поэтому `ForbiddenError` и `NotFoundError` становятся 403 и 404 с тем же
 * текстом, который сервис написал по-русски, а претензии к запросу
 * дописываются к сообщению — терять их по дороге незачем.
 */
export function toPageError(cause: unknown): never {
	if (!(cause instanceof AppError)) {
		throw cause;
	}

	error(statusForError(cause), { message: [cause.message, ...errorIssues(cause)].join('. ') });
}

/**
 * Адрес вызывающего: по нему считаются лимиты и пишется журнал.
 *
 * За обратным прокси адрес соединения — это адрес самого прокси, и один он
 * ничего не говорит о том, кто пришёл. Наблюдённый адрес прокси дописывает
 * справа в `X-Forwarded-For` (`$proxy_add_x_forwarded_for` у nginx: сначала
 * то, что прислал клиент, следом — адрес, с которого прокси приняло
 * соединение). Поэтому при `TRUST_PROXY=true` берётся последняя запись
 * заголовка: она единственная поставлена нашим собственным прокси, а всё, что
 * левее, сочинил клиент. Взять крайнюю слева значило бы позволить любому
 * посетителю назначить себе адрес самому — и обойти и лимит входов, и запись в
 * журнале. Прокси в развёртывании ровно один (nginx, `docs/deployment.md`);
 * появится второй — правило станет «столько-то записей справа», и менять его
 * придётся вместе с описанием стенда.
 *
 * Заголовка может не быть вовсе: внутри сети развёртывания к приложению ходят
 * напрямую — имитаторы систем заказчика и проверка здоровья контейнера. Это не
 * ошибка, адрес у такого запроса есть — адрес соединения, он и идёт дальше как
 * есть. Разбирает заголовок само приложение, а не транспорт: adapter-node с
 * `ADDRESS_HEADER` бросает исключение на каждом запросе, где заголовка нет, и
 * обращение изнутри сети превращалось бы в 500 (`docs/deployment.md`).
 *
 * При `TRUST_PROXY=false` заголовок не читается вовсе: приложение доступно
 * напрямую, и `X-Forwarded-For` в таком запросе написал тот, кто его прислал.
 */
export function clientAddress(event: RequestEvent): string {
	const connection = event.getClientAddress();

	if (!getConfig().TRUST_PROXY) {
		return connection;
	}

	const forwarded = event.request.headers.get('x-forwarded-for');

	if (forwarded === null) {
		return connection;
	}

	const addresses = forwarded
		.split(',')
		.map((address) => address.trim())
		.filter((address) => address !== '');

	// Пустой или состоящий из одних запятых заголовок — это отсутствие адреса,
	// а не адрес: за ним остаётся адрес соединения.
	return addresses.at(-1) ?? connection;
}
