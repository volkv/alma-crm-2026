/**
 * Пакет документов вузу из карточки дела: письмо контактным лицам основной
 * стороны с текущими редакциями документов, собранных по шаблонам, в PDF.
 *
 * Сборка пакета (`documents/package.ts`) и его отправка — разные шаги: собрать
 * можно и не отправлять, пакет уходит и через ЭДО или курьером. Отправка
 * отсюда оставляет след в деле и сама отмечает пункт чек-листа с действием
 * «Отправить пакет документов»; отправку мимо системы человек отмечает
 * галочкой.
 *
 * Получатели — как у описания программ (`contact-addressees.ts`): адресов
 * браузер не видит и не присылает. Файлы окно называет идентификаторами, а
 * сервер отправляет только те, что сейчас и есть пакет этого дела: текущие
 * редакции документов по шаблонам в PDF. Заменённая редакция, чужой документ
 * или DOCX — отказ всей отправки, а не молчаливый пропуск.
 *
 * Письма уходят в фоне: нажатие ставит задание в общую очередь писем вузу
 * (`mail/queue.ts`), окно получает ответ сразу, а обработчик
 * ({@link documentPackageMail}) шлёт письма после фиксации и ставит отметку.
 *
 * След — строка истории дела с идентификаторами получателей и документов с
 * хешами, без адресов и имён; тестовое письмо себе оставляет только журнал.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
	PACKAGE_SEND_CHANGE_FIELD,
	type PackageSendDocumentView,
	type PackageSendDraftView,
	type PackageSendOutcome,
	type PackageSendRecipientView,
	type SendDocumentPackageInput
} from '$lib/contracts/document-package-send';
import {
	DOCUMENT_TEMPLATE_KEYS,
	GENERATED_DOCUMENT_KIND,
	type DocumentTemplateKey
} from '$lib/contracts/documents';
import type { InteractionView } from '$lib/contracts/interactions';
import { formatIsoDay, pluralize } from '$lib/format';
import { readModuleFactValue } from '$lib/platform/module-fact';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import { documents, interactionChanges, interactions } from '../db/schema';
import { withTransaction } from '../db/transaction';
import { documentFileName } from '../documents/filename';
import { PDF_MIME } from '../documents/mime';
import { readStoredFile } from '../documents/storage';
import { ForbiddenError, ValidationError } from '../errors';
import { publishAfterCommit } from '../live/publish';
import {
	MAX_OUTBOUND_ATTACHMENTS_BYTES,
	outboundMailPolicy,
	sendOutboundMail,
	type OutboundAttachment
} from '../mail/outbound';
import { documentPackageEmail, type DocumentPackageFacts } from '../mail/document-package';
import {
	enqueueOutboundMail,
	PACKAGE_SEND_MAIL_KIND,
	payloadIds,
	readOutboundMailInFlight,
	singleMailResult,
	type OutboundMailHandler,
	type OutboundMailJob,
	type OutboundMailResult
} from '../mail/queue';
import { requirePermission } from '../rbac';
import { markActionItemsIn } from '../stages/commands';
import {
	contactGreetingName,
	contactPersonName,
	contactUnavailableReason,
	readCaseContacts,
	resolveCaseContacts
} from './contact-addressees';
import { getInteraction } from './read';

/** Действие пункта чек-листа, который отправка отмечает сама. */
const SEND_ACTION = 'package_send';

const NO_PACKAGE =
	'Пакет ещё не собран: соберите его кнопкой «Собрать пакет документов» в панели «Документы»';

type Sender = { id: string; name: string; email: string };

function senderOf(ctx: ActorContext): Sender {
	if (ctx.user === null) {
		throw new ForbiddenError('Письмо вузу отправляет пользователь, а не фоновая задача');
	}

	return { id: ctx.user.id, name: ctx.user.fullName, email: ctx.user.email };
}

function primaryParty(interaction: InteractionView) {
	return interaction.parties.find((party) => party.isPrimary) ?? null;
}

type PackageDocument = PackageSendDocumentView & { filePath: string; sha256: string };

const successor = alias(documents, 'successor');

/**
 * Пакет дела сейчас: по каждому шаблону — текущая редакция в PDF. Редакция,
 * загруженная руками поверх собранной (скан подписанного), наследует ключ
 * шаблона и тоже годится: это тот же документ. Порядок — каталога шаблонов,
 * как в панели сборки.
 */
async function readPackageDocuments(interactionId: string): Promise<PackageDocument[]> {
	const rows = await getDb()
		.select({
			id: documents.id,
			kind: documents.kind,
			templateKey: documents.templateKey,
			title: documents.title,
			mime: documents.mime,
			sizeBytes: documents.sizeBytes,
			sha256: documents.sha256,
			filePath: documents.filePath,
			createdAt: documents.createdAt
		})
		.from(documents)
		.leftJoin(successor, eq(successor.supersedesId, documents.id))
		.where(
			and(
				eq(documents.interactionId, interactionId),
				isNotNull(documents.templateKey),
				eq(documents.mime, PDF_MIME),
				isNull(successor.id)
			)
		)
		.orderBy(asc(documents.createdAt), asc(documents.id));

	const order = (key: DocumentTemplateKey) => DOCUMENT_TEMPLATE_KEYS.indexOf(key);

	return rows
		.flatMap((row) => (row.templateKey === null ? [] : [{ ...row, templateKey: row.templateKey }]))
		.sort((left, right) => order(left.templateKey) - order(right.templateKey))
		.map((row) => ({
			documentId: row.id,
			templateKey: row.templateKey,
			title: row.title,
			fileName: documentFileName(row.title, row.mime),
			sizeBytes: row.sizeBytes,
			createdAt: row.createdAt.toISOString(),
			uploaded: row.kind !== GENERATED_DOCUMENT_KIND,
			filePath: row.filePath,
			sha256: row.sha256
		}));
}

function packageFacts(
	interaction: InteractionView,
	sender: Sender,
	chosen: readonly PackageDocument[],
	recipientName: string | null,
	isTest: boolean
): DocumentPackageFacts {
	return {
		institutionName: primaryParty(interaction)?.organizationName ?? interaction.title,
		interactionTitle: interaction.title,
		recipientName,
		documents: chosen.map((document) => ({
			title: document.title,
			fileName: document.fileName,
			sizeBytes: document.sizeBytes
		})),
		sender: { name: sender.name, email: sender.email },
		isTest
	};
}

/**
 * Что именно ушло: роли и люди получателей, документы с хешами. Лежит рядом с
 * фразой ленты (`{ text, data, trace }`): лента читает фразу и числа, а след —
 * ответ на вопрос «какой файл мы вузу отправили», даже если документ потом
 * пересобрали.
 */
type SendTrace = {
	recipients: { affiliationId: string; personId: string }[];
	documents: { documentId: string; sha256: string }[];
};

async function readLastSent(interactionId: string): Promise<PackageSendDraftView['lastSent']> {
	const [row] = await getDb()
		.select({ changedAt: interactionChanges.changedAt, value: interactionChanges.newValue })
		.from(interactionChanges)
		.where(
			and(
				eq(interactionChanges.interactionId, interactionId),
				eq(interactionChanges.field, PACKAGE_SEND_CHANGE_FIELD)
			)
		)
		.orderBy(desc(interactionChanges.changedAt))
		.limit(1);

	const data = readModuleFactValue(row?.value)?.data;

	return row === undefined
		? null
		: {
				sentAt: row.changedAt.toISOString(),
				recipientCount: typeof data?.recipientCount === 'number' ? data.recipientCount : 0,
				documentCount: typeof data?.documentCount === 'number' ? data.documentCount : 0
			};
}

/**
 * Всё, что показывает окно отправки: получатели, файлы пакета, превью со
 * всеми файлами, политика почты. Право — запись в дело и чтение документов:
 * письмо уносит файлы дела наружу.
 */
export async function readPackageSendDraft(
	ctx: ActorContext,
	interactionId: string
): Promise<PackageSendDraftView> {
	requirePermission(ctx, 'interactions.write');
	requirePermission(ctx, 'documents.read');

	const sender = senderOf(ctx);
	const interaction = await getInteraction(ctx, interactionId);
	const primary = primaryParty(interaction);
	const [contacts, packageDocuments, lastSent, inFlight] = await Promise.all([
		readCaseContacts(ctx, interaction),
		readPackageDocuments(interaction.id),
		readLastSent(interaction.id),
		readOutboundMailInFlight(interaction.id, PACKAGE_SEND_MAIL_KIND)
	]);

	const today = formatIsoDay();
	const recipients: PackageSendRecipientView[] = (contacts ?? []).map((contact) => {
		const reason = contactUnavailableReason(contact, today);

		return {
			affiliationId: contact.id,
			name: contactPersonName(contact.person),
			position: contact.position,
			isCaseContact: contact.id === primary?.contactAffiliationId,
			available: reason === null,
			unavailableReason: reason
		};
	});

	recipients.sort((left, right) => Number(right.isCaseContact) - Number(left.isCaseContact));

	const recipientsNotice =
		primary === null
			? 'У дела нет основной стороны — писать некому'
			: contacts === null
				? 'Контакты стороны скрыты: нет права видеть людей организации. Тестовое письмо себе отправить можно'
				: recipients.length === 0
					? 'У стороны не заведено ни одного контактного лица: добавьте его в карточке вуза или в диалоге «Контактное лицо»'
					: recipients.every((recipient) => !recipient.available)
						? 'Ни у одного контактного лица нет открытой почты'
						: null;

	const previewRecipient =
		recipients.find((recipient) => recipient.isCaseContact && recipient.available) ??
		recipients.find((recipient) => recipient.available);
	const previewContact = contacts?.find(
		(contact) => contact.id === previewRecipient?.affiliationId
	);
	const previewFor =
		previewContact === undefined ? null : contactGreetingName(previewContact.person);
	const email = documentPackageEmail(
		packageFacts(interaction, sender, packageDocuments, previewFor, false)
	);
	const policy = outboundMailPolicy();

	return {
		recipients,
		recipientsNotice,
		documents: packageDocuments.map((document) => ({
			documentId: document.documentId,
			templateKey: document.templateKey,
			title: document.title,
			fileName: document.fileName,
			sizeBytes: document.sizeBytes,
			createdAt: document.createdAt,
			uploaded: document.uploaded
		})),
		subject: email.subject,
		previewHtml: email.html,
		previewFor,
		attachmentsLimitBytes: MAX_OUTBOUND_ATTACHMENTS_BYTES,
		sender: { name: sender.name, email: sender.email },
		policy: { allowed: policy.allowed, sandboxed: policy.sandboxed, reason: policy.reason },
		lastSent,
		inFlight
	};
}

/**
 * Отмеченные файлы — только из текущего пакета дела. Размер сверяется по
 * записям документов, до чтения из хранилища: письмо, которое сервер всё
 * равно отбил бы, не должно ни вставать в очередь, ни тянуть файлы.
 */
async function chooseDocuments(
	interactionId: string,
	documentIds: readonly string[]
): Promise<PackageDocument[]> {
	const available = await readPackageDocuments(interactionId);

	if (available.length === 0) {
		throw new ValidationError(NO_PACKAGE);
	}

	if (documentIds.length === 0) {
		throw new ValidationError('Отметьте хотя бы один файл пакета');
	}

	const wanted = new Set(documentIds);
	const chosen = available.filter((document) => wanted.has(document.documentId));

	if (chosen.length !== wanted.size) {
		throw new ValidationError(
			'Файл не из текущего пакета дела: его заменили новой редакцией или он не собран по шаблону',
			['Обновите окно отправки']
		);
	}

	const total = chosen.reduce((sum, document) => sum + document.sizeBytes, 0);

	if (total > MAX_OUTBOUND_ATTACHMENTS_BYTES) {
		throw new ValidationError('Файлы пакета не помещаются в одно письмо', [
			'Отметьте меньше файлов и отправьте остальные вторым письмом'
		]);
	}

	return chosen;
}

/** Файлы вложений — читаются обработчиком, в момент отправки. */
async function readAttachments(chosen: readonly PackageDocument[]): Promise<OutboundAttachment[]> {
	return Promise.all(
		chosen.map(async (document) => ({
			filename: document.fileName,
			content: await readStoredFile(document.filePath),
			contentType: PDF_MIME
		}))
	);
}

function auditOf(test: boolean, interactionId: string) {
	return {
		type: test ? 'interactions.document_package_tested' : 'interactions.document_package_sent',
		subject: { type: 'interaction', id: interactionId }
	} as const;
}

/**
 * Тестовое письмо себе или письма выбранным контактам — постановкой в
 * очередь. Окно получает ответ сразу, письма уходят в фоне
 * ({@link documentPackageMail}).
 *
 * Отказы, видные без почтового сервера (права, чужой получатель или файл,
 * размер), — исключения и ответ 4xx, как и раньше; закрытая почта установки —
 * исход `refused`. Задание несёт только идентификаторы ролей и документов.
 */
export async function sendDocumentPackage(
	ctx: ActorContext,
	input: SendDocumentPackageInput
): Promise<PackageSendOutcome> {
	const audit = auditOf(input.test, input.interactionId);

	await requirePermission(ctx, 'interactions.write', audit);
	await requirePermission(ctx, 'documents.read', audit);

	senderOf(ctx);

	const interaction = await getInteraction(ctx, input.interactionId);
	const policy = outboundMailPolicy();

	if (!policy.allowed) {
		return {
			status: 'refused',
			test: input.test,
			error: policy.reason ?? 'Почтовый сервер не настроен'
		};
	}

	if (!input.test && input.recipientIds.length === 0) {
		throw new ValidationError('Отметьте хотя бы одного получателя');
	}

	const addressees = input.test
		? []
		: await resolveCaseContacts(ctx, interaction, input.recipientIds, audit.type);

	for (const addressee of addressees) {
		if (addressee.email === null) {
			throw new ValidationError(
				`Письмо не отправить: ${contactPersonName(addressee.contact.person)}`,
				[addressee.reason]
			);
		}
	}

	await chooseDocuments(interaction.id, input.documentIds);

	await withTransaction(ctx, (tx) =>
		enqueueOutboundMail(ctx, tx, {
			kind: PACKAGE_SEND_MAIL_KIND,
			label: input.test ? 'Тестовый пакет документов' : 'Пакет документов',
			interactionId: interaction.id,
			test: input.test,
			payload: { recipientIds: input.recipientIds, documentIds: input.documentIds }
		})
	);

	return { status: 'queued', test: input.test };
}

/**
 * Обработчик очереди: письма уходят по одному, от имени отправителя и по его
 * действующим правам. Пакет и адреса читаются в момент отправки: файл,
 * заменённый новой редакцией за время ожидания, — отказ всей отправки, а не
 * письмо со старой редакцией.
 *
 * След в деле и отметка пункта — если ушло хоть одному.
 */
async function deliverDocumentPackage(
	ctx: ActorContext,
	job: OutboundMailJob
): Promise<OutboundMailResult> {
	const audit = auditOf(job.test, job.interactionId);

	await requirePermission(ctx, 'interactions.write', audit);
	await requirePermission(ctx, 'documents.read', audit);

	const recipientIds = payloadIds(job, 'recipientIds');
	const sender = senderOf(ctx);
	const interaction = await getInteraction(ctx, job.interactionId);
	const chosen = await chooseDocuments(interaction.id, payloadIds(job, 'documentIds'));
	const attachments = await readAttachments(chosen);
	const details = { mailJobId: job.id, attachmentCount: attachments.length };

	if (job.test) {
		const contacts = recipientIds.length === 0 ? null : await readCaseContacts(ctx, interaction);
		const shown = contacts?.find((contact) => contact.id === recipientIds[0]);
		const email = documentPackageEmail(
			packageFacts(
				interaction,
				sender,
				chosen,
				shown === undefined ? null : contactGreetingName(shown.person),
				true
			)
		);
		const outcome = await sendOutboundMail({
			to: [{ name: sender.name, email: sender.email }],
			subject: email.subject,
			html: email.html,
			text: email.text,
			attachments
		});

		await recordAuditEvent(ctx, {
			...audit,
			outcome: outcome.status === 'sent' ? 'success' : 'failure',
			details
		});

		return singleMailResult(outcome);
	}

	const addressees = await resolveCaseContacts(ctx, interaction, recipientIds, audit.type);
	const sent: { affiliationId: string; personId: string }[] = [];
	const failed: string[] = [];
	let refused: string | null = null;

	// По одному письму: у каждого своё обращение, и адреса коллег не
	// раскрываются друг другу. Отказ до соединения одинаков для всех. Адрес,
	// закрывшийся за время ожидания, — письмо не уходит только этому человеку.
	for (const addressee of addressees) {
		if (addressee.email === null) {
			failed.push(`${contactPersonName(addressee.contact.person)} — ${addressee.reason}`);
			continue;
		}

		const email = documentPackageEmail(
			packageFacts(
				interaction,
				sender,
				chosen,
				contactGreetingName(addressee.contact.person),
				false
			)
		);
		const outcome = await sendOutboundMail({
			to: [{ name: contactPersonName(addressee.contact.person), email: addressee.email }],
			subject: email.subject,
			html: email.html,
			text: email.text,
			attachments,
			replyTo: sender.email
		});

		if (outcome.status === 'sent') {
			sent.push({ affiliationId: addressee.contact.id, personId: addressee.contact.person.id });
		} else if (outcome.status === 'refused') {
			refused = outcome.error;
			break;
		} else {
			failed.push(`${contactPersonName(addressee.contact.person)} — ${outcome.error}`);
		}
	}

	const result: OutboundMailResult = {
		sentCount: sent.length,
		failedCount: failed.length,
		refused,
		error: failed[0] ?? null
	};

	if (sent.length === 0) {
		await recordAuditEvent(ctx, {
			...audit,
			outcome: 'failure',
			details: { ...details, recipientCount: 0 }
		});

		return result;
	}

	const trace: SendTrace = {
		recipients: sent,
		documents: chosen.map((document) => ({
			documentId: document.documentId,
			sha256: document.sha256
		}))
	};

	await withTransaction(ctx, async (tx) => {
		// Блокировка — как у любой записи в дело. Письма уже ушли: отказ сейчас
		// оставил бы их без следа, поэтому область проверена чтением дела выше.
		await tx
			.select({ id: interactions.id })
			.from(interactions)
			.where(eq(interactions.id, interaction.id))
			.for('update');

		await tx.insert(interactionChanges).values({
			interactionId: interaction.id,
			authorId: sender.id,
			field: PACKAGE_SEND_CHANGE_FIELD,
			oldValue: null,
			newValue: {
				text: sentText(sent.length, chosen.length),
				data: { recipientCount: sent.length, documentCount: chosen.length },
				trace
			}
		});

		await tx
			.update(interactions)
			.set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
			.where(eq(interactions.id, interaction.id));

		// Пункт «Пакет отправлен» — ручной: его отмечает и человек, если пакет
		// ушёл мимо системы. Здесь отметку ставит сама отправка, от имени того,
		// кто нажал, — и только при праве менять чек-лист. Нет такого пункта на
		// открытой стадии или права — письмо ушло, пункт остаётся как был.
		const marked = await markActionItemsIn(ctx, tx, interaction.id, SEND_ACTION);

		await recordAuditEvent(
			ctx,
			{
				...audit,
				outcome: 'success',
				details: {
					...details,
					recipientCount: sent.length,
					checklistItemCount: marked ? 1 : 0
				}
			},
			tx
		);

		publishAfterCommit(tx, interaction.id, { type: 'interaction.changed' });
	});

	return result;
}

/** Пакет документов в очереди писем: кто его отправляет. */
export const documentPackageMail: OutboundMailHandler = {
	auditType: (job) => auditOf(job.test, job.interactionId).type,
	deliver: deliverDocumentPackage
};

/** Строка ленты: сколько получателей и файлов, без имён. */
function sentText(recipients: number, files: number): string {
	return `Пакет документов отправлен вузу: ${pluralize(recipients, ['получатель', 'получателя', 'получателей'])}, ${pluralize(files, ['файл', 'файла', 'файлов'])}`;
}
