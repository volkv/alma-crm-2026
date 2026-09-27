/**
 * Оператор — сама школа — стороной каждого взаимодействия.
 *
 * Школа представлена в справочнике организацией вида `operator`
 * (`ORGANIZATION_KINDS`): «сама школа в своих процессах, сторона договоров».
 * Пакет документов, акт и сублицензия подписываются от её имени, и дело без
 * этой стороны до документов не доходит. Поэтому сторону ставит само
 * заведение дела, одним правилом для формы, API и заявок с сайта, а не
 * человек, который о ней может не знать.
 *
 * Какая организация — школа, решает справочник, а не догадка: действующая
 * организация вида «Оператор» должна быть ровно одна. Нет её или их несколько
 * — это настройка стенда, которую чинит администратор, и заведение дела
 * отказывает словами, как её починить. Выбрать «первую попавшуюся» значило бы
 * подписать документы от чужого имени.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { CreateInteractionInput } from '$lib/contracts/interactions';
import { organizations } from '../db/schema';
import type { Tx } from '../db/transaction';
import type { getDb } from '../db';
import { ConflictError } from '../errors';

type Executor = Tx | ReturnType<typeof getDb>;

type PartyInput = CreateInteractionInput['parties'][number];

/** Что справочник говорит о школе: одна организация, ни одной или несколько. */
export type SchoolOperator =
	| { state: 'configured'; id: string; name: string }
	| { state: 'missing' }
	| { state: 'ambiguous'; names: string[] };

export async function readSchoolOperator(executor: Executor): Promise<SchoolOperator> {
	const rows = await executor
		.select({ id: organizations.id, name: organizations.shortName })
		.from(organizations)
		.where(and(eq(organizations.kind, 'operator'), eq(organizations.isActive, true)))
		.orderBy(asc(organizations.shortName));

	if (rows.length === 0) {
		return { state: 'missing' };
	}

	if (rows.length > 1) {
		return { state: 'ambiguous', names: rows.map((row) => row.name) };
	}

	return { state: 'configured', id: rows[0].id, name: rows[0].name };
}

/** Почему школу не определить — словами для того, кто это исправит. */
export function schoolOperatorProblem(operator: Exclude<SchoolOperator, { state: 'configured' }>): {
	message: string;
	issues: string[];
} {
	if (operator.state === 'missing') {
		return {
			message: 'В справочнике не указана организация школы',
			issues: [
				'Администратор заводит школу в разделе «Организации» с типом «Оператор»: от её имени собираются договоры и акты, и она стоит стороной каждого взаимодействия'
			]
		};
	}

	return {
		message: 'В справочнике несколько организаций школы',
		issues: [
			`Действующих организаций с типом «Оператор» ${operator.names.length}: ${operator.names.map((name) => `«${name}»`).join(', ')}. Оставьте одну, остальные переведите в архив или смените им тип`
		]
	};
}

/**
 * Стороны нового дела вместе с оператором.
 *
 * Переданный оператор остаётся как есть: приём заявки или API могли назвать
 * его сами. Не передан — ставится школа из справочника. Школа, которая уже
 * стоит стороной в другой роли, — противоречие, которое молча не разрешить:
 * одна организация участвует в деле один раз.
 */
export async function withSchoolOperator(tx: Tx, parties: PartyInput[]): Promise<PartyInput[]> {
	if (parties.some((party) => party.partyRole === 'operator')) {
		return parties;
	}

	const operator = await readSchoolOperator(tx);

	if (operator.state !== 'configured') {
		const problem = schoolOperatorProblem(operator);

		throw new ConflictError(`${problem.message}. ${problem.issues.join('. ')}`);
	}

	if (parties.some((party) => party.organizationId === operator.id)) {
		throw new ConflictError(
			`Организация школы «${operator.name}» уже стоит стороной в другой роли: оператором её не поставить`
		);
	}

	return [
		...parties,
		{
			organizationId: operator.id,
			partyRole: 'operator',
			isPrimary: false,
			contactAffiliationId: null,
			siteIds: []
		}
	];
}
