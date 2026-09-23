import { describe, expect, it } from 'vitest';
import {
	firstProperty,
	plainText,
	property,
	readMicrodata
} from '$lib/server/enrichment/microdata';

/**
 * Сканер микроданных. Проверяется на разметке того вида, какой она бывает на
 * сайтах вузов: значения то в тексте, то в атрибуте, имена свойств написаны
 * кто как, вокруг — верстка, комментарии и скрипты.
 */

describe('readMicrodata', () => {
	it('читает значение из текста элемента', () => {
		const data = readMicrodata('<div itemprop="fullName">Такой-то университет</div>');

		expect(property(data, 'fullName')).toBe('Такой-то университет');
	});

	it('у meta и link значение берётся из атрибута, а не из текста', () => {
		const data = readMicrodata(
			'<meta itemprop="regDate" content="1899-02-19"><link itemprop="website" href="https://example.ru/">'
		);

		expect(property(data, 'regDate')).toBe('1899-02-19');
		expect(property(data, 'website')).toBe('https://example.ru/');
	});

	it('не различает написание имени свойства', () => {
		const data = readMicrodata('<span itemprop="ShortName">СПбПУ</span>');

		expect(property(data, 'shortName')).toBe('СПбПУ');
	});

	it('снимает вложенную разметку и сущности внутри значения', () => {
		const data = readMicrodata(
			'<td itemprop="address"><b>195251,</b>&nbsp;г.&nbsp;Санкт-Петербург, ул.&nbsp;Политехническая, 29</td>'
		);

		expect(property(data, 'address')).toBe('195251, г. Санкт-Петербург, ул. Политехническая, 29');
	});

	it('считает вложенность по имени тега, а не по первому закрывающему', () => {
		const data = readMicrodata(
			'<div itemprop="founder">Министерство <div>науки и высшего образования</div> РФ</div><div>чужое</div>'
		);

		expect(property(data, 'founder')).toBe('Министерство науки и высшего образования РФ');
	});

	it('не читает то, что текстом страницы не является', () => {
		const data = readMicrodata(
			'<!-- <span itemprop="email">spam@example.ru</span> --><script>var itemprop = "fullName";</script><div itemprop="email">rector@example.ru</div>'
		);

		expect(property(data, 'email')).toBe('rector@example.ru');
		expect(property(data, 'fullName')).toBeNull();
	});

	it('собирает все значения одного свойства без повторов', () => {
		const data = readMicrodata(
			'<p itemprop="telephone">+7 812 000-00-00</p><p itemprop="telephone">+7 812 000-00-00</p><p itemprop="telephone">+7 812 111-11-11</p>'
		);

		expect(data.properties.get('telephone')).toEqual(['+7 812 000-00-00', '+7 812 111-11-11']);
	});

	it('запоминает itemtype: по нему видно, чья это разметка', () => {
		const data = readMicrodata(
			'<div itemscope itemtype="http://obrnadzor.gov.ru/microdata/Common"><span itemprop="fullName">Вуз</span></div>'
		);

		expect(data.types.has('http://obrnadzor.gov.ru/microdata/Common')).toBe(true);
	});

	it('на странице без разметки не находит ничего', () => {
		const data = readMicrodata('<html><body><h1>Сведения</h1></body></html>');

		expect(data.properties.size).toBe(0);
	});

	it('пустое значение не считается значением', () => {
		const data = readMicrodata('<div itemprop="fullName">   </div>');

		expect(property(data, 'fullName')).toBeNull();
	});
});

describe('firstProperty', () => {
	it('берёт первое из написаний, которое нашлось', () => {
		const data = readMicrodata('<div itemprop="nameOrg">Вуз</div>');

		expect(firstProperty(data, ['fullName', 'nameOrg'])).toBe('Вуз');
		expect(firstProperty(data, ['fullName', 'shortName'])).toBeNull();
	});
});

describe('plainText', () => {
	it('оставляет то, что видит человек', () => {
		expect(plainText('<p>А&nbsp;&mdash;\n  Б</p>')).toBe('А — Б');
	});
});
