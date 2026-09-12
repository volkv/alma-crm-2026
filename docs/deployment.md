# Развёртывание

Инструкция для сервера: один хост, Docker Compose, обратный прокси перед приложением.
Локальный запуск и разработка — в [`../README.md`](../README.md) и [`development.md`](development.md).

## Что нужно на сервере

- Docker 25+ с плагином Compose 2.24+ (нужны теги слияния `!reset` / `!override`
  в `docker-compose.prod.yml`; проверить — `docker compose version`).
- ~2 ГБ свободной оперативной памяти на стек и ~2 ГБ на сборку образа.
  Суммарный лимит контейнеров — 1984 МБ (см. `docker-compose.prod.yml`).
  Если памяти на сборку не хватает, образ собирают на другой машине и переносят:
  `docker save lct-crm-app | gzip | ssh <host> 'gunzip | docker load'`,
  а у сервиса `app` в оверрайде вместо `build` указывают `image: lct-crm-app`.
- ~3 ГБ на диске под образы и тома.
- nginx (или другой прокси), который терминирует TLS и проксирует на порт приложения.

Наружу публикуется только приложение и только на loopback (`127.0.0.1:${APP_PORT}`).
PostgreSQL, Redis, Gotenberg и Mailpit доступны исключительно внутри сети Compose:
у Mailpit веб-интерфейс показывает всю исходящую почту, у базы — все данные.

## Конфигурация

Все переменные обязательны: без любой из них сервер не стартует и пишет, чего не хватает
(`src/lib/server/config.ts`). Шаблон — `.env.example`; на сервере `.env` отличается от него
адресами (внутри сети Compose это имена сервисов, а не `localhost`) и двумя добавками.

| Переменная           | Значение на сервере                                                                |
| -------------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`           | `production`                                                                       |
| `DATABASE_URL`       | `postgres://lct:lct@postgres:5432/lct`                                             |
| `REDIS_URL`          | `redis://redis:6379`                                                               |
| `GOTENBERG_URL`      | `http://gotenberg:3000`                                                            |
| `SMTP_HOST`          | `mailpit`                                                                          |
| `SMTP_PORT`          | `1025`                                                                             |
| `ORIGIN`             | `https://<домен>` — ровно тот адрес, по которому открывается приложение в браузере |
| `DEMO_MODE`          | `true` на публичном стенде, `false` у заказчика; ровно `true` или `false`          |
| `SEED_DEMO_PASSWORD` | Общий пароль демонстрационных учётных записей; нужен только при `DEMO_MODE=true`   |
| `TRUST_PROXY`        | `true` — приложение стоит за nginx и берёт адрес клиента из `X-Forwarded-For`      |
| `APP_PORT`           | порт на `127.0.0.1`, куда смотрит прокси; по умолчанию `8099`                      |

`DATA_DIR`, `ADDRESS_HEADER` и `XFF_DEPTH` в `.env` не пишут: их задаёт
`docker-compose.prod.yml`, потому что они описывают устройство развёртывания, а не его
настройки. Каталог данных — том `app-data`, примонтированный в `/data`; он переживает
пересборку образа и `docker compose down` без `-v`.

`ORIGIN` обязан совпадать с публичным адресом до символа: adapter-node по нему проверяет
источник POST-запросов, при расхождении формы отваливаются с 403.

`APP_PORT` читает только Compose (подстановка в `docker-compose.prod.yml`), приложение
внутри контейнера всегда слушает 3000.

Файл с секретом — `chmod 600 .env`. В репозиторий он не попадает (`.gitignore`).

## Первый запуск

```bash
git clone <repo> /srv/lct-crm && cd /srv/lct-crm
cp .env.example .env && chmod 600 .env      # дальше править по таблице выше
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Compose поднимает PostgreSQL, Redis, Gotenberg и Mailpit, ждёт их healthcheck'ов и только
потом запускает приложение. Контейнер приложения при старте сам применяет миграции
(`node scripts/migrate.ts` в `Dockerfile`) — отдельного шага миграции в развёртывании нет.
Миграции идемпотентны: применённые пропускаются.

Следом, и только при `DEMO_MODE=true`, контейнер заливает демонстрационные данные
(`node scripts/seed/index.ts --if-demo`): справочники, три демонстрационные учётные записи и
двух сотрудников. Сид тоже идемпотентен и не затирает правки, сделанные на стенде руками;
при `DEMO_MODE=false` он не делает ничего. Что именно заливается и как это устроено —
в [`seeds.md`](seeds.md).

Проверить, что всё поднялось:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
curl -s http://127.0.0.1:8099/api/health
```

`/api/health` отвечает `{"status":"ok","db":"ok","redis":"ok","version":"…"}` и кодом 200,
только если ответили и база, и Redis. Иначе — 503 и текст ошибки того сервиса, который лёг.
Тот же эндпоинт использует healthcheck контейнера.

Дальше — прокси: шаблон `deploy/nginx/crm.conf.example`, в нём заменить `CRM_DOMAIN`,
`CRM_PORT` и пути к сертификату, положить в `sites-available`, слинковать в `sites-enabled`
и перезагрузить nginx после `nginx -t`.

Буферы заголовков в шаблоне увеличены не про запас. SvelteKit отдаёт заголовок `Link` со
ссылками на модули, которые странице понадобятся (`rel=modulepreload`); на страницах со
списками и диалогами он вырастает до 4–5 КБ. Дефолтного `proxy_buffer_size 4k` на такой ответ
не хватает: nginx не режет заголовок, а отвечает 502 и пишет в `crm_error.log`
«upstream sent too big header while reading response header from upstream». Приложение при
этом исправно — в его логе обычный 200. Отсюда `proxy_buffer_size 32k`, `proxy_buffers 8 32k`
и `proxy_busy_buffers_size 64k` в `location /`: если прокси на стенде настраивают не по
шаблону, эти три строки нужно перенести руками.

## Обновление

```bash
cd /srv/lct-crm
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Пересобирается и заменяется только приложение; база, Redis и их тома остаются на месте,
новые миграции применяются при старте нового контейнера. Простой — несколько секунд.

Откат — на предыдущий коммит той же командой. Миграции назад не откатываются: если релиз
менял схему, перед откатом нужен дамп (ниже) и ручное решение, что с данными.

## Логи, остановка, перезапуск

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart app
docker compose -f docker-compose.yml -f docker-compose.prod.yml down        # тома целы
```

`down -v` удаляет тома вместе с данными — на сервере так не делают.

## Резервное копирование

Дамп базы (формат `custom`, сжатый, годится для `pg_restore`):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T postgres pg_dump -U lct -d lct -Fc > lct-$(date +%F).dump
```

Восстановление в пустую базу:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T postgres pg_restore -U lct -d lct --clean --if-exists < lct-2026-01-01.dump
```

Redis в бэкапе не нуждается: там сессии и кэш, они восстанавливаются сами.
Gotenberg и Mailpit состояния не хранят.
