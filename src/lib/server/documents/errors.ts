/**
 * Ошибки внешних служб, на которых стоят документы: конвертация в PDF и
 * хранилище файлов.
 *
 * В `$lib/server/errors` их нет намеренно: там ошибки предметной области, за
 * которые отвечает пользователь, и каждая переводится в 4xx. Здесь — отказы
 * инфраструктуры, в которых пользователь не виноват и починить которые он не
 * может; такой отказ обязан дойти до 500 и до логов, а не превратиться в
 * «ничего не найдено».
 */

/** Хост службы или пустая строка, если адрес не разобрался как URL. */
function serviceHost(serviceUrl: string): string {
	try {
		return new URL(serviceUrl).host;
	} catch {
		// Настроенной невалидной конфигурации не бывает — её отвергает
		// `parseConfig`, — но прятать по имени хоста тогда просто нечего.
		return '';
	}
}

/**
 * Адрес службы конвертации — часть внутреннего устройства развёртывания.
 * В сообщении, которое увидит человек, его быть не должно: по нему видно, что
 * и где крутится за приложением.
 */
export function hideServiceAddresses(text: string, serviceUrl: string): string {
	const host = serviceHost(serviceUrl);

	let sanitized = text.replace(/\bhttps?:\/\/\S+/gi, '[служба конвертации]');

	if (host !== '') {
		sanitized = sanitized.replaceAll(host, '[служба конвертации]');
	}

	return sanitized.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export class DocumentConversionError extends Error {
	/** Код ответа службы или `null`, если ответа не было вовсе. */
	readonly status: number | null;

	constructor(message: string, options: { status: number | null; cause?: unknown }) {
		super(message, { cause: options.cause });
		this.name = 'DocumentConversionError';
		this.status = options.status;
	}
}

/**
 * Отказ хранилища файлов.
 *
 * Сообщение — по-русски и без адресов: где именно лежит бакет и под какими
 * ключами ходит приложение, человеку за экраном знать незачем, а вот код отказа
 * (`NoSuchBucket`, `AccessDenied`, `NoSuchKey`) — это первое, что спросят у того,
 * кто чинит стенд, поэтому он сохраняется полем и попадает в сообщение.
 */
export class DocumentStorageError extends Error {
	/** Код отказа хранилища или `null`, если хранилище не ответило вовсе. */
	readonly code: string | null;
	/** Код ответа HTTP от хранилища или `null`. */
	readonly status: number | null;

	constructor(
		message: string,
		options: { code?: string | null; status?: number | null; cause?: unknown } = {}
	) {
		const code = options.code ?? null;

		super(code === null ? message : `${message} (${code})`, { cause: options.cause });
		this.name = 'DocumentStorageError';
		this.code = code;
		this.status = options.status ?? null;
	}
}
