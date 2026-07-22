# 03 · What Is REST? Constraints & Maturity

> **In one line:** REST is not a protocol or a spec but an architectural *style* — six constraints Roy Fielding derived from the Web itself — and the properties you actually want (scalability, evolvability, cacheability, visibility) are consequences of accepting those constraints, not of using JSON over HTTP.

---

## 1. Overview

**REST** — REpresentational State Transfer — is an architectural style for distributed hypermedia systems, described in Chapter 5 of Roy T. Fielding's year-2000 doctoral dissertation. Fielding was not inventing something new; he was *naming* the design rationale behind HTTP/1.0 and 1.1, both of which he co-authored. His method was unusual and worth understanding: he started from the null style (anything goes) and derived an architecture by successively adding **constraints**, showing at each step which system properties the constraint buys and which it costs. REST is therefore best read as a set of deliberate restrictions, and the value proposition is: *give up some freedom at design time, gain scalability and independent evolvability at runtime*.

The problem REST addresses is **evolution over decades at internet scale**, with millions of independently deployed components, no coordinated release, no central authority, and no ability to upgrade every client at once. Classic RPC and CORBA-style distributed objects assumed the opposite: shared type systems, generated stubs, and coordinated deployment. They worked beautifully inside one organisation and fell apart across trust boundaries. REST asks a different question — what constraints let a client written in 2005 keep working against a server rewritten in 2026? — and answers with statelessness, a uniform interface, layering, and cacheable self-descriptive messages.

The name itself encodes the model. A **resource** is any concept worth naming (an order, a user, "today's weather in Pune", the collection of shipped orders). A resource is *not* a database row; it is an identifier for a concept whose value may change over time. The client never touches the resource directly — it transfers **representations** of it (a JSON document, an image, a CSV) back and forth, and the application progresses by moving through states as it follows links and submits representations. Hence *representational state transfer*.

Where practice diverges from theory is worth stating plainly at the top. The overwhelming majority of production "REST APIs" satisfy statelessness, client–server, layering and the resource-plus-verb parts of the uniform interface, and simply do not implement **HATEOAS** (hypermedia as the engine of application state). Fielding wrote in 2008 that such APIs are not REST — and by his definition he is right. But the industry has settled on a useful vocabulary: "REST" in job descriptions means resource-oriented HTTP with correct methods and status codes. The **Richardson Maturity Model** gives you a way to talk about that gap precisely instead of arguing about the word. This chapter teaches both: what REST *is*, and what the ecosystem *means* when it says REST.

Concretely: **GitHub's API** returns objects laden with `url`, `issues_url` and `comments_url` fields, and its `Link` header carries `rel="next"`/`rel="prev"` for pagination — Level 3 hypermedia for navigation, even though most clients ignore it. **Stripe** is deliberately Level 2: clean resources, correct methods, no hypermedia, with a rigorous date-based versioning policy instead. Both are excellent APIs. The lesson is that the constraints have costs as well as benefits, and a senior engineer chooses which to pay.

## 2. Core Concepts

- **Architectural style** — a coordinated set of constraints, independent of any implementation. REST is a style; HTTP is a protocol that (mostly) implements it.
- **Resource** — the key abstraction: any information that can be named. Its *value* (the mapping to a set of entities) may change over time; its identity does not.
- **Resource identifier (URI)** — the name of a resource. Stable identifiers are what make bookmarks, caches and links work.
- **Representation** — a byte sequence plus metadata capturing a resource's current or intended state, e.g. `application/json` with `ETag` and `Content-Type`.
- **Self-descriptive message** — every message carries everything needed to interpret it: the method, the media type, cache directives, and preconditions. No out-of-band context required.
- **Statelessness** — the server stores no *session* state between requests; all context needed to serve a request is in the request. Resource state on the server is fine — that is the point of the server.
- **HATEOAS** — Hypermedia As The Engine Of Application State: the client discovers what it can do next from links and forms in the responses, not from hard-coded URI templates.
- **Uniform interface** — the constraint that all components interact through the same generic vocabulary (identification, manipulation via representations, self-descriptive messages, hypermedia).
- **Richardson Maturity Model (RMM)** — Leonard Richardson's four-level scale (0: single endpoint/RPC · 1: resources · 2: HTTP verbs and status codes · 3: hypermedia) for describing how far an API leans on the Web's own mechanics.
- **Idempotency & safety** — HTTP method properties that make the uniform interface useful to intermediaries; they are the mechanical payoff of the style.

## 3. Theory & Principles

### The six constraints

Fielding derives REST by adding these in order. Five are required; the sixth is optional.

**1. Client–Server.** Separate user-interface concerns from data-storage concerns. This buys portability of the UI across platforms and independent evolution of both sides. Cost: you now have a network between them, with everything that implies.

**2. Stateless.** Each request from client to server must contain all information necessary to understand it; the server may not use stored session context. This buys **visibility** (a monitor can understand a request by looking at just that request), **reliability** (partial failure recovery is easier), and **scalability** (the server frees resources between requests and any replica can serve any request). Cost: repeated per-request data, and less server control over consistent application behaviour.

**3. Cacheable.** Responses must be explicitly or implicitly labelled cacheable or non-cacheable. This buys latency and efficiency — the best request is one never sent. Cost: a cache can serve stale data, and correctness now depends on getting `Cache-Control`, `ETag` and `Vary` right.

**4. Uniform Interface.** The central constraint, itself made of four sub-constraints: *identification of resources* (URIs), *manipulation of resources through representations*, *self-descriptive messages*, and *hypermedia as the engine of application state*. This buys generality — intermediaries can be written once and work with every service. Cost: efficiency, because a uniform, standardised form is by definition not optimised for your specific case.

**5. Layered System.** A component cannot see beyond the layer it talks to, which permits load balancers, gateways, CDNs and legacy encapsulation. Cost: added latency per hop and reduced end-to-end visibility.

**6. Code-on-Demand (optional).** The server may extend client functionality by sending executable code (JavaScript in a browser). Rare in APIs; listed as optional because it reduces visibility.

```svg
<svg viewBox="0 0 820 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Fielding's derivation: each constraint buys a property and costs one</text>
  <g stroke-width="2">
    <rect x="20" y="48" width="240" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="20" y="108" width="240" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="20" y="168" width="240" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="20" y="228" width="240" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
    <rect x="20" y="288" width="240" height="40" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  </g>
  <g fill="#1e293b" font-weight="bold">
    <text x="36" y="70">1. Client&#8211;Server</text><text x="36" y="130">2. Stateless</text>
    <text x="36" y="190">3. Cacheable</text><text x="36" y="250">4. Uniform Interface</text>
    <text x="36" y="313">5. Layered  (+6. Code-on-Demand)</text>
  </g>
  <g fill="#475569" font-size="11">
    <text x="36" y="88">separate UI from storage</text><text x="36" y="148">no server session state</text>
    <text x="36" y="208">responses labelled cacheable</text><text x="36" y="268">identify &#183; represent &#183; describe &#183; link</text>
  </g>
  <g stroke="#4f46e5" stroke-width="2" marker-end="url(#c1)">
    <line x1="264" y1="74" x2="378" y2="74"/><line x1="264" y1="134" x2="378" y2="134"/>
    <line x1="264" y1="194" x2="378" y2="194"/><line x1="264" y1="254" x2="378" y2="254"/>
    <line x1="264" y1="308" x2="378" y2="308"/>
  </g>
  <g stroke-width="2">
    <rect x="382" y="48" width="200" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="382" y="108" width="200" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="382" y="168" width="200" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="382" y="228" width="200" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="382" y="288" width="200" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  </g>
  <g fill="#1e293b" font-size="11">
    <text x="394" y="70">portability, independent</text><text x="394" y="86">evolution of both sides</text>
    <text x="394" y="130">visibility, reliability,</text><text x="394" y="146">horizontal scalability</text>
    <text x="394" y="190">lower latency, less</text><text x="394" y="206">origin load</text>
    <text x="394" y="250">generality: intermediaries</text><text x="394" y="266">work with every service</text>
    <text x="394" y="313">gateways, CDNs, proxies</text>
  </g>
  <g fill="#b45309" font-size="11">
    <text x="600" y="74">network exists now</text>
    <text x="600" y="140">repeated per-request data</text>
    <text x="600" y="200">stale-data risk</text>
    <text x="600" y="254">not optimised for your</text><text x="600" y="270">specific use case</text>
    <text x="600" y="313">a hop of latency each</text>
  </g>
  <text x="700" y="44" text-anchor="middle" fill="#b45309" font-size="12" font-weight="bold">costs</text>
  <text x="482" y="44" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">buys</text>
</svg>
```

### Statelessness, precisely

The most common misreading is that a stateless server cannot store anything. It stores **resource state** — that is its job. What it must not do is keep **application/session state** on the server side, such that request N+1 is only interpretable in light of request N. A shopping cart held in a server-side `HttpSession` keyed by a cookie is application state on the server: it breaks visibility, prevents any replica from serving any request, and complicates failover. A shopping cart exposed as `/carts/{id}` — a real resource the client addresses explicitly — is resource state, and is perfectly RESTful.

### The Richardson Maturity Model

| Level | Name | What it looks like | What you gain |
|---|---|---|---|
| **0** | The Swamp of POX | One URI, one verb: `POST /api` with `{"op":"getOrder","id":9}` | Nothing from HTTP; it is RPC over a tunnel (classic SOAP) |
| **1** | Resources | Many URIs, still one verb: `POST /orders/9/get` | Divide-and-conquer: the domain is now addressable |
| **2** | HTTP Verbs | `GET /orders/9`, `DELETE /orders/9`, correct status codes | Caching, safe retries, idempotency, intermediary participation — **the level with the real payoff** |
| **3** | Hypermedia | Responses carry links/actions: `{"_links":{"cancel":{"href":"/orders/9/cancellation"}}}` | Discoverability, server-controlled workflow, URI evolvability |

Richardson framed these as steps toward "the glory of REST", and Fielding insists only Level 3 qualifies. Pragmatically, **Level 2 captures the great majority of the engineering value**; Level 3's benefits are real but only materialise when clients are actually written to follow links rather than hard-code paths — which, absent a browser-like generic client, they rarely are.

## 4. Architecture & Workflow

How a Level 3 interaction actually proceeds, contrasted with the Level 2 equivalent:

1. **Entry point.** The client knows exactly one URL: `GET https://api.example.com/`. The response is a directory of link relations (`orders`, `customers`, `search`) — no other URI is compiled into the client.
2. **Navigate to the collection.** The client follows the `orders` relation and issues `GET /v1/orders`. It has no idea whether that path is `/v1/orders` or `/api/2026/order-collection`; it followed a link.
3. **Server returns a representation with affordances.** Each order carries `_links` describing what is currently *possible for this resource in this state*: a `pending_payment` order exposes `pay` and `cancel`; a `shipped` order exposes `track` and `return` but no `cancel`.
4. **Client renders/decides from affordances.** The workflow logic lives on the server. Removing `cancel` from shipped orders instantly disables it in every client, with no client release.
5. **State transition.** The client `POST`s to the `cancel` href. The server validates the transition and returns the new representation with a new set of links.
6. **Caching and layering.** Every `GET` along the way carries `ETag` and `Cache-Control`, so a CDN can serve steps 1–3 without touching the origin. Because messages are self-descriptive, that CDN needs to know nothing about orders.
7. **Evolution.** The server moves `/v1/orders` to a different host. Link-following clients keep working; hard-coded clients break. That is the whole payoff of the constraint — and the reason it is worth exactly as much as the number of link-following clients you have.

```svg
<svg viewBox="0 0 820 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="d1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="d2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Hypermedia state machine: the server owns the workflow</text>
  <g stroke-width="2">
    <rect x="30" y="60" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="240" y="60" width="150" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
    <rect x="450" y="60" width="150" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="660" y="60" width="130" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="450" y="180" width="150" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  </g>
  <g text-anchor="middle" fill="#1e293b" font-weight="bold">
    <text x="105" y="84">draft</text><text x="315" y="84">pending_payment</text>
    <text x="525" y="84">paid</text><text x="725" y="84">shipped</text><text x="525" y="204">cancelled</text>
  </g>
  <g text-anchor="middle" fill="#475569" font-size="11">
    <text x="105" y="104">links: submit</text><text x="315" y="104">links: pay, cancel</text>
    <text x="525" y="104">links: ship, refund</text><text x="725" y="104">links: track, return</text>
    <text x="525" y="224">links: (none)</text>
  </g>
  <g stroke="#4f46e5" stroke-width="2" marker-end="url(#d1)">
    <line x1="182" y1="90" x2="236" y2="90"/><line x1="392" y1="90" x2="446" y2="90"/>
    <line x1="602" y1="90" x2="656" y2="90"/>
  </g>
  <line x1="330" y1="122" x2="470" y2="178" stroke="#16a34a" stroke-width="2" marker-end="url(#d2)"/>
  <g fill="#1e293b" font-size="11">
    <text x="209" y="82" text-anchor="middle">submit</text><text x="419" y="82" text-anchor="middle">pay</text>
    <text x="629" y="82" text-anchor="middle">ship</text><text x="366" y="160">cancel</text>
  </g>
  <rect x="30" y="262" width="760" height="82" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="44" y="284" fill="#1e293b" font-size="12" font-weight="bold">Response for a pending_payment order</text>
  <g fill="#1e293b" font-size="11">
    <text x="44" y="304">{ "id": "ord_9F2", "status": "pending_payment",</text>
    <text x="44" y="322">  "_links": { "self": {"href":"/v1/orders/ord_9F2"},</text>
    <text x="44" y="338">              "pay": {"href":"/v1/orders/ord_9F2/payments","method":"POST"},</text>
    <text x="470" y="322">"cancel": {"href":"/v1/orders/ord_9F2/cancellation"} } }</text>
    <text x="470" y="338" fill="#b45309">no "cancel" link once shipped &#8594; client cannot even try</text>
  </g>
</svg>
```

> **Note:** The honest counterpoint — a hand-written client still needs to know that the relation is called `cancel` and what payload it takes. Hypermedia removes URI coupling, not semantic coupling. That is why link relations should be registered or documented as carefully as any other part of the contract.

## 5. Implementation

### Level 0 → Level 2, side by side

```http
POST /api HTTP/1.1                       # Level 0: one endpoint, verbs in the body
Content-Type: application/json

{"operation":"cancelOrder","orderId":9,"reason":"changed_mind"}

HTTP/1.1 200 OK
{"success":false,"errorCode":"ORDER_ALREADY_SHIPPED"}
```

```http
POST /v1/orders/ord_9F2/cancellation HTTP/1.1   # Level 2: resource + method + status
Content-Type: application/json
Authorization: Bearer ...

{"reason":"changed_mind"}

HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{"type":"https://api.example.com/problems/order-already-shipped",
 "title":"Order already shipped","status":409,
 "detail":"Order ord_9F2 shipped at 2026-07-21T18:02Z and can no longer be cancelled."}
```

The second version is retryable-aware (a client library sees `409` and knows not to retry blindly), cacheable where relevant, monitorable by status class, and understandable to every proxy on the path. The first is opaque to all of them.

### A stateless design, and the state that is allowed

```http
GET /v1/carts/cart_71Ka HTTP/1.1          # cart is a RESOURCE, addressable and cacheable
Authorization: Bearer ...

HTTP/1.1 200 OK
ETag: W/"cart-4"
Cache-Control: private, no-cache

{"id":"cart_71Ka","items":[{"sku":"TSHIRT-BLK-M","quantity":2}],"subtotal":159800}
```

There is no server-side session: the bearer token identifies the caller, the URI identifies the cart, and any of fifty replicas can serve this request. Contrast with `GET /cart` relying on a `JSESSIONID` cookie and sticky routing — that is application state on the server, and it is what breaks when a pod is rescheduled.

### Adding hypermedia (FastAPI, Level 3)

```python
from fastapi import FastAPI, HTTPException

app = FastAPI()
ORDERS = {"ord_9F2": {"id": "ord_9F2", "status": "pending_payment", "total": 159800}}

# The workflow lives here, on the server — not in every client.
TRANSITIONS = {
    "draft":           {"submit": ("POST", "/v1/orders/{id}/submission")},
    "pending_payment": {"pay":    ("POST", "/v1/orders/{id}/payments"),
                        "cancel": ("POST", "/v1/orders/{id}/cancellation")},
    "paid":            {"refund": ("POST", "/v1/orders/{id}/refunds")},
    "shipped":         {"track":  ("GET",  "/v1/shipments?order={id}")},
}

def with_links(order: dict) -> dict:
    links = {"self": {"href": f"/v1/orders/{order['id']}", "method": "GET"}}
    for rel, (method, tmpl) in TRANSITIONS.get(order["status"], {}).items():
        links[rel] = {"href": tmpl.format(id=order["id"]), "method": method}
    return {**order, "_links": links}

@app.get("/")                                    # the ONLY URL a client should hard-code
def entry():
    return {"_links": {"orders": {"href": "/v1/orders"},
                       "customers": {"href": "/v1/customers"}}}

@app.get("/v1/orders/{oid}")
def get_order(oid: str):
    if oid not in ORDERS:
        raise HTTPException(404, "No such order")
    return with_links(ORDERS[oid])

@app.post("/v1/orders/{oid}/cancellation", status_code=201)
def cancel(oid: str):
    order = ORDERS.get(oid) or _404()
    if "cancel" not in TRANSITIONS.get(order["status"], {}):
        raise HTTPException(409, f"Cannot cancel an order in state {order['status']}")
    order["status"] = "cancelled"
    return with_links(order)

def _404():
    raise HTTPException(404, "No such order")
```

### A link-following client

```javascript
// Knows one URL and a set of link relation names — nothing about path structure.
async function follow(startUrl, rels, token) {
  let doc = await (await fetch(startUrl, { headers: auth(token) })).json();
  for (const rel of rels) {
    const link = doc._links?.[rel];
    if (!link) throw new Error(`relation '${rel}' not available in this state`);
    doc = await (await fetch(link.href, {
      method: link.method ?? "GET", headers: auth(token),
    })).json();
  }
  return doc;
}
const auth = (t) => ({ Authorization: `Bearer ${t}`, Accept: "application/json" });

// If the server later moves /v1/orders to /api/orders, this client does not change.
await follow("https://api.example.com/", ["orders"], token);
```

> **Optimization note.** The performance payoff of REST is almost entirely the **cacheable** and **layered** constraints, not hypermedia. Emitting `Cache-Control` + `ETag` on `GET` lets a CDN absorb read traffic; statelessness lets you add replicas linearly. Hypermedia has a real cost — payloads grow (a `_links` block can be 30–50% of a small resource) and clients make more round trips discovering their way. Mitigate with `Link` headers instead of body links where the client only needs navigation, URI templates (RFC 6570) so one link covers a family of URLs, and by embedding related resources (`_embedded` in HAL) to collapse round trips.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Statelessness** | Any replica serves any request; trivial horizontal scale, simple failover, high visibility | Auth and context re-sent every time; some workflows need an explicit resource (a cart, a job) instead of a session |
| **Uniform interface** | Generic intermediaries — CDNs, proxies, gateways, SDK generators — work with no per-API code | Deliberately not optimised for your case; over- and under-fetching are structural (this is GraphQL's opening) |
| **Cacheability** | Can remove the majority of origin read traffic; the biggest single performance lever | Correctness is subtle (`Vary`, `no-cache` vs `no-store`); stale data becomes a class of bug |
| **Layered system** | Gateways, WAFs, edge auth and legacy wrapping become possible | Each layer adds latency and a failure domain, and reduces end-to-end visibility |
| **Resource orientation** | Maps naturally to CRUD-shaped domains; URIs are readable and bookmarkable | Genuine *actions* (cancel, retry, transcode, send) fit awkwardly and need reification into resources |
| **HATEOAS** | Server owns the workflow; URIs become changeable; discoverability improves | Rarely adopted — clients hard-code paths anyway; larger payloads, more round trips, extra client complexity for benefits few teams realise |
| **Evolvability** | Additive changes and new media types can ship without breaking clients | Only if you enforce it: tolerant readers, no breaking renames, explicit deprecation policy |
| **Ubiquity of skills** | Every developer can call it with `curl`; enormous tooling ecosystem | "REST" is used so loosely that team agreement on what it means cannot be assumed |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Calling any JSON-over-HTTP endpoint "REST".** `POST /api/doThing` with `200 {"ok":false}` is Level 0 RPC in a REST costume, and it forfeits caching, retries and monitorability. ✅ Target Level 2 deliberately: resources, correct methods, correct status codes.
2. ⚠️ **Verbs in URIs** — `/getOrders`, `/orders/9/setStatus`, `/deleteUser`. ✅ Nouns identify; methods act. When you truly need an action, model it as a resource (`POST /orders/9/cancellation`, `POST /videos/9/transcodes`).
3. ⚠️ **Server-side sessions behind a REST API.** Sticky sessions break horizontal scaling, blue/green deploys and failover. ✅ Bearer tokens plus explicit resources for anything cart- or wizard-like.
4. ⚠️ **Treating "stateless" as "the server stores nothing".** ✅ Resource state on the server is required; it is *session* state that is forbidden. Know the difference before quoting the constraint in a review.
5. ⚠️ **Chasing Level 3 for its own sake.** Adding `_links` that no client ever follows is pure payload tax. ✅ Adopt hypermedia where it pays: workflow-heavy domains, long-lived clients you do not control, or pagination (`Link: rel="next"`), which is hypermedia everyone actually uses.
6. ⚠️ **Exposing database tables as resources.** Your schema becomes the public contract and every migration becomes a breaking change. ✅ Model the domain concepts consumers reason about; map explicitly to storage.
7. ⚠️ **Ignoring cacheability entirely.** Shipping `Cache-Control: no-store` everywhere "to be safe" discards the single largest performance constraint in the style. ✅ Classify endpoints, and use short `max-age` + `ETag` + `stale-while-revalidate` for anything read-heavy.
8. ⚠️ **Breaking clients with "small" changes** — renaming a field, tightening an enum, changing a default. ✅ Additive-only within a version; require tolerant readers (ignore unknown fields), and signal removals with `Deprecation` + `Sunset` (RFC 8594).
9. ⚠️ **Inventing per-endpoint error shapes.** ✅ One `application/problem+json` envelope (RFC 9457) across the whole API, with a stable `type` URI per problem class.
10. ⚠️ **Using `200` with an error body because "the HTTP call succeeded".** ✅ The status code describes the outcome of the *request*, not of the TCP connection.
11. ⚠️ **Uniform interface violations in the name of speed** — a `/batch` endpoint that tunnels arbitrary sub-requests, or a `POST /query` that takes SQL. ✅ If you genuinely need that shape, pick GraphQL or gRPC honestly rather than smuggling RPC through REST.
12. ⚠️ **Arguing about the word "REST" in design reviews.** ✅ Use the maturity model as shared vocabulary: "this is Level 1, let us get it to Level 2 and skip Level 3" is a decision; "that is not RESTful" is a fight.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

Because messages are self-descriptive, a single captured exchange should be enough to diagnose most issues — if it is not, something is stateful or context-dependent that should not be. Check for hidden state first: sticky sessions at the load balancer, in-memory caches that differ per replica, or auth context inferred from a cookie rather than the token. Reproduce with `curl` against an individual pod IP as well as the service address; behaviour differing between the two is proof of a statelessness violation.

### Monitoring

Measure by route template and status class, and add REST-specific signals: **cache effectiveness** (`304`:`200` ratio, CDN hit rate, `Age` distribution), **method mix** (a "REST" API that is 95% `POST` is Level 1 and probably losing all caching), **status-code distribution** (an API emitting only `200` and `500` is not using the uniform interface), and **link-follow rate** if you invested in hypermedia — if nobody follows links, stop paying for them. Track per-version and per-consumer traffic so deprecations are data-driven.

### Security

Statelessness moves the security burden into the token: use short-lived bearer tokens (OAuth 2.1 authorization code + PKCE for public clients), validate signature, issuer, audience and expiry on every request, and never infer identity from anything the client controls other than the credential. The layered constraint means authorization must be enforced at the origin as well as the gateway — defence in depth, since a request that bypasses the edge must still be safe. Apply object-level authorization on every resource access (OWASP API1: BOLA). Be careful that cacheable responses never contain per-user data without `private`/`no-store` and a correct `Vary`.

### Performance & scaling

Lean on the two constraints that actually pay: cacheability and statelessness. Classify every `GET` as public-cacheable, private-cacheable or uncacheable and set headers accordingly; use `stale-while-revalidate` so revalidation latency is invisible. Keep the service genuinely stateless so autoscaling is linear and rollouts need no draining. Bound and paginate every collection. Where hypermedia adds round trips, offer embedding or expansion so a client can fetch a graph in one call. Push slow operations into resources of their own (`POST /exports` → `202 Accepted` + a status URI) instead of holding a request open.

## 9. Interview Questions

**Q: What is REST, precisely?**
A: An architectural style defined by Roy Fielding in 2000 as a set of constraints — client–server, stateless, cacheable, uniform interface, layered system, and optionally code-on-demand — that together yield scalability, evolvability and visibility for distributed hypermedia systems. It is not a protocol, a spec or a data format; JSON over HTTP is neither necessary nor sufficient for an API to be RESTful.

**Q: Name the six constraints and one property each buys.**
A: Client–server (portability and independent evolution), stateless (visibility, reliability, horizontal scalability), cacheable (latency and efficiency), uniform interface (generality — intermediaries work everywhere), layered system (gateways, CDNs, encapsulation of legacy), and code-on-demand (client extensibility, optional because it reduces visibility).

**Q: Does "stateless" mean the server stores nothing?**
A: No. The server stores *resource* state — that is its purpose. What it must not keep is per-client *session* state such that a request can only be interpreted in light of previous ones. A cart in an `HttpSession` violates the constraint; the same cart exposed as `/carts/{id}` does not.

**Q: What is the difference between a resource and a representation?**
A: A resource is the named concept — "order ord_9F2", "today's weather in Pune" — and its identity is stable even as its value changes. A representation is one concrete serialisation of that resource's state at a point in time, with a media type and metadata like `ETag`. Clients transfer representations; they never manipulate the resource directly.

**Q: What is the Richardson Maturity Model?**
A: A four-level scale for how much of the Web's mechanics an API uses: Level 0 is one endpoint and one verb (RPC tunnelled through HTTP), Level 1 introduces many resource URIs, Level 2 adds proper HTTP methods and status codes, and Level 3 adds hypermedia controls. Most of the practical value — caching, safe retries, intermediary support — arrives at Level 2.

**Q: What is HATEOAS and why is it so rarely implemented?**
A: HATEOAS means the client discovers available transitions from links in responses instead of hard-coding URIs, so the server owns the workflow and can move URIs freely. It is rare because the benefit only materialises with generic link-following clients; hand-written clients still hard-code paths and need out-of-band knowledge of link relations and payloads, so teams pay the payload and complexity cost without collecting the evolvability benefit.

**Q: Is REST the same as CRUD over HTTP?**
A: No. CRUD-over-HTTP is a common *shape* of a Level 2 API, but REST says nothing about databases and plenty of RESTful designs are not CRUD — process resources like `POST /orders/9/cancellation` or `POST /exports` model actions as first-class resources. Conversely a CRUD API with server sessions and `200`-for-errors satisfies almost none of the constraints.

**Q: Why is the uniform interface described as a trade-off rather than a pure win?**
A: Because standardising the interface necessarily de-optimises it for any particular case: a generic representation is not the exact shape your screen needs, which produces over-fetching and under-fetching. Fielding says this explicitly — REST trades per-interaction efficiency for the enormous leverage of components that all speak one vocabulary.

**Q: (Senior) Fielding says most "REST APIs" are not RESTful. Is he right, and does it matter?**
A: He is right by his own definition — without hypermedia driving application state, the uniform interface constraint is only partly satisfied, and the resulting APIs couple clients to URI structure. Whether it matters is an engineering judgement: for a versioned API with a small number of SDKs you control, URI coupling is cheap to manage and Level 2 plus a disciplined deprecation policy delivers most of the value. It matters far more for long-lived, uncontrolled clients — embedded devices, third-party integrations that never update.

**Q: (Senior) How would you decide whether to invest in Level 3 hypermedia?**
A: Ask three questions: do I control my clients' release cycle (if yes, hypermedia's evolvability buys little); is the domain workflow-heavy with state-dependent permitted actions (if yes, server-driven affordances remove real duplicated logic); and will anything actually follow the links (if not, it is payload tax). A pragmatic middle path is partial adoption — `Link` headers for pagination, an entry-point document, and state-dependent action links on workflow resources only.

**Q: (Senior) Where does statelessness break down in practice, and how do you handle it?**
A: It breaks down for multi-step wizards, long-running operations, streaming, and anything needing server-side continuation. The REST-consistent answer is to reify the state as a resource: a `checkout_session`, a `job` returning `202 Accepted` with a status URI, or an export resource the client polls or subscribes to via webhook. What you must avoid is a hidden session keyed by cookie with sticky routing, because that reintroduces server affinity and defeats the scalability the constraint was buying.

**Q: (Senior) A team wants a `POST /graphql`-style endpoint inside their REST API for one screen. What do you advise?**
A: Name the trade honestly rather than smuggling it in. A single opaque `POST` endpoint is Level 0: it is uncacheable, invisible to intermediaries, hard to rate-limit meaningfully and hard to monitor by operation. If the driver is over-fetching on one aggregate screen, the cheaper fixes are a purpose-built BFF resource, field selection (`?fields=`) or embedding. If the driver is systemic client-shaped querying across many screens, adopt GraphQL deliberately as a separate, properly operated surface — with depth limits, persisted queries and its own caching strategy.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** REST is an architectural style from Fielding's 2000 dissertation, defined by six constraints: **client–server**, **stateless**, **cacheable**, **uniform interface**, **layered system**, and optional **code-on-demand**. The uniform interface has four parts — identify resources by URI, manipulate them through representations, use self-descriptive messages, and use hypermedia as the engine of application state. Stateless forbids *session* state on the server, not resource state. The constraints buy scalability, visibility and evolvability, and cost per-interaction efficiency and some latency per layer. The **Richardson Maturity Model** grades adoption: Level 0 (one endpoint, RPC), Level 1 (resources), Level 2 (methods + status codes — where the practical payoff is), Level 3 (hypermedia). Most production APIs are Level 2 and that is a defensible engineering choice, provided you take the caching and statelessness constraints seriously and manage change with versioning and deprecation.

| Item | Value |
|---|---|
| Source | Fielding dissertation (2000), Chapter 5 |
| Required constraints | client–server, stateless, cacheable, uniform interface, layered |
| Optional constraint | code-on-demand |
| Uniform interface sub-constraints | resource identification · manipulation via representations · self-descriptive messages · HATEOAS |
| RMM Level 0 / 1 / 2 / 3 | one endpoint · resources · verbs + status codes · hypermedia |
| Statelessness forbids | server-side **session** state (not resource state) |
| Biggest practical payoff | Level 2 + correct caching |
| Hypermedia in the wild | `Link: <...>; rel="next"`, HAL `_links`, JSON:API `links` |
| Action modelled RESTfully | `POST /orders/9/cancellation` (a process resource), not `POST /cancelOrder` |
| Error format | `application/problem+json` (RFC 9457) |
| Deprecation signalling | `Deprecation` header + `Sunset` (RFC 8594) |

**Flash cards**
- **The six constraints** → client–server, stateless, cacheable, uniform interface, layered system, code-on-demand (optional).
- **What does "stateless" forbid?** → Server-side *session* state; resource state is required and fine.
- **Richardson Level 2 means** → Many resource URIs plus correct HTTP methods and status codes — the level with most of the value.
- **What is HATEOAS for?** → Letting the server own the workflow and change URIs freely, because clients follow links instead of hard-coding paths.
- **Resource vs representation** → The resource is the named concept with stable identity; the representation is one serialisation of its state right now.

## 11. Hands-On Exercises & Mini Project

- [ ] Take an existing API you work on and score every endpoint on the Richardson scale. Count how many are Level 0/1 in disguise (verbs in the path, `POST` for reads, `200` for errors).
- [ ] Find the three highest-traffic `GET` endpoints and add `ETag` + `Cache-Control`. Measure the change in origin requests and p99 latency over a day.
- [ ] Rewrite one action-shaped endpoint (`POST /orders/cancel`) as a process resource (`POST /orders/{id}/cancellation`) and enumerate which status codes it should now return: `201`, `404`, `409`, `412`, `422`.
- [ ] Hunt for hidden session state: grep for session middleware and sticky-session configuration, then prove statelessness by sending consecutive requests to two different pods directly.
- [ ] Build the Level 3 FastAPI example from §5 and write a client that only knows `/` and the relation names — then rename every internal path and confirm the client still passes.

### Mini Project — "Two APIs, One Domain"

**Goal.** Implement the same small domain twice — once at Level 0/1 and once at Level 2/3 — and measure the difference instead of arguing about it.

**Requirements.**
1. Domain: `articles` with a lifecycle `draft → in_review → published → archived`, plus comments as a sub-resource.
2. **Version A (Level 1):** `POST /api` with an operation field; always `200`; no caching headers.
3. **Version B (Level 2):** proper URIs and methods; `201` + `Location` on create, `204` on delete, `409` on illegal transitions, `412` on stale `If-Match`; `ETag` + `Cache-Control` on all reads.
4. Put the same caching proxy in front of both and measure origin requests, bytes transferred and p99 latency for an identical read-heavy workload.
5. Write one generic client that retries on `429`/`5xx` and refreshes on `401`, and document exactly why it cannot work against Version A.

**Extensions.**
- Promote Version B to Level 3 with state-dependent `_links` and an entry-point document; write a link-following client and then move every URI to prove it survives.
- Add `Link: rel="next"` pagination and compare client code complexity against `?page=` URL construction.
- Publish an OpenAPI 3.1 document for Version B and generate a client from it; try the same for Version A and record why the generated client is useless.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is an API? Web APIs & Clients* (the contract mindset this style serves), *HTTP Fundamentals for API Builders* (the protocol the constraints are expressed in), *REST vs GraphQL, gRPC & SOAP* (what you give up and gain by leaving the style), *Resource Modeling & URI Design* (doing Level 1 and 2 well), *HTTP Methods, Safety & Idempotency* (the mechanics behind the uniform interface).

- **Architectural Styles and the Design of Network-based Software Architectures** — Roy T. Fielding, 2000 · *Advanced* · the primary source; Chapter 5 derives REST constraint by constraint and is far more readable than its reputation suggests. <https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm>
- **REST APIs must be hypertext-driven** — Roy T. Fielding, 2008 · *Intermediate* · the short, blunt blog post where Fielding explains what he means by HATEOAS and why most APIs do not qualify. <https://roy.gbiv.com/untangled/2008/rest-apis-must-be-hypertext-driven>
- **Richardson Maturity Model** — Martin Fowler · *Beginner* · the canonical explanation of the four levels with worked examples; the fastest way to give a team shared vocabulary. <https://martinfowler.com/articles/richardsonMaturityModel.html>
- **RFC 9110 — HTTP Semantics** — IETF, 2022 · *Intermediate* · the uniform interface as actually specified: method properties, status codes, conditional requests, content negotiation. <https://www.rfc-editor.org/rfc/rfc9110.html>
- **Google API Design Guide — Resource-Oriented Design** — Google · *Intermediate* · a rigorous, opinionated take on modelling resources and standard methods at Level 2, plus how to handle genuine custom actions. <https://cloud.google.com/apis/design/resources>
- **Zalando RESTful API and Event Guidelines** — Zalando · *Intermediate* · a large real-world rulebook with explicit MUST/SHOULD rules on REST maturity, hypermedia, pagination and compatibility. <https://opensource.zalando.com/restful-api-guidelines/>
- **JSON:API Specification** — jsonapi.org · *Intermediate* · a concrete, widely used media type showing what disciplined Level 3 looks like: links, relationships, sparse fieldsets and pagination all standardised. <https://jsonapi.org/format/>
- **HAL — Hypertext Application Language** — Mike Kelly / IETF draft · *Beginner* · the simplest practical hypermedia format (`_links`, `_embedded`); useful for adding hypermedia incrementally to an existing JSON API. <https://stateless.co/hal_specification.html>

---

*REST API Handbook — chapter 03.*
