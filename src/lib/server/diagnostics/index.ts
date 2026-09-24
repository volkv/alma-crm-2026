/**
 * Самодиагностика связей: с чем система соединяется, зачем и отвечает ли оно
 * сейчас.
 *
 * Обещание продукта — работа в закрытой сети: локальные зависимости стоят
 * рядом с приложением, связи с CMS и системой обучения разрешены внутри сети
 * заказчика, а выход в интернет нужен только отключаемым внешним источникам.
 * Страница «Связи и зависимости» показывает это на живой установке, а не
 * словами в документации.
 *
 * Правила проверки:
 * - каждая проверка ограничена {@link PROBE_TIMEOUT_MS}: мёртвая связь не
 *   держит страницу дольше пары секунд;
 * - при открытии страницы наружу не ходит ничто. Dadata и сайты вузов только
 *   называются вместе с состоянием флага; выход в интернет проверяется
 *   отдельной кнопкой ({@link checkExternalSources});
 * - адрес на экран попадает без учётных данных и параметров
 *   (`displayAddress`), текст отказа — без них же (`hideCredentials`).
 */
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import type { ActorContext } from '../actor';
import { rebaseEndpoint } from '../auth/oidc';
import { getConfig } from '../config';
import { pingDatabase } from '../db';
import { pingStorage } from '../documents/storage';
import { isDadataConfigured } from '../enrichment/dadata';
import { outboundTargetIssue } from '../integrations/outbound';
import { getExchangeSettings, getLmsSettings } from '../integrations/settings';
import { requirePermission } from '../rbac';
import { pingRedis } from '../redis';
import { getSetting } from '../settings';
import {
	displayAddress,
	hideCredentials,
	isOfflineReady,
	type DiagnosticLink,
	type DiagnosticsReport,
	type LinkKind,
	type LinkState
} from './report';

/** Сколько ждём одну связь. Локальная зависимость, не ответившая за это время, для человека лежит. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Узел Dadata, к которому ходит поиск реквизитов (`enrichment/dadata.ts`). */
export const DADATA_HOST = 'suggestions.dadata.ru';

const DEFAULT_PORTS: Record<string, number> = {
	'http:': 80,
	'https:': 443,
	'smtp:': 25,
	'smtps:': 465
};

class ProbeTimeout extends Error {
	constructor() {
		super(`Не ответила за ${PROBE_TIMEOUT_MS / 1000} с`);
		this.name = 'ProbeTimeout';
	}
}

/**
 * Проверка под таймаутом. Сигнал отдаётся проверке, чтобы запрос по сети
 * оборвался вместе с ожиданием; у клиентов базы и Redis своего сигнала нет, и
 * для них таймаут обрывает только ожидание — их собственные потолки короче
 * минуты и соединение они не держат.
 */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;

	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new ProbeTimeout());
		}, PROBE_TIMEOUT_MS);
	});

	try {
		return await Promise.race([run(controller.signal), expired]);
	} finally {
		clearTimeout(timer);
	}
}

function failureText(error: unknown): string {
	if (error instanceof ProbeTimeout) {
		return error.message;
	}

	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		// `fetch` прячет настоящую причину (`ECONNREFUSED`, неразрешившееся имя)
		// в `cause`; уже пересказанную в тексте повторять незачем.
		const cause =
			error.cause instanceof Error && !error.message.includes(error.cause.message)
				? `: ${error.cause.message}`
				: '';
		const text = `${error.message}${cause}`;

		return hideCredentials(typeof code === 'string' ? `${code} — ${text}` : text);
	}

	return hideCredentials(String(error));
}

/** Проверка с замером: отказ связи — это состояние строки, а не ошибка страницы. */
async function probe(run: (signal: AbortSignal) => Promise<void>): Promise<LinkState> {
	const started = performance.now();

	try {
		await withTimeout(run);

		return { status: 'ok', detail: null, latencyMs: Math.round(performance.now() - started) };
	} catch (error) {
		return { status: 'failed', detail: failureText(error), latencyMs: null };
	}
}

/** TCP-соединение с узлом и порт адреса: без запроса, только «принимает ли». */
function tcpConnect(host: string, port: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port });
		const abort = () => socket.destroy(new ProbeTimeout());

		signal.addEventListener('abort', abort, { once: true });
		socket.once('connect', () => {
			signal.removeEventListener('abort', abort);
			// Разрыв сразу, а не `end()`: после вежливого закрытия узел ещё может
			// сбросить соединение, и эта ошибка пришла бы уже без слушателя.
			socket.destroy();
			resolve();
		});
		socket.once('error', (error) => {
			signal.removeEventListener('abort', abort);
			socket.destroy();
			reject(error);
		});
	});
}

function portOf(url: URL): number {
	if (url.port !== '') {
		return Number(url.port);
	}

	const port = DEFAULT_PORTS[url.protocol];

	if (port === undefined) {
		throw new Error(`Не знаю порта по умолчанию для схемы ${url.protocol}`);
	}

	return port;
}

async function fetchOk(url: string, signal: AbortSignal): Promise<Response> {
	const response = await fetch(url, { signal, headers: { accept: 'application/json' } });

	if (!response.ok) {
		throw new Error(`Ответ ${response.status}`);
	}

	return response;
}

function link(
	id: string,
	name: string,
	purpose: string,
	kind: LinkKind,
	address: string | null,
	state: LinkState
): DiagnosticLink {
	return { id, name, purpose, kind, address, state };
}

const NOT_CONFIGURED = (detail: string): LinkState => ({
	status: 'not_configured',
	detail,
	latencyMs: null
});

/** Каталог учётных записей: метаданные realm по адресу, которым ходит сервер. */
async function probeKeycloak(): Promise<{ address: string; state: LinkState }> {
	const { OIDC_ISSUER_URL, OIDC_PUBLIC_URL, OIDC_INTERNAL_URL } = getConfig();
	const discovery = `${OIDC_ISSUER_URL}/.well-known/openid-configuration`;
	const target =
		OIDC_INTERNAL_URL === undefined
			? discovery
			: rebaseEndpoint(discovery, OIDC_PUBLIC_URL, OIDC_INTERNAL_URL);

	const state = await probe(async (signal) => {
		const body: unknown = await (await fetchOk(target, signal)).json();
		const issuer =
			typeof body === 'object' && body !== null ? (body as { issuer?: unknown }).issuer : undefined;

		// Ответил не тот realm — вход всё равно не пройдёт: `iss` токена сверяется
		// с этим же адресом.
		if (issuer !== OIDC_ISSUER_URL) {
			throw new Error(`Каталог называет себя «${String(issuer)}», а ждём «${OIDC_ISSUER_URL}»`);
		}
	});

	return { address: displayAddress(target), state };
}

/**
 * Разрешённая связь с чужой системой внутри сети заказчика.
 *
 * Отдельного адреса здоровья у CMS и системы обучения по контракту нет, и
 * рабочие адреса принимают только подписанные сообщения, поэтому проверяется
 * соединение с узлом. До соединения — то же правило исходящих адресов, что и у
 * самого обмена: адрес, на который обмен не пойдёт, не должен выглядеть живым.
 */
async function probePeer(raw: string): Promise<LinkState> {
	const target = raw.replace('{externalId}', 'x');

	return probe(async (signal) => {
		const refusal = await outboundTargetIssue(target);

		if (refusal !== null) {
			throw new Error(refusal);
		}

		const url = new URL(target);

		await tcpConnect(url.hostname, portOf(url), signal);
	});
}

async function peerLink(
	id: string,
	name: string,
	purpose: string,
	raw: string | null,
	missing: string
): Promise<DiagnosticLink> {
	if (raw === null) {
		return link(id, name, purpose, 'allowed', null, NOT_CONFIGURED(missing));
	}

	return link(id, name, purpose, 'allowed', displayAddress(raw), await probePeer(raw));
}

/**
 * Проверить все связи установки. Внешние источники не проверяются — только
 * называются вместе с тем, включены ли они флагом.
 */
export async function runDiagnostics(ctx: ActorContext): Promise<DiagnosticsReport> {
	requirePermission(ctx, 'integrations.manage');

	const config = getConfig();
	const smtpUrl = config.SMTP_URL;

	const [database, redis, storage, keycloak, gotenberg, smtp, exchange, lms, enrichment] =
		await Promise.all([
			probe(() => pingDatabase()),
			probe(() => pingRedis()),
			probe(() => pingStorage()),
			probeKeycloak(),
			probe(async (signal) => {
				const base = config.GOTENBERG_URL.endsWith('/')
					? config.GOTENBERG_URL
					: `${config.GOTENBERG_URL}/`;

				await fetchOk(new URL('health', base).href, signal);
			}),
			smtpUrl === null
				? Promise.resolve(
						NOT_CONFIGURED(
							'SMTP_URL не задан: уведомления не уходят почтой, журнал доставок называет причину'
						)
					)
				: probe((signal) => {
						const url = new URL(smtpUrl);

						return tcpConnect(url.hostname, portOf(url), signal);
					}),
			getExchangeSettings(),
			getLmsSettings(),
			getSetting('enrichment')
		]);

	const peers = await Promise.all([
		peerLink(
			'cms',
			'CMS сайта',
			'Снимок статуса заявки уходит на сайт; заявки с сайта приходят сюда по ключу доступа',
			exchange.cms.statusUrl,
			'Адрес карточки заявки не задан: направление «статус на сайт» выключено'
		),
		peerLink(
			'lms-exchange',
			'Система обучения: учебные группы',
			'Заявка на учебную группу; результаты потока приходят сюда по ключу доступа',
			exchange.lms.groupsUrl,
			'Адрес заявки на группу не задан: кнопка создания группы недоступна'
		),
		peerLink(
			'lms-sync',
			'Система обучения: выгрузка',
			'Заход за выгрузкой по курсам и записанным слушателям',
			lms.baseUrl,
			'Адрес веб-сервиса не задан: выгрузка из системы обучения выключена'
		)
	]);

	const disabled: LinkState = {
		status: 'disabled',
		detail: 'Выключено флагом «Внешние источники» в общих настройках: карточку заполняют вручную',
		latencyMs: null
	};
	const dadataState: LinkState = !enrichment.enabled
		? disabled
		: !isDadataConfigured()
			? NOT_CONFIGURED('Флаг включён, но DADATA_API_KEY не задан: поиск реквизитов не настроен')
			: {
					status: 'not_checked',
					detail: 'Включено флагом. Выход в интернет проверяется кнопкой ниже',
					latencyMs: null
				};
	const sitesState: LinkState = enrichment.enabled
		? {
				status: 'not_checked',
				detail:
					'Включено флагом. Адрес берётся из карточки организации в момент запроса, проверять заранее нечего',
				latencyMs: null
			}
		: disabled;

	const links: DiagnosticLink[] = [
		link(
			'postgres',
			'PostgreSQL',
			'Все записи системы: организации, взаимодействия, журнал',
			'required',
			displayAddress(config.DATABASE_URL),
			database
		),
		link(
			'redis',
			'Redis',
			'Сессии, кэш сводки, счётчики блокировки входа',
			'required',
			displayAddress(config.REDIS_URL),
			redis
		),
		link(
			's3',
			'Хранилище файлов (S3)',
			`Документы и загруженные файлы, бакет «${config.S3_BUCKET}»`,
			'required',
			displayAddress(config.S3_ENDPOINT),
			storage
		),
		link(
			'keycloak',
			'Keycloak',
			'Вход сотрудников и роли',
			'required',
			keycloak.address,
			keycloak.state
		),
		link(
			'gotenberg',
			'Gotenberg',
			'Печать документов и отчётов в PDF',
			'required',
			displayAddress(config.GOTENBERG_URL),
			gotenberg
		),
		link(
			'smtp',
			'Почтовый сервер',
			'Уведомления руководителю о зависших взаимодействиях',
			'allowed',
			smtpUrl === null ? null : displayAddress(smtpUrl),
			smtp
		),
		...peers,
		link(
			'dadata',
			'Dadata',
			'Поиск реквизитов организации по названию или ИНН',
			'external',
			`https://${DADATA_HOST}`,
			dadataState
		),
		link(
			'sveden',
			'Сайты вузов',
			'Раздел «Сведения об образовательной организации» (/sveden) с сайта из карточки',
			'external',
			'https://<сайт организации>/sveden',
			sitesState
		)
	];

	return {
		checkedAt: new Date().toISOString(),
		links,
		offlineReady: isOfflineReady(links),
		outboundAllowList: config.OUTBOUND_ALLOWED_HOSTS.entries
	};
}

export type ExternalCheck = {
	host: string;
	/** Адрес, в который разрешилось имя; `null` — имя не разрешилось. */
	resolved: string | null;
	state: LinkState;
};

/**
 * Одна проверка выхода в интернет: разрешается ли имя Dadata и принимает ли
 * узел соединение на 443. Запросов к API нет — ни ключа, ни квоты проверка не
 * тратит. Идёт только по кнопке: открытие страницы наружу не ходит.
 */
export async function checkExternalSources(ctx: ActorContext): Promise<ExternalCheck> {
	requirePermission(ctx, 'integrations.manage');

	let resolved: string | null = null;

	const state = await probe(async (signal) => {
		try {
			resolved = (await lookup(DADATA_HOST)).address;
		} catch (error) {
			throw new Error(`Имя ${DADATA_HOST} не разрешается: ${failureText(error)}`, {
				cause: error
			});
		}

		await tcpConnect(resolved, 443, signal);
	});

	return { host: DADATA_HOST, resolved, state };
}
