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

/** Метка прогона: делает названия уникальными в общей базе. */
const TAG = crypto.randomUUID().slice(0, 8);

const PDF_TITLE = `Скан соглашения ${TAG}`;
const TEXT_TITLE = `Служебная записка ${TAG}`;

/** Настоящий PDF, пусть и минимальный: тип проверяется по содержимому файла. */
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');
const TEXT_BYTES = Buffer.from('Записка о составе пакета документов.\n', 'utf8');

/** Строки раздела, заведённые этим прогоном. */
function ownRows(page: Page): Locator {
	return page.locator('[data-slot="data-table"] tbody tr[data-row]').filter({ hasText: TAG });
}

async function upload(
	page: Page,
	title: string,
	kind: string,
	file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
	// Форма загрузки — одна из карточек вкладки, и подписи полей у неё общие со
	// словарём продукта, поэтому поля ищутся внутри неё.
	const form = page.locator('[data-slot="card"]').filter({ hasText: 'Загрузить документ' });

	await form.getByLabel('Название').fill(title);
	await form.getByLabel('Вид документа').fill(kind);
	await form.getByLabel('Файл').setInputFiles(file);
	await form.getByRole('button', { name: 'Загрузить' }).click();

	await expect(page.getByText(title)).toBeVisible();
}

test('раздел показывает загруженные документы, фильтрует по формату и отдаёт файл', async ({
	page
}) => {
	await test.step('файлы загружаются из карточки взаимодействия', async () => {
		await page.goto(`/interactions/${INTERACTION_ID}`);
		await page.getByRole('tab', { name: 'Документы' }).click();

		await upload(page, PDF_TITLE, 'agreement', {
			name: 'agreement.pdf',
			mimeType: 'application/pdf',
			buffer: PDF_BYTES
		});
		await upload(page, TEXT_TITLE, 'note', {
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
		await page.getByLabel('Формат').selectOption('pdf');

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
