/**
 * Серверная часть «Встреч» в карточке: контакты стороны для диалога
 * приглашения и сам файл приглашения (.ics).
 *
 * Права на запись и на персональные данные участников проверяются здесь же, по
 * действующему праву в момент скачивания; что модуль действует в пространстве
 * дела, проверяет реестр до вызова.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { defineCardServer } from '$lib/platform/card.server';
import {
	actorFromEvent,
	can,
	contentDisposition,
	getDb,
	getInteraction,
	listAffiliations,
	recordAuditEvent,
	requirePermission,
	toPageError,
	users
} from '$lib/platform/core.server';
import type { MeetingsCardData } from './data';
import meetings from './index';
import { buildMeetingInvite, meetingInviteUid } from './server/ics';

const START_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 24 * 60;
const MAX_LOCATION_LENGTH = 300;
const MAX_AGENDA_LENGTH = 4000;

/** Пояс встречи: Москва, круглый год без перехода на летнее время с 2014 года. */
const MOSCOW_OFFSET = '+03:00';

function readStart(raw: string | null): Date {
	if (raw === null || !START_PATTERN.test(raw)) {
		error(400, 'Дата и время встречи указаны неверно');
	}

	const start = new Date(`${raw}:00${MOSCOW_OFFSET}`);

	if (Number.isNaN(start.getTime())) {
		error(400, 'Дата и время встречи указаны неверно');
	}

	return start;
}

function readDuration(raw: string | null): number {
	const minutes = raw === null ? NaN : Number(raw);

	if (
		!Number.isInteger(minutes) ||
		minutes < MIN_DURATION_MINUTES ||
		minutes > MAX_DURATION_MINUTES
	) {
		error(400, 'Длительность встречи указана неверно');
	}

	return minutes;
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
	actions: {},

	files: {
		/**
		 * Приглашение на встречу файлом календаря (.ics).
		 *
		 * Ссылка из диалога карточки: сюда приходят с сессионной кукой, а отказ
		 * рисуется страницей ошибки, как и у скачивания документа.
		 *
		 * Параметры — дата, длительность, место, повестка и выбранные участники —
		 * приходят строкой запроса от диалога, а не спрятаны в теле: файл можно
		 * переслать ссылкой повторно с теми же условиями. Имена и почту участников
		 * сервер не принимает от вызывающего — только идентификаторы контактов;
		 * само имя и то, можно ли показать почту, читаются заново отсюда, по
		 * действующему праву на персональные данные, а не по тому, что было на
		 * экране в момент открытия диалога.
		 */
		'meeting.ics': async (event) => {
			const ctx = actorFromEvent(event);
			const { url, params } = event;

			const start = readStart(url.searchParams.get('start'));
			const durationMinutes = readDuration(url.searchParams.get('duration'));
			const rawLocation = url.searchParams.get('location')?.trim() ?? '';
			const location = rawLocation === '' ? null : rawLocation.slice(0, MAX_LOCATION_LENGTH);
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

				const uid = meetingInviteUid(interaction.id, start, durationMinutes);
				const generatedAt = new Date();

				const ics = buildMeetingInvite({
					uid,
					summary: `Встреча: ${interaction.title}`,
					agenda,
					location,
					start,
					durationMinutes,
					organizer: { name: interaction.ownerName, email: organizerEmail },
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
	 * говорит почему, а не молчит.
	 */
	load: async ({ ctx, interaction }): Promise<MeetingsCardData> => {
		const primary = interaction.parties.find((party) => party.isPrimary);

		if (primary === undefined) {
			return { contacts: [], contactsDenied: false };
		}

		if (!can(ctx, 'people.read')) {
			return { contacts: [], contactsDenied: true };
		}

		return { contacts: await listAffiliations(ctx, primary.organizationId), contactsDenied: false };
	}
});
