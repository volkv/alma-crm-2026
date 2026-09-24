import type { MyDayKind } from '$lib/contracts/my-day';

/** Подмножество тонов `StatusBadge`: выделенного (`accent`) и успеха здесь нет. */
export type MyDayTone = 'danger' | 'warning' | 'info' | 'neutral';

/**
 * Как разделы «Моего дня» выглядят на главной: короткое имя для счётчика,
 * тон и глагол кнопки у строки.
 *
 * Полное название раздела и подсказка к действию — в контракте
 * (`$lib/contracts/my-day`), их же читает утреннее письмо. Здесь только то,
 * что нужно экрану и чего в письме нет: счётчик в ряд из семи не вмещает
 * «Срок стадии сегодня или завтра», а у строки письма нет кнопки.
 *
 * Тон — по срочности, а не по разделу: красным горит только то, что уже
 * сорвано, жёлтым — что вот-вот сорвётся или стоит на месте из-за помехи.
 * Остальное нейтрально, иначе на экране не остаётся спокойного фона, на
 * котором видно тревожное.
 */
export const MY_DAY_KIND_VIEW: Record<MyDayKind, { short: string; tone: MyDayTone; verb: string }> =
	{
		overdue: { short: 'Просрочено', tone: 'danger', verb: 'Сдвинуть' },
		due_soon: { short: 'Срок до завтра', tone: 'warning', verb: 'Проверить' },
		blocker: { short: 'Помехи', tone: 'warning', verb: 'Снять' },
		stuck: { short: 'Зависли', tone: 'neutral', verb: 'Сдвинуть' },
		waiting: { short: 'Ждём сторону', tone: 'neutral', verb: 'Напомнить' },
		application: { short: 'Новые заявки', tone: 'info', verb: 'Разобрать' },
		license: { short: 'Лицензии', tone: 'neutral', verb: 'Продлить' }
	};

/** Якорь карточки раздела: к нему ведёт счётчик наверху. */
export function myDayAnchor(kind: MyDayKind): string {
	return `my-day-${kind}`;
}
