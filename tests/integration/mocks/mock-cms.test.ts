/**
 * Имитатор CMS: что он отправляет в CRM и что принимает от неё.
 *
 * Сервис поднимается прямо здесь на случайном порту, а на месте CRM стоит
 * обычный `http.createServer`: проверяется то, что уходит по сети — конверт,
 * заголовки, подпись, — а не то, что имитатор о себе рассказывает.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startMockCms } from '../../../mocks/mock-cms/service.ts';
import { MAX_BODY_BYTES, type MockService } from '../../../mocks/shared/http.ts';
import { crmEnvelope, signedHeaders, startCrmStandIn, type CrmStandIn } from './helpers.ts';

const SECRET = 'stand-secret';
const API_KEY = 'lct_stand_key';
const B2B_EXTERNAL_ID = 'site-2026-000123';

let crm: CrmStandIn;
let cms: MockService;

beforeAll(async () => {
	crm = await startCrmStandIn();
	cms = await startMockCms({
		port: 0,
		crm: { baseUrl: crm.url, apiKey: API_KEY },
		exchangeSecret: SECRET
	});
});

afterAll(async () => {
	await cms.stop();
	await crm.stop();
});

afterEach(async () => {
	await fetch(`${cms.url}/__scenario`, { method: 'POST', body: JSON.stringify({ reset: true }) });
	crm.requests.length = 0;
	crm.reply = { status: 200, body: { schemaVersion: '1.0', result: 'created', data: {} } };
});

/** Значение по пути `a.b.0.c` — иначе проверки тонут в приведениях типов. */
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

async function sendApplication(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await fetch(`${cms.url}/__send-application`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

	return { status: response.status, ...(await readJson(response)) };
}

/** Снимок статуса, каким его шлёт CRM в направлении 2. */
async function postStatus(
	externalId: string,
	data: Record<string, unknown>,
	options: { eventId?: string; signature?: string } = {}
): Promise<Response> {
	const body = JSON.stringify(
		crmEnvelope('application.status', { externalId, ...data }, options.eventId ?? randomUUID())
	);

	return fetch(`${cms.url}/api/applications/${externalId}/status`, {
		method: 'POST',
		headers: signedHeaders(SECRET, body, { signature: options.signature }),
		body
	});
}

describe('заявка из CMS в CRM', () => {
	it('уходит конвертом контракта с ключом доступа', async () => {
		const sent = await sendApplication({ form: 'b2b' });

		expect(sent.status).toBe(200);
		expect(crm.requests).toHaveLength(1);

		const request = crm.requests[0];
		const envelope = JSON.parse(request.body) as Record<string, unknown>;

		expect(request.path).toBe('/api/v1/applications');
		expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
		expect(request.headers['idempotency-key']).toBe(envelope.eventId);
		expect(envelope.schemaVersion).toBe('1.0');
		expect(envelope.eventType).toBe('application.submitted');
		expect(pick(envelope, 'source.system')).toBe('cms');
		expect(pick(envelope, 'source.instance')).toBe('itschool-site');
		expect(pick(envelope, 'data.externalId')).toBe(B2B_EXTERNAL_ID);
		expect(pick(envelope, 'data.revision')).toBe(1);
		expect(pick(envelope, 'data.applicant.inn')).toBe('0000000096');
	});

	it('у B2C несёт физлицо и согласие', async () => {
		await sendApplication({ form: 'b2c' });

		const envelope = JSON.parse(crm.requests[0].body) as Record<string, unknown>;

		expect(pick(envelope, 'data.form')).toBe('b2c');
		expect(pick(envelope, 'data.applicant.kind')).toBe('individual');
		expect(pick(envelope, 'data.consent.given')).toBe(true);
	});

	it('повторная отправка той же заявки поднимает ревизию', async () => {
		await sendApplication({ form: 'b2b' });
		await sendApplication({ form: 'b2b' });

		const first = JSON.parse(crm.requests[0].body) as Record<string, unknown>;
		const second = JSON.parse(crm.requests[1].body) as Record<string, unknown>;

		expect(pick(first, 'data.revision')).toBe(1);
		expect(pick(second, 'data.revision')).toBe(2);
		expect(second.eventId).not.toBe(first.eventId);
	});

	it('повтор того же события шлёт то же тело', async () => {
		const eventId = randomUUID();

		await sendApplication({ form: 'b2b', eventId });
		const repeat = await sendApplication({ form: 'b2b', eventId });

		expect(repeat.repeat).toBe(true);
		expect(crm.requests).toHaveLength(2);
		expect(crm.requests[1].body).toBe(crm.requests[0].body);
	});

	it('ответ CRM ложится в журнал как есть', async () => {
		crm.reply = { status: 409, body: { code: 'conflict', message: 'другой ИНН' } };

		const sent = await sendApplication({ form: 'b2b' });

		expect(pick(sent, 'crm.status')).toBe(409);
		expect(pick(sent, 'crm.body.code')).toBe('conflict');

		const state = await readJson(await fetch(`${cms.url}/__state`));

		expect(pick(state, 'journal.0.status')).toBe(409);
		expect(pick(state, 'journal.0.direction')).toBe('outbound');
	});

	it('без ключа доступа CRM отвечает, что обмен не настроен', async () => {
		const unconfigured = await startMockCms({ port: 0, exchangeSecret: SECRET });

		try {
			const response = await fetch(`${unconfigured.url}/__send-application`, {
				method: 'POST',
				body: JSON.stringify({ form: 'b2b' })
			});

			expect(response.status).toBe(503);
			expect(pick(await readJson(response), 'message')).toContain('CRM_API_KEY');
		} finally {
			await unconfigured.stop();
		}
	});

	it('неизвестное поле триггера — отказ, а не молчаливый пропуск', async () => {
		const response = await fetch(`${cms.url}/__send-application`, {
			method: 'POST',
			body: JSON.stringify({ form: 'b2b', formm: 'b2c' })
		});

		expect(response.status).toBe(400);
		expect(pick(await readJson(response), 'message')).toContain('formm');
	});
});

describe('статус заявки из CRM', () => {
	it('принимается с верной подписью и виден в состоянии', async () => {
		await sendApplication({ form: 'b2b' });

		const response = await postStatus(B2B_EXTERNAL_ID, { applicationStatus: 'in_progress' });

		expect(response.status).toBe(200);

		const state = await readJson(await fetch(`${cms.url}/__state`));

		expect(pick(state, 'objects.applications.0.statuses.0.data.applicationStatus')).toBe(
			'in_progress'
		);
	});

	it('с неверной подписью отвергается и карточку не меняет', async () => {
		await sendApplication({ form: 'b2b' });

		const response = await postStatus(
			B2B_EXTERNAL_ID,
			{ applicationStatus: 'completed' },
			{ signature: 'sha256=00' }
		);

		expect(response.status).toBe(401);
		expect(pick(await readJson(response), 'code')).toBe('bad_signature');

		const state = await readJson(await fetch(`${cms.url}/__state`));

		expect(pick(state, 'objects.applications.0.statuses')).toHaveLength(0);
	});

	it('повторная доставка того же события ничего не меняет', async () => {
		await sendApplication({ form: 'b2b' });

		const eventId = randomUUID();
		const first = await postStatus(B2B_EXTERNAL_ID, { applicationStatus: 'on_hold' }, { eventId });
		const second = await postStatus(B2B_EXTERNAL_ID, { applicationStatus: 'on_hold' }, { eventId });

		expect(pick(await readJson(first), 'result')).toBe('accepted');
		expect(pick(await readJson(second), 'result')).toBe('unchanged');

		const state = await readJson(await fetch(`${cms.url}/__state`));

		expect(pick(state, 'objects.applications.0.statuses')).toHaveLength(1);
	});

	it('по неизвестной заявке заводит карточку и помечает, откуда она', async () => {
		// Заявку могли завести в CRM руками или принести другим каналом: сайту от
		// снимка нужно одно — показать заявителю, что с обращением происходит.
		// Отказ вместо этого означал бы окончательный 4xx и «не доставлено» в
		// журнале CRM на первом же статусе такой заявки.
		const response = await postStatus('site-2026-000999', { applicationStatus: 'received' });

		expect(response.status).toBe(200);
		expect(pick(await readJson(response), 'result')).toBe('created');

		const state = await readJson(await fetch(`${cms.url}/__state`));

		expect(pick(state, 'objects.applications.0.externalId')).toBe('site-2026-000999');
		expect(pick(state, 'objects.applications.0.origin')).toBe('crm-status');
		expect(pick(state, 'objects.applications.0.revision')).toBeNull();
		expect(pick(state, 'objects.applications.0.statuses.0.data.applicationStatus')).toBe(
			'received'
		);
		expect(pick(state, 'journal.0.note')).toContain('заведена по статусу из CRM');
	});

	it('форма сайта по той же заявке забирает карточку себе, не теряя статусов', async () => {
		await postStatus(B2B_EXTERNAL_ID, { applicationStatus: 'received' });
		await sendApplication({ form: 'b2b' });

		const state = await readJson(await fetch(`${cms.url}/__state`));

		expect(pick(state, 'objects.applications.0.origin')).toBe('form');
		expect(pick(state, 'objects.applications.0.revision')).toBe(1);
		expect(pick(state, 'objects.applications.0.statuses')).toHaveLength(1);
	});

	it('конверт чужой версии схемы отвергается отдельным кодом', async () => {
		await sendApplication({ form: 'b2b' });

		const body = JSON.stringify({
			...crmEnvelope('application.status', { externalId: B2B_EXTERNAL_ID }, randomUUID()),
			schemaVersion: '2.0'
		});
		const response = await fetch(`${cms.url}/api/applications/${B2B_EXTERNAL_ID}/status`, {
			method: 'POST',
			headers: signedHeaders(SECRET, body),
			body
		});

		expect(response.status).toBe(400);
		expect(pick(await readJson(response), 'code')).toBe('unsupported_version');
	});

	it('тело больше предела — 413, и оно не читается целиком', async () => {
		const body = JSON.stringify({ filler: 'x'.repeat(MAX_BODY_BYTES) });
		const response = await fetch(`${cms.url}/api/applications/${B2B_EXTERNAL_ID}/status`, {
			method: 'POST',
			headers: signedHeaders(SECRET, body),
			body
		});

		expect(response.status).toBe(413);
	});
});

describe('сценарий отказов', () => {
	it('портит заданное число обращений к контракту и не трогает управление', async () => {
		await sendApplication({ form: 'b2b' });

		const applied = await fetch(`${cms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ failNext: 3, status: 503 })
		});

		expect(pick(await readJson(applied), 'scenario.failNext')).toBe(3);

		const codes: number[] = [];

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const response = await postStatus(B2B_EXTERNAL_ID, { applicationStatus: 'in_progress' });

			codes.push(response.status);
			await response.body?.cancel();
		}

		expect(codes).toStrictEqual([503, 503, 503, 200]);

		// Управление отвечает и при включённом сценарии: иначе его нечем было бы
		// ни посмотреть, ни снять.
		const state = await fetch(`${cms.url}/__state`);

		expect(state.status).toBe(200);
		await state.body?.cancel();
	});

	it('сброс забывает заявки, журнал и сам сценарий', async () => {
		await sendApplication({ form: 'b2b' });
		await fetch(`${cms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ failNext: 5, reset: true })
		});

		const state = await readJson(await fetch(`${cms.url}/__state`));

		expect(pick(state, 'objects.applications')).toHaveLength(0);
		expect(pick(state, 'journal')).toHaveLength(0);
		expect(pick(state, 'scenario.failNext')).toBe(0);
	});

	it('«match» сужает отказ до одной заявки, соседние идут как обычно', async () => {
		// Имитатор на стенде один, и сломанная доставка одной заявки не должна
		// задевать соседнюю — ни на показе, ни в проверках, идущих рядом.
		await fetch(`${cms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ failNext: 5, status: 503, match: 'site-2026-000777' })
		});

		const stranger = await postStatus('site-2026-000778', { applicationStatus: 'received' });
		const targeted = await postStatus('site-2026-000777', { applicationStatus: 'received' });

		expect(stranger.status).toBe(200);
		expect(targeted.status).toBe(503);

		const state = await readJson(await fetch(`${cms.url}/__state`));

		// Испорчено ровно одно обращение из двух: счётчик тронут один раз.
		expect(pick(state, 'scenario.failNext')).toBe(4);
	});

	it('пустой «match» — отказ разбора, а не сценарий на всё подряд', async () => {
		const response = await fetch(`${cms.url}/__scenario`, {
			method: 'POST',
			body: JSON.stringify({ failNext: 1, match: '' })
		});

		expect(response.status).toBe(400);
		expect(pick(await readJson(response), 'message')).toContain('match');
	});
});

describe('страница состояния и управление', () => {
	it('страница показывает заголовок, кнопку сцены и живёт без управляющих адресов', async () => {
		const response = await fetch(`${cms.url}/`);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(html).toContain('Имитатор CMS сайта — не настоящая система');
		// Адрес формы относительный: на стенде имитатор живёт под префиксом пути
		// (`/mock-cms/`), и абсолютный увёл бы кнопку в корень домена.
		expect(html).toContain('action="__send-application"');
	});

	it('кнопка страницы подаёт заявку и возвращает на страницу', async () => {
		const response = await fetch(`${cms.url}/__send-application`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ form: 'b2b', externalId: '' }).toString(),
			redirect: 'manual'
		});

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('./');
		expect(crm.requests).toHaveLength(1);

		const envelope = JSON.parse(crm.requests[0].body) as Record<string, unknown>;

		// Пустое поле формы — это «как обычно», а не пустой ключ заявки.
		expect(pick(envelope, 'data.externalId')).toBe(B2B_EXTERNAL_ID);
	});

	it('с токеном управляющие адреса закрыты, а страница и триггер — нет', async () => {
		const guarded = await startMockCms({
			port: 0,
			crm: { baseUrl: crm.url, apiKey: API_KEY },
			exchangeSecret: SECRET,
			controlToken: 'stand-control-token'
		});

		try {
			const state = await fetch(`${guarded.url}/__state`);

			expect(state.status).toBe(403);
			expect(pick(await readJson(state), 'code')).toBe('control_forbidden');

			const scenario = await fetch(`${guarded.url}/__scenario`, {
				method: 'POST',
				body: JSON.stringify({ failNext: 1 })
			});

			expect(scenario.status).toBe(403);
			await scenario.body?.cancel();

			const withToken = await fetch(`${guarded.url}/__state`, {
				headers: { 'x-mock-control': 'stand-control-token' }
			});

			expect(withToken.status).toBe(200);
			await withToken.body?.cancel();

			// Показать стенд токен не мешает: страница состояния и триггер сцены
			// открыты — ровно они и выходят наружу через прокси.
			const page = await fetch(`${guarded.url}/`);

			expect(page.status).toBe(200);
			await page.body?.cancel();

			const trigger = await fetch(`${guarded.url}/__send-application`, {
				method: 'POST',
				body: JSON.stringify({ form: 'b2b' })
			});

			expect(trigger.status).toBe(200);
			await trigger.body?.cancel();
		} finally {
			await guarded.stop();
		}
	});
});
