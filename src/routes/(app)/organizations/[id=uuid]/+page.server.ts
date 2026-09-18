import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { endAffiliationSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import {
	countOrganizationInteractions,
	getOrganization,
	listAffiliations,
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
import { formatIsoDay } from '$lib/format';
import { toActionFailure, toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const organization = await getOrganization(ctx, event.params.id);

		// Назначать ответственных может не всякий, кто открыл карточку: списки
		// сотрудников и направлений собираются только тем, кто их увидит в форме.
		const canAssign = can(ctx, 'responsibles.manage');

		// Контакты — отдельное право: организацию видно и без права на людей.
		const [sites, affiliations, interactionCount, responsibles, assignableUsers, directionOptions] =
			await Promise.all([
				listSites(ctx, organization.id),
				can(ctx, 'people.read') ? listAffiliations(ctx, organization.id) : Promise.resolve([]),
				countOrganizationInteractions(ctx, organization.id),
				listResponsibles(ctx, organization.id),
				canAssign ? listAssignableUsers(ctx) : Promise.resolve([]),
				canAssign ? listDirectionOptions(ctx) : Promise.resolve([])
			]);

		return {
			organization,
			sites,
			affiliations,
			interactionCount,
			responsibles,
			assignableUsers,
			directionOptions,
			canAssign,
			// Передача незавершённых записей — та же смена владельца, что и с
			// карточки взаимодействия: без этого права флажок не показывается, а
			// сервер отказывает, даже если поле дослали руками.
			canTransfer: can(ctx, 'interactions.reassign'),
			// Полномочия закрывают сегодняшним днём по Москве — по нему живёт процесс.
			today: formatIsoDay(),
			canReadPeople: can(ctx, 'people.read'),
			canWrite: can(ctx, 'organizations.write'),
			canWritePeople: can(ctx, 'people.write')
		};
	} catch (error) {
		toPageError(error);
	}
};

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
