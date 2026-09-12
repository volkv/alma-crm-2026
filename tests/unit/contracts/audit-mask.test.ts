/**
 * Маскирование адреса и клиента в журнале.
 *
 * Публичная демонстрация читает журнал целиком, а адрес и строка клиента в нём
 * — настоящие: их оставил живой посетитель. Проверяется не «что-то изменилось»,
 * а что в ответе не осталось того, по чему посетителя узнают.
 */
import { describe, expect, it } from 'vitest';
import { maskAuditEvent, maskIp, maskUserAgent } from '$lib/contracts/audit';
import type { AuditEventView } from '$lib/contracts/audit';

describe('адрес', () => {
	it('оставляет первые два октета и убирает остальные', () => {
		expect(maskIp('198.51.100.14')).toBe('198.51.*.*');
		expect(maskIp('10.0.0.1')).toBe('10.0.*.*');
	});

	it('не выдаёт адрес, который не разбирается на четыре октета', () => {
		// У IPv6 нет октетов, и «префикс» в нём — это по-прежнему адрес сети.
		expect(maskIp('2001:db8::1')).toBe('скрыто');
		expect(maskIp('::1')).toBe('скрыто');
		expect(maskIp('не адрес')).toBe('скрыто');
	});

	it('оставляет пустоту пустотой', () => {
		// `null` — это «адрес неизвестен», и подменять его словом «скрыто» значило
		// бы сказать, что адрес был.
		expect(maskIp(null)).toBeNull();
	});
});

describe('клиент', () => {
	it('называет семейство браузера вместо полной строки', () => {
		expect(
			maskUserAgent(
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
			)
		).toBe('Chrome');
		expect(
			maskUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0')
		).toBe('Firefox');
		expect(
			maskUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
			)
		).toBe('Safari');
	});

	it('различает браузеры, которые называют себя Chrome', () => {
		// Порядок проверки значим: у Edge и Яндекса в строке стоит и `Chrome/`.
		expect(
			maskUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0'
			)
		).toBe('Edge');
		expect(
			maskUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 YaBrowser/26.9.0.0 Safari/537.36'
			)
		).toBe('Яндекс.Браузер');
		expect(
			maskUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/120.0.0.0'
			)
		).toBe('Opera');
	});

	it('не пересказывает строку, в которой не узнало браузера', () => {
		expect(maskUserAgent('curl/8.11.1')).toBe('скрыто');
		expect(maskUserAgent('')).toBe('скрыто');
		expect(maskUserAgent(null)).toBeNull();
	});
});

describe('событие целиком', () => {
	const event: AuditEventView = {
		id: '00000000-0000-4000-8000-00000000ae01',
		occurredAt: new Date('2026-09-12T10:00:00Z'),
		requestId: '00000000-0000-4000-8000-00000000fee1',
		source: 'ui',
		eventType: 'auth.login',
		outcome: 'success',
		actorUserId: '00000000-0000-4000-8000-0000000000a1',
		apiKeyId: null,
		actorLabel: 'Администратор Демо',
		ip: '198.51.100.14',
		userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0',
		subjectType: 'user',
		subjectId: '00000000-0000-4000-8000-0000000000a1',
		details: { userId: '00000000-0000-4000-8000-0000000000a1', demo: true }
	};

	it('огрубляет адрес и клиента и не трогает остального', () => {
		const masked = maskAuditEvent(event);

		expect(masked.ip).toBe('198.51.*.*');
		expect(masked.userAgent).toBe('Firefox');

		// Всё прочее — про систему, а не про того, кто её открыл: подменять там
		// нечего, иначе журнал перестанет быть доказательством.
		expect({ ...masked, ip: event.ip, userAgent: event.userAgent }).toEqual(event);
	});

	it('не меняет исходную запись', () => {
		maskAuditEvent(event);

		expect(event.ip).toBe('198.51.100.14');
	});
});
