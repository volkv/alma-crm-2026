/**
 * Договоры контрагента и их позиции.
 *
 * Договор принадлежит контрагенту, а не взаимодействию: один договор
 * обслуживает несколько взаимодействий, и привязка к записи процесса означала бы
 * копию договора на каждое. Поэтому запись договора живёт в справочниках рядом с
 * организацией, а взаимодействие только **выбирает** договор и подмножество его
 * позиций (`docs/domain.md`, раздел 3.2).
 *
 * Позиция договора — коммерческие условия по одному продукту: сроки лицензии и
 * статус по передаче. Состав продуктов взаимодействия она не задаёт — это
 * `interaction_products`; позиция добавляет к продукту условия.
 *
 * Два правила держат весь модуль.
 *
 * 1. **Пустое значение ничего не стирает.** Строка каталога почти всегда
 *    неполна, и «в колонке пусто» означает «здесь нет данных», а не «сотрите
 *    то, что записано». Поэтому изменения считаются только по заполненным
 *    значениям, и повторная загрузка того же файла не даёт ни одного изменения.
 * 2. **Что поменялось, видно до записи.** Слияние и запись разведены:
 *    `mergeContract` считает изменения по текущему состоянию и новым значениям,
 *    а пишет их уже `insertContract`/`updateContract`. Благодаря этому
 *    предпросмотр импорта и само применение считают изменения одним и тем же
 *    кодом — расхождение между «что подтвердили» и «что записалось» невозможно
 *    по устройству, а не по договорённости.
 *
 * Своего права у договора пока нет: экрана, с которого его заводят руками, в
 * продукте тоже нет. Гейтом служит `organizations.write` — договор принадлежит
 * контрагенту, и право править его карточку и есть право записать его договор.
 * Появится отдельный раздел договоров — появится и своё право.
 */
import { eq, sql } from 'drizzle-orm';
import type { ContractStatus } from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { contractItems, contracts } from '../db/schema';
import type { Tx } from '../db/transaction';
import { ValidationError } from '../errors';
import { requirePermission } from '../rbac';

/**
 * Статус позиции, с которым она заводится, когда файл о нём молчит. Словарь
 * `transfer_status` свободный (каталога заказчика ещё нет), и «ожидает
 * передачи» — единственное утверждение, которое можно сделать о позиции, про
 * передачу которой ничего не сказано.
 */
export const DEFAULT_TRANSFER_STATUS = 'pending';

/** Одно изменение записи: машинный ключ для кода и название для человека. */
export type FieldChange = {
	key: string;
	label: string;
	/** `null` — поле было пустым. */
	from: string | null;
	to: string;
};

/** Текущее состояние договора — то, с чем сравнивают новые значения. */
export type ContractState = {
	id: string;
	number: string;
	signedOn: string | null;
	validUntil: string | null;
};

/** Текущее состояние позиции договора. */
export type ContractItemState = {
	id: string;
	licenseSignedAt: string | null;
	licenseUntil: string | null;
	transferStatus: string;
};

/** Новые значения договора: `null` — «данных нет», а не «очистить». */
export type ContractDraft = {
	organizationId: string;
	number: string;
	signedOn: string | null;
	validUntil: string | null;
};

/** Новые значения позиции договора. */
export type ContractItemDraft = {
	contractId: string;
	productId: string;
	licenseSignedAt: string | null;
	licenseUntil: string | null;
	transferStatus: string | null;
};

const CONTRACT_FIELD_LABELS = {
	signedOn: 'Дата договора',
	validUntil: 'Договор действует до'
} as const;

const CONTRACT_ITEM_FIELD_LABELS = {
	licenseSignedAt: 'Подписание лицензии',
	licenseUntil: 'Срок действия лицензии',
	transferStatus: 'Статус по передаче'
} as const;

/**
 * Значение после слияния и изменение, если оно есть.
 *
 * Пустое новое значение оставляет прежнее и изменением не считается — это и
 * есть правило «пустое ничего не стирает», выраженное один раз.
 */
function merge<TLabels extends Record<string, string>>(
	labels: TLabels,
	key: keyof TLabels & string,
	current: string | null,
	incoming: string | null,
	changes: FieldChange[]
): string | null {
	if (incoming === null || incoming === current) {
		return current;
	}

	changes.push({ key, label: labels[key], from: current, to: incoming });

	return incoming;
}

/** Порядок дат: срок, истекающий раньше подписания, — это ошибка файла. */
function assertOrdered(
	from: string | null,
	to: string | null,
	message: string,
	explanation: string
): void {
	if (from !== null && to !== null && to < from) {
		throw new ValidationError(message, [explanation]);
	}
}

export type ContractMerge = {
	next: { signedOn: string | null; validUntil: string | null };
	changes: FieldChange[];
};

/**
 * Каким договор станет и что в нём поменяется. Чистая функция: её зовёт и
 * предпросмотр импорта, и запись.
 */
export function mergeContract(
	current: Pick<ContractState, 'signedOn' | 'validUntil'> | null,
	draft: ContractDraft
): ContractMerge {
	const changes: FieldChange[] = [];
	// У создания изменений не бывает: запись заводится целиком, и «поле поменялось
	// с пустого на значение» у неё означало бы, что она уже была.
	const sink = current === null ? [] : changes;
	const signedOn = merge(
		CONTRACT_FIELD_LABELS,
		'signedOn',
		current?.signedOn ?? null,
		draft.signedOn,
		sink
	);
	const validUntil = merge(
		CONTRACT_FIELD_LABELS,
		'validUntil',
		current?.validUntil ?? null,
		draft.validUntil,
		sink
	);

	assertOrdered(
		signedOn,
		validUntil,
		'Договор не записан',
		`Договор «${draft.number}» действует до ${validUntil}, а подписан ${signedOn}`
	);

	return { next: { signedOn, validUntil }, changes };
}

export type ContractItemMerge = {
	next: { licenseSignedAt: string | null; licenseUntil: string | null; transferStatus: string };
	changes: FieldChange[];
};

/** Какой станет позиция договора и что в ней поменяется. */
export function mergeContractItem(
	current: Omit<ContractItemState, 'id'> | null,
	draft: ContractItemDraft
): ContractItemMerge {
	const changes: FieldChange[] = [];
	const sink = current === null ? [] : changes;

	const licenseSignedAt = merge(
		CONTRACT_ITEM_FIELD_LABELS,
		'licenseSignedAt',
		current?.licenseSignedAt ?? null,
		draft.licenseSignedAt,
		sink
	);
	const licenseUntil = merge(
		CONTRACT_ITEM_FIELD_LABELS,
		'licenseUntil',
		current?.licenseUntil ?? null,
		draft.licenseUntil,
		sink
	);
	const transferStatus =
		merge(
			CONTRACT_ITEM_FIELD_LABELS,
			'transferStatus',
			current?.transferStatus ?? null,
			draft.transferStatus,
			sink
		) ?? DEFAULT_TRANSFER_STATUS;

	assertOrdered(
		licenseSignedAt,
		licenseUntil,
		'Позиция договора не записана',
		`Лицензия действует до ${licenseUntil}, а подписана ${licenseSignedAt}`
	);

	return { next: { licenseSignedAt, licenseUntil, transferStatus }, changes };
}

/**
 * Заводит договор. Состояние выбирается по тому, что о договоре известно:
 * подписанный договор действует, а договор без даты подписания — черновик.
 * Дальше состоянием распоряжается работа с договором, а не импорт: файл о нём
 * ничего не говорит, и переводить действующий договор в черновик загрузкой
 * значило бы менять смысл записи молча.
 */
export async function insertContract(
	ctx: ActorContext,
	tx: Tx,
	draft: ContractDraft
): Promise<ContractState> {
	requirePermission(ctx, 'organizations.write');

	const number = draft.number.trim();

	if (number === '') {
		throw new ValidationError('Договор не записан', ['У договора должен быть номер']);
	}

	const { next } = mergeContract(null, draft);
	const status: ContractStatus = next.signedOn === null ? 'draft' : 'active';

	const [row] = await tx
		.insert(contracts)
		.values({
			organizationId: draft.organizationId,
			number,
			signedOn: next.signedOn,
			validUntil: next.validUntil,
			status
		})
		.returning({
			id: contracts.id,
			number: contracts.number,
			signedOn: contracts.signedOn,
			validUntil: contracts.validUntil
		});

	return row;
}

/** Записывает новые значения договора. Пустые значения сюда не доходят. */
export async function updateContract(
	ctx: ActorContext,
	tx: Tx,
	id: string,
	next: ContractMerge['next']
): Promise<void> {
	requirePermission(ctx, 'organizations.write');

	await tx
		.update(contracts)
		.set({ ...next, updatedAt: sql`now()` })
		.where(eq(contracts.id, id));
}

export async function insertContractItem(
	ctx: ActorContext,
	tx: Tx,
	draft: ContractItemDraft
): Promise<ContractItemState> {
	requirePermission(ctx, 'organizations.write');

	const { next } = mergeContractItem(null, draft);

	const [row] = await tx
		.insert(contractItems)
		.values({ contractId: draft.contractId, productId: draft.productId, ...next })
		.returning({
			id: contractItems.id,
			licenseSignedAt: contractItems.licenseSignedAt,
			licenseUntil: contractItems.licenseUntil,
			transferStatus: contractItems.transferStatus
		});

	return row;
}

export async function updateContractItem(
	ctx: ActorContext,
	tx: Tx,
	id: string,
	next: ContractItemMerge['next']
): Promise<void> {
	requirePermission(ctx, 'organizations.write');

	await tx
		.update(contractItems)
		.set({ ...next, updatedAt: sql`now()` })
		.where(eq(contractItems.id, id));
}
