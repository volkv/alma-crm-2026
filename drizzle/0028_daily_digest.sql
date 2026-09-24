-- Утренняя сводка «Мой день».
--
-- У строки журнала доставок появляется третий предмет: день сводки вместе с
-- получателем. Ключ дедупликации — «вид × получатель × день × канал»: одна
-- сводка на сотрудника, день и канал, сколько бы проходов цикла ни пришлось
-- на утро. Проверка «заполнен ровно один предмет» пересобирается под три
-- предмета.
--
-- Новое значение перечисления в этой же миграции не используется: PostgreSQL
-- не даёт пользоваться добавленным значением до фиксации транзакции.
ALTER TYPE "public"."notification_kind" ADD VALUE 'daily_digest';--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_subject_one_of";--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "digest_day" date;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_digest_key" ON "notification_deliveries" USING btree ("kind","recipient_user_id","digest_day","channel") WHERE "notification_deliveries"."digest_day" is not null;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subject_one_of" CHECK (("notification_deliveries"."stage_entry_id" is not null and "notification_deliveries"."interaction_id" is not null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is null and "notification_deliveries"."contract_item_id" is not null and "notification_deliveries"."license_until" is not null and "notification_deliveries"."digest_day" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is not null));