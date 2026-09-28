import { describe, expect, it } from 'vitest';
import { readManagersPage } from '$lib/server/enrichment/sveden';

describe('«Руководство» с контейнером, размеченным мимо', () => {
	it('ФИО и должности вне пустого контейнера собираются по порядку', () => {
		const html = `
			<br itemprop="rucovodstvo">
			<table><tr><td itemprop="fio">Иванова Анна Петровна</td><td itemprop="post">Ректор</td>
			<td itemprop="telephone">+7 (495) 000-00-01</td><td itemprop="email">rector@vuz.example</td></tr></table>
			<br itemprop="rucovodstvoZam">
			<table><tr><td itemprop="fio">Петров Олег Иванович</td><td itemprop="post">Проректор по учебной работе</td>
			<td itemprop="telephone">+7 (495) 000-00-02</td><td itemprop="email">prorector@vuz.example</td></tr></table>`;

		const contacts = readManagersPage(html);

		expect(contacts.map((contact) => [contact.name, contact.post, contact.email])).toEqual([
			['Иванова Анна Петровна', 'Ректор', 'rector@vuz.example'],
			['Петров Олег Иванович', 'Проректор по учебной работе', 'prorector@vuz.example']
		]);
	});

	it('телефоны не по числу ФИО не приписываются никому', () => {
		const html = `
			<td itemprop="fio">Иванова Анна Петровна</td><td itemprop="post">Ректор</td>
			<td itemprop="fio">Петров Олег Иванович</td><td itemprop="post">Проректор</td>
			<td itemprop="telephone">+7 (495) 000-00-01</td>`;

		expect(readManagersPage(html).map((contact) => contact.phone)).toEqual([null, null]);
	});
});
