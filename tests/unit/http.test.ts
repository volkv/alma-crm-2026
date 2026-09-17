import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	ConflictError,
	ForbiddenError,
	NotFoundError,
	statusForError,
	ValidationError
} from '$lib/server/errors';
import { clientAddress, toActionFailure, toPageError } from '$lib/server/http';

/** Единственное, что `http.ts` берёт из конфигурации, — доверие к прокси. */
const { config } = vi.hoisted(() => ({ config: { TRUST_PROXY: false } }));

vi.mock('$lib/server/config', () => ({ getConfig: () => config }));

/**
 * Один код — один статус, и так во всех трёх транспортах. Проверяется именно
 * это: разойдясь, таблицы дали бы 403 в форме и 500 на странице для одного и
 * того же отказа, и никто бы этого не заметил.
 */
describe('перевод предметной ошибки в ответ', () => {
	it('держит одно соответствие кода и статуса', () => {
		expect(statusForError(new ValidationError('плохо'))).toBe(400);
		expect(statusForError(new ForbiddenError())).toBe(403);
		expect(statusForError(new NotFoundError())).toBe(404);
		expect(statusForError(new ConflictError('занято'))).toBe(409);
	});

	it('отдаёт форме статус, текст и претензии к полям', () => {
		const failure = toActionFailure(
			new ValidationError('Данные не прошли проверку', ['инн: коротко'])
		);

		expect(failure.status).toBe(400);
		expect(failure.data).toEqual({
			message: 'Данные не прошли проверку',
			issues: ['инн: коротко']
		});
	});

	it('отдаёт странице тот же статус и не теряет претензии по дороге', () => {
		expect(() => toPageError(new ForbiddenError('Нельзя'))).toThrow(
			expect.objectContaining({ status: 403, body: { message: 'Нельзя' } })
		);

		expect(() => toPageError(new ValidationError('Фильтр не разобран', ['from: не дата']))).toThrow(
			expect.objectContaining({
				status: 400,
				body: { message: 'Фильтр не разобран. from: не дата' }
			})
		);
	});

	it('пропускает мимо себя всё, что не предметная ошибка', () => {
		const failure = new TypeError('сломалось внутри');

		// Незнакомый сбой не превращается в вежливый отказ: это 500, и он должен
		// дойти до `handleError` как есть.
		expect(() => toActionFailure(failure)).toThrow(failure);
		expect(() => toPageError(failure)).toThrow(failure);
	});
});

/** Адрес соединения — тот, который отдаёт транспорт. */
const SOCKET = '192.0.2.50';

/** Запрос в том объёме, в каком его читает `clientAddress`: адрес и заголовок. */
function addressEvent(forwarded?: string): RequestEvent {
	return {
		request: new Request('http://localhost/api/v1/organizations', {
			headers: forwarded === undefined ? undefined : { 'x-forwarded-for': forwarded }
		}),
		getClientAddress: () => SOCKET
	} as unknown as RequestEvent;
}

describe('адрес вызывающего', () => {
	it('за доверенным прокси берёт запись, которую дописал сам прокси', () => {
		config.TRUST_PROXY = true;

		// Прокси один, и наблюдённый им адрес он дописывает справа. Клиент пришёл
		// без заголовка — в нём одна запись, и она же адрес.
		expect(clientAddress(addressEvent('203.0.113.7'))).toBe('203.0.113.7');

		// Клиент прислал заголовок сам: всё, что левее последней записи, — его
		// сочинение, и адресом оно не становится. Иначе лимит входов и журнал
		// обходились бы одним заголовком.
		expect(clientAddress(addressEvent('10.0.0.9, 203.0.113.7'))).toBe('203.0.113.7');
	});

	it('за доверенным прокси без заголовка отдаёт адрес соединения', () => {
		config.TRUST_PROXY = true;

		// Так приходят запросы изнутри сети развёртывания — имитаторы систем
		// заказчика и проверка здоровья. Это рабочий случай, а не ошибка.
		expect(clientAddress(addressEvent())).toBe(SOCKET);
		// Заголовок без адресов — то же самое отсутствие адреса.
		expect(clientAddress(addressEvent(' , '))).toBe(SOCKET);
	});

	it('без доверия к прокси заголовок не читает вовсе', () => {
		config.TRUST_PROXY = false;

		// Приложение доступно напрямую: заголовок написал тот, кто пришёл.
		expect(clientAddress(addressEvent('10.0.0.9, 203.0.113.7'))).toBe(SOCKET);
	});
});
