# 21 · Authorization: RBAC, ABAC & Scopes

> **In one line:** Authentication asks *who are you*, scopes ask *what may this client do at all*, and authorization asks *may this specific principal perform this specific action on this specific object right now* — and skipping that last question is the single most exploited flaw in APIs.

---

## 1. Overview

Authorization is the part of API security that no framework can do for you. A signature check is universal — every JWT is validated the same way. But "may Alice void invoice `inv_9f2`?" depends on your product's domain model, your tenancy story, your org hierarchy and your compliance rules. That irreducible business-specificity is exactly why **Broken Object Level Authorization (BOLA)** has sat at #1 in the OWASP API Security Top 10 in both 2019 and 2023: the check is easy to describe, easy to forget, and invisible in a passing test suite that only ever uses one account.

The problem it solves is *lateral access*. Once a system has more than one tenant, more than one user, or more than one privilege level, every endpoint becomes a potential pivot. `GET /v1/invoices/9f2` authenticates fine with Bob's perfectly valid token; the only thing standing between Bob and Alice's invoice is a `WHERE tenant_id = ?` clause somebody remembered to write. Attackers do not need clever payloads — they enumerate identifiers. The 2021 Peloton and 2019 Uber API incidents, and countless bug-bounty reports, are all the same shape: a valid session plus somebody else's object ID.

The models evolved in a clear line. **ACLs** (per-object lists of who may do what) came first and do not scale organisationally. **RBAC** (NIST, formalised in the 1992 Ferraiolo–Kuhn model and later ANSI INCITS 359-2004) introduced roles as an indirection between users and permissions, which is why it dominates enterprise software. **ABAC** (NIST SP 800-162, 2014) generalised further: decisions are a function over attributes of subject, object, action and environment, letting you express "a nurse may read a chart *if* they are on the patient's care team *and* it is during their shift" without inventing a role per combination. **ReBAC** — relationship-based access control, popularised by Google's Zanzibar paper (2019) and its open-source descendants — models authorization as a graph of tuples (`document:roadmap#viewer@group:eng#member`) and answers "is there a path?" at global scale.

A concrete example: **GitHub**. A token has *scopes* (`repo`, `read:org`) — a ceiling set at OAuth consent time. Inside that ceiling, GitHub applies *roles* (read, triage, write, maintain, admin) per repository, inherited from organisation and team membership, then *attributes* (is the repo private? is the branch protected? is the actor an outside collaborator?), then organisation-level policies (SAML session must be active, IP allow-list must match). Five distinct layers, all of which must pass. Notably, GitHub returns **404, not 403**, when you request a private repository you cannot see — because a `403` would confirm the repository exists.

The durable mental model: **scopes attenuate the client, roles attenuate the user, policies decide the action, and object-level checks decide the row.** All four, every request. Miss the last one and you have shipped API1:2023.

---

## 2. Core Concepts

- **Authentication vs authorization** — authn establishes identity (`401` when it fails); authz decides permission (`403` when it fails). Different failures, different status codes, different fixes.
- **Scope** — an OAuth-level ceiling on what a *client application* may request on the user's behalf (`invoices:read`). Coarse, user-visible at consent time, and never sufficient on its own.
- **Permission** — an atomic capability in your domain: `invoice.void`, `user.invite`, `report.export`. The thing you actually check.
- **Role** — a named bundle of permissions (`billing_admin`). An indirection that lets you change what a job function can do without touching users.
- **RBAC** — access determined by the roles assigned to a subject. Optionally hierarchical (roles inherit) and constrained (separation of duty).
- **ABAC** — access determined by a boolean function over attributes of subject, resource, action and environment (time, IP, device posture, data classification).
- **ReBAC** — access determined by relationships in a graph (`user → member → team → editor → doc`), the Zanzibar model. Excellent for sharing and nesting.
- **BOLA / IDOR** — Broken Object Level Authorization: the endpoint checks *that* you are authenticated but not *whether this object is yours*. OWASP API1:2023.
- **BFLA** — Broken Function Level Authorization: an ordinary user can call an admin function because the route was never guarded. OWASP API5:2023.
- **PDP / PEP** — Policy Decision Point (evaluates the rule) and Policy Enforcement Point (calls the PDP and enforces the answer). Separating them is what makes policy auditable.
- **Deny by default** — the absence of an explicit grant is a denial. The only safe default, and the one most middleware gets wrong.

---

## 3. Theory & Principles

**The four-layer model.** Every authorized request passes four gates in a fixed order, and each answers a different question:

| Layer | Question | Failure |
|---|---|---|
| Authentication | Is the token valid and unexpired? | `401` |
| Scope (client) | Was this client granted this capability class? | `403 insufficient_scope` |
| Function (route) | May this role invoke this operation at all? | `403` |
| Object (row) | Does this principal have a relationship to *this* resource? | `403` or `404` |

Collapsing layers is where bugs live. Scope is not a role: `invoices:read` says the *client app* may read invoices, not that *this user* may read *that* invoice. A role is not an object check: `billing_admin` in tenant A is not `billing_admin` in tenant B.

**Deny by default, and the closed-world assumption.** Formally, authorization is a predicate `permit(subject, action, object, env) → bool` and the safe base case is `false`. An allow-list of guarded routes fails open for every route you forget; a middleware that denies unless a route explicitly declares its permission fails closed. Express this structurally: make the *absence* of a permission declaration a startup error, not a runtime permit.

**RBAC formally.** RBAC assigns `UA ⊆ Users × Roles` and `PA ⊆ Permissions × Roles`; a user's effective permission set is `⋃ {p : (p, r) ∈ PA, (u, r) ∈ UA}`. With `n` users, `m` permissions and `k` roles, direct assignment costs `O(n·m)` relationships while RBAC costs `O(n·k + k·m)` — the reason RBAC wins organisationally is combinatorial, not conceptual. Hierarchical RBAC adds a partial order on roles (`admin ≥ editor ≥ viewer`) so inheritance is transitive; static separation of duty forbids assigning mutually exclusive roles (a user cannot be both `payment_initiator` and `payment_approver`).

**RBAC's failure mode is role explosion.** The moment permissions depend on context — region, project, data classification, time — pure RBAC forces a role per combination: `billing_admin_eu_readonly_q4`. When you see roles with more than two qualifiers in the name, you have outgrown RBAC and should move context into attributes.

**ABAC formally.** ABAC evaluates a policy `P(S, R, A, E)` over subject, resource, action and environment attributes. Expressiveness costs decidability of *reverse* queries: with RBAC, "list everything Alice can see" is a join; with rich ABAC it can require evaluating the policy against every object. That is why real systems compile ABAC policies into **filters** — the policy engine returns a SQL predicate rather than a boolean, so list endpoints stay indexable.

**ReBAC and Zanzibar.** Relationship tuples `object#relation@subject` plus userset rewrite rules express nesting and sharing naturally, and the check becomes a bounded graph traversal. The trade-off is consistency: Zanzibar introduced *zookies* (consistency tokens) because a stale authorization cache can leak a document that was just unshared. This is the "new enemy problem" — reordering ACL updates relative to content updates causes real disclosure.

```svg
<svg viewBox="0 0 780 330" width="100%" height="330" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="330" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Four gates: every request passes all four, in order</text>
  <rect x="18" y="44" width="176" height="88" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="66" font-size="12" font-weight="700" fill="#1e293b">1. AUTHENTICATION</text>
  <text x="34" y="86" font-size="10" fill="#1e293b">signature, iss, aud, exp</text>
  <text x="34" y="102" font-size="10" fill="#1e293b">who is the principal?</text>
  <text x="34" y="122" font-size="11" font-weight="700" fill="#4f46e5">fail &#8594; 401</text>
  <rect x="206" y="44" width="176" height="88" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="222" y="66" font-size="12" font-weight="700" fill="#1e293b">2. SCOPE</text>
  <text x="222" y="86" font-size="10" fill="#1e293b">invoices:write present?</text>
  <text x="222" y="102" font-size="10" fill="#1e293b">client ceiling, not user</text>
  <text x="222" y="122" font-size="11" font-weight="700" fill="#0ea5e9">fail &#8594; 403 scope</text>
  <rect x="394" y="44" width="176" height="88" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="410" y="66" font-size="12" font-weight="700" fill="#1e293b">3. FUNCTION</text>
  <text x="410" y="86" font-size="10" fill="#1e293b">role grants invoice.void?</text>
  <text x="410" y="102" font-size="10" fill="#1e293b">route level, BFLA gate</text>
  <text x="410" y="122" font-size="11" font-weight="700" fill="#16a34a">fail &#8594; 403</text>
  <rect x="582" y="44" width="180" height="88" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="598" y="66" font-size="12" font-weight="700" fill="#1e293b">4. OBJECT</text>
  <text x="598" y="86" font-size="10" fill="#1e293b">invoice.tenant == token</text>
  <text x="598" y="102" font-size="10" fill="#1e293b">row level, BOLA gate</text>
  <text x="598" y="122" font-size="11" font-weight="700" fill="#d97706">fail &#8594; 403 or 404</text>
  <line x1="194" y1="88" x2="202" y2="88" stroke="#1e293b" stroke-width="2"/>
  <line x1="382" y1="88" x2="390" y2="88" stroke="#1e293b" stroke-width="2"/>
  <line x1="570" y1="88" x2="578" y2="88" stroke="#1e293b" stroke-width="2"/>
  <rect x="18" y="152" width="744" height="72" rx="10" fill="#ffffff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="174" font-size="13" font-weight="700" fill="#1e293b">Model selection</text>
  <text x="34" y="194" font-size="11" fill="#1e293b">RBAC: roles bundle permissions. O(n*k + k*m) instead of O(n*m). Breaks when context enters the role name.</text>
  <text x="34" y="212" font-size="11" fill="#1e293b">ABAC: predicate over subject/resource/action/environment. Expressive, but reverse queries are hard.</text>
  <rect x="18" y="238" width="744" height="76" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="260" font-size="13" font-weight="700" fill="#1e293b">The list-endpoint trick</text>
  <text x="34" y="280" font-size="11" fill="#1e293b">Do not fetch 10,000 rows and filter in memory. Have the PDP return a FILTER, not a boolean:</text>
  <text x="34" y="300" font-size="11" font-weight="700" fill="#1e293b">decide(subject, "invoice.read") &#8594; WHERE tenant_id = 'ten_42' AND region IN ('eu')</text>
</svg>
```

---

## 4. Architecture & Workflow

The reference architecture separates **decision** from **enforcement** (the NIST PDP/PEP split). Numbered flow for `POST /v1/invoices/inv_9f2/void`:

1. **Edge.** The gateway terminates TLS, validates the JWT signature and `exp`, and rejects anonymous traffic. It may enforce coarse scope, but it must not be the only enforcement point — internal callers bypass it.
2. **Principal construction.** The service builds an immutable `Principal` from verified claims: `user_id`, `tenant_id`, `roles`, `scopes`, plus environment (`ip`, `mfa_at`, `client_id`). Nothing here comes from the request body or a client-supplied header.
3. **Scope gate.** Middleware checks the route's declared required scope against `claims.scope`. Missing → `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="invoices:write"`.
4. **Function gate.** The route declares `requires_permission("invoice.void")`. The PEP asks the PDP whether the principal's roles grant it *in this tenant*. Missing → `403`. A route with **no** declaration fails startup validation — that is the structural BFLA defence.
5. **Object load with tenancy predicate.** The repository layer fetches by `(id, tenant_id)` — never by `id` alone. This is the single most important line of code in the request. If the row does not exist *for this tenant*, the query returns nothing.
6. **Object gate / policy evaluation.** The PDP evaluates the full policy with the loaded resource's attributes: `invoice.status == 'open'`, `invoice.amount <= principal.approval_limit`, `principal.mfa_at > now - 15m` for high-value voids, `resource.region ∈ principal.allowed_regions`.
7. **Response shaping.** Denials on *existence-sensitive* resources return `404` (do not confirm the object exists to someone with no relationship to it). Denials on resources the caller can see but not act on return `403` with a machine-readable reason.
8. **Field-level filtering.** The serializer drops fields the principal may not see (`internal_notes`, `cost_basis`) based on the same policy — response shaping is authorization too, and skipping it is Excessive Data Exposure.
9. **Audit.** Emit a structured decision log: `{principal, action, object, decision, policy_version, reason, request_id}` for both permits and denies. Auditors want permits; incident response wants denies.
10. **Cache with care.** Decisions may be cached for seconds keyed by `(principal_version, object_version, action)`. Any role or relationship change bumps `principal_version`, invalidating instantly.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="350" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">PEP / PDP flow for POST /v1/invoices/inv_9f2/void</text>
  <rect x="18" y="44" width="120" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="42" y="66" font-size="12" font-weight="700" fill="#1e293b">Client</text>
  <text x="30" y="84" font-size="10" fill="#1e293b">Bearer token</text>
  <rect x="176" y="44" width="120" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="198" y="66" font-size="12" font-weight="700" fill="#1e293b">Gateway</text>
  <text x="186" y="84" font-size="10" fill="#1e293b">sig + exp + scope</text>
  <rect x="334" y="44" width="132" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="356" y="66" font-size="12" font-weight="700" fill="#1e293b">Service (PEP)</text>
  <text x="344" y="84" font-size="10" fill="#1e293b">builds Principal</text>
  <rect x="504" y="44" width="120" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="530" y="66" font-size="12" font-weight="700" fill="#1e293b">PDP</text>
  <text x="514" y="84" font-size="10" fill="#1e293b">policy engine</text>
  <rect x="662" y="44" width="100" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="686" y="66" font-size="12" font-weight="700" fill="#1e293b">Store</text>
  <text x="670" y="84" font-size="10" fill="#1e293b">tenant scoped</text>
  <line x1="138" y1="70" x2="172" y2="70" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="176,70 168,66 168,74" fill="#0ea5e9"/>
  <line x1="296" y1="70" x2="330" y2="70" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="334,70 326,66 326,74" fill="#4f46e5"/>
  <line x1="466" y1="70" x2="500" y2="70" stroke="#16a34a" stroke-width="2"/>
  <polygon points="504,70 496,66 496,74" fill="#16a34a"/>
  <line x1="624" y1="70" x2="658" y2="70" stroke="#d97706" stroke-width="2"/>
  <polygon points="662,70 654,66 654,74" fill="#d97706"/>
  <rect x="18" y="116" width="744" height="118" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="138" font-size="13" font-weight="700" fill="#1e293b">Decision input assembled by the PEP</text>
  <text x="34" y="160" font-size="11" fill="#1e293b">subject: {user_id: usr_8f21, tenant_id: ten_42, roles: [billing_admin], mfa_at: 2026-07-22T09:02Z}</text>
  <text x="34" y="180" font-size="11" fill="#1e293b">action:  invoice.void</text>
  <text x="34" y="200" font-size="11" fill="#1e293b">resource: {id: inv_9f2, tenant_id: ten_42, status: open, amount_cents: 480000, region: eu}</text>
  <text x="34" y="220" font-size="11" fill="#1e293b">environment: {ip: 203.0.113.7, time: 09:14Z, client_id: app_web_prod}</text>
  <rect x="18" y="250" width="360" height="86" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="272" font-size="12" font-weight="700" fill="#1e293b">PERMIT</text>
  <text x="34" y="292" font-size="10" fill="#1e293b">204 No Content, audit log written</text>
  <text x="34" y="310" font-size="10" fill="#1e293b">reason: role billing_admin + amount &lt;= limit</text>
  <text x="34" y="328" font-size="10" fill="#1e293b">policy_version: v2026.07.14</text>
  <rect x="402" y="250" width="360" height="86" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="418" y="272" font-size="12" font-weight="700" fill="#1e293b">DENY</text>
  <text x="418" y="292" font-size="10" fill="#1e293b">wrong tenant &#8594; 404 (do not confirm existence)</text>
  <text x="418" y="310" font-size="10" fill="#1e293b">right tenant, no permission &#8594; 403 + reason code</text>
  <text x="418" y="328" font-size="10" fill="#1e293b">stale MFA &#8594; 403 step_up_required</text>
</svg>
```

---

## 5. Implementation

**Declarative permission binding (FastAPI). The key property: a route with no declaration cannot start.**

```python
from dataclasses import dataclass
from fastapi import FastAPI, Depends, HTTPException, Request

@dataclass(frozen=True)
class Principal:
    user_id: str; tenant_id: str
    roles: frozenset[str]; scopes: frozenset[str]
    approval_limit_cents: int; mfa_at: float

ROLE_PERMS = {
    "viewer":        {"invoice.read"},
    "billing_agent": {"invoice.read", "invoice.create"},
    "billing_admin": {"invoice.read", "invoice.create", "invoice.void", "invoice.refund"},
}

def principal(request: Request) -> Principal:
    c = request.state.claims                      # set by verified-JWT middleware
    return Principal(c["sub"], c["tenant_id"],
                     frozenset(c.get("roles", [])), frozenset(c["scope"].split()),
                     c.get("approval_limit_cents", 0), c.get("auth_time", 0))

def requires(permission: str, scope: str):
    def dep(p: Principal = Depends(principal)) -> Principal:
        if scope not in p.scopes:
            raise HTTPException(403, "insufficient_scope", headers={
                "WWW-Authenticate": f'Bearer error="insufficient_scope", scope="{scope}"'})
        granted = set().union(*(ROLE_PERMS.get(r, set()) for r in p.roles)) if p.roles else set()
        if permission not in granted:
            raise HTTPException(403, f"missing permission {permission}")
        return p
    return dep
```

**The object-level check — the line that prevents BOLA:**

```python
@app.post("/v1/invoices/{invoice_id}/void", status_code=204)
async def void_invoice(invoice_id: str,
                       p: Principal = Depends(requires("invoice.void", "invoices:write"))):
    # ALWAYS scope the read by tenant. Never SELECT ... WHERE id = :id alone.
    inv = await db.fetch_one(
        "SELECT id, status, amount_cents, region FROM invoices "
        "WHERE id = :id AND tenant_id = :tid", {"id": invoice_id, "tid": p.tenant_id})
    if inv is None:
        raise HTTPException(404, "invoice not found")      # do not leak existence
    if inv["status"] != "open":
        raise HTTPException(409, "invoice is not open")
    if inv["amount_cents"] > p.approval_limit_cents:
        raise HTTPException(403, "amount exceeds your approval limit")
    if time.time() - p.mfa_at > 900:
        raise HTTPException(403, "step-up authentication required")
    await db.execute("UPDATE invoices SET status='void' WHERE id=:id AND tenant_id=:tid",
                     {"id": invoice_id, "tid": p.tenant_id})
```

**Wire-level: the three distinguishable outcomes.**

```http
POST /v1/invoices/inv_9f2/void HTTP/1.1
Host: api.acme.io
Authorization: Bearer eyJhbGciOiJFUzI1NiJ9...
```

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{
  "type": "https://api.acme.io/problems/insufficient-permission",
  "title": "Permission denied",
  "status": 403,
  "detail": "Voiding an invoice requires the invoice.void permission",
  "required_permission": "invoice.void",
  "request_id": "req_01J8Z4K7"
}
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json

{ "type": "https://api.acme.io/problems/not-found", "title": "Invoice not found",
  "status": 404, "detail": "No invoice with that id is visible to your account" }
```

**Filter-pushdown for list endpoints (the correct way to avoid N policy evaluations):**

```python
def visibility_filter(p: Principal) -> tuple[str, dict]:
    clauses, params = ["tenant_id = :tid"], {"tid": p.tenant_id}
    if "billing_admin" not in p.roles:
        clauses.append("created_by = :uid"); params["uid"] = p.user_id
    if p.allowed_regions:
        clauses.append("region = ANY(:regions)"); params["regions"] = list(p.allowed_regions)
    return " AND ".join(clauses), params

@app.get("/v1/invoices")
async def list_invoices(p: Principal = Depends(requires("invoice.read", "invoices:read")),
                        limit: int = 50, cursor: str | None = None):
    where, params = visibility_filter(p)
    rows = await db.fetch_all(
        f"SELECT id, amount_cents, status FROM invoices WHERE {where} "
        f"AND (:cur::text IS NULL OR id > :cur) ORDER BY id LIMIT :lim",
        {**params, "cur": cursor, "lim": min(limit, 100)})
    return {"data": rows, "next_cursor": rows[-1]["id"] if len(rows) == limit else None}
```

**Policy as code (Open Policy Agent / Rego) when rules outgrow if-statements:**

```rego
package invoices

default allow := false

allow if {
  input.action == "invoice.void"
  input.resource.tenant_id == input.subject.tenant_id
  "invoice.void" in data.roles[input.subject.roles[_]]
  input.resource.status == "open"
  input.resource.amount_cents <= input.subject.approval_limit_cents
  time.now_ns() - input.subject.mfa_at_ns < 900000000000
}
```

**OpenAPI 3.1 documenting the contract:**

```yaml
paths:
  /v1/invoices/{invoiceId}/void:
    post:
      security: [{ oauth2: [invoices:write] }]
      x-required-permission: invoice.void
      responses:
        '204': { description: Invoice voided }
        '403': { description: Missing scope or permission, or step-up required }
        '404': { description: Not visible to this tenant }
        '409': { description: Invoice is not in an open state }
```

**Optimization note.** Authorization must not add a round trip per request. Three techniques: (1) **embed low-cardinality facts in the token** — `tenant_id`, `roles`, `approval_limit` — so the common case is pure CPU, and keep TTLs short so revocation is bounded; (2) **push filters into the query** rather than evaluating policy per row — a list endpoint that loads 10,000 rows to keep 12 is both slow and a data-exposure risk if the filter is ever skipped; (3) **cache decisions keyed by `(principal_version, resource_version, action)`** with a 5–30 s TTL, bumping `principal_version` on any role or membership change. For ReBAC, batch checks (`BatchCheck` / `expand`) so rendering a list of 50 documents is one call, not 50, and remember Zanzibar's lesson: cache staleness in authorization is a disclosure bug, so bound it explicitly with a consistency token.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Scopes | User-visible consent boundary; enforced cheaply at the gateway | Far too coarse for rows; scope explosion when misused as permissions |
| RBAC | Simple to reason about, easy to audit, matches org charts, fast to evaluate | Role explosion once context matters; awkward for per-object sharing |
| ABAC | Expresses context (time, region, classification) without new roles | Hard to answer "what can Alice see?"; policies drift into unreadable rules |
| ReBAC / Zanzibar | Natural sharing, nesting and inheritance; scales to billions of tuples | Operationally heavy; consistency (stale-cache disclosure) becomes your problem |
| Policy engine (OPA/Cedar) | Policy is versioned, testable, and separable from app code | Extra deployment, latency budget, and a second language for the team |
| In-code checks | Zero latency, trivially debuggable, no new infrastructure | Rules scatter across the codebase; auditing means reading every handler |
| Centralised PDP | One place to audit, change and test policy | New tier-0 dependency; must cache or co-locate to survive its outage |
| 404 instead of 403 | Does not confirm existence of hidden resources | Harder support debugging; needs correlated audit logs to explain to users |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Fetching by ID alone: `SELECT * FROM invoices WHERE id = :id`.** → ✅ Always include the tenancy/ownership predicate: `WHERE id = :id AND tenant_id = :tid`. This is BOLA in one line, and it is OWASP API1:2023.
2. ⚠️ **Treating scopes as permissions.** → ✅ Scope is the *client's* ceiling; roles and object checks decide the user's actual access. A token with `invoices:read` must still be blocked from another tenant's invoices.
3. ⚠️ **Guarding routes with an allow-list of "admin paths".** → ✅ Deny by default: every route declares its required permission, and an undeclared route fails CI or startup. Forgotten routes are BFLA (API5:2023).
4. ⚠️ **Relying on the UI to hide actions.** → ✅ The client is a suggestion. Every hidden button corresponds to an endpoint an attacker will call directly with `curl`.
5. ⚠️ **Trusting client-supplied identity: `X-User-Id`, `?tenant_id=`, or a `role` field in the body.** → ✅ Derive every authorization input from verified token claims or a server-side lookup. Never from user-controllable input.
6. ⚠️ **Mass assignment on update: binding the whole request body to the model.** → ✅ Explicit allow-lists of writable fields per role. Otherwise `PATCH /users/me {"role":"admin"}` is a privilege escalation (API6:2023).
7. ⚠️ **Returning `403` for objects the caller shouldn't know exist.** → ✅ Use `404` for existence-sensitive resources (GitHub's model), and reserve `403` for "you can see it, you can't do that to it".
8. ⚠️ **Checking permission on `GET` but not on the sibling `PUT`/`DELETE`, or on the REST route but not the GraphQL/gRPC/batch one.** → ✅ Enforce in the service layer that all transports share, not in per-route handlers.
9. ⚠️ **Filtering in application memory after an unfiltered query.** → ✅ Push the predicate into the query. In-memory filtering is a performance problem *and* one refactor away from leaking everything.
10. ⚠️ **Ignoring field-level authorization.** → ✅ Serialize per-role: `cost_basis`, `internal_notes` and `ssn_last4` must be stripped for lower-privilege viewers, not just hidden in the UI.
11. ⚠️ **No audit trail for permits.** → ✅ Log every decision with principal, action, object, outcome, reason and `policy_version`. Denies help incident response; permits are what auditors and forensics need.
12. ⚠️ **Testing with a single account.** → ✅ Every test suite needs at least two tenants and three privilege levels, with an automated cross-tenant probe asserting `404`/`403` on every object endpoint.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Make every denial *explainable*. Return a stable machine-readable reason code (`insufficient_permission`, `wrong_tenant`, `step_up_required`, `policy_denied`) alongside the human `detail`, and log the full decision input at debug level behind a flag. Provide an internal `POST /internal/authz/explain` endpoint that takes `{subject, action, resource}` and returns the evaluated policy trace — the single highest-leverage tool for support, because "why can't Alice see this?" is otherwise archaeology. Never expose the trace to end users; it describes your policy structure.

**Monitoring.** Track `authz_decisions_total{action,decision,reason}` — a sudden spike in `deny{reason="wrong_tenant"}` from one principal is enumeration in progress. Watch `authz_decision_duration_seconds` p99 (a centralised PDP creeping into your latency budget), the ratio of `403` to `200` per client, `404` rate on ID-shaped paths per principal (BOLA probing looks like a burst of 404s across many IDs), and policy-version drift across services. Alert on: any principal exceeding N distinct denied object IDs in a window; any deploy where a route's declared permission changed without a policy review; any service falling back to a cached policy bundle for longer than the SLO.

**Security.** Enforce authorization in the service layer so REST, GraphQL, gRPC, batch jobs and admin tooling share one path. Use unguessable identifiers (UUIDv7 or ULID) so enumeration is expensive — but treat that strictly as defence in depth, never as the control. Apply step-up authentication (`auth_time`/`acr` claims) for destructive or high-value actions. Implement separation of duty for money movement (initiator ≠ approver) and enforce it in the policy, not the UI. Review role assignments quarterly with an access-recertification report, and make cross-tenant isolation tests a merge gate. For multi-tenant SQL, consider PostgreSQL row-level security as a backstop so a forgotten `WHERE` clause fails closed at the database.

**Performance & scaling.** Keep the hot path CPU-only: token claims plus an in-process role→permission map handle 95% of checks in microseconds. Reserve the remote PDP for genuinely dynamic policy, and co-locate it as a sidecar (OPA's typical deployment) so a network partition does not take your API down — bundle-distributed policy with a local evaluator gives you central authorship and local latency. For ReBAC, watch the tuple-store fan-out: deeply nested groups turn one check into a wide traversal, so cap depth and denormalise hot paths. Cache decisions briefly and version the cache key on principal and resource so an unshare takes effect within seconds, not minutes.

---

## 9. Interview Questions

**Q: What is the difference between authentication, scopes and authorization?**
A: Authentication proves identity and fails with `401`. Scopes are an OAuth-level ceiling on what the *client application* may attempt on the user's behalf. Authorization decides whether *this principal* may perform *this action* on *this object*, and fails with `403` (or `404` when existence itself is sensitive).

**Q: What is BOLA and why is it #1 in the OWASP API Security Top 10?**
A: Broken Object Level Authorization is when an endpoint authenticates the caller but never checks that the requested object belongs to them — `GET /invoices/{id}` returning any invoice to any logged-in user. It is #1 because the check is per-endpoint, per-object and business-specific, so no framework provides it by default and single-account test suites never catch it.

**Q: When does RBAC stop being enough?**
A: When context enters the role name. Roles like `billing_admin_eu_readonly` signal that region, data classification or time are really attributes, and you need ABAC (or ReBAC for sharing relationships) instead of a combinatorial explosion of roles.

**Q: How do you enforce authorization on a list endpoint without evaluating policy per row?**
A: Push the policy down into the query as a filter predicate rather than returning a boolean per object. The PDP returns a `WHERE` clause (`tenant_id = ? AND region = ANY(?)`) that the repository composes, keeping the query indexable and making it impossible to return rows the principal cannot see.

**Q: 403 or 404 for an object belonging to another tenant?**
A: `404`, for the same reason GitHub returns 404 on private repositories — a `403` confirms the resource exists, which is itself a disclosure. Use `403` when the caller can legitimately see the resource but lacks permission for the specific action, and always include a machine-readable reason code.

**Q: What is BFLA and how do you prevent it structurally?**
A: Broken Function Level Authorization is an ordinary user invoking an administrative operation because the route was never guarded — often a `DELETE` sibling of a guarded `GET`. Prevent it by making permission declaration mandatory: every route declares a required permission, and an undeclared route fails startup or CI rather than defaulting to permit.

**Q: Why is mass assignment an authorization bug?**
A: Because binding the whole request body to your model lets a user write fields they have no permission to write — `role`, `tenant_id`, `is_verified`, `balance`. The fix is an explicit per-role allow-list of writable fields, not a denylist, since denylists miss every field you add later.

**Q: (Senior) Design authorization for a multi-tenant SaaS with nested organisations, teams and per-document sharing.**
A: Model it as ReBAC: tuples like `doc:roadmap#viewer@team:eng#member` with userset rewrites so team membership and org inheritance resolve by graph traversal, which handles nesting and ad-hoc sharing that RBAC cannot. Layer scopes at the OAuth boundary and keep tenant isolation as a hard outer predicate — every tuple lookup is tenant-qualified, with database row-level security as a backstop. Add a consistency token per read so a freshly revoked share cannot be served from a stale cache, and expose a batch-check API so listing 50 documents costs one call.

**Q: (Senior) Centralised policy engine or in-code checks? Defend your choice.**
A: Use in-code checks for simple, stable, latency-critical rules — a role-to-permission map in process is microseconds and trivially debuggable. Move to a policy engine when rules change faster than deploys, when non-engineers must review them, or when consistency across many services matters more than local simplicity; deploy it as a sidecar with bundle distribution so authorship is central but evaluation is local. The failure mode to design against is a remote PDP becoming a tier-0 latency and availability dependency.

**Q: (Senior) How do you migrate a live system from ad-hoc `if user.is_admin` checks to a policy model without an outage?**
A: Introduce the PDP in shadow mode first: every existing check also calls the new engine, logs both answers, and serves the old one. Drive the disagreement rate to zero using production traffic, which surfaces the undocumented rules nobody remembered. Then flip enforcement per endpoint behind a flag, keeping the old check as a tripwire that alerts on divergence, and only delete it after a full audit cycle with cross-tenant isolation tests in CI.

**Q: How do you handle "the user's role changed" with stateless JWTs?**
A: Keep access tokens short (5–15 minutes) so stale roles expire quickly, and add a `principal_version` or `token_version` claim compared against a cached counter that you bump on any role change — that gives near-instant revocation without a per-request database lookup. For genuinely destructive actions, re-resolve permissions server-side rather than trusting the token's snapshot.

**Q: What belongs in the token versus what should be looked up?**
A: Put small, slow-changing, low-cardinality facts in the token: `sub`, `tenant_id`, `roles`, `scope`, maybe an approval limit. Look up anything large, fast-changing or sensitive — per-object relationships, group membership graphs, feature entitlements — because embedding them bloats every request and makes staleness a security bug.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Four gates, always in order: **authentication** (`401`), **scope** (client ceiling, `403 insufficient_scope`), **function** (route/role, `403`, this is the BFLA gate), and **object** (row/relationship, `403` or `404`, this is the BOLA gate). Deny by default and make undeclared routes fail startup. RBAC bundles permissions into roles and wins on auditability until context creeps into role names; ABAC evaluates a predicate over subject, resource, action and environment; ReBAC/Zanzibar models relationships as a graph and is the right answer for sharing and nesting. Never fetch by ID alone — always `WHERE id = :id AND tenant_id = :tid`. For lists, push the policy down as a SQL filter instead of evaluating per row. Derive every authorization input from verified claims, never from `X-User-Id` or the request body. Return `404` when existence is sensitive, `403` with a reason code otherwise, and audit both permits and denies with a policy version.

| Situation | Response |
|---|---|
| No / invalid / expired token | `401` + `WWW-Authenticate: Bearer error="invalid_token"` |
| Valid token, client lacks scope | `403` + `error="insufficient_scope", scope="invoices:write"` |
| Valid user, role lacks permission | `403` + `problem+json` with `required_permission` |
| Object belongs to another tenant | `404` (do not confirm existence) |
| Object visible, action not allowed | `403` + machine-readable reason code |
| Needs recent MFA | `403` + `step_up_required` (or `401` with `acr_values` hint) |
| Object in wrong state (already void) | `409 Conflict` |
| Write to a field you may not set | `403` or `422`, never silently ignore |

**Flash cards**

- **The one line that prevents BOLA?** → `WHERE id = :id AND tenant_id = :tenant_id` — never fetch by ID alone.
- **Scope vs role?** → Scope limits the *client application*; the role limits the *user*. Both must pass, and neither replaces the object check.
- **When do you outgrow RBAC?** → When roles start carrying context in their names (`admin_eu_readonly`) — move that context into attributes.
- **403 or 404?** → `404` when knowing the object exists is itself a leak; `403` when the caller may see it but not act on it.
- **How do you authorize a list endpoint?** → Return a filter from the policy and push it into the query; never fetch-then-filter in memory.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Build a two-tenant fixture and write an automated probe that, for every object endpoint in your OpenAPI spec, requests tenant B's IDs with tenant A's token and asserts `404`/`403`. Wire it into CI as a merge gate.
- [ ] Implement `requires(permission, scope)` middleware plus a startup check that every registered route declares a permission; add a deliberately undeclared route and confirm the app refuses to boot.
- [ ] Convert a list endpoint from fetch-then-filter to filter-pushdown, then compare query plans and p99 latency at 100k rows.
- [ ] Write the same rule three ways — hard-coded `if`, RBAC table, and Rego policy — and compare readability, test ergonomics and evaluation latency.
- [ ] Add field-level filtering so `cost_basis` is stripped for `viewer` but present for `billing_admin`, and assert it in a contract test against the serialized JSON, not the ORM object.

**Mini Project — multi-tenant invoicing authorization**

*Goal:* build an invoicing API where authorization is provably correct across tenants, roles and object states.

*Requirements:*
1. Three roles (`viewer`, `billing_agent`, `billing_admin`) mapped to permissions, plus OAuth scopes `invoices:read` / `invoices:write` enforced independently.
2. Endpoints for list, read, create, void and refund, each with a declared permission and mandatory tenant-scoped data access.
3. ABAC conditions: void requires `status == open`, `amount <= approval_limit`, and MFA within 15 minutes; refunds are blocked outside business hours for the tenant's timezone.
4. Correct status semantics: `401`, `403 insufficient_scope`, `403 insufficient_permission`, `404` cross-tenant, `409` wrong state — all as RFC 9457 problem details.
5. A structured decision audit log with `policy_version`, and an internal `explain` endpoint returning the evaluation trace.

*Extensions:* move policy into OPA as a sidecar and run it in shadow mode against the in-code rules until they agree; add ReBAC-style per-invoice sharing (`invoice:inv_9f2#viewer@user:usr_x`); add PostgreSQL row-level security as a backstop and prove it blocks a deliberately unscoped query; build an access-recertification report listing every principal's effective permissions.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *OAuth 2.0 & OpenID Connect* (chapter 19) covers where scopes and consent come from; *JWT: Structure, Validation & Pitfalls* (chapter 20) covers producing the verified claims this chapter consumes; *OWASP API Security Top 10* (chapter 23) puts BOLA, BFLA and mass assignment in the full risk landscape; *TLS, CORS & Security Headers* (chapter 22) covers the browser-side controls; *Rate Limiting, Quotas & Throttling* (chapter 24) covers slowing the enumeration that finds authorization gaps.

- **OWASP API Security Top 10 (2023) — API1 & API5** — OWASP · *Intermediate* · the canonical descriptions of BOLA and BFLA with attack scenarios and prevention checklists. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
- **OWASP Authorization Cheat Sheet** — OWASP · *Intermediate* · practical, framework-agnostic rules: deny by default, enforce server-side, test cross-tenant. <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html>
- **NIST SP 800-162 — Guide to Attribute Based Access Control** — NIST · *Advanced* · the definitive ABAC reference including the PDP/PEP architecture and attribute governance. <https://csrc.nist.gov/pubs/sp/800/162/upd2/final>
- **Zanzibar: Google's Consistent, Global Authorization System** — Google (USENIX ATC '19) · *Advanced* · the ReBAC paper: tuples, userset rewrites, zookies and the new-enemy problem. <https://research.google/pubs/pub48190/>
- **Open Policy Agent documentation** — CNCF · *Intermediate* · Rego language guide plus deployment patterns (sidecar, bundles) for externalising policy without adding latency. <https://www.openpolicyagent.org/docs/latest/>
- **AWS Cedar Policy Language Guide** — AWS · *Intermediate* · a modern, analysable policy language with formal verification; excellent worked multi-tenant examples. <https://docs.cedarpolicy.com/>
- **PortSwigger Web Security Academy — Access Control Vulnerabilities** — PortSwigger · *Beginner* · free interactive labs covering IDOR, horizontal and vertical privilege escalation. <https://portswigger.net/web-security/access-control>
- **PostgreSQL Row Security Policies** — PostgreSQL · *Advanced* · how to make tenant isolation fail closed at the database layer as a backstop to application checks. <https://www.postgresql.org/docs/current/ddl-rowsecurity.html>

---

*REST API Handbook — chapter 21.*
