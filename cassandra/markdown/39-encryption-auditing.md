# 39 · Encryption (TLS & At-Rest) and Auditing

> **In one line:** Encrypt the wire with client and node-to-node TLS, encrypt the disk with filesystem-level or commercial TDE, and prove what happened with Cassandra 4.0's audit log and full query log.

---

## 1. Overview

Cassandra moves data across three boundaries, and each needs its own protection. Clients talk to coordinators over the native protocol on port 9042. Coordinators talk to replicas over the internode messaging protocol on ports 7000 (plaintext) and 7001 (TLS). And data eventually lands on disk as SSTables, commit logs, hints, and snapshots. Encryption in Cassandra therefore has two independent stories: **transport encryption** (TLS), which Apache Cassandra implements natively and thoroughly, and **at-rest encryption**, which open-source Cassandra deliberately does *not* implement, delegating it to the filesystem or the storage layer.

That second point surprises people, so state it plainly: **Apache Cassandra has no built-in transparent data encryption.** DataStax Enterprise ships TDE with a local or KMIP key store; open-source clusters achieve at-rest encryption with LUKS/dm-crypt on Linux, encrypted EBS/persistent-disk volumes in the cloud, or self-encrypting drives. This is not a gap so much as a design decision — kernel-level encryption is faster (AES-NI, no JVM involvement), covers commit logs, hints, and snapshots automatically, and does not complicate compaction or streaming. The trade-off is that it protects against stolen disks, not against a compromised OS user.

Transport encryption is where Cassandra gives you real knobs. `client_encryption_options` governs the CQL port; `server_encryption_options` governs internode traffic, with an `internode_encryption` mode of `none`, `all`, `dc` (encrypt cross-DC only), or `rack`. Cassandra 4.0 was a watershed here: `CASSANDRA-10404` rewrote internode messaging on Netty, making TLS cheap enough to leave on everywhere, and added **optional** mode so you can roll TLS out without a flag-day restart. Cassandra 4.0 also added hot-reloading of keystores (`CASSANDRA-14222`), so certificate rotation no longer requires a rolling restart — the node re-reads the keystore when its file timestamp changes.

Auditing arrived in the same release. Before 4.0, the only way to know who ran what was DSE or a proxy. `CASSANDRA-12151` added the **audit log**, a low-overhead binary-log-based recorder with category filters (`QUERY`, `DML`, `DDL`, `DCL`, `AUTH`, `ERROR`, `PREPARE`), keyspace include/exclude lists, and role filters. Its sibling, **full query logging** (`CASSANDRA-13983`), records every query with its parameters for replay and debugging — invaluable for capacity testing (`fqltool replay`) but far heavier than the audit log.

A concrete example: a healthcare platform under HIPAA runs Cassandra across two datacenters. They enable client TLS with mutual authentication so only certificate-holding services connect; internode TLS in `all` mode because their DCs span a shared cloud backbone; LUKS on every data volume with keys from the cloud KMS; and the audit log filtered to `DCL,DDL,AUTH` plus `DML` on the `phi` keyspace only, shipped hourly to a SIEM with 7-year retention. The `DML`-on-one-keyspace filter is the operationally important part: auditing every query on every keyspace would double their write I/O.
## 2. Core Concepts

- **`client_encryption_options`** — `cassandra.yaml` block controlling TLS on the native (CQL) port, including `optional`, `require_client_auth`, and cipher/protocol selection.
- **`server_encryption_options`** — the internode block; `internode_encryption` may be `none`, `all`, `dc`, or `rack`.
- **Keystore** — a JKS or PKCS12 file holding the node's private key and certificate, used to prove the node's identity.
- **Truststore** — a JKS/PKCS12 file holding the CA certificate(s) used to validate peers. With a private CA, this is usually one root cert.
- **Mutual TLS (mTLS)** — `require_client_auth: true`, forcing clients to present a certificate the node validates against the truststore. Authentication by certificate, complementary to password auth.
- **Optional TLS** — `optional: true`, accepting both plaintext and TLS on the same port so a cluster can be migrated without downtime.
- **Hot reload** — Cassandra 4.0+ re-reads keystores/truststores when the file mtime changes (checked every `ssl_storage_port` reload interval, 10 min by default), enabling certificate rotation without restart.
- **At-rest encryption (TDE)** — encryption of SSTables/commit logs on disk. Open-source: LUKS/dm-crypt, encrypted cloud volumes, or SEDs. DSE: native TDE with local or KMIP key management.
- **Audit log** — 4.0+ binary-log recorder of categorized cluster activity (who, from where, what statement), decoded with `auditlogviewer`.
- **Full query log (FQL)** — 4.0+ recorder of all queries with bind values, decoded and replayed with `fqltool dump` / `fqltool replay`.
- **Chronicle Queue** — the append-only binary log library backing both audit log and FQL, chosen for microsecond-scale write overhead.
## 3. Theory & Internals

### 3.1 What TLS actually costs

Cassandra's TLS uses the JVM's `SSLEngine`, optionally accelerated by netty-tcnative (OpenSSL/BoringSSL). Two costs matter:

**Handshake cost** — an RSA-2048 handshake costs roughly 1–2 ms of CPU on the server; ECDSA P-256 is 3–5× cheaper. This is paid per connection, so, exactly as with bcrypt in the previous chapter, long-lived pooled sessions make it irrelevant and connection churn makes it fatal.

**Bulk cipher cost** — with AES-NI, `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256` runs at several GB/s per core. Measured overhead on a modern node is typically **3–8% CPU** for internode traffic at realistic throughputs. Without AES-NI or with a CBC cipher suite it can be 20%+, which is why cipher suite selection is a performance decision and not only a security one.

Prefer, in order: `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256`, `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`, and on Java 11+/TLS 1.3, `TLS_AES_128_GCM_SHA256`. Disable everything with `CBC`, `3DES`, `RC4`, or `SHA1` MACs, and set `accepted_protocols: [TLSv1.2, TLSv1.3]`.

### 3.2 The optional-TLS migration ladder

Because you cannot restart a cluster into TLS atomically, Cassandra provides a staged path. The invariant is that at every stage, nodes with the *old* config and nodes with the *new* config can still talk.

```
Stage 0  internode_encryption: none                       (all plaintext)
Stage 1  internode_encryption: all,  optional: true       (accept both, prefer TLS)
Stage 2  internode_encryption: all,  optional: false      (TLS only)
```

Each stage is a full rolling restart. Attempting to jump 0 → 2 partitions the cluster mid-restart: restarted nodes refuse plaintext, unrestarted nodes cannot speak TLS, gossip splits, and you get a live incident.

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="360" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Encryption boundaries in a Cassandra deployment</text>
<rect x="20" y="50" width="150" height="90" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="38" y="76" font-size="12" font-weight="bold" fill="#1e293b">Application</text>
<text x="38" y="98" font-size="11" fill="#1e293b">driver session</text> <text x="38" y="118" font-size="11" fill="#1e293b">truststore + key</text>
<rect x="290" y="50" width="180" height="90" rx="8" fill="#eef2ff" stroke="#4f46e5"/> <text x="308" y="76" font-size="12" font-weight="bold" fill="#1e293b">Coordinator node</text>
<text x="308" y="98" font-size="11" fill="#1e293b">port 9042 native</text> <text x="308" y="118" font-size="11" fill="#1e293b">port 7001 internode TLS</text>
<rect x="580" y="50" width="160" height="90" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="598" y="76" font-size="12" font-weight="bold" fill="#1e293b">Replica nodes</text>
<text x="598" y="98" font-size="11" fill="#1e293b">same keystore CA</text> <text x="598" y="118" font-size="11" fill="#1e293b">rack / dc / all mode</text>
<path d="M170 95 L290 95" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a39)"/> <text x="176" y="88" font-size="10" fill="#1e293b">client TLS (mTLS optional)</text>
<path d="M470 95 L580 95" stroke="#16a34a" stroke-width="2" marker-end="url(#a39)"/> <text x="476" y="88" font-size="10" fill="#1e293b">internode TLS</text>
<rect x="290" y="180" width="180" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/> <text x="308" y="206" font-size="12" font-weight="bold" fill="#1e293b">Disk</text>
<text x="308" y="228" font-size="11" fill="#1e293b">SSTable · commitlog · hints</text> <path d="M380 140 L380 180" stroke="#d97706" stroke-width="2" marker-end="url(#a39)"/>
<text x="390" y="166" font-size="10" fill="#1e293b">written unencrypted by Cassandra</text> <rect x="20" y="272" width="720" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="36" y="296" font-size="12" font-weight="bold" fill="#1e293b">At rest is the kernel's job in open-source Cassandra</text>
<text x="36" y="318" font-size="11" fill="#1e293b">LUKS / dm-crypt, encrypted cloud volumes, or self-encrypting drives cover data, commitlog,</text>
<text x="36" y="336" font-size="11" fill="#1e293b">hints and snapshots at once. Native TDE exists only in DataStax Enterprise.</text> <defs>
<marker id="a39" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"> <path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```

### 3.3 How the audit log is cheap

The audit log writes to a **Chronicle Queue**: a memory-mapped, append-only ring of rolled files. A record is serialized into a pre-allocated off-heap buffer with no allocation and no fsync in the hot path, giving sub-microsecond append latency. Two knobs control back-pressure behaviour:

- `block: true` (default) — if the queue is full, the writing thread blocks. Safe for compliance (no lost records) but the audit log can become a latency source.
- `block: false` — records are dropped when the queue is full, and a counter is incremented. Fast, but you lose the compliance guarantee.

`roll_cycle` (default `HOURLY`) controls file rotation, and `max_log_size` (default 17 GB) plus `max_archive_retries` control the archiving handoff via `archive_command`. The single most important tuning decision is **filtering**: `included_categories`, `excluded_categories`, `included_keyspaces`, `excluded_keyspaces`, `included_users`, `excluded_users`. Auditing `QUERY` and `DML` across all keyspaces roughly doubles the I/O of a read-heavy cluster; auditing `DCL,DDL,AUTH` costs essentially nothing because those events are rare.

### 3.4 Audit log versus full query log

| | Audit log | Full query log |
|---|---|---|
| Purpose | Compliance: who did what, when, from where | Debugging and replay: exact queries + bind values |
| Records | Categorized events, statement text | Every query, with parameters and timestamps |
| Filtering | Rich (category, keyspace, user) | Minimal |
| Volume | Small if filtered to DCL/DDL/AUTH | Very large — plan a dedicated volume |
| Tool | `auditlogviewer` | `fqltool dump` / `fqltool replay` / `fqltool compare` |
| Enable at runtime | `nodetool enableauditlog` | `nodetool enablefullquerylog` |
## 4. Architecture & Workflow

Rolling out encryption and auditing across a live cluster, in the order that keeps the cluster up:

1. **Build a private CA.** One root key, offline. Generate a per-node key pair with a SAN covering the node's hostname *and* its IP, since Cassandra's internode verification can check either depending on `require_endpoint_verification`.
2. **Create keystore and truststore per node.** The keystore holds that node's key plus its signed cert; the truststore holds only the CA cert. Distribute with your config management, `chmod 600`, owned by the `cassandra` user.
3. **Enable client TLS with `optional: true`** and rolling-restart. Both plaintext and TLS clients keep working.
4. **Migrate clients** to TLS by shipping the truststore and updating driver configuration. Verify with `nodetool` connection metrics and driver logs that no plaintext CQL connections remain.
5. **Flip `optional: false`** on the client block and rolling-restart. Plaintext CQL is now rejected.
6. **Enable internode TLS with `optional: true`** (`internode_encryption: all`) and rolling-restart. Nodes negotiate TLS with restarted peers and plaintext with the rest.
7. **Flip internode `optional: false`** and rolling-restart. All gossip, streaming, hints, and replica traffic is now encrypted.
8. **Enable at-rest encryption** by provisioning new nodes on LUKS-backed or KMS-encrypted volumes and replacing existing nodes one at a time with `-Dcassandra.replace_address_first_boot`. This is the slow part: it is a full data migration.
9. **Enable the audit log** with a conservative filter (`DCL,DDL,AUTH`) on a dedicated volume, verify with `auditlogviewer`, then widen to `DML` on sensitive keyspaces only.
10. **Wire archiving** — set `archive_command` to move rolled Chronicle files to object storage or your SIEM collector, and alert if archiving falls behind.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Zero-downtime TLS rollout ladder</text>
<rect x="20" y="52" width="215" height="120" rx="8" fill="#fef3c7" stroke="#d97706"/> <text x="36" y="78" font-size="13" font-weight="bold" fill="#1e293b">Stage 1</text>
<text x="36" y="100" font-size="11" fill="#1e293b">optional: true</text> <text x="36" y="120" font-size="11" fill="#1e293b">node accepts plaintext</text>
<text x="36" y="140" font-size="11" fill="#1e293b">and TLS on same port</text> <text x="36" y="160" font-size="11" fill="#1e293b">rolling restart 1</text>
<rect x="272" y="52" width="215" height="120" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="288" y="78" font-size="13" font-weight="bold" fill="#1e293b">Stage 2</text>
<text x="288" y="100" font-size="11" fill="#1e293b">migrate every client</text> <text x="288" y="120" font-size="11" fill="#1e293b">ship truststore, update</text>
<text x="288" y="140" font-size="11" fill="#1e293b">driver ssl_context</text> <text x="288" y="160" font-size="11" fill="#1e293b">no restart needed</text>
<rect x="524" y="52" width="215" height="120" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="540" y="78" font-size="13" font-weight="bold" fill="#1e293b">Stage 3</text>
<text x="540" y="100" font-size="11" fill="#1e293b">optional: false</text> <text x="540" y="120" font-size="11" fill="#1e293b">plaintext rejected</text>
<text x="540" y="140" font-size="11" fill="#1e293b">require_client_auth</text> <text x="540" y="160" font-size="11" fill="#1e293b">rolling restart 2</text>
<path d="M235 112 L272 112" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a39b)"/> <path d="M487 112 L524 112" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a39b)"/>
<rect x="20" y="200" width="719" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="36" y="222" font-size="12" font-weight="bold" fill="#1e293b">Repeat the same ladder for internode: none  to  all+optional  to  all</text>
<text x="36" y="242" font-size="11" fill="#1e293b">Skipping the optional stage splits gossip mid-restart and takes the cluster down.</text>
<rect x="20" y="266" width="719" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="36" y="288" font-size="12" font-weight="bold" fill="#1e293b">Cassandra 4.0+ hot reload</text>
<text x="36" y="308" font-size="11" fill="#1e293b">Replace keystore files in place; the node re-reads them on mtime change. No restart to rotate certs.</text> <defs>
<marker id="a39b" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"> <path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```
## 5. Implementation

### 5.1 Generate a CA and per-node keystores

```bash
# 1. Private CA (do this once, keep ca-key.pem offline)
openssl req -new -x509 -nodes -days 3650 -newkey rsa:4096 \
  -keyout ca-key.pem -out ca-cert.pem \
  -subj "/CN=cassandra-internal-ca/O=zariya/C=IN"

# 2. Per-node key pair in a JKS keystore
NODE=cass-01.prod.internal
IP=10.0.1.11
keytool -genkeypair -alias $NODE -keyalg RSA -keysize 2048 -validity 730 \
  -keystore $NODE-keystore.jks -storepass "$KS_PASS" -keypass "$KS_PASS" \
  -dname "CN=$NODE, O=zariya, C=IN" \
  -ext "SAN=dns:$NODE,ip:$IP"

# 3. CSR, sign with the CA
keytool -certreq -alias $NODE -keystore $NODE-keystore.jks \
  -storepass "$KS_PASS" -file $NODE.csr -ext "SAN=dns:$NODE,ip:$IP"
openssl x509 -req -CA ca-cert.pem -CAkey ca-key.pem -CAcreateserial \
  -in $NODE.csr -out $NODE-cert.pem -days 730 -sha256 \
  -extfile <(printf "subjectAltName=DNS:$NODE,IP:$IP")

# 4. Import CA then the signed cert back into the keystore
keytool -importcert -alias ca -file ca-cert.pem -keystore $NODE-keystore.jks \
  -storepass "$KS_PASS" -noprompt
keytool -importcert -alias $NODE -file $NODE-cert.pem -keystore $NODE-keystore.jks \
  -storepass "$KS_PASS" -noprompt

# 5. One shared truststore holding only the CA
keytool -importcert -alias ca -file ca-cert.pem -keystore truststore.jks \
  -storepass "$TS_PASS" -noprompt

chmod 600 *.jks && chown cassandra:cassandra *.jks
```

### 5.2 `cassandra.yaml` encryption blocks

```yaml
client_encryption_options:
  enabled: true
  optional: false                     # stage 3: reject plaintext
  keystore: /etc/cassandra/conf/cass-01-keystore.jks
  keystore_password: ${KS_PASS}
  require_client_auth: true           # mutual TLS
  truststore: /etc/cassandra/conf/truststore.jks
  truststore_password: ${TS_PASS}
  protocol: TLS
  accepted_protocols: [TLSv1.2, TLSv1.3]
  cipher_suites:
    - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
    - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384

server_encryption_options:
  internode_encryption: all           # none | all | dc | rack
  optional: false
  legacy_ssl_storage_port_enabled: false
  keystore: /etc/cassandra/conf/cass-01-keystore.jks
  keystore_password: ${KS_PASS}
  require_client_auth: true           # mutual TLS between nodes
  truststore: /etc/cassandra/conf/truststore.jks
  truststore_password: ${TS_PASS}
  require_endpoint_verification: true # validate peer hostname against SAN
  accepted_protocols: [TLSv1.2, TLSv1.3]
```

> **Note:** `require_endpoint_verification: true` is what stops an attacker with *any* CA-signed certificate from joining the ring. Without it, mutual TLS proves only "signed by our CA", not "is the node it claims to be."

### 5.3 Audit log configuration

```yaml
audit_logging_options:
  enabled: true
  logger:
    class_name: BinAuditLogger        # or FileAuditLogger for slf4j output
  audit_logs_dir: /var/log/cassandra/audit   # DEDICATED volume
  included_categories: DCL,DDL,AUTH
  excluded_categories: ''
  included_keyspaces: ''
  excluded_keyspaces: system,system_schema,system_virtual_schema
  included_users: ''
  excluded_users: ''
  roll_cycle: HOURLY
  block: true
  max_queue_weight: 268435456         # 256 MiB
  max_log_size: 17179869184           # 16 GiB
  archive_command: '/usr/local/bin/ship-audit.sh %path'
  max_archive_retries: 10
```

```bash
# Toggle at runtime without a restart
nodetool enableauditlog \
  --logger BinAuditLogger \
  --included-categories DCL,DDL,AUTH,DML \
  --included-keyspaces phi

nodetool disableauditlog

# Decode the binary log
auditlogviewer /var/log/cassandra/audit
# LogMessage: user:svc_ledger|host:/10.0.1.11:7000|source:/10.2.4.87|port:51344
#   |timestamp:1753180442117|type:UPDATE|category:DML|ks:phi|scope:patient_events
#   |operation:UPDATE phi.patient_events SET note=? WHERE id=? AND ts=?
```

### 5.4 Full query log for replay-based testing

```bash
nodetool enablefullquerylog --path /var/log/cassandra/fql --roll-cycle HOURLY \
  --blocking false --max-log-size 10737418240

# ... capture production traffic for 30 minutes ...
nodetool disablefullquerylog

fqltool dump /var/log/cassandra/fql | head -5
# Query: SELECT amount FROM payments.ledger WHERE id=?
# Values: [7f3c9a12-...]
# Query start time: 1753180442117  Protocol version: 5  Consistency: LOCAL_QUORUM

# Replay captured production traffic against a staging cluster
fqltool replay --target 10.9.0.11 --keyspace payments /var/log/cassandra/fql
```

### 5.5 Driver-side TLS

```python
from ssl import SSLContext, PROTOCOL_TLS_CLIENT, CERT_REQUIRED
from cassandra.cluster import Cluster
from cassandra.auth import PlainTextAuthProvider
import os

ctx = SSLContext(PROTOCOL_TLS_CLIENT)
ctx.verify_mode = CERT_REQUIRED
ctx.check_hostname = True
ctx.load_verify_locations("/etc/ssl/cassandra/ca-cert.pem")
ctx.load_cert_chain(certfile="/etc/ssl/cassandra/client-cert.pem",
                    keyfile="/etc/ssl/cassandra/client-key.pem")   # for mTLS

cluster = Cluster(
    ["cass-01.prod.internal", "cass-02.prod.internal"],
    ssl_context=ctx,
    auth_provider=PlainTextAuthProvider(os.environ["CASS_USER"],
                                        os.environ["CASS_PASSWORD"]),
    protocol_version=5,
)
session = cluster.connect("payments")
```

```java
// Java driver 4.x -- application.conf
// datastax-java-driver.advanced.ssl-engine-factory {
//   class = DefaultSslEngineFactory
//   hostname-validation = true
//   truststore-path = /etc/ssl/cassandra/truststore.jks
//   truststore-password = ${TS_PASS}
//   keystore-path = /etc/ssl/cassandra/client-keystore.jks
//   keystore-password = ${KS_PASS}
// }
CqlSession session = CqlSession.builder()
    .withLocalDatacenter("dc_east")
    .withKeyspace("payments")
    .build();   // picks up SSL config from application.conf
```

**Optimization note.** Three levers dominate TLS cost. First, cipher suite: pin GCM suites so AES-NI is used and avoid CBC, which halves throughput on some JVMs. Second, install `netty-tcnative-boringssl-static` on the classpath — Cassandra 4.0 will prefer the native OpenSSL provider over the JDK `SSLEngine`, typically cutting TLS CPU by 30–50%. Third, use `internode_encryption: dc` when your intra-rack traffic already crosses a trusted private network but cross-DC traffic traverses the public internet; you get the security that matters at a fraction of the CPU. For auditing, the equivalent lever is filtering: never audit `QUERY` globally, and put `audit_logs_dir` on a volume separate from the data disk so a log burst cannot fill the data path.
## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Client TLS | Protects credentials and payloads on the wire; mandatory if using password auth | 1–2 ms handshake per connection; certificate lifecycle to manage |
| Internode TLS (`all`) | Encrypts gossip, streaming, hints, and replica traffic | 3–8% CPU with AES-NI; more with CBC or no native provider |
| `internode_encryption: dc` | Encrypts only the traffic that leaves the datacenter — best cost/benefit | Intra-DC traffic remains plaintext; unacceptable in shared/hostile networks |
| Mutual TLS | Certificate-based identity for nodes and clients; blocks rogue node joins | Client cert distribution and rotation become an operational program |
| Hot keystore reload (4.0+) | Certificate rotation with no restart | Only reloads on file mtime change; silent failure if permissions are wrong |
| LUKS / encrypted volumes | Covers SSTables, commitlog, hints, snapshots uniformly; hardware-accelerated | Protects against stolen disks only; a compromised OS user still reads plaintext |
| DSE native TDE | Per-table encryption, KMIP key management, key rotation | Not available in Apache Cassandra; vendor lock-in |
| Audit log (filtered) | Compliance-grade attribution at negligible cost | Only useful if filtered; unfiltered it can double I/O |
| Audit log `block: true` | No lost records — required for compliance | The audit queue can become a source of write latency |
| Full query log | Exact production replay for testing and root cause | Very high volume; needs its own volume and short retention |
## 7. Common Mistakes & Best Practices

1. ⚠️ **Enabling auth without TLS.** → ✅ Roll out `client_encryption_options` first. SASL PLAIN sends the password as cleartext bytes; auth over plaintext is a false sense of security.
2. ⚠️ **Jumping straight to `optional: false`.** → ✅ Use the ladder: enable with `optional: true`, rolling restart, migrate clients/peers, then flip to `optional: false` with a second rolling restart. A flag-day switch splits gossip and takes the cluster down.
3. ⚠️ **Leaving `require_endpoint_verification: false`.** → ✅ Set it to `true` so peers are validated against the certificate SAN. Otherwise any cert signed by your CA — including one issued for an unrelated service — can join the ring.
4. ⚠️ **Self-signed certificates per node with no CA.** → ✅ Run a private CA and put only the CA cert in the truststore. Per-node self-signed certs mean every truststore must list every node, and adding a node becomes a cluster-wide config push.
5. ⚠️ **Certificates that expire unnoticed.** → ✅ Monitor `notAfter` on every node's cert and alert at 30 days. Expiry is a simultaneous, total, cluster-wide outage — internode TLS fails on every link at once.
6. ⚠️ **Assuming Cassandra encrypts data at rest.** → ✅ It does not. Provision LUKS/dm-crypt or encrypted cloud volumes, and remember to cover the commitlog, hints, saved caches, and snapshot directories, not just the data directory.
7. ⚠️ **Encrypting the data volume but not the backup destination.** → ✅ Snapshots shipped to object storage must use server-side or client-side encryption too; otherwise your at-rest control has an unencrypted copy sitting in a bucket.
8. ⚠️ **Auditing everything.** → ✅ Start with `included_categories: DCL,DDL,AUTH` — rare, high-value events. Add `DML` only for sensitive keyspaces via `included_keyspaces`. Auditing `QUERY` globally can double cluster I/O.
9. ⚠️ **Writing audit logs to the data disk.** → ✅ Mount `audit_logs_dir` on a separate volume. A compliance-driven retention change should never be able to fill the disk Cassandra stores data on.
10. ⚠️ **Setting `block: false` in a regulated environment.** → ✅ With `block: false` records are silently dropped under pressure, which breaks the compliance guarantee. Use `block: true`, size `max_queue_weight` generously, and monitor the dropped-event counter.
11. ⚠️ **Leaving full query logging on permanently.** → ✅ FQL is a diagnostic and load-capture tool. Enable it with `nodetool enablefullquerylog` for a bounded window, capture, then `disablefullquerylog`.
12. ⚠️ **Storing keystore passwords in the yaml in git.** → ✅ Inject via environment substitution or a secrets manager, keep keystores `chmod 600` owned by the `cassandra` user, and never commit them.
## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

TLS failures are noisy but the messages are precise.

```bash
# Verify the node is actually serving TLS and see the presented chain
openssl s_client -connect cass-01.prod.internal:9042 -CAfile ca-cert.pem </dev/null
# depth=1 CN = cassandra-internal-ca  ... Verify return code: 0 (ok)

# Inspect what is in a keystore
keytool -list -v -keystore cass-01-keystore.jks -storepass "$KS_PASS" | \
  grep -E "Alias|Valid from|SubjectAlternativeName"

# JVM-level handshake tracing (temporarily, in jvm-server.options)
# -Djavax.net.debug=ssl:handshake

# Common failures and causes
# "PKIX path building failed"        -> CA cert missing from truststore
# "No subject alternative names"     -> SAN missing; require_endpoint_verification fails
# "Received fatal alert: bad_certificate" -> mTLS on, client presented no/invalid cert
# "certificate_expired"              -> rotate now; this hits all nodes simultaneously
```

For internode problems, `nodetool gossipinfo` and the `system.log` line `Failed to connect to peer` on port 7001 tell you whether the split is TLS-related.

### Monitoring

| Signal | Source |
|---|---|
| Certificate days to expiry | external check on `notAfter`; alert at 30 days |
| Internode connection failures | `org.apache.cassandra.metrics:type=Connection,name=Timeouts` and `system.log` |
| TLS CPU overhead | node CPU delta measured before/after enablement in a canary |
| Audit events dropped | `BinLog` dropped-record counter in JMX; must be zero with `block: true` |
| Audit archive lag | age of the newest file in `audit_logs_dir` versus archive destination |
| Audit volume free space | filesystem check on `audit_logs_dir`; alert at 70% |
| FQL enabled anywhere | `nodetool getfullquerylog` across the fleet — should be off in steady state |

### Security

Layer the controls. TLS protects the wire; auth (chapter 38) protects identity; mTLS ties them together by requiring both a certificate and a credential. At rest, encrypt whole volumes and treat backups identically. Rotate certificates on a schedule shorter than their validity — 2-year certs rotated annually — and exercise the hot-reload path in staging so you know it works before you need it. Ship audit logs off-node quickly: an attacker with root on a node can otherwise delete their own trail, so the archive destination should be append-only (object-lock enabled bucket) and on a different trust boundary.

### Performance & Scaling

Measure TLS overhead on a canary node rather than trusting a number: enable it on one node, compare `ClientRequest` latency percentiles and node CPU against a peer for an hour. If overhead exceeds ~10%, check that netty-tcnative is on the classpath and that a GCM cipher was negotiated (`javax.net.debug=ssl:handshake` will print the chosen suite). Handshake cost scales with connection churn, so the same session-reuse discipline that matters for auth matters here. For audit logging, throughput scales with the number of matching events, not with cluster size, so the filter is the scaling control — measure the file growth rate in `audit_logs_dir` over an hour and multiply by retention before enabling a new category.
## 9. Interview Questions

**Q: Does Apache Cassandra encrypt data at rest?**
A: No. Open-source Cassandra has no built-in transparent data encryption; SSTables, commit logs, hints, and snapshots are written in plaintext. At-rest encryption is delegated to the operating system or storage layer — LUKS/dm-crypt, encrypted cloud volumes, or self-encrypting drives — while DataStax Enterprise provides native TDE with local or KMIP key management.

**Q: What is the difference between `client_encryption_options` and `server_encryption_options`?**
A: The client block secures the native CQL protocol on port 9042 between applications and coordinators. The server block secures internode messaging — gossip, replica writes, streaming, and hints — on port 7001, and supports the modes `none`, `all`, `dc`, and `rack`. They have independent keystores, cipher lists, and client-auth settings.

**Q: Why can't you just flip internode TLS on and do a rolling restart?**
A: Because mid-restart you would have a mixed cluster where restarted nodes speak only TLS and unrestarted nodes speak only plaintext, so gossip splits and the cluster partitions. The correct path uses `optional: true` first, which makes nodes accept both, then a second rolling restart to set `optional: false` once every node speaks TLS.

**Q: What does `require_endpoint_verification` do and why does it matter?**
A: It makes a node validate that the peer's certificate SAN actually matches the peer's hostname or IP, not merely that the certificate was signed by a trusted CA. Without it, any certificate issued by your internal CA — for any service — can be used to join the ring or impersonate a node, which turns your CA into a single point of total compromise.

**Q: What is the CPU cost of enabling TLS in Cassandra?**
A: With AES-NI and a GCM cipher suite, internode TLS typically costs 3–8% CPU at production throughput, and per-connection handshakes cost 1–2 ms of server CPU for RSA-2048. The cost balloons with CBC cipher suites or without the netty-tcnative native provider, and with applications that churn connections instead of reusing a pooled session.

**Q: What does the Cassandra 4.0 audit log record, and how do you keep it cheap?**
A: Each entry records the role, source IP and port, node, timestamp, statement category and type, keyspace, scope, and the statement text, written to a Chronicle Queue binary log and decoded with `auditlogviewer`. You keep it cheap by filtering: start with `included_categories: DCL,DDL,AUTH`, which are rare, and add `DML` only for specific sensitive keyspaces via `included_keyspaces`.

**Q: (Senior) Your certificates expire in three days across a 60-node cluster. What do you do?**
A: On Cassandra 4.0+ this is a hot-reload operation, not a restart: generate new node certs from the same CA, write the new keystore files in place with the same paths and permissions, and the node re-reads them when the file mtime changes. Do it one rack at a time, verifying with `openssl s_client` that the presented chain has the new `notAfter` and that `nodetool status` shows all nodes up before proceeding. If you are on 3.x, there is no hot reload and you need a coordinated rolling restart — which is precisely why expiry monitoring at 30 days is non-negotiable.

**Q: (Senior) Compare the audit log and the full query log. When would you enable each?**
A: The audit log is a compliance instrument: categorized, filterable, small when filtered to DCL/DDL/AUTH, and designed to run permanently so you can answer "who changed this role" or "who read the PHI keyspace". The full query log is a diagnostic and load-capture instrument: it records every query with bind values and is enormous, so you enable it via `nodetool enablefullquerylog` for a bounded window. FQL's killer feature is `fqltool replay`, which lets you replay real production traffic against a staging cluster to validate an upgrade or a schema change, and `fqltool compare` to diff results between two clusters.

**Q: (Senior) How do you migrate an existing unencrypted cluster to encrypted volumes with no downtime?**
A: You cannot encrypt a volume in place, so it becomes a node replacement exercise. Provision a new node with a LUKS-backed or KMS-encrypted data volume, start it with `-Dcassandra.replace_address_first_boot=<old_ip>` so it streams the dead node's ranges rather than bootstrapping a new token set, wait for `nodetool netstats` to finish and `nodetool status` to show UN, then repeat for the next node. Do one node at a time, never more than one per rack simultaneously, and keep an eye on cluster headroom because each replacement is a full data stream. Budget roughly an hour per terabyte per node and schedule the whole campaign over days, not hours.

**Q: Why must audit logs be shipped off the node quickly?**
A: An attacker who compromises a node with root privileges can delete or edit local audit files, destroying the evidence of their own activity. Shipping rolled Chronicle files promptly to an append-only destination — an object store with object lock, or a SIEM in a different trust boundary — preserves the trail. It also keeps `audit_logs_dir` from filling, which with `block: true` would turn into write latency.

**Q: What is `internode_encryption: dc` for?**
A: It encrypts only traffic that crosses datacenter boundaries, leaving intra-DC traffic in plaintext. That is the right trade-off when nodes within a datacenter sit on a trusted private network but cross-DC replication traverses the public internet or a shared backbone, since cross-DC traffic is a small fraction of total volume and you avoid paying TLS CPU on the hot intra-DC path. In shared cloud VPCs or zero-trust environments, use `all` instead.

**Q: What breaks if you set `block: false` on the audit log?**
A: Under back-pressure — a queue-full condition caused by a burst of auditable events or slow disk — records are silently dropped and only a counter increments. Latency stays flat, which is why it is tempting, but the audit trail acquires undetectable holes. For any regulated workload use `block: true`, provision a fast dedicated volume, and size `max_queue_weight` so bursts absorb rather than block.
## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra encrypts the wire, not the disk. `client_encryption_options` secures port 9042; `server_encryption_options` with `internode_encryption: none|all|dc|rack` secures internode traffic on 7001. Roll out with the ladder — `optional: true`, rolling restart, migrate peers/clients, `optional: false`, rolling restart — never in one step, or gossip splits. Use a private CA, per-node keystores with SANs covering hostname and IP, one shared truststore holding the CA, and turn on `require_endpoint_verification`. Prefer GCM cipher suites and install netty-tcnative; expect 3–8% CPU. Cassandra 4.0+ hot-reloads keystores on mtime change, so certificate rotation needs no restart. At rest is the kernel's job: LUKS or encrypted cloud volumes, covering data, commitlog, hints, and snapshots. Auditing is 4.0's `audit_logging_options` writing a Chronicle binary log — filter to `DCL,DDL,AUTH` plus `DML` on sensitive keyspaces, put it on a dedicated volume, keep `block: true`, and archive off-node.

| Item | Value / Command |
|---|---|
| CQL TLS port | 9042 (same port; TLS negotiated) |
| Internode TLS port | 7001 (`ssl_storage_port`) |
| Internode modes | `none`, `all`, `dc`, `rack` |
| Safe rollout | `optional: true` → migrate → `optional: false` |
| Peer identity check | `require_endpoint_verification: true` |
| Mutual TLS | `require_client_auth: true` + truststore |
| Preferred suites | `TLS_ECDHE_*_AES_128_GCM_SHA256`, TLS 1.2/1.3 only |
| Cert rotation (4.0+) | Overwrite keystore file; hot reload on mtime |
| At rest | LUKS / dm-crypt / encrypted cloud volume (not Cassandra) |
| Enable audit | `nodetool enableauditlog --included-categories DCL,DDL,AUTH` |
| Read audit | `auditlogviewer /var/log/cassandra/audit` |
| Enable FQL | `nodetool enablefullquerylog --path /var/log/cassandra/fql` |
| Replay FQL | `fqltool replay --target <host> --keyspace ks <path>` |
| Verify TLS live | `openssl s_client -connect host:9042 -CAfile ca-cert.pem` |

**Flash cards**

- **Does Cassandra do TDE?** → No. Open-source relies on LUKS/encrypted volumes; DSE has native TDE.
- **Safe TLS rollout** → `optional: true` → migrate → `optional: false`, two rolling restarts.
- **Certificate identity check** → `require_endpoint_verification: true` validates SAN, not just CA signature.
- **Cheap audit filter** → `DCL,DDL,AUTH` always; `DML` only on sensitive keyspaces.
- **Audit vs FQL** → Audit = compliance, always on, filtered. FQL = replay/debug, bounded window, huge.
## 11. Hands-On Exercises & Mini Project

- [ ] Build a private CA and node keystores with `keytool`/`openssl` as in section 5.1, then enable `client_encryption_options` with `optional: true` on a 3-node `ccm` cluster and confirm both `cqlsh` and `cqlsh --ssl` work.
- [ ] Flip to `optional: false` and `require_client_auth: true`, then prove that a client without a certificate is rejected. Capture the exact exception from the Python driver.
- [ ] Perform the internode ladder: `none` → `all` + `optional: true` → `all`. Between stages, run `nodetool status` and `nodetool gossipinfo` to verify no node was ever isolated.
- [ ] Enable the audit log with `included_categories: DCL,DDL,AUTH`, create and grant a role, then decode the log with `auditlogviewer` and identify the source IP and role in the record.
- [ ] Enable full query logging for five minutes while running `cassandra-stress`, then `fqltool dump` the output and measure bytes written per query. Extrapolate the daily volume for your production QPS.
- [ ] Test hot reload: with TLS enabled, regenerate the node certificate, overwrite the keystore file in place, and verify with `openssl s_client` that the new `notAfter` is served without restarting Cassandra.

### Mini Project — "Compliance-Ready Cassandra"

**Goal.** Take a plaintext, unaudited cluster to a state that would pass a HIPAA or PCI review, with automated evidence.

**Requirements.**
1. A CA and certificate issuance pipeline (script or step-ca/Vault PKI) that issues per-node certs with correct SANs and outputs keystore/truststore pairs, plus a rotation command.
2. Automated execution of the TLS ladder for both client and internode encryption, with a health gate between stages that fails if any node is down or gossip is unstable.
3. An at-rest layer: provision node data volumes with LUKS keyed from a KMS, and script the `replace_address_first_boot` migration to move an existing node's data onto an encrypted volume.
4. Audit logging enabled with a documented filter, `audit_logs_dir` on a dedicated volume, and an `archive_command` shipping rolled files to an object-lock-enabled bucket.
5. An evidence report generator that outputs, per node: negotiated TLS version and cipher, certificate subject and expiry, `internode_encryption` mode, whether the data volume is encrypted, and the audit categories in force.

**Extensions.**
- Add certificate expiry monitoring with alerting at 60/30/7 days, and prove hot reload works by rotating in staging under load.
- Add an FQL-based upgrade validation step: capture 15 minutes of production traffic, `fqltool replay` it against a staging cluster running the new version, and `fqltool compare` the results.
- Extend the evidence report into a scheduled job that diffs against the previous run and opens a ticket on any drift, so compliance posture is monitored rather than audited once a year.
## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Authentication, Authorization & RBAC* — the prerequisite identity layer; TLS without auth and auth without TLS are both incomplete. *Cassandra 4.x & 5.x New Features* — audit log, full query log, and virtual tables all arrived in 4.0, and 5.0 adds dynamic data masking. *Multi-Datacenter Deployment* — where `internode_encryption: dc` earns its keep. *Backup & Restore* — encrypting snapshot destinations. *Monitoring & Observability* — certificate expiry and audit-lag alerting. *Drivers & Application Development* — configuring SSL contexts and session reuse.

- **Apache Cassandra — Security: TLS/SSL Encryption** — Apache Software Foundation · *Intermediate* · Definitive reference for `client_encryption_options` and `server_encryption_options`, including optional mode and endpoint verification. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/security.html>
- **Apache Cassandra — Audit Logging** — Apache Software Foundation · *Intermediate* · The full `audit_logging_options` reference, category list, and `auditlogviewer` usage. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/audit_logging.html>
- **Apache Cassandra — Full Query Logging** — Apache Software Foundation · *Advanced* · How FQL, `fqltool dump`, `fqltool replay`, and `fqltool compare` work, with replay-based testing guidance. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/fqltool.html>
- **CASSANDRA-12151: Audit logging for database activity** — Apache JIRA · *Advanced* · The design thread explaining the Chronicle Queue choice and the filtering model. <https://issues.apache.org/jira/browse/CASSANDRA-12151>
- **CASSANDRA-14222: SSL certificate hot reloading** — Apache JIRA · *Advanced* · Why 4.0 can rotate certificates without a restart, and the exact reload semantics. <https://issues.apache.org/jira/browse/CASSANDRA-14222>
- **The Last Pickle — "Hardening Cassandra Step by Step: Server to Server"** — The Last Pickle · *Intermediate* · Practical internode TLS walkthrough with keystore generation and the migration ordering. <https://thelastpickle.com/blog/2015/09/30/hardening-cassandra-step-by-step-part-1-server-to-server.html>
- **DataStax — Transparent Data Encryption** — DataStax Docs · *Advanced* · Read to understand what native TDE offers and therefore what open-source Cassandra is asking your OS to do instead. <https://docs.datastax.com/en/dse/6.8/securing/transparent-data-encryption.html>
- **Apache Cassandra Blog — "Audit Logging in Apache Cassandra 4.0"** — Apache Cassandra project · *Intermediate* · Practitioner-oriented introduction with realistic filter configurations and overhead measurements. <https://cassandra.apache.org/_/blog/Apache-Cassandra-4.0-Overview.html>

---

*Apache Cassandra Handbook — chapter 39.*
