/**
 * Сторона взаимодействия из реестра: поиск в ЕГРЮЛ из поля формы и заведение
 * выбранной строки организацией справочника.
 *
 * Панель паспорта предлагает поля и ждёт, пока сотрудник их примет и сохранит
 * карточку. Здесь карточки нет: сотрудник заполняет взаимодействие, и нужной
 * организации в справочнике просто не оказалось. Поэтому выбранная строка
 * реестра заводится сразу — с реквизитами из выписки, видом по полю, в котором
 * её выбрали, догадкой об уровне образования и сайтом, если его нашли источники
 * сайта (`website/`). Происхождение каждого значения пишется в журнал тем же
 * событием, что и приёмка паспорта.
 *
 * Браузер реквизитов не присылает. Каждая строка реестра уходит в него под
 * номером выданного паспорта (`passports.ts`), и заводит организацию сервер из
 * своей копии: подменить ИНН или название браузером нельзя, а второго
 * обращения к поставщику — и второго списания квоты — не нужно.
 */
import type {
	FieldSource,
	LegalEntity,
	PassportField,
	PassportProvenance,
	RegistryCandidate
} from '$lib/contracts/enrichment';
import {
	createOrganizationSchema,
	type LookupOption,
	type OrganizationFormKind
} from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { matchOrganizationsByInn } from '../directory/read';
import { createOrganization } from '../directory/write';
import { ConflictError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { guessEducationLevel, guessKind } from './classify';
import { queryRegistry, registryPassport } from './index';
import { issuePassport, readIssuedPassport } from './passports';
import { normalizeWebsite } from './sveden';
import { warmSiteReport } from './warm';

const TAKEN =
	'Организация с этим ИНН уже есть в справочнике, но вне вашей области доступа или в архиве';

const LIQUIDATED = 'По ЕГРЮЛ организация ликвидирована';

/**
 * Строки реестра по строке поиска — для выпадающего списка поля формы
 * взаимодействия и страницы новой организации.
 *
 * Каждая строка сверяется со справочником по ИНН: организация, которая уже
 * есть и доступна, выбирается как есть, а не заводится второй раз. Строка без
 * ИНН не показывается: сверить её не с чем, а ИНН — то, по чему справочник
 * узнаёт организацию.
 */
export async function searchRegistryCandidates(
	ctx: ActorContext,
	raw: string
): Promise<RegistryCandidate[]> {
	const answer = await queryRegistry(ctx, raw);
	const entities = answer.entities.filter(
		(entity): entity is LegalEntity & { inn: string } => entity.inn !== null
	);
	const matches = await matchOrganizationsByInn(
		ctx,
		entities.map((entity) => entity.inn)
	);

	return Promise.all(
		entities.map(async (entity) => {
			const match = matches.get(entity.inn);
			const unavailable =
				match === null ? TAKEN : entity.status === 'liquidated' ? LIQUIDATED : null;
			// Паспорт выдаётся только строке, которую будут заводить: у занятой и
			// у ликвидированной его никто не предъявит.
			const token =
				match === undefined && unavailable === null
					? (
							await issuePassport(
								ctx,
								'live',
								await registryPassport(answer.query, [entity], answer.fetchedAt)
							)
						).token
					: null;

			return {
				token,
				legalName: entity.legalName,
				shortName: entity.shortName,
				inn: entity.inn,
				kpp: entity.kpp,
				region: entity.region,
				status: entity.status,
				isBranch: entity.isBranch,
				educationLevel: guessEducationLevel(entity.legalName, entity.okved),
				looksEducational: guessKind(entity.legalName, entity.okved) === 'educational_institution',
				existing: match ?? null,
				unavailable
			};
		})
	);
}

/**
 * Организация справочника из выбранной строки реестра.
 *
 * Вид называет вызывающий: поле формы взаимодействия, в котором строку
 * выбрали, или сотрудник на странице новой организации. Повторный выбор той
 * же строки — двойной щелчок, соседняя вкладка — не заводит вторую:
 * организация с этим ИНН уже есть, и отдаётся она (`created: false`).
 */
export async function createFromRegistry(
	ctx: ActorContext,
	token: string,
	kind: OrganizationFormKind
): Promise<LookupOption & { created: boolean }> {
	requirePermission(ctx, 'organizations.write');

	const { via, passport } = await readIssuedPassport(ctx, token);
	const entity = passport.entity;
	// Сайт — тот, что паспорт предложил при поиске (`website/`): второй раз
	// источники не спрашиваются, и в карточку попадает то, что сотрудник видел в
	// строке реестра. Адрес ещё раз приводится к origin: номер мог принадлежать
	// паспорту из загруженного снимка, а из-за непригодного сайта заведение
	// отказывать не должно — поле просто останется пустым, и сайт введут вручную.
	const offeredWebsite = passport.fields.website;
	const website = offeredWebsite === undefined ? null : normalizeWebsite(offeredWebsite.value);

	if (entity === null || entity.inn === null) {
		throw new ValidationError('Строка реестра устарела: повторите поиск');
	}

	if (entity.status === 'liquidated') {
		throw new ValidationError(LIQUIDATED);
	}

	const match = (await matchOrganizationsByInn(ctx, [entity.inn])).get(entity.inn);

	if (match === null) {
		throw new ConflictError(TAKEN);
	}

	if (match !== undefined) {
		return { ...match, created: false };
	}

	const parsed = createOrganizationSchema.safeParse({
		kind,
		educationLevel:
			kind === 'educational_institution'
				? guessEducationLevel(entity.legalName, entity.okved)
				: null,
		legalName: entity.legalName.slice(0, 500),
		shortName: entity.shortName.slice(0, 200),
		inn: entity.inn,
		kpp: entity.kpp,
		ogrn: entity.ogrn,
		region: entity.region?.slice(0, 200) ?? null,
		website,
		notes: null,
		isActive: true,
		externalSource: null,
		externalId: null
	});

	// Выписку проверяет та же схема, что и форму карточки: реестр ошибается
	// редко, но записывать в справочник то, чего не пропустила бы форма, нельзя.
	if (!parsed.success) {
		throw new ValidationError(
			'Выписка из реестра не проходит проверку карточки: заведите организацию в справочнике вручную',
			parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`)
		);
	}

	const input = parsed.data;
	const fetchedAt = passport.fields.inn?.fetchedAt ?? new Date().toISOString();
	const sources: [PassportField, FieldSource][] = [
		['legalName', 'dadata'],
		['shortName', 'dadata'],
		['inn', 'dadata'],
		['kpp', 'dadata'],
		['ogrn', 'dadata'],
		['region', 'dadata'],
		['educationLevel', 'guess']
	];
	// Вид в происхождение не попадает: его выбрал сотрудник полем формы, а не
	// источник.
	const provenance: PassportProvenance[] = sources
		.filter(([field]) => input[field] !== null)
		.map(([field, source]) => ({ field, source, fetchedAt, via }));

	// У сайта свои источник и дата: справочник вузов датирует ответ днём
	// выгрузки, а не моментом ответа реестра. Адрес, который пришлось поправить,
	// источнику уже не принадлежит — как и поле, поправленное человеком.
	if (offeredWebsite !== undefined && input.website === offeredWebsite.value) {
		provenance.push({
			field: 'website',
			source: offeredWebsite.source,
			fetchedAt: offeredWebsite.fetchedAt,
			via
		});
	}

	const created = await createOrganization(ctx, input, undefined, provenance);

	// Вуз заведён из поля формы дела, и следующим шагом сотрудник выберет его
	// подразделение и контакт: раздел «Сведения» читается сразу, в фоне, чтобы
	// к открытию «Состава» кандидаты с сайта уже лежали в кэше.
	if (created.kind === 'educational_institution') {
		warmSiteReport(created.website);
	}

	return { id: created.id, label: created.shortName, created: true };
}
