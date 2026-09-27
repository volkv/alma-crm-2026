/** Договор в карточке: панель с позициями и лицензиями и факт в шапке. */
import { defineCardUi } from '$lib/platform/card-ui';
import manifest from './index';
import ContractFact from './ui/contract-fact.svelte';
import ContractPanel from './ui/contract-panel.svelte';

export default defineCardUi(manifest, {
	panels: { contract: ContractPanel },
	headerFacts: { contract: ContractFact },
	dialogs: null
});
