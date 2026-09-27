/**
 * Проверка пунктов-фактов чек-листа: один механизм на весь продукт.
 *
 * Пункт-факт (`completion.kind = 'fact'`) закрывают данные дела, а не галочка:
 * выбранное подразделение, записанный результат, поток в системе обучения,
 * приложенный документ. Ответ «выполнен ли пункт» задают карточка (чтобы
 * показать его), доска, команда перехода и завершение — и ответ обязан быть
 * один, поэтому правила живут только здесь. Каталог правил —
 * `$lib/platform/checklist`; добавить правило туда без проверки здесь не даст
 * компилятор.
 *
 * Проверка идёт пачкой: доска спрашивает о десятках карточек сразу, и каждое
 * правило отвечает за все одним запросом, а не запросом на карточку.
 *
 * Считаются только открытые записи. Закрытая запись несёт результат проверки,
 * сохранённый при выходе (`commands.ts`), и не пересчитывается: история
 * стадии — это то, что было, когда с неё ушли, а не то, что есть сейчас.
 */
import { and, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { ChecklistFact, ChecklistState, StageSnapshot } from '$lib/contracts/interactions';
import { isFactItem } from '$lib/contracts/interactions';
import { CONTRACT_DOCUMENT_KIND, CONTRACT_DOCUMENT_TEMPLATES } from '$lib/contracts/documents';
import { PAYMENT_CHECKLIST_KEY } from '$lib/contracts/payments';
import { checklistRule, type ChecklistRuleKey } from '$lib/platform/checklist-rules';
import { formatDate, pluralize } from '$lib/format';
import type { getDb } from '../db';
import {
	affiliations,
	contractItems,
	documents,
	interactionContractItems,
	interactionParties,
	interactionPartySites,
	interactionProducts,
	interactionPrograms,
	interactions,
	learningGroupLearners,
	learningGroupResults,
	learningGroups,
	products,
	programs,
	programVersions,
	sites,
	users
} from '../db/schema';
import type { Tx } from '../db/transaction';
import { readDocumentMark } from '../documents/evidence';
import { countsForStage, readLmsEvidence } from '../integrations/exchange/evidence';

type Executor = Tx | ReturnType<typeof getDb>;

/** Запись стадии в объёме, который нужен правилам. */
export type FactEntry = {
	id: string;
	interactionId: string;
	enteredAt: Date;
	resultText: string | null;
	checklistState: ChecklistState;
	snapshot: StageSnapshot;
};

/** Результаты по записи: ключ пункта → проверка. */
export type EntryFacts = Record<string, ChecklistFact>;

type Evaluate = (
	executor: Executor,
	entries: readonly FactEntry[]
) => Promise<Map<string, ChecklistFact>>;

const NOT_DONE: ChecklistFact = { done: false, evidence: null };

const done = (evidence: string): ChecklistFact => ({ done: true, evidence });

const SLICE = 160;

/** Длинный текст — первой строкой и обрезанный: у пункта место под одну фразу. */
function excerpt(text: string): string {
	const line = text.trim().split('\n')[0];

	return line.length > SLICE ? `${line.slice(0, SLICE - 1)}…` : line;
}

/** По записи на дело: правило, которому ответ про дело, а не про запись. */
function byInteraction(
	entries: readonly FactEntry[],
	answers: ReadonlyMap<string, ChecklistFact>
): Map<string, ChecklistFact> {
	return new Map(entries.map((entry) => [entry.id, answers.get(entry.interactionId) ?? NOT_DONE]));
}

const interactionIds = (entries: readonly FactEntry[]) => [
	...new Set(entries.map((entry) => entry.interactionId))
];

/** Подразделение у основной стороны: площадка вида «Подразделение» выбрана в деле. */
const partyDepartment: Evaluate = async (executor, entries) => {
	const rows = await executor
		.select({ interactionId: interactionParties.interactionId, name: sites.name })
		.from(interactionParties)
		.innerJoin(interactionPartySites, eq(interactionPartySites.partyId, interactionParties.id))
		.innerJoin(sites, eq(sites.id, interactionPartySites.siteId))
		.where(
			and(
				inArray(interactionParties.interactionId, interactionIds(entries)),
				eq(interactionParties.isPrimary, true),
				eq(sites.kind, 'department')
			)
		);

	const names = new Map<string, string[]>();

	for (const row of rows) {
		names.set(row.interactionId, [...(names.get(row.interactionId) ?? []), row.name]);
	}

	return byInteraction(
		entries,
		new Map([...names].map(([id, list]) => [id, done(`Подразделение: ${list.join(', ')}`)]))
	);
};

/**
 * Канал связи у контактного лица основной стороны. Само значение наружу не
 * выходит: это контакт человека, и его видит тот, кому открыты люди.
 */
const contactChannel: Evaluate = async (executor, entries) => {
	const rows = await executor
		.select({ interactionId: interactionParties.interactionId })
		.from(interactionParties)
		.innerJoin(affiliations, eq(affiliations.id, interactionParties.contactAffiliationId))
		.where(
			and(
				inArray(interactionParties.interactionId, interactionIds(entries)),
				eq(interactionParties.isPrimary, true),
				isNotNull(affiliations.channel),
				sql`btrim(${affiliations.channel}) <> ''`
			)
		);

	return byInteraction(
		entries,
		new Map(rows.map((row) => [row.interactionId, done('У контактного лица указан канал связи')]))
	);
};

/**
 * Ответственный у дела. Дело без ответственного не заводится, поэтому пункт
 * выполнен с первой минуты и называет, кто ведёт дело: просить человека
 * отметить то, что система уже знает, — лишняя галочка.
 */
const responsibleAssigned: Evaluate = async (executor, entries) => {
	const rows = await executor
		.select({ interactionId: interactions.id, name: users.fullName })
		.from(interactions)
		.innerJoin(users, eq(users.id, interactions.ownerUserId))
		.where(inArray(interactions.id, interactionIds(entries)));

	return byInteraction(
		entries,
		new Map(rows.map((row) => [row.interactionId, done(`Ответственный: ${row.name}`)]))
	);
};

/** Результат этой записи стадии. */
const stageResult: Evaluate = async (_executor, entries) =>
	new Map(
		entries.map((entry) => [
			entry.id,
			entry.resultText !== null && entry.resultText.trim() !== ''
				? done(`Результат: ${excerpt(entry.resultText)}`)
				: NOT_DONE
		])
	);

/**
 * Новая версия программы: в деле закреплена версия, заведённая после входа на
 * стадию. Версия, выбранная раньше, пункт не закрывает — актуализация означает
 * новую редакцию, а не ту, с которой пришли.
 */
const programVersionNew: Evaluate = async (executor, entries) => {
	const rows = await executor
		.select({
			interactionId: interactionPrograms.interactionId,
			createdAt: programVersions.createdAt,
			version: programVersions.version,
			name: programs.name
		})
		.from(interactionPrograms)
		.innerJoin(programVersions, eq(programVersions.id, interactionPrograms.programVersionId))
		.innerJoin(programs, eq(programs.id, interactionPrograms.programId))
		.where(inArray(interactionPrograms.interactionId, interactionIds(entries)));

	return new Map(
		entries.map((entry) => {
			const fresh = rows.find(
				(row) => row.interactionId === entry.interactionId && row.createdAt >= entry.enteredAt
			);

			return [
				entry.id,
				fresh === undefined ? NOT_DONE : done(`«${fresh.name}», версия ${fresh.version}`)
			];
		})
	);
};

/**
 * Лицензии: по каждому продукту дела выбрана позиция договора с датой
 * оформления лицензии. У дела без продуктов лицензировать нечего — пункт
 * выполнен и так и говорит: иначе дело только с программами встало бы на нём
 * навсегда.
 */
const licensesIssued: Evaluate = async (executor, entries) => {
	const ids = interactionIds(entries);
	const [wanted, selected] = await Promise.all([
		executor
			.select({
				interactionId: interactionProducts.interactionId,
				productId: interactionProducts.productId,
				name: products.name
			})
			.from(interactionProducts)
			.innerJoin(products, eq(products.id, interactionProducts.productId))
			.where(inArray(interactionProducts.interactionId, ids)),
		executor
			.select({
				interactionId: interactionContractItems.interactionId,
				productId: contractItems.productId,
				signedAt: contractItems.licenseSignedAt
			})
			.from(interactionContractItems)
			.innerJoin(contractItems, eq(contractItems.id, interactionContractItems.contractItemId))
			.where(inArray(interactionContractItems.interactionId, ids))
	]);

	const answers = new Map<string, ChecklistFact>();

	for (const id of ids) {
		const own = wanted.filter((row) => row.interactionId === id);

		if (own.length === 0) {
			answers.set(id, done('В деле нет продуктов — лицензировать нечего'));
			continue;
		}

		const missing = own.filter(
			(product) =>
				!selected.some(
					(item) =>
						item.interactionId === id &&
						item.productId === product.productId &&
						item.signedAt !== null
				)
		);

		answers.set(
			id,
			missing.length === 0
				? done(
						`Лицензии оформлены по ${pluralize(own.length, ['продукту', 'продуктам', 'продуктам'])}`
					)
				: {
						done: false,
						evidence: `Нет позиции договора с датой лицензии: ${missing.map((product) => `«${product.name}»`).join(', ')}`
					}
		);
	}

	return byInteraction(entries, answers);
};

/**
 * Акт передачи, собранный по шаблону, утверждён. Тот же факт, которым стадия
 * передачи подтверждается (`requiresDocumentTemplate`): отдельной галочки
 * «акт подписан» поверх него не нужно.
 */
const handoverActApproved: Evaluate = async (executor, entries) => {
	const answers = new Map<string, ChecklistFact>();

	for (const id of interactionIds(entries)) {
		const mark = await readDocumentMark(executor, id, 'approved', 'handover_act');

		if (mark !== null) {
			answers.set(id, done(`«${mark.title}» утверждён ${formatDate(mark.markedAt)}`));
		}
	}

	return byInteraction(entries, answers);
};

/**
 * Поток нужного назначения, засчитываемый делу: программа потока входит в
 * программы дела (то же правило, что у подтверждения стадии обучением).
 */
async function countedGroups(
	executor: Executor,
	entries: readonly FactEntry[],
	purpose: 'teachers' | 'upskilling'
) {
	return executor
		.select({
			id: learningGroups.id,
			interactionId: learningGroups.interactionId,
			streamNumber: learningGroups.streamNumber,
			programName: programs.name
		})
		.from(learningGroups)
		.innerJoin(programs, eq(programs.id, learningGroups.programId))
		.where(
			and(
				inArray(learningGroups.interactionId, interactionIds(entries)),
				countsForStage(executor, [purpose])
			)
		);
}

/** Поток преподавателей со слушателями: список загружен или система обучения прислала зачисление. */
const teachersGroupFormed: Evaluate = async (executor, entries) => {
	const groups = await countedGroups(executor, entries, 'teachers');
	const ids = groups.map((group) => group.id);

	if (ids.length === 0) {
		return byInteraction(entries, new Map());
	}

	const [listed, enrolled] = await Promise.all([
		executor
			.select({ groupId: learningGroupLearners.learningGroupId, count: sql<number>`count(*)::int` })
			.from(learningGroupLearners)
			.where(inArray(learningGroupLearners.learningGroupId, ids))
			.groupBy(learningGroupLearners.learningGroupId),
		executor
			.select({
				groupId: learningGroupResults.learningGroupId,
				enrolled: sql<number>`max(${learningGroupResults.enrolled})::int`
			})
			.from(learningGroupResults)
			.where(
				and(
					inArray(learningGroupResults.learningGroupId, ids),
					gt(learningGroupResults.enrolled, 0)
				)
			)
			.groupBy(learningGroupResults.learningGroupId)
	]);

	const answers = new Map<string, ChecklistFact>();

	for (const group of groups) {
		const people = Math.max(
			listed.find((row) => row.groupId === group.id)?.count ?? 0,
			enrolled.find((row) => row.groupId === group.id)?.enrolled ?? 0
		);

		if (people > 0 && !answers.has(group.interactionId)) {
			answers.set(
				group.interactionId,
				done(
					`Поток ${group.streamNumber}: ${pluralize(people, ['слушатель', 'слушателя', 'слушателей'])}`
				)
			);
		}
	}

	return byInteraction(entries, answers);
};

/** Обучение преподавателей завершено: итог системы обучения или отметка сотрудника по потоку преподавателей. */
const teachersTrainingCompleted: Evaluate = async (executor, entries) => {
	const answers = new Map<string, ChecklistFact>();

	for (const id of interactionIds(entries)) {
		const evidence = await readLmsEvidence(executor, id, ['teachers']);

		if (evidence !== null) {
			answers.set(
				id,
				done(
					evidence.kind === 'result'
						? `Итог группы ${evidence.groupExternalId}: завершили ${evidence.completed}`
						: `Отмечено завершение потока ${evidence.streamNumber}`
				)
			);
		}
	}

	return byInteraction(entries, answers);
};

/** Поток повышения квалификации по программе дела. */
const upskillingGroupProgram: Evaluate = async (executor, entries) => {
	const groups = await countedGroups(executor, entries, 'upskilling');
	const answers = new Map<string, ChecklistFact>();

	for (const group of groups) {
		if (!answers.has(group.interactionId)) {
			answers.set(group.interactionId, done(`Поток ${group.streamNumber}: «${group.programName}»`));
		}
	}

	return byInteraction(entries, answers);
};

/**
 * Зачисление по данным системы обучения: результат по потоку повышения
 * квалификации с зачисленными. Отправленный список — ещё не зачисление.
 */
const upskillingEnrolled: Evaluate = async (executor, entries) => {
	const groups = await countedGroups(executor, entries, 'upskilling');
	const ids = groups.map((group) => group.id);

	if (ids.length === 0) {
		return byInteraction(entries, new Map());
	}

	const rows = await executor
		.select({
			groupId: learningGroupResults.learningGroupId,
			enrolled: sql<number>`max(${learningGroupResults.enrolled})::int`
		})
		.from(learningGroupResults)
		.where(
			and(inArray(learningGroupResults.learningGroupId, ids), gt(learningGroupResults.enrolled, 0))
		)
		.groupBy(learningGroupResults.learningGroupId);

	const answers = new Map<string, ChecklistFact>();

	for (const row of rows) {
		const group = groups.find((candidate) => candidate.id === row.groupId);

		if (group !== undefined && !answers.has(group.interactionId)) {
			answers.set(
				group.interactionId,
				done(`Поток ${group.streamNumber}: зачислено ${row.enrolled}`)
			);
		}
	}

	return byInteraction(entries, answers);
};

/** Документ вида «Документ об обучении» приложен к делу. */
const trainingDocument: Evaluate = async (executor, entries) => {
	const rows = await executor
		.select({ interactionId: documents.interactionId, title: documents.title })
		.from(documents)
		.where(
			and(
				inArray(documents.interactionId, interactionIds(entries)),
				eq(documents.kind, 'certificate')
			)
		);

	const answers = new Map<string, ChecklistFact>();

	for (const row of rows) {
		if (row.interactionId !== null && !answers.has(row.interactionId)) {
			answers.set(row.interactionId, done(`Приложен «${row.title}»`));
		}
	}

	return byInteraction(entries, answers);
};

/**
 * Договор заключён: документ договора дела отмечен «Утверждён» — соглашение,
 * документ вида «Договор» или собранный по шаблону договора (сублицензионный,
 * договор с юридическим лицом), — или оферта акцептована оплатой: отметкой
 * «Оплата получена» этой же стадии. Физическое лицо договора не подписывает:
 * оплата по оферте и есть акцепт.
 */
const contractConcluded: Evaluate = async (executor, entries) => {
	const rows = await executor
		.select({
			interactionId: documents.interactionId,
			title: documents.title,
			approvedAt: documents.approvedAt
		})
		.from(documents)
		.where(
			and(
				inArray(documents.interactionId, interactionIds(entries)),
				or(
					inArray(documents.kind, ['agreement', CONTRACT_DOCUMENT_KIND]),
					inArray(documents.templateKey, [...CONTRACT_DOCUMENT_TEMPLATES])
				),
				isNotNull(documents.approvedAt)
			)
		);

	return new Map(
		entries.map((entry) => {
			const signed = rows.find((row) => row.interactionId === entry.interactionId);

			if (signed !== undefined && signed.approvedAt !== null) {
				return [entry.id, done(`«${signed.title}» утверждён ${formatDate(signed.approvedAt)}`)];
			}

			return [
				entry.id,
				entry.checklistState[PAYMENT_CHECKLIST_KEY] === true
					? done('Оферта акцептована оплатой')
					: NOT_DONE
			];
		})
	);
};

const EVALUATORS: Record<ChecklistRuleKey, Evaluate> = {
	party_department: partyDepartment,
	contact_channel: contactChannel,
	responsible_assigned: responsibleAssigned,
	stage_result: stageResult,
	program_version_new: programVersionNew,
	licenses_issued: licensesIssued,
	handover_act_approved: handoverActApproved,
	teachers_group_formed: teachersGroupFormed,
	teachers_training_completed: teachersTrainingCompleted,
	upskilling_group_program: upskillingGroupProgram,
	upskilling_enrolled: upskillingEnrolled,
	training_document: trainingDocument,
	contract_concluded: contractConcluded
};

/**
 * Пункты-факты открытых записей: запись → пункт → проверка. Запись без
 * пунктов-фактов получает пустой набор.
 *
 * Правило, которого установка не знает (стадию описали при другом составе
 * модулей), пункт не закрывает и говорит почему: выдумать ответ за правило,
 * которого нет, значило бы пустить дело дальше без проверки.
 */
export async function checkFacts(
	executor: Executor,
	entries: readonly FactEntry[]
): Promise<Map<string, EntryFacts>> {
	const result = new Map<string, EntryFacts>(entries.map((entry) => [entry.id, {}]));
	const byRule = new Map<string, { entry: FactEntry; itemKey: string }[]>();

	for (const entry of entries) {
		for (const item of entry.snapshot.checklist) {
			if (isFactItem(item)) {
				const list = byRule.get(item.completion.rule) ?? [];
				list.push({ entry, itemKey: item.key });
				byRule.set(item.completion.rule, list);
			}
		}
	}

	await Promise.all(
		[...byRule].map(async ([rule, targets]) => {
			const evaluate =
				checklistRule(rule) === undefined ? undefined : EVALUATORS[rule as ChecklistRuleKey];
			const answers =
				evaluate === undefined
					? null
					: await evaluate(executor, [...new Set(targets.map((target) => target.entry))]);

			for (const { entry, itemKey } of targets) {
				const facts = result.get(entry.id) ?? {};

				facts[itemKey] =
					answers === null
						? { done: false, evidence: `Правило «${rule}» этой установке неизвестно` }
						: (answers.get(entry.id) ?? NOT_DONE);
				result.set(entry.id, facts);
			}
		})
	);

	return result;
}

/** Пункты-факты одной открытой записи. */
export async function checkEntryFacts(executor: Executor, entry: FactEntry): Promise<EntryFacts> {
	return (await checkFacts(executor, [entry])).get(entry.id) ?? {};
}

/**
 * Сохранённые при выходе результаты — у закрытой записи. Отдельного хранилища
 * у них нет: при выходе результат каждого пункта-факта ложится в отметки
 * записи (`checklistState`), и доказательство — в журнал перехода. Ручная
 * отметка на пункт-факт не ставится никогда, поэтому смешаться им не с чем.
 */
export function frozenFacts(snapshot: StageSnapshot, state: ChecklistState): EntryFacts {
	return Object.fromEntries(
		snapshot.checklist
			.filter(isFactItem)
			.map((item) => [item.key, { done: state[item.key] === true, evidence: null }])
	);
}
