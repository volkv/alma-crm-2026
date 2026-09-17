import { describe, expect, it } from 'vitest';
import { localAddressKind, outboundUrlIssue } from '$lib/contracts/integrations';
import { outboundAddressIssue } from '$lib/server/integrations/outbound';

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
		'https://minio:9000/lct'
	];

	it('отвергает все двенадцать адресов внутрь установки', async () => {
		const verdicts = await Promise.all(
			inside.map(async (url) => [url, await outboundAddressIssue(url, false)] as const)
		);

		expect(verdicts.filter(([, issue]) => issue === null).map(([url]) => url)).toEqual([]);
	});

	it('отвергает IPv4 в обёртке IPv6 — это тот же самый адрес', async () => {
		expect(await outboundAddressIssue('https://[::ffff:127.0.0.1]/hook', false)).not.toBeNull();
		expect(localAddressKind('[::ffff:7f00:1]')).toBe('петля');
	});

	it('пропускает публичный адрес', async () => {
		// Литерал, а не имя: проверка имени ходила бы в DNS, и на машине без сети
		// тест говорил бы не о правиле, а о резолвере.
		expect(await outboundAddressIssue('https://93.184.216.34/hook', false)).toBeNull();
		expect(localAddressKind('93.184.216.34')).toBeNull();
	});

	it('разрешает поимённо два имитатора стенда и только по ним', async () => {
		// Имитаторы живут внутри сети `docker-compose.yml` — по адресу, который
		// иначе был бы запрещён. Поэтому они названы, а не подобраны образцом:
		// образец вида `mock-*` открыл бы по http любое имя внутри сети.
		expect(await outboundAddressIssue('http://mock-cms:8081/api/status', false)).toBeNull();
		expect(await outboundAddressIssue('http://mock-lms:8082/api/groups', false)).toBeNull();
		expect(await outboundAddressIssue('http://mock-other:8083/api', false)).not.toBeNull();
	});

	it('говорит, что отказ адреса окончателен, а неразрешившееся имя — нет', async () => {
		const refused = await outboundAddressIssue('https://10.0.0.5/internal', false);
		const unresolved = await outboundAddressIssue('https://keycloak:8080/realms/lct', false);

		// Отказ правила не станет другим сам по себе и ждёт человека; имя, которое
		// сейчас не разрешилось, — обычная сетевая неудача, её повторяют.
		expect(refused?.temporary).toBe(false);
		expect(unresolved?.temporary).toBe(true);
	});

	it('на машине разработчика пропускает петлю: иначе связку нечем проверить', async () => {
		// Развёртывание говорит об этом явно (`ALLOW_LOCAL_TARGETS`), а умолчание
		// зависит от режима: в производственном — запрет.
		expect(await outboundAddressIssue('http://127.0.0.1:4173/hook', true)).toBeNull();
		expect(await outboundAddressIssue('https://169.254.169.254/latest/', true)).toBeNull();
	});

	it('вид адреса проверяется и без сети: по http — только петля и имитаторы', () => {
		expect(outboundUrlIssue('http://example.org/hook')).not.toBeNull();
		expect(outboundUrlIssue('ftp://example.org/hook')).not.toBeNull();
		expect(outboundUrlIssue('не адрес')).not.toBeNull();
		expect(outboundUrlIssue('https://example.org/hook')).toBeNull();
	});
});
