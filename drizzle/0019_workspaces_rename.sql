-- Группа процесса становится пространством.
--
-- Переименование, а не пересоздание: `process_groups` уже хранит ровно то, чем
-- должно быть пространство — ключ, имя, описание, порядок в списке, — и на её
-- строки ссылаются взаимодействия, редакции и реестр ключей стадий. `alter
-- table … rename` сохраняет данные, внешние ключи и индексы; «создать рядом и
-- перенести» дало бы новые идентификаторы всему, что уже идёт.
--
-- Имена ограничений и индексов приводятся к новому имени таблицы: иначе на
-- свежей установке и на обновлённой они разные, и следующая миграция, которая
-- сошлётся на имя, сработает только на одной из них.

-- 1. Таблица и её собственные имена.
ALTER TABLE "process_groups" RENAME TO "workspaces";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "process_groups_pkey" TO "workspaces_pkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "process_groups_key_key" TO "workspaces_key_key";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "process_groups_position_key" TO "workspaces_position_key";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "process_groups_active_revision_id_process_revisions_id_fk" TO "workspaces_active_revision_id_process_revisions_id_fk";--> statement-breakpoint

-- 2. Взаимодействие идёт в пространстве. Внешний ключ Postgres переносит сам,
-- но его имя врало бы о таблице, на которую он указывает.
ALTER TABLE "interactions" RENAME COLUMN "process_group_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "interactions" RENAME CONSTRAINT "interactions_process_group_id_process_groups_id_fk" TO "interactions_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "interactions_group_status_idx" RENAME TO "interactions_workspace_status_idx";--> statement-breakpoint

-- 3. Имена внешних ключей, приезжающих в пространство со стороны. Сами колонки
-- остаются `group_id`: редакции и реестр ключей переедут на процесс следующей
-- миграцией, и переименовывать их дважды незачем.
ALTER TABLE "process_revisions" RENAME CONSTRAINT "process_revisions_group_id_process_groups_id_fk" TO "process_revisions_group_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "process_stage_keys" RENAME CONSTRAINT "process_stage_keys_group_id_process_groups_id_fk" TO "process_stage_keys_group_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "process_group_counterparty_kinds" RENAME CONSTRAINT "process_group_counterparty_kinds_group_id_process_groups_id_fk" TO "process_group_counterparty_kinds_group_id_workspaces_id_fk";
