import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import {
	catalogListQuerySchema,
	endAffiliationSchema,
	saveContractItemSchema,
	saveContractSchema
} from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import {
	listOrganizationContracts,
	saveContract,
	saveContractItem
} from '$lib/server/directory/contracts';
import {
	getOrganization,
	listAffiliations,
	listProducts,
	listSites
} from '$lib/server/directory/read';
import {
	assignResponsible,
	listAssignableUsers,
	listDirectionOptions,
	listResponsibles,
	releaseResponsible
} from '$lib/server/directory/responsibles';
import {
	archiveOrganization,
	endAffiliation,
	restoreOrganization
} from '$lib/server/directory/write';
import { startLicenseRenewal } from '$lib/server/directory/license-renewal';
import {
	addSiteContact,
	listOrganizationWork,
	readPassportApplied
} from '$lib/server/directory/organization-card';
import { matchSchoolPrograms } from '$lib/server/directory/program-match';
import { passportAvailability } from '$lib/server/enrichment/access';
import { peekSiteReport, siteWarnings } from '$lib/server/enrichment';
import type { ActorContext } from '$lib/server/actor';
import { addSiteContactSchema } from '$lib/contracts/organization-card';
import { formatIsoDay } from '$lib/format';
import { toActionFailure, toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getSetting } from '$lib/server/settings';
import { passportActions } from '../passport/actions.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Раздел «Сведения», если сайт этой организации уже читали в пределах суток:
 * карточка показывает его сразу, без нажатия и без обращения к сайту.
 */
async function cachedSitePassport(ctx: ActorContext, website: string | null) {
	const site = website === null ? null : await peekSiteReport(ctx, website);

	if (site === null) {
		return null;
	}

	return {
		site,
		warnings: siteWarnings(site),
		programMatch: await matchSchoolPrograms(ctx, site.programs)
	};
}

/** Каталог продуктов для позиции договора: активные, одной страницей. */
const productPage = catalogListQuerySchema.parse({ status: 'active', pageSize: 100 });

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	const { workspaces } = await event.parent();

	try {
		const organization = await getOrganization(ctx, event.params.id);

		// Назначать ответственных может не всякий, кто открыл карточку: списки
		// сотрудников и направлений собираются только тем, кто их увидит в форме.
		const canAssign = can(ctx, 'responsibles.manage');

		// Каталог продуктов нужен только форме позиции договора: без права на
		// запись её никто не увидит, и читать каталог незачем.
		const canWrite = can(ctx, 'organizations.write');

		// Контакты — отдельное право: организацию видно и без права на людей.
		const [
			sites,
			affiliations,
			responsibles,
			assignableUsers,
			directionOptions,
			contracts,
			products,
			licenseWarningDays,
			work,
			passportApplied,
			availability,
			sitePassport
		] = await Promise.all([
			listSites(ctx, organization.id),
			can(ctx, 'people.read') ? listAffiliations(ctx, organization.id) : Promise.resolve([]),
			listResponsibles(ctx, organization.id),
			canAssign ? listAssignableUsers(ctx) : Promise.resolve([]),
			canAssign ? listDirectionOptions(ctx) : Promise.resolve([]),
			listOrganizationContracts(ctx, organization.id),
			canWrite ? listProducts(ctx, productPage) : Promise.resolve({ items: [] }),
			getSetting('license_warning_days'),
			listOrganizationWork(ctx, organization.id, workspaces),
			readPassportApplied(organization.id),
			// Чтение раздела «Сведения» — то же действие, что в форме правки, и
			// право то же: без права на правку кнопки нет, и настройку незачем читать.
			canWrite ? passportAvailability(ctx) : Promise.resolve(null),
			canWrite ? cachedSitePassport(ctx, organization.website) : Promise.resolve(null)
		]);

		return {
			organization,
			sites,
			affiliations,
			responsibles,
			assignableUsers,
			directionOptions,
			contracts,
			productOptions: products.items.map((product) => ({
				id: product.id,
				label: `${product.code} — ${product.name}`
			})),
			canAssign,
			// Передача незавершённых записей — та же смена владельца, что и с
			// карточки взаимодействия: без этого права флажок не показывается, а
			// сервер отказывает, даже если поле дослали руками.
			canTransfer: can(ctx, 'interactions.reassign'),
			// Полномочия закрывают сегодняшним днём по Москве — по нему живёт процесс.
			today: formatIsoDay(),
			canReadPeople: can(ctx, 'people.read'),
			canWrite,
			// Окно продления лицензий — то же, по которому напоминает наблюдатель:
			// письмо зовёт к кнопке, и кнопка обязана быть на экране.
			licenseWarningDays,
			// Продление — это заведение взаимодействия, и право то же.
			canStartRenewal: can(ctx, 'interactions.write'),
			canWritePeople: can(ctx, 'people.write'),
			canStartInteraction: can(ctx, 'interactions.write'),
			work,
			passportApplied,
			// Раздел «Сведения» читается по сайту из карточки: без сайта и без
			// включённых источников кнопки нет, а причина сказана словами.
			siteReading:
				availability === null
					? null
					: { enabled: availability.enabled, remaining: availability.remaining },
			sitePassport
		};
	} catch (error) {
		toPageError(error);
	}
};

/**
 * Значение поля формы или «не заполнено».
 *
 * Пустая строка из формы — это отсутствие значения, а не пустая дата: `''` не
 * проходит проверку календарного дня, и очищенное поле отвечало бы претензией
 * вместо того, чтобы очиститься. Схема отличает отсутствие от значения сама —
 * необязательное поле станет `null`, обязательное скажет, чего не хватает.
 */
function field(data: FormData, key: string): string | undefined {
	const value = data.get(key);

	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Версия записи из скрытого поля формы: число или `null`, если поля нет. Без
 * версии правку существующего договора отвергает схема — отсутствие версии не
 * разрешение перезаписать чужую правку.
 */
function editVersion(data: FormData): number | null {
	const value = field(data, 'editVersion');

	return value === undefined ? null : Number(value);
}

export const actions: Actions = {
	archive: async (event) => {
		try {
			await archiveOrganization(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, `${resolve('/(app)/organizations')}?done=archived`);
	},

	restore: async (event) => {
		try {
			await restoreOrganization(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		// Возврат оставляет человека на карточке: он вернул организацию, чтобы
		// тут же продолжить с ней работать, а не чтобы уйти в список.
		redirect(
			303,
			`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=restored`
		);
	},

	/**
	 * Назначение ответственного. Обе формы — назначение и снятие — оставляют
	 * человека на карточке: он пришёл сюда распределять работу, а не уходить.
	 */
	assignResponsible: async (event) => {
		const form = await event.request.formData();
		const userId = form.get('userId');
		const rawDirection = form.get('directionId');

		if (typeof userId !== 'string' || userId === '') {
			return fail(400, { message: 'Не выбран сотрудник', issues: [] });
		}

		try {
			await assignResponsible(actorFromEvent(event), {
				organizationId: event.params.id,
				userId,
				// Пустое значение — «за вуз целиком», а не незаполненное поле.
				directionId: typeof rawDirection === 'string' && rawDirection !== '' ? rawDirection : null,
				// Снятый флажок браузер не присылает вовсе, поэтому «передавать» —
				// это присутствие поля, а не его значение.
				transferInteractions: form.get('transferInteractions') === 'true'
			});
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=responsible_assigned`
		);
	},

	releaseResponsible: async (event) => {
		const responsibleId = (await event.request.formData()).get('responsibleId');

		if (typeof responsibleId !== 'string' || responsibleId === '') {
			return fail(400, { message: 'Не указано, какое назначение снимать', issues: [] });
		}

		try {
			await releaseResponsible(actorFromEvent(event), responsibleId);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=responsible_released`
		);
	},

	/**
	 * Договор контрагента: заводится и правится одной формой и одним действием.
	 * Форма присылает запись целиком, и «завести» отличается от «исправить»
	 * только тем, есть ли в теле идентификатор.
	 */
	saveContract: async (event) => {
		const data = await event.request.formData();
		const parsed = saveContractSchema.safeParse({
			id: field(data, 'id'),
			organizationId: event.params.id,
			number: field(data, 'number'),
			signedOn: field(data, 'signedOn'),
			validUntil: field(data, 'validUntil'),
			status: field(data, 'status'),
			editVersion: editVersion(data)
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Договор не сохранён',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await saveContract(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=contract_saved`
		);
	},

	saveContractItem: async (event) => {
		const data = await event.request.formData();
		const parsed = saveContractItemSchema.safeParse({
			id: field(data, 'id'),
			contractId: field(data, 'contractId'),
			productId: field(data, 'productId'),
			licenseSignedAt: field(data, 'licenseSignedAt'),
			licenseUntil: field(data, 'licenseUntil'),
			transferStatus: field(data, 'transferStatus'),
			editVersion: editVersion(data)
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Позиция договора не сохранена',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await saveContractItem(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=contract_item_saved`
		);
	},

	/**
	 * Продление лицензии по позиции договора: заводит взаимодействие и ведёт на
	 * его карточку — работа продолжается там.
	 */
	startRenewal: async (event) => {
		const contractItemId = (await event.request.formData()).get('contractItemId');

		if (typeof contractItemId !== 'string' || contractItemId === '') {
			return fail(400, { message: 'Не указана позиция договора', issues: [] });
		}

		let interactionId: string;

		try {
			interactionId = (await startLicenseRenewal(actorFromEvent(event), contractItemId)).id;
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, resolve('/(app)/interactions/[id=uuid]', { id: interactionId }));
	},

	/**
	 * Раздел «Сведения» на сайте из карточки — то самое действие, что стоит в
	 * форме правки (`passportActions.passportSite`): та же квота, тот же кэш на
	 * сутки. Карточка ничего из него не записывает в реквизиты — она показывает
	 * кандидатов в контакты и подбирает программы школы под программы вуза.
	 */
	readSite: async (event) => {
		const result = await passportActions.passportSite(event);

		if (!('issued' in result)) {
			return result;
		}

		const site = result.issued.passport.site;

		try {
			return {
				site,
				warnings: result.issued.passport.warnings,
				programMatch:
					site === null ? null : await matchSchoolPrograms(actorFromEvent(event), site.programs)
			};
		} catch (error) {
			return toActionFailure(error);
		}
	},

	/**
	 * Кандидат из подраздела «Структура» — в контакты одним щелчком. Без
	 * перехода: сотрудник разбирает список кандидатов и добавляет нескольких
	 * подряд, а прочитанный раздел остаётся на экране.
	 */
	addSiteContact: async (event) => {
		const parsed = addSiteContactSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: 'Контакт не добавлен',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			const added = await addSiteContact(actorFromEvent(event), event.params.id, parsed.data);

			return { addedContact: `${added.person.lastName} ${added.person.firstName}` };
		} catch (error) {
			return toActionFailure(error);
		}
	},

	endAffiliation: async (event) => {
		const parsed = endAffiliationSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: 'Полномочия не закрыты',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await endAffiliation(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/organizations/[id=uuid]', { id: event.params.id })}?done=affiliation_ended`
		);
	}
};
