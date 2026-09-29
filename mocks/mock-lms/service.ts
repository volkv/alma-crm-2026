/**
 * Имитатор системы обучения: направления 3 и 4 контракта обмена и веб-сервис
 * Moodle рядом с ними.
 *
 * Что он изображает: CRM просит завести учебную группу и получает её
 * идентификатор (направление 3), а система обучения по окончании потока
 * присылает результат — числа для отчёта и подтверждение стадии (направление
 * 4). Плюс четыре функции веб-сервиса Moodle, которыми пользуется выгрузка
 * данных об обучении, — второй протокол той же системы (`moodle.ts`).
 *
 * Чем он не является: настоящей LMS заказчика. Обмен с ней не считается
 * проверенным по результатам имитатора.
 */
import { courseForProgram, stableGroupId } from './groups.ts';
import { moodleRest, moodleToken, readParams } from './moodle.ts';
import { renderGroupsOverview, renderResultSpotlight, type SentResult } from './spotlight.ts';
import { controlRoutes } from '../shared/control.ts';
import { crmIssue, postToCrm, type CrmTarget } from '../shared/crm.ts';
import { buildEnvelope, parseEnvelope, SCHEMA_VERSION, type Envelope } from '../shared/envelope.ts';
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

/** Куда имитатор отправляет результат (`docs/exchange-contract.md`, раздел 6). */
export const CRM_RESULTS_PATH = '/api/v1/exchange/learning-groups/results';

export type MockLmsOptions = {
	/** `0` — любой свободный порт: так сервис поднимается в тестах. */
	port?: number;
	host?: string;
	/** Имя экземпляра LMS: входит в ключ дедупликации на стороне CRM. */
	instance?: string;
	/** Адрес, по которому группа видна человеку; уезжает в ответе на заявку. */
	publicUrl?: string;
	crm?: CrmTarget;
	/** Секрет, которым CRM подписывает исходящие сообщения. */
	exchangeSecret?: string | null;
	journalSize?: number;
	/** Токен управляющих адресов; `null` — управление открыто. */
	controlToken?: string | null;
};

export type GroupCounters = { enrolled: number; completed: number; expelled: number };

/** Выбор формы стенда: чем считать отправляемый результат. */
const RESULT_FINISHES = ['по дате потока', 'завершили сегодня', 'ещё учатся'] as const;

function isResultFinish(value: unknown): value is (typeof RESULT_FINISHES)[number] {
	return (RESULT_FINISHES as readonly unknown[]).includes(value);
}

/** Учебная группа, какой её помнит система обучения. */
type LearningGroup = {
	/** Ключ заявки CRM: `crm-group-<взаимодействие>-<поток>`. */
	requestExternalId: string;
	groupExternalId: string;
	courseExternalId: string;
	url: string;
	interactionId: string | null;
	/** Что обучается: код программы и коды продуктов из заявки CRM. */
	programCode: string | null;
	productCodes: string[];
	/** Для кого обучение: `students`, `teachers`, `upskilling`; `null` — группа, заведённая до закрепления выбора. */
	purpose: string | null;
	plannedSeats: number | null;
	startsOn: string | null;
	endsOn: string | null;
	requestedAt: string;
	/**
	 * Сколько слушателей в последнем присланном списке; `null` — списка не
	 * присылали. Сам список имитатор не хранит: страница стенда открыта всем,
	 * а ФИО и почта — персональные данные, пусть и выдуманные.
	 */
	learnerCount: number | null;
	/**
	 * `occurredAt` последнего применённого списка; `null` — списка не было.
	 * Список старше применённого не применяется (`docs/exchange-contract.md`,
	 * раздел 2): отложенный повтор старой передачи не затирает новую.
	 */
	rosterOccurredAt: string | null;
	/** Отправленные результаты: промежуточные и итоговый, свежий — последний. */
	results: SentResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function nested(data: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = data[key];

	return isRecord(value) ? value : {};
}

/** Коды продуктов заявки из списка `products`. */
function readProductCodes(data: Record<string, unknown>): string[] {
	return Array.isArray(data.products)
		? data.products
				.map((item) => (isRecord(item) ? readString(item.code) : null))
				.filter((code): code is string => code !== null)
		: [];
}

/**
 * Счётчики по умолчанию — из переданного CRM списка слушателей: сколько людей
 * в списке, столько и зачислено. Списка не присылали — число мест потока. Итог
 * (есть дата окончания) — все зачисленные доучились; промежуточный — ещё
 * учатся все. Ничего случайного: числа имитатора обязаны сходиться с тем, что
 * CRM ему передала, а стенд — выглядеть одинаково при каждом запуске.
 */
function defaultCounters(
	group: Pick<LearningGroup, 'learnerCount' | 'plannedSeats'>,
	finished: boolean
): GroupCounters {
	const enrolled = group.learnerCount ?? group.plannedSeats ?? 30;

	return { enrolled, completed: finished ? enrolled : 0, expelled: 0 };
}

function parseCounters(value: unknown, base: GroupCounters): GroupCounters | string {
	if (value === undefined) {
		return base;
	}

	if (!isRecord(value)) {
		return 'counters: ожидается объект с полями enrolled, completed, expelled';
	}

	const unknownFields = Object.keys(value).filter(
		(name) => !['enrolled', 'completed', 'expelled'].includes(name)
	);

	if (unknownFields.length > 0) {
		return `counters: неизвестные поля ${unknownFields.join(', ')}`;
	}

	const counters: GroupCounters = {
		enrolled: value.enrolled === undefined ? base.enrolled : Number(value.enrolled),
		completed: value.completed === undefined ? base.completed : Number(value.completed),
		expelled: value.expelled === undefined ? base.expelled : Number(value.expelled)
	};

	for (const [name, number] of Object.entries(counters)) {
		if (!Number.isInteger(number) || number < 0) {
			return `counters.${name}: ожидается целое число от нуля`;
		}
	}

	// То же ограничение, что стоит в базе CRM: «ещё учатся» — это остаток, и два
	// поля, противоречащих друг другу, однажды разойдутся.
	if (counters.completed + counters.expelled > counters.enrolled) {
		return 'counters: completed + expelled не больше enrolled';
	}

	return counters;
}

/** Число слушателей в заявке; `null` — поля `learners` нет (заявка о составе молчит). */
function readLearnerCount(data: Record<string, unknown>): number | null {
	return Array.isArray(data.learners) ? data.learners.length : null;
}

/**
 * Конверт для журнала стенда: поимённый список заменён числом. Журнал виден
 * на открытой странице имитатора, и ФИО с почтой там не место.
 */
function journalCopy(envelope: Envelope): Envelope {
	const count = readLearnerCount(envelope.data);

	return count === null
		? envelope
		: { ...envelope, data: { ...envelope.data, learners: `${count} (состав не хранится)` } };
}

function groupReply(
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
		payload: envelope === null ? null : journalCopy(envelope)
	});

	return problem(status, code, message);
}

export async function startMockLms(options: MockLmsOptions = {}): Promise<MockService> {
	const instance = options.instance ?? 'moodle-itschool';
	const crm: CrmTarget = options.crm ?? { baseUrl: null, apiKey: null };
	const exchangeSecret = options.exchangeSecret ?? null;
	const journal = createJournal(options.journalSize ?? DEFAULT_JOURNAL_SIZE);
	const scenario = createScenario();

	/** Группы по ключу заявки CRM. */
	const groups = new Map<string, LearningGroup>();
	/** Отправленные конверты: повтор события шлёт тот же самый, байт в байт. */
	const sent = new Map<string, Envelope>();

	function publicUrl(): string {
		return (options.publicUrl ?? 'http://localhost:58082').replace(/\/+$/, '');
	}

	function findGroup(groupExternalId: string): LearningGroup | null {
		for (const group of groups.values()) {
			if (group.groupExternalId === groupExternalId) {
				return group;
			}
		}

		return null;
	}

	function forget(): void {
		groups.clear();
		sent.clear();
		journal.clear();
	}

	const contract: MockRoute[] = [
		{
			// Направление 3: CRM заводит учебную группу.
			method: 'POST',
			path: '/api/groups',
			contract: true,
			handle: (request) => {
				const path = request.path;
				const refusal = checkSignature({
					secret: exchangeSecret,
					headers: request.headers,
					body: request.rawBody
				});

				if (refusal !== null) {
					return groupReply(journal, path, refusal.status, refusal.code, refusal.message, null);
				}

				const parsed = parseEnvelope(request.rawBody, {
					eventType: 'learning_group.requested',
					system: 'crm'
				});

				if (!parsed.ok) {
					const { status, code, message } = parsed.refusal;

					return groupReply(journal, path, status, code, message, null);
				}

				const envelope = parsed.envelope;
				const requestExternalId = readString(envelope.data.externalId);

				if (requestExternalId === null) {
					return groupReply(
						journal,
						path,
						400,
						'validation',
						'data.externalId обязателен: ключ заявки на группу',
						envelope
					);
				}

				const existing = groups.get(requestExternalId);
				const learnerCount = readLearnerCount(envelope.data);

				if (existing !== undefined) {
					// Повторная заявка возвращает ту же группу, а не заводит вторую:
					// это и есть защита от дубля на стороне LMS. Список слушателей в
					// ней — снимок состава: он заменяет прежний, а не дописывается.
					const stale =
						learnerCount !== null &&
						existing.rosterOccurredAt !== null &&
						Date.parse(envelope.occurredAt) < Date.parse(existing.rosterOccurredAt);
					const rostered = learnerCount !== null && !stale;

					if (rostered) {
						existing.learnerCount = learnerCount;
						existing.rosterOccurredAt = envelope.occurredAt;
					}

					journal.add({
						direction: 'inbound',
						summary: `POST ${path}`,
						status: 200,
						eventId: envelope.eventId,
						eventType: envelope.eventType,
						note: stale
							? `состав группы ${existing.groupExternalId} старее применённого: не применён`
							: rostered
								? `состав группы ${existing.groupExternalId}: ${learnerCount} слушателей`
								: `повтор заявки: группа ${existing.groupExternalId} уже заведена`,
						payload: journalCopy(envelope)
					});

					return {
						status: 200,
						json: {
							schemaVersion: SCHEMA_VERSION,
							result: rostered ? 'updated' : 'unchanged',
							data: {
								externalId: existing.requestExternalId,
								groupExternalId: existing.groupExternalId,
								courseExternalId: existing.courseExternalId,
								url: existing.url
							}
						}
					};
				}

				const stream = nested(envelope.data, 'stream');
				const programCode = readString(nested(envelope.data, 'program').code);
				const course = courseForProgram(programCode);
				const groupExternalId = stableGroupId(requestExternalId, (id) => findGroup(id) !== null);
				const group: LearningGroup = {
					requestExternalId,
					groupExternalId,
					courseExternalId: String(course.id),
					url: `${publicUrl()}/course/view.php?id=${course.id}`,
					interactionId: readString(envelope.data.interactionId),
					programCode,
					productCodes: readProductCodes(envelope.data),
					purpose: readString(envelope.data.purpose),
					plannedSeats: Number.isInteger(stream.plannedSeats)
						? (stream.plannedSeats as number)
						: null,
					startsOn: readString(stream.startsOn),
					endsOn: readString(stream.endsOn),
					requestedAt: envelope.occurredAt,
					learnerCount,
					rosterOccurredAt: learnerCount === null ? null : envelope.occurredAt,
					results: []
				};

				groups.set(requestExternalId, group);

				journal.add({
					direction: 'inbound',
					summary: `POST ${path}`,
					status: 201,
					eventId: envelope.eventId,
					eventType: envelope.eventType,
					note: `заведена группа ${group.groupExternalId} на курсе ${course.idnumber}${group.purpose === null ? '' : ` (${group.purpose})`}${learnerCount === null ? '' : `, слушателей: ${learnerCount}`}`,
					payload: journalCopy(envelope)
				});

				return {
					status: 201,
					json: {
						schemaVersion: SCHEMA_VERSION,
						result: 'created',
						data: {
							externalId: group.requestExternalId,
							groupExternalId: group.groupExternalId,
							courseExternalId: group.courseExternalId,
							url: group.url
						}
					}
				};
			}
		}
	];

	/** Веб-сервис Moodle: тот же адрес и те же параметры, что у площадки. */
	const moodle: MockRoute[] = (['GET', 'POST'] as const).flatMap((method) => [
		{
			method,
			path: '/login/token.php',
			contract: true,
			handle: (request) => moodleToken(readParams(request))
		},
		{
			method,
			path: '/webservice/rest/server.php',
			contract: true,
			handle: (request) => moodleRest(readParams(request), new Date())
		}
	]);

	const triggers: MockRoute[] = [
		{
			// Направление 4: «поток закончился, вот числа». Триггер стенда, а не
			// эндпоинт контракта: у настоящей LMS его роль играет расписание. Жмут
			// его кнопкой со страницы состояния и запросом из проверки.
			method: 'POST',
			path: '/__send-result',
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
				const allowed = [
					'groupExternalId',
					'requestExternalId',
					'counters',
					'finishedOn',
					'finish',
					'period',
					'eventId'
				];
				const unknownFields = Object.keys(body).filter((name) => !allowed.includes(name));

				if (unknownFields.length > 0) {
					return refuse(400, 'validation', `Неизвестные поля: ${unknownFields.join(', ')}`);
				}

				if (body.eventId !== undefined && typeof body.eventId !== 'string') {
					return refuse(400, 'validation', 'eventId: ожидается строка');
				}

				const requestExternalId = readString(body.requestExternalId);
				const groupExternalId = readString(body.groupExternalId);
				const group =
					requestExternalId !== null
						? (groups.get(requestExternalId) ?? null)
						: groupExternalId !== null
							? findGroup(groupExternalId)
							: null;

				if (group === null) {
					return refuse(
						404,
						'not_found',
						'Такой группы в системе обучения нет: назовите groupExternalId или requestExternalId заведённой группы'
					);
				}

				if (body.finish !== undefined && !isResultFinish(body.finish)) {
					return refuse(400, 'validation', `finish: ожидается ${RESULT_FINISHES.join(', ')}`);
				}

				if (body.finish !== undefined && body.finishedOn !== undefined) {
					return refuse(
						400,
						'validation',
						'finish и finishedOn вместе не задаются: finishedOn — сама дата окончания'
					);
				}

				// Дата окончания по умолчанию — конец потока, но только если он уже
				// наступил: плановая дата в будущем — не факт окончания, и CRM такой
				// результат отвергает. Поток, который ещё идёт, шлёт результат без
				// даты окончания — промежуточный. «Завершили сегодня» — досрочный
				// итог: так на стенде показывают конец потока, чей план ещё впереди.
				// День — по Москве, как в CRM: по UTC после полуночи МСК было бы «вчера».
				const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
					new Date()
				);
				const finishedOn =
					body.finish === 'завершили сегодня'
						? today
						: body.finish === 'ещё учатся'
							? null
							: (readString(body.finishedOn) ??
								(group.endsOn !== null && group.endsOn <= today ? group.endsOn : null));

				const counters = parseCounters(body.counters, defaultCounters(group, finishedOn !== null));

				if (typeof counters === 'string') {
					return refuse(400, 'validation', counters);
				}

				const issue = crmIssue(crm);

				if (issue !== null) {
					return refuse(503, 'not_configured', issue);
				}

				const repeatOf = typeof body.eventId === 'string' ? (sent.get(body.eventId) ?? null) : null;

				let envelope: Envelope;

				if (repeatOf !== null) {
					// Повтор того же события шлёт то же тело: иначе проверялась бы не
					// идемпотентность приёмника, а сборка сообщения.
					envelope = repeatOf;
				} else {
					const period = nested(body, 'period');

					envelope = buildEnvelope({
						eventType: 'learning_group.result',
						system: 'lms',
						instance,
						eventId: typeof body.eventId === 'string' ? body.eventId : undefined,
						data: {
							groupExternalId: group.groupExternalId,
							requestExternalId: group.requestExternalId,
							period: {
								start: readString(period.start) ?? group.startsOn,
								end: readString(period.end) ?? group.endsOn
							},
							finishedOn,
							counters
						}
					});
				}

				const call = await postToCrm(crm, CRM_RESULTS_PATH, envelope);

				sent.set(envelope.eventId, envelope);
				group.results.push({
					at: envelope.occurredAt,
					eventId: envelope.eventId,
					finishedOn: readString(envelope.data.finishedOn),
					counters: envelope.data.counters as GroupCounters,
					crmStatus: call.status,
					crmReply: call.body,
					crmError: call.error
				});

				journal.add({
					direction: 'outbound',
					summary: `POST ${call.url}`,
					status: call.status,
					eventId: envelope.eventId,
					eventType: envelope.eventType,
					note:
						call.error ??
						(repeatOf === null
							? `результат группы ${group.groupExternalId} отправлен`
							: 'повтор того же события (тот же eventId)'),
					payload: envelope
				});

				// Кнопка со страницы состояния ведёт на карточку отправленного
				// результата на той же странице: что ушло и чем ответила CRM.
				return parsedBody.fromForm
					? {
							status: 303,
							headers: { location: `./?result=${encodeURIComponent(envelope.eventId)}` }
						}
					: {
							status: 200,
							json: {
								eventId: envelope.eventId,
								groupExternalId: group.groupExternalId,
								repeat: repeatOf !== null,
								request: envelope,
								crm: call
							}
						};
			}
		}
	];

	return startMockService({
		name: 'mock-lms',
		port: options.port ?? 8082,
		host: options.host,
		scenario,
		journal,
		routes: [
			...contract,
			...moodle,
			...triggers,
			...controlRoutes({
				name: 'mock-lms',
				title: 'Имитатор системы обучения (LMS)',
				mark: 'LMS',
				intro:
					'Принимает от CRM заявки на учебные группы и заводит группы, а по окончании потока возвращает в CRM итог: сколько зачислено, завершили и отчислено.',
				journal,
				scenario,
				controlToken: options.controlToken ?? null,
				forms: [
					{
						action: '__send-result',
						title: 'Результат потока',
						description:
							'То же, что делает система обучения по окончании потока: имитатор собирает числа группы и отправляет их в CRM.',
						fields: [
							{
								name: 'requestExternalId',
								label: 'Ключ заявки CRM',
								hint: 'crm-group-<взаимодействие>-<поток>; список заведённых групп — выше'
							},
							{
								name: 'groupExternalId',
								label: 'Ключ группы',
								hint: 'вместо ключа заявки: любой из двух, чтобы назвать группу'
							},
							{
								name: 'finish',
								label: 'Обучение завершено',
								options: RESULT_FINISHES,
								hint: '«по дате потока» — итог, если конец потока наступил, иначе промежуточный результат; «завершили сегодня» — итог с сегодняшней датой, в том числе для потока, чей план ещё впереди. Числа — из переданного списка слушателей: сколько передано, столько зачислено'
							}
						],
						submit: 'Отправить результат в CRM'
					}
				],
				objects: () => ({ groups: [...groups.values()] }),
				overview: () => renderGroupsOverview([...groups.values()]),
				// Карточка отправленного результата над формой: после отправки кнопка
				// ведёт сюда с ключом события в строке запроса.
				spotlight: (query) => {
					const eventId = query.get('result');

					if (eventId === null) {
						return null;
					}

					for (const group of groups.values()) {
						const result = group.results.find((item) => item.eventId === eventId);

						if (result !== undefined) {
							return renderResultSpotlight(eventId, group.groupExternalId, result);
						}
					}

					return renderResultSpotlight(eventId, null, null);
				},
				forget,
				// Ни ключа, ни секрета, ни токена веб-сервиса: страница стенда
				// открыта. Видно только, настроен ли обмен.
				settings: () => ({
					instance,
					publicUrl: publicUrl(),
					crmBaseUrl: crm.baseUrl,
					crmApiKeyConfigured: crm.apiKey !== null && crm.apiKey !== '',
					exchangeSecretConfigured: exchangeSecret !== null && exchangeSecret !== ''
				})
			})
		]
	});
}
