-- Учебная группа закрепляет, что и для кого обучается, а стадию подтверждает
-- итог обучения нужной группы, а не любой пришедший результат.
--
-- До этой миграции группа знала только номер потока, а программа и продукт
-- подбирались при отправке первым попавшимся из взаимодействия. У группы
-- появляются программа, продукты и назначение обучения, выбранные сотрудником
-- при заявке, и отметка «обучение завершено» — на случай, когда итога из
-- системы обучения нет, а обучение закончилось.
--
-- Старые группы заполняются по одному правилу, и правило это — «что ушло в
-- систему обучения». Замороженный конверт заявки (`exchange_messages.envelope`)
-- — это ровно то, что получила LMS, поэтому программа и продукт берутся из него.
-- Заявку, которая так и не ушла, конверт не описывает; тогда закрепляется
-- программа (продукт), если у взаимодействия она одна. Где выбор неоднозначен —
-- у взаимодействия несколько программ и заявка не отправлялась, — программа
-- остаётся пустой: придумывать её задним числом значило бы солгать о том, что
-- обучается. Назначения обучения старые заявки не несли вовсе, и оно остаётся
-- пустым у всех старых групп.

-- 1. Назначение обучения.
CREATE TYPE "public"."learning_purpose" AS ENUM('students', 'teachers', 'upskilling');--> statement-breakpoint

-- 2. Продукты группы: подмножество продуктов взаимодействия.
CREATE TABLE "learning_group_products" (
	"learning_group_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_group_products_learning_group_id_product_id_pk" PRIMARY KEY("learning_group_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "learning_group_products" ADD CONSTRAINT "learning_group_products_learning_group_id_learning_groups_id_fk" FOREIGN KEY ("learning_group_id") REFERENCES "public"."learning_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_group_products" ADD CONSTRAINT "learning_group_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- 3. Программа, назначение и отметка «обучение завершено».
ALTER TABLE "learning_groups" ADD COLUMN "program_id" uuid;--> statement-breakpoint
ALTER TABLE "learning_groups" ADD COLUMN "purpose" "learning_purpose";--> statement-breakpoint
ALTER TABLE "learning_groups" ADD COLUMN "completion_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_groups" ADD COLUMN "completion_marked_by" uuid;--> statement-breakpoint
ALTER TABLE "learning_groups" ADD COLUMN "completion_comment" text;--> statement-breakpoint
ALTER TABLE "learning_groups" ADD CONSTRAINT "learning_groups_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_groups" ADD CONSTRAINT "learning_groups_completion_marked_by_users_id_fk" FOREIGN KEY ("completion_marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_groups" ADD CONSTRAINT "learning_groups_completion_mark_whole" CHECK (("learning_groups"."completion_marked_at" is null) = ("learning_groups"."completion_comment" is null));--> statement-breakpoint

-- 4. Заполнение старых групп. Конверт заявки ищется по ключу запроса
-- `crm-group-<взаимодействие>-<поток>`; если сообщений по ключу несколько,
-- берётся первое отправленное — то, по которому LMS и завела группу.
CREATE TEMPORARY TABLE "learning_group_sent" ON COMMIT DROP AS
SELECT DISTINCT ON (g."id") g."id" AS "learning_group_id", m."envelope"::jsonb -> 'data' AS "data"
FROM "learning_groups" g
JOIN "exchange_messages" m
	ON m."direction" = 'outbound'
	AND m."event_type" = 'learning_group.requested'
	AND m."external_id" = 'crm-group-' || g."interaction_id" || '-' || g."stream_number"
	AND m."envelope" IS NOT NULL
ORDER BY g."id", m."created_at";--> statement-breakpoint

-- 4а. Ушла заявка — программа та, что в ней.
UPDATE "learning_groups" g SET "program_id" = p."id"
FROM "learning_group_sent" s
JOIN "programs" p ON p."id"::text = s."data" -> 'program' ->> 'id'
WHERE s."learning_group_id" = g."id";--> statement-breakpoint

-- 4б. Не ушла — единственная программа взаимодействия.
UPDATE "learning_groups" g SET "program_id" = (
	SELECT ip."program_id" FROM "interaction_programs" ip WHERE ip."interaction_id" = g."interaction_id"
)
WHERE NOT EXISTS (SELECT 1 FROM "learning_group_sent" s WHERE s."learning_group_id" = g."id")
	AND (SELECT count(*) FROM "interaction_programs" ip WHERE ip."interaction_id" = g."interaction_id") = 1;--> statement-breakpoint

-- 4в. Продукт: из ушедшей заявки либо единственный продукт взаимодействия.
INSERT INTO "learning_group_products" ("learning_group_id", "product_id")
SELECT s."learning_group_id", p."id"
FROM "learning_group_sent" s
JOIN "products" p ON p."id"::text = s."data" -> 'product' ->> 'id'
UNION
SELECT g."id", (
	SELECT ip."product_id" FROM "interaction_products" ip WHERE ip."interaction_id" = g."interaction_id"
)
FROM "learning_groups" g
WHERE NOT EXISTS (SELECT 1 FROM "learning_group_sent" s WHERE s."learning_group_id" = g."id")
	AND (SELECT count(*) FROM "interaction_products" ip WHERE ip."interaction_id" = g."interaction_id") = 1;--> statement-breakpoint

-- 5. Снимок факта обучения на записи стадии получает вид: до сих пор он бывал
-- только результатом группы, теперь рядом встаёт отметка сотрудника.
UPDATE "stage_entries" SET "lms_evidence" = jsonb_build_object('kind', 'result') || "lms_evidence"
WHERE "lms_evidence" IS NOT NULL AND NOT ("lms_evidence" ? 'kind');--> statement-breakpoint

-- 6. Открытая стадия, подтверждённая промежуточным результатом, перестаёт
-- считаться подтверждённой: итога (завершившие и дата окончания) у такого
-- результата нет. Подтверждение снимается, только если его поставил сам приём
-- результата — `lms_record` с источником и группой этого же факта; поставленное
-- сотрудником остаётся. Закрытые записи — история, их не трогаем.
UPDATE "stage_entries" e SET
	"confirmation" = CASE WHEN e."confirmation" = jsonb_build_object(
			'kind', 'lms_record',
			'source', (e."lms_evidence" ->> 'system') || ':' || (e."lms_evidence" ->> 'instance'),
			'recordId', e."lms_evidence" ->> 'groupExternalId'
		) THEN NULL ELSE e."confirmation" END,
	"confirmed_at" = CASE WHEN e."confirmation" = jsonb_build_object(
			'kind', 'lms_record',
			'source', (e."lms_evidence" ->> 'system') || ':' || (e."lms_evidence" ->> 'instance'),
			'recordId', e."lms_evidence" ->> 'groupExternalId'
		) THEN NULL ELSE e."confirmed_at" END,
	"confirmed_by" = CASE WHEN e."confirmation" = jsonb_build_object(
			'kind', 'lms_record',
			'source', (e."lms_evidence" ->> 'system') || ':' || (e."lms_evidence" ->> 'instance'),
			'recordId', e."lms_evidence" ->> 'groupExternalId'
		) THEN NULL ELSE e."confirmed_by" END,
	"lms_evidence" = NULL,
	"updated_at" = now()
WHERE e."left_at" IS NULL
	AND e."lms_evidence" IS NOT NULL
	AND e."lms_evidence" ->> 'kind' = 'result'
	AND (coalesce((e."lms_evidence" ->> 'completed')::int, 0) <= 0 OR e."lms_evidence" ->> 'finishedOn' IS NULL);
