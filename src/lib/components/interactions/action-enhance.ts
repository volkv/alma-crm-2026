import { applyAction } from '$app/forms';
import type { SubmitFunction } from '@sveltejs/kit';
import { toast } from 'svelte-sonner';

/** Отказ действия в том виде, в каком его складывает `toActionFailure`. */
type ActionError = { message?: unknown; issues?: unknown };

function describe(data: unknown): { message: string; description?: string } {
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
 */
export function actionEnhance(options: { onsuccess?: () => void } = {}): SubmitFunction {
	return () =>
		async ({ result, update }) => {
			if (result.type === 'failure') {
				const { message, description } = describe(result.data);
				toast.error(message, { description });

				return;
			}

			if (result.type === 'success') {
				options.onsuccess?.();
				await update();

				return;
			}

			await applyAction(result);
		};
}
