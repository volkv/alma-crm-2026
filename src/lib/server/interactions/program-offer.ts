/**
 * Описание программ вузу в один клик: письмо контактным лицам основной стороны
 * с программами и продуктами дела и материалами программ во вложении.
 *
 * Шаблон письма (`mail/program-offer.ts`) и отправка с песочницей
 * (`mail/outbound.ts`) живут своими модулями; здесь — факты дела для шаблона,
 * права и след в деле.
 *
 * Адреса получателей в браузер не уходят и из браузера не принимаются: кому
 * из контактов стороны можно написать, решает `contact-addressees.ts`, общий
 * с приглашением на встречу.
 *
 * Письма уходят в фоне: нажатие ставит задание в общую очередь писем вузу
 * (`mail/queue.ts`), окно получает ответ сразу, а обработчик
 * ({@link programOfferMail}) шлёт письма после фиксации.
 *
 * Каждому получателю — своё письмо: обращение по имени, и адреса коллег друг
 * другу не раскрываются. След отправки — строка `program_offer_sends` с одними
 * идентификаторами и запись в истории дела для ленты; тестовое письмо себе
 * оставляет только строку журнала.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { PROGRAM_LEVEL_LABELS } from '$lib/components/directory/labels';
import type { InteractionView } from '$lib/contracts/interactions';
import {
	PROGRAM_OFFER_CHANGE_FIELD,
	type ProgramOfferAttachmentView,
	type ProgramOfferDraftView,
	type ProgramOfferOutcome,
	type ProgramOfferRecipientView,
	type SendProgramOfferInput
} from '$lib/contracts/program-offer';
import { formatIsoDay, pluralize } from '$lib/format';
import type { ActorContext } from '../actor';
import { recordAuditEvent } from '../audit';
import { getDb } from '../db';
import {
	interactionChanges,
	interactions,
	products,
	programOfferSends,
	programs,
	programVersions,
	stageEntries
} from '../db/schema';
import { withTransaction, type Tx } from '../db/transaction';
import { listProgramMaterials, type ProgramMaterial } from '../directory/program-materials';
import { readStoredFile } from '../documents/storage';
import { ForbiddenError, ValidationError } from '../errors';
import { publishAfterCommit } from '../live/publish';
import {
	MAX_OUTBOUND_ATTACHMENTS_BYTES,
	outboundMailPolicy,
	sendOutboundMail,
	type OutboundAttachment
} from '../mail/outbound';
import { programOfferEmail, type ProgramOfferFacts } from '../mail/program-offer';
import {
	enqueueOutboundMail,
	payloadIds,
	PROGRAM_OFFER_MAIL_KIND,
	readOutboundMailInFlight,
	singleMailResult,
	type OutboundMailHandler,
	type OutboundMailJob,
	type OutboundMailResult
} from '../mail/queue';
import { requirePermission } from '../rbac';
import {
	contactGreetingName,
	contactPersonName,
	contactUnavailableReason,
	readCaseContacts,
	resolveCaseContacts,
	type CaseContactAddressee
} from './contact-addressees';
import { getInteraction } from './read';

const NO_PROGRAMS = 'В деле нет программ: добавьте их в «Программы и продукты»';

/** Отправитель — тот, кто нажал: письмо подписано им, ответ вуза придёт ему. */
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

type OfferContent = {
	facts: Omit<ProgramOfferFacts, 'recipientName' | 'isTest'>;
	materials: (ProgramMaterial & { programName: string })[];
};

/**
 * Факты дела для письма: программы с описанием и сводкой привязанной версии,
 * продукты, материалы программ. Справочник программ общий, и программы дела
 * видит всякий, кто видит дело, — материалы читаются без своей проверки прав.
 */
async function readOfferContent(
	interaction: InteractionView,
	sender: Sender
): Promise<OfferContent> {
	const programIds = interaction.programs.map((program) => program.programId);
	const versionIds = interaction.programs
		.map((program) => program.programVersionId)
		.filter((id): id is string => id !== null);
	const productIds = interaction.products.map((product) => product.productId);

	const [programRows, versionRows, productRows, materials] = await Promise.all([
		programIds.length === 0
			? []
			: getDb()
					.select({
						id: programs.id,
						code: programs.code,
						name: programs.name,
						level: programs.level,
						description: programs.description
					})
					.from(programs)
					.where(inArray(programs.id, programIds)),
		versionIds.length === 0
			? []
			: getDb()
					.select({ id: programVersions.id, summary: programVersions.summary })
					.from(programVersions)
					.where(inArray(programVersions.id, versionIds)),
		productIds.length === 0
			? []
			: getDb()
					.select({ id: products.id, name: products.name, description: products.description })
					.from(products)
					.where(inArray(products.id, productIds)),
		listProgramMaterials(programIds)
	]);

	// Порядок — порядок дела: так программы стоят и в карточке.
	const offered = interaction.programs.flatMap((link) => {
		const program = programRows.find((row) => row.id === link.programId);

		return program === undefined ? [] : [{ link, program }];
	});

	return {
		facts: {
			institutionName: primaryParty(interaction)?.organizationName ?? interaction.title,
			interactionTitle: interaction.title,
			programs: offered.map(({ link, program }) => ({
				code: program.code,
				name: program.name,
				levelLabel: PROGRAM_LEVEL_LABELS[program.level],
				description: program.description,
				versionSummary:
					versionRows.find((row) => row.id === link.programVersionId)?.summary ?? null,
				materials: materials
					.filter((material) => material.programId === program.id)
					.map((material) => ({ fileName: material.fileName, sizeBytes: material.sizeBytes }))
			})),
			products: interaction.products.flatMap((link) => {
				const product = productRows.find((row) => row.id === link.productId);

				return product === undefined
					? []
					: [{ name: product.name, description: product.description }];
			}),
			sender: { name: sender.name, email: sender.email }
		},
		materials: offered.flatMap(({ program }) =>
			materials
				.filter((material) => material.programId === program.id)
				.map((material) => ({ ...material, programName: program.name }))
		)
	};
}

async function readLastSent(interactionId: string): Promise<ProgramOfferDraftView['lastSent']> {
	const [row] = await getDb()
		.select({
			sentAt: programOfferSends.sentAt,
			recipientCount: sql<number>`jsonb_array_length(${programOfferSends.recipients})::int`
		})
		.from(programOfferSends)
		.where(eq(programOfferSends.interactionId, interactionId))
		.orderBy(desc(programOfferSends.sentAt))
		.limit(1);

	return row === undefined
		? null
		: { sentAt: row.sentAt.toISOString(), recipientCount: row.recipientCount };
}

/**
 * Всё, что показывает окно письма: получатели, превью, вложения, политика
 * почты. Право — запись в дело: письмо вузу — действие по делу, а не просмотр.
 */
export async function readProgramOfferDraft(
	ctx: ActorContext,
	interactionId: string
): Promise<ProgramOfferDraftView> {
	requirePermission(ctx, 'interactions.write');

	const sender = senderOf(ctx);
	const interaction = await getInteraction(ctx, interactionId);
	const primary = primaryParty(interaction);
	const [contacts, content, lastSent, inFlight] = await Promise.all([
		readCaseContacts(ctx, interaction),
		readOfferContent(interaction, sender),
		readLastSent(interaction.id),
		readOutboundMailInFlight(interaction.id, PROGRAM_OFFER_MAIL_KIND)
	]);

	const today = formatIsoDay();
	const recipients: ProgramOfferRecipientView[] = (contacts ?? []).map((contact) => {
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

	// Контактное лицо дела — первым: оно же отмечено по умолчанию.
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

	// Превью — письмо того, кто отмечен по умолчанию: контактного лица дела,
	// а если ему не написать — первого, кому можно.
	const previewRecipient =
		recipients.find((recipient) => recipient.isCaseContact && recipient.available) ??
		recipients.find((recipient) => recipient.available);
	const previewContact = contacts?.find(
		(contact) => contact.id === previewRecipient?.affiliationId
	);
	const previewFor =
		previewContact === undefined ? null : contactGreetingName(previewContact.person);
	const email = programOfferEmail({ ...content.facts, recipientName: previewFor, isTest: false });
	const attachments: ProgramOfferAttachmentView[] = content.materials.map((material) => ({
		documentId: material.documentId,
		programName: material.programName,
		fileName: material.fileName,
		sizeBytes: material.sizeBytes
	}));
	const policy = outboundMailPolicy();

	return {
		recipients,
		recipientsNotice,
		subject: email.subject,
		previewHtml: email.html,
		previewFor,
		programCount: content.facts.programs.length,
		attachments,
		attachmentsBytes: attachments.reduce((total, item) => total + item.sizeBytes, 0),
		attachmentsLimitBytes: MAX_OUTBOUND_ATTACHMENTS_BYTES,
		sender: { name: sender.name, email: sender.email },
		policy: { allowed: policy.allowed, sandboxed: policy.sandboxed, reason: policy.reason },
		lastSent,
		inFlight
	};
}

/**
 * Вложения помещаются в одно письмо. Сверяется по размеру из справочника, до
 * чтения из хранилища: письмо, которое почтовый сервер всё равно отбил бы, не
 * должно ни вставать в очередь, ни тянуть двадцать мегабайт.
 */
function assertAttachmentsFit(materials: readonly ProgramMaterial[]): void {
	const total = materials.reduce((sum, material) => sum + material.sizeBytes, 0);

	if (total > MAX_OUTBOUND_ATTACHMENTS_BYTES) {
		throw new ValidationError('Материалы программ не помещаются в одно письмо', [
			'Уберите часть материалов с карточек программ или отправьте их отдельно'
		]);
	}
}

/** Файлы вложений — читаются обработчиком, в момент отправки. */
async function readAttachments(
	materials: readonly ProgramMaterial[]
): Promise<OutboundAttachment[]> {
	assertAttachmentsFit(materials);

	return Promise.all(
		materials.map(async (material) => ({
			filename: material.fileName,
			content: await readStoredFile(material.filePath),
			contentType: material.mime
		}))
	);
}

/**
 * Получатели настоящей отправки: только контакты основной стороны этого дела.
 * Чужой контакт — отказ всей отправки. `strict` — при нажатии: закрытый адрес
 * тоже отказ, человек видит это в окне. В обработчике адрес мог закрыться
 * между нажатием и отправкой — такому получателю письмо просто не уходит, а
 * исход называет причину.
 */
async function resolveAddressees(
	ctx: ActorContext,
	interaction: InteractionView,
	recipientIds: readonly string[],
	strict: boolean
): Promise<CaseContactAddressee[]> {
	if (recipientIds.length === 0) {
		throw new ValidationError('Отметьте хотя бы одного получателя');
	}

	const resolved = await resolveCaseContacts(
		ctx,
		interaction,
		recipientIds,
		'interactions.program_offer_sent'
	);

	if (strict) {
		for (const { contact, email, reason } of resolved) {
			if (email === null) {
				throw new ValidationError(`Письмо не отправить: ${contactPersonName(contact.person)}`, [
					reason
				]);
			}
		}
	}

	return resolved;
}

/** Открытая запись стадии дела; `null` — дело ни на какой стадии не стоит. */
async function openEntryId(executor: Tx, interactionId: string): Promise<string | null> {
	const [row] = await executor
		.select({ id: stageEntries.id })
		.from(stageEntries)
		.where(and(eq(stageEntries.interactionId, interactionId), isNull(stageEntries.leftAt)))
		.limit(1);

	return row?.id ?? null;
}

function auditTypeOf(test: boolean) {
	return test ? 'interactions.program_offer_tested' : 'interactions.program_offer_sent';
}

/**
 * Тестовое письмо себе или письма выбранным контактам — постановкой в
 * очередь. Окно получает ответ сразу, письма уходят в фоне
 * ({@link programOfferMail}).
 *
 * Всё, что видно без почтового сервера (прав нет, получатель чужой, вложения
 * не помещаются), — исключения и ответ 4xx, как и раньше; закрытая почта
 * установки — исход `refused`. Задание несёт только идентификаторы ролей:
 * адреса обработчик подставит заново.
 */
export async function sendProgramOffer(
	ctx: ActorContext,
	input: SendProgramOfferInput
): Promise<ProgramOfferOutcome> {
	await requirePermission(ctx, 'interactions.write', {
		type: auditTypeOf(input.test),
		subject: { type: 'interaction', id: input.interactionId }
	});

	const sender = senderOf(ctx);
	const interaction = await getInteraction(ctx, input.interactionId);

	if (interaction.programs.length === 0) {
		throw new ValidationError(NO_PROGRAMS);
	}

	const policy = outboundMailPolicy();

	if (!policy.allowed) {
		return {
			status: 'refused',
			test: input.test,
			error: policy.reason ?? 'Почтовый сервер не настроен'
		};
	}

	if (!input.test) {
		await resolveAddressees(ctx, interaction, input.recipientIds, true);
	}

	assertAttachmentsFit((await readOfferContent(interaction, sender)).materials);

	await withTransaction(ctx, (tx) =>
		enqueueOutboundMail(ctx, tx, {
			kind: PROGRAM_OFFER_MAIL_KIND,
			label: input.test ? 'Тестовое описание программ' : 'Описание программ',
			interactionId: interaction.id,
			test: input.test,
			// У тестового — чьё обращение показать, как в превью.
			payload: { recipientIds: input.recipientIds }
		})
	);

	return { status: 'queued', test: input.test };
}

/**
 * Обработчик очереди: письма уходят по одному, от имени отправителя и по его
 * действующим правам. Дело, программы, материалы и адреса читаются в момент
 * отправки: за время ожидания их могли поправить.
 *
 * След в деле — строка `program_offer_sends` (по ней закрывается пункт
 * правилом `offer_sent`) и запись истории для ленты — пишется, если ушло хоть
 * одному, и называет только тех, кому ушло. Тестовое письмо себе оставляет
 * только журнал.
 */
async function deliverProgramOffer(
	ctx: ActorContext,
	job: OutboundMailJob
): Promise<OutboundMailResult> {
	const audit = {
		type: auditTypeOf(job.test),
		subject: { type: 'interaction', id: job.interactionId }
	} as const;

	await requirePermission(ctx, 'interactions.write', audit);

	const recipientIds = payloadIds(job, 'recipientIds');
	const sender = senderOf(ctx);
	const interaction = await getInteraction(ctx, job.interactionId);

	if (interaction.programs.length === 0) {
		throw new ValidationError(NO_PROGRAMS);
	}

	const content = await readOfferContent(interaction, sender);
	const attachments = await readAttachments(content.materials);
	const details = {
		mailJobId: job.id,
		attachmentCount: attachments.length,
		programCount: content.facts.programs.length
	};

	if (job.test) {
		// Обращение в тестовом письме — того, кого окно показывало в превью, если
		// его имя можно прочитать; иначе обезличенное «Здравствуйте!».
		const contacts = recipientIds.length === 0 ? null : await readCaseContacts(ctx, interaction);
		const shown = contacts?.find((contact) => contact.id === recipientIds[0]);
		const email = programOfferEmail({
			...content.facts,
			recipientName: shown === undefined ? null : contactGreetingName(shown.person),
			isTest: true
		});
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

	const addressees = await resolveAddressees(ctx, interaction, recipientIds, false);
	const sent: CaseContactAddressee[] = [];
	const failed: string[] = [];
	let refused: string | null = null;

	// По одному письму: у каждого своё обращение, и адреса коллег не
	// раскрываются друг другу. Отказ до соединения (песочница, размер) одинаков
	// для всех — после первого остальных не пробуем.
	for (const addressee of addressees) {
		if (addressee.email === null) {
			failed.push(`${contactPersonName(addressee.contact.person)} — ${addressee.reason}`);
			continue;
		}

		const email = programOfferEmail({
			...content.facts,
			recipientName: contactGreetingName(addressee.contact.person),
			isTest: false
		});
		const outcome = await sendOutboundMail({
			to: [{ name: contactPersonName(addressee.contact.person), email: addressee.email }],
			subject: email.subject,
			html: email.html,
			text: email.text,
			attachments,
			replyTo: sender.email
		});

		if (outcome.status === 'sent') {
			sent.push(addressee);
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

	await withTransaction(ctx, async (tx) => {
		// Блокировка — как у любой записи в дело: след ложится после правок,
		// начатых раньше, а не посреди них. Область доступа проверена чтением
		// дела перед отправкой; письма уже ушли, и отказ сейчас оставил бы их
		// без следа.
		await tx
			.select({ id: interactions.id })
			.from(interactions)
			.where(eq(interactions.id, interaction.id))
			.for('update');

		const [row] = await tx
			.insert(programOfferSends)
			.values({
				interactionId: interaction.id,
				stageEntryId: await openEntryId(tx, interaction.id),
				sentBy: sender.id,
				recipients: sent.map((addressee) => ({
					affiliationId: addressee.contact.id,
					personId: addressee.contact.person.id
				})),
				programs: interaction.programs.map((program) => ({
					programId: program.programId,
					programVersionId: program.programVersionId
				})),
				documents: content.materials.map((material) => ({
					documentId: material.documentId,
					sha256: material.sha256
				}))
			})
			.returning({ id: programOfferSends.id });

		await tx.insert(interactionChanges).values({
			interactionId: interaction.id,
			authorId: sender.id,
			field: PROGRAM_OFFER_CHANGE_FIELD,
			oldValue: null,
			newValue: {
				text: offerText(sent.length, attachments.length),
				data: { sendId: row.id }
			}
		});

		await tx
			.update(interactions)
			.set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
			.where(eq(interactions.id, interaction.id));

		await recordAuditEvent(
			ctx,
			{
				...audit,
				outcome: 'success',
				details: { ...details, recipientCount: sent.length, sendId: row.id }
			},
			tx
		);

		publishAfterCommit(tx, interaction.id, { type: 'interaction.changed' });
	});

	return result;
}

/** Описание программ в очереди писем: кто его отправляет. */
export const programOfferMail: OutboundMailHandler = {
	auditType: (job) => auditTypeOf(job.test),
	deliver: deliverProgramOffer
};

/** Строка ленты: сколько получателей и вложений, без имён. */
function offerText(recipients: number, attachments: number): string {
	const files = attachments === 0 ? 'без вложений' : `вложений: ${attachments}`;

	return `Описание программ отправлено вузу: ${pluralize(recipients, ['получатель', 'получателя', 'получателей'])}, ${files}`;
}
