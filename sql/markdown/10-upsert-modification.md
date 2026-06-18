# 10 · INSERT, UPDATE, DELETE & UPSERT

> **In one line:** Modify data safely, including idempotent upserts.

---

## 1. Overview

DML statements change data. Modern SQL adds **UPSERT** (`INSERT ... ON CONFLICT` / `MERGE`) for idempotent writes and `RETURNING` to get affected rows back in one round trip.

## 2. Key Concepts

- Always scope UPDATE/DELETE with a WHERE — or you change every row.
- UPSERT inserts or updates on a unique-key conflict atomically.
- RETURNING avoids a second SELECT after a write.
- Batch large modifications to avoid long locks/bloat.

## 3. Syntax & Code

```sql
-- Idempotent upsert on a unique email
INSERT INTO users (email, name)
VALUES ('a@x.com', 'Ann')
ON CONFLICT (email)
DO UPDATE SET name = EXCLUDED.name
RETURNING id;
```

## 4. Worked Example

**Safe bulk delete in batches**

Delete old rows in chunks to avoid a giant lock:

```sql
DELETE FROM events
WHERE id IN (
  SELECT id FROM events WHERE created_at < now() - interval '90 days' LIMIT 10000
);
```

## 5. Best Practices

- ✅ Wrap multi-statement changes in a transaction.
- ✅ Test UPDATE/DELETE as a SELECT first to confirm the WHERE.
- ✅ Use ON CONFLICT for idempotency in retried writes.
- ✅ Use RETURNING to fetch generated ids.
- ✅ Batch large deletes/updates.

## 6. Common Pitfalls

1. ⚠️ UPDATE/DELETE without WHERE affecting all rows.
2. ⚠️ UPSERT without a matching unique/exclusion constraint errors.
3. ⚠️ Huge single-statement deletes causing long locks and replication lag.
4. ⚠️ Forgetting EXCLUDED refers to the proposed row in ON CONFLICT.
5. ⚠️ Non-idempotent inserts duplicating on retry.
6. ⚠️ Triggers firing unexpectedly on bulk DML.

## 7. Interview Questions

1. **Q: What is an UPSERT?**
   A: Insert a row, or update it if a unique conflict occurs — atomic and idempotent.

2. **Q: What does RETURNING do?**
   A: Returns columns of the rows affected by an INSERT/UPDATE/DELETE in the same statement.

3. **Q: Risk of UPDATE without WHERE?**
   A: It modifies every row in the table.

4. **Q: How to make retried writes safe?**
   A: ON CONFLICT DO NOTHING/UPDATE, or natural idempotency keys.

5. **Q: Why batch big deletes?**
   A: To limit lock duration, WAL/redo size, and replication lag.

6. **Q: What is EXCLUDED in ON CONFLICT?**
   A: A pseudo-row holding the values proposed for insertion, used in the DO UPDATE clause.

7. **Q: MERGE vs ON CONFLICT?**
   A: MERGE (SQL standard) is more general multi-action; ON CONFLICT is Postgres' targeted upsert.

8. **Q: How to soft-delete?**
   A: Add a deleted_at column and filter it out instead of physically deleting.

## 8. Practice

- [ ] Write an idempotent upsert keyed on a unique column.
- [ ] Delete stale rows in 10k batches.
- [ ] Use RETURNING to capture inserted ids.

## 9. Quick Revision

DML changes data — always WHERE-scope UPDATE/DELETE. UPSERT (ON CONFLICT) gives idempotent writes; RETURNING saves a round trip; batch big modifications.

**References:** INSERT ... ON CONFLICT

---

*SQL Handbook — topic 10.*
