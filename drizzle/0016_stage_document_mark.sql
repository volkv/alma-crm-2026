-- Отметка по документу как доказательство исполнения стадии и комментарий к
-- самой отметке.
--
-- 1. Признак стадии: какая отметка по документу дела закрывает эту стадию.
--    Пусто — отметки не требуется, и это состояние всех существующих стадий:
--    опубликованные редакции миграция не переписывает, требование включают
--    черновиком процесса или новой поставкой определений.
ALTER TABLE "stages" ADD COLUMN "requires_document_mark" text;--> statement-breakpoint

-- 2. Снимок отметки на записи стадии: чем именно она подтверждена. Живёт рядом
--    со снимком фактов обучения и по той же причине — документ переименуют и
--    заменят новой редакцией, а запись обязана объяснять подтверждение и потом.
ALTER TABLE "stage_entries" ADD COLUMN "document_mark_evidence" jsonb;--> statement-breakpoint

-- 3. В слепке стадии появился ещё один параметр. У закрытых записей он
--    проставляется пустым: это история, и раньше такого требования не
--    существовало. Слепок открытой записи пересобирается по стадии — открытая
--    запись ещё не история, история начинается в момент её закрытия.
UPDATE "stage_entries"
SET "stage_snapshot" = "stage_snapshot" || jsonb_build_object('requiresDocumentMark', null)
WHERE NOT ("stage_snapshot" ? 'requiresDocumentMark');--> statement-breakpoint
UPDATE "stage_entries" e
SET "stage_snapshot" = e."stage_snapshot" || jsonb_build_object(
	'requiresDocumentMark', s."requires_document_mark"
)
FROM "stages" s
WHERE s."id" = e."stage_id" AND e."left_at" IS NULL;--> statement-breakpoint

-- 4. Комментарий к отметке: чем она объясняется. По колонке на факт, а не одна
--    на документ: отметка неизменяема, и общий комментарий пришлось бы
--    переписывать второй отметкой.
ALTER TABLE "documents" ADD COLUMN "agreed_note" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approved_note" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "in_effect_note" text;
