# 40 · Case Study: Multi-tenant SaaS Database

> **In one line:** Multi-tenancy is a choice of **where the tenant boundary lives** — in a column (shared schema), a namespace (schema per tenant) or a server (database per tenant) — and a mature SaaS usually runs **all three at once**: small tenants pooled and sharded by `tenant_id` with row-level security as a safety net, big or regulated tenants isolated on their own shard or cluster, with quotas and per-tier pools keeping neighbours quiet.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [SQL Handbook · Schema Design](../sql/topic.html?p=30-schema-design) · [SQL Handbook · Index Design](../sql/topic.html?p=20-index-design) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) (pools, timeouts) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution). This chapter assumes those and focuses on the decisions specific to serving many customers from shared infrastructure: isolation, noisy neighbours, tenant placement and tenant-level operations.

### The product

A B2B SaaS — think project management or a CRM — sold on three tiers:

- **Free**: tiny workspaces, self-serve, no SLA.
- **Pro**: small companies, standard SLA.
- **Enterprise**: large companies with contracts that demand things like "our data must be isolated", "restore our workspace to yesterday 14:00", "data stays in the EU", "delete everything within 30 days of termination", and audit evidence of all of it.

**Functional requirements (data layer)**: every query is scoped to one tenant; admins of a tenant can export their data; support can restore a single tenant's data; offboarding deletes a tenant completely; a few internal cross-tenant analytics and billing jobs exist.

**Non-functional requirements**

- **Zero cross-tenant data leaks.** One leaked row is a security incident, a customer notification, and possibly the end of an enterprise deal.
- One tenant's heavy report must not degrade others' p99 (noisy-neighbour isolation).
- Schema migrations must reach every tenant, safely, within one deploy window.
- Cost per free tenant must be close to zero; enterprise isolation can cost more because it is paid for.

### Workload estimate

| Quantity | Estimate | Notes |
|---|---|---|
| Tenants | 50,000 (40,000 free, 9,500 pro, 500 enterprise) | new: ~1,000/month |
| Users | 2 M total, ~400 K daily active | |
| Peak QPS | ~30 K reads, ~4 K writes | |
| Data | ~40 TB, growing ~1.5 TB/month | |
| Size distribution | median tenant ~200 MB; top 1% hold ~40% of data | power law |
| Largest tenant | ~3 TB, ~15% of all traffic | one customer is bigger than 45,000 others combined |
| Tables in the product schema | ~250 | |

The distribution is the whole story. **Any model that treats tenants identically is wrong for someone**: database-per-tenant for 40,000 free tenants is a fleet you cannot afford to run, and a shared table for the 3 TB tenant makes its reports everyone's problem.

### Why the naive designs break

**Naive shared schema** — a `tenant_id` column added "where needed", global `id` keys, and a `WHERE tenant_id = ?` the developer is expected to remember:

- One forgotten predicate in one endpoint leaks another customer's data. With 250 tables and hundreds of engineers, this *will* happen.
- `UNIQUE (email)` is global — tenant A cannot create a user whose email exists in tenant B, and the error message tells A that the email exists somewhere. That is a leak.
- Foreign keys reference `id` only, so a bug can link tenant A's task to tenant B's project and the database accepts it.
- Indexes lead with other columns, so per-tenant queries scan across tenants; the 3 TB tenant's statistics dominate the planner's choices for everyone.

**Naive database per tenant** for everyone:

- 50,000 databases × a pool of connections each exceeds any sane `max_connections` (Postgres uses a process per connection); a pooler cannot share a server connection across databases.
- Every migration runs 50,000 times; some fail halfway; the fleet drifts into many schema versions.
- Each idle database still costs catalog space, monitoring series, backups and vacuum work.

## 2. Core Concepts

- **Tenant** — the customer organisation; the unit of isolation, billing, placement, backup and deletion.
- **Isolation model** — where the boundary is enforced: **pool** (shared tables, `tenant_id` column), **bridge** (schema per tenant in a shared database), **silo** (database or cluster per tenant). *Why it matters:* it decides the blast radius of a bug, the cost floor per tenant and how painful migrations are.
- **Tenant key everywhere** — in the pool model every tenant-owned table has `tenant_id NOT NULL`, primary keys are `(tenant_id, id)`, and foreign keys include `tenant_id`. *Invariant:* **no row can reference a row of another tenant** — enforced by the FK itself.
- **Row-level security (RLS)** — Postgres policies that add a tenant predicate to every query on a table for non-exempt roles. *Invariant:* **a session with `app.tenant_id = X` can read and write only rows with `tenant_id = X`**, even if the application forgets the `WHERE`.
- **Tenant context** — the per-transaction setting (`SET LOCAL app.tenant_id`) that RLS policies read. *Why it matters:* with connection pooling it must be transaction-scoped, never session-scoped.
- **Tenant directory** — a small, highly available mapping `tenant_id → placement (shard group / cluster / region / tier)`. *Invariant:* every request is routed by it; moving a tenant is a directory change at the end of a copy.
- **Distribution column / co-location** — in Citus, tables distributed by `tenant_id` are **co-located**: the same tenant's rows of all tables live in the same shard group on the same node, so joins and transactions within a tenant stay local.
- **Noisy neighbour** — a tenant whose load (a huge export, a runaway integration) degrades others sharing the same resources. Controlled with quotas, timeouts, per-tier pools and placement.
- **Tier** — a product plan that maps to resource limits and placement rules.
- **Tenant lifecycle** — create, grow, move, export, restore, suspend, delete. *Invariant:* **deletion is complete**, including derived stores, and provable.

## 3. Theory & Principles

### Access patterns, ranked

| # | Pattern | Share | Implication |
|---|---|---|---|
| 1 | Single-tenant OLTP reads/writes (list tasks in a project, update a record) | ~97% of queries | Every index leads with `tenant_id`; the tenant is the shard key |
| 2 | Single-tenant reports/exports (all records of a tenant, aggregates) | ~2%, but heavy | Must be resource-limited; big tenants' reports go to replicas |
| 3 | Tenant lifecycle ops: provision, move, restore, delete | rare | Must be per-tenant operations, automatable |
| 4 | Cross-tenant internal analytics, billing, abuse detection | rare | Out of OLTP: CDC to a warehouse, or a role that bypasses RLS on a replica |
| 5 | Migrations | per deploy | One schema, applied everywhere, backward compatible |

Pattern 1 dominating is why `tenant_id` is the natural shard key: almost nothing crosses it ([Ch 12 · Sharding](topic.html?p=12-sharding)). Pattern 4 is the only cross-tenant workload, and it is deliberately moved off the OLTP path.

### The three isolation models

```svg
<svg viewBox="0 0 880 560" width="100%" height="560" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Where does the tenant boundary live?</text>
  <rect x="20" y="40" width="270" height="250" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="155" y="62" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">Pool: shared schema</text>
  <rect x="40" y="76" width="230" height="120" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="155" y="94" text-anchor="middle" fill="#1e293b" font-weight="bold">table tasks</text>
  <rect x="52" y="104" width="206" height="18" fill="#dbeafe" stroke="#94a3b8"/><text x="155" y="117" text-anchor="middle" fill="#1e293b">tenant 7 | task 1 | ...</text>
  <rect x="52" y="124" width="206" height="18" fill="#dcfce7" stroke="#94a3b8"/><text x="155" y="137" text-anchor="middle" fill="#1e293b">tenant 9 | task 1 | ...</text>
  <rect x="52" y="144" width="206" height="18" fill="#dbeafe" stroke="#94a3b8"/><text x="155" y="157" text-anchor="middle" fill="#1e293b">tenant 7 | task 2 | ...</text>
  <rect x="52" y="164" width="206" height="18" fill="#fef3c7" stroke="#94a3b8"/><text x="155" y="177" text-anchor="middle" fill="#1e293b">tenant 3 | task 1 | ...</text>
  <text x="40" y="216" fill="#1e3a8a">boundary: a column + RLS policy</text>
  <text x="40" y="234" fill="#334155">cost per tenant: ~0</text>
  <text x="40" y="252" fill="#334155">migrations: once</text>
  <text x="40" y="270" fill="#991b1b">blast radius of a bug: everyone</text>
  <rect x="305" y="40" width="270" height="250" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Bridge: schema per tenant</text>
  <rect x="325" y="76" width="230" height="120" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="440" y="94" text-anchor="middle" fill="#1e293b" font-weight="bold">one database</text>
  <rect x="337" y="104" width="100" height="36" fill="#ede9fe" stroke="#94a3b8"/><text x="387" y="119" text-anchor="middle" fill="#1e293b">t7.tasks</text><text x="387" y="133" text-anchor="middle" fill="#334155">t7.projects</text>
  <rect x="443" y="104" width="100" height="36" fill="#ede9fe" stroke="#94a3b8"/><text x="493" y="119" text-anchor="middle" fill="#1e293b">t9.tasks</text><text x="493" y="133" text-anchor="middle" fill="#334155">t9.projects</text>
  <rect x="337" y="146" width="206" height="36" fill="#f1f5f9" stroke="#94a3b8"/><text x="440" y="161" text-anchor="middle" fill="#334155">... x 10,000 schemas x 250 tables</text><text x="440" y="175" text-anchor="middle" fill="#991b1b">= 2.5 M relations in the catalog</text>
  <text x="325" y="216" fill="#5b21b6">boundary: search_path + grants</text>
  <text x="325" y="234" fill="#334155">cost per tenant: catalog + files</text>
  <text x="325" y="252" fill="#991b1b">migrations: N times, drift risk</text>
  <text x="325" y="270" fill="#334155">per-tenant dump: easy</text>
  <rect x="590" y="40" width="270" height="250" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="725" y="62" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">Silo: database / cluster per tenant</text>
  <rect x="610" y="76" width="70" height="56" rx="6" fill="#ffffff" stroke="#16a34a"/><text x="645" y="100" text-anchor="middle" fill="#1e293b">t7 DB</text><text x="645" y="116" text-anchor="middle" fill="#334155">pool</text>
  <rect x="690" y="76" width="70" height="56" rx="6" fill="#ffffff" stroke="#16a34a"/><text x="725" y="100" text-anchor="middle" fill="#1e293b">t9 DB</text><text x="725" y="116" text-anchor="middle" fill="#334155">pool</text>
  <rect x="770" y="76" width="70" height="56" rx="6" fill="#ffffff" stroke="#16a34a"/><text x="805" y="100" text-anchor="middle" fill="#1e293b">t3 DB</text><text x="805" y="116" text-anchor="middle" fill="#334155">pool</text>
  <rect x="610" y="140" width="230" height="56" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="725" y="162" text-anchor="middle" fill="#334155">own cluster = own PITR, own region,</text><text x="725" y="178" text-anchor="middle" fill="#334155">own keys, own maintenance window</text>
  <text x="610" y="216" fill="#166534">boundary: server / credentials</text>
  <text x="610" y="234" fill="#991b1b">cost per tenant: high floor</text>
  <text x="610" y="252" fill="#991b1b">migrations: fleet orchestration</text>
  <text x="610" y="270" fill="#166534">blast radius: one tenant</text>
  <rect x="20" y="310" width="840" height="236" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="332" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">The hybrid most SaaS companies converge on</text>
  <rect x="40" y="348" width="250" height="92" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="165" y="370" text-anchor="middle" fill="#1e293b" font-weight="bold">Free + Pro (49,500 tenants)</text>
  <text x="165" y="388" text-anchor="middle" fill="#334155">pool model on a Citus cluster</text>
  <text x="165" y="404" text-anchor="middle" fill="#334155">distributed by tenant_id, co-located</text>
  <text x="165" y="420" text-anchor="middle" fill="#334155">RLS as defence in depth</text>
  <rect x="315" y="348" width="250" height="92" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="370" text-anchor="middle" fill="#1e293b" font-weight="bold">Large tenants (top ~50)</text>
  <text x="440" y="388" text-anchor="middle" fill="#334155">same pool schema, but isolated</text>
  <text x="440" y="404" text-anchor="middle" fill="#334155">to their own shard, then own node</text>
  <text x="440" y="420" text-anchor="middle" fill="#334155">no code change: routing only</text>
  <rect x="590" y="348" width="250" height="92" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="715" y="370" text-anchor="middle" fill="#1e293b" font-weight="bold">Regulated enterprise (~20)</text>
  <text x="715" y="388" text-anchor="middle" fill="#334155">silo: dedicated cluster</text>
  <text x="715" y="404" text-anchor="middle" fill="#334155">same schema, same code</text>
  <text x="715" y="420" text-anchor="middle" fill="#334155">region / keys / PITR per contract</text>
  <text x="40" y="468" fill="#1e293b" font-weight="bold">The trick: ONE schema with tenant_id everywhere, deployed in every placement.</text>
  <text x="40" y="488" fill="#334155">A silo cluster is just a pool with one tenant in it. Moving a tenant between placements is a data copy plus a</text>
  <text x="40" y="506" fill="#334155">directory flip, never a rewrite. Schema-per-tenant is avoided because it scales badly in tenant count and is the one</text>
  <text x="40" y="524" fill="#334155">model that forces a different code path (search_path) from the others.</text>
</svg>
```

### Comparison

| Dimension | Pool (shared schema) | Bridge (schema per tenant) | Silo (DB/cluster per tenant) |
|---|---|---|---|
| Isolation strength | Logical (predicate + RLS); a bug can leak | Namespace + grants; a wrong `search_path` can leak | Physical/credential; strongest |
| Cost floor per tenant | ~0 | Catalog entries, files per table, vacuum per table | A server's worth of overhead (or a database's on a shared cluster) |
| Tenant count it scales to | Millions | Low thousands before catalog pain | Hundreds (per ops team) |
| Migrations | Once | N times, drift and partial failure | N times, fleet orchestration |
| Noisy neighbours | Shared everything; needs quotas | Shared server | Isolated |
| Per-tenant backup/restore | Hard (extract from a full restore) | `pg_dump -n schema` easy; PITR still per cluster | Easy if cluster per tenant; PITR is per **cluster**, not per database |
| Per-tenant deletion | Batched deletes across tables | `DROP SCHEMA ... CASCADE` | `DROP DATABASE` / destroy cluster |
| Cross-tenant analytics | Easy (same tables) | `UNION ALL` over N schemas | Federation / warehouse |
| Connection pooling | One pool | One pool (schema via `search_path`) | Pool per database — multiplies connections |

Two facts from that table deserve emphasis because they are commonly got wrong: **PostgreSQL point-in-time recovery is per cluster** — database-per-tenant on a shared cluster does *not* give per-tenant PITR — and **a pooler holds server connections per (database, user) pair**, so many databases on one server multiply idle connections.

### Consistency and security boundaries

- Every OLTP transaction touches exactly one tenant, therefore (with tenant sharding) exactly one shard: **single-shard ACID, no distributed transactions** in the product path.
- The **application** is the primary enforcer of tenant scoping (every query includes `tenant_id` — needed anyway for index use and shard routing); **RLS** is the second, independent layer that turns a forgotten predicate into zero rows instead of a leak; **composite foreign keys** are the third, preventing cross-tenant references at write time.
- Cross-tenant reads happen only in explicitly privileged paths (billing, analytics) using a separate role, ideally on a replica or warehouse.

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 540" width="100%" height="540" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c40b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c40b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Request path: tenant context, directory, per-tier pools, placements</text>
  <rect x="20" y="40" width="170" height="64" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="105" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Request</text>
  <text x="105" y="80" text-anchor="middle" fill="#334155">JWT: user 55, tenant 7</text>
  <text x="105" y="96" text-anchor="middle" fill="#334155">tier = pro</text>
  <rect x="230" y="40" width="190" height="64" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="325" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">App: tenant middleware</text>
  <text x="325" y="78" text-anchor="middle" fill="#334155">rate limit per tenant (Redis)</text>
  <text x="325" y="94" text-anchor="middle" fill="#334155">look up placement</text>
  <path d="M192,72 L228,72" stroke="#2563eb" stroke-width="2" marker-end="url(#c40b1)"/>
  <rect x="460" y="40" width="190" height="64" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="555" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Tenant directory</text>
  <text x="555" y="78" text-anchor="middle" fill="#334155">tenant to placement, tier,</text>
  <text x="555" y="94" text-anchor="middle" fill="#334155">region, status (cached 30 s)</text>
  <path d="M422,72 L458,72" stroke="#2563eb" stroke-width="2" marker-end="url(#c40b1)"/>
  <rect x="690" y="40" width="170" height="64" rx="8" fill="#ffffff" stroke="#2563eb"/>
  <text x="775" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Every transaction</text>
  <text x="775" y="78" text-anchor="middle" fill="#334155">BEGIN; set_config(</text>
  <text x="775" y="94" text-anchor="middle" fill="#334155">'app.tenant_id','7',true)</text>
  <rect x="20" y="130" width="840" height="70" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="150" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">PgBouncer (transaction pooling): one pool per tier and role</text>
  <rect x="40" y="160" width="250" height="30" rx="5" fill="#ffffff" stroke="#7c3aed"/><text x="165" y="179" text-anchor="middle" fill="#1e293b">app_free: pool_size 20, stmt timeout 2 s</text>
  <rect x="315" y="160" width="250" height="30" rx="5" fill="#ffffff" stroke="#7c3aed"/><text x="440" y="179" text-anchor="middle" fill="#1e293b">app_pro: pool_size 80, stmt timeout 10 s</text>
  <rect x="590" y="160" width="250" height="30" rx="5" fill="#ffffff" stroke="#7c3aed"/><text x="715" y="179" text-anchor="middle" fill="#1e293b">app_reports: pool_size 10, to replicas</text>
  <path d="M325,106 L325,128" stroke="#2563eb" stroke-width="2" marker-end="url(#c40b1)"/>
  <rect x="20" y="226" width="540" height="200" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="290" y="248" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">Pooled Citus cluster (distribution column tenant_id)</text>
  <rect x="40" y="262" width="120" height="50" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="100" y="282" text-anchor="middle" fill="#1e293b" font-weight="bold">coordinator</text><text x="100" y="298" text-anchor="middle" fill="#334155">routes by tenant_id</text>
  <rect x="180" y="262" width="110" height="80" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="235" y="282" text-anchor="middle" fill="#1e293b" font-weight="bold">worker 1</text><text x="235" y="298" text-anchor="middle" fill="#334155">shard groups</text><text x="235" y="314" text-anchor="middle" fill="#334155">~8,000 tenants</text><text x="235" y="330" text-anchor="middle" fill="#334155">co-located</text>
  <rect x="300" y="262" width="110" height="80" rx="6" fill="#ffffff" stroke="#2563eb"/><text x="355" y="282" text-anchor="middle" fill="#1e293b" font-weight="bold">worker 2</text><text x="355" y="298" text-anchor="middle" fill="#334155">shard groups</text><text x="355" y="314" text-anchor="middle" fill="#334155">~8,000 tenants</text><text x="355" y="330" text-anchor="middle" fill="#334155">co-located</text>
  <rect x="420" y="262" width="120" height="80" rx="6" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/><text x="480" y="282" text-anchor="middle" fill="#1e293b" font-weight="bold">worker 9</text><text x="480" y="298" text-anchor="middle" fill="#334155">tenant 1042 only</text><text x="480" y="314" text-anchor="middle" fill="#334155">isolated shard</text><text x="480" y="330" text-anchor="middle" fill="#334155">(3 TB tenant)</text>
  <text x="40" y="364" fill="#334155">reference tables (plans, countries) replicated to every worker</text>
  <text x="40" y="382" fill="#334155">all tables of a tenant on one node: local joins, single-node txns</text>
  <text x="40" y="400" fill="#334155">RLS + composite FKs on every tenant table</text>
  <text x="40" y="418" fill="#334155">replicas for reports; CDC to warehouse for cross-tenant analytics</text>
  <rect x="590" y="226" width="270" height="200" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="725" y="248" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">Silo clusters (enterprise)</text>
  <rect x="610" y="262" width="110" height="56" rx="6" fill="#ffffff" stroke="#16a34a"/><text x="665" y="284" text-anchor="middle" fill="#1e293b">tenant 88</text><text x="665" y="302" text-anchor="middle" fill="#334155">eu-central</text>
  <rect x="730" y="262" width="110" height="56" rx="6" fill="#ffffff" stroke="#16a34a"/><text x="785" y="284" text-anchor="middle" fill="#1e293b">tenant 301</text><text x="785" y="302" text-anchor="middle" fill="#334155">us-east, CMK</text>
  <text x="610" y="342" fill="#334155">same schema, same migrations</text>
  <text x="610" y="360" fill="#334155">own PITR, own maintenance window</text>
  <text x="610" y="378" fill="#334155">own encryption key (crypto-shred)</text>
  <text x="610" y="396" fill="#334155">own pool; cost billed to contract</text>
  <path d="M290,202 L290,224" stroke="#16a34a" stroke-width="2" marker-end="url(#c40b2)"/>
  <path d="M715,202 L715,224" stroke="#16a34a" stroke-width="2" marker-end="url(#c40b2)"/>
  <rect x="20" y="446" width="840" height="80" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="40" y="468" fill="#1e293b" font-weight="bold">Noisy-neighbour controls, outermost first</text>
  <text x="40" y="488" fill="#334155">1. per-tenant API rate limits and concurrency caps   2. per-tier pools (a free tenant cannot take pro connections)</text>
  <text x="40" y="506" fill="#334155">3. per-role statement_timeout / work_mem   4. reports to replicas   5. move the tenant: own shard, own node, own cluster</text>
</svg>
```

### Request lifecycle

```text
1. Auth: the JWT carries user_id and tenant_id (signed; the client never chooses tenant_id freely).
2. Middleware: per-tenant rate limit (token bucket in Redis), look up placement in the directory cache.
3. Acquire a connection from the pool for (placement, tier role).
4. BEGIN; SELECT set_config('app.tenant_id', '7', true);   -- true = transaction-local (SET LOCAL)
5. Application queries, all with WHERE tenant_id = $1 (for routing and index use).
   RLS policies independently restrict every table to tenant 7.
6. COMMIT; the setting vanishes with the transaction; the connection returns to the pool clean.
```

Step 4 is the one that interacts with pooling: in PgBouncer **transaction mode**, consecutive transactions from one client may run on different server connections, and one server connection serves many clients. A session-level `SET app.tenant_id` would stay on the server connection and be inherited by the **next client's** transaction — a cross-tenant leak created by the very mechanism meant to prevent one. `SET LOCAL` / `set_config(..., true)` is scoped to the transaction and cannot leak.

### Moving a big tenant to its own shard or cluster

```text
T0  directory: tenant 1042 -> pool-A (shared shard group)
T1  Citus: isolate_tenant_to_new_shard('tasks', 1042, 'CASCADE')  -- its rows get a dedicated shard group
T2  citus_move_shard_placement(...) / rebalancer -> dedicated worker 9 (online, logical replication based)
    --- or, for a move to a silo cluster (plain Postgres) ---
T1' target: same schema; source: CREATE PUBLICATION t1042 FOR TABLE projects WHERE (tenant_id = 1042), ...  (PG 15+ row filters)
T2' target: CREATE SUBSCRIPTION ... copy_data = true ; initial copy + streaming catch-up (hours for TBs)
T3  verify: per-table row counts and checksums for tenant 1042 on both sides
T4  directory: status = 'moving' -> app rejects/queues writes for 1042 (seconds)
T5  wait until subscription lag = 0 for all tables; flip directory to the new placement; status = 'active'
T6  drop subscription; delete tenant 1042's rows from the source in small batches (background, days)
```

The write freeze at T4–T5 lasts seconds and affects only one tenant. Two prerequisites make this possible: primary keys that are unique **globally** (UUIDs or a global id generator), so the moved rows never collide with rows already on the target and no database-local sequence has to be re-synchronised; and a schema identical in every placement.

## 5. Implementation

### Tenant-scoped schema (pool model)

```sql
CREATE TABLE tenants (
    tenant_id    bigint PRIMARY KEY,
    name         text   NOT NULL,
    tier         text   NOT NULL CHECK (tier IN ('free','pro','enterprise')),
    region       text   NOT NULL,
    status       text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','moving','suspended','deleting')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    tenant_id    bigint NOT NULL REFERENCES tenants,
    user_id      bigint NOT NULL,
    email        citext NOT NULL,
    name         text   NOT NULL,
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE (tenant_id, email)                       -- per-tenant uniqueness: no cross-tenant existence leak
);

CREATE TABLE projects (
    tenant_id    bigint NOT NULL,
    project_id   bigint NOT NULL,
    name         text   NOT NULL,
    owner_id     bigint NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, project_id),
    FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, user_id)
);

CREATE TABLE tasks (
    tenant_id    bigint NOT NULL,
    task_id      bigint NOT NULL,
    project_id   bigint NOT NULL,
    assignee_id  bigint,
    title        text   NOT NULL,
    status       smallint NOT NULL DEFAULT 0,
    due_on       date,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, task_id),
    FOREIGN KEY (tenant_id, project_id)  REFERENCES projects (tenant_id, project_id),
    FOREIGN KEY (tenant_id, assignee_id) REFERENCES users (tenant_id, user_id)
);
CREATE INDEX tasks_by_project  ON tasks (tenant_id, project_id, status, due_on);
CREATE INDEX tasks_by_assignee ON tasks (tenant_id, assignee_id, status) WHERE assignee_id IS NOT NULL;
```

The composite foreign key `(tenant_id, project_id)` is the structural guarantee: a task of tenant 7 physically cannot point at a project of tenant 9, because no row `(7, <tenant 9's project id>)` exists. Every index leads with `tenant_id`, which matches the dominant access pattern and is also what makes each index usable per shard. (With `FOREIGN KEY (tenant_id, assignee_id)` and a `NULL` assignee, the default `MATCH SIMPLE` skips the check — exactly what an optional reference needs.)

### Row-level security

```sql
-- Roles: the application never connects as the table owner or a superuser
CREATE ROLE app_owner NOLOGIN;                 -- owns tables; used only by migrations
CREATE ROLE app_user  LOGIN PASSWORD '...' NOBYPASSRLS;
CREATE ROLE app_free  LOGIN PASSWORD '...' IN ROLE app_user;
CREATE ROLE app_pro   LOGIN PASSWORD '...' IN ROLE app_user;
CREATE ROLE app_reports LOGIN PASSWORD '...' IN ROLE app_user;   -- used only against replicas
GRANT SELECT, INSERT, UPDATE, DELETE ON users, projects, tasks TO app_user;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE  ROW LEVEL SECURITY;   -- apply even to the table owner

CREATE POLICY tenant_isolation ON tasks
    USING      (tenant_id = current_setting('app.tenant_id', true)::bigint)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::bigint);
-- repeat for every tenant-owned table (generate it in the migration tool; test that none is missing)
```

What each piece does:

- `USING` filters rows for `SELECT`, `UPDATE` and `DELETE`; `WITH CHECK` rejects `INSERT`/`UPDATE` that would write a row for another tenant.
- `current_setting('app.tenant_id', true)` returns `NULL` when unset, so a transaction that forgot to set the context sees **zero rows** instead of erroring or seeing everything. (If a session had set the variable and then reset it, it may return an empty string, which fails the `::bigint` cast — an error, which is also safe.)
- `FORCE ROW LEVEL SECURITY` matters because **table owners bypass RLS by default**. Superusers and roles with `BYPASSRLS` **always** bypass it, regardless of `FORCE`. So the application must never connect as the owner, a superuser or a `BYPASSRLS` role — check this in CI.

The transaction pattern in application code:

```go
// WithTenant runs fn in a transaction whose RLS context is the given tenant.
// Transaction-local setting: safe with PgBouncer transaction pooling.
func WithTenant(ctx context.Context, pool *pgxpool.Pool, tenantID int64, fn func(pgx.Tx) error) error {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // no-op after commit
	// set_config(name, value, is_local=true) == SET LOCAL; a bind parameter, so no SQL injection
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`,
		strconv.FormatInt(tenantID, 10)); err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
```

And a regression test that proves the safety net works:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '7', true);
SELECT count(*) FROM tasks;                               -- only tenant 7's rows
SELECT count(*) FROM tasks WHERE tenant_id = 9;           -- 0, even though tenant 9 has rows
INSERT INTO tasks (tenant_id, task_id, project_id, title) VALUES (9, 1, 1, 'x');
-- ERROR:  new row violates row-level security policy for table "tasks"
ROLLBACK;
```

**RLS pitfalls that bite in production**

- **Performance**: the policy predicate is added to every query. `current_setting()` is `STABLE`, so `tenant_id = current_setting(...)::bigint` can use an index that leads with `tenant_id` — but policies that call non-`LEAKPROOF` functions or subqueries can block optimisations such as pushing user predicates below the policy. Keep policies to the simple equality; always also put `tenant_id = $1` in application queries.
- **Views** run with the permissions of the view **owner** by default, so a view owned by a `BYPASSRLS` or owner role exposes all tenants. Use `security_invoker = true` views (PG 15+) or grant carefully.
- **Materialized views** are computed by their owner and have no RLS of their own: a cross-tenant matview is readable in full by anyone granted `SELECT` on it.
- **Referential integrity checks and unique constraints bypass RLS** by design: a global `UNIQUE (email)` leaks existence through the error. Make every uniqueness per tenant.
- **Sequences** are shared: `task_id` values from a global sequence reveal other tenants' activity rate. Prefer random or per-tenant-scoped ids if that matters.
- **Pooled session state**: never `SET` (session) the tenant; always transaction-local. Also never rely on `RESET ALL`/`DISCARD ALL` happening between clients — in transaction mode it does not.

> **MySQL difference:** MySQL has no row-level security. Equivalent defence in depth relies on views with `WHERE tenant_id = <session variable>` combined with `SQL SECURITY DEFINER` and grants only on views (brittle), or on enforcing tenant scoping in a data-access layer / proxy. Vitess can shard by a tenant keyspace id, and composite keys work the same way as above.

### Tenant-based sharding with Citus

```sql
-- On the Citus coordinator
SELECT create_reference_table('tenants');                       -- small, replicated to every worker
SELECT create_distributed_table('users',    'tenant_id');
SELECT create_distributed_table('projects', 'tenant_id', colocate_with => 'users');
SELECT create_distributed_table('tasks',    'tenant_id', colocate_with => 'users');

-- A tenant-scoped join is routed to exactly one worker (router query):
EXPLAIN SELECT t.title, p.name
  FROM tasks t JOIN projects p USING (tenant_id, project_id)
 WHERE t.tenant_id = 7 AND t.status = 0;
```

```text
 Custom Scan (Citus Adaptive)
   Task Count: 1
   Tasks Shown: All
   ->  Task
         Node: host=worker-2 port=5432 dbname=app
         ->  Nested Loop
               ->  Index Scan using tasks_by_project_102041 on tasks_102041 t
                     Index Cond: ((tenant_id = 7) AND (status = 0))
               ...
```

`Task Count: 1` is the property you design for: every product query routes to one node, and the join is local because co-located tables put tenant 7's `tasks` and `projects` shards on the same worker. Joins that do not include `tenant_id` in the join condition (or queries without a tenant filter) fan out to every worker — a code-review red flag.

Isolating and moving a large tenant (online; the move uses logical replication under the hood):

```sql
-- Give tenant 1042 a shard group of its own (all co-located tables, thanks to CASCADE)
SELECT isolate_tenant_to_new_shard('users', 1042, cascade_option => 'CASCADE');
-- Then move that shard group to a dedicated worker
SELECT citus_move_shard_placement(<shard_id>, 'worker-3', 5432, 'worker-9', 5432);
```

Without Citus, the same model works with **application-level sharding**: N Postgres clusters, the tenant directory maps `tenant_id → cluster`, and a tenant move is the logical-replication procedure from section 4 ([Ch 12 · Sharding](topic.html?p=12-sharding)). The directory itself is a tiny table replicated to a highly available store and cached in every app instance with short TTLs; a `moving` status blocks writes during the final flip.

### Schema per tenant (for completeness — and why it is avoided here)

```sql
CREATE SCHEMA t_7;  -- then run all 250 CREATE TABLEs inside it
-- per request: SET LOCAL search_path = t_7, public;
```

It gives easy per-tenant `pg_dump -n t_7` and `DROP SCHEMA t_7 CASCADE`, which is why it is popular for a few hundred tenants. At tens of thousands of tenants it means millions of catalog entries, each backend caching the parts of the catalog it touches (memory per connection grows with the number of relations accessed), autovacuum iterating over millions of tables, `pg_dump` of the whole database taking hours, and every migration executed tenant-by-tenant with the risk of a fleet stuck half-migrated. It also has its own pooling trap: `search_path` set at session level leaks across pooled clients exactly like `app.tenant_id` does.

### Noisy-neighbour controls

```sql
-- Per-tier limits on the database roles (applied at session start)
ALTER ROLE app_free SET statement_timeout = '2s';
ALTER ROLE app_free SET work_mem = '8MB';
ALTER ROLE app_pro  SET statement_timeout = '10s';
ALTER ROLE app_pro  SET work_mem = '32MB';
ALTER ROLE app_free SET idle_in_transaction_session_timeout = '15s';   -- role settings are per login role:
ALTER ROLE app_pro  SET idle_in_transaction_session_timeout = '15s';   -- members do not inherit app_user's
ALTER ROLE app_reports SET statement_timeout = '5min';   -- connects to replicas only
```

```ini
; pgbouncer.ini — separate pools per tier so free traffic cannot starve pro
[databases]
app_free    = host=citus-coord dbname=app user=app_free    pool_size=20
app_pro     = host=citus-coord dbname=app user=app_pro     pool_size=80
app_reports = host=citus-replica dbname=app user=app_reports pool_size=10

[pgbouncer]
pool_mode = transaction
max_client_conn = 20000
```

Role-level `ALTER ROLE ... SET` values are applied when the server connection is established, so they survive transaction pooling (they are not per-client session state). Beyond the database:

- **Per-tenant rate limits** at the API (token bucket in Redis keyed by `tenant_id`), and a per-tenant concurrency cap on expensive endpoints (exports, bulk imports) — the database cannot tell tenants apart inside one pool, so fairness must be enforced before the pool.
- **Attribution**: tag every query with the tenant (`/* tenant=7 route=GET /tasks */` via a query commenter, or `application_name`) so slow-query logs can be aggregated per tenant; recent Citus versions also expose per-tenant statistics (`citus_stat_tenants`). `pg_stat_statements` alone groups by query shape, not by tenant.
- **Placement**: when a tenant is persistently heavy, the fix is not a tighter limit but a different home — isolate its shard, then give it a node ([Ch 21 · Database Scaling](topic.html?p=21-database-scaling)).

### Per-tenant backup, restore and deletion

**Restore one tenant in the pool model** (no per-tenant PITR exists — PITR restores a whole cluster):

```text
1. PITR the relevant cluster/worker to a scratch instance at the requested time (e.g. yesterday 14:00).
2. Extract the tenant:  COPY (SELECT * FROM tasks WHERE tenant_id = 7) TO ...   for every table, in FK order.
3. Decide the merge policy with the customer: replace everything, or restore only deleted rows.
4. In production, inside one transaction per table batch with app.tenant_id = 7:
   replace -> DELETE tenant rows, INSERT restored rows;  deleted-only -> INSERT ... ON CONFLICT DO NOTHING.
5. Audit-log the operation; invalidate caches for the tenant.
```

Automate it; enterprise customers will ask, and doing it by hand at 3 a.m. under pressure is how you restore the wrong tenant. For silo tenants with a cluster each, per-tenant PITR is the native operation — one of the few things silo buys that nothing else does.

**Delete a tenant** (offboarding, GDPR erasure):

```sql
-- 1. Mark deleting: the app stops serving the tenant; directory status = 'deleting'
UPDATE tenants SET status = 'deleting' WHERE tenant_id = 7;

-- 2. Batched deletes, children before parents, small batches to limit WAL, locks and replica lag
DELETE FROM tasks WHERE (tenant_id, task_id) IN (
    SELECT tenant_id, task_id FROM tasks WHERE tenant_id = 7 LIMIT 5000);
-- loop until 0 rows; then projects, then users ...

-- 3. Derived stores: search index, caches, object storage prefix tenants/7/, warehouse, CDC topics (compacted tombstones)
-- 4. Backups: rows persist in backups until they age out (document the retention, e.g. 35 days) —
--    or use per-tenant encryption keys for sensitive columns/objects and destroy the key (crypto-shredding)
-- 5. Record a deletion certificate: what, where, when, by which job
```

Big deletes create dead tuples and bloat ([Ch 03 · MVCC](topic.html?p=03-mvcc)); for large tenants it is often cheaper to **isolate the tenant to its own shard first and then drop that shard**, turning a multi-day delete into a metadata operation — the same trick as dropping a partition instead of deleting rows ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)).

### Diagnostics

```sql
-- Which tenants are running the slowest statements right now? (requires the query-comment tag)
SELECT substring(query from 'tenant=(\d+)') AS tenant, count(*) AS active,
       max(now() - query_start) AS longest
  FROM pg_stat_activity
 WHERE state = 'active' AND query LIKE '%tenant=%'
 GROUP BY 1 ORDER BY longest DESC LIMIT 10;

-- Is any tenant table missing RLS? (run in CI after every migration)
SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')
   AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);

-- Does the application role bypass RLS? Must return false/false.
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user';
```

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Default isolation model | Pool (shared schema) | Schema per tenant; DB per tenant | Scales to any tenant count, one migration, near-zero cost per tenant. |
| Enterprise isolation | Same schema on a dedicated shard or cluster | A separate codebase/schema for enterprise | Isolation by placement, not by code path. |
| Tenant scoping | App predicate + RLS + composite FKs | App predicate only; RLS only | Three independent layers; RLS alone hurts routing/indexing, app alone leaks on the first bug. |
| Tenant context | `set_config(..., true)` per transaction | Session `SET`; connection per tenant | Safe with transaction pooling. |
| Sharding | Citus distributed by `tenant_id`, co-located | Shard by entity id; app sharding from day one | Single-node joins and transactions per tenant; tenant isolation functions built in. App-level sharding is the alternative without Citus. |
| Keys | `(tenant_id, id)` composite PKs, global-unique ids | Global single-column ids | Co-location, FK integrity, painless tenant moves. |
| Noisy neighbours | Rate limits, per-tier pools, role timeouts, placement | Bigger hardware | Fairness is a policy; hardware only delays the incident. |
| Per-tenant restore (pool) | Scratch PITR + extract + merge, automated | Per-tenant logical dumps nightly | Dumps of 50 K tenants nightly are expensive and not point-in-time. |

### When to use each model

- **Pool**: the default for B2B and B2C SaaS with many tenants, especially with a free tier. Needs discipline (RLS, composite keys, quotas).
- **Bridge (schema per tenant)**: tens to a few hundred tenants, each substantial, where per-tenant dump/restore and occasional per-tenant customisations matter more than tenant-count scalability.
- **Silo**: regulated or very large tenants who pay for it — data residency, customer-managed keys, contractual isolation, per-tenant PITR, their own maintenance windows.

### When NOT to use them

- **Do not use pool** without RLS or an equivalent enforced layer if you have many engineers writing queries; and not for tenants whose contracts forbid co-mingling.
- **Do not use bridge** past low thousands of tenants, or with a pooler and session-level `search_path`.
- **Do not use silo** for a free tier or anything self-serve at volume: the cost floor and migration fleet will dominate engineering time.

## 7. Common Mistakes & Best Practices

- **`tenant_id` "where needed".** Missing on child tables because "you can join through the parent". It hurts routing, indexing, RLS and deletion. Instead: `tenant_id` on every tenant-owned table, first in the PK and every index.
- **Global unique constraints.** `UNIQUE (email)` leaks existence and blocks legitimate use. Instead: `UNIQUE (tenant_id, email)`; a separate global identity table only if login needs global emails, holding no tenant data.
- **FKs without `tenant_id`.** Allows cross-tenant references. Instead: composite FKs `(tenant_id, x_id)`.
- **Connecting as the table owner or a superuser.** RLS silently does nothing for superusers and `BYPASSRLS` roles, and for the owner unless `FORCE`. Instead: a dedicated `NOBYPASSRLS` application role; `FORCE ROW LEVEL SECURITY`; CI checks.
- **Session-level `SET app.tenant_id` behind PgBouncer transaction pooling.** The next client inherits the previous tenant's context. Instead: `SET LOCAL` / `set_config(..., true)` inside every transaction.
- **Relying on RLS instead of predicates.** Queries without `tenant_id = $1` cannot be routed to a shard and may not use indexes as well. Instead: always both.
- **Cross-tenant reporting on the OLTP primary.** Scans every tenant and fans out to every shard. Instead: CDC to a warehouse.
- **One pool for all tiers.** A free-tier import storm takes every connection. Instead: per-tier pools and per-tenant concurrency caps.
- **Treating the biggest tenant like the others.** Its statistics, locks and vacuum dominate a shared shard. Instead: detect growth early and isolate it proactively.
- **Promising per-tenant PITR on shared clusters.** It does not exist. Instead: automate scratch-restore-and-extract and state its RTO honestly, or sell silo.
- **Forgetting derived data on deletion.** Search indexes, caches, object storage, warehouses and backups all hold tenant data. Instead: a deletion workflow with a checklist per store and a certificate.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Scaling path

Following [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) and sized with [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning):

- **Day 1** — one Postgres, pool model, composite keys, RLS, per-tier roles. Everything above costs almost nothing to adopt now and is very expensive to retrofit (adding `tenant_id` to 250 tables later is a multi-quarter migration — [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)).
- **10×** — PgBouncer with per-tier pools, read replicas for reports, per-tenant rate limits, query tagging by tenant.
- **100×** — distribute by `tenant_id` (Citus, or app-level shards with a directory); add workers as tenants grow; rebalance shard groups by size.
- **Whales** — isolate the top tenants to their own shard groups and nodes; offer silo clusters for regulated enterprise customers, deployed from the same migrations.
- **Multi-region** — tenants are homed in a region (data residency); the directory routes by tenant; cross-region only for global metadata ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)).

### Failure scenarios

- **At 10:15, support gets a ticket: "I can see another company's projects."** Root cause: a new internal endpoint used a connection from the `app_owner` pool (the migration role) "temporarily", so RLS did not apply, and its query omitted `tenant_id`. Symptoms were invisible until a customer noticed. Fix: revoke login from the owner role, CI check that the app's roles are `NOBYPASSRLS` and tables `FORCE ROW LEVEL SECURITY`, and a canary test that runs every endpoint as tenant A against a database seeded with tenant B's data and fails on any B row. Then the incident process: scope, notify, audit logs.
- **p99 for all pro tenants triples every Monday at 09:00.** Root cause: one enterprise tenant in the pool runs a weekly export that scans 400 GB on the shared worker, evicting everyone's hot pages from shared buffers and saturating IO. Fix: exports go to a replica pool with its own timeout; then isolate the tenant to its own node. Detected by per-tenant attribution of IO in slow-query logs.
- **After enabling PgBouncer transaction pooling, a small number of requests return data from the wrong tenant.** Root cause: a legacy code path used session-level `SET app.tenant_id` outside a transaction. Fix: transaction-local setting only; a lint rule rejecting `SET app.` without `LOCAL`; RLS policies that return zero rows when the setting is missing narrow the damage but do not help when a *stale* setting is present — which is why this is so dangerous.
- **A migration fails halfway in schema-per-tenant.** 3,100 of 8,000 schemas have the new column; the deploy is stuck because new code expects it and old code cannot handle it. Fix: expand/contract migrations that are backward compatible, idempotent per-schema migration jobs with a progress table — or, better, move off schema-per-tenant.
- **A tenant move's final flip takes 20 minutes instead of seconds.** Root cause: the subscription was lagging because the tenant ran a bulk import during the move; writes were frozen while waiting for lag to reach zero. Fix: only enter the freeze when lag is under a threshold (for example under 1 s) and abort/retry the flip otherwise; schedule moves for the tenant's quiet hours.
- **Tenant deletion job causes replica lag of 10 minutes.** Root cause: 200 M-row delete in large batches generating WAL faster than replicas replay. Fix: smaller batches with sleeps, lag-aware throttling, or isolate-then-drop for large tenants.

### Monitoring

| Metric | Why | Alert when |
|---|---|---|
| Per-tenant query time / IO share (from tagged logs, `citus_stat_tenants`) | noisy-neighbour detection | one tenant > 20% of a node |
| Per-tier pool saturation (`SHOW POOLS`: `cl_waiting`, `maxwait`) | tier fairness | waiting > 0 for 30 s |
| Tables without forced RLS; app roles with BYPASSRLS | security invariants | any (CI and runtime) |
| Tenant size and growth; shard group size skew | when to isolate or rebalance | tenant > 5% of a worker |
| Directory lookups failing / stale | routing correctness | any |
| Deletion and restore job progress/age | lifecycle SLAs | past SLA |
| Replica lag on report replicas | report freshness | > 60 s |

### Backups, DR and lifecycle

- Cluster-level PITR for each placement ([Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery)); automated, rehearsed per-tenant restore runbook; silo tenants get their own PITR and, if contracted, their own region and keys.
- The tenant directory is tiny but critical: back it up and replicate it like the most important table you own, because without it nothing routes.
- Lifecycle ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)): suspended tenants can be moved to cold, cheaper shards; deleted tenants are purged by a workflow covering every derived store; backup retention documented in the contract.

## 9. Interview Questions

**Q: Compare shared schema, schema per tenant and database per tenant.**
A: Shared schema puts all tenants in the same tables with a `tenant_id` column; it is cheapest, scales to any number of tenants and needs one migration, but isolation is logical, so a bug can leak and noisy neighbours share everything. Schema per tenant gives each tenant its own namespace in one database, making per-tenant dump and drop easy, but catalog size, vacuum and migrations scale with tenant count and become painful beyond a few thousand tenants. Database or cluster per tenant gives the strongest isolation, per-tenant maintenance and, with a cluster each, per-tenant PITR, but has a high cost floor and turns migrations into fleet orchestration. Most SaaS companies run a hybrid: pool for the many, silo for the few who pay for it.

**Q: How does row-level security work in Postgres and how do you wire it to the tenant?**
A: You enable RLS on a table and create a policy whose `USING` expression filters rows for reads, updates and deletes and whose `WITH CHECK` expression validates inserted and updated rows. The policy compares `tenant_id` to `current_setting('app.tenant_id', true)`, and the application sets that value at the start of every transaction with `set_config('app.tenant_id', $1, true)`, which is transaction-local. If the setting is missing the policy yields no rows. It is defence in depth: the application still filters by `tenant_id` for routing and index use.

**Q: What are the ways RLS can be bypassed?**
A: Superusers and roles with `BYPASSRLS` always bypass it, and the table owner bypasses it unless `FORCE ROW LEVEL SECURITY` is set, so the application must use a dedicated non-owner, non-bypass role. Views execute with their owner's rights by default, so a view owned by a privileged role exposes all rows unless it is a `security_invoker` view. Materialized views have no RLS of their own. Unique constraints and foreign-key checks are enforced regardless of RLS and can leak existence through errors. And a session-level tenant setting leaking across pooled connections defeats it entirely.

**Q: Why use composite primary and foreign keys with `tenant_id`?**
A: Composite FKs such as `(tenant_id, project_id) REFERENCES projects (tenant_id, project_id)` make it structurally impossible for a row to reference another tenant's row, catching bugs at write time. Leading every key and index with `tenant_id` matches the dominant access pattern, and in a sharded system it is what lets every table be distributed and co-located by tenant, so joins and transactions stay on one node. It also makes tenant moves and deletions straightforward, because every row carries its tenant.

**Q: How does connection pooling interact with tenant context?**
A: In PgBouncer transaction mode, server connections are shared between clients transaction by transaction, so any session-level state — `SET app.tenant_id`, `search_path`, temp tables, advisory locks — can outlive the client that set it and be inherited by another. For tenant context that means a cross-tenant leak. The fix is to set the tenant only transaction-locally, with `SET LOCAL` or `set_config(..., true)`, inside every transaction. Role-level settings via `ALTER ROLE ... SET` are fine because they are applied when the server connection is created.

**Q: How do you shard a multi-tenant database?**
A: By `tenant_id`, because almost every query is scoped to one tenant. With Citus you distribute every tenant table on `tenant_id` and co-locate them, so a tenant's rows of all tables live in the same shard group and a tenant-scoped join routes to one worker; small global tables become reference tables replicated everywhere. Without Citus you run several Postgres clusters and a tenant directory that maps tenants to clusters. Either way the power-law distribution means you also need a way to isolate the largest tenants.

**Q: How do you handle noisy neighbours?**
A: In layers. At the API, per-tenant rate limits and concurrency caps on expensive endpoints, because the database cannot distinguish tenants within one pool. At the pooler, separate pools per tier so free traffic cannot take pro connections. At the database, per-role `statement_timeout`, `work_mem` and idle-in-transaction timeouts, with heavy reports routed to replicas. And when a tenant is persistently heavy, placement: isolate it to its own shard and node. Per-tenant attribution through query tags is what tells you who the neighbour is.

**Q: How do you delete a tenant completely?**
A: Mark the tenant as deleting so the app stops serving it, then delete its rows in small batches in foreign-key order, throttled by replica lag, or for a large tenant isolate it to its own shard and drop the shard. Then purge derived stores — search indexes, caches, object storage, the warehouse, event topics — from a checklist. Backups keep the data until they age out, which must be documented, or sensitive data is encrypted with a per-tenant key that is destroyed. Finally record a deletion certificate for compliance.

**Q: An enterprise customer asks you to restore their workspace to yesterday at 14:00. You use the pool model. What do you do? (Senior)**
A: PITR in Postgres is per cluster, so I cannot rewind one tenant in place. I restore the relevant cluster or worker to a scratch instance at that time, extract the tenant's rows from every table with `WHERE tenant_id = X` in foreign-key order, and agree the merge semantics with the customer — full replacement or only recovering deleted rows. Then I apply it in production in batches under the tenant's RLS context, invalidate caches and log the operation. This must be an automated, rehearsed runbook with a known RTO; if customers need it routinely, that is the argument for selling them a silo cluster with native PITR.

**Q: One tenant has grown to 3 TB and 15% of traffic. How do you move it without downtime? (Senior)**
A: With Citus I isolate the tenant into its own shard group with `isolate_tenant_to_new_shard` and cascade, then move that shard group to a dedicated worker; the move uses logical replication and only briefly blocks writes to those shards at cut-over. Without Citus I create row-filtered publications for the tenant's rows on the source, subscribe from the target cluster, let it copy and catch up, verify counts and checksums, set the tenant to `moving` in the directory to freeze its writes for seconds, wait for zero lag, flip the directory and unfreeze, then delete the old rows in the background. Prerequisites are globally unique ids and an identical schema in every placement, and the freeze should only start when lag is already small.

**Q: Your team proposes schema-per-tenant for 30,000 tenants because "it isolates better". How do you respond? (Senior)**
A: Its isolation is namespace-level, not much stronger than RLS: a wrong `search_path` — for example set at session level behind a transaction pooler — leaks just like a missing predicate. Meanwhile it multiplies relations to millions, which inflates the catalog, per-backend catalog caches, autovacuum work and `pg_dump` time, and turns every migration into 30,000 migrations with partial-failure and drift risk. I would propose the pool model with composite keys, forced RLS, a non-bypass app role and CI checks for isolation, plus silo placement for the few tenants who contractually need physical isolation. If a team needs per-tenant customisation, JSONB extension columns in the shared schema usually cover it.

**Q: How would you prove to an auditor that tenants are isolated? (Senior)**
A: I would show layered, tested controls rather than a promise. Structural: composite foreign keys and per-tenant unique constraints on every table. Enforced: forced RLS on every tenant table, application roles without `BYPASSRLS`, verified by catalog queries in CI and at runtime. Behavioural: an automated suite that runs every API endpoint as tenant A against data seeded for tenant B and fails on any B row, run on each deploy. Operational: privileged cross-tenant access only through separate roles, on replicas or the warehouse, with audit logs, and documented deletion and restore procedures with evidence of execution.

## 10. Quick Revision & Cheat Sheet

| Concern | Design |
|---|---|
| Default model | Pool: shared tables, `tenant_id` on every tenant table |
| Keys | PK `(tenant_id, id)`; FKs `(tenant_id, x_id)`; `UNIQUE (tenant_id, ...)`; globally unique ids |
| Indexes | lead with `tenant_id` |
| RLS | `ENABLE` + `FORCE`; policy `tenant_id = current_setting('app.tenant_id', true)::bigint` with `WITH CHECK` |
| Context | `set_config('app.tenant_id', $1, true)` in every transaction; never session `SET` behind a pooler |
| Roles | app role `NOBYPASSRLS`, not owner, not superuser; owner role only for migrations |
| Sharding | Citus `create_distributed_table(..., 'tenant_id')`, co-located; reference tables for globals; or app shards + directory |
| Whales | `isolate_tenant_to_new_shard` then move to a dedicated node; or logical replication with row filters to a silo |
| Noisy neighbours | API rate limits, per-tier pools, per-role timeouts/work_mem, reports on replicas, placement |
| Restore one tenant | scratch PITR, extract by `tenant_id`, merge (PITR is per cluster) |
| Delete a tenant | status `deleting`, batched deletes or drop isolated shard, purge derived stores, backups/crypto-shred, certificate |

- Tenants follow a power law; design for the median and the whale separately.
- One schema, many placements: silo is a pool with one tenant in it.
- Three layers of isolation: predicate, RLS, composite keys.
- Transaction pooling + session state = cross-tenant leak.
- Superusers, `BYPASSRLS` and (without `FORCE`) owners ignore RLS.
- Per-tenant PITR exists only if the tenant has its own cluster.
- Put `tenant_id` in from day one; retrofitting it is the most expensive migration in SaaS.

## 11. Hands-On Exercises

Lab: `docker run --name saas -e POSTGRES_PASSWORD=pw -p 5432:5432 -d postgres:17`. For Citus exercises use `citusdata/citus` images (a coordinator and two workers via its docker-compose).

1. **RLS end to end.** Create the schema, roles and policies above. Seed two tenants. As `app_user`, verify you see only one tenant's rows after `set_config`, zero rows without it, and an error when inserting the other tenant's row. Then connect as the owner without `FORCE` and see RLS disappear.
2. **The pooling leak.** Put PgBouncer in transaction mode in front of the database. From client A run `SET app.tenant_id = '7'` (session) and a query; from client B run a query without setting the tenant. Observe B reading tenant 7's rows. Switch to `set_config(..., true)` and show the leak is gone.
3. **Composite FKs.** Try to insert a task for tenant 7 referencing tenant 9's project, with single-column FKs and then with composite FKs.
4. **Citus routing.** Distribute the tables by `tenant_id`, co-locate them, and compare `EXPLAIN` for a tenant-scoped join (Task Count: 1) against a join missing `tenant_id` (fan-out). Then isolate one tenant and move its shard to the other worker.
5. **Noisy neighbour.** With pgbench, run a "free" workload of heavy scans and a "pro" workload of point queries through a single pool, measure pro p99; then split into per-tier pools with role timeouts and measure again.
6. **Tenant move without Citus.** Using two Postgres containers and a publication with a row filter (`WHERE (tenant_id = 7)`), move tenant 7 while a script keeps writing to it; implement the freeze-wait-flip sequence and verify no writes are lost.

**Mini project — tenant platform toolkit.** Build a CLI with `tenant create`, `tenant move --to <cluster>`, `tenant restore --at <timestamp>` (scratch restore + extract + merge) and `tenant delete` (batched, lag-aware, with a deletion certificate), backed by a tenant directory table. Add a CI job that fails if any table with a `tenant_id` column lacks forced RLS, any FK to a tenant table omits `tenant_id`, or any app role can bypass RLS.

## 12. Related Topics & Free Learning Resources

**Concept chapters this design applies**

- [Ch 03 · MVCC](topic.html?p=03-mvcc) — why bulk tenant deletes bloat.
- [Ch 09 · Replication](topic.html?p=09-replication) — logical replication with row filters for tenant moves; replicas for reports.
- [Ch 12 · Sharding](topic.html?p=12-sharding) — `tenant_id` as the shard key, directories, rebalancing.
- [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) — Citus coordinator/worker model.
- [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) — tenant homing and data residency.
- [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) — pooling modes, timeouts, session state.
- [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) and [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) — the ladder and power-law sizing.
- [Ch 26 · Backup & DR](topic.html?p=26-backup-disaster-recovery) — PITR is per cluster.
- [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) — migrations across many tenants and placements.
- [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) — tenant deletion and retention.
- Sibling case studies: [Ch 31 · E-commerce Database](topic.html?p=31-case-ecommerce), [Ch 38 · Order System](topic.html?p=38-case-order-system).

**SQL Handbook:** [Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Schema Design](../sql/topic.html?p=30-schema-design) · [Index Design](../sql/topic.html?p=20-index-design) · [Views](../sql/topic.html?p=31-views)

**Other handbooks:** [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling) · [System Design · Rate Limiting](../system-design/topic.html?p=26-rate-limiting) · [System Design · Auth](../system-design/topic.html?p=31-auth) · [Caching with Redis · Sorted Sets & Rate Limiting](../redis-caching/topic.html?p=19-sorted-sets-rate-limiting)

**Free resources**

- **PostgreSQL Documentation: Row Security Policies** — PostgreSQL · *Intermediate* · `ENABLE`/`FORCE`, `USING` vs `WITH CHECK`, who bypasses RLS. <https://www.postgresql.org/docs/current/ddl-rowsecurity.html>
- **PostgreSQL Documentation: CREATE PUBLICATION (row filters)** — PostgreSQL · *Advanced* · row-filtered logical replication for moving one tenant. <https://www.postgresql.org/docs/current/sql-createpublication.html>
- **Citus Documentation: Multi-tenant Applications** — Citus Data · *Intermediate* · distributing by tenant, co-location, reference tables, tenant isolation. <https://docs.citusdata.com/en/stable/use_cases/multi_tenant.html>
- **PgBouncer Features** — PgBouncer · *Intermediate* · which session features break in transaction pooling. <https://www.pgbouncer.org/features.html>
- **SaaS Tenant Isolation Strategies (whitepaper)** — AWS · *Intermediate* · silo, pool and bridge models and their trade-offs. <https://docs.aws.amazon.com/whitepapers/latest/saas-tenant-isolation-strategies/saas-tenant-isolation-strategies.html>
- **Multi-tenant SaaS database tenancy patterns** — Microsoft Learn · *Intermediate* · single-tenant, multi-tenant and sharded multi-tenant databases compared. <https://learn.microsoft.com/en-us/azure/azure-sql/database/saas-tenancy-app-design-patterns>
- **Designing Data-Intensive Applications, ch. 6** — Martin Kleppmann · *Advanced* · partitioning, skew and rebalancing — the theory behind tenant sharding. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 40.*
