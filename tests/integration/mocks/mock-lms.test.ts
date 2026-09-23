/**
 * Имитатор системы обучения: заявка на группу, результат группы и веб-сервис
 * Moodle рядом с ними.
 *
 * Как и у имитатора CMS, на месте CRM стоит настоящий `http.createServer`:
 * проверяется то, что уходит по сети.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startMockLms } from '../../../mocks/mock-lms/service.ts';
import { MOCK_LMS_TOKEN } from '../../../mocks/mock-lms/moodle.ts';
import type { MockService } from '../../../mocks/shared/http.ts';
import { crmEnvelope, signedHeaders, startCrmStandIn, type CrmStandIn } from './helpers.ts';

const SECRET = 'stand-secret';
const API_KEY = 'lct_stand_key';
const REQUEST_ID = 'crm-group-2f1c9a0e-1';

let crm: CrmStandIn;
let lms: MockService;

beforeAll(async () => {
	crm = await startCrmStandIn();
	lms = await startMockLms({
		port: 0,
		crm: { baseUrl: crm.url, apiKey: API_KEY },
		exchangeSecret: SECRET,
		publicUrl: 'http://lms.stand.example'
	});
});

afterAll(async () => {
	await lms.stop();
	await crm.stop();
});

afterEach(async () => {
	await fetch(`${lms.url}/__scenario`, { method: 'POST', body: JSON.stringify({ reset: true }) });
	crm.requests.length = 0;
});

function pick(value: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((current, key) => {
		return current === null || typeof current !== 'object'
			? undefined
			: (current as Record<string, unknown>)[key];
	}, value);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

/** Заявка на группу, какой её шлёт CRM в направлении 3. */
async function requestGroup(
	service: MockService,
	options: { externalId?: string; data?: Record<string, unknown>; signature?: string } = {}
): Promise<Response> {
	const body = JSON.stringify(
		crmEnvelope(
			'learning_group.requested',
			{
				externalId: options.externalId ?? REQUEST_ID,
				interactionId: '2f1c9a0e-6b3d-4a77-8f21-0c5e9d4b7a10',
				program: { id: '1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d', code: 'VO-BAK-01' },
				stream: { number: 1, plannedSeats: 45, startsOn: '2026-10-01', endsOn: '2027-05-31' },
				...options.data
			},
			randomUUID()
		)
	);

	return fetch(`${service.url}/api/groups`, {
		method: 'POST',
		headers: signedHeaders(SECRET, body, { signature: options.signature }),
		body
	});
}

async function sendResult(body: Record<string, unknown>): Promise<Response> {
	return fetch(`${lms.url}/__send-result`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('заявка на учебную группу', () => {
	it('заводит группу и отвечает её идентификатором', async () => {
		const response = await requestGroup(lms);
		const body = await readJson(response);

		expect(response.status).toBe(201);
		expect(body.result).toBe('created');
		expect(body.schemaVersion).toBe('1.0');
		expect(pick(body, 'data.externalId')).toBe(REQUEST_ID);
		expect(pick(body, 'data.groupExternalId')).toMatch(/^\d{4}$/);
		expect(pick(body, 'data.courseExternalId')).toBe('101');
		expect(pick(body, 'data.url')).toBe('http://lms.stand.example/course/view.php?id=101');
	});

	it('помнит, что и для кого обучается: программу, продукты и назначение', async () => {
		await requestGroup(lms, {
			data: {
				products: [
					{ id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b', code: 'RT-DEVOPS' },
					{ id: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c', code: 'RT-YAGA' }
				],
				purpose: 'teachers'
			}
		});

		const state = await readJson(await fetch(`${lms.url}/__state`));

		expect(pick(state, 'objects.groups.0.programCode')).toBe('VO-BAK-01');
		expect(pick(state, 'objects.groups.0.productCodes')).toEqual(['RT-DEVOPS', 'RT-YAGA']);
		expect(pick(state, 'objects.groups.0.purpose')).toBe('teachers');
	});

	it('на повторную заявку возвращает ту же группу, а не заводит вторую', async () => {
		const first = await readJson(await requestGroup(lms));
		const second = await requestGroup(lms);
		const repeated = await readJson(second);

		expect(second.status).toBe(200);
		expect(repeated.result).toBe('unchanged');
		expect(pick(repeated, 'data.groupExternalId')).toBe(pick(first, 'data.groupExternalId'));

		const state = await readJson(await fetch(`${lms.url}/__state`));

		expect(pick(state, 'objects.groups')).toHaveLength(1);
	});

	it('идентификатор группы переживает перезапуск сервиса', async () => {
		const first = await readJson(await requestGroup(lms));
		const restarted = await startMockLms({ port: 0, exchangeSecret: SECRET });

		try {
			const second = await readJson(await requestGroup(restarted));

			expect(pick(second, 'data.groupExternalId')).toBe(pick(first, 'data.groupExternalId'));
		} finally {
			await restarted.stop();
		}
	});

	it('с неверной подписью отвергается и группы не заводит', async () => {
		const response = await requestGroup(lms, { signature: 'sha256=00' });

		expect(response.status).toBe(401);
		expect(pick(await readJson(response), 'code')).toBe('bad_signature');

		const state = await readJson(await fetch(`${lms.url}/__state`));

		expect(pick(state, 'objects.groups')).toHaveLength(0);
	});

	it('без ключа заявки — отказ с указанием поля', async () => {
		const response = await requestGroup(lms, { data: { externalId: '' } });

		expect(response.status).toBe(400);
		expect(pick(await readJson(response), 'message')).toContain('externalId');
	});
});

describe('результат группы', () => {
	it('уходит в CRM конвертом контракта со счётчиками', async () => {
		const created = await readJson(await requestGroup(lms));
		const response = await sendResult({
			requestExternalId: REQUEST_ID,
			counters: { enrolled: 45, completed: 38, expelled: 4 },
			finishedOn: '2027-05-20'
		});

		expect(response.status).toBe(200);
		expect(crm.requests).toHaveLength(1);

		const request = crm.requests[0];
		const envelope = JSON.parse(request.body) as Record<string, unknown>;

		expect(request.path).toBe('/api/v1/exchange/learning-groups/results');
		expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
		expect(envelope.eventType).toBe('learning_group.result');
		expect(pick(envelope, 'source.system')).toBe('lms');
		expect(pick(envelope, 'data.groupExternalId')).toBe(pick(created, 'data.groupExternalId'));
		expect(pick(envelope, 'data.requestExternalId')).toBe(REQUEST_ID);
		expect(pick(envelope, 'data.counters.completed')).toBe(38);
		expect(pick(envelope, 'data.period.end')).toBe('2027-05-31');
	});

	it('повтор того же события шлёт то же тело', async () => {
		await requestGroup(lms);

		const eventId = randomUUID();

		await sendResult({ requestExternalId: REQUEST_ID, eventId });
		const repeat = await readJson(await sendResult({ requestExternalId: REQUEST_ID, eventId }));

		expect(repeat.repeat).toBe(true);
		expect(crm.requests).toHaveLength(2);
		expect(crm.requests[1].body).toBe(crm.requests[0].body);
	});

	it('противоречивые счётчики не отправляются вовсе', async () => {
		await requestGroup(lms);

		const response = await sendResult({
			requestExternalId: REQUEST_ID,
			counters: { enrolled: 10, completed: 9, expelled: 2 }
		});

		expect(response.status).toBe(400);
		expect(crm.requests).toHaveLength(0);
	});

	it('по неизвестной группе — 404', async () => {
		const response = await sendResult({ groupExternalId: '9999' });

		expect(response.status).toBe(404);
	});
});

describe('веб-сервис Moodle', () => {
	it('выдаёт токен по логину и паролю', async () => {
		const response = await fetch(
			`${lms.url}/login/token.php?username=operator&password=mock-lms&service=moodle_mobile_app`
		);

		expect(pick(await readJson(response), 'token')).toBe(MOCK_LMS_TOKEN);
	});

	it('отдаёт курсы кодами программ справочника', async () => {
		const response = await fetch(
			`${lms.url}/webservice/rest/server.php?wstoken=${MOCK_LMS_TOKEN}&wsfunction=core_course_get_courses&moodlewsrestformat=json`
		);
		const courses = (await response.json()) as { idnumber: string }[];

		expect(courses.length).toBeGreaterThan(0);
		expect(courses.map((course) => course.idnumber)).toContain('VO-BAK-01');
	});

	it('на чужой токен отвечает исключением веб-сервиса, а не кодом ответа', async () => {
		const response = await fetch(
			`${lms.url}/webservice/rest/server.php?wstoken=nope&wsfunction=core_course_get_courses&moodlewsrestformat=json`
		);

		// Moodle отдаёт отказ веб-сервиса кодом 200 и телом-исключением; клиент
		// разбирает именно тело.
		expect(response.status).toBe(200);
		expect(pick(await readJson(response), 'errorcode')).toBe('invalidtoken');
	});
});

describe('сценарий отказов', () => {
	it('offline обрывает соединение на контракте и оставляет управление живым', async () => {
		await fetch(`${lms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ mode: 'offline' })
		});

		await expect(requestGroup(lms)).rejects.toThrow();

		const state = await fetch(`${lms.url}/__state`);

		expect(state.status).toBe(200);
		await state.body?.cancel();
	});

	it('задержка ответа больше таймаута отправителя', async () => {
		await fetch(`${lms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ delayMs: 300 })
		});

		await expect(
			fetch(`${lms.url}/login/token.php?username=operator`, {
				signal: AbortSignal.timeout(100)
			})
		).rejects.toThrow();
	});
});
