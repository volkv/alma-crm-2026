/**
 * Сторона взаимодействия из реестра: поиск в ЕГРЮЛ из поля формы и заведение
 * выбранной строки организацией справочника.
 *
 * Панель паспорта предлагает поля и ждёт, пока сотрудник их примет и сохранит
 * карточку. Здесь карточки нет: сотрудник заполняет взаимодействие, и нужной
 * организации в справочнике просто не оказалось. Поэтому выбранная строка
 * реестра заводится сразу — с реквизитами из выписки, видом по полю, в котором
 * её выбрали, и догадками об уровне образования и сайте. Происхождение каждого
 * значения пишется в журнал тем же событием, что и приёмка паспорта.
 *
 * Браузер реквизитов не присылает. Каждая строка реестра уходит в него под
 * номером выданного паспорта (`passports.ts`), и заводит организацию сервер из
 * своей копии: подменить ИНН или название браузером нельзя, а второго
 * обращения к поставщику — и второго списания квоты — не нужно.
 */
import {
	REGISTRY_PICK_KINDS,
	type FieldSource,
	type LegalEntity,
	type PassportField,
	type PassportProvenance,
	type RegistryCandidate,
	type RegistryPickRole
} from '$lib/contracts/enrichment';
import { createOrganizationSchema, type LookupOption } from '$lib/contracts/directory';
import type { ActorContext } from '../actor';
import { matchOrganizationsByInn } from '../directory/read';
import { createOrganization } from '../directory/write';
import { ConflictError, ValidationError } from '../errors';
import { requirePermission } from '../rbac';
import { guessEducationLevel, guessKind } from './classify';
import { queryRegistry, registryPassport } from './index';
import { issuePassport, readIssuedPassport } from './passports';
import { siteFromEmails } from './sveden';

const TAKEN =
	'Организация с этим ИНН уже есть в справочнике, но вне вашей области доступа или в архиве';

const LIQUIDATED = 'По ЕГРЮЛ организация ликвидирована';

/**
 * Строки реестра по строке поиска — для выпадающего списка поля.
 *
 * Каждая строка сверяется со справочником по ИНН: организация, которая уже
 * есть и доступна, выбирается как есть, а не заводится второй раз. Строка без
 * ИНН не показывается: сверить её не с чем, а ИНН — то, по чему справочник
 * узнаёт организацию.
 */
export async function searchRegistryCandidates(
	ctx: ActorContext,
	raw: string,
	role: RegistryPickRole
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
								registryPassport(answer.query, [entity], answer.fetchedAt)
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
				educationLevel:
					role === 'educational_institution'
						? guessEducationLevel(entity.legalName, entity.okved)
						: null,
				looksEducational: guessKind(entity.legalName, entity.okved) === 'educational_institution',
				existing: match ?? null,
				unavailable
			};
		})
	);
}

/**
 * Организация справочника из строки реестра, выбранной в поле формы.
 *
 * Повторный выбор той же строки — двойной щелчок, соседняя вкладка — не
 * заводит вторую: организация с этим ИНН уже есть, и выбирается она.
 */
export async function createFromRegistry(
	ctx: ActorContext,
	token: string,
	role: RegistryPickRole
): Promise<LookupOption> {
	requirePermission(ctx, 'organizations.write');

	const { via, passport } = await readIssuedPassport(ctx, token);
	const entity = passport.entity;

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
		return match;
	}

	const kind = REGISTRY_PICK_KINDS[role];
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
		website: siteFromEmails(entity.emails),
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
		['educationLevel', 'guess'],
		['website', 'guess']
	];
	// Вид в происхождение не попадает: его выбрал сотрудник полем формы, а не
	// источник.
	const provenance: PassportProvenance[] = sources
		.filter(([field]) => input[field] !== null)
		.map(([field, source]) => ({ field, source, fetchedAt, via }));

	const created = await createOrganization(ctx, input, undefined, provenance);

	return { id: created.id, label: created.shortName };
}
