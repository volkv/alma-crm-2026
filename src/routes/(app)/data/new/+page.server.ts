import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { STAT_FILE_FORMATS_HINT } from '$lib/contracts/stats';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { toActionFailure } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import { createSnapshot } from '$lib/server/stats/import';
import type { Actions, PageServerLoad } from './$types';

/** Значения формы, которые возвращаются вместе с отказом: ввод не теряется. */
type FormValues = {
	source: string;
	mode: string;
	periodKind: string;
	periodStart: string;
	periodEnd: string;
	note: string;
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

export const load: PageServerLoad = async (event) => {
	// Право проверяется и здесь, и в сервисе: страница, которая рисует форму и
	// отказывает только на отправке, тратит время человека впустую.
	requirePermission(actorFromEvent(event), 'stats.import');

	const period = currentAcademicYear();

	return {
		values: {
			source: 'file',
			mode: 'full',
			periodKind: 'academic',
			periodStart: period.start,
			periodEnd: period.end,
			note: ''
		} satisfies FormValues
	};
};

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const values: FormValues = {
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
			});
		}

		let snapshotId: string;

		try {
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
			return fail(failure.status, { ...failure.data, values });
		}

		redirect(303, resolve('/(app)/data/[id=uuid]/mapping', { id: snapshotId }));
	}
};
