# 03 · Vectorization & ufuncs

> **In one line:** Replace Python loops with array-wide C operations.

---

## 1. Overview

**Vectorization** expresses computations as operations over whole arrays, executed by C-level **ufuncs** (np.add, np.exp, etc.). It's the single biggest NumPy performance lever — often 10–100× faster than Python loops and far more concise.

## 2. Key Concepts

- ufuncs apply element-wise in compiled C.
- Arithmetic/comparison operators are ufuncs.
- Reductions (sum/mean/max) collapse axes.
- Avoid Python-level loops over elements.
- np.vectorize is convenience, not speed.

## 3. Syntax & Code

```python
x = np.linspace(0, np.pi, 5)
y = np.sin(x) ** 2 + np.cos(x) ** 2   # vectorized, ~1.0 everywhere
total = y.sum()
```

## 4. Worked Example

**Loop → vectorized**

Distance between point arrays without a loop:

```python
p = np.random.rand(1000, 2)
q = np.random.rand(1000, 2)
d = np.sqrt(((p - q) ** 2).sum(axis=1))   # 1000 distances, no loop
```

## 5. Best Practices

- ✅ Express math over whole arrays, not element loops.
- ✅ Use built-in ufuncs/reductions.
- ✅ Specify axis explicitly in reductions.
- ✅ Combine masks + vectorized ops for conditional logic.
- ✅ Profile before micro-optimizing.

## 6. Common Pitfalls

1. ⚠️ Python loops over array elements (slow).
2. ⚠️ Thinking np.vectorize gives C speed (it doesn't).
3. ⚠️ Wrong axis in reductions.
4. ⚠️ Creating large temporaries in long expressions (memory).
5. ⚠️ Mixing Python floats and arrays unnecessarily.
6. ⚠️ Forgetting integer division vs float behavior.

## 7. Interview Questions

1. **Q: What is vectorization?**
   A: Performing operations on entire arrays via compiled ufuncs instead of Python loops.

2. **Q: Why is it faster?**
   A: It avoids the Python interpreter overhead per element and uses CPU/cache-friendly C loops.

3. **Q: What is a ufunc?**
   A: A universal function applying an operation element-wise across arrays (with broadcasting).

4. **Q: Does np.vectorize speed things up?**
   A: No — it's a convenience wrapper; the loop is still Python-level.

5. **Q: How do reductions work?**
   A: Functions like sum/mean collapse a chosen axis to aggregate.

6. **Q: How to do conditional logic vectorized?**
   A: Boolean masks and np.where.

7. **Q: Memory cost of big expressions?**
   A: Intermediate temporaries; chunk or use in-place ops if needed.

8. **Q: axis=0 vs axis=1?**
   A: axis=0 reduces down columns; axis=1 across rows.

## 8. Practice

- [ ] Rewrite a Python sum loop as a vectorized reduction.
- [ ] Compute pairwise distances without loops.
- [ ] Use a mask + np.where for conditional math.

## 9. Quick Revision

Vectorize: whole-array ufuncs in C beat Python loops 10–100×. Use built-in ufuncs/reductions (mind axis), masks/np.where for conditionals; np.vectorize is not fast.

**References:** Universal functions

---

*NumPy & Pandas Handbook — topic 03.*
