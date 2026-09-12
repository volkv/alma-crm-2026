/**
 * Принадлежность адреса сети, записанной в виде CIDR.
 *
 * Нужна одному вопросу: удалённый ли это доступ. Политика второго фактора
 * может требовать код только снаружи доверенных сетей, а «снаружи» — это и
 * есть «адрес не попал ни в одну из перечисленных сетей».
 *
 * Разбор свой, а не библиотечный: нужны ровно две операции — превратить запись
 * в байты и сравнить старшие биты, — и обе умещаются в файл, который целиком
 * читается глазами. Зависимость ради этого пришлось бы обновлять и проверять
 * наравне с тем, что стоит на пути входа в систему.
 *
 * Разбор строгий. Адрес, который не разобрался, не «считается недоверенным» и
 * не пропускается молча: запись сети чинит администратор, а тихо
 * недействующее правило безопасности хуже отсутствующего.
 */

/** Сеть: её адрес в байтах и длина значащей части в битах. */
export type NetworkPrefix = {
	bytes: Uint8Array;
	prefixLength: number;
};

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;

/**
 * Октет IPv4. Ведущие нули запрещены: часть систем читает `010` как восьмерично
 * записанную восьмёрку, часть — как десятичную десятку, и запись, которую
 * читают по-разному, в правиле доступа стоять не может.
 */
function parseOctet(value: string): number | null {
	if (!/^\d{1,3}$/.test(value) || (value.length > 1 && value.startsWith('0'))) {
		return null;
	}

	const octet = Number(value);

	return octet <= 255 ? octet : null;
}

function parseIpv4(value: string): Uint8Array | null {
	const parts = value.split('.');

	if (parts.length !== IPV4_BYTES) {
		return null;
	}

	const bytes = new Uint8Array(IPV4_BYTES);

	for (const [index, part] of parts.entries()) {
		const octet = parseOctet(part);

		if (octet === null) {
			return null;
		}

		bytes[index] = octet;
	}

	return bytes;
}

/** Группа IPv6: от одной до четырёх шестнадцатеричных цифр. */
function parseGroup(value: string): number | null {
	return /^[0-9a-fA-F]{1,4}$/.test(value) ? Number.parseInt(value, 16) : null;
}

/**
 * Одна половина записи IPv6 — до `::` или после него. Последняя группа может
 * быть записана как IPv4 (`::ffff:192.0.2.1`), и тогда она занимает две.
 */
function parseGroups(value: string, allowTrailingIpv4: boolean): number[] | null {
	if (value === '') {
		return [];
	}

	const parts = value.split(':');
	const groups: number[] = [];

	for (const [index, part] of parts.entries()) {
		const last = index === parts.length - 1;

		if (last && allowTrailingIpv4 && part.includes('.')) {
			const embedded = parseIpv4(part);

			if (embedded === null) {
				return null;
			}

			groups.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]);
			continue;
		}

		const group = parseGroup(part);

		if (group === null) {
			return null;
		}

		groups.push(group);
	}

	return groups;
}

function parseIpv6(value: string): Uint8Array | null {
	const halves = value.split('::');

	if (halves.length > 2) {
		return null;
	}

	const head = parseGroups(halves[0], halves.length === 1);
	const tail = halves.length === 2 ? parseGroups(halves[1], true) : [];

	if (head === null || tail === null) {
		return null;
	}

	const total = head.length + tail.length;

	// Без `::` групп ровно восемь; с ним — меньше восьми, иначе сокращать нечего.
	if (halves.length === 1 ? total !== 8 : total >= 8) {
		return null;
	}

	const groups = [...head, ...new Array<number>(8 - total).fill(0), ...tail];
	const bytes = new Uint8Array(IPV6_BYTES);

	for (const [index, group] of groups.entries()) {
		bytes[index * 2] = group >> 8;
		bytes[index * 2 + 1] = group & 0xff;
	}

	return bytes;
}

/** IPv4, записанный как IPv6: `::ffff:198.51.100.7`. */
function isIpv4Mapped(bytes: Uint8Array): boolean {
	return (
		bytes.length === IPV6_BYTES &&
		bytes.subarray(0, 10).every((byte) => byte === 0) &&
		bytes[10] === 0xff &&
		bytes[11] === 0xff
	);
}

/**
 * Адрес в байтах: четыре для IPv4, шестнадцать для IPv6. `null` — запись не
 * является адресом.
 *
 * IPv4, записанный по правилам IPv6, приводится к четырём байтам. Так его
 * накрывает обычная сеть вида `10.0.0.0/8`: за прокси один и тот же клиент
 * приходит то в одной записи, то в другой, и различать их значило бы требовать
 * от администратора перечислить сеть дважды.
 */
export function parseAddress(value: string): Uint8Array | null {
	const trimmed = value.trim();

	if (trimmed === '') {
		return null;
	}

	if (trimmed.includes(':')) {
		const bytes = parseIpv6(trimmed);

		if (bytes === null) {
			return null;
		}

		return isIpv4Mapped(bytes) ? bytes.subarray(12) : bytes;
	}

	return parseIpv4(trimmed);
}

/**
 * Сеть в записи CIDR: `198.51.100.0/24`, `2001:db8::/32`. `null` — запись не
 * является сетью.
 *
 * Биты за границей префикса обязаны быть нулевыми: `198.51.100.7/24` — это не
 * сеть, а адрес с приписанной маской, и принимать такое значит позволить
 * правилу означать не то, что в нём написано.
 */
export function parseNetwork(value: string): NetworkPrefix | null {
	const [address, prefix, ...rest] = value.trim().split('/');

	if (rest.length > 0 || prefix === undefined || !/^\d{1,3}$/.test(prefix)) {
		return null;
	}

	const bytes = parseAddress(address);

	if (bytes === null) {
		return null;
	}

	const prefixLength = Number(prefix);

	if (prefixLength > bytes.length * 8) {
		return null;
	}

	if (!isPrefixAligned(bytes, prefixLength)) {
		return null;
	}

	return { bytes, prefixLength };
}

/** Все биты за границей префикса нулевые. */
function isPrefixAligned(bytes: Uint8Array, prefixLength: number): boolean {
	for (let index = 0; index < bytes.length; index += 1) {
		const significant = Math.min(Math.max(prefixLength - index * 8, 0), 8);
		const mask = significant === 0 ? 0 : (0xff << (8 - significant)) & 0xff;

		if ((bytes[index] & ~mask & 0xff) !== 0) {
			return false;
		}
	}

	return true;
}

function withinPrefix(address: Uint8Array, network: NetworkPrefix): boolean {
	// Разные семейства не сравниваются: адрес IPv6 не попадает в сеть IPv4, как
	// бы ни совпали байты.
	if (address.length !== network.bytes.length) {
		return false;
	}

	let remaining = network.prefixLength;

	for (let index = 0; index < address.length && remaining > 0; index += 1) {
		const significant = Math.min(remaining, 8);
		const mask = (0xff << (8 - significant)) & 0xff;

		if ((address[index] & mask) !== (network.bytes[index] & mask)) {
			return false;
		}

		remaining -= significant;
	}

	return true;
}

/**
 * Попадает ли адрес хотя бы в одну из сетей.
 *
 * Адрес, которого транспорт не знает (`null`), не попадает никуда: за
 * неизвестным адресом может стоять кто угодно, и считать его своим — значит
 * отдать доверенную сеть тому, кто спрятал свой адрес.
 *
 * Неразобранная запись сети — исключение, а не «не совпало»: правило, которое
 * никто не понял, не должно молча превращаться в отсутствие правила.
 */
export function isAddressWithin(address: string | null, networks: readonly string[]): boolean {
	if (address === null) {
		return false;
	}

	// Сперва разбираются все записи, потом сравнивается адрес: иначе испорченная
	// запись после совпавшей осталась бы незамеченной, и о ней узнали бы в тот
	// день, когда совпадать перестанет.
	const prefixes = networks.map((network) => {
		const prefix = parseNetwork(network);

		if (prefix === null) {
			throw new Error(`Запись сети «${network}» не является CIDR`);
		}

		return prefix;
	});

	const parsed = parseAddress(address);

	return parsed !== null && prefixes.some((prefix) => withinPrefix(parsed, prefix));
}
