DROP INDEX "agent_proposals_one_unresolved_idx";--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "direct_edit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD COLUMN "request_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_proposals_one_unresolved_idx" ON "agent_proposals" USING btree ("project_id") WHERE "agent_proposals"."direct_edit" = false and "agent_proposals"."status" in ('draft', 'needs_rebase', 'reviewing');