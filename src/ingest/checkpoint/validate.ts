/**
 * Validate agent session checkpoints against the Build OS contract.
 *
 * The schema is vendored from `build-os/contracts/agent-session-checkpoint.v1.schema.json` so
 * this package stays self-contained and extractable (DEC-008). `tests/contract-sync.test.ts`
 * asserts the two copies are identical whenever the canonical file is reachable.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./agent-session-checkpoint.v1.schema.json" with { type: "json" };

export interface SessionCheckpointV1 {
  schema_version: "1";
  repository: string;
  workstream_id?: string | null;
  session_id: string;
  agent: "claude" | "chatgpt" | "codex" | "human" | "other";
  agent_name?: string | null;
  session_kind: "DESIGN" | "IMPLEMENTATION" | "REVIEW" | "INVESTIGATION" | "OPERATIONS";
  objective: string;
  status: "ACTIVE" | "WAITING" | "BLOCKED" | "COMPLETED" | "ABANDONED";
  phase?: string | null;
  completed?: string[];
  in_progress?: string[];
  blockers?: { description: string; needs_owner: boolean }[];
  next_step?: string | null;
  related_pr?: number | null;
  updated_at: string;
}

export type CheckpointValidation =
  | { ok: true; checkpoint: SessionCheckpointV1 }
  | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const compiled: ValidateFunction = ajv.compile(schema);

function describe(error: ErrorObject): string {
  const at = error.instancePath === "" ? "(root)" : error.instancePath;
  return `${at} ${error.message ?? "is invalid"}`;
}

/**
 * A checkpoint whose `schema_version` is not understood is rejected rather than
 * partially accepted. Guessing at an unknown contract version is how a "state, never
 * transcript" guarantee quietly stops holding.
 */
export function validateCheckpoint(input: unknown): CheckpointValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["(root) must be an object"] };
  }

  const version = (input as Record<string, unknown>).schema_version;
  if (version !== "1") {
    return {
      ok: false,
      errors: [`(root) unsupported schema_version ${JSON.stringify(version)}; this consumer understands "1"`],
    };
  }

  if (compiled(input)) return { ok: true, checkpoint: input as SessionCheckpointV1 };
  return { ok: false, errors: (compiled.errors ?? []).map(describe) };
}
