---
name: Freeze Notion Full-Page Content Overwrites
tags:
  - notion
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # notion / freeze-content-overwrite

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `notion.ingress.freeze_content_overwrite`

  ## What it does

  Denies `notion-update-page` calls whose `command` argument is `replace_content` — the one edge on Notion's hosted MCP server that overwrites a page's **entire body** in a single call. The overwrite is recoverable only through Notion page history, and it happens silently from the agent's viewpoint: the tool reports success, and neither the agent nor the user sees that the previous content is gone. The additive commands pass through untouched, so agents can still append content (`insert_content_after`) and edit page properties (`update_properties`) without a human in the loop.

  This freezes the only silently-destructive write in the hosted server's 18-tool surface — the hosted server exposes **no delete, archive, or trash tool at all**, so `replace_content` is where the PF-06 record-destruction risk lives on this target. A prompt-injected or simply mistaken agent that "cleans up" a page with `replace_content` destroys meeting notes, HR trackers, or finance runbooks in one call; with this policy attached, the worst it can do is append.

  There is deliberately **no identity exemption**: page bodies must survive agent error and prompt injection regardless of who is driving the agent. The deny reason steers the agent to `insert_content_after`; a legitimate full rewrite belongs in the Notion UI, where page history and human eyes are both present.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records by removing the agent's unilateral ability to replace a page's full body.
  - **HIPAA §164.312(c)** — supports the integrity standard (protection of ePHI recorded in Notion pages — care notes, intake trackers — from improper alteration/destruction); **§164.530(c)** — supports privacy safeguards over those records.
  - **GDPR Art. 5(1)(d)** — supports accuracy by preventing mass corruption of personal-data records: one `replace_content` call can wipe every fact a page holds about data subjects.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g. `notion-notion-update-page` for a server named `notion`), and that prefix is deployment-specific, so the policy matches case-insensitively by suffix:

  - `*-update-page` — the hosted server's `notion-update-page` (verified against Notion's supported-tools documentation).

  The suffix also happens to match the legacy official local server's `update-page` once the gateway prefixes it (e.g. `notion-update-page`) — harmless, because that tool takes no `command` argument and therefore always passes (see Known limitations). Verify the exact name your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  The hosted `notion-update-page` takes `page_id`, a `command` ∈ {`replace_content`, `insert_content_after`, `update_properties`}, and command-specific content payloads (verified from the landscape research as of mid-2026). Every read goes through `object.get`:

  - `args.command` is read as `object.get(object.get(input.payload, "args", {}), "command", "")`, then trimmed and lowercased before comparison, so `Replace_Content`, `REPLACE_CONTENT`, and whitespace-padded variants (` replace_content `, `replace_content\n`) cannot slip past a server that strips/normalizes the command before dispatch.
  - A call with **no `args` object or no `command` key is not treated as an overwrite** and passes through — the server itself rejects a malformed call; this policy only freezes confirmed full-body overwrites.
  - A non-string `command` (array, object, number) never compares equal to `replace_content` and passes through; the server's own schema validation rejects such calls anyway.

  ## Examples

  ### Allowed — appending content (the recommended alternative)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-update-page", "type": "tool" },
      "payload": {
        "name": "notion-notion-update-page",
        "args": {
          "page_id": "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
          "command": "insert_content_after",
          "new_str": "## Follow-ups\n- Circulate the draft"
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — full-page overwrite

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-update-page", "type": "tool" },
      "payload": {
        "name": "notion-notion-update-page",
        "args": {
          "page_id": "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
          "command": "replace_content",
          "new_str": "Cleaned up!"
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Full-page overwrites are blocked (...)"`.

  ### Allowed — property edit on the same tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-update-page", "type": "tool" },
      "payload": {
        "name": "notion-notion-update-page",
        "args": {
          "page_id": "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
          "command": "update_properties",
          "properties": { "Status": "In review" }
        }
      }
    }
  }
  ```

  `allow = true` — property edits are additive-class and left for other policies to govern.

  ## Composition

  This policy is single-purpose: it freezes the full-body overwrite command and nothing else. Pair it with:

  - a **structural-write role gate** on `-move-pages`, `-update-data-source`, and `-update-view` — schema rewrites and workspace restructuring are the other alteration surfaces on the hosted server, and they are intentionally out of scope here,
  - a **directory-harvest gate** on `-get-users`, which returns workspace member and guest emails,
  - an **egress redaction** policy on the read surface (`-search`, `-fetch`, `-query-data-sources`) for regulated data leaving the workspace.

  ## Known limitations

  - **Hosted-server scope — by design.** This policy targets Notion's hosted MCP server (the surface behind the Claude connector), which has no delete/archive tool; `replace_content` is its only silently-destructive write. The legacy official local server's `delete-block` and `update-page-markdown`, and the awkoy community server's archive/delete operations behind its `notion_execute` meta-tool, are different surfaces and are **not** covered — prefer blocking those servers in gateway config and standardizing on the hosted target.
  - **Legacy local `update-page` matches the suffix but always passes.** Behind a server named `notion`, the legacy local server's `update-page` appears as `notion-update-page` and matches `*-update-page` — but it takes no `command` argument, so this policy never denies it. Its content-overwrite sibling `update-page-markdown` does **not** match the suffix and is out of scope per the previous point.
  - **No identity exemption — by design.** There is no group that may overwrite page bodies through the agent channel; records must survive agent error and prompt injection for every caller. Legitimate full rewrites belong in the Notion UI. If your organization truly requires an agent-channel break-glass, add a `groups`-gated `allow` branch per the identity-placeholder conventions — but understand it reopens the injection surface this policy closes.
  - **Page history is the recovery path, not a guarantee.** Notion page history has plan-dependent retention (shorter on lower plans). This policy prevents the overwrite from happening at all, which is stronger — but anything that does slip through a misconfigured deployment depends on history retention for recovery.
  - **Appending is still writing.** `insert_content_after` can append misleading or injected content; `update_properties` can flip statuses and retitle pages. Those are visible, reversible edits — governed by companion policies, not this one.
  - **Command normalization covers case + surrounding whitespace only.** The `command` value is `trim_space`-d and lowercased, defeating casing and padding tricks. It does **not** normalize Unicode homoglyphs, zero-width characters, or interior whitespace (e.g. `replace _content`). Such a value passes this policy — but it also fails the hosted server's exact-string command dispatch, so no overwrite occurs. If a future server variant does fuzzy command matching, extend `requested_command` accordingly.
  - **Malformed calls fail open here.** A `-update-page` call with a missing or non-string `command` passes the policy and is left for the server's own schema validation to reject. This is intentional (`object.get` defaults): a benign call is never misclassified as an overwrite.
  - **Argument vocabulary is research-verified as of mid-2026.** The `command` key and its three values come from the landscape research against Notion API version `2026-03-11`. If Notion adds another destructive command value, it would pass this policy until the matcher is extended.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - notion
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package notion.ingress.freeze_content_overwrite

# Deny-by-default: only the explicit allow rule below permits the request.
default allow := false

# --- Tool matching ---
# Hosted Notion MCP update tool is `notion-update-page`; the gateway prepends
# the configured MCP server name (e.g. `notion-notion-update-page`), so match
# by suffix, case-insensitively. Verify the exact name your gateway sends with
# the dump-input debug technique.
is_update_page_tool if {
    endswith(lower(input.resource.name), "-update-page")
}

# Safe read of the `command` argument: a missing args object or a missing
# command key yields "" (never treated as an overwrite). The value is trimmed
# and lowercased before comparison, so `Replace_Content`, `REPLACE_CONTENT`,
# or a whitespace-padded ` replace_content `/`replace_content\n` cannot slip
# past a server that strips/normalizes the command before dispatch. A
# non-string command leaves requested_command undefined, which also means
# "not an overwrite" — the server's schema validation rejects such calls.
requested_command := lower(trim_space(command_value)) if {
    command_value := object.get(object.get(input.payload, "args", {}), "command", "")
    is_string(command_value)
}

# `replace_content` overwrites the entire page body — recoverable only via
# Notion page history, and silently from the agent's viewpoint. The additive
# commands (`insert_content_after`, `update_properties`) are not matched.
is_content_overwrite if {
    is_update_page_tool
    requested_command == "replace_content"
}

# Allow every call that is not a confirmed full-page overwrite.
allow if {
    not is_content_overwrite
}

reason := "Full-page overwrites are blocked: notion-update-page with command \"replace_content\" replaces the entire page body, recoverable only through Notion page history and invisibly from the agent's viewpoint. Append with command \"insert_content_after\" instead, or make the full rewrite by hand in the Notion UI. Contact your InfoSec team if a full overwrite is legitimately required." if {
    not allow
}
```
