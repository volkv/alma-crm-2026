import { redirect, type RequestEvent } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { id } from '$lib/contracts/common';
import type { LookupOption, OrganizationKind } from '$lib/contracts/directory';
import { createInteractionSchema } from '$lib/contracts/interactions';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { getOrganization, pickOrganization } from '$lib/server/directory/read';
import { passportAvailability } from '$lib/server/enrichment/access';
import { toActionFailure } from '$lib/server/http';
import { createInteraction } from '$lib/server/interactions/write';
import { can } from '$lib/server/rbac';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import type { ResponsibleOption } from './responsible';

/**
 * Окно «Создать взаимодействие» живёт на странице списка: отдельной страницы
 * у формы нет. Здесь — то, что окну нужно от сервера, и сама команда
 * создания.
 */

/** Организация, подставляемая в окно основной стороной. */
export const ORGANIZATION_PARAM = 'organization';

/** Идентификатор формы: на странице списка есть и другие действия. */
const FORM_ID = 'create-interaction';

const organizationParam = id('Идентификатор организации в ссылке некорректен');

/**
 * Можно ли из полей сторон искать в ЕГРЮЛ и заводить найденное. Нужны право
 * заводить организации, включённые внешние источники и ключ Dadata; нет
 * чего-то одного — поля ищут только по справочнику.
 */
async function registryAvailable(ctx: ActorContext): Promise<boolean> {
	if (!can(ctx, 'organizations.write')) {
		return false;
	}

	const availability = await passportAvailability(ctx);

	return availability.enabled && availability.registryConfigured;
}

/**
 * Организация из ссылки `?organization=<id>` — с карточки организации окно
 * открывается уже с основной стороной. Подставляется только то, что человек
 * нашёл бы и поиском: действующая организация в его области доступа. Иначе
 * окно открывается пустым и говорит, почему.
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

/**
 * Данные окна создания. `null` — создать нельзя: нет права на запись или у
 * пространства нет процесса (кнопка тогда недоступна и называет причину).
 */
export async function loadCreateForm(
	event: RequestEvent,
	ctx: ActorContext,
	workspace: { hasWorkflow: boolean },
	users: ResponsibleOption[]
) {
	if (!can(ctx, 'interactions.write') || !workspace.hasWorkflow) {
		return null;
	}

	const raw = event.url.searchParams.get(ORGANIZATION_PARAM);

	const [form, preset, registry] = await Promise.all([
		superValidate(zod4(createInteractionSchema), { id: FORM_ID }),
		presetInstitution(ctx, raw),
		registryAvailable(ctx)
	]);

	// Ответственного форма не подставляет: дело часто заводят раньше, чем под
	// него находится исполнитель. Назначить можно тут же или позже с карточки.

	return {
		form,
		users,
		presetInstitution: preset.option,
		presetKind: preset.kind,
		presetRefused: preset.refused,
		/** Открыть окно сразу: пришли по ссылке с карточки организации. */
		openOnLoad: wantsCreate(event.url) || raw !== null,
		registryAvailable: registry,
		// Завести контрагента из поля формы можно тому, кто заводит организации;
		// физическое лицо — ещё и человека.
		canCreate: {
			organization: can(ctx, 'organizations.write'),
			individual: can(ctx, 'organizations.write') && can(ctx, 'people.write')
		}
	};
}

/** Команда создания: после неё — сразу в карточку новой записи. */
export async function createAction(event: RequestEvent<{ workspace: string }>) {
	// Стороны приезжают вложенным списком, поэтому форма отправляется одним
	// JSON, а не парами «поле — значение».
	const form = await superValidate(event.request, zod4(createInteractionSchema), { id: FORM_ID });

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
		// в заполненном окне, а не получил голый отказ.
		const failure = toActionFailure(error);

		return message(form, failure.data.message, {
			status: failure.status as 400 | 403 | 404 | 409
		});
	}

	redirect(303, `/w/${encodeURIComponent(event.params.workspace)}/interactions/${createdId}`);
}
