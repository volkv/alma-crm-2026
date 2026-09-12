import { redirect, type Cookies } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { fail, message, setError, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { secondFactorSchema, totpCodeSchema } from '$lib/contracts/auth';
import { actorFromEvent } from '$lib/server/actor';
import { finishSecondFactor } from '$lib/server/auth/login';
import {
	BACKUP_CODE_COUNT,
	claimFreshEnrollment,
	confirmEnrollment,
	mfaStateFor,
	pendingEnrollment,
	verifySecondFactor
} from '$lib/server/auth/mfa';
import { safeNextPath } from '$lib/server/auth/redirect';
import { SESSION_COOKIE } from '$lib/server/auth/session';
import { formatSecretForHuman } from '$lib/server/auth/totp';
import { AppError, ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';
import type { Actions, PageServerLoad } from './$types';

/**
 * Второй шаг входа.
 *
 * Сюда приходит тот, чей пароль приняли, но чья сессия ещё неполная: гвардия
 * не пускает её никуда, кроме этой страницы. Шага два вида, и выбирает между
 * ними не адрес, а состояние учётной записи: есть зарегистрированный секрет —
 * спрашиваем код, нет — показываем регистрацию, потому что политика требует
 * фактор, а фактора у человека пока нет.
 *
 * Страница живёт в `(auth)`, а не в `(app)`: оболочки приложения тому, кто ещё
 * не вошёл, не полагается, а гвардия сюда и не смотрит — иначе она разворачивала
 * бы неполную сессию на страницу, которая сама же и закрыта.
 */

/** Форма страницы: идентификатор связывает её с формой в браузере. */
const FORM_ID = 'second-factor';

function sessionId(cookies: Cookies): string {
	const value = cookies.get(SESSION_COOKIE);

	if (value === undefined) {
		// Хук уже собрал `locals.user` по этой самой cookie, поэтому её отсутствие
		// здесь означает не «не вошёл», а расхождение внутри одного запроса.
		throw new Error('Сессия есть, а её cookie нет');
	}

	return value;
}

export const load: PageServerLoad = async (event) => {
	const user = event.locals.user;
	const next = safeNextPath(event.url.searchParams.get('next'));

	if (user === null) {
		redirect(303, `${resolve('/login')}?next=${encodeURIComponent(next)}`);
	}

	// Шаг уже закрыт: и тот, кто открыл страницу из истории браузера, и тот, кто
	// вошёл во второй вкладке, должны оказаться там, куда шли, а не на форме
	// подтверждения того, что подтверждать нечего.
	if (!user.mfaPending) {
		redirect(303, next);
	}

	const state = await mfaStateFor(user.id);

	if (state.enabled) {
		return {
			mode: 'verify' as const,
			next,
			account: { email: user.email },
			enrollment: null,
			backupCodeCount: BACKUP_CODE_COUNT,
			form: await superValidate(zod4(secondFactorSchema), { id: FORM_ID })
		};
	}

	const enrollment = await pendingEnrollment(actorFromEvent(event), sessionId(event.cookies));

	return {
		mode: 'enroll' as const,
		next,
		account: { email: user.email },
		enrollment: {
			uri: enrollment.uri,
			secret: formatSecretForHuman(enrollment.secret)
		},
		backupCodeCount: BACKUP_CODE_COUNT,
		form: await superValidate(zod4(totpCodeSchema), { id: FORM_ID })
	};
};

export const actions: Actions = {
	/** Код из приложения или резервный код у того, у кого фактор уже есть. */
	verify: async (event) => {
		const form = await superValidate(event.request, zod4(secondFactorSchema), { id: FORM_ID });
		const code = form.data.code;

		// Код в браузер не возвращается: он одноразовый, и перерисованная с ним
		// форма предлагала бы отправить его второй раз.
		form.data.code = '';

		if (!form.valid) {
			return fail(400, { form });
		}

		const ctx = actorFromEvent(event);
		const outcome = await verifySecondFactor(ctx, { code });

		if (!outcome.ok) {
			return message(form, outcome.message, { status: 400 });
		}

		await finishSecondFactor(ctx, sessionId(event.cookies));

		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	},

	/**
	 * Подтверждение регистрации. Вход не закрывается здесь же: резервные коды
	 * показываются один раз, и человек должен успеть их записать — закрывает шаг
	 * действие `finish`.
	 */
	enroll: async (event) => {
		const form = await superValidate(event.request, zod4(totpCodeSchema), { id: FORM_ID });
		const code = form.data.code;

		form.data.code = '';

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			const backupCodes = await confirmEnrollment(actorFromEvent(event), {
				sessionId: sessionId(event.cookies),
				code
			});

			return { form, backupCodes };
		} catch (failure) {
			if (failure instanceof AppError) {
				return setError(form, '', [
					failure.message,
					...(failure instanceof ValidationError ? failure.issues : [])
				]);
			}

			throw failure;
		}
	},

	/**
	 * «Я записал коды»: закрывает второй шаг после только что законченной
	 * регистрации. Разрешение на это одноразовое и выдано самой регистрацией —
	 * иначе отправкой этой формы мимо страницы можно было бы войти, не предъявив
	 * ни кода, ни резервного кода.
	 */
	finish: async (event) => {
		const ctx = actorFromEvent(event);
		const session = sessionId(event.cookies);

		if (!(await claimFreshEnrollment(session))) {
			return fail(400, {
				message: 'Подтвердите вход кодом из приложения',
				issues: []
			});
		}

		try {
			await finishSecondFactor(ctx, session);
		} catch (failure) {
			return toActionFailure(failure);
		}

		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	}
};
