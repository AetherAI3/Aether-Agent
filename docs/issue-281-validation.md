# Issue 281: local shell attachment review

## Acceptance evidence

- `/shell-result` stages a memory-only exact-byte preview; only the explicit
  `/shell-result send` consumes it. Cancel, empty edits, invalid edits and a
  repeated send do not call either model transport.
- Immutable capture/session/command identity is retained independently of the
  editable body. A later result cannot substitute for the reviewed capture,
  including when a reviewed send waits behind a queued shell command.
- Replacing the body removes command/cwd/fixture-value lines. A protected
  untrusted-data envelope retains source-output and formatting omission counts
  and identifies an edited selection. Redaction is an aid, not a guarantee.
- UTF-8 head/tail truncation preserves whole code points. Terminal controls are
  removed before review. Project-context fence escaping is applied before
  review and is idempotent, preserving the reviewed attachment on the wire.
- TTY and pipe regression sessions have real history enabled. They cover
  success, failed commands, 401 and 500 send failures, no auth/composer replay,
  subsequent prompt isolation, and no durable custody-receipt retention.
- A mocked local-Ollama transport test covers cancel/edit/send/repeated-send and
  the next ordinary prompt. Fixtures make no paid inference calls.

## Verification

Linux, Node.js 24.19.0; dependencies installed with `npm ci --ignore-scripts`.

- `npm run build`, `npm run typecheck`, `npm run lint`: passed
- `npm test`: 3,357 passed, 11 platform/environment skips, zero failures in the
  implementation-wide run; final focused regressions below include subsequent
  strengthened queue-binding and local-transport cases
- `node --test --test-isolation=none dist/test/console_input.test.js dist/test/shell_attachment.test.js dist/test/console_shell.test.js`:
  final 26 passed, zero skips/failures
- `npm run docs:check`, `npm run verify:production`, `npm pack --dry-run`: passed
- `git diff --check`: passed
- `npm run smoke`: failed because this executor cannot resolve example.com;
  2 pass, 4 skip, 1 fail. This is not recorded as a pass
- `npm run release:truth`: 11/12 pass; `registry.source-truth` fails because the
  published source version requires a frozen-prerelease operator packet

Both aggregate failures were independently reproduced on untouched base
`f76b1c5e21346120681f0b607f40631d9168a65f`. No release evidence, network policy,
security setting or gate was changed to hide them. Exact-head CI and platform
qualification remain separate from this local evidence.
