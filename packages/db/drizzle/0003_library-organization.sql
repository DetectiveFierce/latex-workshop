CREATE TABLE "library_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"trashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tag_assignments" (
	"project_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_tag_assignments_project_id_tag_id_pk" PRIMARY KEY("project_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "project_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'green' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD COLUMN "favorite" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD COLUMN "last_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD COLUMN "trashed_by_folder_id" uuid;--> statement-breakpoint
ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tag_assignments" ADD CONSTRAINT "project_tag_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tag_assignments" ADD CONSTRAINT "project_tag_assignments_tag_id_project_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."project_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tag_assignments" ADD CONSTRAINT "project_tag_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_folders_user_idx" ON "library_folders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "library_folders_parent_idx" ON "library_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_folders_active_sibling_name_idx" ON "library_folders" USING btree ("user_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name")) WHERE "library_folders"."trashed_at" is null;--> statement-breakpoint
CREATE INDEX "project_tag_assignments_user_idx" ON "project_tag_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_tag_assignments_tag_idx" ON "project_tag_assignments" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "project_tags_user_idx" ON "project_tags" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tags_user_name_idx" ON "project_tags" USING btree ("user_id",lower("name"));--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_folder_id_library_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_trashed_by_folder_id_library_folders_id_fk" FOREIGN KEY ("trashed_by_folder_id") REFERENCES "public"."library_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_folder_idx" ON "project_memberships" USING btree ("folder_id");