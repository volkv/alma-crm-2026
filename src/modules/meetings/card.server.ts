/**
 * Серверная часть «Встреч» в карточке: назначение встречи с приглашением
 * участникам письмом, перенос и отмена (`server/invite.ts`), назначение без
 * писем и сам файл приглашения (.ics) для скачивания, контакты стороны и
 * коллеги для диалога.
 *
 * Права на запись и на персональные данные участников проверяются по
 * действующему праву в момент действия; что модуль действует в пространстве
 * дела, проверяет реестр до вызова.
 */
import { error, fail } from '@sveltejs/kit';
import { formatIsoDay } from '$lib/format';
import { defineCardServer } from '$lib/platform/card.server';
import {
	actorFromEvent,
	can,
	contactPersonName,
	contactUnavailableReason,
	contentDisposition,
	getDb,
	getInteraction,
	listAffiliations,
	listInteractionViewers,
	outboundMailPolicy,
	readCaseContacts,
	recordAuditEvent,
	requirePermission,
	run,
	text,
	toActionFailure,
	toPageError,
	users
} from '$lib/platform/core.server';
import { eq } from 'drizzle-orm';
import type { MeetingContactView, MeetingsCardData, SavedMeeting } from './data';
import meetings from './index';
import { buildMeetingInvite, nextMeetingIdentity } from './server/ics';
import {
	cancelMeeting,
	isUpcoming,
	meetingCancelMail,
	meetingInviteMail,
	meetingText,
	readMeeting,
	recordMeeting,
	sendMeetingInvite
} from './server/invite';

const START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 24 * 60;
const MAX_LOCATION_LENGTH = 300;
const MAX_AGENDA_LENGTH = 4000;

/** Пояс встречи: Москва, круглый год без перехода на летнее время с 2014 года. */
const MOSCOW_OFFSET = '+03:00';

/** Начало встречи по Москве; `null` — дата и время указаны неверно. */
function parseStart(raw: string | null): Date | null {
	if (raw === null || !START_PATTERN.test(raw)) {
		return null;
	}

	const start = new Date(`${raw}:00${MOSCOW_OFFSET}`);

	return Number.isNaN(start.getTime()) ? null : start;
}

/** Длительность в минутах; `null` — вне допустимого. */
function parseDuration(raw: string | null): number | null {
	const minutes = raw === null ? NaN : Number(raw);

	return Number.isInteger(minutes) &&
		minutes >= MIN_DURATION_MINUTES &&
		minutes <= MAX_DURATION_MINUTES
		? minutes
		: null;
}

/** Момент встречи как значение поля `datetime-local` по Москве. */
function moscowInput(start: Date): string {
	return new Date(start.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/** Дата, длительность и место из формы; отказ — с перечнем того, что не так. */
function readMeetingFields(data: FormData) {
	const start = parseStart(text(data, 'start'));
	const durationMinutes = parseDuration(text(data, 'duration'));
	const location = text(data, 'location')?.slice(0, MAX_LOCATION_LENGTH) ?? null;
	const issues = [
		...(start === null ? ['Укажите дату и время встречи'] : []),
		...(durationMinutes === null
			? [`Длительность — от ${MIN_DURATION_MINUTES} минут до суток`]
			: [])
	];

	return start === null || durationMinutes === null
		? ({ ok: false, issues } as const)
		: ({ ok: true, start, durationMinutes, location } as const);
}

/** Идентификаторы из повторяющегося поля; чужой вид — отказ, а не пропуск. */
function idsOf(values: FormDataEntryValue[]): string[] | null {
	const ids = values.filter((value): value is string => typeof value === 'string');

	return ids.length === values.length && ids.every((id) => UUID_PATTERN.test(id)) ? ids : null;
}

function readAttendeeIds(url: URL): string[] {
	const ids = url.searchParams.getAll('attendee');

	if (ids.some((id) => !UUID_PATTERN.test(id))) {
		error(400, 'Некорректный идентификатор участника встречи');
	}

	return ids;
}

/** Почта ответственного — организатор встречи. У системных учётных записей она есть всегда. */
async function findOwnerEmail(userId: string): Promise<string | null> {
	const [row] = await getDb()
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	return row?.email ?? null;
}

/** Действие, чей результат — исход отправки: предметные отказы — ответом 4xx формы. */
async function outcomeOf(action: () => Promise<Record<string, unknown>>) {
	try {
		return await action();
	} catch (cause) {
		return toActionFailure(cause);
	}
}

export default defineCardServer(meetings, {
	/**
	 * Письма «Встреч» в общей очереди ядра: приглашение (и перенос) и отмена.
	 * Действия ниже их только ставят, а уходят они в фоне.
	 */
	mail: {
		invite: meetingInviteMail,
		cancel: meetingCancelMail
	},

	actions: {
		/**
		 * Назначить встречу и разослать приглашение письмом — основной путь
		 * диалога. Встреча, которая ещё впереди, так переносится: участникам
		 * уходит обновление того же события. С `test` письмо уходит только тому,
		 * кто нажал, и встреча не сохраняется. Ответ приходит сразу: письма
		 * встают в очередь, а встреча ложится в дело, когда они ушли.
		 */
		meetingInvite: async (event) => {
			const ctx = actorFromEvent(event);
			const data = await event.request.formData();
			const fields = readMeetingFields(data);
			const contactIds = idsOf(data.getAll('contact'));
			const userIds = idsOf(data.getAll('colleague'));

			if (!fields.ok) {
				return fail(400, { message: 'Приглашение не отправлено', issues: fields.issues });
			}

			if (contactIds === null || userIds === null) {
				return fail(400, { message: 'Некорректный идентификатор участника встречи', issues: [] });
			}

			return outcomeOf(() =>
				sendMeetingInvite(ctx, {
					interactionId: event.params.id,
					start: fields.start,
					durationMinutes: fields.durationMinutes,
					location: fields.location,
					agenda: (text(data, 'agenda') ?? '').slice(0, MAX_AGENDA_LENGTH),
					contactIds,
					userIds,
					test: data.get('test') === '1'
				})
			);
		},

		/**
		 * Отменить встречу, которая ещё впереди: отметка в деле сразу, отмена в
		 * календари приглашённых — письмами в фоне.
		 */
		meetingCancel: async (event) =>
			outcomeOf(() => cancelMeeting(actorFromEvent(event), event.params.id)),

		/**
		 * Назначить встречу без писем — для скачивания файла приглашения
		 * (`meeting.ics`), когда почта установки закрыта или приглашение
		 * рассылают сами. Дата, длительность и место ложатся в историю и видны в
		 * ленте и у пункта «Встреча назначена». Кого приглашали письмом раньше,
		 * остаётся в факте, пока это то же событие: отмена дойдёт и до них.
		 */
		meetingSchedule: async (event) => {
			const ctx = actorFromEvent(event);
			const fields = readMeetingFields(await event.request.formData());

			if (!fields.ok) {
				return fail(400, { message: 'Встреча не сохранена', issues: fields.issues });
			}

			return run(async () => {
				// Встреча ещё впереди — это перенос той же встречи: календарь
				// участников обновит событие по тому же `UID` и большему `SEQUENCE`.
				const previous = await readMeeting(event.params.id);
				const identity = nextMeetingIdentity(previous, new Date());
				const sameEvent = previous !== null && previous.uid === identity.uid ? previous : null;
				const meeting = {
					start: fields.start,
					durationMinutes: fields.durationMinutes,
					location: fields.location,
					uid: identity.uid,
					sequence: identity.sequence,
					cancelled: false,
					contactIds: sameEvent?.contactIds ?? [],
					userIds: sameEvent?.userIds ?? []
				};

				await recordMeeting(ctx, event.params.id, meeting, {
					text: meetingText(meeting, sameEvent !== null),
					auditType: 'interactions.meeting_invited'
				});
			});
		}
	},

	files: {
		/**
		 * Приглашение на встречу файлом календаря (.ics).
		 *
		 * Ссылка из диалога карточки: сюда приходят с сессионной кукой, а отказ
		 * рисуется страницей ошибки, как и у скачивания документа.
		 *
		 * Дата, длительность, место и идентификатор события — сохранённой встречи
		 * дела: файл описывает то, что записано в деле, и перенос приходит
		 * участникам обновлением того же события. Повестка и выбранные участники
		 * приходят строкой запроса от диалога. Имена и почту участников сервер
		 * не принимает от вызывающего — только идентификаторы контактов; само
		 * имя и то, можно ли показать почту, читаются заново отсюда, по
		 * действующему праву на персональные данные, а не по тому, что было на
		 * экране в момент открытия диалога.
		 */
		'meeting.ics': async (event) => {
			const ctx = actorFromEvent(event);
			const { url, params } = event;

			const agenda = (url.searchParams.get('agenda') ?? '').trim().slice(0, MAX_AGENDA_LENGTH);
			const attendeeIds = readAttendeeIds(url);

			try {
				// То же право, что у комментария и правки записи: приглашение — не
				// просмотр карточки, а действие по ней, и у роли «только смотреть» его
				// быть не должно.
				await requirePermission(ctx, 'interactions.write', {
					type: 'interactions.meeting_invited',
					subject: { type: 'interaction', id: params.id }
				});

				const interaction = await getInteraction(ctx, params.id);
				const meeting = await readMeeting(interaction.id);

				if (meeting === null) {
					error(400, 'Встреча по делу ещё не назначена: сначала назначьте её в диалоге');
				}

				if (meeting.cancelled) {
					error(400, 'Встреча отменена: назначьте новую, чтобы скачать приглашение');
				}

				// Организатор приглашения — ответственный: без него звать некому от имени дела.
				if (interaction.ownerUserId === null) {
					error(
						400,
						'У дела не назначен ответственный: назначьте его, чтобы разослать приглашение'
					);
				}

				const organizerEmail = await findOwnerEmail(interaction.ownerUserId);

				if (organizerEmail === null) {
					// Данные интерфейса: у ответственного из справочника пользователей нет
					// почты, хотя запись до него дошла. Условие процесса это нарушает, а не
					// ввод человека, — поэтому это не отказ 400, а сбой, который стоит
					// увидеть в логе.
					throw new Error(`У ответственного ${interaction.ownerUserId} нет почты для приглашения`);
				}

				const attendeesWithEmail: { name: string; email: string }[] = [];
				const attendeeNamesWithoutEmail: string[] = [];

				if (attendeeIds.length > 0) {
					const primary = interaction.parties.find((party) => party.isPrimary);

					if (primary === undefined) {
						error(400, 'У записи нет основной стороны — участников выбрать не из кого');
					}

					await requirePermission(ctx, 'people.read', {
						type: 'interactions.meeting_invited',
						subject: { type: 'interaction', id: interaction.id }
					});

					const contacts = await listAffiliations(ctx, primary.organizationId);
					const byId = new Map(contacts.map((contact) => [contact.id, contact]));

					for (const id of attendeeIds) {
						const contact = byId.get(id);

						if (contact === undefined) {
							error(400, 'Участник встречи не найден среди контактов основной стороны');
						}

						const name = contactPersonName(contact.person);

						if (contact.person.contactsMasked || contact.person.email === null) {
							attendeeNamesWithoutEmail.push(name);
						} else {
							attendeesWithEmail.push({ name, email: contact.person.email });
						}
					}
				}

				const generatedAt = new Date();

				const ics = buildMeetingInvite({
					uid: meeting.uid,
					sequence: meeting.sequence,
					summary: `Встреча: ${interaction.title}`,
					agenda,
					location: meeting.location,
					start: meeting.start,
					durationMinutes: meeting.durationMinutes,
					organizer: { name: interaction.ownerName ?? '', email: organizerEmail },
					attendeesWithEmail,
					attendeeNamesWithoutEmail,
					generatedAt
				});

				await recordAuditEvent(ctx, {
					type: 'interactions.meeting_invited',
					outcome: 'success',
					subject: { type: 'interaction', id: interaction.id },
					details: {
						attendeeCount: attendeesWithEmail.length + attendeeNamesWithoutEmail.length
					}
				});

				return new Response(ics, {
					headers: {
						'Content-Type': 'text/calendar; charset=utf-8; method=REQUEST',
						'Content-Disposition': contentDisposition(`Встреча — ${interaction.title}.ics`),
						// Приглашение несёт адреса участников: ни браузеру, ни кэшу его не
						// хранить, как и у скачивания документа.
						'Cache-Control': 'no-store',
						'X-Content-Type-Options': 'nosniff'
					}
				});
			} catch (failure) {
				toPageError(failure);
			}
		}
	},

	/**
	 * Данные диалога приглашения. Контакты основной стороны — та же область
	 * доступа, что у справочника людей, и видны именем и должностью, без почты:
	 * адрес подставит сервер при отправке. Без права список пуст, и диалог
	 * говорит почему, а не молчит. Коллеги — сотрудники, которые видят дело,
	 * как у упоминаний; ответственного среди них нет, он участвует всегда.
	 * Назначенная встреча подставляется в поля при следующем открытии.
	 */
	load: async ({ ctx, interaction }): Promise<MeetingsCardData> => {
		const primary = interaction.parties.find((party) => party.isPrimary);
		const stored = await readMeeting(interaction.id);
		const meeting: SavedMeeting | null =
			stored === null
				? null
				: {
						start: moscowInput(stored.start),
						durationMinutes: stored.durationMinutes,
						location: stored.location,
						upcoming: isUpcoming(stored, new Date()),
						cancelled: stored.cancelled,
						invitedCount: stored.contactIds.length + stored.userIds.length
					};
		const defaultContactId = primary?.contactAffiliationId ?? null;
		const policy = outboundMailPolicy();
		const colleagues = (await listInteractionViewers(interaction.id))
			.filter((viewer) => viewer.userId !== interaction.ownerUserId)
			.map((viewer) => ({ userId: viewer.userId, name: viewer.fullName }));
		const common = {
			defaultContactId,
			colleagues,
			policy: { allowed: policy.allowed, sandboxed: policy.sandboxed, reason: policy.reason },
			meeting
		};

		if (primary === undefined) {
			return { ...common, contacts: [], contactsDenied: false };
		}

		if (!can(ctx, 'people.read')) {
			return { ...common, contacts: [], contactsDenied: true };
		}

		const today = formatIsoDay();
		const contacts: MeetingContactView[] = ((await readCaseContacts(ctx, interaction)) ?? [])
			.map((contact) => ({
				id: contact.id,
				name: contactPersonName(contact.person),
				position: contact.position,
				isCaseContact: contact.id === defaultContactId,
				unavailableReason: contactUnavailableReason(contact, today)
			}))
			// Контактное лицо дела — первым: оно же отмечено по умолчанию.
			.sort((left, right) => Number(right.isCaseContact) - Number(left.isCaseContact));

		return { ...common, contacts, contactsDenied: false };
	}
});
