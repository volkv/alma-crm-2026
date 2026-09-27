-- Модули пространства: какие части продукта — договоры, оплата, обучение,
-- встречи — включены в пространстве. Строка есть — модуль включён явно.
--
-- Проверка панелей карточки по каталогу снимается: каталог теперь собирается из
-- модулей установки (`crm.config.ts`), и держать его в базе значило бы писать
-- миграцию на каждый модуль. Панели проверяет приложение. Значение по умолчанию
-- у `card_panels` прежнее — на нём стоят процессы, заведённые позже.
CREATE TABLE "workspace_modules" (
	"workspace_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled_by" uuid,
	CONSTRAINT "workspace_modules_workspace_id_module_key_pk" PRIMARY KEY("workspace_id","module_key"),
	CONSTRAINT "workspace_modules_key_format" CHECK ("workspace_modules"."module_key" ~ '^[a-z][a-z0-9-]{1,31}$')
);
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_card_panels_known";--> statement-breakpoint
ALTER TABLE "workspace_modules" ADD CONSTRAINT "workspace_modules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_modules" ADD CONSTRAINT "workspace_modules_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Пространства получают те модули, которыми они уже пользуются, — так карточка
-- и её шапка после миграции выглядят как до неё:
-- - «Встречи» — всем: приглашение на встречу было в каждой карточке;
-- - «Договоры и лицензии» — где процесс держит панель договора или шаблоны
--   сублицензии и акта, где стадия ждёт отметки на них, и где принимают вузы и
--   юридических лиц: у них шапка карточки называет договор;
-- - «Оплата» — где процесс держит панель оплаты, где стадия ждёт отметки
--   «Оплата получена» и где принимают физических лиц: у них шапка называет оплату;
-- - «Обучение» — где процесс держит панели обучения или стадия подтверждается
--   данными LMS.
-- Пространство, у которого ни одно условие не выполнено, модуль не получает:
-- в нём им и не пользовались.
INSERT INTO "workspace_modules" ("workspace_id", "module_key")
SELECT w."id", m."key"
FROM "workspaces" w
LEFT JOIN "workflows" f ON f."id" = w."workflow_id"
CROSS JOIN (VALUES ('contracts'), ('payment'), ('learning'), ('meetings')) AS m("key")
WHERE m."key" = 'meetings'
	OR (m."key" = 'contracts' AND (
		coalesce(f."card_panels" && '{contract}'::text[], false)
		OR coalesce(f."document_template_keys" && '{sublicense,handover_act}'::text[], false)
		OR EXISTS (
			SELECT 1 FROM "stages" s
			WHERE s."revision_id" = f."active_revision_id"
				AND s."requires_document_template" IN ('sublicense', 'handover_act'))
		OR EXISTS (
			SELECT 1 FROM "workspace_intake_routes" r
			WHERE r."workspace_id" = w."id" AND r."kind" IN ('educational_institution', 'legal_entity'))))
	OR (m."key" = 'payment' AND (
		coalesce(f."card_panels" && '{payment}'::text[], false)
		OR EXISTS (
			SELECT 1 FROM "stages" s
			WHERE s."revision_id" = f."active_revision_id"
				AND s."checklist" @> '[{"key":"payment_received"}]'::jsonb)
		OR EXISTS (
			SELECT 1 FROM "workspace_intake_routes" r
			WHERE r."workspace_id" = w."id" AND r."kind" = 'individual')))
	OR (m."key" = 'learning' AND (
		coalesce(f."card_panels" && '{learners,learning,training_document}'::text[], false)
		OR EXISTS (
			SELECT 1 FROM "stages" s
			WHERE s."revision_id" = f."active_revision_id"
				AND (s."requires_lms_data" OR s."lms_group_purposes" IS NOT NULL))))
ON CONFLICT DO NOTHING;
