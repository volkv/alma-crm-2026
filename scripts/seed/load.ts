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
 *    строки рядом с демонстрационными, пользуясь их процессом, программами и
 *    продуктами. Демонстрационный сид и его тесты про этот набор не знают и
 *    знать не должны.
 *
 * Работу ведёт своя команда — двадцать КАМов под тремя руководителями, как у
 * заказчика (`LOAD_TEAM`). Каждый вуз закреплён за одним КАМом, и его
 * взаимодействия ведёт он же; руководитель видит портфели своих подчинённых
 * через иерархию. Так область доступа каждого входящего в прогон сотрудника
 * считается на своём, правдоподобном по размеру портфеле, а не на одном
 * портфеле из всех трёхсот вузов.
 *
 * Строки истории — записи стадий, комментарии, правки плана — заводятся прямой
 * вставкой, а не командами движка: движок открывает транзакцию на каждый шаг, и
 * сорок восемь тысяч шагов заняли бы часы. Форма строк при этом та же, что
 * пишет движок: слепок стадии снимается с действующей редакции тем же
 * `stageSnapshot`, которым его снимает переход.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
import { contactColumns } from '$lib/server/people/pii';
import { B2B_WORKSPACE_KEY } from '$lib/server/stages/definitions';
import {
	readActiveRevision,
	readWorkflowForWorkspace,
	readWorkspaceByKey,
	stageSnapshot
} from '$lib/server/stages/process';
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

/** Сотрудник нагрузочной команды. */
export type LoadAccount = {
	key: string;
	/** Имя входа в каталоге учётных записей. */
	login: string;
	/** Почта — ключ связывания записи каталога с записью CRM при первом входе. */
	email: string;
	firstName: string;
	lastName: string;
	roleId: 'manager' | 'lead';
	/** Роль realm, которую каталог выдаёт этой записи. */
	realmRole: 'crm-user' | 'crm-lead';
	/** Ключ руководителя; у руководителей — `null`. */
	managerKey: string | null;
};

/** Состав команды заказчика: двадцать КАМов, три руководителя. */
const LOAD_TEAM_SIZES = { leads: 3, accountManagers: 20 } as const;

const LEADS: readonly LoadAccount[] = Array.from({ length: LOAD_TEAM_SIZES.leads }, (_, index) => {
	const login = `load-lead-${index + 1}`;

	return {
		key: login,
		login,
		email: `${login}@load.lct-crm.local`,
		firstName: 'Руководитель',
		lastName: `Нагрузочный ${index + 1}`,
		roleId: 'lead',
		realmRole: 'crm-lead',
		managerKey: null
	};
});

const ACCOUNT_MANAGERS: readonly LoadAccount[] = Array.from(
	{ length: LOAD_TEAM_SIZES.accountManagers },
	(_, index) => {
		const number = String(index + 1).padStart(2, '0');
		const login = `load-kam-${number}`;

		return {
			key: login,
			login,
			email: `${login}@load.lct-crm.local`,
			firstName: `КАМ ${number}`,
			lastName: 'Нагрузочный',
			roleId: 'manager',
			realmRole: 'crm-user',
			// КАМы делятся между руководителями по кругу: семь, семь и шесть.
			managerKey: LEADS[index % LEADS.length].key
		};
	}
);

/**
 * Нагрузочная команда: сначала руководители — на них ссылаются КАМы, и
 * вставка в этом порядке не упирается во внешний ключ.
 */
export const LOAD_TEAM: readonly LoadAccount[] = [...LEADS, ...ACCOUNT_MANAGERS];

/** КАМ, за которым закреплён вуз набора с этим порядковым номером. */
function accountManagerOf(organizationIndex: number): LoadAccount {
	return ACCOUNT_MANAGERS[(organizationIndex - 1) % ACCOUNT_MANAGERS.length];
}

/**
 * Ключи сотрудников, чью работу видит учётная запись: у КАМа — он сам, у
 * руководителя — он сам и его КАМы. Это то же правило, что держит область
 * доступа приложения (`accessScopeFor`), только посчитанное по составу команды.
 */
export function loadScopeKeys(account: LoadAccount): string[] {
	return [
		account.key,
		...ACCOUNT_MANAGERS.filter((member) => member.managerKey === account.key).map(
			(member) => member.key
		)
	];
}

/** Номера вузов набора, закреплённых за КАМами из списка. */
function organizationsOf(keys: readonly string[]): number[] {
	const result: number[] = [];

	for (let index = 1; index <= LOAD_SEED_SIZES.organizations; index += 1) {
		if (keys.includes(accountManagerOf(index).key)) {
			result.push(index);
		}
	}

	return result;
}

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
	users: number;
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

	const workspace = await readWorkspaceByKey(tx, B2B_WORKSPACE_KEY);
	const workflow = await readWorkflowForWorkspace(tx, workspace.id);
	const revision = workflow === null ? null : await readActiveRevision(tx, workflow);

	if (revision === null || revision.stages.length === 0) {
		throw new Error(
			'Нагрузочный набор опирается на действующий процесс пространства «b2b»: залейте сначала демонстрационный набор'
		);
	}

	const stageViews = [...revision.stages].sort((left, right) => left.position - right.position);

	const programRows = await tx.select({ id: programs.id }).from(programs).orderBy(programs.code);
	const productRows = await tx.select({ id: products.id }).from(products).orderBy(products.code);

	if (programRows.length === 0 || productRows.length === 0) {
		throw new Error(
			'Нагрузочному набору нужны программы и продукты справочника: залейте сначала демонстрационный набор'
		);
	}

	const now = Date.now();

	// Команда заводится той же транзакцией, что и её портфели: без строки
	// пользователя назначению ответственного не на кого ссылаться. Учётных
	// записей каталога сид не заводит — это делает нагрузочный прогон
	// (`scripts/load/run.sh up`); связывание идёт по почте при первом входе.
	await tx.insert(users).values(
		LOAD_TEAM.map((account) => ({
			id: seedId('user', account.key),
			email: account.email,
			fullName: `${account.firstName} ${account.lastName}`,
			roleId: account.roleId,
			managerUserId: account.managerKey === null ? null : seedId('user', account.managerKey)
		}))
	);

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
			// Контакты шифруются и здесь: нагрузочный набор обязан лежать в базе
			// так же, как боевые данные, иначе он не нагружает то, что нужно.
			...contactColumns({
				email: `contact-${index}@example.org`,
				phone: `+7 900 000-01-${String(index % 100).padStart(2, '0')}`
			})
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
			// Вуз закреплён за одним КАМом команды: пятнадцать вузов на человека,
			// как в портфеле КАМа у заказчика.
			userId: seedId('user', accountManagerOf(index).key),
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
		// Взаимодействие ведёт тот, за кем закреплён вуз: иначе запись лежала бы
		// в области доступа по стороне, а не по владельцу, и портфель КАМа
		// выглядел бы не так, как у заказчика.
		const ownerUserId = seedId('user', accountManagerOf(organizationIndex).key);

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
			workspaceId: workspace.id,
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
		users: LOAD_TEAM.length,
		organizations: organizationRows.length,
		interactions: interactionRows.length,
		stageEntries: entryRows.length,
		comments: commentRows.length,
		changes: changeRows.length
	};
}

/**
 * Можно ли шагнуть вперёд со стадии, ничего не подтверждая: ни результата, ни
 * подтверждения, ни данных системы обучения, ни отметки по документу, ни
 * обязательного пункта-факта чек-листа. Ручные пункты чек-листа сюда не входят —
 * их закрывает тот, кто заводит запись; пункт-факт отметкой не закрыть, его
 * закрывают данные дела (подразделение у стороны, результат стадии).
 *
 * Только такие стадии годятся под переход в нагрузочном прогоне. Со стадии
 * подписания шаг вперёд ждёт утверждённого документа, а после неё — результата
 * и подтверждения; переводить запись, которой по процессу переходить нельзя,
 * значило бы мерить скорость отказа.
 */
function opensForward(snapshot: StageSnapshot): boolean {
	return (
		!snapshot.requiresResult &&
		!snapshot.requiresConfirmation &&
		!snapshot.requiresLmsData &&
		snapshot.requiresDocumentMark === null &&
		!snapshot.isFinal &&
		!snapshot.checklist.some((item) => item.required && item.completion?.kind === 'fact')
	);
}

/** Взаимодействие под один переход: где стоит и куда с этой стадии шаг вперёд. */
export type TransitionTarget = {
	id: string;
	fromStageId: string;
	toStageId: string;
};

/** Начало названия записей пула: по нему прогон находит свои записи при сверке. */
export function transitionPoolPrefix(runKey: string): string {
	return `Прогон ${runKey}: переход № `;
}

/**
 * Свежие взаимодействия под переходы одного нагрузочного прогона.
 *
 * Переход — это изменение состояния: второй шаг по той же записи пошёл бы уже
 * с другой стадии, а после нескольких шагов запись упёрлась бы в подписание,
 * где шаг вперёд ждёт утверждённого документа. Поэтому у каждого прогона свой
 * пул: по `perAccount` записей на каждого сотрудника команды, на стадиях, с
 * которых шаг вперёд разрешён (`opensForward`), с закрытым чек-листом. Запись
 * ведёт сам сотрудник, а вуз берётся из его области — у руководителя из
 * портфелей его КАМов, — поэтому переход проходит все проверки области и прав,
 * как у живого человека.
 *
 * Возвращает пул по имени входа сотрудника. Истории у записей пула нет: читают
 * в прогоне заполненные карточки набора, а пул нужен только под переход.
 */
export async function seedTransitionPool(
	tx: Tx,
	input: { runKey: string; perAccount: number }
): Promise<Record<string, TransitionTarget[]>> {
	const workspace = await readWorkspaceByKey(tx, B2B_WORKSPACE_KEY);
	const workflow = await readWorkflowForWorkspace(tx, workspace.id);
	const revision = workflow === null ? null : await readActiveRevision(tx, workflow);

	if (revision === null) {
		throw new Error('У пространства «b2b» нет действующего процесса');
	}

	const forward = new Map<string, string>();

	for (const transition of revision.transitions) {
		if (transition.kind === 'forward' && !forward.has(transition.fromStageId)) {
			forward.set(transition.fromStageId, transition.toStageId);
		}
	}

	const open = [...revision.stages]
		.sort((left, right) => left.position - right.position)
		.flatMap((stage) => {
			const toStageId = forward.get(stage.id);

			return toStageId !== undefined && opensForward(stageSnapshot(stage))
				? [{ stage, toStageId }]
				: [];
		});

	if (open.length === 0) {
		throw new Error('В действующем процессе нет стадии, с которой шаг вперёд ничего не требует');
	}

	const now = Date.now();
	const interactionRows = [];
	const partyRows = [];
	const entryRows = [];
	const pool: Record<string, TransitionTarget[]> = {};
	let number = 0;

	for (const account of LOAD_TEAM) {
		const organizationIndexes = organizationsOf(loadScopeKeys(account));
		const ownerUserId = seedId('user', account.key);
		pool[account.login] = [];

		for (let step = 0; step < input.perAccount; step += 1) {
			number += 1;
			const id = randomUUID();
			const organizationKey = `load-${organizationIndexes[step % organizationIndexes.length]}`;
			const { stage, toStageId } = open[step % open.length];
			const snapshot = stageSnapshot(stage);
			// Вошли на стадию в прошлом: уйти с неё раньше, чем на неё вошли, база
			// не даст, а переход в прогоне случается через секунды после заливки.
			const enteredAt = new Date(now - (1 + (step % 5)) * DAY_MS);

			interactionRows.push({
				id,
				title: `${transitionPoolPrefix(input.runKey)}${number}`,
				workspaceId: workspace.id,
				status: 'active' as const,
				agreementPeriodStart: '2026-09-01',
				agreementPeriodEnd: '2027-08-31',
				ownerUserId,
				lastActivityAt: enteredAt,
				createdAt: enteredAt,
				updatedAt: enteredAt
			});

			partyRows.push({
				interactionId: id,
				organizationId: seedId('organization', organizationKey),
				partyRole: 'educational_institution' as const,
				isPrimary: true,
				contactAffiliationId: seedId('affiliation', organizationKey)
			});

			entryRows.push({
				interactionId: id,
				stageId: stage.id,
				stageSnapshot: snapshot,
				enteredAt,
				responsibleUserId: ownerUserId,
				checklistState: closedChecklist(snapshot)
			});

			pool[account.login].push({ id, fromStageId: stage.id, toStageId });
		}
	}

	await insertAll(interactionRows, (chunk) => tx.insert(interactions).values(chunk));
	await insertAll(partyRows, (chunk) => tx.insert(interactionParties).values(chunk));
	await insertAll(entryRows, (chunk) => tx.insert(stageEntries).values(chunk));

	return pool;
}
