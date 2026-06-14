import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { Passport } from "../lib/nomadPassport";
import {
  verifyPassport,
  PURCHASE_ACTION,
  type PassportReader,
} from "../lib/verifyPassport";

// A real, valid Base58 agent public key — so the input-validation gate passes and
// the reader is actually consulted.
const AGENT_ID = Keypair.generate().publicKey.toBase58();

function passport(permissions: string[]): Passport {
  return {
    version: 1,
    bump: 255,
    authority: Keypair.generate().publicKey.toBase58(),
    agent: AGENT_ID,
    label: "Shopping Agent",
    permissions,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Fake reader: returns a passport, returns null (missing), or throws (RPC down). */
function reader(behavior: {
  passport?: Passport | null;
  throws?: boolean;
}): PassportReader {
  return async () => {
    if (behavior.throws) throw new Error("rpc down");
    return behavior.passport ?? null;
  };
}

describe("verifyPassport", () => {
  it("ok — passport grants the purchase scope (exact match)", async () => {
    const r = await verifyPassport(
      AGENT_ID,
      reader({ passport: passport([PURCHASE_ACTION, "commerce.checkout"]) }),
    );
    expect(r).toEqual({
      status: "ok",
      ok: true,
      label: "Shopping Agent",
      scopes: [PURCHASE_ACTION, "commerce.checkout"],
    });
  });

  it("ok — purchase granted via a trailing ns.* wildcard", async () => {
    const r = await verifyPassport(
      AGENT_ID,
      reader({ passport: passport(["payments.*"]) }),
    );
    expect(r.status).toBe("ok");
    expect(r.ok).toBe(true);
  });

  it("no_passport — reader finds no account (unregistered or revoked)", async () => {
    const r = await verifyPassport(AGENT_ID, reader({ passport: null }));
    expect(r).toEqual({ status: "no_passport", ok: false });
  });

  it("not_permitted — passport exists but lacks the purchase scope", async () => {
    const r = await verifyPassport(
      AGENT_ID,
      reader({ passport: passport(["calendar.read", "mail.send"]) }),
    );
    expect(r).toEqual({
      status: "not_permitted",
      ok: false,
      scopes: ["calendar.read", "mail.send"],
    });
  });

  it("bad_agent_id — not a valid 32-byte Base58 public key (no read)", async () => {
    let read = false;
    const r = await verifyPassport("not-a-valid-key-!!!", async () => {
      read = true;
      return null;
    });
    expect(r).toEqual({ status: "bad_agent_id", ok: false });
    expect(read).toBe(false); // rejected before any network call
  });

  it("empty_agent_id — blank input short-circuits before any read", async () => {
    let read = false;
    const r = await verifyPassport("   ", async () => {
      read = true;
      return null;
    });
    expect(r).toEqual({ status: "empty_agent_id", ok: false });
    expect(read).toBe(false);
  });

  it("verifier_unavailable — a reader throw fails closed, never ok", async () => {
    const r = await verifyPassport(AGENT_ID, reader({ throws: true }));
    expect(r).toEqual({ status: "verifier_unavailable", ok: false });
  });
});
