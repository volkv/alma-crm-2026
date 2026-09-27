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
 * Своего права у договора нет: гейтом служит `organizations.write` — договор
 * принадлежит контрагенту, и право править его карточку и есть право записать
 * его договор. Читается он под `organizations.read` и в той же области доступа,
 * что сам контрагент: отдельного раздела договоров в продукте нет, они живут
 * блоком карточки вуза (`docs/access-matrix.md`).
 */
import { and, asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PageResult } from '$lib/contracts/common';
import { AWAITING_TRANSFER_STATUS } from '$lib/contracts/documents';
import type {
	ContractItemView,
	ContractListQuery,
	ContractView,
	SaveContractInput,
	SaveContractItemInput
} from '$lib/contracts/directory';
import type { ContractStatus } from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { contractItems, contracts, products } from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { NotFoundError, ValidationError } from '../errors';
import { visibleOrganizationFilter } from '../interactions/access';
import {
	assertEditVersion,
	editorOf,
	firstEdit,
	nextEdit,
	type Editor
} from '../interactions/edit-version';
import { requirePermission, scopeFilter } from '../rbac';
import { withUniqueConflicts } from './conflicts';
import { getOrganization } from './read';

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
	/**
	 * Состояние договора — от того, кто его знает. Форма знает: человек выбирает
	 * состояние списком. Импорт не знает: файл о состоянии молчит, и тогда оно
	 * выводится из даты подписания.
	 */
	status?: ContractStatus;
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
	// Словарь `transfer_status` свободный (каталога заказчика ещё нет), и «ожидает
	// передачи» — единственное утверждение, которое можно сделать о позиции, про
	// передачу которой файл молчит.
	const transferStatus =
		merge(
			CONTRACT_ITEM_FIELD_LABELS,
			'transferStatus',
			current?.transferStatus ?? null,
			draft.transferStatus,
			sink
		) ?? AWAITING_TRANSFER_STATUS;

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
	const status: ContractStatus = draft.status ?? (next.signedOn === null ? 'draft' : 'active');

	const [row] = await tx
		.insert(contracts)
		.values({
			organizationId: draft.organizationId,
			number,
			signedOn: next.signedOn,
			validUntil: next.validUntil,
			status,
			...firstEdit(editorOf(ctx))
		})
		.returning({
			id: contracts.id,
			number: contracts.number,
			signedOn: contracts.signedOn,
			validUntil: contracts.validUntil
		});

	return row;
}

/**
 * Значения договора для записи.
 *
 * Номер и состояние присылает тот, кто ими распоряжается, — форма справочника.
 * Импорт их не касается: переименовать договор или перевести действующий в
 * черновик загрузкой значило бы поменять смысл записи молча.
 */
export type ContractWrite = ContractMerge['next'] & {
	number?: string;
	status?: ContractStatus;
};

/** Записывает новые значения договора. Пустые значения сюда не доходят. */
export async function updateContract(
	ctx: ActorContext,
	tx: Tx,
	id: string,
	next: ContractWrite
): Promise<void> {
	requirePermission(ctx, 'organizations.write');

	await tx
		.update(contracts)
		.set({ ...next, ...nextEdit(contracts.editVersion, editorOf(ctx)), updatedAt: sql`now()` })
		.where(eq(contracts.id, id));
}

/**
 * Позиции договоров поменялись — сдвигается версия их договоров.
 *
 * Версия одна на договор с позициями: блок карточки правит их вместе, и
 * открытая форма договора должна узнать о смене статуса передачи так же, как
 * о смене сроков. Договоры блокируются по порядку идентификаторов и **до**
 * позиций — тем же порядком, что у формы договора: иначе запись позиций и
 * сохранение договора, отданные навстречу, ждали бы друг друга.
 */
export async function bumpContractsOfItems(
	tx: Tx,
	itemIds: readonly string[],
	editor: Editor
): Promise<void> {
	if (itemIds.length === 0) {
		return;
	}

	const owners = await tx
		.selectDistinct({ contractId: contractItems.contractId })
		.from(contractItems)
		.where(inArray(contractItems.id, [...itemIds]));

	await bumpContracts(
		tx,
		owners.map((row) => row.contractId),
		editor
	);
}

async function bumpContracts(
	tx: Tx,
	contractIds: readonly string[],
	editor: Editor
): Promise<void> {
	const ids = [...new Set(contractIds)].sort();

	for (const id of ids) {
		await tx
			.update(contracts)
			.set({ ...nextEdit(contracts.editVersion, editor), updatedAt: sql`now()` })
			.where(eq(contracts.id, id));
	}
}

export async function insertContractItem(
	ctx: ActorContext,
	tx: Tx,
	draft: ContractItemDraft
): Promise<ContractItemState> {
	requirePermission(ctx, 'organizations.write');

	const { next } = mergeContractItem(null, draft);

	await bumpContracts(tx, [draft.contractId], editorOf(ctx));

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

	await bumpContractsOfItems(tx, [id], editorOf(ctx));

	await tx
		.update(contractItems)
		.set({ ...next, updatedAt: sql`now()` })
		.where(eq(contractItems.id, id));
}

/** Позиции перечисленных договоров, уже с названием продукта. */
async function readItems(contractIds: string[]): Promise<Map<string, ContractItemView[]>> {
	const byContract = new Map<string, ContractItemView[]>();

	if (contractIds.length === 0) {
		return byContract;
	}

	const rows = await getDb()
		.select({
			id: contractItems.id,
			contractId: contractItems.contractId,
			productId: contractItems.productId,
			productCode: products.code,
			productName: products.name,
			licenseSignedAt: contractItems.licenseSignedAt,
			licenseUntil: contractItems.licenseUntil,
			transferStatus: contractItems.transferStatus
		})
		.from(contractItems)
		.innerJoin(products, eq(products.id, contractItems.productId))
		.where(inArray(contractItems.contractId, contractIds))
		.orderBy(asc(products.code), asc(contractItems.id));

	for (const row of rows) {
		const list = byContract.get(row.contractId);

		if (list === undefined) {
			byContract.set(row.contractId, [row]);
		} else {
			list.push(row);
		}
	}

	return byContract;
}

/**
 * Договоры по условию — вместе с позициями.
 *
 * Позиции читаются вторым запросом по списку договоров, а не соединением:
 * иначе договор с пятью позициями приехал бы пятью строками, и страница списка
 * считала бы не то, что показывает.
 */
async function readContracts(where: SQL, limit?: number, offset?: number): Promise<ContractView[]> {
	const query = getDb()
		.select({
			id: contracts.id,
			organizationId: contracts.organizationId,
			number: contracts.number,
			signedOn: contracts.signedOn,
			validUntil: contracts.validUntil,
			status: contracts.status,
			editVersion: contracts.editVersion,
			createdAt: contracts.createdAt,
			updatedAt: contracts.updatedAt
		})
		.from(contracts)
		.where(where)
		// Последний ключ — идентификатор: у двух договоров с одним номером
		// (номера уникальны только внутри контрагента) порядок иначе не
		// определён, и запись с границы страниц показалась бы дважды.
		.orderBy(asc(contracts.number), asc(contracts.id))
		.$dynamic();

	const rows = await (limit === undefined ? query : query.limit(limit).offset(offset ?? 0));
	const items = await readItems(rows.map((row) => row.id));

	return rows.map((row) => ({ ...row, items: items.get(row.id) ?? [] }));
}

/**
 * Договоры контрагента для его карточки.
 *
 * Условие видимости — то же, что у самой карточки (`visibleOrganizationFilter`):
 * у кого вуз забрали, а незавершённое взаимодействие осталось, тот продолжает
 * видеть и договор, по которому оно идёт. Страницами список не режется: у вуза
 * договоров единицы, а разрезанный на страницы блок карточки скрыл бы часть
 * условий, ничего не сказав.
 */
export async function listOrganizationContracts(
	ctx: ActorContext,
	organizationId: string
): Promise<ContractView[]> {
	requirePermission(ctx, 'organizations.read');

	return readContracts(
		and(
			eq(contracts.organizationId, organizationId),
			visibleOrganizationFilter(ctx, contracts.organizationId)
		) as SQL
	);
}

/**
 * Один договор с позициями или «не найден».
 *
 * Договор вне области доступа неотличим от несуществующего: иначе перебором
 * идентификаторов можно узнать, с кем у оператора есть договоры.
 */
export async function getContract(ctx: ActorContext, id: string): Promise<ContractView> {
	requirePermission(ctx, 'organizations.read');

	const [contract] = await readContracts(
		and(eq(contracts.id, id), visibleOrganizationFilter(ctx, contracts.organizationId)) as SQL
	);

	if (contract === undefined) {
		throw new NotFoundError('Договор не найден');
	}

	return contract;
}

/**
 * Страница списка договоров: то, что отдаёт `GET /v1/contracts`.
 *
 * Область здесь — назначения (`scopeFilter`), как и у списка организаций:
 * список — это перечень имущества оператора, и расширять его записями, видными
 * через чужое взаимодействие, значило бы отдать по ключу больше, чем показывает
 * раздел вузов.
 */
export async function listContracts(
	ctx: ActorContext,
	query: ContractListQuery
): Promise<PageResult<ContractView>> {
	requirePermission(ctx, 'organizations.read');

	const conditions: SQL[] = [scopeFilter(ctx, contracts.organizationId)];

	if (query.organizationId !== null) {
		conditions.push(eq(contracts.organizationId, query.organizationId));
	}

	if (query.status !== null) {
		conditions.push(eq(contracts.status, query.status));
	}

	const where = and(...conditions) as SQL;

	const [items, [total]] = await Promise.all([
		readContracts(where, query.pageSize, (query.page - 1) * query.pageSize),
		getDb().select({ value: count() }).from(contracts).where(where)
	]);

	return { items, total: total.value, page: query.page, pageSize: query.pageSize };
}

/**
 * Блокировка строки договора и сверка версии, с которой открыта форма. Отказ —
 * до первой записи; `null` у правки существующего договора сюда не доходит —
 * его отвергает схема команды.
 */
async function lockContractVersion(
	tx: Tx,
	contractId: string,
	expected: number | null
): Promise<void> {
	if (expected === null) {
		throw new ValidationError('Форма не знает версию договора', ['Обновите карточку']);
	}

	const [row] = await tx
		.select({
			editVersion: contracts.editVersion,
			editedBy: contracts.editedBy,
			editedVia: contracts.editedVia,
			editedAt: contracts.editedAt
		})
		.from(contracts)
		.where(eq(contracts.id, contractId))
		.for('update');

	if (row === undefined) {
		throw new NotFoundError('Договор не найден');
	}

	await assertEditVersion(tx, row, expected);
}

/**
 * Договор контрагента: заводится или правится целиком.
 *
 * Команда одна на оба случая, потому что форма присылает запись целиком:
 * «завести» отличается от «исправить» ровно тем, есть ли уже идентификатор.
 * Правило импорта «пустое ничего не стирает» здесь не действует — человек,
 * очистивший поле, именно его и очищает.
 */
export async function saveContract(
	ctx: ActorContext,
	input: SaveContractInput
): Promise<ContractView> {
	const creating = input.id === null;

	await requirePermission(ctx, 'organizations.write', {
		type: creating ? 'directory.contract_created' : 'directory.contract_updated',
		subject: { type: 'organization', id: input.organizationId }
	});

	// Право на запись само по себе не даёт доступа к чужому вузу: карточка
	// читается с областью, и договор чужого контрагента отсюда не завести.
	await getOrganization(ctx, input.organizationId);

	if (input.id !== null) {
		const before = await getContract(ctx, input.id);

		// Договор не переносят между контрагентами: на него ссылаются
		// взаимодействия, и перенос сделал бы эти ссылки ложью.
		if (before.organizationId !== input.organizationId) {
			throw new ValidationError('Договор нельзя перенести к другому контрагенту', [
				'Заведите договор в карточке нужного контрагента'
			]);
		}
	}

	const id = await withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			if (input.id === null) {
				const created = await insertContract(ctx, tx, {
					organizationId: input.organizationId,
					number: input.number,
					signedOn: input.signedOn,
					validUntil: input.validUntil,
					status: input.status
				});

				await recordAuditEvent(
					ctx,
					{
						type: 'directory.contract_created',
						outcome: 'success',
						subject: { type: 'contract', id: created.id },
						details: { organizationId: input.organizationId }
					},
					tx
				);

				return created.id;
			}

			await lockContractVersion(tx, input.id, input.editVersion);

			await updateContract(ctx, tx, input.id, {
				number: input.number,
				signedOn: input.signedOn,
				validUntil: input.validUntil,
				status: input.status
			});

			await recordAuditEvent(
				ctx,
				{
					type: 'directory.contract_updated',
					outcome: 'success',
					subject: { type: 'contract', id: input.id },
					details: { organizationId: input.organizationId }
				},
				tx
			);

			return input.id;
		})
	);

	return getContract(ctx, id);
}

/**
 * Позиция договора: заводится или правится целиком, как и сам договор.
 *
 * Продукт позиции меняться не может: на пару «договор + продукт» ссылаются
 * взаимодействия, и подмена продукта под уже выбранной позицией переписала бы
 * условия чужой работы. Нужен другой продукт — это другая позиция.
 */
export async function saveContractItem(
	ctx: ActorContext,
	input: SaveContractItemInput
): Promise<ContractView> {
	const creating = input.id === null;

	await requirePermission(ctx, 'organizations.write', {
		type: creating ? 'directory.contract_item_created' : 'directory.contract_item_updated',
		subject: { type: 'contract', id: input.contractId }
	});

	const contract = await getContract(ctx, input.contractId);
	const existing =
		input.id === null ? null : (contract.items.find((item) => item.id === input.id) ?? null);

	if (input.id !== null && existing === null) {
		throw new NotFoundError('Позиция договора не найдена');
	}

	if (existing !== null && existing.productId !== input.productId) {
		throw new ValidationError('Продукт позиции договора изменить нельзя', [
			'Заведите позицию по нужному продукту: условия по прежнему продукту останутся на месте'
		]);
	}

	if (existing === null) {
		const [product] = await getDb()
			.select({ id: products.id })
			.from(products)
			.where(eq(products.id, input.productId))
			.limit(1);

		if (product === undefined) {
			throw new ValidationError('Продукт не найден', ['Выберите продукт из каталога']);
		}
	}

	await withUniqueConflicts(() =>
		withTransaction(ctx, async (tx) => {
			// Позицию правят в блоке договора, и версия у них общая: новая позиция
			// или правка старой после чужой правки договора — тот же отказ.
			await lockContractVersion(tx, input.contractId, input.editVersion);

			if (existing === null) {
				const created = await insertContractItem(ctx, tx, {
					contractId: input.contractId,
					productId: input.productId,
					licenseSignedAt: input.licenseSignedAt,
					licenseUntil: input.licenseUntil,
					transferStatus: input.transferStatus
				});

				await recordAuditEvent(
					ctx,
					{
						type: 'directory.contract_item_created',
						outcome: 'success',
						subject: { type: 'contract_item', id: created.id },
						details: { contractId: input.contractId, productId: input.productId }
					},
					tx
				);

				return;
			}

			await updateContractItem(ctx, tx, existing.id, {
				licenseSignedAt: input.licenseSignedAt,
				licenseUntil: input.licenseUntil,
				transferStatus: input.transferStatus
			});

			await recordAuditEvent(
				ctx,
				{
					type: 'directory.contract_item_updated',
					outcome: 'success',
					subject: { type: 'contract_item', id: existing.id },
					details: { contractId: input.contractId, productId: input.productId }
				},
				tx
			);
		})
	);

	return getContract(ctx, input.contractId);
}
