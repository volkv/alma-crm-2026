-- Описание и материалы образовательной программы.
--
-- `programs.description` — краткое описание для карточки и письма вузу; длину
-- (до 1000 символов) держит контракт формы. `program_documents` привязывает к
-- программе файлы с её полным описанием: сами файлы — строки `documents` без
-- взаимодействия с видом `program_description`. Снять материал с программы —
-- удалить связь; строка документа и файл остаются, поштучно документы не
-- удаляются.
CREATE TABLE "program_documents" (
	"program_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_documents_program_id_document_id_pk" PRIMARY KEY("program_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "program_documents" ADD CONSTRAINT "program_documents_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_documents" ADD CONSTRAINT "program_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;