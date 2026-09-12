import { error, redirect, type ActionFailure, type Cookies } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { fail, message, setError, superValidate, type SuperValidated } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { totpCodeSchema } from '$lib/contracts/auth';
import { actorFromEvent } from '$lib/server/actor';
import { recordAuditEvent } from '$lib/server/audit';
import {
	BACKUP_CODE_COUNT,
	confirmEnrollment,
	disableMfa,
	mfaRequiredForRole,
	mfaStateFor,
	pendingEnrollment,
	regenerateBackupCodes
} from '$lib/server/auth/mfa';
import { clearSessionCookie, revokeAllSessions, SESSION_COOKIE } from '$lib/server/auth/session';
import { formatSecretForHuman } from '$lib/server/auth/totp';
import { changePassword } from '$lib/server/auth/users';
import { AppError, ForbiddenError, ValidationError } from '$lib/server/errors';
import { errorIssues, toActionFailure, type ActionErrorPayload } from '$lib/server/http';
import { getSetting } from '$lib/server/settings';
import { changePasswordSchema } from './schema';
import type { Actions, PageServerLoad } from './$types';

/**
 * Профиль: пароль и сессии того, кто вошёл. Отдельного права на раздел нет —
 * свой пароль меняет любой сотрудник, — но и чужую учётную запись отсюда не
 * тронуть: сервис работает только с `ctx.user`.
 *
 * Оба действия гасят все сессии владельца, включая текущую, и снимают cookie:
 * следующий запрос должен быть анонимным, а не биться о погашенную сессию.
 * Смена пароля уводит на форму входа с причиной в адресе, «завершить все
 * сессии» оставляет человека здесь с сообщением и кнопкой «Войти заново».
 *
 * Демонстрационной сессии раздел доступен только на чтение. Учётная запись у
 * неё общая: её открыли все, кто зашёл на стенд, и оба действия тронули бы не
 * свою работу, а чужую — смена пароля увела бы его у администратора стенда,
 * «завершить все сессии» выкинуло бы из системы всех посетителей разом. Права
 * на собственный пароль нет и быть не может (его меняет любой сотрудник),
 * поэтому граница проходит здесь — по общей учётной записи, ровно как у
 * `deactivateUser`, который по той же причине не даёт её выключить.
 */

/** Формы раздела; идентификатор связывает форму на сервере с формой в браузере. */
const FORM_IDS = {
	enroll: 'mfa-enroll',
	disable: 'mfa-disable',
	codes: 'mfa-backup-codes'
} as const;

/**
 * Идентификатор сессии: секрет начатой регистрации живёт рядом с ней, а не в
 * учётной записи. До раздела доходит только вошедший, поэтому cookie здесь
 * есть всегда; её отсутствие — расхождение внутри одного запроса, а не
 * состояние, которое надо обойти.
 */
function sessionId(cookies: Cookies): string {
	const value = cookies.get(SESSION_COOKIE);

	if (value === undefined) {
		throw new Error('Сессия есть, а её cookie нет');
	}

	return value;
}

/** Отказ демонстрации: одинаковый для обоих действий раздела. */
function refuseDemo(action: string): ForbiddenError {
	return new ForbiddenError(
		`Демонстрационная учётная запись общая для всех, кто открыл стенд: ${action} из демонстрации нельзя`
	);
}

export const load: PageServerLoad = async (event) => {
	const user = event.locals.user;

	if (user === null) {
		error(403, 'Профиль доступен только вошедшему пользователю');
	}

	// Материал регистрации собирается только по прямой просьбе: секрет, показанный
	// всякому, кто открыл профиль, начинал бы регистрацию, которой никто не просил.
	const enrolling = !user.isDemo && event.url.searchParams.get('mfa') === 'enroll';
	const [policy, mfa, mfaRequired, enrollment] = await Promise.all([
		getSetting('password_policy'),
		mfaStateFor(user.id),
		mfaRequiredForRole(user.roleId),
		enrolling
			? pendingEnrollment(actorFromEvent(event), sessionId(event.cookies))
			: Promise.resolve(null)
	]);

	return {
		account: { email: user.email, fullName: user.fullName },
		isDemo: user.isDemo,
		policy,
		mfa,
		/** Роль обязана иметь фактор: отключить его владелец не может. */
		mfaRequired,
		backupCodeCount: BACKUP_CODE_COUNT,
		enrollment:
			enrollment === null || mfa.enabled
				? null
				: { uri: enrollment.uri, secret: formatSecretForHuman(enrollment.secret) },
		form: await superValidate(zod4(changePasswordSchema)),
		enrollForm: await superValidate(zod4(totpCodeSchema), { id: FORM_IDS.enroll }),
		disableForm: await superValidate(zod4(totpCodeSchema), { id: FORM_IDS.disable }),
		codesForm: await superValidate(zod4(totpCodeSchema), { id: FORM_IDS.codes })
	};
};

export const actions: Actions = {
	password: async (event) => {
		const ctx = actorFromEvent(event);
		const form = await superValidate(event.request, zod4(changePasswordSchema));
		const { current, next } = form.data;

		// Пароли не возвращаются в браузер ни при каком исходе: форма
		// перерисовывается пустой, а не с набранным паролем в разметке ответа.
		form.data = { current: '', next: '', repeat: '' };

		if (ctx.user?.isDemo === true) {
			return toActionFailure(refuseDemo('менять её пароль'));
		}

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await changePassword(ctx, { current, next });
		} catch (failure) {
			if (failure instanceof AppError) {
				return setError(form, '', [
					failure.message,
					...(failure instanceof ValidationError ? failure.issues : [])
				]);
			}

			throw failure;
		}

		clearSessionCookie(event.cookies);

		// Сессии погашены все, включая текущую, поэтому на странице раздела
		// человеку делать нечего: следующий же запрос отсюда развернуло бы на
		// вход. Причина едет в адресе — форма входа объясняет, почему человек на
		// ней оказался, вместо того чтобы выглядеть внезапным выходом из системы.
		redirect(303, `${resolve('/login')}?reason=password-changed`);
	},

	revokeAll: async (event) => {
		const ctx = actorFromEvent(event);

		if (ctx.user === null) {
			error(403, 'Завершить сессии может только вошедший пользователь');
		}

		if (ctx.user.isDemo) {
			return toActionFailure(refuseDemo('завершить её сессии'));
		}

		await revokeAllSessions(ctx.user.id);

		await recordAuditEvent(ctx, {
			type: 'auth.logout',
			outcome: 'success',
			subject: { type: 'user', id: ctx.user.id },
			details: { userId: ctx.user.id }
		});

		clearSessionCookie(event.cookies);

		return message(
			await superValidate(zod4(changePasswordSchema)),
			'Все сессии завершены — войдите заново.'
		);
	},

	/**
	 * Подключение фактора по собственному желанию: у роли, которой политика его
	 * не требует, это единственный способ его получить. Резервные коды видны
	 * один раз — прямо в ответе этого действия.
	 */
	mfaEnroll: async (event) => {
		const form = await superValidate(event.request, zod4(totpCodeSchema), {
			id: FORM_IDS.enroll
		});
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
			return asFormError(form, failure);
		}
	},

	/**
	 * Отключение фактора. Код спрашивается не для проформы: без него достаточно
	 * оставленной без присмотра вкладки, чтобы снять защиту с учётной записи.
	 */
	mfaDisable: async (event) => {
		const form = await superValidate(event.request, zod4(totpCodeSchema), {
			id: FORM_IDS.disable
		});
		const code = form.data.code;

		form.data.code = '';

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await disableMfa(actorFromEvent(event), { code });
		} catch (failure) {
			return asFormError(form, failure);
		}

		return message(form, 'Второй фактор отключён');
	},

	/** Новый набор резервных кодов вместо прежнего: старые перестают работать. */
	mfaCodes: async (event) => {
		const form = await superValidate(event.request, zod4(totpCodeSchema), { id: FORM_IDS.codes });
		const code = form.data.code;

		form.data.code = '';

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			const backupCodes = await regenerateBackupCodes(actorFromEvent(event), { code });

			return { form, backupCodes };
		} catch (failure) {
			return asFormError(form, failure);
		}
	}
};

/**
 * Предметная ошибка показывается над той формой, из которой пришла: поля, к
 * которому её можно отнести, у неё нет, а угадывать поле по тексту сообщения
 * значит сломаться на первой же правке текста. Отказ по правам выведен из этого
 * правила — он не претензия к заполнению и правкой полей не поправляется,
 * поэтому уходит своим кодом.
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
