# Hosted authentication repair in the console

The interactive `aether` coding/chat console accepts `/auth status`, `/auth login`,
`/auth continue`, `/auth new`, and `/auth draft`. `/auth login` uses the same device login as
`aether auth login`; launch the console with `--no-browser` to print the URL and
code without opening a browser. Login and status use authentication and catalog
requests only. Neither starts a model turn.

After a hosted HTTP 401 survives automatic session refresh, the console saves
the failed instruction separately from the current input buffer. A newer draft
is held separately during repair and can be restored with `/auth draft`. `/auth status` reports whether the active credential is a session
token or API key and whether it came from `AETHER_TOKEN`, a saved login, or an
injected source. It never prints credential bytes. An environment override can
shadow a saved login in a new process; remove that override explicitly if it
is stale.

The authenticated `GET /models` response has an optional opaque `account_id`.
The console captures it before hosted work and compares it with a fresh catalog
response after login. A matching owner permits `/auth continue`. A different
owner, an unavailable API, or a server without `account_id` cannot prove account
continuity; `/auth new` explicitly discards the pending continuation and starts
a fresh console conversation. The original instruction remains in history.
Older servers omit the field, so they fail closed for continuation.

`/auth continue` is available only when the server rejected the original HTTP
request with 401 before a stream began and the console observed no tool or
custody receipt. It sends the saved instruction once, only after the operator
requests it. A 401 carried inside a stream may have followed accepted work;
the console preserves any known receipts and asks the operator to inspect the
workspace before issuing a new instruction. Login never replays a tool or task.

HTTP 402, 403, and 429 and network failures remain separate from authentication
repair. A 401 whose server detail describes insufficient balance is treated as
a balance problem. Cancelling or timing out device login leaves the pending
instruction and workspace intact. The standalone `aether auth login` command,
including username/password and token input modes, remains available for
headless automation.
