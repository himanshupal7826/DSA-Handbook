# 09 · Microservices vs Monolith

> **In one line:** Trade deployment independence for distributed complexity.

---

## 1. Overview

A **monolith** is one deployable unit (simple, fast to start). **Microservices** split by business capability for independent scaling/deploys, at the cost of distributed-systems complexity (network calls, data consistency, observability). Most systems should start monolithic and split when pain justifies it.

## 2. Key Concepts

- Split by bounded context / business capability.
- Each service owns its data (no shared DB).
- API gateway handles routing/auth/rate-limiting.
- Service mesh manages service-to-service traffic.
- Distributed transactions → sagas, not 2PC across services.

## 3. Syntax & Code

```text
Client ─▶ API Gateway ─▶ [Auth] [Orders] [Payments] [Inventory]
                          each: own DB, own deploy, own scaling
```

## 4. Worked Example

**Saga over distributed transaction**

Coordinate a multi-service workflow with compensating actions instead of a global transaction.

```text
CreateOrder -> ReserveInventory -> ChargePayment
  on failure: compensate (refund, release inventory)
```

## 5. Best Practices

- ✅ Start monolithic; extract services when boundaries are clear.
- ✅ Give each service its own data store.
- ✅ Use an API gateway for cross-cutting concerns.
- ✅ Design for failure (timeouts, retries, circuit breakers).
- ✅ Invest in observability (tracing, metrics, logs).

## 6. Common Pitfalls

1. ⚠️ Premature microservices (distributed monolith).
2. ⚠️ Shared database coupling services.
3. ⚠️ Synchronous call chains amplifying latency/failure.
4. ⚠️ Distributed transactions via 2PC across services.
5. ⚠️ No tracing → undebuggable failures.
6. ⚠️ Network calls treated as if local (no timeouts/retries).

## 7. Interview Questions

1. **Q: Monolith vs microservices?**
   A: Monolith: one deployable, simple; microservices: independent deploy/scale per capability, with distributed complexity.

2. **Q: When to use microservices?**
   A: When clear bounded contexts and team/scale needs justify the operational cost.

3. **Q: Why own-database-per-service?**
   A: To decouple services; a shared DB recreates a tightly-coupled monolith.

4. **Q: How to handle cross-service transactions?**
   A: Sagas with compensating actions, not global 2PC.

5. **Q: Role of an API gateway?**
   A: Single entry point for routing, auth, rate-limiting, and aggregation.

6. **Q: What's a distributed monolith?**
   A: Microservices so coupled they must deploy together — worst of both worlds.

7. **Q: How to manage service-to-service comms?**
   A: Timeouts, retries with backoff, circuit breakers, and a service mesh.

8. **Q: Why is observability critical?**
   A: Failures span services; distributed tracing is needed to debug them.

## 8. Practice

- [ ] Decide monolith vs microservices for an MVP.
- [ ] Design a saga for order→payment→inventory.
- [ ] Add resilience (timeouts/circuit breaker) to a call.

## 9. Quick Revision

Monolith (simple) vs microservices (independent deploy/scale + distributed complexity). Split by bounded context, DB-per-service, API gateway, sagas not 2PC, design for failure, invest in observability. Start monolith.

**References:** Microservices

---

*System Design Handbook — topic 09.*
