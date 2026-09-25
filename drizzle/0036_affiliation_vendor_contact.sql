-- Роль «Контакт вендора»: человек вендора, отвечающий за его продукты.
-- Раньше загрузка вендоров заводила такому человеку роль `other`, и карточка
-- продукта показывала его контакт «Другое».
--
-- Значение добавляется пересозданием типа, а не ALTER TYPE ... ADD VALUE, — как
-- в 0005 и 0035: мигратор применяет все неприменённые файлы одной транзакцией,
-- а PostgreSQL не даёт пользоваться добавленным значением до её фиксации, здесь
-- же оно нужно переносу. Порядок значений прежний, новое — последним.
--
-- Перенос: `vendor_contact` получает роль `other` в организации-вендоре у
-- человека, который через `product_contacts` отвечает за продукт этого же
-- вендора, — ровно то, что заводила загрузка вендоров. Прочие `other` остаются.
CREATE TYPE "public"."affiliation_role_kind_next" AS ENUM('rector', 'vice_rector', 'dean', 'head_of_department', 'teacher', 'coordinator', 'other', 'vendor_contact');--> statement-breakpoint
ALTER TABLE "affiliations" ALTER COLUMN "role_kind" TYPE "public"."affiliation_role_kind_next" USING "role_kind"::text::"public"."affiliation_role_kind_next";--> statement-breakpoint
DROP TYPE "public"."affiliation_role_kind";--> statement-breakpoint
ALTER TYPE "public"."affiliation_role_kind_next" RENAME TO "affiliation_role_kind";--> statement-breakpoint
UPDATE "affiliations" SET "role_kind" = 'vendor_contact', "updated_at" = now() WHERE "role_kind" = 'other' AND EXISTS (SELECT 1 FROM "product_contacts" JOIN "products" ON "products"."id" = "product_contacts"."product_id" WHERE "product_contacts"."person_id" = "affiliations"."person_id" AND "products"."vendor_organization_id" = "affiliations"."organization_id");
