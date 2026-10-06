# Saved goal plans

`/goal <objective>` drafts a plan from the exact objective and a bounded, read-only look at the current workspace. It identifies a known stack, likely relevant filenames, existing checks, and repository instruction files when possible. It never runs a check, changes source files, installs dependencies, or calls a model. A missing stack or check is shown as an assumption; verification remains **unresolved** until a suitable check is chosen.

The draft stays in the current console session and is not persisted until accepted with `/goal save`. Review it before saving:

| Command | Effect on the unsaved draft |
| --- | --- |
| `/goal draft` | Show the current draft |
| `/goal phase add <title>` | Add a phase; give it completion criteria before saving |
| `/goal phase remove <number>` | Remove a phase, keeping at least one |
| `/goal phase move <from> <to>` | Reorder phases |
| `/goal phase title <number> <text>` | Change a phase title |
| `/goal phase describe <number> <text>` | Change a phase description |
| `/goal criteria <number> <criterion; criterion>` | Replace completion criteria |
| `/goal note <number> <text>` | Change a phase note |
| `/goal save` | Confirm and save the reviewed plan |
| `/goal discard` | Discard the unsaved draft |

`/goal edit [id]` reopens a saved plan as a separate draft. The saved copy remains intact until `/goal save` is confirmed. `/goal view [id]` and `/goals <id>` display the accepted plan, including constraints and verification status. Existing goals without plan metadata remain readable; reopening one marks the missing information for review.

Planning text is never evidence that work has run. `/goal run [id]` explicitly executes **one** accepted phase in the selected workspace through the existing host coding loop. It uses the accepted objective, constraints, phase notes and criteria, selected model, normal tool permissions, and accepted check command. It records an attempt ID, session/turn ID, workspace, model, tree change, and host check receipt. A later phase needs another `/goal run`.

`/goal run pause [id]` and `/goal run cancel [id]` request cooperative cancellation of a live run, including its tools or final check. `/goal run resume [id]` reconciles the prior session before continuing from its checkpoint; it never automatically replays a finished phase. A missing, failed, stale, or unattributable check leaves the phase unresolved. Free-form criteria the host check cannot prove remain visible as verification pending, even when the check is green. Publication requires a separate ship action.

`/goal start` changes **manual tracking** status only. `/goal complete` marks a phase **manually complete** and does not certify tests. Changing an accepted phase's scope invalidates its earlier run receipt.
