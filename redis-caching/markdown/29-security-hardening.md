# 29 · Security, Multi-Tenancy & Production Hardening

> **In one line:** Redis was born trusting its network completely — no auth, no encryption, every command available to anyone who could reach the port — and every one of its famous breaches traces to shipping that default onto a reachable network, so hardening is less about adding features than about deliberately switching off the trust Redis assumes.

---

## 1. Overview

Redis's security story is a story about a default. It was designed in 2009 for a specific deployment: a single application server talking to a Redis on the same trusted, private network, where authentication would be pure overhead. So the default was *no password, all commands available, listening on all interfaces*. That was a reasonable choice for its intended environment and a catastrophic one the moment cloud, containers and careless firewall rules put Redis instances a single `redis-cli -h` away from the open internet. The result was a wave of breaches: internet scanners find an open port 6379, connect with no credentials, and run `CONFIG SET` to write an SSH key or a cron job to disk, or simply `FLUSHALL` the data. None of these exploited a Redis bug; they exploited the trust model working exactly as designed, on a network that should never have been trusted.

Modern Redis (6+) gives you the tools to reverse that default properly: **protected mode** as a safety net, `requirepass` and full **ACLs** for authentication and least-privilege authorisation, **TLS** to encrypt client and replication traffic, `rename-command` to disable or hide dangerous commands, and network controls (binding to internal interfaces, firewalling) to keep the port unreachable in the first place. The mental shift is that these are not optional extras bolted on for the paranoid; they are how you consciously withdraw the blanket trust Redis grants by default.

This chapter also covers **multi-tenancy** — running one Redis for many tenants without leaking one tenant's data to another — which is really a question of isolation: key namespacing plus ACL key patterns for soft isolation within an instance, versus separate logical databases or (better) separate instances for hard isolation. The throughline is that the strongest, simplest boundary is usually one instance per tenant, and the more you try to squeeze many tenants into one instance, the more of your isolation you are trusting to convention rather than enforcement. We close with a concrete pre-production hardening checklist.

## 2. Core Concepts

- **The trusted-network model** — Redis's historical assumption that anyone who can reach it is authorised; the root of most Redis breaches.
- **Protected mode** — a safety net (default on) that refuses connections from non-loopback addresses when no password and no explicit bind are configured.
- **`requirepass`** — the classic single shared password; simple authentication, no per-user granularity.
- **ACLs (Redis 6+)** — named users with fine-grained permissions over commands, key patterns and Pub/Sub channels; the basis of least-privilege access.
- **`ACL SETUSER`** — the command that creates and configures a user with its passwords, allowed commands and key/channel patterns.
- **Least-privilege app user** — a dedicated ACL user granted only the commands and key patterns an application actually needs, never the default all-powerful user.
- **TLS** — encryption of client–server and replica–master traffic, so credentials and cached data are not sent in clear text.
- **`bind` / firewalling** — restricting which network interfaces Redis listens on and which hosts can reach the port; the outermost defence.
- **`rename-command`** — renaming or disabling dangerous commands (`FLUSHALL`, `KEYS`, `CONFIG`, `DEBUG`) so they cannot be casually invoked.
- **Key namespacing** — prefixing keys per tenant (`tenant:42:...`) to partition a shared keyspace; soft isolation enforceable via ACL key patterns.
- **Isolation spectrum** — shared instance + namespacing (softest) → separate logical DBs → separate instances per tenant (hardest and often cleanest).

## 3. Theory & Principles

### The historical trust model, and why it keeps causing breaches

Understanding Redis security starts with understanding what it originally assumed: that the network is a trust boundary you have already secured. In that world, a password is redundant — if an attacker is on your private network, you have bigger problems — and encryption is wasted CPU on a trusted wire. So Redis shipped open. The failure mode is not subtle. When a Redis with no auth is reachable from the internet, an attacker connects and has *root over the data* immediately: read every cached value (sessions, tokens, PII), `FLUSHALL` it, or — the classic escalation — abuse `CONFIG SET dir` and `CONFIG SET dbfilename` plus `SAVE` to write a file (an SSH `authorized_keys`, a cron entry, a webshell) to an arbitrary path, turning data access into remote code execution on the host.

The lesson is defence in depth, and the first and cheapest layer is **never let the port be reachable**. Bind to the internal interface, firewall 6379 to only the application hosts, and put Redis on a private subnet. Authentication and TLS are the layers *behind* that, for when the network boundary is breached or when regulation demands encryption in transit. Protected mode is a deliberately blunt safety net: if you have set no password and no explicit `bind`, Redis refuses connections from anything but loopback, on the theory that an unconfigured Redis reachable from outside is almost certainly an accident.

### Authentication → authorisation: from one password to least privilege

`requirepass` was the whole authentication story for years: one shared password, and once you knew it you could do anything. That is authentication without authorisation — every client is all-powerful. Redis 6 added **ACLs**, which is the difference between "who are you" and "what may you do." An ACL user is defined by three kinds of rule: which **commands** it may run (`+get +set` or `+@read` category, `-@dangerous`), which **keys** it may touch (`~cache:*` restricts it to keys matching a pattern), and which **Pub/Sub channels** it may use (`&events:*`). This lets you give an application a user that can `GET`/`SET`/`EXPIRE` on `~app:*` and nothing else — no `CONFIG`, no `FLUSHALL`, no `KEYS`, no access to other prefixes. If that credential leaks, the blast radius is bounded to what that user could do, not the whole instance.

The principle is least privilege made concrete: the `default` user should be locked down (given a password or disabled), and every application should connect as a purpose-built user with exactly the commands and key patterns it needs. This is also the enforcement mechanism for multi-tenancy, below.

### The isolation spectrum for multi-tenancy

Running many tenants on Redis is a question of how strong a wall you put between them, and there is a spectrum from convention to physical separation:

- **Shared instance + key namespacing (softest).** Every key is prefixed with the tenant id (`tenant:42:session:...`). Simple and memory-efficient, but isolation is pure convention — a bug that forgets the prefix, or a `KEYS *`, crosses tenants. Memory, CPU and the single thread are all shared, so one noisy tenant degrades everyone (a "noisy neighbour").
- **Namespacing enforced by ACL key patterns.** Give each tenant's application a distinct ACL user restricted to `~tenant:42:*`. Now the isolation is *enforced by the server*, not just hoped for in application code — tenant 42's credential physically cannot read tenant 43's keys. This is a large step up and the right minimum for soft multi-tenancy. Resource sharing (memory, the single thread) is still shared, though.
- **Separate logical databases (`SELECT 0..15`).** Redis's numbered databases give namespace separation but are widely discouraged for tenancy: they share the same instance, memory, thread and config; `FLUSHALL` hits all of them; ACLs cannot cleanly scope per-DB; and Cluster supports only DB 0. They are a weak, legacy partition.
- **One instance per tenant (hardest, often cleanest).** Each tenant gets its own Redis process (or Cluster). Isolation is physical: separate memory budgets, separate `maxmemory` and eviction, separate credentials, no noisy-neighbour blast radius, per-tenant backup/restore and independent scaling. The cost is more instances to run, which orchestration (Kubernetes, managed Redis) makes cheap. For anything with a real security or compliance boundary between tenants, this is usually the honest answer — the more you cram into one instance, the more of your isolation you are trusting to convention rather than to the operating system.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Defence in depth: peeling back the trust Redis assumes by default</text>

  <rect x="60" y="44" width="760" height="66" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="68" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Default (2009): trusted network &#8212; no auth, all commands, all interfaces</text>
  <text x="440" y="90" text-anchor="middle" fill="#991b1b" font-size="10">reachable from internet &#8594; attacker runs CONFIG SET dir + SAVE &#8594; writes SSH key / cron &#8594; RCE</text>
  <text x="440" y="104" text-anchor="middle" fill="#991b1b" font-size="9">no Redis bug was exploited &#8212; the trust model worked exactly as designed, on the wrong network</text>

  <rect x="60" y="126" width="760" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="147" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Layer 1 &#8212; Network: bind internal, firewall 6379, private subnet, protected mode</text>
  <text x="440" y="164" text-anchor="middle" fill="#b45309" font-size="9">cheapest and most important: if the port is unreachable, nothing else matters</text>

  <rect x="60" y="180" width="760" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="201" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Layer 2 &#8212; Authentication: requirepass or (better) named ACL users</text>
  <text x="440" y="218" text-anchor="middle" fill="#1d4ed8" font-size="9">who are you? &#8212; lock down the default user; every app connects as itself</text>

  <rect x="60" y="234" width="760" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="255" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Layer 3 &#8212; Authorisation (ACLs): least privilege on commands + key + channel patterns</text>
  <text x="440" y="272" text-anchor="middle" fill="#166534" font-size="9">what may you do? &#8212; +@read +@write ~app:* -@dangerous; leak = bounded blast radius</text>

  <rect x="60" y="288" width="760" height="46" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="309" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Layer 4 &#8212; Encryption (TLS): client&#8211;server and replica&#8211;master traffic</text>
  <text x="440" y="326" text-anchor="middle" fill="#6d28d9" font-size="9">credentials and cached PII not sent in clear text; required by most compliance regimes</text>

  <rect x="60" y="342" width="760" height="46" rx="8" fill="#f1f5f9" stroke="#475569" stroke-width="2"/>
  <text x="440" y="363" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Layer 5 &#8212; Command control: rename/disable FLUSHALL, KEYS, CONFIG, DEBUG</text>
  <text x="440" y="380" text-anchor="middle" fill="#475569" font-size="9">remove the footguns even authorised users should not casually fire</text>

  <rect x="60" y="400" width="760" height="44" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="421" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">No single layer is sufficient; the port being unreachable is necessary but not enough.</text>
  <text x="440" y="437" text-anchor="middle" fill="#166534" font-size="9">Assume each layer can fail and the next must still hold.</text>
</svg>
```

## 4. Architecture & Workflow

The hardening layers compose as a stack, each defending against the failure of the one outside it. The workflow to secure an instance works from the outside in:

1. **Network first.** Set `bind` to the internal interface(s) only, never `0.0.0.0` on a reachable network. Firewall port 6379 (and 16379 for Cluster bus, 26379 for Sentinel) to only the application and replica hosts. Put Redis on a private subnet with no public route. Confirm protected mode is on. This layer alone stops the internet-scanner breach.
2. **Authenticate.** Disable or password-protect the `default` user. Create a named ACL user per application. A client must present valid credentials (`AUTH <user> <pass>` or the connection URL) before any command runs.
3. **Authorise (least privilege).** Each ACL user gets only the command categories and key/channel patterns it needs: an app user gets `+@read +@write +@keyspace ~app:*`, explicitly `-@dangerous` and `-@admin`; a monitoring user (chapter 28) gets `+info +slowlog +latency +memory ~*` and nothing that mutates.
4. **Encrypt.** Enable TLS with `tls-port`, a server cert/key and a CA; require client certs (`tls-auth-clients yes`) for mutual TLS if the environment demands it. Enable TLS on replication (`tls-replication yes`) and Cluster bus so intra-cluster traffic is encrypted too.
5. **Remove footguns.** `rename-command` the dangerous commands to empty (disable) or to an unguessable name in `redis.conf`, and/or deny them via ACL categories (`-@dangerous`). `FLUSHALL`, `FLUSHDB`, `KEYS`, `CONFIG`, `DEBUG`, `SHUTDOWN` are the usual targets.
6. **For multi-tenancy, choose your isolation** from the spectrum: namespacing + ACL key patterns for soft isolation, or one instance per tenant for hard isolation, deciding by how strong the boundary between tenants must be.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Multi-tenancy: the isolation spectrum, convention &#8594; physical</text>

  <rect x="24" y="44" width="200" height="330" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="124" y="68" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">Shared + namespacing</text>
  <text x="124" y="86" text-anchor="middle" fill="#991b1b" font-size="9">tenant:42:key</text>
  <text x="36" y="112" fill="#7f1d1d" font-size="9">+ simplest, memory-cheap</text>
  <text x="36" y="130" fill="#7f1d1d" font-size="9">+ one instance to run</text>
  <text x="36" y="154" fill="#b91c1c" font-size="9" font-weight="bold">&#8722; isolation is CONVENTION</text>
  <text x="36" y="170" fill="#991b1b" font-size="9">a missing prefix crosses tenants</text>
  <text x="36" y="188" fill="#991b1b" font-size="9">KEYS * sees everyone</text>
  <text x="36" y="206" fill="#991b1b" font-size="9">noisy-neighbour: shared thread</text>
  <text x="36" y="224" fill="#991b1b" font-size="9">&amp; memory budget</text>
  <rect x="36" y="238" width="176" height="120" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="124" y="258" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">Use when</text>
  <text x="48" y="278" fill="#991b1b" font-size="8">tenants are low-trust to each</text>
  <text x="48" y="292" fill="#991b1b" font-size="8">other but not a security</text>
  <text x="48" y="306" fill="#991b1b" font-size="8">boundary; small, many tenants;</text>
  <text x="48" y="320" fill="#991b1b" font-size="8">cost dominates. ALWAYS add</text>
  <text x="48" y="334" fill="#991b1b" font-size="8">ACL key patterns to enforce</text>
  <text x="48" y="348" fill="#991b1b" font-size="8">the prefix on the server.</text>

  <rect x="236" y="44" width="200" height="330" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="336" y="68" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">+ ACL key patterns</text>
  <text x="336" y="86" text-anchor="middle" fill="#b45309" font-size="9">user t42 ~tenant:42:*</text>
  <text x="248" y="112" fill="#713f12" font-size="9">+ isolation ENFORCED by</text>
  <text x="248" y="128" fill="#713f12" font-size="9">  the server, not app code</text>
  <text x="248" y="146" fill="#713f12" font-size="9">+ leaked cred = one tenant</text>
  <text x="248" y="170" fill="#92400e" font-size="9" font-weight="bold">&#8722; still shares memory</text>
  <text x="248" y="186" fill="#b45309" font-size="9">  &amp; the single thread</text>
  <text x="248" y="204" fill="#b45309" font-size="9">&#8722; noisy neighbour remains</text>
  <rect x="248" y="238" width="176" height="120" rx="6" fill="#fff" stroke="#fbbf24"/>
  <text x="336" y="258" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">Use when</text>
  <text x="260" y="278" fill="#b45309" font-size="8">you need real data isolation</text>
  <text x="260" y="292" fill="#b45309" font-size="8">but can share resources;</text>
  <text x="260" y="306" fill="#b45309" font-size="8">the right MINIMUM for soft</text>
  <text x="260" y="320" fill="#b45309" font-size="8">multi-tenancy on one box.</text>

  <rect x="448" y="44" width="180" height="330" rx="10" fill="#f1f5f9" stroke="#475569" stroke-width="2"/>
  <text x="538" y="68" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Logical DBs (0..15)</text>
  <text x="538" y="86" text-anchor="middle" fill="#475569" font-size="9">SELECT n</text>
  <text x="460" y="112" fill="#334155" font-size="9">&#8722; DISCOURAGED for tenancy</text>
  <text x="460" y="130" fill="#475569" font-size="9">shared instance/thread/mem</text>
  <text x="460" y="148" fill="#475569" font-size="9">FLUSHALL hits all DBs</text>
  <text x="460" y="166" fill="#475569" font-size="9">ACLs can't cleanly scope</text>
  <text x="460" y="184" fill="#475569" font-size="9">Cluster = DB 0 only</text>
  <rect x="460" y="238" width="156" height="120" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="538" y="258" text-anchor="middle" fill="#334155" font-size="9" font-weight="bold">Use when</text>
  <text x="472" y="278" fill="#475569" font-size="8">legacy separation of one</text>
  <text x="472" y="292" fill="#475569" font-size="8">app's namespaces; NOT a</text>
  <text x="472" y="306" fill="#475569" font-size="8">security boundary. Avoid</text>
  <text x="472" y="320" fill="#475569" font-size="8">for real multi-tenancy.</text>

  <rect x="640" y="44" width="216" height="330" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="748" y="68" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">One instance per tenant</text>
  <text x="748" y="86" text-anchor="middle" fill="#166534" font-size="9">separate process / Cluster</text>
  <text x="652" y="112" fill="#14532d" font-size="9">+ PHYSICAL isolation</text>
  <text x="652" y="130" fill="#166534" font-size="9">+ own memory + maxmemory</text>
  <text x="652" y="148" fill="#166534" font-size="9">+ no noisy neighbour</text>
  <text x="652" y="166" fill="#166534" font-size="9">+ per-tenant backup/scale</text>
  <text x="652" y="184" fill="#166534" font-size="9">+ own credentials</text>
  <text x="652" y="208" fill="#15803d" font-size="9" font-weight="bold">&#8722; more instances to run</text>
  <text x="652" y="224" fill="#166534" font-size="9">  (orchestration makes cheap)</text>
  <rect x="652" y="238" width="192" height="120" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="748" y="258" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">Use when (often cleanest)</text>
  <text x="664" y="278" fill="#166534" font-size="8">there is a real security or</text>
  <text x="664" y="292" fill="#166534" font-size="8">compliance boundary; tenants</text>
  <text x="664" y="306" fill="#166534" font-size="8">are large or few; you want</text>
  <text x="664" y="320" fill="#166534" font-size="8">isolation enforced by the OS,</text>
  <text x="664" y="334" fill="#166534" font-size="8">not by convention.</text>
</svg>
```

## 5. Implementation

Hardening is mostly configuration — `redis.conf` and ACL rules — with the application only needing to present credentials over TLS. Here is a hardened config, the ACL commands, and a go-redis connection using TLS and an ACL user.

### redis.conf — a hardened baseline

```conf
# --- Network: make the port unreachable from anywhere it shouldn't be ---
bind 10.0.1.20 127.0.0.1          # internal interface + loopback ONLY, never 0.0.0.0 on a reachable net
protected-mode yes                # safety net: refuse non-loopback if unconfigured
port 6379                         # (firewall this to app/replica hosts at the network layer)

# --- Authentication: lock down the default user ---
# Prefer ACLs over a single requirepass. Disable the all-powerful default user
# so a leaked "just the password" grants nothing.
user default off                  # the default user cannot log in at all
aclfile /etc/redis/users.acl      # named users live here (see below)

# --- TLS: encrypt client and replication traffic ---
tls-port 6380                     # serve TLS on 6380
port 0                            # OPTIONAL: disable the plaintext port entirely
tls-cert-file /etc/redis/tls/redis.crt
tls-key-file  /etc/redis/tls/redis.key
tls-ca-cert-file /etc/redis/tls/ca.crt
tls-auth-clients yes              # require client certificates (mutual TLS)
tls-replication yes               # encrypt replica <-> master traffic too
tls-cluster yes                   # encrypt the Cluster bus

# --- Remove footguns: disable or rename dangerous commands ---
rename-command FLUSHALL ""        # "" = fully disabled, cannot be called
rename-command FLUSHDB  ""
rename-command KEYS     ""        # force SCAN; also blocks the O(N) footgun (ch.28)
rename-command DEBUG    ""
rename-command CONFIG   "CONFIG_9f3a2b7c"   # hidden behind an unguessable name for ops use

# --- Pure-cache hardening: no persistence to abuse via CONFIG SET dir + SAVE ---
save ""                           # disable RDB snapshots (a cache is disposable, ch.24)
appendonly no
```

### ACL users — least privilege per role

```bash
# users.acl (or run these as ACL SETUSER at runtime; SAVE with ACL SAVE)

# An application user: only read/write/expire on its own prefix, nothing admin,
# nothing dangerous. If this credential leaks, the blast radius is app:* only.
ACL SETUSER app_svc on >S0me-Strong-Pass \
    ~app:* \
    +@read +@write +@keyspace \
    -@dangerous -@admin -@scripting

# A per-tenant user for soft multi-tenancy: physically scoped to one tenant's
# keys by pattern. tenant 42's credential CANNOT read tenant 43's keys — the
# server enforces the namespace, not application code.
ACL SETUSER tenant_42 on >tenant42-secret \
    ~tenant:42:* \
    +@read +@write +@keyspace \
    -@dangerous

# A read-only monitoring user (chapter 28): can observe, cannot mutate. Restrict
# to exactly the introspection commands the exporter needs.
ACL SETUSER monitor on >monitor-secret \
    ~* \
    +info +slowlog +latency +memory +client|list +config|get \
    -@write -@dangerous -@admin

# Inspect and verify what a user can actually do:
#   ACL LIST                 -> all users and their rules
#   ACL GETUSER app_svc      -> one user's exact permissions
#   ACL WHOAMI               -> who the current connection is
#   ACL CAT                  -> the command categories (@read, @write, @dangerous...)
```

### Go — a TLS + ACL connection with go-redis

```go
package secureredis

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"github.com/redis/go-redis/v9"
)

// NewHardenedClient connects as a least-privilege ACL user over TLS with mutual
// authentication. Nothing here is optional in a real deployment: the app never
// connects as the default user, never in clear text, and never with more
// privilege than it uses.
func NewHardenedClient(ctx context.Context) (*redis.Client, error) {
	// Load the CA that signed the server cert so we can verify the server's
	// identity — this is what prevents connecting to an impostor Redis.
	caPEM, err := os.ReadFile("/etc/redis/tls/ca.crt")
	if err != nil {
		return nil, fmt.Errorf("read CA: %w", err)
	}
	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("bad CA cert")
	}

	// Present OUR client certificate so the server can authenticate us too
	// (mutual TLS, matching tls-auth-clients yes on the server).
	clientCert, err := tls.LoadX509KeyPair(
		"/etc/redis/tls/client.crt", "/etc/redis/tls/client.key")
	if err != nil {
		return nil, fmt.Errorf("load client cert: %w", err)
	}

	rdb := redis.NewClient(&redis.Options{
		Addr: "10.0.1.20:6380", // the TLS port, on the internal address

		// ACL credentials: connect as the scoped application user, NOT default.
		// Username triggers ACL AUTH; the user is limited to ~app:* by the server.
		Username: "app_svc",
		Password: mustEnv("REDIS_APP_PASSWORD"), // from a secret store, never hard-coded

		// TLS config: verify the server via our CA, and present our client cert.
		TLSConfig: &tls.Config{
			RootCAs:      caPool,
			Certificates: []tls.Certificate{clientCert},
			MinVersion:   tls.VersionTLS12, // never negotiate down to old TLS
			ServerName:   "redis.internal", // must match the server cert's SAN
		},
	})

	// Fail fast if auth, TLS or connectivity is wrong — better at startup than
	// on the first cache miss under load.
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("ping (auth/tls/network?): %w", err)
	}
	return rdb, nil
}

// TenantClient returns a client scoped to a single tenant's ACL user, so the
// server itself enforces that this connection can only touch tenant:N:* keys.
// This is soft multi-tenancy done correctly: the isolation is not a prefix the
// application politely remembers, it is a boundary the server refuses to cross.
func TenantClient(ctx context.Context, tenantID int, password string) (*redis.Client, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     "10.0.1.20:6380",
		Username: fmt.Sprintf("tenant_%d", tenantID),
		Password: password,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: "redis.internal"},
	})
	return rdb, rdb.Ping(ctx).Err()
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		panic("missing required secret: " + k)
	}
	return v
}
```

The three artefacts together implement the layered model: the config makes the port unreachable and removes footguns, the ACL rules give every role exactly the privilege it needs and no more, and the Go client proves its identity with a certificate while proving *what it may do* with a scoped ACL user.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **ACLs give bounded blast radius.** A leaked application credential can do only what that user could — its prefix, its commands — not own the instance.
- **Server-enforced tenant isolation.** ACL key patterns make namespacing a boundary the server refuses to cross, not a convention application code must remember.
- **TLS closes the clear-text exposure.** Credentials and cached PII are no longer readable on the wire, satisfying most compliance regimes.
- **`rename-command` removes footguns** even from otherwise-authorised users, so an accidental `FLUSHALL` or `KEYS` cannot happen.
- **One-instance-per-tenant gives physical isolation** — separate memory, credentials and blast radius with no shared single thread.

**Disadvantages**
- **Every layer is off or permissive by default.** Security is opt-in; an unhardened Redis is wide open, and the burden is entirely on the operator.
- **ACLs add operational complexity.** More users, passwords and patterns to manage, rotate and get right; a too-broad `~*` quietly defeats the point.
- **TLS costs CPU and adds cert lifecycle.** Handshakes and encryption add latency and CPU, and certs must be issued, distributed and rotated.
- **Soft multi-tenancy still shares the thread and memory.** Namespacing and ACL patterns isolate *data* but not *resources*; a noisy tenant still degrades everyone.
- **One instance per tenant multiplies operational surface** — more processes, more monitoring, more backups — even if orchestration makes each cheap.

**Trade-offs**
- *`requirepass` vs ACLs:* one shared password is simple but all-or-nothing; ACLs are more work but give least privilege and per-role blast-radius control. Use ACLs for anything beyond a toy.
- *Shared instance vs instance-per-tenant:* sharing is memory- and ops-cheap but isolation is soft and noisy-neighbour is real; per-tenant instances give physical isolation at the cost of more instances. Choose by how strong the boundary must be.
- *TLS everywhere vs internal-only plaintext:* TLS satisfies compliance and defends a breached network at a CPU/latency and cert-management cost; a strictly private, firewalled network may accept plaintext internally. Regulation usually settles it.
- *Disabling commands vs keeping them for ops:* disabling `CONFIG`/`DEBUG` outright is safest but blocks legitimate operations; renaming to an unguessable name keeps them for tooling while denying casual use.

## 7. Common Mistakes & Best Practices

- **Binding to `0.0.0.0` on a reachable network.** The single most common cause of Redis breaches — the port becomes internet-reachable. *Best practice:* `bind` to internal interfaces only and firewall the port to app/replica hosts.
- **Running with the default user and no password.** Anyone who reaches the port owns the data and can escalate to RCE via `CONFIG SET dir` + `SAVE`. *Best practice:* disable/lock the `default` user and require authenticated ACL users.
- **Giving the application a `~*` all-commands ACL.** This is `requirepass` with extra steps — no least privilege, full blast radius on leak. *Best practice:* scope each app user to its key prefix and needed command categories, with `-@dangerous -@admin`.
- **Multi-tenancy by prefix in application code only.** A forgotten prefix or a stray `KEYS *` crosses tenants; the isolation is hope, not enforcement. *Best practice:* back every tenant prefix with an ACL key pattern so the server enforces it.
- **Using logical databases (`SELECT`) for tenancy.** They share everything, `FLUSHALL` hits all of them, ACLs cannot cleanly scope them, and Cluster ignores them. *Best practice:* use ACL-enforced namespacing or separate instances instead.
- **Leaving `CONFIG`, `FLUSHALL`, `KEYS`, `DEBUG` callable.** They are footguns even for authorised users and the tools of the `CONFIG SET dir` exploit. *Best practice:* disable or rename them via `rename-command` and/or `-@admin -@dangerous`.
- **Plaintext replication traffic.** A master–replica link in clear text leaks every value it ships. *Best practice:* enable `tls-replication yes` (and `tls-cluster yes`).
- **Best practice: assume every layer can fail.** Harden the network *and* authenticate *and* authorise *and* encrypt *and* remove footguns, so no single misconfiguration is fatal — defence in depth, not a single wall.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `ACL WHOAMI` shows who a connection is; `ACL GETUSER <name>` shows a user's exact permissions when a command is unexpectedly denied (`NOPERM` errors mean the ACL is working — check the pattern, not the code). For TLS handshake failures, verify the `ServerName` matches the cert SAN, the CA chain is complete, and clock skew is not invalidating certs. `ACL LOG` records recent authentication and permission failures — the first place to look for an attacker probing or a misconfigured client.
- **Monitoring.** Alert on `ACL LOG` entries (repeated auth failures signal probing or a broken deployment), on connections from unexpected source IPs, and on any use of a renamed dangerous command. Track certificate expiry so TLS does not fail silently at renewal time. The monitoring user itself must be least-privilege (chapter 28) so the observability path is not a backdoor.
- **Security.** Rotate ACL passwords and TLS certs on a schedule; store secrets in a vault, never in `redis.conf` in plaintext where possible, and never in source control. Keep Redis patched — while most incidents are misconfiguration, CVEs do occur (e.g. Lua sandbox escapes), and an unpatched, exposed instance compounds the risk. Audit ACLs periodically for scope creep (a `~*` that crept in).
- **Scaling.** In Cluster, secure the bus port (16379) and enable `tls-cluster yes`; every node needs the hardening, not just the ones apps connect to. For multi-tenancy at scale, per-tenant instances orchestrated by Kubernetes or a managed service (ElastiCache, Redis Cloud) give physical isolation with automated provisioning, backup and failover per tenant — usually the cleanest path once tenant count or compliance makes soft isolation untenable. ACL and TLS config should be templated and applied identically across the fleet so no node is the weak link.

## 9. Interview Questions

**Q: Why has Redis historically been involved in so many breaches if it has few security bugs?**
A: Because the breaches exploit the *default trust model*, not bugs. Redis was designed for a trusted private network, so it shipped with no authentication, all commands available, and listening broadly. When cloud and container deployments accidentally exposed port 6379 to the internet, scanners connected with no credentials and had full control — reading all data, `FLUSHALL`, or the classic escalation of `CONFIG SET dir` plus a crafted `dbfilename` and `SAVE` to write an SSH key or cron job to disk and get remote code execution. Nothing was hacked in the sense of exploiting a flaw; the trust model worked exactly as designed, on a network that should never have been trusted. The fix is operational: never expose the port, and deliberately switch off the assumed trust with auth, ACLs and TLS.

**Q: What is protected mode and what does it actually protect against?**
A: Protected mode (on by default) is a safety net that refuses connections from non-loopback addresses *when Redis has no password set and no explicit `bind` configured* — i.e. when it looks unconfigured. It exists precisely to catch the accidental-exposure case: someone starts a fresh Redis, it is reachable from outside, and without protected mode it would accept anonymous commands. It is deliberately blunt and is not a substitute for real security — the moment you set a password or a `bind`, it steps aside — but it stops the most common careless mistake from being immediately catastrophic.

**Q: What is the difference between `requirepass` and ACLs?**
A: `requirepass` is a single shared password — authentication only, and all-or-nothing: anyone with the password can run any command. ACLs (Redis 6+) add authorisation on top of authentication: named users, each with fine-grained rules over which commands (`+@read`, `-@dangerous`), which keys (`~app:*`), and which Pub/Sub channels (`&events:*`) they may use. The practical win is least privilege and bounded blast radius — an application connects as a user restricted to its own prefix and its own commands, so a leaked credential cannot own the instance. Use ACLs for anything real; `requirepass` is the legacy toy.

**Q: How do ACLs let you enforce multi-tenant key isolation?**
A: By giving each tenant's application a distinct ACL user restricted to that tenant's key pattern, e.g. `ACL SETUSER tenant_42 ... ~tenant:42:*`. Now tenant 42's connection physically cannot read or write any key outside `tenant:42:*` — the *server* rejects it with a `NOPERM` error. That turns namespacing from a convention the application must remember (and can forget, or bypass with `KEYS *`) into a boundary the server enforces. It is the difference between soft isolation that depends on correct code everywhere and soft isolation the server guarantees.

**Q: Why are logical databases (`SELECT 0..15`) discouraged for multi-tenancy?**
A: Because they share almost everything and enforce almost nothing. All numbered DBs live in the same instance, sharing the same memory budget, the same single thread and the same config; `FLUSHALL` wipes every DB at once; ACLs cannot cleanly scope permissions per DB; and Redis Cluster supports only DB 0, so the approach does not survive scaling out. They provide namespace separation with none of the isolation guarantees tenancy needs. ACL-enforced key namespacing (for soft isolation) or separate instances (for hard isolation) are both strictly better.

**Q: Which commands would you disable or rename in production, and why?**
A: The footguns and the exploit tools. `FLUSHALL`/`FLUSHDB` (accidental or malicious total data loss), `KEYS` (the O(N) command that blocks the single thread, chapter 28), `CONFIG` (the pivot in the `CONFIG SET dir` + `SAVE` RCE, and a way to weaken settings at runtime), `DEBUG` (can crash or manipulate the server), and `SHUTDOWN`. I disable the ones no one needs (`rename-command FLUSHALL ""`) and rename the ones operations genuinely use to an unguessable name (`CONFIG` → `CONFIG_9f3a2b7c`) so tooling keeps working while casual or hostile use cannot find them. ACL categories (`-@dangerous`, `-@admin`) achieve the same per-user.

**Q: (Senior) A colleague proposes one shared Redis with per-tenant key prefixes for a SaaS with a hard compliance boundary between tenants. Argue the trade-off.**
A: I would push back and probably land on one instance per tenant. Key-prefix namespacing on a shared instance gives *soft* isolation, and its weaknesses matter precisely when there is a compliance boundary. First, even with ACL key patterns enforcing the prefix (which is mandatory — prefixing in application code alone is just hope), the tenants still share memory and the single thread, so one tenant can exhaust `maxmemory` and cause the eviction policy to drop another tenant's keys, and one tenant's O(N) command blocks every tenant — a noisy-neighbour problem that is also an availability-isolation failure. Second, the blast radius of a single ACL misconfiguration, a Redis CVE, or an operational mistake is *all* tenants at once, which a compliance boundary usually cannot accept. Third, per-tenant backup, restore, encryption keys and data-residency requirements are awkward-to-impossible when everything shares one keyspace and one RDB file. One instance per tenant makes isolation physical: separate memory budgets and eviction, separate credentials and TLS, independent backup and scaling, and a breach or bug bounded to one tenant. The cost is more instances, but with Kubernetes operators or a managed Redis that provisions per tenant, that cost is largely automated away. I would only accept shared-with-namespacing when the tenants are not a genuine security boundary (e.g. free-tier users of one product) and cost dominates — and even then, only with ACL key patterns enforcing every prefix.

**Q: (Senior) Walk through hardening a Redis that is currently open on `0.0.0.0` with no auth, without a maintenance window.**
A: I would work outside-in and reversibly, because I cannot drop live connections. First and most urgently, the network: firewall port 6379 at the security-group/host level to only the known application hosts — this closes the internet exposure immediately without touching Redis config or existing connections, and is the single highest-value action. Then I would introduce authentication additively: create the ACL users the applications will use (`ACL SETUSER app_svc ... ~app:* +@read +@write`), deploy the applications to authenticate with them, and verify via `ACL WHOAMI` and traffic that everyone has migrated — *before* disabling the default user, so I never lock out a live client. Once traffic is confirmed on named users, `user default off`. Next, stand up TLS on a new `tls-port` alongside the existing plaintext port, migrate clients to it, confirm, then disable the plaintext port (`port 0`) — again additive so nothing breaks mid-migration. Then remove footguns: `rename-command` the dangerous commands, checking first via `commandstats`/`ACL LOG` that nothing legitimate calls them. Throughout I watch `ACL LOG` for auth failures (a client I forgot to migrate) and rollback is always "re-enable the old path" since every step was additive. Finally, bake the whole config into the provisioning template so the *next* instance is born hardened rather than retrofitted, and audit for the `CONFIG SET dir` exploit's traces (unexpected files, cron entries) since an open no-auth instance must be assumed already probed.

**Q: (Senior) What is the `CONFIG SET dir` attack and how does hardening stop it?**
A: It is the escalation from data access to remote code execution on an unauthenticated (or over-privileged) Redis. The attacker sets `CONFIG SET dir /some/writable/path` and `CONFIG SET dbfilename authorized_keys` (or a cron filename), stuffs a crafted value (their SSH public key, or a cron line) into a key, and triggers `SAVE`/`BGSAVE`, which writes the RDB file — containing their payload — to the chosen path with the chosen name, planting an SSH key or cron job on the host. Several layers stop it, which is the point of defence in depth. Requiring authentication stops the anonymous version. A least-privilege ACL user without `CONFIG` and without `@admin`/`@dangerous` cannot change `dir` or `dbfilename`. Renaming/disabling `CONFIG` removes the pivot entirely. Disabling persistence (`save ""`, `appendonly no`) — which a pure cache should do anyway — removes the write-to-disk mechanism. And the network layer means the attacker never reaches the port to begin with. No single one is the whole answer, which is exactly why you layer them.

**Q: When would you require mutual TLS (client certificates) rather than server-only TLS?**
A: Server-only TLS encrypts the traffic and lets the client verify the server's identity, which stops eavesdropping and connecting to an impostor. Mutual TLS (`tls-auth-clients yes`) adds the server verifying the *client's* identity via a client certificate, so only holders of a valid cert can even complete the handshake — authentication at the transport layer, before any `AUTH`. I require it in zero-trust or high-compliance environments where I want a second, cryptographic factor beyond the ACL password, where I want to revoke a client's access by revoking its cert, or where I cannot fully trust the network path even after firewalling. It costs more certificate lifecycle management, so for a strictly private, firewalled network with strong ACL auth, server-only TLS is often a reasonable stopping point.

## 10. Quick Revision & Cheat Sheet

| Layer | Mechanism | Key config / command |
|---|---|---|
| Network | bind + firewall + protected mode | `bind 10.0.1.20 127.0.0.1`, `protected-mode yes` |
| Authentication | ACL users (not shared password) | `user default off`, `ACL SETUSER app_svc on >pass` |
| Authorisation | least-privilege patterns | `~app:* +@read +@write -@dangerous` |
| Encryption | TLS client + replication | `tls-port 6380`, `tls-replication yes` |
| Command control | disable/rename footguns | `rename-command FLUSHALL ""`, `CONFIG` → hidden |
| Multi-tenancy | ACL key patterns / per-instance | `~tenant:42:*` or one Redis per tenant |

| Isolation approach | Isolation strength | Use when |
|---|---|---|
| Shared + prefix (code only) | convention (weak) | never alone — always add ACL patterns |
| Shared + ACL key patterns | server-enforced data isolation | soft tenancy, shared resources OK |
| Logical DBs (`SELECT`) | discouraged | legacy namespace split, not tenancy |
| One instance per tenant | physical (strongest) | real security/compliance boundary |

**Flash cards**
- **Root cause of Redis breaches?** → Default trusted-network model exposed to the internet, not bugs.
- **protected mode?** → Refuses non-loopback connections when unconfigured; a safety net, not security.
- **requirepass vs ACL?** → Shared password (all-or-nothing) vs named least-privilege users.
- **Enforce tenant isolation?** → ACL key pattern `~tenant:N:*`, so the server rejects cross-tenant access.
- **`CONFIG SET dir` attack?** → Write an RDB payload (SSH key/cron) to disk → RCE; stop via auth + no CONFIG + no persistence + network.
- **Cleanest multi-tenancy for a hard boundary?** → One instance per tenant (physical isolation).

## 11. Hands-On Exercises & Mini Project

- [ ] Start a default Redis, connect from another host with no password, and observe you have full access; then `bind` internally and firewall the port and confirm it is unreachable.
- [ ] Create an ACL user scoped to `~app:*` with `+@read +@write -@dangerous`, connect as it, and confirm `KEYS *`, `CONFIG GET`, and a `GET other:key` are all denied with `NOPERM`.
- [ ] Generate a self-signed CA and server/client certs, enable `tls-port` with `tls-auth-clients yes`, and connect over mutual TLS from go-redis.
- [ ] `rename-command FLUSHALL ""` and `CONFIG` to a hidden name, then confirm `FLUSHALL` fails and `CONFIG` works only under the new name.
- [ ] Create two tenant users (`tenant_1`, `tenant_2`) each scoped to their prefix and prove that tenant 1's connection cannot read tenant 2's keys.
- [ ] Trigger auth and permission failures and read them back from `ACL LOG`.

### Mini Project — "Harden a Wide-Open Redis"

**Goal.** Take a deliberately insecure Redis (open on `0.0.0.0`, no auth, all commands) and drive it through the full layered hardening without ever losing a live connection, ending with a repeatable provisioning template.

**Requirements.**
1. Start from the insecure baseline and demonstrate the `CONFIG SET dir` + `SAVE` write-to-disk escalation in a sandbox so the risk is concrete.
2. Apply the layers in order — firewall/bind, ACL users, TLS, command control — each additively, verifying live traffic keeps working at every step.
3. Build a least-privilege ACL scheme with at least three roles: application, per-tenant, and read-only monitoring.
4. Prove tenant isolation: two tenant users that provably cannot see each other's keys, enforced by the server.
5. Produce a `redis.conf` + `users.acl` + go-redis client template and a written pre-production hardening checklist.

**Extensions.**
- Extend to a 3-node Cluster with `tls-cluster yes` and the bus port firewalled, applying identical hardening to every node.
- Compare shared-instance-with-ACL-patterns against instance-per-tenant for the same tenant set, measuring the noisy-neighbour effect (one tenant exhausting `maxmemory` and evicting another's keys) that only the per-instance model prevents.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis as a Cache* (the single-thread model behind the `KEYS`/`FLUSHALL` footguns), *Observability* (the least-privilege monitoring user and `ACL LOG` alerting), *Persistence: RDB, AOF & the Durability Trade-off* (why disabling persistence also removes an attack surface), *Replication & High Availability* (securing replica traffic with TLS), *Redis Cluster* (securing the bus and per-node hardening).

- **Redis — Security** — Redis · *Intermediate* · the maintainers' overview of the trust model, protected mode, and the network-first advice this chapter builds on. <https://redis.io/docs/latest/operate/oss_and_stack/management/security/>
- **Redis — ACL documentation** — Redis · *Advanced* · the authoritative reference for users, categories, key/channel patterns and `ACL SETUSER` syntax. <https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/>
- **Redis — Encryption / TLS support** — Redis · *Advanced* · how to configure `tls-port`, certs, mutual TLS and TLS for replication and Cluster. <https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/>
- **Redis — Command rename & disabling** — Redis · *Intermediate* · `rename-command` semantics and the case for removing dangerous commands. <https://redis.io/docs/latest/operate/oss_and_stack/management/config/>
- **OWASP — Redis security cheat sheet / hardening guidance** — OWASP · *Intermediate* · community hardening checklist covering exposure, auth and command control. <https://cheatsheetseries.owasp.org/>
- **Redis — ACL LOG and auditing** — Redis · *Intermediate* · using `ACL LOG` to detect auth and permission failures and probing. <https://redis.io/docs/latest/commands/acl-log/>
- **AWS ElastiCache — Security & encryption** — AWS · *Intermediate* · a managed-service view of in-transit/at-rest encryption, auth tokens and RBAC for multi-tenant setups. <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/encryption.html>
- **Redis University — RU330: Redis Security** — Redis · *Intermediate* · a free course covering ACLs, TLS, and production hardening end to end. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 29.*
