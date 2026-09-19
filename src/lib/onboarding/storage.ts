/**
 * Признаки «подсказки показаны» и место, где они лежат.
 *
 * Отдельный файл без рун и без импортов сборки: ключи читает и состояние тура,
 * и модульные проверки, а проверкам браузера и контекста компонента не нужно.
 *
 * Почему признаки живут в `localStorage`, а не в базе, — в `tour.svelte.ts` и в
 * `docs/onboarding.md`. Здесь важно одно: ключ экрана начинается с ключа
 * полного тура, поэтому признаки одной учётной записи убираются вместе.
 */
const STORAGE_PREFIX = 'lct-crm:onboarding:';

/** Ключ признака «полный тур показан» для этой учётной записи и её роли. */
export function onboardingStorageKey(userId: string, roleId: string): string {
	return `${STORAGE_PREFIX}${userId}:${roleId}`;
}

/** Ключ признака «вступление этого экрана уже видели» на этом устройстве. */
export function onboardingScreenKey(userId: string, roleId: string, screenId: string): string {
	return `${onboardingStorageKey(userId, roleId)}:screen:${screenId}`;
}
