import { describe, expect, it } from 'vitest';
import { sitePassport } from '$lib/server/enrichment';
import { readStructPage, readSvedenPage } from '$lib/server/enrichment/sveden';

/**
 * Ячейки «Сведений» в том виде, в каком их набирают вузы: подпись поля внутри
 * размеченного элемента, ссылка на положение внутри названия подразделения,
 * номер и почта в одной ячейке, маркеры дерева сущностями. Разметка повторяет
 * настоящую страницу вуза; ФИО и адреса вымышленные.
 */

const common = `
<div class="units-row content"><p itemprop="fullName">
 <b>Полное наименование</b>: Федеральное государственное бюджетное образовательное учреждение высшего образования «Приволжский технический университет».
</p>
<p itemprop="shortName">
 <b>Сокращенные наименования</b>: ФГБОУ ВО «Приволжский технический университет»; Приволжский технический университет; ПрвТУ.
</p>
<p itemprop="regDate"><b>Дата создания:</b>&nbsp;31 мая 1930 г.</p>
<p itemprop="address">
 <b>Место нахождения образовательного учреждения:</b>&nbsp;Россия,&nbsp;400005, г. Волгоград, проспект им. В.И. Ленина,&nbsp;д. 28.
</p>
<p itemprop="workTime"><b>Режим и график работы:</b>&nbsp;Пн-Чт, 8:30-17:15.</p>
<p itemprop="telephone"><b>Справочный телефон образовательного учреждения:</b>&nbsp;+7 (8442) 00-00-15.</p>
<p itemprop="email"><b>Адрес электронной почты образовательного учреждения:</b>&nbsp;<a href="mailto:rector@prvtu.example.ru">rector@prvtu.example.ru</a><br></p>
</div>`;

const struct = `
<table>
<tr itemprop="structOrgUprav">
	<td colspan=6><div align=center><b>ОРГАНЫ УПРАВЛЕНИЯ</b></div></td>
<tr itemprop="structOrgUprav">
	<td itemprop="name">Ректорат <div itemprop="divisionClauseDocLink">
		<a href="/upload/sveden/struct/rectorat.pdf">Положение от 03.12.2019</a>&nbsp;
	</div></td>
	<td itemprop="fio"><a href="/people/1/">Петров Пётр Петрович</a></td>
	<td itemprop="post">исполняющий обязанности ректора</td>
	<td itemprop="addressStr">400005, Волгоград, пр. им. Ленина, 28, к.208</td>
	<td itemprop="site">нет</td>
	<td itemprop="email">(8442) 00-00-76;<br><a href="mailto:rector@prvtu.example.ru">rector@prvtu.example.ru</a></td>
</tr>
<tr itemprop="structOrgUprav">
	<td itemprop="name">&nbsp;&nbsp;&bull;&nbspАрхив <div itemprop="divisionClauseDocLink"></div></td>
	<td itemprop="fio">Сидорова Анна Ивановна</td>
	<td itemprop="post">начальник</td>
	<td itemprop="addressStr">400005, Волгоград, пр. им. Ленина, 28</td>
	<td itemprop="site">нет</td>
	<td itemprop="email">(8442)00-81-98; archive@prvtu.example.ru</td>
</tr>
<tr itemprop="structOrgUprav">
	<td itemprop="name">Отдел кадров</td>
	<td itemprop="fio">--</td>
	<td itemprop="post">--</td>
	<td itemprop="addressStr">--</td>
	<td itemprop="site">нет</td>
	<td itemprop="email">--</td>
</tr>
</table>`;

describe('«Основные сведения» с подписями полей', () => {
	const report = readSvedenPage('https://prvtu.example.ru/sveden/common', common);

	it('подпись поля в значение не попадает', () => {
		expect(report.fields.fullName).toMatch(/^Федеральное государственное бюджетное/);
		expect(report.fields.shortName).toMatch(/^ФГБОУ ВО/);
		expect(report.fields.regDate).toBe('31 мая 1930 г.');
		expect(report.fields.address).toBe(
			'Россия, 400005, г. Волгоград, проспект им. В.И. Ленина, д. 28'
		);
		expect(report.fields.telephone).toBe('+7 (8442) 00-00-15');
		expect(report.fields.email).toBe('rector@prvtu.example.ru');
	});

	it('краткое наименование — аббревиатура из написаний через «;», регион — по столице субъекта', () => {
		const passport = sitePassport({
			website: 'https://prvtu.example.ru',
			fetchedAt: '2026-09-28T08:00:00.000Z',
			common: report,
			struct: { url: '', found: false, truncated: false, problem: null },
			managers: null,
			education: { url: '', found: false, truncated: false, problem: null },
			contacts: [],
			units: [],
			programs: []
		});

		expect(passport.fields.shortName?.value).toBe('ПрвТУ');
		expect(passport.fields.shortName?.variants).toEqual([
			'ФГБОУ ВО «Приволжский технический университет»',
			'Приволжский технический университет'
		]);
		expect(passport.fields.region?.value).toBe('Волгоградская область');
	});
});

describe('кандидаты из «Структуры»', () => {
	const contacts = readStructPage(struct);

	it('название без положения и маркеров, номер и почта — по своим полям, пустышка отброшена', () => {
		expect(contacts).toEqual([
			{
				unit: 'Ректорат',
				name: 'Петров Пётр Петрович',
				post: 'исполняющий обязанности ректора',
				email: 'rector@prvtu.example.ru',
				phone: '(8442) 00-00-76',
				address: '400005, Волгоград, пр. им. Ленина, 28, к.208'
			},
			{
				unit: 'Архив',
				name: 'Сидорова Анна Ивановна',
				post: 'начальник',
				email: 'archive@prvtu.example.ru',
				phone: '(8442)00-81-98',
				address: '400005, Волгоград, пр. им. Ленина, 28'
			}
		]);
	});
});

describe('один человек в нескольких строках «Структуры»', () => {
	const rows = `
<table>
<tr itemprop="structOrgUprav">
	<td itemprop="name">Ученый совет</td>
	<td itemprop="fio">Петров Пётр Петрович, председатель Ученого совета, ректор</td>
	<td itemprop="post"></td>
	<td itemprop="email">council@prvtu.example.ru</td>
</tr>
<tr itemprop="structOrgUprav">
	<td itemprop="name">Ректор</td>
	<td itemprop="fio">Петров Пётр Петрович</td>
	<td itemprop="post"></td>
	<td itemprop="email">rector@prvtu.example.ru</td>
</tr>
<tr itemprop="structOrgUprav">
	<td itemprop="name">Проректор по АХР</td>
	<td itemprop="fio">Сидоров Иван Ильич</td>
	<td itemprop="post"></td>
	<td itemprop="email">ahr@prvtu.example.ru</td>
</tr>
</table>`;

	it('склеены в одного кандидата, должность из ФИО и из подразделения — в должности', () => {
		expect(readStructPage(rows).map(({ unit, name, post }) => ({ unit, name, post }))).toEqual([
			{
				unit: 'Ученый совет',
				name: 'Петров Пётр Петрович',
				post: 'председатель Ученого совета, ректор'
			},
			{ unit: 'Проректор по АХР', name: 'Сидоров Иван Ильич', post: 'Проректор по АХР' }
		]);
	});
});
