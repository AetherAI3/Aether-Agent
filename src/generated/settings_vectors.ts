// GENERATED — do not edit by hand.
// Source: AetherAI3/AETHER-CLOUD contracts/aether-settings/cross-surface-vectors.v1.json
// Source commit: 80e810ada7501127019c704a9a9aeadcee2edb96
// Contract version: 1
// Canonical sha256 (of THIS vector file): 8f4ff065855169a642cc1dca2d5b83a85bee13db9c45aa05ab434b746379d68e
// Canonical sha256 (of the registry it was generated from): 4cd562dab6b53338e7fa57e5ddbb59d8809093da4a426f5c9d72d9a167d70e6a
// Regenerate (no generator script is checked in here; the generator lives in the
// source repo at lib/code_settings/generate_registry.py — this is the whole
// procedure on this side):
//   1. Run `python lib/code_settings/generate_registry.py` in AETHER-CLOUD and
//      take contracts/aether-settings/cross-surface-vectors.v1.json at the
//      commit you want to pin.
//   2. Paste it as AETHER_SETTINGS_VECTORS below and set the header's
//      "Source commit" to that commit.
//   3. Recompute AETHER_SETTINGS_VECTORS_DIGEST as the sha256 of the CANONICAL
//      encoding — JSON with object keys sorted recursively, no whitespace:
//        sha256(JSON.stringify(sortKeysDeep(vectors)))
//      and copy it into the "Canonical sha256" header line too.
//   4. Update AETHER_SETTINGS_VECTORS_SOURCE.commit / .contractVersion to match.
// test/settings_canonical.test.ts verifies the digest reproduces under exactly
// that recipe, so a bad paste fails before it can reach a user.
//
// This file is the ONE place Aether Agent learns a canonical setting's key,
// type, default, allowed scopes and persistence owner. Never re-declare those
// facts anywhere else in this repository.

/** Vendored copy of the canonical cross-surface settings vectors. */
export const AETHER_SETTINGS_VECTORS = {
  "contractDigest": "4cd562dab6b53338e7fa57e5ddbb59d8809093da4a426f5c9d72d9a167d70e6a",
  "contractSchema": "aether.settings/1",
  "contractVersion": 1,
  "schema": "aether.settings.cross-surface-vectors/1",
  "settings": [
    {
      "allowedScopes": [
        "account",
        "project"
      ],
      "apply": "approval_step_up",
      "defaultValue": false,
      "deprecated": false,
      "key": "actions.liveCanvas.autoApply",
      "managedPolicy": true,
      "persistence": "server",
      "policyOnlyScopes": [
        "team"
      ],
      "validation": {
        "kind": "boolean"
      },
      "valueType": "boolean"
    },
    {
      "allowedScopes": [
        "account",
        "project"
      ],
      "apply": "next_session",
      "defaultValue": "medium",
      "deprecated": false,
      "key": "agent.defaultEffort",
      "managedPolicy": false,
      "persistence": "server",
      "policyOnlyScopes": [
        "team"
      ],
      "validation": {
        "kind": "enum",
        "options": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ]
      },
      "valueType": "string"
    },
    {
      "allowedScopes": [
        "account",
        "project"
      ],
      "apply": "next_session",
      "defaultValue": "sonnet",
      "deprecated": false,
      "key": "agent.defaultModel",
      "managedPolicy": false,
      "persistence": "server",
      "policyOnlyScopes": [
        "team"
      ],
      "validation": {
        "kind": "catalog_model_id",
        "maximumLength": 256
      },
      "valueType": "string"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": "blue",
      "deprecated": false,
      "key": "appearance.themeId",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "enum",
        "options": [
          "blue",
          "light",
          "sage",
          "olive",
          "forest",
          "black"
        ]
      },
      "valueType": "string"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": false,
      "deprecated": false,
      "key": "editor.autoSave",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "boolean"
      },
      "valueType": "boolean"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": 14,
      "deprecated": false,
      "key": "editor.fontSize",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "integer",
        "maximum": 40,
        "minimum": 8
      },
      "valueType": "integer"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": true,
      "deprecated": false,
      "key": "editor.guides",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "boolean"
      },
      "valueType": "boolean"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": true,
      "deprecated": false,
      "key": "editor.insertSpaces",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "boolean"
      },
      "valueType": "boolean"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": false,
      "deprecated": false,
      "key": "editor.minimap",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "boolean"
      },
      "valueType": "boolean"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": "none",
      "deprecated": false,
      "key": "editor.renderWhitespace",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "enum",
        "options": [
          "none",
          "selection",
          "boundary",
          "all"
        ]
      },
      "valueType": "string"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": 2,
      "deprecated": false,
      "key": "editor.tabSize",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "integer",
        "maximum": 8,
        "minimum": 1
      },
      "valueType": "integer"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": false,
      "deprecated": false,
      "key": "editor.wordWrap",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "boolean"
      },
      "valueType": "boolean"
    },
    {
      "allowedScopes": [
        "device"
      ],
      "apply": "immediate",
      "defaultValue": true,
      "deprecated": false,
      "key": "voice.enabled",
      "managedPolicy": false,
      "persistence": "device",
      "policyOnlyScopes": [],
      "validation": {
        "kind": "boolean"
      },
      "valueType": "boolean"
    }
  ]
} as const;

/** sha256 of the canonical encoding of AETHER_SETTINGS_VECTORS. */
export const AETHER_SETTINGS_VECTORS_DIGEST =
  "8f4ff065855169a642cc1dca2d5b83a85bee13db9c45aa05ab434b746379d68e" as const;

/**
 * sha256 of the canonical encoding of the registry these vectors came from.
 * AETHER-CLOUD pins the same literal, so a default/scope/key changed on one
 * side alone fails the other side's parity test.
 */
export const AETHER_SETTINGS_CONTRACT_DIGEST =
  "4cd562dab6b53338e7fa57e5ddbb59d8809093da4a426f5c9d72d9a167d70e6a" as const;

export const AETHER_SETTINGS_VECTORS_SOURCE = {
  repo: "AetherAI3/AETHER-CLOUD",
  path: "contracts/aether-settings/cross-surface-vectors.v1.json",
  commit: "80e810ada7501127019c704a9a9aeadcee2edb96",
  contractVersion: 1,
} as const;
