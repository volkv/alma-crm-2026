import { error } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure } from '$lib/server/http';
import { checkExternalSources, dadataHost, runDiagnostics } from '$lib/server/diagnostics';
import { can } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';
import { PERMISSIONS } from '$lib/server/rbac/permissions';

/**
 * «Статус системы»: самодиагностика установки в закрытой сети.
 *
 * Право — то же, что у интеграций (`integrations.manage`): адреса CMS и системы
 * обучения на странице те же, что в настройках обмена, а остальное — адреса
 * служб внутри сети установки без учётных данных.
 *
 * Проверка идёт при каждом открытии: страница отвечает на вопрос «работает ли
 * сейчас», и ответ из кэша на него не отвечает. Наружу открытие не ходит —
 * выход в интернет проверяется только действием `external`.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	if (!can(ctx, 'integrations.manage')) {
		error(403, `Раздел доступен только с правом «${PERMISSIONS['integrations.manage']}»`);
	}

	return { report: await runDiagnostics(ctx), dadataHost: await dadataHost() };
};

export const actions: Actions = {
	external: async (event) => {
		const ctx = actorFromEvent(event);

		try {
			return { external: await checkExternalSources(ctx) };
		} catch (failure) {
			// Сюда доходит только отказ по правам: недоступность узла — это
			// состояние проверки, а не исключение.
			return toActionFailure(failure);
		}
	}
};
