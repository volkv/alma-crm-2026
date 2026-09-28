import type { MyDayKind } from '$lib/contracts/my-day';

/** Подмножество тонов `StatusBadge`: выделенного (`accent`) и успеха здесь нет. */
export type MyDayTone = 'danger' | 'warning' | 'info' | 'neutral';

/**
 * Как разделы «Моего дня» выглядят на главной: короткое имя для счётчика и
 * тон.
 *
 * Полное название раздела и подсказка к действию — в контракте
 * (`$lib/contracts/my-day`), их же читает утреннее письмо. Здесь только то,
 * что нужно экрану и чего в письме нет: счётчик в ряд из восьми не вмещает
 * «Срок стадии сегодня или завтра».
 *
 * Тон — по срочности, а не по разделу: красным горит только то, что уже
 * сорвано, жёлтым — что вот-вот сорвётся или стоит на месте из-за помехи.
 * Остальное нейтрально, иначе на экране не остаётся спокойного фона, на
 * котором видно тревожное.
 */
export const MY_DAY_KIND_VIEW: Record<MyDayKind, { short: string; tone: MyDayTone }> = {
	unassigned: { short: 'Без ответственного', tone: 'warning' },
	overdue: { short: 'Просрочено', tone: 'danger' },
	due_soon: { short: 'Срок до завтра', tone: 'warning' },
	blocker: { short: 'Помехи', tone: 'warning' },
	stuck: { short: 'Зависли', tone: 'neutral' },
	waiting: { short: 'Ждём сторону', tone: 'neutral' },
	application: { short: 'Новые заявки', tone: 'info' },
	license: { short: 'Лицензии', tone: 'neutral' }
};

/** Якорь карточки раздела: к нему ведёт счётчик наверху. */
export function myDayAnchor(kind: MyDayKind): string {
	return `my-day-${kind}`;
}
