# 29 · Security & Multi-Tenancy: TLS, SASL & ACLs

> **In one line:** Broker security is three separable pillars — encryption (TLS, so no one can read the traffic), authentication (SASL or mTLS, so the broker knows *who* is connecting), and authorization (ACLs and permissions, so it knows *what* they may do) — and multi-tenancy is those three plus per-tenant quotas, applied so that one tenant can neither read another's data nor starve them of throughput.

---

## 1. Overview

For most of their history, both Kafka and RabbitMQ shipped *insecure by default*: an open port, no authentication, no encryption, and — on Kafka — no authorization, so anyone who could reach the broker could read every topic, write to any topic, and delete data. That default has caused real breaches, because a broker is a firehose of exactly the data attackers want: orders, payments, personal data, internal events. The single most important security principle in this chapter is therefore also the simplest: **never expose a broker on an unauthenticated, unencrypted network**, and never assume "it's on the internal network" is protection — internal networks are exactly where lateral movement happens.

Securing a broker means composing three independent pillars, and it is worth keeping them mentally separate because they solve different problems and can each be got wrong on its own. **Encryption** (TLS) protects data *in transit* — it stops a network eavesdropper reading messages, but it says nothing about who is allowed to connect. **Authentication** (SASL mechanisms or mutual TLS) establishes *identity* — the broker learns that this connection is `orders-service` and not an impostor, but authentication alone does not limit what that identity may do. **Authorization** (Kafka ACLs, RabbitMQ permissions) constrains *action* — this authenticated principal may read topic X and write topic Y but touch nothing else. You need all three: TLS without authentication lets anyone connect over an encrypted channel; authentication without authorization lets any valid user do anything; authorization without authentication is meaningless because identity can be forged.

The fourth concern, **multi-tenancy**, is what you build on top when many teams or customers share one cluster. Isolation has two dimensions: *data isolation* (tenant A cannot read or write tenant B's topics/queues, enforced by naming conventions plus ACLs/permissions) and *resource isolation* (tenant A cannot starve tenant B of throughput, enforced by per-tenant quotas). A shared cluster without quotas is a shared cluster where the noisiest tenant degrades everyone.

This chapter covers each pillar concretely for both systems — SASL mechanisms, ACL grammar, RabbitMQ's vhost/permission model — the historical insecure-default trap and a hardening checklist, the specific performance cost that TLS imposes (it defeats Kafka's zero-copy read path), and multi-tenancy with quotas. Section 5 has real config and a secured Go client.

## 2. Core Concepts

- **TLS (Transport Layer Security)** — encrypts a connection so a network eavesdropper cannot read or tamper with messages in transit. Applies to client-broker *and* inter-broker (Kafka) / inter-node (RabbitMQ) links.
- **mTLS (mutual TLS)** — both sides present certificates; the client's certificate also *authenticates* it, so TLS doubles as authentication.
- **SASL (Simple Authentication and Security Layer)** — a framework for pluggable authentication mechanisms over a connection. Kafka supports several.
- **SASL/PLAIN** — username+password sent over the connection; only safe *over TLS* (otherwise the password is in the clear).
- **SASL/SCRAM** — salted challenge-response; the password is never sent in the clear and credentials are stored hashed. The sane default for username/password auth.
- **SASL/GSSAPI (Kerberos)** — enterprise single-sign-on via Kerberos tickets; common where an organisation already runs Active Directory / Kerberos.
- **SASL/OAUTHBEARER** — authentication via OAuth 2.0 bearer tokens from an identity provider; fits modern token-based infrastructures.
- **ACL (Access Control List) — Kafka** — a rule granting or denying a *principal* an *operation* (read/write/create/describe/delete/alter) on a *resource* (topic/group/cluster/transactional-id), evaluated by the broker's authorizer.
- **Authorizer (Kafka)** — the pluggable component that evaluates ACLs; `StandardAuthorizer` (KRaft) or the older ACL authorizer.
- **Permissions (RabbitMQ)** — three regexes per user per vhost — `configure`, `write`, `read` — matched against resource names to allow declaring, publishing to, and consuming from them.
- **Virtual host (vhost)** — RabbitMQ's isolation boundary: a namespace of exchanges, queues and bindings; permissions are granted per-vhost, making it the natural per-tenant unit.
- **Quota** — a cap on a client's resource use: Kafka *client quotas* limit produce/fetch byte-rate and request rate per principal/client-id; RabbitMQ policies and per-vhost limits cap connections, queues, and message rates.
- **Principal** — the authenticated identity a rule is written against (`User:orders-service`, a certificate DN, a Kerberos principal).
- **Least privilege** — granting each principal only the exact operations on the exact resources it needs, and nothing more.

## 3. Theory & Principles

### The three pillars are orthogonal, and you need all three

The clearest way to reason about broker security is to hold the three pillars apart, because each answers a different question and each is independently sufficient to sink you if omitted. Encryption answers "can someone on the wire read this?" — no, if TLS is on. Authentication answers "who is this connection?" — a named principal, if SASL/mTLS is on. Authorization answers "what may this principal do?" — only what the ACLs allow. The failure modes map one-to-one: skip encryption and an eavesdropper reads your payments off the network; skip authentication and anyone who can reach the port acts as a trusted client; skip authorization and any authenticated client (including a compromised low-privilege one) can read and destroy everything. A "secure" broker is one where all three questions have a satisfactory answer, and a checklist that ticks TLS but leaves authorization off (a distressingly common state) is not secure — it is an encrypted free-for-all.

### TLS has a real, physical cost on Kafka

Security is not free, and the honest version of this chapter names the cost. On Kafka specifically, TLS **defeats the zero-copy read path**. Normally Kafka serves consumer fetches with the `sendfile` system call, which pushes log bytes straight from the OS page cache to the network socket without ever copying them into user space — a major source of Kafka's throughput. TLS requires the bytes to be *encrypted*, which cannot happen inside the kernel's zero-copy path, so every byte served to a consumer now takes a detour through user space to be encrypted. The measured effect is commonly a 20-40% drop in read throughput and a corresponding rise in CPU. This does not mean "don't use TLS" — you almost always should — it means the cost is real, you must budget for it in capacity planning (chapter 28), you should ensure AES-NI hardware acceleration is enabled, and in some threat models teams keep inter-broker traffic on a trusted network to limit TLS to client-facing links. The principle: security trades throughput, and pretending otherwise leads to under-provisioned clusters.

### Multi-tenancy is isolation in two dimensions

A shared cluster is cheaper than a cluster per tenant, but "shared" must not mean "leaky". True isolation has two independent dimensions. **Data isolation** ensures tenant A cannot read or write tenant B's data — achieved by a naming convention (topics/queues prefixed with the tenant, `tenantA.orders`) plus authorization rules that grant each tenant access only to its own prefix. **Resource isolation** ensures tenant A cannot consume so much throughput that tenant B starves — achieved by quotas that cap each tenant's produce/fetch rate. The two are orthogonal: you can have perfect data isolation and still let one tenant's runaway producer saturate the brokers and inflate everyone's latency (the "noisy neighbour" problem), which is why data-isolation ACLs without resource quotas is only half a multi-tenant design.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="c1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three pillars, in order, on every connection</text>

  <rect x="30" y="44" width="200" height="150" rx="10" fill="#cffafe" stroke="#0891b2" stroke-width="2"/>
  <text x="130" y="68" text-anchor="middle" fill="#155e75" font-size="12" font-weight="bold">1. ENCRYPTION</text>
  <text x="130" y="88" text-anchor="middle" fill="#0e7490" font-size="10" font-weight="bold">TLS</text>
  <text x="46" y="110" fill="#155e75" font-size="9">answers: can the wire</text>
  <text x="46" y="124" fill="#155e75" font-size="9">be read? &#8594; No.</text>
  <text x="46" y="146" fill="#b91c1c" font-size="9">skip it &#8594; eavesdropper reads</text>
  <text x="46" y="160" fill="#b91c1c" font-size="9">your payments off the net</text>
  <text x="46" y="182" fill="#0e7490" font-size="8">cost: defeats Kafka zero-copy</text>

  <rect x="250" y="44" width="200" height="150" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="350" y="68" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">2. AUTHENTICATION</text>
  <text x="350" y="88" text-anchor="middle" fill="#1d4ed8" font-size="9">SASL / mTLS</text>
  <text x="266" y="110" fill="#1e40af" font-size="9">answers: WHO is this</text>
  <text x="266" y="124" fill="#1e40af" font-size="9">connection? &#8594; a principal</text>
  <text x="266" y="146" fill="#b91c1c" font-size="9">skip it &#8594; anyone reaching</text>
  <text x="266" y="160" fill="#b91c1c" font-size="9">the port is a trusted client</text>
  <text x="266" y="182" fill="#1d4ed8" font-size="8">PLAIN/SCRAM/Kerberos/OAuth</text>

  <rect x="470" y="44" width="200" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="570" y="68" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">3. AUTHORIZATION</text>
  <text x="570" y="88" text-anchor="middle" fill="#6d28d9" font-size="9">ACLs / permissions</text>
  <text x="486" y="110" fill="#5b21b6" font-size="9">answers: WHAT may this</text>
  <text x="486" y="124" fill="#5b21b6" font-size="9">principal do? &#8594; only X</text>
  <text x="486" y="146" fill="#b91c1c" font-size="9">skip it &#8594; any valid user</text>
  <text x="486" y="160" fill="#b91c1c" font-size="9">reads &amp; destroys everything</text>
  <text x="486" y="182" fill="#6d28d9" font-size="8">principal + op + resource</text>

  <rect x="690" y="44" width="160" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="770" y="68" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">+ QUOTAS</text>
  <text x="706" y="90" fill="#92400e" font-size="9">for multi-tenancy:</text>
  <text x="706" y="108" fill="#b45309" font-size="9">cap produce/fetch</text>
  <text x="706" y="122" fill="#b45309" font-size="9">rate per tenant</text>
  <text x="706" y="144" fill="#b91c1c" font-size="9">skip it &#8594; noisy</text>
  <text x="706" y="158" fill="#b91c1c" font-size="9">neighbour starves</text>
  <text x="706" y="172" fill="#b91c1c" font-size="9">everyone else</text>

  <path d="M230,119 L248,119" stroke="#4f46e5" stroke-width="2" marker-end="url(#c1)"/>
  <path d="M450,119 L468,119" stroke="#4f46e5" stroke-width="2" marker-end="url(#c1)"/>
  <path d="M670,119 L688,119" stroke="#4f46e5" stroke-width="2" marker-end="url(#c1)"/>

  <rect x="30" y="212" width="820" height="110" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="234" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The insecure-by-default trap</text>
  <text x="52" y="258" fill="#991b1b" font-size="10">Both brokers historically shipped: open port, no auth, no TLS, and (Kafka) no authorization &#8594; anyone reaching the port reads/writes/deletes ALL data.</text>
  <text x="52" y="278" fill="#991b1b" font-size="10">"It's on the internal network" is NOT protection &#8212; internal networks are exactly where lateral movement happens. Real breaches have resulted.</text>
  <text x="52" y="302" fill="#7f1d1d" font-size="10" font-weight="bold">Rule #1: never expose a broker unauthenticated or unencrypted, internal or not.</text>

  <rect x="30" y="336" width="820" height="118" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="358" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Multi-tenancy = isolation in TWO dimensions</text>
  <rect x="52" y="372" width="380" height="70" rx="8" fill="#fff" stroke="#86efac"/>
  <text x="242" y="392" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Data isolation</text>
  <text x="66" y="412" fill="#166534" font-size="9">tenant prefix (tenantA.orders) + ACLs</text>
  <text x="66" y="428" fill="#166534" font-size="9">&#8594; A cannot read/write B's data</text>
  <rect x="448" y="372" width="380" height="70" rx="8" fill="#fff" stroke="#86efac"/>
  <text x="638" y="392" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Resource isolation</text>
  <text x="462" y="412" fill="#166534" font-size="9">per-tenant quotas cap produce/fetch rate</text>
  <text x="462" y="428" fill="#166534" font-size="9">&#8594; A cannot STARVE B (noisy neighbour)</text>
</svg>
```

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="se1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three pillars, in order: encrypt &#8594; authenticate &#8594; authorize</text>

  <rect x="30" y="46" width="120" height="50" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="90" y="70" text-anchor="middle" fill="#1e40af" font-weight="bold">client</text>
  <text x="90" y="86" text-anchor="middle" fill="#1d4ed8" font-size="9">producer/consumer</text>
  <path d="M152,71 L206,71" stroke="#4f46e5" stroke-width="2" marker-end="url(#se1)"/>

  <rect x="210" y="46" width="140" height="50" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="280" y="66" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">1. TLS</text>
  <text x="280" y="82" text-anchor="middle" fill="#166534" font-size="9">encrypt the wire</text>
  <path d="M352,71 L406,71" stroke="#4f46e5" stroke-width="2" marker-end="url(#se1)"/>

  <rect x="410" y="46" width="140" height="50" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="480" y="66" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">2. SASL / mTLS</text>
  <text x="480" y="82" text-anchor="middle" fill="#b45309" font-size="9">who are you?</text>
  <path d="M552,71 L606,71" stroke="#4f46e5" stroke-width="2" marker-end="url(#se1)"/>

  <rect x="610" y="46" width="140" height="50" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="680" y="66" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">3. ACLs</text>
  <text x="680" y="82" text-anchor="middle" fill="#6d28d9" font-size="9">may you do it?</text>
  <path d="M752,71 L806,71" stroke="#4f46e5" stroke-width="2" marker-end="url(#se1)"/>
  <rect x="810" y="46" width="46" height="50" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="833" y="76" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">broker</text>

  <rect x="30" y="118" width="266" height="130" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="163" y="140" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Encryption (TLS)</text>
  <text x="46" y="162" fill="#1d4ed8" font-size="9">client&#8211;broker AND inter-broker traffic</text>
  <text x="46" y="180" fill="#1d4ed8" font-size="9">Kafka: SSL listener &#183; RabbitMQ: TLS listener</text>
  <text x="46" y="202" fill="#b91c1c" font-size="9" font-weight="bold">Cost: TLS defeats Kafka's zero-copy on</text>
  <text x="46" y="216" fill="#991b1b" font-size="9">the read path &#8212; a real throughput hit (ch18)</text>
  <text x="46" y="238" fill="#1e40af" font-size="9">Encrypts, but proves NOTHING about identity.</text>

  <rect x="306" y="118" width="266" height="130" rx="8" fill="#fefce8" stroke="#d97706" stroke-width="2"/>
  <text x="439" y="140" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Authentication</text>
  <text x="322" y="162" fill="#b45309" font-size="9">Kafka SASL: PLAIN, SCRAM, GSSAPI,</text>
  <text x="322" y="176" fill="#b45309" font-size="9">OAUTHBEARER &#183; or mTLS (client cert)</text>
  <text x="322" y="196" fill="#b45309" font-size="9">RabbitMQ: user/pass, x509, SASL</text>
  <text x="322" y="218" fill="#92400e" font-size="9" font-weight="bold">Establishes the PRINCIPAL &#8212; the identity</text>
  <text x="322" y="232" fill="#b45309" font-size="9">the next pillar authorizes against.</text>

  <rect x="582" y="118" width="274" height="130" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="2"/>
  <text x="719" y="140" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Authorization (ACLs)</text>
  <text x="598" y="162" fill="#6d28d9" font-size="9">Kafka: principal + operation (read/write/</text>
  <text x="598" y="176" fill="#6d28d9" font-size="9">create) + resource (topic/group/cluster)</text>
  <text x="598" y="196" fill="#6d28d9" font-size="9">RabbitMQ: configure/write/read regex</text>
  <text x="598" y="210" fill="#6d28d9" font-size="9">per user per vhost</text>
  <text x="598" y="232" fill="#5b21b6" font-size="9" font-weight="bold">Least privilege: a principal per service.</text>

  <rect x="30" y="266" width="826" height="118" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="443" y="288" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The insecure-by-default trap &#8594; a hardening checklist</text>
  <text x="46" y="312" fill="#991b1b" font-size="10">&#8226; NEVER expose a broker port to an untrusted network without authentication &#8212; an open Kafka/RabbitMQ is a data breach</text>
  <text x="46" y="330" fill="#991b1b" font-size="10">&#8226; TLS everywhere (client and inter-broker) &#183; a distinct principal per service &#183; least-privilege ACLs, deny by default</text>
  <text x="46" y="348" fill="#991b1b" font-size="10">&#8226; disable auto-topic-create &#183; per-tenant quotas to cap produce/fetch rate &#183; isolate tenants by topic/vhost naming + ACLs</text>
  <text x="46" y="370" fill="#7f1d1d" font-size="10" font-weight="bold">Encryption without authentication is theatre; authentication without authorization lets any valid client read everything.</text>
</svg>
```

The security handshake follows the same logical order on both brokers: a connection is established and encrypted (TLS), the client authenticates (SASL/mTLS), and thereafter every operation is authorized (ACLs/permissions). What differs is the vocabulary and the isolation unit.

**Kafka.** Listeners are configured per protocol: `SASL_SSL` (SASL auth over TLS) is the standard secure listener; `SSL` alone gives mTLS auth; `PLAINTEXT` is the insecure default you disable. On connect, the client completes the TLS handshake, then the SASL exchange (SCRAM challenge-response, a Kerberos ticket, an OAuth token, or PLAIN credentials). The broker maps the authenticated identity to a **principal** (`User:orders-service` or the certificate DN). From then on, every produce, fetch, offset-commit, and admin call is checked against the ACLs by the authorizer. Crucially, once you enable an authorizer you should set `allow.everyone.if.no.acl.found=false` — otherwise resources with no ACL are open to all, which quietly re-creates the insecure default. Inter-broker traffic is secured separately (its own listener and credentials).

**RabbitMQ.** A client opens a TLS connection, authenticates (username/password via SASL PLAIN over TLS, or x509 certificate), and selects a **vhost**. Every operation — declaring an exchange/queue (`configure`), publishing (`write`), consuming (`read`) — is checked against the user's three permission regexes *for that vhost*. The vhost is the isolation boundary: a user with permissions on `/tenant-a` and none on `/tenant-b` simply cannot see tenant B's topology. Resource limits and message-rate policies attach per-vhost, making the vhost the natural per-tenant unit.

The workflow discipline is **least privilege from the start**: create a distinct principal per service, grant it exactly the operations on exactly the resources it needs (a producer gets `write` on its topics, a consumer gets `read` on its topics plus its consumer group, nobody gets cluster-wide admin unless they are admin), and add the deny-by-default posture so a missing rule means "no", not "yes".

## 5. Implementation

Real config for both brokers, ACL/permission commands, SCRAM setup, quotas, and a fully secured Go client.

### Kafka: secure listener + SCRAM (server.properties)

```properties
# server.properties — a secured Kafka broker.
# Listeners: expose ONLY the secure listener to clients; keep inter-broker on
# its own. No PLAINTEXT client listener — that is the insecure default we remove.
listeners=SASL_SSL://0.0.0.0:9093,CONTROLLER://0.0.0.0:9094
advertised.listeners=SASL_SSL://kafka1.internal:9093
inter.broker.listener.name=SASL_SSL

# TLS: the broker's keystore (its cert/key) and the truststore (CAs it trusts).
ssl.keystore.location=/etc/kafka/ssl/kafka.keystore.jks
ssl.keystore.password=${KEYSTORE_PW}
ssl.truststore.location=/etc/kafka/ssl/kafka.truststore.jks
ssl.truststore.password=${TRUSTSTORE_PW}
# Require clients to present a cert too (mTLS) if you want cert-based auth as well.
ssl.client.auth=required

# SASL: enable SCRAM (salted challenge-response; password never sent in clear).
sasl.enabled.mechanisms=SCRAM-SHA-512
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512

# AUTHORIZATION: turn on the authorizer and DENY BY DEFAULT. Without the second
# line, any resource lacking an ACL is world-open — the insecure default reborn.
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
allow.everyone.if.no.acl.found=false
# Bootstrap superusers who may administer ACLs themselves.
super.users=User:admin
```

```bash
# Create a SCRAM credential for a service principal (stored hashed in Kafka).
kafka-configs.sh --bootstrap-server kafka1:9093 --command-config admin.properties \
  --alter --add-config 'SCRAM-SHA-512=[password=s3cr3t]' \
  --entity-type users --entity-name orders-service

# LEAST-PRIVILEGE ACLs: the producer may WRITE only its topics.
kafka-acls.sh --bootstrap-server kafka1:9093 --command-config admin.properties \
  --add --allow-principal User:orders-service \
  --operation Write --operation Describe \
  --topic orders --resource-pattern-type prefixed

# The consumer may READ its topics AND its consumer group (both are needed —
# forgetting the group ACL is the classic "why can't my consumer join?" bug).
kafka-acls.sh --bootstrap-server kafka1:9093 --command-config admin.properties \
  --add --allow-principal User:fulfilment-service \
  --operation Read --operation Describe \
  --topic orders --resource-pattern-type prefixed
kafka-acls.sh --bootstrap-server kafka1:9093 --command-config admin.properties \
  --add --allow-principal User:fulfilment-service \
  --operation Read --group fulfilment-group

# PER-TENANT QUOTA: cap this principal to 10 MB/s produce and 10 MB/s fetch so a
# runaway tenant cannot saturate the brokers and starve others.
kafka-configs.sh --bootstrap-server kafka1:9093 --command-config admin.properties \
  --alter --add-config 'producer_byte_rate=10485760,consumer_byte_rate=10485760' \
  --entity-type users --entity-name tenant-a
```

### RabbitMQ: TLS, users, vhosts, permissions (rabbitmq.conf + rabbitmqctl)

```ini
# rabbitmq.conf — TLS listener and hardening.
# Disable the plaintext AMQP port entirely; only TLS on 5671.
listeners.tcp = none
listeners.ssl.default = 5671
ssl_options.cacertfile = /etc/rabbitmq/ssl/ca.pem
ssl_options.certfile   = /etc/rabbitmq/ssl/server.pem
ssl_options.keyfile    = /etc/rabbitmq/ssl/server.key
# Require and verify client certificates (mTLS) in addition to password auth.
ssl_options.verify = verify_peer
ssl_options.fail_if_no_peer_cert = true
# Do NOT allow the default guest user to connect over the network (it is
# localhost-only by default; make that explicit and delete guest in production).
loopback_users.guest = true
```

```bash
# Per-tenant vhost is the isolation boundary.
rabbitmqctl add_vhost tenant-a
rabbitmqctl add_user orders-a 's3cr3t'
rabbitmqctl delete_user guest   # remove the notorious default account

# LEAST-PRIVILEGE permissions: three regexes = configure / write / read, scoped
# to this vhost. Here the producer may only WRITE to orders.* and configure
# nothing; it cannot read, and it cannot touch tenant-b (no perms there at all).
#                                    <conf>   <write>       <read>
rabbitmqctl set_permissions -p tenant-a orders-a "^$" "^orders\..*" "^$"

# A consumer in the same vhost: read only, from its own queues.
rabbitmqctl add_user fulfilment-a 's3cr3t2'
rabbitmqctl set_permissions -p tenant-a fulfilment-a "^$" "^$" "^orders\..*"

# Resource isolation: cap the vhost's connections and per-queue length so one
# tenant cannot exhaust broker resources.
rabbitmqctl set_vhost_limits -p tenant-a '{"max-connections": 200, "max-queues": 100}'
```

### A fully secured Go client (Kafka, SASL_SSL + SCRAM)

```go
package secure

import (
	"crypto/tls"
	"crypto/x509"
	"os"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl/scram"
)

// SecureWriter builds a Kafka producer that speaks SASL_SSL: TLS for encryption
// AND SCRAM for authentication. Nothing here trusts the network — the identity
// is proven by SCRAM and the channel is encrypted by TLS. The broker's ACLs
// then decide what this principal may write.
func SecureWriter(brokers []string, topic, user, pass, caPath string) (*kafka.Writer, error) {
	// SCRAM-SHA-512: a salted challenge-response. The password is never sent in
	// the clear; the broker stored only a hash. This is the sane default over
	// SASL/PLAIN, which would transmit the password (safe only because TLS wraps
	// it, but SCRAM is safer still).
	mechanism, err := scram.Mechanism(scram.SHA512, user, pass)
	if err != nil {
		return nil, err
	}

	// TLS: trust ONLY our private CA, and verify the broker's certificate. Never
	// set InsecureSkipVerify=true in production — it disables the check that the
	// broker is who it claims, defeating the point of TLS.
	caCert, err := os.ReadFile(caPath)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caCert)
	tlsConfig := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}

	return &kafka.Writer{
		Addr:  kafka.TCP(brokers...),
		Topic: topic,
		// The transport carries both the TLS config and the SASL mechanism.
		Transport: &kafka.Transport{
			TLS:  tlsConfig,
			SASL: mechanism,
		},
		RequiredAcks: kafka.RequireAll, // durability, unaffected by security
	}, nil
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of proper broker security**
- **Confidentiality.** TLS ensures messages — often payments, PII, internal events — cannot be read off the network by an eavesdropper.
- **Accountability.** Authentication gives every action a named principal, so audit logs answer "who did this?" and a compromised credential can be revoked precisely.
- **Least-privilege blast radius.** Fine-grained ACLs mean a compromised low-privilege service cannot read or destroy data it never needed, containing the breach.
- **Safe multi-tenancy.** Data isolation plus quotas let many teams share one cluster without reading each other's data or starving each other, saving the cost of a cluster per tenant.

**Disadvantages / costs**
- **Throughput cost.** TLS defeats Kafka's zero-copy read path (commonly 20-40% less read throughput) and adds CPU; security is not free.
- **Operational complexity.** Certificates expire (and an expired broker cert is an outage), SCRAM credentials rotate, ACLs proliferate; a whole lifecycle now needs managing.
- **Misconfiguration risk.** Getting it subtly wrong — `allow.everyone.if.no.acl.found=true`, `InsecureSkipVerify`, a forgotten consumer-group ACL — produces a false sense of security or a broken client.
- **Latency of Kerberos/OAuth.** Token/ticket acquisition and renewal add moving parts and occasional auth-refresh latency.

**Trade-offs**
- *Security vs throughput:* TLS everywhere is the safe default but costs Kafka read throughput; some teams keep inter-broker traffic on a trusted network to limit TLS to client links, trading a smaller attack surface reduction for performance.
- *SASL/PLAIN vs SCRAM vs Kerberos vs OAuth:* PLAIN is simplest but only safe over TLS; SCRAM adds hashed storage and challenge-response; Kerberos integrates enterprise SSO at the cost of infrastructure; OAuth fits token-based systems but needs an identity provider. Choose for your existing identity infrastructure.
- *Fine-grained vs coarse ACLs:* per-resource least privilege is the most secure but the most rules to manage; prefix-based ACLs (`tenantA.*`) trade a little precision for far less administration.
- *Vhost-per-tenant vs prefix-per-tenant:* RabbitMQ vhosts give hard isolation but more topology to manage; a shared vhost with name prefixes is lighter but leans entirely on permission regexes being correct.

## 7. Common Mistakes & Best Practices

- **Leaving the broker unauthenticated because "it's internal".** Internal networks are where lateral movement happens; an unauthenticated broker is one compromised host away from total data exposure. Authenticate always.
- **Enabling the authorizer but leaving `allow.everyone.if.no.acl.found=true`.** This re-creates the insecure default: any resource without an explicit ACL is world-open. Set it to `false` — deny by default.
- **`InsecureSkipVerify=true` / not verifying the broker cert.** This disables the check that you are talking to the real broker, so TLS no longer protects against a man-in-the-middle. Always verify against your CA.
- **Forgetting the consumer-group ACL.** A consumer needs `Read` on the topic *and* `Read` on its consumer group; granting only the topic ACL produces a baffling "cannot join group" failure.
- **Using SASL/PLAIN without TLS.** PLAIN sends the password over the connection; without TLS it is in the clear. PLAIN is only acceptable wrapped in TLS — and SCRAM is safer regardless.
- **Leaving auto-topic-creation on in a secured cluster.** `auto.create.topics.enable=true` lets any client with write access spawn arbitrary topics; disable it so topics are provisioned deliberately with the right ACLs.
- **Not rotating credentials or monitoring cert expiry.** An expired broker certificate is a full outage; unrotated long-lived credentials are a standing risk. Automate rotation and alert on expiry.
- **Data isolation without quotas.** Perfect ACL isolation still lets one tenant saturate the brokers and inflate everyone's latency; multi-tenancy needs resource quotas as well as data ACLs.
- **Best practice: deny by default, least privilege per principal, TLS everywhere, and a hardening checklist run before any broker faces traffic.** Distinct principal per service, exact ACLs, no plaintext listener, no default accounts, auto-create off, quotas per tenant.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Security failures are notoriously opaque because brokers deliberately give little detail to unauthenticated clients (revealing why auth failed helps attackers). The systematic approach: isolate which pillar failed. A TLS handshake error (cert expired, wrong CA, hostname mismatch) fails before auth; a SASL failure means TLS worked but credentials/mechanism are wrong; an *authorization* failure means auth worked but an ACL is missing — the tell is that the client connects and authenticates fine but a specific operation is denied. Broker logs distinguish these; the classic red herring is a missing consumer-group ACL presenting as a mysterious rebalance/join failure.
- **Monitoring.** Beyond the metrics of chapter 27, security adds: authentication-failure rate (a spike is a brute-force attempt or a broken deploy), authorization-denial rate (a spike is a misconfigured client or an intrusion attempt), and certificate expiry countdowns (alert weeks ahead — an expired broker cert is an outage). Lock down the metrics and JMX endpoints themselves; they leak topology useful for reconnaissance.
- **Security.** This is the security chapter, but the operational meta-point is that security is a *lifecycle*, not a config: certificates expire and must rotate, credentials leak and must revoke, ACLs drift from need and must be audited, and new services must be onboarded with least privilege by default. A secured cluster that is never re-audited slowly accumulates over-broad ACLs and stale credentials until it is secured in name only.
- **Scaling.** Security scales with the number of principals and rules, not just traffic. Managing ACLs by hand does not scale past a few dozen services — you want them declared as code (in the topic/ACL provisioning pipeline) and reviewed, so access is version-controlled and auditable. Multi-tenancy scaling means the quota and isolation model must be templated per new tenant (a vhost or topic prefix, a standard permission set, a default quota) so onboarding a tenant is a parameterised operation, not a bespoke one.

## 9. Interview Questions

**Q: What are the three pillars of broker security and what does each solve?**
A: Encryption, authentication, and authorization, and they are orthogonal. Encryption (TLS) protects data in transit — it answers "can someone on the wire read this?" but says nothing about who may connect. Authentication (SASL mechanisms or mutual TLS) establishes identity — it answers "who is this connection?" but not what they may do. Authorization (Kafka ACLs, RabbitMQ permissions) constrains action — it answers "what may this principal do?". You need all three: TLS without auth lets anyone connect over an encrypted channel; auth without authorization lets any valid user do anything; authorization is meaningless without authentication because identity could be forged.

**Q: What SASL mechanisms does Kafka support and when would you choose each?**
A: SASL/PLAIN sends a username and password over the connection, so it is only safe wrapped in TLS; it is the simplest. SASL/SCRAM is a salted challenge-response where the password is never sent in the clear and credentials are stored hashed — the sane default for username/password auth. SASL/GSSAPI is Kerberos, chosen where an organisation already runs Active Directory or Kerberos and wants single sign-on. SASL/OAUTHBEARER authenticates with OAuth 2.0 bearer tokens from an identity provider, fitting modern token-based infrastructure. And mutual TLS uses client certificates so TLS itself provides authentication. You choose based on your existing identity infrastructure — SCRAM if you have none, Kerberos or OAuth if you already have that ecosystem.

**Q: How do Kafka ACLs work?**
A: An ACL grants (or denies) a *principal* an *operation* on a *resource*. The principal is the authenticated identity (`User:orders-service`). The operation is read, write, create, describe, delete, alter, and so on. The resource is a topic, a consumer group, the cluster, or a transactional id, and can be matched literally or by prefix. The broker's authorizer evaluates every request against these rules. The critical setting is `allow.everyone.if.no.acl.found`: it must be `false` so that a resource with no ACL is denied by default — leaving it `true` means any un-ACL'd resource is world-open, quietly re-creating the insecure default.

**Q: How does RabbitMQ's authorization model differ from Kafka's?**
A: RabbitMQ authorizes per user per vhost using three regexes — `configure`, `write`, and `read` — matched against resource names. `Configure` allows declaring/deleting exchanges and queues, `write` allows publishing to them, `read` allows consuming. The vhost is the isolation boundary: permissions are always scoped to a vhost, so a user with rights on `/tenant-a` and none on `/tenant-b` cannot even see tenant B's topology. This is coarser and more namespace-oriented than Kafka's operation-on-resource ACLs, but the vhost makes it a natural fit for multi-tenancy — one vhost per tenant.

**Q: Why does TLS reduce Kafka's throughput?**
A: Because it defeats the zero-copy read path. Normally Kafka serves consumer fetches with the `sendfile` system call, which sends log bytes straight from the OS page cache to the network socket without copying them into user space — a major source of its throughput. TLS requires the bytes to be encrypted, which cannot happen in the kernel's zero-copy path, so every served byte now detours through user space to be encrypted. The measured cost is commonly a 20-40% drop in read throughput plus more CPU. You still use TLS almost always, but you budget for the cost in capacity planning, ensure AES-NI is enabled, and sometimes keep inter-broker traffic on a trusted network to limit TLS to client links.

**Q: What is the historical insecure-by-default trap?**
A: Both Kafka and RabbitMQ historically shipped with an open port, no authentication, no encryption, and — on Kafka — no authorization, so anyone who could reach the broker could read every topic, write to any topic, and delete data. Combined with the belief that "it's on the internal network" is protection, this has caused real breaches, because internal networks are exactly where an attacker who has compromised one host moves laterally. The lesson, and rule number one, is never to expose a broker unauthenticated or unencrypted regardless of network, and to explicitly disable the plaintext listener and default accounts rather than relying on defaults.

**Q: How do you isolate tenants on a shared cluster?**
A: In two dimensions. Data isolation stops tenant A reading or writing tenant B's data: a naming convention (topics/queues prefixed with the tenant) plus authorization rules granting each tenant access only to its own prefix — or, on RabbitMQ, a vhost per tenant. Resource isolation stops tenant A starving tenant B of throughput: per-tenant quotas capping produce and fetch byte-rate on Kafka, or per-vhost connection/queue limits and rate policies on RabbitMQ. Both matter — data isolation without quotas still lets one tenant's runaway producer saturate the brokers and inflate everyone's latency, the noisy-neighbour problem, so a real multi-tenant design needs both.

**Q: (Senior) Design a hardening checklist for a Kafka cluster about to face production traffic.**
A: I would work pillar by pillar and end with the multi-tenancy and lifecycle concerns. Encryption: enable TLS on the client listener and disable the PLAINTEXT listener entirely, use a private CA, and require clients to verify the broker certificate (never `InsecureSkipVerify`); decide explicitly whether inter-broker traffic is TLS or trusted-network based on the throughput cost. Authentication: enable SASL/SCRAM (or Kerberos/OAuth if that infrastructure exists), create a distinct principal per service rather than a shared account, and set up mTLS if I want cert-based identity too. Authorization: enable the authorizer, set `allow.everyone.if.no.acl.found=false` so it denies by default, and grant least-privilege ACLs — each producer `write` on only its topics, each consumer `read` on only its topics and its group, and nobody cluster-admin unless they administer the cluster. Hardening: disable `auto.create.topics.enable` so topics are provisioned deliberately with the right ACLs, remove or lock down default and superuser accounts to a minimal set, and put the JMX and metrics endpoints behind the internal network and auth because they leak topology. Multi-tenancy: apply per-tenant quotas so no tenant can saturate the brokers. Lifecycle: automate certificate rotation and alert on expiry (an expired broker cert is an outage), monitor authentication-failure and authorization-denial rates, and manage ACLs as version-controlled code so access is auditable and does not drift. The through-line is deny by default and least privilege at every layer, verified before traffic rather than after an incident.

**Q: (Senior) A consumer authenticates successfully but cannot consume, with a puzzling group error. How do you diagnose it?**
A: This is the classic missing-consumer-group-ACL symptom, and the diagnosis is to separate the pillars. Successful authentication tells me TLS and SASL both worked — the connection is encrypted and the principal is established — so the problem is in authorization, not identity or encryption. A Kafka consumer needs two distinct permissions: `Read` on the *topic* and `Read` on its *consumer group* resource, because joining a group and committing offsets are operations on the group, not the topic. Teams routinely grant the topic ACL and forget the group ACL, and because the failure surfaces during the group join and rebalance rather than as a clean "access denied on read", it looks like a rebalance or coordinator problem rather than an authorization one. I would confirm by checking the broker's authorizer logs for a denied operation naming the group resource and principal, then add the group `Read` ACL. More generally, my mental model for any broker-security failure is a decision tree: did TLS complete (else cert/CA/hostname issue), did SASL complete (else credential/mechanism issue), and only then is it authorization — and within authorization the subtle cases are almost always a resource type the client needs that was overlooked, the consumer group being the most common, followed by transactional-id ACLs for transactional producers. Naming which pillar failed first turns an opaque error into a specific missing rule.

**Q: (Senior) When would you accept SASL/PLAIN over SCRAM, and what must be true for it to be safe?**
A: I would accept SASL/PLAIN only when it is wrapped in TLS and there is a concrete reason SCRAM is impractical — for instance, when the broker delegates authentication to an external system via a custom PLAIN callback that validates credentials against a directory or a secrets manager, so "PLAIN" is really a transport for a token the broker verifies elsewhere. The non-negotiable condition is TLS: PLAIN transmits the username and password over the connection, so without encryption they are in the clear on the wire and trivially captured, which is a disqualifying flaw. With TLS the credentials are protected in transit, so PLAIN becomes acceptable, but even then SCRAM is preferable for a reason beyond the wire: SCRAM never sends the password at all (it is a salted challenge-response) and the broker stores only a hash, so a broker-side credential store compromise does not directly yield plaintext passwords, whereas a PLAIN setup that validates against a store of plaintext or reversibly-encrypted passwords is a worse breach if that store leaks. So my default is SCRAM, and I reach for PLAIN-over-TLS only to integrate an external identity system through the callback mechanism, never as a convenience, and never without TLS. If I find PLAIN configured without TLS anywhere, I treat it as an active incident, because every authentication has been leaking credentials.

## 10. Quick Revision & Cheat Sheet

| Pillar | Question | Kafka | RabbitMQ |
|---|---|---|---|
| **Encryption** | Can the wire be read? | TLS listener (`SASL_SSL`/`SSL`) | TLS listener (5671) |
| **Authentication** | Who is this? | SASL PLAIN/SCRAM/GSSAPI/OAUTHBEARER, mTLS | user/pass, x509, SASL |
| **Authorization** | What may they do? | ACLs: principal + op + resource | permissions: configure/write/read regex per vhost |
| **Quotas** | How much may they use? | client quotas (byte/request rate) | vhost limits + policies |
| **Isolation unit** | | topic prefix + ACLs | vhost |

| Must-set on Kafka | Why |
|---|---|
| `allow.everyone.if.no.acl.found=false` | Deny by default; else un-ACL'd = world-open |
| disable PLAINTEXT listener | Remove the insecure default |
| `auto.create.topics.enable=false` | No arbitrary topic creation by clients |
| verify broker cert (no `InsecureSkipVerify`) | Prevent man-in-the-middle |

**Flash cards**
- **Three pillars?** → Encryption (TLS), authentication (SASL/mTLS), authorization (ACLs/permissions).
- **Safest username/password mechanism?** → SASL/SCRAM (hashed, challenge-response); PLAIN only over TLS.
- **What must be false on the Kafka authorizer?** → `allow.everyone.if.no.acl.found` (deny by default).
- **Consumer needs which ACLs?** → `Read` on the topic AND `Read` on the consumer group.
- **What does TLS cost Kafka?** → Zero-copy on reads → 20-40% less read throughput.
- **Multi-tenancy = ?** → Data isolation (prefix/vhost + ACLs) + resource isolation (quotas).

## 11. Hands-On Exercises & Mini Project

- [ ] Stand up a Kafka broker with a `SASL_SSL` listener and SCRAM, and connect a client with `InsecureSkipVerify=false` verifying a private CA.
- [ ] Add least-privilege ACLs for a producer and a consumer, deliberately omit the consumer-group ACL, and observe the failure — then fix it.
- [ ] Set `allow.everyone.if.no.acl.found=true` then `false` and demonstrate the difference on an un-ACL'd topic.
- [ ] Create two RabbitMQ vhosts, a user per vhost with least-privilege permissions, and prove one user cannot see the other's queues.
- [ ] Apply a Kafka client quota (`producer_byte_rate`) and watch a producer get throttled above the limit.
- [ ] Benchmark read throughput with and without TLS and measure the zero-copy premium.

### Mini Project — "Secure Multi-Tenant Cluster"

**Goal.** Build a cluster that safely hosts two tenants with full data and resource isolation, and prove the isolation holds.

**Requirements.**
1. Configure TLS on the client listener, disable the plaintext listener, and connect clients that verify the broker against a private CA.
2. Enable SCRAM authentication with a distinct principal per service, and enable the authorizer with deny-by-default.
3. Create two tenants (topic prefixes + ACLs on Kafka, or two vhosts on RabbitMQ) and prove tenant A cannot read or write tenant B's data.
4. Apply per-tenant quotas and demonstrate that a runaway producer in tenant A is throttled and does not degrade tenant B's latency.
5. Disable auto-topic-creation and remove default accounts; run a hardening checklist and document each item.

**Extensions.**
- Add certificate-expiry monitoring and authentication/authorization failure-rate alerts, and simulate an expired cert to confirm the alert fires before the outage.
- Manage the ACLs/permissions as version-controlled code and show a reviewable diff when onboarding a new service.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Performance Tuning & Capacity Planning* (why TLS changes the throughput and capacity math), *Monitoring: Lag, Throughput & Broker Health* (securing and watching the metrics/JMX endpoints), *Consumers, Groups, Offsets & Rebalancing* (why the consumer-group ACL matters), *Design: Kafka vs RabbitMQ* (how the isolation models differ), *Delivery Guarantees* (transactional-id ACLs for exactly-once producers).

- **Apache Kafka — Security** — Apache · *Advanced* · the authoritative reference for TLS listeners, SASL mechanisms, and the authorizer/ACL model. <https://kafka.apache.org/documentation/#security>
- **Kafka — Authorization and ACLs** — Confluent · *Advanced* · the ACL grammar (principal, operation, resource) and `kafka-acls.sh` in practice, including deny-by-default. <https://docs.confluent.io/platform/current/kafka/authorization.html>
- **RabbitMQ — Access Control** — RabbitMQ · *Intermediate* · the vhost/user/permission model and the configure/write/read regexes in detail. <https://www.rabbitmq.com/docs/access-control>
- **RabbitMQ — TLS Support** — RabbitMQ · *Intermediate* · configuring TLS listeners, peer verification, and client certificates. <https://www.rabbitmq.com/docs/ssl>
- **Kafka — Multi-Tenancy & Quotas** — Confluent · *Advanced* · client quotas for produce/fetch/request rate and how to isolate tenants on a shared cluster. <https://docs.confluent.io/platform/current/kafka/multi-tenancy.html>
- **OWASP — Transport Layer Protection Cheat Sheet** — OWASP · *Intermediate* · the general principles of doing TLS correctly (verification, cipher choice, versions) that apply to brokers. <https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Protection_Cheat_Sheet.html>
- **RabbitMQ — Virtual Hosts** — RabbitMQ · *Beginner* · the isolation boundary that makes vhost-per-tenant multi-tenancy work. <https://www.rabbitmq.com/docs/vhosts>
- **Designing Data-Intensive Applications, ch. 11 & security discussions** — Martin Kleppmann · *Advanced* · the systems context for why brokers hold sensitive data and must be secured as such. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 29.*
