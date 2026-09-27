/**
 * Имитатор CMS публичного сайта: направления 1 и 2 контракта обмена.
 *
 * Что он изображает: форма на сайте заводит заявку и отправляет её в CRM
 * (направление 1), а CRM в ответ на каждое изменение присылает снимок статуса
 * заявки (направление 2). Ни того, ни другого у нас нет на стенде иначе —
 * настоящая CMS заказчика наружу не смотрит.
 *
 * Чем он не является: настоящей интеграцией. Обмен с системой заказчика не
 * считается проверенным по результатам имитатора — проверенным считается
 * только то, что CRM говорит на объявленном контракте.
 */
import {
	applicantIssue,
	applicationTemplate,
	applicationWithApplicant,
	isApplicationForm,
	templateExternalId,
	APPLICATION_FORMS,
	type ApplicationForm
} from './applications.ts';
import { renderApplicationSpotlight } from './spotlight.ts';
import { CONTROL_HEADER, controlAllowed, controlRoutes } from '../shared/control.ts';
import { crmIssue, postToCrm, type CrmCall, type CrmTarget } from '../shared/crm.ts';
import { buildEnvelope, parseEnvelope, type Envelope } from '../shared/envelope.ts';
import {
	formProblem,
	parseTriggerBody,
	problem,
	startMockService,
	type MockReply,
	type MockRoute,
	type MockService
} from '../shared/http.ts';
import { createJournal, DEFAULT_JOURNAL_SIZE, type Journal } from '../shared/journal.ts';
import { createScenario } from '../shared/scenario.ts';
import { checkSignature } from '../shared/signature.ts';

/** Куда имитатор отправляет заявку (`docs/exchange-contract.md`, раздел 3). */
export const CRM_APPLICATIONS_PATH = '/api/v1/applications';

/** Поля триггера заявки: всё остальное — опечатка или чужая договорённость. */
const TRIGGER_FIELDS = ['form', 'externalId', 'applicant', 'revision', 'eventId', 'data'] as const;

/**
 * Поля триггера, которыми распоряжается только управление имитатором.
 *
 * Триггер открыт наружу (`deploy/nginx/crm.conf.example`): им начинают сцену со
 * страницы стенда. Открытым он остаётся ровно настолько, насколько это нужно
 * зрителю, — выбрать набор формы и, при желании, ключ заявки. Тело сообщения,
 * его ревизию и ключ события задаёт тот, кто предъявил токен управления: иначе
 * имитатор подписывал бы своим ключом обмена произвольную заявку, присланную с
 * улицы, и относил её в CRM от имени сайта.
 */
const CONTROL_ONLY_FIELDS = ['revision', 'eventId', 'data'] as const;

/**
 * Ключ заявки, который принимает открытый триггер: нумерация заявок стенда.
 *
 * Тот же ключ означает изменение той же заявки, и повторить это со страницы
 * надо уметь. Свободной строки здесь при этом быть не должно: ключ заявки —
 * половина ключа дедупликации на стороне CRM, и произвольный означал бы, что
 * заявки стенда заводит кто угодно снаружи и сколько угодно.
 */
const OPEN_EXTERNAL_ID = /^site-2026-\d{6}$/;

/**
 * Ключ новой заявки, когда в форме назвали своего заявителя, а ключа не дали.
 *
 * Ключ набора означал бы изменение заявки набора — под чужим именем. Номер
 * случайный из верхней половины нумерации стенда: сид занимает нижние номера
 * (`site-2026-000201`…), а счётчик с единицы после перезапуска имитатора
 * наступил бы на заявку, которую CRM уже помнит, — и получил бы `unchanged`.
 */
function freshExternalId(taken: ReadonlyMap<string, unknown>): string {
	for (;;) {
		const candidate = `site-2026-${String(500_000 + Math.floor(Math.random() * 500_000))}`;

		if (!taken.has(candidate)) {
			return candidate;
		}
	}
}

/** Что CRM ответила на заявку: итог приёма, ключ дела — или что помешало. */
function crmOutcome(call: CrmCall): {
	crmResult: string | null;
	interactionId: string | null;
	crmError: string | null;
} {
	if (call.error !== null) {
		return { crmResult: null, interactionId: null, crmError: call.error };
	}

	const body =
		typeof call.body === 'object' && call.body !== null
			? (call.body as Record<string, unknown>)
			: null;
	const data =
		typeof body?.data === 'object' && body.data !== null
			? (body.data as Record<string, unknown>)
			: null;
	const ok = call.status !== null && call.status >= 200 && call.status < 300;

	return {
		crmResult: ok && typeof body?.result === 'string' ? body.result : null,
		interactionId: ok && typeof data?.interactionId === 'string' ? data.interactionId : null,
		crmError: ok
			? null
			: `CRM ответила ${String(call.status)}${typeof body?.message === 'string' ? `: ${body.message}` : ''}`
	};
}

export type MockCmsOptions = {
	/** `0` — любой свободный порт: так сервис поднимается в тестах. */
	port?: number;
	host?: string;
	/** Имя экземпляра CMS: входит в ключ дедупликации на стороне CRM. */
	instance?: string;
	crm?: CrmTarget;
	/** Секрет, которым CRM подписывает исходящие сообщения. */
	exchangeSecret?: string | null;
	journalSize?: number;
	/** Токен управляющих адресов; `null` — управление открыто. */
	controlToken?: string | null;
};

/**
 * Откуда на сайте взялась карточка заявки.
 *
 * `form` — её заполнили на сайте и отправили в CRM. `crm-status` — её завёл
 * снимок статуса, пришедший из CRM: заявку подали мимо формы (оператор завёл
 * обращение руками, его принёс другой канал), а сайт всё равно обязан показать
 * заявителю, что с ней происходит.
 */
type ApplicationOrigin = 'form' | 'crm-status';

/** Заявка, какой её помнит сайт. */
type StoredApplication = {
	externalId: string;
	origin: ApplicationOrigin;
	/** Набор формы; `null` — карточку завёл статус, формы у неё не было. */
	form: string | null;
	/** Монотонная ревизия отправителя: растёт с каждым изменением заявки. */
	revision: number | null;
	lastEventId: string | null;
	sentAt: string | null;
	/** Чем CRM ответила на последнюю отправку. */
	crmStatus: number | null;
	/** Итог приёма в CRM: `created`, `updated`, `unchanged`; `null` — не принята. */
	crmResult: string | null;
	/** Взаимодействие, которым заявка стала в CRM. */
	interactionId: string | null;
	/** Почему CRM не приняла заявку — словами; `null` — приняла или не отправляли. */
	crmError: string | null;
	/** Заявитель, как его назвали в форме; `null` — заявитель набора. */
	applicant: string | null;
	/** Снимки статуса, присланные CRM: свежий — последний. */
	statuses: { at: string; eventId: string; data: Record<string, unknown> }[];
};

function statusReply(
	journal: Journal,
	path: string,
	status: number,
	code: string,
	message: string,
	envelope: Envelope | null
): MockReply {
	journal.add({
		direction: 'inbound',
		summary: `POST ${path}`,
		status,
		eventId: envelope?.eventId ?? null,
		eventType: envelope?.eventType ?? null,
		note: `${code}: ${message}`,
		payload: envelope
	});

	return problem(status, code, message);
}

export async function startMockCms(options: MockCmsOptions = {}): Promise<MockService> {
	const instance = options.instance ?? 'itschool-site';
	const controlToken = options.controlToken ?? null;
	const crm: CrmTarget = options.crm ?? { baseUrl: null, apiKey: null };
	const exchangeSecret = options.exchangeSecret ?? null;
	const journal = createJournal(options.journalSize ?? DEFAULT_JOURNAL_SIZE);
	const scenario = createScenario();

	const applications = new Map<string, StoredApplication>();
	/** Отправленные конверты: повтор события шлёт тот же самый, байт в байт. */
	const sent = new Map<string, Envelope>();
	/** Принятые от CRM сообщения: второй раз то же самое ничего не меняет. */
	const received = new Set<string>();

	function forget(): void {
		applications.clear();
		sent.clear();
		received.clear();
		journal.clear();
	}

	const contract: MockRoute[] = [
		{
			// Направление 2: CRM присылает снимок состояния заявки.
			method: 'POST',
			path: '/api/applications/{externalId}/status',
			contract: true,
			handle: (request) => {
				const path = request.path;
				const refusal = checkSignature({
					secret: exchangeSecret,
					headers: request.headers,
					body: request.rawBody
				});

				if (refusal !== null) {
					return statusReply(journal, path, refusal.status, refusal.code, refusal.message, null);
				}

				const parsed = parseEnvelope(request.rawBody, {
					eventType: 'application.status',
					system: 'crm'
				});

				if (!parsed.ok) {
					const { status, code, message } = parsed.refusal;

					return statusReply(journal, path, status, code, message, null);
				}

				const envelope = parsed.envelope;
				const externalId = envelope.data.externalId;

				if (externalId !== request.params.externalId) {
					return statusReply(
						journal,
						path,
						400,
						'validation',
						`Ключ заявки в теле (${String(externalId)}) не совпадает с адресом (${request.params.externalId})`,
						envelope
					);
				}

				const known = applications.get(request.params.externalId);
				// Заявки с таким ключом сайт не отправлял — и это не повод отказывать.
				// Обращение могло прийти не с формы: его завели в CRM руками, принёс
				// другой канал, оно пережило переустановку сайта. Сайту от снимка
				// нужно одно — показать заявителю, что с обращением происходит, а для
				// этого карточку достаточно завести. Отказ `404` вместо этого означал
				// бы, что первый же статус по такой заявке навсегда получает в журнале
				// CRM «не доставлено»: повторять окончательный отказ 4xx бессмысленно
				// (`docs/exchange-contract.md`, раздел 4). Что карточка пришла не с
				// формы, видно и в состоянии, и на странице: `origin: "crm-status"`.
				const application: StoredApplication = known ?? {
					externalId: request.params.externalId,
					origin: 'crm-status',
					form: null,
					revision: null,
					lastEventId: null,
					sentAt: null,
					crmStatus: null,
					crmResult: null,
					interactionId: null,
					crmError: null,
					applicant: null,
					statuses: []
				};

				if (known === undefined) {
					applications.set(application.externalId, application);
				}

				if (received.has(envelope.eventId)) {
					journal.add({
						direction: 'inbound',
						summary: `POST ${path}`,
						status: 200,
						eventId: envelope.eventId,
						eventType: envelope.eventType,
						note: 'повтор доставки: состояние карточки не менялось',
						payload: envelope
					});

					return { status: 200, json: { result: 'unchanged' } };
				}

				received.add(envelope.eventId);
				application.statuses.push({
					at: envelope.occurredAt,
					eventId: envelope.eventId,
					data: envelope.data
				});

				journal.add({
					direction: 'inbound',
					summary: `POST ${path}`,
					status: 200,
					eventId: envelope.eventId,
					eventType: envelope.eventType,
					note:
						known === undefined
							? `карточка заведена по статусу из CRM и переведена в ${String(envelope.data.applicationStatus)}`
							: `карточка заявки переведена в ${String(envelope.data.applicationStatus)}`,
					payload: envelope
				});

				return { status: 200, json: { result: known === undefined ? 'created' : 'accepted' } };
			}
		}
	];

	const triggers: MockRoute[] = [
		{
			// Направление 1: «на сайте заполнили форму». Триггер стенда, а не
			// эндпоинт контракта: у настоящей CMS его роль играет посетитель. Жмут
			// его кнопкой со страницы состояния, запросом из проверки и действием
			// «Демо: заявка с сайта» на экране «Внешние системы».
			//
			// Открыт он наружу, поэтому и принимает снаружи только выбор сцены:
			// набор формы, ключ заявки стенда и имя заявителя. Собственное тело
			// сообщения — `CONTROL_ONLY_FIELDS` — за токеном управления.
			method: 'POST',
			path: '/__send-application',
			contract: false,
			handle: async (request) => {
				const parsedBody = parseTriggerBody(request);

				if (!parsedBody.ok) {
					return problem(400, 'validation', parsedBody.message);
				}

				// Кнопка со страницы состояния получает отказ страницей со ссылкой
				// назад, а не JSON: нажавший смотрит в браузер, а не в тело ответа.
				const refuse = (status: number, code: string, message: string): MockReply =>
					parsedBody.fromForm ? formProblem(status, message) : problem(status, code, message);

				const body = parsedBody.body;
				const unknown = Object.keys(body).filter(
					(name) => !(TRIGGER_FIELDS as readonly string[]).includes(name)
				);

				if (unknown.length > 0) {
					return refuse(400, 'validation', `Неизвестные поля: ${unknown.join(', ')}`);
				}

				// Снаружи триггер выбирает сцену, а не сочиняет сообщение: тело заявки
				// имитатор берёт из своих фикстур. Всё, чем распоряжается управление,
				// требует токена — и до похода в CRM дело не доходит вовсе.
				const controlled = controlAllowed(controlToken, request);
				const controlOnly = CONTROL_ONLY_FIELDS.filter((name) => body[name] !== undefined);

				if (!controlled && controlOnly.length > 0) {
					return refuse(
						403,
						'control_forbidden',
						`Поля ${controlOnly.join(', ')} задаёт только управление имитатором: назовите токен в заголовке ${CONTROL_HEADER}`
					);
				}

				if (body.externalId !== undefined && typeof body.externalId !== 'string') {
					return refuse(400, 'validation', 'externalId: ожидается строка');
				}

				if (
					!controlled &&
					typeof body.externalId === 'string' &&
					!OPEN_EXTERNAL_ID.test(body.externalId)
				) {
					return refuse(
						400,
						'validation',
						'externalId: ключ заявки стенда имеет вид site-2026-000123; произвольный задаёт только управление имитатором'
					);
				}

				const requestedForm = body.form ?? 'b2b';

				if (!isApplicationForm(requestedForm)) {
					return refuse(400, 'validation', `form: ожидается ${APPLICATION_FORMS.join(' или ')}`);
				}

				const form: ApplicationForm = requestedForm;

				if (body.applicant !== undefined && typeof body.applicant !== 'string') {
					return refuse(400, 'validation', 'applicant: ожидается строка');
				}

				const applicant = typeof body.applicant === 'string' ? body.applicant.trim() : null;

				if (applicant !== null) {
					const issue = applicantIssue(form, applicant);

					if (issue !== null) {
						return refuse(400, 'validation', issue);
					}
				}

				if (applicant !== null && body.data !== undefined) {
					return refuse(
						400,
						'validation',
						'applicant и data вместе не задаются: data — всё тело заявки'
					);
				}

				if (body.eventId !== undefined && typeof body.eventId !== 'string') {
					return refuse(400, 'validation', 'eventId: ожидается строка');
				}

				if (
					body.revision !== undefined &&
					(!Number.isInteger(body.revision) || (body.revision as number) < 1)
				) {
					return refuse(400, 'validation', 'revision: ожидается целое число от единицы');
				}

				if (
					body.data !== undefined &&
					(typeof body.data !== 'object' || body.data === null || Array.isArray(body.data))
				) {
					return refuse(400, 'validation', 'data: ожидается объект тела заявки');
				}

				const issue = crmIssue(crm);

				if (issue !== null) {
					return refuse(503, 'not_configured', issue);
				}

				const repeatOf = typeof body.eventId === 'string' ? (sent.get(body.eventId) ?? null) : null;

				let envelope: Envelope;

				if (repeatOf !== null) {
					// Повтор того же события: тело не пересобирается. Иначе CRM
					// увидела бы под старым именем другой запрос — и ответила бы 422,
					// а проверялась бы не идемпотентность, а сборка тела.
					envelope = repeatOf;
				} else {
					const externalId =
						typeof body.externalId === 'string' && body.externalId !== ''
							? body.externalId
							: applicant !== null
								? freshExternalId(applications)
								: templateExternalId(form);
					const previous = applications.get(externalId);
					// Ревизии у карточки может не быть вовсе: её завёл статус из CRM, а
					// формы, которая нумерует изменения, у такой заявки не было.
					const revision =
						typeof body.revision === 'number' ? body.revision : (previous?.revision ?? 0) + 1;
					// Заявитель повторной отправки — тот же, что в первой: иначе
					// изменение заявки молча вернуло бы ей заявителя набора.
					const named = applicant ?? previous?.applicant ?? null;
					const data =
						body.data !== undefined
							? { externalId, revision, ...(body.data as Record<string, unknown>) }
							: named !== null
								? applicationWithApplicant(form, externalId, revision, named)
								: applicationTemplate(form, externalId, revision);

					envelope = buildEnvelope({
						eventType: 'application.submitted',
						system: 'cms',
						instance,
						data,
						eventId: typeof body.eventId === 'string' ? body.eventId : undefined
					});
				}

				const call = await postToCrm(crm, CRM_APPLICATIONS_PATH, envelope);

				sent.set(envelope.eventId, envelope);

				const externalId = String(envelope.data.externalId);
				const previous = applications.get(externalId);

				applications.set(externalId, {
					externalId,
					// Заявку отправила форма — даже если карточку до этого завёл статус
					// из CRM: снимки статуса у неё остаются, а происхождение меняется.
					origin: 'form',
					form: String(envelope.data.form ?? form),
					revision: Number(envelope.data.revision ?? 1),
					lastEventId: envelope.eventId,
					sentAt: envelope.occurredAt,
					crmStatus: call.status,
					...crmOutcome(call),
					applicant: applicant ?? previous?.applicant ?? null,
					statuses: previous?.statuses ?? []
				});

				journal.add({
					direction: 'outbound',
					summary: `POST ${call.url}`,
					status: call.status,
					eventId: envelope.eventId,
					eventType: envelope.eventType,
					note:
						call.error ??
						(repeatOf === null ? 'заявка отправлена' : 'повтор того же события (тот же eventId)'),
					payload: envelope
				});

				// Кнопка со страницы состояния ведёт на карточку своей заявки на той
				// же странице: что ответила CRM и какие статусы пришли. Адрес
				// относительный и с ключом в строке запроса — та же страница,
				// которую прокси стенда пропускает наружу. Запросу из проверки
				// уходит разбор целиком.
				return parsedBody.fromForm
					? {
							status: 303,
							headers: { location: `./?application=${encodeURIComponent(externalId)}` }
						}
					: {
							status: 200,
							json: {
								eventId: envelope.eventId,
								externalId,
								repeat: repeatOf !== null,
								request: envelope,
								crm: call
							}
						};
			}
		}
	];

	return startMockService({
		name: 'mock-cms',
		port: options.port ?? 8081,
		host: options.host,
		scenario,
		journal,
		routes: [
			...contract,
			...triggers,
			...controlRoutes({
				name: 'mock-cms',
				title: 'Имитатор CMS сайта — не настоящая система',
				journal,
				scenario,
				controlToken,
				forms: [
					{
						action: '__send-application',
						title: 'Заявка с сайта',
						description:
							'То же, что делает посетитель, отправивший форму на сайте: имитатор собирает заявку и отправляет её в CRM.',
						fields: [
							{ name: 'form', label: 'Набор', options: APPLICATION_FORMS },
							{
								name: 'applicant',
								label: 'Заявитель',
								hint: 'b2b — название организации, b2c — фамилия и имя. Пусто — заявитель набора; названный заявитель получает новый ключ заявки'
							},
							{
								name: 'externalId',
								label: 'Ключ заявки',
								hint: 'пусто — ключ заявки набора или новый ключ для названного заявителя; тот же ключ означает изменение той же заявки. Вид ключа — site-2026-000123'
							}
						],
						submit: 'Отправить заявку в CRM'
					}
				],
				objects: () => ({ applications: [...applications.values()] }),
				// Страница открыта наружу, `__state` — за токеном, и снимки статуса
				// из CRM видны только во втором: в их телах есть имя ответственного и
				// последний комментарий по взаимодействию (`docs/security.md`).
				// Зрителю сцены нужно другое — дошло ли, чем ответили и в каком
				// состоянии заявка.
				pageObjects: () => ({
					applications: [...applications.values()].map(({ applicant, ...application }) => ({
						...application,
						// Имя, набранное в форме, видно только в карточке своей заявки:
						// страница открыта всем, и список чужих заявителей ей не нужен.
						applicant: applicant === null ? null : 'названный в форме',
						statuses: application.statuses.map((status) => ({
							at: status.at,
							eventId: status.eventId,
							applicationStatus: status.data.applicationStatus ?? null
						}))
					}))
				}),
				// Карточка своей заявки над формой: после отправки кнопка ведёт сюда
				// с ключом заявки в строке запроса.
				spotlight: (query) => {
					const externalId = query.get('application');
					const application = externalId === null ? undefined : applications.get(externalId);

					return externalId === null
						? null
						: renderApplicationSpotlight(externalId, application ?? null);
				},
				forget,
				// Ни ключа, ни секрета в состоянии нет: страница стенда открыта, и
				// показывать в ней значения нельзя. Видно только, настроен ли обмен.
				settings: () => ({
					instance,
					crmBaseUrl: crm.baseUrl,
					crmApiKeyConfigured: crm.apiKey !== null && crm.apiKey !== '',
					exchangeSecretConfigured: exchangeSecret !== null && exchangeSecret !== ''
				})
			})
		]
	});
}
