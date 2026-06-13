import { validatePermissions, type Cluster } from "@agent-passport/sdk";
import type {
  AgentInfo,
  AirdropResult,
  AttemptResult,
  Msg,
  OwnerInfo,
  OwnerMode,
  PassportInfo,
  Response,
  TxResult,
} from "./messages";
import { DEMO_PHANTOM_LOGIN } from "./config";

interface PhantomProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString(): string } }>;
}

declare global {
  interface Window {
    solana?: PhantomProvider;
    phantom?: { solana?: PhantomProvider };
  }
}

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const hasExtensionRuntime = (): boolean =>
  typeof chrome !== "undefined" &&
  typeof chrome.runtime?.sendMessage === "function";

function log(message: string): void {
  if (message.startsWith("error:")) {
    console.error(`[Nomad] ${message}`);
    return;
  }
  console.info(`[Nomad] ${message}`);
}

let phantomActionTimer: ReturnType<typeof setTimeout> | null = null;

function setPhantomAction(text: string, resetMs?: number): void {
  if (phantomActionTimer) {
    clearTimeout(phantomActionTimer);
    phantomActionTimer = null;
  }
  const button = el<HTMLButtonElement>("connectOwner");
  button.dataset.state = text.toLowerCase();
  button.setAttribute(
    "aria-label",
    text === "Connect" ? "Connect Phantom wallet" : `Phantom wallet ${text}`,
  );
  if (resetMs !== undefined) {
    phantomActionTimer = setTimeout(() => {
      button.dataset.state = "connect";
      button.setAttribute("aria-label", "Connect Phantom wallet");
      phantomActionTimer = null;
    }, resetMs);
  }
}

function getPhantomProvider(): PhantomProvider | undefined {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solana?.isPhantom) return window.solana;
  return undefined;
}

/** Send a message to the background worker; throws on a structured error. */
async function send<T>(msg: Msg): Promise<T> {
  if (!hasExtensionRuntime()) {
    throw new Error("Nomad extension runtime unavailable");
  }
  const res: Response = await chrome.runtime.sendMessage(msg);
  if (!res.ok) throw new Error(res.error);
  return res.data as T;
}

const cluster = (): Cluster =>
  el<HTMLSelectElement>("cluster").value as Cluster;
const ownerMode = (): OwnerMode =>
  el<HTMLSelectElement>("ownerMode").value as OwnerMode;

let currentAgent: AgentInfo = { agentPublicKey: null };
let currentOwner: OwnerInfo = {
  kind: null,
  ownerPublicKey: null,
  balanceSol: 0,
};
let devWalletSkipped = false;

const scopes = (): string[] =>
  el<HTMLTextAreaElement>("permissions")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

async function withErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function showTx(text: string, klass: "pending" | "ok" | "error"): void {
  const s = el("txStatus");
  s.textContent = text;
  s.className = `status ${klass}`;
  s.style.display = "block";
}

function showVerdict(result: AttemptResult): void {
  const v = el("verdict");
  const klass =
    result.status === "ok"
      ? "ok"
      : result.status === "not_permitted" || result.status === "no_passport"
        ? "deny"
        : "warn";
  const scopeNote = result.scopes
    ? ` — agent scopes: [${result.scopes.join(", ")}]`
    : "";
  v.textContent = `${result.status.toUpperCase()}${result.reason ? ` — ${result.reason}` : ""}${scopeNote}`;
  v.className = `verdict ${klass}`;
  v.style.display = "block";
}

/** Reject early — before any signature is requested — if scopes are malformed. */
function ensureValidScopes(list: string[]): void {
  const result = validatePermissions(list);
  if (!result.ok)
    throw new Error(`invalid permissions: ${result.errors.join("; ")}`);
}

function renderStage(): void {
  const walletConnected =
    devWalletSkipped ||
    (currentOwner.kind === "phantom" && Boolean(currentOwner.ownerPublicKey));
  const agentSynced = Boolean(currentAgent.agentPublicKey);
  el("walletGate").hidden = walletConnected;
  el("postWallet").hidden = !walletConnected;
  el("agentGate").hidden = !walletConnected || agentSynced;
  el("workspace").hidden = !walletConnected;
}

function applyAgentInfo(a: AgentInfo): void {
  currentAgent = a;
  const agentPublicKey = a.agentPublicKey ?? "none";
  el("agentPubkey").textContent = agentPublicKey;
  el("workspaceAgentPubkey").textContent = agentPublicKey;
  renderStage();
}

function applyOwnerInfo(o: OwnerInfo): void {
  currentOwner = o;
  el("ownerPubkey").textContent = o.ownerPublicKey ?? "none";
  el("ownerBalance").textContent = o.balanceSol.toFixed(4);
  const warn = el("ownerWarn");
  if (o.walletCluster && o.walletCluster !== cluster()) {
    warn.textContent = `⚠ Phantom is on "${o.walletCluster}" but "${cluster()}" is selected — signing will be blocked.`;
  } else {
    warn.textContent = "";
  }
  renderStage();
}

function syncOwnerControls(): void {
  el("ownerHint").textContent = "";
}

function syncAmbientPointer(event: PointerEvent): void {
  const x = Math.round((event.clientX / window.innerWidth) * 100);
  const y = Math.round((event.clientY / window.innerHeight) * 100);
  const driftX = (event.clientX / window.innerWidth - 0.5) * 10;
  const driftY = (event.clientY / window.innerHeight - 0.5) * 10;
  document.body.style.setProperty("--bg-x", `${x}%`);
  document.body.style.setProperty("--bg-y", `${y}%`);
  document.body.style.setProperty("--drift-x", `${driftX.toFixed(2)}px`);
  document.body.style.setProperty("--drift-y", `${driftY.toFixed(2)}px`);
}

function syncLiquidButtonPointer(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button");
  if (!button) return;
  const rect = button.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * 100);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * 100);
  button.style.setProperty("--button-x", `${x}%`);
  button.style.setProperty("--button-y", `${y}%`);
}

function releaseLiquidButton(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button");
  if (!button || button.classList.contains("dev-skip")) return;
  button.classList.remove("liquid-release");
  void button.offsetWidth;
  button.classList.add("liquid-release");
}

async function refresh(): Promise<void> {
  const a = await send<AgentInfo>({ type: "AGENT_GET" });
  applyAgentInfo(a);
  const o = await send<OwnerInfo>({
    type: "OWNER_GET",
    cluster: cluster(),
    mode: ownerMode(),
  });
  applyOwnerInfo(o);
}

el("cluster").addEventListener("change", () => void withErrors(refresh));
el("ownerMode").addEventListener("change", () => {
  syncOwnerControls();
  void withErrors(refresh);
});

el("ensureAgent").addEventListener("click", () =>
  withErrors(async () => {
    const { agentPublicKey } = await send<AgentInfo>({ type: "AGENT_ENSURE" });
    applyAgentInfo({ agentPublicKey });
    log(`agent ready: ${agentPublicKey}`);
  }),
);

el("resyncAgent").addEventListener("click", () =>
  withErrors(async () => {
    const { agentPublicKey } = await send<AgentInfo>({ type: "AGENT_ENSURE" });
    applyAgentInfo({ agentPublicKey });
    log(`agent ready: ${agentPublicKey}`);
  }),
);

async function ensureAgentAfterWalletConnect(): Promise<void> {
  const { agentPublicKey } = await send<AgentInfo>({ type: "AGENT_ENSURE" });
  applyAgentInfo({ agentPublicKey });
  log(`agent ready: ${agentPublicKey}`);
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

function setDemoPhantomPhase(phase: "securing" | "verifying" | "ready"): void {
  setPhantomAction(phase);
}

el("connectOwner").addEventListener("click", () =>
  withErrors(async () => {
    const button = el<HTMLButtonElement>("connectOwner");
    let keepAction = false;
    button.disabled = true;
    try {
      if (DEMO_PHANTOM_LOGIN.enabled) {
        setDemoPhantomPhase("securing");
        log("demo mode: restoring Phantom session");
        await wait(DEMO_PHANTOM_LOGIN.delayMs * 0.36);
        setDemoPhantomPhase("verifying");
        await wait(DEMO_PHANTOM_LOGIN.delayMs * 0.42);
        setDemoPhantomPhase("ready");
        await wait(DEMO_PHANTOM_LOGIN.delayMs * 0.22);
        devWalletSkipped = true;
        const o: OwnerInfo = {
          kind: "phantom",
          ownerPublicKey: DEMO_PHANTOM_LOGIN.publicKey,
          balanceSol: 2,
          providerKind: "injected",
          walletCluster: null,
        };
        applyOwnerInfo(o);
        if (hasExtensionRuntime()) {
          try {
            await ensureAgentAfterWalletConnect();
          } catch (e) {
            log(
              `error: agent sync failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        setPhantomAction("Connected", 1500);
        keepAction = true;
        log(`demo Phantom session restored: ${o.ownerPublicKey}`);
        return;
      }

      if (!hasExtensionRuntime()) {
        const provider = getPhantomProvider();
        if (!provider) {
          setPhantomAction("Unavailable", 2500);
          keepAction = true;
          log(
            "error: Phantom is not injected in this browser preview. Load the unpacked Nomad extension in Chrome with Phantom installed, or use Skip for dev.",
          );
          return;
        }
        setPhantomAction("Approve");
        log("preview mode: opening Phantom directly");
        const { publicKey } = await provider.connect();
        const o: OwnerInfo = {
          kind: "phantom",
          ownerPublicKey: publicKey.toString(),
          balanceSol: 0,
          walletCluster: null,
        };
        applyOwnerInfo(o);
        setPhantomAction("Connected", 1500);
        keepAction = true;
        log(`Phantom connected in preview: ${o.ownerPublicKey}`);
        return;
      }

      setPhantomAction("Opening");
      log("opening Phantom connector tab — approve the connection there…");
      const o = await send<OwnerInfo>({
        type: "PHANTOM_CONNECT",
        cluster: cluster(),
      });
      applyOwnerInfo(o);
      try {
        await ensureAgentAfterWalletConnect();
      } catch (e) {
        log(
          `error: agent sync failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      setPhantomAction("Connected", 1500);
      keepAction = true;
      log(`Phantom connected: ${o.ownerPublicKey}`);
    } finally {
      button.disabled = false;
      if (!keepAction) setPhantomAction("Connect");
    }
  }),
);

el("skipWallet").addEventListener("click", () => {
  devWalletSkipped = true;
  currentOwner = {
    kind: "phantom",
    ownerPublicKey: "skipped for dev",
    balanceSol: 0,
  };
  el("ownerPubkey").textContent = currentOwner.ownerPublicKey;
  el("ownerBalance").textContent = currentOwner.balanceSol.toFixed(4);
  renderStage();
  log("wallet connect skipped for dev");
});

el("airdrop").addEventListener("click", () =>
  withErrors(async () => {
    const r = await send<AirdropResult>({
      type: "OWNER_AIRDROP",
      cluster: cluster(),
      mode: ownerMode(),
    });
    el("ownerBalance").textContent = r.balanceSol.toFixed(4);
    log(`airdrop ok, balance ${r.balanceSol} SOL`);
  }),
);

el("createPassport").addEventListener("click", () =>
  withErrors(async () => {
    const list = scopes();
    ensureValidScopes(list);
    showTx("Submitting create… approve in Phantom if prompted.", "pending");
    const r = await send<TxResult>({
      type: "PASSPORT_CREATE",
      cluster: cluster(),
      mode: ownerMode(),
      label: el<HTMLInputElement>("label").value,
      scopes: list,
    });
    showTx(`Created ✓  sig: ${r.txSig}`, "ok");
    log(`passport created on ${r.cluster}: ${r.txSig}`);
  }).catch(() => showTx("Create failed — see log.", "error")),
);

el("updatePassport").addEventListener("click", () =>
  withErrors(async () => {
    const list = scopes();
    ensureValidScopes(list);
    const label = el<HTMLInputElement>("label").value;
    showTx("Submitting update… approve in Phantom if prompted.", "pending");
    const r = await send<TxResult>({
      type: "PASSPORT_UPDATE",
      cluster: cluster(),
      mode: ownerMode(),
      label: label || null,
      scopes: list,
    });
    showTx(`Updated ✓  sig: ${r.txSig}`, "ok");
    log(`passport updated on ${r.cluster}: ${r.txSig}`);
  }).catch(() => showTx("Update failed — see log.", "error")),
);

el("revokePassport").addEventListener("click", () =>
  withErrors(async () => {
    showTx("Submitting revoke… approve in Phantom if prompted.", "pending");
    const r = await send<TxResult>({
      type: "PASSPORT_REVOKE",
      cluster: cluster(),
      mode: ownerMode(),
    });
    showTx(`Revoked ✓  sig: ${r.txSig}`, "ok");
    log(`passport revoked on ${r.cluster}: ${r.txSig}`);
  }).catch(() => showTx("Revoke failed — see log.", "error")),
);

el("loadPassport").addEventListener("click", () =>
  withErrors(async () => {
    const { passport } = await send<PassportInfo>({
      type: "PASSPORT_READ",
      cluster: cluster(),
    });
    if (!passport) {
      el("onchainScopes").textContent = "none (no passport on this cluster)";
      log("no passport found on chain for this agent");
      return;
    }
    el("onchainScopes").textContent = passport.scopes.join(", ") || "(empty)";
    el<HTMLTextAreaElement>("permissions").value = passport.scopes.join("\n");
    log(
      `loaded ${passport.scopes.length} scope(s) from chain (label: ${passport.label})`,
    );
  }),
);

el("attemptAction").addEventListener("click", () =>
  withErrors(async () => {
    const action = el<HTMLInputElement>("action").value || "calendar.read";
    const result = await send<AttemptResult>({
      type: "ATTEMPT_ACTION",
      cluster: cluster(),
      action,
    });
    showVerdict(result);
    log(`attempt "${action}" -> ${result.status}`);
  }),
);

window.addEventListener("pointermove", syncAmbientPointer);
window.addEventListener("pointermove", syncLiquidButtonPointer);
window.addEventListener("pointerup", releaseLiquidButton);
syncOwnerControls();
renderStage();
if (hasExtensionRuntime()) {
  void withErrors(refresh);
}
