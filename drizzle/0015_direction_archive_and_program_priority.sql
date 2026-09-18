ALTER TABLE "directions" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "priority" integer;