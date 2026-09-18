#!/usr/bin/env bash
#
# Нагрузочный прогон целиком: стенд, набор, сценарии, отчёт, уборка.
#
#   scripts/load/run.sh up        поднять нагрузочный стенд и залить набор
#   scripts/load/run.sh probe     короткая проба (5 VU, 30 с) — проверить сценарий
#   scripts/load/run.sh cache     замер кэша повторного открытия (F13)
#   scripts/load/run.sh browse    сценарий «пятьдесят пользователей» (VUS, DURATION)
#   scripts/load/run.sh reports   сценарий «десять одновременных отчётов»
#   scripts/load/run.sh full      полный прогон обоих сценариев
#   scripts/load/run.sh breakdown <файл>  разложить прогон по шагам сценария
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
ENV_FILE=scripts/load/load.env
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE"
	-f docker-compose.yml -f docker-compose.prod.yml -f scripts/load/compose.load.yml)

cd "$ROOT"

# Файла окружения в репозитории нет: в нём ключ шифрования контактов и пароли
# стенда, и напечатанные в репозитории они не защищают ничего. Без него
# останавливаемся здесь, а не на середине `docker compose up` с сообщением о
# ненайденной переменной.
if [[ ! -f "$ENV_FILE" ]]; then
	echo "нет $ENV_FILE: скопируйте $ENV_FILE.example и заполните значения (scripts/load/README.md)" >&2
	exit 2
fi

# Значение переменной из файла окружения: последнее объявление, как читает его
# и сам Compose.
env_value() {
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

BASE_URL="${BASE_URL:-http://localhost:3100}"
# Тем же паролем сид завёл учётные записи стенда, и им же входит сценарий: две
# набранные порознь строки однажды разъехались бы, и прогон мерил бы отказ входа.
PASSWORD="${PASSWORD:-$(env_value SEED_DEMO_PASSWORD)}"
OUT="${OUT:-$(mktemp -d -t lct-load-XXXXXX)}"

if [[ -z "$PASSWORD" ]]; then
	echo "в $ENV_FILE не задан SEED_DEMO_PASSWORD: сценарию нечем войти" >&2
	exit 2
fi

fixture() {
	mkdir -p "$OUT"
	"${COMPOSE[@]}" exec -T app node scripts/load/fixture.ts >"$OUT/fixture.json"
	echo "фикстура: $OUT/fixture.json"
}

# Счётчик заходов с адреса живёт пятнадцать минут и общий на все VU: без сброса
# второй прогон подряд упёрся бы в лимит начала входа, а не в производительность.
reset_login_limit() {
	# Redis стенда закрыт паролем (`docker-compose.prod.yml`), и свой пароль
	# контейнер знает сам — набирать его здесь второй раз значило бы однажды
	# разойтись с ним.
	"${COMPOSE[@]}" exec -T redis sh -c \
		'redis-cli --no-auth-warning -a "$REDIS_PASSWORD" --scan --pattern "login_ip:*" |
			xargs -r redis-cli --no-auth-warning -a "$REDIS_PASSWORD" del' >/dev/null
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
		--out "json=/out/${script%.js}-raw.json.gz" \
		--summary-time-unit ms
}

# Сводка считает метрики сценария целиком, и на один вопрос она не отвечает:
# шаг «переход по процессу» и шаг «комментарий» лежат в одной метрике, потому
# что для требования это одна операция — отправка формы. Когда надо разделить
# их (или разложить страницы на список, карточку и отчёт), берётся разбивка по
# меткам запроса из сырых точек прогона.
breakdown() {
	local raw="$1"
	python3 - "$raw" <<-'PYTHON'
		import gzip, json, sys
		from collections import defaultdict

		points = defaultdict(list)

		with gzip.open(sys.argv[1], 'rt') as source:
		    for line in source:
		        event = json.loads(line)
		        if event['type'] == 'Point' and event['metric'] == 'http_req_duration':
		            tags = event['data']['tags']
		            points[tags.get('step', '—')].append(event['data']['value'])

		def quantile(values, share):
		    return values[min(int(len(values) * share), len(values) - 1)]

		print(f"{'шаг':<16}{'запросов':>10}{'p50, мс':>10}{'p95, мс':>10}{'max, мс':>10}")
		for step, values in sorted(points.items()):
		    values.sort()
		    print(
		        f'{step:<16}{len(values):>10}{quantile(values, 0.5):>10.0f}'
		        f'{quantile(values, 0.95):>10.0f}{values[-1]:>10.0f}'
		    )
	PYTHON
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
	k6 cache.js -e PAIRS="${PAIRS:-40}" -e REPORT_PAIRS="${REPORT_PAIRS:-3}" | tee "$OUT/cache.txt"
	;;
browse)
	fixture
	reset_login_limit
	k6 browse.js -e VUS="${VUS:-50}" -e DURATION="${DURATION:-3m}" | tee "$OUT/browse.txt"
	echo "результаты: $OUT"
	;;
reports)
	fixture
	reset_login_limit
	k6 reports.js -e REPORT_VUS="${REPORT_VUS:-10}" -e REPORT_DURATION="${REPORT_DURATION:-2m}" |
		tee "$OUT/reports.txt"
	echo "результаты: $OUT"
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
breakdown)
	breakdown "${2:?путь к сырым точкам прогона: <OUT>/browse-raw.json.gz}"
	;;
down)
	"${COMPOSE[@]}" down -v
	;;
*)
	echo "неизвестная команда: $1" >&2
	exit 2
	;;
esac
