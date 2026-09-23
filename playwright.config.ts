import { defineConfig, devices } from '@playwright/test';
import { E2E_EXCHANGE_ENV } from './e2e/exchange-keys.ts';

/**
 * Порт прогона: свой у каждого, чтобы на одной машине помещалось несколько.
 *
 * Значение по умолчанию — 4173; соседний прогон запускается из отдельной рабочей
 * копии со своим `E2E_PORT` из объявленных в realm (4173–4177) — подробности и
 * то, что при этом всё равно общее, в «Параллельных прогонах»
 * `docs/development.md`.
 */
const port = Number(process.env.E2E_PORT ?? 4173);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
	throw new Error(`E2E_PORT must be a TCP port number, got «${process.env.E2E_PORT}»`);
}

const origin = `http://localhost:${port}`;

/**
 * Состояние прогона тоже своё на каждый порт, иначе от второго прогона спасал бы
 * один только свободный порт: соседний сетап залил бы ту же базу заново, а общий
 * счётчик попыток входа сбросился бы посреди проверки лимита.
 *
 * База PostgreSQL заводится глобальным сетапом в том же сервере из
 * `docker-compose.yml`; логических баз у Redis шестнадцать, поэтому номер — это
 * остаток от деления порта. Прогоны на соседних портах не пересекаются, а порты,
 * отличающиеся ровно на 16, делят счётчики — берите соседний.
 */
const databaseUrl = `postgres://lct:lct@localhost:55432/lct_e2e_${port}`;
const redisUrl = `redis://localhost:56379/${port % 16}`;

/**
 * The end-to-end suite runs against a production build backed by the PostgreSQL
 * and Redis services from docker-compose.yml, which `pnpm run test:e2e` starts
 * first. The values below are fixed on purpose: the suite must behave the same
 * on a laptop and in CI, so it does not read the developer's .env.
 */
export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.test.ts',
	fullyParallel: true,
	// Число рабочих процессов не задано нарочно, и добавлять его пробовали:
	// прогон в два ряда идёт заметно быстрее (девять минут против четырнадцати),
	// но краснеет каждый раз в новом месте. За рядами стоит одно приложение в
	// одном процессе и одна база: второй ряд не заполняет чужое ожидание, а
	// становится в ту же очередь, и проверки, чьи ожидания рассчитаны на один
	// ряд, начинают не укладываться в них — то импорт каталога, то перестройка
	// отчёта. Ускорять это нужно со стороны очереди, а не числа рядов.
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	// `list` — чтобы прогон было видно в терминале и в логе CI, `html` — чтобы
	// после падения было что открыть: без него каталог отчёта пуст, и выгружать
	// из CI нечего.
	reporter: [['list'], ['html', { open: 'never' }]],
	// Трасса — с каждого падения: повторов нет, и другого шанса разобраться в
	// упавшем прогоне CI не будет. `reducedMotion` — не про оформление, а про
	// устойчивость: карточка подсказок ходит за элементом покадрово, и пока
	// страница едет плавно, она едет вместе с ней; на занятой машине нажатие
	// ждёт остановки карточки до самого таймаута.
	use: { baseURL: origin, trace: 'retain-on-failure', reducedMotion: 'reduce' },
	// Миграции, каталог ролей и учётные записи прогона — до первого запроса к
	// приложению: страница входа читает настройки из базы.
	globalSetup: './e2e/global-setup.ts',
	projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
	webServer: {
		command: 'pnpm run build && node build/index.js',
		port,
		timeout: 180_000,
		reuseExistingServer: false,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			NODE_ENV: 'production',
			PORT: String(port),
			ORIGIN: origin,
			DATABASE_URL: databaseUrl,
			REDIS_URL: redisUrl,
			GOTENBERG_URL: 'http://localhost:3001',
			// Почта уведомлений: Mailpit из `docker-compose.yml`, опубликованный на
			// 1025, — его поднимает `e2e/stack.ts`. Письмо уходит по-настоящему.
			SMTP_URL: 'smtp://localhost:1025',
			SMTP_FROM: 'lct-crm@e2e.local',
			// Потолок тела запроса у adapter-node: тот же, что в compose. С его
			// умолчанием (512K) загрузка обычного скана отваливается с 413.
			BODY_SIZE_LIMIT: '27M',
			// Демонстрационный вход — часть проверяемого поведения.
			DEMO_MODE: 'true',
			// Пароль, который карточка входа показывает зрителю стенда. Здесь это
			// пароль прогона: учётные записи каталога приводит к нему глобальный сетап
			// (`E2E_PASSWORD` в `e2e/global-setup.ts`, он же сверяет, что строки
			// совпадают) — карточка обязана называть тот пароль, который пускает.
			DEMO_PASSWORD_HINT: 'Проверка-Входа-2026!',
			// Ключ шифрования контактов людей: прогон свой, и ключ у него свой —
			// база прогона заводится заново, а с чужим ключом её контакты не
			// прочитались бы. Сид прогона получает то же значение: глобальный сетап
			// запускает миграцию и сид с этим окружением.
			PII_ENCRYPTION_KEY: 'KfAA/EWod3wd+ai6b1LHC62LWho5pPp1ajJnQNdbqUs=',
			// Обмен: приложение ходит до имитаторов из `docker-compose.yml` —
			// `mock-cms` на 58081 и `mock-lms` на 58082. Адрес карточки заявки несёт
			// `{externalId}` — на его место встаёт ключ заявки.
			EXCHANGE_CMS_STATUS_URL: 'http://localhost:58081/api/applications/{externalId}/status',
			EXCHANGE_LMS_GROUPS_URL: 'http://localhost:58082/api/groups',
			EXCHANGE_LMS_BASE_URL: 'http://localhost:58082',
			// Триггер имитатора CMS за кнопкой «Демо: заявка с сайта»: приложение
			// прогона ходит до контейнера по опубликованному порту, как ходило бы с
			// машины разработчика.
			DEMO_CMS_TRIGGER_URL: 'http://localhost:58081/__send-application',
			// Ключи обмена, имена подключений и секрет подписи — ровно те, с которыми
			// `e2e/stack.ts` поднял имитаторов. Отсюда их читает и сид прогона:
			// глобальный сетап запускает его с этим окружением, и ключи стенда
			// оказываются заведены до первой проверки (`e2e/exchange-keys.ts`).
			...E2E_EXCHANGE_ENV,
			TRUST_PROXY: 'false',
			// Имитаторы и приёмник подписки прогона живут на петле: прогон идёт в
			// производственном режиме, где умолчание — запрет, и без этой строки
			// проверять было бы нечего.
			ALLOW_LOCAL_TARGETS: 'true',
			// Каталог учётных записей — тот же контейнер, что у стека: Keycloak
			// стартует полторы минуты, и второй под прогон не поднимают. Записи и
			// пароли прогона приводит к своим глобальный сетап.
			//
			// Адреса возврата клиента realm перечислены в `keycloak/realm-lct.json`
			// и включают порты 4173–4177. `E2E_PORT` берётся из них: адрес возврата,
			// которого в realm нет, каталог разворачивает — прогон падает на входе
			// (`docs/development.md`, «Параллельные прогоны»).
			OIDC_ISSUER_URL: 'http://localhost:58080/realms/lct',
			OIDC_PUBLIC_URL: 'http://localhost:58080',
			OIDC_CLIENT_ID: 'lct-crm',
			OIDC_CLIENT_SECRET: 'lct-crm-dev-secret',
			// Хранилище — тот же MinIO из `docker-compose.yml`, но свой бакет:
			// объекты прогона не должны мешаться с файлами стенда, а стенд
			// переживает `docker compose down` без `-v` вместе с ними. Бакет
			// заводит `minio-init`, которого запускает `pnpm run test:e2e`.
			S3_ENDPOINT: 'http://localhost:59000',
			S3_REGION: 'us-east-1',
			S3_BUCKET: 'lct-documents-e2e',
			S3_ACCESS_KEY: 'lct',
			S3_SECRET_KEY: 'lct-secret-key',
			S3_FORCE_PATH_STYLE: 'true'
		}
	}
});
