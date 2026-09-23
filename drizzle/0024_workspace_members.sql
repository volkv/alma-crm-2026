-- Членство сотрудника в пространстве: пространство становится границей доступа.
--
-- До этой миграции пространство было раскладкой меню, и видимость считалась
-- только по назначениям и иерархии. Теперь взаимодействие видно, если его
-- пространство входит в пространства сотрудника и оно же попадает в его область
-- по назначениям. Администратор видит всё без членства.
--
-- Строка — период, как у назначений ответственных: исключение закрывает его, а
-- не удаляет строку. Действующее членство одно на пару «пространство ×
-- сотрудник» — это держит частичный уникальный индекс.
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_period_ordered" CHECK ("workspace_members"."valid_to" is null or "workspace_members"."valid_to" > "workspace_members"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_active_key" ON "workspace_members" USING btree ("workspace_id","user_id") WHERE "workspace_members"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id") WHERE "workspace_members"."valid_to" is null;--> statement-breakpoint

-- Установка, на которой уже работают, не должна потерять доступ в момент
-- выката: каждый сотрудник, кроме администраторов и машинного субъекта обмена
-- (им членство не нужно — их область и так полная), включается во все
-- существующие пространства. Дальше состав правит администратор в разделе
-- «Настройки → Пространства».
INSERT INTO "workspace_members" ("workspace_id", "user_id")
SELECT "workspaces"."id", "users"."id"
FROM "workspaces"
CROSS JOIN "users"
WHERE "users"."role_id" NOT IN ('admin', 'service');
