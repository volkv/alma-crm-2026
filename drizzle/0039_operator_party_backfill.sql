-- Оператор (сама школа) стороной незавершённых взаимодействий, у которых его
-- нет. С этой миграции сторону ставит само заведение дела
-- (`createInteractionIn`), а дела, заведённые формой раньше, остались без неё —
-- и пакет документов по ним отказывал «нет оператора».
--
-- Школа — единственная действующая организация вида «Оператор». Нет её или их
-- несколько — миграция ничего не меняет: выбирать наугад, от чьего имени
-- подписывать документы, нельзя, а стороны потом добавляют в «Изменить состав».
-- Завершённые и отменённые дела не трогаются: их состав — история.
--
-- Каждое дополненное дело сдвигает версию правки (открытая форма коллеги
-- получит отказ «запись изменила система», а не затрёт сторону) и оставляет
-- запись в журнале действий от имени системы. В предметную историю плана
-- строка не пишется: у её записей автор — человек (`interactions/write.ts`).
CREATE TEMPORARY TABLE "operator_party_backfill" AS
SELECT "interactions"."id" AS "interaction_id", "school"."id" AS "operator_id"
FROM "interactions"
CROSS JOIN (
	SELECT (array_agg("id"))[1] AS "id"
	FROM "organizations"
	WHERE "kind" = 'operator' AND "is_active"
	HAVING count(*) = 1
) AS "school"
WHERE "interactions"."status" = 'active'
	AND NOT EXISTS (
		SELECT 1 FROM "interaction_parties"
		WHERE "interaction_parties"."interaction_id" = "interactions"."id"
			AND ("interaction_parties"."party_role" = 'operator'
				OR "interaction_parties"."organization_id" = "school"."id")
	);--> statement-breakpoint
INSERT INTO "interaction_parties" ("interaction_id", "organization_id", "party_role", "is_primary")
SELECT "interaction_id", "operator_id", 'operator', false FROM "operator_party_backfill";--> statement-breakpoint
UPDATE "interactions"
SET "edit_version" = "edit_version" + 1,
	"edited_by" = NULL,
	"edited_via" = 'system',
	"edited_at" = now(),
	"updated_at" = now()
WHERE "id" IN (SELECT "interaction_id" FROM "operator_party_backfill");--> statement-breakpoint
INSERT INTO "audit_events" ("request_id", "source", "event_type", "outcome", "actor_label", "subject_type", "subject_id", "details")
SELECT 'migration-0039', 'system', 'interactions.updated', 'success', 'Система', 'interaction', "interaction_id", '{"changedFields":["parties"]}'::jsonb
FROM "operator_party_backfill";--> statement-breakpoint
DROP TABLE "operator_party_backfill";
