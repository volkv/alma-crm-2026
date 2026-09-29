/**
 * Управление имитатором: состояние, сценарий отказов, страница.
 *
 * Адреса начинаются с `__` — так их не спутать с эндпоинтами контракта, за
 * которые имитатор отвечает перед CRM: у настоящей CMS нет ни `__state`, ни
 * `__scenario`, и в обмене они не участвуют. Сценарий отказов на них не
 * действует (`MockRoute.contract: false`), иначе включённый сценарий нельзя
 * было бы ни посмотреть, ни снять.
 *
 * Граница демонстрации проходит здесь же. На стенде наружу через прокси
 * открыты только страница состояния и триггеры — то, что показывают зрителю;
 * `__state` и `__scenario` меняют или раскрывают состояние стенда целиком,
 * поэтому прокси их не пускает, а имитатор вдобавок требует к ним токен
 * (`CONTROL_TOKEN`, заголовок `X-Mock-Control`). Тем же токеном закрыто всё,
 * чем распоряжается управление на открытых адресах: триггер сцены снаружи
 * выбирает только набор заявки, а собственное тело сообщения задаёт лишь тот,
 * кто токен предъявил (`controlAllowed`). Токена нет — управление открыто: так
 * имитатор живёт на машине разработчика и в прогонах, где он доступен только с
 * петли. Кто и чем это закрывает на стенде — `docs/security.md`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Journal } from './journal.ts';
import { problem, type MockReply, type MockRequest, type MockRoute } from './http.ts';
import type { Scenario } from './scenario.ts';
import { renderStatePage, type TriggerForm } from './state-page.ts';

/** Заголовок, которым к управляющим адресам предъявляют токен. */
export const CONTROL_HEADER = 'x-mock-control';

export type ControlOptions = {
	/** Имя сервиса: `mock-cms`, `mock-lms`. */
	name: string;
	/** Заголовок страницы состояния. */
	title: string;
	/** Что делает имитатор, одной-двумя фразами для зрителя страницы. */
	intro: string;
	/** Короткая метка системы в шапке страницы: `LMS`, `CMS`. */
	mark: string;
	journal: Journal;
	scenario: Scenario;
	/** Снимок объектов сервиса: заявки у CMS, группы у LMS. */
	objects: () => unknown;
	/**
	 * То же для открытой страницы состояния; не задано — она показывает
	 * `objects` целиком.
	 *
	 * Страница видна снаружи, а `__state` закрыт токеном, и это разные права на
	 * одни и те же объекты: в присланном из CRM снимке статуса есть имя
	 * ответственного и последний комментарий, и печатать их зрителю стенда
	 * незачем (`docs/security.md`).
	 */
	pageObjects?: () => unknown;
	/**
	 * Объекты страницы для человека — таблица, уже экранированная сервисом; не
	 * задано — они видны только JSON в технических подробностях.
	 */
	overview?: () => string;
	/** Забыть всё, что сервис накопил: объекты и журнал. */
	forget: () => void;
	/** Настройки, по которым видно, настроен ли обмен со стендом. */
	settings: () => Record<string, unknown>;
	/** Формы-триггеры на странице состояния: по одной на сцену обмена. */
	forms: readonly TriggerForm[];
	/** Токен управляющих адресов; `null` — управление открыто. */
	controlToken?: string | null;
	/**
	 * Карточка одного объекта над формами страницы по строке запроса —
	 * разметка, уже экранированная сервисом; `null` — без карточки.
	 */
	spotlight?: (query: URLSearchParams) => string | null;
};

/** Сверка постоянная по времени: по обычному сравнению токен подбирается побайтно. */
function tokenMatches(expected: string, actual: string): boolean {
	const left = Buffer.from(expected, 'utf8');
	const right = Buffer.from(actual, 'utf8');

	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * Управляет ли имитатором тот, кто прислал запрос.
 *
 * Токен не задан — управление открыто: так имитатор живёт на машине
 * разработчика и в прогонах, где он доступен только с петли. На стенде токен
 * обязателен (`docker-compose.prod.yml` требует непустое значение), поэтому
 * снаружи это всегда `false`.
 */
export function controlAllowed(controlToken: string | null, request: MockRequest): boolean {
	return controlToken === null || tokenMatches(controlToken, request.headers[CONTROL_HEADER] ?? '');
}

/** Отказ в управлении имитатором; `null` — токен предъявлен либо не нужен. */
export function controlRefusal(
	controlToken: string | null,
	request: MockRequest
): MockReply | null {
	return controlAllowed(controlToken, request)
		? null
		: problem(
				403,
				'control_forbidden',
				`Управление имитатором закрыто токеном: назовите его в заголовке ${CONTROL_HEADER}`
			);
}

export function controlRoutes(options: ControlOptions): MockRoute[] {
	const { name, title, journal, scenario, objects, forget, settings, forms } = options;
	const controlToken = options.controlToken ?? null;
	const pageObjects = options.pageObjects ?? objects;

	/** Отказ управляющему адресу; `null` — токен предъявлен либо не нужен. */
	function refuseControl(request: MockRequest): MockReply | null {
		return controlRefusal(controlToken, request);
	}

	function snapshot(): Record<string, unknown> {
		return {
			service: name,
			settings: settings(),
			scenario: scenario.read(),
			objects: objects(),
			journal: journal.list()
		};
	}

	return [
		{
			method: 'GET',
			path: '/__state',
			contract: false,
			handle: (request) => refuseControl(request) ?? { status: 200, json: snapshot() }
		},
		{
			method: 'GET',
			path: '/',
			contract: false,
			handle: (request) => ({
				status: 200,
				html: renderStatePage({
					spotlight: options.spotlight?.(request.url.searchParams) ?? null,
					name,
					title,
					intro: options.intro,
					mark: options.mark,
					overview: options.overview?.() ?? null,
					scenario: scenario.read(),
					objects: pageObjects(),
					journal: journal.list(),
					forms,
					controlProtected: controlToken !== null
				})
			})
		},
		{
			method: 'POST',
			path: '/__scenario',
			contract: false,
			handle: (request) => {
				const refusal = refuseControl(request);

				if (refusal !== null) {
					return refusal;
				}

				let body: unknown;

				try {
					body = request.rawBody === '' ? {} : JSON.parse(request.rawBody);
				} catch {
					return problem(400, 'validation', 'Тело сценария не разбирается как JSON');
				}

				const applied = scenario.apply(body);

				if (!applied.ok) {
					return problem(400, 'validation', applied.issues.join('; '));
				}

				if (applied.reset) {
					forget();
				}

				return { status: 200, json: { scenario: scenario.read(), reset: applied.reset } };
			}
		}
	];
}
