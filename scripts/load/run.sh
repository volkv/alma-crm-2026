#!/usr/bin/env bash
#
# Нагрузочный прогон целиком: стенд, набор, сценарии, отчёт, уборка.
#
#   scripts/load/run.sh up        поднять стенд, залить набор, завести команду в каталоге
#   scripts/load/run.sh probe     дымовой прогон (5 VU, 1 мин) — проверить сценарий
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

# Фикстура прогона: кто входит и что открывает (`fixture.ts`). С аргументами
# `<ключ> <VU> <переходов на VU>` она ещё и заводит свежий пул переходов под
# этот прогон — у каждой ступени лестницы свой.
fixture() {
	mkdir -p "$OUT"
	local flags=()
	if [[ $# -gt 0 ]]; then
		flags=(--run "$1" --vus "$2" --per-vu "$3")
	fi
	"${COMPOSE[@]}" exec -T app node scripts/load/fixture.ts "${flags[@]}" >"$OUT/fixture.json"
	echo "фикстура: $OUT/fixture.json"
}

# Длительность в формате k6 (`90s`, `3m`, `1m30s`, `1h`) — в секунды.
seconds() {
	python3 - "$1" <<-'PYTHON'
		import re, sys

		parts = re.fullmatch(r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?', sys.argv[1])
		if parts is None or not any(parts.groups()):
		    sys.exit(f'длительность «{sys.argv[1]}» не в формате k6 (90s, 3m, 1m30s)')
		hours, minutes, secs = (int(value or 0) for value in parts.groups())
		print(hours * 3600 + minutes * 60 + secs)
	PYTHON
}

# Учётные записи нагрузочной команды в каталоге. Сид заводит их в базе CRM, а
# войти можно только записью каталога: она заводится здесь через его
# административный API — с той же почтой (по ней запись каталога связывается с
# записью CRM при первом входе), подтверждённой почтой, ролью realm и паролем
# стенда. Повторный вызов записи не пересоздаёт: новая запись каталога — это
# новый субъект, и CRM не связала бы её с уже связанной строкой.
accounts() {
	KEYCLOAK_URL="$(env_value OIDC_PUBLIC_URL)" \
		KEYCLOAK_REALM="$(env_value OIDC_ISSUER_URL | sed 's|.*/realms/||')" \
		KEYCLOAK_ADMIN="$(env_value KEYCLOAK_ADMIN)" \
		KEYCLOAK_ADMIN_PASSWORD="$(env_value KEYCLOAK_ADMIN_PASSWORD)" \
		PASSWORD="$PASSWORD" python3 - "$OUT/fixture.json" <<-'PYTHON'
			import json, os, sys, time, urllib.error, urllib.parse, urllib.request

			base = os.environ['KEYCLOAK_URL'].rstrip('/')
			realm = os.environ['KEYCLOAK_REALM']
			admin = f'{base}/admin/realms/{realm}'

			# Каталог стоит на петле этой машины: прокси из окружения до него не
			# дотянется и ответит своей ошибкой вместо ответа каталога.
			urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

			def call(method, url, body=None, token=None, form=False):
			    headers = {}
			    data = None
			    if token is not None:
			        headers['Authorization'] = f'Bearer {token}'
			    if body is not None:
			        if form:
			            data = urllib.parse.urlencode(body).encode()
			            headers['Content-Type'] = 'application/x-www-form-urlencoded'
			        else:
			            data = json.dumps(body).encode()
			            headers['Content-Type'] = 'application/json'
			    request = urllib.request.Request(url, data=data, headers=headers, method=method)
			    with urllib.request.urlopen(request, timeout=30) as response:
			        raw = response.read()
			        return json.loads(raw) if raw else None

			# Каталог поднимается дольше приложения: ждём, пока он начнёт выдавать
			# токены, но не бесконечно.
			for attempt in range(60):
			    try:
			        token = call('POST', f'{base}/realms/master/protocol/openid-connect/token', {
			            'grant_type': 'password',
			            'client_id': 'admin-cli',
			            'username': os.environ['KEYCLOAK_ADMIN'],
			            'password': os.environ['KEYCLOAK_ADMIN_PASSWORD'],
			        }, form=True)['access_token']
			        break
			    except urllib.error.HTTPError:
			        # Каталог ответил, но отказал — ждать тут нечего.
			        raise
			    except (urllib.error.URLError, ConnectionError) as error:
			        last = error
			        time.sleep(2)
			else:
			    sys.exit(f'каталог учётных записей не выдал токен администратора: {last}')

			roles = {}
			created = 0

			team = json.load(open(sys.argv[1]))['accounts']

			for account in team:
			    found = call('GET', f"{admin}/users?exact=true&username={urllib.parse.quote(account['login'])}", token=token)
			    if not found:
			        call('POST', f'{admin}/users', {
			            'username': account['login'],
			            'email': account['email'],
			            'firstName': account['firstName'],
			            'lastName': account['lastName'],
			            'enabled': True,
			            'emailVerified': True,
			            'requiredActions': [],
			        }, token=token)
			        found = call('GET', f"{admin}/users?exact=true&username={urllib.parse.quote(account['login'])}", token=token)
			        created += 1
			    user_id = found[0]['id']
			    call('PUT', f'{admin}/users/{user_id}/reset-password', {
			        'type': 'password', 'value': os.environ['PASSWORD'], 'temporary': False,
			    }, token=token)
			    role = account['realmRole']
			    if role not in roles:
			        roles[role] = call('GET', f'{admin}/roles/{urllib.parse.quote(role)}', token=token)
			    call('POST', f'{admin}/users/{user_id}/role-mappings/realm', [roles[role]], token=token)

			print(f'каталог: записей команды {len(team)}, заведено сейчас {created}')
		PYTHON
}

# Сверка «сервер ответил success» с «в базе появилось». k6 считает принятые
# сервером переходы и комментарии (`applied_*` в сводке), `fixture.ts --verify`
# — строки, которые прогон с этим ключом оставил в базе. Расхождение значит, что
# сценарий засчитал изменение, которого нет, и числа прогона недействительны.
verify() {
	local key="$1" summary="$2"
	if [[ ! -f "$summary" ]]; then
		echo "сверка: k6 не оставил сводки $summary — прогон не состоялся" >&2
		return 1
	fi
	"${COMPOSE[@]}" exec -T app node scripts/load/fixture.ts --verify "$key" >"$OUT/verify.json"
	python3 - "$summary" "$OUT/verify.json" <<-'PYTHON'
		import json, sys

		metrics = json.load(open(sys.argv[1]))['metrics']
		stored = json.load(open(sys.argv[2]))

		def applied(name):
		    return int(metrics.get(f'applied_{name}', {}).get('count', 0))

		failed = False
		for name, column in (('transition', 'transitions'), ('comment', 'comments')):
		    counted, found = applied(name), stored[column]
		    verdict = 'сходится' if counted == found else 'РАСХОДИТСЯ'
		    failed = failed or counted != found
		    print(f'сверка {name}: k6 принял {counted}, в базе {found} — {verdict}')

		sys.exit(1 if failed else 0)
	PYTHON
}

# Сценарий «пятьдесят пользователей»: свежий пул переходов, прогон, сверка.
# Проход VU длится не меньше четырёх секунд (четыре паузы по секунде), отсюда
# потолок переходов на VU. Статус k6 (порог не выдержан — 99) возвращается
# после сверки: числа несдавшего порог прогона тоже нужно проверить.
browse() {
	local vus="$1" duration="$2" key
	key="$(date +%Y%m%d-%H%M%S)"
	fixture "$key" "$vus" "$(($(seconds "$duration") / 4 + 1))"
	reset_login_limit
	local status=0
	k6 browse.js -e VUS="$vus" -e DURATION="$duration" | tee "$OUT/browse.txt" || status=$?
	verify "$key" "$OUT/browse.json" || status=$?
	return "$status"
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
	accounts
	;;
probe)
	browse "${VUS:-5}" "${DURATION:-1m}"
	echo "результаты: $OUT"
	;;
cache)
	fixture
	reset_login_limit
	k6 cache.js -e PAIRS="${PAIRS:-40}" -e REPORT_PAIRS="${REPORT_PAIRS:-3}" | tee "$OUT/cache.txt"
	;;
browse)
	browse "${VUS:-50}" "${DURATION:-3m}"
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
	status=0
	browse "${VUS:-50}" "${DURATION:-3m}" || status=$?
	reset_login_limit
	k6 reports.js -e REPORT_VUS="${REPORT_VUS:-10}" -e REPORT_DURATION="${REPORT_DURATION:-2m}" |
		tee "$OUT/reports.txt" || status=$?
	echo "результаты: $OUT"
	exit "$status"
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
