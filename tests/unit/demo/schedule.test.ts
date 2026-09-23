import { describe, expect, it } from 'vitest';
import { dueResetDay, serverDay } from '$lib/server/demo/schedule';

/**
 * «Пора ли сбрасывать стенд» — чистое правило о часах и сутках, и проверяется
 * оно числами, без Redis и без базы.
 */

/** Момент по часам сервера: расписание считает именно по ним. */
function at(day: string, hour: number, minute = 0): Date {
	const [year, month, date] = day.split('-').map(Number);

	return new Date(year, month - 1, date, hour, minute);
}

const ON = { enabled: true, hour: 3 } as const;

describe('расписание сброса демонстрационного стенда', () => {
	it('выключенное расписание не наступает никогда', () => {
		expect(dueResetDay({ enabled: false, hour: 3 }, at('2026-09-18', 23, 59), null)).toBeNull();
	});

	it('до назначенного часа не наступает, с его началом — наступает', () => {
		expect(dueResetDay(ON, at('2026-09-18', 2, 59), null)).toBeNull();
		expect(dueResetDay(ON, at('2026-09-18', 3, 0), null)).toBe('2026-09-18');
	});

	it('за те же сутки второй раз не наступает', () => {
		const day = dueResetDay(ON, at('2026-09-18', 3, 0), null);

		expect(day).toBe('2026-09-18');
		expect(dueResetDay(ON, at('2026-09-18', 3, 1), day)).toBeNull();
		expect(dueResetDay(ON, at('2026-09-18', 23, 59), day)).toBeNull();
	});

	it('следующие сутки наступают заново', () => {
		expect(dueResetDay(ON, at('2026-09-19', 2, 59), '2026-09-18')).toBeNull();
		expect(dueResetDay(ON, at('2026-09-19', 3, 0), '2026-09-18')).toBe('2026-09-19');
	});

	it('пропущенный час догоняется в те же сутки', () => {
		// Приложение могло не работать в три часа ночи. Стенд, поднятый утром,
		// всё равно обязан начать показ с эталонного набора.
		expect(dueResetDay(ON, at('2026-09-18', 10, 30), '2026-09-17')).toBe('2026-09-18');
	});

	it('полночь как назначенный час — это начало суток, а не их конец', () => {
		const midnight = { enabled: true, hour: 0 } as const;

		expect(dueResetDay(midnight, at('2026-09-18', 0, 0), '2026-09-17')).toBe('2026-09-18');
		expect(dueResetDay(midnight, at('2026-09-17', 23, 59), '2026-09-17')).toBeNull();
	});

	it('отметка суток — календарный день по часам сервера', () => {
		expect(serverDay(at('2026-09-01', 0, 0))).toBe('2026-09-01');
		expect(serverDay(at('2026-12-31', 23, 59))).toBe('2026-12-31');
	});
});
