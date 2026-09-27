/**
 * Разбор колонки «Ответственные от ВУЗа».
 *
 * Ячейка приходит свободным текстом, и порядок частей в ней не закреплён ничем:
 * где-то сначала имя, где-то телефон, где-то должность между ними. Проверяется
 * не «разобралось», а что именно разобралось: из этой ячейки заводится человек
 * с персональными данными, и лишняя догадка здесь дороже отказа.
 */
import { describe, expect, it } from 'vitest';
import {
	CONTACT_DEFAULT_POSITION,
	contactFullName,
	normalizeContactPhone,
	parseContacts,
	parsePersonName
} from '$lib/server/directory/contacts';

describe('разбор ячейки контактов', () => {
	it('собирает человека из ФИО, телефона и почты в любом порядке', () => {
		const direct = parseContacts('Иванова Мария Петровна, +7 (999) 123-45-67, m.ivanova@vuz.ru');
		const shuffled = parseContacts('m.ivanova@vuz.ru, +7 (999) 123-45-67, Иванова Мария Петровна');

		expect(direct.unparsed).toEqual([]);
		expect(direct.contacts).toEqual([
			{
				lastName: 'Иванова',
				firstName: 'Мария',
				middleName: 'Петровна',
				email: 'm.ivanova@vuz.ru',
				phone: '+7 (999) 123-45-67',
				position: CONTACT_DEFAULT_POSITION
			}
		]);
		expect(shuffled.contacts).toEqual(direct.contacts);
	});

	it('разбирает нескольких людей через точку с запятой и перевод строки', () => {
		const result = parseContacts(
			'Иванова Мария Петровна, m.ivanova@vuz.ru; Петров П. П., проректор, p@vuz.ru\nСидорова А. В.'
		);

		expect(result.contacts.map(contactFullName)).toEqual([
			'Иванова Мария Петровна',
			'Петров П. П.',
			'Сидорова А. В.'
		]);
		expect(result.contacts[1].position).toBe('проректор');
		expect(result.contacts[2].email).toBeNull();
	});

	it('разбивает слипшиеся инициалы и приводит регистр фамилии', () => {
		const [contact] = parseContacts('ИВАНОВ И.И., ivanov@vuz.ru').contacts;

		expect(contact.lastName).toBe('Иванов');
		expect(contact.firstName).toBe('И.');
		expect(contact.middleName).toBe('И.');
	});

	it('ФИО из четырёх слов с отчеством не отдаёт отчество в должность и не меняет регистр после дефиса', () => {
		const [contact] = parseContacts('Проход-C Тестова Вера Петровна, проректор').contacts;

		expect(contact).toMatchObject({
			lastName: 'Проход-C Тестова',
			firstName: 'Вера',
			middleName: 'Петровна',
			position: 'проректор'
		});
		expect(parsePersonName('Мамедов Рашид Али оглы')).toEqual({
			lastName: 'Мамедов',
			firstName: 'Рашид',
			middleName: 'Али оглы'
		});
		expect(parsePersonName('ИВАНОВА-ПЕТРОВА МАРИЯ')).toEqual({
			lastName: 'Иванова-Петрова',
			firstName: 'Мария',
			middleName: null
		});
	});

	it('слова после ФИО становятся должностью', () => {
		const [contact] = parseContacts('Гурьев Олег Тимурович начальник учебного отдела').contacts;

		expect(contactFullName(contact)).toBe('Гурьев Олег Тимурович');
		expect(contact.position).toBe('начальник учебного отдела');
	});

	it('не считает телефоном короткий номер', () => {
		// Внутренний номер и год — это не телефон: назвать их телефоном значило бы
		// записать в карточку человека то, по чему до него не дозвониться.
		const [contact] = parseContacts('Зотова Инна Львовна, доб. 2415').contacts;

		expect(contact.phone).toBeNull();
		expect(contact.position).toBe('доб. 2415');
	});

	it('кусок без имени возвращает как неразобранный', () => {
		const result = parseContacts('приёмная +7 999 000-00-00; Орлов Пётр, orlov@vuz.ru');

		expect(result.unparsed).toEqual([
			{
				text: 'приёмная +7 999 000-00-00',
				reason: 'после «приёмная» нет имени: фамилия и имя пишутся вместе, до первой запятой'
			}
		]);
		expect(result.contacts.map(contactFullName)).toEqual(['Орлов Пётр']);
	});

	it('объясняет, какое слово не принято за имя', () => {
		const [digit] = parseContacts('Проход2-С Иванова Мария Петровна, проректор').unparsed;

		expect(digit.reason).toBe(
			'«Проход2-С» не похоже на фамилию: в ФИО бывают только буквы, дефис и точка у инициала'
		);
		expect(parseContacts('rector@vuz.ru').unparsed[0].reason).toBe(
			'в нём только почта или телефон, а нужны фамилия и имя'
		);
	});

	it('маркер отчества за отчеством остаётся в ФИО, а не уходит в должность', () => {
		const [contact] = parseContacts('Алиева Айгюн Рашидовна кызы, проректор').contacts;

		expect(contact).toMatchObject({
			lastName: 'Алиева',
			firstName: 'Айгюн',
			middleName: 'Рашидовна кызы',
			position: 'проректор'
		});
	});

	it('пустая ячейка — это ноль людей и ноль претензий', () => {
		expect(parseContacts('   ;  \n ')).toEqual({ contacts: [], unparsed: [] });
	});

	it('телефон сравнивается по цифрам, как его ни запиши', () => {
		expect(normalizeContactPhone('+7 (999) 123-45-67')).toBe('79991234567');
		expect(normalizeContactPhone('8 999 123 45 67')).toBe('89991234567');
	});
});
