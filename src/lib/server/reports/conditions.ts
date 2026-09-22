/**
 * Условия выборки отчёта и признаки взаимодействия, которые показываются в
 * строке.
 *
 * Условия одни на оба режима: адрес описывает, про какие взаимодействия вопрос,
 * а режим — какой именно вопрос про них задан. Область доступа применяется
 * всегда и поверх фильтров, **тем же условием, что и в списке**
 * (`interactionScopeFilter`): пересказ этого условия здесь разошёлся бы с
 * кодом, и числа отчёта не сошлись бы с числом строк списка на том же фильтре.
 *
 * Многозначные параметры внутри одного работают как «или», а между параметрами
 * — как «и». Многозначный признак взаимодействия считается подходящим, если
 * подходит хотя бы одно его значение: взаимодействие с двумя продуктами
 * попадает и в отчёт по первому, и в отчёт по второму.
 *
 * Выборка делится надвое, и это деление — не украшение, а цена отклика.
 * **Колонки выборки** (`SELECTION_COLUMNS`) считаются для каждой строки: по ним
 * работают фильтры, сортировка и все агрегаты. **Признаки строки**
 * (`ATTRIBUTE_COLUMNS`) — боковые выборки по связям многие ко многим, и они
 * считаются только для показанных строк: экрану нужна одна страница, а не все
 * три тысячи.
 */
import { and, sql, type SQL } from 'drizzle-orm';
import type { InteractionStatus } from '$lib/contracts/interactions';
import type {
	ReportDocumentRef,
	ReportLearningGroupRef,
	ReportQuery
} from '$lib/contracts/reports';
import type { ActorContext } from '../actor';
import { interactionScopeFilter } from '../interactions/access';

/** Список значений для `in (…)`. Каждое значение уходит параметром запроса. */
function inList(values: readonly string[]): SQL {
	return sql`(${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `
	)})`;
}

/**
 * Основная сторона взаимодействия — та, с которой ведётся процесс, — и её
 * организация. Один боковой join на выборку, а не подзапрос в каждом месте, где
 * про основную сторону спрашивают: подзапросов таких мест набирается четыре
 * (колонка вуза, ответственный за вуз, фильтр по типу контрагента, фильтр по
 * ответственному), и база считала бы одно и то же четырежды на строку.
 *
 * Ставится сразу за `from interactions` в **каждой** выборке отчёта: и условия,
 * и колонки ссылаются на `primary_party` и `counterparty` по имени.
 */
export const PRIMARY_PARTY_JOIN = sql`
	left join lateral (
		select parties.organization_id as id
		from interaction_parties parties
		where parties.interaction_id = interactions.id and parties.is_primary
		limit 1
	) primary_party on true
	left join organizations counterparty on counterparty.id = primary_party.id
`;

/**
 * Условия на взаимодействие. Возвращает одно выражение: вызывающий подставляет
 * его в `where` своего запроса, а не собирает список заново. Запрос обязан
 * содержать `PRIMARY_PARTY_JOIN`.
 */
export function interactionConditions(ctx: ActorContext, query: ReportQuery): SQL {
	const conditions: SQL[] = [interactionScopeFilter(ctx)];

	if (query.org.length > 0) {
		conditions.push(sql`exists (
			select 1 from interaction_parties parties
			where parties.interaction_id = interactions.id
				and parties.organization_id in ${inList(query.org)}
		)`);
	}

	if (query.party.length > 0) {
		conditions.push(sql`counterparty.kind in ${inList(query.party)}`);
	}

	if (query.dir.length > 0) {
		// Направление взаимодействия — объединение направлений его продуктов и
		// его программ: у продуктонезависимой программы направление своё, и без
		// второй половины такие программы выпали бы из разреза целиком.
		conditions.push(sql`(
			exists (
				select 1 from interaction_products chosen
				join product_directions product_direction on product_direction.product_id = chosen.product_id
				where chosen.interaction_id = interactions.id
					and product_direction.direction_id in ${inList(query.dir)}
			)
			or exists (
				select 1 from interaction_programs chosen
				join programs program on program.id = chosen.program_id
				where chosen.interaction_id = interactions.id
					and program.direction_id in ${inList(query.dir)}
			)
		)`);
	}

	if (query.prog.length > 0) {
		conditions.push(sql`exists (
			select 1 from interaction_programs chosen
			where chosen.interaction_id = interactions.id and chosen.program_id in ${inList(query.prog)}
		)`);
	}

	if (query.prod.length > 0) {
		conditions.push(sql`exists (
			select 1 from interaction_products chosen
			where chosen.interaction_id = interactions.id and chosen.product_id in ${inList(query.prod)}
		)`);
	}

	if (query.owner.length > 0) {
		conditions.push(sql`interactions.owner_user_id in ${inList(query.owner)}`);
	}

	if (query.assignee.length > 0) {
		// Фильтр по ответственному за вуз работает по действующим назначениям, а
		// одноимённая колонка историческая: это признак вуза, а не записи, и
		// вопрос «кто ведёт этот вуз сейчас» задают именно в настоящем времени.
		conditions.push(sql`exists (
			select 1 from organization_responsibles responsible
			where responsible.organization_id = primary_party.id
				and responsible.valid_to is null
				and responsible.user_id in ${inList(query.assignee)}
		)`);
	}

	if (query.state.length > 0) {
		conditions.push(sql`interactions.status in ${inList(query.state)}`);
	}

	if (query.transfer.length > 0) {
		conditions.push(sql`exists (
			select 1 from interaction_contract_items chosen
			join contract_items item on item.id = chosen.contract_item_id
			where chosen.interaction_id = interactions.id
				and item.transfer_status in ${inList(query.transfer)}
		)`);
	}

	if (query.workspace.length > 0) {
		conditions.push(sql`exists (
			select 1 from workspaces workspace
			where workspace.id = interactions.workspace_id
				and workspace.key in ${inList(query.workspace)}
		)`);
	}

	return and(...conditions) ?? sql`true`;
}

/**
 * Колонки выборки: то, что считается для каждой строки в обоих режимах.
 *
 * Здесь только однозначные признаки — те, что не размножают строку и берутся
 * одним join'ом. По ним работают агрегаты (итоги, воронка, разрезы по вузам и
 * ответственным) и сортировка страницы, поэтому считать их приходится по всей
 * выборке. Требуют `PRIMARY_PARTY_JOIN` и join пространства.
 */
export const SELECTION_COLUMNS = sql`
	interactions.id as "interactionId",
	interactions.title as "title",
	interactions.status as "status",
	interactions.workspace_id as "workspaceId",
	interactions.owner_user_id as "ownerUserId",
	interactions.contract_id as "contractId",
	workspace.key as "workspaceKey",
	counterparty.id as "organizationId",
	counterparty.short_name as "organizationName",
	counterparty.kind as "organizationKind"
`;

/**
 * Признаки взаимодействия для строки отчёта. Все — боковыми выборками по одному
 * взаимодействию: `join` по связи «многие ко многим» удвоил бы строку и сломал
 * бы все суммы (зерно строки фиксировано и от выбранных колонок не зависит).
 *
 * Считаются только для строк, которые уйдут в ответ: страница экрана или полный
 * набор выгрузки. Итогам, воронке и разрезам они не нужны — те считаются
 * агрегирующими запросами по колонкам выборки (`reports/aggregate.ts`).
 */
export const ATTRIBUTE_COLUMNS = sql`
	owner_user.full_name as "ownerName",
	contract.number as "contractNumber",
	coalesce(interaction_programs_agg.ids, '{}'::uuid[]) as "programIds",
	coalesce(interaction_programs_agg.names, '{}'::text[]) as "programs",
	coalesce(interaction_products_agg.ids, '{}'::uuid[]) as "productIds",
	coalesce(interaction_products_agg.names, '{}'::text[]) as "products",
	coalesce(interaction_directions_agg.ids, '{}'::uuid[]) as "directionIds",
	coalesce(interaction_directions_agg.names, '{}'::text[]) as "directions",
	coalesce(interaction_transfer_agg.names, '{}'::text[]) as "transferStatuses",
	coalesce(interaction_assignees_agg.names, '{}'::text[]) as "assignees",
	coalesce(interaction_documents_agg.items, '[]'::json) as "documents",
	coalesce(interaction_learning_groups_agg.items, '[]'::json) as "learningGroups"
`;

/**
 * Боковые выборки к признакам. `source` — псевдоним уже отобранных строк
 * (страница экрана или весь набор выгрузки): признаки считаются от него, а не
 * от таблицы взаимодействий, поэтому их цена — это цена показанных строк.
 *
 * Ответственный за вуз берётся на момент среза: колонка историческая и
 * показывает назначения, действовавшие на `T`. Момент передаётся строкой ISO, а
 * не `Date`: у параметра в готовом SQL нет выведенного типа, и драйвер
 * отказывается кодировать объект даты вслепую.
 */
export function attributeJoins(asOf: string, source: SQL): SQL {
	return sql`
		left join users owner_user on owner_user.id = ${source}."ownerUserId"
		left join contracts contract on contract.id = ${source}."contractId"
		left join lateral (
			select
				array_agg(program.id order by program.code) as ids,
				array_agg(program.name order by program.code) as names
			from interaction_programs chosen
			join programs program on program.id = chosen.program_id
			where chosen.interaction_id = ${source}."interactionId"
		) interaction_programs_agg on true
		left join lateral (
			select
				array_agg(product.id order by product.code) as ids,
				array_agg(product.name order by product.code) as names
			from interaction_products chosen
			join products product on product.id = chosen.product_id
			where chosen.interaction_id = ${source}."interactionId"
		) interaction_products_agg on true
		left join lateral (
			select
				array_agg(direction.id order by direction.position) as ids,
				array_agg(direction.name order by direction.position) as names
			from directions direction
			where exists (
					select 1 from interaction_products chosen
					join product_directions product_direction on product_direction.product_id = chosen.product_id
					where chosen.interaction_id = ${source}."interactionId"
						and product_direction.direction_id = direction.id
				)
				or exists (
					select 1 from interaction_programs chosen
					join programs program on program.id = chosen.program_id
					where chosen.interaction_id = ${source}."interactionId"
						and program.direction_id = direction.id
				)
		) interaction_directions_agg on true
		left join lateral (
			select array_agg(distinct item.transfer_status) as names
			from interaction_contract_items chosen
			join contract_items item on item.id = chosen.contract_item_id
			where chosen.interaction_id = ${source}."interactionId"
		) interaction_transfer_agg on true
		left join lateral (
			select array_agg(distinct assignee.full_name) as names
			from organization_responsibles responsible
			join users assignee on assignee.id = responsible.user_id
			where responsible.organization_id = ${source}."organizationId"
				and responsible.valid_from <= ${asOf}::timestamptz
				and (responsible.valid_to is null or responsible.valid_to > ${asOf}::timestamptz)
		) interaction_assignees_agg on true
		left join lateral (
			select json_agg(json_build_object(
				'id', document.id,
				'kind', document.kind,
				'storageKey', document.file_path,
				'sha256', document.sha256
			) order by document.created_at) as items
			from documents document
			where document.interaction_id = ${source}."interactionId"
		) interaction_documents_agg on true
		left join lateral (
			select json_agg(json_build_object(
				'id', learning_group.id,
				'externalId', learning_group.group_external_id,
				'resultId', latest_result.id
			) order by learning_group.stream_number) as items
			from learning_groups learning_group
			left join lateral (
				select result.id
				from learning_group_results result
				where result.learning_group_id = learning_group.id
				order by result.occurred_at desc
				limit 1
			) latest_result on true
			where learning_group.interaction_id = ${source}."interactionId"
		) interaction_learning_groups_agg on true
	`;
}

/**
 * Колонки выборки в том виде, в каком их отдаёт база. Идентификаторы едут рядом
 * с названиями: по ним разрез строит ссылку «показать только эти», а показывать
 * в ячейке идентификатор нельзя.
 */
export type ReportSelection = {
	interactionId: string;
	title: string;
	status: InteractionStatus;
	workspaceId: string;
	workspaceKey: string;
	ownerUserId: string;
	contractId: string | null;
	organizationId: string | null;
	organizationName: string | null;
	organizationKind: string | null;
};

/** Признаки строки: считаются только для показанных строк. */
export type ReportAttributes = {
	ownerName: string | null;
	contractNumber: string | null;
	programIds: string[];
	programs: string[];
	productIds: string[];
	products: string[];
	directionIds: string[];
	directions: string[];
	transferStatuses: string[];
	assignees: string[];
	/**
	 * Ключи связи для проверки числа. Едут объектами JSON, а не параллельными
	 * массивами: у документа четыре поля, и четыре массива разъехались бы на
	 * первой же строке без документа.
	 */
	documents: ReportDocumentRef[];
	learningGroups: ReportLearningGroupRef[];
};

/**
 * Окно страницы. Отсутствие окна — это выгрузка: у неё набор полный, иначе файл
 * показал бы меньше строк, чем экран, и выглядел бы при этом правдой.
 */
export type RowWindow = { limit: number; offset: number };

/** `limit … offset …` или пусто: у выгрузки окна нет. */
export function windowClause(window: RowWindow | null): SQL {
	return window === null ? sql`` : sql`limit ${window.limit} offset ${window.offset}`;
}

export { inList };
