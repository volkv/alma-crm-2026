#!/usr/bin/env bash
# Динамическое сканирование: OWASP ZAP baseline против собранного образа
# приложения, поднятого в отдельном стеке (docs/security.md, «Динамическое
# сканирование»).
#
#   pnpm run check:dast
#
# Что делает:
#   1. поднимает стек `lct-dast` из docker-compose.yml и
#      scripts/dast/compose.dast.yml — тот же образ из Dockerfile, демонстрационные
#      данные, ни одного порта на хосте;
#   2. гоняет zap-baseline.py дважды, контейнером в сети стека: без входа
#      (публичная часть) и с сессией демонстрационной записи (всё, что видит
#      вошедший). Сессию открывает scripts/dast/login.py полным входом через
#      каталог, ZAP подставляет её заголовком Cookie в каждый запрос;
#   3. печатает сводку, складывает отчёты в DAST_REPORT_DIR и гасит стек
#      вместе с томами.
#
# Режим пассивный: паук ходит только GET-запросами (отправка форм выключена),
# атак ZAP не шлёт, а находки собирает по ответам. Публичный стенд этим
# скриптом не сканируется — цель всегда контейнер `app` своего стека.
#
# Код возврата: 0 — ни одного правила уровня FAIL (WARN в отчёте, но сборку не
# валят); 1 — сработало правило FAIL из scripts/dast/rules.conf; 3 — сканер
# не отработал (ошибка ZAP, не открылась сессия, не поднялся стек).
#
# Переменные окружения:
#   DAST_REPORT_DIR      куда сложить отчёты (по умолчанию /tmp/lct-crm-dast)
#   DAST_PROJECT         имя проекта Compose (по умолчанию lct-dast)
#   DAST_SPIDER_MINUTES  сколько минут ходит паук в каждом проходе (по умолчанию 3)
#   DAST_USER            демонстрационная запись для прохода с входом (admin)
#   DAST_PASSWORD        её пароль (умолчание стека, lct-demo-2026)
#   DAST_ZAP_IMAGE       образ сканера
#   DAST_ZAP_CPUS        сколько ядер отдать ZAP (по умолчанию 4: машина общая)
#   DAST_ZAP_TIMEOUT     предел одного прохода в секундах (по умолчанию 1800)
#   DAST_KEEP_STACK=1    не гасить стек после прогона (разбор находок руками)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAST_DIR="$ROOT/scripts/dast"
REPORT_DIR="${DAST_REPORT_DIR:-/tmp/lct-crm-dast}"
PROJECT="${DAST_PROJECT:-lct-dast}"
SPIDER_MINUTES="${DAST_SPIDER_MINUTES:-3}"
USER_NAME="${DAST_USER:-admin}"
USER_PASSWORD="${DAST_PASSWORD:-lct-demo-2026}"
# Версия закреплена, как у остальных сканеров: `stable` сегодня и через месяц —
# разные наборы правил, и отчёты перестали бы сравниваться.
ZAP_IMAGE="${DAST_ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:2.17.0}"
ZAP_CPUS="${DAST_ZAP_CPUS:-4}"
ZAP_TIMEOUT="${DAST_ZAP_TIMEOUT:-1800}"
TARGET='http://app:3000'
NETWORK="${PROJECT}_default"

# `--env-file /dev/null`: стек сканирования берёт умолчания docker-compose.yml,
# а не `.env` разработчика. Иначе пароль демонстрационных записей, режим демо
# и ключи зависели бы от того, чья это машина.
compose() {
	docker compose -p "$PROJECT" --env-file /dev/null \
		-f "$ROOT/docker-compose.yml" -f "$DAST_DIR/compose.dast.yml" "$@"
}

cleanup() {
	if [[ "${DAST_KEEP_STACK:-0}" == 1 ]]; then
		echo "Стек оставлен: docker compose -p $PROJECT ... down -v, когда станет не нужен"
		return
	fi
	echo '==> Гашу стек сканирования'
	if ! compose down -v --remove-orphans >/dev/null 2>&1; then
		echo "Стек $PROJECT не погас — погасите руками: docker compose -p $PROJECT down -v" >&2
	fi
}
trap cleanup EXIT

mkdir -p "$REPORT_DIR"
# ZAP в контейнере пишет отчёты от своего пользователя (uid 1000).
chmod 777 "$REPORT_DIR"
cp "$DAST_DIR/rules.conf" "$REPORT_DIR/rules.conf"

echo "==> Поднимаю стек $PROJECT (сборка образа приложения)"
if ! compose up -d --build --wait --wait-timeout 600 app; then
	echo 'Стек не поднялся' >&2
	exit 3
fi

echo "==> Вхожу записью $USER_NAME"
if ! SESSION_COOKIE="$(
	docker run --rm --network "$NETWORK" \
		-e DAST_TARGET="$TARGET" -e DAST_USER="$USER_NAME" -e DAST_PASSWORD="$USER_PASSWORD" \
		-v "$DAST_DIR/login.py:/zap/login.py:ro" \
		"$ZAP_IMAGE" python3 /zap/login.py
)"; then
	echo 'Сессия не открылась — проход с входом невозможен' >&2
	exit 3
fi

# Паук не отправляет формы: baseline по умолчанию шлёт их POST-запросом, а в
# проходе с входом это были бы настоящие изменения данных. Опции `-config`
# паука действуют только в классическом режиме zap-baseline.py (`--autooff`):
# план Automation Framework задаёт пауку свои умолчания поверх них.
SPIDER_OPTIONS='-config spider.postform=false'

# Заголовок Cookie подставляет правило замены ZAP — в каждый запрос, включая
# запросы паука. Значение сессии уходит в конфигурацию одного контейнера и
# живёт, пока жив стек.
AUTH_OPTIONS="$SPIDER_OPTIONS"
AUTH_OPTIONS+=' -config replacer.full_list(0).description=session'
AUTH_OPTIONS+=' -config replacer.full_list(0).enabled=true'
AUTH_OPTIONS+=' -config replacer.full_list(0).matchtype=REQ_HEADER'
AUTH_OPTIONS+=' -config replacer.full_list(0).matchstr=Cookie'
AUTH_OPTIONS+=' -config replacer.full_list(0).regex=false'
AUTH_OPTIONS+=" -config replacer.full_list(0).replacement=$SESSION_COOKIE"

# Один проход zap-baseline.py. `-I`: WARN не меняет код возврата — отказ дают
# только правила, переведённые в FAIL в rules.conf. Проход ограничен по
# времени: ZAP на старте докачивает дополнения из сети и однажды завис на этом
# шаге на двадцать минут — без предела такой прогон молча держал бы машину.
scan() {
	local name="$1" options="$2" container="$PROJECT-zap-$1"

	echo "==> ZAP baseline: проход «$name»"
	set +e
	timeout "$ZAP_TIMEOUT" docker run --rm --name "$container" --network "$NETWORK" \
		--cpus "$ZAP_CPUS" -v "$REPORT_DIR:/zap/wrk:rw" \
		"$ZAP_IMAGE" zap-baseline.py --autooff -t "$TARGET/" -c rules.conf \
		-m "$SPIDER_MINUTES" -I -r "zap-$name.html" -J "zap-$name.json" -w "zap-$name.md" \
		-z "$options" 2>&1 | tee "$REPORT_DIR/zap-$name.log"
	local code="${PIPESTATUS[0]}"
	set -e
	if [[ "$code" == 124 ]]; then
		echo "Проход «$name» не уложился в $ZAP_TIMEOUT с" >&2
		docker rm -f "$container" >/dev/null
	fi
	return "$code"
}

# Проход с входом доказателен, только если сессия пережила его: паук, выбитый
# на страницу входа, дал бы чистый отчёт по одной странице.
session_alive() {
	local code
	code="$(docker run --rm --network "$NETWORK" "$ZAP_IMAGE" \
		curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $SESSION_COOKIE" "$TARGET/")"
	[[ "$code" == 200 ]]
}

status=0
for pass in anon auth; do
	if [[ "$pass" == anon ]]; then options="$SPIDER_OPTIONS"; else options="$AUTH_OPTIONS"; fi
	if scan "$pass" "$options"; then
		code=0
	else
		code=$?
	fi
	case "$code" in
		0) ;;
		1) status=1 ;;
		*)
			echo "ZAP завершился с кодом $code в проходе «$pass»" >&2
			exit 3
			;;
	esac
done

if ! session_alive; then
	echo 'Сессия погасла во время прохода с входом — отчёт «auth» неполон' >&2
	exit 3
fi

echo
echo '==> Сводка'
for pass in anon auth; do
	urls="$(grep -o 'Total of [0-9]* URLs' "$REPORT_DIR/zap-$pass.log" || echo 'Total of ? URLs')"
	summary="$(grep 'FAIL-NEW:' "$REPORT_DIR/zap-$pass.log" | tr '\t' ' ')"
	printf '%-5s %s; %s\n' "$pass" "$urls" "$summary"
done
echo "Отчёты: $REPORT_DIR/zap-{anon,auth}.{html,json,md,log}"

exit "$status"
