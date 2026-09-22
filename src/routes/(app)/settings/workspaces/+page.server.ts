import { error, type ActionFailure } from '@sveltejs/kit';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import {
	assignWorkspaceWorkflowSchema,
	createWorkspaceSchema,
	renameWorkspaceSchema,
	reorderWorkspacesSchema
} from '$lib/contracts/interactions';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import {
	assignWorkspaceWorkflow,
	createWorkspace,
	listWorkflows,
	listWorkspaces,
	renameWorkspace,
	reorderWorkspaces
} from '$lib/server/stages/process';
import type { Actions, PageServerLoad } from './$types';

/**
 * Настройка пространств: направления работы, их порядок в меню и назначенный
 * каждому процесс.
 *
 * Пространство и процесс — разные сущности, и заводятся они порознь:
 * пространство без процесса — законное состояние, секция в меню у него есть, а
 * завести в нём взаимодействие нельзя, потому что стадии, на которую его
 * ставить, не существует. Процесс без пространства — мусор, и заводить его
 * отсюда нельзя: для этого есть раздел «Процесс».
 *
 * Правило смены процесса живёт в команде, а не здесь: адрес действия набирают и
 * руками, и форма, которая «не предлагает невозможного», — удобство, а не
 * защита.
 */

/** Формы страницы; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = {
	create: 'workspace-create',
	rename: 'workspace-rename'
} as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, 'Раздел доступен только с правом «Настройка маршрутов и стадий»');
	}

	// Процессы нужны на этом экране целиком: из них выбирают и при заведении
	// пространства, и при назначении процесса уже заведённому.
	const [workspaces, workflows, createForm, renameForm] = await Promise.all([
		listWorkspaces(ctx),
		listWorkflows(ctx),
		superValidate(zod4(createWorkspaceSchema), { id: FORM_IDS.create }),
		superValidate(zod4(renameWorkspaceSchema), { id: FORM_IDS.rename })
	]);

	return { workspaces, workflows, createForm, renameForm };
};

/**
 * Предметная ошибка формы показывается над её полями целиком: у «ключ занят» и
 * «такого процесса нет» нет поля, к которому их можно отнести однозначно, а
 * угадывать поле по тексту сообщения значит сломаться на первой же правке
 * текста.
 *
 * Отказ по правам из этого правила выведен: он не претензия к заполнению и
 * правкой полей не поправляется — уходит своим кодом, а страница показывает его
 * над карточками.
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
	create: async (event) => {
		const form = await superValidate(event.request, zod4(createWorkspaceSchema), {
			id: FORM_IDS.create
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await createWorkspace(actorFromEvent(event), form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, `Пространство «${form.data.name}» заведено`);
	},

	/**
	 * Переименование меняет название и пояснение — и только их. Ключ стоит в
	 * адресе раздела и в разосланных ссылках, и менять его переименованием
	 * значило бы ломать закладки за спиной у того, кто просто поправил опечатку
	 * в названии.
	 */
	rename: async (event) => {
		const form = await superValidate(event.request, zod4(renameWorkspaceSchema), {
			id: FORM_IDS.rename
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await renameWorkspace(actorFromEvent(event), form.data);
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, `Пространство переименовано в «${form.data.name}»`);
	},

	/**
	 * Назначение процесса. Формы у действия нет — выбор в строке отправляет себя
	 * сам, — поэтому и ответ идёт не через superforms: успех и отказ приходят
	 * одинаковым сообщением, которое страница показывает над карточками.
	 */
	assign: async (event) => {
		const body = await event.request.formData();
		const parsed = assignWorkspaceWorkflowSchema.safeParse({
			key: body.get('key'),
			workflowKey: body.get('workflowKey')
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Не указано, какому пространству назначается процесс',
				issues: []
			});
		}

		try {
			await assignWorkspaceWorkflow(actorFromEvent(event), parsed.data);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			message:
				parsed.data.workflowKey === null
					? 'Процесс снят: заводить взаимодействия в пространстве больше нечем'
					: 'Процесс назначен пространству',
			issues: []
		};
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

		return { message: 'Порядок сохранён: в этом же порядке пространства стоят в меню', issues: [] };
	}
};
