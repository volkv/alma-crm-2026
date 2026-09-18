#!/usr/bin/env bash
#
# Нагрузочный прогон целиком: стенд, набор, сценарии, отчёт, уборка.
#
#   scripts/load/run.sh up        поднять нагрузочный стенд и залить набор
#   scripts/load/run.sh probe     короткая проба (5 VU, 30 с) — проверить сценарий
#   scripts/load/run.sh cache     замер кэша повторного открытия карточки (F13)
#   scripts/load/run.sh full      полный прогон обоих сценариев
#   scripts/load/run.sh down      погасить стенд и снести его тома
#
# Стенд поднимается под своим именем проекта (`lct-load`) и на своих портах:
# см. `scripts/load/compose.load.yml`. Результаты k6 складываются в каталог,
# заданный `OUT` (по умолчанию — временный), и туда же уезжает сводка JSON.
#
# k6 в репозитории нет и быть не может: это не пакет npm, а отдельный бинарь.
# Он запускается контейнером `grafana/k6` в сети хоста — приложение стенда
# опубликовано на 127.0.0.1, и из своей сети контейнер до него не дотянулся бы.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT=lct-load
COMPOSE=(docker compose -p "$PROJECT" --env-file scripts/load/load.env
	-f docker-compose.yml -f docker-compose.prod.yml -f scripts/load/compose.load.yml)

BASE_URL="${BASE_URL:-http://localhost:3100}"
PASSWORD="${PASSWORD:-Load-Password-2026!}"
OUT="${OUT:-$(mktemp -d -t lct-load-XXXXXX)}"

cd "$ROOT"

fixture() {
	mkdir -p "$OUT"
	"${COMPOSE[@]}" exec -T app node scripts/load/fixture.ts >"$OUT/fixture.json"
	echo "фикстура: $OUT/fixture.json"
}

# Счётчик заходов с адреса живёт пятнадцать минут и общий на все VU: без сброса
# второй прогон подряд упёрся бы в лимит начала входа, а не в производительность.
reset_login_limit() {
	"${COMPOSE[@]}" exec -T redis sh -c 'redis-cli --scan --pattern "login_ip:*" | xargs -r redis-cli del' >/dev/null
}

k6() {
	local script="$1"
	shift
	# Тем же пользователем, что и хозяин каталога: иначе сводку в него не
	# записать, а образ k6 работает под своим uid.
	docker run --rm --network host --user "$(id -u):$(id -g)" \
		-v "$ROOT/scripts/load:/scripts:ro" -v "$OUT:/out" \
		-e BASE_URL="$BASE_URL" -e PASSWORD="$PASSWORD" -e FIXTURE=/out/fixture.json "$@" \
		grafana/k6 run "/scripts/$script" \
		--summary-export "/out/${script%.js}.json" \
		--summary-time-unit ms
}

case "${1:-full}" in
up)
	"${COMPOSE[@]}" up -d --build
	"${COMPOSE[@]}" exec -T app node scripts/seed/index.ts --load
	fixture
	;;
probe)
	fixture
	reset_login_limit
	k6 browse.js -e VUS=5 -e DURATION=30s
	;;
cache)
	fixture
	reset_login_limit
	k6 cache.js -e PAIRS="${PAIRS:-40}" | tee "$OUT/cache.txt"
	;;
full)
	fixture
	reset_login_limit
	k6 browse.js -e VUS="${VUS:-50}" -e DURATION="${DURATION:-3m}" | tee "$OUT/browse.txt"
	reset_login_limit
	k6 reports.js -e REPORT_VUS="${REPORT_VUS:-10}" -e REPORT_DURATION="${REPORT_DURATION:-2m}" |
		tee "$OUT/reports.txt"
	echo "результаты: $OUT"
	;;
down)
	"${COMPOSE[@]}" down -v
	;;
*)
	echo "неизвестная команда: $1" >&2
	exit 2
	;;
esac
