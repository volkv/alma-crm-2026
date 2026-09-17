/**
 * Начатый, но ещё не законченный вход.
 *
 * Между нажатием «Войти» и возвратом из каталога приложению надо помнить три
 * одноразовых значения (`state`, `nonce`, проверочный код PKCE) и путь, куда
 * человек шёл. Всё это лежит в Redis, а браузер носит только случайную ручку в
 * недолгой cookie: сами значения — это то, чем заход и защищён, и отдавать их
 * браузеру незачем.
 *
 * Запись одноразовая: `getdel` читает и удаляет её одним действием, поэтому
 * повторный возврат с тем же кодом сверять уже не с чем — а повторно
 * предъявленный код и есть его перехват.
 */
import { randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { getConfig } from '../config';
import { getRedis } from '../redis';
import type { LoginAttempt } from './oidc';

export const FLOW_COOKIE = 'lct_login';

/**
 * Сколько живёт начатый вход. Десять минут — это время найти пароль и набрать
 * код второго фактора в каталоге, а не половина рабочего дня: до возврата
 * запись ничем не защищена, кроме своей случайности, и лежать ей незачем.
 */
const FLOW_TTL_SECONDS = 10 * 60;

const flowKey = (id: string): string => `login_flow:${id}`;

/** Что приложение помнит о заходе, пока человек в каталоге. */
export type LoginFlow = LoginAttempt & {
	/** Куда вернуть человека после входа; уже проверенный путь внутри приложения. */
	next: string;
};

function cookieOptions(): { httpOnly: true; sameSite: 'lax'; path: '/'; secure: boolean } {
	return {
		httpOnly: true,
		// `lax`, а не `strict`: возврат из каталога — это переход с чужого
		// происхождения, и при `strict` браузер не прислал бы cookie вовсе.
		sameSite: 'lax',
		path: '/',
		secure: getConfig().ORIGIN.startsWith('https://')
	};
}

/** Складывает заход в Redis и выдаёт браузеру ручку к нему. */
export async function rememberFlow(cookies: Cookies, flow: LoginFlow): Promise<void> {
	const id = randomBytes(32).toString('base64url');

	await getRedis().set(flowKey(id), JSON.stringify(flow), 'EX', FLOW_TTL_SECONDS);

	cookies.set(FLOW_COOKIE, id, { ...cookieOptions(), maxAge: FLOW_TTL_SECONDS });
}

/**
 * Забирает заход обратно — один раз. Возвращает `null`, если ручки нет, запись
 * истекла или её уже забрали: во всех трёх случаях заканчивать нечего.
 */
export async function takeFlow(cookies: Cookies): Promise<LoginFlow | null> {
	const id = cookies.get(FLOW_COOKIE);

	cookies.delete(FLOW_COOKIE, cookieOptions());

	if (id === undefined) {
		return null;
	}

	const raw = await getRedis().getdel(flowKey(id));

	if (raw === null) {
		return null;
	}

	const parsed: unknown = JSON.parse(raw);

	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as LoginFlow).state !== 'string' ||
		typeof (parsed as LoginFlow).nonce !== 'string' ||
		typeof (parsed as LoginFlow).codeVerifier !== 'string' ||
		typeof (parsed as LoginFlow).next !== 'string'
	) {
		return null;
	}

	return parsed as LoginFlow;
}

/** Адрес, на который каталог возвращает браузер. Всегда от объявленного происхождения. */
export function callbackUrl(): string {
	// Не от `event.url`: за обратным прокси там стоит внутренний адрес, и каталог
	// отверг бы такой `redirect_uri` как незарегистрированный. `ORIGIN` —
	// единственное место, где сказано, как приложение видно снаружи.
	return new URL('/login/callback', getConfig().ORIGIN).toString();
}
