#!/usr/bin/env bash
#
# Пересборка картинок модели архитектуры из `lct-crm.archimate`.
#
#   bash docs/archi/export.sh            # PNG каждого вида рядом с моделью
#   bash docs/archi/export.sh --report ~/archi-report   # плюс HTML-отчёт целиком
#
# Скрипт запускает Archi в headless-режиме внутри контейнера: своего Archi, Java
# и графической подсистемы на машине не требуется, нужен только Docker. Сам Archi
# скачивается один раз с github.com/archimatetool и кладётся в кэш
# (`$ARCHI_CACHE`, по умолчанию `${TMPDIR:-/tmp}/archi-dist`).
#
# Картинки видов берутся из HTML-отчёта Archi: команда `--html.createReport`
# рисует каждый вид в PNG. Отдельного экспорта картинок у консольного Archi нет —
# он живёт в плагине jArchi, который в этот образ не ставится.
set -euo pipefail

ARCHI_VERSION="${ARCHI_VERSION:-5.10.0}"
ARCHI_IMAGE="${ARCHI_IMAGE:-lct-archi:${ARCHI_VERSION}}"
ARCHI_CACHE="${ARCHI_CACHE:-${TMPDIR:-/tmp}/archi-dist}"
ARCHI_TARBALL="Archi-Linux64-${ARCHI_VERSION}.tgz"
ARCHI_URL="https://github.com/archimatetool/archi.io/releases/download/${ARCHI_VERSION%.*}_${ARCHI_VERSION##*.}/${ARCHI_TARBALL}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="${DIR}/lct-crm.archimate"
MODEL_ID="id-lct-crm-model"
REPORT_KEEP=""

# Вид модели → имя картинки рядом с моделью.
VIEWS=(
	"id-view-business:business.png"
	"id-view-application:application.png"
	"id-view-technology:technology.png"
)

while [[ $# -gt 0 ]]; do
	case "$1" in
	--report)
		REPORT_KEEP="${2:?--report ждёт каталог}"
		shift 2
		;;
	*)
		echo "неизвестный аргумент: $1" >&2
		exit 2
		;;
	esac
done

command -v docker >/dev/null || {
	echo "нужен docker" >&2
	exit 1
}
[[ -f "$MODEL" ]] || {
	echo "нет файла модели: $MODEL" >&2
	exit 1
}

mkdir -p "$ARCHI_CACHE"
if [[ ! -f "${ARCHI_CACHE}/${ARCHI_TARBALL}" ]]; then
	echo "качаю Archi ${ARCHI_VERSION} → ${ARCHI_CACHE}/${ARCHI_TARBALL}"
	curl -fsSL --retry 3 -o "${ARCHI_CACHE}/${ARCHI_TARBALL}.part" "$ARCHI_URL"
	mv "${ARCHI_CACHE}/${ARCHI_TARBALL}.part" "${ARCHI_CACHE}/${ARCHI_TARBALL}"
fi

# Образ: Debian + GTK и Xvfb (Archi рисует виды через SWT, а SWT нужен дисплей),
# сам Archi приезжает распакованным архивом и несёт свою JRE.
cat >"${ARCHI_CACHE}/Dockerfile" <<'DOCKERFILE'
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0 libglib2.0-0 libgl1 libx11-6 libxext6 libxrender1 libxtst6 libxi6 \
      libnss3 libasound2 libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
      xvfb xauth fontconfig fonts-dejavu-core fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG ARCHI_TARBALL
ADD ${ARCHI_TARBALL} /opt/

WORKDIR /work
DOCKERFILE

echo "собираю образ ${ARCHI_IMAGE}"
docker build --quiet \
	--build-arg "ARCHI_TARBALL=${ARCHI_TARBALL}" \
	-t "$ARCHI_IMAGE" "$ARCHI_CACHE" >/dev/null

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "${WORK}/home" "${WORK}/ws" "${WORK}/report"
cp "$MODEL" "${WORK}/model.archimate"

echo "запускаю Archi в headless-режиме"
docker run --rm \
	--user "$(id -u):$(id -g)" \
	-e HOME=/work/home \
	-e LANG=C.UTF-8 \
	-e LC_ALL=C.UTF-8 \
	-v "${WORK}:/work" \
	"$ARCHI_IMAGE" \
	bash -c '
		Xvfb :99 -screen 0 1600x1200x24 -nolisten tcp >/work/xvfb.log 2>&1 &
		sleep 2
		export DISPLAY=:99
		/opt/Archi/Archi \
			-application com.archimatetool.commandline.app \
			-consoleLog -nosplash -data /work/ws \
			--loadModel /work/model.archimate \
			--html.createReport /work/report
	' 2>&1 | { grep -vE 'SessionManagerDBus|incubator modules' || true; }
# Отказ Archi виден здесь: pipefail отдаёт код docker run, а не grep.

IMAGES="${WORK}/report/${MODEL_ID}/images"
for pair in "${VIEWS[@]}"; do
	src="${IMAGES}/${pair%%:*}.png"
	dst="${DIR}/${pair##*:}"
	[[ -f "$src" ]] || {
		echo "Archi не нарисовал вид ${pair%%:*}" >&2
		exit 1
	}
	cp "$src" "$dst"
	printf '%s — %s байт\n' "$dst" "$(stat -c %s "$dst")"
done

if [[ -n "$REPORT_KEEP" ]]; then
	mkdir -p "$REPORT_KEEP"
	cp -r "${WORK}/report/." "$REPORT_KEEP/"
	echo "HTML-отчёт: ${REPORT_KEEP}/index.html"
fi
