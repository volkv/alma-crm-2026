/**
 * Из чего собирают состав дела: каталог программ и продуктов, организация
 * школы и виды контрагентов, с которыми работает пространство.
 *
 * Сам состав пишет `updateInteraction` и `createInteractionIn` — здесь только
 * то, что форма предлагает выбрать.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { OrganizationKind } from '$lib/contracts/directory';
import type { CompositionCatalog, CompositionOperator } from '$lib/contracts/interactions';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { products, programVersions, programs, workspaceIntakeRoutes } from '../db/schema';
import { can } from '../rbac';
import { readSchoolOperator, schoolOperatorProblem } from './operator';

/**
 * Действующие программы с версиями и действующие продукты — целиком, без
 * страниц: выбирают из них поиском по коду и названию, и отрезанный хвост
 * каталога выглядел бы как «такой программы нет». Без права на каталог его
 * часть пуста — выбрать из него человек всё равно не может.
 */
export async function readCompositionCatalog(ctx: ActorContext): Promise<CompositionCatalog> {
	const db = getDb();

	const [programRows, productRows] = await Promise.all([
		can(ctx, 'programs.read')
			? db
					.select({ id: programs.id, code: programs.code, name: programs.name })
					.from(programs)
					.where(eq(programs.status, 'active'))
					.orderBy(asc(programs.code))
			: [],
		can(ctx, 'products.read')
			? db
					.select({ id: products.id, code: products.code, name: products.name })
					.from(products)
					.where(eq(products.status, 'active'))
					.orderBy(asc(products.code))
			: []
	]);

	const versionRows =
		programRows.length === 0
			? []
			: await db
					.select({
						id: programVersions.id,
						programId: programVersions.programId,
						version: programVersions.version,
						effectiveFrom: programVersions.effectiveFrom
					})
					.from(programVersions)
					.where(
						inArray(
							programVersions.programId,
							programRows.map((row) => row.id)
						)
					)
					.orderBy(asc(programVersions.version));

	return {
		programs: programRows.map((program) => ({
			...program,
			versions: versionRows
				.filter((version) => version.programId === program.id)
				.map(({ id, version, effectiveFrom }) => ({ id, version, effectiveFrom }))
		})),
		products: productRows
	};
}

/** Школа для стороны «Оператор» — или объяснение, почему её не предложить. */
export async function readCompositionOperator(): Promise<CompositionOperator> {
	const operator = await readSchoolOperator(getDb());

	if (operator.state === 'configured') {
		return operator;
	}

	const problem = schoolOperatorProblem(operator);

	return { state: 'unavailable', reason: `${problem.message}. ${problem.issues.join('. ')}` };
}

/** Виды основной стороны, которые вообще бывают у взаимодействия. */
const PRIMARY_KINDS: readonly OrganizationKind[] = [
	'educational_institution',
	'legal_entity',
	'individual'
];

/**
 * С кем работает пространство: виды основной стороны, которые маршруты приёма
 * направляют сюда. Пространство без маршрутов (заведено недавно, заявки в него
 * не идут) ограничений не имеет — форма предлагает все три вида, и выбирает
 * человек.
 */
export async function readWorkspaceCounterpartyKinds(
	workspaceId: string
): Promise<OrganizationKind[]> {
	const rows = await getDb()
		.select({ kind: workspaceIntakeRoutes.kind })
		.from(workspaceIntakeRoutes)
		.where(
			and(
				eq(workspaceIntakeRoutes.workspaceId, workspaceId),
				inArray(workspaceIntakeRoutes.kind, [...PRIMARY_KINDS])
			)
		);

	const routed = new Set(rows.map((row) => row.kind));

	return routed.size === 0 ? [...PRIMARY_KINDS] : PRIMARY_KINDS.filter((kind) => routed.has(kind));
}
