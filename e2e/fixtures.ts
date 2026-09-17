import { expect, test as base } from '@playwright/test';
import { LEAD_STATE, MANAGER_STATE } from './global-setup';

/**
 * Тест, который начинается с уже вошедшего демонстрационного менеджера.
 *
 * Сессию готовит глобальный сетап — один вход на весь прогон, а не по входу на
 * рабочий процесс: вход идёт через каталог учётных записей, и восемь процессов
 * гоняли бы через него восемь настоящих сессий на каждый файл. Здесь остаётся
 * только подставить сохранённое состояние браузера.
 */
export const test = base.extend<object>({ storageState: MANAGER_STATE });

/** То же самое, но вошёл руководитель: он видит работу своих людей. */
export const leadTest = base.extend<object>({ storageState: LEAD_STATE });

export { expect };
