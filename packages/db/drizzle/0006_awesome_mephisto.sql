ALTER TABLE "editor_history_nodes" ALTER COLUMN "snapshot_object_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "editor_history_nodes" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;