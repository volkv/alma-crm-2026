-- Маршруты стадий становятся редакциями процесса группы.
--
-- Таблица переименовывается, а не создаётся заново: на её строки ссылаются
-- стадии, а на стадии — записи истории, и «создать рядом и скопировать» здесь
-- означало бы новые идентификаторы у всего, что уже прошли. Порядок шагов
-- фиксирован: группы → редакции → записи → проверка → и только потом снятие
-- `interactions.route_id`. Пока колонка на месте, исходное соответствие
-- «взаимодействие → редакция» восстановимо; после удаления — нет.

-- 1. Переименование таблицы и её ограничений. Имена ограничений приводятся к
-- новому имени таблицы: иначе на свежей установке и на обновлённой они разные.
ALTER TABLE "stage_routes" RENAME TO "process_revisions";--> statement-breakpoint
ALTER TABLE "process_revisions" RENAME CONSTRAINT "stage_routes_pkey" TO "process_revisions_pkey";--> statement-breakpoint
ALTER TABLE "process_revisions" RENAME COLUMN "description" TO "note";--> statement-breakpoint
ALTER TABLE "process_groups" RENAME CONSTRAINT "process_groups_active_revision_id_stage_routes_id_fk" TO "process_groups_active_revision_id_process_revisions_id_fk";--> statement-breakpoint
ALTER TABLE "stage_migration_rules" RENAME CONSTRAINT "stage_migration_rules_revision_id_stage_routes_id_fk" TO "stage_migration_rules_revision_id_process_revisions_id_fk";--> statement-breakpoint

-- 2. Редакция принадлежит группе. Колонка заводится необязательной, чтобы её
-- заполнил следующий шаг: `not null` ставится после проверки, а не вместо неё.
ALTER TABLE "process_revisions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
UPDATE "process_revisions" SET "group_id" = "process_groups"."id"
FROM "process_groups"
WHERE "process_groups"."key" = CASE
	WHEN "process_revisions"."key" = 'university-partnership' THEN 'b2b'
	ELSE "process_revisions"."key"
END;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "process_revisions" WHERE "group_id" IS NULL) THEN
		RAISE EXCEPTION 'Перенос процесса: у редакции нет группы. Миграция 0006 заводит группу на каждое семейство маршрутов — проверьте, что она применена';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "process_revisions" ALTER COLUMN "group_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "process_revisions" ADD CONSTRAINT "process_revisions_group_id_process_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."process_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 3. Ключ семейства и маршрут по умолчанию исчезают: группа выводится из вида
-- основной стороны, а внутри группы действует ровно одна редакция.
ALTER TABLE "process_revisions" DROP CONSTRAINT "stage_routes_key_version_key";--> statement-breakpoint
ALTER TABLE "process_revisions" DROP COLUMN "key";--> statement-breakpoint
ALTER TABLE "process_revisions" DROP COLUMN "is_default";--> statement-breakpoint
ALTER TABLE "process_revisions" ADD CONSTRAINT "process_revisions_group_version_key" UNIQUE("group_id","version");--> statement-breakpoint

-- 4. У группы остаётся один черновик — последний. Два незаконченных описания
-- одного процесса нечем свести: опубликуются оба, и какое описывает работу,
-- станет вопросом порядка нажатий. Стадии и переходы лишних уходят каскадом;
-- если на стадию черновика ссылается запись истории, `on delete restrict` у
-- `stage_entries.stage_id` остановит миграцию — и это правильный исход.
DELETE FROM "process_revisions" r
WHERE r."published_at" IS NULL
	AND r."id" <> (
		SELECT keep."id" FROM "process_revisions" keep
		WHERE keep."group_id" = r."group_id" AND keep."published_at" IS NULL
		ORDER BY keep."version" DESC
		LIMIT 1
	);--> statement-breakpoint
CREATE UNIQUE INDEX "process_revisions_one_draft_per_group" ON "process_revisions" USING btree ("group_id") WHERE "process_revisions"."published_at" is null;--> statement-breakpoint

-- 5. Стадии и переходы принадлежат редакции, а не маршруту.
ALTER TABLE "stages" RENAME COLUMN "route_id" TO "revision_id";--> statement-breakpoint
ALTER TABLE "stages" RENAME CONSTRAINT "stages_route_id_stage_routes_id_fk" TO "stages_revision_id_process_revisions_id_fk";--> statement-breakpoint
ALTER TABLE "stages" RENAME CONSTRAINT "stages_route_key_key" TO "stages_revision_key_key";--> statement-breakpoint
ALTER TABLE "stages" RENAME CONSTRAINT "stages_route_position_key" TO "stages_revision_position_key";--> statement-breakpoint
ALTER TABLE "stage_transitions" RENAME COLUMN "route_id" TO "revision_id";--> statement-breakpoint
ALTER TABLE "stage_transitions" RENAME CONSTRAINT "stage_transitions_route_id_stage_routes_id_fk" TO "stage_transitions_revision_id_process_revisions_id_fk";--> statement-breakpoint

-- 6. В каждой редакции появляется финальная стадия: процесс без неё нечем
-- закончить, а завершение теперь спрашивает у финальной стадии доказательство
-- исполнения. Финальной становится последняя по порядку — там, где ни одна
-- стадия финальной не отмечена.
UPDATE "stages" s SET "is_final" = true
FROM (
	SELECT DISTINCT ON ("revision_id") "revision_id", "id"
	FROM "stages"
	ORDER BY "revision_id", "position" DESC
) last
WHERE s."id" = last."id"
	AND NOT EXISTS (
		SELECT 1 FROM "stages" other
		WHERE other."revision_id" = s."revision_id" AND other."is_final"
	);--> statement-breakpoint

-- 7. Открытые записи переезжают на стадии действующей редакции своей группы —
-- по ключу, а не по идентификатору: строка `stages` живёт внутри редакции.
-- Закрытые не трогаются: они остались на стадиях тех редакций, при которых их
-- прошли, и их снимки — это то, что видел исполнитель.
UPDATE "stage_entries" e SET "stage_id" = target."id", "updated_at" = now()
FROM "interactions" i
JOIN "process_groups" g ON g."id" = i."process_group_id"
JOIN "stages" target ON target."revision_id" = g."active_revision_id"
JOIN "stages" current ON current."key" = target."key"
WHERE e."interaction_id" = i."id"
	AND e."left_at" IS NULL
	AND current."id" = e."stage_id"
	AND target."id" <> e."stage_id";--> statement-breakpoint

-- 8. В слепке стадии появились два признака. У закрытых записей они
-- проставляются выключенными: это история, и раньше ни того, ни другого
-- требования не существовало. Слепок открытой записи пересобирается по стадии —
-- открытая запись ещё не история, история начинается в момент её закрытия.
UPDATE "stage_entries"
SET "stage_snapshot" = "stage_snapshot" || jsonb_build_object('requiresLmsData', false, 'isFinal', false)
WHERE NOT ("stage_snapshot" ? 'requiresLmsData') OR NOT ("stage_snapshot" ? 'isFinal');--> statement-breakpoint
UPDATE "stage_entries" e SET "stage_snapshot" = jsonb_build_object(
	'key', s."key",
	'name', s."name",
	'position', s."position",
	'category', s."category",
	'slaDays', s."sla_days",
	'staleAfterDays', s."stale_after_days",
	'requiresResult', s."requires_result",
	'requiresConfirmation', s."requires_confirmation",
	'requiresLmsData', s."requires_lms_data",
	'isFinal', s."is_final",
	'checklist', s."checklist"
)
FROM "stages" s
WHERE s."id" = e."stage_id" AND e."left_at" IS NULL;--> statement-breakpoint

-- 9. Проверка постусловия до снятия `route_id`: ни одной открытой записи вне
-- действующей редакции своей группы. Пока колонка на месте, отказ здесь
-- оставляет данные восстановимыми; после её удаления — нет.
DO $$
DECLARE
	stray integer;
BEGIN
	IF EXISTS (SELECT 1 FROM "interactions" WHERE "process_group_id" IS NULL) THEN
		RAISE EXCEPTION 'Перенос процесса: у взаимодействия нет группы процесса';
	END IF;

	SELECT count(*) INTO stray
	FROM "stage_entries" e
	JOIN "interactions" i ON i."id" = e."interaction_id"
	JOIN "process_groups" g ON g."id" = i."process_group_id"
	LEFT JOIN "stages" s ON s."id" = e."stage_id"
	WHERE e."left_at" IS NULL
		AND (g."active_revision_id" IS NULL OR s."revision_id" IS DISTINCT FROM g."active_revision_id");

	IF stray > 0 THEN
		RAISE EXCEPTION 'Перенос процесса: % открытых записей стадий вне действующей редакции своей группы. Обычно это значит, что в действующей редакции нет стадии с тем же ключом', stray;
	END IF;
END $$;--> statement-breakpoint

-- 10. Группа обязательна, ссылка на маршрут снимается последней.
ALTER TABLE "interactions" ALTER COLUMN "process_group_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" DROP COLUMN "route_id";
