/**
 * Хранилище файлов документов.
 *
 * Файлы лежат объектами в S3-совместимом хранилище (в поставке — MinIO) под
 * ключом `files/<uuid>` без расширения: ключ ничего не значит, всё, что о файле
 * известно, записано в базе. Имя, которое прислал человек, в ключ не попадает —
 * иначе по ключу читались бы фамилии и названия организаций. Объект неизменяем:
 * новая редакция документа — это новая запись и новый объект, перезаписи в коде
 * нет.
 *
 * Протокол записи разведён на три шага, потому что хранилище и база не умеют
 * фиксироваться вместе:
 *
 * 1. `stageBlob` — проверка размера и содержимого, хеш, запись объекта под
 *    временным ключом `tmp/<uuid>`; база ещё ничего не знает;
 * 2. `promoteBlob` — перенос объекта на боевой ключ `files/<uuid>`;
 * 3. запись в `documents` (это делает вызывающий сервис, в транзакции).
 *
 * Тело файла уходит по сети на шаге 1, до транзакции: транзакция не должна
 * ждать чужую службу с двадцатью пятью мегабайтами в руках. На шаге 2 по сети
 * идут только команды — копирование внутри бакета хранилище делает у себя,
 * данные через приложение не проходят.
 *
 * Если шаг 2 или 3 не удался, вызывающий обязан позвать `discardStaged`: объект,
 * на который не ссылается ни одна запись, — мусор, который никто никогда не
 * найдёт. Обратного порядка (сначала база, потом хранилище) быть не может:
 * тогда запись ссылалась бы на файл, которого ещё нет.
 */
import { createHash } from 'node:crypto';
import {
	CopyObjectCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { getConfig } from '../config';
import { DocumentStorageError } from './errors';
import { assertContentMatchesMime, assertSizeAllowed, type AllowedDocumentMime } from './mime';

/** Префикс готовых объектов; он же начало `file_path` в базе. */
const FILES_PREFIX = 'files';
/** Префикс объектов, которые ещё не проверены базой. */
const TMP_PREFIX = 'tmp';

/**
 * Ключ, который хранилище готово обслуживать. Строка приходит из базы, то есть
 * формально это произвольные данные: ключ неизвестной формы читать нельзя,
 * потому что по нему невозможно сказать, наш ли это объект.
 */
const STORED_KEY_PATTERN = new RegExp(
	`^${FILES_PREFIX}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
);

/**
 * Потолок ожидания хранилища. `connectionTimeout` — на установку соединения,
 * `requestTimeout` — на паузу в передаче: заваленное хранилище должно кончиться
 * отказом, а не висящим запросом. Счёт идёт от последнего пришедшего байта,
 * поэтому долгая, но живая загрузка под него не попадает.
 */
const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Свой потолок у пробы живости: на весь ответ `/api/health` у healthcheck'а
 * контейнера пять секунд, и проба хранилища не вправе занять их все. Считается
 * вместе с повторами — отсюда `AbortSignal`, а не таймаут одного запроса.
 */
const PING_TIMEOUT_MS = 2_000;

let cachedClient: S3Client | undefined;

/**
 * Клиент хранилища.
 *
 * Собирается при первом обращении, а не при импорте: SvelteKit загружает
 * серверные модули на сборке, и клиент, собранный там, читал бы конфигурацию
 * без настоящего окружения.
 */
function getClient(): S3Client {
	if (cachedClient === undefined) {
		const config = getConfig();

		cachedClient = new S3Client({
			endpoint: config.S3_ENDPOINT,
			region: config.S3_REGION,
			forcePathStyle: config.S3_FORCE_PATH_STYLE,
			credentials: {
				accessKeyId: config.S3_ACCESS_KEY,
				secretAccessKey: config.S3_SECRET_KEY
			},
			requestHandler: {
				connectionTimeout: CONNECTION_TIMEOUT_MS,
				requestTimeout: REQUEST_TIMEOUT_MS
			}
		});
	}

	return cachedClient;
}

/**
 * Закрывает соединения с хранилищем и забывает клиент. Нужен там, где процесс
 * обязан закончиться сам, — в прогоне тестов и в разовом скрипте.
 */
export function closeStorage(): void {
	const open = cachedClient;
	cachedClient = undefined;
	open?.destroy();
}

/**
 * Клиент и бакет одной операции.
 *
 * Берутся до `runStorage`, а не внутри: незаполненное окружение — это не отказ
 * хранилища, и подменять «в окружении нет S3_BUCKET» на «хранилище не ответило»
 * значит отправить чинить не то.
 */
function storage(): { client: S3Client; bucket: string } {
	return { client: getClient(), bucket: getConfig().S3_BUCKET };
}

/**
 * Код отказа: `NoSuchKey`, `AccessDenied`, `NoSuchBucket` — от хранилища,
 * `ECONNREFUSED`, `ENOTFOUND` — от сети под ним. Второе не менее важно первого:
 * «хранилище отказало» и «до хранилища не доехали» чинят по-разному.
 */
function failureCode(error: unknown): string | null {
	const failure = error as { name?: unknown; code?: unknown } | null;

	if (typeof failure?.name === 'string' && failure.name !== '' && failure.name !== 'Error') {
		return failure.name;
	}

	return typeof failure?.code === 'string' && failure.code !== '' ? failure.code : null;
}

function failureStatus(error: unknown): number | null {
	const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
		?.httpStatusCode;

	return typeof status === 'number' ? status : null;
}

/**
 * «Такого объекта нет» — это ответ, а не отказ: `storedFileSize` и
 * `storedFileSha256` обязаны отличать его от сломанного хранилища. Разбирается
 * и сырая ошибка клиента, и уже завёрнутая: до вызывающего доходит вторая.
 */
function isMissingObject(error: unknown): boolean {
	const wrapped = error instanceof DocumentStorageError;
	const code = wrapped ? error.code : failureCode(error);
	const status = wrapped ? error.status : failureStatus(error);

	return code === 'NoSuchKey' || code === 'NotFound' || status === 404;
}

/**
 * Отказ хранилища в виде, пригодном для показа: с кодом, но без адреса
 * хранилища и ключа доступа, которые S3-клиент кладёт в свои сообщения.
 */
function storageFailure(description: string, error: unknown): DocumentStorageError {
	return new DocumentStorageError(description, {
		code: failureCode(error),
		status: failureStatus(error),
		cause: error
	});
}

/** Единственный путь к хранилищу: любой отказ становится `DocumentStorageError`. */
async function runStorage<TResult>(
	description: string,
	operation: () => Promise<TResult>
): Promise<TResult> {
	try {
		return await operation();
	} catch (error) {
		// Собственный отказ уже описан по-русски — заворачивать его второй раз
		// значит подменить причину именем класса.
		throw error instanceof DocumentStorageError ? error : storageFailure(description, error);
	}
}

/**
 * Самая дешёвая проверка хранилища: бакет на месте, адрес верный, ключи к нему
 * подходят. Ответ хранилища — часть ответа `/api/health`: приложение, которому
 * некуда положить документ, здоровым не считается.
 */
export async function pingStorage(): Promise<void> {
	const { client, bucket } = storage();

	await runStorage('Хранилище файлов не отвечает', async () => {
		await client.send(new HeadBucketCommand({ Bucket: bucket }), {
			abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS)
		});
	});
}

/** Хеш содержимого в том виде, в каком он лежит в `documents.sha256`. */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Тот же хеш в base64 — в таком виде его сверяет хранилище при записи. */
function sha256Base64(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('base64');
}

/**
 * Ключ объекта по значению `file_path` из базы. Строка из базы — это данные, а
 * не код: ключ, не похожий на ключ хранилища, читать нельзя.
 */
export function storedObjectKey(relativePath: string): string {
	if (!STORED_KEY_PATTERN.test(relativePath)) {
		throw new DocumentStorageError(`Ключ «${relativePath}» не похож на ключ файла хранилища`);
	}

	return relativePath;
}

/** Объект, записанный и проверенный, но ещё не принадлежащий ни одной записи. */
export type StagedBlob = {
	/** Идентификатор файла; он же хвост ключа. */
	id: string;
	/** Ключ объекта в бакете — то, что уйдёт в `file_path`. */
	relativePath: string;
	sha256: string;
	sizeBytes: number;
	mime: AllowedDocumentMime;
};

function tmpKeyOf(blob: StagedBlob): string {
	return `${TMP_PREFIX}/${blob.id}`;
}

/**
 * Кладёт содержимое во временный объект, проверив размер и то, что содержимое
 * соответствует заявленному типу. Ничего не знает о базе — и не должен:
 * решение, появится ли запись, принимает вызывающий сервис.
 */
export async function stageBlob(bytes: Uint8Array, mime: AllowedDocumentMime): Promise<StagedBlob> {
	assertSizeAllowed(bytes.byteLength);
	assertContentMatchesMime(mime, bytes);

	const id = crypto.randomUUID();
	const blob: StagedBlob = {
		id,
		relativePath: `${FILES_PREFIX}/${id}`,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		mime
	};

	const { client, bucket } = storage();

	await runStorage('Не удалось записать файл в хранилище', async () => {
		await client.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: tmpKeyOf(blob),
				Body: bytes,
				ContentType: mime,
				// Хранилище сверяет хеш с содержимым и отвергает запись, если по
				// дороге что-то испортилось: битый файл не должен тихо лечь под
				// правильной контрольной суммой в базе.
				ChecksumSHA256: sha256Base64(bytes)
			})
		);
	});

	return blob;
}

/**
 * Переносит проверенный объект на боевой ключ. После этого его можно только
 * читать: перезаписи в коде нет вовсе.
 *
 * Копирование идёт внутри бакета, поэтому тело файла второй раз по сети не
 * едет. Временный объект убирается сразу же — отказ на этом шаге доходит до
 * вызывающего, потому что иначе в хранилище остался бы мусор, о котором никто
 * не знает.
 */
export async function promoteBlob(blob: StagedBlob): Promise<void> {
	const from = tmpKeyOf(blob);
	const to = storedObjectKey(blob.relativePath);
	const { client, bucket } = storage();

	await runStorage('Не удалось перенести файл в хранилище', async () => {
		await client.send(
			new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from}` })
		);
	});

	await removeObject(from);
}

/** Убирает объект; отсутствующий объект удаляется без ошибки — S3 идемпотентен. */
async function removeObject(key: string): Promise<void> {
	const { client, bucket } = storage();

	await runStorage('Не удалось удалить файл из хранилища', async () => {
		await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	});
}

/**
 * Компенсация неудачной записи: убирает и временный объект, и объект на боевом
 * ключе, если перенос уже прошёл. Единственный способ удалить файл — публичного
 * удаления документов в системе нет.
 */
async function discardBlob(blob: StagedBlob): Promise<void> {
	await removeObject(tmpKeyOf(blob));
	await removeObject(storedObjectKey(blob.relativePath));
}

/**
 * Убирает файлы, на которые больше не ссылается ни одна запись.
 *
 * Случай ровно один — сброс демонстрационных данных
 * (`$lib/server/demo/reset`): он стирает записи документов целиком, и без этой
 * уборки объекты остались бы в бакете навсегда, а узнать их ключи после сброса
 * было бы уже неоткуда. Отказ хранилища уходит наружу: объект, о котором никто
 * не знает, — это то, что модуль обязан не допускать, а не то, о чём он молчит.
 */
export async function removeStoredFiles(relativePaths: readonly string[]): Promise<void> {
	for (const relativePath of relativePaths) {
		await removeObject(storedObjectKey(relativePath));
	}
}

/**
 * Убирает файлы операции, которая не удалась. Зовётся из `catch`, поэтому
 * принимает и исходную ошибку: если убрать файлы не получилось, наружу уходят
 * обе. Потерять причину отказа нельзя, но и промолчать про оставшийся в
 * хранилище объект — тоже: записи о нём не будет ни в базе, ни в журнале.
 */
export async function discardStaged(blobs: readonly StagedBlob[], failure: unknown): Promise<void> {
	try {
		for (const blob of blobs) {
			await discardBlob(blob);
		}
	} catch (cleanupFailure) {
		throw new AggregateError(
			[failure, cleanupFailure],
			'Операция не удалась, и убрать за ней файлы тоже не получилось',
			{ cause: cleanupFailure }
		);
	}
}

/** Содержимое файла хранилища целиком. Для файла, который сразу идёт в обработку. */
export async function readStoredFile(relativePath: string): Promise<Buffer> {
	const key = storedObjectKey(relativePath);
	const { client, bucket } = storage();

	return runStorage('Не удалось прочитать файл из хранилища', async () => {
		const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

		if (response.Body === undefined) {
			throw new DocumentStorageError('Хранилище вернуло файл без содержимого');
		}

		return Buffer.from(await response.Body.transformToByteArray());
	});
}

/** Размер файла хранилища или `null`, если объекта нет. */
export async function storedFileSize(relativePath: string): Promise<number | null> {
	const key = storedObjectKey(relativePath);
	const { client, bucket } = storage();

	try {
		const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

		return response.ContentLength ?? null;
	} catch (error) {
		if (isMissingObject(error)) {
			return null;
		}

		throw storageFailure('Не удалось узнать размер файла в хранилище', error);
	}
}

/** Хеш файла хранилища или `null`, если объекта нет. */
export async function storedFileSha256(relativePath: string): Promise<string | null> {
	try {
		return sha256Hex(await readStoredFile(relativePath));
	} catch (error) {
		if (isMissingObject(error)) {
			return null;
		}

		throw error;
	}
}

/**
 * Поток на чтение файла. Скачивание идёт мимо памяти процесса: документ на
 * 25 МиБ, помноженный на число одновременных скачиваний, — это уже не мелочь.
 */
export async function openStoredFile(relativePath: string): Promise<ReadableStream<Uint8Array>> {
	const key = storedObjectKey(relativePath);
	const { client, bucket } = storage();

	return runStorage('Не удалось прочитать файл из хранилища', async () => {
		const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

		if (response.Body === undefined) {
			throw new DocumentStorageError('Хранилище вернуло файл без содержимого');
		}

		return response.Body.transformToWebStream() as ReadableStream<Uint8Array>;
	});
}
