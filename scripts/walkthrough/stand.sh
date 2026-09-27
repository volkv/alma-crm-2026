#!/usr/bin/env bash
#
# Стенд для ручного прохода сценариев: отдельная рабочая копия на
# зафиксированном коммите, изолированная от разработки и от e2e — свой порт,
# своя база PostgreSQL, свой номер базы Redis, свой бакет MinIO. Keycloak,
# имитаторы CMS/LMS и Gotenberg — общий стек `docker-compose.yml`, тот же, что
# у разработки и у e2e; общая база и Redis у них тоже, но стенд живёт в
# собственном имени базы и собственной логической базе Redis, поэтому им есть
# чем не пересекаться.
#
# Использование:
#   scripts/walkthrough/stand.sh up [копия] [коммит]
#   scripts/walkthrough/stand.sh down [копия]
#   scripts/walkthrough/stand.sh status [копия]
#   scripts/walkthrough/stand.sh reseed [копия]
#
# Копия по умолчанию — соседний каталог `<репозиторий>-walk`. Коммит у `up`
# необязателен: без него собирается то, что уже стоит в копии.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Порт, база, номер Redis и бакет стенда. Порт — 3000: он уже разрешён в
# realm-е Keycloak умолчанием `${CRM_ORIGIN:http://localhost:3000}` из
# `docker-compose.yml` (см. docs/development.md, «Стенд для ручной проверки») —
# ни realm, ни compose трогать не нужно. Номер базы Redis — 15: e2e занимает
# 10–14 (`10 + порт % 5` на портах 4173–4177), у разработки без номера — 0.
STAND_PORT="${STAND_PORT:-3000}"
STAND_DB="${STAND_DB:-lct_walk}"
STAND_REDIS_DB="${STAND_REDIS_DB:-15}"
STAND_BUCKET="${STAND_BUCKET:-lct-documents-walk}"

# Адреса общего стека — те же, что в `.env.example` для разработки.
STAND_PG_PORT=55432
STAND_REDIS_PORT=56379
STAND_S3_ACCESS_KEY=lct
STAND_S3_SECRET_KEY=lct-secret-key

# Сервисы общего стека, которые нужны стенду. Без `app` (стенд запускает свой
# процесс на хосте, не контейнером) и без `minio-init` (одноразовая задача,
# заводится отдельным вызовом ниже).
INFRA_SERVICES=(postgres redis keycloak gotenberg mailpit minio mock-cms mock-lms)

if [ -s "$HOME/.nvm/nvm.sh" ]; then
	# shellcheck disable=SC1091
	source "$HOME/.nvm/nvm.sh"
	nvm use 24 >/dev/null
fi

usage() {
	cat <<'USAGE'
Использование: stand.sh <up|down|status|reseed> [копия] [коммит]

  up <копия> [коммит]  checkout (если задан коммит) → зависимости → общая
                       инфраструктура (Keycloak/Gotenberg/имитаторы) → своя
                       база и бакет → миграции → демо-сид → сборка → запуск
                       сервера в фоне (pid-файл и лог — в копии)
  down <копия>         остановить процесс сервера стенда (инфраструктуру и
                       базу не трогает — они общие с разработкой и e2e)
  status <копия>       жив ли процесс, отвечает ли /api/health
  reseed <копия>       вернуть демо-данные к эталону той же кнопкой, что и
                       администратор стенда (/settings/general → «Сбросить
                       демо-данные»); сервер должен быть запущен

Копия по умолчанию: каталог рядом с этим репозиторием, с суффиксом «-walk».
USAGE
}

log() { printf '%s\n' "$*" >&2; }

run_dir() { echo "$1/.walkthrough"; }
pid_file() { echo "$(run_dir "$1")/stand.pid"; }
log_file() { echo "$(run_dir "$1")/stand.log"; }

default_copy_dir() {
	echo "${MAIN_REPO}-walk"
}

require_copy() {
	local copy="$1"
	if [ ! -d "$copy" ]; then
		log "Копия не найдена: $copy"
		exit 1
	fi
	if [ ! -f "$copy/docker-compose.yml" ]; then
		log "$copy не похож на рабочую копию продукта (нет docker-compose.yml)"
		exit 1
	fi
}

set_env_var() {
	local file="$1" key="$2" value="$3"
	if grep -q "^${key}=" "$file"; then
		sed -i "s|^${key}=.*|${key}=${value}|" "$file"
	else
		printf '%s=%s\n' "$key" "$value" >>"$file"
	fi
}

# Базой берётся `.env.example` копии, а не `.env` основного дерева: на
# 2026-09-27 `.env` основного дерева заведён до того, как в конфигурацию
# добавили обязательные переменные Keycloak и обмена (`OIDC_*`, `EXCHANGE_*`),
# и не проходит проверку схемы (`src/lib/server/config.ts`) вовсе — сервер с
# таким `.env` не запустится. `.env.example`, наоборот, обязан оставаться
# годным всегда: это шаблон, с которого копирует `.env` каждый разработчик.
prepare_env() {
	local copy="$1"
	local env_file="$copy/.env"

	cp "$copy/.env.example" "$env_file"

	# NODE_ENV намеренно не трогаем: Vite сам считает `pnpm run build`
	# production-сборкой и ругается на `NODE_ENV=production` в `.env`
	# («is not supported in the .env file»). Для запущенного сервера этого мало
	# не покажется — `NODE_ENV=production` идёт отдельно, в окружение процесса
	# при старте (`start_server`), тем же способом, каким его ставит
	# `playwright.config.ts` для e2e и `docker-compose.yml` для контейнера
	# `app`.
	set_env_var "$env_file" DATABASE_URL "postgres://lct:lct@localhost:${STAND_PG_PORT}/${STAND_DB}"
	set_env_var "$env_file" REDIS_URL "redis://localhost:${STAND_REDIS_PORT}/${STAND_REDIS_DB}"
	set_env_var "$env_file" ORIGIN "http://localhost:${STAND_PORT}"
	set_env_var "$env_file" PORT "${STAND_PORT}"
	set_env_var "$env_file" HOST "0.0.0.0"
	set_env_var "$env_file" DEMO_MODE "true"
	set_env_var "$env_file" S3_BUCKET "${STAND_BUCKET}"
	# Те же демонстрационные ключи обмена, что дефолтит docker-compose.yml для
	# mock-cms/mock-lms (`EXCHANGE_API_KEY_CMS`/`_LMS`, секция `app`/`mock-*`):
	# сид заводит ключ с тем же значением, и обмен на стенде работает без
	# ручного выпуска.
	set_env_var "$env_file" EXCHANGE_API_KEY_CMS "lct_local-dev-only-cms-key-000000000"
	set_env_var "$env_file" EXCHANGE_API_KEY_LMS "lct_local-dev-only-lms-key-000000000"

	log "Конфигурация записана: $env_file"
}

# Инфраструктура общая на все копии (главное дерево, `-accept`, `-baseline`,
# `-walk`) — один проект compose `lct-crm`. `--project-directory` всегда
# главное дерево, а не копия: у `postgres` и `keycloak` в `docker-compose.yml`
# относительные bind-mount'ы (`./keycloak/...`), и у `mock-cms`/`mock-lms` —
# относительный контекст сборки (`./mocks`). Их резолвится путь входит в хэш
# конфигурации compose, и запуск с `--project-directory <копия>` заставил бы
# compose пересоздавать эти контейнеры при каждом переключении между копиями —
# сюрприз для всех, кто в этот момент ходит в общий Keycloak или Postgres.
# `--env-file` при этом свой, из копии: переменные обмена и порт приложения
# ему не нужны (эти сервисы их не используют), а совпадающие с главным деревом
# умолчания (`S3_ACCESS_KEY`, ключи обмена) не меняют хэш вовсе.
compose() {
	local copy="$1"
	shift
	docker compose --project-directory "$MAIN_REPO" --env-file "$copy/.env" "$@"
}

ensure_infra() {
	local copy="$1"
	log "Поднимаю общую инфраструктуру: ${INFRA_SERVICES[*]}"
	compose "$copy" up -d --wait "${INFRA_SERVICES[@]}"
}

ensure_database() {
	local copy="$1"
	local container
	container="$(compose "$copy" ps -q postgres)"

	if [ -z "$container" ]; then
		log "Контейнер postgres не найден — ensure_infra не отработал?"
		exit 1
	fi

	local exists
	exists="$(docker exec "$container" psql -U lct -d lct -tAc \
		"select 1 from pg_database where datname = '${STAND_DB}'")"

	if [ "$exists" = "1" ]; then
		log "База ${STAND_DB} уже есть"
	else
		docker exec "$container" psql -U lct -d lct -c "create database ${STAND_DB}" >/dev/null
		log "База ${STAND_DB} создана"
	fi
}

ensure_bucket() {
	local copy="$1"

	# Обычный запуск minio-init — те же два бакета, что и у разработки
	# (`lct-documents`, `lct-documents-e2e`); `--ignore-existing` внутри его
	# собственной команды делает повтор безопасным.
	compose "$copy" run --rm minio-init >/dev/null

	# Свой бакет стенда — тем же образом (`mc` внутри образа minio), но другой
	# командой поверх того же сервиса: заводить отдельный сервис в
	# docker-compose.yml ради одного бакета незачем, а compose — не моя область.
	compose "$copy" run --rm --entrypoint sh minio-init -c \
		"mc alias set walk http://minio:9000 '${STAND_S3_ACCESS_KEY}' '${STAND_S3_SECRET_KEY}' && mc mb --ignore-existing walk/${STAND_BUCKET}" >/dev/null

	log "Бакет ${STAND_BUCKET} готов"
}

sync_scripts() {
	local copy="$1"
	mkdir -p "$copy/scripts/walkthrough"
	cp "$SCRIPT_DIR/stand.sh" "$SCRIPT_DIR/login.ts" "$SCRIPT_DIR/reseed.ts" "$SCRIPT_DIR/onboarding.ts" \
		"$copy/scripts/walkthrough/"
}

build_app() {
	local copy="$1"
	(
		cd "$copy"
		if [ ! -d node_modules ]; then
			pnpm install --frozen-lockfile
		fi
		pnpm run build
	)
}

migrate_and_seed() {
	local copy="$1"
	(
		cd "$copy"
		pnpm run db:migrate
		pnpm run db:seed
	)
}

start_server() {
	local copy="$1"
	local dir
	dir="$(run_dir "$copy")"
	mkdir -p "$dir"

	local pidfile logfile
	pidfile="$(pid_file "$copy")"
	logfile="$(log_file "$copy")"

	if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
		log "Сервер уже запущен, PID $(cat "$pidfile")"
		return 0
	fi

	(
		cd "$copy"
		: >"$logfile"
		NODE_ENV=production setsid node --env-file-if-exists=.env build/index.js >>"$logfile" 2>&1 <"/dev/null" &
		echo $! >"$pidfile"
		disown
	)

	log "Сервер запущен, PID $(cat "$pidfile"), лог: $logfile"
}

wait_healthy() {
	local url="http://localhost:${STAND_PORT}/api/health"
	local attempt
	for attempt in $(seq 1 60); do
		if curl -fsS "$url" >/dev/null 2>&1; then
			log "Стенд отвечает: $url"
			return 0
		fi
		sleep 1
	done
	log "Стенд не ответил за 60 секунд ($url) — смотри лог"
	return 1
}

cmd_up() {
	local copy="$1" commit="${2:-}"
	require_copy "$copy"

	if [ -n "$commit" ]; then
		git -C "$copy" checkout -q --detach "$commit"
		log "Копия переключена на $(git -C "$copy" rev-parse --short HEAD)"
	fi

	sync_scripts "$copy"
	prepare_env "$copy"
	ensure_infra "$copy"
	ensure_database "$copy"
	ensure_bucket "$copy"
	build_app "$copy"
	migrate_and_seed "$copy"
	start_server "$copy"
	wait_healthy
}

cmd_down() {
	local copy="$1"
	local pidfile
	pidfile="$(pid_file "$copy")"

	if [ ! -f "$pidfile" ]; then
		log "PID-файл не найден — сервер этим скриптом не запущен"
		return 0
	fi

	local pid
	pid="$(cat "$pidfile")"

	if kill -0 "$pid" 2>/dev/null; then
		kill "$pid"
		local i
		for i in $(seq 1 20); do
			kill -0 "$pid" 2>/dev/null || break
			sleep 0.5
		done
		if kill -0 "$pid" 2>/dev/null; then
			kill -9 "$pid"
		fi
		log "Сервер (PID $pid) остановлен"
	else
		log "Процесс PID $pid уже не жив"
	fi

	rm -f "$pidfile"
}

cmd_status() {
	local copy="$1"
	local pidfile
	pidfile="$(pid_file "$copy")"

	if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
		log "Процесс: жив, PID $(cat "$pidfile")"
	else
		log "Процесс: не запущен"
	fi

	local url="http://localhost:${STAND_PORT}/api/health"
	if curl -fsS "$url"; then
		echo
		log "HTTP: отвечает ($url)"
	else
		log "HTTP: не отвечает ($url)"
	fi
}

cmd_reseed() {
	local copy="$1"
	require_copy "$copy"
	(
		cd "$copy"
		node scripts/walkthrough/reseed.ts "http://localhost:${STAND_PORT}"
	)
}

main() {
	local action="${1:-}"
	[ $# -gt 0 ] && shift
	local copy="${1:-$(default_copy_dir)}"
	[ $# -gt 0 ] && shift

	case "$action" in
	up)
		cmd_up "$copy" "${1:-}"
		;;
	down)
		cmd_down "$copy"
		;;
	status)
		cmd_status "$copy"
		;;
	reseed)
		cmd_reseed "$copy"
		;;
	*)
		usage
		exit 1
		;;
	esac
}

main "$@"
