import { describe, expect, it } from 'vitest';
import { localAddressKind, outboundUrlIssue } from '$lib/contracts/integrations';
import { parseOutboundAllowList } from '$lib/server/integrations/allow-list';
import { outboundAddressIssue } from '$lib/server/integrations/outbound';

function allowList(raw: string) {
	const list = parseOutboundAllowList(raw);

	if (typeof list === 'string') {
		throw new Error(list);
	}

	return list;
}

const EMPTY = allowList('');

/**
 * Куда серверу разрешено ходить по своей инициативе.
 *
 * Адрес приёмника подписки и адрес системы обучения задаёт человек, а запрос по
 * нему делает сервер — изнутри сети развёртывания. Там живут каталог учётных
 * записей, хранилище файлов и служба метаданных облака: снаружи они
 * недостижимы, а изнутри отвечают без всякого ключа. Поэтому проверяется не
 * вид адреса, а то, куда он ведёт.
 */
describe('адресат исходящего запроса', () => {
	/**
	 * Адреса, каждый из которых ведёт внутрь установки. Первые десять —
	 * литералы, включая восьмеричную и десятичную записи одного и того же
	 * `127.0.0.1`; последние два — имена сервисов, которые в сети развёртывания
	 * разрешаются в приватные адреса, а на машине прогона не разрешаются вовсе.
	 */
	const inside = [
		'https://127.0.0.1/hook',
		'https://localhost/hook',
		'https://[::1]:9000/hook',
		'https://10.0.0.5/internal',
		'https://192.168.1.1/hook',
		'https://172.16.0.9/hook',
		'https://169.254.169.254/latest/meta-data/',
		'https://[fd00::1]/hook',
		'https://0177.0.0.1/hook',
		'https://2130706433/hook',
		'https://keycloak:8080/realms/lct',
		'https://seaweedfs:8333/lct'
	];

	it('отвергает все двенадцать адресов внутрь установки', async () => {
		const verdicts = await Promise.all(
			inside.map(async (url) => [url, await outboundAddressIssue(url, EMPTY)] as const)
		);

		expect(verdicts.filter(([, issue]) => issue === null).map(([url]) => url)).toEqual([]);
	});

	it('отвергает IPv4 в обёртке IPv6 — это тот же самый адрес', async () => {
		expect(await outboundAddressIssue('https://[::ffff:127.0.0.1]/hook', EMPTY)).not.toBeNull();
		expect(localAddressKind('[::ffff:7f00:1]')).toBe('петля');
	});

	it('пропускает публичный адрес', async () => {
		// Литерал, а не имя: проверка имени ходила бы в DNS, и на машине без сети
		// тест говорил бы не о правиле, а о резолвере.
		expect(await outboundAddressIssue('https://93.184.216.34/hook', EMPTY)).toBeNull();
		expect(localAddressKind('93.184.216.34')).toBeNull();
	});

	it('говорит, что отказ адреса окончателен, а неразрешившееся имя — нет', async () => {
		const refused = await outboundAddressIssue('https://10.0.0.5/internal', EMPTY);
		const unresolved = await outboundAddressIssue('https://keycloak:8080/realms/lct', EMPTY);

		// Отказ правила не станет другим сам по себе и ждёт человека; имя, которое
		// сейчас не разрешилось, — обычная сетевая неудача, её повторяют.
		expect(refused?.temporary).toBe(false);
		expect(unresolved?.temporary).toBe(true);
	});

	it('открывает приватный адрес только из списка разрешённых узлов', async () => {
		// Закрытый контур: CMS заказчика на 10.20.0.5, система обучения — в сети
		// 10.30.0.0/24. Соседние приватные адреса — каталог, хранилище, метаданные
		// облака — список не открывает.
		const list = allowList('10.20.0.5,10.30.0.0/24,fd00:20::/64');

		expect(await outboundAddressIssue('https://10.20.0.5/api', list)).toBeNull();
		expect(await outboundAddressIssue('https://10.30.0.77/api', list)).toBeNull();
		expect(await outboundAddressIssue('https://[fd00:20::9]/api', list)).toBeNull();
		expect(await outboundAddressIssue('https://10.20.0.6/api', list)).not.toBeNull();
		expect(await outboundAddressIssue('https://169.254.169.254/latest/', list)).not.toBeNull();
		expect(await outboundAddressIssue('https://127.0.0.1/hook', list)).not.toBeNull();
	});

	it('имя из списка сравнивается точно, имя не из списка проверяется по адресам', async () => {
		// `localhost` разрешается в петлю: названный поимённо — годится, а в
		// пустом списке или в списке с другим именем — отказ. Сеть из списка
		// открывает и имя, разрешившееся в неё.
		expect(
			await outboundAddressIssue('http://localhost:8081/api', allowList('localhost'))
		).toBeNull();
		expect(
			await outboundAddressIssue('http://localhost:8081/api', allowList('cms.localhost'))
		).not.toBeNull();
		expect(
			await outboundAddressIssue('http://localhost:8081/api', allowList('127.0.0.0/8,::1/128'))
		).toBeNull();
		expect(await outboundAddressIssue('http://mock-cms:8081/api', EMPTY)).not.toBeNull();
	});

	it('внешним источникам список не открывает ничего', async () => {
		// `null` вместо списка — строгий режим сайтов вузов: только публичное.
		expect(await outboundAddressIssue('https://10.20.0.5/api', null)).not.toBeNull();
	});

	it('вид адреса проверяется и без сети: по http — только петля и имитаторы', () => {
		expect(outboundUrlIssue('http://example.org/hook')).not.toBeNull();
		expect(outboundUrlIssue('ftp://example.org/hook')).not.toBeNull();
		expect(outboundUrlIssue('не адрес')).not.toBeNull();
		expect(outboundUrlIssue('https://example.org/hook')).toBeNull();
	});
});
