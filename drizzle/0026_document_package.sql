-- Пакет документов по процессу и виду контрагента.
--
-- Каталог шаблонов вырос: к соглашению с вузом добавились сублицензионный
-- договор и акт передачи материалов и лицензий, у коммерческого обучения —
-- договор-оферта с физическим лицом, договор с юридическим лицом и акт
-- оказанных услуг. Проверка каталога на процессе пересоздаётся под новый набор.
--
-- Акт передачи называет позиции договора, которые он передаёт
-- (`document_contract_items`): отметка «Утверждён» на редакции акта переводит
-- эти позиции в статус «передан».
CREATE TABLE "document_contract_items" (
	"document_id" uuid NOT NULL,
	"contract_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_contract_items_document_id_contract_item_id_pk" PRIMARY KEY("document_id","contract_item_id")
);
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_document_template_keys_known";--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "document_template_keys" SET DEFAULT array['agreement', 'sublicense', 'handover_act', 'offer', 'legal_entity_contract', 'services_act']::text[];--> statement-breakpoint
ALTER TABLE "document_contract_items" ADD CONSTRAINT "document_contract_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_contract_items" ADD CONSTRAINT "document_contract_items_contract_item_id_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "public"."contract_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_document_template_keys_known" CHECK ("workflows"."document_template_keys" <@ array['agreement', 'sublicense', 'handover_act', 'offer', 'legal_entity_contract', 'services_act']::text[]);--> statement-breakpoint

-- Базовые процессы получают свой пакет. Правка по ключу, как в 0025: имя правят
-- руками, ключ не меняется. Набор, который администратор уже менял в
-- редакторе, дополняется, а не затирается: снятое им остаётся снятым только
-- среди прежних шаблонов, новые добавляются. Порядок — порядок каталога.
UPDATE "workflows"
SET "document_template_keys" = array(
		SELECT catalog.key
		FROM unnest('{agreement,sublicense,handover_act,offer,legal_entity_contract,services_act}'::text[]) WITH ORDINALITY AS catalog(key, position)
		WHERE catalog.key = ANY ("document_template_keys" || '{sublicense,handover_act}'::text[])
		ORDER BY catalog.position
	),
	"updated_at" = now()
WHERE "key" = 'b2b';--> statement-breakpoint
UPDATE "workflows"
SET "document_template_keys" = array(
		SELECT catalog.key
		FROM unnest('{agreement,sublicense,handover_act,offer,legal_entity_contract,services_act}'::text[]) WITH ORDINALITY AS catalog(key, position)
		WHERE catalog.key = ANY ("document_template_keys" || '{offer,legal_entity_contract,services_act}'::text[])
		ORDER BY catalog.position
	),
	"updated_at" = now()
WHERE "key" = 'b2c';
