-- Уведомление при входе на стадию.
--
-- `stages.on_enter_notify` — кого уведомить, когда дело входит на стадию:
-- ответственного (`responsible`) или его руководителя (`manager`); пусто —
-- никого. У журнала доставок появляется вид `stage_entered`; предмет у него —
-- запись стадии, как у напоминания о зависшем, и ключ дедупликации тот же.
--
-- Новое значение перечисления в этой же миграции не используется: PostgreSQL
-- не даёт пользоваться добавленным значением до фиксации транзакции.
ALTER TYPE "public"."notification_kind" ADD VALUE 'stage_entered';--> statement-breakpoint
ALTER TABLE "stages" ADD COLUMN "on_enter_notify" text;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_on_enter_notify_known" CHECK ("stages"."on_enter_notify" is null or "stages"."on_enter_notify" in ('responsible', 'manager'));