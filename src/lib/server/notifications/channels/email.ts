/**
 * Канал «почта»: настоящая отправка по SMTP.
 *
 * Соединение общее с остальной почтой приложения (`$lib/server/mail/transport`);
 * здесь — только то, что делает письмо уведомлением: кому и с каким текстом.
 */
import { getConfig } from '../../config';
import { describeMailFailure, mailTransport } from '../../mail/transport';
import type { NotificationMessage } from '../message';
import type { ChannelOutcome, NotificationRecipient } from './index';

export { SMTP_TIMEOUT_MS, closeMailTransport, smtpOptions } from '../../mail/transport';

/**
 * Одна попытка отправки. Исключений не бросает: неудача — обычный исход
 * доставки, и решение о повторе принимает наблюдатель, а не обработчик ошибки.
 */
export async function sendEmail(
	recipient: NotificationRecipient,
	message: NotificationMessage
): Promise<ChannelOutcome> {
	const config = getConfig();

	if (config.SMTP_URL === null || config.SMTP_FROM === null) {
		return {
			status: 'failed',
			error:
				'Почтовый сервер не настроен: задайте SMTP_URL и SMTP_FROM в окружении установки (docs/deployment.md)'
		};
	}

	if (recipient.email === null) {
		return { status: 'failed', error: 'У получателя не указан адрес электронной почты' };
	}

	try {
		await mailTransport(config.SMTP_URL).sendMail({
			from: config.SMTP_FROM,
			to: recipient.email,
			subject: message.subject,
			text: message.text
		});

		return { status: 'sent', error: null };
	} catch (error) {
		return { status: 'failed', error: describeMailFailure(error) };
	}
}
