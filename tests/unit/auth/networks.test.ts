import { describe, expect, it } from 'vitest';
import { isAddressWithin, parseAddress, parseNetwork } from '$lib/server/auth/networks';

describe('разбор адреса', () => {
	it('читает IPv4 и отвергает то, что им не является', () => {
		expect(Array.from(parseAddress('198.51.100.7') ?? [])).toEqual([198, 51, 100, 7]);
		expect(parseAddress('198.51.100')).toBeNull();
		expect(parseAddress('198.51.100.256')).toBeNull();
		expect(parseAddress('198.51.100.7.1')).toBeNull();
		expect(parseAddress('')).toBeNull();
	});

	it('не принимает октет с ведущим нулём: его читают по-разному', () => {
		// `010` — это восемь в одной системе и десять в другой. Запись, которая
		// означает разное, в правиле доступа стоять не может.
		expect(parseAddress('10.0.0.010')).toBeNull();
		expect(parseAddress('10.0.0.0')).not.toBeNull();
	});

	it('читает IPv6 с сокращением и без', () => {
		expect(parseAddress('::1')?.length).toBe(16);
		expect(parseAddress('2001:db8::1')?.length).toBe(16);
		expect(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001')?.length).toBe(16);
		expect(parseAddress('2001:db8::1::2')).toBeNull();
		expect(parseAddress('2001:db8:::1')).toBeNull();
		expect(parseAddress('2001:db8')).toBeNull();
	});

	it('приводит IPv4, записанный как IPv6, к четырём байтам', () => {
		// За прокси один и тот же клиент приходит то в одной записи, то в другой;
		// требовать от администратора перечислить сеть дважды нельзя.
		expect(Array.from(parseAddress('::ffff:198.51.100.7') ?? [])).toEqual([198, 51, 100, 7]);
		expect(isAddressWithin('::ffff:198.51.100.7', ['198.51.100.0/24'])).toBe(true);
	});
});

describe('разбор сети', () => {
	it('читает CIDR обеих версий', () => {
		expect(parseNetwork('198.51.100.0/24')?.prefixLength).toBe(24);
		expect(parseNetwork('2001:db8::/32')?.prefixLength).toBe(32);
		expect(parseNetwork('0.0.0.0/0')?.prefixLength).toBe(0);
	});

	it('не принимает запись без длины префикса и с длиной больше семейства', () => {
		expect(parseNetwork('198.51.100.0')).toBeNull();
		expect(parseNetwork('198.51.100.0/33')).toBeNull();
		expect(parseNetwork('2001:db8::/129')).toBeNull();
		expect(parseNetwork('198.51.100.0/24/8')).toBeNull();
	});

	it('не принимает адрес машины вместо начала сети', () => {
		// `198.51.100.7/24` — это не сеть: биты за границей префикса значат, что
		// написавший имел в виду не то, что написал.
		expect(parseNetwork('198.51.100.7/24')).toBeNull();
		expect(parseNetwork('198.51.100.0/24')).not.toBeNull();
		expect(parseNetwork('2001:db8::1/32')).toBeNull();
	});
});

describe('принадлежность адреса сети', () => {
	it('сравнивает по значащим битам, а не по октетам', () => {
		expect(isAddressWithin('198.51.100.7', ['198.51.100.0/24'])).toBe(true);
		expect(isAddressWithin('198.51.101.7', ['198.51.100.0/24'])).toBe(false);

		// Граница внутри октета: /28 накрывает .0–.15 и не накрывает .16.
		expect(isAddressWithin('10.0.0.15', ['10.0.0.0/28'])).toBe(true);
		expect(isAddressWithin('10.0.0.16', ['10.0.0.0/28'])).toBe(false);
	});

	it('не смешивает семейства', () => {
		expect(isAddressWithin('::1', ['0.0.0.0/0'])).toBe(false);
		expect(isAddressWithin('10.0.0.1', ['::/0'])).toBe(false);
		expect(isAddressWithin('2001:db8::1', ['2001:db8::/32'])).toBe(true);
	});

	it('считает чужим неизвестный и неразобранный адрес', () => {
		// За неизвестным адресом может стоять кто угодно: доверенным он не бывает.
		expect(isAddressWithin(null, ['0.0.0.0/0'])).toBe(false);
		expect(isAddressWithin('unknown', ['0.0.0.0/0'])).toBe(false);
	});

	it('пустой список сетей не накрывает никого', () => {
		expect(isAddressWithin('10.0.0.1', [])).toBe(false);
	});

	it('не проглатывает испорченную запись сети', () => {
		// Правило, которое никто не понял, не должно молча превращаться в
		// отсутствие правила — даже если совпадение уже нашлось по соседней записи.
		expect(() => isAddressWithin('10.0.0.1', ['10.0.0.0/8', 'совсем не сеть'])).toThrow(/CIDR/);
	});
});
