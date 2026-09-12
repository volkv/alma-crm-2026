import { redirect } from '@sveltejs/kit';
import { fail, message, superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';
import { resolve } from '$app/paths';
import { createProgramVersionSchema } from '$lib/contracts/directory';
import { actorFromEvent } from '$lib/server/actor';
import { getProgram } from '$lib/server/directory/read';
import { addProgramVersion } from '$lib/server/directory/write';
import { ConflictError, ValidationError } from '$lib/server/errors';
import { formatIsoDay } from '$lib/format';
import { toActionFailure, toPageError } from '$lib/server/http';
import { requirePermission } from '$lib/server/rbac';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const ctx = actorFromEvent(event);

	try {
		requirePermission(ctx, 'programs.write');
		const { program, versions } = await getProgram(ctx, event.params.id);

		return {
			program,
			nextVersion: (versions[0]?.version ?? 0) + 1,
			form: await superValidate(
				{
					programId: program.id,
					effectiveFrom: formatIsoDay()
				},
				zod4(createProgramVersionSchema),
				{ errors: false }
			)
		};
	} catch (error) {
		toPageError(error);
	}
};

export const actions: Actions = {
	default: async (event) => {
		const form = await superValidate(event.request, zod4(createProgramVersionSchema));

		if (!form.valid) {
			return fail(400, { form });
		}

		try {
			await addProgramVersion(actorFromEvent(event), {
				...form.data,
				programId: event.params.id
			});
		} catch (error) {
			if (error instanceof ConflictError || error instanceof ValidationError) {
				return message(
					form,
					{ text: error.message },
					{
						status: error instanceof ConflictError ? 409 : 400
					}
				);
			}

			return toActionFailure(error);
		}

		redirect(
			303,
			`${resolve('/(app)/programs/[id=uuid]', { id: event.params.id })}?done=version_created`
		);
	}
};
