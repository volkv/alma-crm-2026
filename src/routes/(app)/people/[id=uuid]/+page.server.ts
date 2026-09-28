import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import {
	endAffiliationSchema,
	recordConsentSchema,
	setRetentionSchema,
	withdrawConsentSchema
} from '$lib/contracts/directory';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { getPerson, listPersonAffiliations } from '$lib/server/directory/read';
import { endAffiliation } from '$lib/server/directory/write';
import { formatIsoDay } from '$lib/format';
import { toActionFailure, toPageError } from '$lib/server/http';
import { listConsents, recordConsent, withdrawConsent } from '$lib/server/people/consents';
import { anonymizePerson, setRetention } from '$lib/server/people/retention';
import { can } from '$lib/server/rbac';
import { createAffiliationAction, loadCreateAffiliation } from './create-affiliation.server';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

/**
 * Почему уничтожить данные нельзя — словами и с сервера.
 *
 * Приговор выносит право, интерфейс его показывает: второго свода правил на
 * клиенте нет. Демонстрации причина называется своя — там дело не в роли, под
 * которой вошли, а в том, что стенд общий и стёртого на нём никто не вернёт.
 */
function anonymizeDenial(ctx: ActorContext): string | null {
	if (can(ctx, 'people.anonymize')) {
		return null;
	}

	return ctx.user?.isDemo === true
		? 'Уничтожение данных на демонстрационном стенде закрыто: он общий, а обезличивание необратимо — стёртого не увидит и следующий посетитель.'
		: 'Права на уничтожение данных у вас нет: его выдают отдельно от учёта согласий, потому что отменить обезличивание нельзя.';
}

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);
	// Учёт согласий — отдельное право: карточку контакта открывают все, кто
	// работает с процессом, а основания обработки данных ведут не они.
	const managesPii = can(ctx, 'people.manage_consents');

	try {
		const [person, affiliations, consents, createAffiliation] = await Promise.all([
			getPerson(ctx, event.params.id),
			listPersonAffiliations(ctx, event.params.id),
			managesPii ? listConsents(ctx, event.params.id) : [],
			loadCreateAffiliation(event, ctx, event.params.id)
		]);

		const denial = anonymizeDenial(ctx);

		return {
			person,
			affiliations,
			consents,
			canWrite: can(ctx, 'people.write'),
			managesPii,
			// Уничтожение — не то же самое, что учёт согласий: панель видна по
			// одному праву, а кнопка в ней живёт по другому.
			anonymize: { allowed: denial === null, reason: denial },
			// Полномочия закрывают сегодняшним днём по Москве — по нему живёт процесс.
			today: formatIsoDay(),
			/** Окно «Добавить роль»; `null` — назначать роли нельзя. */
			createAffiliation
		};
	} catch (error) {
		toPageError(error);
	}
};

/** Поля формы в объекте, пригодном для схемы контракта. */
function fields(data: FormData): Record<string, unknown> {
	return Object.fromEntries(data);
}

/** Переход обратно на карточку с кодом сообщения для тоста. */
function done(event: RequestEvent, code: string): never {
	redirect(303, `${resolve('/(app)/people/[id=uuid]', { id: event.params.id })}?done=${code}`);
}

export const actions: Actions = {
	createAffiliation: createAffiliationAction,

	endAffiliation: async (event) => {
		const parsed = endAffiliationSchema.safeParse(
			Object.fromEntries(await event.request.formData())
		);

		if (!parsed.success) {
			return fail(400, {
				message: 'Полномочия не закрыты',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await endAffiliation(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		done(event, 'affiliation_ended');
	},

	setRetention: async (event) => {
		const parsed = setRetentionSchema.safeParse({
			...fields(await event.request.formData()),
			personId: event.params.id
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Срок хранения не сохранён',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await setRetention(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		done(event, 'retention_changed');
	},

	recordConsent: async (event) => {
		const parsed = recordConsentSchema.safeParse({
			...fields(await event.request.formData()),
			personId: event.params.id
		});

		if (!parsed.success) {
			return fail(400, {
				message: 'Согласие не зафиксировано',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await recordConsent(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		done(event, 'consent_recorded');
	},

	withdrawConsent: async (event) => {
		const parsed = withdrawConsentSchema.safeParse(fields(await event.request.formData()));

		if (!parsed.success) {
			return fail(400, {
				message: 'Согласие не отозвано',
				issues: parsed.error.issues.map((issue) => issue.message)
			});
		}

		try {
			await withdrawConsent(actorFromEvent(event), parsed.data);
		} catch (error) {
			return toActionFailure(error);
		}

		done(event, 'consent_withdrawn');
	},

	anonymize: async (event) => {
		try {
			await anonymizePerson(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		done(event, 'anonymized');
	}
};
