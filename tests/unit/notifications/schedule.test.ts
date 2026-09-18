/**
 * Когда напоминать снова.
 *
 * Правило одно на наблюдателя и на кнопку «Повторить», и всё, что в нём есть, —
 * числа: шаг повтора, дно этого шага, задержка после отказа и предел попыток.
 * Числа и проверяются числами, без базы и без почтового сервера.
 */
import { describe, expect, it } from 'vitest';
import {
	FAILURE_RETRY_MINUTES,
	MAX_ATTEMPTS,
	MIN_REPEAT_DAYS,
	nextNotifyAt,
	repeatAfterMs
} from '$lib/server/notifications/schedule';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-18T10:00:00.000Z');

describe('шаг повтора', () => {
	it('равен порогу', () => {
		expect(repeatAfterMs(7)).toBe(7 * DAY_MS);
		expect(repeatAfterMs(30)).toBe(30 * DAY_MS);
	});

	it('не опускается ниже суток даже при нулевом пороге', () => {
		// Нулевой шаг означал бы письмо на каждый проход цикла — раз в пятнадцать
		// секунд. Это не напоминание, а рассылка в чужой почтовый ящик.
		expect(repeatAfterMs(0)).toBe(MIN_REPEAT_DAYS * DAY_MS);
	});

	it('отказывается считать шаг от бессмысленного порога', () => {
		expect(() => repeatAfterMs(-1)).toThrowError(RangeError);
		expect(() => repeatAfterMs(1.5)).toThrowError(RangeError);
	});
});

describe('момент следующего напоминания', () => {
	it('после отправки отодвигается на шаг повтора', () => {
		const next = nextNotifyAt({ status: 'sent', attempts: 1 }, 7, NOW);

		expect(next).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
	});

	it('после пропуска — тоже: незаполненную иерархию однажды заполнят', () => {
		const next = nextNotifyAt({ status: 'skipped', attempts: 0 }, 3, NOW);

		expect(next).toEqual(new Date(NOW.getTime() + 3 * DAY_MS));
	});

	it('после отказа — через час, а не через неделю', () => {
		// Недоступный почтовый сервер не повод откладывать напоминание на срок
		// порога: авария кончится раньше, чем стадия сменится.
		const next = nextNotifyAt({ status: 'failed', attempts: 1 }, 7, NOW);

		expect(next).toEqual(new Date(NOW.getTime() + FAILURE_RETRY_MINUTES * 60 * 1000));
	});

	it('после исчерпания попыток перестаёт повторять сам', () => {
		expect(nextNotifyAt({ status: 'failed', attempts: MAX_ATTEMPTS }, 7, NOW)).toBeNull();
		expect(nextNotifyAt({ status: 'failed', attempts: MAX_ATTEMPTS - 1 }, 7, NOW)).not.toBeNull();
	});
});
