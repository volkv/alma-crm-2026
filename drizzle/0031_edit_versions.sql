-- Версия правки взаимодействия и договора: целое число, которое сдвигают только
-- команды, переписывающие защищённые поля, и автор этой версии. Форма несёт
-- версию, с которой её открыли; несовпадение под блокировкой строки — отказ,
-- а не перезапись чужой правки. Прежние записи получают версию 1 и момент
-- своей последней правки: автора у них нет, это «система».
CREATE TYPE "public"."edit_source" AS ENUM('user', 'site', 'system');--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "edit_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "edited_by" uuid;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "edited_via" "edit_source" DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "edited_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "edit_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "edited_by" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "edited_via" "edit_source" DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "edited_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_edited_by_source" CHECK (("contracts"."edited_via" = 'user') = ("contracts"."edited_by" is not null));--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_edited_by_source" CHECK (("interactions"."edited_via" = 'user') = ("interactions"."edited_by" is not null));--> statement-breakpoint
UPDATE "contracts" SET "edited_at" = "updated_at";--> statement-breakpoint
UPDATE "interactions" SET "edited_at" = "updated_at";
