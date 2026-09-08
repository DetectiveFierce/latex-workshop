CREATE TABLE "agent_client_policies" (
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"all_projects" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_client_policies_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);--> statement-breakpoint
ALTER TABLE "agent_client_policies" ADD CONSTRAINT "agent_client_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
