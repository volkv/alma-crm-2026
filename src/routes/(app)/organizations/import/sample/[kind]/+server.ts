import { error } from '@sveltejs/kit';
import { DIRECTORY_IMPORT_KINDS, type DirectoryImportKind } from '$lib/contracts/directory-import';
import { actorFromEvent } from '$lib/server/actor';
import { importSample } from '$lib/server/directory/import-sample';
import { toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { RequestHandler } from './$types';

const FILE_NAMES: Record<DirectoryImportKind, string> = {
	catalog: 'catalog-sample.xlsx',
	vendors: 'vendors-sample.xlsx'
};

/** Образец файла загрузки — тем, кто вправе загружать справочник. */
export const GET: RequestHandler = async (event) => {
	try {
		requirePermission(actorFromEvent(event), 'directory.import');
	} catch (cause) {
		toPageError(cause);
	}

	const kind = DIRECTORY_IMPORT_KINDS.find((known) => known === event.params.kind);

	if (kind === undefined) {
		error(404, { message: 'Такого образца нет' });
	}

	return new Response(new Uint8Array(importSample(kind)), {
		headers: {
			'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'content-disposition': `attachment; filename="${FILE_NAMES[kind]}"`
		}
	});
};
