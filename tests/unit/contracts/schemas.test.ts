/**
 * По паре «принимается / отвергается» на каждую схему контрактов.
 *
 * Смысл не в том, чтобы перепроверить Zod, а в том, чтобы зафиксировать, какое
 * тело запроса считается допустимым: контракт — это то, на что опираются и
 * форма, и API, и импорт, и меняться он должен осознанно.
 */
import { describe, expect, it } from 'vitest';
import { auditFilterSchema } from '$lib/contracts/audit';
import { pageQuerySchema } from '$lib/contracts/common';
import {
	catalogListQuerySchema,
	createAffiliationSchema,
	createOrganizationSchema,
	createPersonSchema,
	createProductSchema,
	createProgramSchema,
	createProgramVersionSchema,
	createSiteSchema,
	organizationListQuerySchema,
	peopleListQuerySchema,
	recordConsentSchema,
	setRetentionSchema,
	updateOrganizationSchema,
	withdrawConsentSchema
} from '$lib/contracts/directory';
import {
	documentListQuerySchema,
	documentTemplateVariableSchema,
	generateDocumentSchema,
	markDocumentStatusSchema,
	uploadDocumentSchema
} from '$lib/contracts/documents';
import {
	advanceStageSchema,
	checklistItemSchema,
	confirmStageSchema,
	createCommentSchema,
	createInteractionSchema,
	interactionListQuerySchema,
	pauseStageSchema,
	raiseBlockerSchema,
	resolveBlockerSchema,
	resumeStageSchema,
	returnStageSchema,
	skipStageSchema,
	stageConfirmationSchema,
	stageSnapshotSchema,
	updateInteractionSchema
} from '$lib/contracts/interactions';
import { settingSchemas } from '$lib/contracts/settings';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

/** Схеме нужен только `safeParse`; так в таблицу ложится любая из них. */
type Checkable = { safeParse: (value: unknown) => { success: boolean } };

type Case = {
	name: string;
	schema: Checkable;
	valid: unknown;
	invalid: unknown;
};

const organization = {
	kind: 'educational_institution',
	educationLevel: 'vo',
	legalName: 'Федеральное государственное автономное образовательное учреждение',
	shortName: 'ПУПИ',
	inn: '7707083893'
};

const interaction = {
	title: 'Сотрудничество на 2026/27 учебный год',
	ownerUserId: OTHER_ID,
	parties: [{ organizationId: ID, partyRole: 'educational_institution', isPrimary: true }]
};

/** Номер редакции процесса несёт каждая команда перехода. */
const stageCommand = { interactionId: ID, fromStageId: OTHER_ID, revision: 1 };

const cases: Case[] = [
	{
		name: 'organizationList',
		schema: organizationListQuerySchema,
		valid: { kind: 'operator', q: 'мфти', page: '2' },
		invalid: { kind: 'university' }
	},
	{
		name: 'catalogList',
		schema: catalogListQuerySchema,
		valid: { status: 'active' },
		invalid: { status: 'retired' }
	},
	{
		name: 'page',
		schema: pageQuerySchema,
		valid: { page: '3', pageSize: '50' },
		invalid: { pageSize: 500 }
	},
	{
		name: 'createOrganization',
		schema: createOrganizationSchema,
		valid: organization,
		// Уровень образования у компании-заказчика заполнять нельзя.
		invalid: { ...organization, kind: 'customer_company' }
	},
	{
		name: 'createOrganization: контрольная сумма ИНН',
		schema: createOrganizationSchema,
		valid: { ...organization, inn: null },
		invalid: { ...organization, inn: '7707083894' }
	},
	{
		name: 'createOrganization: внешняя ссылка парная',
		schema: createOrganizationSchema,
		valid: { ...organization, externalSource: 'moodle', externalId: '7' },
		invalid: { ...organization, externalId: '7' }
	},
	{
		name: 'updateOrganization',
		schema: updateOrganizationSchema,
		valid: { ...organization, id: ID },
		invalid: organization
	},
	{
		name: 'createSite',
		schema: createSiteSchema,
		valid: { organizationId: ID, kind: 'campus', name: 'Главный корпус' },
		invalid: { organizationId: ID, kind: 'campus', name: '   ' }
	},
	{
		name: 'createPerson',
		schema: createPersonSchema,
		valid: { lastName: 'Иванов', firstName: 'Иван', email: 'ivanov@vuz.ru' },
		invalid: { lastName: 'Иванов', firstName: 'Иван', email: 'не почта' }
	},
	{
		name: 'createAffiliation',
		schema: createAffiliationSchema,
		valid: {
			personId: ID,
			organizationId: OTHER_ID,
			position: 'Проректор по цифровому развитию',
			roleKind: 'vice_rector',
			validFrom: '2026-09-01'
		},
		invalid: {
			personId: ID,
			organizationId: OTHER_ID,
			position: 'Проректор',
			roleKind: 'vice_rector',
			validFrom: '2026-09-01',
			validTo: '2026-08-01'
		}
	},
	{
		name: 'recordConsent',
		schema: recordConsentSchema,
		valid: { personId: ID, basis: 'contract', textVersion: '2026-09-01', givenAt: '2026-09-01' },
		// Основание — ссылка на норму закона, а не свободный текст.
		invalid: { personId: ID, basis: 'по договорённости', textVersion: 'v1', givenAt: '2026-09-01' }
	},
	{
		name: 'withdrawConsent',
		schema: withdrawConsentSchema,
		valid: { id: ID, withdrawnAt: '2026-09-01' },
		invalid: { id: ID, withdrawnAt: 'вчера' }
	},
	{
		name: 'setRetention',
		schema: setRetentionSchema,
		// Пустое значение — «срок не назначен», а не «хранить вечно».
		valid: { personId: ID, retentionUntil: null },
		invalid: { personId: ID, retentionUntil: '31.12.2030' }
	},
	{
		name: 'peopleList: отбор по сроку хранения',
		schema: peopleListQuerySchema,
		valid: { retention: 'expired' },
		// У полей списка стоит `catch`: чушь в адресе — это «без фильтра».
		invalid: null
	},
	{
		name: 'createProgram',
		schema: createProgramSchema,
		valid: { code: 'IB-01', name: 'Информационная безопасность', level: 'bachelor' },
		invalid: { code: 'IB-01', name: 'Информационная безопасность', level: 'phd' }
	},
	{
		name: 'createProgramVersion',
		schema: createProgramVersionSchema,
		valid: {
			programId: ID,
			summary: 'Добавлен модуль по защите данных',
			effectiveFrom: '2026-09-01'
		},
		invalid: { programId: ID, summary: '', effectiveFrom: '2026-09-01' }
	},
	{
		name: 'createProduct',
		schema: createProductSchema,
		valid: { code: 'LMS', name: 'Учебная платформа' },
		invalid: { code: 'LMS', name: 'Учебная платформа', vendorOrganizationId: 'нет' }
	},
	{
		name: 'checklistItem',
		schema: checklistItemSchema,
		valid: { key: 'contract-signed', label: 'Договор подписан', required: true },
		invalid: { key: '', label: 'Договор подписан' }
	},
	{
		name: 'stageSnapshot',
		schema: stageSnapshotSchema,
		valid: {
			key: 'contact',
			name: 'Первый контакт',
			position: 1,
			category: 'contact',
			slaDays: 5,
			staleAfterDays: null,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			isFinal: false,
			checklist: []
		},
		invalid: {
			key: 'contact',
			name: 'Первый контакт',
			position: 0,
			category: 'contact',
			slaDays: 5,
			staleAfterDays: null,
			requiresResult: false,
			requiresConfirmation: false,
			requiresLmsData: false,
			isFinal: false,
			checklist: []
		}
	},
	{
		name: 'stageConfirmation',
		schema: stageConfirmationSchema,
		valid: { kind: 'lms_record', source: 'moodle', recordId: '55' },
		invalid: { kind: 'handshake' }
	},
	{
		name: 'createInteraction',
		schema: createInteractionSchema,
		valid: interaction,
		// Ровно один основной участник: иначе непонятно, с кем идёт процесс.
		invalid: {
			...interaction,
			parties: [
				{ organizationId: ID, partyRole: 'educational_institution', isPrimary: true },
				{ organizationId: OTHER_ID, partyRole: 'customer', isPrimary: true }
			]
		}
	},
	{
		name: 'createInteraction: порядок дат',
		schema: createInteractionSchema,
		valid: { ...interaction, agreementPeriodStart: '2026-09-01', agreementPeriodEnd: '2027-06-30' },
		invalid: {
			...interaction,
			agreementPeriodStart: '2027-06-30',
			agreementPeriodEnd: '2026-09-01'
		}
	},
	{
		name: 'updateInteraction',
		schema: updateInteractionSchema,
		valid: { ...interaction, id: ID, reason: 'Сдвинули сроки по просьбе вуза' },
		invalid: interaction
	},
	{
		name: 'interactionList',
		schema: interactionListQuerySchema,
		valid: { status: 'active', q: 'мфти' },
		invalid: { status: 'paused' }
	},
	{
		name: 'advanceStage',
		schema: advanceStageSchema,
		valid: { ...stageCommand, toStageId: ID, checklistState: { 'contract-signed': true } },
		invalid: { ...stageCommand, toStageId: ID, checklistState: { 'contract-signed': 'да' } }
	},
	{
		name: 'returnStage',
		schema: returnStageSchema,
		valid: { ...stageCommand, toStageId: ID, reason: 'Вуз попросил переоформить документы' },
		invalid: { ...stageCommand, toStageId: ID, reason: '' }
	},
	{
		name: 'skipStage',
		schema: skipStageSchema,
		valid: { ...stageCommand, toStageId: ID, reason: 'Согласование не требуется' },
		invalid: { ...stageCommand, toStageId: ID }
	},
	{
		name: 'pauseStage',
		schema: pauseStageSchema,
		valid: { ...stageCommand, reason: 'waiting_counterparty', note: 'Ждём подписи ректора' },
		invalid: { ...stageCommand, reason: 'holidays', note: 'Ждём' }
	},
	{
		name: 'resumeStage',
		schema: resumeStageSchema,
		valid: { ...stageCommand, note: 'Документы получены' },
		invalid: { ...stageCommand, interactionId: 'не идентификатор' }
	},
	{
		name: 'confirmStage',
		schema: confirmStageSchema,
		valid: { ...stageCommand, confirmation: { kind: 'mark' } },
		// Автора и время отметки проставляет сервер, а не вызывающий.
		invalid: { ...stageCommand, confirmation: { kind: 'file' } }
	},
	{
		name: 'raiseBlocker',
		schema: raiseBlockerSchema,
		valid: { interactionId: ID, reasonCode: 'no-contact', description: 'Не отвечает координатор' },
		invalid: { interactionId: ID, reasonCode: 'no-contact' }
	},
	{
		name: 'resolveBlocker',
		schema: resolveBlockerSchema,
		valid: { blockerId: ID, resolution: 'Связались через приёмную ректора' },
		invalid: { blockerId: ID, resolution: '' }
	},
	{
		name: 'createComment',
		schema: createCommentSchema,
		valid: { interactionId: ID, body: 'Созвон назначен на четверг' },
		invalid: { interactionId: ID, body: '   ' }
	},
	{
		name: 'uploadDocument',
		schema: uploadDocumentSchema,
		valid: { kind: 'agreement', title: 'Соглашение', mime: 'application/pdf', sizeBytes: 1024 },
		invalid: {
			kind: 'agreement',
			title: 'Соглашение',
			mime: 'application/x-msdownload',
			sizeBytes: 1024
		}
	},
	{
		name: 'uploadDocument: потолок размера',
		schema: uploadDocumentSchema,
		valid: { kind: 'act', title: 'Акт', mime: 'image/png', sizeBytes: 25 * 1024 * 1024 },
		invalid: { kind: 'act', title: 'Акт', mime: 'image/png', sizeBytes: 25 * 1024 * 1024 + 1 }
	},
	{
		name: 'generateDocument',
		schema: generateDocumentSchema,
		valid: { templateKey: 'agreement', interactionId: ID, variables: { university: 'ПУПИ' } },
		invalid: { templateKey: 'agreement', interactionId: ID, variables: { university: 2026 } }
	},
	{
		name: 'markDocumentStatus',
		schema: markDocumentStatusSchema,
		valid: { documentId: ID, fact: 'approved', at: '2026-09-12' },
		invalid: { documentId: ID, fact: 'signed' }
	},
	{
		name: 'documentTemplateVariable',
		schema: documentTemplateVariableSchema,
		valid: { key: 'university', label: 'Наименование вуза', required: true },
		invalid: { key: 'university' }
	},
	{
		name: 'documentList',
		schema: documentListQuerySchema,
		valid: { interactionId: ID, kind: 'agreement' },
		invalid: { interactionId: 'нет' }
	},
	{
		name: 'auditFilter',
		schema: auditFilterSchema,
		valid: { eventType: ['auth.login'], outcome: ['denied'], from: '2026-09-01T00:00:00+03:00' },
		invalid: { eventType: ['auth.teleport'] }
	},
	{
		name: 'setting: login_banner',
		schema: settingSchemas.login_banner,
		valid: { title: 'Вход в систему', text: 'Действия записываются в журнал' },
		invalid: { title: '', text: '' }
	},
	{
		name: 'setting: session_idle_minutes',
		schema: settingSchemas.session_idle_minutes,
		valid: 30,
		invalid: 2
	},
	{
		name: 'setting: session_absolute_hours',
		schema: settingSchemas.session_absolute_hours,
		valid: 12,
		invalid: 0
	}
];

describe.each(cases)('$name', ({ schema, valid, invalid }) => {
	it('принимает допустимое значение', () => {
		expect(schema.safeParse(valid).success).toBe(true);
	});

	it('отвергает недопустимое значение', () => {
		expect(schema.safeParse(invalid).success).toBe(false);
	});
});

describe('сообщения об ошибках', () => {
	it('написаны по-русски и называют поле', () => {
		const result = createOrganizationSchema.safeParse({ ...organization, shortName: '' });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toBe('Укажите краткое наименование организации');
			expect(result.error.issues[0]?.path).toEqual(['shortName']);
		}
	});
});

describe('нормализация пустых значений', () => {
	it('превращает пустую строку необязательного поля в null', () => {
		const result = createOrganizationSchema.parse({ ...organization, notes: '', region: '  ' });

		expect(result.notes).toBeNull();
		expect(result.region).toBeNull();
	});
});
