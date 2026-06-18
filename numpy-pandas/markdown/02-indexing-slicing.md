# 02 · Indexing, Slicing & Views

> **In one line:** Slices are views (no copy); fancy/boolean indexing copies.

---

## 1. Overview

Basic **slices return views** that share memory with the original (mutations propagate). **Fancy indexing** (integer/boolean arrays) returns **copies**. Boolean masks are the idiomatic way to filter data.

## 2. Key Concepts

- a[1:3, :] is a view — editing it edits a.
- Boolean mask a[a > 0] selects matching elements (copy).
- Fancy indexing a[[0,2]] copies selected rows.
- Negative indices count from the end.
- Use .copy() to detach a view.

## 3. Syntax & Code

```python
a = np.arange(10)
view = a[2:5]
view[0] = 99       # also changes a[2]!
mask = a > 5
print(a[mask])     # boolean filtering -> copy
```

## 4. Worked Example

**Conditional replace**

Use a mask to assign in place:

```python
a = np.array([-1, 2, -3, 4])
a[a < 0] = 0       # clamp negatives -> [0 2 0 4]
```

## 5. Best Practices

- ✅ Use boolean masks for filtering — clear and fast.
- ✅ Call .copy() when you need independence from a view.
- ✅ Prefer slicing over loops for subsets.
- ✅ Combine masks with & / | (parenthesized).
- ✅ Use np.where for vectorized if/else.

## 6. Common Pitfalls

1. ⚠️ Mutating a view and unintentionally changing the source.
2. ⚠️ Using Python and/or instead of & / | on arrays.
3. ⚠️ Forgetting parentheses around mask conditions.
4. ⚠️ Assuming fancy indexing returns a view (it copies).
5. ⚠️ Out-of-bounds fancy indices raising errors.
6. ⚠️ Chained indexing causing copy-vs-view ambiguity.

## 7. Interview Questions

1. **Q: View vs copy in NumPy?**
   A: Basic slicing returns a view sharing memory; fancy/boolean indexing returns a copy.

2. **Q: How to filter with a condition?**
   A: Boolean mask: a[a > k].

3. **Q: Why use & / | not and/or?**
   A: Python's and/or operate on truth values; element-wise needs & / | with parentheses.

4. **Q: How to make a slice independent?**
   A: Call .copy() on it.

5. **Q: What does np.where do?**
   A: Vectorized conditional selection/assignment (if/else over arrays).

6. **Q: Does a[[0,2]] return a view?**
   A: No — integer (fancy) indexing copies.

7. **Q: How to assign to a masked subset?**
   A: a[mask] = value updates matching elements in place.

8. **Q: Risk of chained indexing?**
   A: It can produce a temporary copy, so the assignment may not stick.

## 8. Practice

- [ ] Show a view mutating its source, then fix with copy.
- [ ] Clamp negatives to zero with a boolean mask.
- [ ] Use np.where to build an if/else array.

## 9. Quick Revision

Slices = views (shared memory); fancy/boolean indexing = copies. Filter with masks (& / | + parens), detach with .copy(), branch with np.where; beware mutating views.

**References:** Indexing

---

*NumPy & Pandas Handbook — topic 02.*
