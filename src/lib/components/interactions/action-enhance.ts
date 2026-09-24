import { applyAction } from '$app/forms';
import type { SubmitFunction } from '@sveltejs/kit';
import { toast } from 'svelte-sonner';

/** Отказ действия в том виде, в каком его складывает `toActionFailure`. */
type ActionError = { message?: unknown; issues?: unknown };

/** Отказ действия словами: сообщение сервера и его претензии одной строкой. */
export function describeActionFailure(data: unknown): { message: string; description?: string } {
	const payload = (data ?? {}) as ActionError;
	const message = typeof payload.message === 'string' ? payload.message : 'Действие не выполнено';
	const issues = Array.isArray(payload.issues)
		? payload.issues.filter((issue): issue is string => typeof issue === 'string')
		: [];

	return { message, description: issues.length > 0 ? issues.join('; ') : undefined };
}

/**
 * Отправка формы действия в карточке взаимодействия.
 *
 * Успех обновляет всю страницу: одно действие меняет и стадию, и сводку, и
 * историю, поэтому перерисовывать что-то одно бессмысленно. Отказ показывается
 * словами — тем самым сообщением, которое вернул сервер, а не «что-то пошло не
 * так».
 *
 * По умолчанию отказ уходит в тост. Форме, которую этот отказ и надо
 * исправлять, тост не годится: он всплывает в углу, накрывает её поля и гаснет
 * вместе с причиной, — такая форма передаёт `onfailure` и показывает отказ у
 * себя.
 */
export function actionEnhance(
	options: {
		onsuccess?: () => void;
		/**
		 * Проверка формы перед отправкой. Вернула `false` — отправки не будет, а
		 * введённое останется на экране: претензию к полю пишет сама форма
		 * по-русски, а не браузер своим пузырём на своём языке.
		 */
		validate?: () => boolean;
		/**
		 * Показать отказ самой формой вместо тоста. Вызывается вместо него, а не
		 * вдобавок: два сообщения об одном отказе спорят друг с другом. Форма,
		 * которая взяла отказ себе, обязана его показать.
		 */
		onfailure?: (refusal: { message: string; description?: string }) => void;
		/**
		 * Отказ 409 — запись изменил кто-то другой или стадия уже сменилась —
		 * показать в самой форме, рядом с кнопкой «Обновить карточку», а не
		 * тостом: введённое остаётся в полях, и решать, что с ним делать, человек
		 * будет, глядя на форму. Остальные отказы идут обычным путём.
		 */
		onconflict?: (message: string) => void;
	} = {}
): SubmitFunction {
	return ({ cancel }) => {
		if (options.validate?.() === false) {
			cancel();
		}

		return async ({ result, update }) => {
			if (result.type === 'failure') {
				const refusal = describeActionFailure(result.data);

				if (result.status === 409 && options.onconflict) {
					options.onconflict(refusal.message);
				} else if (options.onfailure) {
					options.onfailure(refusal);
				} else {
					toast.error(refusal.message, { description: refusal.description });
				}

				return;
			}

			if (result.type === 'success') {
				options.onsuccess?.();
				await update();

				return;
			}

			await applyAction(result);
		};
	};
}
