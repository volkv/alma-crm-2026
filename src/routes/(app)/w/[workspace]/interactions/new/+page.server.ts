import { error, redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { id } from '$lib/contracts/common';
import {
	catalogListQuerySchema,
	type LookupOption,
	type OrganizationKind
} from '$lib/contracts/directory';
import { createInteractionSchema } from '$lib/contracts/interactions';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import {
	getOrganization,
	listProducts,
	listPrograms,
	pickOrganization
} from '$lib/server/directory/read';
import { passportAvailability } from '$lib/server/enrichment/access';
import { toActionFailure, toPageError } from '$lib/server/http';
import { readWorkspaceCounterpartyKinds } from '$lib/server/interactions/composition';
import { createInteraction } from '$lib/server/interactions/write';
import { can, requirePermission } from '$lib/server/rbac';
import { responsibleOptions } from '../responsible';
import type { Actions, PageServerLoad } from './$types';

const catalogPage = catalogListQuerySchema.parse({ status: 'active', pageSize: 100 });

const organizationParam = id('Идентификатор организации в ссылке некорректен');

/**
 * Можно ли из полей сторон искать в ЕГРЮЛ и заводить найденное. Нужны право
 * заводить организации, включённые внешние источники и ключ Dadata; нет
 * чего-то одного — поля ищут только по справочнику, как раньше.
 */
async function registryAvailable(ctx: ActorContext): Promise<boolean> {
	if (!can(ctx, 'organizations.write')) {
		return false;
	}

	const availability = await passportAvailability(ctx);

	return availability.enabled && availability.registryConfigured;
}

/**
 * Вуз из ссылки `?organization=<id>` — с карточки организации форма приходит
 * уже с основной стороной. Подставляется только то, что человек нашёл бы и
 * поиском в форме: действующая организация в его области доступа. Иначе
 * форма открывается пустой и говорит, почему.
 */
async function presetInstitution(
	ctx: ActorContext,
	raw: string | null
): Promise<{
	option: LookupOption | null;
	kind: OrganizationKind | null;
	refused: string | null;
}> {
	if (raw === null) {
		return { option: null, kind: null, refused: null };
	}

	const parsed = organizationParam.safeParse(raw);

	if (!parsed.success) {
		return { option: null, kind: null, refused: parsed.error.issues[0].message };
	}

	const option = await pickOrganization(ctx, parsed.data);

	if (option === null) {
		return {
			option: null,
			kind: null,
			refused: 'Организация из ссылки не найдена, в архиве или вне вашей области доступа'
		};
	}

	// Вид подставленной организации выбирает и вид формы: компания с её
	// карточки открывает форму для компании, а не для вуза.
	const organization = await getOrganization(ctx, option.id);

	return { option, kind: organization.kind, refused: null };
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	// Форма заведения открывается только с правом на запись: без него страница
	// показала бы заполняемые поля и отказала бы в самом конце — как и у
	// остальных «new», отказ здесь, а не после работы.
	try {
		requirePermission(ctx, 'interactions.write');
	} catch (cause) {
		toPageError(cause);
	}

	const { workspace } = await event.parent();

	// Пространству без процесса завести запись нечем: стадии, на которую её
	// ставить, не существует. Отказ здесь, а не после заполнения формы, и
	// словами, а не пустым списком: доска такого пространства кнопку «Завести»
	// не показывает вовсе, но адрес набирают и руками.
	if (!workspace.hasWorkflow) {
		error(
			409,
			`Пространству «${workspace.name}» не назначен процесс: выберите его в настройках пространств, иначе взаимодействию не с чего начать`
		);
	}

	const [programs, products, users, form, preset, registry, counterpartyKinds] = await Promise.all([
		listPrograms(ctx, catalogPage),
		listProducts(ctx, catalogPage),
		responsibleOptions(event),
		superValidate(zod4(createInteractionSchema)),
		presetInstitution(ctx, event.url.searchParams.get('organization')),
		registryAvailable(ctx),
		readWorkspaceCounterpartyKinds(workspace.id)
	]);

	// Ответственный по умолчанию подставляется сразу: в девяти случаях из десяти
	// это и есть правильный ответ, а менять его можно тут же.
	form.data.ownerUserId = event.locals.user?.id ?? '';

	return {
		form,
		programs: programs.items,
		products: products.items,
		users,
		presetInstitution: preset.option,
		presetKind: preset.kind,
		presetRefused: preset.refused,
		registryAvailable: registry,
		counterpartyKinds,
		// Завести контрагента из поля формы можно тому, кто заводит организации;
		// физическое лицо — ещё и человека.
		canCreate: {
			organization: can(ctx, 'organizations.write'),
			individual: can(ctx, 'organizations.write') && can(ctx, 'people.write')
		}
	};
};

export const actions: Actions = {
	default: async (event) => {
		// Стороны и программы приезжают вложенными списками, поэтому форма
		// отправляется одним JSON, а не парами «поле — значение».
		const form = await superValidate(event.request, zod4(createInteractionSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		let createdId: string;

		try {
			const created = await createInteraction(
				actorFromEvent(event),
				event.params.workspace,
				form.data
			);
			createdId = created.id;
		} catch (error) {
			// Соответствие предметной ошибки и кода ответа живёт в одном месте;
			// здесь оно только переносится в сообщение формы, чтобы человек остался
			// на заполненной странице, а не получил голый отказ.
			const failure = toActionFailure(error);

			return message(form, failure.data.message, {
				status: failure.status as 400 | 403 | 404 | 409
			});
		}

		// Прямо в карточку её пространства, а не через прежний адрес: место
		// известно — это то, в котором стоит форма.
		redirect(303, `/w/${encodeURIComponent(event.params.workspace)}/interactions/${createdId}`);
	}
};
