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
 * Наборов кадров два, и живут они разной жизнью: снимки README рассказывают о
 * продукте снаружи, снимки справки стоят внутри статей и едут вместе с
 * приложением. Общее у них всё, кроме списка кадров, каталога и размера окна, —
 * поэтому набор выбирается ключом, а скрипт остаётся один.
 *
 * ```
 * node scripts/readme-media/capture.ts                     # все кадры README
 * node scripts/readme-media/capture.ts reports exchange    # только названные
 * node scripts/readme-media/capture.ts --set=help          # кадры справки
 * node scripts/readme-media/capture.ts --list              # что вообще снимает
 * ```
 */
import { execFile } from 'node:child_process';
import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SHOTS, VIEWPORT, type Shot, type ShotRole } from './shots.ts';
import { HELP_SHOTS, HELP_VIEWPORT } from './help-shots.ts';

const run = promisify(execFile);

/**
 * Кадр со своим шагом на странице.
 *
 * Кадры README снимаются с адреса, и этого им хватает. Справке нужны и такие
 * экраны, которых по адресу не бывает: палитра поиска открывается клавишами, а
 * карточка документа лежит за нажатием в списке. Поэтому кадр может принести
 * свой шаг — он делается после того, как страница ожила, и до съёмки.
 */
export type Frame = Shot & { prepare?: (page: Page) => Promise<void> };

type FrameSet = {
	shots: readonly Frame[];
	/** Куда складываются кадры: имя кадра — путь внутри этого каталога. */
	output: string;
	viewport: { width: number; height: number };
	/**
	 * Пережимать ли готовый PNG.
	 *
	 * Кадры справки едут внутри образа и тянутся в браузер читателя, поэтому их
	 * вес — часть продукта. Кадры README лежат в репозитории и открываются
	 * страницей GitHub по одному.
	 */
	optimize: boolean;
};

const MEDIA = path.join(import.meta.dirname, '..', '..', 'docs', 'media');
const HELP = path.join(import.meta.dirname, '..', '..', 'static', 'help');

const SETS: Record<string, FrameSet> = {
	readme: { shots: SHOTS, output: MEDIA, viewport: VIEWPORT, optimize: false },
	help: { shots: HELP_SHOTS, output: HELP, viewport: HELP_VIEWPORT, optimize: true }
};

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
 * Признак ожившей страницы ставит корневой layout: до него разметка на экране
 * есть, а диаграммы, всплывающие слои и подсказки первого входа ещё не собраны.
 */
async function hydrated(page: Page): Promise<void> {
	await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: 20_000 });
}

/**
 * Закрыть подсказки первого входа так, как их закрывает человек.
 *
 * Признак «подсказки показаны» лежит в браузере, а браузер у съёмки каждый раз
 * чистый: тур открывается на первом же экране любой роли и попал бы на каждый
 * кадр поверх самого экрана. Нажимается «Позже» на приветствии — та самая
 * кнопка, которой его закрывает человек, впервые вошедший в систему: скрытого
 * выключателя в продукте нет, и снимок с подложенным признаком показывал бы
 * систему, которой не существует.
 */
async function skipOnboardingTour(page: Page): Promise<void> {
	const tour = page.getByTestId('onboarding-tour');

	await tour.waitFor({ state: 'visible', timeout: 20_000 });
	await tour.getByRole('button', { name: 'Позже' }).click();
	await tour.waitFor({ state: 'hidden', timeout: 20_000 });
}

/**
 * Вход через каталог учётных записей: кнопка на нашей странице, форма Keycloak,
 * возврат в приложение.
 *
 * Поля формы ищутся по идентификаторам (`#username`, `#password`), а не по
 * подписям: подписи Keycloak локализует, и realm стенда стоит на русском.
 *
 * `keepTour` оставляет подсказки первого входа открытыми — это нужно ровно
 * одному кадру на набор, тому, ради которого они и снимаются.
 */
async function signIn(context: BrowserContext, login: string, keepTour: boolean): Promise<void> {
	const page = await context.newPage();

	try {
		await page.goto(`${BASE_URL}/login`);
		await page.getByRole('button', { name: 'Войти', exact: true }).click();
		await page.waitForURL(/\/realms\/lct\/protocol\/openid-connect\/auth/);
		await page.locator('#username').fill(login);
		await page.locator('#password').fill(PASSWORD);
		await page.locator('#kc-login').click();
		await page.waitForURL(`${BASE_URL}/`);

		if (!keepTour) {
			await hydrated(page);
			await skipOnboardingTour(page);
		}
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
	roles: Set<ShotRole>,
	viewport: { width: number; height: number }
): Promise<Map<ShotRole, BrowserContext>> {
	const contexts = new Map<ShotRole, BrowserContext>();

	for (const role of roles) {
		const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });

		if (role !== 'anonymous') {
			await signIn(context, role, false);
		}

		contexts.set(role, context);
	}

	return contexts;
}

/**
 * Кадру нужна своя сессия, если он показывает то, что помнит браузер: признак
 * «подсказки уже показаны» и выбранную тему.
 *
 * Общая сессия роли для такого кадра не годится в обе стороны: подсказки в ней
 * уже закрыты, а выбранная на кадре тёмная тема осталась бы у всех следующих
 * снимков этой роли. Своя сессия стоит одного входа в каталог и не зависит от
 * того, в каком порядке кадры сняли.
 */
function needsOwnSession(shot: Frame): boolean {
	return shot.tour === true || shot.theme !== undefined;
}

/** Сессия под один кадр: тот же вход, но в чистый браузер. */
async function ownSession(
	browser: Browser,
	shot: Frame,
	viewport: { width: number; height: number }
): Promise<BrowserContext> {
	const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });

	if (shot.role !== 'anonymous') {
		await signIn(context, shot.role, shot.tour === true);
	}

	return context;
}

/**
 * Пережать PNG палитрой.
 *
 * Снимок интерфейса — это сплошные заливки, рамки и текст: цветов на экране
 * заметно меньше трёхсот, а лежит он полноцветной картинкой. Палитра из 256
 * цветов отдаёт ту же картинку втрое-вчетверо легче и без потерь, которые
 * видно: считается она по самому кадру, а не берётся стандартная. Размывание
 * выключено намеренно — на тексте оно даёт рябь и растит файл.
 *
 * Пережимает `ffmpeg`, которым в этом же каталоге собираются ролики: своей
 * зависимости ради одной команды в проекте не появляется.
 */
async function shrink(file: string): Promise<void> {
	const packed = `${file}.packed.png`;

	await run('ffmpeg', [
		'-y',
		'-loglevel',
		'error',
		'-i',
		file,
		'-vf',
		'split[source][copy];[source]palettegen=max_colors=256:stats_mode=full[palette];[copy][palette]paletteuse=dither=none',
		packed
	]);

	await rename(packed, file);
}

async function capture(context: BrowserContext, shot: Frame, set: FrameSet): Promise<string> {
	const page = await context.newPage();

	try {
		if (shot.viewport !== undefined) {
			await page.setViewportSize(shot.viewport);
		}

		await page.goto(`${BASE_URL}${shot.path}`, { waitUntil: 'load' });

		if (shot.standalone !== true) {
			await hydrated(page);
		}

		// Тема переключается тем же переключателем в шапке, которым её переключает
		// человек: на кадре видно и выбранное положение, а не только цвета.
		// Кнопка одна, положения идут по кругу — отсюда нажатия до нужного.
		if (shot.theme !== undefined) {
			const toggle = page.locator('[data-slot="theme-toggle"]').first();

			for (let attempt = 0; attempt < 3; attempt += 1) {
				if ((await toggle.getAttribute('data-theme-option')) === shot.theme) {
					break;
				}

				await toggle.click();
			}
		}

		// Шаг кадра идёт до ожидания текста: ждут обычно того, что этот шаг и
		// открывает.
		if (shot.prepare !== undefined) {
			await shot.prepare(page);
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

		const file = path.join(set.output, `${shot.name}.png`);

		// Имя кадра может вести по каталогам (`user/start-1`): снимки справки
		// разложены по разделам так же, как её статьи.
		await mkdir(path.dirname(file), { recursive: true });
		await page.screenshot({ path: file, fullPage: shot.fullPage === true });

		if (set.optimize) {
			await shrink(file);
		}

		return file;
	} finally {
		await page.close();
	}
}

/**
 * Какой набор кадров снимаем: `--set=help`; по умолчанию README.
 *
 * Значение пишется через знак равенства, а не следующим словом: имена кадров
 * идут теми же аргументами, и кадр README называется `help` — отделённое
 * пробелом значение было бы не отличить от него.
 */
function chooseSet(args: string[]): FrameSet {
	const flag = args.find((argument) => argument.startsWith('--set='));
	const key = flag === undefined ? 'readme' : flag.slice('--set='.length);
	const set = SETS[key];

	if (set === undefined) {
		throw new Error(`Набора кадров «${key}» нет. Есть: ${Object.keys(SETS).join(', ')}`);
	}

	return set;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const set = chooseSet(args);

	if (args.includes('--list')) {
		for (const shot of set.shots) {
			console.log(
				`${shot.name.padEnd(26)} ${shot.role.padEnd(10)} ${shot.path}  — ${shot.caption}`
			);
		}

		return;
	}

	const names = args.filter((argument) => !argument.startsWith('--'));
	const selected =
		names.length === 0 ? set.shots : set.shots.filter((shot) => names.includes(shot.name));
	const unknown = names.filter((name) => !set.shots.some((shot) => shot.name === name));

	if (unknown.length > 0) {
		throw new Error(`Кадров с такими именами нет: ${unknown.join(', ')}. Список — «--list»`);
	}

	await mkdir(set.output, { recursive: true });

	const browser = await chromium.launch();
	const contexts = await sessions(
		browser,
		new Set(selected.filter((shot) => !needsOwnSession(shot)).map((shot) => shot.role)),
		set.viewport
	);

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
			let own: BrowserContext | null = null;

			try {
				own = needsOwnSession(shot) ? await ownSession(browser, shot, set.viewport) : null;

				const context = own ?? contexts.get(shot.role);

				if (context === undefined) {
					throw new Error(`Сессия роли «${shot.role}» не открыта`);
				}

				const file = await capture(context, shot, set);
				const { size } = await stat(file);

				console.log(`${shot.name}: ${file} — ${Math.round(size / 1024)} КиБ`);
			} catch (failure) {
				const reason = failure instanceof Error ? failure.message.split('\n')[0] : String(failure);

				failures.push({ name: shot.name, reason });
				console.error(`${shot.name}: не снят — ${reason}`);
			} finally {
				await own?.close();
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
