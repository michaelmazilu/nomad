import "./polyfill";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  decodePassport,
  derivePassportPda,
  getClusterConfig,
  type Cluster,
} from "@agent-passport/sdk";
import { createVerifier } from "@agent-passport/verifier";
import { PlaintextKeyStore } from "./keystore";
import { AgentKeyManager } from "./agent";
import { OwnerWallet } from "./wallet";
import { PassportClient } from "./passportClient";
import {
  LocalOwnerSigner,
  PhantomOwnerSigner,
  SponsoredOwnerSigner,
  type OwnerSigner,
} from "./ownerSigner";
import { SponsorClient } from "./sponsorClient";
import { TabPhantomBridge, type ConnectorMessage } from "./phantom";
import { NotConnectedError, RpcError } from "./errors";
import {
  CONNECTOR_URL,
  INFERENCE_PROXY_URL,
  INTENT_PROXY_URL,
  SPONSOR_URL,
  SPONSOR_AUTH_TOKEN,
} from "./config";
import {
  extractChatGptConversation,
  extractLatestChatGptUserMessage,
} from "./chatgptExtractor";
import {
  inferFromChatGptContext,
  isSupportedChatGptUrl,
  normalizeTabContext,
  parseInferenceJson,
  type ExtractedTabContext,
  type NormalizedTabContext,
} from "./inference";
const LOG_URL = INTENT_PROXY_URL.replace(/\/[^/]+$/, "/log");
function tlog(level: "log" | "warn" | "error", msg: string): void {
  console[level](`[Nomad] ${msg}`);
  fetch(LOG_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ level, msg }),
  }).catch(() => {});
}

import type {
  AgentInfo,
  AgentIntentResult,
  AirdropResult,
  AttemptResult,
  InferenceResult,
  Msg,
  OwnerInfo,
  OwnerMode,
  PassportInfo,
  TxResult,
  WalletProviderKind,
} from "./messages";

// Both keys live ONLY here, in the service worker, behind the KeyStore. The popup
// is a thin UI that messages this worker — keys never enter the popup DOM. The
// agent key signs action requests; the LOCAL owner key (dev-only) signs passport
// writes. The real owner path is Phantom, whose key never enters the extension.
const agent = new AgentKeyManager(
  new PlaintextKeyStore("agentPassport.agentKey"),
);
const localOwner = new OwnerWallet(
  new PlaintextKeyStore("agentPassport.ownerKey"),
);
// Embedded owner: an in-app authority key whose writes are paid by the sponsor
// backend. Same in-extension keypair machinery as the local owner; the
// difference is purely who pays (sponsor) and that it never needs funding.
const embeddedOwner = new OwnerWallet(
  new PlaintextKeyStore("agentPassport.embeddedOwnerKey"),
);

let sponsorSingleton: SponsorClient | null = null;
function sponsor(): SponsorClient {
  if (!sponsorSingleton) {
    sponsorSingleton = new SponsorClient(SPONSOR_URL, SPONSOR_AUTH_TOKEN);
  }
  return sponsorSingleton;
}

const PHANTOM_KEY = "agentPassport.phantom";
interface PhantomConnection {
  publicKey: string;
  walletCluster: Cluster | null;
  providerKind?: WalletProviderKind | null;
}

let bridgeSingleton: TabPhantomBridge | null = null;
function bridge(): TabPhantomBridge {
  if (!bridgeSingleton) {
    bridgeSingleton = new TabPhantomBridge(
      CONNECTOR_URL,
      chrome.runtime.id,
      async (url) => {
        await chrome.tabs.create({ url });
      },
    );
  }
  return bridgeSingleton;
}

const connect = (cluster: Cluster): Connection =>
  new Connection(getClusterConfig(cluster).rpcUrl, "confirmed");

async function loadPhantom(): Promise<PhantomConnection | null> {
  const got = await chrome.storage.local.get(PHANTOM_KEY);
  return (got[PHANTOM_KEY] as PhantomConnection | undefined) ?? null;
}
async function savePhantom(conn: PhantomConnection): Promise<void> {
  await chrome.storage.local.set({ [PHANTOM_KEY]: conn });
}

async function getBalance(cluster: Cluster, pubkey: string): Promise<number> {
  try {
    return (
      (await connect(cluster).getBalance(new PublicKey(pubkey))) /
      LAMPORTS_PER_SOL
    );
  } catch {
    return 0; // balance is display-only; don't fail the whole refresh on an RPC blip
  }
}

async function ownerAddress(mode: OwnerMode): Promise<string | null> {
  if (mode === "local") return localOwner.getPublicKey();
  if (mode === "embedded") return embeddedOwner.getPublicKey();
  return (await loadPhantom())?.publicKey ?? null;
}

/** Resolve the active owner signer. Phantom never exposes its key to us. */
async function ownerSigner(
  mode: OwnerMode,
  cluster: Cluster,
): Promise<OwnerSigner> {
  if (mode === "local") return new LocalOwnerSigner(await localOwner.keypair());
  if (mode === "embedded") {
    const keypair = await embeddedOwner.keypair();
    const client = sponsor();
    const feePayer = await client.feePayer();
    return new SponsoredOwnerSigner(keypair, client, feePayer);
  }
  const conn = await loadPhantom();
  if (!conn)
    throw new NotConnectedError(
      "Connect Phantom before signing a passport write.",
    );
  return new PhantomOwnerSigner(
    bridge(),
    new PublicKey(conn.publicKey),
    cluster,
    conn.walletCluster,
    conn.providerKind ?? "injected",
  );
}

async function readPassport(
  cluster: Cluster,
): Promise<PassportInfo["passport"]> {
  const agentPk = await agent.getPublicKey();
  if (!agentPk) return null;
  const cfg = getClusterConfig(cluster);
  const [pda] = derivePassportPda(
    new PublicKey(agentPk),
    new PublicKey(cfg.programId),
  );
  const info = await new Connection(cfg.rpcUrl, "confirmed").getAccountInfo(
    pda,
  );
  if (!info) return null;
  const p = decodePassport(Uint8Array.from(info.data));
  return { scopes: p.permissions, label: p.label };
}

async function activeChatGptContext(): Promise<NormalizedTabContext> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id || !tab.url) {
    throw new Error("Open a ChatGPT tab before inferring permissions.");
  }
  if (!isSupportedChatGptUrl(tab.url)) {
    throw new Error("Inference currently supports chatgpt.com tabs only.");
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractChatGptConversation,
  });
  const extracted = injection?.result as ExtractedTabContext | undefined;
  if (!extracted) {
    throw new Error("Could not read the active ChatGPT tab.");
  }
  return normalizeTabContext({
    url: tab.url,
    title: tab.title ?? extracted.title,
    text: extracted.text,
  });
}

/** Read the most recent message the user sent in the active ChatGPT tab. */
async function activeChatGptLatestUserText(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tlog("log", `activeChatGptLatestUserText: active tab = ${tab?.url ?? "(none)"}`);
  if (!tab?.id || !tab.url) {
    throw new Error("Open a ChatGPT tab to detect agent intent.");
  }
  if (!isSupportedChatGptUrl(tab.url)) {
    tlog("warn", `tab URL not supported for agent detection: ${tab.url}`);
    throw new Error("Agent detection supports chatgpt.com tabs only.");
  }
  tlog("log", `injecting extractor into tab ${tab.id}`);
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractLatestChatGptUserMessage,
  });
  const extracted = injection?.result as ExtractedTabContext | undefined;
  tlog("log", `injection result: ${JSON.stringify(extracted)}`);
  return extracted?.text ?? "";
}

// Remember the last message we classified so polling doesn't re-ask Haiku about
// text the user already sent (and so the popup only reacts to fresh messages).
let lastClassifiedText: string | null = null;

/**
 * Ask the backend intent proxy (which holds the Anthropic key and calls Haiku
 * 4.5) whether a single ChatGPT message asks to create an agent.
 */
async function classifyAgentIntent(text: string): Promise<boolean> {
  tlog("log", `classifyAgentIntent: POSTing to ${INTENT_PROXY_URL}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(INTENT_PROXY_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await response.text();
    tlog("log", `classifyAgentIntent: proxy responded ${response.status} ${body}`);
    if (!response.ok) {
      throw new Error(
        `intent proxy failed (${response.status}): ${body || response.statusText}`,
      );
    }
    const parsed = JSON.parse(body) as { wantsAgent?: boolean };
    return parsed.wantsAgent === true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("agent intent detection timed out");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function inferPermissionsFromContext(
  context: NormalizedTabContext,
): Promise<InferenceResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const resultWithSource = (
    fields: Omit<InferenceResult, "source">,
  ): InferenceResult => {
    const warnings = [...fields.warnings];
    if (context.truncated) {
      warnings.push("Conversation text was truncated before inference.");
    }
    return {
      ...fields,
      warnings,
      source: {
        url: context.url,
        ...(context.title ? { title: context.title } : {}),
      },
    };
  };

  try {
    const response = await fetch(INFERENCE_PROXY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        schema: "nomad.permission_inference.v1",
        instructions:
          "Return strict JSON only with agentName, label, scopes, and optional testAction. Scopes must be lowercase Nomad permission strings.",
        context: {
          url: context.url,
          title: context.title,
          text: context.text,
          truncated: context.truncated,
        },
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `inference proxy failed (${response.status}): ${body || response.statusText}`,
      );
    }
    return resultWithSource(parseInferenceJson(body));
  } catch (e) {
    const reason =
      e instanceof DOMException && e.name === "AbortError"
        ? "Inference proxy timed out; used local ChatGPT inference."
        : "Inference proxy unavailable; used local ChatGPT inference.";
    return resultWithSource(inferFromChatGptContext(context, reason));
  } finally {
    clearTimeout(timeout);
  }
}

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case "AGENT_ENSURE":
      return { agentPublicKey: await agent.getOrCreate() } satisfies AgentInfo;
    case "AGENT_GET":
      return { agentPublicKey: await agent.getPublicKey() } satisfies AgentInfo;

    case "PHANTOM_CONNECT": {
      const { publicKey, walletCluster, providerKind } = await bridge().connect(
        msg.cluster,
      );
      await savePhantom({ publicKey, walletCluster, providerKind });
      const balanceSol = await getBalance(msg.cluster, publicKey);
      return {
        kind: "phantom",
        ownerPublicKey: publicKey,
        balanceSol,
        providerKind,
        walletCluster,
      } satisfies OwnerInfo;
    }
    case "OWNER_EMBEDDED_ENSURE": {
      // Create (or load) the in-app authority key. It never needs funding — the
      // sponsor pays — so balance is display-only and expected to be zero.
      const ownerPublicKey = await embeddedOwner.getOrCreate();
      return {
        kind: "embedded",
        ownerPublicKey,
        balanceSol: await getBalance(msg.cluster, ownerPublicKey),
      } satisfies OwnerInfo;
    }
    case "OWNER_LOCAL_ENSURE": {
      const ownerPublicKey = await localOwner.getOrCreate();
      return {
        kind: "local",
        ownerPublicKey,
        balanceSol: 0,
      } satisfies OwnerInfo;
    }
    case "OWNER_GET": {
      const ownerPublicKey = await ownerAddress(msg.mode);
      const balanceSol = ownerPublicKey
        ? await getBalance(msg.cluster, ownerPublicKey)
        : 0;
      const phantom = msg.mode === "phantom" ? await loadPhantom() : null;
      const walletCluster = phantom?.walletCluster ?? null;
      const providerKind = phantom?.providerKind ?? null;
      return {
        kind: ownerPublicKey ? msg.mode : null,
        ownerPublicKey,
        balanceSol,
        providerKind,
        walletCluster,
      } satisfies OwnerInfo;
    }
    case "OWNER_AIRDROP": {
      const addr = await ownerAddress(msg.mode);
      if (!addr) throw new NotConnectedError("No owner wallet to airdrop to.");
      const c = connect(msg.cluster);
      let txSig: string;
      try {
        txSig = await c.requestAirdrop(
          new PublicKey(addr),
          2 * LAMPORTS_PER_SOL,
        );
        await c.confirmTransaction(txSig, "confirmed");
      } catch (e) {
        throw new RpcError(
          "airdrop failed (devnet faucet limits, or localnet not running)",
          e,
        );
      }
      const balanceSol =
        (await c.getBalance(new PublicKey(addr))) / LAMPORTS_PER_SOL;
      return { balanceSol, txSig } satisfies AirdropResult;
    }

    case "PASSPORT_READ":
      return {
        passport: await readPassport(msg.cluster),
      } satisfies PassportInfo;
    case "PASSPORT_CREATE": {
      const agentPk = await agent.getOrCreate();
      const owner = await ownerSigner(msg.mode, msg.cluster);
      const client = new PassportClient(msg.cluster);
      const txSig = await client.initialize(
        owner,
        new PublicKey(agentPk),
        msg.label,
        msg.scopes,
      );
      return { txSig, cluster: msg.cluster } satisfies TxResult;
    }
    case "PASSPORT_UPDATE": {
      const agentPk = await agent.getOrCreate();
      const owner = await ownerSigner(msg.mode, msg.cluster);
      const client = new PassportClient(msg.cluster);
      const txSig = await client.update(
        owner,
        new PublicKey(agentPk),
        msg.label,
        msg.scopes,
      );
      return { txSig, cluster: msg.cluster } satisfies TxResult;
    }
    case "PASSPORT_REVOKE": {
      const agentPk = await agent.getOrCreate();
      const owner = await ownerSigner(msg.mode, msg.cluster);
      const client = new PassportClient(msg.cluster);
      const txSig = await client.revoke(owner, new PublicKey(agentPk));
      return { txSig, cluster: msg.cluster } satisfies TxResult;
    }

    case "ATTEMPT_ACTION": {
      // The agent signs the action; the verifier checks it against the live
      // on-chain passport and returns the real decision.
      const signed = await agent.signAction({
        action: msg.action,
        timestamp: Date.now(),
      });
      const result = await createVerifier({ cluster: msg.cluster }).verify(
        signed,
      );
      return {
        status: result.status,
        reason: result.reason,
        scopes: result.passport?.permissions ?? null,
        signed,
      } satisfies AttemptResult;
    }
    case "AGENT_GET_PUBLIC_KEY":
      return { agentPublicKey: await agent.getOrCreate() };

    case "AGENT_SIGN_MESSAGE":
      return await agent.signMessage(msg.message);

    case "INFER_PERMISSIONS_FROM_ACTIVE_TAB": {
      const context = await activeChatGptContext();
      return await inferPermissionsFromContext(context);
    }
    case "DETECT_AGENT_INTENT_FROM_ACTIVE_TAB": {
      tlog("log", "DETECT_AGENT_INTENT_FROM_ACTIVE_TAB received");
      const text = await activeChatGptLatestUserText();
      tlog("log", `extracted text: ${JSON.stringify(text)}`);
      tlog("log", `lastClassifiedText: ${JSON.stringify(lastClassifiedText)}`);
      if (!text || text === lastClassifiedText) {
        tlog("log", "skipping — no new text");
        return {
          changed: false,
          wantsAgent: false,
          text: text || null,
        } satisfies AgentIntentResult;
      }
      tlog("log", `calling classifyAgentIntent: "${text.slice(0, 100)}"`);
      let wantsAgent = false;
      try {
        wantsAgent = await classifyAgentIntent(text);
        lastClassifiedText = text;
      } catch (e) {
        tlog("error", `classifyAgentIntent failed: ${e instanceof Error ? e.message : String(e)}`);
        return { changed: false, wantsAgent: false, text } satisfies AgentIntentResult;
      }
      tlog("log", `classifyAgentIntent result: wantsAgent = ${wantsAgent}`);
      return { changed: true, wantsAgent, text } satisfies AgentIntentResult;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg as Msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) =>
      sendResponse({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  return true; // async response
});

function shouldCloseConnectorTab(msg: unknown): boolean {
  const m = msg as Partial<ConnectorMessage> | null;
  return m?.type === "CONNECTOR_PUSH" && "ok" in m && m.ok === true;
}

function connectorMatchPattern(): string {
  return `${new URL(CONNECTOR_URL).origin}/*`;
}

async function closeConnectorTab(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  if (!shouldCloseConnectorTab(msg)) return;
  if (sender.tab?.id !== undefined) {
    await chrome.tabs.remove(sender.tab.id);
    return;
  }
  const req = (msg as Partial<ConnectorMessage> | null)?.req;
  if (!req) return;
  const reqParam = `req=${encodeURIComponent(req)}`;
  const tabs = await chrome.tabs.query({ url: connectorMatchPattern() });
  const tabIds = tabs
    .filter((tab) => tab.id !== undefined && tab.url?.includes(reqParam))
    .map((tab) => tab.id!);
  if (tabIds.length > 0) await chrome.tabs.remove(tabIds);
}

// External messages come from (a) the Phantom connector page relaying connect /
// sign results, and (b) agent web pages doing read-only action attempts. Writes
// and key export are never allowed from outside.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const connectorReply = bridge().handleConnectorMessage(
    msg as ConnectorMessage,
  );
  if (connectorReply.handled) {
    sendResponse(connectorReply.response);
    setTimeout(() => {
      void closeConnectorTab(msg, sender);
    }, 650);
    return false;
  }
  const m = msg as Msg;
  if (m.type === "ATTEMPT_ACTION" || m.type === "AGENT_GET") {
    handle(m)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true;
  }
  sendResponse({ ok: false, error: "request type not allowed externally" });
  return false;
});
