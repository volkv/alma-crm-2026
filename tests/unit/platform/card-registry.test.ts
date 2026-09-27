/**
 * Действия модулей на странице карточки: каждое стоит за проверкой «модуль
 * действует в пространстве дела», и отказ проверки — отказ формы со словами, а
 * не молчаливое выполнение. Сама проверка по базе — в интеграционном тесте
 * модулей пространства; здесь — что реестр её зовёт и уважает.
 */
import type { ActionFailure, RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardRouteParams } from '$lib/platform/card.server';

const { assertModuleActive } = vi.hoisted(() => ({ assertModuleActive: vi.fn() }));

vi.mock('$lib/server/platform/workspace-modules', async (importOriginal) => ({
	...(await importOriginal<object>()),
	assertModuleActive
}));
vi.mock('$lib/server/actor', async (importOriginal) => ({
	...(await importOriginal<object>()),
	actorFromEvent: () => ({ requestId: 'test' })
}));

const { ValidationError } = await import('$lib/server/errors');
const { moduleCardActionHandlers } = await import('$lib/platform/card-registry.server');

const INTERACTION_ID = '0b0e6f53-6a8f-4d0c-9d3c-2f6b7b1f0a11';

/** Отправка пустой формы действия карточки. */
function event(): RequestEvent<CardRouteParams> {
	return {
		params: { workspace: 'b2b', id: INTERACTION_ID },
		request: new Request('https://crm.example.org/', { method: 'POST', body: new FormData() }),
		locals: { requestId: 'test', user: null, apiKey: null }
	} as unknown as RequestEvent<CardRouteParams>;
}

function failure(result: unknown): ActionFailure<{ message: string; issues: string[] }> {
	return result as ActionFailure<{ message: string; issues: string[] }>;
}

beforeEach(() => {
	assertModuleActive.mockReset();
});

describe('действия модулей в карточке', () => {
	it('приносят действия «Обучения», «Договоров», «Оплаты» и «Встреч» под своими именами', () => {
		expect(Object.keys(moduleCardActionHandlers([])).sort()).toEqual([
			'completeGroup',
			'contract',
			'meetingSchedule',
			'rosterAddCounterparty',
			'rosterImport',
			'rosterPreview',
			'rosterRemove',
			'rosterSend',
			'sendGroup',
			'setPrice'
		]);
	});

	it('не дают модулю перекрыть действие ядра', () => {
		expect(() => moduleCardActionHandlers(['advance', 'sendGroup'])).toThrow(/sendGroup/);
	});

	it('отказывают со словами, когда модуль в пространстве не действует', async () => {
		assertModuleActive.mockRejectedValue(
			new ValidationError('Модуль «Обучение» не подключён к пространству «Вузы»', [
				'Его подключают в «Настройки → Пространства»'
			])
		);

		const result = failure(await moduleCardActionHandlers([]).rosterPreview(event()));

		expect(assertModuleActive).toHaveBeenCalledWith(expect.anything(), INTERACTION_ID, 'learning');
		expect(result.status).toBe(400);
		expect(result.data.message).toBe('Модуль «Обучение» не подключён к пространству «Вузы»');
		expect(result.data.issues).toEqual(['Его подключают в «Настройки → Пространства»']);
	});

	it('пропускают к действию модуля, когда модуль действует', async () => {
		assertModuleActive.mockResolvedValue(undefined);

		// Пустая форма доходит до разбора самого действия и отказывает уже им.
		const result = failure(await moduleCardActionHandlers([]).rosterPreview(event()));

		expect(result.status).toBe(400);
		expect(result.data.message).toBe('Данные действия не прошли проверку');
	});
});
