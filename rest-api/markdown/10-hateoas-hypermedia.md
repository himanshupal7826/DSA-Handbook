# 10 · HATEOAS & Hypermedia APIs

> **In one line:** HATEOAS makes the server, not the client, the authority on what a client can do next — the constraint that separates "REST" from "JSON over HTTP", and the one almost nobody implements.

---

## 1. Overview

**HATEOAS** — Hypermedia As The Engine Of Application State — is the constraint that a client should navigate an API entirely through **links and forms supplied by the server**, starting from a single entry-point URI, exactly as a human navigates a website. The client knows one URL and a set of **link relation types** (`next`, `self`, `edit`, `payment`, `cancel`); it does not know, and must not construct, any other URL. Application state advances because the server hands the client the transitions that are currently legal.

The problem it solves is **client–server coupling**. In a typical JSON API the client hardcodes `/v1/orders/{id}/cancel`, plus the rule "only show the Cancel button when `status == 'pending' && payment_state != 'captured' && !is_disputed`". That business rule now lives in two places — your service and every client — and diverges the moment either changes. With HATEOAS, the server emits `"links": {"cancel": {"href": "/v1/orders/ord_1/cancel", "method": "POST"}}` only when cancellation is actually permitted for *this* order and *this* caller. The client renders a button for every link it recognises. The rule lives in exactly one place, and the URL layout becomes an implementation detail the server can change freely.

This is not a nice-to-have in Fielding's formulation — it is *the* defining constraint. His 2008 blog post, "REST APIs must be hypertext-driven", is unusually blunt: an API that requires out-of-band knowledge of its URI structure "is not RESTful and cannot be REST". Leonard Richardson's Maturity Model formalised the ladder: **Level 0** a single URI tunnelling RPC; **Level 1** many resources; **Level 2** correct HTTP verbs and status codes; **Level 3** hypermedia controls. Virtually every API praised as "RESTful" in industry is Level 2.

**Concrete example.** The GitHub API is genuinely hypermedia-ish: fetch `https://api.github.com` and you get a document of ~30 URI templates (`"repository_url": "https://api.github.com/repos/{owner}/{repo}"`), and every paginated response carries an RFC 8288 `Link` header with `rel="next"`, `rel="prev"`, `rel="last"`. PayPal's REST API attaches a `links` array to every resource, with `rel` values like `self`, `approve`, `capture`, `refund` — driving the checkout flow. Amazon's own internal API guidance and the Netflix API both experimented with hypermedia and largely retreated from it. Stripe, the most-admired API in the industry, has essentially none: no `links`, no discoverability, just impeccable documentation and versioned SDKs. That contrast is the honest centre of this chapter.

The durable mental model: **HATEOAS moves the state machine from the client into the response.** It is unambiguously correct as architecture and unambiguously costly in practice. Understanding *why* it is right, and *why* most teams still skip it, is the actual interview question.

## 2. Core Concepts

- **Hypermedia control** — a link or form embedded in a representation that tells the client about a possible next request (URI, method, expected body).
- **Link relation type (`rel`)** — the *semantic name* of a link, which is the real contract: `self`, `next`, `edit`, `collection`, or an extension URI like `https://api.zariya.in/rels/refund`. Registered relations live in the IANA Link Relations registry.
- **Entry point (bookmark URI)** — the single URL a client is allowed to hardcode; everything else is discovered from it.
- **URI template (RFC 6570)** — a parameterised URI like `/repos/{owner}/{repo}` that a client expands locally; a partial concession to construction.
- **Richardson Maturity Model** — Level 0 (RPC over one URI) → Level 1 (resources) → Level 2 (verbs + status codes) → Level 3 (hypermedia controls).
- **HAL (Hypertext Application Language)** — a minimal hypermedia JSON format using `_links` and `_embedded`; media type `application/hal+json`.
- **JSON:API** — an opinionated spec with `data`/`links`/`relationships`/`included`; media type `application/vnd.api+json`.
- **Siren / Collection+JSON / Hydra** — richer formats that also describe **actions/forms** (method, fields, types), not just links.
- **Affordance** — what a control makes possible: a link affords navigation; a form affords a state-changing request with a described payload.
- **`Link` header (RFC 8288)** — hypermedia carried in the HTTP header rather than the body, so it works for any content type and for `HEAD` requests.

## 3. Theory & Principles

**Why Fielding considers this non-optional.** REST's constraints — client–server, stateless, cacheable, layered, uniform interface, optional code-on-demand — exist to buy *evolvability* at internet scale. The uniform interface has four sub-constraints, and the fourth is **"hypermedia as the engine of application state"**. Its purpose is to let servers change without coordinating with clients. If clients construct URIs from templates baked into their source, the server can never reorganise its URI space, never move a resource to another host, never introduce a new state without shipping client code. Hypermedia converts the URI space from a published contract into an internal detail.

**What actually becomes decoupled — and what doesn't.** The precise claim is narrower than enthusiasts suggest:

- **Decoupled:** URI structure, availability of transitions (which depends on state *and* on the caller's permissions), pagination mechanics, resource relocation and sharding.
- **Still coupled:** the media type, the link relation vocabulary, the field names inside representations, and the *meaning* of each relation. A client that doesn't know what `rel="refund"` means cannot use it.

So HATEOAS does not eliminate coupling; it **relocates coupling from URLs to relation names and media types**. That is a genuine improvement — relation names are stable, semantic, and versionable — but it is a trade, not a free lunch.

**The state machine argument.** A resource with a lifecycle is a finite state machine: an order goes `pending → paid → shipped → delivered`, with `cancel` legal only before `shipped` and `refund` only after `paid`. In a Level 2 API this FSM is duplicated in the server, the web client, the iOS client, the Android client and the partner integration — five copies that must be updated together. In a Level 3 API the server emits only the currently-legal transitions, and every client renders whatever it is given. **The number of places the business rule lives drops from N+1 to 1.** This is the single strongest practical argument for hypermedia, and it is stronger for *permission-dependent* transitions than for state-dependent ones, because permissions are exactly the thing clients get wrong.

**Why adoption failed anyway.** Six honest reasons:
1. **Clients are typed and generated.** Modern consumers are TypeScript/Kotlin/Swift SDKs generated from OpenAPI. A generated client wants a static method surface; consuming links at runtime defeats the type system.
2. **Discoverability costs round trips.** Strict "start at the root and follow links" navigation turns a one-request operation into three or four. HTTP/2 and caching soften this, but it is real on mobile networks.
3. **Payload bloat.** A `_links` block adds 20–40 % to small representations and, on a 100-item collection, can exceed the data itself.
4. **No universal client.** The web browser is a general hypermedia client because HTML forms describe everything needed. JSON has no such runtime; every API invents its own control format, so nothing generic can consume them.
5. **Documentation still wins.** In practice, developers read the docs, copy the URL, and ship. Excellent documentation plus stable versioned URLs delivers most of the practical benefit at a fraction of the cost.
6. **OpenAPI absorbed the ecosystem.** Tooling, mocking, codegen, linting and testing all crystallised around a *static* description of the API — the opposite philosophy — and network effects did the rest.

**The pragmatic middle ground.** Nearly every successful hypermedia adoption is partial, and three patterns carry most of the value for a fraction of the cost:
- **`Link` headers for pagination** (RFC 8288, `rel="next"`) — near-universal, costs nothing, and genuinely removes cursor-construction logic from clients.
- **State-dependent action links on stateful resources only** — emit `links.cancel` / `links.refund` on orders and payments, and skip links entirely on reference data.
- **A `self` link everywhere** — trivial to emit, and it makes any object in any payload independently addressable and re-fetchable.

```svg
<svg viewBox="0 0 770 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="750" height="340" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="385" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Richardson Maturity Model</text>
  <rect x="30" y="58" width="710" height="60" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="50" y="82" fill="#1e293b" font-size="13" font-weight="700">Level 0 &#183; the swamp of POX</text>
  <text x="50" y="104" fill="#1e293b" font-size="11">POST /api  {"op":"getOrder","id":7}  &#8212; one URI, one verb, RPC tunnelled over HTTP</text>
  <rect x="30" y="130" width="710" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="50" y="154" fill="#1e293b" font-size="13" font-weight="700">Level 1 &#183; resources</text>
  <text x="50" y="176" fill="#1e293b" font-size="11">POST /orders/7/cancel &#8212; many URIs, but still verbs in paths and 200-for-everything</text>
  <rect x="30" y="202" width="710" height="60" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="50" y="226" fill="#1e293b" font-size="13" font-weight="700">Level 2 &#183; HTTP verbs and status codes  (where ~95% of real APIs live)</text>
  <text x="50" y="248" fill="#1e293b" font-size="11">GET /orders/7 &#8594; 200 &#183; DELETE /orders/7 &#8594; 204 &#183; POST /orders &#8594; 201 + Location</text>
  <rect x="30" y="274" width="710" height="66" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="50" y="298" fill="#1e293b" font-size="13" font-weight="700">Level 3 &#183; hypermedia controls (HATEOAS)</text>
  <text x="50" y="318" fill="#1e293b" font-size="11">GET /orders/7 &#8594; 200 + "_links": { "self":&#8230;, "cancel":&#8230;, "refund":&#8230; }</text>
  <text x="50" y="334" fill="#1e293b" font-size="11">the server decides which transitions exist right now, for this caller</text>
</svg>
```

## 4. Architecture & Workflow

A complete hypermedia-driven checkout, from a client that knows exactly one URL. Compare each step to what a Level 2 client would have hardcoded.

1. **Bootstrap the entry point.** `GET https://api.zariya.in/` returns the root document: a map of relation names to URI templates. This is the only URL in the client's source code.
2. **Discover the collection.** The client looks up `rel="orders"` — it does **not** know the string `/v1/orders`. If the server later moves orders to a different host or path prefix, the client follows along with no release.
3. **Create the order.** `POST` to the discovered orders URI → `201 Created` with `Location`, plus a body containing `_links` for the transitions currently legal on a fresh order: `self`, `edit`, `cancel`, `pay`.
4. **Render from affordances.** The UI iterates `_links` and shows a control for each relation it recognises. There is no `if (order.status === 'pending')` anywhere in the client — the presence of the link *is* the condition.
5. **Follow the payment link.** `POST` to `_links.pay.href`. The link may point at a completely different service (a payments host) — the client neither knows nor cares, which is layered-system evolvability in action.
6. **State transition changes the affordances.** The response for the now-paid order drops `pay` and `cancel` and adds `refund` and `invoice`. The client's rendered buttons change automatically because they are derived from the response.
7. **Authorization is expressed as absence.** A support agent with read-only scope receives the same order with only `self` — the server has evaluated permissions and emitted only what this principal may do. The client needs no permission model at all.
8. **Paginate by relation.** The collection response carries `Link: <…>; rel="next"`. The client follows it opaquely and never parses or constructs a cursor, so you can switch from offset to cursor pagination without touching clients.
9. **Terminal state.** A delivered order exposes only `self` and `receipt`. The client, correctly, renders no actions — the state machine ended, and the client was never told what the state machine was.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="330" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Affordances change with state and with caller</text>
  <rect x="30" y="56" width="150" height="88" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">GET /  (root)</text>
  <text x="105" y="98" text-anchor="middle" fill="#1e293b" font-size="10">rel=orders</text>
  <text x="105" y="114" text-anchor="middle" fill="#1e293b" font-size="10">rel=customers</text>
  <text x="105" y="132" text-anchor="middle" fill="#1e293b" font-size="10">the only hardcoded URL</text>
  <path d="M180 100 L218 100" stroke="#4f46e5" stroke-width="2"/>
  <rect x="222" y="56" width="160" height="88" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="302" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">order: pending</text>
  <text x="302" y="98" text-anchor="middle" fill="#166534" font-size="10">self &#183; edit</text>
  <text x="302" y="114" text-anchor="middle" fill="#166534" font-size="10">cancel &#183; pay</text>
  <text x="302" y="132" text-anchor="middle" fill="#1e293b" font-size="10">4 affordances</text>
  <path d="M382 100 L420 100" stroke="#4f46e5" stroke-width="2"/>
  <text x="401" y="92" text-anchor="middle" fill="#4f46e5" font-size="10">POST pay</text>
  <rect x="424" y="56" width="160" height="88" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="504" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">order: paid</text>
  <text x="504" y="98" text-anchor="middle" fill="#166534" font-size="10">self &#183; refund</text>
  <text x="504" y="114" text-anchor="middle" fill="#166534" font-size="10">invoice &#183; ship</text>
  <text x="504" y="132" text-anchor="middle" fill="#b91c1c" font-size="10">pay, cancel removed</text>
  <path d="M584 100 L622 100" stroke="#4f46e5" stroke-width="2"/>
  <rect x="626" y="56" width="120" height="88" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="686" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">delivered</text>
  <text x="686" y="98" text-anchor="middle" fill="#166534" font-size="10">self</text>
  <text x="686" y="114" text-anchor="middle" fill="#166534" font-size="10">receipt</text>
  <text x="686" y="132" text-anchor="middle" fill="#1e293b" font-size="10">terminal</text>
  <rect x="30" y="170" width="355" height="72" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="50" y="194" fill="#1e293b" font-size="12" font-weight="700">Same order, read-only support agent</text>
  <text x="50" y="214" fill="#1e293b" font-size="11">_links: { self } only &#8212; permissions are expressed</text>
  <text x="50" y="230" fill="#1e293b" font-size="11">as the absence of a link, not as client-side logic</text>
  <rect x="405" y="170" width="345" height="72" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="425" y="194" fill="#1e293b" font-size="12" font-weight="700">Client rule</text>
  <text x="425" y="214" fill="#1e293b" font-size="11">render a control for every rel you recognise;</text>
  <text x="425" y="230" fill="#1e293b" font-size="11">ignore unknown rels; never build a URL</text>
  <rect x="30" y="258" width="720" height="70" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="50" y="282" fill="#1e293b" font-size="12" font-weight="700">What is decoupled vs what is not</text>
  <text x="50" y="302" fill="#166534" font-size="11">free to change: URI paths, hosts, cursor format, which transitions are legal</text>
  <text x="50" y="320" fill="#b91c1c" font-size="11">still a contract: media type, rel vocabulary, field names, rel semantics</text>
</svg>
```

## 5. Implementation

The root document — the client's only hardcoded URL:

```http
GET /v1 HTTP/1.1
Host: api.zariya.in
Accept: application/hal+json
```

```http
HTTP/1.1 200 OK
Content-Type: application/hal+json
Cache-Control: public, max-age=3600

{
  "_links": {
    "self":      { "href": "/v1" },
    "orders":    { "href": "/v1/orders{?status,limit,cursor}", "templated": true },
    "customers": { "href": "/v1/customers{?email}", "templated": true },
    "me":        { "href": "/v1/me" }
  }
}
```

A resource in **HAL** (`application/hal+json`) with state-dependent controls:

```http
GET /v1/orders/ord_01JQ8Z HTTP/1.1
Accept: application/hal+json
```

```http
HTTP/1.1 200 OK
Content-Type: application/hal+json
ETag: "3"

{
  "id": "ord_01JQ8Z",
  "status": "pending",
  "amount_minor": 249900,
  "currency": "INR",
  "_links": {
    "self":     { "href": "/v1/orders/ord_01JQ8Z" },
    "customer": { "href": "/v1/customers/cus_8Kq" },
    "cancel":   { "href": "/v1/orders/ord_01JQ8Z/cancel", "title": "Cancel this order" },
    "pay":      { "href": "/v1/orders/ord_01JQ8Z/payments" },
    "line-items": { "href": "/v1/orders/ord_01JQ8Z/line-items" }
  },
  "_embedded": {
    "line-items": [
      { "id": "li_1", "description": "Annual plan", "quantity": 1,
        "_links": { "self": { "href": "/v1/line-items/li_1" } } }
    ]
  }
}
```

HAL only describes *links*, not methods or payloads — a known weakness. **Siren** describes full affordances, which is what a truly generic client would need:

```json
{
  "class": ["order"],
  "properties": { "id": "ord_01JQ8Z", "status": "pending", "amount_minor": 249900 },
  "actions": [
    {
      "name": "cancel-order",
      "title": "Cancel Order",
      "method": "POST",
      "href": "https://api.zariya.in/v1/orders/ord_01JQ8Z/cancel",
      "type": "application/json",
      "fields": [
        { "name": "reason", "type": "text", "title": "Cancellation reason" },
        { "name": "refund", "type": "checkbox", "value": "true" }
      ]
    }
  ],
  "links": [{ "rel": ["self"], "href": "https://api.zariya.in/v1/orders/ord_01JQ8Z" }]
}
```

The **pragmatic 80/20** — `Link` headers (RFC 8288) for pagination, which works with any content type and even on `HEAD`:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Link: </v1/orders?cursor=b3JkXzk5&limit=25>; rel="next",
      </v1/orders?limit=25>; rel="first",
      </v1/orders/ord_01JQ8Z>; rel="self"
```

**FastAPI** — emitting links from a single authoritative policy function:

```python
from fastapi import FastAPI, Depends
from fastapi.responses import JSONResponse

app = FastAPI()
HAL = "application/hal+json"

TRANSITIONS = {
    # state -> {rel: (path_suffix, required_scope)}
    "pending":   {"cancel": ("cancel", "orders:write"), "pay": ("payments", "payments:write")},
    "paid":      {"refund": ("refunds", "refunds:write"), "invoice": ("invoice", "orders:read")},
    "shipped":   {"track": ("tracking", "orders:read")},
    "delivered": {"receipt": ("receipt", "orders:read")},
}

def links_for(order, principal) -> dict:
    """THE single source of truth for what is possible. Clients hold none of this."""
    links = {"self": {"href": f"/v1/orders/{order.id}"},
             "customer": {"href": f"/v1/customers/{order.customer_id}"}}
    for rel, (suffix, scope) in TRANSITIONS.get(order.status, {}).items():
        if scope in principal.scopes and principal.can_access(order):
            links[rel] = {"href": f"/v1/orders/{order.id}/{suffix}"}
    return links

@app.get("/v1/orders/{order_id}")
def get_order(order_id: str, principal=Depends(current_principal)):
    order = repo.get(order_id)
    body = order.public_dict() | {"_links": links_for(order, principal)}
    return JSONResponse(body, media_type=HAL, headers={"ETag": f'"{order.version}"'})

@app.post("/v1/orders/{order_id}/cancel")
def cancel(order_id: str, principal=Depends(current_principal)):
    order = repo.get(order_id)
    # The link's absence is a UI hint, never the authorization check.
    if "cancel" not in links_for(order, principal):
        return problem(409, "invalid-transition", f"Cannot cancel an order in state {order.status}")
    return JSONResponse(repo.cancel(order_id).public_dict(), media_type=HAL)
```

A **hypermedia-driven client** — note that it constructs no URLs at all:

```javascript
const ROOT = "https://api.zariya.in/v1";           // the only hardcoded URL
const get = (u) => fetch(u, { headers: { Accept: "application/hal+json" } }).then(r => r.json());

async function cancelLatestPendingOrder() {
  const root   = await get(ROOT);
  const orders = await get(expand(root._links.orders.href, { status: "pending", limit: 1 }));
  const order  = orders._embedded.orders[0];

  const cancel = order._links.cancel;
  if (!cancel) return { done: false, reason: "not cancellable right now" };

  const res = await fetch(cancel.href, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "customer request" }),
  });
  return { done: res.ok, status: res.status };
}

// Rendering is derived entirely from affordances:
const KNOWN = { cancel: "Cancel order", pay: "Pay now", refund: "Refund", track: "Track" };
const buttons = Object.entries(order._links)
  .filter(([rel]) => rel in KNOWN)      // ignore rels we don't understand
  .map(([rel, l]) => ({ label: KNOWN[rel], href: l.href }));
```

**Optimization note.** Hypermedia's costs are both measurable and mitigable. **Payload:** a `_links` block on a small object routinely adds 20–40 % — on collections, emit links only on the collection plus a `self` per item, and let clients `GET` an item for its full affordances. **Round trips:** cache the root document aggressively (`Cache-Control: public, max-age=3600`) so bootstrapping costs nothing after the first call, and use URI templates (RFC 6570) so a client can jump directly to a known relation instead of walking the graph. Do *not* serve a root document with `no-store` — that turns every client operation into an extra request. **Computation:** `links_for()` runs on every serialized object, so a naive implementation that queries permissions per item makes a 100-item page do 100 authorization lookups; batch the permission evaluation once per request and pass the result down. Finally, `Link` headers keep hypermedia out of the body entirely, which means a `HEAD` request can discover navigation without transferring any representation at all.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Server owns the state machine | Business rules live in exactly one place instead of N clients | Every client must be written to *consume* links, which most SDK generators don't support |
| URI space becomes internal | Free to reorganise paths, move resources across hosts, re-shard | Only true if clients genuinely never construct URLs — one hardcoded path voids it |
| Permission-aware affordances | Clients need no permission model; absence of a link is the answer | Link generation now runs authorization per object; easy to make N+1 |
| Discoverability | An API you can explore from the root with `curl`; self-documenting | Discovery costs round trips; typed clients still need docs for field semantics |
| `Link` headers for pagination | Cheap, standard (RFC 8288), works on any content type and on `HEAD` | Only covers navigation, not state-changing actions |
| HAL | Simple, widely supported, small footprint | Describes links only — no method, no expected payload, so clients still hardcode both |
| Siren / Hydra | Full affordances: method, fields, types — a generic client is possible | Verbose, niche tooling, steep learning curve, tiny ecosystem |
| JSON:API | Complete spec with relationships, sparse fieldsets, includes | Opinionated and heavy; the whole team must learn it; fights typed codegen |
| Level 2 + great docs (the mainstream) | Fast to build, perfect codegen, minimal payloads, familiar to everyone | Business rules duplicated across clients; URI space frozen as a public contract |
| Partial adoption (`self` + action links) | Captures most of the value at a fraction of the cost | Not "real" HATEOAS; clients still construct some URLs, so the decoupling is partial |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Emitting links but hardcoding URLs anyway.** The client has a `_links` parser and *also* `const url = `/v1/orders/${id}/cancel``. You pay the payload cost and get zero decoupling. → ✅ Ban URL construction in client code with a lint rule; the only string literal allowed is the entry point.
2. ⚠️ **Treating a missing link as an authorization check.** The client hides the button, so the endpoint "can't" be called — until someone calls it directly with `curl`. → ✅ Links are a UI hint; the endpoint must independently authorize every request and return `403`/`409` regardless of what was rendered.
3. ⚠️ **Static links that ignore state.** Emitting `cancel` on a delivered order makes the whole mechanism a lie and clients stop trusting it. → ✅ Derive links from the resource's actual state and the caller's permissions, from one shared policy function.
4. ⚠️ **Inventing relation names when a registered one exists.** `"nextPage"`, `"myself"`, `"parentThing"`. → ✅ Use IANA-registered relations (`self`, `next`, `prev`, `first`, `last`, `collection`, `item`, `edit`, `up`, `describedby`) and namespace extensions as URIs.
5. ⚠️ **Links on every item of a 500-item collection.** Payload balloons past the data itself and permission checks go quadratic. → ✅ Links on the collection plus a `self` per item; full affordances on the individual `GET`.
6. ⚠️ **Absolute URLs baked with the wrong host.** Links generated as `http://internal-svc:8080/...` leak internal topology and break behind a proxy. → ✅ Use relative URIs, or build absolute ones from `Forwarded`/`X-Forwarded-*` with a validated allow-list of public hosts.
7. ⚠️ **Claiming HATEOAS in the docs while shipping Level 2.** "Our RESTful API" with `_links` containing only `self`. → ✅ Be honest about your maturity level; nobody is impressed by the label, and precision helps consumers.
8. ⚠️ **Rebuilding the whole API around hypermedia for internal service-to-service traffic.** The consumers are three services you own and deploy together; discoverability buys nothing. → ✅ Reserve hypermedia investment for public APIs, long-lived clients (mobile apps you cannot force-update), and complex workflows.
9. ⚠️ **Ignoring caching of the root document.** Every operation now starts with an uncached round trip to `/`. → ✅ `Cache-Control: public, max-age=3600` on the entry point plus an `ETag`; it changes about once a quarter.
10. ⚠️ **Breaking clients by removing a link relation.** Removing `rel="cancel"` from the vocabulary is exactly as breaking as deleting an endpoint. → ✅ Relation names are versioned contract: deprecate with `Sunset`, keep emitting during the window, then remove.
11. ⚠️ **Mixing hypermedia formats within one API.** HAL on some endpoints, JSON:API on others, bare links elsewhere. → ✅ One format, one media type, declared in the style guide and enforced by lint.
12. ⚠️ **Using `_embedded` to inline unbounded child collections.** An order embedding 5,000 line items produces a multi-megabyte response. → ✅ Embed a capped preview and always provide a link to the paginated sub-resource.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Hypermedia makes API exploration genuinely pleasant — `curl https://api.zariya.in/v1 | jq '._links'` gives a support engineer an accurate map of the system with no documentation. Conversely, the failure mode is uniquely confusing: "the button disappeared" is now a *server-side* bug in the link-policy function, not a client bug. Log the computed relation set alongside the resource state and the principal's scopes on every serialization, so you can answer "why did this user not get `cancel` at 14:03?" without reproducing. Keep a golden-file test per state-and-role combination asserting the exact set of relations emitted — that matrix is the real contract, and it's the thing that silently drifts.

**Monitoring.** Two metrics worth having. **Link-following ratio:** the fraction of incoming requests whose `Referer` or a `Link-Rel` hint indicates they arrived by following a link versus being constructed. If it stays near zero, your clients are not actually hypermedia clients and you are paying the payload cost for nothing — that is a real decision point, not a curiosity. **Affordance-emission counters:** `links_emitted_total{rel, state}` tells you which relations are ever produced; a relation that has been emitted zero times in a month is dead code in your state machine. Also watch response-size percentiles before and after enabling links, and watch the authorization-call count per request to catch the N+1 in `links_for()`.

**Security.** The cardinal rule: **a link is a hint, never a control.** Every endpoint must authorize independently, because an attacker sees the URL space regardless — either from another user's response, from documentation, or by guessing. There is a subtler leak: the *presence* of a link discloses permission and state information. Emitting `rel="refund"` tells the caller a refund is possible, which can reveal payment state they aren't otherwise entitled to see; emitting a link to a resource in another tenant confirms it exists. Compute links under the same authorization context as the data itself. Also validate host construction: if you build absolute URLs from `Host` or `X-Forwarded-Host`, an attacker can poison every link in the response by sending a forged header — a classic host-header injection that turns your API into a phishing redirector. Always resolve against a configured allow-list.

**Performance & scaling.** The three costs are bytes, round trips, and authorization calls. Bytes: measure `_links` as a percentage of response size and cap embedded collections. Round trips: cache the root and any relatively static index documents at the CDN, and prefer URI templates over graph-walking so a client can reach a resource in one hop. Authorization: batch permission evaluation per request rather than per object — the naive implementation of `links_for()` inside a list serializer is the most common performance regression in hypermedia APIs, turning one page render into hundreds of policy lookups. Finally, hypermedia interacts well with caching *because* the server controls the URL space: when you reorganise paths, old URLs can `301` to new ones and clients follow transparently, which is precisely the evolvability the constraint was designed to buy.

## 9. Interview Questions

**Q: What does HATEOAS actually mean?**
A: Hypermedia As The Engine Of Application State: the client starts from a single entry-point URI and discovers every subsequent action from links and forms the server includes in its responses, rather than from URLs baked into client code. Application state advances by following server-provided controls. It is one of the four sub-constraints of REST's uniform interface, and it is what Fielding meant when he said REST APIs must be hypertext-driven.

**Q: What are the levels of the Richardson Maturity Model?**
A: Level 0 is a single URI with RPC tunnelled through it, typically all `POST`. Level 1 introduces multiple resources with their own URIs but still misuses methods. Level 2 uses HTTP methods and status codes correctly — this is where the vast majority of real "REST" APIs live. Level 3 adds hypermedia controls so responses tell the client what it can do next.

**Q: Why do most APIs skip HATEOAS?**
A: Because the cost is immediate and the benefit is deferred. Modern clients are typed SDKs generated from OpenAPI, which want a static method surface and cannot use runtime links; discoverability adds round trips; `_links` inflates payloads; and there is no generic JSON hypermedia client analogous to the browser, so every API's controls must be understood by bespoke code anyway. Meanwhile, good documentation plus stable versioned URLs delivers most of the practical benefit far more cheaply.

**Q: What is a link relation type and why does it matter more than the URL?**
A: The `rel` is the semantic name of the link — `self`, `next`, `cancel` — and it is the actual contract between client and server. The `href` is meant to be opaque and changeable; the `rel` is what the client keys off. This is why HATEOAS relocates coupling rather than eliminating it: you stop depending on URL structure and start depending on a relation vocabulary.

**Q: How does HATEOAS remove business logic from clients?**
A: In a Level 2 API, every client re-implements the resource's state machine to decide which buttons to show — "cancellable if pending and not captured and not disputed" — so the rule exists in the server plus every client. With hypermedia, the server emits a `cancel` link only when cancellation is genuinely legal for this resource and this caller, and clients simply render whatever links they recognise. The rule collapses from N+1 copies to one.

**Q: What's the difference between HAL and Siren?**
A: HAL is minimal — `_links` and `_embedded`, describing only where you can go, not how. Siren adds `actions` with an explicit method, content type, and field descriptions, which is what a genuinely generic client needs to construct a state-changing request without out-of-band knowledge. HAL is far more widely deployed precisely because it is cheaper; Siren is more correct and almost unused.

**Q: Is the absence of a link a security control?**
A: No. It is a UI affordance. Any attacker can discover or guess the URL and call it directly, so the endpoint must perform its own authorization and return `403` or `409` independently of what the representation advertised. Treating link absence as enforcement is a straightforward broken-access-control vulnerability.

**Q: Where is hypermedia genuinely worth the cost?**
A: Public APIs with many long-lived third-party clients you cannot force to upgrade; mobile apps where old versions linger in the wild for years; and complex, permission-heavy workflows where the set of legal next actions is expensive for a client to compute correctly. It is rarely worth it for internal service-to-service APIs, where consumers are few and deploy alongside you.

**Q: (Senior) Fielding says an API without hypermedia isn't REST. Is he right, and does it matter?**
A: He is right by definition — HATEOAS is a stated constraint of REST, so an API lacking it is by construction not REST; it is HTTP-based RPC over resources, and Fielding's frustration was with the term being applied to things that discard its central constraint. Whether it *matters* is a separate question, and honestly it usually doesn't: the industry converged on Level 2 plus OpenAPI because that combination optimises for the actual dominant constraint, which is developer productivity with generated, typed clients. The useful senior position is precision rather than purity — know exactly which property you are giving up (server-controlled evolution of the URI space and the state machine), decide deliberately whether you need it, and stop calling Level 2 "RESTful" as if the label settled anything.

**Q: (Senior) How would you introduce hypermedia into a large existing Level 2 API without breaking anyone?**
A: Additively and partially. Start with `Link` headers for pagination, since RFC 8288 is standard, costs no body bytes, and immediately removes cursor-construction logic from clients. Next, add a `_links` object to stateful resources only — orders, payments, subscriptions — computed from a single server-side policy function; existing clients ignore the unknown field, so it is non-breaking by construction. Publish the relation vocabulary as versioned documentation and add golden-file tests over the state-by-role matrix. Then instrument link-following: if after two quarters no meaningful share of traffic arrives via followed links, you have learned that your consumers don't want hypermedia, and you should stop investing rather than escalate. The mistake is a big-bang migration to HAL or JSON:API, which is a breaking media-type change delivering benefits your clients haven't asked for.

**Q: (Senior) What are the performance implications of hypermedia at scale, and how do you mitigate them?**
A: Three costs. Payload growth — `_links` commonly adds 20–40 % to small representations, and on a large collection can exceed the payload, so emit full affordances only on individual resources and just `self` on collection items. Round trips — strict root-first navigation multiplies requests, mitigated by caching the entry-point document with a long `max-age` and by RFC 6570 URI templates that let clients jump directly to a relation. Authorization cost — link computation is permission-dependent, so a naive `links_for()` inside a list serializer produces an N+1 of policy lookups; batch the permission evaluation once per request. The subtle one is cache-key fragmentation: if links vary by caller permissions, responses become per-principal and lose shared cacheability, which is why permission-varying links belong on `private` responses and `Vary: Authorization` must be set correctly.

**Q: (Senior) How do you version a hypermedia API?**
A: The relation vocabulary and the media type become the versioned contract instead of the URL space, which is exactly the point — URLs are now free to change. Relation names are versioned like any other public identifier: to change semantics, introduce a new `rel` (ideally a namespaced URI like `https://api.zariya.in/rels/refund-v2`), emit both during a deprecation window, monitor usage, and remove the old one after a published `Sunset` date. For wholesale representation changes, version the media type (`application/vnd.zariya.order+json; version=2`) and negotiate via `Accept`, so both shapes can coexist behind the same URIs. What you must not do is treat links as un-versioned just because they are "just data" — removing a relation clients depend on is precisely as breaking as deleting an endpoint.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** HATEOAS means the client hardcodes exactly one URL — the entry point — and discovers everything else from server-supplied links. It is REST's fourth uniform-interface sub-constraint and the top rung of the Richardson Maturity Model; Level 2 (correct verbs and status codes) is where nearly every real API stops. The genuine win is that the resource's state machine and its permission rules live only on the server, so `cancel` appears when cancellation is legal for this order and this caller, and clients render whatever they recognise. The cost is payload growth, extra round trips, per-object authorization work, and incompatibility with the OpenAPI codegen ecosystem that clients actually use. Coupling is relocated, not removed: you stop depending on URLs and start depending on relation names and a media type. The pragmatic adoption path is `Link` headers for pagination, a `self` link everywhere, and state-dependent action links on stateful resources only. And always remember a missing link is a hint, never an authorization control.

| Concept | What it is | Media type / spec |
|---|---|---|
| HATEOAS | Hypermedia drives application state | Fielding, REST dissertation §5.1.5 |
| Maturity Level 2 | Verbs + status codes, no links | where most APIs live |
| Maturity Level 3 | Hypermedia controls in responses | the constraint being discussed |
| `Link` header | Links in the HTTP header | RFC 8288 |
| URI template | `/repos/{owner}/{repo}` | RFC 6570 |
| HAL | `_links`, `_embedded`; links only | `application/hal+json` |
| JSON:API | `data`, `links`, `relationships`, `included` | `application/vnd.api+json` |
| Siren | `properties`, `actions` (method + fields), `links` | `application/vnd.siren+json` |
| Registered `rel`s | `self`, `next`, `prev`, `first`, `last`, `item`, `collection`, `edit`, `up`, `describedby` | IANA registry |
| Extension `rel`s | Namespaced URIs you own | `https://api.example.com/rels/refund` |

**Flash cards**

- **What is the only URL a hypermedia client may hardcode?** → The entry point; everything else is discovered from `rel` names.
- **Which Richardson level is "HATEOAS"?** → Level 3. Level 2 is correct verbs and status codes, and it's where most APIs stop.
- **Does HATEOAS remove coupling?** → No — it moves coupling from URL structure to relation names and the media type.
- **Is a missing link an access control?** → Never. Every endpoint must authorize independently and return `403`/`409`.
- **What's the cheapest useful hypermedia?** → `Link: <…>; rel="next"` for pagination (RFC 8288), plus a `self` link on every resource.

## 11. Hands-On Exercises & Mini Project

- [ ] Add RFC 8288 `Link` headers with `next`/`prev`/`first` to an existing paginated endpoint, then rewrite a client to follow them instead of constructing cursors.
- [ ] Model an order lifecycle as an explicit state machine and write one `links_for(resource, principal)` function that is the sole source of truth for legal transitions; test the full state × role matrix.
- [ ] Convert one endpoint to `application/hal+json` served *alongside* the existing JSON via content negotiation, so both clients work simultaneously.
- [ ] Measure the payload cost: compare a 50-item collection with no links, with `self` only, and with full affordances per item. Report the three sizes gzipped.
- [ ] Write a client that performs a complete three-step workflow with exactly one hardcoded URL, then prove decoupling by changing every server path except the root and re-running it unmodified.

### Mini Project — A Level 3 Order Workflow

**Goal.** Build a small order API that is genuinely hypermedia-driven, plus a client that hardcodes only the entry point — then demonstrate the evolvability payoff.

**Requirements.**
1. Entry point `GET /v1` returning RFC 6570 URI templates for `orders`, `customers` and `me`, cacheable for an hour with an `ETag`.
2. Order states `pending → paid → shipped → delivered`, plus `cancelled` and `refunded`, with a single server-side transition table.
3. Every order response carries `_links` computed from state **and** the caller's scopes; a read-only role receives `self` only.
4. Collections carry RFC 8288 `Link` headers for `next`/`prev`/`first`; items in collections carry only `self`.
5. Endpoints authorize independently and return `409` with a Problem Details body naming `current_state` and `allowed_transitions` when a transition is illegal — even if no link was emitted.
6. A client that completes create → pay → ship → deliver knowing only `https://…/v1`, rendering buttons purely from recognised `rel`s.
7. Golden-file tests asserting the exact relation set for every (state, role) pair.

**Extensions.**
- Move every path except the root (e.g. `/v1/orders` → `/v1/commerce/orders`) and prove the client still works without modification. This is the whole thesis, demonstrated.
- Serve Siren (`application/vnd.siren+json`) alongside HAL through content negotiation, with `actions` describing method and fields, and write a generic renderer that builds a form from any Siren action.
- Add `links_emitted_total{rel,state}` and a link-following ratio metric; report what fraction of traffic actually follows links.
- Add a namespaced extension relation with a `describedby` link to its documentation, and deprecate an older relation using `Deprecation` and `Sunset` headers.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *REST Constraints & Architectural Style* covers the other five constraints this one completes; *Naming Conventions & API Consistency* is what you rely on when you *don't* do hypermedia; *Pagination* is where `Link` headers pay off immediately; *Content Negotiation & Media Types* explains serving HAL and JSON alongside each other; *Versioning & Deprecation* covers sunsetting a relation; *Authentication & Authorization* explains why a missing link is never a control; *OpenAPI & Documentation* is the ecosystem that outcompeted hypermedia.

- **REST APIs must be hypertext-driven** — Roy Fielding · *Advanced* · the short, blunt post that defines the constraint and names the misuse of the term. <https://roy.gbiv.com/untangled/2008/rest-apis-must-be-hypertext-driven>
- **Architectural Styles and the Design of Network-based Software Architectures, Ch. 5** — Roy Fielding · *Advanced* · the original dissertation chapter defining REST's constraints, including the uniform interface. <https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm>
- **Richardson Maturity Model** — Martin Fowler · *Intermediate* · the clearest explanation of levels 0–3 and what each one buys you. <https://martinfowler.com/articles/richardsonMaturityModel.html>
- **RFC 8288 — Web Linking** — IETF · *Intermediate* · defines the `Link` header and the link-relation model; the cheapest real hypermedia you can ship. <https://www.rfc-editor.org/rfc/rfc8288.html>
- **IANA Link Relation Types registry** — IANA · *Beginner* · check here before inventing a `rel`; most of what you need already exists. <https://www.iana.org/assignments/link-relations/link-relations.xhtml>
- **JSON Hypertext Application Language (HAL)** — Mike Kelly / IETF draft · *Intermediate* · the `_links`/`_embedded` format, with worked examples. <https://datatracker.ietf.org/doc/html/draft-kelly-json-hal>
- **JSON:API Specification v1.1** — jsonapi.org · *Intermediate* · a complete, opinionated hypermedia-flavoured spec covering relationships, includes and sparse fieldsets. <https://jsonapi.org/format/>
- **RFC 6570 — URI Template** — IETF · *Intermediate* · the templating syntax hypermedia entry points use to avoid forcing a full graph walk. <https://www.rfc-editor.org/rfc/rfc6570.html>

---

*REST API Handbook — chapter 10.*
