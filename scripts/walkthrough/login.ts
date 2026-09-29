/**
 * Playwright-хелпер стенда для ручного прохода: логинится под каждой
 * демонстрационной ролью через настоящий Keycloak — тем же путём, каким его
 * проходит человек (`e2e/helpers/sign-in.ts`), без обхода формы, — и
 * сохраняет `storageState`, чтобы тот, кто ведёт проход, открывал браузер уже
 * вошедшим под нужной ролью.
 *
 * Три демонстрационные записи (`admin`, `lead`, `manager`) — из группы `demo`
 * realm `lct`: у них общий пароль и нет второго фактора
 * (`keycloak/README.md`, «Исключение — группа demo»), поэтому вход — обычная
 * форма логина и пароля, без TOTP.
 *
 * Запуск: node --env-file-if-exists=.env scripts/walkthrough/login.ts \
 *   <baseUrl> <outDir> [screenshotDir]
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { dismissOnboardingTour } from './onboarding.ts';

/** Пароль демонстрационных записей — публичный, см. docs/seeds.md. */
const PASSWORD = process.env.WALK_DEMO_PASSWORD ?? 'lct-demo-2026';

/** Имена входа — `scripts/seed/users.ts`, `DEMO_LOGINS`. */
const ROLES: { login: string; label: string; file: string }[] = [
	{ login: 'manager', label: 'КАМ (Менеджер Демо)', file: 'manager.json' },
	{ login: 'lead', label: 'Руководитель (Руководитель Демо)', file: 'lead.json' },
	{ login: 'admin', label: 'Администратор (Администратор Демо)', file: 'admin.json' }
];

/** Пространство `b2b` — эталонный процесс «Работа с ВУЗ», сюда встают все три роли. */
const INTERACTIONS_PATH = '/w/b2b/interactions';

async function main(): Promise<void> {
	const baseUrl = process.argv[2] ?? 'http://localhost:3000';
	const outDir = process.argv[3] ?? path.join(process.cwd(), '.walkthrough', 'state');
	const screenshotDir = process.argv[4];

	await mkdir(outDir, { recursive: true });
	if (screenshotDir) {
		await mkdir(screenshotDir, { recursive: true });
	}

	for (const role of ROLES) {
		const browser = await chromium.launch();
		const context = await browser.newContext();
		const page = await context.newPage();

		await page.goto(`${baseUrl}/login`);
		await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/);
		await page.locator('#username').fill(role.login);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();
		await page.waitForURL((url) => !url.toString().includes('/realms/'));

		await page.goto(`${baseUrl}${INTERACTIONS_PATH}`);
		// `networkidle` знает только про загрузку файлов, а список взаимодействий
		// группируется в доску клиентским кодом уже после гидратации
		// (`docs/development.md`, «Всплывающие слои»): без ожидания признака
		// `data-hydrated` снимок снят раньше, чем доска разложила карточки по
		// стадиям, и колонки на нём пустые при полной базе.
		await page.locator('body[data-hydrated]').waitFor({ timeout: 15_000 });
		// Первый вход этой ролью в свежем браузере открывает тур подсказок и
		// перекрывает экран подложкой; закрываем его до снимка и до сохранения
		// storageState — иначе тот, кто откроет сессию, увидит тур повторно.
		await dismissOnboardingTour(page);

		if (screenshotDir) {
			await page.screenshot({
				path: path.join(screenshotDir, `${role.login}.png`),
				fullPage: true
			});
		}

		const stateFile = path.join(outDir, role.file);
		await context.storageState({ path: stateFile });
		await context.close();
		await browser.close();

		console.log(`${role.label}: сессия сохранена в ${stateFile}`);
	}
}

await main();
