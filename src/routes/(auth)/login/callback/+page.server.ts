import { redirect } from '@sveltejs/kit';
import { actorFromEvent } from '$lib/server/actor';
import { callbackUrl, takeFlow } from '$lib/server/auth/flow';
import { signInWithClaims } from '$lib/server/auth/identity';
import { exchangeCode } from '$lib/server/auth/oidc';
import { safeNextPath } from '$lib/server/auth/redirect';
import { setSessionCookie } from '$lib/server/auth/session';
import type { PageServerLoad } from './$types';

/**
 * Возврат из каталога.
 *
 * Страница, а не эндпоинт: удачный исход уводит человека перенаправлением и
 * ничего не рисует, а неудачный обязан объяснить, что случилось, — и объяснить
 * на нашем языке, потому что в этот момент человек стоит перед пустым экраном
 * с непонятным адресом в строке.
 *
 * Любой сбой обмена — просроченный заход, подменённый `state`, негодная подпись
 * — приводит сюда одним и тем же исходом: вход не состоялся. Причину наружу не
 * уточняем, она уходит в лог сервера вместе с идентификатором запроса.
 */
export const load: PageServerLoad = async (event) => {
	const flow = await takeFlow(event.cookies);

	if (flow === null) {
		return {
			failure: 'expired' as const,
			message: 'Вход не закончен: страница входа была открыта слишком давно. Начните заново.'
		};
	}

	// Каталог отказал до всякого обмена — человек нажал «отмена» на его форме
	// или realm отклонил заход. Это не сбой, и объяснять его как сбой нельзя.
	if (event.url.searchParams.has('error')) {
		return {
			failure: 'refused' as const,
			message: 'Каталог учётных записей не подтвердил вход.'
		};
	}

	const ctx = actorFromEvent(event);

	let exchanged: Awaited<ReturnType<typeof exchangeCode>>;

	try {
		exchanged = await exchangeCode({
			currentUrl: event.url,
			attempt: flow,
			redirectUri: callbackUrl()
		});
	} catch (error) {
		console.error(`[auth] обмен кода не состоялся, запрос ${event.locals.requestId}`, error);

		return {
			failure: 'exchange' as const,
			message: 'Ответ каталога учётных записей не прошёл проверку. Попробуйте войти заново.'
		};
	}

	const outcome = await signInWithClaims(ctx, exchanged.claims, exchanged.idToken);

	if (!outcome.ok) {
		return { failure: outcome.reason, message: REFUSAL[outcome.reason] };
	}

	await setSessionCookie(event.cookies, outcome.sessionId);

	redirect(303, safeNextPath(flow.next));
};

/**
 * Отказ во входе словами. Случаи разные, и путать их нельзя: «доступ не
 * назначен» решается обращением к администратору каталога, «запись выключена» и
 * «почта занята» — к администратору системы, а машинным субъектом не входят
 * вовсе.
 */
const REFUSAL: Record<'no_role' | 'service_account' | 'inactive' | 'email_taken', string> = {
	no_role:
		'Доступ в систему вам не назначен. Обратитесь к администратору: нужна одна из ролей CRM в каталоге учётных записей.',
	service_account:
		'Этой учётной записью пользуется внешняя система, войти ею нельзя. Обратитесь к администратору.',
	inactive: 'Учётная запись выключена. Обратитесь к администратору системы.',
	email_taken:
		'Ваша почта уже числится за другой учётной записью системы. Обратитесь к администратору: связать их может только он.'
};
