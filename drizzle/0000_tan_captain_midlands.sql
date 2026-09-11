CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TYPE "public"."audit_source" AS ENUM('ui', 'api', 'system');--> statement-breakpoint
CREATE TYPE "public"."affiliation_role_kind" AS ENUM('rector', 'vice_rector', 'dean', 'head_of_department', 'teacher', 'coordinator', 'other');--> statement-breakpoint
CREATE TYPE "public"."education_level" AS ENUM('vo', 'spo', 'school');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."organization_kind" AS ENUM('educational_institution', 'customer_company', 'operator');--> statement-breakpoint
CREATE TYPE "public"."program_level" AS ENUM('bachelor', 'master', 'specialist', 'spo', 'school', 'dpo');--> statement-breakpoint
CREATE TYPE "public"."site_kind" AS ENUM('campus', 'branch', 'department', 'other');--> statement-breakpoint
CREATE TYPE "public"."interaction_status" AS ENUM('active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM('educational_institution', 'customer', 'operator');--> statement-breakpoint
CREATE TYPE "public"."pause_reason" AS ENUM('waiting_counterparty', 'waiting_internal', 'other');--> statement-breakpoint
CREATE TYPE "public"."stage_category" AS ENUM('contact', 'documents', 'delivery', 'implementation', 'training', 'teaching', 'update', 'control');--> statement-breakpoint
CREATE TYPE "public"."stage_outcome" AS ENUM('completed', 'returned', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."stage_transition_kind" AS ENUM('forward', 'return', 'skip');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text NOT NULL,
	"source" "audit_source" NOT NULL,
	"event_type" text NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"actor_user_id" uuid,
	"api_key_id" uuid,
	"actor_label" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"subject_type" text,
	"subject_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" text NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role_id" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid,
	"position" text NOT NULL,
	"role_kind" "affiliation_role_kind" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"channel" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliations_period_ordered" CHECK ("affiliations"."valid_to" is null or "affiliations"."valid_to" >= "affiliations"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "organization_kind" NOT NULL,
	"education_level" "education_level",
	"legal_name" text NOT NULL,
	"short_name" text NOT NULL,
	"inn" text,
	"kpp" text,
	"ogrn" text,
	"region" text,
	"website" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_education_level_matches_kind" CHECK (("organizations"."education_level" is not null) = ("organizations"."kind" = 'educational_institution'))
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"last_name" text NOT NULL,
	"first_name" text NOT NULL,
	"middle_name" text,
	"email" text,
	"phone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"vendor_organization_id" uuid,
	"description" text,
	"status" "lifecycle_status" DEFAULT 'draft' NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "program_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"summary" text NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_versions_program_version_key" UNIQUE("program_id","version")
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"level" "program_level" NOT NULL,
	"direction_code" text,
	"status" "lifecycle_status" DEFAULT 'draft' NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programs_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "site_kind" NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"region" text,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_organization_name_key" UNIQUE("organization_id","name"),
	CONSTRAINT "sites_id_organization_key" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"file_path" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"agreed_at" timestamp with time zone,
	"agreed_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"in_effect_at" timestamp with time zone,
	"in_effect_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"stage_entry_id" uuid,
	"reason_code" text NOT NULL,
	"description" text NOT NULL,
	"blocks_transition" boolean DEFAULT true NOT NULL,
	"raised_by" uuid NOT NULL,
	"assignee_user_id" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "interaction_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_role" "party_role" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"contact_affiliation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_parties_interaction_organization_key" UNIQUE("interaction_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_party_sites" (
	"party_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_party_sites_party_id_site_id_pk" PRIMARY KEY("party_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_products" (
	"interaction_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_products_interaction_id_product_id_pk" PRIMARY KEY("interaction_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_programs" (
	"interaction_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"program_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_programs_interaction_id_program_id_pk" PRIMARY KEY("interaction_id","program_id")
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"route_id" uuid NOT NULL,
	"status" "interaction_status" DEFAULT 'active' NOT NULL,
	"agreement_period_start" date,
	"agreement_period_end" date,
	"academic_period_start" date,
	"academic_period_end" date,
	"owner_user_id" uuid NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interaction_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"stage_snapshot" jsonb NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"outcome" "stage_outcome",
	"outcome_reason" text,
	"responsible_user_id" uuid,
	"waiting_party_id" uuid,
	"result_text" text,
	"confirmation" jsonb,
	"confirmation_document_id" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"checklist_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_entries_left_after_entered" CHECK ("stage_entries"."left_at" is null or "stage_entries"."left_at" >= "stage_entries"."entered_at")
);
--> statement-breakpoint
CREATE TABLE "stage_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage_entry_id" uuid NOT NULL,
	"reason" "pause_reason" NOT NULL,
	"waiting_party_id" uuid,
	"next_action" text,
	"note" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_pauses_ended_after_started" CHECK ("stage_pauses"."ended_at" > "stage_pauses"."started_at")
);
--> statement-breakpoint
CREATE TABLE "stage_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_routes_key_version_key" UNIQUE("key","version")
);
--> statement-breakpoint
CREATE TABLE "stage_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"from_stage_id" uuid NOT NULL,
	"to_stage_id" uuid NOT NULL,
	"kind" "stage_transition_kind" NOT NULL,
	"required_permission_key" text NOT NULL,
	"requires_reason" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_transitions_from_to_key" UNIQUE("from_stage_id","to_stage_id")
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" "stage_category" NOT NULL,
	"sla_days" integer NOT NULL,
	"stale_after_days" integer,
	"requires_result" boolean DEFAULT false NOT NULL,
	"requires_confirmation" boolean DEFAULT false NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stages_route_key_key" UNIQUE("route_id","key"),
	CONSTRAINT "stages_route_position_key" UNIQUE("route_id","position")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliations" ADD CONSTRAINT "affiliations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliations" ADD CONSTRAINT "affiliations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliations" ADD CONSTRAINT "affiliations_site_belongs_to_organization" FOREIGN KEY ("site_id","organization_id") REFERENCES "public"."sites"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_organization_id_organizations_id_fk" FOREIGN KEY ("vendor_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_agreed_by_users_id_fk" FOREIGN KEY ("agreed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_in_effect_by_users_id_fk" FOREIGN KEY ("in_effect_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_stage_entry_id_stage_entries_id_fk" FOREIGN KEY ("stage_entry_id") REFERENCES "public"."stage_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blockers" ADD CONSTRAINT "blockers_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_changes" ADD CONSTRAINT "interaction_changes_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_changes" ADD CONSTRAINT "interaction_changes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_parties" ADD CONSTRAINT "interaction_parties_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_parties" ADD CONSTRAINT "interaction_parties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_parties" ADD CONSTRAINT "interaction_parties_contact_affiliation_id_affiliations_id_fk" FOREIGN KEY ("contact_affiliation_id") REFERENCES "public"."affiliations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_party_sites" ADD CONSTRAINT "interaction_party_sites_party_id_interaction_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."interaction_parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_party_sites" ADD CONSTRAINT "interaction_party_sites_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_products" ADD CONSTRAINT "interaction_products_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_products" ADD CONSTRAINT "interaction_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_programs" ADD CONSTRAINT "interaction_programs_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_programs" ADD CONSTRAINT "interaction_programs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_programs" ADD CONSTRAINT "interaction_programs_program_version_id_program_versions_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."program_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_route_id_stage_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."stage_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD CONSTRAINT "stage_entries_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD CONSTRAINT "stage_entries_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD CONSTRAINT "stage_entries_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD CONSTRAINT "stage_entries_waiting_party_id_interaction_parties_id_fk" FOREIGN KEY ("waiting_party_id") REFERENCES "public"."interaction_parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD CONSTRAINT "stage_entries_confirmation_document_id_documents_id_fk" FOREIGN KEY ("confirmation_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entries" ADD CONSTRAINT "stage_entries_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_pauses" ADD CONSTRAINT "stage_pauses_stage_entry_id_stage_entries_id_fk" FOREIGN KEY ("stage_entry_id") REFERENCES "public"."stage_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_pauses" ADD CONSTRAINT "stage_pauses_waiting_party_id_interaction_parties_id_fk" FOREIGN KEY ("waiting_party_id") REFERENCES "public"."interaction_parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_route_id_stage_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."stage_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_from_stage_id_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_to_stage_id_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_required_permission_key_permissions_key_fk" FOREIGN KEY ("required_permission_key") REFERENCES "public"."permissions"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_route_id_stage_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."stage_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_inn_key" ON "organizations" USING btree ("inn") WHERE "organizations"."inn" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_external_ref_key" ON "organizations" USING btree ("external_source","external_id") WHERE "organizations"."external_source" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_external_ref_key" ON "products" USING btree ("external_source","external_id") WHERE "products"."external_source" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "programs_external_ref_key" ON "programs" USING btree ("external_source","external_id") WHERE "programs"."external_source" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sites_external_ref_key" ON "sites" USING btree ("external_source","external_id") WHERE "sites"."external_source" is not null;--> statement-breakpoint
CREATE INDEX "blockers_interaction_idx" ON "blockers" USING btree ("interaction_id","raised_at");--> statement-breakpoint
CREATE INDEX "comments_interaction_idx" ON "comments" USING btree ("interaction_id","created_at");--> statement-breakpoint
CREATE INDEX "interaction_changes_interaction_idx" ON "interaction_changes" USING btree ("interaction_id","changed_at");--> statement-breakpoint
CREATE INDEX "interactions_status_idx" ON "interactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "interactions_owner_idx" ON "interactions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "interactions_last_activity_idx" ON "interactions" USING btree ("last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_external_ref_key" ON "interactions" USING btree ("external_source","external_id") WHERE "interactions"."external_source" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_entries_one_open_per_interaction" ON "stage_entries" USING btree ("interaction_id") WHERE "stage_entries"."left_at" is null;--> statement-breakpoint
CREATE INDEX "stage_entries_interaction_idx" ON "stage_entries" USING btree ("interaction_id","entered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_pauses_one_open_per_entry" ON "stage_pauses" USING btree ("stage_entry_id") WHERE "stage_pauses"."ended_at" is null;