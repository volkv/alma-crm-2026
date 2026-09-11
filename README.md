# LCT CRM

CRM для оператора образовательных программ: учёт вузов, компаний-заказчиков и взаимодействий с ними.

## Требования

- Docker 25+ с плагином Compose
- Node.js 24 (версия зафиксирована в `.nvmrc`)
- pnpm 10 (`corepack enable`)

## Запуск одной командой

```bash
docker compose up --build
```

Поднимаются приложение, PostgreSQL 17, Redis 8, Gotenberg и Mailpit; миграции применяются
автоматически перед стартом приложения. Дальше:

- приложение — http://localhost:3000
- почтовый ящик Mailpit — http://localhost:8025

Остановить и удалить данные: `docker compose down -v`.

## Разработка

```bash
cp .env.example .env                                        # значения уже совпадают с compose
docker compose up -d postgres redis gotenberg mailpit       # только инфраструктура
pnpm install
pnpm run db:migrate
pnpm dev                                                    # http://localhost:5173
```

Все переменные окружения обязательны: без любой из них сервер не стартует и пишет,
чего именно не хватает. Список — в `.env.example`.

## Проверки

```bash
pnpm run check:all
```

Это lint → проверка типов → модульные тесты → интеграционные тесты → сборка → e2e.
Интеграционные и e2e-тесты требуют запущенного Docker.

Подробности — в [`docs/development.md`](docs/development.md).

## Лицензия

MIT, см. [LICENSE](LICENSE).
