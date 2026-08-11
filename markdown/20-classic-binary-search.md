# 20 · Classic Binary Search

> **One-liner:** Halve a sorted search space each step for O(log n) lookup.

---

## 1. Overview

### Definition
The **Classic Binary Search** pattern belongs to the *Binary Search* family. Halve a sorted search space each step for O(log n) lookup.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
binary search, sorted, logn, mid, divide.

### Constraints
- Input size where the brute-force complexity would time out — the Classic Binary Search optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Classic Binary Search invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Classic Binary Search is the upgrade.
- The wording maps onto: binary search, sorted, logn, mid, divide.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Where does this value sit in an ordered space?"*

Running example: `nums = [-1, 0, 3, 5, 9, 12]`, `target = 9`. (Answer: index 4.)

### Intuition
Walk the array from the front and compare each element with the target. Stop at the first match; if you fall off the end, it isn't there.

### Algorithm
1. For `i` from `0` to `n − 1`:
2. &nbsp;&nbsp;If `nums[i] == target`, return `i`.
3. Return `-1`.

### Complexity
- Time: **O(n)** — up to `n` comparisons.
- Space: O(1).

### Drawbacks
- On the running example the scan reads `-1, 0, 3, 5, 9` — five comparisons. But the very first one already told us everything: `-1 < 9`, and the array is **sorted**, so `0` and `3` cannot possibly be 9 either. We compared them anyway.
- Each comparison is thrown away. A comparison against a sorted array carries information about *every* element on both sides of it, and the linear scan uses it only for the single element it touched.
- The cost is not academic: on a million-element array a scan averages 500,000 comparisons where 20 would do.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Compare against the middle: one comparison against a sorted array eliminates half of everything that is left.**

It's how you find a word in a paper dictionary. You don't start at "aardvark" — you open it in the middle, see whether your word sorts before or after, and throw away the half it can't be in. Repeat. A 100,000-word dictionary is exhausted in 17 openings, because each one halves the pile.

### The thought process

```text
We need    : the index of target in a sorted array.
Obvious way: scan from the left.
Too slow   : O(n) — and it ignores the sortedness entirely.
Notice     : if nums[mid] < target, then EVERY index <= mid is also < target.
Therefore  : one comparison rules out half the remaining candidates.
Now        : n -> n/2 -> n/4 -> ... -> 1  is log2(n) steps → O(log n).
```

### Why the half-open range `[lo, hi)` is the invariant to memorise

Binary search is famously easy to get wrong — off-by-ones, infinite loops, `hi = mid` versus `hi = mid - 1`. The cure is to fix **one** convention and never deviate. Throughout chapters 20–24 we use the *half-open* range:

```text
[lo, hi)   means   lo, lo+1, ..., hi-1      (lo included, hi EXCLUDED)
```

Three things follow, and together they make every variant in this family fall out mechanically:

**1. The loop invariant, in words:**

> *If the answer exists at all, it is inside `[lo, hi)`.*

We start with `lo = 0`, `hi = n`, which is the whole array — so the invariant is true at the start. Each iteration only discards indices that the comparison has proved cannot be the answer, so the invariant stays true. When the loop ends, `lo == hi` and the range is empty.

**2. Why `hi = mid` and not `hi = mid - 1`.** Because `hi` is *exclusive*, writing `hi = mid` discards `mid` and everything after it — exactly one half — while keeping the range's meaning unchanged. There is no `-1` to forget. Symmetrically `lo = mid + 1` discards `mid` and everything before it, because `lo` is *inclusive*.

**3. Why the loop terminates.** With `lo < hi`, integer division gives

```text
lo  <=  mid  <  hi
```

`mid` can equal `lo` but can never equal `hi`. So `lo = mid + 1` strictly increases `lo`, and `hi = mid` strictly decreases `hi` (since `mid < hi`). The gap `hi − lo` shrinks by at least 1 every iteration and can never go negative — the loop must end. The classic infinite loop (`hi = mid` paired with a `mid` that rounds *up*) is impossible here because `mid` always rounds **down**.

### Why `mid = lo + (hi - lo) / 2` and not `(lo + hi) / 2`

Mathematically they are the same number. On a machine with fixed-width integers they are not:

```text
32-bit signed int maxes out at 2,147,483,647

lo = 1,500,000,000
hi = 2,000,000,000

(lo + hi)      = 3,500,000,000   → overflows → wraps to a NEGATIVE number
(lo + hi) / 2  = a negative "midpoint" → out-of-bounds index or infinite loop

lo + (hi - lo) / 2:
   hi - lo     =   500,000,000   → fits comfortably
   /2          =   250,000,000
   lo + that   = 1,750,000,000   → correct, and never exceeded hi
```

Because `hi >= lo`, the quantity `hi - lo` is non-negative and no larger than `hi`, so no intermediate value can exceed the largest index — the expression cannot overflow. This is not a hypothetical: the bug sat undetected in Java's `Arrays.binarySearch` for nine years. Python's arbitrary-precision integers make `(lo + hi) // 2` safe there, but write the subtraction form everywhere so the habit survives the language switch.

### Steps

```text
Step 1 → lo = 0, hi = n            (the invariant: answer, if any, is in [lo, hi))
Step 2 → while lo < hi:
Step 3 →     mid = lo + (hi - lo) / 2
Step 4 →     if nums[mid] == target → return mid
Step 5 →     if nums[mid] <  target → lo = mid + 1   (mid and everything left of it is too small)
Step 6 →     else                   → hi = mid       (mid and everything right of it is too big)
Step 7 → return -1                  (range is empty: target is absent)
```

### How should I recognize this?

```text
If you see...
  "sorted array", "O(log n) required", n up to 1e5..1e9,
  a monotonic predicate ("once true, always true"),
  an API you may only call a limited number of times
        ↓
Think about...
  "Can one probe at the middle rule out half the remaining candidates?"
        ↓
Use...
  half-open [lo, hi), mid = lo + (hi-lo)/2
  ├─ exact match wanted      → return on ==, else lo = mid+1 / hi = mid   (this chapter)
  ├─ boundary wanted         → never return early; let lo converge        (chapters 21-24)
  └─ search space is VALUES  → set lo/hi to the value range, not indices
```

### Visual explanation

```svg
<svg viewBox="0 0 620 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-20" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Search 13 in a sorted array: compare a[mid], discard the wrong half</text>
  <rect x="24"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="96"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="81" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="168" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="81" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="240" y="52" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="274" y="81" text-anchor="middle" fill="#1e293b" font-weight="700">7</text>
  <rect x="312" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="346" y="81" text-anchor="middle" fill="#1e293b">9</text>
  <rect x="384" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="81" text-anchor="middle" fill="#1e293b">11</text>
  <rect x="456" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="81" text-anchor="middle" fill="#1e293b">13</text>
  <rect x="528" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="81" text-anchor="middle" fill="#1e293b">15</text>
  <text x="58"  y="124" text-anchor="middle" fill="#64748b" font-weight="700">lo</text>
  <text x="274" y="124" text-anchor="middle" fill="#059669" font-weight="700">mid</text>
  <text x="562" y="124" text-anchor="middle" fill="#64748b" font-weight="700">hi</text>
  <text x="130" y="150" text-anchor="middle" fill="#d97706">discarded half</text>
  <line x1="300" y1="168" x2="470" y2="168" stroke="#475569" marker-end="url(#bs-20)"/>
  <text x="385" y="188" text-anchor="middle" fill="#64748b">a[mid]=7 &lt; 13  →  lo = mid + 1, keep right half</text>
</svg>
```

```text
nums = [-1,  0,  3,  5,  9, 12]      target = 9
index    0   1   2   3   4   5

step 1   [lo=0 ................ hi=6)     mid = 0 + 6/2 = 3
         nums[3] = 5 < 9  →  everything at index <= 3 is too small
                             lo = 4

step 2               [lo=4 ..... hi=6)    mid = 4 + 2/2 = 5
         nums[5] = 12 > 9 →  everything at index >= 5 is too big
                             hi = 5

step 3               [lo=4 hi=5)          mid = 4 + 1/2 = 4
         nums[4] = 9  ==  9  →  return 4  ★

6 candidates → 2 → 1 → done.  3 comparisons instead of 5.
```

### Interview explanation
"The array is sorted, so a single comparison against the middle element tells me which half the target must be in, and I can discard the other half — that's O(log n). I keep a half-open range `[lo, hi)` with the invariant that the answer, if it exists, is always inside it: `lo = mid + 1` when the middle is too small, `hi = mid` when it's too large, and I return immediately on a match. The half-open convention means neither update needs an off-by-one adjustment on `hi`. I compute the midpoint as `lo + (hi-lo)/2` rather than `(lo+hi)/2` so the sum can't overflow on large ranges. The loop terminates because `mid` always rounds down, so `lo <= mid < hi` and the gap strictly shrinks. O(log n) time, O(1) space."

---

## 5. Generic Templates

> Half-open `[lo, hi)`, `mid = lo + (hi-lo)/2`, `lo = mid+1` or `hi = mid`. Memorise this shape once; chapters 21–24 change only the comparison.

```go
// BinarySearch returns an index of target in the sorted slice a, or -1.
// Invariant: if target is present, its index lies in [lo, hi).
func BinarySearch(a []int, target int) int {
    lo, hi := 0, len(a) // half-open: hi is one PAST the last candidate
    for lo < hi {
        mid := lo + (hi-lo)/2 // subtraction form: cannot overflow
        switch {
        case a[mid] == target:
            return mid
        case a[mid] < target:
            lo = mid + 1 // mid and everything before it is too small
        default:
            hi = mid // mid and everything after it is too large
        }
    }
    return -1 // range is empty → absent
}
```

```python
def binary_search(a, target):
    """Index of target in the sorted list a, or -1.
    Invariant: if target is present, its index lies in [lo, hi)."""
    lo, hi = 0, len(a)                 # half-open: hi is one PAST the last candidate
    while lo < hi:
        mid = lo + (hi - lo) // 2      # subtraction form: habit that survives other languages
        if a[mid] == target:
            return mid
        if a[mid] < target:
            lo = mid + 1               # mid and everything before it is too small
        else:
            hi = mid                   # mid and everything after it is too large
    return -1                          # range is empty → absent
```

```java
public class BinarySearchTemplate {
    // Index of target in the sorted array a, or -1.
    public static int binarySearch(int[] a, int target) {
        int lo = 0, hi = a.length;              // half-open [lo, hi)
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;       // cannot overflow
            if (a[mid] == target) return mid;
            if (a[mid] < target) lo = mid + 1;  // too small
            else hi = mid;                      // too large
        }
        return -1;
    }
}
```

```cpp
#include <vector>
using namespace std;

// Index of target in the sorted vector a, or -1.
int binarySearch(const vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size();          // half-open [lo, hi)
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;        // cannot overflow
        if (a[mid] == target) return mid;
        if (a[mid] < target) lo = mid + 1;   // too small
        else hi = mid;                       // too large
    }
    return -1;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Classic Binary Search (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(log n)** |
| Time (best)  | — | **O(log n)** |
| Time (average) | — | **O(log n)** |
| Space | varies | **O(1)** |

> Each step halves the range; iterative form uses constant space.

---

## 7. Common Mistakes

1. Overflow in `(lo+hi)/2` — use `lo + (hi-lo)/2`.
2. Inconsistent interval convention (mixing closed and half-open).
3. Infinite loop when `lo`/`hi` don't make progress.
4. Wrong bias: lower-bound vs upper-bound off by one.
5. Returning `mid` for boundary problems instead of the boundary index.
6. Using `<=` vs `<` incorrectly in the loop condition.
7. Forgetting the array must be sorted (or predicate monotonic).
8. Mishandling all-true or all-false predicate ranges.
9. Searching values when you should search the *answer* space.
10. Not validating the final index against bounds.

---

## 8. Interview Follow-Up Questions

1. **Q: Lower vs upper bound difference?**
   A: Lower: first >= target. Upper: first > target. They bracket equal ranges.

2. **Q: Why half-open intervals?**
   A: They make termination and boundary reasoning uniform.

3. **Q: Binary search on answer — when?**
   A: When you can test feasibility(x) monotonically (minimize-the-max problems).

4. **Q: Rotated sorted array?**
   A: Detect which half is sorted, then search that half.

5. **Q: Find peak without full sort?**
   A: Move toward the ascending slope.

6. **Q: First/last occurrence with duplicates?**
   A: Bias the search left or right after a match.

7. **Q: Count of a value?**
   A: upper_bound - lower_bound.

8. **Q: Floating-point answer?**
   A: Iterate a fixed number of times or until precision epsilon.

9. **Q: 2D sorted matrix?**
   A: Treat as a single sorted list or staircase search.

10. **Q: Why O(log n)?**
   A: Each step discards half the candidates.

11. **Q: Avoid overflow in other languages?**
   A: Use unsigned shifts or wider types.

12. **Q: Predicate not monotonic?**
   A: Binary search doesn't apply; reconsider modeling.

13. **Q: Search insert position?**
   A: That's exactly lower_bound.

14. **Q: Median of two sorted arrays?**
   A: Binary search the partition point.

15. **Q: Off-by-one debugging tip?**
   A: Test arrays of size 0, 1, 2 and all-equal.

---

## 9. Solved Example 1

### Problem — Binary Search (LeetCode 704)
Given a sorted array of distinct integers `nums` and a `target`, return the index of `target`, or `-1` if it is not present. Required complexity: O(log n).

### Thought Process
1. The array is sorted and we want an exact match — the textbook case.
2. Keep the half-open range `[lo, hi)` starting at `[0, n)`, with the invariant *"if the target is in the array, its index is in `[lo, hi)`"*.
3. Probe `mid = lo + (hi-lo)/2`. Equal → done. Smaller → the target must be to the right, so `lo = mid + 1`. Larger → `hi = mid`.
4. Because `hi` is exclusive, `hi = mid` drops `mid` without any `−1` bookkeeping.
5. If the loop ends, `lo == hi`, the range is empty, and the invariant says the target was never there → `-1`.

### Dry Run

Input: `nums = [-1, 0, 3, 5, 9, 12]`, `target = 9`

| step | `lo` | `hi` | `mid = lo+(hi-lo)/2` | `nums[mid]` | vs target | action |
|------|------|------|----------------------|-------------|-----------|--------|
| 1 | 0 | 6 | 0 + 3 = **3** | 5 | 5 < 9 | `lo = 4` (indices 0–3 ruled out) |
| 2 | 4 | 6 | 4 + 1 = **5** | 12 | 12 > 9 | `hi = 5` (index 5 ruled out) |
| 3 | 4 | 5 | 4 + 0 = **4** | 9 | **equal** | return **4** |

Output: **4**

A missing target, `target = 2`: step 1 `mid=3`, `5 > 2` → `hi=3`; step 2 `lo=0,hi=3,mid=1`, `0 < 2` → `lo=2`; step 3 `lo=2,hi=3,mid=2`, `3 > 2` → `hi=2`; now `lo == hi == 2`, the range is empty → **−1**.

### Visualization

```text
index      0    1    2    3    4    5
nums     [-1,   0,   3,   5,   9,  12]      target = 9

step 1   [ lo=0 ─────────────────── hi=6 )
                          ↑ mid=3, value 5 < 9
                          discard [0,4)

step 2                      [ lo=4 ─── hi=6 )
                                       ↑ mid=5, value 12 > 9
                                       discard [5,6)

step 3                      [ lo=4  hi=5 )
                              ↑ mid=4, value 9  ★ found

candidates: 6 → 2 → 1
```

### Code

```go
func search(nums []int, target int) int {
    lo, hi := 0, len(nums) // half-open [lo, hi)

    for lo < hi {
        mid := lo + (hi-lo)/2 // subtraction form avoids overflow
        if nums[mid] == target {
            return mid
        }
        if nums[mid] < target {
            lo = mid + 1 // mid and everything left of it is too small
        } else {
            hi = mid // mid and everything right of it is too large
        }
    }
    return -1 // empty range → target absent
}
```

```python
def search(nums, target):
    lo, hi = 0, len(nums)              # half-open [lo, hi)

    while lo < hi:
        mid = lo + (hi - lo) // 2      # subtraction form avoids overflow
        if nums[mid] == target:
            return mid
        if nums[mid] < target:
            lo = mid + 1               # left half ruled out
        else:
            hi = mid                   # right half ruled out

    return -1                          # empty range → absent
```

### Complexity
Time **O(log n)** — the candidate count goes `n → n/2 → n/4 → …`, so at most `⌈log₂ n⌉ + 1` iterations. Space **O(1)** — two indices, no recursion.

---

## 10. Solved Example 2

### Problem — Guess Number (LeetCode 374)
A number is picked in `[1, n]`. The API `guess(num)` returns `-1` if your guess is **too high**, `1` if it is **too low**, and `0` if it is correct. Find the picked number using as few calls as possible.

### Thought Process
1. There is no array here — but the candidate answers `1, 2, …, n` are an ordered space, and `guess` tells you which side of your probe the answer lies on. That is all binary search ever needs.
2. So run the same loop over **values** instead of indices: `[lo, hi) = [1, n+1)`. The `+1` is because `n` itself is a legal answer and `hi` is exclusive.
3. `guess(mid) == 0` → return `mid`. `== -1` (too high) → the pick is below `mid`, so `hi = mid`. `== 1` (too low) → `lo = mid + 1`.
4. Read the API's sign convention carefully — inverting it is the single most common way to fail this problem.
5. `n` can be as large as 2³¹ − 1, so the overflow-safe midpoint is mandatory, not optional.

### Dry Run

Input: `n = 10`, the hidden pick is `7`

| step | `lo` | `hi` | `mid` | `guess(mid)` | meaning | action |
|------|------|------|-------|--------------|---------|--------|
| 1 | 1 | 11 | 1 + 5 = **6** | `1` | 6 is too low | `lo = 7` |
| 2 | 7 | 11 | 7 + 2 = **9** | `-1` | 9 is too high | `hi = 9` |
| 3 | 7 | 9 | 7 + 1 = **8** | `-1` | 8 is too high | `hi = 8` |
| 4 | 7 | 8 | 7 + 0 = **7** | `0` | correct | return **7** |

Output: **7** — four calls to `guess` for a space of ten values.

Step 4 shows why `mid` rounding **down** matters: with `lo = 7, hi = 8`, `mid` must equal `lo`, so the last remaining candidate does get probed. Had `mid` rounded up it would equal `hi`, which is outside the range, and the loop would spin forever.

### Visualization

```text
values   1  2  3  4  5  6  7  8  9  10          pick = 7
         [lo=1 ───────────────────── hi=11)
                        ↑ mid=6  "too low"   → lo = 7

                        [lo=7 ────── hi=11)
                                 ↑ mid=9  "too high"  → hi = 9

                        [lo=7 ─ hi=9)
                              ↑ mid=8  "too high"  → hi = 8

                        [lo=7 hi=8)
                         ↑ mid=7  ★ correct

the "array" is the value range itself — binary search never required one
```

### Code

```go
// pick and guess model the API LeetCode provides, so this example runs standalone.
var pick int

func guess(num int) int {
    switch {
    case num == pick:
        return 0
    case num > pick:
        return -1 // too high
    default:
        return 1 // too low
    }
}

func guessNumber(n int) int {
    lo, hi := 1, n+1 // half-open over VALUES: n itself must stay reachable

    for lo < hi {
        mid := lo + (hi-lo)/2 // n can be 2^31-1: the subtraction form is required
        switch guess(mid) {
        case 0:
            return mid
        case -1:
            hi = mid // mid is too high → the pick is strictly below it
        default:
            lo = mid + 1 // mid is too low → the pick is strictly above it
        }
    }
    return -1 // unreachable for a valid pick
}
```

```python
def guessNumber(n):
    lo, hi = 1, n + 1                  # half-open over VALUES

    while lo < hi:
        mid = lo + (hi - lo) // 2
        result = guess(mid)            # -1 too high, 1 too low, 0 correct
        if result == 0:
            return mid
        if result == -1:
            hi = mid                   # pick is strictly below mid
        else:
            lo = mid + 1               # pick is strictly above mid

    return -1                          # unreachable for a valid pick
```

### Complexity
Time **O(log n)** — at most `⌈log₂ n⌉ + 1` calls to `guess`; for `n = 2³¹ − 1` that is 31 calls. Space **O(1)**.

---

## 11. Solved Example 3

### Problem — Search Insert (LeetCode 35)
Given a sorted array of distinct integers and a `target`, return the index of `target` if present, otherwise the index at which it should be inserted to keep the array sorted.

### Thought Process
1. Both cases — "found here" and "insert here" — are the same question: **the first index `i` with `nums[i] >= target`**. If the target is present that index holds it; if not, it is the first larger element, which is where the target belongs.
2. So we no longer want an early return on equality. We want `lo` to *converge* on that boundary. This is the shift from chapter 20's exact search to the boundary searches of chapters 21–24.
3. Same skeleton, one changed line: when `nums[mid] < target` the answer is strictly right (`lo = mid + 1`); otherwise `mid` is still a candidate, so `hi = mid` — never `mid − 1`.
4. When the loop ends, `lo == hi` and every index below `lo` was proved `< target` while every index at or above it was proved `>= target`. That is precisely the boundary.
5. A target larger than everything drives `lo` all the way to `n`, which is the correct "append at the end" answer — no special case needed.

### Dry Run

Input: `nums = [1, 3, 5, 6]`, `target = 5`

| step | `lo` | `hi` | `mid` | `nums[mid]` | `nums[mid] < 5`? | action |
|------|------|------|-------|-------------|------------------|--------|
| 1 | 0 | 4 | 0 + 2 = **2** | 5 | no (5 is a candidate) | `hi = 2` |
| 2 | 0 | 2 | 0 + 1 = **1** | 3 | yes (too small) | `lo = 2` |
| 3 | — | — | — | — | `lo == hi == 2` | stop, return **2** |

Output: **2** — and `nums[2] == 5`, so the target was found at that index.

Three more targets on the same array, showing every case:

| target | trace | result | why |
|--------|-------|--------|-----|
| 2 | `hi=2`, `hi=1`, `lo=1` | **1** | insert between 1 and 3 |
| 7 | `lo=3`, `lo=4` | **4** | larger than everything → append at index `n` |
| 0 | `hi=2`, `hi=1`, `hi=0` | **0** | smaller than everything → prepend |

Note step 1: `nums[mid]` *equals* the target and we still do not return. Keeping `mid` as a candidate (`hi = mid`) is what makes this generalise to duplicate values, where the answer must be the **leftmost** match.

### Visualization

```text
nums = [ 1,   3,   5,   6 ]        target = 5
index    0    1    2    3    4 ← insertion position n is legal too

         [lo=0 ─────────── hi=4)
                    ↑ mid=2, nums[2]=5 is NOT < 5 → still a candidate → hi=2

         [lo=0 ─ hi=2)
               ↑ mid=1, nums[1]=3 < 5 → too small → lo=2

         lo == hi == 2   ★ answer

after the loop:      every index < lo  has nums[i] <  target
                     every index >= lo has nums[i] >= target
                                    ↑ that split point IS the answer
```

### Code

```go
func searchInsert(nums []int, target int) int {
    lo, hi := 0, len(nums) // half-open [lo, hi); hi == len is a legal answer

    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] < target {
            lo = mid + 1 // strictly too small → answer is to the right
        } else {
            hi = mid // mid is still a candidate → keep it in range
        }
    }
    return lo // first index with nums[i] >= target
}
```

```python
def searchInsert(nums, target):
    lo, hi = 0, len(nums)              # half-open; hi == len is a legal answer

    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] < target:
            lo = mid + 1               # strictly too small → answer is right
        else:
            hi = mid                   # mid is still a candidate

    return lo                          # first index with nums[i] >= target
```

### Complexity
Time **O(log n)** — the range halves every iteration and the loop never returns early. Space **O(1)**.

> This function is the **lower bound**, and it is the ancestor of the next four chapters: 21 (first occurrence) checks `nums[lo] == target` afterwards, 22 (last occurrence) flips the comparison to `<=` and returns `lo - 1`, and 23/24 study the two bounds in their own right.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 704 | Binary Search | Easy | Core binary search application |
| 374 | Guess Number | Easy | Core binary search application |
| 35 | Search Insert | Medium | Core binary search application |
| 69 | Sqrt | Medium | Core binary search application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Classic search**
- **Lower/upper bound**
- **First/last occurrence**
- **Binary search on answer**
- **Rotated array search**
- **Peak finding**
- **Monotonic predicate search**

---

## 14. Production Engineering Applications

- **Scalability:** Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Classic Binary Search logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Classic Binary Search (Binary Search).
- **Signal:** binary search, sorted, logn, mid, divide.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Classic Binary Search invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Classic Binary Search
FAMILY : Binary Search (Intermediate)
WHEN   : binary search, sorted, logn, mid, divide
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 704, 374, 35, 69
```

---

*Part of the DSA Patterns Handbook — pattern 20 of 100.*
