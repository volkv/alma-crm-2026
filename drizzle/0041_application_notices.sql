-- Уведомление ответственному о новом деле с сайта.
--
-- `application_notices` — «дело × ответственный» с отметкой прочтения для
-- колокольчика: заявка или оплата с сайта завела дело и назначила его
-- сотруднику. Уникальность «дело × адресат» держит правило «одно уведомление
-- о новом деле» при повторах и новых ревизиях заявки. У журнала доставок
-- появляется пятый предмет — уведомление (`application_notice_id` вместе со
-- взаимодействием), ключ дедупликации «вид × уведомление × канал»; проверка
-- «заполнен ровно один предмет» пересобирается под пять предметов.
--
-- Новое значение перечисления в этой же миграции не используется: PostgreSQL
-- не даёт пользоваться добавленным значением до фиксации транзакции.
ALTER TYPE "public"."notification_kind" ADD VALUE 'site_application';--> statement-breakpoint
CREATE TABLE "application_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_subject_one_of";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "application_notice_id" uuid;--> statement-breakpoint
ALTER TABLE "application_notices" ADD CONSTRAINT "application_notices_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_notices" ADD CONSTRAINT "application_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_notices_interaction_user_key" ON "application_notices" USING btree ("interaction_id","user_id");--> statement-breakpoint
CREATE INDEX "application_notices_user_idx" ON "application_notices" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_application_notice_fk" FOREIGN KEY ("application_notice_id") REFERENCES "public"."application_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_application_notice_key" ON "notification_deliveries" USING btree ("kind","application_notice_id","channel") WHERE "notification_deliveries"."application_notice_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_deliveries_application_notice_idx" ON "notification_deliveries" USING btree ("application_notice_id");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subject_one_of" CHECK (("notification_deliveries"."stage_entry_id" is not null and "notification_deliveries"."interaction_id" is not null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is null and "notification_deliveries"."mention_id" is null and "notification_deliveries"."application_notice_id" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is null and "notification_deliveries"."contract_item_id" is not null and "notification_deliveries"."license_until" is not null and "notification_deliveries"."digest_day" is null and "notification_deliveries"."mention_id" is null and "notification_deliveries"."application_notice_id" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is not null and "notification_deliveries"."mention_id" is null and "notification_deliveries"."application_notice_id" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is not null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is null and "notification_deliveries"."mention_id" is not null and "notification_deliveries"."application_notice_id" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is not null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is null and "notification_deliveries"."mention_id" is null and "notification_deliveries"."application_notice_id" is not null));