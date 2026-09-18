/**
 * Каналы доставки: реестр, заглушки и почта без почтового сервера.
 *
 * Настоящая отправка проверяется интеграционным тестом против настоящего SMTP —
 * здесь то, что до сокета не доходит вовсе: какие каналы вообще есть, что
 * заглушка не притворяется отправкой и что ненастроенная почта говорит об этом
 * словами, а не молчит.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	NOTIFICATION_CHANNELS,
	isStubChannel,
	notificationChannelsSchema
} from '$lib/contracts/notifications';

/** Конфигурация под контролем теста: настоящую `.env` сюда пускать незачем. */
let smtpUrl: string | null = null;
let smtpFrom: string | null = null;

vi.mock('$lib/server/config', () => ({
	getConfig: () => ({ SMTP_URL: smtpUrl, SMTP_FROM: smtpFrom, ORIGIN: 'https://crm.example.org' })
}));

const { NOTIFICATION_SENDERS, sendThroughChannel } =
	await import('$lib/server/notifications/channels');
const { smtpOptions } = await import('$lib/server/notifications/channels/email');
const { STUB_NOTICE } = await import('$lib/server/notifications/channels/stub');

const RECIPIENT = { userId: 'u1', fullName: 'Руководитель', email: 'lead@example.org' };
const MESSAGE = { subject: 'Тема', text: 'Текст' };

beforeEach(() => {
	smtpUrl = null;
	smtpFrom = null;
});

describe('реестр каналов', () => {
	it('покрывает каждый канал словаря отправителем', () => {
		expect(Object.keys(NOTIFICATION_SENDERS).sort()).toEqual([...NOTIFICATION_CHANNELS].sort());
	});

	it('покрывает каждый канал выключателем в настройках', () => {
		expect(Object.keys(notificationChannelsSchema.shape).sort()).toEqual(
			[...NOTIFICATION_CHANNELS].sort()
		);
	});
});

describe('заглушки', () => {
	it('отвечают своим исходом, а не успехом', async () => {
		for (const channel of NOTIFICATION_CHANNELS.filter(isStubChannel)) {
			const outcome = await sendThroughChannel(channel, RECIPIENT, MESSAGE);

			expect(outcome.status).toBe('stub');
			expect(outcome.error).toBe(STUB_NOTICE);
		}
	});

	it('говорят о себе словом «заглушка»', () => {
		// Молчаливая заглушка однажды окажется единственным включённым каналом
		// эскалации, и об этом никто не узнает.
		expect(STUB_NOTICE).toContain('Заглушка');
	});
});

describe('почта', () => {
	it('без SMTP_URL и SMTP_FROM не отправляет и называет недостающие переменные', async () => {
		const outcome = await sendThroughChannel('email', RECIPIENT, MESSAGE);

		expect(outcome.status).toBe('failed');
		expect(outcome.error).toContain('SMTP_URL');
		expect(outcome.error).toContain('SMTP_FROM');
	});

	it('без адреса получателя не отправляет', async () => {
		smtpUrl = 'smtp://localhost:1025';
		smtpFrom = 'crm@example.org';

		const outcome = await sendThroughChannel('email', { ...RECIPIENT, email: null }, MESSAGE);

		expect(outcome.status).toBe('failed');
		expect(outcome.error).toContain('адрес электронной почты');
	});

	it('разбирает адрес сервера вместе с портом, режимом и учётными данными', () => {
		expect(smtpOptions('smtp://mailpit:1025')).toMatchObject({
			host: 'mailpit',
			port: 1025,
			secure: false
		});

		expect(smtpOptions('smtps://relay.example.org')).toMatchObject({
			host: 'relay.example.org',
			port: 465,
			secure: true
		});

		expect(smtpOptions('smtp://relay.example.org')).toMatchObject({ port: 587 });

		expect(smtpOptions('smtp://user%40crm:pa%3Ass@relay.example.org:2525')).toMatchObject({
			auth: { user: 'user@crm', pass: 'pa:ss' }
		});
	});

	it('ставит сроки на соединение: неотвечающий сервер не держит проход цикла', () => {
		const options = smtpOptions('smtp://mailpit:1025');

		expect(options.connectionTimeout).toBeGreaterThan(0);
		expect(options.greetingTimeout).toBeGreaterThan(0);
		expect(options.socketTimeout).toBeGreaterThan(0);
	});
});
