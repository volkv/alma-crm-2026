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
| `pnpm run check:all`        | Полный гейт: lint → check → unit → integration → build → e2e                      |

`check:all` — единственная команда, которую нужно помнить: то же самое гоняет CI.

## Структура каталогов

```
src/
  app.html                     каркас документа, lang="ru"
  app.css                      Tailwind 4: @import и @theme с токенами
  hooks.server.ts              валидация конфигурации при старте сервера
  lib/
    server/                    код, который никогда не попадает в браузер
      config.ts                схема переменных окружения (Zod) и getConfig()
      redis.ts                 клиент ioredis и pingRedis()
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
(его отдаёт `/api/health`) и список дополнительных файлов для tsconfig.

`vite.config.ts` также описывает два проекта Vitest — `unit` и `integration`. Поэтому
`pnpm run test:unit` и `pnpm run test:integration` — это один Vitest с `--project`.

## Svelte 5: runes

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

## Tailwind 4

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
