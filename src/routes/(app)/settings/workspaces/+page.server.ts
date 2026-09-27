import { error, type ActionFailure } from '@sveltejs/kit';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import {
	addWorkspaceMemberSchema,
	assignWorkspaceWorkflowSchema,
	createWorkspaceSchema,
	removeWorkspaceMemberSchema,
	renameWorkspaceSchema,
	reorderWorkspacesSchema
} from '$lib/contracts/interactions';
import { setWorkspaceModuleSchema } from '$lib/contracts/modules';
import { moduleByKey } from '$lib/platform/registry';
import { actorFromEvent } from '$lib/server/actor';
import { getDb } from '$lib/server/db';
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
	createWorkspace,
	listWorkflows,
	listWorkspaces,
	readWorkspaceByKey,
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
 *
 * Здесь же состав пространств: кто в каком направлении работает. Это выдача
 * доступа, поэтому у неё своё право — `users.manage`; без него блок состава не
 * показывается, а команды откажут и так.
 *
 * И модули пространств: что из установленного подключено к каждому
 * направлению. Модуль, который нужен стадии процесса, действует и без
 * включения, и выключить его нельзя. Правило живёт в сервисе модулей, а
 * переключатель в форме лишь показывает его заблокированным.
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
	const [workspaces, workflows, modules, memberships, createForm, renameForm] = await Promise.all([
		listWorkspaces(ctx),
		listWorkflows(ctx),
		listWorkspaceModules(ctx),
		can(ctx, 'users.manage') ? listWorkspaceMemberships(ctx) : null,
		superValidate(zod4(createWorkspaceSchema), { id: FORM_IDS.create }),
		superValidate(zod4(renameWorkspaceSchema), { id: FORM_IDS.rename })
	]);

	return { workspaces, workflows, modules, memberships, createForm, renameForm };
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
			ok: true,
			message:
				parsed.data.workflowKey === null
					? 'Процесс снят: заводить взаимодействия в пространстве больше нечем'
					: 'Процесс назначен пространству',
			issues: []
		};
	},

	/**
	 * Включение и выключение модуля пространства. Формы у действия нет —
	 * переключатель в строке модуля отправляет себя сам, — поэтому ответ тот же,
	 * что у назначения процесса. Выключение не стирает данных: панели модуля
	 * перестают показываться, а записанное в них возвращается вместе с модулем.
	 */
	module: async (event) => {
		const body = await event.request.formData();
		const parsed = setWorkspaceModuleSchema.safeParse({
			workspaceKey: body.get('workspaceKey'),
			moduleKey: body.get('moduleKey'),
			enabled: body.get('enabled')
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues.map((issue) => issue.message).join('. '),
				issues: []
			});
		}

		const { workspaceKey, moduleKey, enabled } = parsed.data;

		try {
			const { changed } = await setWorkspaceModule(actorFromEvent(event), parsed.data);
			const workspace = await readWorkspaceByKey(getDb(), workspaceKey);
			const label = `Модуль «${moduleByKey(moduleKey)?.label ?? moduleKey}»`;
			const where = `пространства «${workspace.name}»`;

			// Повтор ничего не меняет и в журнал не пишется, но и отказом не
			// считается: второй щелчок по уже сделанному — не ошибка человека.
			if (!changed) {
				return {
					ok: true,
					message: `${label} уже ${enabled ? 'подключён' : 'отключён'}: у ${where} ничего не изменилось`,
					issues: []
				};
			}

			return {
				ok: true,
				message: enabled
					? `${label} подключён: его панели и действия появятся в карточках ${where}`
					: `${label} отключён: его панели и действия скрыты в карточках ${where}. Записанные данные сохранены и вернутся, если модуль подключить снова`,
				issues: []
			};
		} catch (failure) {
			return toActionFailure(failure);
		}
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
	},

	/** Включить сотрудника в пространство: он увидит работу направления со следующего запроса. */
	addMember: async (event) => {
		const body = await event.request.formData();
		const parsed = addWorkspaceMemberSchema.safeParse({
			key: body.get('key'),
			userId: body.get('userId')
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues.map((issue) => issue.message).join('. '),
				issues: []
			});
		}

		try {
			await addWorkspaceMember(actorFromEvent(event), parsed.data);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Сотрудник включён в пространство', issues: [] };
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
			key: body.get('key'),
			userId: body.get('userId'),
			confirmOwned: body.get('confirmOwned') === 'true'
		});

		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues.map((issue) => issue.message).join('. '),
				issues: []
			});
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
