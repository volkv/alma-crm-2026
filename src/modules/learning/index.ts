/**
 * «Обучение»: потоки в системе обучения, слушатели и документ об обучении.
 * Обмен с LMS остаётся сервисом ядра, модуль отвечает за то, где и кому он
 * виден.
 */
import { defineModule } from '$lib/platform/define';

export default defineModule({
	key: 'learning',
	label: 'Обучение',
	description:
		'Потоки в системе обучения и заявка на новый, списки слушателей, документ об обучении',
	panels: [
		{
			key: 'learners',
			label: 'Слушатели',
			hint: 'Сколько слушателей заявлено, зачислено, окончило и отчислено — по данным потоков',
			order: 40
		},
		{
			key: 'learning',
			label: 'Система обучения',
			hint: 'Потоки в системе обучения и заявка на новый',
			order: 50
		},
		{
			key: 'training_document',
			label: 'Документ об обучении',
			hint: 'Документы вида «Документ об обучении», приложенные к делу',
			order: 60
		}
	],
	headerFacts: [],
	cardActions: [],
	sections: [{ key: 'streams', label: 'Потоки и слушатели', permission: 'interactions.read' }],
	documents: { templates: [], kinds: ['certificate'] },
	// Стадию, которую подтверждают данными обучения, без потоков не закрыть:
	// выключенный модуль оставил бы её без кнопки «Отправить в LMS».
	requiredByStage: (stage) => stage.requiresLmsData || stage.lmsGroupPurposes !== null
});
