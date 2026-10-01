// The invitation exists only in memory and on the operator's terminal. The
// fragment does not travel in the initial HTTP request or Referer header.
import { randomBytes } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import qrcode from "aether-rc-qr";
import type { ObserverGrant } from "./host.js";

export const RC_VIEW_ORIGIN = "https://app.aethersystems.net";

export function newObserverId(): string {
  return `viewer_${randomBytes(16).toString("hex")}`;
}

export function observerLink(grant: ObserverGrant): string {
  const url = new URL("/rc", RC_VIEW_ORIGIN);
  url.hash = new URLSearchParams({ grant: grant.token, device_id: grant.device_id }).toString();
  return url.toString();
}

export function observerQr(link: string, columns: number | undefined): string | null {
  if (!columns || columns < 40) return null;
  let rendered = "";
  qrcode.generate(link, { small: true }, (value: string) => { rendered = value; });
  const maxWidth = Math.max(...rendered.split("\n").map((line) => stripVTControlCharacters(line).length));
  return maxWidth <= columns ? rendered : null;
}
