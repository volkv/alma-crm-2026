/**
 * Нагрузочный набор: столько работы, сколько её бывает у живого оператора.
 *
 * Демонстрационный набор отвечает на вопрос «как это выглядит»: сорок вузов,
 * два десятка взаимодействий, история, которую можно прочитать глазами. На
 * таком объёме любой замер отклика показывает скорость PostgreSQL на пустой
 * таблице, а не скорость системы. Этот набор отвечает на другой вопрос — «как
 * это держится»: три сотни вузов, три тысячи взаимодействий и почти полсотни
 * тысяч строк истории, по которым ходят список, карточка и отчёт за год.
 *
 * Он **не** демонстрационный и на стенд не попадает: его заливают руками
 * (`node scripts/seed/index.ts --load`) на отдельной установке перед
 * нагрузочным прогоном (`scripts/load/`, `docs/performance.md`).
 *
 * Три правила набора:
 *
 * 1. **детерминированность.** Ни одного `Math.random`: и названия, и сроки, и
 *    распределение по стадиям выводятся из порядкового номера. Два прогона на
 *    разных машинах меряют одну и ту же базу, иначе числа не сравнить;
 * 2. **идемпотентность.** Заливка целиком идёт одной транзакцией и начинается с
 *    проверки «первая организация набора уже заведена». Повторный запуск не
 *    делает ничего, прерванный — не оставляет половины;
 * 3. **невмешательство.** Набор ничего не переписывает: он добавляет свои
 *    строки рядом с демонстрационными, пользуясь их процессом, программами,
 *    продуктами и учётными записями. Демонстрационный сид и его тесты про этот
 *    набор не знают и знать не должны.
 *
 * Строки истории — записи стадий, комментарии, правки плана — заводятся прямой
 * вставкой, а не командами движка: движок открывает транзакцию на каждый шаг, и
 * сорок восемь тысяч шагов заняли бы часы. Форма строк при этом та же, что
 * пишет движок: слепок стадии снимается с действующей редакции тем же
 * `stageSnapshot`, которым его снимает переход.
 */
import { count, eq, inArray } from 'drizzle-orm';
import type { ChecklistState, StageSnapshot } from '$lib/contracts/interactions';
import {
	affiliations,
	comments,
	interactionChanges,
	interactionParties,
	interactionProducts,
	interactionPrograms,
	interactions,
	organizationResponsibles,
	organizations,
	people,
	products,
	programs,
	stageEntries,
	users
} from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { B2B_GROUP_KEY } from '$lib/server/stages/definitions';
import { readActiveRevision, readGroupByKey, stageSnapshot } from '$lib/server/stages/process';
import { seedId } from './ids';

/** Размеры набора. Их же печатает отчёт заливки и читает документация. */
export const LOAD_SEED_SIZES = {
	organizations: 300,
	interactionsPerOrganization: 10,
	/** Пройденных стадий у взаимодействия; текущая — сверх них. */
	closedStagesPerInteraction: 8,
	commentsPerInteraction: 4,
	changesPerInteraction: 3,
	/**
	 * Во сколько раз длиннее история у «долгого» взаимодействия и каждое
	 * которое такое.
	 *
	 * Без них набор был бы однородным, а однородный набор врёт: кэш повторного
	 * открытия и лента карточки существуют ради записи, которую ведут второй
	 * год, — у неё сотни строк истории, а не четыре. Каждая десятая запись
	 * набора именно такая.
	 */
	longHistoryEvery: 10,
	longHistoryFactor: 10
} as const;

const INTERACTIONS = LOAD_SEED_SIZES.organizations * LOAD_SEED_SIZES.interactionsPerOrganization;

/** Сколько строк уезжает в базу одним запросом. */
const CHUNK = 500;

/**
 * Учётные записи, между которыми раскладывается работа. Это те же сотрудники,
 * что и на демонстрационном стенде: нагрузочный набор не заводит своих людей,
 * иначе под ними некому было бы войти.
 */
const OWNER_KEYS = ['demo-manager', 'veresova', 'zotov'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Разброс без случайности: остаток от умножения номера на простое число.
 * Соседние номера получают непохожие значения, а одинаковые входные данные —
 * один и тот же результат.
 */
function spread(index: number, modulo: number): number {
	return (index * 2_654_435_761) % modulo;
}

/** Регионы, по которым раскладываются вузы: разрез фильтра отчёта. */
const REGIONS = [
	'Москва',
	'Санкт-Петербург',
	'Республика Татарстан',
	'Новосибирская область',
	'Свердловская область',
	'Краснодарский край',
	'Томская область',
	'Нижегородская область'
] as const;

/** Основа названий: получается «Технический университет № 17». */
const ORGANIZATION_TITLES = [
	'Технический университет',
	'Государственный университет',
	'Политехнический институт',
	'Гуманитарный университет',
	'Аграрный университет',
	'Медицинский университет',
	'Педагогический университет',
	'Колледж информационных технологий'
] as const;

const INTERACTION_TITLES = [
	'Соглашение о сотрудничестве',
	'Запуск базовой кафедры',
	'Программа стажировок',
	'Курс по направлению DevOps',
	'Совместная лаборатория',
	'Олимпиада и профориентация'
] as const;

const COMMENT_TEXTS = [
	'Согласовали состав рабочей группы, ждём ответ проректора.',
	'Направили проект соглашения на юридическую проверку.',
	'Уточнили количество мест в потоке и сроки набора.',
	'Обсудили площадку и расписание занятий на семестр.',
	'Зафиксировали договорённость о совместном мероприятии.'
] as const;

/** Отметки по чек-листу стадии: все пункты выполнены. */
function closedChecklist(snapshot: StageSnapshot): ChecklistState {
	return Object.fromEntries(snapshot.checklist.map((item) => [item.key, true]));
}

function chunked<TValue>(values: readonly TValue[]): TValue[][] {
	const chunks: TValue[][] = [];

	for (let offset = 0; offset < values.length; offset += CHUNK) {
		chunks.push(values.slice(offset, offset + CHUNK));
	}

	return chunks;
}

async function insertAll<TValue extends Record<string, unknown>>(
	rows: readonly TValue[],
	write: (chunk: TValue[]) => Promise<unknown>
): Promise<void> {
	for (const chunk of chunked(rows)) {
		await write(chunk);
	}
}

/** Итог заливки: по строке на таблицу, для отчёта скрипта. */
export type LoadSeedReport = {
	organizations: number;
	interactions: number;
	stageEntries: number;
	comments: number;
	changes: number;
};

/**
 * Заливка нагрузочного набора. Прерывается словами, если демонстрационный сид
 * ещё не проходил: набор опирается на его процесс, программы и продукты.
 */
export async function seedLoad(tx: Tx): Promise<LoadSeedReport | null> {
	const firstOrganizationId = seedId('organization', 'load-1');

	const [already] = await tx
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.id, firstOrganizationId))
		.limit(1);

	if (already !== undefined) {
		return null;
	}

	const group = await readGroupByKey(tx, B2B_GROUP_KEY);
	const revision = await readActiveRevision(tx, group);

	if (revision === null || revision.stages.length === 0) {
		throw new Error(
			'Нагрузочный набор опирается на действующий процесс группы «b2b»: залейте сначала демонстрационный набор'
		);
	}

	const stageViews = [...revision.stages].sort((left, right) => left.position - right.position);

	const ownerIds = OWNER_KEYS.map((key) => seedId('user', key));
	const [ownersInPlace] = await tx
		.select({ value: count() })
		.from(users)
		.where(inArray(users.id, ownerIds));

	if (ownersInPlace.value !== ownerIds.length) {
		throw new Error(
			'Нагрузочный набор ведут сотрудники демонстрационного стенда: залейте сначала демонстрационный набор'
		);
	}

	const programRows = await tx.select({ id: programs.id }).from(programs).orderBy(programs.code);
	const productRows = await tx.select({ id: products.id }).from(products).orderBy(products.code);

	if (programRows.length === 0 || productRows.length === 0) {
		throw new Error(
			'Нагрузочному набору нужны программы и продукты справочника: залейте сначала демонстрационный набор'
		);
	}

	const now = Date.now();

	const organizationRows = [];
	const peopleRows = [];
	const affiliationRows = [];
	const responsibleRows = [];

	for (let index = 1; index <= LOAD_SEED_SIZES.organizations; index += 1) {
		const key = `load-${index}`;
		const organizationId = seedId('organization', key);
		const personId = seedId('person', key);
		const title = ORGANIZATION_TITLES[spread(index, ORGANIZATION_TITLES.length)];

		organizationRows.push({
			id: organizationId,
			kind: 'educational_institution' as const,
			educationLevel: (index % 5 === 0 ? 'spo' : 'vo') as 'spo' | 'vo',
			legalName: `Федеральное государственное бюджетное образовательное учреждение «${title} № ${index}»`,
			shortName: `${title} № ${index}`,
			region: REGIONS[spread(index, REGIONS.length)],
			notes: 'Нагрузочный набор: организация вымышлена.'
		});

		peopleRows.push({
			id: personId,
			lastName: `Нагрузов${index % 2 === 0 ? 'а' : ''}`,
			firstName: index % 2 === 0 ? 'Нагрузка' : 'Нагруз',
			middleName: null,
			email: `contact-${index}@example.org`,
			phone: `+7 900 000-01-${String(index % 100).padStart(2, '0')}`
		});

		affiliationRows.push({
			id: seedId('affiliation', key),
			personId,
			organizationId,
			position: 'Проректор по учебной работе',
			roleKind: 'vice_rector' as const,
			isPrimary: true,
			validFrom: '2026-01-01'
		});

		responsibleRows.push({
			id: seedId('responsible', key),
			organizationId,
			// Все вузы набора ведёт один человек, а не трое по кругу. Набор
			// существует, чтобы нагрузить **один** портфель: в области доступа
			// КАМа тогда лежат все три сотни вузов, и подзапрос области считается
			// на настоящем объёме. Правдоподобное распределение ответственности
			// между людьми показывает демонстрационный набор, и его этот не
			// трогает.
			userId: seedId('user', 'demo-manager'),
			validFrom: new Date(now - 365 * DAY_MS)
		});
	}

	await insertAll(organizationRows, (chunk) => tx.insert(organizations).values(chunk));
	await insertAll(peopleRows, (chunk) => tx.insert(people).values(chunk));
	await insertAll(affiliationRows, (chunk) => tx.insert(affiliations).values(chunk));
	await insertAll(responsibleRows, (chunk) => tx.insert(organizationResponsibles).values(chunk));

	const interactionRows = [];
	const partyRows = [];
	const programLinkRows = [];
	const productLinkRows = [];
	const entryRows = [];
	const commentRows = [];
	const changeRows = [];

	for (let index = 1; index <= INTERACTIONS; index += 1) {
		const organizationIndex = ((index - 1) % LOAD_SEED_SIZES.organizations) + 1;
		const organizationKey = `load-${organizationIndex}`;
		const organizationId = seedId('organization', organizationKey);
		const key = `load-${index}`;
		const interactionId = seedId('interaction', key);
		const ownerUserId = ownerIds[organizationIndex % ownerIds.length];

		// Возраст записи разводит их по времени: отчёт за период обязан видеть и
		// начатые год назад, и заведённые на прошлой неделе.
		const ageDays = 30 + spread(index, 330);
		const createdAt = new Date(now - ageDays * DAY_MS);
		// Глубина продвижения — тоже разрез, по которому смотрят воронку.
		const passed =
			1 +
			spread(index, Math.min(LOAD_SEED_SIZES.closedStagesPerInteraction, stageViews.length - 1));
		const completed = index % 7 === 0;
		// Прожитое время делится между стадиями поровну, и открытая запись
		// начинается не позже сегодняшнего дня. Иначе взаимодействие стояло бы на
		// стадии, на которую ещё не вошло, и первый же переход по нему упёрся бы в
		// проверку базы «уйти со стадии нельзя раньше, чем на неё вошли».
		const segmentDays = Math.max(1, Math.floor(ageDays / (passed + 1)));

		const openEnteredAt = new Date(createdAt.getTime() + passed * segmentDays * DAY_MS);

		interactionRows.push({
			id: interactionId,
			title: `${INTERACTION_TITLES[spread(index, INTERACTION_TITLES.length)]} № ${index}`,
			processGroupId: group.id,
			status: (completed ? 'completed' : 'active') as 'completed' | 'active',
			agreementPeriodStart: '2026-09-01',
			agreementPeriodEnd: '2027-08-31',
			academicPeriodStart: '2026-09-01',
			academicPeriodEnd: '2027-06-30',
			ownerUserId,
			// Последнее событие — вход на текущую стадию: запись, по которой
			// работали позже, чем вошли, выглядела бы историей наоборот.
			lastActivityAt: openEnteredAt,
			createdAt,
			updatedAt: openEnteredAt
		});

		partyRows.push({
			interactionId,
			organizationId,
			partyRole: 'educational_institution' as const,
			isPrimary: true,
			contactAffiliationId: seedId('affiliation', organizationKey)
		});

		programLinkRows.push({
			interactionId,
			programId: programRows[spread(index, programRows.length)].id,
			programVersionId: null
		});

		productLinkRows.push({
			interactionId,
			productId: productRows[spread(index, productRows.length)].id
		});

		// Записи стадий: пройденные закрыты по очереди, последняя открыта — если
		// взаимодействие не завершено.
		let enteredAt = createdAt;

		for (let step = 0; step <= passed; step += 1) {
			const stage = stageViews[Math.min(step, stageViews.length - 1)];
			const isLast = step === passed;
			const leftAt =
				isLast && !completed ? null : new Date(enteredAt.getTime() + segmentDays * DAY_MS);

			const snapshot = stageSnapshot(stage);

			entryRows.push({
				interactionId,
				stageId: stage.id,
				stageSnapshot: snapshot,
				enteredAt,
				leftAt,
				outcome: leftAt === null ? null : ('completed' as const),
				responsibleUserId: ownerUserId,
				// Чек-лист стадии закрыт: запись, по которой работали, доходит до
				// перехода с закрытым чек-листом, и без этого нагрузочный прогон
				// мерил бы скорость отказа вместо скорости перехода.
				checklistState: closedChecklist(snapshot)
			});

			if (leftAt !== null) {
				enteredAt = leftAt;
			}
		}

		// Каждая десятая запись — долгая: у неё история в десять раз длиннее.
		const factor =
			index % LOAD_SEED_SIZES.longHistoryEvery === 0 ? LOAD_SEED_SIZES.longHistoryFactor : 1;

		for (let step = 0; step < LOAD_SEED_SIZES.commentsPerInteraction * factor; step += 1) {
			commentRows.push({
				interactionId,
				authorId: ownerUserId,
				body: COMMENT_TEXTS[spread(index + step, COMMENT_TEXTS.length)],
				createdAt: new Date(createdAt.getTime() + (step + 1) * DAY_MS)
			});
		}

		for (let step = 0; step < LOAD_SEED_SIZES.changesPerInteraction * factor; step += 1) {
			changeRows.push({
				interactionId,
				changedAt: new Date(createdAt.getTime() + (step + 1) * 2 * DAY_MS),
				authorId: ownerUserId,
				field: 'title',
				oldValue: `Черновик ${step + 1}`,
				newValue: `Черновик ${step + 2}`,
				reason: 'Уточнение по итогам встречи'
			});
		}
	}

	await insertAll(interactionRows, (chunk) => tx.insert(interactions).values(chunk));
	await insertAll(partyRows, (chunk) => tx.insert(interactionParties).values(chunk));
	await insertAll(programLinkRows, (chunk) => tx.insert(interactionPrograms).values(chunk));
	await insertAll(productLinkRows, (chunk) => tx.insert(interactionProducts).values(chunk));
	await insertAll(entryRows, (chunk) => tx.insert(stageEntries).values(chunk));
	await insertAll(commentRows, (chunk) => tx.insert(comments).values(chunk));
	await insertAll(changeRows, (chunk) => tx.insert(interactionChanges).values(chunk));

	return {
		organizations: organizationRows.length,
		interactions: interactionRows.length,
		stageEntries: entryRows.length,
		comments: commentRows.length,
		changes: changeRows.length
	};
}
