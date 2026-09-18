import { env } from '$env/dynamic/private';
import { z } from 'zod';
import { outboundUrlIssue } from '$lib/contracts/integrations';

/**
 * Every environment variable the server needs, in one place. There are no
 * defaults: a missing or malformed value must stop the process at startup
 * rather than surface as a confusing failure later.
 */
/**
 * Флаг из окружения. Переменные окружения — всегда строки, а `Boolean('false')`
 * равно `true`, поэтому допустимы ровно два написания и ничего больше.
 */
const booleanFlag = z
	.enum(['true', 'false'], { error: 'must be exactly "true" or "false"' })
	.transform((value) => value === 'true');

/**
 * Необязательный адрес обмена: пустая строка означает «направление не
 * настроено», а не «адрес пустой». Правило самого адреса — общее
 * `outboundUrlIssue`: сервер идёт по нему сам, и откуда бы адрес ни пришёл —
 * из формы или из окружения, — опасность одна и та же.
 */
function exchangeUrl(withExternalId: boolean) {
	return z
		.string()
		.default('')
		.refine(
			(value) => value === '' || outboundUrlIssue(value.replace('{externalId}', 'x')) === null,
			{ error: (issue) => outboundUrlIssue(String(issue.input)) ?? 'must be a valid URL' }
		)
		.refine((value) => !withExternalId || value === '' || value.includes('{externalId}'), {
			error: 'must contain {externalId}: the application key goes there'
		})
		.transform((value) => (value === '' ? null : value));
}

/**
 * Ключ шифрования персональных данных: ровно 32 байта — либо 64 знака hex,
 * либо 44 знака base64 (вывод `openssl rand -base64 32`).
 *
 * Длину проверяет вид строки, а не разбор: `Buffer.from` молча проглатывает и
 * мусор, и обрезок, и ключ не той длины доехал бы до первой записи контактов, а
 * узнали бы о нём на первом чтении — уже с непрочитываемым шифртекстом в базе.
 */
const piiEncryptionKeySchema = z
	.string()
	.regex(/^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=)$/, {
		error: 'must be a 32-byte key: 64 hex characters or 44 base64 (openssl rand -base64 32)'
	})
	.transform((value) => Buffer.from(value, value.length === 64 ? 'hex' : 'base64'));

/**
 * Ключ шифрования персональных данных из произвольного набора переменных.
 *
 * Отдельной функцией, а не через {@link getConfig}: тот читает конфигурацию
 * целиком, а применение миграций обязано обходиться без адреса Redis и
 * хранилища файлов (`scripts/migrate.ts`). Схема при этом одна — иначе
 * приложение и миграция разошлись бы в том, какой ключ считают годным.
 */
export function readPiiEncryptionKey(source: Record<string, string | undefined>): Buffer {
	const raw = source.PII_ENCRYPTION_KEY;

	if (raw === undefined || raw === '') {
		throw new Error(
			'PII_ENCRYPTION_KEY is not set: contacts of people are stored encrypted and cannot be read without it (see .env.example)'
		);
	}

	const result = piiEncryptionKeySchema.safeParse(raw);

	if (!result.success) {
		throw new Error(
			`PII_ENCRYPTION_KEY: ${result.error.issues.map((issue) => issue.message).join('; ')}`
		);
	}

	return result.data;
}

/** Разбирается ли строка как адрес почтового сервера `smtp://` или `smtps://`. */
function isSmtpUrl(value: string): boolean {
	try {
		return ['smtp:', 'smtps:'].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

const configSchema = z
	.object({
		NODE_ENV: z.enum(['development', 'test', 'production']),
		/** postgres:// connection string for the primary database. */
		DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
		/** redis:// connection string for sessions, caches and queues. */
		REDIS_URL: z.url({ protocol: /^rediss?$/ }),
		/** Base URL of the Gotenberg service used to render documents to PDF. */
		GOTENBERG_URL: z.url({ protocol: /^https?$/ }),
		/** Public origin of the app; adapter-node needs it to validate form posts. */
		ORIGIN: z.url({ protocol: /^https?$/ }),
		/**
		 * Public demo. The sign-in page lists the three demo accounts and their
		 * shared password, the seed fills the stand with synthetic data, sessions
		 * opened on an account marked `is_demo` never get the permissions listed in
		 * `demoSessionPermissions`, those accounts cannot be switched off, and the
		 * audit log masks addresses and clients for them. Off by default is not an
		 * option: the deployment has to say which of the two it is.
		 */
		DEMO_MODE: booleanFlag,
		/**
		 * Общий пароль демонстрационных записей для карточки входа.
		 *
		 * Приложение паролей не проверяет: строка только повторяет то, что задано
		 * в каталоге (`SEED_DEMO_PASSWORD`, импорт realm), чтобы зритель
		 * публичного стенда мог войти, никого не спрашивая. Пустая — не задано:
		 * карточка тогда пароля не называет. Показывается только при `DEMO_MODE`.
		 *
		 * Потолок длины — от опечатки вида `DEMO_PASSWORD_HINT=$(cat .env)`: на
		 * экран уходит строка, а не файл.
		 */
		DEMO_PASSWORD_HINT: z
			.string()
			.max(128, { error: 'must be at most 128 characters' })
			.default('')
			.transform((value) => (value.trim() === '' ? null : value.trim())),
		/**
		 * The app sits behind a reverse proxy, so the client address comes from
		 * `X-Forwarded-For` instead of the socket. The header is read by the app
		 * itself — `clientAddress()` in `http.ts` takes the last entry, the one
		 * the proxy appended, and falls back to the socket address when the header
		 * is absent, as it is on a request made inside the deployment network.
		 * Never turn this on when the app is reachable directly: the client would
		 * then choose its own address for the audit log and the rate limiter.
		 */
		TRUST_PROXY: booleanFlag,
		/**
		 * Разрешить исходящие запросы на петлю и в приватные сети.
		 *
		 * Сервер ходит сам по адресам, которые назвал человек: приёмник подписки,
		 * адрес системы обучения, подключения обмена. Внутренняя сеть развёртывания —
		 * это каталог учётных записей, хранилище, база и служба метаданных облака;
		 * запрос туда от имени сервера и есть SSRF, поэтому по умолчанию в
		 * производственном режиме такие адреса запрещены.
		 *
		 * На машине разработчика и в прогоне наоборот: имитаторы и приёмник
		 * поднимаются рядом, на `127.0.0.1`, и без них связку нечем проверить.
		 * Отсюда и умолчание по режиму — `production` запрещает, остальные
		 * разрешают. Сказать иначе развёртывание может, но только явно.
		 */
		ALLOW_LOCAL_TARGETS: booleanFlag.optional(),
		/**
		 * Ключ, которым зашифрованы почта и телефон людей справочника
		 * (`src/lib/server/people/pii.ts`).
		 *
		 * Обязателен везде, включая машину разработчика: контакты лежат в базе
		 * шифртекстом, и установка без ключа не прочитает ни одного из них.
		 * Умолчания у него нет и быть не может — ключ, напечатанный в
		 * репозитории, не защищает ни от чего. Потеря ключа необратима: вместе с
		 * ним теряются контакты всех людей справочника, и «подобрать заново» тут
		 * нечего.
		 */
		PII_ENCRYPTION_KEY: piiEncryptionKeySchema,
		/**
		 * Подключения обмена (`docs/exchange-contract.md`).
		 *
		 * Умолчания развёртывания, а не настройки продукта: адреса чужих систем и
		 * секрет подписи задаёт тот, кто поднимает стенд, а сотрудник правит их на
		 * экране «Внешние системы» — сохранённое им сильнее (`integrations/settings.ts`).
		 * Пустая строка равна «не задано»: Compose подставляет пустое значение там,
		 * где переменной нет в `.env`, и различать эти два случая было бы различением
		 * без разницы.
		 */
		EXCHANGE_CMS_INSTANCE: z.string().min(1).default('itschool-site'),
		EXCHANGE_LMS_INSTANCE: z.string().min(1).default('moodle-itschool'),
		/**
		 * Адрес карточки заявки на сайте. Содержит `{externalId}` — на его место
		 * встаёт ключ заявки: карточку адресуют её же идентификатором.
		 */
		EXCHANGE_CMS_STATUS_URL: exchangeUrl(true),
		/** Адрес, по которому заводится учебная группа. */
		EXCHANGE_LMS_GROUPS_URL: exchangeUrl(false),
		/** Адрес веб-сервиса системы обучения: подсказка в разделе интеграций. */
		EXCHANGE_LMS_BASE_URL: exchangeUrl(false),
		/**
		 * Триггер имитатора CMS: по нему кнопка «Демо: заявка с сайта» на экране
		 * «Внешние системы» просит имитатор подать заявку — так сцена начинается
		 * там же, где начинается у посетителя сайта.
		 *
		 * Направлением контракта это не является: у настоящей CMS такого адреса
		 * нет, форму на ней заполняет человек. Поэтому кнопка живёт только на
		 * демонстрационном стенде (`DEMO_MODE=true`), а пустая строка — обычное
		 * состояние установки: кнопки нет.
		 */
		DEMO_CMS_TRIGGER_URL: exchangeUrl(false),
		/**
		 * Секрет подписи исходящих сообщений обмена — общий для обоих подключений.
		 *
		 * Пустая строка равна «не задан»: направление тогда просто не настроено.
		 * А вот заданный секрет обязан быть секретом: подпись HMAC-SHA256 стоит
		 * ровно столько, сколько стоит подбор ключа, и «exchange» из восьми букв
		 * подбирается словарём.
		 */
		EXCHANGE_SECRET: z
			.string()
			.default('')
			.refine((value) => value === '' || value.length >= 32, {
				error: 'must be at least 32 characters: it is the HMAC key of every outgoing message'
			})
			.transform((value) => (value === '' ? null : value)),
		/**
		 * Почтовый сервер, через который уходят уведомления, и адрес отправителя.
		 *
		 * Умолчания у них нет: адрес чужого узла и обратный адрес письма — это
		 * решение развёртывания, а подставленный `localhost:25` означал бы письма,
		 * которые никуда не уходят и об этом молчат. Пустая строка равна «не
		 * задано» — Compose подставляет пустое значение там, где переменной нет в
		 * `.env`, и различать эти два случая было бы различением без разницы.
		 *
		 * Не задано — канал «почта» не отправляет, а говорит об этом в журнале
		 * доставок (`src/lib/server/notifications/channels/email.ts`).
		 */
		SMTP_URL: z
			.string()
			.default('')
			.refine((value) => value === '' || isSmtpUrl(value), {
				error: 'must be an smtp:// or smtps:// URL'
			})
			.transform((value) => (value === '' ? null : value)),
		SMTP_FROM: z
			.string()
			.default('')
			.refine((value) => value === '' || z.email().safeParse(value).success, {
				error: 'must be an e-mail address'
			})
			.transform((value) => (value === '' ? null : value)),
		/**
		 * S3-совместимое хранилище файлов документов (в поставке — MinIO).
		 *
		 * Адрес — с протоколом и портом (`http://minio:9000`), потому что своего
		 * умолчания у S3-клиента для чужого хранилища нет. Регион MinIO не использует,
		 * но подпись запроса без него не собирается, поэтому переменная обязательна
		 * и здесь.
		 */
		S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
		S3_REGION: z.string().min(1),
		/** Имя бакета по правилам S3: строчные буквы, цифры, дефис и точка. */
		S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, {
			error: 'must be a valid S3 bucket name (3-63 chars, lowercase letters, digits, "-", ".")'
		}),
		S3_ACCESS_KEY: z.string().min(1),
		S3_SECRET_KEY: z.string().min(1),
		/**
		 * Путь к бакету в адресе (`http://host/bucket/key`) вместо поддомена
		 * (`http://bucket.host/key`). MinIO по адресу `http://minio:9000` понимает
		 * только первый вариант: поддомен бакета некуда разрешать. Умолчания нет —
		 * развёртывание обязано сказать, куда оно ходит.
		 */
		S3_FORCE_PATH_STYLE: booleanFlag,
		/**
		 * Каталог учётных записей: адрес realm целиком.
		 *
		 * По нему сервер читает `<issuer>/.well-known/openid-configuration` и по нему
		 * же сверяет `iss` каждого токена — поэтому строка обязана совпадать с тем,
		 * что каталог пишет в токен, символ в символ. Завершающий слэш такого
		 * совпадения не переживает, и его здесь быть не должно.
		 */
		OIDC_ISSUER_URL: z
			.url({ protocol: /^https?$/ })
			.refine((value) => !value.endsWith('/'), { error: 'must not end with a slash' }),
		/**
		 * Публичное основание адресов каталога: всё, что он о себе рассказывает,
		 * начинается с этой строки — и `OIDC_ISSUER_URL`, и адреса эндпоинтов в его
		 * метаданных. Для Keycloak это `KC_HOSTNAME` вместе с относительным путём
		 * установки (`https://<домен>/auth`), для локального стека — опубликованный
		 * порт (`http://localhost:58080`). Завершающий слэш такого совпадения не
		 * переживает, и его здесь быть не должно.
		 */
		OIDC_PUBLIC_URL: z
			.url({ protocol: /^https?$/ })
			.refine((value) => !value.endsWith('/'), { error: 'must not end with a slash' }),
		/**
		 * Адрес каталога для **серверных** запросов, если он не тот же, что для
		 * браузера. Необязательна: где приложение достаёт каталог по тому же адресу,
		 * что и человек, переносить нечего.
		 *
		 * В стеке они разные: человек приходит по опубликованному порту, а
		 * приложение стоит в одной сети с каталогом, и опубликованный порт для него
		 * чужой адрес. Тогда метаданные, ключи подписи и обмен кода уходят сюда, а
		 * `iss` токена по-прежнему сверяется с `OIDC_ISSUER_URL`: подменять то, чем
		 * токен подписан, нельзя ни при каких удобствах.
		 *
		 * Значение — основание, парное `OIDC_PUBLIC_URL`: с относительным путём
		 * установки, если он есть (`http://keycloak:8080/auth`), и без завершающего
		 * слэша.
		 */
		OIDC_INTERNAL_URL: z
			.url({ protocol: /^https?$/ })
			.refine((value) => !value.endsWith('/'), { error: 'must not end with a slash' })
			.optional(),
		/** Клиент realm, которым представляется сервер. */
		OIDC_CLIENT_ID: z.string().min(1),
		/**
		 * Секрет клиента. Клиент конфиденциальный: код на токены меняет сервер, а
		 * PKCE (`S256`) стоит сверху и закрывает перехват кода в браузере.
		 */
		OIDC_CLIENT_SECRET: z.string().min(1)
	})
	.superRefine((config, ctx) => {
		// Метаданные каталога перекладываются на внутренний адрес заменой публичного
		// основания, и работает это, только пока адрес realm с него и начинается.
		// Проверка здесь, а не при первом входе: развёртывание обязано узнать о
		// расхождении при старте, а не отказом в ответ на нажатие «Войти».
		if (!config.OIDC_ISSUER_URL.startsWith(`${config.OIDC_PUBLIC_URL}/`)) {
			ctx.addIssue({
				code: 'custom',
				path: ['OIDC_ISSUER_URL'],
				message: `must start with OIDC_PUBLIC_URL (${config.OIDC_PUBLIC_URL})`
			});
		}
	});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Validate a set of raw environment values. Exported separately from
 * {@link getConfig} so it can be exercised without touching the real process
 * environment.
 */
export function parseConfig(source: Record<string, string | undefined>): AppConfig {
	const result = configSchema.safeParse(source);

	if (!result.success) {
		const details = result.error.issues
			.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('\n');

		throw new Error(
			`Invalid environment configuration. Fix the following variables (see .env.example):\n${details}`
		);
	}

	return result.data;
}

let cached: AppConfig | undefined;

/**
 * The validated configuration. Parsed on first call and reused afterwards;
 * `src/hooks.server.ts` calls it while the server boots so that a bad
 * environment fails fast instead of on the first request.
 */
export function getConfig(): AppConfig {
	cached ??= parseConfig(env);
	return cached;
}
