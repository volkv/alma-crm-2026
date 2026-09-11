import { env } from '$env/dynamic/private';
import { z } from 'zod';

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

const configSchema = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']),
	/** postgres:// connection string for the primary database. */
	DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
	/** redis:// connection string for sessions, caches and queues. */
	REDIS_URL: z.url({ protocol: /^rediss?$/ }),
	/** Base URL of the Gotenberg service used to render documents to PDF. */
	GOTENBERG_URL: z.url({ protocol: /^https?$/ }),
	SMTP_HOST: z.string().min(1),
	SMTP_PORT: z.coerce.number().int().min(1).max(65535),
	/** Public origin of the app; adapter-node needs it to validate form posts. */
	ORIGIN: z.url({ protocol: /^https?$/ }),
	/** Key for signing session cookies. Must not be guessable. */
	SESSION_SECRET: z.string().min(32, 'must be at least 32 characters long'),
	/**
	 * Public demo: the read-only account may sign in and destructive actions are
	 * refused. Off by default is not an option — the deployment has to say which
	 * of the two it is.
	 */
	DEMO_MODE: booleanFlag,
	/**
	 * The app sits behind a reverse proxy, so `X-Forwarded-For` and
	 * `X-Forwarded-Proto` describe the real client. Never turn this on when the
	 * app is reachable directly: the client would then choose its own IP for the
	 * audit log and the rate limiter.
	 */
	TRUST_PROXY: booleanFlag,
	/** Directory for uploaded and generated files; must be writable and persist. */
	DATA_DIR: z.string().min(1)
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
