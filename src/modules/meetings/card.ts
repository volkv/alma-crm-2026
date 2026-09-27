/** «Встречи» в карточке: своих панелей и фактов шапки нет, только диалог приглашения. */
import { defineCardUi } from '$lib/platform/card-ui';
import manifest from './index';
import InviteDialog from './ui/invite-dialog.svelte';

export default defineCardUi(manifest, {
	panels: {},
	headerFacts: {},
	dialogs: InviteDialog
});
