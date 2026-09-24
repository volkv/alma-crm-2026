-- Уведомления о сроках лицензий по позициям договоров.
--
-- Журнал доставок знал один предмет — запись стадии зависшего взаимодействия.
-- Лицензия живёт в позиции договора, и взаимодействия у неё может не быть
-- вовсе, поэтому у строки журнала появляется второй предмет: позиция договора
-- вместе со сроком лицензии. Заполнен ровно один из двух — это держит проверка.
-- Срок входит в ключ дедупликации: продлили лицензию — новый срок напоминает
-- заново, а история прежнего остаётся строками журнала.
--
-- Новые значения перечисления в этой же миграции не используются: PostgreSQL
-- не даёт пользоваться добавленным значением до фиксации транзакции.
ALTER TYPE "public"."notification_kind" ADD VALUE 'license_expiring';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'license_expired';--> statement-breakpoint
ALTER TABLE "notification_deliveries" ALTER COLUMN "interaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ALTER COLUMN "stage_entry_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "contract_item_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "license_until" date;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_contract_item_id_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "public"."contract_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_license_key" ON "notification_deliveries" USING btree ("kind","contract_item_id","license_until","channel") WHERE "notification_deliveries"."contract_item_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_deliveries_contract_item_idx" ON "notification_deliveries" USING btree ("contract_item_id");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subject_one_of" CHECK (("notification_deliveries"."stage_entry_id" is not null and "notification_deliveries"."interaction_id" is not null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is null and "notification_deliveries"."contract_item_id" is not null and "notification_deliveries"."license_until" is not null));