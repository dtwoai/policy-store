---
name: "Shopify: Block Agent Purchases in Restricted Categories"
tags:
  - shopify
  - ucp
  - agentic-commerce
  - access-control
  - spend-control
  - ingress
publishedAt: 2026-06-27
description: |
  # shopify / restricted-category-block

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow, with targeted denies on checkout/cart writes that contain a restricted category, SKU, or product
  **Package:** `shopify.ingress.restricted_category_block`

  ## What it does

  This is enterprise buyer-side governance: it governs the agents *you* run. An
  organization that lets its agents transact over the Universal Commerce Protocol
  (UCP) can bar those agents from autonomously buying certain categories — for
  example weapons, controlled substances, gift cards, or a named set of
  enterprise-restricted SKUs.

  The policy is `default allow := true`. It denies a `complete_checkout` or
  cart-update call only when one of three signals is present:

  1. A line item whose product **id** or **title** matches the restricted set —
     either an exact id/SKU in `input.context.restricted_skus`, or a keyword in
     the configurable `restricted_keywords` set found in the item title.
  2. A `messages[]` **warning** that carries a restricted code (e.g.
     `age_restricted`), drawn from the configurable `restricted_message_codes`
     set.

  Anything else — reads, non-restricted carts, other tools — passes through
  untouched.

  ## Scope and honesty about what is visible

  DTwo sits on the **MCP path** only. It sees the tool calls your agent makes
  through the gateway (`create_cart`, `update_cart`, `complete_checkout`, …). It
  does **not** see a browser `continue_url` handoff: if the checkout is finished
  by a human in a browser tab, that step is outside the gateway and outside this
  policy. This control is therefore an agent-autonomy guardrail, not a guarantee
  that a restricted item can never be bought by any means.

  DTwo is complementary to UCP and to Shopify. It is not a competing trust
  referee: the merchant still authorizes the order, Shopify still owns the
  catalog, and UCP still defines the wire shapes. This policy only decides
  whether *your* agent is allowed to push the call.

  ## `input.context.*` is DTwo-supplied, not a UCP field

  The buyer's spending limits, budgets, velocity, and allow/deny lists **do not
  exist as UCP fields**. In UCP those constraints live only inside an opaque AP2
  SD-JWT (`checkout.ap2.checkout_mandate`) that the gateway cannot read as plain
  JSON. So any cap or list this policy consults is **policy input that DTwo
  injects** at `input.context`, not something parsed out of the UCP payload:

  - `input.context.restricted_skus` — array of exact product ids / SKUs the org
    bars. DTwo-supplied.

  Treat `input.context.*` as administrator-configured policy data, never as a
  buyer-asserted UCP field.

  ## UCP fields this policy reads

  All of these are confirmed UCP paths, read defensively with
  `object.get(...)` so a missing field falls through to allow rather than
  erroring:

  - **Tool name** — `input.resource.name`, lowercased and matched against
    hyphenated, underscored, and collapsed shapes of the OpenRPC operations
    (`complete_checkout`, `update_cart`, `update_checkout`), anchored at a
    `-`/`_` separator, plus the bare un-prefixed names. The gateway prepends a
    non-standard server prefix and commonly slugifies underscores to hyphens
    when federating tool names (`ucp-shop-complete-checkout`). Never read the
    tool name from `input.payload.name`.
  - **Tool args** — `input.payload.args`. The checkout object rides under
    `args.checkout` (the canonical UCP tool-arg shape, as the sibling policies
    read it); `line_items[]` and `messages[]` are read from `args.checkout.*`,
    with top-level `args.line_items` / `args.messages` kept as fallbacks for
    servers that accept the flattened form.
  - **Line items** — `line_items[]` is an array of
    `{ id, item, quantity, totals }`; `item` is `{ id, title, price, image_url? }`
    where `price` is a signed integer in the currency minor unit (cents).
  - **Messages** — `messages[]` is a `oneOf` discriminated on the `type` const
    (`error` | `warning` | `info`). Only `error` carries `severity`. `code` and
    `error_code` are freeform strings. This policy inspects `warning` entries for
    a restricted `code`.

  ## Behavior

  ```text
  default allow := true

  allow := false  when  (write tool) AND (restricted line item OR restricted warning)
  reasons         the human-readable cause(s)
  reason          reasons joined into one string
  ```

  `complete_checkout` is the primary gate — it is the irreversible step. The
  policy also gates `update_cart` and `update_checkout` so a restricted item is
  caught when it is added, not only at the final commit. Reads
  (`get_checkout`, `get_cart`, `search_catalog`, …) are never denied.

  ## Configuration

  Edit three sets at the top of the Rego:

  - `restricted_keywords` — lowercase substrings matched against each item
    title (shipped placeholders: `firearm`, `ammunition`, `gift card`).
  - `restricted_message_codes` — lowercase `messages[].code` values that, on a
    `warning`, force a deny (shipped placeholder: `age_restricted`).
  - The exact-id / SKU list is **not** in the Rego — it is supplied per-tenant by
    DTwo at `input.context.restricted_skus`, so the same policy body serves every
    tenant.

  ## Examples

  ### Denied — completing a checkout that contains a restricted SKU

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "shopify-mcp-7f3a-complete_checkout", "type": "tool" },
      "payload": {
        "name": "shopify-mcp-7f3a-complete_checkout",
        "args": {
          "checkout": {
            "currency": "USD",
            "status": "ready_for_complete",
            "line_items": [
              { "id": "li_1", "quantity": 1,
                "item": { "id": "SKU-RESTRICTED-001", "title": "Field Knife", "price": 4999 } }
            ]
          }
        }
      },
      "context": { "restricted_skus": ["SKU-RESTRICTED-001"] }
    }
  }
  ```

  `allow = false`, `reason` names the restricted item id.

  ### Allowed — completing a checkout with only ordinary items

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "shopify-mcp-7f3a-complete_checkout", "type": "tool" },
      "payload": {
        "name": "shopify-mcp-7f3a-complete_checkout",
        "args": {
          "checkout": {
            "currency": "USD",
            "status": "ready_for_complete",
            "line_items": [
              { "id": "li_1", "quantity": 2,
                "item": { "id": "SKU-PEN-014", "title": "Ballpoint Pen", "price": 250 } }
            ]
          }
        }
      },
      "context": { "restricted_skus": ["SKU-RESTRICTED-001"] }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  Part of the [`agentic-commerce`](../../../bundles/agentic-commerce/README.md)
  bundle. Pair with a spend-cap policy (`input.context.mandate.max_total`) for
  budget enforcement and an egress policy that redacts buyer PII from tool
  results.

  ## Known limitations

  - **Browser handoff is invisible.** A checkout completed via a `continue_url`
    in a human's browser does not pass through the gateway, so this policy cannot
    gate it. Use it for autonomous agent purchases.
  - **Keyword matching is substring-based.** Title keywords can over- or
    under-match (e.g. `gift card` would match "regift cardigan"). Prefer the
    exact-id `restricted_skus` list where the catalog gives you stable SKUs;
    treat keywords as a coarse backstop.
  - **No identity-based exemptions.** All callers are treated the same. To add a
    break-glass purchaser, gate a separate `allow if` branch on
    `input.subject.claims` (never on `is_admin` / `teams` / `user`).
  - **Only the configured write tools are gated.** If your Shopify MCP server
    exposes another mutating checkout/cart tool, add its name shapes to
    `write_tool_shapes`.
direction: ingress
apps:
  - shopify
industries:
  - retail
bundles:
  - agentic-commerce
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0
---

```rego
package shopify.ingress.restricted_category_block

# Default-allow: only deny when a checkout/cart write carries a restricted
# category, SKU, or warning. Reads and ordinary writes pass through.
default allow := true

# -----------------------------------------------------------------------------
# CONFIG: restricted title keywords (lowercase substrings).
# Matched against each line item's item.title. Placeholders — replace with the
# categories your organization bars its agents from buying autonomously.
# -----------------------------------------------------------------------------
restricted_keywords := {
    "firearm", # placeholder, replace with your restricted keywords
    "ammunition", # placeholder, replace with your restricted keywords
    "gift card", # placeholder, replace with your restricted keywords
}

# -----------------------------------------------------------------------------
# CONFIG: restricted messages[].code values (lowercase). A `warning` message
# carrying one of these forces a deny. code/error_code are freeform UCP strings.
# -----------------------------------------------------------------------------
restricted_message_codes := {
    "age_restricted", # placeholder, replace with your restricted message codes
}

# -----------------------------------------------------------------------------
# WRITE TOOLS: a tool is a gated write when its lowercased input.resource.name
# (NOT input.payload.name) matches one of these OpenRPC operations. The gateway
# prepends a non-standard server prefix and commonly slugifies underscores to
# hyphens when federating tool names ("ucp-shop-complete-checkout"), so each
# op is matched in hyphenated, underscored, and collapsed shape — anchored at
# a "-"/"_" separator — plus the bare un-prefixed name. complete_checkout is
# the irreversible commit; the cart/checkout updates catch a restricted item
# as it is added rather than only at the final commit.
# -----------------------------------------------------------------------------
write_tool_shapes := {
    "complete_checkout",
    "complete-checkout",
    "completecheckout",
    "update_cart",
    "update-cart",
    "updatecart",
    "update_checkout",
    "update-checkout",
    "updatecheckout",
}

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

tool_name := lower(object.get(input.resource, "name", ""))

tool_matches(shapes) if shapes[tool_name]

tool_matches(shapes) if {
    some shape in shapes
    endswith(tool_name, sprintf("-%s", [shape]))
}

tool_matches(shapes) if {
    some shape in shapes
    endswith(tool_name, sprintf("_%s", [shape]))
}

is_write_tool if tool_matches(write_tool_shapes)

# Tool args live at input.payload.args (canonical). The checkout object rides
# under args.checkout — the spec-shaped UCP argument the sibling policies
# read. Some servers also accept flattened top-level line_items/messages
# args, kept here as fallbacks; both locations are inspected, so a restricted
# item in either one denies.
args := object.get(input.payload, "args", {})

checkout := object.get(args, "checkout", {})

# line_items[] = [{ id, item, quantity, totals }]; item = { id, title, price }.
line_items := array.concat(
    object.get(checkout, "line_items", []),
    object.get(args, "line_items", []),
)

# DTwo-SUPPLIED policy input (not a UCP field): exact product ids / SKUs the org
# bars. Injected by the gateway at input.context.restricted_skus.
restricted_skus := {s |
    some s in object.get(input.context, "restricted_skus", [])
    is_string(s)
}

# messages[] = oneOf error|warning|info, discriminated on the "type" const.
messages := array.concat(
    object.get(checkout, "messages", []),
    object.get(args, "messages", []),
)

# -----------------------------------------------------------------------------
# Restricted-item detection
# -----------------------------------------------------------------------------

# A line item is restricted when its item.id matches a DTwo-supplied SKU.
restricted_item_ids contains id if {
    some li in line_items
    item := object.get(li, "item", {})
    id := object.get(item, "id", "")
    is_string(id)
    id != ""
    restricted_skus[id]
}

# A line item is restricted when its item.title contains a restricted keyword.
restricted_item_titles contains title if {
    some li in line_items
    item := object.get(li, "item", {})
    title := object.get(item, "title", "")
    is_string(title)
    title != ""
    some kw in restricted_keywords
    contains(lower(title), kw)
}

# A `warning` message carries a restricted code.
restricted_warning_codes contains code if {
    some m in messages
    object.get(m, "type", "") == "warning"
    code := object.get(m, "code", "")
    is_string(code)
    restricted_message_codes[lower(code)]
}

# -----------------------------------------------------------------------------
# Deny rules
# -----------------------------------------------------------------------------

allow := false if {
    is_write_tool
    count(restricted_item_ids) > 0
}

allow := false if {
    is_write_tool
    count(restricted_item_titles) > 0
}

allow := false if {
    is_write_tool
    count(restricted_warning_codes) > 0
}

# -----------------------------------------------------------------------------
# Reasons
# -----------------------------------------------------------------------------

reasons contains msg if {
    is_write_tool
    some id in restricted_item_ids
    msg := sprintf("Item '%s' is in a restricted category your agents may not purchase. Contact your procurement team if this needs to change.", [id])
}

reasons contains msg if {
    is_write_tool
    some title in restricted_item_titles
    msg := sprintf("Item titled '%s' matches a restricted category your agents may not purchase. Contact your procurement team if this needs to change.", [title])
}

reasons contains msg if {
    is_write_tool
    some code in restricted_warning_codes
    msg := sprintf("Checkout carries a restricted '%s' warning; autonomous purchase is not permitted. Contact your procurement team if this needs to change.", [code])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
