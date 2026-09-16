# Карта архитектуры

Документ для того, кто открыл репозиторий впервые и хочет за четверть часа понять, куда приходит
запрос, кто отвечает за каждый кусок кода и где лежит правило, которое нужно поправить. Устройство
подсистем описано отдельно (`stages.md`, `documents.md`, `stats.md`, …), команды, соглашения и
шпаргалки по Svelte 5 и Tailwind 4 — в [`development.md`](development.md). Что уже сделано и что
впереди — раздел «Дорожная карта» в `README.md`.

Продукт — модульный монолит на SvelteKit: страницы, формы и публичный API живут в одном приложении
и зовут одни и те же сервисы. Слоёв три:

- **транспорт** — хуки (`src/hooks.server.ts`, `src/lib/server/hooks/`), загрузчики и form actions
  страниц (`src/routes/(app)/**`), эндпоинты `src/routes/api/v1/**`;
- **сервисы** — `src/lib/server/*`, по модулю на предметную область;
- **данные** — PostgreSQL через Drizzle (`src/lib/server/db/`), Redis (`src/lib/server/redis.ts`),
  файлы документов в `DATA_DIR` (`src/lib/server/documents/storage.ts`).

Граница между транспортом и сервисом одна и та же везде: сервис принимает `(ctx: ActorContext,
input)`, не смотрит в `locals`, не читает заголовки и не строит ответ. Он бросает ошибки из
`src/lib/server/errors.ts`, а превращает их в ответ транспорт — `toPageError`/`toActionFailure`
(`src/lib/server/http.ts`) для браузера и `apiHandler` для API.

## Путь запроса

### Хуки: что происходит с любым запросом

`src/hooks.server.ts` собирает цепочку
`sequence(requestId, securityHeaders, csrf, session, guard, rateLimit)`. Порядок значим: первый хук
в списке — внешний, он видит и запрос, и уже готовый ответ.

| Хук               | Файл (`src/lib/server/hooks/`) | Что делает                                                                              |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `requestId`       | `request-id.ts`                | `locals.requestId` = свежий UUID; ставит `x-request-id` на ответ                        |
| `securityHeaders` | `security-headers.ts`          | `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS на https, `no-store` вошедшему |
| `csrf`            | `csrf.ts`                      | форменный POST/PUT/PATCH/DELETE только со своим `Origin`, иначе 403 по-русски           |
| `session`         | `session.ts`                   | читает куку `lct_session`, продлевает запись в Redis, кладёт `locals.user`              |
| `guard`           | `guard.ts`                     | всё под `(app)` требует сессии; неполная (`mfaPending`) уходит на `/login/mfa`          |
| `rateLimit`       | `rate-limit.ts`                | POST под `(auth)` считается по адресу (`withinAddressLimit`)                            |

Четыре вещи, которые стоит знать сразу:

- **`csrf` стоит перед `session`** — запрос с чужой страницы отвергается раньше, чем будет прочитана
  сессия, которую он пытается использовать.
- **Пользователь собирается заново на каждый запрос** (`loadSessionUser` в `auth/session.ts`): в
  Redis лежит только идентификатор и признак незавершённого второго шага, а роль, права и активность
  читаются из базы. Снятое право действует немедленно.
- **Проверка прав в хуках не делается.** `guard` отвечает только на вопрос «есть ли тут кто-нибудь»;
  конкретное право спрашивают загрузчик и сервис — см. «Область доступа и права».
- **Встроенная в SvelteKit проверка Origin выключена** (`csrf.trustedOrigins: ['*']` в
  `vite.config.ts`) ровно потому, что то же правило живёт в хуке и отвечает по-русски.

Кроме цепочки в `hooks.server.ts` есть `init` (проверка конфигурации `getConfig()` и запуск таймера
интеграций, см. «Интеграции») и `handleError` — он переводит в текст отказы, которые сочинил сам
фреймворк (404, 413 от `BODY_SIZE_LIMIT`, 415), и подставляет `requestId` на страницу ошибки.

### Страница: `load` и form action

1. `src/routes/+layout.server.ts` отдаёт `requestId` — его цитирует страница ошибки.
2. `src/routes/(app)/+layout.server.ts` отдаёт `locals.user` и флаг `DEMO_MODE` оболочке
   (`AppShell`): навигация и меню учётной записи одинаковы на всех страницах.
3. `+page.server.ts` раздела строит `ctx = actorFromEvent(event)` и зовёт сервисы, обычно одной
   `Promise.all`. Предметная ошибка переводится в статус через `toPageError`.
4. Form action разбирает тело формы схемой из `src/lib/contracts/**`, зовёт команду сервиса и
   переводит отказ через `toActionFailure`.

Образец обоих шагов — `src/routes/(app)/interactions/[id=uuid]/+page.server.ts`: восемь чтений в
`load` и двадцать с лишним действий (`advance`, `pause`, `confirm`, `upload`, `generate`, …), каждое
из которых сводится к «разобрать схемой → позвать команду → вернуть отказ формы».

### Публичный API: `/api/v1`

Все эндпоинты обёрнуты в `apiHandler` (`src/lib/server/api/handler.ts`). Обёртка делает по порядку:

1. лимит по адресу (`consumeRateLimit('ip:…')`, 600 запросов в минуту);
2. разбор `Authorization: Bearer lct_…` и поиск ключа по `sha256` (`api/keys.ts`);
3. лимит по ключу (120 в минуту); в заголовках ответа — `tighter()` из двух приговоров;
4. `requirePermission(ctx, config.permission)`;
5. разбор `params`/`query`/`body` схемами Zod из конфигурации эндпоинта;
6. `Idempotency-Key`, если эндпоинт объявлен `idempotent` (`api/idempotency.ts`): бронь в Redis на
   сутки вместе с отпечатком тела — повтор с тем же телом отдаёт прежний ответ и заголовок
   `Idempotency-Replay`, с другим телом — 422;
7. вызов сервиса и **проверка ответа его собственной схемой** `config.output` (не сошёлся — 500, а
   не «почти правильный» ответ наружу);
8. `finish()` — конверт JSON, `cache-control: no-store`, заголовки лимита и запись в журнал
   (`api.request`, а для безымянных отказов — сводная `api.unauthenticated_burst` раз в минуту).

Сессия браузера в API не смотрится вовсе: иначе запрос со страницы приложения выполнялся бы от лица
пользователя без ключа, то есть был бы CSRF.

Описание API собирается из тех же схем: каждый файл маршрута зовёт `registerRoute(...)`
(`api/openapi.ts`), а `src/routes/api/openapi.json/+server.ts` загружает файлы маршрутов через
`import.meta.glob` и отдаёт документ OpenAPI 3.1. Swagger UI — `src/routes/api/docs/+server.ts`
(единственная страница раздела, которая смотрит на сессию: не вошедшего она отправляет на вход).

### Что у UI и API общее

- **`ActorContext`** (`src/lib/server/actor.ts`) — единственная сигнатура действующего лица:
  `requestId`, `source` (`ui` | `api` | `system`), `user`, `apiKeyId`, `ip`, `userAgent`, `scope`.
  Страницы и формы строят его `actorFromEvent(event)`, фоновая работа — `systemActor(requestId)`,
  а `apiHandler` собирает свой: он должен уметь отвечать и записывать журнал до того, как ключ
  вообще опознан. Контекста с `source: 'system'` из обработчика запроса не появляется никогда —
  такой проходит любую проверку права (`can`).
- **Контракты** `src/lib/contracts/*.ts` — схемы Zod команд и ответов. Они не импортируют ничего из
  `$lib/server`, поэтому одна и та же схема проверяет форму в браузере, тело запроса к API и строку
  импорта из файла.
- **Ошибки** — `ValidationError`, `ForbiddenError`, `NotFoundError`, `ConflictError` и таблица
  `code → status` в `src/lib/server/errors.ts`. Её читают и страницы, и формы, и API.

## Карта модулей `src/lib/server`

| Модуль           | Зачем                                                                        | Точки входа                                                                                  | От кого зависит                                        |
| ---------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `actor.ts`       | контекст действующего лица                                                   | `actorFromEvent`, `systemActor`, `AccessScope`                                               | —                                                      |
| `config.ts`      | схема переменных окружения, без умолчаний                                    | `getConfig`, `parseConfig`                                                                   | —                                                      |
| `errors.ts`      | предметные ошибки и статусы для них                                          | `AppError` и потомки, `statusForError`                                                       | —                                                      |
| `http.ts`        | ошибка → отказ формы или страницы                                            | `toActionFailure`, `toPageError`                                                             | `errors`                                               |
| `db/`            | пул postgres.js, Drizzle, граница транзакции                                 | `getDb`, `withTransaction`, `schema/*`                                                       | `config`                                               |
| `redis.ts`       | общий клиент ioredis                                                         | `getRedis`, `pingRedis`                                                                      | `config`                                               |
| `rbac/`          | каталог прав, роли, проверка права и области                                 | `can`, `requirePermission`, `scopeFilter`, `PERMISSIONS`, `seedRolesAndPermissions`          | `db`, `audit`                                          |
| `audit/`         | журнал действий: запись, выборка, выгрузка                                   | `recordAuditEvent`, `listAuditEvents`, `exportAuditEvents`                                   | `db`, `rbac`, `spreadsheet`                            |
| `auth/`          | сессии, вход, пароли, второй фактор, пользователи                            | `loadSessionUser`, `login`, `verifySecondFactor`, `createUser`                               | `db`, `redis`, `rbac`, `settings`, `audit`             |
| `api/`           | обёртка эндпоинта, ключи, лимиты, идемпотентность, OpenAPI                   | `apiHandler`, `registerRoute`, `authenticateApiKey`                                          | `rbac`, `audit`, `redis`, `auth/session`               |
| `settings/`      | настройки приложения со значениями по умолчанию                              | `getSetting`, `setSetting`, `SETTING_DEFAULTS`                                               | `db`, `rbac`, `audit`                                  |
| `directory/`     | организации, площадки, люди, роли, программы, продукты                       | `read.ts` (выборки), `write.ts` (команды)                                                    | `db`, `rbac`, `audit`, `people`                        |
| `people/`        | персональные данные: маскирование, согласия, срок хранения, след просмотра   | `toPersonView`, `withPiiTrace`, `recordConsent`, `anonymizePerson`                           | `db`, `rbac`, `audit`                                  |
| `stages/`        | маршруты и версии, правила перехода, команды движка, состояние стадии        | `evaluateTransition`, `advanceStage`…, `getInteractionStatus`, `readRoute`                   | `db`, `rbac`, `audit`, `interactions/access`           |
| `interactions/`  | взаимодействие: создание, список, карточка, сводка, доска, сводная картина   | `createInteraction`, `listInteractions`, `getInteractionSummary`, `getWorkOverview`          | `db`, `rbac`, `audit`, `stages`, `people`              |
| `documents/`     | хранилище файлов, проверка содержимого, шаблоны, генерация, отметки          | `stageBlob`/`promoteBlob`, `uploadDocument`, `generateDocument`, `readDocumentForDownload`   | `db`, `rbac`, `audit`, `config`, `stages/commands`     |
| `stats/`         | данные об обучении: разбор файла, сопоставление, снимки, показатели, дашборд | `createSnapshot`, `applyMapping`, `confirmSnapshot`, `getStatsDashboard`, `buildStatsReport` | `db`, `rbac`, `audit`, `documents`, `spreadsheet`      |
| `integrations/`  | вебхуки, цикл доставки, обмен с LMS, мок LMS, приём заявок                   | `runIntegrationsCycle`, `createWebhook`, `syncLms`, `receiveApplication`                     | `audit`, `redis`, `directory`, `interactions`, `stats` |
| `spreadsheet.ts` | обезвреживание формул в ячейках выгрузок                                     | `spreadsheetText`                                                                            | —                                                      |

Зависимости идут в одну сторону: `integrations` знает про `directory`, `interactions` и `stats`, а
они про `integrations` — нет. Единственная пара, замкнутая друг на друга по смыслу, —
`stages` ↔ `interactions`: команды движка спрашивают `interactionScopeFilter` из
`interactions/access.ts`, а карточка взаимодействия зовёт `stages`. Разрыв сделан файлом: `access.ts`
не зависит ни от чего из `stages`.

## Владельцы данных

Схема разложена по файлам `src/lib/server/db/schema/*.ts` и собрана барелем `schema/index.ts` —
через него её видят и `drizzle()`, и drizzle-kit.

| Файл схемы        | Таблицы                                                                                                                                                                                                                                         | Кто пишет                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `auth.ts`         | `permissions`, `roles`, `role_permissions`, `users`                                                                                                                                                                                             | `rbac/seed.ts` (каталог), `auth/users.ts`, `auth/mfa.ts`, `auth/session.ts`                                                    |
| `api.ts`          | `api_keys`                                                                                                                                                                                                                                      | `api/keys.ts`                                                                                                                  |
| `audit.ts`        | `audit_events`                                                                                                                                                                                                                                  | только `audit/index.ts`                                                                                                        |
| `settings.ts`     | `app_settings`                                                                                                                                                                                                                                  | `settings/index.ts` и `integrations/settings.ts`                                                                               |
| `directory.ts`    | `organizations`, `sites`, `people`, `consents`, `affiliations`, `programs`, `program_versions`, `products`                                                                                                                                      | `directory/write.ts`; `consents` и обезличивание `people` — `people/*`                                                         |
| `interactions.ts` | `stage_routes`, `stages`, `stage_transitions`, `interactions`, `interaction_parties`, `interaction_party_sites`, `interaction_programs`, `interaction_products`, `interaction_changes`, `stage_entries`, `stage_pauses`, `blockers`, `comments` | маршруты — `stages/routes.ts`; взаимодействие и его связи — `interactions/write.ts`; всё, что движется, — `stages/commands.ts` |
| `documents.ts`    | `document_templates`, `documents`                                                                                                                                                                                                               | `documents/templates.ts`, `upload.ts`, `generate.ts`, `status.ts`                                                              |
| `stats.ts`        | `stat_snapshots`, `stat_rows`                                                                                                                                                                                                                   | `stats/import.ts`                                                                                                              |

Писатели через границу модуля — их четыре, и каждый объяснён в коде:

- `stages/commands.ts` обновляет `interactions` (статус, ответственный, `last_activity_at`) — строка
  взаимодействия и есть то, что двигают команды;
- `stages/commands.ts` и `interactions/write.ts` оба пишут `interaction_changes` — это предметная
  история изменений плана, которую показывают в карточке, а не журнал действий;
- `stats/import.ts` создаёт запись в `documents`: исходный файл снимка обязан лежать в том же
  неизменяемом хранилище, что и остальные документы;
- `people/retention.ts` обновляет `people`, которой владеет `directory`: обезличивание — необратимое
  действие с собственным правом, и живёт оно рядом с согласиями, а не в общей записи справочника.

**Представления и триггеры** заводятся SQL-миграциями, а в Drizzle объявлены как `.existing()` —
ORM про них знает, но ими не управляет:

- `stage_entry_status` (`drizzle/0001_…`) — срок стадии с учётом пауз: окно записи, `paused_seconds`
  как пересечение пауз с окном, `due_at`, `is_overdue`. Закрытая запись больше не «едет»;
- `stat_program_indicators` (`drizzle/0002_…`) — показатели по программе, организации и периоду:
  складываются только строки подтверждённых текущих снимков;
- триггер `audit_events_append_only` (`drizzle/0001_…`) запрещает `UPDATE` и `DELETE` в журнале на
  любой установке — не грантом, который живёт в базе, а триггером, который едет со схемой;
- частичные уникальные индексы, которые держат инварианты: `stage_entries_one_open_per_interaction`,
  `stage_pauses_one_open_per_entry`, `interactions_external_ref_key`, `organizations_inn_key`,
  `documents_supersedes_key`, `users_email_lower_key`.

**Миграции** лежат в `drizzle/` (SQL плюс журнал drizzle-kit) и применяются `scripts/migrate.ts`:
`pnpm run db:migrate` руками и `CMD` контейнера перед стартом приложения. Тот же скрипт одной
транзакцией приводит каталог прав и ролей к тому, что записано в коде
(`seedRolesAndPermissions`) — иначе выпуск, добавивший право, пришлось бы разносить по установкам
руками. Демонстрационные данные к этому отношения не имеют: их заливает `scripts/seed/`.

## Транзакционные границы и инварианты

Транзакцию открывает тот сервис, который отвечает за целостность операции целиком; вложенные вызовы
получают `tx` параметром и своей транзакции не начинают. Обёртка одна — `withTransaction(ctx, fn)`
(`db/transaction.ts`); она же кладёт `app.request_id` в настройки сессии PostgreSQL, чтобы медленный
оператор в логе базы связывался с записью журнала.

| Операция                       | Где                                               | Что внутри одной транзакции                                         |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| любая команда стадии           | `stages/commands.ts` (`moveStage`, `pauseStage`…) | блокировка строки, проверка, запись стадии, пауза, событие журнала  |
| создание взаимодействия        | `interactions/write.ts` + `startInteractionIn`    | взаимодействие, стороны, программы, продукты и первая стадия        |
| приём заявки с сайта           | `integrations/intake.ts`                          | организация, человек, роль, взаимодействие, первый комментарий      |
| согласие и срок хранения       | `people/consents.ts`, `people/retention.ts`       | запись согласия/отзыва или обезличивание вместе с событием журнала  |
| загрузка и генерация документа | `documents/upload.ts`, `generate.ts`              | запись `documents` после того, как файл уже лежит в хранилище       |
| импорт данных об обучении      | `stats/import.ts`                                 | документ-исходник, снимок и его строки; подтверждение — своим шагом |

Вне транзакции — намеренно:

- **отказы и неудачи журнала.** `recordAuditEvent` пишет в `tx` только исход `success`; `failure` и
  `denied` уходят отдельным соединением, потому что транзакция вокруг них обычно откатывается, а
  знать о попытке нужно именно тогда (`audit/index.ts`, `rbac/index.ts::denyWithRecord`);
- **след просмотра ПДн у упавшего чтения.** `withPiiTrace` пишет событие в `tx`, только если чтение
  прошло: после ошибки базы транзакция уже в состоянии `25P02`, и вставка в неё подменила бы
  исходную ошибку — на которую, например, смотрит приём заявки, различая гонку на уникальности;
- **конвертация DOCX → PDF.** Gotenberg ходит по сети и отвечает секунды; транзакция открывается
  после рендера и конвертации, а не вокруг них.

Из-за первых двух пунктов пул соединений (`POOL_MAX = 24` в `db/index.ts`) заведомо больше числа
одновременных транзакций: внутри открытой транзакции коду иногда нужно второе соединение.

**Блокировки и идемпотентность.** Каждая команда движка начинается с `lockInteraction` —
`SELECT … FOR UPDATE` по строке взаимодействия с проверкой области доступа тем же запросом. Без неё
две одновременные команды прочитали бы одно состояние и обе сочли бы себя правыми. `setResponsible`
блокирует несколько записей в одном порядке, чтобы встречные команды не встали во взаимный замок.
Повтор перехода из API гасит `Idempotency-Key`; повтор заявки с сайта — частичный уникальный индекс
по `external_source`/`external_id`, а проигравший гонку откатывается целиком и отвечает прежней
записью и `created: false`.

**Правило перехода — одно на продукт.** `evaluateTransition(ctx, state, transition, intent)` в
`stages/transitions.ts` — чистая функция: ни базы, ни HTTP. Она проверяет право перехода (код берётся
из конфигурации маршрута и обязан быть в каталоге прав, иначе строка в базе стала бы обходом
проверки), совпадение текущей стадии, открытые помехи, а для шага вперёд — паузу, обязательные
пункты чек-листа, результат и подтверждение. Причина требуется, когда её требует переход. Эту же
функцию зовут три места: карточка (`interactions/summary.ts`), доска (`interactions/board.ts`) и сама
команда под блокировкой строки (`stages/commands.ts::moveStage`).

**Четыре вопроса карточки** — `getInteractionSummary` в `interactions/summary.ts`: что происходит,
что мешает, кто должен действовать и что я могу сделать прямо сейчас. Ответ собирается целиком на
сервере, потому что три вопроса из четырёх — это правила, а не данные, и интерфейс не имеет права
выводить доступность действия заново.

## Область доступа и права

Актор собирается один раз за запрос (`actorFromEvent`), а область доступа приезжает в нём из сессии
(`AccessScope`: `{ kind: 'all' }` либо список организаций; у анонимного — пустой список). Решается
она в `loadSessionUser` — в одном месте, а не в выборках.

Вопросов всегда два, и отвечают на них разные функции `src/lib/server/rbac/index.ts`:

- **право** — «можно ли вообще делать это действие»: `can(ctx, key)` и `requirePermission`. Каталог
  прав — `rbac/permissions.ts` (26 кодов и роли по умолчанию `admin`/`manager`/`viewer`); он же
  типизирует `PermissionKey`, сидируется в таблицы и синхронизируется миграцией. Право роли
  кэшируется на процесс, кэш сбрасывает `invalidateRoleCache()`. У `requirePermission` есть вторая,
  асинхронная форма — с описанием события: попытка сделать то, на что нет права, записывается в
  журнал отдельным соединением и только потом становится ошибкой;
- **область** — «какие строки видно»: `scopeFilter(ctx, column)` отдаёт SQL, пригодный для `and(...)`
  (`true` при полном доступе, `false` при пустой области — не `in ()`). Для взаимодействия область
  считается через стороны процесса: `interactionScopeFilter` в `interactions/access.ts` — это
  `exists(...)` по `interaction_parties`, а `assertInteractionVisible` отдаёт `NotFoundError`, а не
  403, чтобы перебором идентификаторов нельзя было узнать, что существует за границей области.
  Документы наследуют ту же проверку (`documents/read.ts::assertInteractionAccessible`).

**Граница демонстрации** проходит по правам, а не по интерфейсу. `demoSessionPermissions` вычитает
из набора роли семь кодов (`users.manage`, `api_keys.manage`, `settings.write`, `audit.export`,
`stages.configure`, `integrations.manage`, `people.anonymize`), и это видно всем — загрузчикам,
сервисам и API, — потому что спрятанной кнопки хватает ровно настолько, насколько её хватает от
`curl`. Признак поднимает не столбец `users.is_demo` сам по себе, а он вместе с `DEMO_MODE`.

**Маскирование ПДн — в одном сериализаторе.** `toPersonView` (`people/serialize.ts`) — единственный
способ отдать человека наружу: без права `people.read_pii` почта и телефон уходят замаскированными
(`i***@vuz.ru`, `+7 *** *** 45 67`) и поднимается флаг `contactsMasked`. Там же, и только там,
отмечается факт раскрытия: `notePiiView` копит идентификаторы в области сбора `withPiiTrace`, и на
выходе из последней области в журнал уходит одно событие `people.pii_viewed` со списком — вместо
двадцати пяти событий на страницу справочника. Области сбора открывают чтения и записи людей в
`directory/read.ts`, `directory/write.ts`, `interactions/read.ts`, `people/retention.ts` и
`integrations/intake.ts`.

## Интеграции и фоновые процессы

Отдельного фонового процесса в системе нет: `init` в `src/hooks.server.ts` заводит таймер
(`startIntegrationsTimer` в `integrations/pump.ts`) — цепочку `setTimeout`, а не `setInterval`,
потому что период лежит в настройках и меняется из интерфейса. Под Vitest таймер не стартует.

Один проход (`runIntegrationsCycle`) берёт замок `lct:integrations:pump:lock` в Redis на пять минут
— приложение может работать в нескольких процессах, а событие должно уйти получателю один раз, — и
делает два дела.

**Доставка вебхуков.** Подписки живут в Redis (`integrations/subscriptions.ts`, ключи —
`redis-keys.ts`), а источник событий — журнал действий: только исход `success` и без собственных
записей о доставке, иначе цикл кормил бы сам себя. Курсор подписки идёт по паре «момент, id» и
намеренно отстаёт от настоящего времени на `JOURNAL_LAG_SECONDS = 30`: `occurred_at` — это время
начала транзакции, и без отставания событие из чуть более долгой транзакции появилось бы уже позади
курсора. Вторую отправку гасит отметка `SET NX` (`claimEvent`). Подпись — в `delivery.ts`:
`signPayload(secret, timestamp, body)` даёт `sha256=<HMAC-SHA256(секрет, "<timestamp>.<тело>")>` и
едет в заголовках `X-Webhook-Id`, `X-Webhook-Timestamp`, `X-Webhook-Signature`; timestamp в подписи
нужен, чтобы перехваченный запрос нельзя было повторить через сутки. Повторы — по списку
`RETRY_DELAYS_SECONDS` (15 с … 2 ч), за перенаправлением запрос не идёт.

**Обмен с системой обучения.** `integrations/lms/moodle.ts` — клиент веб-сервиса Moodle REST
(`wsfunction`, ошибка приходит с кодом 200 и телом-исключением, поэтому тело разбирается всегда).
`lms/sync.ts` собирает из курсов и записанных слушателей обычную таблицу и кладёт её в тот же сервис
снимков, каким пользуется человек, загрузивший файл руками, — и останавливается на состоянии
«проверен»: подтверждение снимка вводит числа в показатели, а это решение человека.

**Мок LMS** живёт в самом приложении: `integrations/mock-lms/` плюс маршруты
`src/routes/mock-lms/login/token.php` и `.../webservice/rest/server.php`. Без флага `MOCK_LMS`
маршрутов нет вовсе (404). Клиент к нему ходит тот же самый, что пойдёт в настоящую LMS: адрес
берётся из настроек интеграций.

**Приём заявок** — `POST /api/v1/applications` → `integrations/intake.ts`. Заявка не заводит третьей
сущности: она сразу становится организацией, контактным лицом и взаимодействием на маршруте по
умолчанию, через обычные сервисы справочника и взаимодействий.

## Файлы и документы

Файлы лежат в `DATA_DIR/files/<uuid>` без расширения — всё, что о файле известно, записано в базе.
Файл неизменяем: новая редакция документа — это новая запись и новый файл со ссылкой
`supersedes_id`, а не правка старого.

Запись разведена на три шага, потому что диск и база не фиксируются вместе
(`documents/storage.ts`): `stageBlob` кладёт байты во временный каталог и проверяет содержимое →
`promoteBlob` делает `rename` в `files/` (в пределах тома это атомарно) → запись в `documents`
делает вызывающий сервис в транзакции. Если два последних шага не удались, вызывающий обязан позвать
`discardStaged`. Обратного порядка быть не может: запись ссылалась бы на файл, которого ещё нет.
Путь из базы — данные, а не код, поэтому `resolveStoredPath` проверяет, что он не ведёт за пределы
каталога данных; права на файлы и каталоги — `0600`/`0700`.

**Проверка содержимого** — `documents/mime.ts`: тип определяется по сигнатуре первых байтов, а для
форматов Office ещё и по составу zip-архива, и должен совпасть с заявленным. Список допустимых типов
и потолок размера (25 МиБ) живут в контрактах, то есть одни и те же на форме, в API и здесь.

**Выдача** — `src/routes/(app)/documents/[id=uuid]/download/+server.ts`: маршрут внутри оболочки
приложения, а не в `/api`, потому что сюда приходят с сессионной кукой и ошибку надо показывать
страницей. Право и область проверяет `readDocumentForDownload`, файл отдаётся потоком с диска,
ответ — `no-store` и `nosniff`.

**Генерация** — `documents/generate.ts`: DOCX собирается docxtemplater'ом в памяти по шаблону из
`templates/`, PDF получается из того же DOCX конвертацией в Gotenberg (`GOTENBERG_URL`, потолок
ожидания 30 с). Своего рендерера PDF нет намеренно: документ обязан выглядеть одинаково в обоих
форматах. Сам шаблон при первом обращении переносится в хранилище файлов
(`documents/templates.ts`), чтобы уже сгенерированный документ можно было объяснить.

## Клиент

- `src/routes/(app)/**` — разделы приложения: взаимодействия, организации, контакты, программы,
  продукты, данные, документы, журнал, настройки; `src/routes/(auth)/**` — вход и второй шаг.
  Оболочка — `(app)/+layout.svelte` → `AppShell` (`components/app-shell/`): боковая навигация,
  верхняя панель, палитра поиска, место для всплывающих уведомлений.
- `src/lib/components/ui/**` — примитивы shadcn-svelte/bits-ui, завендоренные в репозиторий;
  `src/lib/components/<раздел>/**` — составные компоненты продукта (`interactions/`, `directory/`,
  `stats/`, `home/`, `form/`, `data-table/`).
- **Контролы:** у каждой задачи ввода ровно один контрол, и он наш, а не браузерный —
  `FieldSelect`/`FilterSelect`, `FieldDate`/`DateField`, `FileInput`, `FieldInput`, `FieldTextarea`.
  Нативных `<select>`, `<input type="date">` и `<input type="file">` в разметке быть не должно;
  проверка на весь продукт и причина — в [`development.md`](development.md), раздел «Один контрол на
  задачу».
- **Состояние списков живёт в адресе.** `page`, `size`, `sort`, `q` собирает
  `components/data-table/query.ts`; фильтры раздела — `components/directory/query.ts` и
  `routes/(app)/interactions/filters.ts`. Имена параметров знает один модуль, а читают обе стороны:
  загрузчик разбирает строку запроса, таблица её пишет. Значит, список — это ссылка.
- **Всплывающие слои** (диалоги, меню, поповеры, панели) ломаются тихо: заголовок группы только
  внутри `Group`, портал уже внутри `Content`, анимацию держат два импорта в `src/app.css`, а
  открывает слой только ожившая страница. Все четыре правила и приёмы для проверок — в
  [`development.md`](development.md), раздел «Всплывающие слои».
- Клиентские модули иногда импортируют из `$lib/server` — но только типы (`SessionUser`,
  `PermissionKey`): такой импорт стирается при сборке и в браузер не попадает.

## Как найти

| Вопрос                                         | Файл                                        | Что смотреть                                         |
| ---------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| правило перехода между стадиями                | `src/lib/server/stages/transitions.ts`      | `evaluateTransition`, `transitionPermission`         |
| выполнение перехода, блокировки                | `src/lib/server/stages/commands.ts`         | `moveStage`, `lockInteraction`                       |
| проверка права                                 | `src/lib/server/rbac/index.ts`              | `can`, `requirePermission`                           |
| каталог прав и роли по умолчанию               | `src/lib/server/rbac/permissions.ts`        | `PERMISSIONS`, `DEFAULT_ROLES`                       |
| сужение выборки по области доступа             | `src/lib/server/rbac/index.ts`              | `scopeFilter`                                        |
| то же для взаимодействий и документов          | `src/lib/server/interactions/access.ts`     | `interactionScopeFilter`, `assertInteractionVisible` |
| адаптер LMS                                    | `src/lib/server/integrations/lms/moodle.ts` | `createMoodleClient`, `MoodleError`                  |
| что адаптер делает с ответами                  | `src/lib/server/integrations/lms/sync.ts`   | `collectRows`, `syncLms`                             |
| подпись вебхука                                | `src/lib/server/integrations/delivery.ts`   | `signPayload`, `verifySignature`, `postWebhook`      |
| журнал: запись и выгрузка                      | `src/lib/server/audit/index.ts`             | `recordAuditEvent`, `exportAuditEvents`              |
| журнал: словарь событий и правила подробностей | `src/lib/contracts/audit.ts`                | `AUDIT_EVENT_TYPES`, `validateAuditDetails`          |
| маскирование персональных данных               | `src/lib/server/people/serialize.ts`        | `toPersonView`                                       |
| след просмотра персональных данных             | `src/lib/server/people/pii-trace.ts`        | `withPiiTrace`, `notePiiView`                        |
| обёртка эндпоинта API                          | `src/lib/server/api/handler.ts`             | `apiHandler`                                         |
| граница транзакции                             | `src/lib/server/db/transaction.ts`          | `withTransaction`                                    |

## Окружение запуска

`docker-compose.yml` — локальный стек и он же демонстрационный стенд: `postgres:17-alpine` (на хосте
`55432`), `redis:8-alpine` (`56379`), `gotenberg:8` (`3001`), `mailpit` (`1025`/`8025`) и `app`
(`3000`). Порты на хосте сдвинуты, чтобы стек не спорил с уже запущенными на машине службами.
`docker-compose.prod.yml` — наложение поверх базового файла: наружу смотрит только приложение и
только на петлевом интерфейсе, у каждой службы перезапуск и потолок памяти, конфигурация приходит из
`.env`, а `ADDRESS_HEADER`/`XFF_DEPTH` описывают, как читать адрес клиента за обратным прокси.

Переменные окружения проверяются схемой Zod в `src/lib/server/config.ts` без умолчаний: недостающая
или неверная останавливает процесс при старте, а не всплывает страницей позже. Шаблон —
`.env.example`.

| Группа    | Переменные                                                           | Комментарий                                                       |
| --------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Среда     | `NODE_ENV`, `ORIGIN`                                                 | `ORIGIN` сверяет хук `csrf` и по нему же решается `secure` у куки |
| Данные    | `DATABASE_URL`, `REDIS_URL`, `DATA_DIR`                              | база, Redis, каталог файлов документов                            |
| Службы    | `GOTENBERG_URL`, `SMTP_HOST`, `SMTP_PORT`                            | конвертация в PDF и почта                                         |
| Режимы    | `DEMO_MODE`, `MOCK_LMS`, `TRUST_PROXY`                               | ровно `true`/`false`; `TRUST_PROXY` — только за обратным прокси   |
| Вне схемы | `BODY_SIZE_LIMIT`, `SEED_DEMO_PASSWORD`, `SEED_STAFF_ADMIN_PASSWORD` | первую читает adapter-node, две другие — только сид               |

`Dockerfile` — пять стадий (`base` → `deps` → `prod-deps` → `build` → `runtime`). В образ
кроме `build/` кладутся `drizzle/`, `scripts/`, `src/lib` и `templates/`: миграции, сид и чтение
шаблонов выполняет обычный процесс Node, которому нужны исходники, а не бандл. `HEALTHCHECK` стучится
в `/api/health` — этот эндпоинт отвечает 200, только когда откликнулись и база, и Redis.

Старт контейнера — одна команда из трёх шагов: `node scripts/migrate.ts` (миграции плюс синхронизация
каталога прав) → `node scripts/seed/index.ts --if-demo` (демонстрационные данные, и только при
`DEMO_MODE=true`) → `exec node build/index.js`. Сбой на любом шаге останавливает контейнер, а не
запускает приложение на наполовину подготовленной базе.
