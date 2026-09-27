// Versioned, JSON-safe public command authority. Runtime handler functions live
// in their registries and are bound to these identities by parity validation.
import type { CommandManifestEntry } from "./command_manifest.js";

export const COMMAND_MANIFEST_SCHEMA = "aether.command-manifest/1" as const;
export const COMMAND_MANIFEST_SOURCE: readonly CommandManifestEntry[] = [
  {
    "key": "shell:help",
    "surface": "shell",
    "name": "help",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[command]",
    "summary": "show grouped help or command detail",
    "detailedHelp": "aether help [command]\nshow grouped help or command detail",
    "section": "Start",
    "hidden": false,
    "permissionClass": "read-only",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.help",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:help",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "help",
      "usage": "aether help [command]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:agent",
    "surface": "shell",
    "name": "agent",
    "aliases": [
      "code"
    ],
    "compatibilityAliases": [
      "code"
    ],
    "deprecatedAliases": [],
    "args": "[task]",
    "summary": "run the coding agent or open its REPL",
    "detailedHelp": "aether agent [task]\nrun the coding agent or open its REPL",
    "section": "Start",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted-or-local"
      ]
    },
    "telemetryName": "shell.agent",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:agent",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "agent",
      "usage": "aether agent [task]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:chat",
    "surface": "shell",
    "name": "chat",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[prompt]",
    "summary": "start chat or send one prompt",
    "detailedHelp": "aether chat [prompt]\nstart chat or send one prompt",
    "section": "Start",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.chat",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:chat",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "chat",
      "usage": "aether chat [prompt]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:resume",
    "surface": "shell",
    "name": "resume",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[session-id|export [id] --out <file>]",
    "summary": "replay a local session, or export it as a portable handoff",
    "detailedHelp": "aether resume [session-id|export [id] --out <file>]\nreplay a local session, or export it as a portable handoff",
    "section": "Start",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.resume",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:resume",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "resume",
      "usage": "aether resume [session-id|export [id] --out <file>]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:run",
    "surface": "shell",
    "name": "run",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<neo|kronus> <task>",
    "summary": "stream an orchestrator run",
    "detailedHelp": "aether run <neo|kronus> <task>\nstream an orchestrator run",
    "section": "Start",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.run",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:run",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "run",
      "usage": "aether run <neo|kronus> <task>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:models",
    "surface": "shell",
    "name": "models",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[use <id>]",
    "summary": "list models or set the default",
    "detailedHelp": "aether models [use <id>]\nlist models or set the default",
    "section": "Start",
    "hidden": false,
    "permissionClass": "read-only",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.models",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:models",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "models",
      "usage": "aether models [use <id>]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:agents",
    "surface": "shell",
    "name": "agents",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "list available orchestrators",
    "detailedHelp": "aether agents\nlist available orchestrators",
    "section": "Start",
    "hidden": false,
    "permissionClass": "read-only",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.agents",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:agents",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "agents",
      "usage": "aether agents",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:auth",
    "surface": "shell",
    "name": "auth",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<login|status|token|refresh|logout>",
    "summary": "manage authentication",
    "detailedHelp": "aether auth <login|status|token|refresh|logout>\nmanage authentication",
    "section": "Account",
    "hidden": false,
    "permissionClass": "account",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.auth",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:auth",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "auth",
      "usage": "aether auth <login|status|token|refresh|logout>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:device",
    "surface": "shell",
    "name": "device",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<subcommand>",
    "summary": "manage the dev-only, default-off Windows device runtime",
    "detailedHelp": "aether device <subcommand>\nmanage the dev-only, default-off Windows device runtime",
    "section": "Account",
    "hidden": true,
    "permissionClass": "account",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.device",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {
      "base-url": {
        "type": "string"
      }
    },
    "handler": {
      "id": "handler:shell:device",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "device",
      "usage": "aether device <subcommand>",
      "visible": false,
      "disposition": "generated"
    },
    "release": {
      "disposition": "new",
      "note": "SC-DEVICE-01: dev-only, default-off Windows device runtime (outbound-only telemetry, signed command execution, Job Object containment)."
    }
  },
  {
    "key": "shell:login",
    "surface": "shell",
    "name": "login",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "sign in (legacy shortcut)",
    "detailedHelp": "aether login\nsign in (legacy shortcut)",
    "section": "Account",
    "hidden": true,
    "permissionClass": "account",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.login",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:login",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "login",
      "usage": "aether login",
      "visible": false,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:logout",
    "surface": "shell",
    "name": "logout",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "sign out (legacy shortcut)",
    "detailedHelp": "aether logout\nsign out (legacy shortcut)",
    "section": "Account",
    "hidden": true,
    "permissionClass": "account",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.logout",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:logout",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "logout",
      "usage": "aether logout",
      "visible": false,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:github",
    "surface": "shell",
    "name": "github",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<connect|status|disconnect>",
    "summary": "manage the GitHub connection",
    "detailedHelp": "aether github <connect|status|disconnect>\nmanage the GitHub connection",
    "section": "Account",
    "hidden": false,
    "permissionClass": "account",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.github",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:github",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "github",
      "usage": "aether github <connect|status|disconnect>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:vault",
    "surface": "shell",
    "name": "vault",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<command>",
    "summary": "search and manage semantic memory",
    "detailedHelp": "aether vault <command>\nsearch and manage semantic memory",
    "section": "Knowledge",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.vault",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:vault",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault",
      "usage": "aether vault <command>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:workflow",
    "surface": "shell",
    "name": "workflow",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<command>",
    "summary": "create and manage workflows",
    "detailedHelp": "aether workflow <command>\ncreate and manage workflows",
    "section": "Knowledge",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.workflow",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:workflow",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "workflow",
      "usage": "aether workflow <command>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:memory",
    "surface": "shell",
    "name": "memory",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[status|inspect|forget|prune]",
    "summary": "inspect and manage scoped memory",
    "detailedHelp": "aether memory [status|inspect|forget|prune]\ninspect and manage scoped memory",
    "section": "Knowledge",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.memory",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:memory",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "memory",
      "usage": "aether memory [status|inspect|forget|prune]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:skills",
    "surface": "shell",
    "name": "skills",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<subcommand>",
    "summary": "inspect, trust, and manage agent skills",
    "detailedHelp": "aether skills <subcommand>\ninspect, trust, and manage agent skills",
    "section": "Knowledge",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.skills",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:skills",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "skills",
      "usage": "aether skills <subcommand>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:capabilities",
    "surface": "shell",
    "name": "capabilities",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[--available]",
    "summary": "show the capability contract and runtime availability",
    "detailedHelp": "aether capabilities [--available]\nshow the capability contract and runtime availability",
    "section": "Knowledge",
    "hidden": false,
    "permissionClass": "read-only",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.capabilities",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:capabilities",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "capabilities",
      "usage": "aether capabilities [--available]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:image",
    "surface": "shell",
    "name": "image",
    "aliases": [
      "img"
    ],
    "compatibilityAliases": [
      "img"
    ],
    "deprecatedAliases": [],
    "args": "<prompt>",
    "summary": "generate an image",
    "detailedHelp": "aether image <prompt>\ngenerate an image",
    "section": "Media",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.image",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:image",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "image",
      "usage": "aether image <prompt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:video",
    "surface": "shell",
    "name": "video",
    "aliases": [
      "vid"
    ],
    "compatibilityAliases": [
      "vid"
    ],
    "deprecatedAliases": [],
    "args": "<prompt>",
    "summary": "generate a video",
    "detailedHelp": "aether video <prompt>\ngenerate a video",
    "section": "Media",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.video",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:video",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "video",
      "usage": "aether video <prompt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:output",
    "surface": "shell",
    "name": "output",
    "aliases": [
      "out"
    ],
    "compatibilityAliases": [
      "out"
    ],
    "deprecatedAliases": [],
    "args": "[open <n>]",
    "summary": "manage generated media",
    "detailedHelp": "aether output [open <n>]\nmanage generated media",
    "section": "Media",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.output",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:output",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "output",
      "usage": "aether output [open <n>]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:audit",
    "surface": "shell",
    "name": "audit",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[limit]",
    "summary": "show chain-of-custody events",
    "detailedHelp": "aether audit [limit]\nshow chain-of-custody events",
    "section": "System",
    "hidden": false,
    "permissionClass": "read-only",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.audit",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:audit",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "audit",
      "usage": "aether audit [limit]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:receipt",
    "surface": "shell",
    "name": "receipt",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<order-id>",
    "summary": "export an audit proof package",
    "detailedHelp": "aether receipt <order-id>\nexport an audit proof package",
    "section": "System",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted"
      ]
    },
    "telemetryName": "shell.receipt",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:receipt",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "receipt",
      "usage": "aether receipt <order-id>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:support-bundle",
    "surface": "shell",
    "name": "support-bundle",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "export a redacted diagnostic support bundle",
    "detailedHelp": "aether support-bundle\nexport a redacted diagnostic support bundle",
    "section": "System",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.support-bundle",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:support-bundle",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "support-bundle",
      "usage": "aether support-bundle",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:mcp",
    "surface": "shell",
    "name": "mcp",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[list|doctor|repair]",
    "summary": "manage and diagnose MCP servers",
    "detailedHelp": "aether mcp [list|doctor|repair]\nmanage and diagnose MCP servers",
    "section": "System",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.mcp",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:mcp",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "mcp",
      "usage": "aether mcp [list|doctor|repair]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:config",
    "surface": "shell",
    "name": "config",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[show|get|set]",
    "summary": "inspect or change configuration",
    "detailedHelp": "aether config [show|get|set]\ninspect or change configuration",
    "section": "System",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.config",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:config",
      "kind": "host",
      "module": "src/main.ts",
      "symbol": "main"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "config",
      "usage": "aether config [show|get|set]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:exec",
    "surface": "shell",
    "name": "exec",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[--exec-driver ollama|cloud|selftest] [flags] \"task\"",
    "summary": "run the packaged coding agent over versioned JSONL",
    "detailedHelp": "aether exec [--exec-driver ollama|cloud|selftest] [flags] \"task\"\nrun the packaged coding agent over versioned JSONL",
    "section": "Start",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.hosted",
        "aether.local-child",
        "aether.headless.v1",
        "aether.headless.v2"
      ]
    },
    "telemetryName": "shell.exec",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {
      "permission": {
        "type": "string"
      },
      "allow-tool": {
        "type": "string",
        "multiple": true
      },
      "capability-pack": {
        "type": "string",
        "multiple": true
      },
      "timeout-ms": {
        "type": "string"
      },
      "max-uvt": {
        "type": "string"
      },
      "exec-driver": {
        "type": "string"
      },
      "exec-protocol": {
        "type": "string"
      },
      "agent-definition": {
        "type": "string"
      },
      "authority-ttl-ms": {
        "type": "string"
      }
    },
    "handler": {
      "id": "handler:shell:exec",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "exec",
      "usage": "aether exec [--exec-driver ollama|cloud|selftest] [flags] \"task\"",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "new",
      "note": "Packaged Ollama, model-and-UVT-bound local-authority hosted text-model cloud-dev-session, and model-free selftest drivers with compatible aether.exec/1 and repository-bound aether.exec/2 JSONL sessions."
    }
  },
  {
    "key": "shell:setup",
    "surface": "shell",
    "name": "setup",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "--local",
    "summary": "diagnose bounded local Ollama setup without changing configuration",
    "detailedHelp": "aether setup --local\ndiagnose bounded local Ollama setup without changing configuration",
    "section": "Start",
    "hidden": false,
    "permissionClass": "read-only",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "ollama.local"
      ]
    },
    "telemetryName": "shell.setup",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:setup",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "setup",
      "usage": "aether setup --local",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "new",
      "note": "v0.3.0 adds bounded local setup diagnosis."
    }
  },
  {
    "key": "shell:local",
    "surface": "shell",
    "name": "local",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "doctor|models|use <model>|pull <model>",
    "summary": "diagnose and explicitly manage the local Ollama runtime",
    "detailedHelp": "aether local doctor|models|use <model>|pull <model>\ndiagnose and explicitly manage the local Ollama runtime",
    "section": "Start",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "ollama.local"
      ]
    },
    "telemetryName": "shell.local",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {},
    "handler": {
      "id": "handler:shell:local",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "local",
      "usage": "aether local doctor|models|use <model>|pull <model>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "new",
      "note": "v0.3.0 adds explicit Ollama diagnosis and management."
    }
  },
  {
    "key": "shell:preview",
    "surface": "shell",
    "name": "preview",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "start|open|logs|status|stop",
    "summary": "manage an explicitly declared loopback development preview",
    "detailedHelp": "aether preview start|open|logs|status|stop\nmanage an explicitly declared loopback development preview",
    "section": "Start",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.local-preview"
      ]
    },
    "telemetryName": "shell.preview",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {
      "command": {
        "type": "string"
      },
      "arg": {
        "type": "string",
        "multiple": true
      },
      "ready-url": {
        "type": "string"
      },
      "preview-cwd": {
        "type": "string"
      },
      "preview-timeout-ms": {
        "type": "string"
      },
      "no-open": {
        "type": "boolean",
        "default": false
      }
    },
    "handler": {
      "id": "handler:shell:preview",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "preview",
      "usage": "aether preview start|open|logs|status|stop",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "new",
      "note": "v0.3.0 adds a consent-gated, managed loopback preview lifecycle."
    }
  },
  {
    "key": "shell:doctor",
    "surface": "shell",
    "name": "doctor",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[--live|--fix] [--deep] [--only <id>]",
    "summary": "run structured runtime diagnostics",
    "detailedHelp": "aether doctor [--live|--fix] [--deep] [--only <id>]\nrun structured runtime diagnostics",
    "section": "System",
    "hidden": false,
    "permissionClass": "network",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.doctor",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {
      "deep": {
        "type": "boolean",
        "default": false
      },
      "live": {
        "type": "boolean",
        "default": false
      },
      "fix": {
        "type": "boolean",
        "default": false
      },
      "dry-run": {
        "type": "boolean",
        "default": false
      },
      "no-ui": {
        "type": "boolean",
        "default": false
      },
      "only": {
        "type": "string",
        "multiple": true
      }
    },
    "handler": {
      "id": "handler:shell:doctor",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "doctor",
      "usage": "aether doctor [--live|--fix] [--deep] [--only <id>]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:sessions",
    "surface": "shell",
    "name": "sessions",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[inspect|continue|export|archive|clean] [id]",
    "summary": "browse, inspect and continue past project sessions",
    "detailedHelp": "aether sessions [inspect|continue|export|archive|clean] [id]\nbrowse, inspect and continue past project sessions",
    "section": "Start",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.sessions",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {
      "undo": {
        "type": "boolean",
        "default": false
      },
      "no-select": {
        "type": "boolean",
        "default": false
      }
    },
    "handler": {
      "id": "handler:shell:sessions",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "sessions",
      "usage": "aether sessions [inspect|continue|export|archive|clean] [id]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:review",
    "surface": "shell",
    "name": "review",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[stage|unstage|revert|commit|diff|verify]",
    "summary": "review changes, pick files or hunks, commit",
    "detailedHelp": "aether review [stage|unstage|revert|commit|diff|verify]\nreview changes, pick files or hunks, commit",
    "section": "Start",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.review",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {
      "files": {
        "type": "string"
      },
      "hunks": {
        "type": "string"
      },
      "message": {
        "type": "string",
        "short": "m"
      },
      "approve": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "base": {
        "type": "string"
      }
    },
    "handler": {
      "id": "handler:shell:review",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "review",
      "usage": "aether review [stage|unstage|revert|commit|diff|verify]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "shell:ship",
    "surface": "shell",
    "name": "ship",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[--title t] [--base b]",
    "summary": "publish the head branch and open a pull request",
    "detailedHelp": "aether ship [--title t] [--base b]\npublish the head branch and open a pull request",
    "section": "Start",
    "hidden": false,
    "permissionClass": "destructive",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "shell.ship",
    "acceptedGlobalFlags": [
      "agent",
      "all",
      "apply",
      "audit",
      "available",
      "ci",
      "cwd",
      "effort",
      "help",
      "interactive",
      "json",
      "junit",
      "license-key",
      "local",
      "model",
      "no-browser",
      "no-log",
      "no-skills",
      "out",
      "password",
      "pool",
      "quiet",
      "repo",
      "resume",
      "scope",
      "skill",
      "swarm",
      "test-cmd",
      "token",
      "username",
      "version",
      "with-token",
      "worktree",
      "yes"
    ],
    "ownedFlags": {
      "files": {
        "type": "string"
      },
      "hunks": {
        "type": "string"
      },
      "message": {
        "type": "string",
        "short": "m"
      },
      "approve": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "base": {
        "type": "string"
      }
    },
    "handler": {
      "id": "handler:shell:ship",
      "kind": "lazy",
      "module": "src/commands/cli_registry.ts",
      "symbol": "DISPATCH_COMMANDS"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "ship",
      "usage": "aether ship [--title t] [--base b]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:help",
    "surface": "slash",
    "name": "help",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[command]",
    "summary": "this help, or detail for one command",
    "detailedHelp": "/help [command]\nthis help, or detail for one command",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.help",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:help",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "help",
      "usage": "/help [command]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:models",
    "surface": "slash",
    "name": "models",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "interactive model picker",
    "detailedHelp": "/models\ninteractive model picker",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.catalogue"
      ]
    },
    "telemetryName": "slash.models",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:models",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "models",
      "usage": "/models",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:model",
    "surface": "slash",
    "name": "model",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<n|id>",
    "summary": "switch model (no arg → picker)",
    "detailedHelp": "/model <n|id>\nswitch model (no arg → picker)",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.catalogue"
      ]
    },
    "telemetryName": "slash.model",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:model",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "model",
      "usage": "/model <n|id>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:agent",
    "surface": "slash",
    "name": "agent",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<n|id>",
    "summary": "switch orchestrator (or picker)",
    "detailedHelp": "/agent <n|id>\nswitch orchestrator (or picker)",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.catalogue"
      ]
    },
    "telemetryName": "slash.agent",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:agent",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "agent",
      "usage": "/agent <n|id>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:agents",
    "surface": "slash",
    "name": "agents",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "active agent sessions + UVT",
    "detailedHelp": "/agents\nactive agent sessions + UVT",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.catalogue"
      ]
    },
    "telemetryName": "slash.agents",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:agents",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "agents",
      "usage": "/agents",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:tier",
    "surface": "slash",
    "name": "tier",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "plan tier + default model",
    "detailedHelp": "/tier\nplan tier + default model",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.catalogue"
      ]
    },
    "telemetryName": "slash.tier",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:tier",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "tier",
      "usage": "/tier",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:effort",
    "surface": "slash",
    "name": "effort",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[tier|1-6]",
    "summary": "effort dial (LOW to CODEPRO), drives aether code",
    "detailedHelp": "/effort [tier|1-6]\neffort dial (LOW to CODEPRO), drives aether code",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.effort",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:effort",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "effort",
      "usage": "/effort [tier|1-6]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:audit",
    "surface": "slash",
    "name": "audit",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[n]",
    "summary": "recent audit trail",
    "detailedHelp": "/audit [n]\nrecent audit trail",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.audit",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:audit",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "audit",
      "usage": "/audit [n]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:doctor",
    "surface": "slash",
    "name": "doctor",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[deep]",
    "summary": "structured runtime diagnostics",
    "detailedHelp": "/doctor [deep]\nstructured runtime diagnostics",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.doctor",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:doctor",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "doctor",
      "usage": "/doctor [deep]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:preview",
    "surface": "slash",
    "name": "preview",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "start|open|logs|status|stop",
    "summary": "manage the declared loopback development preview",
    "detailedHelp": "/preview start|open|logs|status|stop\nmanage the declared loopback development preview",
    "section": "Session",
    "hidden": false,
    "permissionClass": "local-write",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": [
        "aether.local-preview"
      ]
    },
    "telemetryName": "slash.preview",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:preview",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "preview",
      "usage": "/preview start|open|logs|status|stop",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "new",
      "note": "v0.3.0 adds the same managed preview lifecycle inside the REPL."
    }
  },
  {
    "key": "slash:clear",
    "surface": "slash",
    "name": "clear",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "clear screen",
    "detailedHelp": "/clear\nclear screen",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.clear",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:clear",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "clear",
      "usage": "/clear",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:exit",
    "surface": "slash",
    "name": "exit",
    "aliases": [
      "quit"
    ],
    "compatibilityAliases": [
      "quit"
    ],
    "deprecatedAliases": [],
    "summary": "leave the REPL",
    "detailedHelp": "/exit\nleave the REPL",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.exit",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:exit",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "exit",
      "usage": "/exit",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:mcp",
    "surface": "slash",
    "name": "mcp",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[list|doctor|repair]",
    "summary": "manage and diagnose MCP servers",
    "detailedHelp": "/mcp [list|doctor|repair]\nmanage and diagnose MCP servers",
    "section": "Session",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.mcp",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:mcp",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "mcp",
      "usage": "/mcp [list|doctor|repair]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:autonomous-execution",
    "surface": "slash",
    "name": "autonomous-execution",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<task>",
    "summary": "execute without asking",
    "detailedHelp": "/autonomous-execution <task>\nexecute without asking",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.autonomous-execution",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:autonomous-execution",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "autonomous-execution",
      "usage": "/autonomous-execution <task>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:subagent-driven-execution",
    "surface": "slash",
    "name": "subagent-driven-execution",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<task>",
    "summary": "decompose + delegate",
    "detailedHelp": "/subagent-driven-execution <task>\ndecompose + delegate",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.subagent-driven-execution",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:subagent-driven-execution",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "subagent-driven-execution",
      "usage": "/subagent-driven-execution <task>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:self-review",
    "surface": "slash",
    "name": "self-review",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "review your own recent work",
    "detailedHelp": "/self-review\nreview your own recent work",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.self-review",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:self-review",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "self-review",
      "usage": "/self-review",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:recon",
    "surface": "slash",
    "name": "recon",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<topic>",
    "summary": "deep reconnaissance",
    "detailedHelp": "/recon <topic>\ndeep reconnaissance",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.recon",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:recon",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "recon",
      "usage": "/recon <topic>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:plan",
    "surface": "slash",
    "name": "plan",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<topic>",
    "summary": "write implementation plan",
    "detailedHelp": "/plan <topic>\nwrite implementation plan",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.plan",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:plan",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "plan",
      "usage": "/plan <topic>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:research",
    "surface": "slash",
    "name": "research",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<topic>",
    "summary": "research-gather-summarize",
    "detailedHelp": "/research <topic>\nresearch-gather-summarize",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.research",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:research",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "research",
      "usage": "/research <topic>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:project-review",
    "surface": "slash",
    "name": "project-review",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "ask the brain for a prose project review (was /review)",
    "detailedHelp": "/project-review\nask the brain for a prose project review (was /review)",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.project-review",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:project-review",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "project-review",
      "usage": "/project-review",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:code-review",
    "surface": "slash",
    "name": "code-review",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "sweep: clean up + simplify",
    "detailedHelp": "/code-review\nsweep: clean up + simplify",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.code-review",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:code-review",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "code-review",
      "usage": "/code-review",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:writing-skills",
    "surface": "slash",
    "name": "writing-skills",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "author reusable skills",
    "detailedHelp": "/writing-skills\nauthor reusable skills",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.writing-skills",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:writing-skills",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "writing-skills",
      "usage": "/writing-skills",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:writing-plans",
    "surface": "slash",
    "name": "writing-plans",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<topic>",
    "summary": "write plan to .hermes/plans/",
    "detailedHelp": "/writing-plans <topic>\nwrite plan to .hermes/plans/",
    "section": "Agent Modes",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.writing-plans",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:writing-plans",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "writing-plans",
      "usage": "/writing-plans <topic>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:queue",
    "surface": "slash",
    "name": "queue",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<task>",
    "summary": "queue a task (runs when current finishes)",
    "detailedHelp": "/queue <task>\nqueue a task (runs when current finishes)",
    "section": "Steering",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.queue",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:queue",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "queue",
      "usage": "/queue <task>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:steer",
    "surface": "slash",
    "name": "steer",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<guidance>",
    "summary": "mid-task steering for the next turn",
    "detailedHelp": "/steer <guidance>\nmid-task steering for the next turn",
    "section": "Steering",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.steer",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:steer",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "steer",
      "usage": "/steer <guidance>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:btw",
    "surface": "slash",
    "name": "btw",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<note>",
    "summary": "contextual side note (accumulates)",
    "detailedHelp": "/btw <note>\ncontextual side note (accumulates)",
    "section": "Steering",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.btw",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:btw",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "btw",
      "usage": "/btw <note>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:pin",
    "surface": "slash",
    "name": "pin",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<path> [reason]",
    "summary": "force file into persistent context (pin list)",
    "detailedHelp": "/pin <path> [reason]\nforce file into persistent context (pin list)",
    "section": "Context & Limits",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.pin",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:pin",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "pin",
      "usage": "/pin <path> [reason]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:drop",
    "surface": "slash",
    "name": "drop",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<path>",
    "summary": "evict file from context",
    "detailedHelp": "/drop <path>\nevict file from context",
    "section": "Context & Limits",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.drop",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:drop",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "drop",
      "usage": "/drop <path>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:snapshot",
    "surface": "slash",
    "name": "snapshot",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[resume <id>]",
    "summary": "save session state / reload a snapshot",
    "detailedHelp": "/snapshot [resume <id>]\nsave session state / reload a snapshot",
    "section": "Context & Limits",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.snapshot",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:snapshot",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "snapshot",
      "usage": "/snapshot [resume <id>]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:limit",
    "surface": "slash",
    "name": "limit",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<uvt>",
    "summary": "cap UVT spend for this session",
    "detailedHelp": "/limit <uvt>\ncap UVT spend for this session",
    "section": "Context & Limits",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.limit",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:limit",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "limit",
      "usage": "/limit <uvt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:token-budget",
    "surface": "slash",
    "name": "token-budget",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<uvt>",
    "summary": "alias for /limit",
    "detailedHelp": "/token-budget <uvt>\nalias for /limit",
    "section": "Context & Limits",
    "hidden": true,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.token-budget",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:token-budget",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "token-budget",
      "usage": "/token-budget <uvt>",
      "visible": false,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:audit-receipt",
    "surface": "slash",
    "name": "audit-receipt",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[n]",
    "summary": "verified log of tool calls + UVT",
    "detailedHelp": "/audit-receipt [n]\nverified log of tool calls + UVT",
    "section": "Context & Limits",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.audit-receipt",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:audit-receipt",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "audit-receipt",
      "usage": "/audit-receipt [n]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:rollback",
    "surface": "slash",
    "name": "rollback",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "discard uncommitted changes to tracked files",
    "detailedHelp": "/rollback\ndiscard uncommitted changes to tracked files",
    "section": "Context & Limits",
    "hidden": false,
    "permissionClass": "destructive",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.rollback",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:rollback",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "rollback",
      "usage": "/rollback",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:logs-view",
    "surface": "slash",
    "name": "logs-view",
    "aliases": [
      "logs"
    ],
    "compatibilityAliases": [
      "logs"
    ],
    "deprecatedAliases": [],
    "summary": "interactive session log browser",
    "detailedHelp": "/logs-view\ninteractive session log browser",
    "section": "Context & Limits",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.logs-view",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:logs-view",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "logs-view",
      "usage": "/logs-view",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:goal",
    "surface": "slash",
    "name": "goal",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<desc|view|start|pause|resume|cancel|complete|note>",
    "summary": "create/manage a goal (agent plans phases)",
    "detailedHelp": "/goal <desc|view|start|pause|resume|cancel|complete|note>\ncreate/manage a goal (agent plans phases)",
    "section": "Goals & Workflows",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.goal",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:goal",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "goal",
      "usage": "/goal <desc|view|start|pause|resume|cancel|complete|note>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:goals",
    "surface": "slash",
    "name": "goals",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[id]",
    "summary": "list saved goals / view one",
    "detailedHelp": "/goals [id]\nlist saved goals / view one",
    "section": "Goals & Workflows",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.goals",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:goals",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "goals",
      "usage": "/goals [id]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:memory",
    "surface": "slash",
    "name": "memory",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[status|inspect|forget|prune]",
    "summary": "inspect and manage scoped memory",
    "detailedHelp": "/memory [status|inspect|forget|prune]\ninspect and manage scoped memory",
    "section": "Goals & Workflows",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.memory",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:memory",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "memory",
      "usage": "/memory [status|inspect|forget|prune]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:workflow",
    "surface": "slash",
    "name": "workflow",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "workflow status",
    "detailedHelp": "/workflow\nworkflow status",
    "section": "Goals & Workflows",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.workflow",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:workflow",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "workflow",
      "usage": "/workflow",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:workflow-templates",
    "surface": "slash",
    "name": "workflow-templates",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "list workflow templates",
    "detailedHelp": "/workflow-templates\nlist workflow templates",
    "section": "Goals & Workflows",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.workflow-templates",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:workflow-templates",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "workflow-templates",
      "usage": "/workflow-templates",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:workflow-template",
    "surface": "slash",
    "name": "workflow-template",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<n>",
    "summary": "load a workflow template",
    "detailedHelp": "/workflow-template <n>\nload a workflow template",
    "section": "Goals & Workflows",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.workflow-template",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:workflow-template",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "workflow-template",
      "usage": "/workflow-template <n>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:vault",
    "surface": "slash",
    "name": "vault",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "vault status",
    "detailedHelp": "/vault\nvault status",
    "section": "Vault",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.vault",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:vault",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault",
      "usage": "/vault",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:vault-context",
    "surface": "slash",
    "name": "vault-context",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "load vault context into the session",
    "detailedHelp": "/vault-context\nload vault context into the session",
    "section": "Vault",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.vault-context",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:vault-context",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault-context",
      "usage": "/vault-context",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:vault-search",
    "surface": "slash",
    "name": "vault-search",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<q>",
    "summary": "search notes",
    "detailedHelp": "/vault-search <q>\nsearch notes",
    "section": "Vault",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.vault-search",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:vault-search",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault-search",
      "usage": "/vault-search <q>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:vault-recent",
    "surface": "slash",
    "name": "vault-recent",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[n]",
    "summary": "recent notes",
    "detailedHelp": "/vault-recent [n]\nrecent notes",
    "section": "Vault",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.vault-recent",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:vault-recent",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault-recent",
      "usage": "/vault-recent [n]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:vault-project",
    "surface": "slash",
    "name": "vault-project",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<name>",
    "summary": "project notes",
    "detailedHelp": "/vault-project <name>\nproject notes",
    "section": "Vault",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.vault-project",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:vault-project",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault-project",
      "usage": "/vault-project <name>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:vault-tag",
    "surface": "slash",
    "name": "vault-tag",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<tag>",
    "summary": "notes by tag",
    "detailedHelp": "/vault-tag <tag>\nnotes by tag",
    "section": "Vault",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.vault-tag",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:vault-tag",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault-tag",
      "usage": "/vault-tag <tag>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:vault-tree",
    "surface": "slash",
    "name": "vault-tree",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "vault folder tree",
    "detailedHelp": "/vault-tree\nvault folder tree",
    "section": "Vault",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.vault-tree",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:vault-tree",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "vault-tree",
      "usage": "/vault-tree",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:delegate",
    "surface": "slash",
    "name": "delegate",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<model> <task>",
    "summary": "delegate a sub-task to a worker model",
    "detailedHelp": "/delegate <model> <task>\ndelegate a sub-task to a worker model",
    "section": "Orchestra",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.delegate",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:delegate",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "delegate",
      "usage": "/delegate <model> <task>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:tree",
    "surface": "slash",
    "name": "tree",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "live orchestration hierarchy",
    "detailedHelp": "/tree\nlive orchestration hierarchy",
    "section": "Orchestra",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.tree",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:tree",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "tree",
      "usage": "/tree",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:broadcast",
    "surface": "slash",
    "name": "broadcast",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "\"<msg>\"",
    "summary": "inject a directive to all sub-agents",
    "detailedHelp": "/broadcast \"<msg>\"\ninject a directive to all sub-agents",
    "section": "Orchestra",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.broadcast",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:broadcast",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "broadcast",
      "usage": "/broadcast \"<msg>\"",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:gather",
    "surface": "slash",
    "name": "gather",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<id|all>",
    "summary": "merge completed work to staging",
    "detailedHelp": "/gather <id|all>\nmerge completed work to staging",
    "section": "Orchestra",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.gather",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:gather",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "gather",
      "usage": "/gather <id|all>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:scaffold",
    "surface": "slash",
    "name": "scaffold",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<type> <name>",
    "summary": "generate boilerplate (component|route|module)",
    "detailedHelp": "/scaffold <type> <name>\ngenerate boilerplate (component|route|module)",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.scaffold",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:scaffold",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "scaffold",
      "usage": "/scaffold <type> <name>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:port",
    "surface": "slash",
    "name": "port",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<file> <lang>",
    "summary": "translate code to another language",
    "detailedHelp": "/port <file> <lang>\ntranslate code to another language",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.port",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:port",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "port",
      "usage": "/port <file> <lang>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:test-drive",
    "surface": "slash",
    "name": "test-drive",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "\"<target>\"",
    "summary": "auto-test: generate, run, fix, repeat",
    "detailedHelp": "/test-drive \"<target>\"\nauto-test: generate, run, fix, repeat",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.test-drive",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:test-drive",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "test-drive",
      "usage": "/test-drive \"<target>\"",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:bench",
    "surface": "slash",
    "name": "bench",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<target>",
    "summary": "profile & optimize code",
    "detailedHelp": "/bench <target>\nprofile & optimize code",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.bench",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:bench",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "bench",
      "usage": "/bench <target>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:purge",
    "surface": "slash",
    "name": "purge",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "flush transient context & temp files",
    "detailedHelp": "/purge\nflush transient context & temp files",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.purge",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:purge",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "purge",
      "usage": "/purge",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:stage-diff",
    "surface": "slash",
    "name": "stage-diff",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "summary": "unified diff + commit message",
    "detailedHelp": "/stage-diff\nunified diff + commit message",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.stage-diff",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:stage-diff",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "stage-diff",
      "usage": "/stage-diff",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:review",
    "surface": "slash",
    "name": "review",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[stage|unstage|revert|commit|diff|verify]",
    "summary": "review changes, pick files or hunks, commit",
    "detailedHelp": "/review [stage|unstage|revert|commit|diff|verify]\nreview changes, pick files or hunks, commit",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.review",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:review",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "review",
      "usage": "/review [stage|unstage|revert|commit|diff|verify]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:ship",
    "surface": "slash",
    "name": "ship",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[--title t] [--base b]",
    "summary": "publish the head branch and open a pull request",
    "detailedHelp": "/ship [--title t] [--base b]\npublish the head branch and open a pull request",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.ship",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:ship",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "ship",
      "usage": "/ship [--title t] [--base b]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:revert",
    "surface": "slash",
    "name": "revert",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<file>",
    "summary": "discard uncommitted changes to one file",
    "detailedHelp": "/revert <file>\ndiscard uncommitted changes to one file",
    "section": "UVT Tools",
    "hidden": false,
    "permissionClass": "destructive",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.revert",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:revert",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "revert",
      "usage": "/revert <file>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:photogen",
    "surface": "slash",
    "name": "photogen",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<prompt> [--model --aspect]",
    "summary": "generate images",
    "detailedHelp": "/photogen <prompt> [--model --aspect]\ngenerate images",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.photogen",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:photogen",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "photogen",
      "usage": "/photogen <prompt> [--model --aspect]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:frame",
    "surface": "slash",
    "name": "frame",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<prompt>",
    "summary": "generate a single styled frame",
    "detailedHelp": "/frame <prompt>\ngenerate a single styled frame",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.frame",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:frame",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "frame",
      "usage": "/frame <prompt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:re-frame",
    "surface": "slash",
    "name": "re-frame",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<prompt>",
    "summary": "re-run the last image with a new prompt",
    "detailedHelp": "/re-frame <prompt>\nre-run the last image with a new prompt",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.re-frame",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:re-frame",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "re-frame",
      "usage": "/re-frame <prompt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:videogen",
    "surface": "slash",
    "name": "videogen",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<prompt> [--model --duration]",
    "summary": "generate video",
    "detailedHelp": "/videogen <prompt> [--model --duration]\ngenerate video",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.videogen",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:videogen",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "videogen",
      "usage": "/videogen <prompt> [--model --duration]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:sequence",
    "surface": "slash",
    "name": "sequence",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<prompt>",
    "summary": "cinematic multi-shot video",
    "detailedHelp": "/sequence <prompt>\ncinematic multi-shot video",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.sequence",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:sequence",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "sequence",
      "usage": "/sequence <prompt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:animate",
    "surface": "slash",
    "name": "animate",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<prompt>",
    "summary": "animate the last image",
    "detailedHelp": "/animate <prompt>\nanimate the last image",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.animate",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:animate",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "animate",
      "usage": "/animate <prompt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:re-cut",
    "surface": "slash",
    "name": "re-cut",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<prompt>",
    "summary": "re-edit the last video",
    "detailedHelp": "/re-cut <prompt>\nre-edit the last video",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.re-cut",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:re-cut",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "re-cut",
      "usage": "/re-cut <prompt>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:output",
    "surface": "slash",
    "name": "output",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "[open|clean|list]",
    "summary": "manage generated media files",
    "detailedHelp": "/output [open|clean|list]\nmanage generated media files",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.output",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:output",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "output",
      "usage": "/output [open|clean|list]",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:storyboard",
    "surface": "slash",
    "name": "storyboard",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<title>",
    "summary": "multi-scene storyboard pipeline",
    "detailedHelp": "/storyboard <title>\nmulti-scene storyboard pipeline",
    "section": "Media",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.storyboard",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:storyboard",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "storyboard",
      "usage": "/storyboard <title>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:add",
    "surface": "slash",
    "name": "add",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "<element>",
    "summary": "add a HUD overlay (context-bar, timer, tools, help, health, status)",
    "detailedHelp": "/add <element>\nadd a HUD overlay (context-bar, timer, tools, help, health, status)",
    "section": "HUD",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.add",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:add",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "add",
      "usage": "/add <element>",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  },
  {
    "key": "slash:hud",
    "surface": "slash",
    "name": "hud",
    "aliases": [],
    "compatibilityAliases": [],
    "deprecatedAliases": [],
    "args": "remove|list|clear",
    "summary": "manage HUD overlay elements",
    "detailedHelp": "/hud remove|list|clear\nmanage HUD overlay elements",
    "section": "HUD",
    "hidden": false,
    "permissionClass": "unknown",
    "availability": {
      "state": "runtime-dependent",
      "capabilityRequirements": []
    },
    "telemetryName": "slash.hud",
    "acceptedGlobalFlags": [],
    "ownedFlags": {},
    "handler": {
      "id": "handler:slash:hud",
      "kind": "host",
      "module": "src/commands/slash.ts",
      "symbol": "handleSlash"
    },
    "docs": {
      "kind": "manifest",
      "module": "src/commands/command_manifest_data.ts",
      "symbol": "COMMAND_MANIFEST_SOURCE",
      "target": "hud",
      "usage": "/hud remove|list|clear",
      "visible": true,
      "disposition": "generated"
    },
    "release": {
      "disposition": "existing",
      "note": null
    }
  }
];
