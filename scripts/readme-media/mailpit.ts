/**
 * Почтовая ловушка стенда (Mailpit) для кадров, на которых видно само письмо.
 *
 * Письмо из карточки дела уходит не в интернет, а в ящик Mailpit, и увидеть его
 * можно только там: веб-интерфейс и API ловушки — это и есть «почтовый клиент»
 * стенда. Кадр ищет своё письмо через API и открывает его той же страницей
 * браузера, которой снимает, — отдельного клиента у съёмки нет.
 *
 * Адрес — `MAILPIT_URL`. По умолчанию `127.0.0.1`, а не `localhost`: на Windows
 * `localhost` сначала разрешается в `::1`, а контейнер слушает только IPv4, и
 * запрос висит до тайм-аута вместо того, чтобы сразу получить ответ.
 */

export const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/+$/, '');

/** Строка списка писем Mailpit: ровно те поля, по которым кадр узнаёт своё. */
type MailpitMessage = { ID: string; Subject: string };

type MailpitList = { messages: MailpitMessage[] };

/** Сколько последних писем смотреть: кадр ищет своё среди только что пришедших. */
const RECENT = 20;

async function recentMessages(): Promise<MailpitMessage[]> {
	let response: Response;

	try {
		response = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=${RECENT}`, {
			signal: AbortSignal.timeout(5_000)
		});
	} catch (failure) {
		const reason = failure instanceof Error ? failure.message : String(failure);

		throw new Error(`почтовая ловушка недоступна: ${MAILPIT_URL} — ${reason}`, { cause: failure });
	}

	if (!response.ok) {
		throw new Error(`почтовая ловушка недоступна: ${MAILPIT_URL} ответил ${response.status}`);
	}

	const body = (await response.json()) as MailpitList;

	return body.messages;
}

/**
 * Что уже лежит в ящике — снимок до отправки.
 *
 * Кадр узнаёт своё письмо не по времени, а по тому, что его раньше не было:
 * часы стенда и машины, с которой снимают, могут расходиться, а ящик общий, и
 * одинаковых по теме писем в нём накапливается много.
 *
 * Заодно это проверка, что ловушка вообще отвечает: до нажатия кнопки, а не
 * после, — чтобы кадр без Mailpit падал сразу и ничего на стенде не отправлял.
 */
export async function mailboxSnapshot(): Promise<Set<string>> {
	return new Set((await recentMessages()).map((message) => message.ID));
}

/**
 * Дождаться нового письма с темой, начинающейся с `subjectPrefix`, и вернуть
 * его идентификатор.
 *
 * Опрос, а не пауза: письмо уходит из приложения по SMTP, и сколько это займёт
 * на занятой машине, заранее не сказать: на стенде разработки первое письмо ещё
 * и ждёт, пока сервер соберёт модули отправки. Предел — чтобы кадр честно упал,
 * а не висел, если письмо так и не пришло.
 */
export async function waitForNewMail(
	before: Set<string>,
	subjectPrefix: string,
	timeoutMs = 60_000
): Promise<string> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const fresh = (await recentMessages()).find(
			(message) => !before.has(message.ID) && message.Subject.startsWith(subjectPrefix)
		);

		if (fresh !== undefined) {
			return fresh.ID;
		}

		await new Promise((resolve) => setTimeout(resolve, 300));
	}

	throw new Error(
		`письмо «${subjectPrefix}…» не пришло в почтовую ловушку за ${timeoutMs / 1000} с`
	);
}

/** Адрес письма целиком — HTML-часть, как её показывает почтовый клиент. */
export function mailpitView(id: string): string {
	return `${MAILPIT_URL}/view/${id}.html`;
}
