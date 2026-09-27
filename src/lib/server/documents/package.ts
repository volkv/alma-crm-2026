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
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { OrganizationKind } from '$lib/contracts/directory';
import {
	DOCUMENT_TEMPLATE_LABELS,
	packageTemplates,
	type DocumentSigning,
	type DocumentTemplateKey,
	type GeneratePackageInput,
	type PackageFix,
	type PackageDefaults,
	type PackageOutcome
} from '$lib/contracts/documents';
import type { InteractionPartyView, InteractionView } from '$lib/contracts/interactions';
import { formatDocumentPrice } from '$lib/contracts/terms';
import { formatDate } from '$lib/format';
import { moduleByKey, offeredTemplates, templateOwner } from '$lib/platform/registry';
import type { ActorContext } from '../actor';
import { getDb } from '../db';
import {
	documents,
	interactionParties,
	interactionTerms,
	organizations,
	people
} from '../db/schema';
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
	/** Стоимость из коммерческих условий дела в копейках; `null` — не названа. */
	priceKopecks: number | null;
};

/** Готовый к сборке документ или перечень того, чего не хватает. */
type Built = { title: string; data: TemplateData; contractItemIds?: string[] };

type Prepared =
	| ({ ok: true; signing: DocumentSigning } & Built)
	| { ok: false; issues: string[]; fixes: PackageFix[] };

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

/**
 * Чего не хватает документу, по месту исправления. `record` — то, что правят в
 * карточке дела или справочнике (стороны, сроки, договор, реквизиты); `form` —
 * поля самой формы сборки. Отказ называет сначала первое: пока в деле нет
 * оператора, просить город подписания бессмысленно — его ввели бы зря.
 * `fixes` — куда в карточке ведёт кнопка отказа.
 */
type Issues = { record: string[]; form: string[]; fixes: Set<PackageFix> };

/** Реквизиты строкой: ИНН обязателен, КПП и ОГРН — если записаны. */
function requisites(organization: OrganizationRow, role: string, issues: Issues): string {
	if (organization.inn === null) {
		issues.record.push(`${role}: заполните ИНН в карточке организации «${organization.legalName}»`);

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

const NO_OPERATOR =
	'Добавьте оператора стороной взаимодействия: «Изменить состав» → «Стороны» в карточке дела';

/** Подписант оператора из формы; не назван — поле формы, а не данные дела. */
function operatorSigner(source: PackageSource, issues: Issues): string {
	if (source.input.operatorSigner === null) {
		issues.form.push('Укажите подписанта оператора в форме сборки');

		return '';
	}

	return source.input.operatorSigner;
}

/** Оператор — сторона дела с ролью «оператор»; без неё подписывать некому. */
function operatorData(source: PackageSource, issues: Issues): TemplateData {
	if (source.operator === null) {
		issues.record.push(NO_OPERATOR);
		issues.fixes.add('parties');

		return {};
	}

	return {
		operatorName: source.operator.legalName,
		operatorRequisites: requisites(source.operator, 'Оператор', issues),
		operatorSigner: operatorSigner(source, issues)
	};
}

function counterpartySigner(source: PackageSource, issues: Issues): string {
	if (source.input.counterpartySigner === null) {
		issues.form.push('Укажите подписанта контрагента в форме сборки');

		return '';
	}

	return source.input.counterpartySigner;
}

function programs(source: PackageSource, issues: Issues): { name: string }[] {
	if (source.interaction.programs.length === 0) {
		issues.record.push('Добавьте образовательные программы: «Изменить состав» в карточке дела');
		issues.fixes.add('parties');
	}

	return source.interaction.programs.map((program) => ({ name: program.name }));
}

/** Период обучения — учебный период плана: у лица это срок обучения. */
function studyPeriod(source: PackageSource, issues: Issues): TemplateData {
	const { academicPeriodStart: start, academicPeriodEnd: end } = source.interaction;

	if (start === null || end === null) {
		issues.record.push('Заполните период обучения: «Изменить план» в панели «Сроки»');
		issues.fixes.add('plan');

		return {};
	}

	return { periodStart: formatDate(start), periodEnd: formatDate(end) };
}

/**
 * Договор дела и выбранные позиции — то, что передаёт сублицензия и акт. У
 * каждой позиции должен быть срок лицензии: без него лицензия в документе
 * бессрочна, а это уже другое обязательство.
 */
function contractItems(source: PackageSource, issues: Issues) {
	const contract = source.interaction.contract;

	if (contract === null) {
		issues.record.push('Выберите договор взаимодействия в панели «Договор и позиции»');
		issues.fixes.add('contract');

		return null;
	}

	if (contract.items.length === 0) {
		issues.record.push('Выберите позиции договора в панели «Договор и позиции»');
		issues.fixes.add('contract');

		return null;
	}

	const items = contract.items.map((item) => {
		if (item.licenseUntil === null) {
			issues.record.push(
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

function institutionData(source: PackageSource, issues: Issues): TemplateData {
	return {
		institutionName: source.primary.legalName,
		institutionRequisites: requisites(source.primary, 'Образовательная организация', issues),
		institutionSigner: counterpartySigner(source, issues)
	};
}

/** Фамилия, имя, отчество и подпись «Фамилия И. О.» физического лица. */
function personNames(source: PackageSource, issues: Issues) {
	const person = source.primary.person;

	if (person === null || person.anonymizedAt !== null) {
		issues.record.push(
			'Персональные данные слушателя обезличены или не записаны: документ не составить'
		);

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
function customerData(source: PackageSource, issues: Issues): TemplateData {
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

/**
 * Условие о стоимости: названа в карточке — сумма, нет — прежняя оговорка о
 * счёте Исполнителя. Отказа нет: договор без суммы законен, сумму тогда
 * называет счёт. Сумма кончается сокращением «руб.», поэтому в тексте условия
 * за `{price}` не ставят точку — вышло бы «руб..».
 */
function priceClause(source: PackageSource, named: string, unnamed: string): string {
	return source.priceKopecks === null
		? unnamed
		: named.replace('{price}', formatDocumentPrice(source.priceKopecks));
}

/** Собирает данные шаблона; чего не хватает — дописывает в `issues`. */
type Builder = (source: PackageSource, issues: Issues) => Built;

const BUILDERS: Record<DocumentTemplateKey, Builder> = {
	agreement: (source, issues) => {
		const { agreementPeriodStart: start, agreementPeriodEnd: end } = source.interaction;

		if (start === null || end === null) {
			issues.record.push('Заполните срок соглашения: «Изменить план» в панели «Сроки»');
			issues.fixes.add('plan');
		}

		if (source.customer === null) {
			issues.record.push(
				'Добавьте заказчика подготовки стороной взаимодействия: «Изменить состав» → «Стороны» в карточке дела'
			);
			issues.fixes.add('parties');
		}

		if (source.operator === null) {
			issues.record.push(NO_OPERATOR);
			issues.fixes.add('parties');
		}

		// Реквизитов в соглашении нет — ИНН здесь не спрашивается.
		return {
			title: `Соглашение — ${source.interaction.title}`,
			data: {
				operatorName: source.operator?.legalName ?? '',
				operatorSigner: operatorSigner(source, issues),
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
			issues.record.push(
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
				...studyPeriod(source, issues),
				priceClause: priceClause(
					source,
					'Стоимость обучения — {price}, обучение начинается после поступления оплаты.',
					'Стоимость обучения указывается в счёте Исполнителя. Обучение начинается после поступления оплаты.'
				)
			}
		};
	},
	legal_entity_contract: (source, issues) => ({
		title: `Договор на обучение — ${source.interaction.title}`,
		data: {
			...operatorData(source, issues),
			...customerData(source, issues),
			programs: programs(source, issues),
			...studyPeriod(source, issues),
			priceClause: priceClause(
				source,
				'Стоимость услуг — {price}, оплачивается Заказчиком до начала обучения.',
				'Стоимость услуг определяется счётом Исполнителя и оплачивается Заказчиком до начала обучения.'
			)
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
	const issues: Issues = { record: [], form: [], fixes: new Set() };
	const built = BUILDERS[key](source, issues);
	const { city, operatorSigner: signer, counterpartySigner: counterparty } = source.input;

	if (city === null) {
		issues.form.push('Укажите город подписания в форме сборки');
	}

	if (issues.record.length > 0 || issues.form.length > 0 || city === null || signer === null) {
		// Одно и то же поле (например, ИНН оператора) спрашивается один раз;
		// данные дела — раньше полей формы.
		return {
			ok: false,
			issues: [...new Set([...issues.record, ...issues.form])],
			fixes: [...issues.fixes]
		};
	}

	return {
		ok: true,
		...built,
		data: { city, date: formatDate(new Date()), ...built.data },
		signing: { city, operatorSigner: signer, counterpartySigner: counterparty }
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

const successor = alias(documents, 'successor');

/**
 * Шаблоны, у которых действующая редакция в деле утверждена — подписана
 * сторонами. Действующая — та, которую ещё никто не заменил; скан, загруженный
 * новой редакцией собранного, наследует его шаблон и тоже считается.
 */
async function approvedTemplates(
	interactionId: string,
	templates: readonly DocumentTemplateKey[]
): Promise<Set<DocumentTemplateKey>> {
	if (templates.length === 0) {
		return new Set();
	}

	const rows = await getDb()
		.selectDistinct({ templateKey: documents.templateKey })
		.from(documents)
		.leftJoin(successor, eq(successor.supersedesId, documents.id))
		.where(
			and(
				eq(documents.interactionId, interactionId),
				inArray(documents.templateKey, [...templates]),
				isNotNull(documents.approvedAt),
				isNull(successor.id)
			)
		);

	return new Set(
		rows.map((row) => row.templateKey).filter((key): key is DocumentTemplateKey => key !== null)
	);
}

/**
 * Отказ пересобрать подписанный документ без явного согласия: новая редакция
 * встала бы поверх подписанной, и действующей стала бы неподписанная.
 */
const SIGNED_ISSUE =
	'Документ подписан: его действующая редакция утверждена, пересборка создаст неподписанную редакцию поверх неё. Чтобы всё же пересобрать, включите его в пакет явно';

/**
 * Собирает пакет. Выбранные шаблоны обязаны быть в пакете дела — объявлены
 * процессом, принадлежат ядру или действующему модулю и подходят виду
 * контрагента; иначе отказ целиком, до сборки.
 * Отказ отдельного документа из-за данных — его исход, а не ошибка пакета.
 * Документ, чья действующая редакция утверждена, пересобирается только с
 * явным согласием (`replaceApproved`), иначе — отказ этого документа.
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

	const [terms] = await getDb()
		.select({ priceKopecks: interactionTerms.priceKopecks })
		.from(interactionTerms)
		.where(eq(interactionTerms.interactionId, interactionId));

	const source: PackageSource = {
		interaction,
		input,
		primary,
		operator: operatorParty === undefined ? null : (rows.get(operatorParty.organizationId) ?? null),
		customer: customerParty,
		priceKopecks: terms?.priceKopecks ?? null
	};

	const outcomes: PackageOutcome[] = [];
	const chosen = offered.filter((item) => input.templates.includes(item));
	const signed = await approvedTemplates(interactionId, chosen);

	for (const key of chosen) {
		if (signed.has(key) && !input.replaceApproved.includes(key)) {
			outcomes.push({ templateKey: key, status: 'refused', issues: [SIGNED_ISSUE], fixes: [] });
			continue;
		}

		const prepared = prepare(key, source);

		if (!prepared.ok) {
			outcomes.push({
				templateKey: key,
				status: 'refused',
				issues: prepared.issues,
				fixes: prepared.fixes
			});
			continue;
		}

		try {
			const views = await generateDocument(ctx, {
				templateKey: key,
				interactionId,
				title: prepared.title,
				data: prepared.data,
				formats: ['docx', 'pdf'],
				contractItemIds: prepared.contractItemIds,
				signing: prepared.signing
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
				issues: [error.message, ...error.issues],
				fixes: []
			});
		}
	}

	return outcomes;
}

/** Столицы-регионы: у них регион в реквизитах и есть город. */
const FEDERAL_CITIES = ['Москва', 'Санкт-Петербург', 'Севастополь'];

/**
 * Город из региона реквизитов: «г. Москва» и «Москва» — город, «Московская
 * область» — нет, и угадывать его из области форма не берётся.
 */
function cityFromRegion(region: string | null): string | null {
	const text = region?.trim() ?? '';
	const named = /^г\.?\s+(.+)$/u.exec(text);

	if (named !== null) {
		return named[1].trim();
	}

	return FEDERAL_CITIES.includes(text) ? text : null;
}

/**
 * Что подставить в форму сборки пакета: город и подписантов прошлой сборки
 * этого дела; чего в нём нет — город из реквизитов оператора и подписант
 * оператора из последней сборки по делам того же оператора. Подписант
 * контрагента берётся только из этого дела: у другого контрагента другой.
 */
export async function readPackageDefaults(
	ctx: ActorContext,
	interactionId: string
): Promise<PackageDefaults> {
	requirePermission(ctx, 'documents.generate');

	const interaction = await getInteraction(ctx, interactionId);
	const operatorParty = interaction.parties.find((party) => party.partyRole === 'operator');
	const db = getDb();

	const [own] = await db
		.select({ signing: documents.signing })
		.from(documents)
		.where(and(eq(documents.interactionId, interactionId), isNotNull(documents.signing)))
		.orderBy(desc(documents.createdAt), desc(documents.id))
		.limit(1);

	if (operatorParty === undefined) {
		return {
			city: own?.signing?.city ?? null,
			operatorSigner: own?.signing?.operatorSigner ?? null,
			counterpartySigner: own?.signing?.counterpartySigner ?? null
		};
	}

	const [operator] = await db
		.select({ region: organizations.region })
		.from(organizations)
		.where(eq(organizations.id, operatorParty.organizationId));
	const [sameOperator] =
		own?.signing?.operatorSigner !== undefined
			? []
			: await db
					.select({ signing: documents.signing })
					.from(documents)
					.innerJoin(
						interactionParties,
						and(
							eq(interactionParties.interactionId, documents.interactionId),
							eq(interactionParties.partyRole, 'operator'),
							eq(interactionParties.organizationId, operatorParty.organizationId)
						)
					)
					.where(isNotNull(documents.signing))
					.orderBy(desc(documents.createdAt), desc(documents.id))
					.limit(1);

	return {
		city: own?.signing?.city ?? cityFromRegion(operator?.region ?? null),
		operatorSigner: own?.signing?.operatorSigner ?? sameOperator?.signing?.operatorSigner ?? null,
		counterpartySigner: own?.signing?.counterpartySigner ?? null
	};
}
