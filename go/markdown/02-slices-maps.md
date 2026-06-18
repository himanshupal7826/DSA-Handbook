# 02 · Slices, Arrays & Maps

> **In one line:** Go's core collections and their sharing semantics.

---

## 1. Overview

Arrays are fixed-size; **slices** are growable views over an underlying array (the workhorse). **Maps** are hash tables. Slices share backing storage, so aliasing and `append` growth are common sources of subtle bugs.

## 2. Key Concepts

- A slice has pointer, length, and capacity; reslicing shares the array.
- `append` may reallocate when capacity is exceeded, breaking aliases.
- Maps are unordered; iteration order is randomized.
- `make([]T, len, cap)` preallocates; nil slices/maps behave specially.
- Reading a missing map key returns the zero value + ok=false.

## 3. Syntax & Code

```go
s := make([]int, 0, 4)   // len 0, cap 4
s = append(s, 1, 2, 3)

m := map[string]int{"a": 1}
v, ok := m["b"] // v=0, ok=false
fmt.Println(v, ok)

for k, val := range m { // order is random
    fmt.Println(k, val)
}
```

## 4. Worked Example

**append aliasing gotcha**

Two slices may share memory until a reallocation:

```go
a := []int{1, 2, 3}
b := a[:2]
b = append(b, 99) // overwrites a[2] if cap allows!
fmt.Println(a)     // [1 2 99]
```

## 5. Best Practices

- ✅ Preallocate with make(..., 0, n) when size is known.
- ✅ Copy slices with `copy` when you need independence.
- ✅ Check map presence with the comma-ok form.
- ✅ Don't rely on map iteration order.
- ✅ Return a fresh slice from functions to avoid aliasing surprises.

## 6. Common Pitfalls

1. ⚠️ append reallocating and silently de-aliasing (or not).
2. ⚠️ Assuming map iteration order is stable.
3. ⚠️ Writing to a nil map panics (reads are fine).
4. ⚠️ Holding a small slice of a huge array keeping it all in memory.
5. ⚠️ Off-by-one in slice expressions a[low:high].
6. ⚠️ Comparing slices/maps with == (not allowed; only nil compare).

## 7. Interview Questions

1. **Q: Slice vs array?**
   A: Array is fixed-size value; slice is a growable reference (pointer+len+cap) over an array.

2. **Q: What does append do on full capacity?**
   A: Allocates a larger backing array and copies, so previous aliases may diverge.

3. **Q: Why randomize map iteration?**
   A: To prevent code from depending on order, which isn't guaranteed.

4. **Q: comma-ok idiom?**
   A: `v, ok := m[k]` distinguishes a present zero value from a missing key.

5. **Q: Can you write to a nil map?**
   A: No — it panics; you must make() it first. Reads return zero values.

6. **Q: How to copy a slice safely?**
   A: Allocate a new slice and use copy(dst, src).

7. **Q: Memory leak from slicing?**
   A: A small sub-slice keeps the whole backing array alive; copy to release it.

8. **Q: Are slices comparable?**
   A: Not with ==; only comparison to nil is allowed.

## 8. Practice

- [ ] Demonstrate an append aliasing bug and fix with copy.
- [ ] Use comma-ok to handle missing keys.
- [ ] Preallocate a slice for known size and benchmark.

## 9. Quick Revision

Slices = pointer+len+cap views (share + may realloc on append); maps = unordered hash tables (comma-ok, nil-write panics). Preallocate, copy for independence, don't depend on order.

**References:** Go blog: Slices

---

*Go Handbook — topic 02.*
