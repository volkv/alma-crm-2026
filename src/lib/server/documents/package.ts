/**
 * Пакет документов дела: все шаблоны, которые объявил процесс, которые дают
 * ядро или действующие модули пространства и которые подходят виду
 * контрагента, одним действием.
 *
 * Реквизиты сторон, позиции договора, программы и сроки берутся из карточек —
 * организации, физического лица, договора и плана. Человек называет только то,
 * чего в справочнике нет: город и подписантов. Каждый документ пакета
 * собирается своей сборкой (DOCX и PDF, как одиночный) и отказывает сам по
 * себе: акт без выбранных позиций не мешает собраться договору, а в отказе
 * названо поле, которое надо заполнить, и где.
 */
import { eq, inArray } from 'drizzle-orm';
import type { OrganizationKind } from '$lib/contracts/directory';
import {
	DOCUMENT_TEMPLATE_LABELS,
	packageTemplates,
	type DocumentTemplateKey,
	type GeneratePackageInput,
	type PackageOutcome
} from '$lib/contracts/documents';
import type { InteractionPartyView, InteractionView } from '$lib/contracts/interactions';
import { formatDate } from '$lib/format';
import { moduleByKey, offeredTemplates, templateOwner } from '$lib/platform/registry';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import { organizations, people } from '../db/schema';
import { ValidationError } from '../errors';
import { getInteraction } from '../interactions/read';
import { readActiveModules } from '../platform/workspace-modules';
import { requirePermission } from '../rbac';
import { readInteractionCard } from '../stages/card';
import { generateDocument, type TemplateData } from './generate';

type OrganizationRow = {
	id: string;
	kind: OrganizationKind;
	legalName: string;
	inn: string | null;
	kpp: string | null;
	ogrn: string | null;
	person: {
		lastName: string;
		firstName: string;
		middleName: string | null;
		anonymizedAt: Date | null;
	} | null;
};

/** Что известно о деле к моменту сборки: одно чтение на весь пакет. */
type PackageSource = {
	interaction: InteractionView;
	input: GeneratePackageInput;
	primary: OrganizationRow;
	operator: OrganizationRow | null;
	customer: InteractionPartyView | null;
};

/** Готовый к сборке документ или перечень того, чего не хватает. */
type Built = { title: string; data: TemplateData; contractItemIds?: string[] };

type Prepared = ({ ok: true } & Built) | { ok: false; issues: string[] };

async function readOrganizations(ids: string[]): Promise<Map<string, OrganizationRow>> {
	const rows = await getDb()
		.select({
			id: organizations.id,
			kind: organizations.kind,
			legalName: organizations.legalName,
			inn: organizations.inn,
			kpp: organizations.kpp,
			ogrn: organizations.ogrn,
			lastName: people.lastName,
			firstName: people.firstName,
			middleName: people.middleName,
			anonymizedAt: people.anonymizedAt
		})
		.from(organizations)
		.leftJoin(people, eq(people.id, organizations.personId))
		.where(inArray(organizations.id, ids));

	return new Map(
		rows.map((row) => [
			row.id,
			{
				id: row.id,
				kind: row.kind,
				legalName: row.legalName,
				inn: row.inn,
				kpp: row.kpp,
				ogrn: row.ogrn,
				person:
					row.lastName === null || row.firstName === null
						? null
						: {
								lastName: row.lastName,
								firstName: row.firstName,
								middleName: row.middleName,
								anonymizedAt: row.anonymizedAt
							}
			}
		])
	);
}

/** Реквизиты строкой: ИНН обязателен, КПП и ОГРН — если записаны. */
function requisites(organization: OrganizationRow, role: string, issues: string[]): string {
	if (organization.inn === null) {
		issues.push(`${role}: заполните ИНН в карточке организации «${organization.legalName}»`);

		return '';
	}

	return [
		`ИНН ${organization.inn}`,
		organization.kpp === null ? null : `КПП ${organization.kpp}`,
		organization.ogrn === null ? null : `ОГРН ${organization.ogrn}`
	]
		.filter((part): part is string => part !== null)
		.join(', ');
}

/** Оператор — сторона дела с ролью «оператор»; без неё подписывать некому. */
function operatorData(source: PackageSource, issues: string[]): TemplateData {
	if (source.operator === null) {
		issues.push('Добавьте оператора стороной взаимодействия: «Изменить план» → «Стороны»');

		return {};
	}

	return {
		operatorName: source.operator.legalName,
		operatorRequisites: requisites(source.operator, 'Оператор', issues),
		operatorSigner: source.input.operatorSigner
	};
}

function counterpartySigner(source: PackageSource, issues: string[]): string {
	if (source.input.counterpartySigner === null) {
		issues.push('Укажите подписанта контрагента в форме сборки');

		return '';
	}

	return source.input.counterpartySigner;
}

function programs(source: PackageSource, issues: string[]): { name: string }[] {
	if (source.interaction.programs.length === 0) {
		issues.push('Добавьте образовательные программы во взаимодействие');
	}

	return source.interaction.programs.map((program) => ({ name: program.name }));
}

/** Период обучения — учебный период плана: у лица это срок обучения. */
function studyPeriod(source: PackageSource, issues: string[]): TemplateData {
	const { academicPeriodStart: start, academicPeriodEnd: end } = source.interaction;

	if (start === null || end === null) {
		issues.push('Заполните период обучения: «Изменить план» в панели «Сроки»');

		return {};
	}

	return { periodStart: formatDate(start), periodEnd: formatDate(end) };
}

/**
 * Договор дела и выбранные позиции — то, что передаёт сублицензия и акт. У
 * каждой позиции должен быть срок лицензии: без него лицензия в документе
 * бессрочна, а это уже другое обязательство.
 */
function contractItems(source: PackageSource, issues: string[]) {
	const contract = source.interaction.contract;

	if (contract === null) {
		issues.push('Выберите договор взаимодействия в панели «Договор»');

		return null;
	}

	if (contract.items.length === 0) {
		issues.push('Выберите позиции договора в панели «Договор»');

		return null;
	}

	const items = contract.items.map((item) => {
		if (item.licenseUntil === null) {
			issues.push(
				`Позиция «${item.name}»: заполните срок лицензии в договоре № ${contract.number} (карточка организации)`
			);
		}

		return {
			id: item.id,
			productName: item.name,
			licenseUntil: item.licenseUntil === null ? '' : formatDate(item.licenseUntil)
		};
	});

	return { contract, items };
}

function institutionData(source: PackageSource, issues: string[]): TemplateData {
	return {
		institutionName: source.primary.legalName,
		institutionRequisites: requisites(source.primary, 'Образовательная организация', issues),
		institutionSigner: counterpartySigner(source, issues)
	};
}

/** Фамилия, имя, отчество и подпись «Фамилия И. О.» физического лица. */
function personNames(source: PackageSource, issues: string[]) {
	const person = source.primary.person;

	if (person === null || person.anonymizedAt !== null) {
		issues.push('Персональные данные слушателя обезличены или не записаны: документ не составить');

		return null;
	}

	const initials = [person.firstName, person.middleName]
		.filter((part): part is string => part !== null && part !== '')
		.map((part) => `${part[0]}.`)
		.join(' ');

	return {
		fullName: [person.lastName, person.firstName, person.middleName]
			.filter((part): part is string => part !== null && part !== '')
			.join(' '),
		signer: `${person.lastName} ${initials}`
	};
}

/** Заказчик коммерческого обучения: компания со своими реквизитами или лицо. */
function customerData(source: PackageSource, issues: string[]): TemplateData {
	if (source.primary.kind === 'individual') {
		const names = personNames(source, issues);

		return names === null
			? {}
			: {
					customerName: names.fullName,
					customerRequisites: 'физическое лицо',
					customerSigner: names.signer
				};
	}

	return {
		customerName: source.primary.legalName,
		customerRequisites: requisites(source.primary, 'Заказчик', issues),
		customerSigner: counterpartySigner(source, issues)
	};
}

/** Собирает данные шаблона; чего не хватает — дописывает в `issues`. */
type Builder = (source: PackageSource, issues: string[]) => Built;

const BUILDERS: Record<DocumentTemplateKey, Builder> = {
	agreement: (source, issues) => {
		const { agreementPeriodStart: start, agreementPeriodEnd: end } = source.interaction;

		if (start === null || end === null) {
			issues.push('Заполните срок соглашения: «Изменить план» в панели «Сроки»');
		}

		if (source.customer === null) {
			issues.push('Добавьте заказчика подготовки стороной взаимодействия');
		}

		if (source.operator === null) {
			issues.push('Добавьте оператора стороной взаимодействия: «Изменить план» → «Стороны»');
		}

		// Реквизитов в соглашении нет — ИНН здесь не спрашивается.
		return {
			title: `Соглашение — ${source.interaction.title}`,
			data: {
				operatorName: source.operator?.legalName ?? '',
				operatorSigner: source.input.operatorSigner,
				institutionName: source.primary.legalName,
				institutionSigner: counterpartySigner(source, issues),
				customerName: source.customer?.organizationName ?? '',
				periodStart: start === null ? '' : formatDate(start),
				periodEnd: end === null ? '' : formatDate(end),
				programs: programs(source, issues)
			}
		};
	},
	sublicense: (source, issues) => {
		const chosen = contractItems(source, issues);

		return {
			title: `Сублицензионный договор — ${source.interaction.title}`,
			data: {
				...operatorData(source, issues),
				...institutionData(source, issues),
				contractNumber: chosen?.contract.number ?? '',
				items:
					chosen?.items.map(({ productName, licenseUntil }) => ({ productName, licenseUntil })) ??
					[]
			}
		};
	},
	handover_act: (source, issues) => {
		const chosen = contractItems(source, issues);

		if (chosen !== null && chosen.contract.signedOn === null) {
			issues.push(
				`Заполните дату подписания договора № ${chosen.contract.number} (карточка организации)`
			);
		}

		return {
			title: `Акт передачи материалов и лицензий — ${source.interaction.title}`,
			data: {
				...operatorData(source, issues),
				...institutionData(source, issues),
				contractNumber: chosen?.contract.number ?? '',
				contractSignedOn:
					chosen?.contract.signedOn == null ? '' : formatDate(chosen.contract.signedOn),
				items:
					chosen?.items.map(({ productName, licenseUntil }) => ({ productName, licenseUntil })) ??
					[]
			},
			// Акт — единственный документ пакета, который передаёт позиции: его
			// подписанный экземпляр и есть факт передачи.
			contractItemIds: chosen?.items.map((item) => item.id) ?? []
		};
	},
	offer: (source, issues) => {
		const names = personNames(source, issues);

		return {
			title: `Договор-оферта — ${source.interaction.title}`,
			data: {
				...operatorData(source, issues),
				learnerName: names?.fullName ?? '',
				learnerSigner: names?.signer ?? '',
				programs: programs(source, issues),
				...studyPeriod(source, issues)
			}
		};
	},
	legal_entity_contract: (source, issues) => ({
		title: `Договор на обучение — ${source.interaction.title}`,
		data: {
			...operatorData(source, issues),
			...customerData(source, issues),
			programs: programs(source, issues),
			...studyPeriod(source, issues)
		}
	}),
	services_act: (source, issues) => ({
		title: `Акт оказанных услуг — ${source.interaction.title}`,
		data: {
			...operatorData(source, issues),
			...customerData(source, issues),
			programs: programs(source, issues),
			...studyPeriod(source, issues)
		}
	})
};

function prepare(key: DocumentTemplateKey, source: PackageSource): Prepared {
	const issues: string[] = [];
	const built = BUILDERS[key](source, issues);

	if (issues.length > 0) {
		// Одно и то же поле (например, ИНН оператора) спрашивается один раз.
		return { ok: false, issues: [...new Set(issues)] };
	}

	return {
		ok: true,
		...built,
		data: { city: source.input.city, date: formatDate(new Date()), ...built.data }
	};
}

/**
 * Почему шаблона нет в пакете дела. Шаблон выключенного модуля объясняется
 * отдельно: процесс его предлагает, и без подсказки человек искал бы причину в
 * редакторе процесса.
 */
function foreignReason(
	key: DocumentTemplateKey,
	active: readonly string[],
	workspaceName: string
): string {
	const owner = templateOwner(key);

	if (owner !== null && !active.includes(owner)) {
		return `«${DOCUMENT_TEMPLATE_LABELS[key]}» даёт модуль «${moduleByKey(owner)?.label ?? owner}», он не подключён к пространству «${workspaceName}»: его подключают в «Настройки → Пространства»`;
	}

	return `«${DOCUMENT_TEMPLATE_LABELS[key]}» не подходит процессу или контрагенту`;
}

/**
 * Собирает пакет. Выбранные шаблоны обязаны быть в пакете дела — объявлены
 * процессом, принадлежат ядру или действующему модулю и подходят виду
 * контрагента; иначе отказ целиком, до сборки.
 * Отказ отдельного документа из-за данных — его исход, а не ошибка пакета.
 * Сбой службы PDF прерывает сборку: собранное до него остаётся в деле.
 */
export async function generateDocumentPackage(
	ctx: ActorContext,
	interactionId: string,
	input: GeneratePackageInput
): Promise<PackageOutcome[]> {
	requirePermission(ctx, 'documents.generate');

	const interaction = await getInteraction(ctx, interactionId);
	const [card, modules] = await Promise.all([
		readInteractionCard(interaction),
		readActiveModules(interaction.workspaceId)
	]);
	// Шаблон модуля входит в пакет, только пока модуль действует в пространстве
	// дела: выбор процесса при этом не теряется.
	const offered = packageTemplates(
		offeredTemplates(card.templates, modules.active),
		card.counterpartyKind
	);
	const foreign = input.templates.filter((key) => !offered.includes(key));

	if (offered.length === 0) {
		throw new ValidationError('Процесс не предлагает документов для этого контрагента', [
			'Шаблоны включают в редакторе процесса'
		]);
	}

	if (foreign.length > 0) {
		throw new ValidationError(
			'Эти документы не входят в пакет дела',
			foreign.map((key) => foreignReason(key, modules.active, interaction.workspaceName))
		);
	}

	const primaryParty = interaction.parties.find((party) => party.isPrimary);
	const operatorParty = interaction.parties.find((party) => party.partyRole === 'operator');
	const customerParty =
		interaction.parties.find((party) => party.partyRole === 'customer' && !party.isPrimary) ?? null;

	// Основную сторону держит `readInteractionCard`: без неё он уже отказал.
	const rows = await readOrganizations(
		[primaryParty?.organizationId, operatorParty?.organizationId].filter(
			(id): id is string => id !== undefined
		)
	);
	const primary = primaryParty === undefined ? undefined : rows.get(primaryParty.organizationId);

	if (primary === undefined) {
		throw new ValidationError('Основная сторона взаимодействия не найдена в справочнике');
	}

	const source: PackageSource = {
		interaction,
		input,
		primary,
		operator: operatorParty === undefined ? null : (rows.get(operatorParty.organizationId) ?? null),
		customer: customerParty
	};

	const outcomes: PackageOutcome[] = [];

	for (const key of offered.filter((item) => input.templates.includes(item))) {
		const prepared = prepare(key, source);

		if (!prepared.ok) {
			outcomes.push({ templateKey: key, status: 'refused', issues: prepared.issues });
			continue;
		}

		try {
			const views = await generateDocument(ctx, {
				templateKey: key,
				interactionId,
				title: prepared.title,
				data: prepared.data,
				formats: ['docx', 'pdf'],
				contractItemIds: prepared.contractItemIds
			});

			outcomes.push({
				templateKey: key,
				status: 'generated',
				documentIds: views.map((view) => view.id)
			});
		} catch (error) {
			if (!(error instanceof ValidationError)) {
				throw error;
			}

			outcomes.push({
				templateKey: key,
				status: 'refused',
				issues: [error.message, ...error.issues]
			});
		}
	}

	return outcomes;
}
