# Перечень библиотек

Состав поставки: что установлено напрямую, какой версии и под какой лицензией. Требование задания
(`R2`) просит перечень библиотек — вот он. Список собран из `package.json`, версии и лицензии взяты
из `node_modules/<пакет>/package.json` на 2026-09-18.

Здесь **только прямые зависимости**: их выбирал человек и за них отвечает проект. Полное дерево со
всеми транзитивными пакетами машина читает из SBOM — см. «Полный состав» внизу.

Деление на `dependencies` и `devDependencies` в этом проекте **не совпадает** с делением
«рантайм / разработка», и это важно для чтения таблиц ниже. Серверный рантайм лежит в
`dependencies` и попадает в образ пакетами. Интерфейсный рантайм (SvelteKit, bits-ui, chart.js,
marked, superforms) лежит в `devDependencies`, но его код уезжает в образ **внутри** `build/`,
собранного Vite: пакета в `node_modules` образа нет, а его код там есть. Поэтому проверка
зависимостей читает lock-файл целиком, а не только прод-ветку ([`security.md`](security.md)).

## Среда выполнения

| Что        | Версия  | Лицензия                        | Где закреплено                                      |
| ---------- | ------- | ------------------------------- | --------------------------------------------------- |
| Node.js    | 24      | MIT                             | `.nvmrc`, `engines.node`, `node:24-alpine` в образе |
| pnpm       | 10.26.2 | MIT                             | `packageManager` в `package.json`                   |
| PostgreSQL | 17      | PostgreSQL                      | `docker-compose.yml`, образ `postgres:17-alpine`    |
| Redis      | 8       | AGPL-3.0 (сервис, не линкуется) | `docker-compose.yml`, образ `redis:8-alpine`        |
| Keycloak   | 26.7.4  | Apache-2.0                      | `docker-compose.yml`, `keycloak/realm-lct.json`     |
| Gotenberg  | 8       | MIT                             | `docker-compose.yml`, конвертация DOCX → PDF        |
| SeaweedFS  | 4.48    | Apache-2.0                      | `docker-compose.yml`, S3-хранилище файлов           |
| Mailpit    | 1.31.1  | MIT                             | `docker-compose.yml`, ловит почту стенда и прогона  |

Службы стоят рядом отдельными контейнерами и в код приложения не линкуются: с Redis, SeaweedFS и
Keycloak приложение говорит по сети своим клиентом, и их лицензия к лицензии продукта отношения не
имеет.

## Серверные библиотеки (`dependencies`)

| Пакет                            | Версия   | Лицензия        | Зачем                                                               |
| -------------------------------- | -------- | --------------- | ------------------------------------------------------------------- |
| `zod`                            | 4.6.2    | MIT             | контракты: одна схема проверяет форму, тело запроса API и OpenAPI   |
| `drizzle-orm`                    | 0.45.2   | Apache-2.0      | запросы и схема базы на TypeScript, SQL-first                       |
| `drizzle-zod`                    | 0.8.3    | Apache-2.0      | схемы Zod из таблиц Drizzle                                         |
| `postgres`                       | 3.4.9    | Unlicense       | драйвер PostgreSQL, на котором работает Drizzle                     |
| `ioredis`                        | 6.0.0    | MIT             | Redis: сессии, лимиты, очередь доставки, кэш чтений                 |
| `oauth4webapi`                   | 3.8.8    | MIT             | OIDC-вход: Authorization Code + PKCE, проверка id-токена по ключам  |
| `@aws-sdk/client-s3`             | 3.1134.0 | Apache-2.0      | S3-совместимое хранилище файлов документов (в поставке — SeaweedFS) |
| `docxtemplater`                  | 3.69.3   | MIT             | сборка DOCX по шаблону из `templates/`                              |
| `pizzip`                         | 3.2.0    | MIT или GPL-3.0 | zip-контейнер DOCX, которым пользуется `docxtemplater`              |
| `exceljs`                        | 4.4.0    | MIT             | запись книг `.xlsx`: выгрузки, списки выбора в шаблоне LMS          |
| `xlsx` (SheetJS)                 | 0.20.3   | Apache-2.0      | чтение загруженных книг и запись формата `.xls`                     |
| `nodemailer`                     | 10.0.10  | MIT-0           | отправка уведомлений по SMTP                                        |
| `@asteasolutions/zod-to-openapi` | 9.1.0    | MIT             | документ OpenAPI 3.1 из тех же схем Zod, что проверяют запросы      |
| `swagger-ui-dist`                | 5.32.15  | Apache-2.0      | Swagger UI на `/api/docs`, отдаётся с нашего же адреса              |

`xlsx` ставится не из реестра npm, а с `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` —
так распространяет свой пакет сам SheetJS начиная с версии 0.20. Адрес закреплён в `package.json`
и в lock-файле вместе с отпечатком архива.

## Интерфейс и сборка (`devDependencies`)

Код этих пакетов, кроме инструментов проверки, уезжает в образ внутри `build/`.

| Пакет                          | Версия  | Лицензия   | Зачем                                                               |
| ------------------------------ | ------- | ---------- | ------------------------------------------------------------------- |
| `svelte`                       | 5.57.0  | MIT        | компоненты в режиме runes                                           |
| `@sveltejs/kit`                | 2.70.3  | MIT        | маршруты, загрузчики, form actions, эндпоинты — каркас приложения   |
| `@sveltejs/adapter-node`       | 5.5.7   | MIT        | сборка в обычный процесс Node для контейнера                        |
| `@sveltejs/vite-plugin-svelte` | 7.3.0   | MIT        | Svelte внутри Vite                                                  |
| `vite`                         | 8.3.0   | MIT        | сборка и dev-сервер                                                 |
| `tailwindcss`                  | 4.3.3   | MIT        | стили; токены темы объявлены в `src/app.css`, без `tailwind.config` |
| `@tailwindcss/vite`            | 4.3.3   | MIT        | Tailwind 4 как плагин Vite                                          |
| `bits-ui`                      | 2.19.2  | MIT        | доступные примитивы (диалоги, меню, поповеры) под shadcn-svelte     |
| `shadcn-svelte`                | 1.6.1   | MIT        | генератор примитивов, которые вендорятся в `components/ui`          |
| `tailwind-variants`            | 3.3.1   | MIT        | варианты классов у примитивов                                       |
| `tailwind-merge`               | 3.6.0   | MIT        | слияние конфликтующих классов Tailwind                              |
| `clsx`                         | 2.1.1   | MIT        | сборка списка классов                                               |
| `tw-animate-css`               | 1.4.0   | MIT        | анимации входа и выхода всплывающих слоёв                           |
| `@lucide/svelte`               | 1.45.0  | ISC        | иконки                                                              |
| `@fontsource-variable/inter`   | 5.3.0   | OFL-1.1    | запасной шрифт, когда фирменный не смонтирован                      |
| `@tanstack/svelte-table`       | 9.2.4   | MIT        | таблицы списков: колонки, сортировка, выбор строк                   |
| `sveltekit-superforms`         | 2.30.2  | MIT        | формы поверх схем Zod: те же правила на сервере и в браузере        |
| `svelte-sonner`                | 1.2.1   | MIT        | всплывающие уведомления                                             |
| `chart.js`                     | 4.5.1   | MIT        | диаграммы отчётов и дашборда, выгрузка их в PNG                     |
| `marked`                       | 18.0.13 | MIT        | разбор Markdown встроенной справки                                  |
| `@internationalized/date`      | 3.12.4  | Apache-2.0 | календарь и разбор дат в полях ввода                                |
| `typescript`                   | 6.0.3   | Apache-2.0 | типы                                                                |
| `@types/node`                  | 24.13.4 | MIT        | типы среды Node                                                     |
| `@types/swagger-ui-dist`       | 3.30.6  | MIT        | типы Swagger UI                                                     |
| `drizzle-kit`                  | 0.31.10 | MIT        | генерация SQL-миграций по схеме; в образ не попадает                |
| `globals`                      | 17.12.0 | MIT        | словари глобальных имён для ESLint                                  |

## Проверки

Эти пакеты не попадают ни в образ, ни в `build/`.

| Пакет                         | Версия  | Лицензия   | Зачем                                                  |
| ----------------------------- | ------- | ---------- | ------------------------------------------------------ |
| `vitest`                      | 5.0.0   | MIT        | модульные и интеграционные тесты                       |
| `testcontainers`              | 12.1.0  | MIT        | настоящие PostgreSQL, Redis и SeaweedFS на время теста |
| `@testcontainers/postgresql`  | 12.1.0  | MIT        | контейнер PostgreSQL для тестов                        |
| `@testcontainers/redis`       | 12.1.0  | MIT        | контейнер Redis для тестов                             |
| `@playwright/test`            | 1.63.0  | Apache-2.0 | e2e против собранного приложения, chromium             |
| `eslint`                      | 10.10.0 | MIT        | статические правила                                    |
| `@eslint/js`                  | 10.0.1  | MIT        | базовый набор правил ESLint                            |
| `typescript-eslint`           | 8.70.0  | MIT        | правила ESLint по типам                                |
| `eslint-plugin-svelte`        | 3.23.0  | MIT        | правила ESLint для `.svelte`                           |
| `eslint-config-prettier`      | 10.1.8  | MIT        | снятие правил ESLint, спорящих с форматированием       |
| `prettier`                    | 3.9.6   | MIT        | форматирование                                         |
| `prettier-plugin-svelte`      | 4.1.1   | MIT        | форматирование `.svelte`                               |
| `prettier-plugin-tailwindcss` | 0.8.1   | MIT        | порядок классов Tailwind                               |
| `svelte-check`                | 4.7.6   | MIT        | типы внутри `.svelte`                                  |

Сканеры безопасности (`semgrep`, `trivy`) в `package.json` не ставятся вовсе: они работают
контейнерами, версии закреплены в `scripts/security-scan.sh` ([`security.md`](security.md)).

## Полный состав

Перечень выше — только прямые зависимости. Всё дерево целиком, вместе с транзитивными пакетами и
их версиями, собирается описью в формате **CycloneDX 1.7**:

```bash
pnpm run check:security
# security-report/sbom-source.cdx.json — дерево зависимостей по pnpm-lock.yaml
# security-report/sbom-image.cdx.json  — состав собранного образа
```

Как их читать и чем открывать — [`security.md`](security.md), раздел «Как читать SBOM».

## Лицензионная чистота

Прямые зависимости идут под разрешительными лицензиями: MIT, MIT-0, ISC, Apache-2.0, Unlicense,
OFL-1.1 (шрифт) и `MIT OR GPL-3.0` у `pizzip` — из двух вариантов проект пользуется MIT. Пакетов
под копилефтом (GPL, AGPL, SSPL), которые линковались бы в приложение, среди прямых зависимостей
нет. Сам продукт — под [MIT](../LICENSE).

AGPL-службы (Redis) стоят отдельными сетевыми сервисами и в код не линкуются, поэтому их
лицензия на лицензию продукта не распространяется. Полную сверку лицензий по всему дереву
зависимостей не проводили — это отдельная работа поверх SBOM.
