-- Чем подтверждается стадия: вид документа и назначение учебной группы.
--
-- `documents.template_key` — шаблон, по которому документ собран; новая
-- редакция наследует его у заменённой. `stages.requires_document_template` —
-- на документе какого шаблона стадия ищет отметку (пусто — на любом).
-- `stages.lms_group_purposes` — назначения групп, итог которых подтверждает
-- стадию (пусто — любые).
--
-- Опубликованные редакции процессов миграция не трогает: процесс — настройка
-- администратора, и новое сужение он включает публикацией.
--
-- Слепки записей стадий получают оба новых параметра пустыми: слепок обязан
-- нести всё, о чём спрашивают правила стадии, а пустое значение означает ровно
-- прежнее поведение.
--
-- Собранным раньше документам ключ восстанавливается там, где происхождение
-- доказуемо: позиции договора в `document_contract_items` связывает с
-- документом только сборка акта передачи (и перенос связей на его новую
-- редакцию). Остальным собранным документам ключ не восстановить без догадки
-- по названию, и они остаются без шаблона — ни одна стадия их не ждёт.
ALTER TABLE "documents" ADD COLUMN "template_key" text;--> statement-breakpoint
ALTER TABLE "stages" ADD COLUMN "requires_document_template" text;--> statement-breakpoint
ALTER TABLE "stages" ADD COLUMN "lms_group_purposes" text[];--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_template_key_known" CHECK ("documents"."template_key" is null or "documents"."template_key" in ('agreement', 'sublicense', 'handover_act', 'offer', 'legal_entity_contract', 'services_act'));--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_requires_document_template_known" CHECK ("stages"."requires_document_template" is null or ("stages"."requires_document_mark" is not null and "stages"."requires_document_template" = any(array['agreement', 'sublicense', 'handover_act', 'offer', 'legal_entity_contract', 'services_act']::text[])));--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_lms_group_purposes_known" CHECK ("stages"."lms_group_purposes" is null or ("stages"."requires_lms_data" and cardinality("stages"."lms_group_purposes") > 0 and "stages"."lms_group_purposes" <@ array['students', 'teachers', 'upskilling']::text[]));--> statement-breakpoint
UPDATE "stage_entries" SET "stage_snapshot" = "stage_snapshot" || '{"requiresDocumentTemplate": null, "lmsGroupPurposes": null}'::jsonb WHERE NOT ("stage_snapshot" ? 'requiresDocumentTemplate');--> statement-breakpoint
UPDATE "documents" SET "template_key" = 'handover_act' WHERE "kind" = 'generated' AND EXISTS (SELECT 1 FROM "document_contract_items" WHERE "document_contract_items"."document_id" = "documents"."id");
