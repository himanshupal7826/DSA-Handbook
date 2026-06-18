# 07 · Query Optimization & EXPLAIN

> **In one line:** Read execution plans and rewrite queries to be fast.

---

## 1. Overview

The query optimizer turns SQL into an execution plan using table statistics. `EXPLAIN ANALYZE` shows the chosen plan and real timings. Optimization = give the optimizer good indexes/statistics and write sargable predicates.

## 2. Key Concepts

- Seq Scan reads the whole table; Index Scan uses an index.
- Join methods: nested loop (small), hash join (large unsorted), merge join (sorted).
- 'Sargable' predicates can use indexes; non-sargable can't.
- Stale statistics → bad row estimates → bad plans; ANALYZE refreshes them.

## 3. Syntax & Code

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE c.country = 'IN' AND o.created_at > now() - interval '7 days';
```

## 4. Worked Example

**Make a predicate sargable**

Avoid wrapping the indexed column in a function:

```sql
-- Non-sargable (no index use):
WHERE date(created_at) = '2026-06-18'
-- Sargable (range, uses index):
WHERE created_at >= '2026-06-18' AND created_at < '2026-06-19'
```

## 5. Best Practices

- ✅ Always profile with EXPLAIN ANALYZE on representative data.
- ✅ Keep statistics fresh (ANALYZE / autovacuum).
- ✅ Write sargable predicates (no functions on indexed columns).
- ✅ Reduce returned columns/rows early.
- ✅ Add the right index rather than tweaking SQL blindly.

## 6. Common Pitfalls

1. ⚠️ Optimizing on tiny dev data where plans differ from prod.
2. ⚠️ Functions/casts making predicates non-sargable.
3. ⚠️ OR conditions across columns preventing index use (consider UNION).
4. ⚠️ SELECT * forcing heap fetches that block index-only scans.
5. ⚠️ Ignoring row-estimate vs actual mismatches (stale stats).
6. ⚠️ N+1 queries from the application instead of one set-based query.

## 7. Interview Questions

1. **Q: What does EXPLAIN ANALYZE show?**
   A: The actual execution plan with real timing, row counts, and (optionally) buffer usage.

2. **Q: What is a sargable predicate?**
   A: One that can use an index because the indexed column appears bare on one side of a range/equality.

3. **Q: Nested loop vs hash join?**
   A: Nested loop suits small/indexed inputs; hash join suits large unsorted inputs; merge join suits pre-sorted inputs.

4. **Q: Why are statistics important?**
   A: The optimizer estimates row counts from stats; stale stats cause poor plan choices.

5. **Q: How to fix a Seq Scan on a big table?**
   A: Add a selective index and ensure predicates are sargable, or accept it if most rows match.

6. **Q: How to handle OR-based index misses?**
   A: Rewrite as UNION of two index-friendly queries.

7. **Q: What is an index-only scan?**
   A: A plan that answers entirely from a covering index without touching the table.

8. **Q: Sign of N+1 in the DB?**
   A: Many identical parameterized queries — batch into one set-based query/JOIN.

## 8. Practice

- [ ] Profile a slow join with EXPLAIN ANALYZE and add an index.
- [ ] Rewrite a date(col)=x filter as a sargable range.
- [ ] Convert an OR filter into a UNION.

## 9. Quick Revision

Optimizer + stats produce a plan; read it with EXPLAIN ANALYZE. Prefer Index/index-only scans, write sargable predicates, keep stats fresh, and fix N+1 with set-based SQL.

**References:** EXPLAIN ANALYZE

---

*SQL Handbook — topic 07.*
