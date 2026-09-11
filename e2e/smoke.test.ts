import { expect, test } from './fixtures';

test('the home page renders the product name', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('LCT CRM');
});

test('the health endpoint reports every dependency as ok', async ({ request }) => {
	const response = await request.get('/api/health');

	expect(response.status()).toBe(200);
	expect(await response.json()).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
});
