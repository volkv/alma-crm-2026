/**
 * Действия паспорта организации — общие для формы создания и формы правки.
 *
 * Три входа: поиск по реестру, чтение раздела `/sveden` по сайту из карточки и
 * загрузка снимка JSON. Ни один из них ничего не пишет в справочник: ответ —
 * паспорт под номером, который форма показывает диффом. Записывает принятые
 * поля обычное сохранение формы — по отметкам, которые форма присылает вместе
 * с реквизитами (`readAcceptance`).
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import {
	passportAcceptanceSchema,
	registryLookupSchema,
	siteLookupSchema,
	type IssuedPassport,
	type PassportAcceptance
} from '$lib/contracts/enrichment';
import { actorFromEvent } from '$lib/server/actor';
import { EnrichmentRefusal } from '$lib/server/enrichment/access';
import { DadataError } from '$lib/server/enrichment/dadata';
import {
	importSnapshot,
	lookupRegistry,
	lookupSite,
	SNAPSHOT_MAX_BYTES
} from '$lib/server/enrichment';
import { ValidationError } from '$lib/server/errors';
import { toActionFailure } from '$lib/server/http';

/** Имя скрытого поля формы с отметками принятых полей. */
export const PASSPORT_ACCEPTANCE_FIELD = 'passport';

type PassportFailure = { message: string; issues: string[] };

/**
 * Отказ источника — фраза над панелью: выключено, квота, поставщик не ответил,
 * никого не нашлось. Всё прочее — сбой приложения, и подменять его сообщением
 * значило бы прятать поломку от того, кто держит стенд.
 */
function asPassportFailure(error: unknown) {
	if (error instanceof EnrichmentRefusal) {
		return fail(error.status, { message: error.message, issues: [] } satisfies PassportFailure);
	}

	if (error instanceof DadataError) {
		return fail(502, { message: error.message, issues: [] } satisfies PassportFailure);
	}

	return toActionFailure(error);
}

function firstIssue(issues: readonly { message: string }[]): string {
	return issues[0]?.message ?? 'Запрос не прошёл проверку';
}

async function run(work: () => Promise<IssuedPassport>) {
	try {
		return { issued: await work() };
	} catch (error) {
		return asPassportFailure(error);
	}
}

export const passportActions = {
	passportRegistry: async (event: RequestEvent) => {
		const parsed = registryLookupSchema.safeParse({
			query: (await event.request.formData()).get('query') ?? ''
		});

		if (!parsed.success) {
			return fail(400, { message: firstIssue(parsed.error.issues), issues: [] });
		}

		return run(() => lookupRegistry(actorFromEvent(event), parsed.data.query));
	},

	passportSite: async (event: RequestEvent) => {
		const parsed = siteLookupSchema.safeParse({
			website: (await event.request.formData()).get('website') ?? ''
		});

		if (!parsed.success) {
			return fail(400, { message: firstIssue(parsed.error.issues), issues: [] });
		}

		return run(() => lookupSite(actorFromEvent(event), parsed.data.website));
	},

	passportImport: async (event: RequestEvent) => {
		const file = (await event.request.formData()).get('snapshot');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Выберите файл снимка', issues: [] });
		}

		if (file.size > SNAPSHOT_MAX_BYTES) {
			return fail(400, {
				message: `Снимок больше ${SNAPSHOT_MAX_BYTES / 1024 / 1024} МиБ — это не паспорт организации`,
				issues: []
			});
		}

		const text = await file.text();

		return run(() => importSnapshot(actorFromEvent(event), text));
	}
};

/**
 * Отметки принятых полей из тела формы. Нет поля — ничего не принималось;
 * поле есть, но не разбирается, — отказ: форма утверждает что-то, чего сервер
 * понять не может, и сохранять молча значило бы потерять происхождение.
 */
export function readAcceptance(formData: FormData): PassportAcceptance {
	const raw = formData.get(PASSPORT_ACCEPTANCE_FIELD);

	if (raw === null || raw === '') {
		return [];
	}

	let json: unknown;

	try {
		json = JSON.parse(String(raw));
	} catch {
		throw new ValidationError('Отметки принятых из источника полей не читаются');
	}

	const parsed = passportAcceptanceSchema.safeParse(json);

	if (!parsed.success) {
		throw new ValidationError('Отметки принятых из источника полей не читаются');
	}

	return parsed.data;
}
