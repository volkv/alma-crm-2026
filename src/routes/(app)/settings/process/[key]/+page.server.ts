import { error, fail, type ActionFailure } from '@sveltejs/kit';
import { message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import type { ProcessDefinitionInput, ProcessPreview } from '$lib/contracts/interactions';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { AppError, ConflictError, ForbiddenError } from '$lib/server/errors';
import {
	errorIssues,
	toActionFailure,
	toPageError,
	type ActionErrorPayload
} from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { PERMISSIONS, PERMISSION_KEYS } from '$lib/server/rbac/permissions';
import {
	createDraft,
	discardDraft,
	getProcessGroup,
	previewPublication,
	processDefinition,
	publishProcess,
	updateDraft
} from '$lib/server/stages/process';
import { parseChecklist, stageFormSchema, transitionFormSchema } from './schema';
import type { Actions, PageServerLoad } from './$types';

/**
 * Процесс одной группы контрагентов.
 *
 * Действующая структура открыта только на чтение: по ней идут взаимодействия и
 * с неё сняты слепки пройденных стадий. Изменение готовят черновиком — копией
 * действующей структуры — и применяют ко всем одной операцией, которая
 * переносит незавершённые взаимодействия на новую структуру.
 *
 * Черновик правится целиком: каждое действие собирает структуру заново и отдаёт
 * её `updateDraft`, а тот переписывает стадии, переходы и правила переноса под
 * блокировкой строки группы. Отсюда и чтение перед каждой записью: правится не
 * поле, а описание процесса.
 */

/** Формы страницы; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = { stage: 'process-stage', transition: 'process-transition' } as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, 'Раздел доступен только с правом «Настройка маршрутов и стадий»');
	}

	try {
		const detail = await getProcessGroup(ctx, event.params.key);

		// Предпросмотр считается сразу вместе со страницей: он справочен, не
		// берёт блокировок, и держать за ним отдельный запрос значило бы
		// показывать числа позже, чем решение о применении.
		let preview: ProcessPreview | null = null;

		if (detail.draft !== null) {
			preview = await previewPublication(ctx, event.params.key);
		}

		return {
			detail,
			// Заголовок и крошки принадлежат макету настроек, а какой именно
			// процесс открыт, знает только эта страница: по «Настройки ›
			// Настройки» было не понять, чей процесс правят.
			settingsTitle: detail.group.name,
			settingsDescription:
				detail.group.description ?? 'Стадии, нормативы и переходы этой группы контрагентов',
			preview,
			stageForm: await superValidate(zod4(stageFormSchema), { id: FORM_IDS.stage }),
			transitionForm: await superValidate(zod4(transitionFormSchema), {
				id: FORM_IDS.transition
			}),
			// Право перехода выбирается из каталога, а не пишется строкой: код, которого
			// в каталоге нет, ничего не разрешает (`transitionPermission`), и переход с
			// таким кодом оказался бы недоступен вообще никому.
			permissions: PERMISSION_KEYS.map((key) => ({ key, label: PERMISSIONS[key] }))
		};
	} catch (failure) {
		toPageError(failure);
	}
};

/**
 * Предметная ошибка записи показывается над формой целиком: у неё нет поля, к
 * которому её можно отнести, а угадывать поле по тексту сообщения значит
 * сломаться на первой же правке текста. Отказ по правам из этого правила
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

/**
 * Черновик в том виде, в каком его принимает `updateDraft`. Читается перед
 * каждой правкой: форма присылает одну стадию или один переход, а записывается
 * структура процесса целиком.
 */
async function readDraftDefinition(
	ctx: ActorContext,
	groupKey: string
): Promise<ProcessDefinitionInput> {
	const { draft } = await getProcessGroup(ctx, groupKey);

	if (draft === null) {
		throw new ConflictError('У группы нет черновика изменений: сначала заведите его');
	}

	return processDefinition(draft);
}

/** Значение поля формы строкой; пустое и отсутствующее — одно и то же. */
function field(form: FormData, name: string): string {
	const value = form.get(name);

	return typeof value === 'string' ? value.trim() : '';
}

export const actions: Actions = {
	createDraft: async (event) => {
		try {
			await createDraft(actorFromEvent(event), event.params.key);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Черновик изменений создан копией действующего процесса' };
	},

	discardDraft: async (event) => {
		try {
			await discardDraft(actorFromEvent(event), event.params.key);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Черновик изменений отменён' };
	},

	stage: async (event) => {
		const form = await superValidate(event.request, zod4(stageFormSchema), { id: FORM_IDS.stage });

		if (!form.valid) {
			return fail(400, { form });
		}

		const input = form.data;
		const ctx = actorFromEvent(event);

		try {
			const definition = await readDraftDefinition(ctx, event.params.key);
			const stages = [...definition.stages];
			const index =
				input.originalKey === ''
					? -1
					: stages.findIndex((stage) => stage.key === input.originalKey);

			if (input.originalKey !== '' && index === -1) {
				return setError(form, '', `Стадии «${input.originalKey}» в черновике больше нет`);
			}

			// Ключ существующей стадии не правится: смена ключа неотличима от
			// «удалили одну стадию и завели другую», а последствия у этих действий
			// разные — по ключу сопоставляются записи и строки отчёта.
			if (index !== -1 && input.key !== input.originalKey) {
				return setError(
					form,
					'key',
					'Ключ существующей стадии изменить нельзя: удалите стадию с правилом переноса и заведите новую'
				);
			}

			if (index !== -1) {
				stages.splice(index, 1);
			}

			if (stages.some((stage) => stage.key === input.key)) {
				return setError(form, 'key', 'Стадия с таким ключом в процессе уже есть');
			}

			// Позиция — это место в цепочке, а не хранимое поле: номера расставит
			// запись редакции по порядку списка. Значение за краями списка
			// означает «в конец», а не ошибку ввода.
			const place = Math.min(Math.max(input.position, 1), stages.length + 1) - 1;

			stages.splice(place, 0, {
				key: input.key,
				name: input.name,
				category: input.category,
				slaDays: input.slaDays,
				staleAfterDays: input.staleAfterDays === 0 ? null : input.staleAfterDays,
				requiresResult: input.requiresResult,
				requiresConfirmation: input.requiresConfirmation,
				requiresLmsData: input.requiresLmsData,
				// Пустая строка в форме означает «отметки не требуется»: пустой
				// выбор в списке не отличить от невыбранного.
				requiresDocumentMark: input.requiresDocumentMark === '' ? null : input.requiresDocumentMark,
				isFinal: input.isFinal,
				checklist: parseChecklist(input.checklist).items
			});

			await updateDraft(ctx, event.params.key, { ...definition, stages });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, input.originalKey === '' ? 'Стадия добавлена' : 'Стадия сохранена');
	},

	deleteStage: async (event) => {
		const body = await event.request.formData();
		const key = field(body, 'key');
		const targetStageKey = field(body, 'targetStageKey');

		if (key === '') {
			return fail(400, { message: 'Не указано, какую стадию удалять', issues: [] });
		}

		const ctx = actorFromEvent(event);

		try {
			const definition = await readDraftDefinition(ctx, event.params.key);
			const stages = definition.stages.filter((stage) => stage.key !== key);

			if (stages.length === definition.stages.length) {
				return fail(404, { message: `Стадии «${key}» в черновике нет`, issues: [] });
			}

			// Процесса без стадий не существует: последнюю удалить нельзя, и
			// говорить об этом надо здесь, а не отказом при применении.
			if (stages.length === 0) {
				return fail(409, {
					message: 'Единственную стадию удалить нельзя: процесса без стадий не существует',
					issues: []
				});
			}

			// Переходы уходят вместе со стадией: переход без одного из концов —
			// это не описание процесса, а висячая ссылка, и оставлять её человеку
			// на доделку значит запереть применение на непонятной претензии.
			const transitions = definition.transitions.filter(
				(transition) => transition.fromStageKey !== key && transition.toStageKey !== key
			);

			// Явно выбранная цель переноса сильнее умолчания; пустая означает
			// «как решит движок» — предыдущая сохранившаяся стадия.
			const migrationRules = definition.migrationRules.filter(
				(rule) => rule.removedStageKey !== key
			);

			if (targetStageKey !== '') {
				if (!stages.some((stage) => stage.key === targetStageKey)) {
					return fail(400, {
						message: `Стадии «${targetStageKey}» в процессе нет: перенести записи на неё нельзя`,
						issues: []
					});
				}

				migrationRules.push({ removedStageKey: key, targetStageKey });
			}

			await updateDraft(ctx, event.params.key, {
				...definition,
				stages,
				transitions,
				migrationRules
			});
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Стадия удалена из черновика' };
	},

	transition: async (event) => {
		const form = await superValidate(event.request, zod4(transitionFormSchema), {
			id: FORM_IDS.transition
		});

		if (!form.valid) {
			return fail(400, { form });
		}

		const input = form.data;
		const ctx = actorFromEvent(event);

		try {
			const definition = await readDraftDefinition(ctx, event.params.key);
			const stageKeys = new Set(definition.stages.map((stage) => stage.key));

			for (const [name, key] of [
				['fromStageKey', input.fromStageKey],
				['toStageKey', input.toStageKey]
			] as const) {
				if (!stageKeys.has(key)) {
					return setError(form, name, `Стадии «${key}» в процессе нет`);
				}
			}

			// Пара «откуда — куда» и есть имя перехода: правка со сменой концов —
			// это другой переход, поэтому прежняя пара снимается, а новая заменяет
			// ту, что могла стоять на её месте.
			const transitions = definition.transitions.filter(
				(transition) =>
					!(
						transition.fromStageKey === input.originalFromKey &&
						transition.toStageKey === input.originalToKey
					) &&
					!(
						transition.fromStageKey === input.fromStageKey &&
						transition.toStageKey === input.toStageKey
					)
			);

			transitions.push({
				fromStageKey: input.fromStageKey,
				toStageKey: input.toStageKey,
				kind: input.kind,
				requiredPermissionKey: input.requiredPermissionKey,
				requiresReason: input.requiresReason
			});

			await updateDraft(ctx, event.params.key, { ...definition, transitions });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, input.originalFromKey === '' ? 'Переход добавлен' : 'Переход сохранён');
	},

	deleteTransition: async (event) => {
		const body = await event.request.formData();
		const fromStageKey = field(body, 'fromStageKey');
		const toStageKey = field(body, 'toStageKey');

		if (fromStageKey === '' || toStageKey === '') {
			return fail(400, { message: 'Не указано, какой переход удалять', issues: [] });
		}

		const ctx = actorFromEvent(event);

		try {
			const definition = await readDraftDefinition(ctx, event.params.key);
			const transitions = definition.transitions.filter(
				(transition) =>
					!(transition.fromStageKey === fromStageKey && transition.toStageKey === toStageKey)
			);

			if (transitions.length === definition.transitions.length) {
				return fail(404, { message: 'Такого перехода в процессе нет', issues: [] });
			}

			await updateDraft(ctx, event.params.key, { ...definition, transitions });
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Переход удалён из черновика' };
	},

	publish: async (event) => {
		let result: Awaited<ReturnType<typeof publishProcess>>;

		try {
			result = await publishProcess(actorFromEvent(event), event.params.key);
		} catch (failure) {
			return toActionFailure(failure);
		}

		// Числа в ответе — фактические, из транзакции: предпросмотр справочен, и
		// повторять его числа здесь значило бы отчитываться оценкой.
		return {
			ok: true,
			message:
				result.migratedCount === 0
					? `Процесс изменён: перепривязано записей — ${result.reboundCount}, переехавших взаимодействий нет`
					: `Процесс изменён: перепривязано записей — ${result.reboundCount}, переехало взаимодействий — ${result.migratedCount}`
		};
	}
};
