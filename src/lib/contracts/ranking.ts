/**
 * Рейтинг программ и направлений по фактам самой системы.
 *
 * Техническое задание называет, по чему ранжировать: заявки, потоки и
 * обучающиеся. Все три — факты, которые система уже хранит, поэтому рейтинг
 * считается по ним, а не по загруженным файлам:
 *
 * - **заявки с сайта** — взаимодействия, заведённые приёмом заявки из CMS за
 *   период;
 * - **потоки** — учебные группы, стартовавшие в периоде;
 * - **обучающиеся** — зачисленные по последнему результату каждой группы;
 * - **завершили** — по последнему результату группы, если он итоговый.
 *
 * Группа попадает в период один раз — по дате старта — и отдаёт в сумму один
 * результат, последний: промежуточный и итоговый результат одной группы — это
 * два рассказа об одних и тех же людях, и сложить их значит посчитать людей
 * дважды.
 *
 * **Формула — предложение, настраивается**: заказчиком она не утверждена, и
 * экран не выдаёт её за утверждённую. Веса подобраны так, чтобы поток весил
 * как небольшая группа, а завершивший — вдвое больше записавшегося. Веса
 * хранятся настройкой и меняются без выпуска; экран показывает и формулу, и
 * разложение балла каждой строки.
 *
 * Ручной приоритет программы (`programs.priority`) — явная поправка, а не
 * скрытый множитель: он добавляет баллы отдельным слагаемым. Поэтому у каждой
 * строки два места — по одним фактам и итоговое, с поправкой, — и на экране
 * видно, сколько мест программа получила за счёт решения человека.
 */
import { z } from 'zod';
import { formatNumber, pluralize } from '$lib/format';

/** Факты, из которых складывается балл. */
export const RANKING_FACTS = ['applications', 'streams', 'enrolled', 'completed'] as const;

export type RankingFact = (typeof RANKING_FACTS)[number];

export const RANKING_FACT_LABELS: Record<RankingFact, string> = {
	applications: 'Заявки с сайта',
	streams: 'Потоки',
	enrolled: 'Обучающиеся',
	completed: 'Завершили'
};

/** Что именно посчитано — подписью к формуле. */
export const RANKING_FACT_HINTS: Record<RankingFact, string> = {
	applications: 'взаимодействия, заведённые приёмом заявки с сайта за период',
	streams: 'учебные группы, стартовавшие в периоде',
	enrolled: 'зачислено по последнему результату каждой группы',
	completed: 'завершили по последнему результату группы, если он итоговый'
};

/**
 * Сколько верхних приоритетов получают поправку. Приоритет 1 даёт
 * `RANKING_PRIORITY_LEVELS` шагов поправки, приоритет 5 — один шаг, дальше —
 * ничего: «сотый по важности» от «не назначен» на деле не отличается.
 */
export const RANKING_PRIORITY_LEVELS = 5;

const weight = (label: string) =>
	z
		.number({ error: `Вес «${label}» — целое число` })
		.int({ error: `Вес «${label}» — целое число` })
		.min(0, { error: `Вес «${label}» не меньше нуля` })
		.max(1000, { error: `Вес «${label}» не больше 1000` });

/** Веса формулы. Ноль допустим: так слагаемое выключают, не удаляя его из объяснения. */
export const rankingWeightsSchema = z.object({
	applications: weight(RANKING_FACT_LABELS.applications),
	streams: weight(RANKING_FACT_LABELS.streams),
	enrolled: weight(RANKING_FACT_LABELS.enrolled),
	completed: weight(RANKING_FACT_LABELS.completed),
	priorityStep: weight('Шаг приоритета')
});

export type RankingWeights = z.output<typeof rankingWeightsSchema>;

/** Веса, с которыми система работает, пока их не поменяли в настройке. */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
	applications: 3,
	streams: 10,
	enrolled: 1,
	completed: 2,
	priorityStep: 10
};

/**
 * Факты одной строки рейтинга. Заявки и потоки — счётчики, у них ноль это
 * ответ. Обучающиеся и завершившие — числа из результатов групп, и `null`
 * означает «ни одна группа их не прислала», а не ноль.
 */
export type RankingFacts = {
	applications: number;
	streams: number;
	enrolled: number | null;
	completed: number | null;
};

/** Поправка за ручной приоритет; `null` и приоритет ниже пятого — ноль. */
export function priorityBonus(priority: number | null, step: number): number {
	if (priority === null || priority < 1 || priority > RANKING_PRIORITY_LEVELS) {
		return 0;
	}

	return (RANKING_PRIORITY_LEVELS + 1 - priority) * step;
}

/** Одно слагаемое: что взяли, с каким весом и сколько это дало. */
export type RankingComponent = {
	fact: RankingFact;
	/** `null` — данных нет; в сумму такое слагаемое входит нулём. */
	value: number | null;
	weight: number;
	contribution: number;
};

export type RankingScore = {
	score: number;
	/** Сумма вкладов плюс поправка равна `score` — иначе объяснение не объясняет. */
	components: RankingComponent[];
	/** Ручной приоритет; у направления его нет. */
	priority: number | null;
	priorityBonus: number;
};

/** Балл и его разложение. Чистая функция: та же на сервере, в выгрузке и в проверках. */
export function scoreFacts(
	facts: RankingFacts,
	weights: RankingWeights,
	priority: number | null
): RankingScore {
	const components = RANKING_FACTS.map((fact) => {
		const value = facts[fact];

		return { fact, value, weight: weights[fact], contribution: (value ?? 0) * weights[fact] };
	});
	const bonus = priorityBonus(priority, weights.priorityStep);

	return {
		score: components.reduce((total, part) => total + part.contribution, 0) + bonus,
		components,
		priority,
		priorityBonus: bonus
	};
}

/** Что ранжируется: программа или направление вместе со своими фактами. */
export type RankingSubject = {
	id: string;
	code: string;
	name: string;
	facts: RankingFacts;
	priority: number | null;
	/** Сколько организаций стоит за фактами строки. */
	organizationCount: number;
};

export type RankingEntry = RankingScore &
	Omit<RankingSubject, 'priority'> & {
		/** Итоговое место — по баллу вместе с поправкой за ручной приоритет. */
		place: number;
		/** Балл одних фактов, без поправки: `score − priorityBonus`. */
		factScore: number;
		/**
		 * Место по одним фактам. Отличается от `place` ровно тогда, когда места
		 * решил ручной приоритет, — и экран обязан это показать, а не спрятать в
		 * итоговом порядке.
		 */
		factPlace: number;
	};

type Scored = RankingScore & Omit<RankingSubject, 'priority'> & { factScore: number };

/**
 * Порядок по баллу. Равные баллы разводятся кодом: иначе порядок зависел бы от
 * того, в каком порядке их вернула база, и одна и та же ссылка показывала бы
 * разные места.
 */
function placesBy(
	entries: readonly Scored[],
	value: (entry: Scored) => number
): Map<string, number> {
	const ordered = [...entries].sort(
		(left, right) => value(right) - value(left) || left.code.localeCompare(right.code)
	);

	return new Map(ordered.map((entry, index) => [entry.id, index + 1]));
}

/**
 * Места по баллу: итоговое (с поправкой за приоритет) и по одним фактам.
 * Строки идут в порядке итогового места.
 */
export function rankSubjects(
	subjects: readonly RankingSubject[],
	weights: RankingWeights
): RankingEntry[] {
	const scored: Scored[] = subjects.map((subject) => {
		const score = scoreFacts(subject.facts, weights, subject.priority);

		return { ...subject, ...score, factScore: score.score - score.priorityBonus };
	});
	const places = placesBy(scored, (entry) => entry.score);
	const factPlaces = placesBy(scored, (entry) => entry.factScore);

	return scored
		.map((entry) => ({
			...entry,
			place: places.get(entry.id) as number,
			factPlace: factPlaces.get(entry.id) as number
		}))
		.sort((left, right) => left.place - right.place);
}

const POINTS: [string, string, string] = ['балл', 'балла', 'баллов'];

function points(value: number): string {
	return pluralize(value, POINTS);
}

/**
 * «Почему на этом месте» словами: балл, отрыв от соседей и то, что дало
 * больше всего. Сравнение с соседями — потому что вопрос о месте всегда
 * звучит как «почему выше неё» или «почему ниже него».
 */
export function explainPlace(entries: readonly RankingEntry[], index: number): string {
	const entry = entries[index];

	if (entry === undefined) {
		throw new RangeError(`В рейтинге нет строки с номером ${index}`);
	}

	const parts = [`${entry.place}-е место из ${entries.length}: ${points(entry.score)}.`];
	const above = entries[index - 1];
	const below = entries[index + 1];

	if (above !== undefined) {
		const gap = above.score - entry.score;

		parts.push(
			gap === 0
				? `Столько же у «${above.name}» — при равном балле выше тот, чей код меньше.`
				: `На ${points(gap)} меньше, чем у «${above.name}» на ${above.place}-м месте.`
		);
	}

	if (below !== undefined) {
		const gap = entry.score - below.score;

		if (gap > 0) {
			parts.push(`На ${points(gap)} больше, чем у «${below.name}» на ${below.place}-м месте.`);
		}
	}

	const leading = entry.components.reduce<RankingComponent | null>(
		(best, part) => (part.contribution > (best?.contribution ?? 0) ? part : best),
		null
	);

	if (leading !== null) {
		parts.push(
			`Больше всего дало слагаемое «${RANKING_FACT_LABELS[leading.fact]}»: ${formatNumber(leading.value ?? 0)} × ${leading.weight} = ${formatNumber(leading.contribution)}.`
		);
	}

	if (entry.priorityBonus > 0) {
		parts.push(
			`Ручной приоритет ${entry.priority} добавил ${points(entry.priorityBonus)} — это решение человека, а не факт.`
		);
	}

	// Без поправки и без сдвига фраза про «место по фактам» повторяла бы место.
	if (entry.priorityBonus > 0 || entry.factPlace !== entry.place) {
		parts.push(factPlaceText(entry));
	}

	return parts.join(' ');
}

/**
 * Место по одним фактам словами: совпадает ли оно с итоговым и насколько его
 * сдвинул ручной приоритет — вверх своей поправкой или вниз чужой.
 */
export function factPlaceText(entry: RankingEntry): string {
	if (entry.factPlace === entry.place) {
		return `По одним фактам, без ручного приоритета, — то же ${entry.factPlace}-е место.`;
	}

	const moved = entry.factPlace - entry.place;
	const direction = moved > 0 ? 'поднял' : 'опустил';

	return `По одним фактам, без ручного приоритета, — ${entry.factPlace}-е место: приоритет ${direction} строку на ${pluralize(Math.abs(moved), ['место', 'места', 'мест'])}.`;
}

/**
 * Как экран и выгрузка называют статус формулы: заказчиком она не утверждена,
 * и выдавать её за утверждённую нельзя. Одна строка на все места, где о
 * формуле говорится, — иначе пересказы разойдутся.
 */
export const RANKING_FORMULA_NOTE = 'Формула рейтинга — предложение, настраивается';

/** Формула словами и числами — одной строкой над таблицей и в выгрузке. */
export function describeFormula(weights: RankingWeights): string {
	const terms = RANKING_FACTS.map(
		(fact) => `${weights[fact]} × ${RANKING_FACT_LABELS[fact].toLowerCase()}`
	);

	return `балл = ${terms.join(' + ')} + поправка за ручной приоритет (${weights.priorityStep} × (${RANKING_PRIORITY_LEVELS + 1} − приоритет) для приоритетов 1–${RANKING_PRIORITY_LEVELS})`;
}

/** Рейтинг за период целиком. */
export type RankingView = {
	period: { start: string; end: string };
	weights: RankingWeights;
	programs: RankingEntry[];
	directions: RankingEntry[];
	/**
	 * Факты, которые не легли ни в одну строку, — чтобы сумма на экране не
	 * расходилась молча с тем, что человек знает о своих группах.
	 */
	outside: {
		/** Группы без программы: заведены до того, как группа стала её закреплять. */
		groupsWithoutProgram: number;
		/** Заявки с сайта, в которых не названа ни одна программа. */
		applicationsWithoutProgram: number;
		/** Программы с фактами, у которых не указано направление. */
		programsWithoutDirection: number;
	};
};

/** Место одной строки с объяснением — для карточки программы или направления. */
export type RankingPlace = {
	entry: RankingEntry;
	/** Сколько строк в рейтинге того же вида за тот же период. */
	total: number;
	reason: string;
};

/** Место программы или направления; `null` — за период у неё нет фактов. */
export function rankingPlaceOf(entries: readonly RankingEntry[], id: string): RankingPlace | null {
	const index = entries.findIndex((entry) => entry.id === id);

	if (index === -1) {
		return null;
	}

	return { entry: entries[index], total: entries.length, reason: explainPlace(entries, index) };
}

/** Месяц начала учебного года: сентябрь. */
const ACADEMIC_YEAR_START_MONTH = 9;

/** Учебный год, который начинается в `startYear`: `2025-09-01 — 2026-08-31`. */
export function academicYear(startYear: number): { start: string; end: string } {
	return { start: `${startYear}-09-01`, end: `${startYear + 1}-08-31` };
}

/** Учебный год, в который попадает календарный день `yyyy-mm-dd`. */
export function academicYearOf(day: string): { start: string; end: string } {
	const year = Number(day.slice(0, 4));
	const month = Number(day.slice(5, 7));

	if (!Number.isInteger(year) || !Number.isInteger(month)) {
		throw new RangeError(`Не удалось разобрать день: ${day}`);
	}

	return academicYear(month >= ACADEMIC_YEAR_START_MONTH ? year : year - 1);
}
