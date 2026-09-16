/**
 * Имитатор системы обучения отдельным процессом: контейнер стенда и
 * `pnpm run mocks:lms`.
 *
 * Переменные окружения: `PORT` (по умолчанию 8082), `HOST`, `INSTANCE_NAME`
 * (имя экземпляра LMS в сообщениях), `PUBLIC_URL` (адрес группы для человека),
 * `CRM_BASE_URL` и `CRM_API_KEY` (куда и чем представляться, отправляя
 * результат), `EXCHANGE_SECRET` (секрет, которым CRM подписывает исходящие),
 * `JOURNAL_SIZE`.
 *
 * Без `CRM_BASE_URL` и `CRM_API_KEY` сервис поднимается и честно отвечает, что
 * обмен на стенде не настроен.
 */
import { integerEnv, stopOnSignals, textEnv } from '../shared/env.ts';
import { DEFAULT_JOURNAL_SIZE } from '../shared/journal.ts';
import { startMockLms } from './service.ts';

const service = await startMockLms({
	port: integerEnv('PORT', 8082),
	host: textEnv('HOST') ?? '0.0.0.0',
	instance: textEnv('INSTANCE_NAME') ?? 'moodle-itschool',
	publicUrl: textEnv('PUBLIC_URL') ?? undefined,
	crm: { baseUrl: textEnv('CRM_BASE_URL'), apiKey: textEnv('CRM_API_KEY') },
	exchangeSecret: textEnv('EXCHANGE_SECRET'),
	journalSize: integerEnv('JOURNAL_SIZE', DEFAULT_JOURNAL_SIZE)
});

console.log(`mock-lms слушает порт ${service.port}; состояние — GET /__state`);

stopOnSignals(service.stop);
