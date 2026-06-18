# 01 · The ndarray

> **In one line:** A fast, fixed-type, N-dimensional array — the basis of the PyData stack.

---

## 1. Overview

NumPy's **ndarray** is a contiguous, fixed-**dtype**, N-dimensional array. Because elements are the same type and laid out contiguously in memory, operations run in optimized C — orders of magnitude faster than Python lists.

## 2. Key Concepts

- Homogeneous dtype (int64, float64, bool) — not mixed like lists.
- shape describes dimensions; ndim the count.
- Contiguous memory → cache-friendly, vectorizable.
- dtype controls precision and memory footprint.
- Created via array, zeros, ones, arange, linspace.

## 3. Syntax & Code

```python
import numpy as np
a = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.int64)
print(a.shape, a.ndim, a.dtype)  # (2, 3) 2 int64
print(np.arange(0, 1, 0.25))     # [0.   0.25 0.5  0.75]
```

## 4. Worked Example

**Lists vs arrays speed**

Vectorized math beats Python loops:

```python
x = np.arange(1_000_000)
y = x * 2 + 1          # vectorized, runs in C
# vs [i*2+1 for i in range(1_000_000)]  # much slower
```

## 5. Best Practices

- ✅ Pick the smallest dtype that fits (memory + speed).
- ✅ Prefer vectorized ops over Python loops.
- ✅ Know shape/ndim before operating.
- ✅ Use np.zeros/empty to preallocate.
- ✅ Keep arrays contiguous for performance.

## 6. Common Pitfalls

1. ⚠️ Mixing dtypes forcing an object array (slow).
2. ⚠️ Integer overflow with small int dtypes.
3. ⚠️ Assuming arrays are dynamically resizable (they're fixed-size).
4. ⚠️ float precision surprises (use np.isclose).
5. ⚠️ Confusing ndim with len.
6. ⚠️ Accidentally creating object dtype from ragged lists.

## 7. Interview Questions

1. **Q: Why is ndarray faster than a list?**
   A: Homogeneous dtype + contiguous memory enable vectorized C loops and cache efficiency.

2. **Q: What is a dtype?**
   A: The fixed element type (e.g., int64, float32) determining size and precision.

3. **Q: shape vs ndim?**
   A: shape is the tuple of dimension sizes; ndim is the number of dimensions.

4. **Q: What happens with mixed types?**
   A: NumPy falls back to object dtype, losing the speed advantage.

5. **Q: Are arrays resizable?**
   A: No — they're fixed-size; 'append' creates a new array (costly).

6. **Q: How to preallocate?**
   A: np.zeros/np.empty with the target shape and dtype.

7. **Q: Why choose float32 over float64?**
   A: Half the memory and often faster, at reduced precision.

8. **Q: How to compare floats?**
   A: np.isclose / np.allclose, not ==.

## 8. Practice

- [ ] Create a 2D int64 array and inspect shape/dtype.
- [ ] Benchmark a vectorized op vs a Python loop.
- [ ] Trigger and explain an object-dtype array.

## 9. Quick Revision

ndarray = contiguous, fixed-dtype, N-D array → fast vectorized C ops. Pick small dtypes, vectorize, preallocate, keep contiguous; avoid mixed types (object dtype) and float ==.

**References:** NumPy basics

---

*NumPy & Pandas Handbook — topic 01.*
