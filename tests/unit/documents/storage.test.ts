import { describe, expect, it, vi } from 'vitest';
import { sha256Hex, stageBlob, storedObjectKey } from '$lib/server/documents/storage';
import { DocumentStorageError } from '$lib/server/documents/errors';
import { ValidationError } from '$lib/server/errors';

/**
 * Окружения нет вовсе: тогда любое обращение к хранилищу кончается отказом
 * конфигурации, и по типу ошибки видно, дошло ли дело до сети. Без этой
 * подмены модуль взял бы настоящий `.env` и постучался бы в хранилище
 * разработчика.
 */
vi.mock('$env/dynamic/private', () => ({ env: {} }));

const PDF_BYTES = Uint8Array.from(Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1'));
const PDF_MIME = 'application/pdf';

describe('ключ объекта', () => {
	it('принимает ключ, который выдало само хранилище', () => {
		const key = `files/${crypto.randomUUID()}`;

		expect(storedObjectKey(key)).toBe(key);
	});

	it('отвергает всё, что не похоже на такой ключ', () => {
		const rejected = [
			'',
			'files/',
			'files/../../etc/passwd',
			'../files/00000000-0000-4000-8000-000000000001',
			'/files/00000000-0000-4000-8000-000000000001',
			// Временный ключ — шаг протокола записи: читать по нему нечего.
			'tmp/00000000-0000-4000-8000-000000000001',
			'FILES/00000000-0000-4000-8000-000000000001',
			'files/00000000-0000-4000-8000-000000000001/../secret',
			'files/not-a-uuid'
		];

		for (const key of rejected) {
			expect(() => storedObjectKey(key)).toThrowError(DocumentStorageError);
		}
	});
});

describe('хеш содержимого', () => {
	it('считает sha256 в том виде, в каком он лежит в базе', () => {
		expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});
});

describe('проверка перед записью', () => {
	it('не несёт в хранилище файл, который не соответствует заявленному типу', async () => {
		// `ValidationError`, а не отказ конфигурации: до клиента хранилища дело не
		// дошло, потому что содержимое проверяется раньше.
		await expect(
			stageBlob(new TextEncoder().encode('<html><body>Соглашение</body></html>'), PDF_MIME)
		).rejects.toBeInstanceOf(ValidationError);
	});

	it('не несёт в хранилище пустой файл и файл сверх потолка', async () => {
		await expect(stageBlob(new Uint8Array(0), PDF_MIME)).rejects.toBeInstanceOf(ValidationError);

		const tooLarge = new Uint8Array(26 * 1024 * 1024);
		tooLarge.set(PDF_BYTES);

		await expect(stageBlob(tooLarge, PDF_MIME)).rejects.toBeInstanceOf(ValidationError);
	});

	it('проверенный файл идёт в хранилище, и без настроек это видно по отказу', async () => {
		// Обратная сторона предыдущих проверок: файл, к которому претензий нет,
		// доходит до клиента хранилища — а тот без переменных окружения не
		// собирается. Иначе «проверка прошла» и «файл записан» были бы неразличимы.
		await expect(stageBlob(PDF_BYTES, PDF_MIME)).rejects.toThrowError(
			/Invalid environment configuration/
		);
	});
});
