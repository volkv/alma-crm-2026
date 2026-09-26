import { fail as failAction, redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createOrganizationSchema } from '$lib/contracts/directory';
import {
	lookupQueryKind,
	registryCreateSchema,
	registryLookupSchema
} from '$lib/contracts/enrichment';
import { actorFromEvent } from '$lib/server/actor';
import { passportAvailability } from '$lib/server/enrichment/access';
import { resolveAcceptance } from '$lib/server/enrichment/passports';
import { createFromRegistry, searchRegistryCandidates } from '$lib/server/enrichment/pick';
import { findOrganizationByInn } from '$lib/server/directory/read';
import { createOrganization } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import { asPassportFailure, passportActions, readAcceptance } from '../passport/actions.server';
import type { Actions, PageServerLoad } from './$types';

/**
 * Новая организация начинается с поиска по ЕГРЮЛ: одна строка, выбор из
 * списка — и карточка заведена с реквизитами из выписки. Полная форма — запасной
 * путь: организации нет в реестре (школа без своего юрлица, иностранная
 * компания), источники выключены или ключ Dadata не задан. На неё ведёт ссылка
 * «Добавить вручную» (`?manual`), и набранная строка переезжает в неё: ИНН —
 * в поле ИНН, остальное — в наименования.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'organizations.write');
	} catch (error) {
		toPageError(error);
	}

	const passport = await passportAvailability(ctx);
	const registry = passport.enabled && passport.registryConfigured;
	const manual = !registry || event.url.searchParams.has('manual');
	const typed = event.url.searchParams.get('name')?.trim().slice(0, 200) ?? '';
	const { kind, query } = lookupQueryKind(typed);
	const prefill =
		typed === '' ? {} : kind === 'inn' ? { inn: query } : { legalName: query, shortName: query };

	// Самый частый случай — вуз, поэтому форма открывается уже настроенной на него.
	return {
		mode: manual ? ('manual' as const) : ('registry' as const),
		registry,
		form: await superValidate(
			{ kind: 'educational_institution' as const, educationLevel: 'vo' as const, ...prefill },
			zod4(createOrganizationSchema),
			{ errors: false }
		),
		passport,
		// Вендора заводит только полный доступ (`createOrganization` откажет и так).
		allowVendor: ctx.scope.kind === 'all'
	};
};

export const actions: Actions = {
	...passportActions,

	/** Строки реестра по мере набора — сверенные со справочником по ИНН. */
	registrySearch: async (event) => {
		const parsed = registryLookupSchema.safeParse({
			query: (await event.request.formData()).get('query') ?? ''
		});

		if (!parsed.success) {
			return failAction(400, {
				message: parsed.error.issues[0]?.message ?? 'Строка не прошла проверку',
				issues: []
			});
		}

		try {
			return {
				candidates: await searchRegistryCandidates(actorFromEvent(event), parsed.data.query)
			};
		} catch (error) {
			return asPassportFailure(error);
		}
	},

	/**
	 * Заведение выбранной строки реестра и переход в карточку. Уже заведённая
	 * (двойной щелчок, соседняя вкладка) не дублируется: переход в неё же.
	 */
	registryCreate: async (event) => {
		const formData = await event.request.formData();
		const parsed = registryCreateSchema.safeParse({
			token: formData.get('token'),
			kind: formData.get('kind')
		});

		if (!parsed.success) {
			return failAction(400, {
				message: parsed.error.issues[0]?.message ?? 'Запрос не прошёл проверку',
				issues: []
			});
		}

		let created;

		try {
			created = await createFromRegistry(
				actorFromEvent(event),
				parsed.data.token,
				parsed.data.kind
			);
		} catch (error) {
			return asPassportFailure(error);
		}

		const card = resolve('/(app)/organizations/[id=uuid]', { id: created.id });

		redirect(303, created.created ? `${card}?done=registry_created` : card);
	},

	/**
	 * Сохранение карточки. Вместе с реквизитами форма присылает отметки полей,
	 * принятых из паспорта: их происхождение сверяется с выданным паспортом и
	 * ложится в журнал той же транзакцией, что и сами поля.
	 */
	save: async (event) => {
		const formData = await event.request.formData();
		const form = await superValidate(formData, zod4(createOrganizationSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		const ctx = actorFromEvent(event);
		let created;

		try {
			const provenance = await resolveAcceptance(ctx, readAcceptance(formData), form.data);

			created = await createOrganization(ctx, form.data, undefined, provenance);
		} catch (error) {
			if (error instanceof ConflictError) {
				// Дубль уже найден — покажем, на какой организации споткнулись, вместо
				// того чтобы отправлять человека искать её поиском.
				const existing =
					form.data.inn === null ? null : await findOrganizationByInn(ctx, form.data.inn);

				return message(
					form,
					{
						text: error.message,
						...(existing === null
							? {}
							: {
									conflictsWith: existing,
									conflictHref: resolve('/(app)/organizations/[id=uuid]', { id: existing.id })
								})
					},
					{ status: 409 }
				);
			}

			if (error instanceof ValidationError) {
				return message(form, { text: error.message }, { status: 400 });
			}

			return toActionFailure(error);
		}

		redirect(303, `${resolve('/(app)/organizations/[id=uuid]', { id: created.id })}?done=created`);
	}
};
