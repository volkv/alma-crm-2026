import { describe, expect, it } from 'vitest';
import { lookupQueryKind, type LegalEntity } from '$lib/contracts/enrichment';
import { guessEducationLevel, guessKind } from '$lib/server/enrichment/classify';
import { legalStatus, readSuggestions, toLegalEntity } from '$lib/server/enrichment/dadata';
import { registryPassport } from '$lib/server/enrichment';
import {
	charsetOf,
	isCertificateError,
	normalizeWebsite,
	readSvedenPage,
	redirectTarget,
	secureUrl,
	siteFromEmails,
	withinSite,
	wwwTwin
} from '$lib/server/enrichment/sveden';

/**
 * Сборка паспорта организации: распознавание строки поиска, разбор ответа
 * справочника, догадки о виде и уровне, чтение раздела сайта и замечания
 * сотруднику. Сети здесь нет — проверяются те части, которые решают, что в
 * итоге увидит человек.
 */

const entity: LegalEntity = {
	inn: '7802084569',
	kpp: '780201001',
	ogrn: '1027802505279',
	legalName:
		'ФЕДЕРАЛЬНОЕ ГОСУДАРСТВЕННОЕ АВТОНОМНОЕ ОБРАЗОВАТЕЛЬНОЕ УЧРЕЖДЕНИЕ ВЫСШЕГО ОБРАЗОВАНИЯ "ТАКОЙ-ТО ПОЛИТЕХНИЧЕСКИЙ УНИВЕРСИТЕТ"',
	shortName: 'ФГАОУ ВО "ТАКОЙ-ТО ПОЛИТЕХ"',
	region: 'г Санкт-Петербург',
	address: '195251, г Санкт-Петербург, ул Политехническая, д 29',
	status: 'active',
	isBranch: false,
	management: { name: 'Иванов Иван Иванович', post: 'РЕКТОР' },
	emails: ['office@polytech.example.ru'],
	okved: '85.22'
};

describe('распознавание строки поиска', () => {
	it('десять цифр с верной контрольной суммой — это ИНН', () => {
		expect(lookupQueryKind('7802084569')).toEqual({ kind: 'inn', query: '7802084569' });
	});

	it('пробелы и дефисы из буфера обмена снимаются', () => {
		expect(lookupQueryKind(' 7802-084569 ')).toEqual({ kind: 'inn', query: '7802084569' });
	});

	it('цифры с неверной контрольной суммой ИНН не образуют', () => {
		expect(lookupQueryKind('7802084560').kind).toBe('name');
	});

	it('всё остальное — название', () => {
		expect(lookupQueryKind('  Политех  ')).toEqual({ kind: 'name', query: 'Политех' });
	});
});

describe('ответ справочника', () => {
	it('переносит реквизиты в поля карточки', () => {
		const mapped = toLegalEntity({
			value: 'ТАКОЙ-ТО ПОЛИТЕХ',
			data: {
				inn: '7802084569',
				kpp: '780201001',
				ogrn: '1027802505279',
				okved: '85.22',
				branch_type: 'MAIN',
				emails: [{ value: 'office@polytech.example.ru' }],
				name: { full_with_opf: 'ФГАОУ ВО «ТАКОЙ-ТО ПОЛИТЕХ»', short_with_opf: 'СПбПУ' },
				address: { value: '195251, ...', data: { region_with_type: 'г Санкт-Петербург' } },
				state: { status: 'ACTIVE' },
				management: { name: 'Иванов И. И.', post: 'РЕКТОР' }
			}
		});

		expect(mapped).not.toBeNull();
		expect(mapped?.inn).toBe('7802084569');
		expect(mapped?.shortName).toBe('СПбПУ');
		expect(mapped?.region).toBe('г Санкт-Петербург');
		expect(mapped?.isBranch).toBe(false);
		expect(mapped?.emails).toEqual(['office@polytech.example.ru']);
	});

	it('запись без наименования не показывается: называть её нечем', () => {
		expect(toLegalEntity({ data: { inn: '7802084569' } })).toBeNull();
	});

	it('филиал отличается от головной организации', () => {
		const branch = toLegalEntity({
			value: 'Филиал',
			data: { branch_type: 'BRANCH', name: { short_with_opf: 'Филиал' } }
		});

		expect(branch?.isBranch).toBe(true);
	});

	it('незнакомое состояние не считается действующим', () => {
		expect(legalStatus('ACTIVE')).toBe('active');
		expect(legalStatus('LIQUIDATED')).toBe('liquidated');
		expect(legalStatus('НЕПОНЯТНО')).toBe('unknown');
		expect(legalStatus(undefined)).toBe('unknown');
	});

	it('чужой формат ответа — это отказ, а не пустой список', () => {
		expect(() => readSuggestions({ ok: true })).toThrowError();
		expect(readSuggestions({ suggestions: [] })).toEqual([]);
	});
});

describe('догадки о виде и уровне', () => {
	it('код ОКВЭД главнее названия', () => {
		expect(guessEducationLevel('Научно-исследовательский институт чего-то', '85.22')).toBe('vo');
		expect(guessEducationLevel('Какое-то название', '85.21')).toBe('spo');
		expect(guessEducationLevel('Какое-то название', '85.12')).toBe('school');
	});

	it('по названию: колледж — это СПО, даже если он при университете', () => {
		expect(guessEducationLevel('Колледж при Таком-то университете', null)).toBe('spo');
	});

	it('университет и академия — высшее образование', () => {
		expect(guessEducationLevel('Такой-то государственный университет', null)).toBe('vo');
		expect(guessEducationLevel('Российская академия чего-то', null)).toBe('vo');
	});

	it('лицей и гимназия — школа', () => {
		expect(guessEducationLevel('Лицей № 1', null)).toBe('school');
		expect(guessEducationLevel('Гимназия № 2', null)).toBe('school');
	});

	it('организация, не похожая на учебную, остаётся юридическим лицом', () => {
		expect(guessEducationLevel('ООО «Ромашка»', '62.01')).toBeNull();
		expect(guessKind('ООО «Ромашка»', '62.01')).toBe('legal_entity');
		expect(guessKind('Такой-то политехнический университет', '85.22')).toBe(
			'educational_institution'
		);
	});
});

describe('поиск сайта', () => {
	it('домен почты из выписки становится догадкой о сайте', () => {
		expect(siteFromEmails(['office@polytech.example.ru'])).toBe('https://polytech.example.ru');
	});

	it('общедоступная почта сайтом организации не является', () => {
		expect(siteFromEmails(['rector@mail.ru', 'office@polytech.example.ru'])).toBe(
			'https://polytech.example.ru'
		);
		expect(siteFromEmails(['rector@mail.ru'])).toBeNull();
	});

	it('строка, которая не похожа на имя домена, адресом не становится', () => {
		expect(siteFromEmails(['кто-то@почта'])).toBeNull();
		expect(siteFromEmails([])).toBeNull();
	});

	it('сайт приводится к происхождению: схема дописывается, путь отбрасывается', () => {
		expect(normalizeWebsite('spbstu.ru')).toBe('https://spbstu.ru');
		expect(normalizeWebsite('https://www.spbstu.ru/sveden/common')).toBe('https://www.spbstu.ru');
		expect(normalizeWebsite('  ')).toBeNull();
	});

	it('ходить разрешено только по домену сайта из карточки', () => {
		expect(withinSite('spbstu.ru', 'www.spbstu.ru')).toBe(true);
		expect(withinSite('www.miet.ru', 'sveden.miet.ru')).toBe(true);
		expect(withinSite('spbstu.ru', 'spbstu.ru.evil.example')).toBe(false);
		expect(withinSite('spbstu.ru', 'notspbstu.ru')).toBe(false);
	});

	it('перенаправление на http внутри сайта повышается до https, чужой домен — отказ', () => {
		const from = 'https://mospolytech.ru/sveden/struct';

		expect(redirectTarget('mospolytech.ru', from, 'http://mospolytech.ru/sveden/struct/')).toBe(
			'https://mospolytech.ru/sveden/struct/'
		);
		expect(redirectTarget('mospolytech.ru', from, 'http://evil.example/sveden/struct/')).toBeNull();
		expect(
			redirectTarget('mospolytech.ru', from, 'http://mospolytech.ru/sveden/struct')
		).toBeNull();
	});

	it('двойник сайта — с www или без него', () => {
		expect(wwwTwin('https://www.bsuedu.ru')).toBe('https://bsuedu.ru');
		expect(wwwTwin('https://bsuedu.ru')).toBe('https://www.bsuedu.ru');
	});

	it('отказ проверки сертификата отличается от сетевого сбоя', () => {
		expect(isCertificateError({ cause: { code: 'CERT_HAS_EXPIRED' } })).toBe(true);
		expect(isCertificateError({ cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })).toBe(true);
		expect(isCertificateError({ cause: { code: 'ECONNREFUSED' } })).toBe(false);
		expect(isCertificateError(new Error('timeout'))).toBe(false);
	});

	it('первый заход по сайту с http:// тоже идёт по https', () => {
		expect(secureUrl('http://www.kpfu.ru/sveden/common')).toBe('https://www.kpfu.ru/sveden/common');
		expect(secureUrl('https://kpfu.ru/sveden/')).toBe('https://kpfu.ru/sveden/');
	});
});

describe('раздел «Сведения об образовательной организации»', () => {
	const page = `
		<html><head><meta charset="utf-8"></head><body>
		<div itemscope itemtype="http://obrnadzor.gov.ru/microdata/Common">
			<span itemprop="fullName">Такой-то политехнический университет</span>
			<span itemprop="shortName">Политех</span>
			<meta itemprop="regDate" content="1899-02-19">
			<span itemprop="address">195251, Санкт-Петербург, ул. Политехническая, 29</span>
			<span itemprop="telephone">+7 812 000-00-00</span>
			<span itemprop="email">office@polytech.example.ru</span>
			<span itemprop="uchredName">Министерство науки и высшего образования РФ</span>
			<span itemprop="fio">Иванов Иван Иванович</span>
			<span itemprop="post">Ректор</span>
		</div></body></html>`;

	it('читает поля раздела', () => {
		const report = readSvedenPage('https://polytech.example.ru/sveden/common', page);

		expect(report.found).toBe(true);
		expect(report.fields.fullName).toBe('Такой-то политехнический университет');
		expect(report.fields.regDate).toBe('1899-02-19');
		expect(report.fields.founder).toBe('Министерство науки и высшего образования РФ');
		expect(report.fields.headName).toBe('Иванов Иван Иванович');
		expect(report.fields.headPost).toBe('Ректор');
		expect(report.problem).toBeNull();
	});

	it('страница без микроразметки разделом не считается', () => {
		const report = readSvedenPage('https://example.ru/sveden/common', '<h1>Сведения</h1>');

		expect(report.found).toBe(false);
		expect(report.problem).not.toBeNull();
	});

	it('кодировка берётся из заголовка ответа, а он главнее разметки', () => {
		expect(charsetOf('text/html; charset=windows-1251', '<meta charset="utf-8">')).toBe(
			'windows-1251'
		);
		expect(charsetOf(null, '<meta charset="Windows-1251">')).toBe('windows-1251');
		expect(
			charsetOf(null, '<meta http-equiv="content-type" content="text/html; charset=koi8-r">')
		).toBe('koi8-r');
		expect(charsetOf(null, '<html>')).toBe('utf-8');
	});
});

describe('паспорт по ответу реестра', () => {
	const fetchedAt = '2026-09-24T09:00:00.000Z';

	it('реквизиты — из ЕГРЮЛ, вид и сайт — догадка, у каждого значения дата', async () => {
		const passport = await registryPassport('7802084569', [entity], fetchedAt);

		expect(passport.fields.inn).toEqual({ value: '7802084569', source: 'dadata', fetchedAt });
		expect(passport.fields.legalName?.source).toBe('dadata');
		expect(passport.fields.kind).toEqual({
			value: 'educational_institution',
			source: 'guess',
			fetchedAt
		});
		expect(passport.fields.educationLevel?.value).toBe('vo');
		expect(passport.fields.website).toEqual({
			value: 'https://polytech.example.ru',
			source: 'guess',
			fetchedAt
		});
	});

	it('пустое значение источника не предлагается стереть поле карточки', async () => {
		const passport = await registryPassport('x', [{ ...entity, kpp: null, emails: [] }], fetchedAt);

		expect(passport.fields.kpp).toBeUndefined();
		expect(passport.fields.website).toBeUndefined();
	});

	it('о ликвидации и филиале говорят прямо', async () => {
		const { warnings } = await registryPassport(
			'x',
			[{ ...entity, status: 'liquidated', isBranch: true }],
			fetchedAt
		);

		expect(warnings.some((text) => text.includes('ликвидирована'))).toBe(true);
		expect(warnings.some((text) => text.includes('филиал'))).toBe(true);
	});
});
