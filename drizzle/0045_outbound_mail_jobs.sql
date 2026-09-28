-- Очередь писем вузу: описание программ, пакет документов, приглашение на
-- встречу и её отмена уходят фоновым обработчиком, а не внутри запроса окна.
--
-- `outbound_mail_jobs` — одно нажатие «Отправить»: вид письма, дело,
-- отправитель, идентификаторы получателей и файлов (без адресов и ФИО — их
-- обработчик подставляет заново), состояние и исход. Та же строка —
-- уведомление отправителю в колокольчике, если ушло не всем или не ушло.
--
-- Данных миграция не переносит: до неё письма уходили сразу, и ждущих
-- отправок нет.
CREATE TABLE "outbound_mail_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"interaction_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"request_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"locked_until" timestamp with time zone,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"finished_at" timestamp with time zone,
	"notice_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_mail_jobs_status_check" CHECK (status in ('queued', 'sending', 'sent', 'partial', 'failed', 'refused'))
);
--> statement-breakpoint
ALTER TABLE "outbound_mail_jobs" ADD CONSTRAINT "outbound_mail_jobs_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_mail_jobs" ADD CONSTRAINT "outbound_mail_jobs_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_mail_jobs_pending_idx" ON "outbound_mail_jobs" USING btree ("created_at") WHERE "outbound_mail_jobs"."status" in ('queued', 'sending');--> statement-breakpoint
CREATE INDEX "outbound_mail_jobs_interaction_idx" ON "outbound_mail_jobs" USING btree ("interaction_id","kind");--> statement-breakpoint
CREATE INDEX "outbound_mail_jobs_sender_idx" ON "outbound_mail_jobs" USING btree ("sender_user_id","created_at");