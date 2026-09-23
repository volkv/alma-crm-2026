/**
 * Контракт описания API: у каждого зарегистрированного маршрута есть описание,
 * тег, право и схема ответа, а пример сходится с этой схемой.
 *
 * Проверка живёт среди модульных: базы ей не нужно — маршруты регистрируются
 * при загрузке своих файлов, а документ собирается из тех же объектов, которыми
 * эндпоинт проверяет запрос. Зато нужна она на каждый прогон: документация,
 * которая расходится с поведением, хуже отсутствующей.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config', () => ({
	getConfig: () => ({ ORIGIN: 'https://crm.example.org' })
}));

// Маршрут описания загружает файлы всех эндпоинтов — иначе проверка видела бы
// только те, которые кто-то успел вызвать раньше.
await import('../../../src/routes/api/openapi.json/+server');

const { buildOpenApiDocument, registeredRoutes } = await import('$lib/server/api/openapi');

describe('маршруты публичного API', () => {
	const routes = registeredRoutes();

	it('зарегистрированы все и по одному разу', () => {
		expect(routes.length).toBeGreaterThanOrEqual(43);
		expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(
			routes.length
		);
	});

	it('у каждого есть описание, тег, право и схема ответа', () => {
		for (const route of routes) {
			const name = `${route.method} ${route.path}`;

			expect(route.summary, name).not.toBe('');
			expect(route.description ?? '', name).not.toBe('');
			expect(route.tags ?? [], name).not.toHaveLength(0);
			expect(route.config.output, name).toBeDefined();
			// Маршрута без права в продукте нет: появление такого — решение, а не
			// опечатка, и принимать его молча нельзя.
			expect(route.config.permission, name).toBeDefined();
		}
	});

	it('пример ответа сходится со схемой этого же ответа', () => {
		const withExamples = routes.filter((route) => route.example !== undefined);

		expect(withExamples.length).toBeGreaterThan(0);

		for (const route of withExamples) {
			const parsed = route.config.output.safeParse(route.example);

			expect(
				parsed.success
					? []
					: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
				`${route.method} ${route.path}`
			).toEqual([]);
		}
	});

	it('пример тела запроса сходится со схемой тела', () => {
		const withExamples = routes.filter((route) => route.bodyExample !== undefined);

		expect(withExamples.length).toBeGreaterThan(0);

		for (const route of withExamples) {
			const parsed = route.config.body?.safeParse(route.bodyExample);

			expect(
				parsed?.success === true
					? []
					: (parsed?.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [
							'у маршрута нет схемы тела'
						]),
				`${route.method} ${route.path}`
			).toEqual([]);
		}
	});

	it('собирается в документ, где у каждой операции есть право, раздел и описание', () => {
		const document = buildOpenApiDocument();
		const paths = document.paths ?? {};

		expect(Object.keys(paths).length).toBeGreaterThanOrEqual(33);

		for (const [path, operations] of Object.entries(paths)) {
			for (const [method, operation] of Object.entries(operations)) {
				const name = `${method} ${path}`;
				const described = operation as { tags?: string[]; description?: string } & Record<
					string,
					unknown
				>;

				expect(described['x-permission'], name).toBeDefined();
				expect(described.tags ?? [], name).not.toHaveLength(0);
				expect(described.description ?? '', name).not.toBe('');
			}
		}
	});

	it('называет разделы словами и отделяет обмен от чтения', () => {
		const document = buildOpenApiDocument();
		const tags = document.tags ?? [];
		const used = new Set(routes.flatMap((route) => route.tags ?? []));

		expect(tags.map((tag) => tag.name)).toContain('Обмен');
		expect(tags.every((tag) => (tag.description ?? '') !== '')).toBe(true);
		// Тег, которого нет в оглавлении, — раздел без объяснения.
		for (const tag of used) {
			expect(
				tags.map((item) => item.name),
				tag
			).toContain(tag);
		}
	});

	it('пускает ключ внешней системы только на маршруты обмена', () => {
		const exchangeRoutes = routes.filter((route) => route.config.service === true);

		expect(exchangeRoutes.length).toBeGreaterThan(0);

		for (const route of exchangeRoutes) {
			expect(route.tags ?? [], `${route.method} ${route.path}`).toContain('Обмен');
		}

		// И наоборот: раздел «Обмен» — это ровно маршруты машинного субъекта.
		for (const route of routes.filter((item) => (item.tags ?? []).includes('Обмен'))) {
			expect(route.config.service, `${route.method} ${route.path}`).toBe(true);
		}
	});
});
