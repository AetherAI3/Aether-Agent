import { test } from "node:test";
import assert from "node:assert/strict";
import * as tls from "node:tls";
import { trustWindowsSystemCAs } from "../src/core/system_ca.js";

type CaApi = Pick<typeof tls, "getCACertificates" | "setDefaultCACertificates">;

test("Windows CLI adds system roots without dropping bundled or extra defaults", () => {
  let installed: ReadonlyArray<string | NodeJS.ArrayBufferView> | undefined;
  const ca: CaApi = {
    getCACertificates: (type) => type === "system"
      ? ["shared-root", "windows-root"]
      : ["bundled-root", "shared-root", "extra-root"],
    setDefaultCACertificates: (certs) => { installed = certs; },
  };

  assert.equal(trustWindowsSystemCAs("win32", ca), true);
  assert.deepEqual(installed, ["bundled-root", "shared-root", "extra-root", "windows-root"]);
});

test("CA bootstrap leaves other platforms and unsupported Node versions alone", () => {
  let calls = 0;
  const ca: CaApi = {
    getCACertificates: () => { calls++; return ["root"]; },
    setDefaultCACertificates: () => { calls++; },
  };
  assert.equal(trustWindowsSystemCAs("linux", ca), false);
  assert.equal(calls, 0);

  const legacy = { getCACertificates: undefined, setDefaultCACertificates: undefined } as unknown as CaApi;
  assert.equal(trustWindowsSystemCAs("win32", legacy), false);
});

test("CA bootstrap keeps defaults when no additional system root is available", () => {
  let called = false;
  const ca: CaApi = {
    getCACertificates: (type) => type === "system" ? ["shared-root"] : ["shared-root"],
    setDefaultCACertificates: () => { called = true; },
  };
  assert.equal(trustWindowsSystemCAs("win32", ca), false);
  assert.equal(called, false);
});
