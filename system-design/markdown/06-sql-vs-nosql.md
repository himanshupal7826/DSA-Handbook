# 06 · SQL vs NoSQL & Data Modeling

> **In one line:** Choose a datastore by access patterns and consistency needs.

---

## 1. Overview

Pick storage by **access pattern**, not hype. **SQL** (relational, ACID, joins) fits structured, transactional data; **NoSQL** families — key-value, document, wide-column, graph — trade joins/strict schema for scale and flexible models. Often you combine several (polyglot persistence).

## 2. Key Concepts

- SQL: schema, joins, strong ACID transactions.
- Key-value (Redis/DynamoDB): fast lookups by key.
- Document (MongoDB): flexible nested JSON.
- Wide-column (Cassandra): huge write throughput, partitioned.
- Model NoSQL around queries (denormalize for reads).

## 3. Syntax & Code

```text
Need joins + transactions?        -> SQL (Postgres/MySQL)
Simple key lookups, low latency?  -> Key-Value (Redis/Dynamo)
Flexible nested docs?             -> Document (MongoDB)
Massive writes, time-series?      -> Wide-Column (Cassandra)
Relationships/traversal?          -> Graph (Neo4j)
```

## 4. Worked Example

**Model for queries (NoSQL)**

In Cassandra you design tables per query and denormalize, since joins aren't available.

```text
Query: messages by chat, newest first
Table PK = chat_id, clustering = ts DESC  (one table per access pattern)
```

## 5. Best Practices

- ✅ Choose based on access patterns and consistency needs.
- ✅ Use SQL by default for transactional, relational data.
- ✅ Denormalize NoSQL around read queries.
- ✅ Consider polyglot persistence (right tool per job).
- ✅ Know your consistency requirements before choosing.

## 6. Common Pitfalls

1. ⚠️ Picking NoSQL for inherently relational/transactional data.
2. ⚠️ Expecting joins/ACID from eventually-consistent stores.
3. ⚠️ Modeling NoSQL like a relational schema.
4. ⚠️ Ignoring hot partitions in wide-column stores.
5. ⚠️ Premature NoSQL adoption for scale you don't have.
6. ⚠️ Underestimating operational complexity of multiple stores.

## 7. Interview Questions

1. **Q: How to choose SQL vs NoSQL?**
   A: By access patterns, consistency, and scale — SQL for relational/transactional, NoSQL for scale/flexibility.

2. **Q: NoSQL families?**
   A: Key-value, document, wide-column, graph — each suited to different access patterns.

3. **Q: When is SQL the right default?**
   A: Structured data needing joins and strong transactions.

4. **Q: How do you model NoSQL data?**
   A: Around queries: denormalize and create tables/collections per access pattern.

5. **Q: Trade-off of NoSQL scale?**
   A: Often weaker consistency and no joins/ACID across entities.

6. **Q: What is polyglot persistence?**
   A: Using multiple datastores, each for the workload it fits best.

7. **Q: Hot partition problem?**
   A: Skewed partition keys overload one node; design keys for even distribution.

8. **Q: Can NoSQL be ACID?**
   A: Some offer transactions (e.g., DynamoDB, MongoDB) but with constraints.

## 8. Practice

- [ ] Choose a datastore for a shopping cart and justify it.
- [ ] Model a chat-by-room table for a wide-column store.
- [ ] Argue SQL vs NoSQL for an analytics workload.

## 9. Quick Revision

Choose by access pattern: SQL (relational/ACID/joins) vs NoSQL (key-value/document/wide-column/graph) for scale/flexibility. Model NoSQL around queries; polyglot persistence is common; know consistency needs.

**References:** Database types

---

*System Design Handbook — topic 06.*
