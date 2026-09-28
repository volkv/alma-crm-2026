/**
 * Приглашение на встречу письмом из карточки дела.
 *
 * Держит один инвариант: письмо с событием календаря уходит только контакту
 * основной стороны этого дела, коллеге, который видит дело, и копией
 * ответственному; нажатие только ставит письма в очередь, а обработчик
 * очереди отправляет их и сохраняет встречу со списком приглашённых; перенос
 * обновляет то же событие, а отмена ложится в дело сразу и уходит тем же
 * людям. Почтовый сервер заменён приёмником в памяти: проверяется, что и кому
 * передано, а не SMTP.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { affiliations } from '$lib/server/db/schema';
import { ValidationError } from '$lib/server/errors';
import { runOutboundMailCycle } from '$lib/server/mail/queue';
import { readModuleFact } from '$lib/server/platform/module-facts';
import {
	cancelMeeting,
	readMeeting,
	sendMeetingInvite,
	type MeetingInviteRequest
} from '../../../src/modules/meetings/server/invite';
import {
	insertOrganization,
	insertPerson,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';
import {
	B2B_PROCESS,
	B2B_WORKSPACE_KEY,
	createInteractionOn,
	seedProcess
} from '../stages/fixture';

// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const { sendMail } = vi.hoisted(() => ({
	sendMail: vi.fn(async () => ({ messageId: '<meeting@lct-test.local>' }))
}));

vi.mock('$lib/server/mail/transport', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/mail/transport')>();

	return { ...actual, mailTransport: () => ({ sendMail }) };
});

type SentMail = {
	to: { address: string }[];
	subject: string;
	replyTo?: string;
	icalEvent?: { method: string; content: string };
};

function sentMails(): SentMail[] {
	return sendMail.mock.calls.map((call) => (call as unknown as [SentMail])[0]);
}

/** Развернуть строки события: длинные свойства ics переносятся по 75 октетам. */
function unfold(ics: string | undefined): string {
	return (ics ?? '').replace(/\r\n /g, '');
}

let database: TestDatabase;

beforeAll(async () => {
	// Петля — узел почтовой ловушки, поэтому песочница письмо пропускает.
	process.env.SMTP_URL = 'smtp://127.0.0.1:1025';
	process.env.SMTP_FROM = 'crm@lct-test.local';

	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	sendMail.mockClear();
});

async function insertContact(organizationId: string, email: string): Promise<string> {
	const personId = await insertPerson(database.db, { lastName: 'Иванова', email });
	const [row] = await database.db
		.insert(affiliations)
		.values({
			personId,
			organizationId,
			position: 'Проректор',
			roleKind: 'vice_rector',
			validFrom: '2026-01-01'
		})
		.returning({ id: affiliations.id });

	return row.id;
}

describe('приглашение на встречу', () => {
	it('уходит контакту, коллеге и ответственному; перенос — тем же событием, отмена — тем же людям', async () => {
		const ctx = testActor({ roleId: 'admin' });

		await seedProcess(database, B2B_WORKSPACE_KEY, B2B_PROCESS);

		const { interactionId, organizationId } = await createInteractionOn(ctx, database);
		const contactId = await insertContact(organizationId, 'prorector@vuz.example');
		const strangerId = await insertContact(
			await insertOrganization(database.db, { shortName: 'Чужой вуз' }),
			'stranger@other.example'
		);
		const colleagueId = await insertUser(database.db, {
			email: 'kollega@example.org',
			fullName: 'Петров Пётр',
			roleId: 'admin'
		});
		const request: MeetingInviteRequest = {
			interactionId,
			start: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			durationMinutes: 60,
			location: 'https://meet.example.org/room',
			agenda: 'Обсудить программы',
			contactIds: [contactId],
			userIds: [colleagueId],
			test: false
		};

		// Контакт другой организации — отказ всей отправки, письма не уходят.
		await expect(
			sendMeetingInvite(ctx, { ...request, contactIds: [strangerId] })
		).rejects.toBeInstanceOf(ValidationError);
		expect(sendMail).not.toHaveBeenCalled();
		expect(await readMeeting(interactionId)).toBeNull();

		const invited = await sendMeetingInvite(ctx, request);

		// Ответ — сразу и без почты; встреча ляжет в дело, когда письма уйдут.
		expect(invited).toStrictEqual({
			status: 'queued',
			kind: 'invite',
			test: false,
			recorded: false
		});
		expect(sendMail).not.toHaveBeenCalled();
		expect(await readMeeting(interactionId)).toBeNull();

		await expect(runOutboundMailCycle()).resolves.toMatchObject({ processed: 1 });
		expect(sentMails().flatMap((mail) => mail.to.map((to) => to.address))).toStrictEqual([
			'prorector@vuz.example',
			'kollega@example.org',
			'admin@example.org'
		]);

		const [first] = sentMails();

		expect(first.replyTo).toBe('admin@example.org');
		expect(first.icalEvent?.method).toBe('REQUEST');
		expect(unfold(first.icalEvent?.content)).toContain('mailto:prorector@vuz.example');
		expect(unfold(first.icalEvent?.content)).toContain('mailto:kollega@example.org');
		expect(unfold(first.icalEvent?.content)).toContain('SEQUENCE:0');

		const saved = await readMeeting(interactionId);

		expect(saved).toMatchObject({
			cancelled: false,
			sequence: 0,
			contactIds: [contactId],
			userIds: [colleagueId]
		});
		// В факте — идентификаторы, а не адреса.
		const fact = await readModuleFact(database.db, interactionId, 'meetings', 'scheduled');

		expect(JSON.stringify(fact)).not.toContain('prorector@vuz.example');
		expect(fact?.text).toMatch(/приглашение на встречу отправлено: 3 получателя$/);

		sendMail.mockClear();

		const moved = await sendMeetingInvite(ctx, {
			...request,
			start: new Date(request.start.getTime() + 60 * 60 * 1000)
		});

		expect(moved).toMatchObject({ status: 'queued', kind: 'update' });
		await runOutboundMailCycle();
		expect(sentMails()).toHaveLength(3);
		expect(unfold(sentMails()[0].icalEvent?.content)).toContain('SEQUENCE:1');
		expect((await readMeeting(interactionId))?.uid).toBe(saved?.uid);

		sendMail.mockClear();

		expect(await cancelMeeting(ctx, interactionId)).toMatchObject({
			status: 'queued',
			kind: 'cancel',
			recorded: true
		});
		// Отмена — решение по делу: оно в деле сразу, письма догоняют.
		expect((await readMeeting(interactionId))?.cancelled).toBe(true);
		expect(sendMail).not.toHaveBeenCalled();

		await runOutboundMailCycle();
		expect(sentMails()).toHaveLength(3);

		const cancel = unfold(sentMails()[0].icalEvent?.content);

		expect(sentMails()[0].icalEvent?.method).toBe('CANCEL');
		expect(cancel).toContain('STATUS:CANCELLED');
		expect(cancel).toContain('SEQUENCE:2');
		expect(cancel).toContain(`UID:${saved?.uid}`);
		expect(await readMeeting(interactionId)).toMatchObject({ cancelled: true, sequence: 2 });
		// Отменённую встречу второй раз не отменить.
		await expect(cancelMeeting(ctx, interactionId)).rejects.toBeInstanceOf(ValidationError);
	}, 60_000);
});
