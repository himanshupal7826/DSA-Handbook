# 08 · Transactions & ACID

> **In one line:** Group statements into all-or-nothing units with isolation guarantees.

---

## 1. Overview

A transaction is a unit of work that is **Atomic** (all or nothing), **Consistent** (preserves invariants), **Isolated** (concurrent txns don't corrupt each other), and **Durable** (committed data survives crashes). Isolation levels trade correctness for concurrency.

## 2. Key Concepts

- BEGIN ... COMMIT/ROLLBACK delimits a transaction.
- Isolation levels: Read Uncommitted, Read Committed, Repeatable Read, Serializable.
- Anomalies: dirty read, non-repeatable read, phantom read.
- MVCC lets readers not block writers (Postgres, InnoDB).

## 3. Syntax & Code

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
-- both succeed or neither does
COMMIT;
```

## 4. Worked Example

**Prevent lost updates**

Use SELECT ... FOR UPDATE to lock rows you'll modify:

```sql
BEGIN;
SELECT balance FROM accounts WHERE id = 1 FOR UPDATE;
-- compute new balance in app, then:
UPDATE accounts SET balance = :new WHERE id = 1;
COMMIT;
```

## 5. Best Practices

- ✅ Keep transactions short to reduce lock contention.
- ✅ Pick the lowest isolation level that's still correct.
- ✅ Use FOR UPDATE to guard read-modify-write races.
- ✅ Always handle ROLLBACK on errors.
- ✅ Order lock acquisition consistently to avoid deadlocks.

## 6. Common Pitfalls

1. ⚠️ Long transactions holding locks and bloating MVCC.
2. ⚠️ Read Committed allowing non-repeatable reads within a txn.
3. ⚠️ Phantom rows under Repeatable Read (depending on engine).
4. ⚠️ Deadlocks from inconsistent lock ordering.
5. ⚠️ Doing slow external calls inside an open transaction.
6. ⚠️ Assuming autocommit-off without checking the client default.

## 7. Interview Questions

1. **Q: What does ACID stand for?**
   A: Atomicity, Consistency, Isolation, Durability.

2. **Q: Dirty vs non-repeatable vs phantom read?**
   A: Dirty: reading uncommitted data; non-repeatable: a re-read row changed; phantom: new rows match a re-run query.

3. **Q: What does Serializable guarantee?**
   A: Transactions behave as if run one at a time — no concurrency anomalies.

4. **Q: How does MVCC help?**
   A: Each txn sees a consistent snapshot; readers don't block writers and vice versa.

5. **Q: How to prevent lost updates?**
   A: SELECT ... FOR UPDATE (pessimistic) or optimistic concurrency with a version column.

6. **Q: What causes deadlocks and how to avoid?**
   A: Cyclic lock waits; avoid by consistent lock ordering and short transactions.

7. **Q: Default isolation in Postgres/MySQL?**
   A: Postgres: Read Committed; MySQL InnoDB: Repeatable Read.

8. **Q: Why keep transactions short?**
   A: They hold locks and MVCC snapshots, increasing contention and bloat.

## 8. Practice

- [ ] Implement a money transfer transaction with rollback.
- [ ] Reproduce a non-repeatable read, then fix with Repeatable Read.
- [ ] Use a version column for optimistic locking.

## 9. Quick Revision

Transactions = atomic units with ACID. Isolation levels trade anomalies (dirty/non-repeatable/phantom) for concurrency. Keep txns short; use FOR UPDATE or version columns to avoid lost updates; consistent lock order avoids deadlocks.

**References:** ACID; SQL standard isolation levels

---

*SQL Handbook — topic 08.*
