---
name: "Block Agent Purchases in Restricted Categories"
tags:
  - ucp
  - agentic-commerce
  - access-control
  - spend-control
  - ingress
publishedAt: 2026-06-27
description: |
  # ucp / restricted-category-block

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow, with targeted denies on checkout/cart writes that add a restricted category, SKU, or product
  **Package:** `ucp.ingress.restricted_category_block`

  ## What it does

  This is enterprise buyer-side governance: it governs the agents *you* run. An
  organization that lets its agents transact over the Universal Commerce Protocol
  (UCP) can bar those agents from autonomously buying certain categories — for
  example weapons, controlled substances, gift cards, or a named set of
  enterprise-restricted SKUs.

  The policy is `default allow := true`. It denies a checkout/cart **write**
  (`create_checkout`, `update_checkout`, `update_cart`) only when one of these
  signals is present:

  1. A line item whose product **id** or **title** matches the restricted set —
     either an exact id/SKU in `input.context.restricted_skus`, or a keyword in
     the configurable `restricted_keywords` set found in the item title.
  2. A `messages[]` **warning** that carries a restricted code (e.g.
     `age_restricted`), drawn from the configurable `restricted_message_codes`
     set.

  Anything else — reads, non-restricted carts, other tools — passes through
  untouched.

  ## Gate the write where the content enters, not the finalize

  On the confirmed UCP MCP binding, **cart content flows in at `create_checkout`
  and `update_checkout`** (and, on a cart surface, `update_cart`): those args
  carry the `line_items`. **`complete_checkout` args carry no cart content** —
  they carry only the checkout `id` (top level) plus finalization data
  (`payment`, `signals`, `attribution`). There is therefore nothing to inspect
  on `complete_checkout` for a restricted item, so this policy does **not** gate
  it: a restricted item is caught when it is *added* to the checkout/cart, which
  is strictly earlier than the finalize step. (An earlier revision also listed
  `complete_checkout` here; that leg was dead against the real arg shape and has
  been removed.)

  ## Scope and honesty about what is visible

  The gateway sits on the **MCP path** only. It sees the tool calls your agent
  makes through it (`create_checkout`, `update_checkout`, `update_cart`, …). It
  does **not** see a browser `continue_url` handoff: if the checkout is finished
  by a human in a browser tab, that step is outside the gateway and outside this
  policy. This control is therefore an agent-autonomy guardrail, not a guarantee
  that a restricted item can never be bought by any means.

  This policy is complementary to UCP and to the merchant. It is not a competing
  trust referee: the merchant still authorizes the order, the merchant still owns
  the catalog, and UCP still defines the wire shapes. This policy only decides
  whether *your* agent is allowed to push the call.

  ## `input.context.*` is gateway-supplied, not a UCP field

  The buyer's spending limits, budgets, velocity, and allow/deny lists **do not
  exist as UCP fields**. In UCP those constraints live only inside an opaque AP2
  SD-JWT (`checkout.ap2.checkout_mandate`) that the gateway cannot read as plain
  JSON. So any cap or list this policy consults is **policy input the gateway
  injects** at `input.context`, not something parsed out of the UCP payload:

  - `input.context.restricted_skus` — array of exact product ids / SKUs the org
    bars. Gateway-supplied.

  Treat `input.context.*` as administrator-configured policy data, never as a
  buyer-asserted UCP field.

  ## UCP fields this policy reads

  All of these are confirmed UCP paths, read defensively with
  `object.get(...)` so a missing field falls through to allow rather than
  erroring:

  - **Tool name** — `input.resource.name`, lowercased and matched against
    hyphenated, underscored, and collapsed shapes of the OpenRPC operations
    (`create_checkout`, `update_checkout`, `update_cart`), anchored at a
    `-`/`_` separator, plus the bare un-prefixed names. The gateway prepends a
    non-standard server prefix and commonly slugifies underscores to hyphens
    when federating tool names (`ucp-shop-update-checkout`). Never read the
    tool name from `input.payload.name`.
  - **Tool args** — `input.payload.args`. The checkout object rides under
    `args.checkout` (the canonical UCP tool-arg shape, as the sibling policies
    read it); `line_items[]` and `messages[]` are read from `args.checkout.*`,
    with top-level `args.line_items` / `args.messages` kept as fallbacks for
    servers that accept the flattened / cart form.
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

  allow := false  when  (create/update write tool) AND (restricted line item OR restricted warning)
  reasons         the human-readable cause(s)
  reason          reasons joined into one string
  ```

  Reads (`get_checkout`, `get_cart`, `search_catalog`, …) and `complete_checkout`
  are never denied by this policy.

  ## Configuration

  Edit two sets at the top of the Rego:

  - `restricted_keywords` — lowercase substrings matched against each item
    title (shipped placeholders: `firearm`, `ammunition`, `gift card`).
  - `restricted_message_codes` — lowercase `messages[].code` values that, on a
    `warning`, force a deny (shipped placeholder: `age_restricted`).
  - The exact-id / SKU list is **not** in the Rego — it is supplied per-tenant by
    the gateway at `input.context.restricted_skus`, so the same policy body
    serves every tenant.

  ## Examples

  ### Denied — adding a restricted SKU to a checkout (`update_checkout`)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "ucp-shop-7f3a-update_checkout", "type": "tool" },
      "payload": {
        "name": "ucp-shop-7f3a-update_checkout",
        "args": {
          "id": "chk_01HZX5VQ7B",
          "checkout": {
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

  ### Allowed — creating a checkout with only ordinary items (`create_checkout`)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "ucp-shop-7f3a-create_checkout", "type": "tool" },
      "payload": {
        "name": "ucp-shop-7f3a-create_checkout",
        "args": {
          "checkout": {
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
  - **Only the configured write tools are gated.** If your UCP MCP server
    exposes another mutating cart/checkout tool that carries `line_items`, add
    its name shapes to `write_tool_shapes`.
direction: ingress
apps:
  - ucp
industries:
  - commerce
bundles:
  - agentic-commerce
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0
---

```rego
package ucp.ingress.restricted_category_block

# Default-allow: only deny when a checkout/cart WRITE that carries cart content
# (create_checkout / update_checkout / update_cart) adds a restricted category,
# SKU, or warning. Reads, complete_checkout, and ordinary writes pass through.
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
# hyphens when federating tool names ("ucp-shop-update-checkout"), so each op
# is matched in hyphenated, underscored, and collapsed shape — anchored at a
# "-"/"_" separator — plus the bare un-prefixed name.
#
# These are the calls that CARRY CART CONTENT (line_items): create_checkout and
# update_checkout, plus update_cart on a cart surface. complete_checkout is
# deliberately NOT gated here — its args carry only the checkout id and
# finalization data, no line_items, so there is nothing to inspect there. A
# restricted item is caught when it is added, which is earlier than finalize.
# -----------------------------------------------------------------------------
write_tool_shapes := {
    "create_checkout",
    "create-checkout",
    "createcheckout",
    "update_checkout",
    "update-checkout",
    "updatecheckout",
    "update_cart",
    "update-cart",
    "updatecart",
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
# args (cart form), kept here as fallbacks; both locations are inspected, so a
# restricted item in either one denies.
args := object.get(input.payload, "args", {})

checkout := object.get(args, "checkout", {})

# line_items[] = [{ id, item, quantity, totals }]; item = { id, title, price }.
line_items := array.concat(
    object.get(checkout, "line_items", []),
    object.get(args, "line_items", []),
)

# Gateway-SUPPLIED policy input (not a UCP field): exact product ids / SKUs the
# org bars. Injected by the gateway at input.context.restricted_skus.
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

# A line item is restricted when its item.id matches a gateway-supplied SKU.
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
