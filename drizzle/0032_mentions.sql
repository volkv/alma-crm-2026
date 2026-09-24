-- Упоминания сотрудников в комментариях к делу.
--
-- `comment_mentions` — «комментарий × адресат» с отметкой прочтения для
-- колокольчика; текста в ней нет, только ссылки. У журнала доставок появляется
-- четвёртый предмет — упоминание (`mention_id` вместе со взаимодействием), ключ
-- дедупликации «вид × упоминание × канал»; проверка «заполнен ровно один
-- предмет» пересобирается под четыре предмета.
--
-- `comments.request_key` — ключ повтора формы комментария: повторная отправка
-- того же черновика не пишет второй комментарий и не зовёт упомянутых дважды.
--
-- Новое значение перечисления в этой же миграции не используется: PostgreSQL
-- не даёт пользоваться добавленным значением до фиксации транзакции.
ALTER TYPE "public"."notification_kind" ADD VALUE 'mention';--> statement-breakpoint
CREATE TABLE "comment_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_subject_one_of";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "request_key" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "mention_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_mentions_comment_user_key" ON "comment_mentions" USING btree ("comment_id","user_id");--> statement-breakpoint
CREATE INDEX "comment_mentions_user_idx" ON "comment_mentions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_mentions_interaction_idx" ON "comment_mentions" USING btree ("interaction_id");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_mention_id_comment_mentions_id_fk" FOREIGN KEY ("mention_id") REFERENCES "public"."comment_mentions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comments_request_key" ON "comments" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_mention_key" ON "notification_deliveries" USING btree ("kind","mention_id","channel") WHERE "notification_deliveries"."mention_id" is not null;--> statement-breakpoint
CREATE INDEX "notification_deliveries_mention_idx" ON "notification_deliveries" USING btree ("mention_id");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subject_one_of" CHECK (("notification_deliveries"."stage_entry_id" is not null and "notification_deliveries"."interaction_id" is not null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is null and "notification_deliveries"."mention_id" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is null and "notification_deliveries"."contract_item_id" is not null and "notification_deliveries"."license_until" is not null and "notification_deliveries"."digest_day" is null and "notification_deliveries"."mention_id" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is not null and "notification_deliveries"."mention_id" is null) or ("notification_deliveries"."stage_entry_id" is null and "notification_deliveries"."interaction_id" is not null and "notification_deliveries"."contract_item_id" is null and "notification_deliveries"."license_until" is null and "notification_deliveries"."digest_day" is null and "notification_deliveries"."mention_id" is not null));