import {
	expect,
	test as base,
	type APIRequestContext,
	type Locator,
	type Page
} from '@playwright/test';
import { E2E_EXCHANGE_KEYS } from './exchange-keys';
import { STAFF_ADMIN_STATE } from './global-setup';
import { waitForHydration } from './helpers/hydration';

/**
 * Обмен в четыре стороны против имитаторов стенда.
 *
 * Сцену начинает не прогон, а имитатор: «на сайте заполнили форму» — это его
 * триггер `POST /__send-application`, и заявка приходит в CRM по сети, из
 * чужого процесса, своим ключом обмена. Так же возвращается и результат
 * учебной группы: его отправляет триггер имитатора LMS. Имитаторы подняты
 * контейнерами из `docker-compose.yml` (`mock-cms` на 58081, `mock-lms` на
 * 58082), а приложение прогона живёт на хосте — до него они достают по
 * `host.docker.internal` (`e2e/stack.ts`, `extra_hosts` в compose).
 *
 * Ключи обмена прогону выпускать не нужно: их завёл сид из тех же значений, с
 * которыми поднялись имитаторы (`e2e/exchange-keys.ts`). Выпуск ключа из
 * интерфейса проверяется там, где он и есть предмет проверки, — в разделе
 * настроек (`e2e/admin.test.ts`).
 *
 * Имитатор — не интеграция: его ответ ничего не доказывает о системах
 * заказчика. Доказывает он другое — что CRM говорит на объявленном контракте и
 * не теряет сообщений, в том числе после отказа получателя.
 */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });

/**
 * Проход ждёт цикл интеграций: снимок статуса уходит не в ответе на запрос, а
 * следующим проходом — как и на стенде. Плюс повтор после отказа по сценарию:
 * первая задержка расписания — 15 с. Тридцати секунд по умолчанию на это не
 * хватает, и ждать их должен тест, а не повторный прогон.
 */
base.setTimeout(180_000);

const CMS_URL = 'http://localhost:58081';
const LMS_URL = 'http://localhost:58082';

/** Ключ заявки: свой на прогон, иначе вторая заявка обновила бы первую. */
const externalId = `e2e-${Date.now().toString(36)}`;

/**
 * Ключ заявки, которую подаёт кнопка стенда: своего ключа у неё нет — имитатор
 * берёт ключ заявки набора (`mocks/mock-cms/applications.ts`).
 */
const demoExternalId = 'site-2026-000123';

/** Имя вуза заявки: по нему взаимодействие ищется в списке. */
const applicantName = `Политехнический университет прогона ${externalId}`;

type MockState = {
	objects: {
		applications?: {
			externalId: string;
			origin: string;
			revision: number | null;
			statuses: { data: Record<string, unknown> }[];
		}[];
		groups?: { requestExternalId: string; groupExternalId: string }[];
	};
	journal: {
		direction: string;
		summary: string;
		status: number | null;
		eventType: string | null;
		payload: { data?: Record<string, unknown> } | null;
	}[];
};

async function mockState(request: APIRequestContext, service: string): Promise<MockState> {
	const response = await request.get(`${service}/__state`);

	expect(response.ok()).toBeTruthy();

	return (await response.json()) as MockState;
}

/**
 * Сценарий отказов имитатора. Сужается ключом заявки (`match`): имитатор на
 * стенде один, и сломанная доставка этой заявки не должна задевать соседние
 * проверки, идущие рядом.
 */
async function applyScenario(
	request: APIRequestContext,
	service: string,
	scenario: Record<string, unknown>
): Promise<void> {
	const response = await request.post(`${service}/__scenario`, { data: scenario });

	expect(response.status()).toBe(200);
}

/** Строка журнала обмена на экране «Внешние системы» по типу события. */
function journalRow(page: Page, eventType: string) {
	return page.getByRole('row').filter({ hasText: eventType }).first();
}

/**
 * Ячейка строки журнала по названию колонки.
 *
 * Номер ячейки в строке — не свойство данных: колонки журнала переставляются, а
 * второстепенные и вовсе уходят с экрана по его ширине, и записанный числом
 * номер однажды указал бы на соседнюю. Индекс берётся у шапки той же таблицы:
 * скрытая колонка одинаково выпадает и из шапки, и из строки.
 */
async function journalCell(page: Page, row: Locator, column: string): Promise<Locator> {
	const headers = await page.getByRole('columnheader').allInnerTexts();
	const index = headers.findIndex((title) => title.trim() === column);

	expect(index, `колонка «${column}» на экране журнала`).toBeGreaterThanOrEqual(0);

	return row.getByRole('cell').nth(index);
}

staff(
	'заявка с сайта, статус в CMS, группа в LMS и результат обратно',
	async ({ page, request }) => {
		// Первый снимок статуса имитатор отвергнет 503 — временный отказ, который
		// система обязана пережить повтором. Только по нашей заявке.
		await applyScenario(request, CMS_URL, { failNext: 1, status: 503, match: externalId });

		// Направление 1: заявку подаёт сам имитатор — так, как её подал бы
		// посетитель сайта. Тело заявки своё: по имени вуза взаимодействие потом
		// ищется в списке.
		const submitted = await request.post(`${CMS_URL}/__send-application`, {
			data: {
				form: 'b2b',
				externalId,
				data: {
					form: 'b2b',
					applicant: {
						kind: 'educational_institution',
						name: applicantName,
						inn: '0000000018',
						educationLevel: 'vo'
					},
					contact: {
						lastName: 'Кузьмина',
						firstName: 'Наталья',
						email: `kuzmina-${externalId}@example.org`,
						phone: '+7 900 000-00-11',
						position: 'Проректор по цифровому развитию'
					},
					interest: 'Программа подготовки DevOps-инженеров'
				}
			}
		});

		expect(submitted.status()).toBe(200);

		const sent = (await submitted.json()) as {
			externalId: string;
			crm: { status: number | null; body: { result: string; data: { interactionId: string } } };
		};

		// Имитатор дошёл до приложения по сети и получил от него ответ контракта.
		expect(sent.crm.status).toBe(200);
		expect(sent.crm.body.result).toBe('created');

		const interactionId = sent.crm.body.data.interactionId;

		// Взаимодействие видно в разделе: заявка не третья сущность рядом с
		// контрагентом и взаимодействием, а сразу взаимодействие. Поиск по ключу
		// прогона, а не первая страница списка: список отсортирован по сроку стадии,
		// и свежая заявка со сроком в будущем стоит в нём последней.
		await page.goto(`/interactions?q=${encodeURIComponent(externalId)}`);
		await expect(page.getByText(`Заявка с сайта: ${applicantName}`)).toBeVisible();

		// Направление 2: снимок статуса уходит в чужой процесс. Первую попытку
		// имитатор отверг по сценарию, поэтому ждём не первой попытки, а карточки с
		// доставленным статусом — то есть восстановления после отказа.
		await expect(async () => {
			const state = await mockState(request, CMS_URL);
			const card = state.objects.applications?.find((item) => item.externalId === externalId);

			expect(card?.statuses.length ?? 0).toBeGreaterThan(0);
		}).toPass({ timeout: 120_000, intervals: [2000] });

		const cmsState = await mockState(request, CMS_URL);
		const card = cmsState.objects.applications?.find((item) => item.externalId === externalId);

		// Карточка на сайте — та самая, которую завела форма имитатора, и в ней
		// лежит снимок состояния из CRM.
		expect(card?.origin).toBe('form');
		expect(card?.statuses.at(-1)?.data).toMatchObject({
			externalId,
			applicationStatus: 'received',
			stage: { position: 1 }
		});

		const ours = cmsState.journal.filter((entry) => entry.summary.includes(externalId));

		// Сообщение дошло по сети до эндпоинта контракта и **прошло проверку
		// подписи**: неподписанное или подписанное чужим секретом имитатор отвергает
		// кодом 401, не разбирая тела. Тело он разобрал — в журнале лежит конверт со
		// снимком состояния заявки.
		const accepted = ours.find((entry) => entry.status === 200);

		expect(accepted?.eventType).toBe('application.status');
		expect(accepted?.payload?.data).toMatchObject({ externalId, applicationStatus: 'received' });

		// И отказ по сценарию в журнале имитатора остался: доставка была не с первой
		// попытки.
		expect(ours.filter((entry) => entry.status === 503)).toHaveLength(1);

		// Журнал CRM говорит то же самое со своей стороны: сообщение доставлено, и
		// попыток было больше одной.
		await page.goto(`/exchange?q=${encodeURIComponent(externalId)}`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Внешние системы');

		const statusRow = journalRow(page, 'application.status');

		await expect(statusRow).toContainText('Отправлено');
		// Колонка «Попытки»: первая ушла в отказ, доставила вторая.
		await expect(await journalCell(page, statusRow, 'Попытки')).toContainText('2');

		// Направление 3: заявку на учебную группу отправляет сотрудник с карточки.
		await page.goto(`/interactions/${interactionId}`);
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Заявка с сайта');

		await page.getByLabel('Мест в потоке').fill('45');
		// Дату держит компонент: человек пишет `01.10.2026`, а форме уходит
		// `2026-10-01` скрытым полем, — и набранное до того, как страница ожила, в
		// эту форму не попадает совсем.
		await waitForHydration(page);
		await page.getByLabel('Начало занятий').fill('01.10.2026');
		await expect(page.locator('input[name="startsOn"]')).toHaveValue('2026-10-01');
		await page.getByRole('button', { name: 'Отправить в LMS' }).click();

		const groupRequestId = `crm-group-${interactionId}-1`;

		await expect(async () => {
			const state = await mockState(request, LMS_URL);
			const group = state.objects.groups?.find((item) => item.requestExternalId === groupRequestId);

			expect(group).toBeDefined();
		}).toPass({ timeout: 30_000, intervals: [1000] });

		const lmsState = await mockState(request, LMS_URL);
		const group = lmsState.objects.groups?.find(
			(item) => item.requestExternalId === groupRequestId
		);

		expect(group).toBeDefined();

		// Карточка показывает заведённый поток и его имя в системе обучения.
		await page.reload();
		await expect(page.getByText(`Поток 1`)).toBeVisible();
		await expect(page.getByText(group!.groupExternalId, { exact: false }).first()).toBeVisible();

		// Ключ сайта на результат группы не проходит: право `exchange.results` есть
		// у обоих ключей обмена, и различает их только подключение. Ключ здесь тот
		// самый, которым представляется имитатор CMS.
		const crossed = await request.post('/api/v1/exchange/learning-groups/results', {
			headers: {
				authorization: `Bearer ${E2E_EXCHANGE_KEYS.cms}`,
				'content-type': 'application/json'
			},
			data: {
				schemaVersion: '1.0',
				eventId: crypto.randomUUID(),
				eventType: 'learning_group.result',
				occurredAt: new Date().toISOString(),
				source: { system: 'lms', instance: 'moodle-itschool' },
				data: {
					groupExternalId: group!.groupExternalId,
					counters: { enrolled: 1, completed: 1, expelled: 0 }
				}
			}
		});

		expect(crossed.status()).toBe(403);

		// Направление 4: результат потока отправляет сама система обучения — тем же
		// триггером, которым его отправляют со страницы имитатора. Стадию он
		// подтверждает, но никуда её не двигает: переход остаётся за человеком.
		const result = await request.post(`${LMS_URL}/__send-result`, {
			data: {
				requestExternalId: groupRequestId,
				period: { start: '2026-10-01', end: '2027-05-31' },
				finishedOn: '2027-05-20',
				counters: { enrolled: 45, completed: 38, expelled: 4 }
			}
		});

		expect(result.status()).toBe(200);

		const applied = (await result.json()) as {
			crm: { status: number | null; body: { result: string } };
		};

		expect(applied.crm.status).toBe(200);
		expect(applied.crm.body.result).toBe('created');

		// Факт виден на карточке: числа приехали из чужой системы и стали частью
		// работы по взаимодействию.
		await page.reload();
		await expect(page.getByText('завершили 38', { exact: false }).first()).toBeVisible();

		// И журнал обмена показывает обе стороны одним списком — вместе с тем, чем
		// ответил получатель.
		await page.goto('/exchange');
		await expect(page.getByText('application.submitted').first()).toBeVisible();
		await expect(page.getByText('application.status').first()).toBeVisible();
		await expect(page.getByText('learning_group.requested').first()).toBeVisible();
		await expect(page.getByText('learning_group.result').first()).toBeVisible();
	}
);

staff('кнопка стенда подаёт заявку тем же триггером имитатора', async ({ page, request }) => {
	// Демонстрационная кнопка не своя дорога в обход контракта: она жмёт тот же
	// `POST /__send-application`, и заявка приезжает в CRM от имитатора. Ревизия
	// заявки набора считается от того, что имитатор помнит: контейнер стенда
	// переживает прогон, и карточка могла остаться от предыдущего.
	const before = await mockState(request, CMS_URL);
	const revisionBefore =
		before.objects.applications?.find((item) => item.externalId === demoExternalId)?.revision ?? 0;

	await page.goto('/exchange');
	await page.getByRole('button', { name: 'Демо: заявка с сайта' }).click();

	await expect(page.getByText(`Имитатор CMS подал заявку ${demoExternalId}`)).toBeVisible();

	const after = await mockState(request, CMS_URL);
	const card = after.objects.applications?.find((item) => item.externalId === demoExternalId);

	// Заявку завела форма имитатора, а не снимок статуса из CRM, и это новая
	// ревизия: кнопку нажали именно сейчас.
	expect(card?.origin).toBe('form');
	expect(card?.revision ?? 0).toBeGreaterThan(revisionBefore);
});

staff('заявка чужого экземпляра не принимается', async ({ request }) => {
	const response = await request.post('/api/v1/applications', {
		headers: {
			authorization: `Bearer ${E2E_EXCHANGE_KEYS.cms}`,
			'content-type': 'application/json'
		},
		data: {
			schemaVersion: '1.0',
			eventId: crypto.randomUUID(),
			eventType: 'application.submitted',
			occurredAt: new Date().toISOString(),
			source: { system: 'cms', instance: 'другая-площадка' },
			data: {
				externalId: `${externalId}-stranger`,
				revision: 1,
				form: 'b2b',
				applicant: {
					kind: 'educational_institution',
					name: 'Чужая площадка',
					educationLevel: 'vo'
				},
				contact: {
					lastName: 'Иванов',
					firstName: 'Иван',
					email: `ivanov-${externalId}@example.org`
				}
			}
		}
	});

	// Экземпляр определяется подключением, а не полем из тела: иначе отправитель
	// переписал бы себе чужой экземпляр одной строкой в JSON.
	expect(response.status()).toBe(403);
});
