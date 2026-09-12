CREATE TYPE "public"."consent_basis" AS ENUM('consent', 'contract', 'legal');--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"basis" "consent_basis" NOT NULL,
	"text_version" text NOT NULL,
	"given_at" date NOT NULL,
	"withdrawn_at" date,
	"withdrawn_by" uuid,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_withdrawal_ordered" CHECK ("consents"."withdrawn_at" is null or "consents"."withdrawn_at" >= "consents"."given_at"),
	CONSTRAINT "consents_withdrawn_by_requires_withdrawal" CHECK ("consents"."withdrawn_by" is null or "consents"."withdrawn_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "retention_until" date;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_supersedes_id_documents_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_supersedes_key" ON "documents" USING btree ("supersedes_id") WHERE "documents"."supersedes_id" is not null;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_supersedes_not_self" CHECK ("documents"."supersedes_id" is null or "documents"."supersedes_id" <> "documents"."id");