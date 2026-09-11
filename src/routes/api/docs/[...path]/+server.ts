import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { docsHeaders, docsUnauthorized, readDocsAsset } from '$lib/server/api/docs';

/** Файлы Swagger UI. Отдаются локально и только вошедшему пользователю. */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (locals.user === null) {
		return docsUnauthorized();
	}

	const asset = await readDocsAsset(params.path);
	if (asset === null) {
		error(404, 'Файл документации не найден');
	}

	return new Response(asset.body, { headers: docsHeaders(asset.contentType) });
};
