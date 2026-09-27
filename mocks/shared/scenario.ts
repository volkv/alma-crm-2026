/**
 * Сценарий отказов имитатора (`docs/exchange-contract.md`, раздел 9).
 *
 * Тремя настройками проверяется всё, ради чего имитатор и нужен: повтор без
 * дублей (`failNext` с временным кодом), поведение на таймауте (`delayMs`) и
 * восстановление после недоступности (`mode: "offline"`). Без них пришлось бы
 * либо править код приложения ради проверки, либо ждать настоящего сбоя.
 * Четвёртая, `match`, сужает их до обращений по одному объекту: имитатор на
 * стенде один, и сломанная доставка одной заявки не должна ломать соседнюю.
 *
 * Пятая, `ttlSeconds`, даёт сценарию срок: по его истечении имитатор сам
 * возвращается в исходное состояние, как после `reset`. Имитатор на стенде
 * общий, и отказ, включённый на показе и забытый показывающим, иначе ломал бы
 * обмен всем, кто придёт после.
 *
 * Сценарий действует **только на эндпоинты контракта** — те, которыми
 * пользуется CRM. Управление имитатором обязано отвечать и тогда, когда
 * сценарий велел «отвечать 503»: иначе сценарий нечем было бы снять.
 */

export type ScenarioMode = 'normal' | 'offline';

export type ScenarioState = {
	/** Сколько ближайших обращений к эндпоинтам контракта испортить. */
	failNext: number;
	/** Каким кодом их портить. */
	status: number;
	/** Насколько задержать ответ — проверка таймаута отправителя. */
	delayMs: number;
	/** `offline` — обрывать соединение, не отвечая вовсе. */
	mode: ScenarioMode;
	/**
	 * Чьи обращения портить: подстрока пути, например ключ одной заявки.
	 * `null` — любые. Нужно там, где имитатор один, а показывают на нём разное:
	 * «сломай доставку этой заявки» не должно ломать соседнюю.
	 */
	match: string | null;
	/**
	 * Когда сценарий кончится сам (ISO-время): с этого момента имитатор
	 * работает так, будто ему прислали `reset`. `null` — срока нет.
	 */
	expiresAt: string | null;
};

export type Scenario = {
	read: () => ScenarioState;
	/**
	 * Применить тело `POST /__scenario`. Разбор строгий: неизвестное поле —
	 * отказ, иначе опечатка в названии выглядела бы как принятый сценарий.
	 */
	apply: (input: unknown) => { ok: true; reset: boolean } | { ok: false; issues: string[] };
	/**
	 * Забрать одну испорченную попытку: код ответа или `null`, если сценарий
	 * кончился. Вызывается ровно один раз на обращение — счётчик уменьшается.
	 */
	takeFailure: () => number | null;
	reset: () => void;
};

const DEFAULT_STATE: ScenarioState = {
	failNext: 0,
	status: 503,
	delayMs: 0,
	mode: 'normal',
	match: null,
	expiresAt: null
};

/** Больше часа ждать нечего: имитатор поднят ради проверки, а не ради зависания. */
const MAX_DELAY_MS = 60_000;
const MAX_FAIL_NEXT = 1000;
/** Сутки: сценарий дольше — это уже не проверка, а сломанный стенд. */
const MAX_TTL_SECONDS = 86_400;

const FIELDS = ['failNext', 'status', 'delayMs', 'mode', 'match', 'ttlSeconds', 'reset'] as const;

export type ScenarioOptions = {
	/** Текущее время в миллисекундах; подменяется в проверках срока. */
	now?: () => number;
};

function readInteger(
	value: unknown,
	name: string,
	min: number,
	max: number,
	issues: string[]
): number | null {
	if (!Number.isInteger(value)) {
		issues.push(`${name}: ожидается целое число`);
		return null;
	}

	const number = value as number;

	if (number < min || number > max) {
		issues.push(`${name}: ожидается число от ${min} до ${max}`);
		return null;
	}

	return number;
}

export function createScenario(options: ScenarioOptions = {}): Scenario {
	const now = options.now ?? Date.now;
	let state: ScenarioState = { ...DEFAULT_STATE };

	/**
	 * Текущий сценарий с учётом срока. Срок проверяется при каждом обращении,
	 * а не таймером: пока к имитатору никто не обращается, истёкший сценарий
	 * ничего и не портит, а таймер пришлось бы ещё и снимать.
	 */
	function current(): ScenarioState {
		if (state.expiresAt !== null && now() >= Date.parse(state.expiresAt)) {
			state = { ...DEFAULT_STATE };
		}

		return state;
	}

	return {
		read() {
			return { ...current() };
		},

		apply(input) {
			if (typeof input !== 'object' || input === null || Array.isArray(input)) {
				return { ok: false, issues: ['тело сценария — объект'] };
			}

			const body = input as Record<string, unknown>;
			const issues: string[] = [];
			const unknown = Object.keys(body).filter(
				(name) => !FIELDS.includes(name as (typeof FIELDS)[number])
			);

			if (unknown.length > 0) {
				issues.push(`неизвестные поля: ${unknown.join(', ')}`);
			}

			const next: ScenarioState = { ...current() };

			if ('failNext' in body) {
				const value = readInteger(body.failNext, 'failNext', 0, MAX_FAIL_NEXT, issues);

				if (value !== null) {
					next.failNext = value;
				}
			}

			if ('status' in body) {
				const value = readInteger(body.status, 'status', 400, 599, issues);

				if (value !== null) {
					next.status = value;
				}
			}

			if ('delayMs' in body) {
				const value = readInteger(body.delayMs, 'delayMs', 0, MAX_DELAY_MS, issues);

				if (value !== null) {
					next.delayMs = value;
				}
			}

			if ('mode' in body) {
				if (body.mode !== 'normal' && body.mode !== 'offline') {
					issues.push('mode: ожидается normal или offline');
				} else {
					next.mode = body.mode;
				}
			}

			if ('match' in body) {
				if (body.match === null) {
					next.match = null;
				} else if (typeof body.match !== 'string' || body.match === '') {
					issues.push('match: ожидается непустая строка или null');
				} else {
					next.match = body.match;
				}
			}

			// Срок отсчитывается от этого обращения; `null` снимает срок, а
			// сценарий без `ttlSeconds` сохраняет прежний — как и прочие поля.
			if ('ttlSeconds' in body) {
				if (body.ttlSeconds === null) {
					next.expiresAt = null;
				} else {
					const value = readInteger(body.ttlSeconds, 'ttlSeconds', 1, MAX_TTL_SECONDS, issues);

					if (value !== null) {
						next.expiresAt = new Date(now() + value * 1000).toISOString();
					}
				}
			}

			let reset = false;

			if ('reset' in body) {
				if (typeof body.reset !== 'boolean') {
					issues.push('reset: ожидается true или false');
				} else {
					reset = body.reset;
				}
			}

			if (issues.length > 0) {
				return { ok: false, issues };
			}

			// Сброс сильнее остальных полей: «забыть всё» в одном теле с новым
			// сценарием означает именно «начать с чистого листа».
			state = reset ? { ...DEFAULT_STATE } : next;

			return { ok: true, reset };
		},

		takeFailure() {
			if (current().failNext < 1) {
				return null;
			}

			state = { ...state, failNext: state.failNext - 1 };

			return state.status;
		},

		reset() {
			state = { ...DEFAULT_STATE };
		}
	};
}
