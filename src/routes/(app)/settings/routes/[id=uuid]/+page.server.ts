import { error, fail, redirect, type ActionFailure } from '@sveltejs/kit';
import { message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import type { CreateRouteInput } from '$lib/contracts/interactions';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { AppError, ForbiddenError } from '$lib/server/errors';
import {
	errorIssues,
	toActionFailure,
	toPageError,
	type ActionErrorPayload
} from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { PERMISSIONS, PERMISSION_KEYS } from '$lib/server/rbac/permissions';
import {
	createDraftFrom,
	getRouteDetail,
	publishRoute,
	routeDefinition,
	setDefaultRoute,
	updateRoute
} from '$lib/server/stages/routes';
import { parseChecklist, stageFormSchema, transitionFormSchema } from './schema';
import type { Actions, PageServerLoad } from './$types';

/**
 * Карточка версии маршрута.
 *
 * Опубликованная версия открыта только на чтение: по ней уже идут
 * взаимодействия и с неё сняты слепки стадий, поэтому единственное действие над
 * ней — завести новую версию или назначить её маршрутом по умолчанию. Черновик
 * правится целиком: каждое действие собирает конфигурацию заново и отдаёт её
 * `updateRoute`, а тот переписывает стадии и переходы под блокировкой строки.
 *
 * Отсюда и чтение перед каждой записью: правится не поле, а описание процесса
 * целиком. Двух черновиков у одного ключа не бывает (`createDraftFrom`
 * отказывает), поэтому редактирование в один момент времени идёт в одном месте.
 */

/** Формы страницы; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = { stage: 'route-stage', transition: 'route-transition' } as const;

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'stages.configure')) {
		error(403, 'Раздел доступен только с правом «Настройка маршрутов и стадий»');
	}

	try {
		return {
			detail: await getRouteDetail(ctx, event.params.id),
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
 * Конфигурация версии в том виде, в каком её принимает `updateRoute`. Читается
 * перед каждой правкой: форма присылает одну стадию или один переход, а
 * записывается описание процесса целиком.
 */
async function readDefinition(
	ctx: ActorContext,
	routeId: string
): Promise<CreateRouteInput & { id: string }> {
	const { route } = await getRouteDetail(ctx, routeId);

	return { ...routeDefinition(route), id: route.id };
}

/** Значение поля формы строкой; пустое и отсутствующее — одно и то же. */
function field(form: FormData, name: string): string {
	const value = form.get(name);

	return typeof value === 'string' ? value.trim() : '';
}

export const actions: Actions = {
	stage: async (event) => {
		const form = await superValidate(event.request, zod4(stageFormSchema), { id: FORM_IDS.stage });

		if (!form.valid) {
			return fail(400, { form });
		}

		const input = form.data;
		const ctx = actorFromEvent(event);

		try {
			const definition = await readDefinition(ctx, event.params.id);
			const stages = [...definition.stages];
			const index =
				input.originalKey === ''
					? -1
					: stages.findIndex((stage) => stage.key === input.originalKey);

			if (input.originalKey !== '' && index === -1) {
				return setError(form, '', `Стадии «${input.originalKey}» в маршруте больше нет`);
			}

			if (index !== -1) {
				stages.splice(index, 1);
			}

			if (stages.some((stage) => stage.key === input.key)) {
				return setError(form, 'key', 'Стадия с таким ключом в маршруте уже есть');
			}

			// Позиция — это место в цепочке, а не хранимое поле: номера расставит
			// `writeRouteContent` по порядку списка. Значение за краями списка
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
				checklist: parseChecklist(input.checklist).items
			});

			// Переименование ключа — это та же стадия под другим именем, поэтому
			// переходы идут за ней. Иначе правка ключа оставила бы висячий переход,
			// и схема отказала бы там, где человек ничего не ломал.
			const transitions = definition.transitions.map((transition) => ({
				...transition,
				fromStageKey:
					transition.fromStageKey === input.originalKey ? input.key : transition.fromStageKey,
				toStageKey: transition.toStageKey === input.originalKey ? input.key : transition.toStageKey
			}));

			await updateRoute(ctx, { ...definition, stages, transitions });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, input.originalKey === '' ? 'Стадия добавлена' : 'Стадия сохранена');
	},

	deleteStage: async (event) => {
		const key = field(await event.request.formData(), 'key');

		if (key === '') {
			return fail(400, { message: 'Не указано, какую стадию удалять', issues: [] });
		}

		const ctx = actorFromEvent(event);

		try {
			const definition = await readDefinition(ctx, event.params.id);
			const stages = definition.stages.filter((stage) => stage.key !== key);

			if (stages.length === definition.stages.length) {
				return fail(404, { message: `Стадии «${key}» в маршруте нет`, issues: [] });
			}

			// Переходы вместе со стадией не удаляются: переход — отдельное решение
			// («откуда сюда можно прийти»), и молча стереть его значит потерять
			// часть описания процесса без единого слова об этом.
			const held = definition.transitions.filter(
				(transition) => transition.fromStageKey === key || transition.toStageKey === key
			);

			if (held.length > 0) {
				return fail(409, {
					message: `Стадию «${key}» держат переходы — сначала удалите их`,
					issues: held.map((transition) => `${transition.fromStageKey} → ${transition.toStageKey}`)
				});
			}

			await updateRoute(ctx, { ...definition, stages });
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Стадия удалена' };
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
			const definition = await readDefinition(ctx, event.params.id);
			const stageKeys = new Set(definition.stages.map((stage) => stage.key));

			for (const [name, key] of [
				['fromStageKey', input.fromStageKey],
				['toStageKey', input.toStageKey]
			] as const) {
				if (!stageKeys.has(key)) {
					return setError(form, name, `Стадии «${key}» в маршруте нет`);
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

			await updateRoute(ctx, { ...definition, transitions });
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
			const definition = await readDefinition(ctx, event.params.id);
			const transitions = definition.transitions.filter(
				(transition) =>
					!(transition.fromStageKey === fromStageKey && transition.toStageKey === toStageKey)
			);

			if (transitions.length === definition.transitions.length) {
				return fail(404, { message: 'Такого перехода в маршруте нет', issues: [] });
			}

			await updateRoute(ctx, { ...definition, transitions });
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Переход удалён' };
	},

	publish: async (event) => {
		try {
			await publishRoute(actorFromEvent(event), event.params.id);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return {
			ok: true,
			message: 'Версия опубликована: по ней можно вести взаимодействия, править её больше нельзя'
		};
	},

	setDefault: async (event) => {
		try {
			await setDefaultRoute(actorFromEvent(event), event.params.id);
		} catch (failure) {
			return toActionFailure(failure);
		}

		return { ok: true, message: 'Эту версию предложат новому взаимодействию' };
	},

	newVersion: async (event) => {
		let draftId: string;

		try {
			draftId = (await createDraftFrom(actorFromEvent(event), event.params.id)).id;
		} catch (failure) {
			return toActionFailure(failure);
		}

		// Работа продолжается в новой версии: человек нажал «Новая версия», чтобы
		// её править, а не чтобы прочитать сообщение об успехе.
		redirect(303, resolve('/(app)/settings/routes/[id=uuid]', { id: draftId }));
	}
};
