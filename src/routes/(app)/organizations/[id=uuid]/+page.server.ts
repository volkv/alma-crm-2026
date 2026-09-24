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
	countOrganizationInteractions,
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
import { formatIsoDay } from '$lib/format';
import { toActionFailure, toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getSetting } from '$lib/server/settings';
import type { Actions, PageServerLoad } from './$types';

/** Каталог продуктов для позиции договора: активные, одной страницей. */
const productPage = catalogListQuerySchema.parse({ status: 'active', pageSize: 100 });

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

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
			interactionCount,
			responsibles,
			assignableUsers,
			directionOptions,
			contracts,
			products,
			licenseWarningDays
		] = await Promise.all([
			listSites(ctx, organization.id),
			can(ctx, 'people.read') ? listAffiliations(ctx, organization.id) : Promise.resolve([]),
			countOrganizationInteractions(ctx, organization.id),
			listResponsibles(ctx, organization.id),
			canAssign ? listAssignableUsers(ctx) : Promise.resolve([]),
			canAssign ? listDirectionOptions(ctx) : Promise.resolve([]),
			listOrganizationContracts(ctx, organization.id),
			canWrite ? listProducts(ctx, productPage) : Promise.resolve({ items: [] }),
			getSetting('license_warning_days')
		]);

		return {
			organization,
			sites,
			affiliations,
			interactionCount,
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
			canWritePeople: can(ctx, 'people.write')
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
			status: field(data, 'status')
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
			transferStatus: field(data, 'transferStatus')
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
