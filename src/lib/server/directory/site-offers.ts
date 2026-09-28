/**
 * Подразделения вуза «с сайта» в формах карточки дела.
 *
 * Сотрудник выбирает подразделение основной стороны в «Составе» дела, и
 * нужной кафедры часто ещё нет среди площадок организации — а на сайте вуза,
 * в подразделе «Структура», она есть. Здесь — сверка отчёта сайта со
 * справочником (что уже заведено, а что нет) и заведение подразделения с
 * сайта площадкой одним действием.
 *
 * Отчёт берётся только из кэша (`siteReadiness`): наружу эти вызовы не ходят и
 * квоту сотрудника не тратят. Нет отчёта — его прогревают в фоне, а форма
 * говорит «подтягиваем» и спрашивает ещё раз.
 */
import { createHash } from 'node:crypto';
import { createSiteSchema, type LookupOption } from '$lib/contracts/directory';
import { normalizeUnitName, type SiteReport } from '$lib/contracts/enrichment';
import type {
	ImportSiteUnitInput,
	SiteSourceView,
	SiteUnitOffers
} from '$lib/contracts/organization-card';
import type { ActorContext } from '../actor';
import { peekSiteReport } from '../enrichment';
import { siteReadiness } from '../enrichment/warm';
import { NotFoundError, ValidationError } from '../errors';
import { can, requirePermission } from '../rbac';
import { getOrganization, listSites } from './read';
import { createSite } from './write';

/** Внешняя система площадки, заведённой с сайта: так её узнают и в выгрузке. */
export const SVEDEN_SOURCE = 'sveden';

/**
 * Отчёт сайта организации для формы и его состояние словами контракта.
 * `report` — только у прочитанного отчёта.
 */
export async function siteSourceOf(
	website: string | null
): Promise<{ source: SiteSourceView; report: SiteReport | null }> {
	const readiness = await siteReadiness(website);

	if (readiness.state !== 'ready') {
		return { source: { state: readiness.state, fetchedAt: null }, report: null };
	}

	return {
		source: { state: 'ready', fetchedAt: readiness.report.fetchedAt },
		report: readiness.report
	};
}

/**
 * Подразделения с сайта, которых ещё нет среди площадок организации.
 *
 * Сверка — по названию в виде `normalizeUnitName`: площадку могли завести
 * руками с другим регистром или без кавычек. Без права на правку организаций
 * заводить подразделения некому, у организации не вуза раздела нет — блока
 * нет (`null`).
 */
export async function listSiteUnitOffers(
	ctx: ActorContext,
	organizationId: string
): Promise<SiteUnitOffers | null> {
	if (!can(ctx, 'organizations.write')) {
		return null;
	}

	const organization = await getOrganization(ctx, organizationId);

	// Раздел `/sveden` — у образовательной организации; сайт компании ради
	// него не читается.
	if (organization.kind !== 'educational_institution') {
		return null;
	}

	const { source, report } = await siteSourceOf(organization.website);

	if (report === null) {
		return { source, total: 0, units: [] };
	}

	// Сайт прочитан, но «Структуры» на нём нет — это не «всё уже заведено».
	if (!report.struct.found) {
		return { source: { ...source, state: 'unreadable' }, total: 0, units: [] };
	}

	const known = new Set(
		(await listSites(ctx, organizationId)).map((site) => normalizeUnitName(site.name))
	);

	return {
		source,
		total: report.units.length,
		units: report.units.filter((unit) => !known.has(normalizeUnitName(unit.name)))
	};
}

/**
 * Идентификатор площадки во внешней системе «сайт вуза»: организация и
 * отпечаток названия. Одного сайта мало — у головного вуза и филиала он бывает
 * общим, а пара «система + идентификатор» уникальна по всей базе.
 */
function externalIdOf(organizationId: string, name: string): string {
	const hash = createHash('sha256').update(normalizeUnitName(name), 'utf8').digest('hex');

	return `${organizationId}:${hash.slice(0, 24)}`;
}

/**
 * Подразделение с сайта — площадкой организации вида «Подразделение».
 *
 * Как и у кандидата в контакты, данные сервер берёт из своего отчёта сайта, а
 * не из запроса: форма называет только, какое подразделение завести. Уже
 * заведённое (двойной щелчок, соседняя вкладка, площадка, заведённая руками)
 * второй раз не заводится — отдаётся оно (`created: false`). Заводит площадку
 * тот же `createSite`, что форма площадки в карточке организации: право,
 * проверка организации и журнал — его.
 */
export async function importSiteUnit(
	ctx: ActorContext,
	input: ImportSiteUnitInput
): Promise<LookupOption & { created: boolean }> {
	requirePermission(ctx, 'organizations.write');

	const organization = await getOrganization(ctx, input.organizationId);
	const report =
		organization.website === null ? null : await peekSiteReport(ctx, organization.website);
	const wanted = normalizeUnitName(input.name);
	const unit = report?.units.find((row) => normalizeUnitName(row.name) === wanted);

	if (unit === undefined) {
		throw new NotFoundError(
			'Этого подразделения в сведениях с сайта больше нет: откройте форму заново'
		);
	}

	const existing = (await listSites(ctx, organization.id)).find(
		(site) => normalizeUnitName(site.name) === wanted
	);

	if (existing !== undefined) {
		return { id: existing.id, label: existing.name, created: false };
	}

	const parsed = createSiteSchema.safeParse({
		organizationId: organization.id,
		kind: 'department',
		name: unit.name.slice(0, 300),
		address: unit.address?.slice(0, 500) ?? null,
		region: null,
		externalSource: SVEDEN_SOURCE,
		externalId: externalIdOf(organization.id, unit.name)
	});

	// Ячейку сайта набирали руками; то, чего не пропустила бы форма площадки,
	// в справочник не пишется и отсюда.
	if (!parsed.success) {
		throw new ValidationError(
			'Подразделение с сайта не проходит проверку площадки: заведите его вручную',
			parsed.error.issues.map((issue) => issue.message)
		);
	}

	const created = await createSite(ctx, parsed.data);

	return { id: created.id, label: created.name, created: true };
}
