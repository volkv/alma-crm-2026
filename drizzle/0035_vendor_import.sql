-- Вендоры: свой вид организации, второй вид загрузки справочника и контакты
-- вендора по продукту.
--
-- `vendor` — правообладатель ПО, на которого ссылается
-- `products.vendor_organization_id`. Раньше импорт каталога заводил такую
-- организацию компанией-заказчиком, а это другой смысл — плательщик рядом с
-- вузом. Стороной взаимодействия вендор не бывает, пространства и маршрута
-- приёма у него нет.
--
-- Вид добавляется пересозданием типа, а не ALTER TYPE ... ADD VALUE, — как в
-- 0005: мигратор применяет все неприменённые файлы одной транзакцией, а
-- PostgreSQL не даёт пользоваться добавленным значением до её фиксации. Здесь
-- же значение нужно переносу данных. У типа, созданного в этой же транзакции,
-- запрета нет. Порядок значений прежний, новое — последним.
--
-- Перенос: вендором становится компания-заказчик, на которую ссылается продукт
-- и которая не стоит ни в одном взаимодействии. Компания, которая участвует в
-- работе, остаётся компанией-заказчиком: вид решает, может ли она быть
-- стороной, и отобрать это у действующей записи перенос не вправе.
--
-- `directory_imports.kind` — что описывает файл загрузки; прежние загрузки —
-- каталог. Колонки строк загрузки те же: компания файла вендоров ложится в
-- `organization_name`/`organization_inn`, ячейка продуктов — в `product_name`.
--
-- `product_contacts` — какие люди отвечают за продукт у вендора. ФИО и
-- контакты остаются только в `people`, связь хранит два идентификатора.
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_education_level_matches_kind";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_person_matches_kind";--> statement-breakpoint
CREATE TYPE "public"."organization_kind_next" AS ENUM('educational_institution', 'customer_company', 'operator', 'individual', 'legal_entity', 'vendor');--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "kind" TYPE "public"."organization_kind_next" USING "kind"::text::"public"."organization_kind_next";--> statement-breakpoint
ALTER TABLE "workspace_intake_routes" ALTER COLUMN "kind" TYPE "public"."organization_kind_next" USING "kind"::text::"public"."organization_kind_next";--> statement-breakpoint
DROP TYPE "public"."organization_kind";--> statement-breakpoint
ALTER TYPE "public"."organization_kind_next" RENAME TO "organization_kind";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_education_level_matches_kind" CHECK (("organizations"."education_level" is not null) = ("organizations"."kind" = 'educational_institution'));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_person_matches_kind" CHECK (("organizations"."person_id" is not null) = ("organizations"."kind" = 'individual'));--> statement-breakpoint
UPDATE "organizations" SET "kind" = 'vendor', "updated_at" = now() WHERE "kind" = 'customer_company' AND EXISTS (SELECT 1 FROM "products" WHERE "products"."vendor_organization_id" = "organizations"."id") AND NOT EXISTS (SELECT 1 FROM "interaction_parties" WHERE "interaction_parties"."organization_id" = "organizations"."id");--> statement-breakpoint
CREATE TYPE "public"."directory_import_kind" AS ENUM('catalog', 'vendors');--> statement-breakpoint
CREATE TABLE "product_contacts" (
	"product_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_contacts_product_id_person_id_pk" PRIMARY KEY("product_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "directory_imports" ADD COLUMN "kind" "directory_import_kind" DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_contacts" ADD CONSTRAINT "product_contacts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_contacts" ADD CONSTRAINT "product_contacts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_contacts_person_idx" ON "product_contacts" USING btree ("person_id");
