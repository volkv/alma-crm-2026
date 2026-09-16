-- Уникальность «один действующий ответственный на вуз × направление».
-- NULLS NOT DISTINCT: общее назначение (direction_id is null) тоже обязано быть
-- одним, иначе правило ничего не значит. Индекс объявлен здесь, а не в схеме:
-- билдер индексов Drizzle этого ключевого слова не выражает.
CREATE UNIQUE INDEX "organization_responsibles_current_key" ON "organization_responsibles" ("organization_id", "direction_id") NULLS NOT DISTINCT WHERE "valid_to" is null;--> statement-breakpoint
-- Лента карточки, отчёт и перенос сопоставляют записи стадий по ключу из
-- снимка: строка `stages` живёт внутри редакции и меняется с каждой
-- публикацией, а ключ внутри группы — никогда. Индекс по выражению билдер
-- Drizzle тоже не выражает.
CREATE INDEX "stage_entries_snapshot_key_idx" ON "stage_entries" (("stage_snapshot" ->> 'key'));--> statement-breakpoint
-- Две группы процесса, с которыми приезжает система. Это не демонстрационные
-- данные: без них у взаимодействия нет группы, а у заявки с сайта — процесса,
-- поэтому строки кладёт миграция, а не сид.
INSERT INTO "process_groups" ("key", "name", "description", "position") VALUES
	('b2b', 'Учебные заведения', 'Полный цикл работы с вузом: от поиска контактов до контроля исполнения обязательств.', 1),
	('b2c', 'Физические и юридические лица', 'Обучение сотрудников заказчика и частных слушателей.', 2);--> statement-breakpoint
-- Соответствие «вид контрагента → группа». Видов, которые основной стороной не
-- бывают, здесь нет: `customer_company` и `operator` стоят рядом с вузом, но
-- процесс не задают.
INSERT INTO "process_group_counterparty_kinds" ("kind", "group_id")
SELECT source."kind"::"public"."organization_kind", "process_groups"."id"
FROM (VALUES ('educational_institution', 'b2b'), ('legal_entity', 'b2c'), ('individual', 'b2c')) AS source("kind", "group_key")
JOIN "process_groups" ON "process_groups"."key" = source."group_key";--> statement-breakpoint
-- Семейства маршрутов, кроме базового, переезжают по группе на семейство:
-- уникальность `stage_routes` — по паре «ключ + версия», то есть в базе могут
-- лежать несколько независимых процессов. Молча свалить их в одну группу
-- значило бы потерять историю одного из них.
INSERT INTO "process_groups" ("key", "name", "position")
SELECT family."key", family."name", 2 + row_number() OVER (ORDER BY family."key")
FROM (
	SELECT DISTINCT ON ("key") "key", "name" FROM "stage_routes"
	WHERE "key" <> 'university-partnership'
	ORDER BY "key", "version" DESC
) AS family
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Действующая редакция группы — последняя опубликованная в её семействе.
UPDATE "process_groups" SET "active_revision_id" = latest."id"
FROM (
	SELECT DISTINCT ON ("key") "key", "id" FROM "stage_routes"
	WHERE "published_at" IS NOT NULL
	ORDER BY "key", "version" DESC
) AS latest
WHERE latest."key" = CASE WHEN "process_groups"."key" = 'b2b' THEN 'university-partnership' ELSE "process_groups"."key" END;--> statement-breakpoint
-- Реестр ключей стадий: ключ считается занятым с момента, когда появилась
-- первая редакция, где он встретился.
INSERT INTO "process_stage_keys" ("group_id", "key", "first_seen_at")
SELECT "process_groups"."id", "stages"."key", min("stage_routes"."created_at")
FROM "stages"
JOIN "stage_routes" ON "stage_routes"."id" = "stages"."route_id"
JOIN "process_groups" ON "process_groups"."key" = CASE WHEN "stage_routes"."key" = 'university-partnership' THEN 'b2b' ELSE "stage_routes"."key" END
GROUP BY "process_groups"."id", "stages"."key"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Группа взаимодействия выводится из семейства его маршрута. Колонка остаётся
-- необязательной: проставлять её при создании начинает задача живого процесса,
-- она же делает её `not null` и убирает `route_id`.
UPDATE "interactions" SET "process_group_id" = "process_groups"."id"
FROM "stage_routes"
JOIN "process_groups" ON "process_groups"."key" = CASE WHEN "stage_routes"."key" = 'university-partnership' THEN 'b2b' ELSE "stage_routes"."key" END
WHERE "stage_routes"."id" = "interactions"."route_id" AND "interactions"."process_group_id" IS NULL;
