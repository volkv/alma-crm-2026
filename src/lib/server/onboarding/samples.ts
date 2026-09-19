/**
 * Образцы записей для подсказок.
 *
 * Полный тур доходит до экранов карточек, а у карточки в адресе стоит
 * идентификатор записи. Придумать его нельзя, зашить в код — тем более:
 * набор данных у стенда и у заказчика разный, а область доступа у каждого
 * человека своя. Поэтому образцы спрашиваются у сервера теми же сервисами, что
 * собирают обычные списки, — с теми же правами и той же областью. Человек,
 * которому нечего показать, получает `null`, и экран из тура выпадает: тур,
 * ведущий на чужую запись, показал бы то, чего этой сессии видеть нельзя.
 *
 * Для взаимодействия предпочитается просроченная запись: карточка тура
 * рассказывает про помехи и сроки, и показывать их лучше там, где они есть.
 */
import type { PageResult } from '$lib/contracts/common';
import { interactionListQuerySchema } from '$lib/contracts/interactions';
import {
	directionDirectoryQuerySchema,
	organizationDirectoryQuerySchema,
	peopleListQuerySchema,
	productDirectoryQuerySchema,
	programDirectoryQuerySchema
} from '$lib/contracts/directory';
import { documentListQuerySchema } from '$lib/contracts/documents';
import { statSnapshotListQuerySchema } from '$lib/contracts/stats';
import type { TourSamples } from '$lib/onboarding/screens';
import type { ActorContext } from '$lib/server/actor';
import {
	listDirectionRows,
	listOrganizationRows,
	listPeople,
	listProductRows,
	listProgramRows
} from '$lib/server/directory/read';
import { listDocuments } from '$lib/server/documents/read';
import { listInteractions } from '$lib/server/interactions/read';
import { can } from '$lib/server/rbac';
import type { PermissionKey } from '$lib/server/rbac/permissions';
import { listSnapshots } from '$lib/server/stats/read';

/**
 * Идентификатор первой записи списка или `null`.
 *
 * Право проверяется до запроса, а не отказом сервиса: отсутствие права — это
 * «показывать нечего», а не ошибка, и ловить исключение ради известного заранее
 * ответа значило бы глушить настоящие отказы вместе с ним.
 *
 * Идентификатор достаётся вызывающим: строки списков устроены по-разному —
 * у одних он сверху, у других лежит во вложенной записи, — и общего поля `id`
 * у них нет.
 */
async function first<TItem>(
	ctx: ActorContext,
	permission: PermissionKey,
	read: () => Promise<PageResult<TItem>>,
	identify: (item: TItem) => string
): Promise<string | null> {
	if (!can(ctx, permission)) {
		return null;
	}

	const page = await read();
	const item = page.items[0];

	return item === undefined ? null : identify(item);
}

/** Показательное взаимодействие: сначала просроченное, иначе любое доступное. */
async function sampleInteraction(ctx: ActorContext): Promise<string | null> {
	const overdue = await first(
		ctx,
		'interactions.read',
		() =>
			listInteractions(
				ctx,
				interactionListQuerySchema.parse({ status: 'active', overdue: true, pageSize: 1 })
			),
		(item) => item.id
	);

	if (overdue !== null) {
		return overdue;
	}

	return first(
		ctx,
		'interactions.read',
		() => listInteractions(ctx, interactionListQuerySchema.parse({ pageSize: 1 })),
		(item) => item.id
	);
}

/** Показательная организация: сначала учебное заведение, иначе любой контрагент. */
async function sampleOrganization(ctx: ActorContext): Promise<string | null> {
	const institution = await first(
		ctx,
		'organizations.read',
		() =>
			listOrganizationRows(
				ctx,
				organizationDirectoryQuerySchema.parse({ kind: 'educational_institution', pageSize: 1 })
			),
		(item) => item.organization.id
	);

	if (institution !== null) {
		return institution;
	}

	return first(
		ctx,
		'organizations.read',
		() => listOrganizationRows(ctx, organizationDirectoryQuerySchema.parse({ pageSize: 1 })),
		(item) => item.organization.id
	);
}

/**
 * Что тур сможет открыть этой сессии. Запросы идут разом: их восемь, каждый за
 * одной строкой, и последовательная очередь сделала бы старт тура заметно
 * медленнее без единой причины.
 */
export async function tourSamples(ctx: ActorContext): Promise<TourSamples> {
	const [interaction, organization, person, program, product, direction, documentId, dataSnapshot] =
		await Promise.all([
			sampleInteraction(ctx),
			sampleOrganization(ctx),
			first(
				ctx,
				'people.read',
				() => listPeople(ctx, peopleListQuerySchema.parse({ pageSize: 1 })),
				(item) => item.person.id
			),
			first(
				ctx,
				'programs.read',
				() => listProgramRows(ctx, programDirectoryQuerySchema.parse({ pageSize: 1 })),
				(item) => item.program.id
			),
			first(
				ctx,
				'products.read',
				() => listProductRows(ctx, productDirectoryQuerySchema.parse({ pageSize: 1 })),
				(item) => item.product.id
			),
			first(
				ctx,
				'directions.read',
				() => listDirectionRows(ctx, directionDirectoryQuerySchema.parse({ pageSize: 1 })),
				(item) => item.direction.id
			),
			first(
				ctx,
				'documents.read',
				() => listDocuments(ctx, documentListQuerySchema.parse({ pageSize: 1 })),
				(item) => item.id
			),
			first(
				ctx,
				'stats.read',
				() => listSnapshots(ctx, statSnapshotListQuerySchema.parse({ pageSize: 1 })),
				(item) => item.id
			)
		]);

	return {
		interaction,
		organization,
		person,
		program,
		product,
		direction,
		document: documentId,
		dataSnapshot
	};
}
