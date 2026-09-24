import { expect, test } from './fixtures';

// The product name lives in the document title and in the shell; the page
// itself is the daily overview, so its heading names the page, not the product.
test('the home page renders the daily overview', async ({ page }) => {
	await page.goto('/');

	await expect(page).toHaveTitle(/Альма CRM/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Сводка');
});

test('the health endpoint reports every dependency as ok', async ({ request }) => {
	const response = await request.get('/api/health');

	expect(response.status()).toBe(200);
	expect(await response.json()).toMatchObject({
		status: 'ok',
		db: 'ok',
		redis: 'ok',
		storage: 'ok'
	});
});
