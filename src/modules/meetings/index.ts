/**
 * «Встречи»: назначенная встреча сохраняется в деле и уходит участникам письмом
 * с приглашением в календарь (или файлом .ics для скачивания) — из меню
 * карточки и кнопкой у пункта чек-листа, которому процесс выбрал действие
 * `meetings:invite`. Перенос обновляет то же событие, отмена его убирает.
 */
import { defineModule } from '$lib/platform/define';

export default defineModule({
	key: 'meetings',
	label: 'Встречи',
	description:
		'Дата и место встречи в деле, приглашение контактам стороны и коллегам письмом с событием календаря, перенос и отмена',
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
