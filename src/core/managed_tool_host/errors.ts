// Refusals of the managed ATS tool host contract v1
// (docs/specs/2026-09-22-managed-ats-tool-host-v1.md, docs/CONTRACTS.md section 5).
//
// Every refusal is a ToolHostContractError whose message is fixed text naming
// the object and field path. It never echoes the offending value: a refused
// document may carry a token, a path or page text, and messages reach logs.
// The Python mirror in test/fixtures/managed_tool_host_wire.py produces the
// same bytes for every golden vector.

export class ToolHostContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolHostContractError";
  }
}

export function fail(message: string): never {
  throw new ToolHostContractError(message);
}
