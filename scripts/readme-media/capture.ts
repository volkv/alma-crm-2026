/**
 * Съёмка экранов README против поднятого стенда.
 *
 * Снимки в `docs/media/` — единственное, что читатель README видит до того, как
 * что-нибудь запустит, и они устаревают молча: экран переименовали, а картинка
 * осталась прежней. Поэтому снимает их скрипт, а не человек мышкой: любой кадр
 * пересобирается одной командой и снова совпадает с продуктом.
 *
 * Скрипт ходит по стенду тем же путём, что и человек, — через каталог учётных
 * записей. Другого входа в системе нет: паролей она не хранит, и подделать
 * сессию значило бы снимать систему, которой не существует.
 *
 * Запуск и предварительные условия — `docs/readme-media.md`.
 *
 * ```
 * node scripts/readme-media/capture.ts                     # все кадры
 * node scripts/readme-media/capture.ts reports exchange    # только названные
 * node scripts/readme-media/capture.ts --list              # что вообще снимает
 * ```
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { SHOTS, VIEWPORT, type Shot, type ShotRole } from './shots.ts';

/** Куда складываются кадры: тот же каталог, на который ссылается README. */
const OUTPUT = path.join(import.meta.dirname, '..', '..', 'docs', 'media');

function requiredEnv(name: string, fallback?: string): string {
	const value = process.env[name] ?? fallback;

	if (value === undefined || value === '') {
		throw new Error(`Не задано ${name}: см. docs/readme-media.md`);
	}

	return value;
}

/** Адрес стенда: локальный стек по умолчанию. */
const BASE_URL = requiredEnv('MEDIA_BASE_URL', 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Пароль демонстрационных записей каталога.
 *
 * Он не хранится в репозитории: значение принадлежит той машине, на которой
 * подняли Keycloak, и приезжает из её окружения — как и при обычном запуске
 * стека.
 */
const PASSWORD = requiredEnv('SEED_DEMO_PASSWORD');

/**
 * Вход через каталог учётных записей: кнопка на нашей странице, форма Keycloak,
 * возврат в приложение.
 *
 * Поля формы ищутся по идентификаторам (`#username`, `#password`), а не по
 * подписям: подписи Keycloak локализует, и realm стенда стоит на русском.
 */
async function signIn(context: BrowserContext, login: string): Promise<void> {
	const page = await context.newPage();

	try {
		await page.goto(`${BASE_URL}/login`);
		await page.getByRole('button', { name: 'Войти', exact: true }).click();
		await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/);
		await page.locator('#username').fill(login);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();
		await page.waitForURL(`${BASE_URL}/`);
	} finally {
		await page.close();
	}
}

/**
 * Сессии по ролям: вход идёт один раз на роль, а не на кадр. Восемь заходов в
 * каталог ради восьми снимков одной роли — это восемь минут ожидания и ничем
 * не лучший результат.
 */
async function sessions(
	browser: Browser,
	roles: Set<ShotRole>
): Promise<Map<ShotRole, BrowserContext>> {
	const contexts = new Map<ShotRole, BrowserContext>();

	for (const role of roles) {
		const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });

		if (role !== 'anonymous') {
			await signIn(context, role);
		}

		contexts.set(role, context);
	}

	return contexts;
}

async function capture(context: BrowserContext, shot: Shot): Promise<string> {
	const page = await context.newPage();

	try {
		if (shot.viewport !== undefined) {
			await page.setViewportSize(shot.viewport);
		}

		await page.goto(`${BASE_URL}${shot.path}`, { waitUntil: 'load' });

		// Признак ожившей страницы ставит корневой layout: до него разметка на
		// экране есть, а диаграммы и всплывающие слои ещё не собраны.
		if (shot.standalone !== true) {
			await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: 20_000 });
		}

		if (shot.waitFor !== undefined) {
			await page.getByText(shot.waitFor).first().waitFor({ state: 'visible', timeout: 20_000 });
		}

		if (shot.tab !== undefined) {
			await page.getByRole('tab', { name: shot.tab }).click();
		}

		// Анимации входа компонентов на снимке превращаются в полупрозрачные
		// карточки: кадр снимается после того, как они закончились.
		await page.waitForTimeout(600);

		const file = path.join(OUTPUT, `${shot.name}.png`);

		await page.screenshot({ path: file, fullPage: shot.fullPage === true });

		return file;
	} finally {
		await page.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.includes('--list')) {
		for (const shot of SHOTS) {
			console.log(
				`${shot.name.padEnd(26)} ${shot.role.padEnd(10)} ${shot.path}  — ${shot.caption}`
			);
		}

		return;
	}

	const names = args.filter((argument) => !argument.startsWith('--'));
	const selected = names.length === 0 ? SHOTS : SHOTS.filter((shot) => names.includes(shot.name));
	const unknown = names.filter((name) => !SHOTS.some((shot) => shot.name === name));

	if (unknown.length > 0) {
		throw new Error(`Кадров с такими именами нет: ${unknown.join(', ')}. Список — «--list»`);
	}

	await mkdir(OUTPUT, { recursive: true });

	const browser = await chromium.launch();
	const contexts = await sessions(browser, new Set(selected.map((shot) => shot.role)));

	/**
	 * Неснятые кадры копятся, а не останавливают съёмку.
	 *
	 * Кадр не снялся — это обычно не сбой скрипта, а сломанный экран: страница не
	 * ожила или на ней нет того, ради чего её открывали. Бросить на первом же
	 * значило бы оставить остальные снимки несобранными и узнать про один экран
	 * вместо всех. Список несобранного печатается в конце, а код возврата —
	 * ненулевой: молча пропущенный кадр хуже упавшего.
	 */
	const failures: { name: string; reason: string }[] = [];

	try {
		for (const shot of selected) {
			const context = contexts.get(shot.role);

			if (context === undefined) {
				throw new Error(`Сессия роли «${shot.role}» не открыта`);
			}

			try {
				console.log(`${shot.name}: ${await capture(context, shot)}`);
			} catch (failure) {
				const reason = failure instanceof Error ? failure.message.split('\n')[0] : String(failure);

				failures.push({ name: shot.name, reason });
				console.error(`${shot.name}: не снят — ${reason}`);
			}
		}
	} finally {
		for (const context of contexts.values()) {
			await context.close();
		}

		await browser.close();
	}

	if (failures.length > 0) {
		console.error(`\nНе снято кадров: ${failures.length}`);

		for (const failure of failures) {
			console.error(`  ${failure.name} — ${failure.reason}`);
		}

		process.exitCode = 1;
	}
}

await main();
