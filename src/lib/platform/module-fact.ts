/**
 * Факт модуля в истории дела — как он лежит в значении строки истории правок
 * (`<модуль>:<факт>` в поле): готовая фраза для ленты и пункта чек-листа и
 * данные, по которым модуль узнаёт свой факт обратно — например, дату
 * назначенной встречи, чтобы подставить её при следующем открытии диалога.
 *
 * Данные — не персональные: дата, длительность, место, число, а не имена и
 * контакты. Чистый файл без серверных зависимостей: значение читают и сервер
 * модуля, и модель карточки в браузере.
 */
export type ModuleFactData = Readonly<Record<string, string | number | boolean | null>>;

export type ModuleFactValue = { text: string; data: ModuleFactData };

function isFactData(value: unknown): value is ModuleFactData {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every(
			(item) =>
				item === null ||
				typeof item === 'string' ||
				typeof item === 'number' ||
				typeof item === 'boolean'
		)
	);
}

/** Значение строки истории как факт модуля; `null` — это не факт модуля. */
export function readModuleFactValue(value: unknown): ModuleFactValue | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}

	const { text, data } = value as { text?: unknown; data?: unknown };

	return typeof text === 'string' && isFactData(data) ? { text, data } : null;
}
