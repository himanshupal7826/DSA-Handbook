# 03 · Load Balancing

> **In one line:** Distribute traffic across servers for scale and availability.

---

## 1. Overview

A **load balancer** spreads requests across many servers, enabling horizontal scaling and fault tolerance. **L4** balances by IP/port (fast); **L7** routes by HTTP content (smart). Health checks remove unhealthy instances automatically.

## 2. Key Concepts

- Algorithms: round-robin, least-connections, IP/consistent hash.
- L4 (transport) vs L7 (application) load balancing.
- Health checks drain failed nodes.
- Sticky sessions pin a client to a server (avoid if stateless).
- LBs themselves need redundancy (no single point of failure).

## 3. Syntax & Code

```text
        ┌──────────────┐
clients →│ Load Balancer│→ [app-1]
        │  (L7, health │→ [app-2]
        │   checks)    │→ [app-3]
        └──────────────┘   (auto-remove unhealthy)
```

## 4. Worked Example

**Least connections**

Route to the server with the fewest active connections — better than round-robin under uneven request durations.

```text
RR:   evenly, ignores load
LC:   picks least-busy node (good for long requests)
Hash: same client -> same node (cache affinity)
```

## 5. Best Practices

- ✅ Keep app servers stateless so any node can serve any request.
- ✅ Use health checks to auto-remove bad nodes.
- ✅ Pick the algorithm for your traffic (LC for uneven durations).
- ✅ Run redundant LBs (active-active/standby).
- ✅ Terminate TLS at the LB.

## 6. Common Pitfalls

1. ⚠️ Sticky sessions creating stateful bottlenecks.
2. ⚠️ Single load balancer as a SPOF.
3. ⚠️ No health checks → routing to dead servers.
4. ⚠️ Ignoring connection draining on deploys.
5. ⚠️ Round-robin under highly variable request costs.
6. ⚠️ LB becoming the capacity ceiling.

## 7. Interview Questions

1. **Q: Why load balance?**
   A: To scale horizontally and tolerate server failures by distributing traffic.

2. **Q: L4 vs L7?**
   A: L4 routes by IP/port (fast, protocol-agnostic); L7 routes by HTTP content (path/host/cookies).

3. **Q: Common algorithms?**
   A: Round-robin, least-connections, IP/consistent hashing.

4. **Q: Why prefer stateless servers?**
   A: Any server can handle any request, enabling easy scaling and failover.

5. **Q: What are health checks?**
   A: Periodic probes that remove unhealthy instances from rotation.

6. **Q: Downside of sticky sessions?**
   A: They reintroduce state/affinity, harming balance and failover.

7. **Q: Is the LB a SPOF?**
   A: It can be — run redundant LBs and use DNS/anycast failover.

8. **Q: What is connection draining?**
   A: Letting in-flight requests finish before removing a node during deploys.

## 8. Practice

- [ ] Diagram an L7 LB fronting 3 stateless app servers.
- [ ] Choose an algorithm for long-lived connections.
- [ ] Explain how to make the LB itself HA.

## 9. Quick Revision

LBs distribute traffic (RR/least-conn/hash), L4 (fast) vs L7 (smart), with health checks + draining. Keep servers stateless; avoid sticky sessions; make the LB redundant.

**References:** Load balancing

---

*System Design Handbook — topic 03.*
