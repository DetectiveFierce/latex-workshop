CREATE TYPE "public"."compile_target" AS ENUM('accepted', 'proposal');--> statement-breakpoint
ALTER TYPE "public"."checkpoint_reason" ADD VALUE 'proposal';--> statement-breakpoint
ALTER TYPE "public"."compile_trigger" ADD VALUE 'agent';--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "target" "compile_target" DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "proposal_revision" integer;--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD COLUMN "target" "compile_target" DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD COLUMN "proposal_revision" integer;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_proposal_id_agent_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."agent_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compile_jobs" ADD CONSTRAINT "compile_jobs_proposal_id_agent_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."agent_proposals"("id") ON DELETE set null ON UPDATE no action;