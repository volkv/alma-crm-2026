import { describe, expect, it } from 'vitest';
import {
	createWebhookSchema,
	matchesWebhookEvent,
	normalizeWebhookEvents,
	prefixPattern,
	webhookUrlIssue
} from '$lib/contracts/integrations';
import {
	MAX_DELIVERY_ATTEMPTS,
	RETRY_DELAYS_SECONDS,
	retryDelaySeconds,
	signPayload,
	verifySignature
} from '$lib/server/integrations/delivery';

const SECRET = 'whsec_test-secret';

describe('подпись доставки', () => {
	it('считается от момента и тела вместе', () => {
		const body = '{"id":"1"}';

		// Момент входит в подписываемую строку: иначе перехваченный запрос можно
		// повторить через сутки, и подпись сойдётся.
		expect(signPayload(SECRET, '1000', body)).not.toBe(signPayload(SECRET, '1001', body));
		expect(signPayload(SECRET, '1000', body)).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it('воспроизводится по тем же данным и не сходится по чужим', () => {
		const body = '{"id":"1"}';
		const signature = signPayload(SECRET, '1000', body);

		expect(verifySignature(SECRET, '1000', body, signature)).toBe(true);
		expect(verifySignature('whsec_other', '1000', body, signature)).toBe(false);
		expect(verifySignature(SECRET, '1000', '{"id":"2"}', signature)).toBe(false);
		expect(verifySignature(SECRET, '1001', body, signature)).toBe(false);
	});

	it('не падает на подписи чужой длины', () => {
		expect(verifySignature(SECRET, '1000', '{}', 'sha256=short')).toBe(false);
	});
});

describe('расписание повторов', () => {
	it('растёт от секунд к часам и кончается', () => {
		expect(RETRY_DELAYS_SECONDS.map((_, index) => retryDelaySeconds(index + 1))).toEqual([
			...RETRY_DELAYS_SECONDS
		]);
		expect(retryDelaySeconds(RETRY_DELAYS_SECONDS.length + 1)).toBeNull();
		expect(MAX_DELIVERY_ATTEMPTS).toBe(RETRY_DELAYS_SECONDS.length + 1);
	});

	it('каждая следующая задержка больше предыдущей', () => {
		const sorted = [...RETRY_DELAYS_SECONDS].sort((left, right) => left - right);

		expect([...RETRY_DELAYS_SECONDS]).toEqual(sorted);
	});

	it('отвергает номер попытки, которого не бывает', () => {
		// Ноль и отрицательное — это ошибка вызывающего, а не «повторить сразу».
		expect(() => retryDelaySeconds(0)).toThrowError(RangeError);
		expect(() => retryDelaySeconds(1.5)).toThrowError(RangeError);
	});
});

describe('фильтр событий', () => {
	it('пропускает точный код и весь раздел', () => {
		expect(matchesWebhookEvent(['interactions.completed'], 'interactions.completed')).toBe(true);
		expect(matchesWebhookEvent(['interactions.completed'], 'interactions.created')).toBe(false);
		expect(matchesWebhookEvent([prefixPattern('interactions')], 'interactions.created')).toBe(true);
		expect(matchesWebhookEvent([prefixPattern('interactions')], 'documents.uploaded')).toBe(false);
	});

	it('пустой фильтр не пропускает ничего', () => {
		expect(matchesWebhookEvent([], 'interactions.created')).toBe(false);
	});
});

describe('адрес приёмника', () => {
	it('принимает https куда угодно', () => {
		expect(webhookUrlIssue('https://partner.example.org/hooks')).toBeNull();
	});

	it('принимает http только на этой же машине', () => {
		expect(webhookUrlIssue('http://localhost:4000/hook')).toBeNull();
		expect(webhookUrlIssue('http://127.0.0.1:4000/hook')).toBeNull();
		expect(webhookUrlIssue('http://host.docker.internal:4000/hook')).toBeNull();
		expect(webhookUrlIssue('http://partner.example.org/hook')).toMatch(/https/);
	});

	it('отвергает всё, что не http и не https', () => {
		expect(webhookUrlIssue('ftp://partner.example.org')).toMatch(/http/);
		expect(webhookUrlIssue('partner.example.org')).toMatch(/полностью/);
	});
});

describe('схема подписки', () => {
	it('приводит набор событий к каноническому виду', () => {
		// Повторы убраны, порядок задан: «тот же набор» не должен зависеть от
		// порядка галочек в форме.
		expect(
			normalizeWebhookEvents(['interactions.created', 'documents.*', 'interactions.created'])
		).toEqual(['documents.*', 'interactions.created']);
	});

	it('оставляет форме пустой список, а не «ничего»', () => {
		// Схема без преобразования отдаёт значение по умолчанию для пустой формы:
		// с `transform` список приходил бы как `undefined`, и страница падала бы
		// на первом же обращении к нему.
		const empty = createWebhookSchema.safeParse({
			name: 'Портал партнёров',
			url: 'https://partner.example.org/hooks'
		});

		expect(empty.success).toBe(false);
		expect(empty.error?.issues.map((issue) => issue.path.join('.'))).toContain('events');
	});

	it('не принимает событие, которого нет в словаре журнала', () => {
		const parsed = createWebhookSchema.safeParse({
			name: 'Портал партнёров',
			url: 'https://partner.example.org/hooks',
			events: ['interactions.everything'],
			enabled: true
		});

		expect(parsed.success).toBe(false);
	});

	it('не принимает подписку без единого события', () => {
		const parsed = createWebhookSchema.safeParse({
			name: 'Портал партнёров',
			url: 'https://partner.example.org/hooks',
			events: [],
			enabled: true
		});

		expect(parsed.success).toBe(false);
	});
});
