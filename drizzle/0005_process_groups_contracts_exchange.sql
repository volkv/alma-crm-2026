CREATE TYPE "public"."exchange_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."exchange_message_state" AS ENUM('pending', 'retrying', 'sent', 'processed', 'ignored_stale', 'failed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'active', 'closed');--> statement-breakpoint
-- Виды контрагента добавляются пересозданием типа, а не ALTER TYPE ... ADD VALUE.
-- Мигратор применяет все непримененные файлы одной транзакцией, а PostgreSQL
-- запрещает пользоваться значением перечисления, добавленным в незакрытой
-- транзакции («unsafe use of new value»). Новый вид нужен уже здесь — проверке
-- organizations_person_matches_kind — и в следующем файле строкам соответствия
-- видов группам процесса. У типа, созданного в этой же транзакции, запрета нет.
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_education_level_matches_kind";--> statement-breakpoint
CREATE TYPE "public"."organization_kind_next" AS ENUM('educational_institution', 'customer_company', 'operator', 'individual', 'legal_entity');--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "kind" TYPE "public"."organization_kind_next" USING "kind"::text::"public"."organization_kind_next";--> statement-breakpoint
DROP TYPE "public"."organization_kind";--> statement-breakpoint
ALTER TYPE "public"."organization_kind_next" RENAME TO "organization_kind";--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_education_level_matches_kind" CHECK (("organizations"."education_level" is not null) = ("organizations"."kind" = 'educational_institution'));--> statement-breakpoint
ALTER TYPE "public"."stage_outcome" ADD VALUE 'migrated';--> statement-breakpoint
CREATE TABLE "directions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directions_code_key" UNIQUE("code"),
	CONSTRAINT "directions_position_key" UNIQUE("position")
);
--> statement-breakpoint
CREATE TABLE "organization_responsibles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"direction_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"assigned_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_responsibles_period_ordered" CHECK ("organization_responsibles"."valid_to" is null or "organization_responsibles"."valid_to" > "organization_responsibles"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "product_directions" (
	"product_id" uuid NOT NULL,
	"direction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_directions_product_id_direction_id_pk" PRIMARY KEY("product_id","direction_id")
);
--> statement-breakpoint
CREATE TABLE "stage_entry_documents" (
	"stage_entry_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_entry_documents_stage_entry_id_document_id_pk" PRIMARY KEY("stage_entry_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "exchange_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" "exchange_direction" NOT NULL,
	"system" text NOT NULL,
	"instance" text NOT NULL,
	"event_type" text NOT NULL,
	"event_id" text NOT NULL,
	"external_id" text,
	"interaction_id" uuid,
	"state" "exchange_message_state" NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"response_status" integer,
	"last_error" text,
	"payload" jsonb NOT NULL,
	"request_hash" text,
	"response_body" jsonb,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_messages_event_key" UNIQUE("direction","system","instance","event_id")
);
--> statement-breakpoint
CREATE TABLE "learning_group_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learning_group_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"period_start" date,
	"period_end" date,
	"finished_on" date,
	"enrolled" integer,
	"completed" integer,
	"expelled" integer,
	"document_id" uuid,
	"exchange_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_group_results_group_occurred_key" UNIQUE("learning_group_id","occurred_at"),
	CONSTRAINT "learning_group_results_counts_consistent" CHECK ("learning_group_results"."enrolled" is null or coalesce("learning_group_results"."completed", 0) + coalesce("learning_group_results"."expelled", 0) <= "learning_group_results"."enrolled")
);
--> statement-breakpoint
CREATE TABLE "learning_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"stream_number" integer NOT NULL,
	"system" text NOT NULL,
	"instance" text NOT NULL,
	"group_external_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"planned_seats" integer,
	"starts_on" date,
	"ends_on" date,
	"last_result_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_groups_interaction_stream_key" UNIQUE("interaction_id","stream_number")
);
--> statement-breakpoint
CREATE TABLE "contract_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"license_signed_at" date,
	"license_until" date,
	"transfer_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_items_contract_product_key" UNIQUE("contract_id","product_id"),
	CONSTRAINT "contract_items_id_contract_key" UNIQUE("id","contract_id")
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"signed_on" date,
	"valid_until" date,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_organization_number_key" UNIQUE("organization_id","number"),
	CONSTRAINT "contracts_period_ordered" CHECK ("contracts"."valid_until" is null or "contracts"."signed_on" is null or "contracts"."valid_until" >= "contracts"."signed_on")
);
--> statement-breakpoint
CREATE TABLE "interaction_contract_items" (
	"interaction_id" uuid NOT NULL,
	"contract_item_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_contract_items_interaction_id_contract_item_id_pk" PRIMARY KEY("interaction_id","contract_item_id")
);
--> statement-breakpoint
CREATE TABLE "process_group_counterparty_kinds" (
	"kind" "organization_kind" PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active_revision_id" uuid,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_groups_key_key" UNIQUE("key"),
	CONSTRAINT "process_groups_position_key" UNIQUE("position")
);
--> statement-breakpoint
CREATE TABLE "process_stage_keys" (
	"group_id" uuid NOT NULL,
	"key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "process_stage_keys_group_id_key_pk" PRIMARY KEY("group_id","key")
);
--> statement-breakpoint
CREATE TABLE "stage_migration_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"removed_stage_key" text NOT NULL,
	"target_stage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_migration_rules_revision_key" UNIQUE("revision_id","removed_stage_key"),
	CONSTRAINT "stage_migration_rules_keys_differ" CHECK ("stage_migration_rules"."removed_stage_key" <> "stage_migration_rules"."target_stage_key")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "manager_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_subject" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "direction_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "process_group_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "external_revision" bigint;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD COLUMN "migrated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD COLUMN "migrated_from_stage_key" text;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD COLUMN "lms_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "stages" ADD COLUMN "is_final" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stages" ADD COLUMN "requires_lms_data" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_responsibles" ADD CONSTRAINT "organization_responsibles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_responsibles" ADD CONSTRAINT "organization_responsibles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_responsibles" ADD CONSTRAINT "organization_responsibles_direction_id_directions_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."directions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_responsibles" ADD CONSTRAINT "organization_responsibles_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_directions" ADD CONSTRAINT "product_directions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_directions" ADD CONSTRAINT "product_directions_direction_id_directions_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."directions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entry_documents" ADD CONSTRAINT "stage_entry_documents_stage_entry_id_stage_entries_id_fk" FOREIGN KEY ("stage_entry_id") REFERENCES "public"."stage_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entry_documents" ADD CONSTRAINT "stage_entry_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_messages" ADD CONSTRAINT "exchange_messages_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_group_results" ADD CONSTRAINT "learning_group_results_learning_group_id_learning_groups_id_fk" FOREIGN KEY ("learning_group_id") REFERENCES "public"."learning_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_group_results" ADD CONSTRAINT "learning_group_results_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_group_results" ADD CONSTRAINT "learning_group_results_message_fk" FOREIGN KEY ("exchange_message_id") REFERENCES "public"."exchange_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_groups" ADD CONSTRAINT "learning_groups_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_items" ADD CONSTRAINT "contract_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_contract_items" ADD CONSTRAINT "interaction_contract_items_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_contract_items" ADD CONSTRAINT "interaction_contract_items_item_belongs_to_contract" FOREIGN KEY ("contract_item_id","contract_id") REFERENCES "public"."contract_items"("id","contract_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_group_counterparty_kinds" ADD CONSTRAINT "process_group_counterparty_kinds_group_id_process_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."process_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_groups" ADD CONSTRAINT "process_groups_active_revision_id_stage_routes_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."stage_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_stage_keys" ADD CONSTRAINT "process_stage_keys_group_id_process_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."process_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_migration_rules" ADD CONSTRAINT "stage_migration_rules_revision_id_stage_routes_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."stage_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_responsibles_organization_idx" ON "organization_responsibles" USING btree ("organization_id","user_id") WHERE "organization_responsibles"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "organization_responsibles_user_idx" ON "organization_responsibles" USING btree ("user_id") WHERE "organization_responsibles"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "product_directions_direction_idx" ON "product_directions" USING btree ("direction_id");--> statement-breakpoint
CREATE INDEX "exchange_messages_queue_idx" ON "exchange_messages" USING btree ("state","next_attempt_at") WHERE "exchange_messages"."state" in ('pending', 'retrying');--> statement-breakpoint
CREATE INDEX "exchange_messages_interaction_idx" ON "exchange_messages" USING btree ("interaction_id","created_at");--> statement-breakpoint
CREATE INDEX "learning_group_results_group_idx" ON "learning_group_results" USING btree ("learning_group_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "learning_groups_external_key" ON "learning_groups" USING btree ("system","instance","group_external_id") WHERE "learning_groups"."group_external_id" is not null;--> statement-breakpoint
CREATE INDEX "contracts_organization_idx" ON "contracts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "process_group_counterparty_kinds_group_idx" ON "process_group_counterparty_kinds" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_direction_id_directions_id_fk" FOREIGN KEY ("direction_id") REFERENCES "public"."directions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_process_group_id_process_groups_id_fk" FOREIGN KEY ("process_group_id") REFERENCES "public"."process_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_subject_key" ON "users" USING btree ("external_subject") WHERE "users"."external_subject" is not null;--> statement-breakpoint
CREATE INDEX "users_manager_idx" ON "users" USING btree ("manager_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_parties_one_primary" ON "interaction_parties" USING btree ("interaction_id") WHERE "interaction_parties"."is_primary";--> statement-breakpoint
CREATE INDEX "interactions_group_status_idx" ON "interactions" USING btree ("process_group_id","status");--> statement-breakpoint
CREATE INDEX "interactions_contract_idx" ON "interactions" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "stage_entries_window_idx" ON "stage_entries" USING btree ("entered_at","left_at");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_person_key" UNIQUE("person_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_not_self" CHECK ("users"."manager_user_id" <> "users"."id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_person_matches_kind" CHECK (("organizations"."person_id" is not null) = ("organizations"."kind" = 'individual'));