import { describe, expect, it } from 'vitest';
import { lookupQueryKind, type LegalEntity } from '$lib/contracts/enrichment';
import { guessEducationLevel, guessKind } from '$lib/server/enrichment/classify';
import { legalStatus, readSuggestions, toLegalEntity } from '$lib/server/enrichment/dadata';
import { buildDraft, draftWarnings, namesAgree } from '$lib/server/enrichment';
import {
	charsetOf,
	normalizeWebsite,
	readSvedenPage,
	siteFromEmails,
	svedenCandidates
} from '$lib/server/enrichment/sveden';

/**
 * Сборка черновика карточки: распознавание строки поиска, разбор ответа
 * справочника, догадки о виде и уровне, чтение раздела сайта и замечания
 * сотруднику. Сети здесь нет — проверяются те части, которые решают, что в
 * итоге увидит человек.
 */

const entity: LegalEntity = {
	inn: '7802084569',
	kpp: '780201001',
	ogrn: '1027801570540',
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
				ogrn: '1027801570540',
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

	it('раздел ищется от корня сайта, а не от переданного пути', () => {
		expect(svedenCandidates('https://spbstu.ru/education')[0]).toBe(
			'https://spbstu.ru/sveden/common'
		);
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

describe('черновик карточки', () => {
	const sveden = readSvedenPage(
		'https://polytech.example.ru/sveden/common',
		'<span itemprop="fullName">Такой-то политехнический университет</span><span itemprop="shortName">Политех</span>'
	);

	it('реквизиты берутся из ЕГРЮЛ, названия — с сайта', () => {
		const { draft, sources } = buildDraft(entity, sveden, {
			value: 'https://polytech.example.ru',
			fromInput: false
		});

		expect(draft.inn).toBe('7802084569');
		expect(sources.inn).toBe('dadata');
		expect(draft.legalName).toBe('Такой-то политехнический университет');
		expect(sources.legalName).toBe('sveden');
		expect(draft.shortName).toBe('Политех');
		expect(draft.kind).toBe('educational_institution');
		expect(draft.educationLevel).toBe('vo');
		expect(sources.website).toBe('guess');
	});

	it('без раздела названия остаются теми, что в реестре', () => {
		const { draft, sources } = buildDraft(entity, null, { value: null, fromInput: false });

		expect(draft.legalName).toBe(entity.legalName);
		expect(sources.legalName).toBe('dadata');
		expect(draft.website).toBeNull();
	});

	it('уровень образования заполняется только у учебного заведения', () => {
		const company = { ...entity, legalName: 'ООО «Ромашка»', okved: '62.01' };
		const { draft } = buildDraft(company, null, { value: null, fromInput: false });

		expect(draft.kind).toBe('legal_entity');
		expect(draft.educationLevel).toBeNull();
	});

	it('названный человеком сайт помечается как введённый вручную', () => {
		const { sources } = buildDraft(entity, sveden, {
			value: 'https://polytech.example.ru',
			fromInput: true
		});

		expect(sources.website).toBe('input');
	});
});

describe('замечания сотруднику', () => {
	const draftOf = (value: LegalEntity, report = null) =>
		buildDraft(value, report, { value: 'https://polytech.example.ru', fromInput: true }).draft;

	it('о ликвидации говорят прямо', () => {
		const dead = { ...entity, status: 'liquidated' as const };
		const warnings = draftWarnings(dead, [], draftOf(dead), null);

		expect(warnings.some((text) => text.includes('ликвидирована'))).toBe(true);
	});

	it('филиал отмечается отдельно: ИНН у него общий с головной организацией', () => {
		const branch = { ...entity, isBranch: true };

		expect(draftWarnings(branch, [], draftOf(branch), null).some((t) => t.includes('филиал'))).toBe(
			true
		);
	});

	it('непрочитанный раздел означает, что принадлежность сайта не подтверждена', () => {
		const warnings = draftWarnings(entity, [], draftOf(entity), null);

		expect(warnings.some((text) => text.includes('не прочитался'))).toBe(true);
	});

	it('расхождение названий в реестре и на сайте показывается сотруднику', () => {
		const other = readSvedenPage(
			'https://polytech.example.ru/sveden/common',
			'<span itemprop="fullName">Совсем другая организация</span>'
		);
		const { draft } = buildDraft(entity, other, {
			value: 'https://polytech.example.ru',
			fromInput: true
		});

		expect(
			draftWarnings(entity, [], draft, other).some((text) => text.includes('не совпадают'))
		).toBe(true);
	});

	it('разное написание одного и того же названия расхождением не считается', () => {
		expect(
			namesAgree(
				'ФГАОУ ВО «Такой-то политехнический университет»',
				'Такой-то политехнический университет'
			)
		).toBe(true);
		expect(namesAgree('Такой-то политех', 'Совсем другая организация')).toBe(false);
	});
});
