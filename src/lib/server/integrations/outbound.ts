/**
 * Куда серверу разрешено ходить по своей инициативе.
 *
 * Адрес приёмника подписки, адрес системы обучения и адреса подключений обмена
 * задаёт человек, а идёт по ним сервер — изнутри сети развёртывания, где живут
 * каталог учётных записей, хранилище файлов, база и служба метаданных облака.
 * Запрос туда от имени сервера и есть подделка запроса на стороне сервера
 * (SSRF): снаружи эти адреса недостижимы, а изнутри отвечают без всякого ключа.
 *
 * Вид адреса проверяет `outboundUrlIssue` — правило читает и браузер. Здесь
 * проверяется то, что без сервера не проверить: **куда адрес ведёт**. Имя
 * разрешается в адреса, и годятся они все или не годится ни один — частичного
 * ответа тут нет.
 *
 * Проверка идёт дважды: при сохранении адреса и в момент отправки. Один раз
 * мало — имя, сохранённое публичным, к моменту отправки указывает куда угодно
 * (перепривязка DNS), и вся защита свелась бы к одному запросу в прошлом.
 */
import { lookup } from 'node:dns/promises';
import { localAddressKind, outboundUrlIssue, STAND_MOCK_HOSTS } from '$lib/contracts/integrations';
import { getConfig } from '../config';

/**
 * Почему по адресу не пошли. `temporary` отделяет «так нельзя» от «сейчас не
 * получилось»: отказ правила окончателен и ждёт человека, а неразрешившееся
 * имя — обычная сетевая неудача, и её повторяют по расписанию, как и любую
 * другую.
 */
export type OutboundIssue = { message: string; temporary: boolean };

/**
 * Разрешает ли развёртывание ходить на петлю и в приватные сети.
 *
 * На машине разработчика и в прогоне имитаторы, приёмник подписки и система
 * обучения поднимаются рядом, на `127.0.0.1`, и без этого связку нечем
 * проверить. В производственном режиме всё наоборот, поэтому умолчание зависит
 * от режима: `production` — запрет, остальные — разрешение. Развёртывание
 * может сказать иначе, но только явно.
 */
export function allowsLocalTargets(): boolean {
	const config = getConfig();

	return config.ALLOW_LOCAL_TARGETS ?? config.NODE_ENV !== 'production';
}

/** Все адреса имени; пустой список — имя не разрешилось. */
async function resolveHost(host: string): Promise<string[]> {
	try {
		const addresses = await lookup(host, { all: true, verbatim: true });

		return addresses.map((entry) => (entry.family === 6 ? `[${entry.address}]` : entry.address));
	} catch {
		return [];
	}
}

/**
 * Годится ли адрес как адресат исходящего запроса; `null` — годится.
 *
 * `allowLocal` передаётся, а не читается из настроек: правило должно
 * проверяться само по себе, без окружения целиком.
 */
export async function outboundAddressIssue(
	raw: string,
	allowLocal: boolean
): Promise<OutboundIssue | null> {
	const shape = outboundUrlIssue(raw);

	if (shape !== null) {
		return { message: shape, temporary: false };
	}

	const host = new URL(raw).hostname;

	// Имитаторы стенда разрешены поимённо: они и живут по адресу, который иначе
	// был бы запрещён, — внутри сети `docker-compose.yml`.
	if (STAND_MOCK_HOSTS.has(host)) {
		return null;
	}

	const literal = localAddressKind(host);

	if (literal !== null) {
		return allowLocal ? null : refusal(host, literal);
	}

	// Имя узла — это ещё не адрес: за `metadata.internal` и за именем сервиса
	// стоит ровно то, от чего правило защищает.
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.startsWith('[')) {
		const addresses = await resolveHost(host);

		if (addresses.length === 0) {
			return { message: `Имя «${host}» не разрешается в адрес`, temporary: true };
		}

		if (allowLocal) {
			return null;
		}

		for (const address of addresses) {
			const kind = localAddressKind(address);

			if (kind !== null) {
				return refusal(`${host} (${address})`, kind);
			}
		}
	}

	return null;
}

function refusal(where: string, kind: string): OutboundIssue {
	return {
		message: `Адрес «${where}» ведёт внутрь установки (${kind}): наружу система ходит только на публичные адреса`,
		temporary: false
	};
}

/**
 * То же правило для места, где отказ — это отказ формы. Читает настройку
 * развёртывания само: вызывающему остаётся адрес.
 */
export async function outboundTargetIssue(raw: string): Promise<string | null> {
	const issue = await outboundAddressIssue(raw, allowsLocalTargets());

	return issue === null ? null : issue.message;
}
