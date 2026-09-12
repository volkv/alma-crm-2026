import postgres from 'postgres';
import { seedId } from '../scripts/seed/ids';
import { expect, test } from './fixtures';
import { ADMIN_STATE } from './global-setup';

/**
 * Сквозной проход по обещанию m0: карточка → стадия → документ.
 *
 * Проверка идёт по сидированным данным — тем самым, которые увидит жюри, — и
 * работает с одним взаимодействием набора. Своё оно не заводит нарочно: тогда
 * проверялась бы форма заведения (это делает `interactions.test.ts`), а не
 * стенд, который показывают. Повторный прогон получает то же начальное
 * состояние, потому что `beforeAll` возвращает это взаимодействие к началу
 * маршрута: удаляет всё, что проход успел сделать в прошлый раз, и заново
 * открывает первую стадию задолго до срока.
 */

/** Ключ взаимодействия из `scripts/seed/interactions.ts`. */
const SEED_KEY = 'szpu-vo';

const INTERACTION_ID = seedId('interaction', SEED_KEY);

/** Названия сидированных взаимодействий: по ним проверяется фильтр списка. */
const TARGET_TITLE = 'СЗПУ: подготовка по прикладной информатике, 2026/2027';

const OVERDUE_TITLES = [
	TARGET_TITLE,
	'ВКГТУ: системы связи, пакет документов на 2026/2027',
	'ПУТС: передача материалов и лицензий на учебный год',
	'ВКГТУ: обучение преподавателей промышленной разработке'
];

/**
 * Взаимодействие, которого под фильтром просроченных быть не должно. Взято
 * стоящее на паузе: часы стадии у него остановлены, поэтому оно не станет
 * просроченным, сколько бы база прогона ни жила между запусками.
 */
const IN_TIME_TITLE = 'ПУПИ: магистратура по инженерии данных';

/** Сколько дней назад взаимодействие вошло на первую стадию (норматив — 7). */
const ON_STAGE_DAYS = 62;

function databaseUrl(): string {
	const server = test.info().config.webServer;
	const url = (Array.isArray(server) ? server[0] : server)?.env?.DATABASE_URL;

	if (typeof url !== 'string') {
		throw new Error('playwright.config.ts must set DATABASE_URL for the web server');
	}

	return url;
}

/** Сколько переходов по стадиям уже записано в журнале по этому взаимодействию. */
let advancedBefore = 0;

test.beforeAll(async () => {
	const sql = postgres(databaseUrl(), { max: 1, connect_timeout: 10 });

	try {
		await sql.begin(async (tx) => {
			// Документы прошлого прохода уходят первыми: на них ссылается отметка
			// подтверждения стадии.
			await tx`delete from documents where interaction_id = ${INTERACTION_ID}`;

			const [first] = await tx<{ id: string }[]>`
				select id from stage_entries
				where interaction_id = ${INTERACTION_ID}
				order by entered_at asc
				limit 1
			`;

			if (first === undefined) {
				throw new Error(
					`Взаимодействие «${SEED_KEY}» не залито: e2e работает по данным сида, см. global-setup`
				);
			}

			await tx`
				delete from stage_entries
				where interaction_id = ${INTERACTION_ID} and id <> ${first.id}
			`;

			// Первая стадия открывается заново — той же записью, с её слепком:
			// собирать слепок в тесте значило бы повторить движок.
			await tx`
				update stage_entries set
					left_at = null,
					outcome = null,
					outcome_reason = null,
					checklist_state = '{}'::jsonb,
					result_text = null,
					confirmation = null,
					confirmation_document_id = null,
					confirmed_at = null,
					confirmed_by = null,
					entered_at = now() - make_interval(days => ${ON_STAGE_DAYS})
				where id = ${first.id}
			`;

			await tx`
				update interactions set status = 'active' where id = ${INTERACTION_ID}
			`;
		});

		// Журнал неизменяем, поэтому события прошлых прогонов остаются: проверка
		// считает не «есть ли событие», а «прибавилось ли».
		const [row] = await sql<{ count: string }[]>`
			select count(*) as count from audit_events
			where subject_id = ${INTERACTION_ID} and event_type = 'interactions.stage_advanced'
		`;

		advancedBefore = Number(row.count);
	} finally {
		await sql.end();
	}
});

test('демонстрационный проход: карточка, стадия, документ, журнал', async ({ page, browser }) => {
	/** Идентификаторы собранных документов: их спрашивают у журнала. */
	let documentIds: string[] = [];

	// Проход собирает документ через LibreOffice в Gotenberg: это секунды, а не
	// миллисекунды, и сравнивать его с обычной проверкой страницы нечестно.
	test.slow();

	const baseURL = test.info().project.use.baseURL;

	if (baseURL === undefined) {
		throw new Error('playwright.config.ts must set baseURL');
	}

	await test.step('список показывает просроченные взаимодействия', async () => {
		await page.goto('/interactions?overdue=true&size=100');

		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Взаимодействия');

		for (const title of OVERDUE_TITLES) {
			await expect(page.getByRole('cell', { name: title })).toBeVisible();
		}

		await expect(page.getByRole('cell', { name: IN_TIME_TITLE })).toHaveCount(0);
	});

	await test.step('карточка объясняет просрочку и не даёт перейти дальше', async () => {
		// Строка открывается кодом страницы, поэтому нажимаем, пока страница не
		// ожила и переход не случился.
		await expect(async () => {
			await page.getByRole('row').filter({ hasText: TARGET_TITLE }).first().click();
			await expect(page).toHaveURL(`/interactions/${INTERACTION_ID}`, { timeout: 3000 });
		}).toPass({ timeout: 20_000 });

		await expect(page.getByRole('heading', { level: 1 })).toHaveText(TARGET_TITLE);
		// Срок виден и на ленте стадий, и в сводке — берём первое совпадение.
		await expect(page.getByText(/просрочено на/).first()).toBeVisible();

		const advance = page.getByRole('button', { name: 'Перейти: Коммуникация и сверка программ' });

		await expect(advance).toBeDisabled();
		await expect(page.getByText('Не закрыт обязательный пункт чек-листа')).toBeVisible();
	});

	await test.step('закрытый чек-лист открывает переход на следующую стадию', async () => {
		await page.getByRole('switch', { name: 'Найдено профильное подразделение' }).click();
		await page.getByRole('switch', { name: 'Подтверждён контакт ответственного лица' }).click();

		const advance = page.getByRole('button', { name: 'Перейти: Коммуникация и сверка программ' });

		await expect(advance).toBeEnabled();
		await advance.click();

		await expect(
			page.locator('[data-slot="stage-timeline"] [aria-current="step"]')
		).toHaveAccessibleName(/Коммуникация и сверка программ — текущая/);
		await expect(
			page.getByRole('button', { name: 'Перейти: Встреча с представителями' })
		).toBeVisible();

		await page.getByRole('tab', { name: 'История' }).click();
		await expect(page.getByText('1. Поиск контактных лиц')).toBeVisible();
		await expect(page.getByText('пройдена').first()).toBeVisible();
	});

	await test.step('соглашение собирается в DOCX и PDF', async () => {
		await page.getByRole('tab', { name: 'Документы' }).click();
		await expect(page.getByText('Документов пока нет')).toBeVisible();

		await page.getByLabel('Город подписания').fill('Москва');
		await page
			.getByLabel('Подписант оператора (в родительном падеже)')
			.fill('директора Орлова В. С.');
		await page.getByLabel('Подписант учебного заведения').fill('ректора Астахова Л. П.');
		await page.getByRole('button', { name: 'Сгенерировать соглашение' }).click();

		const links = page.getByRole('link', { name: 'Скачать' });

		await expect(links).toHaveCount(2);

		const hrefs = await links.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute('href') ?? '')
		);

		documentIds = hrefs.map((href) => href.split('/').at(-2) ?? '');

		const responses = await Promise.all(hrefs.map((href) => page.request.get(href)));
		const types = responses.map((response) => response.headers()['content-type']);
		const pdf = responses[types.indexOf('application/pdf')];

		expect(types).toContain(
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		);
		expect(pdf).toBeDefined();
		expect(pdf.status()).toBe(200);
		// Пустой PDF весит около сотни байт: это проверка того, что в файле есть
		// документ, а не заголовок.
		expect((await pdf.body()).byteLength).toBeGreaterThan(1024);
	});

	await test.step('журнал администратора знает о переходе и о документе', async () => {
		const context = await browser.newContext({ baseURL, storageState: ADMIN_STATE });

		try {
			const audit = await context.newPage();
			const rows = audit.locator('[data-slot="data-table"] tbody tr');

			await audit.goto(
				`/audit?subject=${INTERACTION_ID}&type=interactions.stage_advanced&size=100`
			);
			await expect(audit.getByRole('heading', { level: 1 })).toHaveText('Журнал действий');
			await expect(rows).toHaveCount(advancedBefore + 1);

			// У события генерации объект — сам документ, а не взаимодействие,
			// поэтому спрашиваем журнал про каждый собранный файл по отдельности.
			expect(documentIds).toHaveLength(2);

			for (const documentId of documentIds) {
				await audit.goto(`/audit?subject=${documentId}&type=documents.generated&size=100`);
				await expect(rows).toHaveCount(1);
			}
		} finally {
			await context.close();
		}
	});
});
