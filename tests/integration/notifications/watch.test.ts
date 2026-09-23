// См. комментарий в `helpers/db.ts`: без этого сервисы пойдут в базу разработчика.
import { vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemActor } from '$lib/server/actor';
import {
	auditEvents,
	interactionParties,
	interactions,
	notificationDeliveries,
	stageEntries,
	stagePauses,
	users
} from '$lib/server/db/schema';
import { ForbiddenError } from '$lib/server/errors';
import { listNotificationDeliveries, retryNotificationDelivery } from '$lib/server/notifications';
import { closeMailTransport } from '$lib/server/notifications/channels/email';
import { runNotificationCycle } from '$lib/server/notifications/watch';
import { setSetting } from '$lib/server/settings';
import { getRedis } from '$lib/server/redis';
import {
	allWorkspaceIds,
	daysFrom,
	failureCode,
	insertInteractionWithStage,
	insertOrganization,
	insertUser,
	startTestDatabase,
	testActor,
	type TestDatabase
} from '../helpers/db';

/**
 * Наблюдатель зависших взаимодействий — целиком, до настоящего почтового
 * сервера.
 *
 * Приёмник SMTP поднимается прямо здесь, обычным `net.createServer`, и говорит
 * на протоколе: подделка, которая «как будто приняла письмо», не проверила бы
 * ни того, что мы вообще куда-то ходим, ни того, что уехало в теме и в теле.
 * Ловить письма контейнером Mailpit тут незачем: контейнер проверял бы Mailpit,
 * а не нас, — он стоит в прогоне e2e, где важно, что приложение идёт по сети до
 * чужого процесса.
 */
let database: TestDatabase;
let smtp: SmtpReceiver;

type SmtpMessage = { from: string; to: string[]; raw: string };

type SmtpReceiver = {
	url: string;
	messages: SmtpMessage[];
	/** Сервер отвечает отказом на конверт: так проверяется неудачная доставка. */
	setFailing: (failing: boolean) => void;
	stop: () => Promise<void>;
};

/** Адрес из команды конверта: `MAIL FROM:<a@b>` → `a@b`. */
function envelopeAddress(line: string): string {
	return /<([^>]*)>/.exec(line)?.[1] ?? '';
}

/**
 * Приёмник SMTP: ровно столько протокола, сколько нужно клиенту, чтобы дойти
 * до `DATA` и получить подтверждение. Расширений в ответ на `EHLO` не
 * объявляем — и клиент кодирует письмо так, чтобы оно проехало по 7 битам.
 */
async function startSmtpReceiver(): Promise<SmtpReceiver> {
	const messages: SmtpMessage[] = [];
	let failing = false;

	const handle = (socket: Socket): void => {
		let buffer = '';
		let inData = false;
		let current: SmtpMessage = { from: '', to: [], raw: '' };

		socket.setEncoding('utf8');
		socket.write('220 lct-test ESMTP\r\n');

		socket.on('data', (chunk: string) => {
			buffer += chunk;

			for (;;) {
				if (inData) {
					const end = buffer.indexOf('\r\n.\r\n');

					if (end === -1) {
						return;
					}

					current.raw = buffer.slice(0, end);
					buffer = buffer.slice(end + 5);
					inData = false;
					messages.push(current);
					current = { from: '', to: [], raw: '' };
					socket.write('250 2.0.0 Ok: queued\r\n');
					continue;
				}

				const eol = buffer.indexOf('\r\n');

				if (eol === -1) {
					return;
				}

				const line = buffer.slice(0, eol);
				buffer = buffer.slice(eol + 2);
				const command = line.toUpperCase();

				if (command.startsWith('EHLO') || command.startsWith('HELO')) {
					socket.write('250 lct-test\r\n');
				} else if (command.startsWith('MAIL FROM')) {
					if (failing) {
						socket.write('451 4.3.0 Приёмник прогона отвергает конверт\r\n');
					} else {
						current.from = envelopeAddress(line);
						socket.write('250 2.1.0 Ok\r\n');
					}
				} else if (command.startsWith('RCPT TO')) {
					current.to.push(envelopeAddress(line));
					socket.write('250 2.1.5 Ok\r\n');
				} else if (command === 'DATA') {
					inData = true;
					socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
				} else if (command === 'QUIT') {
					socket.write('221 2.0.0 Bye\r\n');
					socket.end();
					return;
				} else if (command === 'RSET') {
					current = { from: '', to: [], raw: '' };
					socket.write('250 2.0.0 Ok\r\n');
				} else {
					socket.write('502 5.5.2 Не поддерживается\r\n');
				}
			}
		});

		// Оборванное соединение — не повод ронять прогон: клиент вправе уйти как
		// угодно, а проверяется то, что он успел прислать.
		socket.on('error', () => socket.destroy());
	};

	const server: Server = createServer(handle);

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

	const { port } = server.address() as AddressInfo;

	return {
		url: `smtp://127.0.0.1:${port}`,
		messages,
		setFailing: (value: boolean) => {
			failing = value;
		},
		stop: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			)
	};
}

/** Значение заголовка из шапки письма, со склеенными переносами. */
function headerValue(head: string, name: string): string {
	const unfolded = head.replaceAll('\r\n ', ' ').replaceAll('\r\n\t', ' ');
	const found = unfolded
		.split('\r\n')
		.find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));

	return found === undefined ? '' : found.slice(found.indexOf(':') + 1).trim();
}

/**
 * Закодированные слова заголовка (`=?UTF-8?B?…?=`) обратно в текст.
 *
 * Пробел между двумя соседними закодированными словами по RFC 2047 не значит
 * ничего и при разборе выбрасывается: длинную тему отправитель режет на части,
 * и без этого шага в середине слова появился бы пробел.
 */
function decodeWords(value: string): string {
	return value
		.replaceAll(/\?=\s+=\?/g, '?==?')
		.replaceAll(/=\?[Uu][Tt][Ff]-8\?([BbQq])\?([^?]*)\?=/g, (_match, kind, payload) => {
			if (String(kind).toUpperCase() === 'B') {
				return Buffer.from(String(payload), 'base64').toString('utf8');
			}

			return decodeQuotedPrintable(String(payload).replaceAll('_', ' '));
		});
}

function decodeQuotedPrintable(value: string): string {
	const withoutSoftBreaks = value.replaceAll('=\r\n', '').replaceAll('=\n', '');
	const bytes: number[] = [];

	for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
		const char = withoutSoftBreaks[index];

		if (char === '=' && index + 2 < withoutSoftBreaks.length) {
			bytes.push(Number.parseInt(withoutSoftBreaks.slice(index + 1, index + 3), 16));
			index += 2;
			continue;
		}

		bytes.push(char.charCodeAt(0));
	}

	return Buffer.from(bytes).toString('utf8');
}

/** Письмо в человеческом виде: тему и тело разбирает получатель, как настоящий. */
function readMessage(message: SmtpMessage): { subject: string; text: string } {
	const separator = message.raw.indexOf('\r\n\r\n');
	const head = message.raw.slice(0, separator);
	const body = message.raw.slice(separator + 4);
	const encoding = headerValue(head, 'content-transfer-encoding').toLowerCase();

	const text =
		encoding === 'base64'
			? Buffer.from(body.replaceAll('\r\n', ''), 'base64').toString('utf8')
			: encoding === 'quoted-printable'
				? decodeQuotedPrintable(body)
				: body;

	return { subject: decodeWords(headerValue(head, 'subject')), text };
}

type Scene = {
	interactionId: string;
	stageEntryId: string;
	ownerId: string;
	managerId: string | null;
	managerEmail: string | null;
};

/** Взаимодействие, открытая запись стадии и вертикаль над её владельцем. */
async function makeScene(options: {
	enteredDaysAgo: number;
	withManager?: boolean;
	paused?: boolean;
	title?: string;
	organizationName?: string;
}): Promise<Scene> {
	const db = database.db;
	const suffix = randomUUID().slice(0, 8);

	const managerEmail = `lead-${suffix}@example.org`;
	const managerId =
		options.withManager === false
			? null
			: await insertUser(db, { roleId: 'lead', email: managerEmail });

	const ownerId = await insertUser(db, {
		roleId: 'manager',
		email: `owner-${suffix}@example.org`
	});

	if (managerId !== null) {
		await db.update(users).set({ managerUserId: managerId }).where(eq(users.id, ownerId));
	}

	const { interactionId, stageId, snapshot } = await insertInteractionWithStage(db, {
		ownerUserId: ownerId
	});

	if (options.title !== undefined) {
		// Название ставится отдельно: помощник его не принимает, а письмо обязано
		// называть именно то взаимодействие, о котором оно.
		await db
			.update(interactions)
			.set({ title: options.title })
			.where(eq(interactions.id, interactionId));
	}

	const organizationId = await insertOrganization(db, {
		shortName: options.organizationName ?? `Вуз ${suffix}`
	});

	await db.insert(interactionParties).values({
		interactionId,
		organizationId,
		partyRole: 'educational_institution',
		isPrimary: true
	});

	const [entry] = await db
		.insert(stageEntries)
		.values({
			interactionId,
			stageId,
			stageSnapshot: snapshot,
			enteredAt: daysFrom(new Date(), -options.enteredDaysAgo)
		})
		.returning({ id: stageEntries.id });

	if (options.paused === true) {
		await db.insert(stagePauses).values({
			stageEntryId: entry.id,
			reason: 'waiting_counterparty',
			note: 'Ждём ответа вуза'
		});
	}

	return { interactionId, stageEntryId: entry.id, ownerId, managerId, managerEmail };
}

async function deliveries() {
	return database.db.select().from(notificationDeliveries);
}

const system = () => systemActor(randomUUID());

beforeAll(async () => {
	// Приёмник поднимается до базы: конфигурация читается один раз, и адрес
	// почтового сервера должен стоять в окружении раньше первого её чтения.
	smtp = await startSmtpReceiver();
	process.env.SMTP_URL = smtp.url;
	process.env.SMTP_FROM = 'crm@lct-test.local';

	database = await startTestDatabase();
}, 300_000);

afterAll(async () => {
	closeMailTransport();
	await smtp?.stop();
	await getRedis().quit();
	await database?.stop();
});

beforeEach(async () => {
	await database.reset();
	smtp.messages.length = 0;
	smtp.setFailing(false);
});

describe('наблюдатель зависших взаимодействий', () => {
	it('пишет руководителю владельца, когда запись стоит дольше порога', async () => {
		const scene = await makeScene({
			enteredDaysAgo: 21,
			title: 'СПбПУ: подготовка DevOps-инженеров',
			organizationName: 'СПбПУ'
		});

		const report = await runNotificationCycle(system());

		expect(report).toMatchObject({ sent: 1, failed: 0, skipped: 0 });
		expect(smtp.messages).toHaveLength(1);
		expect(smtp.messages[0].to).toEqual([scene.managerEmail]);

		const letter = readMessage(smtp.messages[0]);
		expect(letter.subject).toContain('СПбПУ: подготовка DevOps-инженеров');
		expect(letter.text).toContain('21 день');
		expect(letter.text).toContain(`/interactions/${scene.interactionId}`);

		const [row] = await deliveries();
		expect(row).toMatchObject({
			kind: 'stage_stuck',
			channel: 'email',
			status: 'sent',
			attempts: 1,
			interactionId: scene.interactionId,
			stageEntryId: scene.stageEntryId,
			recipientUserId: scene.managerId
		});
		expect(row.sentAt).not.toBeNull();
		expect(row.nextNotifyAt).not.toBeNull();

		// Тело письма лежит в строке журнала и совпадает с тем, что принял
		// почтовый сервер: без него на вопрос «что там было» ответить нечем —
		// текст собирается на лету и нигде больше не остаётся.
		expect(row.subject).toBe(letter.subject);
		expect(row.body).toBe(letter.text);

		// Успехи прохода сводятся в одну запись журнала действий.
		const events = await database.db
			.select({ type: auditEvents.eventType })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'notifications.sent'));
		expect(events).toHaveLength(1);
	});

	it('не трогает запись моложе порога', async () => {
		await makeScene({ enteredDaysAgo: 2 });

		const report = await runNotificationCycle(system());

		expect(report.sent).toBe(0);
		expect(smtp.messages).toHaveLength(0);
		expect(await deliveries()).toHaveLength(0);
	});

	it('не трогает запись на паузе: часы стоят — значит, и напоминание', async () => {
		await makeScene({ enteredDaysAgo: 30, paused: true });

		const report = await runNotificationCycle(system());

		expect(report.sent).toBe(0);
		expect(smtp.messages).toHaveLength(0);
	});

	it('не трогает закрытую запись', async () => {
		const scene = await makeScene({ enteredDaysAgo: 30 });

		await database.db
			.update(stageEntries)
			.set({ leftAt: new Date(), outcome: 'completed' })
			.where(eq(stageEntries.id, scene.stageEntryId));

		expect((await runNotificationCycle(system())).sent).toBe(0);
		expect(smtp.messages).toHaveLength(0);
	});

	it('без руководителя письма не шлёт, а говорит об этом строкой журнала', async () => {
		const scene = await makeScene({ enteredDaysAgo: 21, withManager: false });

		const report = await runNotificationCycle(system());

		expect(report).toMatchObject({ sent: 0, skipped: 1 });
		expect(smtp.messages).toHaveLength(0);

		const [row] = await deliveries();
		expect(row).toMatchObject({
			status: 'skipped',
			attempts: 0,
			recipientUserId: null,
			interactionId: scene.interactionId
		});
		expect(row.lastError).toContain('не указан руководитель');

		const [event] = await database.db
			.select({ type: auditEvents.eventType, outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'notifications.skipped'));
		expect(event).toMatchObject({ outcome: 'failure' });
	});

	it('выключенному руководителю не пишет, а называет причину в строке журнала', async () => {
		const scene = await makeScene({ enteredDaysAgo: 21 });

		// Руководитель уволен: учётная запись выключена, а почта в базе осталась.
		// Письмо о зависшей работе ушло бы тому, кому вход в систему уже закрыт.
		await database.db.update(users).set({ isActive: false }).where(eq(users.id, scene.managerId!));

		const report = await runNotificationCycle(system());

		expect(report).toMatchObject({ sent: 0, skipped: 1 });
		expect(smtp.messages).toHaveLength(0);

		const [row] = await deliveries();
		expect(row).toMatchObject({
			status: 'skipped',
			attempts: 0,
			// Кто имелся в виду, строка называет: иначе искать выключенного
			// руководителя пришлось бы по всей иерархии.
			recipientUserId: scene.managerId,
			interactionId: scene.interactionId
		});
		expect(row.lastError).toContain('выключен');
		// Причина у выключенного своя: незаполненная иерархия чинится назначением
		// руководителя, а эта — заменой его на действующего.
		expect(row.lastError).not.toContain('не указан руководитель');

		const [event] = await database.db
			.select({ outcome: auditEvents.outcome })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'notifications.skipped'));
		expect(event).toMatchObject({ outcome: 'failure' });
	});

	it('второй проход подряд дубля не делает', async () => {
		await makeScene({ enteredDaysAgo: 21 });

		await runNotificationCycle(system());
		const second = await runNotificationCycle(system());

		expect(second.sent).toBe(0);
		expect(smtp.messages).toHaveLength(1);
		expect(await deliveries()).toHaveLength(1);
	});

	it('повторяет, когда отметка следующего напоминания созрела', async () => {
		const scene = await makeScene({ enteredDaysAgo: 21 });

		await runNotificationCycle(system());

		await database.db
			.update(notificationDeliveries)
			.set({ nextNotifyAt: daysFrom(new Date(), -1) })
			.where(eq(notificationDeliveries.stageEntryId, scene.stageEntryId));

		expect((await runNotificationCycle(system())).sent).toBe(1);
		expect(smtp.messages).toHaveLength(2);

		const rows = await deliveries();
		expect(rows).toHaveLength(1);
		expect(rows[0].attempts).toBe(2);
	});

	it('порог читается из настроек на каждом проходе', async () => {
		await makeScene({ enteredDaysAgo: 3 });

		expect((await runNotificationCycle(system())).sent).toBe(0);

		await setSetting(testActor(), 'stuck_threshold_days', 1);

		expect((await runNotificationCycle(system())).sent).toBe(1);
	});

	it('выключенный канал не шлёт ничего', async () => {
		await makeScene({ enteredDaysAgo: 21 });

		await setSetting(testActor(), 'notification_channels', {
			email: false,
			telegram: false,
			max: false
		});

		expect((await runNotificationCycle(system())).scanned).toBe(0);
		expect(smtp.messages).toHaveLength(0);
		expect(await deliveries()).toHaveLength(0);
	});

	it('канал-заглушка пишет строку и ничего не отправляет', async () => {
		const scene = await makeScene({ enteredDaysAgo: 21 });

		await setSetting(testActor(), 'notification_channels', {
			email: false,
			telegram: true,
			max: false
		});

		const report = await runNotificationCycle(system());

		expect(report).toMatchObject({ sent: 0, stubbed: 1 });
		expect(smtp.messages).toHaveLength(0);

		const [row] = await deliveries();
		expect(row).toMatchObject({
			channel: 'telegram',
			status: 'stub',
			// Заглушка попыткой не считается: счётчик отправок там, где отправки
			// нет, врал бы.
			attempts: 0,
			stageEntryId: scene.stageEntryId
		});
		expect(row.lastError).toContain('Заглушка');
		// Текст у заглушки тот же и хранится так же: иначе смотреть на строку
		// заглушки было бы нечего, а показать она обязана то, что ушло бы.
		expect(row.subject).toContain('Зависшее взаимодействие');
		expect(row.body).toContain('остаётся на стадии');
	});

	it('каждый включённый канал ведёт свою строку', async () => {
		await makeScene({ enteredDaysAgo: 21 });

		await setSetting(testActor(), 'notification_channels', {
			email: true,
			telegram: true,
			max: false
		});

		await runNotificationCycle(system());

		const rows = await deliveries();
		expect(rows.map((row) => row.channel).sort()).toEqual(['email', 'telegram']);
	});
});

describe('неудачная доставка', () => {
	it('остаётся в журнале с причиной, попыткой и записью в журнале действий', async () => {
		smtp.setFailing(true);
		const scene = await makeScene({ enteredDaysAgo: 21 });

		const report = await runNotificationCycle(system());

		expect(report).toMatchObject({ sent: 0, failed: 1 });

		const [row] = await deliveries();
		expect(row).toMatchObject({ status: 'failed', attempts: 1, sentAt: null });
		expect(row.lastError).toContain('Почтовый сервер не принял письмо');
		// Повтор назначен сам и раньше, чем через порог: авария кончится быстрее,
		// чем сменится стадия.
		expect(row.nextNotifyAt!.getTime()).toBeLessThan(daysFrom(new Date(), 1).getTime());

		const [event] = await database.db
			.select({ outcome: auditEvents.outcome, subjectId: auditEvents.subjectId })
			.from(auditEvents)
			.where(eq(auditEvents.eventType, 'notifications.failed'));
		expect(event).toMatchObject({ outcome: 'failure', subjectId: scene.interactionId });
	});

	it('уходит по кнопке, когда сервер починили', async () => {
		smtp.setFailing(true);
		await makeScene({ enteredDaysAgo: 21 });
		await runNotificationCycle(system());

		const [failed] = await deliveries();
		smtp.setFailing(false);

		const outcome = await retryNotificationDelivery(testActor(), failed.id);

		expect(outcome).toEqual({ ok: true, error: null });
		expect(smtp.messages).toHaveLength(1);

		const [row] = await deliveries();
		expect(row).toMatchObject({ status: 'sent', attempts: 2 });
	});

	it('повтор доступен только с правом управления уведомлениями', async () => {
		smtp.setFailing(true);
		await makeScene({ enteredDaysAgo: 21 });
		await runNotificationCycle(system());

		const [failed] = await deliveries();
		const lead = testActor({ roleId: 'lead' });

		await expect(retryNotificationDelivery(lead, failed.id)).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('повторять отправленное нечего', async () => {
		await makeScene({ enteredDaysAgo: 21 });
		await runNotificationCycle(system());

		const [sent] = await deliveries();

		await expect(retryNotificationDelivery(testActor(), sent.id)).rejects.toThrowError(
			/не отправлена/
		);
	});
});

describe('журнал доставок', () => {
	it('открыт по праву и фильтруется по состоянию и каналу', async () => {
		await makeScene({ enteredDaysAgo: 21 });
		await setSetting(testActor(), 'notification_channels', {
			email: true,
			telegram: true,
			max: false
		});
		await runNotificationCycle(system());

		const all = await listNotificationDeliveries(testActor(), {
			status: null,
			channel: null,
			page: 1,
			pageSize: 20
		});
		expect(all.total).toBe(2);
		expect(all.items[0].interactionTitle).not.toBeNull();
		expect(all.items[0].stageName).toBe('Первый контакт');

		const stubs = await listNotificationDeliveries(testActor(), {
			status: 'stub',
			channel: null,
			page: 1,
			pageSize: 20
		});
		expect(stubs.total).toBe(1);
		expect(stubs.items[0].channel).toBe('telegram');

		const mail = await listNotificationDeliveries(testActor(), {
			status: null,
			channel: 'email',
			page: 1,
			pageSize: 20
		});
		expect(mail.total).toBe(1);
	});

	it('закрыт без права на него', async () => {
		const manager = testActor({ roleId: 'manager' });

		await expect(
			listNotificationDeliveries(manager, {
				status: null,
				channel: null,
				page: 1,
				pageSize: 20
			})
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it('сужается областью: чужое взаимодействие руководителю не показывают', async () => {
		const mine = await makeScene({ enteredDaysAgo: 21 });
		const theirs = await makeScene({ enteredDaysAgo: 21 });

		await runNotificationCycle(system());

		const lead = testActor({
			roleId: 'lead',
			userId: mine.managerId!,
			scopeUserIds: [mine.managerId!, mine.ownerId],
			workspaceIds: await allWorkspaceIds(database.db)
		});

		const page = await listNotificationDeliveries(lead, {
			status: null,
			channel: null,
			page: 1,
			pageSize: 20
		});

		expect(page.total).toBe(1);
		expect(page.items[0].interactionId).toBe(mine.interactionId);

		// А администратор видит обе.
		const full = await listNotificationDeliveries(testActor(), {
			status: null,
			channel: null,
			page: 1,
			pageSize: 20
		});
		expect(full.items.map((item) => item.interactionId).sort()).toEqual(
			[mine.interactionId, theirs.interactionId].sort()
		);
	});
});

describe('дедупликация в базе', () => {
	it('не даёт завести вторую строку на ту же запись, вид и канал', async () => {
		const scene = await makeScene({ enteredDaysAgo: 21 });
		await runNotificationCycle(system());

		expect(
			await failureCode(
				database.db.insert(notificationDeliveries).values({
					kind: 'stage_stuck',
					interactionId: scene.interactionId,
					stageEntryId: scene.stageEntryId,
					channel: 'email',
					status: 'queued'
				})
			)
		).toBe('23505');

		expect(
			await database.db
				.select()
				.from(notificationDeliveries)
				.where(
					and(
						eq(notificationDeliveries.stageEntryId, scene.stageEntryId),
						eq(notificationDeliveries.channel, 'email')
					)
				)
		).toHaveLength(1);
	});
});
