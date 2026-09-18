/**
 * Кнопка «Демо: заявка с сайта»: приложение жмёт триггер имитатора CMS.
 *
 * Сцена обмена начинается не в CRM, а на сайте — и показывать её надо так же:
 * заявку подаёт имитатор, своим ключом обмена, в конверте контракта, а CRM
 * узнаёт о ней из обычного `POST /api/v1/applications`. Кнопка избавляет
 * показывающего от второго окна с формой имитатора, но ничего не заменяет:
 * нажать тот же триггер можно и со страницы самого имитатора.
 *
 * Направлением контракта это не является. У настоящей CMS такого адреса нет —
 * форму на ней заполняет посетитель, — поэтому кнопка живёт только на
 * демонстрационном стенде (`DEMO_MODE=true`) и только при заданном
 * `DEMO_CMS_TRIGGER_URL`. Ни заявку, ни взаимодействие этот модуль не создаёт:
 * он лишь просит чужую систему сделать то, что она делает и без нас.
 */
import type { ActorContext } from '../../actor';
import { getConfig } from '../../config';
import { ValidationError } from '../../errors';
import { requirePermission } from '../../rbac';
import { outboundTargetIssue } from '../outbound';

/** Сколько ждём имитатор: он стоит рядом, и ждать его дольше нечего. */
const TIMEOUT_MS = 5_000;

/** Набор формы, который жмёт кнопка: заявка вуза, а не физического лица. */
const FORM = 'b2b';

/** Что ответил имитатор: ключ поданной заявки и код, которым ответила ему CRM. */
export type DemoApplicationResult = {
	externalId: string;
	eventId: string;
	/** Код ответа CRM имитатору; `null` — CRM не ответила вовсе. */
	crmStatus: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Просит имитатор CMS подать заявку с сайта и возвращает то, что он ответил.
 *
 * Отказ имитатора — это `ValidationError` с его словами: показывающий стоит
 * перед экраном, и «что-то пошло не так» ему не поможет. Молча проглотить
 * отказ нельзя тем более — журнал обмена остался бы пустым, а кнопка выглядела
 * бы нажатой.
 */
export async function sendDemoApplication(ctx: ActorContext): Promise<DemoApplicationResult> {
	requirePermission(ctx, 'integrations.manage');

	const config = getConfig();

	if (!config.DEMO_MODE) {
		throw new ValidationError(
			'Заявку за сайт подаёт только демонстрационный стенд (DEMO_MODE=true): здесь заявки приходят из настоящей CMS'
		);
	}

	const url = config.DEMO_CMS_TRIGGER_URL;

	if (url === null) {
		throw new ValidationError(
			'Триггер имитатора CMS не задан: назовите его в DEMO_CMS_TRIGGER_URL (docs/deployment.md)'
		);
	}

	// То же правило, что и у остальных исходящих: адрес приходит из окружения
	// стенда, а идёт по нему сервер — изнутри сети развёртывания.
	const issue = await outboundTargetIssue(url);

	if (issue !== null) {
		throw new ValidationError(issue);
	}

	let response: Response;

	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
			body: JSON.stringify({ form: FORM }),
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (cause) {
		const name = cause instanceof Error ? cause.name : '';

		throw new ValidationError(
			name === 'TimeoutError' || name === 'AbortError'
				? `Имитатор CMS не ответил за ${TIMEOUT_MS / 1000} с`
				: `Имитатор CMS недоступен: ${cause instanceof Error ? cause.message : String(cause)}`
		);
	}

	const text = await response.text();
	let body: unknown;

	try {
		body = text === '' ? null : JSON.parse(text);
	} catch {
		body = text;
	}

	if (!response.ok) {
		const message =
			isRecord(body) && typeof body.message === 'string' ? body.message : `код ${response.status}`;

		throw new ValidationError(`Имитатор CMS отказался подавать заявку: ${message}`);
	}

	if (!isRecord(body) || typeof body.externalId !== 'string' || typeof body.eventId !== 'string') {
		throw new ValidationError('Имитатор CMS ответил не тем, чем отвечает триггер заявки');
	}

	const crm = isRecord(body.crm) ? body.crm : null;
	const crmStatus = typeof crm?.status === 'number' ? crm.status : null;

	if (crmStatus === null || crmStatus < 200 || crmStatus >= 300) {
		const error = typeof crm?.error === 'string' ? crm.error : `код ${String(crmStatus)}`;

		throw new ValidationError(
			`Имитатор CMS отправил заявку ${body.externalId}, но CRM её не приняла: ${error}`
		);
	}

	return { externalId: body.externalId, eventId: body.eventId, crmStatus };
}
