/**
 * Закрыть подсказки первого входа так, как их закрывает человек — кнопкой
 * «Позже» на приветствии (`data-testid="onboarding-tour"`). Тур открывается
 * один раз на роль в свежем браузере и без этого перекрывает экран своей
 * подложкой (`bg-black/10`, `z-50`): клик по кнопке под ним не проходит.
 *
 * Тот же приём, что и в `e2e/helpers/onboarding.ts` — подкладывать признак
 * «тур показан» напрямую в хранилище нельзя, скрытого выключателя в продукте
 * нет и не должно быть.
 */
import type { Page } from '@playwright/test';

export async function dismissOnboardingTour(page: Page): Promise<void> {
	const tour = page.getByTestId('onboarding-tour');

	try {
		await tour.waitFor({ state: 'visible', timeout: 15_000 });
	} catch {
		// Тур не появился за 15 секунд — сессия уже его видела (storageState с
		// прошлого запуска этого же хелпера) или роль тура не получает.
		return;
	}

	await tour.getByRole('button', { name: 'Позже' }).click();
	await tour.waitFor({ state: 'hidden' });
}
