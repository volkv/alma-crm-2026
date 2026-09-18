/**
 * Перевод нарушений уникальности справочника в понятные фразы.
 *
 * Словарь закрыт намеренно: ограничение, которого в нём нет, показывает
 * человеку пятисотую вместо объяснения. Поэтому здесь проверяется не сам факт
 * перевода, а обе границы — что известное ограничение переводится, а всё
 * остальное улетает наверх нетронутым, включая ошибки, у которых код тот же,
 * но имя ограничения незнакомое.
 */
import { describe, expect, it } from 'vitest';
import { withUniqueConflicts } from '$lib/server/directory/conflicts';
import { ConflictError } from '$lib/server/errors';

/** Ошибка драйвера в том виде, в каком её отдаёт postgres.js. */
function uniqueViolation(constraint: string): Error {
	return Object.assign(
		new Error(`duplicate key value violates unique constraint "${constraint}"`),
		{ code: '23505', constraint_name: constraint }
	);
}

describe('словарь нарушений уникальности', () => {
	it('переводит вторую действующую строку ответственного', async () => {
		// Индекс `organization_responsibles_current_key` частичный и с
		// `nulls not distinct`: на пару «вуз × направление» действующая строка
		// одна, и общее назначение тоже одно.
		const attempt = withUniqueConflicts(async () => {
			throw uniqueViolation('organization_responsibles_current_key');
		});

		await expect(attempt).rejects.toBeInstanceOf(ConflictError);
		await expect(attempt).rejects.toThrow('действующий ответственный');
	});

	it('находит нарушение внутри обёрнутой ошибки', async () => {
		// Drizzle заворачивает ошибку драйвера в свою; без обхода по `cause`
		// словарь не увидел бы ни кода, ни имени ограничения.
		const attempt = withUniqueConflicts(async () => {
			throw new Error('Failed query', { cause: uniqueViolation('organizations_inn_key') });
		});

		await expect(attempt).rejects.toThrow('Организация с таким ИНН уже заведена');
	});

	it('не трогает незнакомое ограничение', async () => {
		const original = uniqueViolation('some_other_key');

		await expect(
			withUniqueConflicts(async () => {
				throw original;
			})
		).rejects.toBe(original);
	});

	it('не трогает ошибку с другим кодом', async () => {
		const original = Object.assign(new Error('deadlock detected'), {
			code: '40P01',
			constraint_name: 'organization_responsibles_current_key'
		});

		await expect(
			withUniqueConflicts(async () => {
				throw original;
			})
		).rejects.toBe(original);
	});
});
