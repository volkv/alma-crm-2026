/**
 * «Встречи»: назначенная встреча сохраняется в деле и уходит участникам файлом
 * для календаря — из меню карточки и кнопкой у пункта чек-листа, которому
 * процесс выбрал действие `meetings:invite`.
 */
import { defineModule } from '$lib/platform/define';

export default defineModule({
	key: 'meetings',
	label: 'Встречи',
	description: 'Дата и место встречи в деле и приглашение контактов стороны файлом для календаря',
	panels: [],
	headerFacts: [],
	cardActions: [
		{
			key: 'invite',
			label: 'Пригласить на встречу',
			requires: 'edit',
			deniedReason: 'Нет права менять взаимодействие',
			menu: true
		}
	],
	sections: [],
	documents: { templates: [], kinds: [] },
	requiredByStage: null
});
