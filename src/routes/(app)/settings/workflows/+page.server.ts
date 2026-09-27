import { error, redirect, type ActionFailure } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { fail, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { createWorkflowSchema } from '$lib/contracts/interactions';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { PERMISSIONS } from '$lib/server/rbac/permissions';
import { createWorkflow, listWorkflows } from '$lib/server/stages/process';
import type { Actions, PageServerLoad } from './$types';

/**
 * Процессы: список описаний работы и заведение нового.
 *
 * Раздел открывается по ключу процесса, а не пространства: одно описание может
 * обслуживать несколько направлений, и у него своя жизнь — своя действующая
 * редакция и свой черновик. Где процесс применяется, решает раздел
 * «Пространства»; здесь видно только, скольким он назначен.
 *
 * Версий процесса на экране нет: в каждом пространстве действует ровно один
 * процесс, и номер его редакции не участвует ни в одном решении. Строка
 * отвечает на три вопроса — сколько стадий в действующей редакции, скольким
 * пространствам процесс назначен и сколько незавершённых взаимодействий он
 * сейчас ведёт во всех них разом: по последнему числу видно, что изменение
 * затронет.
 */

/** Формы страницы; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = { create: 'workflow-create' } as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, `Раздел доступен только с правом «${PERMISSIONS['stages.configure']}»`);
	}

	const [workflows, createForm] = await Promise.all([
		listWorkflows(ctx),
		superValidate(zod4(createWorkflowSchema), { id: FORM_IDS.create })
	]);

	return { workflows, createForm };
};

/**
 * Предметная ошибка формы показывается над её полями целиком: у «ключ занят»
 * нет поля, к которому её можно отнести однозначно, а угадывать поле по тексту
 * сообщения значит сломаться на первой же правке текста.
 *
 * Отказ по правам из этого правила выведен: он не претензия к заполнению и
 * правкой полей не поправляется — уходит своим кодом.
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
	 * Новый процесс заводится пустым или копией другого. Пустой описывают
	 * черновиком в редакторе, а не этой формой — описание работы это полтора
	 * десятка строк с нормативами и переходами, и просить их разом у того, кто
	 * только придумал название, значило бы отложить заведение до конца работы.
	 *
	 * Заведение заканчивается переходом в редактор нового процесса — так же,
	 * как заведение пространства открывает его страницу: следующий шаг почти
	 * всегда там.
	 */
	create: async (event) => {
		const form = await superValidate(event.request, zod4(createWorkflowSchema), {
			id: FORM_IDS.create
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		let created;

		try {
			created = await createWorkflow(actorFromEvent(event), form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		redirect(
			303,
			`${resolve('/(app)/settings/workflows/[key]', { key: created.key })}?done=${
				form.data.copyFromKey === null ? 'created' : 'copied'
			}`
		);
	}
};
