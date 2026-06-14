import { PublicKey } from "@solana/web3.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DECODE_MAP = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET.charCodeAt(i)] = i;
  return m;
})();

const PASSPORT_SEED = "passport";
const seedBytes = new TextEncoder().encode(PASSPORT_SEED);
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export const PUBLIC_KEY_LENGTH = 32;
const ACCOUNT_DISCRIMINATOR_LENGTH = 8;
const AGENT_PASSPORT_PROGRAM_ID =
  "HffPjZ3SXPAPzJRuKfNnihNHbFtv6LAaeH29nCs54BEX";

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

export interface ClusterConfig {
  cluster: Cluster;
  rpcUrl: string;
  programId: string;
}

export interface Passport {
  version: number;
  bump: number;
  authority: string;
  agent: string;
  label: string;
  permissions: string[];
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_RPC_URLS: Record<Cluster, string> = {
  localnet: "http://127.0.0.1:8899",
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

const DEFAULT_PROGRAM_IDS: Record<Cluster, string> = {
  localnet: AGENT_PASSPORT_PROGRAM_ID,
  devnet: AGENT_PASSPORT_PROGRAM_ID,
  "mainnet-beta": AGENT_PASSPORT_PROGRAM_ID,
};

function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function tryFromBase58(str: string): Uint8Array | null {
  try {
    if (str.length === 0) return new Uint8Array(0);

    let zeros = 0;
    while (zeros < str.length && str[zeros] === "1") zeros++;

    const bytes: number[] = [];
    for (let i = zeros; i < str.length; i++) {
      const code = str.charCodeAt(i);
      const value = code < 128 ? DECODE_MAP[code]! : -1;
      if (value < 0) return null;
      let carry = value;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j]! * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) {
        bytes.push(carry & 0xff);
        carry >>= 8;
      }
    }

    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      out[zeros + bytes.length - 1 - i] = bytes[i]!;
    }
    return out;
  } catch {
    return null;
  }
}

class BorshReader {
  private off = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private ensure(n: number): void {
    if (this.off + n > this.data.length) {
      throw new Error("passport decode out of bounds");
    }
  }

  skip(n: number): void {
    this.ensure(n);
    this.off += n;
  }

  u8(): number {
    this.ensure(1);
    return this.view.getUint8(this.off++);
  }

  u32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.off, true);
    this.off += 4;
    return value;
  }

  i64(): number {
    this.ensure(8);
    const value = this.view.getBigInt64(this.off, true);
    this.off += 8;
    return Number(value);
  }

  pubkey(): string {
    this.ensure(PUBLIC_KEY_LENGTH);
    const slice = this.data.subarray(this.off, this.off + PUBLIC_KEY_LENGTH);
    this.off += PUBLIC_KEY_LENGTH;
    return encodeBase58(slice);
  }

  string(): string {
    const len = this.u32();
    this.ensure(len);
    const slice = this.data.subarray(this.off, this.off + len);
    this.off += len;
    return textDecoder.decode(slice);
  }

  vecString(): string[] {
    const count = this.u32();
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(this.string());
    return out;
  }
}

export function decodePassport(data: Uint8Array): Passport {
  const r = new BorshReader(data);
  r.skip(ACCOUNT_DISCRIMINATOR_LENGTH);
  return {
    version: r.u8(),
    bump: r.u8(),
    authority: r.pubkey(),
    agent: r.pubkey(),
    label: r.string(),
    permissions: r.vecString(),
    createdAt: r.i64(),
    updatedAt: r.i64(),
  };
}

export function derivePassportPda(
  agent: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seedBytes, agent.toBuffer()],
    programId,
  );
}

export function getClusterConfig(
  cluster: Cluster,
  overrides: Partial<Omit<ClusterConfig, "cluster">> = {},
): ClusterConfig {
  return {
    cluster,
    rpcUrl: overrides.rpcUrl ?? DEFAULT_RPC_URLS[cluster],
    programId: overrides.programId ?? DEFAULT_PROGRAM_IDS[cluster],
  };
}

export function permits(
  grantedScopes: readonly string[],
  action: string,
): boolean {
  for (const granted of grantedScopes) {
    if (granted === action) return true;
    if (granted.endsWith(".*")) {
      const prefix = granted.slice(0, -1);
      if (action.startsWith(prefix)) return true;
    }
  }
  return false;
}
