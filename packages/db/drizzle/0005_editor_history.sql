ALTER TABLE "user_preferences" ADD COLUMN "keyboard_keymap" text DEFAULT 'linux' NOT NULL;
--> statement-breakpoint
CREATE TABLE "editor_history_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"parent_id" uuid,
	"preferred_child_id" uuid,
	"before_hash" text NOT NULL,
	"after_hash" text NOT NULL,
	"patch" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot_object_key" text NOT NULL,
	"summary" text NOT NULL,
	"selection_before" jsonb,
	"selection_after" jsonb,
	"client_mutation_id" uuid NOT NULL,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editor_history_state" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"current_node_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "editor_history_nodes" ADD CONSTRAINT "editor_history_nodes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "editor_history_nodes" ADD CONSTRAINT "editor_history_nodes_parent_id_editor_history_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."editor_history_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "editor_history_state" ADD CONSTRAINT "editor_history_state_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "editor_history_state" ADD CONSTRAINT "editor_history_state_current_node_id_editor_history_nodes_id_fk" FOREIGN KEY ("current_node_id") REFERENCES "public"."editor_history_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "editor_history_entry_created_idx" ON "editor_history_nodes" USING btree ("entry_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "editor_history_entry_mutation_idx" ON "editor_history_nodes" USING btree ("entry_id","client_mutation_id");
