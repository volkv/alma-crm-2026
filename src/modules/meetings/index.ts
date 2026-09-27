/**
 * «Встречи»: приглашение участников на встречу файлом для календаря — из меню
 * карточки и у пункта чек-листа «Встреча назначена».
 */
import { defineModule } from '$lib/platform/define';

export default defineModule({
	key: 'meetings',
	label: 'Встречи',
	description: 'Приглашение контактов стороны на встречу файлом для календаря',
	panels: [],
	headerFacts: [],
	cardActions: [
		{
			key: 'invite',
			label: 'Пригласить на встречу',
			requires: 'edit',
			deniedReason: 'Нет права менять взаимодействие',
			menu: true,
			checklistItems: ['meeting_scheduled'],
			checklistHint: 'Файл приглашения для календаря; отметьте пункт, когда встреча назначена.'
		}
	],
	sections: [],
	documents: { templates: [], kinds: [] },
	requiredByStage: null
});
