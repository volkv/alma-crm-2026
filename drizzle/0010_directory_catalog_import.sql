CREATE TYPE "public"."directory_import_row_action" AS ENUM('create', 'update', 'unchanged', 'error');--> statement-breakpoint
CREATE TYPE "public"."directory_import_status" AS ENUM('uploading', 'mapped', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "directory_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"origin" integer NOT NULL,
	"action" "directory_import_row_action" DEFAULT 'error' NOT NULL,
	"organization_name" text,
	"organization_inn" text,
	"vendor_name" text,
	"product_name" text,
	"product_code" text,
	"direction_name" text,
	"contract_number" text,
	"contract_signed_on" date,
	"contract_valid_until" date,
	"license_signed_at" date,
	"license_until" date,
	"transfer_status" text,
	"organization_id" uuid,
	"product_id" uuid,
	"contract_id" uuid,
	"contract_item_id" uuid,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"creations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_import_rows_error_has_issue" CHECK (("directory_import_rows"."action" = 'error') = (jsonb_array_length("directory_import_rows"."issues") > 0))
);
--> statement-breakpoint
CREATE TABLE "directory_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "directory_import_status" DEFAULT 'uploading' NOT NULL,
	"file_document_id" uuid,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"create_count" integer DEFAULT 0 NOT NULL,
	"update_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_by" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_imports_confirmed_has_moment" CHECK (("directory_imports"."status" = 'confirmed') = ("directory_imports"."confirmed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "directory_import_rows" ADD CONSTRAINT "directory_import_rows_import_id_directory_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."directory_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_import_rows" ADD CONSTRAINT "directory_import_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_import_rows" ADD CONSTRAINT "directory_import_rows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_import_rows" ADD CONSTRAINT "directory_import_rows_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_import_rows" ADD CONSTRAINT "directory_import_rows_contract_item_id_contract_items_id_fk" FOREIGN KEY ("contract_item_id") REFERENCES "public"."contract_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_imports" ADD CONSTRAINT "directory_imports_file_document_id_documents_id_fk" FOREIGN KEY ("file_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_imports" ADD CONSTRAINT "directory_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_imports" ADD CONSTRAINT "directory_imports_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_import_rows_import_row_key" ON "directory_import_rows" USING btree ("import_id","row_no");--> statement-breakpoint
CREATE INDEX "directory_import_rows_action_idx" ON "directory_import_rows" USING btree ("import_id","action");--> statement-breakpoint
CREATE INDEX "directory_import_rows_organization_idx" ON "directory_import_rows" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "directory_imports_status_idx" ON "directory_imports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "directory_imports_created_idx" ON "directory_imports" USING btree ("created_at");