import type { Db } from "@paperclipai/db";
import { issueThreadInteractions } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

/** An addressed card permits a response run, not ownership of its issue. */
export async function isPendingIssueInteractionWake(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown>;
    /** Use only inside a transaction that has already locked the issue. */
    lockInteraction?: boolean;
  },
): Promise<boolean> {
  const context = input.contextSnapshot;
  if (context.wakeReason !== "interaction_pending" || context.source !== "issue.interaction.created") {
    return false;
  }
  const interactionId = context.interactionId;
  if (typeof interactionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(interactionId)) {
    return false;
  }
  // Re-read durable state at admission. A context string alone must not
  // bypass ownership; answered or readdressed cards must stop queued wakes.
  const query = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
    eq(issueThreadInteractions.status, "pending"),
  )).limit(1);
  const [interaction] = await (input.lockInteraction ? query.for("update") : query);
  if (!interaction) return false;
  const payload = interaction.payload;
  return issueThreadInteractionAttentionAgentAllowed({
    agentId: input.agentId,
    interaction,
    governedAction: interaction.kind === "request_confirmation" &&
      typeof payload === "object" && payload !== null &&
      "toolAction" in payload && payload.toolAction !== undefined,
  });
}
