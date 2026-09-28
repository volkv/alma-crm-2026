/**
 * Серверная часть «Встреч» в карточке: назначенная встреча как факт дела,
 * контакты стороны для диалога приглашения и сам файл приглашения (.ics).
 *
 * Права на запись и на персональные данные участников проверяются здесь же, по
 * действующему праву в момент скачивания; что модуль действует в пространстве
 * дела, проверяет реестр до вызова.
 */
import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { defineCardServer } from '$lib/platform/card.server';
import {
	actorFromEvent,
	can,
	contentDisposition,
	getDb,
	getInteraction,
	listAffiliations,
	readModuleFact,
	recordAuditEvent,
	recordModuleFact,
	requirePermission,
	run,
	text,
	toPageError,
	users
} from '$lib/platform/core.server';
import type { MeetingsCardData, SavedMeeting } from './data';
import meetings from './index';
import { buildMeetingInvite, nextMeetingIdentity } from './server/ics';

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

const MOSCOW_WHEN = new Intl.DateTimeFormat('ru-RU', {
	timeZone: 'Europe/Moscow',
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit'
});

/** Момент встречи как значение поля `datetime-local` по Москве. */
function moscowInput(start: Date): string {
	return new Date(start.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/** Факт «встреча назначена», как его сохранил `meetingSchedule`. */
type StoredMeeting = {
	start: Date;
	durationMinutes: number;
	location: string | null;
	uid: string;
	sequence: number;
};

/** Последняя назначенная встреча дела; `null` — встреч ещё не назначали. */
async function readMeeting(interactionId: string): Promise<StoredMeeting | null> {
	const fact = await readModuleFact(getDb(), interactionId, meetings.key, 'scheduled');

	if (fact === null) {
		return null;
	}

	const { start, durationMinutes, location, uid, sequence } = fact.data;

	if (
		typeof start !== 'string' ||
		typeof durationMinutes !== 'number' ||
		(location !== null && typeof location !== 'string') ||
		typeof uid !== 'string' ||
		typeof sequence !== 'number'
	) {
		throw new Error(`Встреча дела ${interactionId} сохранена без своих данных`);
	}

	return { start: new Date(start), durationMinutes, location, uid, sequence };
}

/** Встреча одной фразой для ленты и пункта чек-листа. */
function meetingText(start: Date, durationMinutes: number, location: string | null): string {
	return [
		`Назначена встреча: ${MOSCOW_WHEN.format(start)} по Москве, ${durationMinutes} мин`,
		...(location === null ? [] : [`место: ${location}`])
	].join(', ');
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

function contactName(person: {
	lastName: string;
	firstName: string;
	middleName: string | null;
}): string {
	return [person.lastName, person.firstName, person.middleName].filter(Boolean).join(' ');
}

export default defineCardServer(meetings, {
	actions: {
		/**
		 * Назначенная встреча — факт дела: дата, длительность и место ложатся в
		 * историю и видны в ленте и у пункта «Встреча назначена». Файл
		 * приглашения диалог скачивает следом, отдельной ссылкой.
		 */
		meetingSchedule: async (event) => {
			const ctx = actorFromEvent(event);
			const data = await event.request.formData();
			const start = parseStart(text(data, 'start'));
			const durationMinutes = parseDuration(text(data, 'duration'));
			const location = text(data, 'location')?.slice(0, MAX_LOCATION_LENGTH) ?? null;
			const issues = [
				...(start === null ? ['Укажите дату и время встречи'] : []),
				...(durationMinutes === null
					? [`Длительность — от ${MIN_DURATION_MINUTES} минут до суток`]
					: [])
			];

			if (start === null || durationMinutes === null) {
				return fail(400, { message: 'Встреча не сохранена', issues });
			}

			return run(async () => {
				// Встреча ещё впереди — это перенос той же встречи: календарь
				// участников обновит событие по тому же `UID` и большему `SEQUENCE`.
				const identity = nextMeetingIdentity(await readMeeting(event.params.id), new Date());

				await recordModuleFact(ctx, {
					interactionId: event.params.id,
					module: meetings.key,
					fact: 'scheduled',
					text: meetingText(start, durationMinutes, location),
					data: {
						start: start.toISOString(),
						durationMinutes,
						location,
						uid: identity.uid,
						sequence: identity.sequence
					},
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
		 * дела (`meetingSchedule`): файл описывает то, что записано в деле, и
		 * перенос приходит участникам обновлением того же события. Повестка и
		 * выбранные участники приходят строкой запроса от диалога. Имена и почту участников
		 * сервер не принимает от вызывающего — только идентификаторы контактов;
		 * само имя и то, можно ли показать почту, читаются заново отсюда, по
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

						const name = contactName(contact.person);

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
	 * Контакты основной стороны для диалога приглашения (участники с почтой,
	 * галочками): та же область доступа, что у справочника людей, а не у
	 * карточки взаимодействия саму по себе. Без права список пуст, и диалог
	 * говорит почему, а не молчит. Контактное лицо дела отмечено по умолчанию,
	 * а назначенная встреча подставляется в поля при следующем открытии.
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
						upcoming: stored.start.getTime() > Date.now()
					};
		const defaultContactId = primary?.contactAffiliationId ?? null;

		if (primary === undefined) {
			return { contacts: [], contactsDenied: false, defaultContactId, meeting };
		}

		if (!can(ctx, 'people.read')) {
			return { contacts: [], contactsDenied: true, defaultContactId, meeting };
		}

		return {
			contacts: await listAffiliations(ctx, primary.organizationId),
			contactsDenied: false,
			defaultContactId,
			meeting
		};
	}
});
