import { expect, test as base } from '@playwright/test';
import { MANAGER_STATE } from './global-setup';

/**
 * Тест, который начинается с уже вошедшего менеджера.
 *
 * Сессию готовит глобальный сетап — один вход на весь прогон, а не по входу на
 * рабочий процесс: POST на `/login` ограничен по адресу, и восемь процессов,
 * каждый со своим входом, упирались в защиту, рассчитанную на живого человека.
 * Здесь остаётся только подставить сохранённое состояние браузера.
 */
export const test = base.extend<object>({ storageState: MANAGER_STATE });

export { expect };
