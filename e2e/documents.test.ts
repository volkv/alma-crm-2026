import { Buffer } from 'node:buffer';
import type { Locator, Page } from '@playwright/test';
import { seedId } from '../scripts/seed/ids';
import { expect, test } from './fixtures';

/**
 * Раздел «Документы» в браузере: навигация, фильтр по формату и скачивание.
 *
 * Проход заводит свои файлы и считает только их. Сидированные соглашения для
 * этого не годятся: строка в базе переживает каталог данных, в котором лежит её
 * файл, и в среде, где базу оставили, а `DATA_DIR` завели заново, скачивание
 * такого документа честно отвечает отказом — файла нет. Свой файл кладёт и
 * читает один и тот же прогон, поэтому проверка говорит о разделе, а не о том,
 * чем заливали базу в прошлый раз.
 */

/** Взаимодействие, в карточку которого проход кладёт свои файлы. */
const INTERACTION_ID = seedId('interaction', 'bit-telecom');

/**
 * Метка прогона: делает названия уникальными в общей базе. У каждого теста своя
 * — иначе тест, который считает свои строки, увидел бы ещё и чужие, когда оба
 * попадут в один рабочий процесс.
 */
const TAG = crypto.randomUUID().slice(0, 8);
const LARGE_TAG = crypto.randomUUID().slice(0, 8);
const REVISION_TAG = crypto.randomUUID().slice(0, 8);

const PDF_TITLE = `Скан соглашения ${TAG}`;
const TEXT_TITLE = `Служебная записка ${TAG}`;
const LARGE_TITLE = `Скан крупного соглашения ${LARGE_TAG}`;

/** Настоящий PDF, пусть и минимальный: тип проверяется по содержимому файла. */
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');
const TEXT_BYTES = Buffer.from('Записка о составе пакета документов.\n', 'utf8');

/** Вторая редакция того же скана: другой файл, тот же документ. */
const REVISION_BYTES = Buffer.from('%PDF-1.7\n2 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

/**
 * Скан размером с настоящий: 1,2 МБ. Содержимое — тот же PDF, добитый пробелами
 * до нужного размера; тип определяется по первым байтам, остальное не важно.
 */
const LARGE_PDF_BYTES = largePdf(1_200_000);

function largePdf(sizeBytes: number): Buffer {
	const head = Buffer.from('%PDF-1.7\n% ', 'latin1');
	const tail = Buffer.from('\n%%EOF\n', 'latin1');
	const padding = Buffer.alloc(sizeBytes - head.byteLength - tail.byteLength, 0x20);

	return Buffer.concat([head, padding, tail]);
}

/** Строки раздела, заведённые прогоном с такой меткой. */
function taggedRows(page: Page, tag: string): Locator {
	return page.locator('[data-slot="data-table"] tbody tr[data-row]').filter({ hasText: tag });
}

/** Строки раздела, заведённые этим прогоном. */
function ownRows(page: Page): Locator {
	return taggedRows(page, TAG);
}

/**
 * Выбор в раскрывающемся списке: и форма, и фильтры списка собраны не на
 * нативном `select`, а на слое, который открывается только после гидратации
 * страницы. Первый клик может прийтись на ещё неживую разметку, поэтому попытка
 * повторяется.
 */
async function choose(trigger: Locator, option: Locator): Promise<void> {
	await expect(async () => {
		await trigger.click();
		await expect(option).toBeVisible({ timeout: 2000 });
	}).toPass({ timeout: 20_000 });

	await option.click();
}

/** Пункт раскрывающегося списка: слой рисуется порталом, а не внутри формы. */
function option(page: Page, label: string): Locator {
	return page.getByRole('option', { name: label, exact: true });
}

/**
 * Заполнить форму загрузки и отправить её, ничего не дожидаясь. Отдельно от
 * {@link upload} — тесту, который смотрит на код ответа, нужно успеть подписаться
 * на ответ до отправки.
 */
async function submitUpload(
	page: Page,
	title: string,
	kind: string,
	file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	// Форма загрузки — одна из карточек вкладки, и подписи полей у неё общие со
	// словарём продукта, поэтому поля ищутся внутри неё.
	const form = page.locator('[data-slot="card"]').filter({ hasText: 'Загрузить документ' });

	await form.getByLabel('Название').fill(title);
	await choose(form.getByLabel('Вид документа'), option(page, kind));
	await form.getByLabel('Файл').setInputFiles(file);
	await form.getByRole('button', { name: 'Загрузить' }).click();
}

async function upload(
	page: Page,
	title: string,
	kind: string,
	file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	await submitUpload(page, title, kind, file);

	await expect(page.getByText(title)).toBeVisible();
}

test('раздел показывает загруженные документы, фильтрует по формату и отдаёт файл', async ({
	page
}) => {
	await test.step('файлы загружаются из карточки взаимодействия', async () => {
		await page.goto(`/interactions/${INTERACTION_ID}`);
		await page.getByRole('tab', { name: 'Документы' }).click();

		await upload(page, PDF_TITLE, 'Соглашение', {
			name: 'agreement.pdf',
			mimeType: 'application/pdf',
			buffer: PDF_BYTES
		});
		await upload(page, TEXT_TITLE, 'Письмо', {
			name: 'note.txt',
			mimeType: 'text/plain',
			buffer: TEXT_BYTES
		});
	});

	await test.step('раздел открывается из навигации и показывает оба файла', async () => {
		await page.goto('/');
		await page
			.getByRole('navigation', { name: 'Разделы' })
			.getByRole('link', { name: 'Документы' })
			.click();

		await expect(page).toHaveURL('/documents');
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Документы');

		// Список открывается свежими документами, поэтому оба лежат на первой
		// странице, а формат у них разный — его показывает отдельная колонка.
		await expect(ownRows(page)).toHaveCount(2);
		await expect(ownRows(page).filter({ hasText: 'PDF' })).toHaveCount(1);
		await expect(ownRows(page).filter({ hasText: 'TXT' })).toHaveCount(1);

		// Строка ведёт в карточку, из которой файл пришёл.
		await expect(
			ownRows(page).first().getByRole('link', { name: 'БИТ: телекоммуникации' })
		).toBeVisible();

		await page.screenshot({ path: 'test-results/documents-list.png', fullPage: true });
	});

	await test.step('фильтр по формату оставляет только PDF', async () => {
		await choose(page.getByLabel('Формат'), option(page, 'PDF'));

		await expect(page).toHaveURL(/format=pdf/);
		await expect(ownRows(page)).toHaveCount(1);
		// Фильтр отбирает по типу файла, а не прячет строки в разметке: под ним
		// не остаётся ни одной строки другого формата — ни своей, ни чужой.
		await expect(page.getByRole('cell', { name: 'TXT', exact: true })).toHaveCount(0);
		await expect(page.getByRole('cell', { name: 'DOCX', exact: true })).toHaveCount(0);
	});

	await test.step('документ скачивается своим типом и под своим именем', async () => {
		const href = await ownRows(page)
			.first()
			.getByRole('link', { name: 'Скачать' })
			.getAttribute('href');

		if (href === null) {
			throw new Error('В строке документа нет ссылки на скачивание');
		}

		const response = await page.request.get(href);

		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toBe('application/pdf');
		// Имя приходит и в UTF-8 по RFC 5987: без этого кириллица в нём
		// превращается в мусор. Расширение берётся из типа, а не из имени файла,
		// под которым его прислали.
		expect(response.headers()['content-disposition']).toContain(
			`filename*=UTF-8''${encodeURIComponent(`${PDF_TITLE}.pdf`)}`
		);
		expect((await response.body()).byteLength).toBe(PDF_BYTES.byteLength);
	});
});

test('новая редакция заменяет файл в деле, а прежний остаётся по переключателю', async ({
	page
}) => {
	const title = `Скан соглашения ${REVISION_TAG}`;

	await page.goto(`/interactions/${INTERACTION_ID}`);
	await page.getByRole('tab', { name: 'Документы' }).click();

	await upload(page, title, 'Соглашение', {
		name: 'agreement.pdf',
		mimeType: 'application/pdf',
		buffer: PDF_BYTES
	});

	const panel = page.locator('[data-slot="card"]').filter({ hasText: 'Документы взаимодействия' });
	const row = panel.locator('li').filter({ hasText: title });

	await test.step('редакция загружается из строки документа', async () => {
		await row.getByRole('button', { name: 'Новая редакция' }).click();

		const dialog = page.getByRole('dialog');
		await expect(dialog.getByText(title)).toBeVisible();

		await dialog.getByLabel('Файл новой редакции').setInputFiles({
			name: 'agreement-v2.pdf',
			mimeType: 'application/pdf',
			buffer: REVISION_BYTES
		});
		await dialog.getByRole('button', { name: 'Загрузить редакцию' }).click();

		// Название у редакции то же, а строка в панели — одна: заменённая скрыта.
		await expect(row).toHaveCount(1);
		await expect(row.getByRole('button', { name: 'Новая редакция' })).toHaveCount(1);
	});

	await test.step('переключатель возвращает заменённую редакцию с пометкой', async () => {
		await panel.getByLabel('Показывать заменённые редакции').click();

		await expect(row).toHaveCount(2);
		// Строки идут от свежих к старым, поэтому заменённая — последняя своя.
		await expect(row.last().getByText(/Заменён редакцией от/)).toBeVisible();
		await expect(row.first().getByText(/Заменён редакцией от/)).toHaveCount(0);
	});

	await test.step('карточка документа показывает цепочку редакций', async () => {
		await row.last().getByRole('link', { name: title }).click();

		const chain = page.locator('section').filter({ hasText: 'Редакции' });
		await expect(chain.getByText('Редакция 1 ·')).toBeVisible();
		await expect(chain.getByText('Редакция 2 ·')).toBeVisible();
		await expect(chain.getByText('Действует')).toBeVisible();

		await page.screenshot({ path: 'test-results/documents-revisions.png', fullPage: true });
	});

	await test.step('раздел показывает только действующую редакцию', async () => {
		await page.goto('/documents');
		await expect(taggedRows(page, REVISION_TAG)).toHaveCount(1);

		await choose(page.getByLabel('Редакции'), option(page, 'Все редакции'));

		await expect(page).toHaveURL(/revisions=all/);
		await expect(taggedRows(page, REVISION_TAG)).toHaveCount(2);
		await expect(taggedRows(page, REVISION_TAG).filter({ hasText: 'Заменён' })).toHaveCount(1);
	});
});

/**
 * Сторож `BODY_SIZE_LIMIT`.
 *
 * adapter-node режет тело запроса по этому потолку и по умолчанию ставит его в
 * 512 КиБ — в полсотни раз ниже потолка загрузки в контрактах. При умолчании
 * скан любого настоящего документа получает 413 ещё до маршрута: сервер не
 * дочитывает тело, приложение о запросе не узнаёт, а человек видит пустой отказ
 * вместо объяснения. Значение задано в обоих compose и в `playwright.config.ts`;
 * убрать его оттуда — уронить этот тест.
 */
test('скан на 1,2 МБ доходит до приложения, а не упирается в потолок тела запроса', async ({
	page
}) => {
	await page.goto(`/interactions/${INTERACTION_ID}`);
	await page.getByRole('tab', { name: 'Документы' }).click();

	// Подписка до отправки: ответ на форму нужен целиком, а не по следам в UI.
	const posted = page.waitForResponse(
		(response) => response.request().method() === 'POST' && response.url().includes('?/upload')
	);

	await submitUpload(page, LARGE_TITLE, 'Соглашение', {
		name: 'scan.pdf',
		mimeType: 'application/pdf',
		buffer: LARGE_PDF_BYTES
	});

	expect((await posted).status()).toBe(200);
	await expect(page.getByText(LARGE_TITLE)).toBeVisible();

	await page.goto('/documents');
	await expect(taggedRows(page, LARGE_TAG)).toHaveCount(1);

	const href = await taggedRows(page, LARGE_TAG)
		.first()
		.getByRole('link', { name: 'Скачать' })
		.getAttribute('href');

	if (href === null) {
		throw new Error('В строке документа нет ссылки на скачивание');
	}

	const response = await page.request.get(href);

	expect(response.status()).toBe(200);
	// Файл дошёл целиком, а не куском: что отдали, то и легло в хранилище.
	expect((await response.body()).byteLength).toBe(LARGE_PDF_BYTES.byteLength);
});
