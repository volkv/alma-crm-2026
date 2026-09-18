/**
 * Договоры демонстрационного стенда и их позиции.
 *
 * Договор принадлежит контрагенту, а не взаимодействию: один договор СПбПУ
 * обслуживает сразу два взаимодействия, и на стенде это видно. Состав продуктов
 * взаимодействия при этом задаёт `interaction_products` — позиция договора
 * добавляет к продукту коммерческие условия, но состав не определяет.
 *
 * Договоры вымышлены целиком: номера, даты, сроки и состав позиций не
 * принадлежат ни одному настоящему соглашению — в отличие от названий вузов и
 * продуктов, которые набор берёт публичные (`directory.ts`).
 */
import { inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import type { ContractStatus } from '$lib/contracts/interactions';
import {
	contractItems,
	contracts,
	interactionContractItems,
	interactions
} from '$lib/server/db/schema';
import { seedId } from './ids';

/**
 * Статус передачи продукта по позиции. Словарь свободный: каталога заказчика
 * ещё нет, и придумывать перечисление до него — значит угадывать.
 */
type TransferStatus = 'transferred' | 'pending';

type ContractItemSeed = {
	productKey: string;
	transferStatus: TransferStatus;
	licenseSignedAt?: string;
	licenseUntil?: string;
};

type ContractSeed = {
	key: string;
	organizationKey: string;
	number: string;
	signedOn: string;
	validUntil: string;
	status: ContractStatus;
	items: readonly ContractItemSeed[];
};

const CONTRACTS: readonly ContractSeed[] = [
	{
		key: 'szpu-2026',
		organizationKey: 'szpu',
		number: 'РТК-2026-0142',
		signedOn: '2026-08-20',
		validUntil: '2027-08-31',
		status: 'active',
		items: [
			{
				productKey: 'lms',
				transferStatus: 'transferred',
				licenseSignedAt: '2026-08-20',
				licenseUntil: '2027-08-31'
			},
			{
				productKey: 'analytics',
				transferStatus: 'transferred',
				licenseSignedAt: '2026-08-20',
				licenseUntil: '2027-08-31'
			},
			{ productKey: 'cloud', transferStatus: 'pending' }
		]
	},
	{
		key: 'ukct-2026',
		organizationKey: 'ukct',
		number: 'РТК-2026-0187',
		signedOn: '2026-09-01',
		validUntil: '2027-06-30',
		status: 'active',
		items: [
			{
				productKey: 'lms',
				transferStatus: 'transferred',
				licenseSignedAt: '2026-09-01',
				licenseUntil: '2027-06-30'
			}
		]
	}
];

/** Какое взаимодействие каким договором и какими его позициями закрыто. */
const INTERACTION_CONTRACTS: readonly {
	interactionKey: string;
	contractKey: string;
	productKeys: readonly string[];
}[] = [
	{ interactionKey: 'szpu-2025', contractKey: 'szpu-2026', productKeys: ['lms', 'analytics'] },
	{ interactionKey: 'szpu-vnedrenie', contractKey: 'szpu-2026', productKeys: ['lms', 'cloud'] },
	{ interactionKey: 'ukct-zanyatiya', contractKey: 'ukct-2026', productKeys: ['lms'] }
];

/** Ключ позиции: договор и продукт — та же пара, что уникальна в базе. */
function itemKey(contractKey: string, productKey: string): string {
	return `${contractKey}:${productKey}`;
}

/**
 * Заливает договоры и привязывает их к взаимодействиям.
 *
 * Идёт после взаимодействий: их заводит движок стадий уже после того, как
 * справочники зафиксированы. Ссылки ставятся только на те взаимодействия,
 * которые в базе действительно есть, — прерванный набор не должен ронять
 * повторный запуск.
 */
export async function seedContracts(): Promise<void> {
	const db = getDb();

	await db
		.insert(contracts)
		.values(
			CONTRACTS.map((contract) => ({
				id: seedId('contract', contract.key),
				organizationId: seedId('organization', contract.organizationKey),
				number: contract.number,
				signedOn: contract.signedOn,
				validUntil: contract.validUntil,
				status: contract.status
			}))
		)
		.onConflictDoNothing({ target: contracts.id });

	await db
		.insert(contractItems)
		.values(
			CONTRACTS.flatMap((contract) =>
				contract.items.map((item) => ({
					id: seedId('contract-item', itemKey(contract.key, item.productKey)),
					contractId: seedId('contract', contract.key),
					productId: seedId('product', item.productKey),
					licenseSignedAt: item.licenseSignedAt ?? null,
					licenseUntil: item.licenseUntil ?? null,
					transferStatus: item.transferStatus
				}))
			)
		)
		.onConflictDoNothing({ target: contractItems.id });

	const wanted = INTERACTION_CONTRACTS.map((link) => seedId('interaction', link.interactionKey));
	const present = new Set(
		(
			await db
				.select({ id: interactions.id })
				.from(interactions)
				.where(inArray(interactions.id, wanted))
		).map((row) => row.id)
	);

	const links = INTERACTION_CONTRACTS.filter((link) =>
		present.has(seedId('interaction', link.interactionKey))
	);

	for (const link of links) {
		await db
			.update(interactions)
			.set({ contractId: seedId('contract', link.contractKey), updatedAt: sql`now()` })
			.where(sql`${interactions.id} = ${seedId('interaction', link.interactionKey)}::uuid`);
	}

	if (links.length > 0) {
		await db
			.insert(interactionContractItems)
			.values(
				links.flatMap((link) =>
					link.productKeys.map((productKey) => ({
						interactionId: seedId('interaction', link.interactionKey),
						contractItemId: seedId('contract-item', itemKey(link.contractKey, productKey)),
						contractId: seedId('contract', link.contractKey)
					}))
				)
			)
			.onConflictDoNothing();
	}
}

/** Сколько строк описано в наборе: по ним тест проверяет, что всё легло. */
export const CONTRACT_SEED_SIZES = {
	contracts: CONTRACTS.length,
	items: CONTRACTS.reduce((total, contract) => total + contract.items.length, 0),
	interactionItems: INTERACTION_CONTRACTS.reduce(
		(total, link) => total + link.productKeys.length,
		0
	)
} as const;
