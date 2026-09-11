/**
 * Ошибка внешней службы преобразования документов.
 *
 * В `$lib/server/errors` её нет намеренно: там ошибки предметной области, за
 * которые отвечает пользователь, и каждая переводится в 4xx. Здесь — отказ
 * инфраструктуры, в котором пользователь не виноват и починить который он не
 * может.
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
