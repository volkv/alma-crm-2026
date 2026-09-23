import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { catalogListQuerySchema } from '$lib/contracts/directory';
import { academicYearOf, rankingPlaceOf } from '$lib/contracts/ranking';
import { formatIsoDay } from '$lib/format';
import { actorFromEvent } from '$lib/server/actor';
import { getDirection, listProducts } from '$lib/server/directory/read';
import {
	archiveDirection,
	linkProductDirection,
	restoreDirection,
	unlinkProductDirection
} from '$lib/server/directory/write';
import { toActionFailure, toPageError } from '$lib/server/http';
import { can } from '$lib/server/rbac';
import { getRanking } from '$lib/server/stats/ranking';
import type { Actions, PageServerLoad } from './$types';

/** Каталог продуктов для формы привязки: действующие, одной страницей. */
const productPage = catalogListQuerySchema.parse({ status: 'active', pageSize: 100 });

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		const detail = await getDirection(ctx, event.params.id);

		// Каталог продуктов нужен только форме привязки: без права на запись её
		// никто не увидит, и читать каталог незачем.
		const canWrite = can(ctx, 'directions.write');
		const linked = new Set(detail.products.map((product) => product.id));

		// Уже привязанные в списке не предлагаются: повторная связь всё равно
		// отвечает конфликтом, а выбор, который нельзя применить, — не выбор.
		const productOptions = canWrite
			? (await listProducts(ctx, productPage)).items
					.filter((product) => !linked.has(product.id))
					.map((product) => ({ id: product.id, label: `${product.code} — ${product.name}` }))
			: [];

		// Место в рейтинге направлений — за текущий учебный год и только тому,
		// кто видит данные об обучении: рейтинг считается по его области доступа.
		const ranking = can(ctx, 'stats.read')
			? await getRanking(ctx, academicYearOf(formatIsoDay()))
			: null;

		return {
			...detail,
			canWrite,
			productOptions,
			ranking:
				ranking === null
					? null
					: { period: ranking.period, place: rankingPlaceOf(ranking.directions, event.params.id) }
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	archive: async (event) => {
		try {
			await archiveDirection(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(303, `${resolve('/(app)/directions')}?done=archived`);
	},

	restore: async (event) => {
		try {
			await restoreDirection(actorFromEvent(event), event.params.id);
		} catch (error) {
			return toActionFailure(error);
		}

		// Возврат оставляет человека на карточке: он вернул направление, чтобы
		// тут же продолжить с ним работать, а не чтобы уйти в список.
		redirect(
			303,
			`${resolve('/(app)/directions/[id=uuid]', { id: event.params.id })}?done=restored`
		);
	},

	linkProduct: async (event) => {
		const productId = (await event.request.formData()).get('productId');

		if (typeof productId !== 'string' || productId === '') {
			return fail(400, { message: 'Не выбран продукт', issues: [] });
		}

		try {
			await linkProductDirection(actorFromEvent(event), {
				directionId: event.params.id,
				productId
			});
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/directions/[id=uuid]', { id: event.params.id })}?done=product_linked`
		);
	},

	unlinkProduct: async (event) => {
		const productId = (await event.request.formData()).get('productId');

		if (typeof productId !== 'string' || productId === '') {
			return fail(400, { message: 'Не указано, какой продукт отвязывать', issues: [] });
		}

		try {
			await unlinkProductDirection(actorFromEvent(event), {
				directionId: event.params.id,
				productId
			});
		} catch (error) {
			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/directions/[id=uuid]', { id: event.params.id })}?done=product_unlinked`
		);
	}
};
