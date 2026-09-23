/**
 * Поиск организации во внешних источниках: от строки до черновика карточки.
 *
 * Порядок один и тот же, что бы ни ввёл сотрудник. Строка распознаётся как ИНН
 * или как название (`lookupQueryKind`), по ней спрашивается справочник
 * юридических лиц (`dadata.ts`), у первого попавшего ищется сайт, по сайту
 * читается раздел «Сведения об образовательной организации» (`sveden.ts`), и
 * всё это сводится в поля карточки с пометкой, откуда взялось каждое.
 *
 * Модуль изолирован намеренно: он ничего не пишет в базу, ничего не знает про
 * справочник организаций и не вызывается из его форм. Наружу он отдаёт
 * черновик, а что с ним делать — решает то место, куда его однажды подключат.
 *
 * Результат всегда неполон и местами неверен: ЕГРЮЛ отстаёт от жизни, сайт
 * вуза заполняли руками, а вид организации и уровень образования вообще
 * угаданы. Поэтому вместе с черновиком идут `sources` — откуда каждое поле — и
 * `warnings` — что именно стоит посмотреть глазами.
 */
import {
	lookupQueryKind,
	type DraftSources,
	type LegalEntity,
	type OrganizationDraft,
	type OrganizationLookupResult,
	type SvedenReport
} from '$lib/contracts/enrichment';
import { guessEducationLevel, guessKind } from './classify';
import { findParties } from './dadata';
import { NotFoundError } from '../errors';
import { fetchSveden, normalizeWebsite, siteFromEmails } from './sveden';

/** Состояния ЕГРЮЛ, о которых сотруднику говорят отдельно. */
const STATUS_WARNINGS: Record<string, string> = {
	liquidating: 'По ЕГРЮЛ организация в процессе ликвидации',
	liquidated: 'По ЕГРЮЛ организация ликвидирована',
	reorganizing: 'По ЕГРЮЛ организация в процессе реорганизации',
	bankrupt: 'По ЕГРЮЛ организация в процедуре банкротства',
	unknown: 'Состояние организации в ЕГРЮЛ не определено'
};

/**
 * Наименование в виде, пригодном для сравнения: без кавычек, регистра и лишних
 * пробелов. Один и тот же вуз в выписке и на своём сайте пишется по-разному —
 * «ФГАОУ ВО „Такой-то университет“» против «Такой-то университет», — и
 * сравнивать их посимвольно значит всегда получать «не совпало».
 */
export function comparableName(value: string): string {
	return value
		.toLocaleLowerCase('ru')
		.replace(/[«»"'`„“”]/g, ' ')
		.replace(/ё/g, 'е')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Говорят ли выписка и сайт об одной организации. */
export function namesAgree(fromRegistry: string, fromSite: string): boolean {
	const registry = comparableName(fromRegistry);
	const site = comparableName(fromSite);

	return registry.includes(site) || site.includes(registry);
}

/**
 * Черновик карточки из выписки и раздела сайта.
 *
 * Правило на все поля одно: реквизиты берутся из ЕГРЮЛ, названия — с сайта.
 * ИНН, КПП, ОГРН и регион существуют в реестре и больше нигде; наименование в
 * реестре записано так, как его подали на регистрацию («ФГБОУ ВО ...»), а на
 * своём сайте вуз пишет то, как он называется. Для карточки, которую читает
 * человек, второе полезнее — но только если раздел действительно нашёлся.
 */
export function buildDraft(
	entity: LegalEntity,
	sveden: SvedenReport | null,
	website: { value: string | null; fromInput: boolean }
): { draft: OrganizationDraft; sources: DraftSources } {
	const siteFullName = sveden?.found === true ? sveden.fields.fullName : null;
	const siteShortName = sveden?.found === true ? sveden.fields.shortName : null;
	const legalName = siteFullName ?? entity.legalName;
	const shortName = siteShortName ?? entity.shortName;
	const educationLevel = guessEducationLevel(legalName, entity.okved);
	const kind = guessKind(legalName, entity.okved);

	return {
		draft: {
			kind,
			// Уровень заполняют ровно у учебных заведений — это же проверяет база.
			educationLevel: kind === 'educational_institution' ? educationLevel : null,
			legalName,
			shortName,
			inn: entity.inn,
			kpp: entity.kpp,
			ogrn: entity.ogrn,
			region: entity.region,
			website: website.value
		},
		sources: {
			kind: 'guess',
			educationLevel: 'guess',
			legalName: siteFullName === null ? 'dadata' : 'sveden',
			shortName: siteShortName === null ? 'dadata' : 'sveden',
			inn: 'dadata',
			kpp: 'dadata',
			ogrn: 'dadata',
			region: 'dadata',
			// Не названный человеком сайт — это догадка по домену почты из выписки,
			// а не вычитанное где-то значение, и помечен он именно так.
			website: website.fromInput ? 'input' : 'guess'
		}
	};
}

/** Что сотруднику стоит проверить глазами, прежде чем заводить карточку. */
export function draftWarnings(
	entity: LegalEntity,
	others: LegalEntity[],
	draft: OrganizationDraft,
	sveden: SvedenReport | null
): string[] {
	const warnings: string[] = [];
	const statusWarning = STATUS_WARNINGS[entity.status];

	if (statusWarning !== undefined) {
		warnings.push(statusWarning);
	}

	if (entity.isBranch) {
		warnings.push('Это филиал, а не головная организация: ИНН у них общий, КПП разный');
	}

	if (others.length > 0) {
		warnings.push(
			`Под запрос попало ещё ${others.length} организаций — проверьте, что выбрана нужная`
		);
	}

	if (draft.kind !== 'educational_institution') {
		warnings.push(
			'По названию и коду ОКВЭД это не похоже на образовательную организацию: вид и уровень образования выбраны наугад'
		);
	}

	if (draft.website === null) {
		warnings.push('Сайт не нашёлся: в ЕГРЮЛ его нет, а почты, по домену которой его искать, тоже');
	} else if (sveden === null || !sveden.found) {
		warnings.push(
			`Раздел «Сведения об образовательной организации» по адресу ${draft.website} не прочитался, и что сайт принадлежит этой организации, ничем не подтверждено`
		);
	} else if (
		sveden.fields.fullName !== null &&
		!namesAgree(entity.legalName, sveden.fields.fullName)
	) {
		warnings.push(
			`Наименование в ЕГРЮЛ и на сайте не совпадают: «${entity.legalName}» против «${sveden.fields.fullName}»`
		);
	}

	return warnings;
}

/**
 * Полный поиск: справочник, сайт, раздел, черновик.
 *
 * `NotFoundError`, а не пустой результат: «по такой строке никого нет» — это
 * отказ, который страница показывает так же, как любой другой, а не особое
 * состояние, которое каждый вызывающий разбирал бы сам.
 */
export async function lookupOrganization(
	raw: string,
	websiteHint: string | null = null
): Promise<OrganizationLookupResult> {
	const { kind, query } = lookupQueryKind(raw);
	const entities = await findParties(query, kind);
	const [entity, ...others] = entities;

	if (entity === undefined) {
		throw new NotFoundError(
			kind === 'inn'
				? 'Организация с таким ИНН в справочнике не найдена'
				: 'По этому названию в справочнике ничего не нашлось'
		);
	}

	// Сайт, названный человеком, сильнее догадки по домену почты: он смотрит на
	// него прямо сейчас, а мы гадаем по выписке.
	const fromInput = websiteHint === null ? null : normalizeWebsite(websiteHint);
	const website = fromInput ?? siteFromEmails(entity.emails);
	const sveden = website === null ? null : await fetchSveden(website);
	const { draft, sources } = buildDraft(entity, sveden, {
		value: website,
		fromInput: fromInput !== null
	});

	return {
		kind,
		entity,
		others,
		draft,
		sources,
		sveden,
		warnings: draftWarnings(entity, others, draft, sveden)
	};
}
