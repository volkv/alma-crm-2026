#!/bin/sh
# Вторая база в том же PostgreSQL — под Keycloak.
#
# Хранить его таблицы в базе приложения нельзя: миграции Drizzle ходят по всей
# схеме, а дампы приложения не должны уносить учётные записи каталога. Отдельный
# сервер ради этого поднимать незачем — одна база рядом стоит дешевле.
#
# Скрипт подключён томом в /docker-entrypoint-initdb.d и выполняется образом
# postgres ровно один раз: при инициализации пустого тома. На стенде, который
# уже работает, том не пуст — там базу заводят руками, командой из
# docs/deployment.md, раздел «Keycloak».
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	create database keycloak owner "$POSTGRES_USER";
SQL
