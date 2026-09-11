/**
 * Хранилище файлов документов.
 *
 * Файлы лежат в `DATA_DIR/files/<uuid>` без расширения: имя на диске ничего не
 * значит, всё, что о файле известно, записано в базе. Файл неизменяем —
 * новая редакция документа это новая запись и новый файл, — поэтому запись
 * идёт только в новый файл и только один раз.
 *
 * Протокол записи разведён на три шага, потому что диск и база не умеют
 * фиксироваться вместе:
 *
 * 1. `stageBlob` — временный файл в `DATA_DIR/tmp/`, проверка содержимого,
 *    хеш; база ещё ничего не знает;
 * 2. `promoteBlob` — `rename` в `files/`; переименование в пределах одного
 *    тома атомарно, полуфайла в хранилище не появится;
 * 3. запись в `documents` (это делает вызывающий сервис, в транзакции).
 *
 * Если шаг 2 или 3 не удался, вызывающий обязан позвать `discardStaged`: файл,
 * на который не ссылается ни одна запись, — мусор, который никто никогда не
 * найдёт. Обратного порядка (сначала база, потом диск) быть не может: тогда
 * запись ссылалась бы на файл, которого ещё нет.
 */
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { getConfig } from '../config';
import { assertContentMatchesMime, assertSizeAllowed, type AllowedDocumentMime } from './mime';

/** Права на файлы и каталоги хранилища: содержимое читает только само приложение. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Подкаталог с готовыми файлами; он же префикс `file_path` в базе. */
const FILES_DIR = 'files';
/** Подкаталог, в котором файл лежит, пока не проверен и не записан в базу. */
const TMP_DIR = 'tmp';

/** Хеш содержимого в том виде, в каком он лежит в `documents.sha256`. */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Абсолютный путь к каталогу данных. Относительный `DATA_DIR` — от рабочего каталога. */
function dataRoot(): string {
	const configured = getConfig().DATA_DIR;
	return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * Абсолютный путь по пути из базы. Строка из базы — это данные, а не код:
 * если в ней окажется `../`, файл читать нельзя.
 */
export function resolveStoredPath(relativePath: string): string {
	const root = dataRoot();
	const absolute = resolve(root, relativePath);

	if (absolute !== root && !absolute.startsWith(root + sep)) {
		throw new Error(`Путь «${relativePath}» ведёт за пределы каталога данных`);
	}

	return absolute;
}

async function ensureDirectories(): Promise<void> {
	const root = dataRoot();
	await mkdir(join(root, FILES_DIR), { recursive: true, mode: DIR_MODE });
	await mkdir(join(root, TMP_DIR), { recursive: true, mode: DIR_MODE });
}

/** Файл, записанный на диск и проверенный, но ещё не принадлежащий ни одной записи. */
export type StagedBlob = {
	/** Идентификатор файла; он же имя на диске. */
	id: string;
	/** Путь относительно каталога данных — то, что уйдёт в `file_path`. */
	relativePath: string;
	sha256: string;
	sizeBytes: number;
	mime: AllowedDocumentMime;
};

function tmpPathOf(blob: StagedBlob): string {
	return join(dataRoot(), TMP_DIR, blob.id);
}

/**
 * Кладёт содержимое во временный файл, проверив размер и то, что содержимое
 * соответствует заявленному типу. Ничего не знает о базе — и не должен:
 * решение, появится ли запись, принимает вызывающий сервис.
 */
export async function stageBlob(bytes: Uint8Array, mime: AllowedDocumentMime): Promise<StagedBlob> {
	assertSizeAllowed(bytes.byteLength);
	assertContentMatchesMime(mime, bytes);

	await ensureDirectories();

	const id = crypto.randomUUID();
	const blob: StagedBlob = {
		id,
		relativePath: `${FILES_DIR}/${id}`,
		sha256: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		mime
	};

	// `wx` — создать или упасть: перезаписать существующий файл хранилище не умеет.
	await writeFile(tmpPathOf(blob), bytes, { flag: 'wx', mode: FILE_MODE });

	return blob;
}

/** Переносит проверенный файл в хранилище. После этого его можно только читать. */
export async function promoteBlob(blob: StagedBlob): Promise<void> {
	await rename(tmpPathOf(blob), resolveStoredPath(blob.relativePath));
}

async function removeIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		// Файла нет — компенсировать нечего. Любая другая ошибка означает, что
		// мусор остался на диске, и об этом должен узнать вызывающий.
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
}

/**
 * Компенсация неудачной записи: убирает и временный файл, и файл в хранилище,
 * если переименование уже прошло. Единственный способ удалить файл — публичного
 * удаления документов в системе нет.
 */
async function discardBlob(blob: StagedBlob): Promise<void> {
	await removeIfExists(tmpPathOf(blob));
	await removeIfExists(resolveStoredPath(blob.relativePath));
}

/**
 * Убирает файлы операции, которая не удалась. Зовётся из `catch`, поэтому
 * принимает и исходную ошибку: если убрать файлы не получилось, наружу уходят
 * обе. Потерять причину отказа нельзя, но и промолчать про оставшийся на диске
 * файл — тоже: записи о нём не будет ни в базе, ни в журнале.
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
	return readFile(resolveStoredPath(relativePath));
}

/** Размер файла хранилища или `null`, если файла нет. */
export async function storedFileSize(relativePath: string): Promise<number | null> {
	try {
		return (await stat(resolveStoredPath(relativePath))).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}

		throw error;
	}
}

/** Хеш файла хранилища или `null`, если файла нет. */
export async function storedFileSha256(relativePath: string): Promise<string | null> {
	try {
		return sha256Hex(await readStoredFile(relativePath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}

		throw error;
	}
}

/**
 * Поток на чтение файла. Скачивание идёт мимо памяти процесса: документ на
 * 25 МиБ, помноженный на число одновременных скачиваний, — это уже не мелочь.
 */
export function openStoredFile(relativePath: string): ReadStream {
	return createReadStream(resolveStoredPath(relativePath));
}
