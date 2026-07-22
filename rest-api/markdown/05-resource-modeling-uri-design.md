# 05 · Resource Modeling & URI Design

> **In one line:** Resource modeling is the act of choosing which nouns your API exposes and how they relate; URI design is how you name them — and both decisions outlive every implementation choice you will make, because URIs are the one part of an API you can almost never take back.

---

## 1. Overview

**Resource modeling** is where an API is won or lost. Before a line of handler code exists, you decide what things your API talks about, which of them are addressable, how they nest, and what a client can do to each. Get it right and the endpoints practically write themselves, the status codes are obvious, caching works, and five years of feature requests fit without a `v2`. Get it wrong and every subsequent decision is a workaround: you end up with `POST /orders/updateStatusAndNotify`, three ways to fetch the same thing, and a versioning migration eighteen months in.

The problem it solves is **stable naming under change**. Implementations churn — languages, databases, service boundaries, team ownership. URIs do not get to churn, because they are copied into partner code, cached by CDNs, stored in webhook configurations, logged in audit trails and pasted into support tickets. Tim Berners-Lee's 1998 note *Cool URIs don't change* made the point for the Web; it applies with even more force to an API, where a broken URI is an outage for someone else's production system. So the modelling exercise is really: *find the concepts that will still make sense when the implementation is unrecognisable.*

The core discipline is to model the **domain**, not the database and not the UI. A database table is a storage decision; a screen is a presentation decision; a resource is a concept your consumers already have a word for. Sometimes these coincide — `customers` is a table, a screen and a resource. Often they do not: a "checkout" is a screen but not a table; a `payment_intent` is a concept Stripe invented because neither the card charge nor the order captured the right state machine. The best test is linguistic — if a domain expert would use the word in a sentence about the business, it is probably a resource.

Two shapes recur so consistently they are worth naming. A **collection resource** (`/orders`) is a container you list from and create into; a **document resource** (`/orders/ord_9F2`) is a single addressable item. Everything else is a variation: sub-collections for containment (`/orders/ord_9F2/items`), **process/action resources** for verbs that will not fit into CRUD (`POST /orders/ord_9F2/cancellation`), and **singleton resources** for one-per-parent concepts (`/users/usr_9/preferences`).

Concretely: **Stripe** models `customers`, `payment_intents`, `charges`, `refunds`, `invoices` and `subscriptions` as flat, top-level collections with opaque prefixed ids (`cus_`, `pi_`, `ch_`) — relationships travel as id fields, not as deep URL nesting, which is why almost every Stripe URL is only two segments deep. **GitHub** takes the other approach where hierarchy is genuinely identifying: `/repos/{owner}/{repo}/issues/{number}` reflects that issue number 7 is only meaningful within a repository. Both are correct because the nesting matches the ownership semantics of the domain. This chapter shows you how to make that call yourself — and §5 works one domain end to end so you can walk into a design round with a template.

## 2. Core Concepts

- **Resource** — any concept worth naming and addressing. Not a table, not a class, not a screen; a noun your domain experts use.
- **Collection resource** — a plural container: `/orders`. Supports `GET` (list, paginated) and `POST` (create). Never returns everything unbounded.
- **Document resource** — one member of a collection: `/orders/ord_9F2`. Supports `GET`, `PATCH`, `PUT`, `DELETE`.
- **Sub-resource (nested collection)** — a collection that only exists within a parent: `/orders/ord_9F2/items`. Justified when the child cannot be identified or does not exist without the parent.
- **Singleton resource** — exactly one per parent, no id segment: `/users/usr_9/preferences`, `/me`. Supports `GET`/`PUT`/`PATCH`, rarely `DELETE`.
- **Process (action) resource** — a verb reified as a noun so it gets an identity, a history and a status: `POST /orders/ord_9F2/cancellation`, `POST /videos/vid_3/transcodes`.
- **Path vs query parameters** — the path *identifies* the resource; the query string *filters, sorts, paginates or shapes* the representation of a collection. `GET /orders/ord_9F2` vs `GET /orders?status=shipped&sort=-created_at`.
- **Canonical URI** — the one authoritative address of a resource. Aliases may exist but every representation should link back to the canonical form via `self`.
- **Opaque identifier** — an id whose structure the client must not parse: `ord_9F2xQ`, a UUID, a ULID. Prevents enumeration and decouples you from storage.
- **Cardinality & ownership** — whether a relationship is 1:1, 1:N or M:N, and whether the child's existence depends on the parent. This is what decides nesting versus a top-level collection with a filter.

## 3. Theory & Principles

### Finding the resources

A repeatable procedure that works in a design round:

1. **Write the domain in sentences.** "A *customer* places an *order*. An order contains *line items*. An order is paid by a *payment*. A *shipment* fulfils some or all of an order. An order can be *cancelled* or *refunded*."
2. **Underline the nouns.** Those are candidate resources: customer, order, line item, payment, shipment, cancellation, refund.
3. **Underline the verbs.** For each, ask whether it is (a) a plain create/update of a noun, (b) a state transition, or (c) a genuinely new noun. "Place an order" is `POST /orders`. "Cancel" produces a cancellation with a reason and a timestamp — a noun. "Ship" produces a shipment — a noun.
4. **Decide cardinality and dependency.** Can a line item exist without its order? No — nest it. Can a payment exist independently and be listed across orders? Yes — make it top-level with an `order_id`.
5. **Decide addressability.** Does any client ever need to reference this thing on its own, link to it, cache it, or check its status? If yes it needs a URI. If it is only ever read as part of its parent, it can stay an embedded object.
6. **Check the state machine.** For each resource, list its states and which transitions are legal from each. This is where your `409 Conflict` responses come from, and it is the question interviewers use to separate levels.

### Nesting: the depth rule

Nest only when the parent is required to *identify* the child, and stop at **two id segments** (`/parents/{id}/children/{id}` at the very worst; prefer `/parents/{id}/children` plus a top-level `/children/{id}`). Deep nesting like `/customers/9/orders/4/items/7/discounts/2` is a trap: it hard-codes a traversal path that changes when the domain does, it multiplies the number of URIs for one thing, and it forces the client to know the whole ancestry to fetch a leaf.

The practical rule: **nest for containment, filter for association.** `/orders/{id}/items` (containment — items have no life outside the order). `/payments?order_id={id}` (association — payments are independent entities that happen to reference an order).

### Naming rules that survive review

- **Plural nouns for collections** (`/orders`, not `/order` or `/orderList`) — one convention, applied everywhere, beats a "better" convention applied inconsistently.
- **`kebab-case` in paths**, `snake_case` or `camelCase` in JSON bodies — pick one for each layer and never mix. `/payment-methods`, `{"payment_method_id": "..."}`.
- **Lowercase always** (paths are case-sensitive per RFC 3986), **no file extensions** (`/orders/9.json` — use `Accept` instead), and **no trailing slash**, enforced with a `301` to the canonical form.
- **No verbs in paths**, with the single principled exception of process resources, which are nouns derived from verbs (`/cancellation`, not `/cancel`).
- **No internal jargon or system names.** `/orders`, not `/oms-order-svc-v2/ords`.
- **Version in the path prefix** (`/v1/...`) for public APIs: it is unambiguous, visible in logs, easy to route on. Header-based versioning is more theoretically pure and much harder to debug.

```svg
<svg viewBox="0 0 820 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="g1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="g2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Nest for containment, filter for association</text>
  <g stroke-width="2">
    <rect x="30" y="48" width="360" height="290" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="430" y="48" width="360" height="290" rx="10" fill="#fef3c7" stroke="#d97706"/>
  </g>
  <text x="210" y="72" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">Good: shallow, meaningful</text>
  <text x="610" y="72" text-anchor="middle" fill="#b45309" font-size="13" font-weight="bold">Bad: deep, brittle</text>
  <g fill="#1e293b" font-size="12">
    <text x="48" y="102">GET  /v1/orders?customer_id=cus_4K</text>
    <text x="48" y="126">GET  /v1/orders/ord_9F2</text>
    <text x="48" y="150">GET  /v1/orders/ord_9F2/items</text>
    <text x="48" y="174">POST /v1/orders/ord_9F2/cancellation</text>
    <text x="48" y="198">GET  /v1/payments?order_id=ord_9F2</text>
    <text x="48" y="222">GET  /v1/shipments/shp_11</text>
    <text x="48" y="246">GET  /v1/users/usr_9/preferences</text>

    <text x="448" y="102">GET  /v1/customers/9/orders/4/items/7</text>
    <text x="448" y="126">POST /v1/orders/getByCustomer</text>
    <text x="448" y="150">POST /v1/order/4/setStatus</text>
    <text x="448" y="174">GET  /v1/OrderList.json?del=false</text>
    <text x="448" y="198">GET  /v1/oms-svc/ords/4/</text>
    <text x="448" y="222">DELETE /v1/orders/deleteAll</text>
    <text x="448" y="246">GET  /v1/orders  (unbounded)</text>
  </g>
  <g fill="#15803d" font-size="11">
    <text x="48" y="276">&#8226; two segments max &#183; plural nouns &#183; opaque ids</text>
    <text x="48" y="296">&#8226; verbs become process resources</text>
    <text x="48" y="316">&#8226; associations are query filters, not paths</text>
  </g>
  <g fill="#b45309" font-size="11">
    <text x="448" y="276">&#8226; 4 levels &#8594; whole ancestry required</text>
    <text x="448" y="296">&#8226; verbs in path &#183; POST used for reads</text>
    <text x="448" y="316">&#8226; extensions, casing, trailing slash, no paging</text>
  </g>
</svg>
```

### Query-string conventions

Reserve a small, consistent vocabulary and use it identically on every collection: `?limit=` and `?cursor=` for pagination, `?sort=-created_at` for ordering (leading `-` = descending), `?fields=id,status,total` for sparse fieldsets, `?expand=customer,items` for embedding related resources, and plain field names for filtering (`?status=shipped&created_after=2026-07-01`). Bound everything: a default `limit` of 25 and a hard maximum of 100, a maximum `expand` depth of one, and an allow-list of sortable fields (an arbitrary `sort` is an index-less table scan waiting to happen).

## 4. Architecture & Workflow

The workflow of an actual design session, applied to a **food-delivery platform** — the exact exercise a design round asks for:

1. **Elicit the domain sentences.** "A *customer* browses *restaurants*, each with a *menu* of *menu items*. The customer builds a *cart*, then places an *order*. A *courier* is assigned and creates a *delivery*. The customer may *cancel* before pickup, *rate* the order afterwards, and request a *refund*."
2. **Extract candidate nouns.** customer, restaurant, menu, menu item, cart, cart item, order, order item, courier, delivery, cancellation, rating, refund, payment, address.
3. **Classify each.** *Top-level collections*: customers, restaurants, orders, couriers, deliveries, payments, refunds. *Nested collections*: `restaurants/{id}/menu-items`, `orders/{id}/items`, `customers/{id}/addresses`. *Singletons*: `customers/{id}/cart`, `orders/{id}/rating`. *Process resources*: `orders/{id}/cancellation`, `orders/{id}/refunds`.
4. **Resolve the ambiguous ones out loud.** Is `menu` a resource or an attribute? If a restaurant has one implicit menu, drop it and expose `restaurants/{id}/menu-items`; if restaurants have breakfast/lunch menus with their own hours, `menus` is a real resource. This "is it a noun or an adjective" judgement is exactly what the interviewer is probing.
5. **Assign methods and status codes per resource.** For `orders`: `GET /v1/orders` (list, filtered by the caller's identity — never by a client-supplied `customer_id`), `POST /v1/orders` → `201` + `Location`, `GET /v1/orders/{id}` → `200`/`404`, `PATCH /v1/orders/{id}` → `200`/`409`/`412`, and no `DELETE` (orders are cancelled, not deleted — soft state, audit trail).
6. **Draw the state machine.** `created → confirmed → preparing → picked_up → delivered`, plus `cancelled` reachable only from the first three. Every illegal transition is a `409 Conflict` with a problem type.
7. **Pin the identifiers.** Opaque, prefixed, sortable: `cus_`, `rst_`, `ord_`, `crr_`, `dlv_` + a ULID. Never expose auto-increment integers.
8. **Define the collection contract once.** Cursor pagination, a fixed `?sort=` allow-list, filters per resource, sparse fieldsets, and one `expand` level — documented centrally, implemented identically everywhere.
9. **Write the URI table and review it before any code.** If the table has verbs, four-level nesting, or two ways to reach the same resource, fix it now — after launch it is a versioned migration.

```svg
<svg viewBox="0 0 820 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="h1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="h2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Food delivery: resource map and the order state machine</text>
  <g stroke-width="2">
    <rect x="20" y="44" width="150" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="20" y="106" width="150" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="20" y="168" width="150" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="220" y="106" width="160" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="220" y="44" width="160" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="220" y="168" width="160" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  </g>
  <g fill="#1e293b" font-size="11">
    <text x="32" y="64">/v1/customers</text><text x="32" y="80" fill="#475569">/{id}/addresses (nested)</text>
    <text x="32" y="126">/v1/restaurants</text><text x="32" y="142" fill="#475569">/{id}/menu-items (nested)</text>
    <text x="32" y="188">/v1/couriers</text><text x="32" y="204" fill="#475569">/{id}/location (singleton)</text>
    <text x="232" y="64">/v1/customers/{id}/cart</text><text x="232" y="80" fill="#475569">singleton, PUT/PATCH</text>
    <text x="232" y="126">/v1/orders</text><text x="232" y="142" fill="#475569">/{id}/items, /{id}/rating</text>
    <text x="232" y="188">/v1/deliveries, /v1/payments</text><text x="232" y="204" fill="#475569">?order_id= (association)</text>
  </g>
  <g stroke="#4f46e5" stroke-width="2" marker-end="url(#h1)">
    <line x1="172" y1="66" x2="216" y2="66"/><line x1="382" y1="70" x2="410" y2="110"/>
    <line x1="172" y1="128" x2="216" y2="128"/><line x1="382" y1="140" x2="410" y2="150"/>
  </g>
  <g stroke-width="2">
    <rect x="440" y="44" width="110" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="590" y="44" width="110" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="590" y="112" width="110" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="590" y="180" width="110" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="440" y="180" width="110" height="40" rx="8" fill="#fef3c7" stroke="#d97706"/>
  </g>
  <g text-anchor="middle" fill="#1e293b" font-size="11">
    <text x="495" y="69">created</text><text x="645" y="69">confirmed</text>
    <text x="645" y="137">preparing</text><text x="645" y="205">picked_up</text>
    <text x="495" y="199">cancelled</text>
  </g>
  <g stroke="#16a34a" stroke-width="2" marker-end="url(#h1)">
    <line x1="552" y1="64" x2="586" y2="64"/><line x1="645" y1="86" x2="645" y2="108"/>
    <line x1="645" y1="154" x2="645" y2="176"/>
  </g>
  <g stroke="#d97706" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#h2)">
    <line x1="490" y1="86" x2="490" y2="176"/><line x1="588" y1="132" x2="554" y2="188"/>
  </g>
  <rect x="20" y="244" width="780" height="122" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="34" y="266" fill="#1e293b" font-size="12" font-weight="bold">Transitions map directly onto responses</text>
  <g fill="#1e293b" font-size="11">
    <text x="34" y="288">POST /v1/orders                    &#8594; 201 Created + Location: /v1/orders/ord_9F2</text>
    <text x="34" y="308">POST /v1/orders/ord_9F2/cancellation (state=preparing)  &#8594; 201 Created</text>
    <text x="34" y="328">POST /v1/orders/ord_9F2/cancellation (state=picked_up)  &#8594; 409 Conflict + problem+json</text>
    <text x="34" y="348">PATCH /v1/orders/ord_9F2 with stale If-Match            &#8594; 412 Precondition Failed</text>
  </g>
</svg>
```

## 5. Implementation

### The worked model: a food-delivery API, complete

| Method + URI | Purpose | Success | Notable failures |
|---|---|---|---|
| `GET /v1/restaurants?near=18.52,73.85&radius_km=5&cursor=` | Discover restaurants | `200` | `400` bad geo, `422` radius too large |
| `GET /v1/restaurants/{rid}` | One restaurant | `200` | `404` |
| `GET /v1/restaurants/{rid}/menu-items?available=true` | Nested: menu belongs to restaurant | `200` | `404` restaurant |
| `GET /v1/customers/{cid}/cart` | Singleton cart | `200` | `403` not your cart |
| `PUT /v1/customers/{cid}/cart` | Full replace (idempotent) | `200` | `409` restaurant changed, `412` stale `If-Match` |
| `POST /v1/orders` | Place an order | `201` + `Location` | `409` cart empty/changed, `422` out of delivery zone |
| `GET /v1/orders?status=delivered&sort=-created_at&limit=25` | List *my* orders | `200` | `400` unknown sort field |
| `GET /v1/orders/{oid}` | One order | `200` + `ETag` | `404`, `403` |
| `PATCH /v1/orders/{oid}` | Change delivery note/address | `200` | `409` illegal for state, `412`/`428` precondition |
| `GET /v1/orders/{oid}/items` | Nested line items | `200` | `404` |
| `POST /v1/orders/{oid}/cancellation` | Process resource | `201` | `409` already picked up |
| `PUT /v1/orders/{oid}/rating` | Singleton, idempotent | `200`/`201` | `409` not delivered yet |
| `POST /v1/orders/{oid}/refunds` | Sub-collection of a process | `201`/`202` | `409` not refundable, `422` amount exceeds total |
| `GET /v1/deliveries?order_id={oid}` | Association via filter, not nesting | `200` | `400` missing filter |
| `POST /v1/couriers/{crid}/location` | High-frequency telemetry | `202` | `403` |

Note what is *absent*: no `DELETE /v1/orders/{id}` (orders are cancelled and retained for audit), no `/customers/{cid}/orders/{oid}/items/{iid}` (three levels — the item is reachable at two), and no `POST /v1/searchOrders`.

### Representations

```http
GET /v1/orders/ord_9F2xQ HTTP/1.1
Accept: application/json
Authorization: Bearer ...

HTTP/1.1 200 OK
Content-Type: application/json
ETag: W/"ord-9F2-v4"
Cache-Control: private, no-cache

{
  "id": "ord_9F2xQ", "object": "order", "status": "preparing",
  "restaurant_id": "rst_88Kd", "customer_id": "cus_4Kd82",
  "currency": "inr", "amount_total": 74500,
  "delivery_address": { "line1": "12 Baner Rd", "city": "Pune", "pincode": "411045" },
  "placed_at": "2026-07-22T09:14:03Z",
  "links": {
    "self":         "/v1/orders/ord_9F2xQ",
    "items":        "/v1/orders/ord_9F2xQ/items",
    "cancellation": "/v1/orders/ord_9F2xQ/cancellation",
    "delivery":     "/v1/deliveries?order_id=ord_9F2xQ"
  }
}
```

A collection response — note the envelope is consistent across every collection in the API:

```http
GET /v1/orders?status=delivered&sort=-placed_at&limit=2 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

{
  "object": "list",
  "data": [ { "id": "ord_9F2xQ", "status": "delivered", "amount_total": 74500 },
            { "id": "ord_7Bc1m", "status": "delivered", "amount_total": 32000 } ],
  "has_more": true,
  "next_cursor": "eyJwbGFjZWRfYXQiOiIyMDI2LTA3LTIwVDExOjAyWiIsImlkIjoib3JkXzdCYzFtIn0"
}
```

### Routing the model (FastAPI)

```python
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from typing import Literal

orders = APIRouter(prefix="/v1/orders", tags=["orders"])

SORTABLE = {"placed_at", "amount_total"}          # allow-list: never sort on arbitrary input
LEGAL_CANCEL_FROM = {"created", "confirmed", "preparing"}

@orders.get("")
def list_orders(
    caller=Depends(current_user),                 # scope by identity, NOT a query param
    status_: Literal["created","confirmed","preparing","picked_up","delivered","cancelled"]
             | None = Query(None, alias="status"),
    sort: str = Query("-placed_at"),
    limit: int = Query(25, ge=1, le=100),         # default AND hard maximum
    cursor: str | None = None,
):
    field = sort.lstrip("-")
    if field not in SORTABLE:
        raise HTTPException(400, f"Cannot sort by '{field}'")
    rows, nxt = repo.page(customer_id=caller.id, status=status_,
                          sort=sort, limit=limit, cursor=cursor)
    return {"object": "list", "data": rows, "has_more": nxt is not None, "next_cursor": nxt}

@orders.get("/{oid}")
def get_order(oid: str, caller=Depends(current_user)):
    order = repo.get(oid) or _404()
    if order["customer_id"] != caller.id:         # object-level authz: OWASP API1 (BOLA)
        raise HTTPException(404, "No such order")  # 404, not 403 — do not confirm existence
    return order

# Process resource: the verb "cancel" becomes the noun "cancellation".
@orders.post("/{oid}/cancellation", status_code=status.HTTP_201_CREATED)
def cancel_order(oid: str, body: CancellationCreate, response: Response,
                 caller=Depends(current_user)):
    order = repo.get_owned(oid, caller.id) or _404()
    if order["status"] not in LEGAL_CANCEL_FROM:
        raise HTTPException(409, f"Cannot cancel an order that is {order['status']}")
    c = repo.create_cancellation(oid, reason=body.reason)
    response.headers["Location"] = f"/v1/orders/{oid}/cancellation"
    return c                                       # has its own id, timestamp, reason, status

def _404():
    raise HTTPException(404, "No such order")
```

### Describing it (OpenAPI 3.1)

```yaml
paths:
  /v1/orders/{oid}/cancellation:
    post:
      summary: Cancel an order
      operationId: cancelOrder
      parameters: [ { name: oid, in: path, required: true, schema: { type: string } } ]
      responses:
        "201": { description: Cancellation recorded }
        "409":
          description: Order is no longer cancellable
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
  /v1/deliveries:
    get:
      summary: List deliveries, filtered by association (not nested under orders)
      parameters:
        - { name: order_id, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, default: 25, maximum: 100 } }
      responses: { "200": { description: A page of deliveries } }
```

> **Optimization note.** URI design has direct performance consequences. **(1)** Shallow paths mean fewer joins to authorize and resolve — `/orders/{id}` needs one lookup; `/customers/{cid}/orders/{oid}/items/{iid}` needs four, each of which must be ownership-checked. **(2)** Route templates must be low-cardinality for metrics and caching — measure `/v1/orders/{id}`, never the interpolated path. **(3)** Every filterable and sortable field must be backed by an index; an allow-list is a performance control, not just a security one. **(4)** Prefer `?expand=items` over forcing three round trips, but cap expansion depth at one level, because unbounded expansion is how a single request becomes a full graph traversal.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Domain-modelled resources** | Survive database and service refactors; readable to consumers; endpoints and status codes become obvious | Requires real domain analysis up front, and disagreement about the right nouns is genuine design work |
| **Shallow URIs (≤2 levels)** | Fewer URIs per concept, simpler caching, cheaper authorization, easier to evolve | Relationships must be expressed as filters, which is slightly less self-evident from the path alone |
| **Nesting for containment** | Communicates ownership and scoping; natural for parent-scoped listing | If ownership later changes (items become shareable), the URI is wrong and you need a migration |
| **Process resources for actions** | Gives verbs an identity, a status, a history and idempotency; keeps the uniform interface intact | Feels unnatural at first; adds resources some consider ceremony |
| **Opaque prefixed ids** | No enumeration, no volume leakage, storage-independent, self-describing in logs | Cannot be range-scanned or sorted by clients; needs a generation strategy (ULID/UUIDv7 if you want time ordering) |
| **Plural + kebab-case convention** | Predictability lets developers guess correctly; consistency beats cleverness | Some domains have awkward plurals (`/people`, `/feedback`); pick and document, do not debate per endpoint |
| **Consistent collection contract** | One pagination/filter/sort/expand vocabulary means a client learns it once | Every endpoint must implement all of it, including bounds and allow-lists |
| **Version prefix in path** | Unambiguous, visible in logs and dashboards, trivially routable | Technically means the "same" resource has multiple URIs; header-based versioning is purer but far harder to operate |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Verbs in URIs** — `/getOrders`, `/orders/9/cancel`, `/updateUserStatus`. ✅ Nouns identify, methods act. When a verb is unavoidable, reify it: `POST /orders/9/cancellation` — now it has an id, a timestamp, a reason and a retrievable status.
2. ⚠️ **Deep nesting** — `/customers/9/orders/4/items/7/discounts/2`. ✅ Two id segments maximum; nest for containment, filter for association (`/payments?order_id=...`).
3. ⚠️ **Exposing database ids and structure.** Sequential integers leak volume and invite enumeration; table names pin your schema into the contract. ✅ Opaque prefixed ids (`ord_` + ULID) and a deliberate mapping between storage and representation.
4. ⚠️ **Scoping a collection by a client-supplied owner id** — `GET /orders?customer_id=X`. Any caller can substitute any X; this is **BOLA**, OWASP API #1. ✅ Scope by the authenticated identity server-side; treat any owner filter as an additional narrowing, never as the authorization.
5. ⚠️ **Unbounded collections.** `GET /orders` returning everything is a latent outage. ✅ Default `limit=25`, hard max `100`, cursor pagination, and a `has_more` flag from the first release.
6. ⚠️ **Arbitrary `sort` and filter fields.** An un-indexed sort is a full table scan a client can trigger at will. ✅ Allow-list sortable and filterable fields, and require an index for each.
7. ⚠️ **Inconsistent naming across endpoints** — `/orders` but `/customerAddresses`, `created_at` here and `createdOn` there. ✅ One casing rule per layer, one pluralisation rule, enforced by a linter (Spectral) in CI.
8. ⚠️ **Two URIs for the same resource** with no canonical form. Caches fragment, `ETag`s diverge, clients disagree. ✅ Pick a canonical URI, expose it as `self` in every representation, and `301` the aliases.
9. ⚠️ **Modelling the UI instead of the domain** — `/dashboard-summary`, `/mobile-home-screen`. These die with the next redesign. ✅ Model the domain and, if a screen genuinely needs an aggregate, build it in a clearly-labelled BFF layer, not in the core API.
10. ⚠️ **Using `PUT` for partial updates.** `PUT` is full replacement, so omitted fields must be cleared — a subtle data-loss bug. ✅ `PATCH` with `application/merge-patch+json` for partial change; keep `PUT` for genuine idempotent replacement (a cart, a rating, a preference document).
11. ⚠️ **`DELETE` on things that need an audit trail.** ✅ Model the negation as a resource (`cancellation`, `deactivation`, `archival`) so you keep the reason, actor and timestamp; reserve `DELETE` for genuinely disposable resources.
12. ⚠️ **Breaking URIs to "clean them up".** A rename is an outage in someone else's system. ✅ Additive change only; if you must move, serve both, emit `Deprecation` and `Sunset` (RFC 8594) headers, `301` where semantics allow, and measure old-path traffic to zero before removing.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

Most "weird API bug" reports trace to routing ambiguity: two templates matching one path (`/orders/summary` vs `/orders/{id}`), trailing-slash mismatches, or URL-encoding of ids containing `/` or `%`. Log the **matched route template** alongside the raw path so you can see which handler actually ran. Reserve non-id path segments deliberately — put special reads under a distinct prefix (`/orders/search`) only if you are certain no id can ever collide, or better, use a query parameter instead. Test with ids containing every reserved character.

### Monitoring

Emit every metric keyed on the **route template**, never the interpolated URI — `/v1/orders/{id}` gives you one time series; `/v1/orders/ord_9F2` gives you millions and will take down your metrics backend. Track per-endpoint traffic to find dead endpoints you can deprecate and hot endpoints that deserve caching or an aggregate. Watch `404` rates per template (a spike means a client is constructing URIs wrongly, often after a docs change), `405` rates (someone is using the wrong method — often a sign your naming misleads), and the distribution of `limit` values requested, which tells you whether your default is right.

### Security

Every path parameter is untrusted input and every one needs an **object-level authorization** check against the authenticated principal — this is OWASP API1 (BOLA) and it is the most common serious API vulnerability in the wild. For resources the caller may not access, prefer `404` over `403` so you do not confirm existence. Never let a client choose the tenant or owner scope through a query parameter. Guard against **mass assignment** by allow-listing writable fields per resource rather than binding the whole body. Validate id format strictly (a prefixed ULID pattern) so injection attempts fail at the router. Bound path length, segment count and query-parameter count at the edge.

### Performance & scaling

Shallow URIs reduce per-request authorization work and make caching simpler. Give every read endpoint an explicit cache classification: public-cacheable (a restaurant's menu), private-cacheable (a customer's own order), or `no-store` (payment details). Collections almost always need cursor pagination — `OFFSET` degrades linearly and is unstable under concurrent writes. Index every allow-listed filter and sort combination, and load-test the worst legal query a client can construct, not the average one. For high-frequency writes like courier telemetry, model a dedicated resource that returns `202 Accepted` and buffers asynchronously, so it never shares a code path or a connection pool with order placement.

## 9. Interview Questions

**Q: How do you decide what the resources are in a new API?**
A: Write the domain out in plain sentences, extract the nouns as candidate resources and the verbs as candidate transitions, then classify each noun by cardinality, ownership and addressability. A noun becomes a resource if any client needs to reference, link to, cache or check the status of it independently; otherwise it stays an embedded field. Verbs that carry their own data — a reason, a timestamp, a status — become process resources.

**Q: When should a resource be nested versus top-level?**
A: Nest when the parent is required to identify the child or the child cannot exist without it — line items inside an order, menu items inside a restaurant. Keep it top-level when the entity has an independent identity and lifecycle and might be listed across parents — payments, shipments, deliveries — and express the relationship with a query filter like `?order_id=`. The rule of thumb is nest for containment, filter for association, and never exceed two id segments.

**Q: How do you model an action like "cancel an order" or "send an invoice"?**
A: Reify the verb as a noun: `POST /orders/{id}/cancellation`, `POST /invoices/{id}/deliveries`. That gives the action an identity, a stored reason, a timestamp, a retrievable status and a natural place for idempotency, and it keeps the uniform interface intact. It also gives you the right failure vocabulary — `409 Conflict` when the current state forbids the transition.

**Q: Path parameter or query parameter?**
A: The path identifies the resource; the query string filters, sorts, paginates or shapes the representation of a collection. `GET /orders/ord_9F2` identifies one order; `GET /orders?status=shipped&limit=25` selects a subset of a collection. If removing the parameter still leaves a meaningful resource, it belongs in the query string.

**Q: Why use opaque identifiers instead of database ids?**
A: Sequential integers leak business volume, enable enumeration attacks, and couple the public contract to the storage engine — you cannot shard or migrate without changing every URI. Opaque prefixed ids like `ord_01HQ...` are self-describing in logs, safe to expose, and free you to change storage; using ULID or UUIDv7 keeps them time-sortable for your own indexing.

**Q: Should collection names be singular or plural?**
A: Plural, consistently: `/orders`, `/orders/{id}`. The specific choice matters much less than applying it uniformly — an API where developers can correctly guess the next endpoint is worth more than one that is theoretically elegant in places. Document the rule and enforce it with a linter in CI.

**Q: How do you version URIs, and when do you have to?**
A: Put a major version in the path prefix (`/v1/`) for public APIs — it is unambiguous, visible in logs and trivial to route. You only need a new version for breaking changes: removing or renaming a field, changing a type, tightening validation, or changing the meaning of an existing field. Additions are safe if clients are tolerant readers, so most changes should never require a version bump.

**Q: A `GET /orders` returns 40,000 rows. What is wrong and how do you fix it?**
A: The collection is unbounded, which is a latency and availability problem and often an authorization problem too. The fix is a server-enforced default and maximum page size, cursor-based pagination with a stable sort key, a documented `has_more`/`next_cursor` contract, and scoping by the authenticated identity rather than by a client-supplied owner filter.

**Q: (Senior) Design the resource model for a ride-hailing API. Walk me through your reasoning.**
A: Nouns first: riders, drivers, vehicles, ride requests, rides, trips, fare estimates, payments, ratings. I would make `ride-requests` a resource distinct from `rides` because the request has its own lifecycle (searching, matched, expired) and can fail without a ride existing — that separation is what lets you retry matching idempotently. `POST /v1/ride-requests` returns `202 Accepted` with a status URI because matching is asynchronous; `GET /v1/rides/{id}` exposes the resulting ride with a state machine `matched → arriving → in_progress → completed`, with `POST /v1/rides/{id}/cancellation` as a process resource that returns `409` once the trip is in progress. Driver location is high-frequency telemetry, so `POST /v1/drivers/{id}/location` returns `202` and is isolated on its own path with its own capacity; fare estimates are `POST /v1/fare-estimates` — a `POST` because the input is a complex body, and I would document explicitly that it is non-idempotent and uncacheable.

**Q: (Senior) You inherit an API with `/customers/{cid}/orders/{oid}/items/{iid}`. How do you fix it without breaking clients?**
A: First measure who calls it, per path and per consumer. Then introduce the shallower canonical forms — `/orders/{oid}` and `/orders/{oid}/items` — as the resources whose `self` link every representation now advertises, and make the deep path a thin alias implemented in terms of the new handlers so there is exactly one authorization and business path. Emit `Deprecation` and `Sunset` headers on the old path, document the mapping, migrate consumers by name, watch the old traffic drop to zero, and only then remove it. Renaming or removing first would be an outage in someone else's system.

**Q: (Senior) How do you decide whether something is a resource or just a field?**
A: Ask whether it has independent identity, an independent lifecycle, or independent access control. A delivery address on an order that is a frozen snapshot is a field; a customer's saved address book that can be listed, reused and deleted is a resource. Also ask whether anyone needs to link to it, cache it separately, or check its status — if yes, it needs a URI. The failure mode in both directions is real: promoting everything to a resource produces a chatty API, and demoting a real entity to a field forces clients to re-fetch the parent to change one thing.

**Q: (Senior) What happens to your URI design when the domain's ownership model changes?**
A: This is exactly why nesting is a commitment. If items become shareable across orders, or projects move between organisations, the nested path is now a lie — the URI asserts an ownership that no longer holds, and every cached copy and stored link encodes it. The mitigation is to nest only where ownership is genuinely immutable (a line item will never belong to a different order), and to prefer top-level resources with association filters wherever ownership is plausibly mutable. When it does happen, the migration is: introduce the top-level canonical URI, dual-serve, redirect with `301` where semantics allow, and deprecate the nested form on a published schedule.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Model the **domain**, not the database or the UI. Extract nouns from domain sentences; each becomes a collection (`/orders`) with document members (`/orders/{id}`). Nest only for containment (`/orders/{id}/items`) and never past two id segments; express associations with query filters (`/payments?order_id=`). Reify verbs as **process resources** (`POST /orders/{id}/cancellation`) so actions get identity, status and correct `409` semantics. Use singletons for one-per-parent concepts (`/users/{id}/preferences`). Path identifies; query filters, sorts, paginates and shapes. Names are lowercase, plural, kebab-case, no verbs, no extensions, no trailing slash, version prefix `/v1`. Ids are opaque and prefixed. Every collection gets a default and maximum page size, cursor pagination, and allow-listed sort and filter fields — which are security and performance controls at once. Every path id gets an object-level authorization check. And remember the constraint that governs everything: **URIs are forever**, so design the table before you write the handlers.

| Pattern | URI | Methods |
|---|---|---|
| Collection | `/v1/orders` | `GET` (paged), `POST` → `201` + `Location` |
| Document | `/v1/orders/{id}` | `GET`, `PATCH`, `PUT`, `DELETE` |
| Nested collection (containment) | `/v1/orders/{id}/items` | `GET`, `POST` |
| Association (not nesting) | `/v1/payments?order_id={id}` | `GET` |
| Singleton | `/v1/users/{id}/preferences` | `GET`, `PUT`, `PATCH` |
| Process resource (a verb) | `POST /v1/orders/{id}/cancellation` | `POST` → `201`/`202`, `409` if illegal |
| Filter / sort / page | `?status=shipped&sort=-placed_at&limit=25&cursor=…` | allow-listed + bounded |
| Sparse fields / embedding | `?fields=id,status` · `?expand=items` | one level of expansion max |
| Naming | lowercase, plural, `kebab-case`, no verbs, no `.json`, no trailing slash | — |
| Identifiers | `ord_01HQ…` (prefix + ULID), opaque to clients | — |
| Version | `/v1/` path prefix, major only | — |
| Illegal state transition | — | `409 Conflict` + `application/problem+json` |

**Flash cards**
- **Nest or filter?** → Nest for containment (child cannot exist alone); filter for association (`?order_id=`). Two id segments maximum.
- **How do you model "cancel"?** → As a noun: `POST /orders/{id}/cancellation` → `201`, or `409` when the state forbids it.
- **Path vs query** → Path identifies the resource; query filters, sorts, paginates and shapes the representation.
- **Why opaque ids?** → No enumeration, no volume leakage, and freedom to change storage without changing URIs.
- **The one rule that governs URI design** → URIs are forever: additive change only, `Deprecation` + `Sunset` before removal.

## 11. Hands-On Exercises & Mini Project

- [ ] Take an API you maintain and write out every endpoint in a table. Mark each as collection, document, nested, singleton or process resource — then flag every verb-in-path, every path deeper than two ids, and every duplicate route to one concept.
- [ ] For one resource, write the full state machine and map each illegal transition to a status code and a problem `type` URI.
- [ ] Convert one action endpoint (`POST /orders/cancel`) into a process resource with its own id, reason and timestamp, and write the `409` response body.
- [ ] Add a Spectral ruleset to CI enforcing plural kebab-case paths, no verbs, a maximum of two path ids, and a required `limit`/`cursor` on every collection. Run it against your existing spec and count the violations.

### Mini Project — "Design Round: Food Delivery API"

**Goal.** Produce, in 60 minutes, the artefact a design round actually asks for: a defensible resource model with URIs, methods, status codes and a state machine — then implement enough to prove it.

**Requirements.**
1. Write the domain in sentences, extract nouns and verbs, and produce a resource table with columns: URI, pattern type, methods, success codes, failure codes, auth scope.
2. Justify every nesting decision in one line ("items cannot exist without an order") and every non-nesting decision ("deliveries are listed independently by ops").
3. Model at least two process resources (`cancellation`, `refunds`) and one singleton (`cart` or `rating`), with their legal source states.
4. Define the collection contract once — pagination, sorting allow-list, filters, sparse fields, expansion — and apply it identically to every collection.
5. Implement `orders` and `cancellation` in FastAPI with object-level authorization, cursor pagination, `ETag` + `If-Match` on update, and `application/problem+json` errors.
6. Publish an OpenAPI 3.1 document and lint it in CI with the ruleset from the exercises.

**Extensions.**
- Add multi-tenancy (a restaurant-partner portal) and decide whether tenancy belongs in the path, a header or the token — write down the trade-offs for each.
- Write contract tests that fail the build if any route template exceeds two path ids or any collection lacks a maximum `limit`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is REST? Constraints & Maturity* (why resources and the uniform interface exist), *HTTP Methods, Safety & Idempotency* (what each method promises about the resources you just modelled), *HTTP Fundamentals for API Builders* (status codes, `ETag`, conditional requests), *What Is an API? Web APIs & Clients* (the contract mindset), *REST vs GraphQL, gRPC & SOAP* (when resource modelling is the wrong tool entirely).

- **Google API Design Guide — Resource-Oriented Design** — Google · *Intermediate* · the most rigorous free treatment of resource hierarchies, standard methods and when a custom method is justified; read the "Resource Names" and "Custom Methods" pages twice. <https://cloud.google.com/apis/design/resources>
- **Zalando RESTful API Guidelines** — Zalando · *Intermediate* · hundreds of numbered MUST/SHOULD rules on naming, pluralisation, nesting depth, pagination and identifiers, drawn from running a very large API estate. <https://opensource.zalando.com/restful-api-guidelines/>
- **Microsoft REST API Guidelines** — Microsoft · *Intermediate* · strong, concrete material on collection URLs, filtering and sorting syntax, long-running operations and naming consistency. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **Cool URIs don't change** — Tim Berners-Lee, W3C · *Beginner* · the short essay that explains why URI design is a permanent commitment; still the best argument against "we'll clean it up later". <https://www.w3.org/Provider/Style/URI>
- **RFC 3986 — Uniform Resource Identifier: Generic Syntax** — IETF · *Advanced* · the normative rules for path, query, reserved characters, percent-encoding and case sensitivity; settles most encoding arguments. <https://www.rfc-editor.org/rfc/rfc3986>
- **Stripe API Reference** — Stripe · *Beginner* · the best available worked example of flat resources, opaque prefixed ids, expansion (`?expand=`) and consistent list envelopes across a very large surface. <https://docs.stripe.com/api>
- **GitHub REST API — Endpoints** — GitHub · *Beginner* · the counterpoint to Stripe: meaningful hierarchy (`/repos/{owner}/{repo}/issues`) where the parent genuinely identifies the child, with `Link`-header pagination. <https://docs.github.com/en/rest>
- **Spectral — API style guide linter** — Stoplight (open source) · *Intermediate* · lets you encode your naming, nesting and pagination rules as CI checks so the design survives contact with twenty contributors. <https://docs.stoplight.io/docs/spectral/674b27b261c3c-overview>

---

*REST API Handbook — chapter 05.*
