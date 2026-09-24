import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

/**
 * Второй фактор штатных учётных записей в прогоне — тем же путём, каким его
 * проходит человек: страница настройки кода на первом входе, форма кода на
 * каждом следующем. Код считается здесь по тому же секрету, который человек
 * сканирует QR-кодом (RFC 6238: HMAC-SHA1, 6 цифр, шаг 30 секунд — политика
 * realm, `keycloak/realm-lct.json`).
 *
 * Секрет живёт в файле рядом с сохранёнными сессиями: его заводит глобальный
 * сетап, а спеки, которые входят по ходу дела, читают. Вместе с ним хранится
 * шаг, в котором код уже предъявлен: каталог не принимает один и тот же код
 * дважды (`otpPolicyCodeReusable: false`), и вход в том же окне ждёт
 * следующего.
 */

const STEP_SECONDS = 30;

type StoredSecret = { secret: string; lastStep: number };

function currentStep(): number {
	return Math.floor(Date.now() / 1000 / STEP_SECONDS);
}

/**
 * Код TOTP шага `step`. Скрытое поле страницы настройки несёт секрет как есть:
 * приложение получает его в base32 из QR-кода, ключ HMAC — байты той же строки.
 */
function totpCode(secret: string, step: number): string {
	const counter = Buffer.alloc(8);

	counter.writeBigUInt64BE(BigInt(step));

	const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const value = digest.readUInt32BE(offset) & 0x7fffffff;

	return String(value % 1_000_000).padStart(6, '0');
}

/** Шаг для нового кода: тот, в котором код уже предъявлен, пропускается. */
async function freshStep(lastStep: number): Promise<number> {
	let step = currentStep();

	while (step <= lastStep) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		step = currentStep();
	}

	return step;
}

/**
 * Первый вход штатной записи: каталог требует настроить код. Секрет берётся со
 * страницы настройки, код из него подтверждает настройку, секрет уходит в файл.
 */
export async function configureSecondFactor(page: Page, file: string): Promise<void> {
	const secretField = page.locator('#totpSecret');

	await secretField.waitFor({ state: 'attached' });

	const secret = await secretField.inputValue();
	const step = await freshStep(-1);

	await page.locator('#totp').fill(totpCode(secret, step));
	await page.locator('#saveTOTPBtn').click();

	await writeFile(file, JSON.stringify({ secret, lastStep: step } satisfies StoredSecret));
}

/** Следующий вход той же записи: форма кода после пароля. */
export async function enterSecondFactor(page: Page, file: string): Promise<void> {
	const stored = JSON.parse(await readFile(file, 'utf8')) as StoredSecret;
	const step = await freshStep(stored.lastStep);

	await page.locator('#otp').fill(totpCode(stored.secret, step));
	await page.locator('#kc-login').click();

	await writeFile(
		file,
		JSON.stringify({ secret: stored.secret, lastStep: step } satisfies StoredSecret)
	);
}
