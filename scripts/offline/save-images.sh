#!/usr/bin/env bash
#
# Архив образов промышленной установки для переноса в закрытую сеть.
#
# Запускается на машине с доступом к реестрам образов и к пакетам (сборка
# приложения ставит зависимости), из корня репозитория:
#
#   scripts/offline/save-images.sh                 # собрать, скачать и сохранить архив
#   DRY_RUN=1 scripts/offline/save-images.sh       # только показать список образов
#
# Что делает:
#   1. берёт список образов из `docker compose config --images` для промышленного
#      оверлея — тот же набор файлов, которым установка поднимается;
#   2. скачивает сторонние образы (`pull --ignore-buildable`) и собирает образ
#      приложения (`build`);
#   3. сохраняет все образы одним архивом `docker save | gzip` и кладёт рядом
#      список образов и контрольную сумму архива.
#
# На стороне закрытой сети: `docker load -i <архив>` и
# `docker compose … up -d --no-build --pull never` — docs/deployment.md,
# раздел «Установка без интернета».
#
# Переменные окружения:
#   ENV_FILE    файл переменных установки для подстановки в Compose (по умолчанию .env);
#               обязательные переменные промышленного оверлея должны быть заданы —
#               без них Compose не соберёт конфигурацию
#   OUT_DIR     куда положить архив (по умолчанию dist/offline)
#   DRY_RUN     1 — только вывести список образов, ничего не скачивать и не сохранять

set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
OUT_DIR="${OUT_DIR:-dist/offline}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -f docker-compose.yml || ! -f docker-compose.production.yml ]]; then
	echo "Запускать из корня репозитория: рядом нет docker-compose.yml и docker-compose.production.yml" >&2
	exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
	echo "Нет файла переменных $ENV_FILE: задайте ENV_FILE или создайте его по .env.example" >&2
	exit 1
fi

compose=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.production.yml)

mapfile -t images < <("${compose[@]}" config --images | sort -u)

if [[ ${#images[@]} -eq 0 ]]; then
	echo "Compose не назвал ни одного образа: проверьте файлы и $ENV_FILE" >&2
	exit 1
fi

echo "Образы установки (${#images[@]}):"
printf '  %s\n' "${images[@]}"

if [[ "$DRY_RUN" == "1" ]]; then
	exit 0
fi

"${compose[@]}" pull --ignore-buildable
"${compose[@]}" build

for image in "${images[@]}"; do
	if ! docker image inspect "$image" >/dev/null 2>&1; then
		echo "Образа $image нет локально после pull и build" >&2
		exit 1
	fi
done

mkdir -p "$OUT_DIR"
stamp="$(date +%F)"
archive="$OUT_DIR/lct-crm-images-$stamp.tar.gz"

echo "Сохраняю архив $archive …"
docker save "${images[@]}" | gzip >"$archive"
printf '%s\n' "${images[@]}" >"$OUT_DIR/lct-crm-images-$stamp.txt"
(cd "$OUT_DIR" && sha256sum "$(basename "$archive")" >"$(basename "$archive").sha256")

echo "Готово:"
ls -lh "$archive" "$archive.sha256" "$OUT_DIR/lct-crm-images-$stamp.txt"
