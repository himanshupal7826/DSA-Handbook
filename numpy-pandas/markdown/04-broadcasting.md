# 04 · Broadcasting

> **In one line:** Operate on different-shaped arrays without copying.

---

## 1. Overview

**Broadcasting** lets NumPy combine arrays of different shapes by virtually stretching dimensions of size 1 — no data is copied. It powers concise, memory-efficient operations like normalizing rows or computing outer products.

## 2. Key Concepts

- Align shapes from the right; dims must be equal or 1.
- Size-1 dimensions stretch to match.
- np.newaxis/reshape adds axes to enable broadcasting.
- No actual data duplication — it's virtual.
- Mismatched, non-1 dims raise a broadcast error.

## 3. Syntax & Code

```python
A = np.arange(6).reshape(2, 3)   # (2,3)
col = np.array([10, 20])         # (2,)
result = A + col[:, np.newaxis]  # (2,1) broadcasts to (2,3)
```

## 4. Worked Example

**Normalize each row**

Subtract per-row mean using broadcasting:

```python
X = np.random.rand(100, 5)
Xn = X - X.mean(axis=1, keepdims=True)   # (100,1) broadcasts over (100,5)
```

## 5. Best Practices

- ✅ Use keepdims=True to keep broadcastable shapes.
- ✅ Add axes with np.newaxis/reshape deliberately.
- ✅ Prefer broadcasting over tiling (saves memory).
- ✅ Verify shapes when results look wrong.
- ✅ Use outer broadcasting for pairwise computations.

## 6. Common Pitfalls

1. ⚠️ Shape mismatch errors from misaligned dims.
2. ⚠️ Forgetting keepdims, breaking the broadcast.
3. ⚠️ Unintended broadcasting producing huge arrays (memory blowup).
4. ⚠️ Assuming row vs column vector orientation.
5. ⚠️ Silent wrong results when shapes broadcast unexpectedly.
6. ⚠️ Confusing (n,) with (n,1).

## 7. Interview Questions

1. **Q: What is broadcasting?**
   A: Implicitly stretching size-1 dimensions so arrays of different shapes can be combined without copying.

2. **Q: Broadcasting rules?**
   A: Align shapes from the right; each dim must be equal or one of them is 1.

3. **Q: Why keepdims=True?**
   A: Retains reduced axes as size-1 so the result broadcasts back over the original.

4. **Q: How to add an axis?**
   A: np.newaxis or reshape, e.g., v[:, np.newaxis].

5. **Q: Does broadcasting copy data?**
   A: No — it's virtual; memory isn't duplicated.

6. **Q: (n,) vs (n,1)?**
   A: 1D vs a 2D column vector — orientation changes how broadcasting aligns.

7. **Q: Risk of accidental broadcasting?**
   A: Creating a huge result array (e.g., (n,1) op (1,m) → (n,m)).

8. **Q: Outer product via broadcasting?**
   A: a[:, None] * b[None, :].

## 8. Practice

- [ ] Add a per-column offset via broadcasting.
- [ ] Row-normalize a matrix with keepdims.
- [ ] Build a pairwise difference matrix with newaxis.

## 9. Quick Revision

Broadcasting stretches size-1 dims (align from right; equal or 1) without copying. Use keepdims + newaxis to shape things; watch for accidental huge results and (n,) vs (n,1).

**References:** Broadcasting

---

*NumPy & Pandas Handbook — topic 04.*
