# Локальная разработка: инфраструктура — в контейнерах, приложение — на хосте.
#
# Сервис `app` из `docker-compose.yml` здесь не поднимается: он собирает образ и
# стартует production-сборку на порту 3000, а разработке нужен Vite с HMR на
# 5173. Всё остальное из стека нужно как есть — адреса в `.env.example` уже
# указывают на опубликованные порты этих контейнеров.

SHELL := /bin/sh

# Стек без `app`. `minio-init` идёт отдельной строкой: это одноразовая задача
# (заводит бакеты и выходит), а не служба, которую ждут по проверке здоровья.
INFRA := postgres redis keycloak gotenberg mailpit minio mock-cms mock-lms

# Те сервисы стека, образ которых собирается здесь, а не тянется готовым:
# имитаторы систем заказчика, их исходники лежат в `mocks/`.
BUILT := mock-cms mock-lms

.PHONY: up down upgrade infra db dev

## up — поднять инфраструктуру, применить миграции и запустить dev-сервер
up: infra db dev

## down — погасить все контейнеры стека
#
# Без списка сервисов: гасится всё из `docker-compose.yml`, включая `app`, если
# он поднимался. Томы (`postgres-data`, `redis-data`, `minio-data`) остаются —
# база и файлы переживают перезапуск; чтобы снести и их, нужен `down -v`.
#
# Dev-сервер это не трогает: он живёт на хосте, его гасит Ctrl+C.
down:
	docker compose down

## upgrade — обновить образы стека
#
# Пересборка имитаторов (их код в репозитории — правка в `mocks/` в прежний
# образ не попадёт) и свежие сторонние образы. `up` этого не делает: там
# пересборка на каждый запуск ничего не проверяет, только тратит время, а
# отсутствующий образ compose соберёт сам.
upgrade: .env
	docker compose build $(BUILT)
	docker compose pull $(filter-out $(BUILT),$(INFRA))

## infra — контейнеры стека, кроме `app`
infra: .env
	docker compose up -d --wait $(INFRA)
	docker compose run --rm minio-init

## db — миграции и, при DEMO_MODE=true, демонстрационные данные
#
# Тот же порядок, что у контейнера приложения (`Dockerfile`, CMD): сначала
# схема и каталог прав, потом сид. `--if-demo` сам смотрит на DEMO_MODE, так
# что вызов безопасен и при выключенной демонстрации.
db:
	pnpm run db:migrate
	pnpm run db:seed --if-demo

## dev — Vite на http://localhost:5173
#
# Vite зовётся через node, а не через `pnpm dev`: на Windows `pnpm` — это
# батник, и Ctrl+C уводит терминал в запрос cmd.exe «Terminate batch job
# (Y/N)?». Без шима сигнал доходит до самого Vite, и он просто выходит.
dev:
	node node_modules/vite/bin/vite.js dev

# Конфигурация читается из `.env`; значения шаблона уже совпадают со стендом.
.env:
	cp .env.example .env
