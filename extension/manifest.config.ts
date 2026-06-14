import { defineManifest } from "@crxjs/vite-plugin";

function hostPermissionFor(url: string | undefined): string[] {
  if (!url) return [];
  try {
    return [`${new URL(url).origin}/*`];
  } catch {
    return [];
  }
}

const inferenceProxyHosts = hostPermissionFor(
  process.env.VITE_NOMAD_INFERENCE_PROXY_URL,
);
const intentProxyHosts = hostPermissionFor(
  process.env.VITE_NOMAD_INTENT_PROXY_URL,
);
const sponsorHosts = hostPermissionFor(process.env.VITE_NOMAD_SPONSOR_URL);

export default defineManifest({
  manifest_version: 3,
  name: "nomad",
  version: "0.1.0",
  description:
    "Create an agent identity and manage its on-chain Nomad permission passport.",
  action: {
    default_title: "nomad",
  },
  side_panel: {
    default_path: "src/popup.html",
  },
  background: {
    service_worker: "src/background.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: [
        "https://chatgpt.com/*",
        "https://*.chatgpt.com/*",
        "https://chat.openai.com/*",
      ],
      js: ["src/content.ts"],
      run_at: "document_start",
    },
    {
      matches: [
        "https://chatgpt.com/*",
        "https://*.chatgpt.com/*",
        "https://chat.openai.com/*",
      ],
      js: ["src/content-inject.ts"],
      world: "MAIN",
      run_at: "document_start",
    },
  ],
  permissions: ["storage", "activeTab", "scripting", "sidePanel"],
  host_permissions: [
    // ChatGPT: standing access lets the popup/background read the active
    // conversation reliably without depending on the activeTab grant lifetime.
    "https://chatgpt.com/*",
    "https://*.chatgpt.com/*",
    "https://chat.openai.com/*",
    "http://localhost:5173/*",
    "http://localhost:8788/*",
    "http://127.0.0.1:8788/*",
    "http://localhost:8790/*",
    "http://127.0.0.1:8790/*",
    "http://localhost:8791/*",
    "http://127.0.0.1:8791/*",
    ...inferenceProxyHosts,
    ...intentProxyHosts,
    ...sponsorHosts,
    "http://127.0.0.1:8899/*",
    "https://api.devnet.solana.com/*",
    "https://api.mainnet-beta.solana.com/*",
  ],
  // The Phantom connector is a normal web page (Phantom does not inject into a
  // chrome-extension:// context). It talks back to this extension over
  // `externally_connectable`; only the connector's dev origin is allowed.
  externally_connectable: {
    matches: ["http://localhost:5173/*"],
  },
});
