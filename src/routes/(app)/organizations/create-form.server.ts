import { fail as failAction, redirect, type RequestEvent } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import { createOrganizationSchema } from '$lib/contracts/directory';
import { registryCreateSchema, registryLookupSchema } from '$lib/contracts/enrichment';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { passportAvailability } from '$lib/server/enrichment/access';
import { resolveAcceptance } from '$lib/server/enrichment/passports';
import { createFromRegistry, searchRegistryCandidates } from '$lib/server/enrichment/pick';
import { findOrganizationByInn, findPossibleDuplicates } from '$lib/server/directory/read';
import { createOrganization } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { asPassportFailure, passportActions, readAcceptance } from './passport/actions.server';
import { MANUAL_PARAM, NAME_PARAM } from './create-params';

/**
 * Окно «Новая организация» живёт на странице списка: отдельной страницы у
 * формы нет. Здесь — то, что окну нужно от сервера, и команды создания.
 *
 * Новая организация начинается с поиска по ЕГРЮЛ: одна строка, выбор из
 * списка — и карточка заведена с реквизитами из выписки. Полная форма —
 * запасной путь: организации нет в реестре (школа без своего юрлица,
 * иностранная компания), источники выключены или ключ Dadata не задан. На неё
 * ведёт «Добавить вручную», и набранная строка переезжает в неё: ИНН — в поле
 * ИНН, остальное — в наименования.
 */

/** Идентификатор формы: у страницы списка есть и другие действия. */
const FORM_ID = 'create-organization';

/**
 * Данные окна создания. `null` — заводить организации нельзя: кнопки на
 * списке тогда нет.
 */
export async function loadCreateForm(event: RequestEvent, ctx: ActorContext) {
	if (!can(ctx, 'organizations.write')) {
		return null;
	}

	const [passport, form] = await Promise.all([
		passportAvailability(ctx),
		// Самый частый случай — вуз, поэтому форма открывается уже настроенной на
		// него. Строка из адреса подставляется в окне: закрытое окно забывает её
		// вместе с набранным, а начальное состояние формы остаётся чистым.
		superValidate(
			{ kind: 'educational_institution' as const, educationLevel: 'vo' as const },
			zod4(createOrganizationSchema),
			{ errors: false, id: FORM_ID }
		)
	]);
	const registry = passport.enabled && passport.registryConfigured;

	return {
		form,
		registry,
		passport,
		/** Ручная форма при открытии: реестр недоступен или так попросила ссылка. */
		startManual: !registry || event.url.searchParams.has(MANUAL_PARAM),
		typed: event.url.searchParams.get(NAME_PARAM)?.trim().slice(0, 200) ?? '',
		openOnLoad: wantsCreate(event.url),
		// Вендора заводит только полный доступ (`createOrganization` откажет и так).
		allowVendor: ctx.scope.kind === 'all'
	};
}

/** Строки реестра по мере набора — сверенные со справочником по ИНН. */
async function registrySearch(event: RequestEvent) {
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
}

/**
 * Заведение выбранной строки реестра и переход в карточку. Уже заведённая
 * (двойной щелчок, соседняя вкладка) не дублируется: переход в неё же.
 */
async function registryCreate(event: RequestEvent) {
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
		created = await createFromRegistry(actorFromEvent(event), parsed.data.token, parsed.data.kind);
	} catch (error) {
		return asPassportFailure(error);
	}

	const card = resolve('/(app)/organizations/[id=uuid]', { id: created.id });

	redirect(303, created.created ? `${card}?done=registry_created` : card);
}

/**
 * Сохранение ручной формы. Вместе с реквизитами форма присылает отметки полей,
 * принятых из паспорта: их происхождение сверяется с выданным паспортом и
 * ложится в журнал той же транзакцией, что и сами поля.
 */
async function create(event: RequestEvent) {
	const formData = await event.request.formData();
	const form = await superValidate(formData, zod4(createOrganizationSchema), { id: FORM_ID });

	if (!form.valid) {
		return fail(400, { form });
	}

	const ctx = actorFromEvent(event);

	// Похожая организация — вопрос, а не запрет: форма возвращается со ссылками
	// на неё и кнопкой «Создать всё равно», которая присылает подтверждение.
	if (formData.get('confirmDuplicate') !== 'yes') {
		const duplicates = await findPossibleDuplicates(ctx, form.data);

		if (duplicates.length > 0) {
			return message(
				form,
				{
					text: 'Похоже, эта организация уже есть в справочнике',
					duplicates: duplicates.map((duplicate) => ({
						label: duplicate.label,
						href: resolve('/(app)/organizations/[id=uuid]', { id: duplicate.id }),
						reason: duplicate.reason === 'ogrn' ? 'тот же ОГРН' : 'тот же сайт'
					}))
				},
				{ status: 409 }
			);
		}
	}

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

/**
 * Действия окна. Имена `passport*` задаёт панель паспорта (она общая с формой
 * правки), `registry*` — поиск по ЕГРЮЛ, `create` — ручная форма.
 */
export const createActions = {
	...passportActions,
	registrySearch,
	registryCreate,
	create
};
