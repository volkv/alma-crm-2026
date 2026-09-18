/**
 * Сброс демонстрационных данных по расписанию.
 *
 * Стенд один на всех, и показывают его без предупреждения: зритель, открывший
 * ссылку вечером, должен увидеть тот же набор данных, по которому написан
 * сценарий, а не то, что наработал предыдущий. Кнопка в `/settings/general`
 * этого не решает — нажать её некому.
 *
 * Почему не в общем цикле интеграций (`integrations/pump.ts`). Тот проход берёт
 * один замок на всю фоновую работу и держит его, пока идёт доставка вебхуков,
 * очередь обмена и наблюдатель зависших взаимодействий. Сброс — это `TRUNCATE`
 * и полная заливка сида, то есть минуты: под общим замком он остановил бы обмен
 * ровно настолько же. Поэтому у сброса свой таймер, свой ключ в Redis и своя
 * отметка о выполненных сутках.
 *
 * Актор — системный (`systemActor`): проверку `settings.write` внутри
 * `resetDemoData` он проходит по признаку источника, как и остальная фоновая
 * работа (`src/lib/server/rbac/index.ts`, `can()`). Обхода проверки здесь нет —
 * та же функция, что зовёт кнопка, с тем же правом и той же записью в журнал.
 */
import { randomUUID } from 'node:crypto';
import type { SettingValue } from '$lib/contracts/settings';
import { systemActor } from '../actor';
import { getConfig } from '../config';
import { getRedis } from '../redis';
import { getSetting } from '../settings';
import { resetDemoData } from './reset';

/** Отметка «за какие сутки сброс уже выполнен». */
const LAST_DAY_KEY = 'lct:demo:reset:day';

/**
 * Сколько живёт отметка. Дольше суток — иначе она истекла бы внутри тех самых
 * суток, за которые стоит, и сброс прошёл бы второй раз; но не вечно, чтобы
 * выключенное расписание не оставляло за собой ключ навсегда.
 */
const LAST_DAY_TTL_SECONDS = 36 * 60 * 60;

/**
 * Занять сутки: отметка ставится, только если стоит не та дата. Одной командой,
 * потому что процессов приложения может быть несколько, а сброс за эти сутки
 * должен пройти один раз.
 */
const CLAIM_DAY = `
	if redis.call('get', KEYS[1]) == ARGV[1] then
		return 0
	end
	redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
	return 1
`;

/**
 * Календарный день по часам сервера — тот вид, в котором он лежит отметкой.
 *
 * Часы сервера, а не Москва: у фонового прохода нет ни запроса, ни человека, из
 * которых можно было бы взять пояс, и расписание в настройках так и названо —
 * «по часам сервера».
 */
export function serverDay(now: Date): string {
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	const day = `${now.getDate()}`.padStart(2, '0');

	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * За какие сутки сброс пора выполнить прямо сейчас; `null` — не пора.
 *
 * Правило целиком: расписание включено, назначенный час уже наступил, и за эти
 * сутки сброса ещё не было. Час — нижняя граница, а не точный момент: приложение
 * могло не работать в три часа ночи, и стенд, поднятый в десять утра, всё равно
 * обязан начать показ с эталонного набора. Следующий сброс придёт уже в
 * следующие сутки — отметка стоит за эти.
 */
export function dueResetDay(
	schedule: SettingValue<'demo_reset_schedule'>,
	now: Date,
	lastDay: string | null
): string | null {
	if (!schedule.enabled) {
		return null;
	}

	if (now.getHours() < schedule.hour) {
		return null;
	}

	const today = serverDay(now);

	return lastDay === today ? null : today;
}

/**
 * Один проход расписания. Возвращает `true`, если сброс действительно прошёл.
 *
 * Отметка ставится **до** сброса, а не после: упавший сброс не должен
 * повторяться каждую минуту до конца суток — `TRUNCATE` и заливка сида стоят
 * слишком дорого, чтобы пробовать их в цикле. След неудачи остаётся в логе
 * сервера, а показ чинят кнопкой.
 */
export async function runDemoResetCycle(now: Date = new Date()): Promise<boolean> {
	// Вне демонстрационного стенда расписания нет: там данные принадлежат
	// организации, и эталона, к которому их возвращать, не существует.
	if (!getConfig().DEMO_MODE) {
		return false;
	}

	const schedule = await getSetting('demo_reset_schedule');
	const redis = getRedis();
	const day = dueResetDay(schedule, now, await redis.get(LAST_DAY_KEY));

	if (day === null) {
		return false;
	}

	const claimed = await redis.eval(CLAIM_DAY, 1, LAST_DAY_KEY, day, String(LAST_DAY_TTL_SECONDS));

	// Сутки занял соседний процесс: сброс за них уже идёт или прошёл.
	if (claimed !== 1) {
		return false;
	}

	await resetDemoData(systemActor(randomUUID()), 'schedule');

	return true;
}

/**
 * Как часто таймер смотрит на часы. Минуты хватает: расписание задано часом
 * суток, и точность в пределах минуты для ночного сброса стенда — это точность
 * с запасом.
 */
const TICK_SECONDS = 60;

/**
 * Таймер расписания. Запускается один раз при старте сервера, рядом с циклом
 * интеграций (`src/hooks.server.ts`).
 *
 * Цепочка `setTimeout`, а не `setInterval`: следующий срок считается после
 * прохода, и два прохода не наезжают друг на друга, даже когда заливка идёт
 * дольше минуты. В прогоне Vitest не стартует — модуль там импортируют ради
 * функций, а незакрытый таймер держал бы процесс живым после конца проверок.
 */
export function startDemoResetTimer(): void {
	if (process.env.VITEST !== undefined) {
		return;
	}

	const schedule = (): void => {
		// Таймер не должен держать процесс: остановка сервера не обязана ждать
		// следующего взгляда на часы.
		setTimeout(() => void tick(), TICK_SECONDS * 1000).unref();
	};

	const tick = async (): Promise<void> => {
		try {
			if (await runDemoResetCycle()) {
				console.info('[demo] стенд сброшен по расписанию');
			}
		} catch (error) {
			// У фоновой работы нет адресата, кроме лога сервера. Молча пропавший
			// сброс означал бы показ на чужих данных, и узнать о нём было бы негде.
			console.error('[demo] сброс по расписанию не удался', error);
		}

		schedule();
	};

	schedule();
}
