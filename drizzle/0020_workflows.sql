-- Процесс выделяется из пространства.
--
-- Сегодня цепочка редакций висит на пространстве (`process_revisions.group_id`),
-- то есть процесс — это и есть история места, и назначить его некуда. Редакции
-- переезжают на собственную таблицу `workflows`, а пространство получает на неё
-- ссылку. Ради одного: один процесс можно назначить нескольким пространствам —
-- два направления по одному сценарию становятся двумя пространствами и одним
-- процессом, а не двумя копиями четырнадцати стадий, которые разъедутся на
-- первой же правке.
--
-- Ключи совпадают, потому что сегодня процесс и место — одно и то же: на каждое
-- пространство заводится процесс с тем же ключом, и по этому ключу всё
-- сшивается обратно. Порядок шагов фиксирован: процессы → ссылка из
-- пространства → редакции и реестр ключей → перенос действующей редакции → и
-- только потом снятие `workspaces.active_revision_id`. Пока колонка на месте,
-- исходное соответствие «пространство → действующая редакция» восстановимо;
-- после удаления — нет.

-- 1. Процесс: описание работы, живущее само по себе. Действующая редакция —
-- его свойство, а не свойство места: публикация переключает процесс одним
-- значением, и это значение обязано быть одно на процесс, а не по одному на
-- каждое пространство, которому он назначен.
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_key_key" UNIQUE("key")
);
--> statement-breakpoint

-- 2. По процессу на каждое пространство — с его ключом, именем и действующей
-- редакцией.
INSERT INTO "workflows" ("key", "name", "description", "active_revision_id")
SELECT "key", "name", "description", "active_revision_id" FROM "workspaces";--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_active_revision_id_process_revisions_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."process_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- 3. Пространство ссылается на процесс, и ссылка допускает пустоту: иначе
-- создание пространства требовало бы готового процесса заранее, а «процесс не
-- назначен» — законное состояние, которое доска объясняет словами.
ALTER TABLE "workspaces" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
UPDATE "workspaces" w SET "workflow_id" = f."id" FROM "workflows" f WHERE f."key" = w."key";--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- 4. Редакция — версия процесса, а не места. Внешний ключ снимается до
-- переименования колонки: он указывает на другую таблицу, и переименование
-- оставило бы имя, которое врёт.
ALTER TABLE "process_revisions" DROP CONSTRAINT "process_revisions_group_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "process_revisions" RENAME COLUMN "group_id" TO "workflow_id";--> statement-breakpoint
UPDATE "process_revisions" r SET "workflow_id" = f."id"
FROM "workspaces" w
JOIN "workflows" f ON f."key" = w."key"
WHERE w."id" = r."workflow_id";--> statement-breakpoint
ALTER TABLE "process_revisions" ADD CONSTRAINT "process_revisions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_revisions" RENAME CONSTRAINT "process_revisions_group_version_key" TO "process_revisions_workflow_version_key";--> statement-breakpoint
ALTER INDEX "process_revisions_one_draft_per_group" RENAME TO "process_revisions_one_draft_per_workflow";--> statement-breakpoint

-- 5. Идентичность стадии становится парой «процесс + ключ». Это не побочный
-- эффект переноса, а условие осмысленности: если два пространства работают по
-- одному процессу, стадия `signing` в них — одна и та же стадия, и отчёт по ним
-- складывается.
ALTER TABLE "process_stage_keys" DROP CONSTRAINT "process_stage_keys_group_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "process_stage_keys" RENAME COLUMN "group_id" TO "workflow_id";--> statement-breakpoint
UPDATE "process_stage_keys" k SET "workflow_id" = f."id"
FROM "workspaces" w
JOIN "workflows" f ON f."key" = w."key"
WHERE w."id" = k."workflow_id";--> statement-breakpoint
ALTER TABLE "process_stage_keys" ADD CONSTRAINT "process_stage_keys_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_stage_keys" RENAME CONSTRAINT "process_stage_keys_group_id_key_pk" TO "process_stage_keys_workflow_id_key_pk";--> statement-breakpoint

-- 6. Проверка постусловия до снятия колонки: у каждого пространства с процессом
-- действующая редакция процесса — та же, что была у пространства. Пока колонка
-- на месте, отказ здесь оставляет данные восстановимыми; после её удаления —
-- нет.
DO $$
DECLARE
	stray integer;
BEGIN
	SELECT count(*) INTO stray
	FROM "workspaces" w
	LEFT JOIN "workflows" f ON f."id" = w."workflow_id"
	WHERE w."workflow_id" IS NULL
		OR f."active_revision_id" IS DISTINCT FROM w."active_revision_id";

	IF stray > 0 THEN
		RAISE EXCEPTION 'Выделение процесса: у % пространств процесс не назначен или его действующая редакция разошлась с прежней', stray;
	END IF;
END $$;--> statement-breakpoint

-- 7. Действующая редакция уходит из пространства насовсем.
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_active_revision_id_process_revisions_id_fk";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "active_revision_id";
