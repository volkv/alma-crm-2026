/**
 * Список узлов внутри сети заказчика, куда серверу разрешено ходить
 * (`OUTBOUND_ALLOWED_HOSTS`).
 *
 * Правило исходящих адресов (`outbound.ts`) по умолчанию не пускает сервер на
 * петлю и в приватные сети: там живут каталог учётных записей, хранилище и
 * служба метаданных облака. Но в закрытом контуре CMS и система обучения
 * заказчика стоят именно там — на `10.x` или `192.168.x`. Список называет их
 * поимённо или сетью, и открывает ровно их, а не приватные сети целиком.
 *
 * Запись списка — одно из трёх:
 * - имя узла (`cms.corp.local`) — сравнивается с именем из адреса точно, без
 *   масок и без поддоменов;
 * - адрес (`10.20.0.5`, `fd00::5`) — ровно этот адрес;
 * - сеть CIDR (`10.20.0.0/24`, `fd00::/64`) — любой адрес в ней, будь он
 *   написан в адресе литералом или получен разрешением имени.
 *
 * Модуль без зависимостей от конфигурации: его разбор вызывает сама
 * конфигурация, и ошибка в записи останавливает запуск, а не всплывает на
 * первом обмене.
 */
import { BlockList, isIP } from 'node:net';

export type OutboundAllowList = {
	/** Записи в том виде, в каком их показывают человеку. */
	entries: readonly string[];
	hosts: ReadonlySet<string>;
	networks: BlockList;
};

const HOST_NAME =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `[fd00::1]` — так адрес IPv6 стоит в адресе и в ответе разрешения имени. */
function unbracket(address: string): string {
	return address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
}

function family(address: string): 'ipv4' | 'ipv6' | null {
	const version = isIP(address);

	return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
}

/**
 * Разобрать список. Первая негодная запись возвращается строкой с её текстом:
 * список пишет человек, и опечатка в нём должна остановить запуск, а не молча
 * закрыть обмен.
 */
export function parseOutboundAllowList(raw: string): OutboundAllowList | string {
	const entries: string[] = [];
	const hosts = new Set<string>();
	const networks = new BlockList();

	for (const part of raw.split(',')) {
		const entry = part.trim().toLowerCase();

		if (entry === '' || entries.includes(entry)) {
			continue;
		}

		const slash = entry.indexOf('/');

		if (slash !== -1) {
			const address = unbracket(entry.slice(0, slash));
			const prefixText = entry.slice(slash + 1);
			const kind = family(address);

			if (kind === null || !/^\d{1,3}$/.test(prefixText)) {
				return `«${entry}» is not a network: expected CIDR like 10.20.0.0/24`;
			}

			const prefix = Number(prefixText);
			const max = kind === 'ipv4' ? 32 : 128;

			// Сеть `/0` — это все адреса разом, то есть снятое правило, а не список.
			if (prefix < 1 || prefix > max) {
				return `«${entry}»: prefix must be between 1 and ${max}`;
			}

			networks.addSubnet(address, prefix, kind);
		} else {
			const address = unbracket(entry);
			const kind = family(address);

			if (kind !== null) {
				networks.addAddress(address, kind);
			} else if (HOST_NAME.test(entry)) {
				hosts.add(entry);
			} else {
				return `«${entry}» is neither a host name, an address nor a CIDR network`;
			}
		}

		entries.push(entry);
	}

	return { entries, hosts, networks };
}

/** Входит ли адрес (литерал, IPv6 — в скобках или без) в сети списка. */
export function allowsAddress(list: OutboundAllowList, address: string): boolean {
	const bare = unbracket(address);
	const kind = family(bare);

	return kind !== null && list.networks.check(bare, kind);
}
