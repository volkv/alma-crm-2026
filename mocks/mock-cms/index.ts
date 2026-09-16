/**
 * Имитатор CMS отдельным процессом: контейнер стенда и `pnpm run mocks:cms`.
 *
 * Переменные окружения: `PORT` (по умолчанию 8081), `HOST`, `INSTANCE_NAME`
 * (имя экземпляра CMS в сообщениях), `CRM_BASE_URL` и `CRM_API_KEY` (куда и
 * чем представляться, отправляя заявку), `EXCHANGE_SECRET` (секрет, которым
 * CRM подписывает исходящие), `JOURNAL_SIZE`.
 *
 * Без `CRM_BASE_URL` и `CRM_API_KEY` сервис поднимается и честно отвечает, что
 * обмен на стенде не настроен: заглушка, притворяющаяся настроенной, отняла бы
 * у проверки её единственный смысл.
 */
import { integerEnv, stopOnSignals, textEnv } from '../shared/env.ts';
import { DEFAULT_JOURNAL_SIZE } from '../shared/journal.ts';
import { startMockCms } from './service.ts';

const service = await startMockCms({
	port: integerEnv('PORT', 8081),
	host: textEnv('HOST') ?? '0.0.0.0',
	instance: textEnv('INSTANCE_NAME') ?? 'itschool-site',
	crm: { baseUrl: textEnv('CRM_BASE_URL'), apiKey: textEnv('CRM_API_KEY') },
	exchangeSecret: textEnv('EXCHANGE_SECRET'),
	journalSize: integerEnv('JOURNAL_SIZE', DEFAULT_JOURNAL_SIZE)
});

console.log(`mock-cms слушает порт ${service.port}; состояние — GET /__state`);

stopOnSignals(service.stop);
