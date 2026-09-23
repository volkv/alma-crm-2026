/**
 * Паспорт организации из внешних источников: от строки поиска или сайта до
 * предложения полей карточки.
 *
 * Два входа, по шагам работы сотрудника. По названию или ИНН спрашивается
 * справочник юридических лиц (`dadata.ts`) — оттуда реквизиты. По сайту из
 * карточки читается раздел «Сведения об образовательной организации»
 * (`sveden.ts`) — оттуда наименования, кандидаты в контакты и программы.
 * Третий вход — снимок JSON, загруженный файлом: тот же паспорт, собранный
 * там, где источники были включены.
 *
 * Модуль ничего не пишет в справочник. Наружу он отдаёт паспорт под номером
 * (`passports.ts`), а записывает принятые поля форма организации — когда
 * сотрудник увидел разницу, отметил нужное и сохранил. Результат всегда неполон
 * и местами неверен: ЕГРЮЛ отстаёт от жизни, сайт вуза заполняли руками, а вид
 * организации угадан. Поэтому у каждого значения — источник и дата, а рядом —
 * замечания, что посмотреть глазами.
 */
import { createHash } from 'node:crypto';
import {
	lookupQueryKind,
	organizationPassportSchema,
	passportValueFits,
	PASSPORT_FIELDS,
	type FieldSource,
	type IssuedPassport,
	type LegalEntity,
	type LookupQueryKind,
	type OrganizationPassport,
	type PassportField,
	type PassportValue,
	type SiteReport
} from '$lib/contracts/enrichment';
import type { ActorContext } from '../actor';
import { cached, type CacheRegion } from '../cache/region';
import { NotFoundError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { consumeQuota, requireEnabled } from './access';
import { guessEducationLevel, guessKind } from './classify';
import { DadataError, DADATA_NOT_CONFIGURED, findParties, isDadataConfigured } from './dadata';
import { issuePassport } from './passports';
import { fetchSiteReport, normalizeWebsite, siteFromEmails } from './sveden';

/** Состояния ЕГРЮЛ, о которых сотруднику говорят отдельно. */
const STATUS_WARNINGS: Record<string, string> = {
	liquidating: 'По ЕГРЮЛ организация в процессе ликвидации',
	liquidated: 'По ЕГРЮЛ организация ликвидирована',
	reorganizing: 'По ЕГРЮЛ организация в процессе реорганизации',
	bankrupt: 'По ЕГРЮЛ организация в процедуре банкротства',
	unknown: 'Состояние организации в ЕГРЮЛ не определено'
};

/**
 * Ответы источников живут сутки. Реквизиты вуза меняются реже, чем раз в год,
 * а лимит подсказок у поставщика общий на стенд. Перепроверки по расписанию нет
 * намеренно: паспорт спрашивают, когда заводят или правят карточку, и держать
 * его свежим без человека, который на него смотрит, незачем.
 */
const ENRICHMENT_CACHE: CacheRegion = { name: 'enrichment', ttlSeconds: 24 * 60 * 60 };

function valueOf(
	value: string | null | undefined,
	source: FieldSource,
	fetchedAt: string
): PassportValue | undefined {
	const trimmed = value?.trim();

	return trimmed === undefined || trimmed === ''
		? undefined
		: { value: trimmed, source, fetchedAt };
}

/** Поля без пустых: пустое значение источника — не предложение стереть поле. */
function compact(
	fields: Partial<Record<PassportField, PassportValue | undefined>>
): OrganizationPassport['fields'] {
	const result: OrganizationPassport['fields'] = {};

	for (const field of PASSPORT_FIELDS) {
		const value = fields[field];

		if (value !== undefined) {
			result[field] = value;
		}
	}

	return result;
}

/**
 * Паспорт по ответу реестра.
 *
 * Реквизиты — ИНН, КПП, ОГРН, регион, наименования — как их отдал ЕГРЮЛ. Вид
 * организации и уровень образования угаданы по ОКВЭД и названию, сайт — по
 * домену почты из выписки; все три помечены догадкой.
 */
export function registryPassport(
	query: string,
	entities: readonly LegalEntity[],
	fetchedAt: string
): OrganizationPassport {
	const [entity, ...others] = entities;

	if (entity === undefined) {
		throw new NotFoundError('По этой строке в реестре никого нет');
	}

	const kind = guessKind(entity.legalName, entity.okved);
	const educationLevel =
		kind === 'educational_institution' ? guessEducationLevel(entity.legalName, entity.okved) : null;

	return {
		version: 1,
		query,
		entity,
		others,
		fields: compact({
			kind: valueOf(kind, 'guess', fetchedAt),
			educationLevel: valueOf(educationLevel, 'guess', fetchedAt),
			legalName: valueOf(entity.legalName, 'dadata', fetchedAt),
			shortName: valueOf(entity.shortName, 'dadata', fetchedAt),
			inn: valueOf(entity.inn, 'dadata', fetchedAt),
			kpp: valueOf(entity.kpp, 'dadata', fetchedAt),
			ogrn: valueOf(entity.ogrn, 'dadata', fetchedAt),
			region: valueOf(entity.region, 'dadata', fetchedAt),
			website: valueOf(siteFromEmails(entity.emails), 'guess', fetchedAt)
		}),
		site: null,
		warnings: registryWarnings(entity, others, kind)
	};
}

/** Что проверить глазами в ответе реестра, прежде чем принимать реквизиты. */
export function registryWarnings(
	entity: LegalEntity,
	others: readonly LegalEntity[],
	kind: string
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

	if (kind !== 'educational_institution') {
		warnings.push(
			'По названию и коду ОКВЭД это не похоже на образовательную организацию: вид угадан'
		);
	}

	if (siteFromEmails(entity.emails) !== null) {
		warnings.push(
			'Сайт в ЕГРЮЛ не хранится и угадан по домену почты из выписки: проверьте его, прежде чем читать раздел «Сведения»'
		);
	}

	return warnings;
}

/**
 * Паспорт по разделу `/sveden` сайта.
 *
 * Из полей карточки сайт предлагает только наименования: реквизиты живут в
 * реестре, и сайт, где ИНН набран руками, ему не соперник. Остальное —
 * руководители подразделений и программы — идёт списками для просмотра.
 */
export function sitePassport(report: SiteReport): OrganizationPassport {
	const common = report.common.found ? report.common.fields : null;

	return {
		version: 1,
		query: null,
		entity: null,
		others: [],
		fields: compact({
			legalName: valueOf(common?.fullName, 'sveden', report.fetchedAt),
			shortName: valueOf(common?.shortName, 'sveden', report.fetchedAt)
		}),
		site: report,
		warnings: siteWarnings(report)
	};
}

/** Что не прочиталось на сайте — сказано словами, а не пустыми блоками. */
export function siteWarnings(report: SiteReport): string[] {
	const warnings: string[] = [];

	if (!report.common.found) {
		warnings.push(
			`«Основные сведения» по адресу ${report.common.url} не прочитались: что сайт принадлежит образовательной организации, ничем не подтверждено`
		);
	}

	if (!report.struct.found) {
		warnings.push(
			'Подраздел «Структура и органы управления» не прочитался: кандидатов в контакты нет'
		);
	}

	if (!report.education.found) {
		warnings.push('Перечень образовательных программ не прочитался');
	} else if (report.education.truncated) {
		warnings.push(
			'Страница с программами больше допустимого размера и прочитана не целиком: список неполон'
		);
	}

	return warnings;
}

function cacheKey(...parts: string[]): string {
	return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 32);
}

type RegistryAnswer = { entities: LegalEntity[]; fetchedAt: string };

/**
 * Поиск по реестру: реквизиты по названию или ИНН.
 *
 * Право — то же, что на правку организаций: паспорт существует ради
 * заполнения карточки. Ответ из кэша квоту не тратит — тратит только настоящее
 * обращение к поставщику.
 */
export async function lookupRegistry(ctx: ActorContext, raw: string): Promise<IssuedPassport> {
	requirePermission(ctx, 'organizations.write');
	const settings = await requireEnabled();

	// Без ключа обращения не будет — и квоту на него тратить нечего.
	if (!isDadataConfigured()) {
		throw new DadataError('not_configured', null, DADATA_NOT_CONFIGURED);
	}

	const { kind, query } = lookupQueryKind(raw);

	// Кэш общий для всех сотрудников: это открытые сведения реестра, а не
	// выборка из справочника, и области доступа они не знают.
	const answer = await cached<RegistryAnswer>(
		ENRICHMENT_CACHE,
		`registry:${cacheKey(kind, query.toLocaleLowerCase('ru'))}`,
		async () => {
			await consumeQuota(ctx, settings.dailyQuota);

			return { entities: await findParties(query, kind), fetchedAt: new Date().toISOString() };
		},
		(stored) => stored as RegistryAnswer
	);

	if (answer.entities.length === 0) {
		throw new NotFoundError(notFoundMessage(kind));
	}

	return issuePassport(ctx, 'live', registryPassport(query, answer.entities, answer.fetchedAt));
}

function notFoundMessage(kind: LookupQueryKind): string {
	return kind === 'inn'
		? 'Организация с таким ИНН в реестре не найдена'
		: 'По этому названию в реестре ничего не нашлось';
}

/**
 * Чтение раздела `/sveden` по сайту из карточки.
 *
 * Сайт называет форма — то, что сейчас стоит в поле «Сайт». Идти разрешено
 * только внутри его домена (`withinSite`), и каждый адрес проверяется правилом
 * исходящих адресов.
 */
export async function lookupSite(ctx: ActorContext, website: string): Promise<IssuedPassport> {
	requirePermission(ctx, 'organizations.write');
	const settings = await requireEnabled();
	const origin = normalizeWebsite(website);

	if (origin === null) {
		throw new ValidationError('Адрес сайта в карточке не разбирается');
	}

	const report = await cached<SiteReport | null>(
		ENRICHMENT_CACHE,
		`site:${cacheKey(origin.toLowerCase())}`,
		async () => {
			await consumeQuota(ctx, settings.dailyQuota);

			return fetchSiteReport(origin, new Date().toISOString());
		},
		(stored) => stored as SiteReport | null
	);

	if (report === null) {
		throw new ValidationError('Адрес сайта в карточке не разбирается');
	}

	return issuePassport(ctx, 'live', sitePassport(report));
}

/** Потолок снимка: паспорт с полным перечнем программ весит сотни килобайт. */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Снимок паспорта из файла — тот же формат, что отдаёт поиск.
 *
 * Работает и при выключенных источниках: наружу он не ходит, а принятые из него
 * поля проходят тот же дифф и то же подтверждение. Происхождение таких полей
 * помечается снимком: источник и дату в нём назвал тот, кто его собирал.
 */
export async function importSnapshot(ctx: ActorContext, text: string): Promise<IssuedPassport> {
	requirePermission(ctx, 'organizations.write');

	let raw: unknown;

	try {
		raw = JSON.parse(text);
	} catch {
		throw new ValidationError('Файл не читается как JSON');
	}

	const parsed = organizationPassportSchema.safeParse(raw);

	if (!parsed.success) {
		throw new ValidationError(
			'Файл не похож на снимок паспорта организации',
			parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`)
		);
	}

	const misfits = PASSPORT_FIELDS.filter((field) => {
		const value = parsed.data.fields[field];

		return value !== undefined && !passportValueFits(field, value.value);
	});

	if (misfits.length > 0) {
		throw new ValidationError('В снимке есть значения, которых карточка не допускает', misfits);
	}

	return issuePassport(ctx, 'snapshot', parsed.data);
}
