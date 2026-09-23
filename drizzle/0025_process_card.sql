-- Состав карточки взаимодействия объявляет процесс: какие панели в ней стоят и
-- какие документы в ней собираются по шаблону.
--
-- До этой миграции карточка была одна на оба процесса и в коммерческом обучении
-- показывала вузовское: срок соглашения, позиции с лицензиями, шаблон
-- соглашения. Колонки стоят на процессе, а не на редакции: это вид рабочего
-- места, стадий он не касается и публикации не требует.
--
-- Процесс, заведённый позже, получает весь каталог — так карточка выглядит так
-- же, как до этой миграции, — и лишнее администратор снимает в редакторе
-- процесса. Значения вне каталога не пускает проверка.
ALTER TABLE "workflows" ADD COLUMN "card_panels" text[] DEFAULT array['terms', 'contract', 'payment', 'learners', 'learning', 'training_document', 'documents']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "document_template_keys" text[] DEFAULT array['agreement']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_card_panels_known" CHECK ("workflows"."card_panels" <@ array['terms', 'contract', 'payment', 'learners', 'learning', 'training_document', 'documents']::text[]);--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_document_template_keys_known" CHECK ("workflows"."document_template_keys" <@ array['agreement']::text[]);--> statement-breakpoint

-- Два базовых процесса получают свои рабочие места. Правка по ключу, а не по
-- имени: имя правят руками, ключ стоит в адресе и не меняется.
UPDATE "workflows"
SET "card_panels" = '{terms,contract,learning,documents}'::text[],
	"document_template_keys" = '{agreement}'::text[],
	"updated_at" = now()
WHERE "key" = 'b2b';--> statement-breakpoint
UPDATE "workflows"
SET "card_panels" = '{terms,payment,learners,learning,training_document,documents}'::text[],
	"document_template_keys" = '{}'::text[],
	"updated_at" = now()
WHERE "key" = 'b2c';
