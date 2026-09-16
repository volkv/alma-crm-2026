# Разработка

## Документация

| Файл                                 | Что внутри                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md) | Карта: путь запроса, модули, владельцы таблиц, транзакции, где что искать   |
| [`data-model.md`](data-model.md)     | Схема базы, контракты, как звать сервисы, ошибки и права                    |
| [`auth.md`](auth.md)                 | Пароли, сессии, защита маршрутов, блокировка перебора, демо-режим           |
| [`directory.md`](directory.md)       | Справочники: организации, площадки, люди, программы, продукты               |
| [`stages.md`](stages.md)             | Маршруты и стадии взаимодействия: команды движка, готовность перехода       |
| [`documents.md`](documents.md)       | Хранилище файлов, шаблоны, генерация, загрузка, скачивание                  |
| [`stats.md`](stats.md)               | Данные об обучении: снимки импорта, сопоставление колонок, показатели       |
| [`admin.md`](admin.md)               | Журнал действий с выгрузкой и разделы настроек                              |
| [`api.md`](api.md)                   | Публичный API: ключи, лимиты, идемпотентность, как добавить эндпоинт        |
| [`integrations.md`](integrations.md) | Вебхуки, обмен с системой обучения, приём заявок с сайта                    |
| [`seeds.md`](seeds.md)               | Начальные данные: каталог прав, учётные записи, демонстрационный справочник |
| [`deployment.md`](deployment.md)     | Развёртывание на сервере, конфигурация, обновление, резервные копии         |

Этот файл — про то, как работать с репозиторием: окружение, команды, устройство каталогов и те
места, где проект расходится с привычками (Svelte 5, Tailwind 4, Zod 4).

## Окружение

- **Node.js 24** — версия в `.nvmrc`, `engines.node` в `package.json`, `.npmrc` с `engine-strict=true`.
  С nvm: `nvm use`.
- **pnpm 10.26.2** — зафиксирован в `packageManager`, включается через `corepack enable`.
- **Docker** — нужен для интеграционных и e2e-тестов и для локальной инфраструктуры.

Конфигурация читается из переменных окружения, шаблон — `.env.example`. Значения в нём уже совпадают
с `docker-compose.yml`, так что `cp .env.example .env` достаточно для локального запуска.

## Скрипты

| Скрипт                      | Что делает                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                  | Dev-сервер Vite на http://localhost:5173 с HMR                                                               |
| `pnpm build`                | Production-сборка в `build/` (adapter-node)                                                                  |
| `pnpm preview`              | Просмотр production-сборки через Vite                                                                        |
| `pnpm run check`            | `svelte-check` — типы в `.ts` и `.svelte`                                                                    |
| `pnpm run lint`             | ESLint + проверка форматирования Prettier                                                                    |
| `pnpm run format`           | Форматирование всего репозитория                                                                             |
| `pnpm run test:unit`        | Модульные тесты (`tests/unit`), Vitest, без внешних сервисов                                                 |
| `pnpm run test:integration` | Интеграционные тесты: PostgreSQL и Redis — в testcontainers, `gotenberg` из compose, `pdftotext` — в системе |
| `pnpm run test:e2e`         | Поднимает `postgres`, `redis` и `gotenberg` в compose и гоняет Playwright по `e2e/`                          |
| `pnpm run db:generate`      | Генерирует SQL-миграцию по изменениям схемы в `drizzle/`                                                     |
| `pnpm run db:migrate`       | Применяет миграции из `drizzle/` к базе из `DATABASE_URL`                                                    |
| `pnpm run db:studio`        | Drizzle Studio — браузер по данным                                                                           |
| `pnpm run check:audit`      | `pnpm audit --prod --audit-level=high` — уязвимости в том, что едет в образ                                  |
| `pnpm run check:docker`     | `docker build .` — образ должен собираться                                                                   |
| `pnpm run check:fast`       | Быстрый круг: lint → check → unit; без Docker и без сборки                                                   |
| `pnpm run check:all`        | Полный гейт: audit → lint → check → unit → integration → build → e2e → образ                                 |

`check:fast` гоняем в цикле правки, `check:all` — перед тем, как считать работу законченной.
`check:all` — это и есть CI: задача workflow не делает ничего сверх него, поэтому зелёный
`check:all` у себя значит зелёный CI.

## Структура каталогов

```
src/
  app.html                     каркас документа, lang="ru"
  app.css                      Tailwind 4: @import и @theme с токенами
  hooks.server.ts              init (валидация конфигурации) и sequence из хуков
  app.d.ts                     App.Locals и App.Error
  lib/
    nav.ts                     разделы главной навигации
    format.ts                  даты, числа, склонение, инициалы
    utils.ts                   cn() и служебные типы shadcn-svelte
    components/ui/             примитивы shadcn-svelte, вендорятся в репозиторий
    components/                составные компоненты продукта (см. «Дизайн-система»)
      app-shell/               навигация, верхняя панель, палитра поиска
      data-table/              список: состояние в query string
      form/                    поля и кнопки формы поверх superforms
    server/                    код, который никогда не попадает в браузер
      config.ts                схема переменных окружения (Zod) и getConfig()
      redis.ts                 клиент ioredis и pingRedis()
      auth/types.ts            SessionUser
      api/types.ts             ApiKeyContext
      hooks/                   по файлу на аспект запроса, см. «Хуки»
      db/
        index.ts               postgres.js + Drizzle, pingDatabase()
        schema/index.ts        реэкспорт всех таблиц схемы
  routes/
    +layout.svelte             корневой layout: app.css и отметка о гидратации
    (app)/                     всё, что живёт внутри оболочки приложения
      +layout.server.ts        locals.user для оболочки
      +layout.svelte           AppShell
      +page.svelte             главная
      ui-kit/                  витрина компонентов
    api/health/+server.ts      GET /api/health
drizzle/                       SQL-миграции и журнал drizzle-kit
scripts/migrate.ts             применение миграций (локально и в контейнере)
tests/unit/                    модульные тесты
tests/integration/             тесты с реальными PostgreSQL и Redis в testcontainers
e2e/                           Playwright
static/                        файлы, отдаваемые как есть
```

## Конфигурация проекта

`svelte.config.js` в проекте нет: начиная с SvelteKit 2.63 настройки Kit передаются прямо в плагин
`sveltekit()` внутри `vite.config.ts` — там же адаптер, принудительный runes-режим, `version.name`
(его отдаёт `/api/health`), `csp` и список дополнительных файлов для tsconfig. Это единственное
место с настройками Kit: `svelte-check` (4.7+) и Vite читают их отсюда, заводить второй файл не надо.

`kit.csp` описывает Content-Security-Policy: всё грузится только со своего origin, `mode: 'auto'`
проставляет хэши и nonce скриптам и стилям, которые Kit вставляет сам. Директиву расширяют вместе с
фичей, которой она понадобилась, а не заранее. Остальные security-заголовки ставит хук
`security-headers` — они не часть CSP.

`vite.config.ts` также описывает два проекта Vitest — `unit` и `integration`. Поэтому
`pnpm run test:unit` и `pnpm run test:integration` — это один Vitest с `--project`.

## Шпаргалка

Места, где проект расходится с тем, что подскажут статьи и память: почти везде стоят мажорные
версии, в которых привычный синтаксис уже не работает.

### Svelte 5: runes

Проект собирается в runes-режиме принудительно (`compilerOptions.runes` в `vite.config.ts`), поэтому
синтаксис Svelte 4 не просто нежелателен — он не скомпилируется.

```svelte
<script lang="ts">
	// Свойства компонента: одна деструктуризация вместо нескольких export let.
	let { title, items = [], onselect }: Props = $props();

	// Реактивное состояние.
	let query = $state('');

	// Производное значение вместо `$:`.
	let filtered = $derived(items.filter((item) => item.name.includes(query)));

	// Побочные эффекты вместо `$:` со side effects; выполняется в браузере.
	$effect(() => {
		document.title = `${title} (${filtered.length})`;
	});
</script>

<input bind:value={query} />
<!-- Обработчики — обычные атрибуты, без двоеточия. -->
<button onclick={() => onselect?.(filtered[0])}>Выбрать</button>
```

Чем это отличается от Svelte 4:

| Svelte 4                     | Svelte 5 runes                                         |
| ---------------------------- | ------------------------------------------------------ |
| `export let value`           | `let { value } = $props()`                             |
| `let count = 0` (реактивно)  | `let count = $state(0)`                                |
| `$: doubled = count * 2`     | `let doubled = $derived(count * 2)`                    |
| `$: console.log(count)`      | `$effect(() => console.log(count))`                    |
| `on:click={fn}`              | `onclick={fn}`                                         |
| `<slot />`                   | `{@render children()}` + `let { children } = $props()` |
| `<slot name="row" {item} />` | сниппет: `{@render row(item)}`                         |
| `createEventDispatcher()`    | колбэк в пропсах: `onselect?.(item)`                   |

Сниппеты вместо слотов:

```svelte
<!-- Определение и вызов внутри одного компонента -->
{#snippet row(item: Item)}
	<tr><td>{item.name}</td></tr>
{/snippet}

<table>
	{#each items as item (item.id)}
		{@render row(item)}
	{/each}
</table>
```

Реактивное состояние вне компонентов живёт в файлах `*.svelte.ts` — только там работают руны.

### Tailwind 4

`tailwind.config.js` нет и не будет: Tailwind 4 настраивается в CSS. Точка входа — `src/app.css`:

```css
@import 'tailwindcss';

@theme {
	--color-brand-500: oklch(0.55 0.18 258);
	--font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
}
```

Каждая переменная в `@theme` порождает утилиты (`--color-brand-500` → `bg-brand-500`,
`text-brand-500`, `border-brand-500`). Плагин подключён в `vite.config.ts` как `@tailwindcss/vite`,
отдельного PostCSS-конфига нет. Prettier сортирует классы по `tailwindStylesheet: './src/app.css'`.

Блок `<style>` внутри компонента про `@theme` ничего не знает: это отдельный файл для Tailwind, и
`@apply` там падает с «Cannot apply unknown utility class». Лечится импортом таблицы токенов:

```svelte
<style>
	@reference "../app.css";

	.card {
		@apply rounded-lg border p-4;
	}
</style>
```

Обычно проще обойтись без `@apply` — писать утилиты прямо в `class`.

### Zod 4

```ts
const schema = z.object({
	email: z.email(), // не z.string().email() — тот помечен deprecated
	site: z.url(),
	role: z.enum(['admin', 'manager']),
	// Сообщение об ошибке — параметр `error`; `message`, `required_error` и `errorMap` из Zod 3 больше нет.
	title: z.string({ error: 'Укажите название' }).min(1, { error: 'Название не может быть пустым' }),
	// У z.record теперь два обязательных аргумента: тип ключа и тип значения.
	counters: z.record(z.string(), z.number())
});

type Input = z.input<typeof schema>; // до преобразований (например, до coerce)
type Output = z.output<typeof schema>; // после; z.infer — синоним z.output
```

Ошибки разбираем функциями, а не методами: `z.treeifyError(err)` вместо `err.format()`,
`z.flattenError(err)` вместо `err.flatten()`, `z.prettifyError(err)` — для текста в лог.

### Формы: superforms

Адаптер для Zod 4 лежит отдельно от адаптера для Zod 3 — берём `zod4`, иначе схема не соберётся:

```ts
// +page.server.ts
import { superValidate } from 'sveltekit-superforms';
import { zod4 } from 'sveltekit-superforms/adapters';

export const load = async () => ({ form: await superValidate(zod4(schema)) });
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
	import { superForm } from 'sveltekit-superforms';
	import { zod4Client } from 'sveltekit-superforms/adapters';

	let { data } = $props();
	const { form, errors, enhance } = superForm(data.form, { validators: zod4Client(schema) });
</script>
```

### Таблицы: TanStack Table

Стоит v9 (`@tanstack/svelte-table`) — именно её документирует data-table в shadcn-svelte. Примеры
для v8 не подойдут: адаптер для Svelte 5 стал рунным (ни сторов, ни `$table`), нужные возможности
объявляются через `tableFeatures` — что не объявлено, то вырезается из бандла, — а колонки строит
`createColumnHelper`.

```svelte
<script lang="ts" generics="TData extends RowData">
	import { createTable, FlexRender, type ColumnDef, type RowData } from '@tanstack/svelte-table';
	import { features, type DataTableFeatures } from './features';

	let { data, columns }: { data: TData[]; columns: ColumnDef<DataTableFeatures, TData>[] } =
		$props();

	// Геттер, а не значение: так таблица видит новые данные без пересоздания.
	const table = createTable({
		features,
		get data() {
			return data;
		},
		columns
	});
</script>
```

Разметку берём у `Table.*` из `$lib/components/ui/table`, ячейки рисует `<FlexRender {cell} />`;
компонент в ячейке — `renderComponent(Comp, props)`, кусок разметки — `renderSnippet`.

### Хуки: sequence

`src/hooks.server.ts` не содержит логики — только порядок аспектов:

```ts
export const handle = sequence(requestId, securityHeaders, csrf, session, guard, rateLimit);
```

Каждый аспект — отдельный файл в `src/lib/server/hooks/`. Хуки вложены друг в друга: то, что до
`await resolve(event)`, выполняется сверху вниз (так `requestId` кладёт `locals.requestId` раньше
всех), то, что после — снизу вверх (поэтому `securityHeaders` уже видит `locals.user`, который
проставил `session`). Новый сквозной аспект — новый файл и новая позиция в этом списке, а не `if`
внутри существующего хука и не код в `+layout.server.ts`.

Проверку происхождения формы (CSRF) делает наш хук `csrf`, а не SvelteKit: встроенная отвечает
английской фразой фреймворка, которую нельзя ни перевести, ни дополнить, — на русском экране это
единственное место, которое говорит не по-русски и не подсказывает, что делать. Поэтому в
`vite.config.ts` стоит `csrf: { trustedOrigins: ['*'] }` — это значит «фреймворк не проверяет», а не
«проверки нет»: правило (для `POST`/`PUT`/`PATCH`/`DELETE` с телом формы `Origin` обязан совпадать с
`ORIGIN`) целиком лежит в `src/lib/server/hooks/csrf.ts` и закрыто `tests/unit/hooks/csrf.test.ts`.
Хук стоит перед `session`: подделанную форму отвергают раньше, чем ищут сессию за ней.

Хук, который решил не пускать запрос дальше, **бросает** `redirect(303, …)`, а не возвращает
готовый `Response`. У перенаправления три разных вида, и выбирает между ними SvelteKit: заголовок
`location` для обычной навигации, конверт JSON для запроса данных клиентского маршрутизатора и ещё
один — для формы, отправленной через `use:enhance`. Готовый `Response` такого разбора не проходит:
форма на странице с погасшей сессией получила бы в ответ разметку страницы входа вместо JSON и
сломалась бы на его разборе. Отложенные в `event.cookies` SvelteKit дописывает и к брошенному
перенаправлению, поэтому сброс мёртвой сессионной cookie в `session` — обычный
`clearSessionCookie(event.cookies)` до `resolve`.

Плата за это — заголовки: ответ на брошенное перенаправление собирается за пределами цепочки хуков,
и ни `x-request-id`, ни заголовки безопасности на него не попадают. Приделать их там нечему —
брошенное перенаправление это не ответ, а пара «код и адрес», — и на редирект без тела они ничего
не защищают: следующий же запрос идёт через всю цепочку и получает и то и другое.

### Ошибки: страница вместо пятисотой

| Где                               | Чем                                           |
| --------------------------------- | --------------------------------------------- |
| таблица статусов                  | `statusForError` в `src/lib/server/errors.ts` |
| действие формы                    | `toActionFailure` в `src/lib/server/http.ts`  |
| загрузчик и `+server.ts` оболочки | `toPageError` там же                          |
| публичный API                     | `apiHandler` — та же таблица, конверт JSON    |
| непредвиденное                    | `handleError` в `src/hooks.server.ts`         |

Показывает результат `+error.svelte`: в корне — для того, что случилось до оболочки (несуществующий
адрес, страницы входа), в `(app)` — внутри оболочки, чтобы отказ на один раздел не выбрасывал
человека из системы. Обе рисуют `$lib/components/error-page.svelte`: код ответа, фраза сервера и
код обращения (`requestId`). У ожидаемого отказа тело пишет `error()`, поэтому `requestId` кладёт в
данные корневой `+layout.server.ts` — до `handleError` такой отказ не доходит. Заголовок страницы
ошибки — наш («Страница не найдена», «Доступ закрыт»), и фраза сервера показывается только если
добавляет к нему что-то новое: на 404 обе строки совпадают дословно, и человек получал одно и то же
дважды.

**Известное ограничение.** Адрес с идентификатором не того вида (`/organizations/abc`) не доходит ни
до одного маршрута: его отбрасывает matcher `uuid` (`src/params/uuid.ts`) — раньше, чем начинается
`(app)`, — и 404 рисует корневая страница ошибки, без разделов и меню. Внутри оболочки это
показывалось бы, если бы идентификатор проверял загрузчик (`error(404, …)` в `+page.server.ts`), а
каталоги назывались `[id]` вместо `[id=uuid]`. Переименование идёт поперёк всех разделов сразу
(около сорока файлов, включая `resolve()` в чужих модулях и тесты), поэтому сделано не было; цена
ошибки при этом — не поломка, а «вышел из системы» вместо «нет такой записи».

### Куда класть зависимость

Vite отдаёт наружу (`external`) то, что лежит в `dependencies`, и вшивает в сборку всё остальное, а
в продовый образ (`pnpm install --prod`) попадают только `dependencies`. Отсюда правило:

- серверная библиотека, которая должна быть в образе как есть — нативные модули (`@node-rs/argon2`),
  пакеты со своими файлами и динамическими `require` (`exceljs`, `docxtemplater`, `swagger-ui-dist`), —
  идёт в `dependencies`;
- всё, что нужно только на сборку, и все Svelte-библиотеки (их всё равно компилирует Vite) —
  в `devDependencies`.

## Дизайн-система

Интерфейс собран из трёх слоёв. Токены в `src/app.css` задают язык (цвет, плотность, радиусы,
тени). Примитивы в `src/lib/components/ui/**` — вендоренный shadcn-svelte, переписанный под эти
токены. Составные компоненты в `src/lib/components/**` — то, из чего собирается страница продукта.
Витрина всего этого — `/ui-kit`, и она же первое место, куда стоит заглянуть.

### Токены

Tailwind 4 настраивается в CSS, `tailwind.config.js` нет. В `src/app.css` сначала идёт сырая
палитра обычными custom properties (`--grey-*`, `--accent-*`, статусные оттенки), затем блок
`@theme`, который раскладывает её по семантическим именам. Утилиты порождает именно `@theme`:
`--color-surface` даёт `bg-surface`, `text-surface`, `border-surface`.

| Группа      | Имена                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Поверхности | `canvas` (фон приложения), `surface` (панели, карточки), `surface-muted` (шапка таблицы, наведение) |
| Текст       | `foreground`, `muted-foreground`, `faint` — все три дают ≥ 4.5:1 на `surface`                       |
| Линии       | `border`, `border-strong`                                                                           |
| Акцент      | `primary`, `primary-hover`, `primary-foreground`, `primary-soft`, `primary-soft-border`             |
| Статусы     | `success`, `warning`, `danger`, `info` — у каждого `*-soft` и `*-soft-foreground`                   |
| Плотность   | `h-row` (36px, строка таблицы), `h-control` (32px, контрол)                                         |
| Радиусы     | `rounded-sm` / `rounded-md` / `rounded-lg`, `rounded-xl` для карточек, `rounded-4xl` — пилюля       |
| Тени        | две ступени: `shadow-xs`/`shadow-sm` — на холсте, `shadow-md`/`shadow-lg` — поверх страницы         |

Правила, по которым это держится:

- **Цвет в разметке — только через токен.** `bg-blue-500`, `text-slate-600` и `#hex` в компонентах
  недопустимы: тогда тему нельзя поменять, не переписав компоненты. Нужен новый оттенок — он
  добавляется в `@theme` с именем, объясняющим смысл, а не вид.
- **Имена `background`, `card`, `popover`, `accent`, `muted`, `input`, `destructive`** оставлены
  ради вендоренных примитивов и являются псевдонимами той же шкалы. `accent` там — нейтральная
  подсветка при наведении; фирменный акцент называется `primary`.
- **Базовый размер текста — 14px** (`text-sm` на `body`), 12px (`text-xs`) — для подписей,
  20px (`text-xl`) — для `<h1>`. Шрифт — Inter Variable из `@fontsource-variable/inter`, лежит в
  сборке, в сеть за ним никто не ходит. Цифры везде моноширинные (`font-variant-numeric:
tabular-nums`): колонки чисел и дат должны выравниваться сами.
- **Фокус с клавиатуры виден всегда.** У примитивов это `focus-visible:ring-3 ring-ring/50`, у
  наших компонентов — утилита `focus-ring` из `src/app.css`. Убирать `outline` без замены нельзя.
- **Тёмная тема** пока не включена, но заложена: ни один компонент не называет цвет напрямую.
  Чтобы её добавить, нужно определить те же токены в блоке `.dark { … }` и вешать класс `dark` на
  `<html>`. Вариант `@custom-variant dark` в `app.css` удалять нельзя: без него `dark:`-утилиты
  внутри примитивов начнут срабатывать по системной теме пользователя поверх светлой палитры.

### Добавить примитив shadcn-svelte

```bash
pnpm dlx shadcn-svelte@1.6.1 add <название>
```

CLI кладёт файлы в `src/lib/components/ui/<название>/` — и заодно правит `package.json` под свой
реестр. После команды обязательно `git diff package.json pnpm-lock.yaml` и откатить всё, кроме
самих новых файлов: версии зависимостей в проекте зафиксированы осознанно.

Дальше компонент — наш код, а не библиотека: его правят напрямую. Что проверить сразу после
установки: высота контролов (`h-control`), радиусы и кольцо фокуса — из токенов; дефолтная палитра
shadcn (`oklch(0.205 0 0)` и подобное) в файле не осталась.

### Составные компоненты

У каждого — JSDoc над `$props()` с описанием, когда его брать. Коротко:

- `app-shell/AppShell` — оболочка приложения: разделы из `src/lib/nav.ts`, сворачиваемая
  навигация (выбор хранится в `localStorage`), поиск по `Ctrl+K`, меню пользователя, выход
  POST-формой на `/logout`. На узком экране навигация уезжает в `Sheet`.
- `StageTimeline` — цикл взаимодействия по этапам: `done` / `current` / `paused` / `overdue` /
  `blocked` / `skipped` / `pending`. Полный режим — для карточки, `compact` — полоска для списка.
  Данные приходят типизированным пропом, запросов компонент не делает.
- `PageHeader` (владеет `<h1>` страницы), `EmptyState`, `ErrorState`, `ConfirmDialog`,
  `KeyValue` + `KeyValueRow`, `StatusBadge`, `SlaChip`, `InlineHint`.
- Тосты — `Toaster` из `ui/sonner`, он уже стоит в `AppShell`; со страницы вызывается
  `toast(...)` из `svelte-sonner`.

### Действие, которого сейчас нельзя

Недоступную команду не прячем: кнопка с написанной рядом причиной объясняет процесс, отсутствие
кнопки не объясняет ничего. Но **первичный вид (`variant="default"`) — только у того, что
действительно можно нажать**: выключенная кнопка остаётся заливкой на `opacity-50` и перетягивает
внимание с доступного действия, а панель «что могу сейчас» тогда сообщает ровно обратное тому, за
чем её открыли. Значит, `disabled` и `variant` меняются вместе:

```svelte
<Button variant={option.allowed ? 'default' : 'outline'} disabled={!option.allowed}>
	{label}
</Button>
{#if !option.allowed}
	<p class="text-xs text-muted-foreground">{option.reasons[0]}</p>
{/if}
```

Причина отказа — словами и рядом с кнопкой, а не только в `title`: подсказку мыши не видно с
клавиатуры и на телефоне. Приговор выносит сервер (`evaluateTransition`), интерфейс его
показывает — второго свода правил на клиенте нет.

### Всплывающие слои

Диалоги, меню, поповеры, панели и подсказки — это примитивы bits-ui. Сами они не рисуют ничего:
разметку даёт `src/lib/components/ui/**`, а поведение — контекст, портал и CSS из двух импортов в
`src/app.css`. Все четыре правила ниже ломаются тихо: сборка проходит, в консоли пусто, а слой
просто не появляется.

- **Заголовок группы — только внутри `Group`.** `DropdownMenu.GroupHeading` (и `Select`,
  `Command` — так же) читает контекст, который заводит `DropdownMenu.Group`. Без него bits-ui
  бросает `Context "Menu.Group | Menu.RadioGroup" not found`, и пропадает не заголовок, а всё
  меню целиком. Нужен заголовок — вокруг него и его пунктов ставится `Group`.
- **Портал уже внутри.** `Dialog.Content`, `AlertDialog.Content`, `DropdownMenu.Content`,
  `Popover.Content` и `Sheet.Content` сами оборачиваются в свой `Portal` и уносят разметку в конец
  `<body>`. Второй `Portal` снаружи не нужен; выносить `Content` из его `Root` нельзя — связь идёт
  по контексту, а не по DOM.
- **Анимацию слоёв держат два импорта `src/app.css`.** `tw-animate-css` даёт `animate-in`,
  `fade-in-0`, `zoom-in-95` и кадры `enter`/`exit`; `shadcn-svelte/tailwind.css` — варианты
  `data-open:` и `data-closed:`, которые разворачиваются в `[data-state="open"]` и
  `[data-state="closed"]` (именно эти атрибуты ставит bits-ui). Убрать любой из импортов — и слой
  либо навсегда останется прозрачным, либо появится рывком. Отсюда же следствие для проверок:
  **слой открывается из `opacity: 0` и доходит до полной видимости за ~100 мс**, поэтому снимок
  экрана или `getByRole(...)` сразу после клика показывает пустоту. Ждать нужно состояния
  (`expect(...).toBeVisible()`, `waitFor`), а не читать DOM в том же кадре.
- **Открывает слой только ожившая страница.** Триггеры (`onclick`, `DropdownMenu.Trigger`) живут в
  клиентском коде: нажатие до гидратации не доходит до компонента и теряется совсем — второго
  шанса нет, слой не откроется и потом. В тестах это лечится повтором нажатия
  (`expect(async () => { … }).toPass()`), как сделано в `e2e/auth.test.ts`, а не фиксированной
  паузой.

Правило то же и для всего остального, что делает страница своим кодом, — сортировки, страниц,
горячих клавиш, полей со своим значением (`DateField`), форм с `use:enhance`. Выбор между двумя
приёмами такой.

**Повтор (`toPass`)** — когда действие можно безопасно повторить и есть по чему понять, что оно
дошло: поменялся адрес, открылся слой, переехал фокус. Обязательных условий два: проверка результата
стоит внутри блока, и действие выполняется только тогда, когда результата ещё нет. Повтор вхолостую
закрыл бы уже открытый слой, отсортировал бы список обратно и увёл бы страницу дальше, чем просили.

**Ожидание (`waitForHydration` из `e2e/helpers/hydration.ts`)** — когда повторять нечего или нечем:

- форма без `use:enhance` уже ушла обычным POST-ом на `?/action`, страница сменилась, и повторять
  на ней нечего;
- текст набран в поле, значение которого держит компонент: в разметке он остался, в данные формы
  не попал, и второй `fill` в уже ожившую страницу ничего не исправит — исправит только первый;
- действие одноразовое по смыслу: переход по ссылке, отправка, подтверждение.

Признак «страница ожила» ставит корневой layout — `data-hydrated` на `<body>` после монтирования.
`networkidle` и фиксированная пауза не годятся ни там, ни там: первое знает только про загрузку
файлов и ничего — про то, смонтировано ли приложение, второе закладывается на скорость машины,
которая под шестнадцатью рабочими процессами бывает какой угодно.

Слои живут на `z-50` — это верхний этаж продукта. Шапка, боковая навигация и липкие строки таблиц
обязаны оставаться ниже (`z-30` и меньше), иначе диалог окажется под ними.

### Списки: `DataTable`

Состояние списка живёт в query string: `page`, `size`, `sort` (`name` — по возрастанию, `-name` —
по убыванию), `q`. Значит, список — это ссылка: её можно послать коллеге, она переживает «назад» и
её же читает сервер. Разбирает и собирает эти параметры один модуль,
`src/lib/components/data-table/query.ts`, и пользуются им обе стороны.

Компонент ничего не загружает: сервер отдаёт одну страницу и общее число строк.

```ts
// +page.server.ts
import { readTableQuery } from '$lib/components/data-table/query';

export const load: PageServerLoad = async ({ url }) => {
	const query = readTableQuery(url);

	return { rows: await listOrganizations(query), total: await countOrganizations(query) };
};
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
	import DataTable from '$lib/components/data-table/data-table.svelte';
	import type { DataTableFeatures } from '$lib/components/data-table/features';
	import type { ColumnDef } from '@tanstack/svelte-table';

	let { data }: PageProps = $props();

	const columns: ColumnDef<DataTableFeatures, Organization>[] = [
		{ accessorKey: 'name', header: 'Название', meta: { title: 'Название' } },
		// `align: 'end'` выравнивает колонку вправо — для всего числового.
		{ accessorKey: 'contacts', header: 'Контакты', meta: { title: 'Контакты', align: 'end' } }
	];
</script>

<DataTable
	{columns}
	rows={data.rows}
	total={data.total}
	getRowId={(organization) => organization.id}
	searchPlaceholder="Поиск по названию"
	onopen={(organization) => goto(resolve('/organizations/[id]', { id: organization.id }))}
/>
```

Что уже внутри: липкая шапка, выбор строк с панелью массовых действий (появляется, если передан
сниппет `bulkActions`), переключение колонок, пустое состояние, скелет на `loading`, клавиатура
(`↑`/`↓` или `j`/`k` — по строкам, `Enter` — открыть, `/` — в поиск), горизонтальная прокрутка на
узком экране. Набор возможностей TanStack объявлен в `data-table/features.ts` — что не объявлено,
того в сборке нет.

Широкий список на ноутбуке подрезается справа, и подрезанная колонка врёт о данных сильнее, чем
честно спрятанная. Поэтому у таблицы есть `initialHiddenColumns`: перечисленные в нём колонки
стартуют скрытыми, пока окно уже 1440px. Это только старт — меню «Колонки» сильнее ширины окна, и
после первого показа видимостью распоряжается человек, а не поворот экрана.

Порядок строк считает сервер, и у любой сортировки списка последним ключом идёт идентификатор:
без него строки с одинаковым значением ключа (одна и та же дата активности — обычное дело)
Postgres волен вернуть в любом порядке, и запись с границы страниц покажется дважды или не
покажется вовсе.

### Один контрол на задачу

У каждой задачи ввода в продукте **ровно один** контрол, и он собран нами, а не браузером. Правило
не про красоту: нативные `<select>`, `<input type="date">` и `<input type="file">` рисует браузер —
своими надписями по-английски, своим порядком полей даты (`mm/dd/yyyy` на машине с американскими
настройками) и своим выпадающим списком, не похожим ни на один всплывающий слой продукта. Рядом на
одном экране это читается как два разных интерфейса.

| Задача                    | Чем                                                                     | Чего в разметке быть не должно     |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| выбор из закрытого списка | `FieldSelect` в форме, `FilterSelect` над списком, `Select.*` в диалоге | `<select>`                         |
| календарный день          | `FieldDate` в форме, `DateField` вне её                                 | `<input type="date">`              |
| файл                      | `FileInput`                                                             | `<input type="file">`              |
| строка, число, почта      | `FieldInput` / `Input`                                                  | голый `<input>` со своими классами |
| длинный текст             | `FieldTextarea` / `Textarea`                                            | голый `<textarea>`                 |

`FieldInput` принимает только закрытый список видов ввода (`text`, `email`, `tel`, `url`, `search`,
`number`, `password`), поэтому вернуть нативный контрол незаметно нельзя. Именно список, а не
`Exclude<HTMLInputTypeAttribute, …>`: тип атрибута из `svelte/elements` кончается на `(string & {})`
ради подсказок редактора, и вычитание из него ничего не запрещает — `date` и `file` проезжали в
такой тип как обычные строки. Проверка на весь продукт:
`grep -rn "<select\|type=\"date\"" src` — совпадать должны только комментарии, которые объясняют
это правило.

`DateField` — поле ввода плюс `Popover` с `Calendar` (bits-ui). Человек видит и пишет `12.09.2026`,
может набрать дату с клавиатуры, выбрать её в календаре или очистить крестиком; наружу поле отдаёт
`2026-09-12` — вид, в котором дату хранят схемы и база, — и кладёт его в форму скрытым полем.
Недописанная дата значения не имеет: пока не набран целый день, значение пустое. Границы периода
задаются `min`/`max` в том же виде (`<DateField min={plan.start} …/>`).

Календарь у нас без выпадающих списков месяца и года: в вендоренном варианте они были нативными
`<select>`, а месяц листается стрелками, и далёкую дату быстрее набрать в поле, чем искать в списке
из ста лет.

### Формы

`sveltekit-superforms` с адаптером `zod4`, схема одна на сервер и на браузер. Поля —
`FieldInput`, `FieldTextarea`, `FieldSelect`, `FieldDate`; внутри они собирают `FormField`, который
связывает подпись, описание и ошибку с контролом (`id`, `aria-describedby`, `aria-invalid`). Кнопки —
`FormActions`, он же блокирует повторную отправку. Выбор файла — `FileInput`: надписи на нативном
`<input type="file">` рисует браузер по-английски, поэтому сам инпут спрятан с экрана (но не
выключен — фокус, проверка и отправка формы работают как обычно), а видимы подпись-кнопка и имя
выбранного файла.

Значение из закрытого списка выбирается списком, а не свободным вводом: вид документа, причина
помехи, причина паузы. Сами списки — справочники в `src/lib/contracts/**` рядом со схемой
(`UPLOADED_DOCUMENT_KINDS`, `BLOCKER_REASONS`, `PAUSE_REASONS`) вместе с картой русских названий,
потому что код уезжает в базу и в журнал, а на экран выходит название. По рукописной строке
(`no-contact`, «нет контакта», `budget`) не собрать ни один отчёт.

```svelte
<script lang="ts">
	const { form, errors, enhance, submitting } = superForm(
		untrack(() => data.form),
		{
			validators: zod4Client(organizationSchema),
			// beforeNavigate внутри superforms: уйти со страницы с несохранённым вводом просто так нельзя.
			taintedMessage: 'Введённые данные не сохранены. Уйти со страницы?'
		}
	);
</script>

<!-- novalidate: проверяет схема и говорит по-русски, а не браузер на своём языке. -->
<form method="POST" use:enhance novalidate>
	<FieldInput name="name" label="Название" required bind:value={$form.name} errors={$errors.name} />
	<FormActions submitting={$submitting} submitLabel="Сохранить организацию" />
</form>
```

Сообщения об ошибках пишем словами и по делу: «Название не короче трёх символов», а не «Invalid
input». Текст ошибки — часть схемы (параметр `error` в Zod 4), чтобы сервер и браузер говорили
одно и то же.

### Форматирование значений

`src/lib/format.ts` — единственное место, где строятся даты, числа и русские словоформы:
`formatDate` (`12.09.2026`), `formatDateTime`, `formatDayAndMonth`, `formatIsoDay` (`2026-09-12` —
календарный день по Москве, вид для схем и базы), `parseRuDay` (обратно: из набранного в поле в
`2026-09-12` или `null`), `formatNumber`, `formatBytes` («2,3 МБ»), `daysUntil`, `pluralForm` /
`pluralize` («3 дня», «5 дней»), `initials`. Время считается по Москве — и у заказчика, и в тестах
результат один и тот же. Невалидная дата, нечисло и отрицательный размер бросают `RangeError`:
«Invalid Date» в таблице — это молча испорченные данные.

Своего `new Intl.DateTimeFormat(...)` в загрузчиках и компонентах быть не должно: «сегодня» по
UTC и «сегодня» по Москве — разные дни, и расходятся они ровно там, где это заметят позже всего.

## Drizzle

- Схема — `src/lib/server/db/schema/`. Каждая таблица в своём файле, `schema/index.ts` реэкспортирует все.
- Соглашение по именам: идентификаторы в TypeScript — camelCase, в PostgreSQL — snake_case
  (`casing: 'snake_case'` включён и в `drizzle.config.ts`, и в `drizzle()`).
- Цикл изменения схемы:
  1. правим файлы в `schema/`;
  2. `pnpm run db:generate` — drizzle-kit кладёт SQL в `drizzle/` и обновляет `drizzle/meta/_journal.json`;
  3. читаем сгенерированный SQL глазами, при необходимости правим руками;
  4. `pnpm run db:migrate` — применяем;
  5. коммитим и схему, и миграцию.
- `db:push` намеренно не заведён: схема едет только миграциями, чтобы состояние базы было
  воспроизводимым и в CI, и у заказчика.
- Применяет миграции `scripts/migrate.ts` (мигратор из `drizzle-orm`, а не CLI drizzle-kit) — один и
  тот же путь локально и в контейнере, где devDependencies недоступны. Контейнер запускает его перед
  стартом приложения.

## Тесты

**Модульные** (`tests/unit`) — без сети и без Docker:

```bash
pnpm run test:unit
pnpm exec vitest --project unit          # watch-режим
```

**Интеграционные** (`tests/integration`) — поднимают настоящие PostgreSQL 17 и Redis 8 через
testcontainers, применяют миграции из `drizzle/` и работают с реальными хранилищами. Контейнеры свои
на каждый файл тестов, и `reset()` из `tests/integration/helpers/db.ts` между проверками чистит и
таблицы, и Redis: прогон не зависит ни от того, что насчитал предыдущий, ни от того, что делает
соседний. Из compose остаётся один `gotenberg` — он тяжёлый, и контейнер на файл ради тестов
документов стоит дороже, чем один на машину. Нужен запущенный Docker; первый прогон тянет образы
`postgres:17-alpine` и `redis:8-alpine`.

```bash
pnpm run test:integration
```

**E2E** (`e2e`) — Playwright, только chromium. Скрипт сам поднимает `postgres`, `redis` и
`gotenberg` из compose, затем Playwright собирает приложение и запускает `node build/index.js` на
порту `E2E_PORT` (по умолчанию 4173). Переменные окружения для этого сервера заданы прямо в
`playwright.config.ts`, чтобы прогон был одинаковым на машине разработчика и в CI.

Проектов Playwright два. `chromium` гоняет всё, кроме проверки лимита входа; `login-limit` — только
её. Лимит попыток считается по адресу, а весь прогон приходит с одного, поэтому выбранный лимит
закрыл бы вход и соседним проверкам: проект идёт после обычного (`dependencies`), в один рабочий
процесс, и снимает счётчики адресов до и после каждой проверки. Отдельно, без обычного проекта:
`pnpm exec playwright test --project=login-limit --no-deps`.

Начальные данные прогона заливает глобальный сетап — тем же `scripts/seed`, что и стенд, поэтому
проверки работают с теми же вузами, взаимодействиями и учётными записями, которые увидит заказчик.
Он же один раз входит менеджером и администратором и складывает сессии в `.playwright/auth`: POST
на `/login` ограничен по адресу, и вход в каждом рабочем процессе упирался в защиту, рассчитанную
на живого человека.

```bash
pnpm exec playwright install chromium    # один раз
pnpm run test:e2e
pnpm exec playwright test --ui           # интерактивно
```

### Параллельные прогоны

Интеграционные тесты ничего общего не занимают: контейнеры у каждого прогона свои, порты им
раздаёт Docker. E2E — другое дело, и чтобы два прогона на одной машине не мешали друг другу, каждому
нужен свой порт и своя рабочая копия:

```bash
E2E_PORT=4180 pnpm run test:e2e
```

Порт задаёт не только адрес сервера, но и состояние прогона: базу `lct_e2e_<порт>` в том же
PostgreSQL из compose (её заводит глобальный сетап, если её ещё нет) и логическую базу Redis под
номером `<порт> % 16`. Без этого свободного порта не хватило бы: соседний сетап залил бы ту же базу
заново, а общий счётчик попыток входа сбрасывался бы посреди проверки лимита.

Рабочая копия нужна своя, потому что `build/`, `.playwright/`, `playwright-report/` и
`test-results/` у прогонов из одного каталога общие: второй прогон пересобрал бы приложение под
ногами у первого.

## CI

`.github/workflows/ci.yml` — одна задача на каждый push и PR. Она ставит Node из `.nvmrc`, браузер
Playwright и `poppler-utils`, после чего гоняет `pnpm run check:all` — ровно то, что гоняют у себя
перед сдачей работы. Отдельных задач под `docker build` и аудит зависимостей нет нарочно: проверка,
которой нет в `check:all`, ловилась бы только после push. При падении выгружаются
`playwright-report/` (отчёт) и `test-results/` (трассы, снимки экрана и видео упавших проверок).

## Правила, которые ломают сборку

- Ошибки не глушим: пустой `catch`, тихий fallback и значение по умолчанию вместо обязательной
  настройки — недопустимы. Конфигурация обязана падать на старте.
- Типы, линты и тесты не ослабляем ради зелёного прогона. `strict: true` — не обсуждается.
- Новая зависимость — осознанное решение: фиксированная версия и причина в описании изменения.
