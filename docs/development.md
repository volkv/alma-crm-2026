# Разработка

## Окружение

- **Node.js 24** — версия в `.nvmrc`, `engines.node` в `package.json`, `.npmrc` с `engine-strict=true`.
  С nvm: `nvm use`.
- **pnpm 10.26.2** — зафиксирован в `packageManager`, включается через `corepack enable`.
- **Docker** — нужен для интеграционных и e2e-тестов и для локальной инфраструктуры.

Конфигурация читается из переменных окружения, шаблон — `.env.example`. Значения в нём уже совпадают
с `docker-compose.yml`, так что `cp .env.example .env` достаточно для локального запуска.

## Скрипты

| Скрипт                      | Что делает                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`                  | Dev-сервер Vite на http://localhost:5173 с HMR                                    |
| `pnpm build`                | Production-сборка в `build/` (adapter-node)                                       |
| `pnpm preview`              | Просмотр production-сборки через Vite                                             |
| `pnpm run check`            | `svelte-check` — типы в `.ts` и `.svelte`                                         |
| `pnpm run lint`             | ESLint + проверка форматирования Prettier                                         |
| `pnpm run format`           | Форматирование всего репозитория                                                  |
| `pnpm run test:unit`        | Модульные тесты (`tests/unit`), Vitest, без внешних сервисов                      |
| `pnpm run test:integration` | Интеграционные тесты (`tests/integration`); поднимают PostgreSQL в testcontainers |
| `pnpm run test:e2e`         | Поднимает `postgres` и `redis` в compose и гоняет Playwright по `e2e/`            |
| `pnpm run db:generate`      | Генерирует SQL-миграцию по изменениям схемы в `drizzle/`                          |
| `pnpm run db:migrate`       | Применяет миграции из `drizzle/` к базе из `DATABASE_URL`                         |
| `pnpm run db:studio`        | Drizzle Studio — браузер по данным                                                |
| `pnpm run check:fast`       | Быстрый круг: lint → check → unit; без Docker и без сборки                        |
| `pnpm run check:all`        | Полный гейт: lint → check → unit → integration → build → e2e                      |

`check:fast` гоняем в цикле правки, `check:all` — перед тем, как считать работу законченной:
то же самое гоняет CI.

## Структура каталогов

```
src/
  app.html                     каркас документа, lang="ru"
  app.css                      Tailwind 4: @import и @theme с токенами
  hooks.server.ts              init (валидация конфигурации) и sequence из хуков
  app.d.ts                     App.Locals и App.Error
  lib/
    nav.ts                     разделы главной навигации
    utils.ts                   cn() и служебные типы shadcn-svelte
    components/ui/             компоненты shadcn-svelte, вендорятся в репозиторий
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
    +layout.svelte             корневой layout
    +page.svelte               главная страница
    api/health/+server.ts      GET /api/health
drizzle/                       SQL-миграции и журнал drizzle-kit
scripts/migrate.ts             применение миграций (локально и в контейнере)
tests/unit/                    модульные тесты
tests/integration/             тесты с реальной БД в testcontainers
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
export const handle = sequence(requestId, securityHeaders, session, guard, rateLimit);
```

Каждый аспект — отдельный файл в `src/lib/server/hooks/`. Хуки вложены друг в друга: то, что до
`await resolve(event)`, выполняется сверху вниз (так `requestId` кладёт `locals.requestId` раньше
всех), то, что после — снизу вверх (поэтому `securityHeaders` уже видит `locals.user`, который
проставил `session`). Новый сквозной аспект — новый файл и новая позиция в этом списке, а не `if`
внутри существующего хука и не код в `+layout.server.ts`.

### Куда класть зависимость

Vite отдаёт наружу (`external`) то, что лежит в `dependencies`, и вшивает в сборку всё остальное, а
в продовый образ (`pnpm install --prod`) попадают только `dependencies`. Отсюда правило:

- серверная библиотека, которая должна быть в образе как есть — нативные модули (`@node-rs/argon2`),
  пакеты со своими файлами и динамическими `require` (`exceljs`, `docxtemplater`, `swagger-ui-dist`), —
  идёт в `dependencies`;
- всё, что нужно только на сборку, и все Svelte-библиотеки (их всё равно компилирует Vite) —
  в `devDependencies`.

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

**Интеграционные** (`tests/integration`) — поднимают настоящий PostgreSQL 17 через testcontainers,
применяют миграции из `drizzle/` и работают с реальной базой. Нужен запущенный Docker; первый прогон
тянет образ `postgres:17-alpine`.

```bash
pnpm run test:integration
```

**E2E** (`e2e`) — Playwright, только chromium. Скрипт сам поднимает `postgres` и `redis` из
compose, затем Playwright собирает приложение и запускает `node build/index.js` на порту 4173.
Переменные окружения для этого сервера заданы прямо в `playwright.config.ts`, чтобы прогон был
одинаковым на машине разработчика и в CI.

```bash
pnpm exec playwright install chromium    # один раз
pnpm run test:e2e
pnpm exec playwright test --ui           # интерактивно
```

## CI

`.github/workflows/ci.yml`, три задачи на каждый push и PR:

- `check` — `pnpm run check:all` на Node из `.nvmrc`, с кэшем pnpm store;
- `docker` — `docker build .`, чтобы образ не ломался незаметно;
- `audit` — `pnpm audit --prod --audit-level=high`.

## Правила, которые ломают сборку

- Ошибки не глушим: пустой `catch`, тихий fallback и значение по умолчанию вместо обязательной
  настройки — недопустимы. Конфигурация обязана падать на старте.
- Типы, линты и тесты не ослабляем ради зелёного прогона. `strict: true` — не обсуждается.
- Новая зависимость — осознанное решение: фиксированная версия и причина в описании изменения.
