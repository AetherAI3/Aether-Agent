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

Planning text is never evidence that work has run. `/goal start` changes tracking status only. Completing a phase is a separate manual status action; execution of a saved phase is outside this planning flow.
