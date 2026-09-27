-- Коммерческие условия дела и две колонки документа.
--
-- `interaction_terms` — стоимость дела в копейках; ведёт её модуль «Оплата».
-- Своя строка на дело со своей версией: правка стоимости не двигает версию
-- плана. Строки нет — стоимость не называли.
--
-- `documents.revision_note` — что изменилось в новой редакции, словами того,
-- кто её загрузил. `documents.signing` — город и подписанты, с которыми
-- документ собран по шаблону: по ним следующая сборка подставляет то же.
--
-- Эталонный процесс коммерческого обучения получает панель договора: юрлицо
-- работает по договору, и выбирать его негде было, кроме как в делах вуза.
-- У физического лица панель молчит сама. Процессы, где состав карточки уже
-- правили и панель есть, не меняются.
CREATE TABLE "interaction_terms" (
	"interaction_id" uuid PRIMARY KEY NOT NULL,
	"price_kopecks" bigint,
	"currency" text DEFAULT 'RUB' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_terms_price_nonnegative" CHECK ("interaction_terms"."price_kopecks" is null or "interaction_terms"."price_kopecks" >= 0),
	CONSTRAINT "interaction_terms_currency_rub" CHECK ("interaction_terms"."currency" = 'RUB')
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "revision_note" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "signing" jsonb;--> statement-breakpoint
ALTER TABLE "interaction_terms" ADD CONSTRAINT "interaction_terms_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_terms" ADD CONSTRAINT "interaction_terms_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

UPDATE "workflows"
SET "card_panels" = array_append("card_panels", 'contract'), "updated_at" = now()
WHERE "key" = 'b2c' AND NOT ('contract' = ANY ("card_panels"));
