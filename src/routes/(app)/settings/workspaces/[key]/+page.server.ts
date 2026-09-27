import { error, type ActionFailure } from '@sveltejs/kit';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import {
	addWorkspaceMemberSchema,
	assignWorkspaceWorkflowSchema,
	removeWorkspaceMemberSchema,
	renameWorkspaceSchema
} from '$lib/contracts/interactions';
import { setWorkspaceModuleSchema } from '$lib/contracts/modules';
import { moduleByKey } from '$lib/platform/registry';
import { actorFromEvent } from '$lib/server/actor';
import { AppError, ForbiddenError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { listWorkspaceModules, setWorkspaceModule } from '$lib/server/platform/workspace-modules';
import { can } from '$lib/server/rbac';
import {
	addWorkspaceMember,
	listWorkspaceMemberships,
	removeWorkspaceMember
} from '$lib/server/rbac/workspaces';
import {
	assignWorkspaceWorkflow,
	listWorkflows,
	listWorkspaces,
	renameWorkspace
} from '$lib/server/stages/process';
import type { Actions, PageServerLoad } from './$types';

/**
 * Страница одного пространства: название, процесс, модули и сотрудники.
 *
 * Пространство здесь называет адрес, а не поле формы: каждое действие берёт
 * ключ из `params.key`. Иначе страница одного пространства могла бы, получив
 * подложенный ключ, поменять соседнее — права у действий те же, но менять
 * должно то, что открыто.
 *
 * Правило смены процесса живёт в команде, а не здесь: адрес действия набирают и
 * руками, и форма, которая «не предлагает невозможного», — удобство, а не
 * защита. То же с модулями: требуемый стадией модуль не выключит сервис, а
 * переключатель лишь показывает его заблокированным.
 *
 * Состав пространства — это выдача доступа, поэтому у него своё право —
 * `users.manage`; без него блок сотрудников не показывается, а команды
 * откажут и так.
 */

/** Форма переименования; идентификатор связывает форму на сервере с формой в браузере. */
const RENAME_FORM_ID = 'workspace-rename';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, 'Раздел доступен только с правом «Настройка маршрутов и стадий»');
	}

	// Читается весь ряд, а не одно пространство: счётчики стадий и
	// взаимодействий, по которым решается, можно ли сменить процесс, считает
	// только список.
	const [workspaces, workflows, modules, memberships] = await Promise.all([
		listWorkspaces(ctx),
		listWorkflows(ctx),
		listWorkspaceModules(ctx),
		can(ctx, 'users.manage') ? listWorkspaceMemberships(ctx) : null
	]);

	const workspace = workspaces.find((candidate) => candidate.key === event.params.key);

	if (workspace === undefined) {
		error(404, 'Пространство не найдено');
	}

	const renameForm = await superValidate(
		{ key: workspace.key, name: workspace.name, description: workspace.description },
		zod4(renameWorkspaceSchema),
		{ id: RENAME_FORM_ID, errors: false }
	);

	return {
		workspace,
		workflows,
		modules: modules.find((candidate) => candidate.workspaceKey === workspace.key)?.modules ?? [],
		members:
			memberships === null
				? null
				: {
						list:
							memberships.workspaces.find((candidate) => candidate.key === workspace.key)
								?.members ?? [],
						candidates: memberships.candidates
					},
		renameForm,
		// Заголовок и крошки принадлежат макету настроек, а какое пространство
		// открыто, знает только эта страница.
		settingsTitle: workspace.name,
		settingsDescription:
			workspace.description ?? 'Название, процесс, модули и сотрудники пространства'
	};
};

/**
 * Предметная ошибка формы показывается над её полями целиком: у неё нет поля,
 * к которому её можно отнести однозначно. Отказ по правам из этого правила
 * выведен: он не поправляется правкой полей и уходит своим кодом.
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

/** Отказ разбора полей одной строкой: у действий без формы нет поля, куда его поставить. */
function issuesText(issues: readonly { message: string }[]): string {
	return issues.map((issue) => issue.message).join('. ');
}

export const actions: Actions = {
	/**
	 * Переименование меняет название и пояснение — и только их. Ключ стоит в
	 * адресе раздела и в разосланных ссылках, и менять его переименованием
	 * значило бы ломать закладки за спиной у того, кто просто поправил опечатку
	 * в названии.
	 */
	rename: async (event) => {
		const body = await event.request.formData();

		body.set('key', event.params.key);

		const form = await superValidate(body, zod4(renameWorkspaceSchema), { id: RENAME_FORM_ID });

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
	 * Назначение процесса. Формы у действия нет — выбор отправляет себя сам, —
	 * поэтому и ответ идёт не через superforms: успех и отказ приходят
	 * одинаковым сообщением, которое страница показывает над карточками.
	 */
	assign: async (event) => {
		const body = await event.request.formData();
		const parsed = assignWorkspaceWorkflowSchema.safeParse({
			key: event.params.key,
			workflowKey: body.get('workflowKey')
		});

		if (!parsed.success) {
			return fail(400, { message: issuesText(parsed.error.issues), issues: [] });
		}

		try {
			await assignWorkspaceWorkflow(actorFromEvent(event), parsed.data);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			ok: true,
			message:
				parsed.data.workflowKey === null
					? 'Процесс снят: заводить взаимодействия в пространстве больше нечем'
					: 'Процесс назначен пространству',
			issues: []
		};
	},

	/**
	 * Включение и выключение модуля. Формы у действия нет — переключатель в
	 * строке модуля отправляет себя сам, — поэтому ответ тот же, что у
	 * назначения процесса. Выключение не стирает данных: панели модуля перестают
	 * показываться, а записанное в них возвращается вместе с модулем.
	 */
	module: async (event) => {
		const body = await event.request.formData();
		const parsed = setWorkspaceModuleSchema.safeParse({
			workspaceKey: event.params.key,
			moduleKey: body.get('moduleKey'),
			enabled: body.get('enabled')
		});

		if (!parsed.success) {
			return fail(400, { message: issuesText(parsed.error.issues), issues: [] });
		}

		const { moduleKey, enabled } = parsed.data;

		try {
			const { changed } = await setWorkspaceModule(actorFromEvent(event), parsed.data);
			const label = `Модуль «${moduleByKey(moduleKey)?.label ?? moduleKey}»`;

			// Повтор ничего не меняет и в журнал не пишется, но и отказом не
			// считается: второй щелчок по уже сделанному — не ошибка человека.
			if (!changed) {
				return {
					ok: true,
					message: `${label} уже ${enabled ? 'подключён' : 'отключён'}: ничего не изменилось`,
					issues: []
				};
			}

			return {
				ok: true,
				message: enabled
					? `${label} подключён: его панели и действия появятся в карточках пространства`
					: `${label} отключён: его панели и действия скрыты в карточках пространства. Записанные данные сохранены и вернутся, если модуль подключить снова`,
				issues: []
			};
		} catch (failure) {
			return toActionFailure(failure);
		}
	},

	/**
	 * Включить сотрудника в пространство: он увидит работу направления со
	 * следующего запроса. Страница предлагает включить заодно и его
	 * руководителя — тот видит работу подчинённого только в пространствах, куда
	 * включён сам. Руководитель включается отдельной командой следом: у него
	 * свои проверки, и отказ по нему не отменяет уже сделанного.
	 */
	addMember: async (event) => {
		const body = await event.request.formData();
		const parsed = addWorkspaceMemberSchema.safeParse({
			key: event.params.key,
			userId: body.get('userId')
		});
		const managerId = body.get('managerUserId');
		const manager =
			typeof managerId === 'string' && managerId !== ''
				? addWorkspaceMemberSchema.safeParse({ key: event.params.key, userId: managerId })
				: null;

		if (!parsed.success) {
			return fail(400, { message: issuesText(parsed.error.issues), issues: [] });
		}

		if (manager !== null && !manager.success) {
			return fail(400, { message: issuesText(manager.error.issues), issues: [] });
		}

		const ctx = actorFromEvent(event);

		try {
			await addWorkspaceMember(ctx, parsed.data);
		} catch (failure) {
			return toActionFailure(failure);
		}

		if (manager === null) {
			return { ok: true, message: 'Сотрудник включён в пространство', issues: [] };
		}

		try {
			await addWorkspaceMember(ctx, manager.data);
		} catch (failure) {
			const refusal = toActionFailure(failure);

			return fail(refusal.status, {
				message: `Сотрудник включён, а руководитель — нет: ${refusal.data.message}`,
				issues: refusal.data.issues
			});
		}

		return {
			ok: true,
			message: 'Сотрудник и его руководитель включены в пространство',
			issues: []
		};
	},

	/**
	 * Исключить сотрудника. Подтверждение приходит полем формы: страница
	 * спрашивает его, когда за сотрудником числятся незавершённые записи, а
	 * команда без него откажет и назовёт их число — адрес действия набирают и
	 * руками.
	 */
	removeMember: async (event) => {
		const body = await event.request.formData();
		const parsed = removeWorkspaceMemberSchema.safeParse({
			key: event.params.key,
			userId: body.get('userId'),
			confirmOwned: body.get('confirmOwned') === 'true'
		});

		if (!parsed.success) {
			return fail(400, { message: issuesText(parsed.error.issues), issues: [] });
		}

		try {
			const { ownedActive } = await removeWorkspaceMember(actorFromEvent(event), parsed.data);

			return {
				ok: true,
				message:
					ownedActive === 0
						? 'Сотрудник исключён из пространства'
						: `Сотрудник исключён из пространства. Незавершённых взаимодействий за ним осталось: ${ownedActive} — передайте их другому ответственному`,
				issues: []
			};
		} catch (failure) {
			return toActionFailure(failure);
		}
	}
};
