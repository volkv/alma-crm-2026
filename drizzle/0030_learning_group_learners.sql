-- Поимённый список слушателей учебной группы: группа × человек из справочника
-- и то, передан ли человек в систему обучения. Строка связи персональных данных
-- не несёт — они живут в `people` и уничтожаются там же.
CREATE TYPE "public"."learner_status" AS ENUM('listed', 'transferred');--> statement-breakpoint
CREATE TABLE "learning_group_learners" (
	"learning_group_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" "learner_status" DEFAULT 'listed' NOT NULL,
	"added_by" uuid,
	"transferred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_group_learners_learning_group_id_person_id_pk" PRIMARY KEY("learning_group_id","person_id"),
	CONSTRAINT "learning_group_learners_transfer_whole" CHECK (("learning_group_learners"."status" = 'transferred') = ("learning_group_learners"."transferred_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "learning_group_learners" ADD CONSTRAINT "learning_group_learners_learning_group_id_learning_groups_id_fk" FOREIGN KEY ("learning_group_id") REFERENCES "public"."learning_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_group_learners" ADD CONSTRAINT "learning_group_learners_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_group_learners" ADD CONSTRAINT "learning_group_learners_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learning_group_learners_person_idx" ON "learning_group_learners" USING btree ("person_id");