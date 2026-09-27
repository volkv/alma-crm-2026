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
import { getExchangeSettings } from '../settings';

/**
 * Сколько ждём имитатор. Он стоит рядом, но ответ его — это ответ CRM ему же:
 * имитатор сам ждёт CRM до десяти секунд (`mocks/shared/crm.ts`,
 * `DEFAULT_CRM_TIMEOUT_MS`). Ждать его меньше значило бы получить «имитатор не
 * ответил» там, где имитатор как раз ждал нас, — и искать поломку не там.
 */
const TIMEOUT_MS = 15_000;

/** Наборы формы имитатора: заявка вуза (`b2b`) или физического лица (`b2c`). */
export const DEMO_APPLICATION_FORMS = ['b2b', 'b2c'] as const;

export type DemoApplicationForm = (typeof DEMO_APPLICATION_FORMS)[number];

/** Что ответил имитатор: ключ поданной заявки и чем её приняла CRM. */
export type DemoApplicationResult = {
	externalId: string;
	eventId: string;
	/** Код ответа CRM имитатору. */
	crmStatus: number;
	/** Итог приёма: `created`, `updated` или `unchanged`; `null` — CRM его не назвала. */
	result: string | null;
	/** Взаимодействие, которым заявка стала; `null` — CRM его не назвала. */
	interactionId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Просит имитатор CMS подать заявку с сайта и возвращает то, что он ответил.
 *
 * Каждое нажатие — новая заявка с новым ключом (`fresh`): кнопка показывает, как
 * заявка становится делом, и повтор одной и той же заявки набора приходил бы в
 * CRM изменением уже заведённого дела, а не новым.
 *
 * Отказ — это `ValidationError` с объяснением, **чья** это поломка: имитатор
 * недоступен, имитатор отказал, или имитатор ответил, но сам не достучался до
 * CRM (частый случай на стенде, где приложение живёт не там, куда смотрит
 * `CRM_BASE_URL` имитатора). Показывающий стоит перед экраном, и «что-то пошло
 * не так» ему не поможет. Молча проглотить отказ нельзя тем более — журнал
 * обмена остался бы пустым, а кнопка выглядела бы нажатой.
 */
export async function sendDemoApplication(
	ctx: ActorContext,
	form: DemoApplicationForm
): Promise<DemoApplicationResult> {
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
			body: JSON.stringify({ form, fresh: true }),
			redirect: 'manual',
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (cause) {
		const name = cause instanceof Error ? cause.name : '';

		throw new ValidationError(
			name === 'TimeoutError' || name === 'AbortError'
				? `Имитатор CMS не ответил за ${TIMEOUT_MS / 1000} с: он доступен, но завис — посмотрите его журнал (${url.replace(/__send-application$/, '')})`
				: `Имитатор CMS недоступен по адресу ${url}: ${cause instanceof Error ? cause.message : String(cause)}`
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

	if (crmStatus === null) {
		// Имитатор ответил, но до CRM не дошёл: это адрес CRM у имитатора, а не
		// сам имитатор и не приём заявки.
		const error = typeof crm?.error === 'string' ? crm.error : 'ответа нет';
		const target = typeof crm?.url === 'string' ? crm.url : 'адрес CRM имитатора';

		throw new ValidationError(
			`Имитатор CMS ответил, но сам не достучался до CRM (${target}): ${error}. Проверьте CRM_BASE_URL имитатора — он должен вести в это приложение`
		);
	}

	const reply = isRecord(crm?.body) ? crm.body : null;

	if (crmStatus < 200 || crmStatus >= 300) {
		const reason = typeof reply?.message === 'string' ? `: ${reply.message}` : '';

		throw new ValidationError(
			`Имитатор CMS отправил заявку ${body.externalId}, но CRM её не приняла — код ${crmStatus}${reason}`
		);
	}

	const data = isRecord(reply?.data) ? reply.data : null;

	return {
		externalId: body.externalId,
		eventId: body.eventId,
		crmStatus,
		result: typeof reply?.result === 'string' ? reply.result : null,
		interactionId: typeof data?.interactionId === 'string' ? data.interactionId : null
	};
}

/* ------------------------------------------------ доступность имитаторов */

/**
 * Демо-переключатель «имитатор недоступен / доступен» на экране «Внешние
 * системы».
 *
 * Отказ и восстановление обмена — то, ради чего у обмена есть очередь,
 * повторы и кнопка «Повторить», — без него показать нечем: настоящие системы
 * на стенде не падают по заказу. Переключатель ставит имитатору сценарий
 * `mode: "offline"` (`docs/exchange-contract.md`, раздел 9): имитатор рвёт
 * соединение на каждом адресе контракта, CRM получает сетевой отказ и держит
 * сообщение в очереди повторов; `mode: "normal"` возвращает имитатор, и
 * следующий повтор доставляет то же сообщение.
 *
 * Отказ ставится со сроком (`ttlSeconds`, `DEMO_OFFLINE_TTL_SECONDS`): имитатор
 * общий для всего стенда, и показывающий, ушедший без «Вернуть сейчас»,
 * иначе оставил бы обмен сломанным всем, кто придёт после. По сроку имитатор
 * возвращается сам; вернуть раньше — та же кнопка. Сброс демонстрационных
 * данных тоже возвращает оба имитатора (`restoreDemoMocks`).
 *
 * Адрес управления — корень того узла, куда CRM доставляет сообщения этого
 * направления (адрес карточки заявки у CMS, адрес заведения группы у LMS):
 * недоступным становится ровно тот, кому CRM пишет. Управление имитатором
 * закрыто токеном (`MOCK_CONTROL_TOKEN`), и приложение предъявляет тот же,
 * что задан имитаторам. Живёт всё это только на демонстрационном стенде
 * (`DEMO_MODE=true`): у настоящей CMS адреса `__scenario` нет.
 */

export const DEMO_MOCK_SYSTEMS = ['cms', 'lms'] as const;

export type DemoMockSystem = (typeof DEMO_MOCK_SYSTEMS)[number];

const MOCK_TITLES: Record<DemoMockSystem, string> = {
	cms: 'Имитатор CMS',
	lms: 'Имитатор LMS'
};

/** Сколько имитатор остаётся недоступным, если его не вернуть раньше. */
export const DEMO_OFFLINE_TTL_SECONDS = 5 * 60;

/** Состояние имитатора для переключателя. */
export type DemoMockState = {
	system: DemoMockSystem;
	title: string;
	/** `true` — отвечает, `false` — рвёт соединения; `null` — не узнали. */
	available: boolean | null;
	/** Когда недоступный имитатор вернётся сам (ISO); `null` — срока нет или доступен. */
	returnsAt: string | null;
	/** Почему состояние не узнать или не переключить; `null` — всё в порядке. */
	problem: string | null;
};

/** Сколько ждём управление имитатора: оно отвечает сразу, без похода в CRM. */
const CONTROL_TIMEOUT_MS = 3_000;

/** Адрес управления сценарием имитатора; строка — почему его нет. */
async function scenarioUrl(system: DemoMockSystem): Promise<URL | string> {
	const settings = await getExchangeSettings();
	const target = system === 'cms' ? settings.cms.statusUrl : settings.lms.groupsUrl;

	if (target === null) {
		return 'адрес доставки этого направления не задан';
	}

	// В адресе карточки заявки стоит `{externalId}` — разбору он не мешает,
	// а от адреса нужен только узел.
	return new URL('/__scenario', target.replace('{externalId}', 'x'));
}

/** Сценарий имитатора: прочитать (`{}`) или задать режим. */
async function postScenario(
	system: DemoMockSystem,
	body: Record<string, unknown>
): Promise<{ available: boolean; returnsAt: string | null } | { problem: string }> {
	const url = await scenarioUrl(system);

	if (typeof url === 'string') {
		return { problem: url };
	}

	const issue = await outboundTargetIssue(url.href);

	if (issue !== null) {
		return { problem: issue };
	}

	const token = getConfig().MOCK_CONTROL_TOKEN;
	let response: Response;

	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json; charset=utf-8',
				accept: 'application/json',
				...(token === null ? {} : { 'x-mock-control': token })
			},
			body: JSON.stringify(body),
			redirect: 'manual',
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS)
		});
	} catch (cause) {
		return {
			problem: `управление имитатора не отвечает (${url.origin}): ${cause instanceof Error ? cause.message : String(cause)}`
		};
	}

	const text = await response.text();
	let parsed: unknown;

	try {
		parsed = text === '' ? null : JSON.parse(text);
	} catch {
		parsed = text;
	}

	if (!response.ok) {
		const message =
			isRecord(parsed) && typeof parsed.message === 'string'
				? parsed.message
				: `код ${response.status}`;

		return {
			problem:
				response.status === 403
					? `имитатор не принял токен управления: задайте приложению тот же MOCK_CONTROL_TOKEN, что и имитаторам (${message})`
					: `имитатор отказал: ${message}`
		};
	}

	const scenario = isRecord(parsed) && isRecord(parsed.scenario) ? parsed.scenario : null;

	if (
		scenario === null ||
		(scenario.mode !== 'normal' && scenario.mode !== 'offline') ||
		(scenario.expiresAt !== null && typeof scenario.expiresAt !== 'string')
	) {
		return { problem: 'имитатор ответил не тем, чем отвечает управление сценарием' };
	}

	return {
		available: scenario.mode === 'normal',
		returnsAt: scenario.mode === 'offline' ? scenario.expiresAt : null
	};
}

/** Можно ли показывать переключатель: только демонстрационный стенд. */
export function demoMocksEnabled(): boolean {
	return getConfig().DEMO_MODE;
}

/** Состояние обоих имитаторов — для экрана «Внешние системы». */
export async function readDemoMocks(ctx: ActorContext): Promise<DemoMockState[]> {
	requirePermission(ctx, 'integrations.manage');

	if (!demoMocksEnabled()) {
		return [];
	}

	return Promise.all(
		DEMO_MOCK_SYSTEMS.map(async (system) => {
			// Пустое тело сценария ничего не меняет и возвращает текущий.
			const outcome = await postScenario(system, {});

			return {
				system,
				title: MOCK_TITLES[system],
				available: 'available' in outcome ? outcome.available : null,
				returnsAt: 'available' in outcome ? outcome.returnsAt : null,
				problem: 'problem' in outcome ? outcome.problem : null
			};
		})
	);
}

/** Сделать имитатор недоступным или вернуть его. */
export async function setDemoMockAvailability(
	ctx: ActorContext,
	system: DemoMockSystem,
	available: boolean
): Promise<void> {
	requirePermission(ctx, 'integrations.manage');

	if (!demoMocksEnabled()) {
		throw new ValidationError(
			'Доступность имитаторов переключает только демонстрационный стенд (DEMO_MODE=true)'
		);
	}

	const outcome = await postScenario(
		system,
		available
			? { mode: 'normal', ttlSeconds: null }
			: { mode: 'offline', ttlSeconds: DEMO_OFFLINE_TTL_SECONDS }
	);

	if ('problem' in outcome) {
		throw new ValidationError(`${MOCK_TITLES[system]}: ${outcome.problem}`);
	}
}

/**
 * Вернуть оба имитатора в `normal` — шаг сброса демонстрационных данных:
 * стенд после сброса обязан обмениваться, а не рвать соединения по отказу,
 * оставленному прошлым показом. Право проверяет сам сброс.
 *
 * Возвращает, что не удалось, словами — по строке на имитатор; пустой список —
 * оба вернулись. Сброс данных из-за этого не откатывается: данные уже залиты,
 * а недоступный имитатор вернётся сам по сроку.
 */
export async function restoreDemoMocks(): Promise<string[]> {
	const outcomes = await Promise.all(
		DEMO_MOCK_SYSTEMS.map(async (system) => ({
			system,
			outcome: await postScenario(system, { mode: 'normal', ttlSeconds: null })
		}))
	);

	return outcomes.flatMap(({ system, outcome }) =>
		'problem' in outcome ? [`${MOCK_TITLES[system]}: ${outcome.problem}`] : []
	);
}
