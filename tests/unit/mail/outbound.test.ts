/**
 * Песочница исходящей почты и то, что отсекается до соединения.
 *
 * Письмо контактному лицу вуза уходит живому человеку и не отзывается.
 * Поэтому главное здесь — что без явного `MAIL_EXTERNAL_DELIVERY=true` письмо
 * попадает только в ловушку, а на чужой сервер не начинает даже разговора:
 * клиент почты подменён, и проверяется, что его не создавали вовсе.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let smtpUrl: string | null = null;
let smtpFrom: string | null = null;
let externalDelivery = false;

vi.mock('$lib/server/config', () => ({
	getConfig: () => ({
		SMTP_URL: smtpUrl,
		SMTP_FROM: smtpFrom,
		MAIL_EXTERNAL_DELIVERY: externalDelivery
	})
}));

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() }));

vi.mock('nodemailer', () => ({ createTransport }));

const { MAX_OUTBOUND_ATTACHMENTS_BYTES, outboundMailPolicy, sendOutboundMail } =
	await import('$lib/server/mail/outbound');
const { closeMailTransport } = await import('$lib/server/mail/transport');

const MAIL = {
	to: [{ name: 'Иванова Мария', email: 'contact@university.example' }],
	subject: 'Информация о программах',
	html: '<p>Текст</p>',
	text: 'Текст',
	attachments: [
		{ filename: 'Программа.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }
	]
};

beforeEach(() => {
	closeMailTransport();
	smtpUrl = 'smtp://mailpit:1025';
	smtpFrom = 'crm@example.org';
	externalDelivery = false;
	createTransport.mockClear();
	sendMail.mockReset();
	sendMail.mockResolvedValue({ messageId: '<m1@example.org>' });
});

describe('песочница', () => {
	it.each([
		'smtp://mailpit:1025',
		'smtp://localhost:1025',
		'smtp://127.0.0.1:1025',
		'smtp://[::1]:1025'
	])('пускает письмо в ловушку %s', async (url) => {
		smtpUrl = url;

		expect(outboundMailPolicy()).toEqual({
			configured: true,
			sandboxed: true,
			allowed: true,
			reason: null
		});
		expect(await sendOutboundMail(MAIL)).toEqual({
			status: 'sent',
			messageId: '<m1@example.org>'
		});
	});

	it('на внешний сервер без MAIL_EXTERNAL_DELIVERY не отправляет и не соединяется', async () => {
		smtpUrl = 'smtp://relay.example.org:587';

		const policy = outboundMailPolicy();

		expect(policy.allowed).toBe(false);
		expect(policy.reason).toContain('MAIL_EXTERNAL_DELIVERY');

		const outcome = await sendOutboundMail(MAIL);

		expect(outcome.status).toBe('refused');
		expect(createTransport).not.toHaveBeenCalled();
		expect(sendMail).not.toHaveBeenCalled();
	});

	it('с MAIL_EXTERNAL_DELIVERY=true доставляет на внешний сервер', async () => {
		smtpUrl = 'smtp://relay.example.org:587';
		externalDelivery = true;

		expect(outboundMailPolicy()).toMatchObject({ allowed: true, sandboxed: false });
		expect((await sendOutboundMail(MAIL)).status).toBe('sent');
	});

	it('без SMTP_URL и SMTP_FROM отказывает и называет переменные', async () => {
		smtpUrl = null;

		expect(outboundMailPolicy()).toMatchObject({ configured: false, allowed: false });

		const outcome = await sendOutboundMail(MAIL);

		expect(outcome).toMatchObject({
			status: 'refused',
			error: expect.stringContaining('SMTP_URL')
		});
		expect(createTransport).not.toHaveBeenCalled();
	});
});

describe('проверки до соединения', () => {
	it('без получателей не отправляет', async () => {
		expect((await sendOutboundMail({ ...MAIL, to: [] })).status).toBe('refused');
		expect(createTransport).not.toHaveBeenCalled();
	});

	it('вложения сверх предела не отправляет', async () => {
		const big = Buffer.alloc(MAX_OUTBOUND_ATTACHMENTS_BYTES + 1);
		const outcome = await sendOutboundMail({
			...MAIL,
			attachments: [{ filename: 'big.pdf', content: big, contentType: 'application/pdf' }]
		});

		expect(outcome.status).toBe('refused');
		expect(createTransport).not.toHaveBeenCalled();
	});

	it('отказ сервера — исход, а не исключение', async () => {
		sendMail.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));

		expect(await sendOutboundMail(MAIL)).toEqual({
			status: 'failed',
			error: 'Почтовый сервер не принял письмо: ECONNREFUSED'
		});
	});

	it('передаёт имя вложения как есть, с кириллицей', async () => {
		await sendOutboundMail(MAIL);

		expect(sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: [{ name: 'Иванова Мария', address: 'contact@university.example' }],
				attachments: [expect.objectContaining({ filename: 'Программа.pdf' })]
			})
		);
	});
});
