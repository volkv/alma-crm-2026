/**
 * Встреча дела и письма о ней: назначение с приглашением участникам, перенос с
 * обновлением того же события и отмена.
 *
 * Встреча — факт модуля в истории дела (`meetings:scheduled`): дата,
 * длительность, место, идентификатор события календаря и его редакция, а с
 * письмами — ещё и кого пригласили, идентификаторами контактов и сотрудников.
 * По этому списку отмена знает, кому слать `METHOD:CANCEL`. Имён и адресов в
 * факте нет: они читаются заново при каждой отправке, по действующему праву.
 *
 * Получатели приглашения — контакты основной стороны дела (права и правила
 * те же, что у описания программ: `contact-addressees.ts` ядра) и коллеги —
 * сотрудники, которые видят дело, как у упоминаний в комментариях. Кого нет
 * в этих списках, сервер не примет, что бы ни прислал браузер. Организатор —
 * ответственный за дело: он в `ORGANIZER`, ответы идут ему (`Reply-To`), и
 * копию письма он получает сам.
 *
 * Каждому — своё письмо с одним и тем же файлом календаря: обращение по
 * имени, адреса участников друг другу видны только в самом событии, как в
 * любом приглашении календаря.
 */
import { inArray } from 'drizzle-orm';
import { formatIsoDay, pluralize } from '$lib/format';
import type { ModuleFactData } from '$lib/platform/module-fact';
import {
	canUserSeeInteraction,
	contactGreetingName,
	contactPersonName,
	contactUnavailableReason,
	ForbiddenError,
	getDb,
	getInteraction,
	meetingInviteEmail,
	outboundMailPolicy,
	readCaseContacts,
	readModuleFact,
	recordAuditEvent,
	recordModuleFact,
	requirePermission,
	resolveCaseContacts,
	sendOutboundMail,
	users,
	ValidationError,
	can,
	type ActorContext,
	type MeetingMailKind
} from '$lib/platform/core.server';
import type { InteractionView } from '$lib/contracts/interactions';
import type { MeetingMissedRecipient, MeetingSendOutcome } from '../data';
import meetings from '../index';
import { buildMeetingInvite, nextMeetingIdentity, type MeetingAttendee } from './ics';

const MOSCOW_WHEN = new Intl.DateTimeFormat('ru-RU', {
	timeZone: 'Europe/Moscow',
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit'
});

/** Сколько участников за одну отправку: приглашение на встречу, а не рассылка. */
export const MAX_MEETING_ATTENDEES = 30;

/** Встреча дела, как её сохранил последний факт `meetings:scheduled`. */
export type StoredMeeting = {
	start: Date;
	durationMinutes: number;
	location: string | null;
	uid: string;
	sequence: number;
	cancelled: boolean;
	/** Кому ушло последнее письмо: контакты стороны и сотрудники, без ответственного. */
	contactIds: string[];
	userIds: string[];
};

function idList(value: unknown): string[] {
	return typeof value === 'string' && value !== '' ? value.split(',') : [];
}

/** Последняя назначенная встреча дела; `null` — встреч ещё не назначали. */
export async function readMeeting(interactionId: string): Promise<StoredMeeting | null> {
	const fact = await readModuleFact(getDb(), interactionId, meetings.key, 'scheduled');

	if (fact === null) {
		return null;
	}

	const { start, durationMinutes, location, uid, sequence, status } = fact.data;

	if (
		typeof start !== 'string' ||
		typeof durationMinutes !== 'number' ||
		(location !== null && typeof location !== 'string') ||
		typeof uid !== 'string' ||
		typeof sequence !== 'number'
	) {
		throw new Error(`Встреча дела ${interactionId} сохранена без своих данных`);
	}

	return {
		start: new Date(start),
		durationMinutes,
		location,
		uid,
		sequence,
		cancelled: status === 'cancelled',
		contactIds: idList(fact.data.contactIds),
		userIds: idList(fact.data.userIds)
	};
}

/** Встреча впереди и не отменена — её можно перенести или отменить. */
export function isUpcoming(meeting: StoredMeeting | null, now: Date): meeting is StoredMeeting {
	return meeting !== null && !meeting.cancelled && meeting.start.getTime() > now.getTime();
}

/**
 * Данные факта. Списки приглашённых — строкой через запятую: данные факта
 * плоские (`ModuleFactData`), а идентификаторы запятой не содержат.
 */
function factData(meeting: StoredMeeting): ModuleFactData {
	return {
		start: meeting.start.toISOString(),
		durationMinutes: meeting.durationMinutes,
		location: meeting.location,
		uid: meeting.uid,
		sequence: meeting.sequence,
		status: meeting.cancelled ? 'cancelled' : 'scheduled',
		contactIds: meeting.contactIds.join(','),
		userIds: meeting.userIds.join(',')
	};
}

/** Встреча одной фразой для ленты и пункта чек-листа. */
export function meetingText(
	meeting: Pick<StoredMeeting, 'start' | 'durationMinutes' | 'location'>,
	rescheduled: boolean
): string {
	return [
		`${rescheduled ? 'Встреча перенесена' : 'Назначена встреча'}: ${MOSCOW_WHEN.format(meeting.start)} по Москве, ${meeting.durationMinutes} мин`,
		...(meeting.location === null ? [] : [`место: ${meeting.location}`])
	].join(', ');
}

function recipientsText(count: number): string {
	return pluralize(count, ['получатель', 'получателя', 'получателей']);
}

/** Сохранить встречу фактом дела: строка ленты, блокировка дела, событие журнала. */
export async function recordMeeting(
	ctx: ActorContext,
	interactionId: string,
	meeting: StoredMeeting,
	input: {
		text: string;
		auditType: 'interactions.meeting_invited' | 'interactions.meeting_cancelled';
		recipientCount?: number;
		mode?: 'invite' | 'update';
	}
): Promise<void> {
	await recordModuleFact(ctx, {
		interactionId,
		module: meetings.key,
		fact: 'scheduled',
		text: input.text,
		data: factData(meeting),
		auditType: input.auditType,
		auditDetails: {
			...(input.recipientCount === undefined ? {} : { recipientCount: input.recipientCount }),
			...(input.mode === undefined ? {} : { mode: input.mode })
		}
	});
}

/** Организатор — ответственный за дело: без него звать некому от имени дела. */
type Organizer = { userId: string; name: string; email: string };

async function readOrganizer(interaction: InteractionView): Promise<Organizer> {
	if (interaction.ownerUserId === null) {
		throw new ValidationError(
			'У дела не назначен ответственный: назначьте его, чтобы разослать приглашение'
		);
	}

	const [row] = await getDb()
		.select({ id: users.id, email: users.email, fullName: users.fullName })
		.from(users)
		.where(inArray(users.id, [interaction.ownerUserId]))
		.limit(1);

	if (row === undefined) {
		// Ответственный дела ссылается на пользователя внешним ключом: его
		// отсутствие — нарушение данных, а не ввод человека.
		throw new Error(`Ответственный ${interaction.ownerUserId} не найден среди пользователей`);
	}

	return { userId: row.id, name: row.fullName, email: row.email };
}

/** Один адресат письма: контакт стороны, коллега или сам ответственный (копия). */
type Recipient = {
	name: string;
	email: string;
	greeting: string | null;
	contactId: string | null;
	userId: string | null;
};

/**
 * Коллеги из списка диалога — только сотрудники, которые видят это дело
 * прямо сейчас, тем же условием, что у карточки и упоминаний. Кто не видит,
 * тому приглашение с повесткой по делу не уходит: отказ всей отправки, как и
 * у чужого контакта.
 */
async function resolveColleagues(
	interactionId: string,
	userIds: readonly string[],
	ownerUserId: string
): Promise<Recipient[]> {
	const ids = [...new Set(userIds)].filter((id) => id !== ownerUserId);

	if (ids.length === 0) {
		return [];
	}

	const rows = await getDb()
		.select({
			id: users.id,
			email: users.email,
			fullName: users.fullName,
			isActive: users.isActive
		})
		.from(users)
		.where(inArray(users.id, ids));

	return Promise.all(
		ids.map(async (id) => {
			const row = rows.find((candidate) => candidate.id === id);

			if (row === undefined || !row.isActive || !(await canUserSeeInteraction(id, interactionId))) {
				throw new ValidationError(
					'Позвать на встречу можно только коллегу, который видит это дело'
				);
			}

			return { name: row.fullName, email: row.email, greeting: null, contactId: null, userId: id };
		})
	);
}

function organizerCopy(organizer: Organizer): Recipient {
	return {
		name: organizer.name,
		email: organizer.email,
		greeting: null,
		contactId: null,
		userId: null
	};
}

/** Один адрес — одно письмо: коллега мог оказаться и ответственным, и в списке. */
function uniqueByEmail(recipients: readonly Recipient[]): Recipient[] {
	const seen = new Set<string>();

	return recipients.filter((recipient) => {
		const key = recipient.email.trim().toLowerCase();

		if (seen.has(key)) {
			return false;
		}

		seen.add(key);

		return true;
	});
}

type Delivery = { sent: Recipient[]; failed: MeetingMissedRecipient[]; refused: string | null };

type MailContent = {
	kind: MeetingMailKind;
	institutionName: string;
	summary: string;
	topic: string;
	start: Date;
	durationMinutes: number;
	location: string | null;
	agenda: string;
	organizer: Organizer;
	isTest: boolean;
	calendar: { method: 'REQUEST' | 'CANCEL'; content: string };
};

/**
 * По одному письму каждому. Отказ до соединения (песочница, адрес) одинаков для
 * всех — после первого остальных не пробуем, как и у описания программ.
 */
async function deliver(recipients: readonly Recipient[], content: MailContent): Promise<Delivery> {
	const delivery: Delivery = { sent: [], failed: [], refused: null };

	for (const recipient of recipients) {
		const email = meetingInviteEmail({
			kind: content.kind,
			institutionName: content.institutionName,
			summary: content.summary,
			topic: content.topic,
			recipientName: recipient.greeting,
			start: content.start,
			durationMinutes: content.durationMinutes,
			location: content.location,
			agenda: content.agenda,
			sender: { name: content.organizer.name, email: content.organizer.email },
			isTest: content.isTest
		});
		const outcome = await sendOutboundMail({
			to: [{ name: recipient.name, email: recipient.email }],
			subject: email.subject,
			html: email.html,
			text: email.text,
			attachments: [],
			replyTo: content.organizer.email,
			calendar: content.calendar
		});

		if (outcome.status === 'sent') {
			delivery.sent.push(recipient);
		} else if (outcome.status === 'refused') {
			delivery.refused = outcome.error;
			break;
		} else {
			delivery.failed.push({ name: recipient.name, reason: outcome.error });
		}
	}

	return delivery;
}

function summaryOf(interaction: InteractionView): string {
	return `Встреча: ${interaction.title}`;
}

function institutionOf(interaction: InteractionView): string {
	return (
		interaction.parties.find((party) => party.isPrimary)?.organizationName ?? interaction.title
	);
}

function attendeesOf(recipients: readonly Recipient[]): MeetingAttendee[] {
	return recipients.map((recipient) => ({ name: recipient.name, email: recipient.email }));
}

export type MeetingInviteRequest = {
	interactionId: string;
	start: Date;
	durationMinutes: number;
	location: string | null;
	agenda: string;
	/** Роли контактов основной стороны. */
	contactIds: readonly string[];
	/** Сотрудники, которые видят дело. */
	userIds: readonly string[];
	/** Письмо только себе: встреча не сохраняется, в деле следа нет. */
	test: boolean;
};

/**
 * Назначить встречу (или перенести ту, что ещё впереди) и разослать
 * приглашение.
 *
 * Порядок осознанный: сначала всё, что проверяется без почтового сервера
 * (права, участники, политика почты), — отказ здесь ничего не сохраняет. Затем
 * письма, и только если ушло хоть одному — факт встречи со списком тех, кому
 * ушло. Так в деле не бывает встречи, о которой никто не узнал, а в чужом
 * календаре — события, которого нет в деле, дольше, чем идёт запись.
 */
export async function sendMeetingInvite(
	ctx: ActorContext,
	request: MeetingInviteRequest
): Promise<MeetingSendOutcome> {
	const auditType = request.test
		? 'interactions.meeting_invite_tested'
		: 'interactions.meeting_invited';

	await requirePermission(ctx, 'interactions.write', {
		type: auditType,
		subject: { type: 'interaction', id: request.interactionId }
	});

	if (ctx.user === null) {
		throw new ForbiddenError('Приглашение отправляет пользователь, а не фоновая задача');
	}

	const interaction = await getInteraction(ctx, request.interactionId);
	const organizer = await readOrganizer(interaction);
	const previous = await readMeeting(interaction.id);
	const now = new Date();
	const rescheduling = isUpcoming(previous, now);
	const kind: MeetingMailKind = rescheduling ? 'update' : 'invite';
	const policy = outboundMailPolicy();

	if (!policy.allowed) {
		return {
			status: 'refused',
			kind,
			test: request.test,
			error: policy.reason ?? 'Почтовый сервер не настроен',
			recorded: false
		};
	}

	const base = {
		kind,
		institutionName: institutionOf(interaction),
		summary: summaryOf(interaction),
		topic: interaction.title,
		start: request.start,
		durationMinutes: request.durationMinutes,
		location: request.location,
		agenda: request.agenda,
		organizer
	};

	if (request.test) {
		// Своё событие со своим `UID`: тестовое письмо не должно ни обновить
		// настоящую встречу в календаре, ни стать ею.
		const me: Recipient = {
			name: ctx.user.fullName,
			email: ctx.user.email,
			greeting: null,
			contactId: null,
			userId: ctx.user.id
		};
		const identity = nextMeetingIdentity(null, now);
		const delivery = await deliver([me], {
			...base,
			isTest: true,
			calendar: {
				method: 'REQUEST',
				content: buildMeetingInvite({
					...base,
					uid: identity.uid,
					sequence: identity.sequence,
					organizer: { name: organizer.name, email: organizer.email },
					attendeesWithEmail: attendeesOf([me]),
					attendeeNamesWithoutEmail: [],
					generatedAt: now
				})
			}
		});

		await recordAuditEvent(ctx, {
			type: auditType,
			outcome: delivery.sent.length > 0 ? 'success' : 'failure',
			subject: { type: 'interaction', id: interaction.id }
		});

		return delivery.sent.length > 0
			? { status: 'sent', kind, test: true, sentCount: 1, failed: [], skipped: [] }
			: {
					status: delivery.refused === null ? 'failed' : 'refused',
					kind,
					test: true,
					error: delivery.refused ?? delivery.failed[0]?.reason ?? 'Письмо не отправлено',
					recorded: false
				};
	}

	if (request.contactIds.length + request.userIds.length === 0) {
		throw new ValidationError('Отметьте хотя бы одного участника: контакт вуза или коллегу');
	}

	if (request.contactIds.length + request.userIds.length > MAX_MEETING_ATTENDEES) {
		throw new ValidationError(`За раз — не больше ${MAX_MEETING_ATTENDEES} участников`);
	}

	const contacts =
		request.contactIds.length === 0
			? []
			: await resolveCaseContacts(ctx, interaction, request.contactIds, auditType);
	const colleagues = await resolveColleagues(interaction.id, request.userIds, organizer.userId);
	const withEmail: Recipient[] = contacts.flatMap((addressee) =>
		addressee.email === null
			? []
			: [
					{
						name: contactPersonName(addressee.contact.person),
						email: addressee.email,
						greeting: contactGreetingName(addressee.contact.person),
						contactId: addressee.contact.id,
						userId: null
					}
				]
	);
	// Контакт без открытой почты письма не получит, но в событии останется
	// по имени — в описании, а не в `ATTENDEE`, которому нужен адрес.
	const skipped: MeetingMissedRecipient[] = contacts.flatMap((addressee) =>
		addressee.reason === null
			? []
			: [{ name: contactPersonName(addressee.contact.person), reason: addressee.reason }]
	);
	const attendees = uniqueByEmail([...withEmail, ...colleagues]);
	const identity = nextMeetingIdentity(previous, now);
	const calendar = {
		method: 'REQUEST' as const,
		content: buildMeetingInvite({
			...base,
			uid: identity.uid,
			sequence: identity.sequence,
			organizer: { name: organizer.name, email: organizer.email },
			attendeesWithEmail: attendeesOf(attendees),
			attendeeNamesWithoutEmail: skipped.map((item) => item.name),
			generatedAt: now
		})
	};
	const delivery = await deliver(uniqueByEmail([...attendees, organizerCopy(organizer)]), {
		...base,
		isTest: false,
		calendar
	});

	if (delivery.sent.length === 0) {
		await recordAuditEvent(ctx, {
			type: auditType,
			outcome: 'failure',
			subject: { type: 'interaction', id: interaction.id },
			details: { recipientCount: 0, mode: kind }
		});

		return {
			status: delivery.refused === null ? 'failed' : 'refused',
			kind,
			test: false,
			error:
				delivery.refused ??
				delivery.failed[0]?.reason ??
				'Почтовый сервер не принял ни одного письма',
			recorded: false
		};
	}

	const meeting: StoredMeeting = {
		start: request.start,
		durationMinutes: request.durationMinutes,
		location: request.location,
		uid: identity.uid,
		sequence: identity.sequence,
		cancelled: false,
		contactIds: delivery.sent.flatMap((item) => (item.contactId === null ? [] : [item.contactId])),
		userIds: delivery.sent.flatMap((item) => (item.userId === null ? [] : [item.userId]))
	};
	const sentText = rescheduling
		? `обновление встречи отправлено: ${recipientsText(delivery.sent.length)}`
		: `приглашение на встречу отправлено: ${recipientsText(delivery.sent.length)}`;

	await recordMeeting(ctx, interaction.id, meeting, {
		text: `${meetingText(meeting, rescheduling)}; ${sentText}`,
		auditType: 'interactions.meeting_invited',
		recipientCount: delivery.sent.length,
		mode: kind === 'update' ? 'update' : 'invite'
	});

	return {
		status: 'sent',
		kind,
		test: false,
		sentCount: delivery.sent.length,
		failed: delivery.failed,
		skipped
	};
}

/**
 * Отменить встречу, которая ещё впереди: `METHOD:CANCEL` тем, кому ушло
 * последнее приглашение, и отметка в деле.
 *
 * Отмена — решение по делу, а не письмо: она записывается и тогда, когда
 * почта установки закрыта или сервер не принял писем, — встречи больше нет, и
 * дело должно это знать. Кому не ушло, окно называет, чтобы предупредить
 * вручную.
 */
export async function cancelMeeting(
	ctx: ActorContext,
	interactionId: string
): Promise<MeetingSendOutcome> {
	const auditType = 'interactions.meeting_cancelled';

	await requirePermission(ctx, 'interactions.write', {
		type: auditType,
		subject: { type: 'interaction', id: interactionId }
	});

	const interaction = await getInteraction(ctx, interactionId);
	const stored = await readMeeting(interaction.id);
	const now = new Date();

	if (!isUpcoming(stored, now)) {
		throw new ValidationError('Отменить можно только назначенную встречу, которая ещё впереди');
	}

	const organizer = await readOrganizer(interaction);
	const cancelled: StoredMeeting = { ...stored, cancelled: true, sequence: stored.sequence + 1 };
	const when = `Встреча отменена: ${MOSCOW_WHEN.format(stored.start)} по Москве`;
	const policy = outboundMailPolicy();

	if (!policy.allowed) {
		await recordMeeting(ctx, interaction.id, cancelled, {
			text: `${when}; письма об отмене не отправлены`,
			auditType,
			recipientCount: 0
		});

		return {
			status: 'refused',
			kind: 'cancel',
			test: false,
			error: policy.reason ?? 'Почтовый сервер не настроен',
			recorded: true
		};
	}

	const skipped: MeetingMissedRecipient[] = [];
	const recipients: Recipient[] = [];

	if (stored.contactIds.length > 0) {
		// Список приглашённых — идентификаторы; имена и адреса читаются сейчас,
		// по праву того, кто отменяет. Контакт мог уйти от стороны, а право —
		// пропасть: тогда отмена ему не уходит, и окно об этом скажет.
		const readable = can(ctx, 'people.read') && can(ctx, 'people.read_pii');
		const contacts = readable ? ((await readCaseContacts(ctx, interaction)) ?? []) : [];
		const today = formatIsoDay();

		for (const id of stored.contactIds) {
			const contact = contacts.find((candidate) => candidate.id === id);

			if (!readable) {
				skipped.push({ name: 'Контакт стороны', reason: 'Нет права видеть контакты людей' });
			} else if (contact === undefined) {
				skipped.push({ name: 'Контакт стороны', reason: 'Больше не среди контактов стороны' });
			} else {
				const reason = contactUnavailableReason(contact, today);

				if (reason !== null || contact.person.email === null) {
					skipped.push({
						name: contactPersonName(contact.person),
						reason: reason ?? 'Почта не указана в карточке человека'
					});
				} else {
					recipients.push({
						name: contactPersonName(contact.person),
						email: contact.person.email,
						greeting: contactGreetingName(contact.person),
						contactId: contact.id,
						userId: null
					});
				}
			}
		}
	}

	if (stored.userIds.length > 0) {
		const rows = await getDb()
			.select({
				id: users.id,
				email: users.email,
				fullName: users.fullName,
				isActive: users.isActive
			})
			.from(users)
			.where(inArray(users.id, stored.userIds));

		for (const row of rows) {
			if (row.isActive) {
				recipients.push({
					name: row.fullName,
					email: row.email,
					greeting: null,
					contactId: null,
					userId: row.id
				});
			} else {
				skipped.push({ name: row.fullName, reason: 'Учётная запись выключена' });
			}
		}
	}

	const attendees = uniqueByEmail(recipients);
	const delivery = await deliver(uniqueByEmail([...attendees, organizerCopy(organizer)]), {
		kind: 'cancel',
		institutionName: institutionOf(interaction),
		summary: summaryOf(interaction),
		topic: interaction.title,
		start: stored.start,
		durationMinutes: stored.durationMinutes,
		location: stored.location,
		agenda: '',
		organizer,
		isTest: false,
		calendar: {
			method: 'CANCEL',
			content: buildMeetingInvite({
				method: 'CANCEL',
				uid: stored.uid,
				sequence: cancelled.sequence,
				summary: summaryOf(interaction),
				agenda: '',
				location: stored.location,
				start: stored.start,
				durationMinutes: stored.durationMinutes,
				organizer: { name: organizer.name, email: organizer.email },
				attendeesWithEmail: attendeesOf(attendees),
				attendeeNamesWithoutEmail: [],
				generatedAt: now
			})
		}
	});
	const sentText =
		delivery.sent.length === 0
			? 'письма об отмене не отправлены'
			: `отмена отправлена: ${recipientsText(delivery.sent.length)}`;

	await recordMeeting(ctx, interaction.id, cancelled, {
		text: `${when}; ${sentText}`,
		auditType,
		recipientCount: delivery.sent.length
	});

	if (delivery.sent.length === 0) {
		return {
			status: delivery.refused === null ? 'failed' : 'refused',
			kind: 'cancel',
			test: false,
			error:
				delivery.refused ??
				delivery.failed[0]?.reason ??
				'Почтовый сервер не принял ни одного письма',
			recorded: true
		};
	}

	return {
		status: 'sent',
		kind: 'cancel',
		test: false,
		sentCount: delivery.sent.length,
		failed: delivery.failed,
		skipped
	};
}
