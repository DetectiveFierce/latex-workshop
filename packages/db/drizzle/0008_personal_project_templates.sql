ALTER TABLE "projects" ADD COLUMN "is_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "user_template_seeds" (
	"user_id" text NOT NULL,
	"seed_key" text NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_template_seeds_user_id_seed_key_pk" PRIMARY KEY("user_id","seed_key")
);--> statement-breakpoint
ALTER TABLE "user_template_seeds" ADD CONSTRAINT "user_template_seeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_template_seeds" ADD CONSTRAINT "user_template_seeds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_template_trash_idx" ON "projects" USING btree ("is_template","trashed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_template_seeds_project_idx" ON "user_template_seeds" USING btree ("project_id");
