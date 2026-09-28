/**
 * Соединение с почтовым сервером — одно на всё приложение.
 *
 * Своего почтового сервера у приложения нет и быть не должно — доставка письма
 * это чужая работа со своими очередями, репутацией отправителя и повторами.
 * Здесь остаётся одно соединение до `SMTP_URL` и один разговор по протоколу;
 * всё остальное — забота того сервера, чей адрес назвало развёртывание.
 *
 * Им пользуются и уведомления, и письма контактным лицам вуза: два клиента к
 * одному серверу держали бы вдвое больше соединений и закрывались бы порознь.
 *
 * Клиент создаётся лениво, как `db` и `redis`: модуль импортируется при сборке,
 * а соединение до чужого узла в момент сборки открывать нельзя.
 */
import { createTransport, type Transporter } from 'nodemailer';

/**
 * Сколько ждём почтовый сервер. Дольше — и проход цикла встанет на одном
 * адресе: тот же срок и по той же причине, что у доставки вебхука.
 */
export const SMTP_TIMEOUT_MS = 5_000;

/**
 * Адрес почтового сервера в параметры соединения.
 *
 * Разбирается здесь, а не отдаётся клиенту строкой, ровно ради сроков: без них
 * неотвечающий сервер держит проход цикла столько, сколько сочтёт нужным ядро
 * системы, — а проход занят замком, и за ним стоит вся остальная фоновая
 * работа. Порты по умолчанию те же, что у самого клиента: 465 под защищённое
 * соединение, 587 под обычное.
 */
export function smtpOptions(url: string): {
	host: string;
	port: number;
	secure: boolean;
	auth?: { user: string; pass: string };
	connectionTimeout: number;
	greetingTimeout: number;
	socketTimeout: number;
} {
	const parsed = new URL(url);
	const secure = parsed.protocol === 'smtps:';

	return {
		host: parsed.hostname,
		port: parsed.port === '' ? (secure ? 465 : 587) : Number(parsed.port),
		secure,
		...(parsed.username === ''
			? {}
			: {
					auth: {
						user: decodeURIComponent(parsed.username),
						pass: decodeURIComponent(parsed.password)
					}
				}),
		connectionTimeout: SMTP_TIMEOUT_MS,
		greetingTimeout: SMTP_TIMEOUT_MS,
		socketTimeout: SMTP_TIMEOUT_MS
	};
}

let transport: Transporter | null = null;
/** Адрес, для которого собран текущий клиент: правка настройки не переживает кэша. */
let transportUrl: string | null = null;

/** Клиент почтового сервера по адресу; соединение откроется только на первом письме. */
export function mailTransport(url: string): Transporter {
	if (transport === null || transportUrl !== url) {
		transport?.close();
		transport = createTransport(smtpOptions(url));
		transportUrl = url;
	}

	return transport;
}

/** Закрыть соединения с почтовым сервером: зовут проверки, чтобы не держать процесс. */
export function closeMailTransport(): void {
	transport?.close();
	transport = null;
	transportUrl = null;
}

/** Причина отказа почтового сервера словами, по-русски и без стека. */
export function describeMailFailure(error: unknown): string {
	if (error instanceof Error) {
		const cause: unknown = (error as { code?: unknown }).code;

		return typeof cause === 'string'
			? `Почтовый сервер не принял письмо: ${cause}`
			: `Почтовый сервер не принял письмо: ${error.message}`;
	}

	return `Почтовый сервер не принял письмо: ${String(error)}`;
}
