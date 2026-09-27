import { error, redirect, type ActionFailure } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { fail, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { createWorkspaceSchema, reorderWorkspacesSchema } from '$lib/contracts/interactions';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { listWorkspaceModules } from '$lib/server/platform/workspace-modules';
import { can } from '$lib/server/rbac';
import { listWorkspaceMemberships } from '$lib/server/rbac/workspaces';
import {
	createWorkspace,
	listWorkflows,
	listWorkspaces,
	reorderWorkspaces
} from '$lib/server/stages/process';
import type { Actions, PageServerLoad } from './$types';

/**
 * Список пространств: направления работы, их порядок в меню и заведение
 * нового.
 *
 * Пространство и процесс — разные сущности, и заводятся они порознь:
 * пространство без процесса — законное состояние, секция в меню у него есть, а
 * завести в нём взаимодействие нельзя, потому что стадии, на которую его
 * ставить, не существует. Процесс без пространства — мусор, и заводить его
 * отсюда нельзя: для этого есть раздел «Процессы».
 *
 * Всё, что настраивается у одного пространства, — название, процесс, модули и
 * сотрудники — живёт на его собственной странице (`./[key]`). Здесь — только
 * обзор: что за направления, по какому процессу, сколько в них людей и какие
 * модули действуют.
 */

/** Формы страницы; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = { create: 'workspace-create' } as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, 'Раздел доступен только с правом «Настройка маршрутов и стадий»');
	}

	// Процессы нужны ради формы заведения: процесс можно назначить сразу.
	// Состав пространств читается только с правом на выдачу доступа — без него
	// колонки «Сотрудников» просто нет.
	const [workspaces, workflows, modules, memberships, createForm] = await Promise.all([
		listWorkspaces(ctx),
		listWorkflows(ctx),
		listWorkspaceModules(ctx),
		can(ctx, 'users.manage') ? listWorkspaceMemberships(ctx) : null,
		superValidate(zod4(createWorkspaceSchema), { id: FORM_IDS.create })
	]);

	// В списке из модулей нужно одно: какие действуют. Подробности — описание,
	// «что даёт», требования стадий — на странице пространства.
	const activeModules = Object.fromEntries(
		modules.map((workspace) => [
			workspace.workspaceKey,
			workspace.modules.filter((module) => module.active).map((module) => module.label)
		])
	);

	const memberCounts =
		memberships === null
			? null
			: Object.fromEntries(
					memberships.workspaces.map((workspace) => [workspace.key, workspace.members.length])
				);

	return { workspaces, workflows, activeModules, memberCounts, createForm };
};

/**
 * Предметная ошибка формы показывается над её полями целиком: у «ключ занят» и
 * «такого процесса нет» нет поля, к которому их можно отнести однозначно, а
 * угадывать поле по тексту сообщения значит сломаться на первой же правке
 * текста.
 *
 * Отказ по правам из этого правила выведен: он не претензия к заполнению и
 * правкой полей не поправляется — уходит своим кодом, а страница показывает его
 * над карточкой.
 */
function asFormError<Out extends Record<string, unknown>, M, In extends Record<string, unknown>>(
	form: SuperValidated<Out, M, In>,
	failure: unknown
): ActionFailure<{ form: SuperValidated<Out, M, In> } | ActionErrorPayload> {
	if (failure instanceof ForbiddenError) {
		return toActionFailure(failure);
	}

	if (failure instanceof AppError) {
		return setError(form, '', [failure.message, ...errorIssues(failure)]);
	}

	throw failure;
}

export const actions: Actions = {
	/**
	 * Заведение заканчивается переходом на страницу нового пространства: следом
	 * за ним почти всегда идут процесс, модули и сотрудники, и настраивают их
	 * там.
	 */
	create: async (event) => {
		const form = await superValidate(event.request, zod4(createWorkspaceSchema), {
			id: FORM_IDS.create
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		let created;

		try {
			created = await createWorkspace(actorFromEvent(event), form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		redirect(
			303,
			`${resolve('/(app)/settings/workspaces/[key]', { key: created.key })}?done=created`
		);
	},

	/**
	 * Порядок пространств. Приходит списком всех ключей целиком, а не парой
	 * «кого и куда»: позиции уникальны, и перестановка идёт одной транзакцией со
	 * сдвигом соседей — команде нужен весь ряд, чтобы разложить его заново.
	 */
	reorder: async (event) => {
		const parsed = reorderWorkspacesSchema.safeParse({
			keys: (await event.request.formData()).getAll('keys')
		});

		if (!parsed.success) {
			return fail(400, { message: 'Порядок задаётся списком ключей пространств', issues: [] });
		}

		try {
			await reorderWorkspaces(actorFromEvent(event), parsed.data);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			ok: true,
			message: 'Порядок сохранён: в этом же порядке пространства стоят в меню',
			issues: []
		};
	}
};
