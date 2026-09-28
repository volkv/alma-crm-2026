-- Отправки описания программ вузу из карточки дела.
--
-- `program_offer_sends` — одно нажатие «Отправить контактам», которое ушло хотя
-- бы одному адресату: кто, когда, на какой записи стадии, кому (идентификаторы
-- роли и человека — без адресов и ФИО, персональные данные живут только в
-- `people`), какие программы в каких версиях и какие файлы с их хешами. По ней
-- закрывается пункт «Отправлено описание программ» правилом `offer_sent`.
--
-- Опубликованные редакции процессов миграция не трогает, как и 0034: процесс —
-- настройка администратора, и новое правило у пункта он выбирает в редакторе
-- процесса и включает публикацией. Эталонный процесс получает его из поставки
-- (`stages/definitions.ts`) — на стенде это сброс демонстрационных данных.
CREATE TABLE "program_offer_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"stage_entry_id" uuid,
	"sent_by" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipients" jsonb NOT NULL,
	"programs" jsonb NOT NULL,
	"documents" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "program_offer_sends" ADD CONSTRAINT "program_offer_sends_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_offer_sends" ADD CONSTRAINT "program_offer_sends_stage_entry_id_stage_entries_id_fk" FOREIGN KEY ("stage_entry_id") REFERENCES "public"."stage_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_offer_sends" ADD CONSTRAINT "program_offer_sends_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_offer_sends_interaction_idx" ON "program_offer_sends" USING btree ("interaction_id","sent_at");