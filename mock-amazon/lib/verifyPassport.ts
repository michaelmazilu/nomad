// ============================================================================
// SERVER-ONLY. The POS verification core, mirroring steps 5–6 of the Nomad
// verifier pipeline (verifier/src/verify.ts) and its reader contract
// (verifier/src/passportReader.ts):
//
//   derive PDA from ["passport", agentPubkey]  ->  read account  ->  permits()
//
// The on-chain read is injected as a `PassportReader` so the pipeline is pure and
// unit-testable without a network. The route wires in an RPC-backed reader; tests
// pass a fake one. Fail-closed: a reader that throws (RPC error or malformed
// account data) yields `verifier_unavailable`, never `ok`.
//
// Do NOT import this from a client component — it pulls in @solana/web3.js.
// ============================================================================
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodePassport,
  derivePassportPda,
  getClusterConfig,
  permits,
  tryFromBase58,
  PUBLIC_KEY_LENGTH,
  type Cluster,
  type ClusterConfig,
  type Passport,
} from "./nomadPassport";

/** The scope a checkout/purchase requires — a real Nomad action string. */
export const PURCHASE_ACTION = "payments.charge";

/** Status vocabulary, mirrored from verifier/src/types.ts (+ input-shape errors). */
export type VerifyStatus =
  | "ok"
  | "no_passport"
  | "not_permitted"
  | "bad_agent_id"
  | "empty_agent_id"
  | "verifier_unavailable";

export interface VerifyResult {
  status: VerifyStatus;
  ok: boolean;
  label?: string;
  scopes?: string[];
}

/**
 * Reads a passport for an agent. Contract (matches RpcPassportReader):
 *  - resolve to the decoded passport when one exists,
 *  - resolve to `null` when no account exists at the derived PDA, or the account
 *    isn't owned by our program (never issued / revoked) → `no_passport`,
 *  - THROW on RPC/transport failure OR malformed account data — the caller fails
 *    closed (`verifier_unavailable`).
 */
export type PassportReader = (
  agentPublicKey: PublicKey,
) => Promise<Passport | null>;

/** HTTP status for each verdict, so the route maps results uniformly. */
export const HTTP_STATUS: Record<VerifyStatus, number> = {
  ok: 200,
  empty_agent_id: 400,
  bad_agent_id: 400,
  no_passport: 403,
  not_permitted: 403,
  verifier_unavailable: 503,
};

/**
 * Pure verification pipeline. Validates the Agent ID, reads its passport via the
 * injected reader, and applies permits(scopes, "payments.charge").
 */
export async function verifyPassport(
  agentIdRaw: string,
  read: PassportReader,
): Promise<VerifyResult> {
  const agentId = (agentIdRaw ?? "").trim();
  if (!agentId) return { status: "empty_agent_id", ok: false };

  // Must be a valid 32-byte Ed25519 public key before any network call.
  const raw = tryFromBase58(agentId);
  if (!raw || raw.length !== PUBLIC_KEY_LENGTH) {
    return { status: "bad_agent_id", ok: false };
  }

  let passport: Passport | null;
  try {
    passport = await read(new PublicKey(raw));
  } catch {
    // RPC error or malformed account data — fail closed, never an approval.
    return { status: "verifier_unavailable", ok: false };
  }

  if (!passport) return { status: "no_passport", ok: false };

  if (!permits(passport.permissions, PURCHASE_ACTION)) {
    return { status: "not_permitted", ok: false, scopes: passport.permissions };
  }
  return {
    status: "ok",
    ok: true,
    label: passport.label,
    scopes: passport.permissions,
  };
}

/**
 * Resolve the cluster/RPC/program config from env. NOMAD_* are canonical;
 * SOLANA_RPC_URL / PROGRAM_ID are accepted as fallbacks. A cluster mismatch
 * silently reads an empty PDA and denies as no_passport, so pin these to where
 * the passport was actually created.
 */
export function resolveClusterConfig(): ClusterConfig {
  const cluster = (process.env.NOMAD_CLUSTER ?? "devnet") as Cluster;
  const rpcUrl = process.env.NOMAD_RPC_URL ?? process.env.SOLANA_RPC_URL;
  const programId = process.env.NOMAD_PROGRAM_ID ?? process.env.PROGRAM_ID;
  return getClusterConfig(cluster, {
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(programId ? { programId } : {}),
  });
}

/**
 * Build the real RPC-backed reader — the single network call lives here. Mirrors
 * verifier/src/passportReader.ts: derive the PDA, getAccountInfo (null = missing),
 * verify program ownership, then decode (a throw here propagates as fail-closed).
 */
export function rpcReader(
  rpcUrl: string,
  programId: PublicKey,
): PassportReader {
  const connection = new Connection(rpcUrl, "confirmed");
  return async (agentPublicKey) => {
    const [pda] = derivePassportPda(agentPublicKey, programId);
    const info = await connection.getAccountInfo(pda, "confirmed");
    if (!info) return null;
    // Defense in depth: a real passport PDA is owned by our program.
    if (!info.owner.equals(programId)) return null;
    return decodePassport(Uint8Array.from(info.data));
  };
}
