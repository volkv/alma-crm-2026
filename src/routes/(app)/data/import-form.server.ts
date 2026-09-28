import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { wantsCreate } from '$lib/components/create-dialog/open-param';
import { STAT_FILE_FORMATS_HINT } from '$lib/contracts/stats';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent, type ActorContext } from '$lib/server/actor';
import { toActionFailure } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { createSnapshot } from '$lib/server/stats/import';

/**
 * Окно «Загрузка данных» живёт на странице списка снимков: отдельной
 * страницы у формы нет. Здесь — то, что окну нужно от сервера, и сама
 * команда загрузки.
 *
 * Форма не на superforms: файл выгрузки едет обычным multipart, а поля
 * рядом с ним — строки, которые проверяет сервис загрузки.
 */

/** Значения формы, которые возвращаются вместе с отказом: ввод не теряется. */
export type ImportFormValues = {
	source: string;
	mode: string;
	periodKind: string;
	periodStart: string;
	periodEnd: string;
	note: string;
};

/** Что возвращает отказ загрузки: окно показывает его, не закрываясь. */
export type ImportFormFailure = {
	message: string;
	issues: string[];
	values: ImportFormValues;
};

/**
 * Учебный год, в котором мы сейчас: с 1 сентября по 31 августа. Это только
 * подсказка формы — период всё равно называет человек, потому что выгрузка
 * бывает и за прошлый год.
 */
function currentAcademicYear(): { start: string; end: string } {
	const today = formatIsoDay();
	const year = Number(today.slice(0, 4));
	const startYear = today.slice(5) >= '09-01' ? year : year - 1;

	return { start: `${startYear}-09-01`, end: `${startYear + 1}-08-31` };
}

function text(data: FormData, name: string): string {
	const value = data.get(name);

	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Данные окна загрузки. `null` — загружать нельзя: окно, которое рисует форму
 * и отказывает только на отправке, тратит время человека впустую, поэтому без
 * права нет и кнопки.
 */
export function loadImportForm(event: RequestEvent, ctx: ActorContext) {
	if (!can(ctx, 'stats.import')) {
		return null;
	}

	const period = currentAcademicYear();

	return {
		values: {
			source: 'file',
			mode: 'full',
			periodKind: 'academic',
			periodStart: period.start,
			periodEnd: period.end,
			note: ''
		} satisfies ImportFormValues,
		/** Открыть окно сразу: пришли по ссылке `?create` с другого экрана. */
		openOnLoad: wantsCreate(event.url)
	};
}

/** Команда загрузки: после неё — сразу в мастер сопоставления колонок. */
export async function importFileAction(event: RequestEvent) {
	const data = await event.request.formData();
	const values: ImportFormValues = {
		source: text(data, 'source'),
		mode: text(data, 'mode'),
		periodKind: text(data, 'periodKind'),
		periodStart: text(data, 'periodStart'),
		periodEnd: text(data, 'periodEnd'),
		note: text(data, 'note')
	};

	const file = data.get('file');

	if (!(file instanceof File) || file.size === 0) {
		return fail(400, {
			message: 'Выберите файл выгрузки',
			issues: [STAT_FILE_FORMATS_HINT],
			values
		} satisfies ImportFormFailure);
	}

	let snapshotId: string;

	try {
		// Право проверяет сервис: скрытая кнопка — удобство, а не защита.
		const snapshot = await createSnapshot(actorFromEvent(event), {
			source: values.source,
			mode: values.mode,
			periodKind: values.periodKind,
			periodStart: values.periodStart,
			periodEnd: values.periodEnd,
			note: values.note === '' ? null : values.note,
			file: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
		});

		snapshotId = snapshot.id;
	} catch (error) {
		const failure = toActionFailure(error);

		// Значения возвращаются вместе с отказом: заполнять форму заново
		// из-за неверной даты — это наказание за опечатку.
		return fail(failure.status, { ...failure.data, values } satisfies ImportFormFailure);
	}

	redirect(303, resolve('/(app)/data/[id=uuid]/mapping', { id: snapshotId }));
}
