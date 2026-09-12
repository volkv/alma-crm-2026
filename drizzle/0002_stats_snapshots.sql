CREATE TYPE "public"."stat_period_kind" AS ENUM('academic', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."stat_snapshot_mode" AS ENUM('full', 'append', 'correction');--> statement-breakpoint
CREATE TYPE "public"."stat_snapshot_status" AS ENUM('uploading', 'mapped', 'validated', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."stat_source" AS ENUM('file', 'lms', 'site', 'manual');--> statement-breakpoint
CREATE TABLE "stat_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"organization_id" uuid,
	"site_id" uuid,
	"program_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"applications" integer,
	"enrolled" integer,
	"parallel_streams" integer,
	"completed" integer,
	"coverage_plan" integer,
	"coverage_fact" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_valid" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"replaced_by_row_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stat_rows_period_ordered" CHECK ("stat_rows"."period_end" >= "stat_rows"."period_start"),
	CONSTRAINT "stat_rows_valid_is_attributed" CHECK (not "stat_rows"."is_valid" or ("stat_rows"."organization_id" is not null and "stat_rows"."program_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "stat_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "stat_source" NOT NULL,
	"mode" "stat_snapshot_mode" NOT NULL,
	"period_kind" "stat_period_kind" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"coverage" jsonb DEFAULT '{"organizationIds":[],"siteIds":[],"programIds":[]}'::jsonb NOT NULL,
	"status" "stat_snapshot_status" DEFAULT 'uploading' NOT NULL,
	"file_document_id" uuid,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"supersedes_snapshot_id" uuid,
	"note" text,
	"created_by" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stat_snapshots_period_ordered" CHECK ("stat_snapshots"."period_end" >= "stat_snapshots"."period_start"),
	CONSTRAINT "stat_snapshots_current_is_confirmed" CHECK (not "stat_snapshots"."is_current" or "stat_snapshots"."status" = 'confirmed'),
	CONSTRAINT "stat_snapshots_confirmed_has_moment" CHECK (("stat_snapshots"."status" = 'confirmed') = ("stat_snapshots"."confirmed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "stat_rows" ADD CONSTRAINT "stat_rows_snapshot_id_stat_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."stat_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_rows" ADD CONSTRAINT "stat_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_rows" ADD CONSTRAINT "stat_rows_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_rows" ADD CONSTRAINT "stat_rows_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_rows" ADD CONSTRAINT "stat_rows_replaced_by_row_id_stat_rows_id_fk" FOREIGN KEY ("replaced_by_row_id") REFERENCES "public"."stat_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_snapshots" ADD CONSTRAINT "stat_snapshots_file_document_id_documents_id_fk" FOREIGN KEY ("file_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_snapshots" ADD CONSTRAINT "stat_snapshots_supersedes_snapshot_id_stat_snapshots_id_fk" FOREIGN KEY ("supersedes_snapshot_id") REFERENCES "public"."stat_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_snapshots" ADD CONSTRAINT "stat_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stat_snapshots" ADD CONSTRAINT "stat_snapshots_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stat_rows_snapshot_row_key" ON "stat_rows" USING btree ("snapshot_id","row_no");--> statement-breakpoint
CREATE INDEX "stat_rows_program_period_idx" ON "stat_rows" USING btree ("program_id","period_start");--> statement-breakpoint
CREATE INDEX "stat_rows_organization_period_idx" ON "stat_rows" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE INDEX "stat_snapshots_period_idx" ON "stat_snapshots" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "stat_snapshots_status_idx" ON "stat_snapshots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stat_snapshots_current_idx" ON "stat_snapshots" USING btree ("source","period_start","period_end") WHERE "stat_snapshots"."is_current";--> statement-breakpoint
-- Показатели по программе, организации и периоду.
--
-- Показатель — это не хранимое число, а вывод из подтверждённых загрузок,
-- поэтому он и живёт представлением: второе место, где то же самое считается
-- иначе, однажды разойдётся с первым, и разойдётся молча.
--
-- Что попадает в сумму:
--
--   * снимок подтверждён (`status = 'confirmed'`) — непроверенная загрузка в
--     отчёт не входит, как бы аккуратно она ни выглядела;
--   * снимок текущий (`is_current`) — этим и работает режим `full`: подтверждая
--     полную выгрузку, команда снимает признак с прежней выгрузки того же
--     источника, периода и области, и та перестаёт складываться, не исчезая
--     из базы. Режим `append` ничего не снимает: его снимок просто ещё один
--     текущий;
--   * строка верна (`is_valid`) — у неё нашлись и организация, и программа;
--   * строку не заменило исправление (`replaced_by_row_id is null`) — так
--     работает режим `correction`: новая версия строки встаёт в сумму, прежняя
--     из неё выходит.
--
-- Периоды не складываются между собой: период входит в ключ группировки, и
-- показатель всегда относится к одному явно названному периоду.
--
-- `sum` пропускает NULL и отдаёт NULL, когда складывать нечего. Это и есть
-- различие нуля и отсутствия данных: «0» означает, что ноль кто-то записал, а
-- пусто — что колонки не было ни в одной строке. Приведение к `integer` нужно
-- потому, что `sum(integer)` в PostgreSQL имеет тип `bigint`, а он приезжает
-- в приложение строкой.
CREATE VIEW stat_program_indicators AS
SELECT
	r.program_id,
	r.organization_id,
	s.period_kind,
	r.period_start,
	r.period_end,
	sum(r.applications)::integer AS applications,
	sum(r.enrolled)::integer AS enrolled,
	sum(r.parallel_streams)::integer AS parallel_streams,
	sum(r.completed)::integer AS completed,
	sum(r.coverage_plan)::integer AS coverage_plan,
	sum(r.coverage_fact)::integer AS coverage_fact,
	count(*)::integer AS row_count,
	count(DISTINCT r.snapshot_id)::integer AS snapshot_count,
	max(s.confirmed_at) AS last_confirmed_at
FROM stat_rows r
JOIN stat_snapshots s ON s.id = r.snapshot_id
WHERE s.status = 'confirmed'
	AND s.is_current
	AND r.is_valid
	AND r.replaced_by_row_id IS NULL
GROUP BY
	r.program_id,
	r.organization_id,
	s.period_kind,
	r.period_start,
	r.period_end;
