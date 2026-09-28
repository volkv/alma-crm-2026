import { fail } from '@sveltejs/kit';
import { academicYearOf, rankingPlaceOf } from '$lib/contracts/ranking';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import {
	addProgramMaterials,
	listProgramMaterialViews,
	removeProgramMaterial
} from '$lib/server/directory/program-materials';
import { getProgram } from '$lib/server/directory/read';
import { run, text } from '$lib/server/forms';
import { toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getRanking } from '$lib/server/stats/ranking';
import { createVersionAction, loadCreateVersionForm } from './create-version-form.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const detail = await getProgram(ctx, event.params.id);
		// Окно версии собирается после чтения карточки: чужая или несуществующая
		// программа отказывает раньше, чем для неё готовится форма.
		const createVersion = await loadCreateVersionForm(event, ctx, detail.program.id);
		const materials = await listProgramMaterialViews(ctx, detail.program.id);

		// Место в рейтинге — за текущий учебный год и только тому, кто видит
		// данные об обучении: рейтинг считается по его области доступа.
		const ranking = can(ctx, 'stats.read')
			? await getRanking(ctx, academicYearOf(formatIsoDay()))
			: null;

		return {
			...detail,
			materials,
			canWrite: can(ctx, 'programs.write'),
			/** Окно «Новая версия»; `null` — менять программу нельзя. */
			createVersion,
			ranking:
				ranking === null
					? null
					: { period: ranking.period, place: rankingPlaceOf(ranking.programs, event.params.id) }
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	createVersion: createVersionAction,

	/** Один или несколько файлов материалов: проходят все вместе или ни один. */
	uploadMaterials: async (event) => {
		const data = await event.request.formData();
		const files = data
			.getAll('files')
			.filter((file): file is File => file instanceof File && file.size > 0);

		if (files.length === 0) {
			return fail(400, { message: 'Выберите файлы материалов', issues: [] as string[] });
		}

		const materials = await Promise.all(
			files.map(async (file) => ({
				name: file.name,
				mime: file.type,
				bytes: new Uint8Array(await file.arrayBuffer())
			}))
		);

		return run(() => addProgramMaterials(actorFromEvent(event), event.params.id, materials));
	},

	/** Снимает материал с программы; файл остаётся в хранилище и в журнале. */
	removeMaterial: async (event) => {
		const data = await event.request.formData();

		return run(() =>
			removeProgramMaterial(actorFromEvent(event), event.params.id, text(data, 'documentId') ?? '')
		);
	}
};
