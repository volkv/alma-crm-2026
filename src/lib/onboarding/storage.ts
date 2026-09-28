/**
 * Признаки «подсказки показаны» и место, где они лежат.
 *
 * Отдельный файл без рун и без импортов сборки: ключи читает и состояние тура,
 * и модульные проверки, а проверкам браузера и контекста компонента не нужно.
 *
 * Почему признаки живут в `localStorage`, а не в базе, — в `tour.svelte.ts` и в
 * `docs/onboarding.md`. Здесь важно одно: все ключи начинаются с ключа
 * учётной записи и роли, поэтому признаки одной учётной записи убираются вместе.
 */
const STORAGE_PREFIX = 'lct-crm:onboarding:';

/** Общее начало признаков этой учётной записи и её роли. */
export function onboardingStorageKey(userId: string, roleId: string): string {
	return `${STORAGE_PREFIX}${userId}:${roleId}`;
}

/**
 * Ключ признака «знакомство предлагали». Свой, а не ключ прежнего полного
 * тура: знакомство — другой обход, и тем, кто закрыл старый тур, его стоит
 * предложить заново.
 */
export function guideStorageKey(userId: string, roleId: string): string {
	return `${onboardingStorageKey(userId, roleId)}:guide`;
}

/** Ключ признака «тур этого экрана прошли или пропустили» на этом устройстве. */
export function onboardingScreenKey(userId: string, roleId: string, screenId: string): string {
	return `${onboardingStorageKey(userId, roleId)}:screen:${screenId}`;
}
