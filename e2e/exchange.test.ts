import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import { STAFF_ADMIN_STATE } from './global-setup';

/**
 * Обмен в четыре стороны против имитаторов стенда.
 *
 * Что здесь проверяется по-настоящему: приложение принимает заявку в конверте
 * контракта своим ключом обмена, отдаёт снимок статуса в **чужой процесс** по
 * сети и заводит там же учебную группу, а результат группы подтверждает стадию,
 * не двигая взаимодействие. Имитаторы подняты контейнерами из `docker-compose.yml`
 * (`mock-cms` на 58081, `mock-lms` на 58082): важно именно то, что приложение
 * ходит до чужого процесса, а не до заглушки внутри себя. Перед прогоном их
 * поднимают: `docker compose up -d --wait mock-cms mock-lms`.
 *
 * Входящие сообщения отправляет сам прогон, а не имитатор. Причина
 * приземлённая: приложение прогона живёт на хосте, а имитаторы — в контейнерах,
 * и адрес CRM у них задан на сеть стенда. Конверт, ключ и маршрут при этом те
 * же самые, а путь «имитатор сам постучался в CRM» проверяется там, где оба
 * конца в одном процессе (`tests/integration/integrations/exchange.test.ts`).
 *
 * Имитатор — не интеграция: его ответ ничего не доказывает о системах
 * заказчика. Доказывает он другое — что CRM говорит на объявленном контракте.
 */
const staff = base.extend<object>({ storageState: STAFF_ADMIN_STATE });

/**
 * Проход ждёт цикл интеграций: снимок статуса уходит не в ответе на запрос, а
 * следующим проходом — как и на стенде. Тридцати секунд по умолчанию на это не
 * хватает, и ждать их должен тест, а не повторный прогон.
 */
base.setTimeout(180_000);

const CMS_URL = 'http://localhost:58081';
const LMS_URL = 'http://localhost:58082';

/** Ключ заявки: свой на прогон, иначе вторая заявка обновила бы первую. */
const externalId = `e2e-${Date.now().toString(36)}`;

type MockState = {
	objects: {
		applications?: { externalId: string; statuses: { data: Record<string, unknown> }[] }[];
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
 * Ключ обмена, выпущенный на машинного субъекта прямо в интерфейсе: показывают
 * его ровно один раз, и это единственный способ получить его — как у настоящей
 * внешней системы.
 *
 * Подключение указывается здесь же: права роли «Внешняя система» одинаковы у
 * всех ключей обмена, и только оно не даёт ключу сайта подать результат
 * учебной группы. Поэтому ключей в прогоне два — по одному на направление.
 */
async function issueExchangeKey(page: Page, connection: RegExp): Promise<string> {
	await page.goto('/settings/api-keys');

	const dialog = page.getByRole('dialog');

	await expect(async () => {
		await page.getByRole('button', { name: 'Выпустить ключ' }).first().click();
		await expect(dialog).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await dialog.getByLabel('Название').fill(`Обмен ${externalId}`);

	// Список собран не на нативном `select`, а на слое, который открывается
	// только после гидратации: первый клик может прийтись на ещё неживую
	// разметку, поэтому попытка повторяется.
	const owner = page.getByRole('option', { name: /Внешние системы/ });

	await expect(async () => {
		await dialog.getByLabel('Владелец').click();
		await expect(owner).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await owner.click();

	const system = page.getByRole('option', { name: connection });

	await expect(async () => {
		await dialog.getByLabel('Подключение обмена').click();
		await expect(system).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await system.click();
	await dialog.getByRole('button', { name: 'Выпустить ключ' }).click();

	const issued = page.getByRole('dialog').filter({ hasText: 'выпущен' });
	await expect(issued).toBeVisible();

	const key = await issued.getByRole('textbox', { name: 'Ключ доступа' }).inputValue();

	expect(key).toMatch(/^lct_/);

	await issued.getByRole('button', { name: 'Готово' }).click();

	return key;
}

function envelope(eventType: string, system: string, data: unknown): Record<string, unknown> {
	return {
		schemaVersion: '1.0',
		eventId: crypto.randomUUID(),
		eventType,
		occurredAt: new Date().toISOString(),
		source: { system, instance: system === 'cms' ? 'itschool-site' : 'moodle-itschool' },
		data
	};
}

staff('заявка, статус в CMS, группа в LMS и результат обратно', async ({ page, request }) => {
	// Ключей два: направление у ключа обмена одно, и оно задаётся при выпуске.
	const key = await issueExchangeKey(page, /Сайт/);
	const lmsKey = await issueExchangeKey(page, /Система обучения/);

	// Направление 1: заявка с сайта в конверте контракта.
	const intake = await request.post('/api/v1/applications', {
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		data: envelope('application.submitted', 'cms', {
			externalId,
			revision: 1,
			form: 'b2b',
			applicant: {
				kind: 'educational_institution',
				name: `Политехнический университет прогона ${externalId}`,
				inn: '7802450127',
				educationLevel: 'vo'
			},
			contact: {
				lastName: 'Кузьмина',
				firstName: 'Наталья',
				email: `kuzmina-${externalId}@example.org`,
				phone: '+7 900 000-00-11',
				position: 'Проректор по цифровому развитию'
			},
			interest: 'Программа подготовки по прикладной информатике'
		})
	});

	expect(intake.status()).toBe(200);

	const accepted = (await intake.json()) as {
		result: string;
		data: { interactionId: string };
	};

	expect(accepted.result).toBe('created');

	// Взаимодействие видно в разделе: заявка не третья сущность рядом с
	// контрагентом и взаимодействием, а сразу взаимодействие. Поиск по ключу
	// прогона, а не первая страница списка: список отсортирован по сроку стадии,
	// и свежая заявка со сроком в будущем стоит в нём последней.
	await page.goto(`/interactions?q=${encodeURIComponent(externalId)}`);
	await expect(
		page.getByText(`Заявка с сайта: Политехнический университет прогона ${externalId}`)
	).toBeVisible();

	// Направление 2: снимок статуса уходит в чужой процесс. Отправляет его цикл
	// интеграций, поэтому ждём — как ждал бы сотрудник.
	await expect(async () => {
		const state = await mockState(request, CMS_URL);
		const delivered = state.journal.find((entry) => entry.summary.includes(externalId));

		expect(delivered).toBeDefined();
	}).toPass({ timeout: 120_000, intervals: [2000] });

	const cmsJournal = await mockState(request, CMS_URL);
	const delivered = cmsJournal.journal.find((entry) => entry.summary.includes(externalId));

	// Сообщение дошло по сети до эндпоинта контракта и **прошло проверку
	// подписи**: неподписанное или подписанное чужим секретом имитатор отвергает
	// кодом 401, не разбирая тела. Тело он разобрал — в журнале лежит конверт со
	// снимком состояния заявки.
	expect(delivered?.eventType).toBe('application.status');
	expect(delivered?.payload?.data).toMatchObject({
		externalId,
		applicationStatus: 'received',
		stage: { position: 1 }
	});

	// Отвечает имитатор `404`, и это правильно: заявку он не отправлял — её
	// положил в CRM сам прогон, а карточки с таким ключом на сайте нет. Полный
	// круг «сайт отправил — CRM приняла — статус вернулся в карточку» проверяется
	// там, где оба конца в одном процессе: `tests/integration/integrations/exchange.test.ts`.
	expect(delivered?.status).toBe(404);

	// Направление 3: заявку на учебную группу отправляет сотрудник с карточки.
	await page.goto(`/interactions/${accepted.data.interactionId}`);
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Заявка с сайта');

	await page.getByLabel('Мест в потоке').fill('45');
	await page.getByLabel('Начало занятий').fill('2026-10-01');
	await page.getByRole('button', { name: 'Отправить в LMS' }).click();

	const groupRequestId = `crm-group-${accepted.data.interactionId}-1`;

	await expect(async () => {
		const state = await mockState(request, LMS_URL);
		const group = state.objects.groups?.find((item) => item.requestExternalId === groupRequestId);

		expect(group).toBeDefined();
	}).toPass({ timeout: 30_000, intervals: [1000] });

	const lmsState = await mockState(request, LMS_URL);
	const group = lmsState.objects.groups?.find((item) => item.requestExternalId === groupRequestId);

	expect(group).toBeDefined();

	// Карточка показывает заведённый поток и его имя в системе обучения.
	await page.reload();
	await expect(page.getByText(`Поток 1`)).toBeVisible();
	await expect(page.getByText(group!.groupExternalId, { exact: false }).first()).toBeVisible();

	// Ключ сайта на результат группы не проходит: право `exchange.results` есть
	// у обоих ключей обмена, и различает их только подключение.
	const crossed = await request.post('/api/v1/exchange/learning-groups/results', {
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		data: envelope('learning_group.result', 'lms', {
			groupExternalId: group!.groupExternalId,
			counters: { enrolled: 1, completed: 1, expelled: 0 }
		})
	});

	expect(crossed.status()).toBe(403);

	// Направление 4: результат группы. Стадию он подтверждает, но никуда её не
	// двигает — переход остаётся решением сотрудника.
	const result = await request.post('/api/v1/exchange/learning-groups/results', {
		headers: { authorization: `Bearer ${lmsKey}`, 'content-type': 'application/json' },
		data: envelope('learning_group.result', 'lms', {
			groupExternalId: group!.groupExternalId,
			requestExternalId: groupRequestId,
			period: { start: '2026-10-01', end: '2027-05-31' },
			finishedOn: '2027-05-20',
			counters: { enrolled: 45, completed: 38, expelled: 4 }
		})
	});

	expect(result.status()).toBe(200);

	const applied = (await result.json()) as { result: string; data: { note: string } };

	expect(applied.result).toBe('created');

	// Факт виден на карточке: числа приехали из чужой системы и стали частью
	// работы по взаимодействию.
	await page.reload();
	await expect(page.getByText('завершили 38', { exact: false }).first()).toBeVisible();

	// И журнал обмена показывает обе стороны одним списком — вместе с тем, чем
	// ответил получатель.
	await page.goto('/exchange');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Внешние системы');
	await expect(page.getByText('application.submitted').first()).toBeVisible();
	await expect(page.getByText('application.status').first()).toBeVisible();
	await expect(page.getByText('learning_group.requested').first()).toBeVisible();
	await expect(page.getByText('learning_group.result').first()).toBeVisible();
	await expect(page.getByText('Получатель ответил 404').first()).toBeVisible();

	// Отказ получателя 4xx окончателен: повторять его бессмысленно, и сообщение
	// ждёт человека с кнопкой «Повторить».
	const failed = page.getByRole('row').filter({ hasText: 'Получатель ответил 404' }).first();

	await expect(failed).toContainText('Не доставлено');
	await expect(failed.getByRole('button', { name: 'Повторить' })).toBeVisible();
});

staff('заявка чужого экземпляра не принимается', async ({ page, request }) => {
	const key = await issueExchangeKey(page, /Сайт/);

	const response = await request.post('/api/v1/applications', {
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		data: {
			...envelope('application.submitted', 'cms', {
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
			}),
			source: { system: 'cms', instance: 'другая-площадка' }
		}
	});

	// Экземпляр определяется подключением, а не полем из тела: иначе отправитель
	// переписал бы себе чужой экземпляр одной строкой в JSON.
	expect(response.status()).toBe(403);
});
