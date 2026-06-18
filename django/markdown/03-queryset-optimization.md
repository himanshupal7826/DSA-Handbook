# 03 · QuerySet Optimization (N+1)

> **In one line:** Eliminate N+1 queries with select_related/prefetch_related.

---

## 1. Overview

The classic Django performance killer is the **N+1 query problem**: looping over objects and lazily fetching a related object each iteration. `select_related` (SQL JOIN, for FK/O2O) and `prefetch_related` (separate query + Python join, for M2M/reverse FK) fix it.

## 2. Key Concepts

- select_related: single JOIN for forward FK/OneToOne.
- prefetch_related: extra query for M2M/reverse, joined in Python.
- only()/defer() limit selected columns.
- annotate()/aggregate() push computation to the DB.
- Inspect queries with django-debug-toolbar or connection.queries.

## 3. Syntax & Code

```python
# BAD: 1 + N queries
for book in Book.objects.all():
    print(book.author.name)   # a query per book

# GOOD: 1 query (JOIN)
for book in Book.objects.select_related('author'):
    print(book.author.name)
```

## 4. Worked Example

**Prefetch for many-to-many**

One extra query instead of N:

```python
authors = Author.objects.prefetch_related('books')
for a in authors:
    print(a.name, [b.title for b in a.books.all()])  # no extra queries
```

## 5. Best Practices

- ✅ Use select_related for FK/O2O, prefetch_related for M2M/reverse.
- ✅ Profile with django-debug-toolbar.
- ✅ annotate counts/sums in the DB, not Python.
- ✅ Use only()/values() to fetch fewer columns.
- ✅ Add indexes for filtered/ordered fields.

## 6. Common Pitfalls

1. ⚠️ N+1 from lazy related access in loops.
2. ⚠️ Using prefetch where select_related is correct (and vice versa).
3. ⚠️ count() in a loop instead of annotate.
4. ⚠️ Loading full objects when values()/only() suffices.
5. ⚠️ Over-prefetching unused relations.
6. ⚠️ Assuming the ORM caches across requests.

## 7. Interview Questions

1. **Q: What is the N+1 query problem?**
   A: One query for a list plus one per item for a related object — fixed by eager loading.

2. **Q: select_related vs prefetch_related?**
   A: select_related uses a SQL JOIN for FK/O2O; prefetch_related runs a second query and joins in Python for M2M/reverse FK.

3. **Q: How to count related rows efficiently?**
   A: annotate(Count('relation')) so the DB computes it in one query.

4. **Q: How do you detect query issues?**
   A: django-debug-toolbar or len(connection.queries) in tests.

5. **Q: only() vs defer()?**
   A: only() loads just listed fields; defer() loads all but listed — both reduce column I/O.

6. **Q: Are QuerySets cached?**
   A: A QuerySet caches its results once evaluated, but a new QuerySet re-queries.

7. **Q: aggregate vs annotate?**
   A: aggregate returns a single summary dict; annotate adds a per-row computed field.

8. **Q: When does select_related not help?**
   A: For many-to-many/reverse relations — use prefetch_related.

## 8. Practice

- [ ] Fix an N+1 loop with select_related.
- [ ] Prefetch a M2M relation and verify query count.
- [ ] Replace per-row counts with annotate.

## 9. Quick Revision

N+1 = list query + per-item related queries. select_related (JOIN, FK/O2O), prefetch_related (2nd query, M2M/reverse), annotate for DB-side counts. Profile with debug-toolbar.

**References:** Database access optimization

---

*Django Handbook — topic 03.*
