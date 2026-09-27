import { serveModuleFile } from '$lib/platform/card-registry.server';
import type { RequestHandler } from './$types';

/**
 * Файлы карточки, которые приносят модули, — например, список слушателей
 * потока (`files/learning/roster.xlsx`). Маршрут лежит внутри оболочки приложения, а не в
 * `/api`: это ссылки из диалогов карточки, сюда приходят с сессионной кукой, а
 * отказ рисуется страницей ошибки. Какой модуль отвечает за файл и действует
 * ли он в пространстве дела, решает реестр.
 */
export const GET: RequestHandler = (event) => serveModuleFile(event);
