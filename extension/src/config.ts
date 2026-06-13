/**
 * Where the Phantom connector web page is served. It must be an http(s) origin
 * (Phantom does not inject into chrome-extension:// pages) and must match the
 * `externally_connectable.matches` entry in the manifest. For local development
 * this is the connector workspace's Vite dev server.
 */
export const CONNECTOR_URL = "http://localhost:5173/";

/**
 * Demo-only Phantom login. Keep the real connector/auth flow in place while
 * allowing presentations to enter the app without opening a wallet prompt.
 */
export const DEMO_PHANTOM_LOGIN = {
  enabled: true,
  delayMs: 1_500,
  publicKey: "6pYmaXSLJALosnttUAaZ4C6tTZ6horFfGD3229FrtrhL",
} as const;
