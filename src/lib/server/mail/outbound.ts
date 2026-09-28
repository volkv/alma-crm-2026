/**
 * Письма людям вне системы: контактным лицам вуза, с разметкой и вложениями.
 *
 * От уведомлений отличаются адресатом, и отсюда всё остальное. Уведомление
 * уходит сотруднику, у которого есть вход в систему; это письмо — человеку
 * снаружи, по адресу из справочника, и отозвать его нельзя. Поэтому перед
 * каждым письмом стоит песочница ({@link outboundMailPolicy}): пока
 * развёртывание не сказало явно, что доставка настоящая, письмо уходит только
 * на почтовую ловушку, а на чужой сервер не уходит вовсе.
 */
import { z } from 'zod';
import { formatBytes } from '$lib/format';
import { getConfig, type AppConfig } from '../config';
import { describeMailFailure, mailTransport } from './transport';

export type OutboundAttachment = { filename: string; content: Buffer; contentType: string };
export type OutboundRecipient = { name: string | null; email: string };
export type OutboundMail = {
	to: OutboundRecipient[];
	subject: string;
	html: string;
	text: string;
	attachments: OutboundAttachment[];
	replyTo?: string | null;
};
export type OutboundOutcome =
	| { status: 'sent'; messageId: string }
	| { status: 'refused'; error: string } // песочница, не настроен SMTP, превышен размер — до соединения
	| { status: 'failed'; error: string }; // сервер не принял

/** Предел суммарного размера вложений: у типовых релеев предел письма 10–25 МБ. */
export const MAX_OUTBOUND_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

/**
 * Узлы почтовой ловушки: письмо, отправленное сюда, наружу не уходит.
 *
 * `mailpit` — имя сервиса Mailpit в сети Compose (стек и стенд), остальное —
 * петля машины разработчика, где Mailpit опубликован на порту 1025. Список
 * закрытый и по имени, а не по «похоже на локальное»: приватная сеть — это
 * и корпоративный релей заказчика, а он доставляет по-настоящему.
 */
export const MAIL_TRAP_HOSTS: readonly string[] = ['mailpit', 'localhost', '127.0.0.1', '::1'];

export type OutboundMailPolicy = {
	/** Заданы ли `SMTP_URL` и `SMTP_FROM`. */
	configured: boolean;
	/** Наружу письмо не уйдёт: либо песочница, либо сервер и есть ловушка. */
	sandboxed: boolean;
	/** Можно ли отправлять прямо сейчас. */
	allowed: boolean;
	/** Почему нельзя — словами для экрана; `null`, если можно. */
	reason: string | null;
};

/** Узел почтового сервера из адреса: без скобок IPv6 и без различия регистра. */
function smtpHost(url: string): string {
	return new URL(url).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

/**
 * Можно ли сейчас отправить письмо наружу и куда оно попадёт.
 *
 * Отдельной функцией, а не внутри отправки: окно письма показывает ответ
 * заранее — плашку «попадёт в ловушку стенда» или причину запрета, — чтобы
 * человек не узнавал о песочнице из отказа после нажатия «Отправить».
 */
export function outboundMailPolicy(): OutboundMailPolicy {
	return policyFor(getConfig());
}

function policyFor(config: AppConfig): OutboundMailPolicy {
	if (config.SMTP_URL === null || config.SMTP_FROM === null) {
		return {
			configured: false,
			sandboxed: !config.MAIL_EXTERNAL_DELIVERY,
			allowed: false,
			reason:
				'Почтовый сервер не настроен: задайте SMTP_URL и SMTP_FROM в окружении установки (docs/deployment.md)'
		};
	}

	const trap = MAIL_TRAP_HOSTS.includes(smtpHost(config.SMTP_URL));

	if (config.MAIL_EXTERNAL_DELIVERY || trap) {
		return { configured: true, sandboxed: trap, allowed: true, reason: null };
	}

	return {
		configured: true,
		sandboxed: true,
		allowed: false,
		reason:
			'Настоящая доставка писем выключена (MAIL_EXTERNAL_DELIVERY), а почтовый сервер установки — не ловушка стенда: письмо не отправлено, чтобы не уйти живому адресату (docs/deployment.md)'
	};
}

const emailSchema = z.email();

/**
 * Одна попытка отправки. Исключений не бросает, как и канал уведомлений:
 * отказ и неудача — обычные исходы, и что показать человеку, решает вызывающий.
 *
 * Всё, что можно проверить без сервера, проверяется до соединения: письмо,
 * которое не имеет права уйти, не должно даже начинать разговор по SMTP.
 */
export async function sendOutboundMail(mail: OutboundMail): Promise<OutboundOutcome> {
	const config = getConfig();
	const policy = policyFor(config);

	// Адреса рядом с `allowed` — ради типов: без них политика и так не разрешает.
	if (!policy.allowed || config.SMTP_URL === null || config.SMTP_FROM === null) {
		return { status: 'refused', error: policy.reason ?? 'Почтовый сервер не настроен' };
	}

	if (mail.to.length === 0) {
		return { status: 'refused', error: 'Не указан ни один получатель' };
	}

	const invalid = mail.to.filter((recipient) => !emailSchema.safeParse(recipient.email).success);

	if (invalid.length > 0) {
		return {
			status: 'refused',
			error: `Адрес получателя не похож на адрес электронной почты: ${invalid.map((recipient) => recipient.email).join(', ')}`
		};
	}

	const attachmentsBytes = mail.attachments.reduce(
		(total, attachment) => total + attachment.content.byteLength,
		0
	);

	if (attachmentsBytes > MAX_OUTBOUND_ATTACHMENTS_BYTES) {
		return {
			status: 'refused',
			error: `Вложения весят ${formatBytes(attachmentsBytes)}, а письмо принимает не больше ${formatBytes(MAX_OUTBOUND_ATTACHMENTS_BYTES)}: почтовый сервер отбил бы его целиком`
		};
	}

	try {
		const info: { messageId?: unknown } = await mailTransport(config.SMTP_URL).sendMail({
			from: config.SMTP_FROM,
			// Имя отдельным полем, а не строкой `Имя <адрес>`: кавычки и запятые в
			// ФИО из справочника тогда кодирует клиент, а не склейка.
			to: mail.to.map((recipient) =>
				recipient.name === null || recipient.name.trim() === ''
					? recipient.email
					: { name: recipient.name.trim(), address: recipient.email }
			),
			...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
			subject: mail.subject,
			html: mail.html,
			text: mail.text,
			// Кириллица в имени файла кодируется клиентом (RFC 2231), так что имя
			// передаётся как есть — «Программа.pdf», а не транслитом.
			attachments: mail.attachments.map((attachment) => ({
				filename: attachment.filename,
				content: attachment.content,
				contentType: attachment.contentType
			}))
		});

		return { status: 'sent', messageId: typeof info.messageId === 'string' ? info.messageId : '' };
	} catch (error) {
		return { status: 'failed', error: describeMailFailure(error) };
	}
}
