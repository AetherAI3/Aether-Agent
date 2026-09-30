// Node's bundled roots may not include a certificate authority trusted by
// Windows (for example, a managed network's TLS inspection root). Include
// Windows' trusted roots in the CLI's default set before the first request.
// Keep the existing defaults so bundled roots and NODE_EXTRA_CA_CERTS survive.

import * as tls from "node:tls";

type CaApi = Pick<typeof tls, "getCACertificates" | "setDefaultCACertificates">;

export function trustWindowsSystemCAs(
  platform: NodeJS.Platform = process.platform,
  ca: CaApi = tls,
): boolean {
  if (platform !== "win32") return false;
  // The package supports Node 24.0+, while these APIs arrived in 24.5.
  if (typeof ca.getCACertificates !== "function" || typeof ca.setDefaultCACertificates !== "function") {
    return false;
  }
  try {
    const defaults = ca.getCACertificates("default");
    const system = ca.getCACertificates("system");
    if (system.length === 0) return false;
    const combined = [...new Set([...defaults, ...system])];
    if (combined.length === defaults.length) return false;
    ca.setDefaultCACertificates(combined);
    return true;
  } catch {
    // A CA discovery or parsing failure leaves Node's original trust intact.
    return false;
  }
}
