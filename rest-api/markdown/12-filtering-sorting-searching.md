# 12 · Filtering, Sorting & Searching

> **In one line:** A collection endpoint is a query surface, not a dump — design its filter, sort, field-selection and search parameters as a bounded, indexed, injection-proof contract, or your `GET /orders` becomes an unauthenticated ad-hoc SQL console.

---

## 1. Overview

Every REST API eventually grows the same three requirements on its collection endpoints: *show me only the rows I care about* (filtering), *in the order I want* (sorting), and *with only the fields I need* (sparse fieldsets). Add "find me things that mention 'refund'" (search) and you have the entire query surface of a typical API. These four features are usually bolted on one query parameter at a time, and the result — after two years and six teams — is `?status=open&state=OPEN&filter[state]=open&q=open&created_after=...&createdAfter=...` living side by side in the same service.

The problem they solve is **round trips and payload size**. Without server-side filtering, clients page through everything and discard 99% of it, burning your database, your bandwidth and their battery. Without sorting, "newest first" becomes a client-side sort over an incomplete page — which is simply wrong. Without field selection, a mobile list view downloads every blob column on every row. Filtering is the single highest-leverage performance feature on a read API, and it is also the single easiest place to accidentally expose an unbounded, unindexed, injectable query engine to the internet.

There is no RFC for filter syntax. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) defines the query component of a URI as opaque to HTTP itself — semantics are entirely yours. So the industry converged through convention instead: JSON:API standardized `filter[...]`, `sort=`, and `fields[type]=`; OData (OASIS) standardized `$filter=price gt 10 and category eq 'books'`; the FIQL/RSQL grammar (from the abandoned draft `draft-nottingham-atompub-fiql`) gave us `price=gt=10;category==books`; and Google's [API Improvement Proposals](https://google.aip.dev/160) specify a small CEL-like expression language in a single `filter` string. Every one of these is a real, defensible choice. Picking one and applying it everywhere matters far more than which one you pick.

**Concrete example.** Stripe uses flat parameters with nested range objects: `GET /v1/charges?status=succeeded&created[gte]=1704067200&limit=100`. GitHub splits the two concerns explicitly — `GET /repos/{o}/{r}/issues?state=open&labels=bug&sort=updated&direction=desc` for *filtering*, and a completely separate `GET /search/issues?q=repo:o/r is:open label:bug` endpoint with its own rate limit and its own inverted index for *searching*. That split is the single most important design lesson in this chapter: filtering is a deterministic predicate over indexed columns; search is a ranked, approximate, expensive relevance query. They have different backends, different cost profiles, different pagination semantics and should have different endpoints.

The durable mental model: **a collection endpoint is a view over a query plan you have pre-approved.** Every filter a client can express must map to an index you own, every sort must be backed by a deterministic, unique ordering, and everything the client did not explicitly ask for must be off by default.

## 2. Core Concepts

- **Filter** — a predicate that *excludes* rows deterministically. `status=open` either matches or it does not; results are exact, unranked, and cheap when indexed.
- **Search** — a *ranked* relevance query over tokenized text. Results are scored and approximate; stemming, stop-words, and typo tolerance all apply. Costs orders of magnitude more than a filter.
- **Sparse fieldset** — client-selected subset of a resource's fields, e.g. `fields=id,name,total`. From JSON:API; reduces payload and can enable index-only scans.
- **Sort key** — the ordered list of columns and directions applied to results, e.g. `sort=-created_at,id`. The leading `-` means descending; this is the most widely adopted convention.
- **Tie-breaker** — a final, *unique* sort column (usually the primary key) appended to every sort so ordering is total and stable. Without it, pagination duplicates and skips rows.
- **Operator suffix** — the way a filter expresses something other than equality: `price[gte]=10`, `price=gte:10`, `price=gt=10`, or `$filter=price gt 10`.
- **Allow-list** — the server-side map of `public_field_name → (column, allowed_operators, index)`. The only safe way to translate user input into a query.
- **Selectivity** — the fraction of rows a filter eliminates. High-selectivity filters (`order_id=`) are cheap; low-selectivity ones (`country=US` on a US-only product) are full scans wearing a filter's clothes.
- **Keyset (cursor) pagination** — pagination by `WHERE (sort_key, id) < (last_seen…)` rather than `OFFSET`. Its correctness depends entirely on the sort being total and stable (see chapter 13).
- **Query cost budget** — an explicit ceiling on filter count, expression depth, result-set size and execution time, enforced before the query runs.

## 3. Theory & Principles

### 3.1 The four syntax families

| Family | Example | Pros | Cons |
|---|---|---|---|
| **Flat / scalar** | `?status=open&owner_id=42` | Trivial to read, cache, log, and validate; works in every HTTP client and OpenAPI tool | Only equality; no `OR`, no ranges without inventing `created_after` twins |
| **Bracketed** | `?filter[status]=open&filter[price][gte]=10` | Structured, self-describing, JSON:API standard, easy to parse and allow-list | Verbose; bracket encoding varies across HTTP clients; still awkward for `OR` |
| **Operator-in-value (RSQL/FIQL)** | `?filter=price=gt=10;status==open,status==paid` | Compact, full boolean algebra, one parameter | Needs a real parser; unreadable to newcomers; trivially over-expressive |
| **Expression language (OData / AIP-160)** | `?$filter=price gt 10 and status eq 'open'` | Very expressive, tooling exists, well specified | Big surface, big attack surface, hard to bound cost, hard to index-plan |

The honest guidance: **start flat, add bracketed operators only where you need ranges, and adopt RSQL/OData only if you are building a genuine reporting or admin API with a query planner behind it.** Expressiveness you cannot index is a liability. Google's AIP-160 exists because Google has the infrastructure to plan arbitrary filters; most teams do not.

### 3.2 Sort semantics and why a tie-breaker is mandatory

The convention `sort=-created_at,name` reads as: order by `created_at` descending, then `name` ascending. It is compact, ordered (position matters), and unambiguous.

The subtle bug is **non-total orderings**. If 500 orders share the same `created_at` (a bulk import) and you sort only by `created_at`, the database is free to return them in *any* order — and it will return a different order across pages, because each page is a separate query with a separate plan. The client then sees duplicates on page 2 and never sees some rows at all. The fix is arithmetic, not heuristic: **append a unique column** so the sort is a total order.

```
sort=-created_at    -->    ORDER BY created_at DESC, id DESC     (server appends id)
```

This is also the precondition for keyset pagination: `WHERE (created_at, id) < ($last_created, $last_id)` is only correct if `(created_at, id)` is unique. Note the tie-breaker's direction should follow the last sort key's direction, or the comparison tuple stops being monotone.

### 3.3 Filter → SQL without injection

There is exactly one safe translation model, and the rule is absolute: **user input never becomes SQL text — only values bound to placeholders.** Column names, operators, sort directions and table joins are chosen by *lookup in a server-side allow-list*, never by string interpolation.

```
user gives:  filter[price][gte]=10&sort=-created_at
server maps: "price"      -> Column(orders.price_cents, ops={eq,gte,lte}, index=ix_price)
             "gte"        -> ">="
             "created_at" -> Column(orders.created_at, sortable=True, index=ix_created_id)
emits:       WHERE orders.price_cents >= $1 ORDER BY orders.created_at DESC, orders.id DESC
binds:       $1 = 1000
```

An ORM does not save you here. `Order.query.order_by(text(request.args["sort"]))` is injectable, and so is any `filter(text(f"{col} = '{val}'"))`. The vulnerability class is CWE-89 and it appears in OWASP API Security Top 10 2023 as **API8:2023 Security Misconfiguration** and in the classic injection category. Equally important and more commonly missed: even a perfectly parameterized query is a vulnerability if the filter lets a caller reach another tenant's rows — **API1:2023 Broken Object Level Authorization**. The tenant predicate is *server-side, always applied, never client-supplied*.

### 3.4 Cost bounding

Every accepted filter must have a plan. The practical rules:

1. **Sortable fields are an explicit, short allow-list** — every sortable column needs a composite index ending in the tie-breaker (`(created_at, id)`). Sorting by an unindexed column on a 200M-row table is a full sort in temp space; it will be the query that takes your database down.
2. **At least one selective filter is often mandatory.** Many production APIs require a tenant/parent scope (`GET /projects/{id}/tasks`) precisely so no query is unbounded.
3. **Cap the number of filter terms** (e.g. 8), the number of values in an `in` list (e.g. 100), and the expression depth (e.g. 3). Reject with `400`, not by silently truncating.
4. **Cap execution time** with `statement_timeout` and return `503`/`504` with `Retry-After` rather than holding a connection for 30 seconds.
5. **`LIKE '%term%'` is not search.** A leading wildcard cannot use a B-tree index. Either use a trigram index (`pg_trgm`), a proper full-text index, or refuse the operation.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="340" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Filter syntax families and where the cost lands</text>
<rect x="26" y="54" width="352" height="128" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
<text x="42" y="76" fill="#1e293b" font-size="12" font-weight="700">Flat scalar</text>
<text x="42" y="96" fill="#1e293b" font-size="11">?status=open&amp;owner_id=42&amp;limit=50</text>
<text x="42" y="116" fill="#1e293b" font-size="11">Equality only. One index lookup per term.</text>
<text x="42" y="134" fill="#1e293b" font-size="11">Cacheable, loggable, trivially allow-listed.</text>
<text x="42" y="156" fill="#16a34a" font-size="11" font-weight="700">Cost: predictable. Default choice.</text>
<text x="42" y="174" fill="#1e293b" font-size="11">Used by: Stripe, GitHub list endpoints.</text>
<rect x="402" y="54" width="352" height="128" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="418" y="76" fill="#1e293b" font-size="12" font-weight="700">Bracketed operators</text>
<text x="418" y="96" fill="#1e293b" font-size="11">?filter[price][gte]=10&amp;filter[status]=open</text>
<text x="418" y="116" fill="#1e293b" font-size="11">Ranges + set membership, still declarative.</text>
<text x="418" y="134" fill="#1e293b" font-size="11">Maps 1:1 to (column, op, value) triples.</text>
<text x="418" y="156" fill="#16a34a" font-size="11" font-weight="700">Cost: bounded if ops are allow-listed.</text>
<text x="418" y="174" fill="#1e293b" font-size="11">Used by: JSON:API ecosystems.</text>
<rect x="26" y="196" width="352" height="140" rx="10" fill="#fef3c7" stroke="#d97706"/>
<text x="42" y="218" fill="#1e293b" font-size="12" font-weight="700">RSQL / FIQL</text>
<text x="42" y="238" fill="#1e293b" font-size="11">?filter=price=gt=10;(status==open,status==paid)</text>
<text x="42" y="258" fill="#1e293b" font-size="11">Full boolean algebra in one parameter.</text>
<text x="42" y="276" fill="#1e293b" font-size="11">Needs a parser + an AST validator.</text>
<text x="42" y="298" fill="#d97706" font-size="11" font-weight="700">Cost: unbounded unless depth-capped.</text>
<text x="42" y="318" fill="#1e293b" font-size="11">OR across columns defeats most indexes.</text>
<rect x="402" y="196" width="352" height="140" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
<text x="418" y="218" fill="#1e293b" font-size="12" font-weight="700">Expression language (OData, AIP-160)</text>
<text x="418" y="238" fill="#1e293b" font-size="11">?filter=price gt 10 and status eq &#39;open&#39;</text>
<text x="418" y="258" fill="#1e293b" font-size="11">Most expressive; real specs and tooling.</text>
<text x="418" y="276" fill="#1e293b" font-size="11">Requires a planner and a cost model.</text>
<text x="418" y="298" fill="#d97706" font-size="11" font-weight="700">Cost: needs timeouts + query governance.</text>
<text x="418" y="318" fill="#1e293b" font-size="11">Adopt only for reporting / admin APIs.</text>
</svg>
```

## 4. Architecture & Workflow

A request to `GET /v1/orders?filter[status]=open&filter[total][gte]=5000&sort=-created_at&fields=id,total,status&limit=50` travels like this:

1. **Gateway** applies auth, rate limits, and a URI-length cap (query strings are logged everywhere; 8 KB is a common hard limit and a long filter can exceed it). Search endpoints get a *lower* rate limit bucket than list endpoints.
2. **Parse** the query string into a normalized structure: `filters: [(field, op, raw_value)]`, `sort: [(field, dir)]`, `fields: [str]`, `limit`, `cursor`. Reject unknown parameters explicitly — silently ignoring `?statuss=open` returns the whole collection and the client never learns why.
3. **Validate against the allow-list.** Each `(field, op)` pair must exist in the resource's query descriptor. Unknown field → `400` with a `problem+json` body naming the field and listing the legal ones. Known field, illegal operator (`created_at[contains]`) → `400`. Legal field the caller may not see (`internal_risk_score`) → `400` as if unknown, so the filter surface does not leak schema.
4. **Coerce and bound values.** `"5000"` → `int`, ISO-8601 strings → aware `datetime`, `in` lists split and capped. Coercion failure is a `400`; a semantically impossible combination (`created_after` later than `created_before`) is a `422`.
5. **Apply mandatory server-side predicates.** Tenant id, soft-delete filter, visibility scope. These are appended *after* user filters and can never be overridden.
6. **Compose the query** with bound parameters, adding the unique tie-breaker to the sort and translating `fields` to a column projection (dropping any field the caller is not authorized to read).
7. **Plan check** (optional but powerful in admin/reporting tiers): run `EXPLAIN`, and if the plan is a sequential scan over more than N rows, reject with `400`/`422` and a message naming the missing filter, rather than executing it.
8. **Execute** under `statement_timeout`, fetching `limit + 1` rows to know whether a next page exists without a second `COUNT(*)`.
9. **Serialize** the projected fields, build the cursor from the last row's `(sort_key…, id)` tuple, and set `Cache-Control` plus an `ETag` computed over the response body.
10. **Respond** with the page, a `links.next` cursor, and — if you provide it — a `total` only when the client asked for it, because an exact count on a large filtered set is often more expensive than the page itself.

```svg
<svg viewBox="0 0 780 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="380" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Query string to bound SQL: the allow-list pipeline</text>
<rect x="26" y="54" width="200" height="86" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="126" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">1. Raw query string</text>
<text x="40" y="96" fill="#1e293b" font-size="10">filter[status]=open</text>
<text x="40" y="112" fill="#1e293b" font-size="10">filter[total][gte]=5000</text>
<text x="40" y="128" fill="#1e293b" font-size="10">sort=-created_at&amp;fields=id,total</text>
<rect x="256" y="54" width="200" height="86" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="356" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">2. Parse + normalize</text>
<text x="270" y="96" fill="#1e293b" font-size="10">[(status, eq, &#39;open&#39;),</text>
<text x="270" y="112" fill="#1e293b" font-size="10"> (total, gte, &#39;5000&#39;)]</text>
<text x="270" y="128" fill="#1e293b" font-size="10">unknown params &#8594; 400</text>
<rect x="486" y="54" width="268" height="86" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="620" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">3. Allow-list lookup</text>
<text x="500" y="96" fill="#1e293b" font-size="10">status &#8594; orders.status  ops{eq,in}</text>
<text x="500" y="112" fill="#1e293b" font-size="10">total  &#8594; orders.total_cents ops{gte,lte}</text>
<text x="500" y="128" fill="#1e293b" font-size="10">no entry &#8594; 400, never interpolate</text>
<path d="M226 97 h24 m-9 -5 l9 5 l-9 5" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M456 97 h24 m-9 -5 l9 5 l-9 5" fill="none" stroke="#4f46e5" stroke-width="2"/>
<rect x="26" y="160" width="342" height="98" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="42" y="182" fill="#1e293b" font-size="12" font-weight="700">4. Coerce, bound, add server predicates</text>
<text x="42" y="202" fill="#1e293b" font-size="10">&#39;5000&#39; &#8594; int 5000 ; max 8 filter terms ; in[] &#8804; 100</text>
<text x="42" y="220" fill="#1e293b" font-size="10">AND tenant_id = $ctx  (never client supplied)</text>
<text x="42" y="238" fill="#1e293b" font-size="10">AND deleted_at IS NULL</text>
<rect x="398" y="160" width="356" height="98" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="414" y="182" fill="#1e293b" font-size="12" font-weight="700">5. Compose parameterized SQL</text>
<text x="414" y="202" fill="#1e293b" font-size="10">WHERE tenant_id=$1 AND status=$2 AND total_cents&gt;=$3</text>
<text x="414" y="220" fill="#1e293b" font-size="10">ORDER BY created_at DESC, id DESC</text>
<text x="414" y="238" fill="#1e293b" font-size="10">LIMIT 51        (limit + 1 probes for next page)</text>
<rect x="26" y="278" width="342" height="98" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="42" y="300" fill="#1e293b" font-size="12" font-weight="700">6. Index requirement</text>
<text x="42" y="320" fill="#1e293b" font-size="10">ix_orders_tenant_status_created_id</text>
<text x="42" y="338" fill="#1e293b" font-size="10">  (tenant_id, status, created_at DESC, id DESC)</text>
<text x="42" y="358" fill="#d97706" font-size="10" font-weight="700">No index for a sort field &#8594; field is not sortable.</text>
<rect x="398" y="278" width="356" height="98" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="414" y="300" fill="#1e293b" font-size="12" font-weight="700">7. Response</text>
<text x="414" y="320" fill="#1e293b" font-size="10">200 OK  Cache-Control: private, max-age=30</text>
<text x="414" y="338" fill="#1e293b" font-size="10">{ &#34;data&#34;: [ &#8230; 50 items, projected fields &#8230; ],</text>
<text x="414" y="358" fill="#1e293b" font-size="10">  &#34;links&#34;: { &#34;next&#34;: &#34;?cursor=eyJjIjoi&#8230;&#34; } }</text>
</svg>
```

## 5. Implementation

### 5.1 The wire contract

```http
GET /v1/orders?filter[status]=open&filter[total][gte]=5000&filter[created_at][gte]=2026-07-01T00:00:00Z&sort=-created_at&fields=id,total,status,created_at&limit=2 HTTP/1.1
Host: api.example.com
Authorization: Bearer sk_live_...
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, max-age=30
ETag: "W/8f3a91c0"
X-Request-Id: req_01J9K2M3

{
  "data": [
    { "id": "ord_8812", "total": 12900, "status": "open", "created_at": "2026-07-21T09:14:02Z" },
    { "id": "ord_8809", "total":  7400, "status": "open", "created_at": "2026-07-21T08:51:44Z" }
  ],
  "links": { "next": "/v1/orders?filter[status]=open&filter[total][gte]=5000&sort=-created_at&limit=2&cursor=eyJjIjoiMjAyNi0wNy0yMVQwODo1MTo0NFoiLCJpIjoib3JkXzg4MDkifQ" },
  "meta": { "has_more": true }
}
```

An unknown filter field must fail loudly rather than be ignored:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/invalid-filter",
  "title": "Invalid filter parameter",
  "status": 400,
  "detail": "Unknown filter field 'statuss'.",
  "errors": [ { "parameter": "filter[statuss]", "code": "unknown_field",
                "allowed": ["status", "total", "created_at", "customer_id"] } ] }
```

```bash
# Multi-value (implicit OR within a field), range, and negation
curl -G https://api.example.com/v1/orders \
  --data-urlencode 'filter[status][in]=open,paid' \
  --data-urlencode 'filter[total][gte]=1000' \
  --data-urlencode 'filter[total][lt]=50000' \
  --data-urlencode 'filter[country][neq]=RU' \
  --data-urlencode 'sort=-created_at,id' \
  --data-urlencode 'fields=id,total,status' \
  -H "Authorization: Bearer $TOKEN"
```

> **Note:** Repeated parameters (`?status=open&status=paid`) also express OR and are marginally simpler, but framework behaviour differs — some take the first value, some the last, some build a list. Bracketed `[in]` is unambiguous across every stack, which is why it survives contact with real client libraries.

### 5.2 A FastAPI implementation with a real allow-list

```python
from dataclasses import dataclass, field as dc_field
from datetime import datetime
from typing import Any, Callable
from fastapi import FastAPI, Query, Request
from sqlalchemy import select, and_, asc, desc

app = FastAPI()
OPS = {"eq": "__eq__", "neq": "__ne__", "gt": "__gt__", "gte": "__ge__",
       "lt": "__lt__", "lte": "__le__", "in": "in_"}
MAX_TERMS, MAX_IN, MAX_LIMIT = 8, 100, 100

@dataclass(frozen=True)
class Spec:
    column: Any                       # a real column object, never a string from the client
    ops: frozenset[str]
    coerce: Callable[[str], Any]
    sortable: bool = False
    scopes: frozenset[str] = dc_field(default_factory=frozenset)

def iso(v: str) -> datetime:
    return datetime.fromisoformat(v.replace("Z", "+00:00"))

ORDER_FIELDS = {
    "status":      Spec(Order.status,      frozenset({"eq", "in"}),         str),
    "total":       Spec(Order.total_cents, frozenset({"gte", "lte", "eq"}), int),
    "customer_id": Spec(Order.customer_id, frozenset({"eq", "in"}),         str),
    "created_at":  Spec(Order.created_at,  frozenset({"gte", "lte"}),       iso, sortable=True),
    "risk_score":  Spec(Order.risk_score,  frozenset({"gte"}), int,
                        scopes=frozenset({"orders:admin"})),
}

def visible(granted):  # unknown and unauthorized must be indistinguishable
    return sorted(f for f, s in ORDER_FIELDS.items() if not s.scopes or s.scopes & granted)

def build_filters(query_params, granted: set[str]):
    clauses = []
    for name, raw in query_params.multi_items():
        if not name.startswith("filter["):
            continue
        fname, op = (name[7:].rstrip("]").split("][") + ["eq"])[:2]   # filter[total][gte]
        spec = ORDER_FIELDS.get(fname)
        if spec is None or (spec.scopes and not spec.scopes & granted):
            bad(name, "unknown_field", f"Unknown filter field '{fname}'.", visible(granted))
        if op not in spec.ops:
            bad(name, "unsupported_operator", f"'{op}' unsupported on '{fname}'.", sorted(spec.ops))
        if len(clauses) >= MAX_TERMS:
            bad(name, "too_many_filters", f"At most {MAX_TERMS} filter terms allowed.")
        try:
            if op == "in":
                values = [v for v in raw.split(",") if v]
                if len(values) > MAX_IN:
                    bad(name, "list_too_long", f"At most {MAX_IN} values allowed.")
                value = [spec.coerce(v) for v in values]
            else:
                value = spec.coerce(raw)
        except (ValueError, TypeError):
            bad(name, "invalid_value", f"Not a valid {spec.coerce.__name__}.")
        clauses.append(getattr(spec.column, OPS[op])(value))   # bound parameter, never SQL text
    return clauses

def build_sort(sort: str | None):
    keys = []
    for token in (sort or "-created_at").split(",")[:3]:
        direction, name = (desc, token[1:]) if token.startswith("-") else (asc, token)
        spec = ORDER_FIELDS.get(name)
        if spec is None or not spec.sortable:
            bad("sort", "unsortable_field", f"Cannot sort by '{name}'.",
                sorted(f for f, s in ORDER_FIELDS.items() if s.sortable))
        keys.append(direction(spec.column))
    return keys + [desc(Order.id)]         # mandatory unique tie-breaker

@app.get("/v1/orders")
async def list_orders(request: Request, sort: str | None = None,
                      fields: str | None = None,
                      limit: int = Query(50, ge=1, le=MAX_LIMIT)):
    ctx = request.state.auth
    stmt = (select(Order)
            .where(Order.tenant_id == ctx.tenant_id,       # server-side, always applied
                   Order.deleted_at.is_(None),
                   and_(*build_filters(request.query_params, ctx.scopes)))
            .order_by(*build_sort(sort))
            .limit(limit + 1))                             # +1 probes for a next page
    rows = (await request.state.db.execute(stmt)).scalars().all()
    return serialize(rows[:limit], projection(fields), has_more=len(rows) > limit)
```

`bad()` raises a `400` RFC 9457 problem document carrying `parameter`, a stable `code` and the `allowed` list — the same helper used in §5.1.

### 5.3 Sparse fieldsets

```http
GET /v1/orders?fields=id,total,status HTTP/1.1
```

Three rules make `fields` safe and useful: (1) `id` (and any field the client needs to build a cursor) is always included whether asked for or not; (2) unknown or unauthorized field names are rejected with `400` rather than silently dropped, or clients will silently render blanks; (3) the projection must reach the database — selecting three columns from a table but still hydrating full ORM entities saves bandwidth and nothing else. When the projection matches a covering index, you get an index-only scan and a genuine order-of-magnitude win.

For nested/related resources, JSON:API's per-type form is clearer: `fields[orders]=id,total&fields[customers]=id,email&include=customer`.

### 5.4 Search is a different endpoint

```http
GET /v1/search/orders?q=refund%20delayed&filter[status]=open&limit=20 HTTP/1.1
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{ "data": [
    { "id": "ord_8812", "score": 8.41,
      "highlight": { "notes": ["customer asked about a <em>delayed refund</em>"] } } ],
  "meta": { "took_ms": 34, "total_relation": "gte", "total": 1000 } }
```

Note what changes: results carry a **relevance score** and **highlights**, `total` is approximate (`"total_relation": "gte"` — Elasticsearch caps counting at 10,000 by default), and deep pagination is usually forbidden past a few thousand results because scoring the whole corpus to skip 100 pages is pathological. In Postgres, the minimum viable version is a stored `tsvector` with a GIN index:

```sql
ALTER TABLE orders ADD COLUMN search_doc tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
      coalesce(notes,'') || ' ' || coalesce(customer_name,''))) STORED;
CREATE INDEX ix_orders_search ON orders USING GIN (search_doc);

SELECT id, ts_rank(search_doc, q) AS score
FROM orders, websearch_to_tsquery('english', $1) q
WHERE tenant_id = $2 AND search_doc @@ q
ORDER BY score DESC, id DESC
LIMIT 20;
```

`websearch_to_tsquery` parses user input safely (quotes, `or`, `-`) and cannot be coerced into a syntax error the way raw `to_tsquery` can — a plain `to_tsquery('english', user_input)` throws on `a & & b` and turns malformed queries into `500`s.

### 5.5 OpenAPI 3.1 fragment

```yaml
paths:
  /v1/orders:
    get:
      parameters:
        - { name: filter[status],     in: query, schema: { type: string, enum: [open, paid, cancelled, refunded] } }
        - { name: filter[total][gte], in: query, schema: { type: integer, minimum: 0 } }
        - name: sort
          in: query
          description: Comma-separated keys; '-' prefix means descending.
          schema:
            type: string
            default: '-created_at'
            pattern: '^-?(created_at|total)(,-?(created_at|total))*$'
        - { name: fields, in: query, schema: { type: string, pattern: '^[a-z_]+(,[a-z_]+)*$' } }
        - { name: limit,  in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
      responses:
        '200': { $ref: '#/components/responses/OrderPage' }
        '400': { $ref: '#/components/responses/Problem400' }
```

Encoding the sortable set into a regex `pattern` means the contract is machine-checkable and generated SDKs reject bad sorts before the request leaves the client.

### 5.6 Optimization notes

- **One composite index per common query shape**, ordered `(equality columns…, sort column, tie-breaker)`. `(tenant_id, status, created_at DESC, id DESC)` serves `status=open&sort=-created_at` as a pure index range scan with no sort step.
- **Skip `COUNT(*)`.** An exact total over a filtered set scans every matching row. Return `has_more` from the `limit + 1` trick, and offer `?include_total=true` (or a separate `/count` endpoint) for callers that genuinely need it.
- **Cache the shape, not just the bytes.** Add `Vary: Authorization` and keep `Cache-Control: private, max-age=30` on list endpoints; identical filter strings from the same client repeat constantly in UIs that poll.
- **Normalize the query string before hashing** for cache keys and ETags — sort the parameters, drop defaults — so `?a=1&b=2` and `?b=2&a=1` are one cache entry, not two.
- **Push field selection into the SQL projection** and prefer covering indexes; an index-only scan on `(tenant_id, status, created_at, id, total_cents)` never touches the heap.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Flat scalar filters | Trivial to document, validate, cache and log; every client library handles them | No ranges or booleans without inventing parallel parameters (`created_after`/`created_before`) |
| Bracketed operators (`filter[x][gte]`) | Structured and self-describing; maps directly to allow-listed `(column, op)` pairs | Verbose URLs; bracket encoding inconsistencies across HTTP clients and gateways |
| RSQL / OData expressions | Enormous expressive power; genuinely useful for admin and reporting surfaces | Requires a parser, an AST validator, a cost model and query governance; easy to DoS yourself |
| Sparse fieldsets (`fields=`) | Big payload reduction; can enable index-only scans; great for mobile | Response shape varies per request, complicating caching, typed SDKs and contract tests |
| Client-controlled sorting | Users get the ordering they need without extra endpoints | Every sortable field is an index you must maintain forever; unindexed sorts are outage material |
| Full-text search endpoint | Relevance ranking, stemming, typo tolerance and highlights that SQL `LIKE` cannot give | A second datastore to sync, index lag, approximate counts, and bounded deep pagination |
| Exact `total` counts | Great UX — real page numbers and result totals | Cost grows with matched rows, not page size; often more expensive than the page itself |
| Rich filter surface | Fewer bespoke endpoints; one collection serves many screens | Every accepted combination is a query plan you implicitly promise to support forever |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Interpolating a sort or filter field into SQL** (`ORDER BY {request.args['sort']}`) — a textbook injection, and ORMs' `text()` helpers do not protect you. → ✅ Look up every field name and operator in a server-side allow-list; only *values* ever become bound parameters.
2. ⚠️ **Silently ignoring unknown parameters.** A typo in `?statuss=open` returns the entire collection, and the client ships it. → ✅ Reject unknown query parameters with `400` and a problem document listing the legal ones.
3. ⚠️ **Sorting without a unique tie-breaker**, so paginated results duplicate and skip rows whenever values tie. → ✅ Always append the primary key to the sort, matching the direction of the last key.
4. ⚠️ **Allowing sorts on unindexed columns**, which turns one API call into a full table sort. → ✅ `sortable=True` is granted only when a composite index ending in the tie-breaker exists; document the sortable set in OpenAPI.
5. ⚠️ **Trusting a client-supplied tenant/owner filter for authorization** (`?tenant_id=other`). This is OWASP API1:2023 Broken Object Level Authorization. → ✅ Apply the tenant predicate server-side from the token, always, and never let a filter widen scope.
6. ⚠️ **Unbounded result sets** — no `limit`, or a `limit` the client can set to 100000. → ✅ Enforce a default and a hard maximum, and reject over-large limits explicitly rather than clamping silently.
7. ⚠️ **Implementing search as `LIKE '%term%'`**, which cannot use a B-tree index and full-scans at every keystroke of an autocomplete. → ✅ Use a real text index (`tsvector` + GIN, `pg_trgm`, or a search engine) and a dedicated endpoint with its own rate limit.
8. ⚠️ **Returning an exact `total` on every list call**, quietly doubling database load. → ✅ Return `has_more` by default and make `total` opt-in or approximate.
9. ⚠️ **Exposing internal columns through the filter surface** — `filter[password_hash][gte]=` lets an attacker binary-search a secret. → ✅ Allow-list is opt-in, never derived from the ORM model; secret columns simply have no entry.
10. ⚠️ **Combining `OR` across low-selectivity columns** so the planner abandons every index. → ✅ Restrict `OR` to within a single field (`[in]`), or require at least one selective filter alongside it.
11. ⚠️ **Leaking the schema through error messages** — "unknown field 'risk_score'" versus "forbidden field 'risk_score'" tells an attacker the column exists. → ✅ Return an identical `400` for unknown and unauthorized fields.
12. ⚠️ **Filter semantics that drift between endpoints** — `?q=` meaning full-text on one route and prefix-match on another, `created_after` here and `filter[created_at][gte]` there. → ✅ One convention, one shared query-parsing library, enforced by a linter in CI.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Log the *normalized* query shape, not the raw string: `orders.list{filters=[status:eq,total:gte],sort=-created_at,fields=3,limit=50}`. That gives you a low-cardinality dimension you can group by, whereas raw query strings are unique per request and contain user data. Keep an `X-Request-Id` on every response and log the chosen index and execution time alongside it; when someone reports "the orders list is slow", you want to jump straight from the request id to the plan. For slow queries, capture `EXPLAIN (ANALYZE, BUFFERS)` behind an internal-only flag and never behind a query parameter a customer can set. A frequent, confusing class of bug is bracket encoding: `filter%5Bstatus%5D` vs `filter[status]` vs a gateway that strips brackets entirely — log the exact received parameter names when a `400 unknown_field` fires so you can tell a client bug from a gateway bug.

**Monitoring.** Instrument `api_list_duration_seconds{route, filter_shape, sort_key}` and `api_list_rows_scanned` (from the database, not the response). The alerting signals that matter: p99 latency per route, the ratio of requests with *no* selective filter, the rate of `400 invalid_filter` per client (a spike means a client release broke), full-scan count from `pg_stat_statements`, and — for search — index lag between the primary store and the search cluster. Watch for the "filter shape explosion" pattern: if the number of distinct filter shapes grows without bound, some client is generating filters programmatically and you will not have indexes for them. Cap the cardinality of that label or you will DoS your metrics backend instead of your database.

**Security.** Three distinct risks. **Injection**: never interpolate identifiers; validate operators against an enum; and remember that ordering by a *user-chosen expression* (not just a column) is an even richer sink. **Broken object-level and property-level authorization**: filters must never widen the caller's scope, and both `fields=` and `filter[…]` must be intersected with what the caller may read — filtering on a field you may not *see* is still an oracle, since `filter[risk_score][gte]=90` plus a result count leaks the value by binary search. **Resource exhaustion**: unbounded filters, deep `OR` trees, giant `in` lists, wildcard-leading searches and deep search pagination are all denial-of-service vectors; bound each explicitly and give search its own, tighter rate-limit bucket (GitHub's public search API allows roughly 10 requests/minute unauthenticated versus 5,000 requests/hour for the core API — that asymmetry is deliberate). Also treat the query string as PII-bearing: search terms end up in access logs, CDN logs and APM traces, so redact `q=` where regulation requires it.

**Performance & scaling.** The scaling path in order: (1) composite indexes matched to real query shapes taken from production logs, not guesses; (2) keyset pagination so page 500 costs the same as page 1; (3) a read replica for list traffic with `statement_timeout` set aggressively (2–5 s) so a bad filter cannot hold a connection; (4) a materialized or denormalized read model when filters span many joins; (5) a dedicated search cluster once relevance or facets are required, accepting eventual consistency and documenting the lag. At every stage, prefer *rejecting* an expensive query over serving it slowly: a `400` telling the caller to add a date range is a better outcome than a 30-second query that saturates the pool for everyone else.

## 9. Interview Questions

**Q: Why should search and filtering be different endpoints?**
A: Filtering is a deterministic, exact predicate over indexed columns and is cheap; search is a ranked relevance query over an inverted index, with stemming, scoring, highlights, approximate totals and much higher cost. They need different backends, different rate limits, different pagination rules and different response shapes. GitHub's `/repos/{o}/{r}/issues` versus `/search/issues` is the canonical split.

**Q: What does `sort=-created_at,name` mean, and what is missing from it?**
A: Order by `created_at` descending, then `name` ascending; the leading `-` marks descending and position determines precedence. What is missing is a unique tie-breaker — the server should append the primary key (`, id DESC`) so the ordering is total, otherwise ties are ordered arbitrarily and pagination duplicates and skips rows.

**Q: How do you make a client-supplied filter safe against SQL injection?**
A: Never let user input become SQL text. Field names, operators and sort directions are resolved through a server-side allow-list mapping public names to real columns and permitted operators; only the *values* are passed as bound parameters. Reject anything not in the allow-list with `400`. ORMs do not make this safe automatically — `text()` and raw `order_by` strings are injectable.

**Q: What are sparse fieldsets and what do they cost?**
A: `fields=id,total,status` lets the client select a subset of the representation, cutting payload and enabling index-only scans when the projection matches a covering index. The costs are a response shape that varies per request — which complicates HTTP caching, typed client SDKs and contract tests — and the need to always include identity fields the client needs for cursors.

**Q: Should a list endpoint return an exact total count?**
A: Usually not by default. An exact count scans every matching row, so it scales with the size of the result set rather than the page, and it is frequently more expensive than the page itself. Return `has_more` (fetch `limit + 1`) and make an exact `total` opt-in, approximate, or a separate endpoint.

**Q: How would you express a range filter?**
A: Either bracketed operators (`filter[created_at][gte]=2026-07-01&filter[created_at][lt]=2026-08-01`) or paired scalar parameters (`created_after` / `created_before`). Prefer half-open intervals `[gte, lt)` so adjacent ranges tile without overlap, require ISO 8601 with an explicit offset, and return `422` if the lower bound is after the upper bound.

**Q: What does a `400` versus `422` look like on a query parameter?**
A: `400` when the parameter cannot be understood — unknown field, unsupported operator, `limit=abc`, a malformed date. `422` when everything parses but the combination is semantically impossible, like `created_at[gte]` after `created_at[lt]`. Both should be RFC 9457 problem documents naming the offending parameter and listing the legal values.

**Q: Why must unknown query parameters be rejected instead of ignored?**
A: Because silently ignoring `?statuss=open` returns the entire unfiltered collection, and both the client developer and your tests will believe the filter worked. That is a correctness bug and a data-exposure risk. Rejecting with `400` and an `allowed` list turns a silent production incident into a one-line fix during development.

**Q: (Senior) A customer says `GET /orders?sort=customer_name` takes 40 seconds. Walk through your response.**
A: First confirm the plan — almost certainly a sequential scan plus an external merge sort, because `customer_name` lives on a joined table and has no composite index ending in the tie-breaker. Short term: apply a `statement_timeout` so it fails fast instead of holding a connection, and either remove `customer_name` from the sortable allow-list (returning `400` with the supported set) or restrict it to requests that also carry a selective filter. Medium term: decide whether it is worth a denormalized `customer_name` column on `orders` with an index `(tenant_id, customer_name, id)`, or whether that sort belongs in the search cluster. The general principle is that sortability is a capability you fund with an index, not a feature you grant by default.

**Q: (Senior) How would you design a filter language for an admin/reporting API where clients genuinely need arbitrary boolean predicates?**
A: Adopt an existing grammar (RSQL or AIP-160) rather than inventing one, parse it to an AST, and then validate the AST rather than the string: cap depth and node count, require every leaf's field to be in the allow-list with a permitted operator, forbid `OR` across low-selectivity columns or require it be wrapped in `IN` on one field, and require at least one high-selectivity anchor such as a tenant plus a bounded date range. Compile the AST to parameterized SQL, run `EXPLAIN` before execution and reject plans whose estimated cost exceeds a budget with a `400` naming the missing constraint. Run it against a read replica with an aggressive `statement_timeout`, meter it under a separate rate-limit bucket, and log the normalized AST shape so you can build indexes for the shapes that actually occur. If clients then want joins, aggregations and grouping, that is a signal you should be exposing a reporting/OLAP surface or scheduled exports rather than growing the REST filter surface further.

**Q: (Senior) How do filters interact with authorization, beyond just row-level scoping?**
A: Three layers. Row level: the tenant/owner predicate is derived from the token and appended server-side; a client-supplied `tenant_id` filter can only narrow, never widen. Field level: `fields=` and `filter[…]` must both be intersected with the properties the caller may read — this is OWASP API3:2023 Broken Object Property Level Authorization. And the subtle one, *inference*: filtering on a field the caller cannot see is an oracle, because `filter[salary][gte]=X` plus a result count reveals values by binary search even though the field is never serialized. So the rule is that a field is filterable only if it is readable by that caller, and unknown-versus-forbidden must produce byte-identical errors so the filter surface does not enumerate your schema.

**Q: (Senior) Your search results are inconsistent — a record updated a second ago does not appear. How do you reason about that?**
A: That is expected: a separate search index is eventually consistent, with lag from the change-capture pipeline, the indexer, and the engine's refresh interval (Elasticsearch defaults to 1 second, and bulk indexing often raises it). Make the contract explicit — document the lag, expose `meta.index_lag_ms`, and never use the search index as the source of truth for a read-after-write flow. Where a user must see their own change immediately, read that specific record from the primary store and merge it into the results, or route "my items" views to the transactional filter endpoint rather than search. Operationally, alert on indexing lag and on the divergence between primary row count and index document count, and make reindexing a routine, tested procedure with alias-swap so it is a non-event.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A collection endpoint is a query surface you must bound. Use **flat parameters** for equality, **bracketed operators** (`filter[total][gte]=10`) for ranges and sets, and adopt RSQL/OData only when you have a planner and a cost model behind it. Sorting uses `sort=-created_at,name` — leading `-` for descending — and the server **always appends a unique tie-breaker** so the ordering is total and keyset pagination is correct. Every filterable and sortable field lives in a **server-side allow-list** mapping public names to columns, permitted operators and required scopes; user input never becomes SQL text, only bound values, and the tenant predicate is always applied server-side. **Reject unknown parameters with `400`** rather than ignoring them. Sparse fieldsets (`fields=`) shrink payloads and can enable index-only scans, but always include identity fields. **Search is a different endpoint** with its own index, its own rate limit, relevance scores, approximate totals and bounded deep pagination — `LIKE '%x%'` is not search. Bound everything: max filter terms, max `in` values, max limit, `statement_timeout`, and prefer rejecting an expensive query over serving it slowly.

| Concern | Convention | Rule |
|---|---|---|
| Equality filter | `?status=open` or `?filter[status]=open` | Allow-listed field, bound value |
| Range | `?filter[created_at][gte]=…&[lt]=…` | Half-open `[gte, lt)`; ISO 8601 with offset |
| Set membership | `?filter[status][in]=open,paid` | Cap list length (e.g. 100) |
| Negation | `?filter[country][neq]=RU` | Rarely selective — verify the plan |
| Sort | `?sort=-created_at,name` | `-` = DESC; server appends `id` tie-breaker |
| Sparse fields | `?fields=id,total` (or `fields[type]=`) | Always include `id`; reject unknown names |
| Search | `GET /search/orders?q=…` | Separate endpoint, index, and rate limit |
| Page size | `?limit=50` | Default + hard max; `limit+1` for `has_more` |
| Unknown param | — | `400` + `problem+json` with `allowed` list |
| Bad combination | `gte` after `lt` | `422 Unprocessable Content` |

- **`sort=-created_at`** → descending by `created_at`; server silently appends `, id DESC` for a total order.
- **Filter vs search** → exact + indexed + cheap vs ranked + tokenized + expensive; different endpoints.
- **Injection defence** → allow-list identifiers and operators; bind only values.
- **Unknown filter field** → `400`, never ignored — and identical to the response for a forbidden field.
- **Sortable field** → only if a composite index ending in the tie-breaker exists.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement a query-descriptor allow-list for one resource: `{field: (column, ops, coerce, sortable, scopes)}`. Add tests proving that an unknown field, an unsupported operator, and a scope-gated field all return byte-identical `400` problem documents.
- [ ] Write a test that inserts 500 rows sharing one `created_at`, pages through them with `sort=-created_at` at `limit=50`, and asserts that the union of ids has no duplicates and no gaps. Then remove the tie-breaker and watch it fail.
- [ ] Take a real filter combination from your logs, run `EXPLAIN (ANALYZE, BUFFERS)` on it, add the composite index `(tenant, equality cols…, sort col, id)`, and record the before/after rows-scanned and latency.
- [ ] Add sparse fieldsets that push the projection into SQL, then measure payload size and query time against a covering index versus a full row fetch.
- [ ] Build a `/search/{resource}` endpoint on a Postgres `tsvector` + GIN index using `websearch_to_tsquery`, returning `score` and `highlight`, with its own rate-limit bucket and a documented max offset.

**Mini Project — a reusable, injection-proof query layer.**
*Goal:* Build a small library that turns a query string into a bounded, parameterized query for any resource, given a declarative descriptor.
*Requirements:* A `QueryDescriptor` per resource declaring filterable fields with operators and coercers, sortable fields with their backing index name, projectable fields, per-field required scopes, and limits (max terms, max `in` size, max sort keys, max page size). A parser handling flat and bracketed forms plus repeated parameters. A validator emitting RFC 9457 problem documents with `parameter`, `code` and `allowed`. A compiler that emits parameterized SQL with the mandatory tenant predicate and an auto-appended tie-breaker. A cursor encoder/decoder built from the sort tuple. An OpenAPI generator that emits the parameter list, enums and `sort` regex directly from the descriptor.
*Extensions:* Add an `EXPLAIN`-based cost guard that rejects plans above a budget; add a CI check that fails if a field is marked `sortable` without a matching index in the migration files; add an RSQL front-end that parses to the same internal AST with depth and node-count caps; add a search adapter so the same descriptor can target Postgres FTS or OpenSearch; and emit a `filter_shape` metric label so you can see which query shapes production actually uses.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Pagination* (chapter 13) for cursors and why the tie-breaker matters; *Resource Modeling & URI Design* (chapter 05) for when a filter should become a sub-collection instead; *Payload Design* (chapter 08) for how sparse fieldsets interact with representation design; *Error Handling & Problem Details* (chapter 16) for the `400`/`422` bodies used here; *Validation & Input Handling* (chapter 17) for coercing and bounding query parameters; *HTTP Caching & ETags* (chapter 25) for caching list responses keyed on a normalized query; *OWASP API Security* (chapter 23) for BOLA/BOPLA in the filter surface; *Rate Limiting & Throttling* (chapter 24) for search's separate bucket.

**Free Learning Resources**
- **RFC 9110 — HTTP Semantics** — IETF · *Intermediate* · the normative meaning of GET, safe methods, and why query semantics are entirely the origin server's business. <https://www.rfc-editor.org/rfc/rfc9110>
- **JSON:API — Fetching Data (filtering, sorting, sparse fieldsets)** — JSON:API · *Beginner* · the most widely copied conventions for `filter[]`, `sort`, and `fields[type]`. <https://jsonapi.org/format/#fetching>
- **Google AIP-160 — Filtering** — Google · *Advanced* · a rigorously specified filter expression language, plus AIP-132 for list methods and AIP-157 for field masks. <https://google.aip.dev/160>
- **Microsoft REST API Guidelines — Filtering and sorting (OData-style)** — Microsoft · *Intermediate* · prescriptive rules for `$filter`, `$orderby`, `$select` and how to bound them. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **Zalando RESTful API Guidelines — Query parameters** — Zalando · *Intermediate* · concrete, opinionated rules on naming, `q`, and collection query design at scale. <https://opensource.zalando.com/restful-api-guidelines/>
- **PostgreSQL — Full Text Search** — PostgreSQL · *Intermediate* · `tsvector`, GIN indexes, `websearch_to_tsquery` and ranking; enough to avoid a second datastore for a long time. <https://www.postgresql.org/docs/current/textsearch.html>
- **Use The Index, Luke! — Sorting, Grouping and Pagination** — Markus Winand · *Intermediate* · the clearest explanation anywhere of why sort columns need composite indexes and why offset pagination degrades. <https://use-the-index-luke.com/sql/sorting-grouping>
- **OWASP API Security Top 10 (2023)** — OWASP · *Intermediate* · API1 (BOLA) and API3 (BOPLA) are exactly the failure modes a rich filter surface creates. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>

---

*REST API Handbook — chapter 12.*
