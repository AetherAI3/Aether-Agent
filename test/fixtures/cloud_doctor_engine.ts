// Scripted doctor engine frames from AETHER-CLOUD commit
// 66eb07505684af2482669aede9af5da5ccfac04e. The request also reflects
// the client filesystem capability extensions introduced for issue #250.
// Keep the frame fixture aligned with lib/agent_dev/synthetic.py and
// tests/api/test_agent_dev_session_routes.py.

export const CLOUD_DOCTOR_CONTRACT_COMMIT = "66eb07505684af2482669aede9af5da5ccfac04e";
export const CLOUD_DOCTOR_PROBE_CONTENT = "aether doctor live probe";

export function cloudDoctorCreateRequest(runId: string): Record<string, unknown> {
  return {
    task: `aether doctor health probe ${runId}`,
    surface: "aether_agent",
    model: null,
    effort: null,
    capabilities: [
      "read_file",
      "list_directory",
      "patch_file",
      "write_file",
      "run_shell",
      "run_tests",
      "repo_search",
      "git_commit",
      "web_search",
      "web_fetch",
    ],
    read_file_ranges: true,
    protocol_version: 1,
    purpose: "doctor",
    max_uvt: 0,
  };
}

export function cloudDoctorEngineFrames(sessionId: string): Array<Record<string, unknown>> {
  const path = `.aether-doctor/probe-${sessionId}.txt`;
  const writeCallId = `doctor:write_file:${sessionId.slice(0, 8)}`;
  const readCallId = `doctor:read_file:${sessionId.slice(0, 8)}`;
  return [
    {
      type: "session",
      seq: 1,
      session_id: sessionId,
      protocol_version: 1,
      model: "synthetic",
      tools: ["read_file", "write_file"],
    },
    {
      type: "reasoning",
      seq: 2,
      text: "doctor health check: sandboxed write/read round trip, no model, no spend",
    },
    {
      type: "tool_call",
      seq: 3,
      tool_call_id: writeCallId,
      name: "write_file",
      args: { path, content: CLOUD_DOCTOR_PROBE_CONTENT },
      risk: "low",
    },
    { type: "tool_result_ack", seq: 4, tool_call_id: writeCallId },
    {
      type: "tool_call",
      seq: 5,
      tool_call_id: readCallId,
      name: "read_file",
      args: { path },
      risk: "low",
    },
    { type: "tool_result_ack", seq: 6, tool_call_id: readCallId },
    { type: "usage", seq: 7, uvt: 0, cents: 0 },
    { type: "done", seq: 8, ok: true, uvt: 0, cents: 0 },
  ];
}
