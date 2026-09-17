/**
 * Московский календарь — единица времени всего продукта.
 *
 * Сутки здесь начинаются в один и тот же заранее известный момент: смещение
 * Москвы постоянно с 2014 года, поэтому граница дня считается арифметикой, а не
 * таблицей часовых поясов; вернётся перевод часов — учитывать его придётся
 * здесь и только здесь.
 *
 * Модуль намеренно крошечный и ни от чего не зависит: его импортируют и
 * страницы, и писатели книг, и разбор фильтра, а расхождение копий одной
 * константы — это расхождение чисел на экране с числами в файле, и происходит
 * оно молча.
 */

const MOSCOW_OFFSET_HOURS = 3;

/** Смещение в миллисекундах — для арифметики суток. */
export const MOSCOW_OFFSET_MS = MOSCOW_OFFSET_HOURS * 60 * 60 * 1000;

/** То же смещение суффиксом ISO-момента: `2026-10-01T00:00:00+03:00`. */
export const MOSCOW_OFFSET = `+0${MOSCOW_OFFSET_HOURS}:00`;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Момент начала календарного дня `2026-10-01` по московскому календарю. */
export function moscowDayStart(day: string): Date {
	const parsed = Date.parse(`${day}T00:00:00.000Z`);

	if (Number.isNaN(parsed)) {
		throw new RangeError(`Не удалось разобрать день: ${day}`);
	}

	return new Date(parsed - MOSCOW_OFFSET_MS);
}

/**
 * Момент среза `T` — начало суток, следующих за днём «по». Срез показывает
 * состояние в последний момент дня «по», а событие ровно в `T` относится уже к
 * следующим суткам.
 */
export function snapshotMoment(to: string): Date {
	return new Date(moscowDayStart(to).getTime() + DAY_MS);
}

/** Календарный день момента по московскому календарю. */
export function moscowDay(value: Date): string {
	return new Date(value.getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}
