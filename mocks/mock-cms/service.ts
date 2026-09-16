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
	applicationTemplate,
	isApplicationForm,
	templateExternalId,
	APPLICATION_FORMS,
	type ApplicationForm
} from './applications.ts';
import { controlRoutes } from '../shared/control.ts';
import { crmIssue, postToCrm, type CrmTarget } from '../shared/crm.ts';
import { buildEnvelope, parseEnvelope, type Envelope } from '../shared/envelope.ts';
import {
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
};

/** Заявка, какой её помнит сайт. */
type StoredApplication = {
	externalId: string;
	form: string;
	/** Монотонная ревизия отправителя: растёт с каждым изменением заявки. */
	revision: number;
	lastEventId: string;
	sentAt: string;
	/** Чем CRM ответила на последнюю отправку. */
	crmStatus: number | null;
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

				const application = applications.get(request.params.externalId);

				if (application === undefined) {
					// Заявки с таким ключом сайт не отправлял. Это не придирка: так
					// видно, что CRM спутала экземпляр CMS — на другом стенде ключ
					// тот же, а заявка другая.
					return statusReply(
						journal,
						path,
						404,
						'not_found',
						`Заявки ${request.params.externalId} на этом сайте нет`,
						envelope
					);
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
					note: `карточка заявки переведена в ${String(envelope.data.applicationStatus)}`,
					payload: envelope
				});

				return { status: 200, json: { result: 'accepted' } };
			}
		}
	];

	const triggers: MockRoute[] = [
		{
			// Направление 1: «на сайте заполнили форму». Триггер проверки, а не
			// эндпоинт контракта: у настоящей CMS его роль играет посетитель.
			method: 'POST',
			path: '/__send-application',
			contract: false,
			handle: async (request) => {
				let body: Record<string, unknown>;

				try {
					body = request.rawBody === '' ? {} : JSON.parse(request.rawBody);
				} catch {
					return problem(400, 'validation', 'Тело запроса не разбирается как JSON');
				}

				if (typeof body !== 'object' || body === null || Array.isArray(body)) {
					return problem(400, 'validation', 'Тело запроса — объект');
				}

				const allowed = ['form', 'externalId', 'revision', 'eventId', 'data'];
				const unknown = Object.keys(body).filter((name) => !allowed.includes(name));

				if (unknown.length > 0) {
					return problem(400, 'validation', `Неизвестные поля: ${unknown.join(', ')}`);
				}

				const requestedForm = body.form ?? 'b2b';

				if (!isApplicationForm(requestedForm)) {
					return problem(400, 'validation', `form: ожидается ${APPLICATION_FORMS.join(' или ')}`);
				}

				const form: ApplicationForm = requestedForm;

				if (body.eventId !== undefined && typeof body.eventId !== 'string') {
					return problem(400, 'validation', 'eventId: ожидается строка');
				}

				if (
					body.revision !== undefined &&
					(!Number.isInteger(body.revision) || (body.revision as number) < 1)
				) {
					return problem(400, 'validation', 'revision: ожидается целое число от единицы');
				}

				if (
					body.data !== undefined &&
					(typeof body.data !== 'object' || body.data === null || Array.isArray(body.data))
				) {
					return problem(400, 'validation', 'data: ожидается объект тела заявки');
				}

				const issue = crmIssue(crm);

				if (issue !== null) {
					return problem(503, 'not_configured', issue);
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
							: templateExternalId(form);
					const previous = applications.get(externalId);
					const revision =
						typeof body.revision === 'number'
							? body.revision
							: previous === undefined
								? 1
								: previous.revision + 1;
					const data =
						body.data === undefined
							? applicationTemplate(form, externalId, revision)
							: { externalId, revision, ...(body.data as Record<string, unknown>) };

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
					form: String(envelope.data.form ?? form),
					revision: Number(envelope.data.revision ?? 1),
					lastEventId: envelope.eventId,
					sentAt: envelope.occurredAt,
					crmStatus: call.status,
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

				return {
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
				title: 'Имитатор CMS сайта',
				journal,
				scenario,
				objects: () => ({ applications: [...applications.values()] }),
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
