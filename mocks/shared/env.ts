/**
 * Настройки имитатора из окружения контейнера.
 *
 * Пустая строка приравнена к «не задано»: Compose подставляет пустое значение
 * там, где переменной нет в `.env`, и различать эти два случая было бы
 * различением без разницы. Неверное число — остановка процесса: имитатор,
 * молча взявший порт по умолчанию вместо названного, ищется полдня.
 */

/** Строка окружения; `null` — не задана. */
export function textEnv(name: string): string | null {
	const value = process.env[name];

	return value === undefined || value === '' ? null : value;
}

/** Целое из окружения или значение по умолчанию. */
export function integerEnv(name: string, fallback: number): number {
	const value = textEnv(name);

	if (value === null) {
		return fallback;
	}

	const parsed = Number(value);

	if (!Number.isInteger(parsed)) {
		throw new Error(`${name}: ожидается целое число, получено «${value}»`);
	}

	return parsed;
}

/** Остановка по сигналу: контейнер обязан гаситься, а не убиваться по таймауту. */
export function stopOnSignals(stop: () => Promise<void>): void {
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.once(signal, () => {
			stop().then(
				() => process.exit(0),
				(error: unknown) => {
					console.error('Не удалось остановить имитатор:', error);
					process.exit(1);
				}
			);
		});
	}
}
