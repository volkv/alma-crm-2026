/**
 * «Договоры и лицензии»: договор контрагента с позициями, лицензии и их
 * передача по акту. Работа с вузом держится на нём целиком, у юридического лица
 * договор называет шапка карточки.
 */
import type { DocumentTemplateKey } from '$lib/contracts/documents';
import { defineModule } from '$lib/platform/define';

/** Шаблоны, которые собираются по договору с позициями, — сублицензия и акт передачи. */
const TEMPLATES = ['sublicense', 'handover_act'] as const satisfies readonly DocumentTemplateKey[];

export default defineModule({
	key: 'contracts',
	label: 'Договоры и лицензии',
	description:
		'Договор контрагента с позициями и лицензиями, их передача по акту и сублицензионный договор по шаблону',
	panels: [
		{
			key: 'contract',
			label: 'Договор с позициями и лицензиями',
			hint: 'Договор контрагента, выбранные позиции, лицензии и их передача',
			order: 20
		}
	],
	headerFacts: [{ key: 'contract', label: 'Договор', shapes: ['institution', 'company'] }],
	cardActions: [],
	sections: [],
	documents: { templates: TEMPLATES, kinds: [] },
	// Стадия, которую подтверждает отметка на сублицензии или акте передачи, без
	// договора с позициями не закрыть: документ собирается из его строк.
	requiredByStage: (stage) =>
		stage.requiresDocumentTemplate !== null &&
		(TEMPLATES as readonly string[]).includes(stage.requiresDocumentTemplate)
});
