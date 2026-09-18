#!/usr/bin/env bash
#
# Сканирование безопасности: код, зависимости, собранный образ и SBOM.
# Запускается одинаково на машине разработчика и в CI (`.github/workflows/ci.yml`,
# задача `security`) — оба зовут именно этот файл, поэтому набор проверок один.
#
#   semgrep      — правила под код проекта и правила на секреты по исходникам
#   trivy fs     — уязвимости зависимостей по `pnpm-lock.yaml` (вместе с devDependencies)
#   trivy image  — уязвимости собранного образа: пакеты Alpine и node_modules внутри
#   trivy convert — те же отчёты в SARIF и SBOM в формате CycloneDX
#
# Порог отказа:
#   semgrep      — находки уровня ERROR;
#   trivy        — CRITICAL и HIGH, для которых уже вышло исправление (`--ignore-unfixed`).
# Всё, что ниже порога или без исправления, попадает в отчёты и в сводку, но сборку не валит:
# чинить нечего, а красный гейт без действия перестают читать.
#
# Отчёты складываются в $SECURITY_REPORT_DIR (по умолчанию — каталог во временных файлах,
# чтобы рабочее дерево оставалось чистым); CI задаёт свой путь и выгружает его артефактом.
#
# Переменные окружения:
#   SECURITY_REPORT_DIR  куда положить отчёты (по умолчанию /tmp/lct-crm-security)
#   SECURITY_IMAGE       тег образа под сканирование (по умолчанию lct-crm:ci)
#   SECURITY_SKIP_BUILD  1 — не собирать образ, взять уже собранный с этим тегом
#   SECURITY_TRIVY_CACHE где держать базу уязвимостей Trivy между запусками

set -euo pipefail

# Версии сканеров закреплены: иначе один и тот же код даёт разные отчёты на разных
# машинах. На свежесть находок это не влияет — базу уязвимостей Trivy и правила
# semgrep тянут из сети на каждом запуске. Поднимать версии — руками, вместе с
# перепроверкой чисел в `docs/security.md`.
SEMGREP_IMAGE=${SEMGREP_IMAGE:-semgrep/semgrep:1.176.1}
TRIVY_IMAGE=${TRIVY_IMAGE:-aquasec/trivy:0.74.0}

# Наборы правил semgrep.
#
# `p/default` — правила под все языки проекта разом: TypeScript, JavaScript,
# конфигурации workflow и менеджера пакетов. Отдельные `p/typescript` и
# `p/javascript` он включает целиком: добавление их к `p/default` даёт ровно одно
# лишнее правило и ноль лишних находок (проверено на этом дереве).
#
# `p/gitleaks` — правила на секреты. Набор `p/secrets` из открытого реестра сюда
# не годится: на подсаженный в файл ключ AWS и на `eval()` он не реагирует вовсе,
# а правила gitleaks ключ находят. Проверять сканер подсадкой находки — часть
# работы: молчащий сканер выглядит так же, как чистый код.
#
# Набора под Svelte в реестре нет, и сам semgrep разметку `.svelte` не разбирает —
# это записано в «чего проверки не покрывают» в `docs/security.md`.
SEMGREP_CONFIGS=(--config p/default --config p/gitleaks)

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
REPORT_DIR=${SECURITY_REPORT_DIR:-/tmp/lct-crm-security}
IMAGE=${SECURITY_IMAGE:-lct-crm:ci}
TRIVY_CACHE=${SECURITY_TRIVY_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/trivy-lct}

case $REPORT_DIR in
	/*) ;;
	*) REPORT_DIR=$REPO_ROOT/$REPORT_DIR ;;
esac

mkdir -p "$REPORT_DIR" "$TRIVY_CACHE"

# Прокси пробрасывается, если он есть в окружении: без него за корпоративным
# периметром не скачать ни правила, ни базу уязвимостей.
proxy_env=()
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
	if [ -n "${!name:-}" ]; then
		proxy_env+=(--env "$name=${!name}")
	fi
done

# Контейнеры пишут отчёты от имени хозяина каталога, иначе локальный прогон
# оставляет файлы root'а. $HOME внутри контейнера при этом недоступен — отсюда
# явные --cache-dir у Trivy и HOME=/tmp у semgrep.
as_host_user=(--user "$(id -u):$(id -g)" --env HOME=/tmp)

failures=()

heading() {
	printf '\n\033[1m=== %s ===\033[0m\n' "$1"
}

semgrep_run() {
	docker run --rm "${as_host_user[@]}" "${proxy_env[@]}" \
		--volume "$REPO_ROOT:/src:ro" \
		--volume "$REPORT_DIR:/out" \
		--workdir /src \
		"$SEMGREP_IMAGE" semgrep scan --metrics=off "${SEMGREP_CONFIGS[@]}" "$@"
}

trivy_run() {
	docker run --rm "${as_host_user[@]}" "${proxy_env[@]}" \
		--volume "$TRIVY_CACHE:/trivy-cache" \
		--volume "$REPO_ROOT:/src:ro" \
		--volume "$REPORT_DIR:/out" \
		"$TRIVY_IMAGE" --cache-dir /trivy-cache "$@"
}

# Сканирование образа идёт через сокет демона, поэтому контейнеру нужна группа
# этого сокета — своего доступа у пользователя-хозяина к нему нет.
trivy_image_run() {
	local socket_group
	socket_group=$(stat -c '%g' /var/run/docker.sock)
	docker run --rm "${as_host_user[@]}" --group-add "$socket_group" "${proxy_env[@]}" \
		--volume "$TRIVY_CACHE:/trivy-cache" \
		--volume /var/run/docker.sock:/var/run/docker.sock \
		--volume "$REPORT_DIR:/out" \
		"$TRIVY_IMAGE" --cache-dir /trivy-cache "$@"
}

gate() {
	local name=$1
	shift
	if "$@"; then
		printf 'Порог пройден: %s\n' "$name"
	else
		printf 'ПОРОГ НЕ ПРОЙДЕН: %s\n' "$name"
		failures+=("$name")
	fi
}

if [ "${SECURITY_SKIP_BUILD:-}" = '1' ]; then
	heading "Образ $IMAGE взят готовым"
else
	heading "Сборка образа $IMAGE"
	# `--pull`: базовый образ берётся свежий. Иначе сканируется тот `node:24-alpine`,
	# который однажды скачался на эту машину, и исправленная в нём уязвимость
	# осталась бы «найденной» — или, хуже, найденная не нашлась бы.
	docker build --pull --tag "$IMAGE" "$REPO_ROOT"
fi

heading 'semgrep: код'
semgrep_run --sarif --output /out/semgrep.sarif

heading 'trivy fs: зависимости по pnpm-lock.yaml'
# --include-dev-deps обязателен: интерфейсный рантайм (Kit, bits-ui, chart.js,
# marked, superforms) лежит в devDependencies, и Vite вкладывает его код в build/.
# Без этого флага половина того, что уезжает в образ, осталась бы вне проверки.
# --list-all-pkgs=false оставляет в отчёте об уязвимостях только то, что нашли;
# полный список пакетов — это SBOM, он собирается отдельным прогоном ниже.
trivy_run fs --scanners vuln --include-dev-deps --list-all-pkgs=false \
	--format json --output /out/trivy-fs.json /src/pnpm-lock.yaml
trivy_run convert --scanners vuln --format sarif \
	--output /out/trivy-fs.sarif /out/trivy-fs.json
trivy_run convert --scanners vuln --format table /out/trivy-fs.json
trivy_run fs --scanners vuln --include-dev-deps --skip-db-update \
	--format cyclonedx --output /out/sbom-source.cdx.json /src/pnpm-lock.yaml

heading "trivy image: образ $IMAGE"
trivy_image_run image --scanners vuln --skip-db-update --list-all-pkgs=false \
	--format json --output /out/trivy-image.json "$IMAGE"
trivy_run convert --scanners vuln --format sarif \
	--output /out/trivy-image.sarif /out/trivy-image.json
trivy_run convert --scanners vuln --format table /out/trivy-image.json
trivy_image_run image --scanners vuln --skip-db-update \
	--format cyclonedx --output /out/sbom-image.cdx.json "$IMAGE"

# Пороги считаются отдельными прогонами, а не по отчётам выше: так порог задают
# сами сканеры своими правилами («есть ли исправление» знает Trivy, а не мы).
# База уязвимостей при этом не обновляется — отчёт и порог видят одни данные.
# `--table-mode detailed` молчит, пока порог пройден, и печатает сами находки,
# когда не пройден: полные отчёты уже выведены выше.
heading 'Пороги'
gate 'semgrep: находки уровня ERROR' \
	semgrep_run --severity ERROR --error --quiet
gate 'trivy fs: CRITICAL/HIGH с доступным исправлением' \
	trivy_run fs --scanners vuln --include-dev-deps --skip-db-update \
	--severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 \
	--quiet --table-mode detailed /src/pnpm-lock.yaml
gate 'trivy image: CRITICAL/HIGH с доступным исправлением' \
	trivy_image_run image --scanners vuln --skip-db-update \
	--severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 \
	--quiet --table-mode detailed "$IMAGE"

heading 'Отчёты'
printf 'Каталог: %s\n' "$REPORT_DIR"
printf '  semgrep.sarif          находки по коду\n'
printf '  trivy-fs.{json,sarif}  уязвимости зависимостей\n'
printf '  trivy-image.{json,sarif} уязвимости образа\n'
printf '  sbom-source.cdx.json   SBOM дерева зависимостей (CycloneDX)\n'
printf '  sbom-image.cdx.json    SBOM образа (CycloneDX)\n'

if [ ${#failures[@]} -gt 0 ]; then
	printf '\nНе пройдено порогов: %d\n' "${#failures[@]}"
	printf '  %s\n' "${failures[@]}"
	exit 1
fi

printf '\nВсе пороги пройдены.\n'
