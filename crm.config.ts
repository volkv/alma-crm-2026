/**
 * Модули этой установки. Порядок здесь — порядок в настройках пространств и в
 * меню.
 *
 * Модуль заказчика подключается одной строкой импорта и ключом в списке:
 *
 *     import acme from './src/modules/custom/acme/index.ts';
 *
 * Расширение `.ts` в импортах обязательно: конфиг читают и миграция с сидом,
 * которые идут обычным процессом Node, а тот без расширения файл не найдёт.
 */
import { defineConfig } from '$lib/platform/config';
import contracts from './src/modules/contracts/index.ts';
import learning from './src/modules/learning/index.ts';
import meetings from './src/modules/meetings/index.ts';
import payment from './src/modules/payment/index.ts';

export default defineConfig({ modules: [contracts, payment, learning, meetings] });
