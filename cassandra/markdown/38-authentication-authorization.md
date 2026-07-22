# 38 · Authentication, Authorization & RBAC

> **In one line:** Cassandra ships wide open by default, and hardening it means switching on internal auth, replacing the `cassandra/cassandra` superuser, replicating `system_auth` properly, and designing roles so no application ever holds more privilege than the one keyspace it needs.

---

## 1. Overview

A freshly installed Cassandra node accepts any connection from anyone who can reach port 9042, as user `anonymous`, with full permission on everything. That is not a bug — it is the default `AllowAllAuthenticator`, chosen because Cassandra was born inside a trusted datacenter perimeter at Facebook in 2008 and later ran mostly behind firewalls at Netflix and Twitter. In 2026 that assumption is indefensible: clusters run in shared VPCs, developers connect from laptops through bastions, and compliance frameworks require per-identity attribution. Turning on authentication and authorization is therefore the first item on every production checklist.

The problem this subsystem solves is threefold. **Authentication** answers "who are you" — Cassandra's built-in `PasswordAuthenticator` stores bcrypt-hashed credentials in the `system_auth.roles` table, so identity is verified by the cluster itself with no external dependency. **Authorization** answers "what may you do" — `CassandraAuthorizer` maintains a permission graph in `system_auth.role_permissions`, mapping roles to `SELECT`, `MODIFY`, `CREATE`, `ALTER`, `DROP`, `AUTHORIZE`, `DESCRIBE`, and `EXECUTE` on resources ranging from a single table to `ALL KEYSPACES`. **Role-based access control** ties the two together: roles can be granted to other roles, forming an inheritance graph so you define `app_reader` once and grant it to five service accounts.

The design has a specific historical shape. Before Cassandra 2.2, the model was flat users (`CREATE USER`), and `CREATE ROLE` superseded it in `CASSANDRA-7653`. The old `CREATE USER` syntax still works and is silently translated into role operations, which is why you will still find it in old runbooks. Cassandra 4.0 added `system_views` and audit logging that make auth activity observable, and 4.1 added network authorization (`CassandraNetworkAuthorizer`) so a role can be restricted to specific datacenters — useful when analytics jobs must only ever touch the analytics DC.

The single most consequential operational detail is the `system_auth` keyspace. It ships with `SimpleStrategy` and `RF=1`. If the one node holding your credentials goes down, *nobody can log in* — not your application, not you. Worse, authentication reads default to `LOCAL_QUORUM` for non-superusers but **`QUORUM` for the `cassandra` superuser**, which means the built-in superuser cannot log in during a partition. Every real production incident in this area starts with someone forgetting to `ALTER KEYSPACE system_auth WITH replication = {'class':'NetworkTopologyStrategy','dc1':3,'dc2':3}` and then running `nodetool repair system_auth`.

A concrete example: a payments platform runs one Cassandra cluster serving three services — a ledger writer, a reconciliation reader, and a reporting job. Without RBAC, all three share one credential with full cluster access, so a bug in the reporting job can `TRUNCATE` the ledger. With RBAC you define `ledger_writer` (SELECT + MODIFY on `payments.ledger` only), `ledger_reader` (SELECT on `payments.*`), and `reporting` (SELECT on `payments.summary_*` only, restricted to `dc_analytics` by network authorization). Now a compromised reporting credential exposes summaries in one datacenter, not the ledger. That containment is the entire point.
## 2. Core Concepts

- **Authenticator** — the pluggable component verifying identity. `AllowAllAuthenticator` (default, no auth), `PasswordAuthenticator` (internal bcrypt credentials), or a custom/LDAP/Kerberos implementation.
- **Authorizer** — the pluggable component deciding permissions. `AllowAllAuthorizer` (default, everything permitted) or `CassandraAuthorizer` (permission graph in `system_auth`).
- **Role** — the unified principal since 2.2. A role may be `LOGIN` (usable as a credential), `SUPERUSER` (bypasses all permission checks), or neither (a pure permission bundle).
- **Role inheritance** — `GRANT role_a TO role_b` makes `role_b` inherit every permission of `role_a`, transitively. The graph must be acyclic.
- **Resource** — the object a permission applies to: `ALL KEYSPACES`, `KEYSPACE ks`, `TABLE ks.tbl`, `ALL ROLES`, `ROLE r`, `ALL FUNCTIONS`, `FUNCTION ks.f`, or `ALL MBEANS`.
- **Permission** — one of `CREATE`, `ALTER`, `DROP`, `SELECT`, `MODIFY`, `AUTHORIZE`, `DESCRIBE`, `EXECUTE`, `UNMASK`, `SELECT_MASKED` (the last two are 5.0 dynamic data masking).
- **`system_auth`** — the keyspace holding `roles`, `role_members`, `role_permissions`, and `network_permissions`. Must be replicated to every datacenter.
- **Permissions cache** — in-memory cache of resolved permissions (`permissions_validity`, default 2000 ms) that keeps auth from hammering `system_auth` on every query.
- **Network authorization** — `CassandraNetworkAuthorizer` (4.1+) restricting a role to a set of datacenters via `ACCESS TO DATACENTERS {...}`.
- **Superuser trap** — the default `cassandra/cassandra` account, which authenticates at `QUORUM` (not `LOCAL_QUORUM`) and bypasses authorization entirely.
## 3. Theory & Internals

### 3.1 The authentication path

When a driver opens a CQL connection it performs the native-protocol `STARTUP` handshake. If the server's authenticator requires credentials it replies `AUTHENTICATE` with the authenticator class name. The driver responds `AUTH_RESPONSE` carrying a SASL PLAIN token (`\0username\0password`). `PasswordAuthenticator.legacyAuthenticate` then issues an internal read:

```
SELECT salted_hash FROM system_auth.roles WHERE role = ?
```

at consistency `LOCAL_QUORUM` — or `QUORUM` when the role is the default `cassandra` superuser, a deliberate safety measure so the well-known default account is harder to use during a partition. The returned bcrypt hash is compared with `BCrypt.checkpw`. Bcrypt is intentionally slow (default cost factor 10, roughly 60–100 ms per check on modern CPUs), which is why the **credentials cache** exists: `credentials_validity` (default 2000 ms) caches the result so a reconnect storm does not turn into a CPU storm.

> **Note:** Because bcrypt verification is expensive, applications must use long-lived pooled sessions. A pattern that opens a new `Cluster`/`Session` per request will pay 60–100 ms of bcrypt per connection and can saturate the auth stage entirely.

### 3.2 The authorization path

After login, every statement is checked against the permission graph. `CassandraAuthorizer.authorize(role, resource)` walks the resource hierarchy from most specific to least specific — `TABLE payments.ledger` → `KEYSPACE payments` → `ALL KEYSPACES` — accumulating permissions, and simultaneously walks the role inheritance graph from the logged-in role through all granted roles. A permission is granted if *any* (role, resource) pair in the closure carries it.

```
effective(role) = ⋃  perms(r, res)
                r ∈ closure(role)
                res ∈ ancestors(target_resource)
```

This is a union, never an intersection: **there is no DENY in Cassandra**. You cannot grant `SELECT` on a keyspace and then revoke it for one table. Least privilege must be built by granting narrowly, not by subtracting.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="380" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Role inheritance graph and resource hierarchy</text>
<text x="20" y="58" font-size="12" font-weight="bold" fill="#1e293b">Roles (closure walked upward)</text> <rect x="20" y="70" width="140" height="42" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="34" y="96" font-size="12" fill="#1e293b">svc_ledger (LOGIN)</text> <rect x="20" y="140" width="140" height="42" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="34" y="166" font-size="12" fill="#1e293b">ledger_writer</text> <rect x="20" y="210" width="140" height="42" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="34" y="236" font-size="12" fill="#1e293b">payments_reader</text> <path d="M90 112 L90 140" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a38)"/>
<path d="M90 182 L90 210" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a38)"/> <text x="100" y="132" font-size="10" fill="#1e293b">GRANT</text>
<text x="100" y="202" font-size="10" fill="#1e293b">GRANT</text> <text x="300" y="58" font-size="12" font-weight="bold" fill="#1e293b">Resources (checked most specific first)</text>
<rect x="300" y="70" width="200" height="42" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="314" y="96" font-size="12" fill="#1e293b">TABLE payments.ledger</text>
<rect x="300" y="140" width="200" height="42" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="314" y="166" font-size="12" fill="#1e293b">KEYSPACE payments</text>
<rect x="300" y="210" width="200" height="42" rx="8" fill="#fef3c7" stroke="#d97706"/> <text x="314" y="236" font-size="12" fill="#1e293b">ALL KEYSPACES</text>
<path d="M400 112 L400 140" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a38)"/> <path d="M400 182 L400 210" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a38)"/>
<rect x="540" y="70" width="200" height="182" rx="8" fill="#eef2ff" stroke="#4f46e5"/> <text x="554" y="94" font-size="12" font-weight="bold" fill="#1e293b">Effective permission</text>
<text x="554" y="118" font-size="11" fill="#1e293b">UNION over role closure</text> <text x="554" y="138" font-size="11" fill="#1e293b">x resource ancestors</text>
<text x="554" y="164" font-size="11" fill="#1e293b">No DENY exists.</text> <text x="554" y="184" font-size="11" fill="#1e293b">You cannot subtract a</text>
<text x="554" y="202" font-size="11" fill="#1e293b">permission once a broader</text> <text x="554" y="220" font-size="11" fill="#1e293b">grant covers the resource.</text>
<text x="554" y="242" font-size="11" fill="#1e293b">Grant narrowly instead.</text> <rect x="20" y="286" width="720" height="76" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="36" y="310" font-size="12" font-weight="bold" fill="#1e293b">Superuser bypass</text>
<text x="36" y="332" font-size="11" fill="#1e293b">A role with SUPERUSER skips the graph walk entirely: every check returns true.</text>
<text x="36" y="352" font-size="11" fill="#1e293b">The default cassandra role also authenticates at QUORUM, not LOCAL_QUORUM.</text> <defs>
<marker id="a38" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"> <path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```

### 3.3 Caching and consistency

Three caches govern auth performance, all configurable in `cassandra.yaml`:

| Cache | Setting | Default | What it holds |
|---|---|---|---|
| Credentials | `credentials_validity` | 2000 ms | bcrypt verification results |
| Permissions | `permissions_validity` | 2000 ms | resolved (role, resource) permission sets |
| Roles | `roles_validity` | 2000 ms | role definitions and membership |

Each has a matching `*_update_interval` for asynchronous refresh and `*_cache_max_entries` (default 1000). The consequence of caching is that **a `REVOKE` is not instantaneous** — it takes effect after the validity window plus the time for the `system_auth` write to propagate to the node serving the session. For emergency revocation you must also flush the cache via JMX (`org.apache.cassandra.auth:type=PermissionsCache` → `invalidate()`) on every node, or simply raise validity to 0 for high-security clusters at a meaningful latency cost.

Because `system_auth` is a normal keyspace, its reads obey normal consistency rules. With `RF=3` per DC and `LOCAL_QUORUM` reads, two of three replicas per DC must be up for logins to succeed. Set `RF` equal to the number of nodes in small DCs (up to 3–5), and always run `nodetool repair system_auth` after changing replication, because credentials written before the change exist on the wrong nodes.
## 4. Architecture & Workflow

The end-to-end path from `cqlsh -u alice` to a row being returned:

1. **Driver connects** to the coordinator on port 9042 and sends `STARTUP`.
2. **Server responds `AUTHENTICATE`** naming `org.apache.cassandra.auth.PasswordAuthenticator`.
3. **Driver sends `AUTH_RESPONSE`** with a SASL PLAIN token. If TLS is not enabled, this password crosses the network in plaintext — which is why chapter 39 on encryption is a hard prerequisite, not an optional companion.
4. **Coordinator reads `system_auth.roles`** at `LOCAL_QUORUM` (or `QUORUM` for the `cassandra` role), checked first against the credentials cache.
5. **Bcrypt comparison** succeeds → server sends `AUTH_SUCCESS`; the connection is now bound to an `AuthenticatedUser`.
6. **Client issues a statement**, e.g. `SELECT * FROM payments.ledger WHERE id = ?`.
7. **Coordinator resolves the role closure** from the roles cache (`svc_ledger` → `ledger_writer` → `payments_reader`), then walks resource ancestors for `TABLE payments.ledger`.
8. **Permission union computed**; if `SELECT` is absent the server returns `Unauthorized: User svc_ledger has no SELECT permission on <table payments.ledger> or any of its parents`.
9. **If `CassandraNetworkAuthorizer` is enabled**, the coordinator additionally verifies the role's allowed datacenter set includes the local DC; otherwise the connection is rejected at login.
10. **Statement executes** through the normal read/write path; if audit logging is on, an `AuditLogEntry` is written recording role, source IP, keyspace, and the statement text.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="340" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Login and statement authorization flow</text>
<rect x="20" y="50" width="120" height="250" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="42" y="74" font-size="12" font-weight="bold" fill="#1e293b">Client</text>
<rect x="230" y="50" width="180" height="250" rx="8" fill="#eef2ff" stroke="#4f46e5"/> <text x="264" y="74" font-size="12" font-weight="bold" fill="#1e293b">Coordinator</text>
<rect x="500" y="50" width="240" height="250" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="534" y="74" font-size="12" font-weight="bold" fill="#1e293b">system_auth replicas</text>
<path d="M140 104 L230 104" stroke="#4f46e5" stroke-width="1.5" marker-end="url(#a38b)"/> <text x="146" y="98" font-size="10" fill="#1e293b">1 STARTUP</text>
<path d="M230 132 L140 132" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#a38b)"/> <text x="146" y="126" font-size="10" fill="#1e293b">2 AUTHENTICATE</text>
<path d="M140 160 L230 160" stroke="#4f46e5" stroke-width="1.5" marker-end="url(#a38b)"/> <text x="146" y="154" font-size="10" fill="#1e293b">3 AUTH_RESPONSE (SASL PLAIN)</text>
<path d="M410 190 L500 190" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a38b)"/> <text x="414" y="184" font-size="10" fill="#1e293b">4 read roles @ LOCAL_QUORUM</text>
<path d="M500 218 L410 218" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a38b)"/> <text x="414" y="212" font-size="10" fill="#1e293b">salted_hash</text>
<path d="M230 246 L140 246" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#a38b)"/> <text x="146" y="240" font-size="10" fill="#1e293b">5 AUTH_SUCCESS</text>
<path d="M140 278 L230 278" stroke="#4f46e5" stroke-width="1.5" marker-end="url(#a38b)"/> <text x="146" y="272" font-size="10" fill="#1e293b">6 SELECT ... 7 permission check</text>
<text x="516" y="248" font-size="10" fill="#1e293b">roles · role_members</text> <text x="516" y="266" font-size="10" fill="#1e293b">role_permissions</text>
<text x="516" y="284" font-size="10" fill="#1e293b">network_permissions</text> <defs> <marker id="a38b" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
<path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```
## 5. Implementation

### 5.1 Enable auth in `cassandra.yaml`

```yaml
authenticator: PasswordAuthenticator
authorizer: CassandraAuthorizer
role_manager: CassandraRoleManager
network_authorizer: CassandraNetworkAuthorizer   # 4.1+, optional

roles_validity: 30000ms
roles_update_interval: 10000ms
permissions_validity: 30000ms
permissions_update_interval: 10000ms
credentials_validity: 30000ms
credentials_update_interval: 10000ms
permissions_cache_max_entries: 10000
```

Raising the validity windows from the 2000 ms default to 30 s is standard practice on busy clusters: it cuts `system_auth` read load by an order of magnitude at the cost of revocations taking up to 30 s to bite. Restart nodes one at a time (rolling restart) after this change.

### 5.2 Fix `system_auth` immediately

```cql
-- FIRST login uses the default account. Do this before anything else.
-- cqlsh -u cassandra -p cassandra

ALTER KEYSPACE system_auth WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'dc_east': 3,
  'dc_west': 3
};
```

```bash
# Replication changes do not move existing data. Repair, on every node.
nodetool repair -full system_auth
# [2026-07-22 10:14:02,110] Repair session ... finished
```

### 5.3 Replace the default superuser

```cql
CREATE ROLE admin_ops
  WITH PASSWORD = 'Us3-a-Secret-Manager-Not-This'
  AND LOGIN = true
  AND SUPERUSER = true;

-- Log out, log back in as admin_ops, then neutralize the default account.
ALTER ROLE cassandra WITH PASSWORD = 'long-random-string-nobody-knows'
  AND SUPERUSER = false
  AND LOGIN = false;

-- Confirm
LIST ROLES;
--  role       | super | login | options
-- ------------+-------+-------+---------
--  admin_ops  |  True |  True |        {}
--  cassandra  | False | False |        {}
```

> **Note:** Do not `DROP ROLE cassandra`. Some tooling and upgrade paths still reference it, and dropping it while permissions reference it can leave orphaned rows. Disabling `LOGIN` and `SUPERUSER` is the safe neutralization.

### 5.4 Design the role hierarchy

```cql
-- Permission bundles (no LOGIN): these are the reusable pieces.
CREATE ROLE payments_reader WITH LOGIN = false;
GRANT SELECT ON KEYSPACE payments TO payments_reader;

CREATE ROLE ledger_writer WITH LOGIN = false;
GRANT payments_reader TO ledger_writer;
GRANT MODIFY ON TABLE payments.ledger TO ledger_writer;

CREATE ROLE reporting_reader WITH LOGIN = false;
GRANT SELECT ON TABLE payments.summary_daily  TO reporting_reader;
GRANT SELECT ON TABLE payments.summary_hourly TO reporting_reader;

-- Service accounts (LOGIN = true): thin, disposable, rotatable.
CREATE ROLE svc_ledger    WITH PASSWORD = '...' AND LOGIN = true;
CREATE ROLE svc_reporting WITH PASSWORD = '...' AND LOGIN = true;

GRANT ledger_writer    TO svc_ledger;
GRANT reporting_reader TO svc_reporting;

-- 4.1+ network authorization: reporting may only connect to the analytics DC.
ALTER ROLE svc_reporting WITH ACCESS TO DATACENTERS {'dc_analytics'};
ALTER ROLE svc_ledger    WITH ACCESS TO DATACENTERS {'dc_east', 'dc_west'};

-- Verify
LIST ALL PERMISSIONS OF svc_ledger;
--  role          | username      | resource               | permission
-- ---------------+---------------+------------------------+------------
--  payments_reader | payments_reader | <keyspace payments>  |     SELECT
--  ledger_writer   | ledger_writer   | <table payments.ledger> |  MODIFY
```

### 5.5 Connecting from drivers

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.auth import PlainTextAuthProvider
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel
import os

auth = PlainTextAuthProvider(
    username=os.environ["CASS_USER"],          # never hardcode
    password=os.environ["CASS_PASSWORD"],
)

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="dc_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
)

cluster = Cluster(
    contact_points=["10.0.1.11", "10.0.1.12", "10.0.1.13"],
    auth_provider=auth,
    execution_profiles={EXEC_PROFILE_DEFAULT: profile},
    protocol_version=5,
)
session = cluster.connect("payments")           # ONE session, reused forever

row = session.execute(
    session.prepare("SELECT amount FROM ledger WHERE id = ?"), ("7f3c...",)
).one()
```

```java
// DataStax Java driver 4.x -- credentials from application.conf or env
CqlSession session = CqlSession.builder()
    .addContactPoint(new InetSocketAddress("10.0.1.11", 9042))
    .withLocalDatacenter("dc_east")
    .withAuthCredentials(System.getenv("CASS_USER"), System.getenv("CASS_PASSWORD"))
    .withKeyspace("payments")
    .build();
// Reuse this session for the JVM lifetime: bcrypt on every new connection is ~80 ms.
```

**Optimization note.** The two settings that matter most for auth performance are `credentials_validity`/`permissions_validity` (raise to 30 s) and connection reuse in the driver. A third, often missed: keep the number of distinct roles small and the inheritance graph shallow. Every level of `GRANT role TO role` adds a `system_auth.role_members` traversal on cache miss, and deeply nested hierarchies (5+ levels) measurably slow first-query latency after a cache expiry. Two levels — permission bundles granted to service accounts — is the sweet spot.
## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Internal `PasswordAuthenticator` | Zero external dependencies; works during network partitions from IdPs | Passwords stored and rotated in the cluster; no SSO, MFA, or central directory |
| `CassandraAuthorizer` RBAC | Fine-grained down to table and function level; inheritance keeps definitions DRY | Union-only model — no DENY, so a broad grant cannot be narrowed later |
| Role inheritance | One definition reused across service accounts; simple rotation | Deep graphs slow cache misses; accidental grants propagate silently |
| Auth caches | Removes bcrypt and `system_auth` reads from the hot path | Revocation is delayed by the validity window; requires JMX invalidation for emergencies |
| `system_auth` in Cassandra itself | No separate credential store to operate or back up | If `system_auth` is under-replicated or unrepaired, nobody can log in |
| Network authorization (4.1+) | Confines a role to specific DCs — real blast-radius reduction | Only DC granularity; no per-IP or per-subnet control |
| Superuser roles | Necessary for schema and role administration | Bypass all checks; must be few, audited, and never used by applications |
| LDAP/Kerberos via plugins | Central identity, SSO, MFA | Third-party or DSE-only in most cases; adds an external dependency to login |
| Bcrypt hashing | Strong against offline cracking | 60–100 ms per verification; punishes connection churn |
## 7. Common Mistakes & Best Practices

1. ⚠️ **Leaving `system_auth` at `SimpleStrategy` `RF=1`.** → ✅ `ALTER KEYSPACE system_auth WITH replication = {'class':'NetworkTopologyStrategy','dc1':3,'dc2':3}` and then `nodetool repair system_auth` on every node. One node down should never mean nobody can log in.
2. ⚠️ **Keeping `cassandra/cassandra` active.** → ✅ Create a named superuser, verify you can log in with it, then `ALTER ROLE cassandra WITH PASSWORD = '<random>' AND SUPERUSER = false AND LOGIN = false`.
3. ⚠️ **Applications running as a superuser.** → ✅ Applications get narrow roles with `SELECT`/`MODIFY` on exactly the tables they touch. A superuser bypasses the entire permission graph, so a SQL-injection-style bug becomes total compromise.
4. ⚠️ **Granting on `ALL KEYSPACES` "for now".** → ✅ Grant at the table or keyspace level. Because there is no DENY, a broad grant can never be narrowed — you must revoke and re-grant, which means an outage window.
5. ⚠️ **Enabling auth without TLS.** → ✅ Turn on `client_encryption_options` first. SASL PLAIN sends the password in cleartext; auth without encryption moves the credential from "nonexistent" to "sniffable".
6. ⚠️ **Opening a new session per request.** → ✅ One `CqlSession`/`Cluster` per process, held for its lifetime. Every new connection costs a bcrypt verification (~80 ms) and can stall the auth stage under reconnect storms.
7. ⚠️ **Expecting `REVOKE` to be instant.** → ✅ Account for `permissions_validity` (and `roles_validity`). For emergency revocation, also drop the role's `LOGIN`, then invalidate the caches through the `PermissionsCache`/`RolesCache` JMX MBeans on every node.
8. ⚠️ **Hardcoding credentials in code or `application.conf` in git.** → ✅ Inject via environment variables or a secrets manager (Vault, AWS Secrets Manager) and rotate on a schedule. Rotation is `ALTER ROLE svc_x WITH PASSWORD = ...` — no restart required.
9. ⚠️ **Forgetting that `DESCRIBE`/schema access leaks structure.** → ✅ Non-superusers see only keyspaces they have permission on in `system_schema` from 4.0 onward, but verify: run `DESCRIBE KEYSPACES` as each service role and confirm the output is minimal.
10. ⚠️ **Leaving auth caches at the 2000 ms default on a large cluster.** → ✅ Raise to 30 s. At 2 s with thousands of connections, `system_auth` becomes one of the hottest keyspaces in the cluster.
11. ⚠️ **Auditing nothing.** → ✅ Enable the 4.0 audit log with at least the `AUTH` and `DDL` categories so failed logins and role changes are recorded. See chapter 39.
12. ⚠️ **Creating one role per human but never removing them.** → ✅ Tie role lifecycle to your identity provider's offboarding process, and periodically reconcile `LIST ROLES` against the HR system. Orphaned superuser roles are the classic audit finding.
## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

The three failures you will actually see:

```bash
# 1. "Provided username X and/or password are incorrect"
#    -> wrong credential OR system_auth replica unavailable at LOCAL_QUORUM.
nodetool status system_auth
cqlsh -u admin_ops -p '***' -e "SELECT role FROM system_auth.roles;"

# 2. "Unauthorized: User svc_x has no SELECT permission on <table ks.t> or any of its parents"
#    -> the permission genuinely is not in the closure. Inspect it:
cqlsh -e "LIST ALL PERMISSIONS OF svc_x;"
cqlsh -e "SELECT * FROM system_auth.role_members WHERE role = 'ledger_writer';"

# 3. "Unable to perform authorization of permissions: Cannot achieve consistency
#     level QUORUM"  -> you are logging in as the default cassandra role during a
#     partition. Use your named superuser instead.
```

Turn up logging temporarily when a permission decision is inexplicable:

```bash
nodetool setlogginglevel org.apache.cassandra.auth DEBUG
# ... reproduce ...
nodetool setlogginglevel org.apache.cassandra.auth INFO
```

### Monitoring

| Signal | Where |
|---|---|
| Failed authentication rate | audit log category `AUTH`, event `LOGIN_ERROR` |
| Auth latency | `org.apache.cassandra.metrics:type=Client,name=AuthFailure` and driver-side connect timings |
| `system_auth` read latency | `type=Table,keyspace=system_auth,scope=roles,name=ReadLatency` |
| Cache effectiveness | JMX `org.apache.cassandra.auth:type=PermissionsCache` hit/miss counters |
| Role changes | audit log category `DCL` (`CREATE ROLE`, `ALTER ROLE`, `GRANT`, `REVOKE`) |
| Superuser usage | audit log filtered on roles with `super = True` — should be near zero in steady state |

Alert on: any `GRANT`/`ALTER ROLE` outside a change window, failed logins exceeding a small baseline (credential-stuffing or a bad deploy), and `system_auth` unavailability.

### Security

Layer defences rather than relying on RBAC alone. Bind `rpc_address` to a private interface, restrict 9042 with security groups, require TLS (chapter 39), rotate service credentials quarterly, and keep superuser accounts on break-glass workflow with audit alerting. Treat `system_auth` backups as secret material — they contain bcrypt hashes, which are strong but not free. For enterprises needing SSO, the practical options are a custom `IAuthenticator` implementing LDAP/Kerberos, an LDAP-backed sidecar, or DataStax Enterprise's built-in providers; Apache Cassandra core ships only `PasswordAuthenticator`.

### Performance & Scaling

Auth scales with connection churn, not query volume, because permissions are cached. The failure mode is a deploy that restarts 500 application pods simultaneously: 500 × N connections × 80 ms bcrypt lands on a handful of `system_auth` replicas. Mitigate with staggered rollouts, generous `credentials_validity`, and `RF` on `system_auth` equal to node count in small DCs so every node can answer locally. If you must support extreme connection churn, front the cluster with a proxy that maintains persistent backend sessions.
## 9. Interview Questions

**Q: What are Cassandra's default authenticator and authorizer, and why is that dangerous?**
A: `AllowAllAuthenticator` and `AllowAllAuthorizer` — meaning any client that can reach port 9042 connects as an anonymous user with full permissions on every keyspace. It is a legacy of Cassandra's trusted-datacenter origins. Production clusters must switch to `PasswordAuthenticator` and `CassandraAuthorizer` and restart, then immediately fix `system_auth` replication.

**Q: Why must you change `system_auth` replication before doing anything else?**
A: It ships as `SimpleStrategy` with `RF=1`, so credentials live on a single node; if that node is down, authentication reads fail and no one can log in — including administrators. Change it to `NetworkTopologyStrategy` with `RF=3` per datacenter (or `RF` = node count in tiny DCs) and then run `nodetool repair system_auth`, since altering replication does not move existing data.

**Q: What is the difference between a role and a user in modern Cassandra?**
A: Since 2.2 there are only roles; `CREATE USER` is a compatibility shim that creates a role with `LOGIN = true`. A role may be a login principal, a pure permission bundle, or both, and roles can be granted to other roles to form an inheritance graph. This unification is what makes RBAC expressible.

**Q: Can you grant SELECT on a keyspace and then deny it on one table?**
A: No. Cassandra's permission model is a union over the role closure and the resource ancestor chain, and there is no DENY primitive. Least privilege has to be constructed by granting narrowly — table by table if necessary — rather than granting broadly and subtracting.

**Q: Why does the default `cassandra` role authenticate at QUORUM instead of LOCAL_QUORUM?**
A: It is a deliberate safety measure: the default account's credentials are universally known, so requiring a global quorum makes it harder to abuse during a partition where a single datacenter is isolated. The practical consequence is that the default superuser cannot log in when a DC is cut off, which is another reason to create your own named superuser.

**Q: How do you rotate an application's password with zero downtime?**
A: Run `ALTER ROLE svc_app WITH PASSWORD = '<new>'`, push the new secret to the application's secret store, and let pods pick it up on rolling restart. Existing connections remain authenticated — Cassandra checks credentials at connect time, not per query — so the rotation window is bounded by your rollout, and `credentials_validity` only affects new connections.

**Q: (Senior) A revoked role can still read data for a while. Explain and fix.**
A: Permissions and roles are cached in memory per node (`permissions_validity`, `roles_validity`, default 2000 ms, commonly raised to 30 s), so a `REVOKE` only takes effect after the cache entry expires on the node serving that connection. For immediate effect, invalidate the `PermissionsCache` and `RolesCache` MBeans over JMX on every node, and additionally set `LOGIN = false` on the role to stop new connections. Long term, treat revocation latency as a known property and document it in your incident runbook rather than discovering it during one.

**Q: (Senior) Design an RBAC scheme for a multi-tenant cluster with 40 microservices.**
A: Use two tiers: permission-bundle roles that are `LOGIN = false` and describe capabilities (`orders_reader`, `orders_writer`, `inventory_reader`), and thin service-account roles with `LOGIN = true` that are granted exactly the bundles they need. Keep the graph two levels deep so cache misses stay cheap, name roles after the resource rather than the consumer so bundles are reusable, and never grant on `ALL KEYSPACES` to anything but the break-glass superuser. Add `CassandraNetworkAuthorizer` so analytics-only roles are confined to the analytics DC, drive all role creation through version-controlled CQL applied by CI, and reconcile `LIST ROLES` against your service catalogue on a schedule to catch orphans.

**Q: (Senior) Your cluster shows a latency spike in `system_auth` reads every deploy. What is happening and what do you change?**
A: A deploy restarts many application instances at once; each new connection triggers a credentials-cache miss, a `system_auth.roles` read at `LOCAL_QUORUM`, and a bcrypt verification costing 60–100 ms of CPU. Concentrated on a few replicas, this saturates the auth path and shows up as connect timeouts. Fixes: raise `credentials_validity` to 30 s, raise `system_auth` RF so every node can serve locally, stagger the rollout, and ensure the application holds a single long-lived session rather than creating one per worker thread.

**Q: What does `CassandraNetworkAuthorizer` add, and what are its limits?**
A: Introduced in 4.1, it restricts a role to a set of datacenters with `ALTER ROLE r WITH ACCESS TO DATACENTERS {'dc1'}`, enforced at connection time. It is genuinely useful for confining analytics or reporting credentials to a workload-isolated DC. Its limit is granularity: it knows only datacenters, not racks, subnets, or client IPs, so network-level controls remain necessary.

**Q: How do you audit who did what?**
A: Enable the Cassandra 4.0 audit log with `audit_logging_options`, including at least the `AUTH`, `DCL`, and `DDL` categories, writing to a dedicated volume via the binary log writer, and ship the decoded entries (`auditlogviewer`) to your SIEM. Each entry records role, source IP, keyspace, operation, and statement, which is what compliance frameworks actually ask for.

**Q: Should you drop the `cassandra` role after creating your own superuser?**
A: Prefer disabling it — set a long random password and both `SUPERUSER = false` and `LOGIN = false`. Dropping it is possible but some tooling and upgrade paths still reference the default role, and dropping a role that appears in permission grants can leave inconsistent rows in `system_auth`. Disabling gives the same security outcome with none of the risk.
## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra defaults to `AllowAllAuthenticator`/`AllowAllAuthorizer` — anyone on port 9042 is a superuser. Switch to `PasswordAuthenticator` + `CassandraAuthorizer` in `cassandra.yaml`, rolling-restart, then immediately `ALTER KEYSPACE system_auth` to `NetworkTopologyStrategy` with `RF=3` per DC and `nodetool repair system_auth`. Create a named superuser and neutralize `cassandra` with `SUPERUSER=false, LOGIN=false`. Build RBAC in two tiers: permission bundles (`LOGIN=false`) granted to thin service accounts (`LOGIN=true`). Permissions are a union over role closure × resource ancestors — there is no DENY, so grant narrowly. Auth results are cached (`permissions_validity`, `roles_validity`, `credentials_validity`), so revocation is delayed; raise these to 30 s for performance and invalidate via JMX for emergencies. Always enable TLS before auth, because SASL PLAIN sends the password in cleartext.

| Task | Command / Setting |
|---|---|
| Enable auth | `authenticator: PasswordAuthenticator` |
| Enable authz | `authorizer: CassandraAuthorizer` |
| Fix auth keyspace | `ALTER KEYSPACE system_auth WITH replication = {...NTS...}` then `nodetool repair system_auth` |
| Create login role | `CREATE ROLE svc_x WITH PASSWORD='..' AND LOGIN=true;` |
| Create bundle | `CREATE ROLE reader WITH LOGIN=false;` |
| Grant table perm | `GRANT SELECT ON TABLE ks.tbl TO reader;` |
| Compose | `GRANT reader TO svc_x;` |
| Inspect | `LIST ALL PERMISSIONS OF svc_x;` · `LIST ROLES;` |
| Restrict DC (4.1+) | `ALTER ROLE r WITH ACCESS TO DATACENTERS {'dc1'};` |
| Rotate password | `ALTER ROLE svc_x WITH PASSWORD='..';` (no restart) |
| Neutralize default | `ALTER ROLE cassandra WITH SUPERUSER=false AND LOGIN=false;` |
| Cache tuning | `permissions_validity: 30000ms` |
| Debug decisions | `nodetool setlogginglevel org.apache.cassandra.auth DEBUG` |

**Flash cards**

- **Default authenticator/authorizer** → `AllowAllAuthenticator` / `AllowAllAuthorizer` — no security at all.
- **First thing after enabling auth** → Re-replicate `system_auth` with NTS and repair it.
- **Permission algebra** → Union over role closure × resource ancestors; no DENY exists.
- **Why revocation lags** → `permissions_validity` / `roles_validity` caches; invalidate via JMX MBean.
- **Superuser trap** → `cassandra/cassandra` authenticates at QUORUM and bypasses all checks; disable it.
## 11. Hands-On Exercises & Mini Project

- [ ] Start a 3-node cluster (`ccm create sec -v 4.1.3 -n 3 -s`), enable `PasswordAuthenticator` and `CassandraAuthorizer` on all nodes, rolling-restart, and confirm that `cqlsh` without credentials now fails.
- [ ] Reproduce the outage: leave `system_auth` at `RF=1`, stop the node that owns the `cassandra` role's token, and observe the login failure. Then fix it with `NetworkTopologyStrategy` and `nodetool repair system_auth` and confirm logins survive a node stop.
- [ ] Build the two-tier role model from section 5.4, then verify least privilege by logging in as `svc_reporting` and attempting `SELECT * FROM payments.ledger`. Record the exact error message.
- [ ] Measure the cost of auth: time 200 sequential new `Cluster`/`Session` creations with and without auth enabled, and compute the per-connection bcrypt overhead. Then raise `credentials_validity` to 30 s and re-measure.
- [ ] Demonstrate revocation lag: grant `SELECT`, run a query, `REVOKE`, and time how long the role can still read. Then invalidate the `PermissionsCache` MBean via `jmxterm` and show it becomes immediate.

### Mini Project — "Zero-Trust Cassandra Bootstrap"

**Goal.** Produce an idempotent, version-controlled bootstrap that takes a fresh cluster from wide-open to fully governed RBAC, with verification.

**Requirements.**
1. A `security.yaml` describing services, the keyspaces/tables each needs, the access level (`read`, `write`, `admin`), and the datacenters each may connect from.
2. A generator that renders `security.yaml` into idempotent CQL: `CREATE ROLE IF NOT EXISTS`, bundle roles, grants, and `ACCESS TO DATACENTERS` clauses — with a matching `REVOKE` plan for removed entries.
3. An apply step that runs the CQL as a named superuser, then a **verification step** that logs in as each service role and asserts both the permitted operations succeed and at least one forbidden operation fails with `Unauthorized`.
4. A `system_auth` health check: assert replication is `NetworkTopologyStrategy` with `RF >= 3` per DC, and that a repair has run within the last 7 days.
5. A drift report comparing live `LIST ROLES` / `LIST ALL PERMISSIONS` output against `security.yaml`, exiting non-zero on unexpected grants or orphaned roles.

**Extensions.**
- Integrate a secrets manager: generate random passwords at apply time, write them to the vault, and never print them.
- Add automated quarterly rotation that alters passwords, updates the vault, and triggers a staggered application rollout.
- Wire the 4.0 audit log into the pipeline so the drift report also lists every `DCL` statement executed since the last run, with the role and source IP that issued it.
## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Encryption (TLS & At-Rest) and Auditing* — the mandatory companion, since SASL PLAIN needs TLS; *Cassandra 4.x & 5.x New Features* — virtual tables, audit log, and 5.0 dynamic data masking with its `UNMASK`/`SELECT_MASKED` permissions; *Drivers & Application Development* — session lifecycle and auth providers; *Multi-Datacenter Deployment* — why `system_auth` must be replicated everywhere; *Monitoring & Observability* — surfacing auth metrics; and *Backup & Restore* — `system_auth` snapshots are secret material.

- **Apache Cassandra — Security Documentation** — Apache Software Foundation · *Intermediate* · The authoritative reference for authenticator/authorizer configuration, role syntax, and cache settings. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/security.html>
- **Apache Cassandra — CQL Security (Roles & Permissions)** — Apache Software Foundation · *Intermediate* · Complete grammar for `CREATE ROLE`, `GRANT`, `LIST PERMISSIONS`, and the full permission/resource matrix. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/security.html>
- **CASSANDRA-7653: Add role based access control** — Apache JIRA · *Advanced* · The design discussion that replaced flat users with roles; explains why inheritance works the way it does. <https://issues.apache.org/jira/browse/CASSANDRA-7653>
- **CASSANDRA-13985: Support restricting a role to specific datacenters** — Apache JIRA · *Advanced* · Background on `CassandraNetworkAuthorizer` and its intentional DC-only granularity. <https://issues.apache.org/jira/browse/CASSANDRA-13985>
- **The Last Pickle — "Hardening Cassandra Step by Step"** — The Last Pickle · *Intermediate* · A practitioner walkthrough covering auth, the superuser trap, and `system_auth` replication in order. <https://thelastpickle.com/blog/2015/09/30/hardening-cassandra-step-by-step-part-1-server-to-server.html>
- **DataStax — Configuring Authentication and Authorization** — DataStax Docs · *Beginner* · Step-by-step enablement with the exact restart sequencing, useful as a checklist. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/configuration/secureConfigNativeAuth.html>
- **DataStax Python Driver — Authentication** — DataStax · *Beginner* · How `PlainTextAuthProvider` and SASL negotiation work from the client side, including session reuse guidance. <https://docs.datastax.com/en/developer/python-driver/latest/security/>
- **Apache Cassandra Blog — "Cassandra 4.1: Guardrails, Auth Plugins and More"** — Apache Cassandra project · *Intermediate* · Covers the 4.1 pluggable auth improvements and network authorization in context. <https://cassandra.apache.org/_/blog/Apache-Cassandra-4.1-Guardrails.html>

---

*Apache Cassandra Handbook — chapter 38.*
