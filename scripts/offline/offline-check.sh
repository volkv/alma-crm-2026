#!/usr/bin/env bash
#
# Проверка «продукт работает без интернета» прогоном, а не чек-листом.
#
# Запуск из корня репозитория (нужны Docker с Compose 2.24+, Node 24 и
# установленные зависимости проекта — `pnpm install` и браузер Playwright):
#
#   scripts/offline/offline-check.sh
#
# Что делает:
#   1. собирает образы приложения и имитаторов (сборке сеть нужна — это
#      нормально: проверяется работа установки, а не сборка; сторонние образы
#      берутся локальные, `--pull never`);
#   2. генерирует файл переменных прогона со своими паролями и ключами и
#      поднимает стенд (`docker-compose.yml` + `docker-compose.prod.yml`,
#      профиль `stand`) с наложением `compose.offline-check.yml`: сеть сервисов
#      `internal: true`, наружу — только прокси `edge` на петле хоста;
#   3. проверяет, что выхода наружу действительно нет: запрос к example.com и
#      к адресу 1.1.1.1 из контейнеров приложения, Gotenberg и имитатора CMS
#      обязан упасть;
#   4. проходит основные сценарии браузером (`offline-check.spec.ts`, набор
#      `@full`): вход тремя ролями, заявка с сайта от имитатора CMS и статус
#      обратно, список и карточка с переходом стадии, комментарием и файлом,
#      группа в LMS и результат от имитатора, отчёт в XLSX и PDF, справка,
#      страница самодиагностики связей;
#   5. перезапускает стек с сохранёнными томами (`down` + `up`), снова
#      проверяет изоляцию и проходит короткий набор `@restart`;
#   6. сносит стек вместе с томами и сетями.
#
# Переменные окружения:
#   OFFLINE_PORT     порт прокси на 127.0.0.1 (по умолчанию 8190)
#   OFFLINE_PROJECT  имя проекта Compose (по умолчанию lct-offline)
#   OUT_DIR          куда сложить журнал, выгрузки отчёта и снимок страницы
#                    самодиагностики (по умолчанию dist/offline/check-<время>)
#   SKIP_BUILD       1 — не собирать образы, взять уже собранные
#   KEEP_STACK       1 — не сносить стек после прогона (для разбора отказа)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PROJECT="${OFFLINE_PROJECT:-lct-offline}"
PORT="${OFFLINE_PORT:-8190}"
OUT_DIR="${OUT_DIR:-$ROOT/dist/offline/check-$(date +%Y%m%d-%H%M%S)}"
SKIP_BUILD="${SKIP_BUILD:-0}"
KEEP_STACK="${KEEP_STACK:-0}"
BASE_URL="http://localhost:$PORT"

# Прокси окружения не должен перехватывать обращения к стеку на петле.
export NO_PROXY="localhost,127.0.0.1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
exec > >(tee "$OUT_DIR/offline-check.log") 2>&1

started=$SECONDS
phase_started=$SECONDS

phase() {
	local elapsed=$((SECONDS - phase_started))
	phase_started=$SECONDS
	printf '\n== %s (предыдущий шаг: %d с, всего: %d с)\n' "$1" "$elapsed" "$((SECONDS - started))"
}

fail() {
	echo "ОТКАЗ: $*" >&2
	exit 1
}

for tool in docker openssl node pnpm curl; do
	command -v "$tool" >/dev/null || fail "нет команды $tool"
done

if ss -ltn "sport = :$PORT" | grep -q LISTEN; then
	fail "порт $PORT на хосте занят: задайте OFFLINE_PORT"
fi

# --- переменные прогона -------------------------------------------------------

export OFFLINE_ENV_FILE="$OUT_DIR/offline.env"
export OFFLINE_PORT="$PORT"

api_key() {
	printf 'lct_%s' "$(openssl rand -base64 24 | tr '+/' '_-' | tr -d '=')"
}

DEMO_PASSWORD="Offline-$(openssl rand -hex 8)"
MOCK_CONTROL_TOKEN="$(openssl rand -hex 24)"

umask 077
cat >"$OFFLINE_ENV_FILE" <<EOF
NODE_ENV=production
POSTGRES_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
S3_ACCESS_KEY=$(openssl rand -hex 12)
S3_SECRET_KEY=$(openssl rand -hex 24)
PII_ENCRYPTION_KEY=$(openssl rand -base64 32)
GOTENBERG_URL=http://gotenberg:3000
SMTP_URL=smtp://mailpit:1025
SMTP_FROM=crm@offline.local
ORIGIN=$BASE_URL
TRUST_PROXY=true
DEMO_MODE=true
SEED_DEMO_PASSWORD=$DEMO_PASSWORD
OIDC_ISSUER_URL=$BASE_URL/auth/realms/lct
OIDC_PUBLIC_URL=$BASE_URL/auth
OIDC_CLIENT_ID=lct-crm
OIDC_CLIENT_SECRET=$(openssl rand -hex 24)
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=$(openssl rand -hex 24)
DADATA_API_KEY=
EXCHANGE_SECRET=$(openssl rand -hex 24)
EXCHANGE_API_KEY_CMS=$(api_key)
EXCHANGE_API_KEY_LMS=$(api_key)
EXCHANGE_CMS_STATUS_URL=http://mock-cms:8081/api/applications/{externalId}/status
EXCHANGE_LMS_GROUPS_URL=http://mock-lms:8082/api/groups
EXCHANGE_LMS_BASE_URL=http://mock-lms:8082
EXCHANGE_LMS_PUBLIC_URL=$BASE_URL/mock-lms
DEMO_CMS_TRIGGER_URL=http://mock-cms:8081/__send-application
OUTBOUND_ALLOWED_HOSTS=mock-cms,mock-lms
MOCK_CONTROL_TOKEN=$MOCK_CONTROL_TOKEN
EOF
umask 022

compose() {
	docker compose -p "$PROJECT" --env-file "$OFFLINE_ENV_FILE" --profile stand \
		-f docker-compose.yml -f docker-compose.prod.yml -f scripts/offline/compose.offline-check.yml "$@"
}

cleanup() {
	local code=$?

	if [[ "$KEEP_STACK" == "1" ]]; then
		echo "Стек оставлен (KEEP_STACK=1): docker compose -p $PROJECT down -v, когда станет не нужен"
		echo "Файл переменных прогона: $OFFLINE_ENV_FILE"
	else
		echo
		echo "== Сношу стек $PROJECT вместе с томами"
		compose down -v --remove-orphans || echo "Стек $PROJECT не погас: docker compose -p $PROJECT down -v" >&2
		# Пароли и ключи прогона умирают вместе со стеком.
		rm -f "$OFFLINE_ENV_FILE"
	fi

	printf '\nИтог: %s, %d с. Журнал и выгрузки: %s\n' \
		"$([[ $code -eq 0 ]] && echo 'ПРОЙДЕНО' || echo "ОТКАЗ (код $code)")" "$((SECONDS - started))" "$OUT_DIR"
}
trap cleanup EXIT

echo "Ревизия: $(git rev-parse --short HEAD 2>/dev/null || echo 'не git')"
echo "Проект: $PROJECT, прокси: $BASE_URL, вывод: $OUT_DIR"

# --- образы -------------------------------------------------------------------

if [[ "$SKIP_BUILD" != "1" ]]; then
	phase "Сборка образов приложения и имитаторов (сеть нужна только здесь)"
	compose build app mock-cms mock-lms
fi

phase "Проверка, что все образы есть локально"
missing=0
while read -r image; do
	if ! docker image inspect "$image" >/dev/null 2>&1; then
		echo "нет образа $image" >&2
		missing=1
	fi
done < <(compose config --images | sort -u)
[[ $missing -eq 0 ]] || fail "не хватает образов: docker pull или docker load из архива (scripts/offline/save-images.sh)"

# --- подъём -------------------------------------------------------------------

up() {
	compose up -d --no-build --pull never --wait --wait-timeout 600
}

# Выход наружу из контейнера обязан упасть: и по имени (нужен DNS), и по адресу.
assert_isolated() {
	local network="${PROJECT}_default"

	[[ "$(docker network inspect "$network" -f '{{.Internal}}')" == "true" ]] ||
		fail "сеть $network не внутренняя"
	echo "сеть $network: internal=true"

	local probe="
const targets = ['https://example.com', 'https://1.1.1.1'];
let reached = false;
for (const url of targets) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
		console.log(url + ': ДОСТУПЕН, код ' + response.status);
		reached = true;
	} catch (error) {
		console.log(url + ': недоступен (' + (error.cause?.code ?? error.name) + ')');
	}
}
process.exit(reached ? 1 : 0);
"
	local service
	for service in app mock-cms; do
		echo "$service:"
		compose exec -T "$service" node --input-type=module -e "$probe" ||
			fail "$service достаёт до интернета"
	done

	echo "gotenberg:"
	local url
	for url in https://example.com https://1.1.1.1; do
		if compose exec -T gotenberg curl -sS -m 8 -o /dev/null "$url" 2>"$OUT_DIR/curl.err"; then
			fail "gotenberg достаёт до $url"
		fi
		echo "$url: недоступен ($(tr -d '\n' <"$OUT_DIR/curl.err"))"
	done
	rm -f "$OUT_DIR/curl.err"
}

assert_health() {
	local body
	body="$(curl -sS --noproxy '*' -m 10 "$BASE_URL/api/health")" || fail "$BASE_URL/api/health не отвечает"
	echo "$BASE_URL/api/health: $body"
	[[ "$body" == *'"status":"ok"'* ]] || fail "health не ok"
}

phase "Подъём стека в изолированной сети"
up
compose ps --format 'table {{.Service}}\t{{.Status}}'

phase "Проверка изоляции: выхода наружу нет"
assert_isolated
assert_health

# Взаимодействие для сценария обучения: активное, у демонстрационного
# менеджера, с основной стороной и уже заведённым потоком — панель «Система
# обучения» карточка показывает там, где потоки есть или стадия ждёт данных
# обучения. Одна программа и не больше одного продукта — форма заявки потока
# тогда подставляет их сама.
LMS_INTERACTION="$(compose exec -T postgres psql -U lct -d lct -Atc "
	select i.id from interactions i
	join workspaces w on w.id = i.workspace_id
	join users u on u.id = i.owner_user_id
	where i.status = 'active' and w.key = 'b2b' and u.email = 'manager@demo.lct-crm.local'
		and exists (select 1 from interaction_parties p where p.interaction_id = i.id and p.is_primary)
		and exists (select 1 from learning_groups g where g.interaction_id = i.id)
		and (select count(*) from interaction_programs x where x.interaction_id = i.id) = 1
		and (select count(*) from interaction_products x where x.interaction_id = i.id) <= 1
	order by i.title limit 1")"
[[ -n "$LMS_INTERACTION" ]] || fail "в наборе нет взаимодействия для сценария обучения"

playwright() {
	OFFLINE_BASE_URL="$BASE_URL" \
		OFFLINE_OUT_DIR="$OUT_DIR" \
		OFFLINE_DEMO_PASSWORD="$DEMO_PASSWORD" \
		OFFLINE_MOCK_CONTROL_TOKEN="$MOCK_CONTROL_TOKEN" \
		OFFLINE_LMS_INTERACTION="$LMS_INTERACTION" \
		pnpm exec playwright test -c scripts/offline/playwright.offline.config.ts "$@"
}

phase "Основные сценарии в браузере (@full)"
playwright --grep @full

# --- перезапуск ---------------------------------------------------------------

phase "Перезапуск стека с сохранёнными томами"
compose down
up

phase "После перезапуска: изоляция, здоровье, вход и карточка (@restart)"
assert_isolated
assert_health
playwright --grep @restart
