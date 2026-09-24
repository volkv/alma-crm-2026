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
 * В закрытом контуре CMS и система обучения заказчика сами стоят в приватной
 * сети. Для них есть список разрешённых узлов (`OUTBOUND_ALLOWED_HOSTS`,
 * `allow-list.ts`): он открывает названные имена и сети, а не приватные сети
 * целиком — каталог учётных записей и хранилище по соседству остаются закрыты.
 *
 * Проверка идёт дважды: при сохранении адреса и в момент отправки. Один раз
 * мало — имя, сохранённое публичным, к моменту отправки указывает куда угодно
 * (перепривязка DNS), и вся защита свелась бы к одному запросу в прошлом.
 */
import { lookup } from 'node:dns/promises';
import { localAddressKind, outboundUrlIssue } from '$lib/contracts/integrations';
import { getConfig } from '../config';
import { allowsAddress, type OutboundAllowList } from './allow-list';

/**
 * Почему по адресу не пошли. `temporary` отделяет «так нельзя» от «сейчас не
 * получилось»: отказ правила окончателен и ждёт человека, а неразрешившееся
 * имя — обычная сетевая неудача, и её повторяют по расписанию, как и любую
 * другую.
 */
export type OutboundIssue = { message: string; temporary: boolean };

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
 * Петля и приватные сети открыты только тем, что назвал список разрешённых
 * узлов (`OUTBOUND_ALLOWED_HOSTS`): имя узла — если оно названо точно, адрес —
 * если он входит в одну из сетей списка, причём у имени не из списка
 * проверяется каждый адрес, в который оно разрешилось. `null` вместо списка —
 * только публичные адреса: так ходят внешние источники, для которых сеть
 * заказчика закрыта при любом списке.
 *
 * Список передаётся, а не читается из настроек: правило должно проверяться
 * само по себе, без окружения целиком.
 */
export async function outboundAddressIssue(
	raw: string,
	allowList: OutboundAllowList | null
): Promise<OutboundIssue | null> {
	const shape = outboundUrlIssue(raw);

	if (shape !== null) {
		return { message: shape, temporary: false };
	}

	const host = new URL(raw).hostname;
	const literal = localAddressKind(host);

	if (literal !== null) {
		return allowList !== null && allowsAddress(allowList, host)
			? null
			: refusal(host, literal, allowList);
	}

	// Имя узла — это ещё не адрес: за `metadata.internal` и за именем сервиса
	// стоит ровно то, от чего правило защищает.
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.startsWith('[')) {
		const addresses = await resolveHost(host);

		if (addresses.length === 0) {
			return { message: `Имя «${host}» не разрешается в адрес`, temporary: true };
		}

		// Имя из списка названо поимённо тем, кто ставил установку: оно и живёт
		// внутри сети заказчика, и его адреса — это адреса его DNS.
		if (allowList !== null && allowList.hosts.has(host)) {
			return null;
		}

		for (const address of addresses) {
			const kind = localAddressKind(address);

			if (kind !== null && (allowList === null || !allowsAddress(allowList, address))) {
				return refusal(`${host} (${address})`, kind, allowList);
			}
		}
	}

	return null;
}

function refusal(where: string, kind: string, allowList: OutboundAllowList | null): OutboundIssue {
	return {
		message:
			allowList === null
				? `Адрес «${where}» ведёт внутрь установки (${kind}): внешние источники запрашиваются только по публичным адресам`
				: `Адрес «${where}» ведёт внутрь установки (${kind}) и не входит в список разрешённых узлов (OUTBOUND_ALLOWED_HOSTS)`,
		temporary: false
	};
}

/**
 * Правило для адресов связей внутри сети заказчика — подписок, обмена, системы
 * обучения — там, где отказ — это отказ формы. Список разрешённых узлов берёт
 * из настроек развёртывания само: вызывающему остаётся адрес.
 */
export async function outboundTargetIssue(raw: string): Promise<string | null> {
	const issue = await outboundAddressIssue(raw, getConfig().OUTBOUND_ALLOWED_HOSTS);

	return issue === null ? null : issue.message;
}

/**
 * Правило для внешних источников (сайты вузов): только публичные адреса, какой
 * бы список ни назвало развёртывание. Список открывает CMS и систему обучения,
 * а адрес сайта берётся из карточки организации — его пишет не тот, кто ставил
 * установку.
 */
export async function publicTargetIssue(raw: string): Promise<string | null> {
	const issue = await outboundAddressIssue(raw, null);

	return issue === null ? null : issue.message;
}
