/**
 * Управление имитатором: состояние, сценарий отказов, страница.
 *
 * Адреса начинаются с `__` — так их не спутать с эндпоинтами контракта, за
 * которые имитатор отвечает перед CRM: у настоящей CMS нет ни `__state`, ни
 * `__scenario`, и в обмене они не участвуют. Сценарий отказов на них не
 * действует (`MockRoute.contract: false`), иначе включённый сценарий нельзя
 * было бы ни посмотреть, ни снять.
 */
import type { Journal } from './journal.ts';
import { problem, type MockRoute } from './http.ts';
import type { Scenario } from './scenario.ts';
import { renderStatePage } from './state-page.ts';

export type ControlOptions = {
	/** Имя сервиса: `mock-cms`, `mock-lms`. */
	name: string;
	/** Заголовок страницы состояния. */
	title: string;
	journal: Journal;
	scenario: Scenario;
	/** Снимок объектов сервиса: заявки у CMS, группы у LMS. */
	objects: () => unknown;
	/** Забыть всё, что сервис накопил: объекты и журнал. */
	forget: () => void;
	/** Настройки, по которым видно, настроен ли обмен со стендом. */
	settings: () => Record<string, unknown>;
};

export function controlRoutes(options: ControlOptions): MockRoute[] {
	const { name, title, journal, scenario, objects, forget, settings } = options;

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
			handle: () => ({ status: 200, json: snapshot() })
		},
		{
			method: 'GET',
			path: '/',
			contract: false,
			handle: () => ({
				status: 200,
				html: renderStatePage({
					name,
					title,
					scenario: scenario.read(),
					objects: objects(),
					journal: journal.list()
				})
			})
		},
		{
			method: 'POST',
			path: '/__scenario',
			contract: false,
			handle: (request) => {
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
