ALTER TABLE "checkpoints" ADD COLUMN "folder_paths" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "main_file_path" text;