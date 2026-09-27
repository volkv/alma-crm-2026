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
 * продуктов, которые набор берёт публичные (`directory.ts`). Это относится и к
 * договору с физическим лицом: и лицо, и его договор синтетические.
 */
import { formatIsoDay } from '$lib/format';
import type { ContractStatus } from '$lib/contracts/interactions';
import { contractItems, contracts } from '$lib/server/db/schema';
import type { Tx } from '$lib/server/db/transaction';
import { seedId } from './ids';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Демо-сроки лицензий у двух позиций разных вузов — относительно момента
 * заливки, как остальные относительные даты сида (`daysBefore` в
 * `scripts/seed/interactions.ts`): ночной сброс даёт те же тридцать дней
 * вперёд и пять назад, а не застывшую дату, которая через месяц перестанет
 * что-либо показывать наблюдателю сроков лицензий
 * (`src/lib/server/notifications/license-watch.ts`). Одна позиция входит в
 * окно продления (`license_expiring`), другая уже просрочена и эскалирует
 * руководителю (`license_expired`).
 */
const LICENSE_EXPIRING_SOON = formatIsoDay(Date.now() + 30 * DAY_MS);
const LICENSE_EXPIRED = formatIsoDay(Date.now() - 5 * DAY_MS);

/**
 * Статус передачи продукта по позиции. Словарь свободный: каталога заказчика
 * ещё нет, и придумывать перечисление до него — значит угадывать. Значения —
 * те же два слова, которыми оперирует продукт: «передан» ставит подписанный акт
 * передачи или человек через форму позиции, «ожидает передачи» — то, с чем
 * заводится позиция, о которой файл ничего не сказал (`DEFAULT_TRANSFER_STATUS`,
 * `src/lib/server/directory/contracts.ts`).
 *
 * Позиции договоров с вузами набор заводит «ожидающими»: «передан» им ставит
 * акт передачи, который набор собирает на стадии передачи материалов
 * (`generateSignedDocument` в `interactions.ts`), — отметка «Утверждён» на акте
 * переводит его позиции той же транзакцией (`markDocument`). Так «передан» у
 * позиции вуза всегда подтверждён актом, а позиция из утверждённого акта
 * всегда «передан». У договоров пространства B2C акта передачи в процессе нет,
 * и статус там задан сразу — как его поставил бы человек в форме позиции.
 */
type TransferStatus = 'передан' | 'ожидает передачи';

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

/**
 * Договор вуза с лицензиями на продукты: позиции ждут передачи, лицензия по
 * каждой оформлена в день подписания и действует до конца договора. Список из
 * одного элемента — чтобы встать в перечень договоров распаковкой.
 */
function institutionContract(
	organizationKey: string,
	number: string,
	signedOn: string,
	validUntil: string,
	productKeys: readonly string[]
): ContractSeed[] {
	return [
		{
			key: `${organizationKey}-licenses`,
			organizationKey,
			number,
			signedOn,
			validUntil,
			status: 'active',
			items: productKeys.map((productKey) => ({
				productKey,
				transferStatus: 'ожидает передачи',
				licenseSignedAt: signedOn,
				licenseUntil: validUntil
			}))
		}
	];
}

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
				transferStatus: 'ожидает передачи',
				licenseSignedAt: '2026-08-20',
				licenseUntil: '2027-08-31'
			},
			{
				productKey: 'analytics',
				transferStatus: 'ожидает передачи',
				licenseSignedAt: '2026-08-20',
				licenseUntil: LICENSE_EXPIRING_SOON
			},
			{
				productKey: 'cloud',
				transferStatus: 'ожидает передачи',
				licenseSignedAt: '2026-08-20',
				licenseUntil: '2027-08-31'
			}
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
				transferStatus: 'ожидает передачи',
				licenseSignedAt: '2026-09-01',
				licenseUntil: LICENSE_EXPIRED
			}
		]
	},
	{
		key: 'vkgtu-2026',
		organizationKey: 'vkgtu',
		number: 'РТК-2025-0418',
		signedOn: '2025-10-06',
		validUntil: '2026-12-31',
		status: 'active',
		items: [
			{
				productKey: 'docs',
				transferStatus: 'ожидает передачи',
				licenseSignedAt: '2025-10-06',
				licenseUntil: '2026-12-31'
			},
			{
				productKey: 'security',
				transferStatus: 'ожидает передачи',
				licenseSignedAt: '2025-10-06',
				licenseUntil: '2026-12-31'
			}
		]
	},
	// Договоры вузов, чьи дела прошли передачу материалов: лицензия на каждый
	// продукт дела оформлена позицией договора — без неё пункт «Выданы
	// лицензии на продукты» не закрыть, и дело не ушло бы дальше передачи.
	...institutionContract('uguis', 'РТК-2026-0205', '2026-02-01', '2027-01-31', ['lab']),
	...institutionContract('sivt', 'РТК-2026-0211', '2026-02-10', '2027-02-28', ['lms']),
	...institutionContract('batse', 'РТК-2026-0216', '2026-02-16', '2027-02-28', ['docs']),
	...institutionContract('sruit', 'РТК-2025-0377', '2025-09-01', '2026-12-31', ['docs']),
	...institutionContract('puts', 'РТК-2026-0223', '2026-02-20', '2027-02-28', ['lab']),
	...institutionContract('yutus', 'РТК-2026-0229', '2026-03-02', '2027-03-31', ['lab']),
	...institutionContract('bit', 'РТК-2026-0234', '2026-03-10', '2027-03-31', ['lab']),
	...institutionContract('nkis', 'РТК-2025-0391', '2025-09-15', '2026-12-31', ['analytics']),
	// Пространство B2C: договор принадлежит контрагенту и здесь — тому же физическому
	// или юридическому лицу, с которым идёт процесс. Ничего особенного в нём
	// нет: та же запись с номером, сроками и позициями.
	{
		key: 'mayak-2026',
		organizationKey: 'mayak',
		number: 'РТК-2026-0231',
		signedOn: '2026-02-16',
		validUntil: '2027-03-31',
		status: 'active',
		items: [
			{
				productKey: 'analytics',
				transferStatus: 'передан',
				licenseSignedAt: '2026-02-16',
				licenseUntil: '2027-03-31'
			},
			{ productKey: 'docs', transferStatus: 'ожидает передачи' }
		]
	},
	{
		key: 'sorokin-2026',
		organizationKey: 'individual-sorokin',
		number: 'ФЛ-2026-0031',
		signedOn: '2026-06-01',
		validUntil: '2026-12-31',
		status: 'active',
		items: [
			{
				productKey: 'docs',
				transferStatus: 'передан',
				licenseSignedAt: '2026-06-01',
				licenseUntil: '2026-12-31'
			}
		]
	}
];

/**
 * Какое взаимодействие каким договором и какими его позициями закрыто. Связь
 * кладётся вместе с самой записью (`contractOf` → `toCreateInput` в
 * `interactions.ts`): договор должен стоять в деле до того, как оно дойдёт до
 * передачи материалов, иначе акту передавать нечего.
 */
const INTERACTION_CONTRACTS: readonly {
	interactionKey: string;
	contractKey: string;
	productKeys: readonly string[];
}[] = [
	{ interactionKey: 'szpu-2025', contractKey: 'szpu-2026', productKeys: ['lms', 'analytics'] },
	{ interactionKey: 'szpu-vnedrenie', contractKey: 'szpu-2026', productKeys: ['lms', 'cloud'] },
	{ interactionKey: 'vkgtu-prepod', contractKey: 'vkgtu-2026', productKeys: ['docs'] },
	{ interactionKey: 'ukct-zanyatiya', contractKey: 'ukct-2026', productKeys: ['lms'] },
	{ interactionKey: 'mayak-dogovor', contractKey: 'mayak-2026', productKeys: ['analytics'] },
	// Дела вузов, прошедшие передачу материалов, — каждое с позицией по своему
	// продукту.
	{ interactionKey: 'uguis-vnedr', contractKey: 'uguis-licenses', productKeys: ['lab'] },
	{
		interactionKey: 'uguis-documentation_update-70',
		contractKey: 'uguis-licenses',
		productKeys: ['lab']
	},
	{ interactionKey: 'uguis-2025b', contractKey: 'uguis-licenses', productKeys: ['lab'] },
	{
		interactionKey: 'sivt-implementation_support-54',
		contractKey: 'sivt-licenses',
		productKeys: ['lms']
	},
	{
		interactionKey: 'batse-implementation_support-56',
		contractKey: 'batse-licenses',
		productKeys: ['docs']
	},
	{
		interactionKey: 'sruit-teacher_training-58',
		contractKey: 'sruit-licenses',
		productKeys: ['docs']
	},
	{ interactionKey: 'sruit-2025', contractKey: 'sruit-licenses', productKeys: ['docs'] },
	{
		interactionKey: 'puts-teacher_training-60',
		contractKey: 'puts-licenses',
		productKeys: ['lab']
	},
	{ interactionKey: 'ukct-program_update-62', contractKey: 'ukct-2026', productKeys: ['lms'] },
	{ interactionKey: 'ukct-2025-spo', contractKey: 'ukct-2026', productKeys: ['lms'] },
	{ interactionKey: 'szpu-classes-68', contractKey: 'szpu-2026', productKeys: ['analytics'] },
	{
		interactionKey: 'yutus-documentation_update-72',
		contractKey: 'yutus-licenses',
		productKeys: ['lab']
	},
	{
		interactionKey: 'vkgtu-qualification_upgrade-74',
		contractKey: 'vkgtu-2026',
		productKeys: ['security']
	},
	{ interactionKey: 'vkgtu-2025-mag', contractKey: 'vkgtu-2026', productKeys: ['security'] },
	{ interactionKey: 'bit-execution_control-76', contractKey: 'bit-licenses', productKeys: ['lab'] },
	{ interactionKey: 'nkis-2025', contractKey: 'nkis-licenses', productKeys: ['analytics'] },
	{ interactionKey: 'sorokin-obuchenie', contractKey: 'sorokin-2026', productKeys: ['docs'] }
];

/** Ключ позиции: договор и продукт — та же пара, что уникальна в базе. */
function itemKey(contractKey: string, productKey: string): string {
	return `${contractKey}:${productKey}`;
}

/**
 * Договор и позиции, которые выбирает взаимодействие набора, — или `null`,
 * если оно без договора. Позиция по продукту, которого в составе записи нет, —
 * ошибка набора: форма взаимодействия такую отвергла бы
 * (`assertContractAllowed`, `src/lib/server/interactions/write.ts`).
 */
export function contractOf(
	interactionKey: string,
	productKeys: readonly string[]
): { contractId: string; contractItemIds: string[] } | null {
	const link = INTERACTION_CONTRACTS.find(
		(candidate) => candidate.interactionKey === interactionKey
	);

	if (link === undefined) {
		return null;
	}

	const orphan = link.productKeys.find((productKey) => !productKeys.includes(productKey));

	if (orphan !== undefined) {
		throw new Error(
			`Взаимодействие «${interactionKey}» выбирает позицию «${orphan}» договора «${link.contractKey}», а продукта в его составе нет`
		);
	}

	return {
		contractId: seedId('contract', link.contractKey),
		contractItemIds: link.productKeys.map((productKey) =>
			seedId('contract-item', itemKey(link.contractKey, productKey))
		)
	};
}

/**
 * Заливает договоры и их позиции. Идёт в транзакции справочников, до
 * взаимодействий: запись выбирает договор при заведении, как в форме.
 */
export async function seedContracts(tx: Tx): Promise<void> {
	await tx
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

	await tx
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
