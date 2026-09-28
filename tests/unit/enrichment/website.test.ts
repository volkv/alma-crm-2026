import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	chainWebsiteFinders,
	findWebsite,
	type WebsiteFinder
} from '$lib/server/enrichment/website';

/**
 * Сайт организации по реквизитам: цепочка источников отвечает первым пригодным
 * адресом и никогда не бросает — заведение организации из реестра не должно
 * падать из-за того, что один источник не ответил.
 */

function finder(name: string, find: WebsiteFinder['find']): WebsiteFinder {
	return { name, find };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('цепочка источников сайта', () => {
	const query = { inn: '7700000000', emails: [] };

	it('сбой источника — это «не знаю»: спрашивается следующий, цепочка не бросает', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const find = chainWebsiteFinders([
			finder('broken', () => Promise.reject(new Error('таймаут'))),
			finder('junk', () => ({ website: 'не адрес', source: 'guess', note: null })),
			finder('good', () => ({ website: 'https://vuz.example/sveden', source: 'guess', note: null }))
		]);

		await expect(find(query)).resolves.toEqual({
			website: 'https://vuz.example',
			source: 'guess',
			note: null
		});
		expect(console.warn).toHaveBeenCalledTimes(1);
	});

	it('никто не ответил — пусто, а не ошибка', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const find = chainWebsiteFinders([
			finder('broken', () => {
				throw new Error('нет снимка');
			}),
			finder('empty', () => null)
		]);

		await expect(find(query)).resolves.toBeNull();
	});
});

describe('сайт по ИНН из справочника вузов', () => {
	it('кириллический домен приходит в punycode и с источником справочника', async () => {
		const found = await findWebsite({ inn: '6950219930', emails: ['rector@other.example'] });

		expect(found).toMatchObject({
			website: 'https://xn--80axkp.xn--p1ai',
			source: 'monitoring',
			fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
		});
		expect(found?.note).toMatch(/справочника вузов/);
	});

	it('неизвестный ИНН уходит к догадке по почте, а без почты — пусто', async () => {
		await expect(
			findWebsite({ inn: '7700000000', emails: ['office@vuz.example'] })
		).resolves.toMatchObject({ website: 'https://vuz.example', source: 'guess' });
		await expect(findWebsite({ inn: '7700000000', emails: [] })).resolves.toBeNull();
	});

	it('канал в мессенджере сайтом организации не считается', async () => {
		await expect(findWebsite({ inn: '9500008580', emails: [] })).resolves.toBeNull();
	});
});
