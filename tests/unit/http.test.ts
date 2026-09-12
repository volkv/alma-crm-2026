import { describe, expect, it } from 'vitest';
import {
	ConflictError,
	ForbiddenError,
	NotFoundError,
	statusForError,
	ValidationError
} from '$lib/server/errors';
import { toActionFailure, toPageError } from '$lib/server/http';

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
