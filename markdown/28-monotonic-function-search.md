# 28 · Monotonic Function Search

> **One-liner:** Binary search the boundary of a monotonic true/false predicate.

---

## 1. Overview

### Definition
The **Monotonic Function Search** pattern belongs to the *Binary Search* family. Binary search the boundary of a monotonic true/false predicate.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
monotonic, predicate, boolean search, first true, threshold.

### Constraints
- Input size where the brute-force complexity would time out — the Monotonic Function Search optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Monotonic Function Search invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Monotonic Function Search is the upgrade.
- The wording maps onto: monotonic, predicate, boolean search, first true, threshold.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Where does this yes/no question flip from NO to YES?"*

Running example: versions `1 … 7` of a product were released in order. At some point a bug was introduced and every version from then on is bad. You may call `isBad(v)`, which is expensive. Suppose version 5 is the first bad one. Find it with as few calls as possible.

### Intuition
Just walk forward. Ask about version 1, then 2, then 3… and stop at the first `true`.

### Algorithm
1. For `v = 1 .. n`:
2. &nbsp;&nbsp;If `isBad(v)`, return `v`.
3. (The loop always terminates: version `n` is bad by assumption.)

### Complexity
- Time: **O(n)** calls to the predicate — and the predicate is the expensive part (an API call, a test-suite run, a simulation).
- Space: O(1)

### Drawbacks
- With the flip at 5, the scan spends its calls like this:

  ```text
  isBad(1) → false     isBad(2) → false     isBad(3) → false
  isBad(4) → false     isBad(5) → true   ← answer
  ```

  Four calls whose only content is "not yet".
- The fact being ignored: **`isBad(4) == false` already proves versions 1, 2 and 3 are good too.** The answers are one solid block of `false` followed by one solid block of `true`. Walking that block one step at a time is like `git bisect`-ing by checking every commit in order.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Forget arrays. Binary search works on any ordered domain the moment you have a yes/no test whose answers look like `F F F T T T` — and all you are ever doing is locating that one flip.**

This is the general statement that chapters 25 and 27 were special cases of. Once you see it, half the "binary search" problems in the world collapse into the same three lines.

```text
problem                  domain of x    predicate P(x)                answer
─────────────────────────────────────────────────────────────────────────────
lower_bound in a sorted   index          a[x] >= target                first true
first bad version         version no.    isBad(x)                      first true
Koko's eating speed       speed          hours(x) <= h                 first true
minimum ship capacity     capacity       daysNeeded(x) <= days         first true
sqrt(n) to 1e-9           real number    x*x >= n                      boundary
find a peak               index          a peak exists at x or left    first true
```

Notice that the classic "sorted array" case is not special at all — sortedness is simply the thing that makes `a[x] >= target` monotone. The array was never the point.

### The thought process

```text
We need    : the first version that is bad.
Obvious way: ask about every version in order.
Too slow   : O(n) expensive calls.
Notice     : the answers are monotone — once bad, always bad.
Notice too : so asking about ONE version classifies ALL of them relative
             to it:  false ⇒ everything to the left is false
                     true  ⇒ everything to the right is true
Therefore  : ask in the middle, and half the domain is resolved for free.
Now        : O(log n) calls — 30 calls cover a billion versions.
```

### Why monotonicity is the only requirement

Write the predicate's answers along the domain:

```text
x    :  1     2     3     4  │  5     6     7
P(x) :  F     F     F     F  │  T     T     T
                             ↑
                     the flip — the thing we are searching for
```

The bar exists because `P` is **monotone**: `P(x) ⇒ P(x+1)`. That single property is what makes a probe informative:

- `P(mid)` is **true** → every `x > mid` is also true, so nothing to the right can be the *first* true. Discard the right half, but **keep `mid`** — it may be the flip itself. (`hi = mid`)
- `P(mid)` is **false** → every `x < mid` is also false. Discard the left half **and `mid`**. (`lo = mid + 1`)

If `P` were not monotone — say `F T F T` — a probe landing on an `F` would say nothing about either side, and discarding a half could throw the flip away. So the one thing to verify before coding is: *does `P(x)` imply `P(x+1)`?*

Two degenerate cases fall out for free, and they are the usual source of bugs:

```text
all true   (T T T T)  → the loop never moves lo, returns lo = the left edge  ✔
all false  (F F F F)  → lo marches to hi; you must decide what "no flip"
                        means. Search [lo, hi+1] and a return of hi+1 is the
                        honest "nothing satisfies P".
```

### The real-valued case

When the answer is a real number there is no "next" value, so there is no exact flip to land on — you can only trap it in a shrinking bracket:

```text
integer domain : loop while lo < hi          → terminates exactly
real domain    : loop while hi - lo > eps    → terminates at a precision
                 or simply loop a FIXED 100 times (each halves the range,
                 so any starting range is crushed below 1e-30)
```

The fixed-iteration form is preferred in interviews: it cannot infinite-loop on floating-point rounding, and 100 iterations is instant. Everything else — the `hi = mid` / `lo = mid` structure — is identical.

### Steps

```text
Step 1 → Name the domain: what is x? An index, a version, a capacity, a real?
Step 2 → Write P(x) as a boolean, and check out loud: does P(x) imply P(x+1)?
Step 3 → Bracket it: lo definitely-false-or-smallest-legal, hi definitely-true.
Step 4 → while lo < hi:
             mid = lo + (hi-lo)/2
             if P(mid) { hi = mid } else { lo = mid + 1 }
         return lo
Step 5 → If "no x satisfies P" is possible, search up to hi+1 and treat a
         return of hi+1 as "not found".
```

### How should I recognize this?

```text
If you see...
  "first / smallest / minimum x such that <condition>"
  "last / largest x such that <condition>"
  an expensive check with a huge candidate range (versions, capacities, times)
  "find the threshold", "find where it starts failing", "bisect"
        ↓
Think about...
  "Write the condition as P(x). Is it F...F T...T along x?"
        ↓
Use...
  the first-true boundary search
    ├─ first true      → if P(mid): hi = mid   else lo = mid + 1
    ├─ last true       → if P(mid): lo = mid   else hi = mid - 1
    │                    and round mid UP:  mid = lo + (hi-lo+1)/2
    ├─ may not exist   → search [lo, hi+1]; hi+1 back means "none"
    └─ real-valued x   → 100 fixed halvings, or until hi - lo < 1e-9
```

### Visual explanation

```svg
<svg viewBox="0 0 620 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-28" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Monotonic predicate f(x): F...F then T...T — locate the flip</text>
  <rect x="24"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="81" text-anchor="middle" fill="#d97706" font-weight="700">F</text>
  <rect x="96"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="81" text-anchor="middle" fill="#d97706" font-weight="700">F</text>
  <rect x="168" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="81" text-anchor="middle" fill="#d97706" font-weight="700">F</text>
  <rect x="240" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="274" y="81" text-anchor="middle" fill="#d97706" font-weight="700">F</text>
  <rect x="312" y="52" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="346" y="81" text-anchor="middle" fill="#059669" font-weight="700">T</text>
  <rect x="384" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="81" text-anchor="middle" fill="#2563eb" font-weight="700">T</text>
  <rect x="456" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="81" text-anchor="middle" fill="#2563eb" font-weight="700">T</text>
  <rect x="528" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="81" text-anchor="middle" fill="#2563eb" font-weight="700">T</text>
  <text x="58"  y="120" text-anchor="middle" fill="#64748b">x0</text>
  <text x="130" y="120" text-anchor="middle" fill="#64748b">x1</text>
  <text x="202" y="120" text-anchor="middle" fill="#64748b">x2</text>
  <text x="274" y="120" text-anchor="middle" fill="#64748b">x3</text>
  <text x="346" y="120" text-anchor="middle" fill="#64748b">x4</text>
  <text x="418" y="120" text-anchor="middle" fill="#64748b">x5</text>
  <text x="490" y="120" text-anchor="middle" fill="#64748b">x6</text>
  <text x="562" y="120" text-anchor="middle" fill="#64748b">x7</text>
  <line x1="312" y1="44" x2="312" y2="132" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="185" y="150" text-anchor="middle" fill="#d97706">test mid: if false, go right</text>
  <text x="470" y="150" text-anchor="middle" fill="#2563eb">if true, keep mid, go left</text>
  <text x="346" y="172" text-anchor="middle" fill="#059669" font-weight="700">first true = answer</text>
  <line x1="470" y1="188" x2="330" y2="188" stroke="#475569" marker-end="url(#bs-28)"/>
  <line x1="150" y1="188" x2="300" y2="188" stroke="#475569" marker-end="url(#bs-28)"/>
  <text x="310" y="204" text-anchor="middle" fill="#64748b">converge on the F→T boundary in O(log n)</text>
</svg>
```

```text
versions 1..7,  first bad = 5      P(v) = isBad(v)

  v    :  1   2   3   4  │  5   6   7
  P(v) :  F   F   F   F  │  T   T   T
                         ↑ the flip = answer

step 1   lo=1 ───────────────────── hi=7   mid=4   P(4)=F → lo = 5
step 2                     lo=5 ─── hi=7   mid=6   P(6)=T → hi = 6
step 3                     lo=5 hi=6       mid=5   P(5)=T → hi = 5
step 4                     lo=hi=5                 answer = 5

3 predicate calls instead of 5 — and only 30 for a billion versions.
```

### Interview explanation
"I'd model this as a monotone predicate rather than an array search. `isBad(v)` is false for a while and then true forever, so the answers form `F F F T T T` and the problem is just 'find the flip'. Probing the middle resolves half the range in one call: a `true` means the flip is at `mid` or earlier so I keep `mid` and set `hi = mid`; a `false` means it is strictly later so `lo = mid + 1`. That is O(log n) predicate calls and O(1) space. The same skeleton handles minimise-the-maximum problems — the domain becomes candidate answers instead of versions — and for a real-valued answer I'd run a fixed hundred halvings instead of looping to equality."

---

## 5. Generic Templates

> Find the flip. `FirstTrue` returns `hi+1` when nothing satisfies the predicate, so "not found" is never silently wrong.

```go
// FirstTrue returns the smallest x in [lo, hi] with pred(x) == true, or hi+1
// if pred is false everywhere. pred must be monotone: pred(x) implies pred(x+1).
func FirstTrue(lo, hi int, pred func(int) bool) int {
    hi++ // search [lo, hi+1]; hi+1 is the sentinel "no such x"
    for lo < hi {
        mid := lo + (hi-lo)/2
        if pred(mid) {
            hi = mid // mid may be the flip itself — keep it
        } else {
            lo = mid + 1 // everything up to and including mid is false
        }
    }
    return lo
}

// LastTrue returns the largest x in [lo, hi] with pred(x) == true, or lo-1 if
// pred is false everywhere. pred must be monotone the other way:
// true...true false...false.
func LastTrue(lo, hi int, pred func(int) bool) int {
    lo-- // search [lo-1, hi]; lo-1 is the sentinel "no such x"
    for lo < hi {
        mid := lo + (hi-lo+1)/2 // round UP, or lo == mid stalls the loop
        if pred(mid) {
            lo = mid
        } else {
            hi = mid - 1
        }
    }
    return lo
}

// BoundaryReal brackets the flip of a monotone real-valued predicate.
// A fixed iteration count cannot loop forever on floating-point rounding;
// each pass halves the bracket, so 100 passes crush any range below 1e-30.
func BoundaryReal(lo, hi float64, pred func(float64) bool) float64 {
    for i := 0; i < 100; i++ {
        mid := lo + (hi-lo)/2
        if pred(mid) {
            hi = mid
        } else {
            lo = mid
        }
    }
    return hi
}
```

```python
def first_true(lo, hi, pred):
    """Smallest x in [lo, hi] with pred(x), or hi+1 if none. pred is F...F T...T."""
    hi += 1                             # hi+1 is the "no such x" sentinel
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if pred(mid):
            hi = mid                    # mid may be the flip itself
        else:
            lo = mid + 1                # everything through mid is false
    return lo


def last_true(lo, hi, pred):
    """Largest x in [lo, hi] with pred(x), or lo-1 if none. pred is T...T F...F."""
    lo -= 1                             # lo-1 is the "no such x" sentinel
    while lo < hi:
        mid = lo + (hi - lo + 1) // 2   # round UP or the loop stalls
        if pred(mid):
            lo = mid
        else:
            hi = mid - 1
    return lo


def boundary_real(lo, hi, pred):
    """Bracket the flip of a monotone real-valued predicate."""
    for _ in range(100):                # each pass halves the bracket
        mid = lo + (hi - lo) / 2
        if pred(mid):
            hi = mid
        else:
            lo = mid
    return hi
```

```java
import java.util.function.DoublePredicate;
import java.util.function.IntPredicate;

public class BoundarySearch {
    /** Smallest x in [lo, hi] with pred(x), or hi+1 if none. */
    public static int firstTrue(int lo, int hi, IntPredicate pred) {
        hi++;                                   // "no such x" sentinel
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (pred.test(mid)) hi = mid;       // mid may be the flip
            else lo = mid + 1;                  // everything through mid is false
        }
        return lo;
    }

    /** Largest x in [lo, hi] with pred(x), or lo-1 if none. */
    public static int lastTrue(int lo, int hi, IntPredicate pred) {
        lo--;                                   // "no such x" sentinel
        while (lo < hi) {
            int mid = lo + (hi - lo + 1) / 2;   // round UP or the loop stalls
            if (pred.test(mid)) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Bracket the flip of a monotone real-valued predicate. */
    public static double boundaryReal(double lo, double hi, DoublePredicate pred) {
        for (int i = 0; i < 100; i++) {         // each pass halves the bracket
            double mid = lo + (hi - lo) / 2;
            if (pred.test(mid)) hi = mid;
            else lo = mid;
        }
        return hi;
    }
}
```

```cpp
#include <functional>

// Smallest x in [lo, hi] with pred(x), or hi+1 if none.
int firstTrue(int lo, int hi, const std::function<bool(int)>& pred) {
    ++hi;                                   // "no such x" sentinel
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (pred(mid)) hi = mid;            // mid may be the flip
        else lo = mid + 1;                  // everything through mid is false
    }
    return lo;
}

// Largest x in [lo, hi] with pred(x), or lo-1 if none.
int lastTrue(int lo, int hi, const std::function<bool(int)>& pred) {
    --lo;                                   // "no such x" sentinel
    while (lo < hi) {
        int mid = lo + (hi - lo + 1) / 2;   // round UP or the loop stalls
        if (pred(mid)) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

// Bracket the flip of a monotone real-valued predicate.
double boundaryReal(double lo, double hi, const std::function<bool(double)>& pred) {
    for (int i = 0; i < 100; ++i) {         // each pass halves the bracket
        double mid = lo + (hi - lo) / 2;
        if (pred(mid)) hi = mid;
        else lo = mid;
    }
    return hi;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Monotonic Function Search (Optimal) |
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

### Problem — First Bad Version (LeetCode 278)
Versions `1 … n` were released in order; from some version onward every one is bad. Given the API `isBadVersion(v)`, find the first bad version with the fewest calls.

### Thought Process
1. Name the predicate: `P(v) = isBadVersion(v)`. The domain is the version numbers `1 … n`.
2. Check monotonicity out loud: once a bug exists it is never un-introduced, so `P(v) ⇒ P(v+1)`. The answers are `F…F T…T`.
3. So the answer is the flip, and a probe at `mid` classifies half the range for free.
4. `P(mid)` true → the flip is `mid` or earlier, so `hi = mid` (keep `mid`, it might be it). False → the flip is strictly later, so `lo = mid + 1`.
5. The problem guarantees at least one bad version, so no "not found" sentinel is needed.

### Dry Run

Input: `n = 7`, first bad version is **5** (so `isBadVersion` is `F F F F T T T`)

| step | lo | hi | mid | isBadVersion(mid) | reasoning | move |
|------|----|----|-----|-------------------|-----------|------|
| 1 | 1 | 7 | 4 | false | 1–4 are all good | `lo = 5` |
| 2 | 5 | 7 | 6 | true | flip is at 6 or earlier | `hi = 6` |
| 3 | 5 | 6 | 5 | true | flip is at 5 or earlier | `hi = 5` |
| 4 | 5 | 5 | — | loop ends, `lo == hi` | | return **5** |

Output: **5**  (3 API calls instead of 5)

Rows 2 and 3 show the rule people get wrong. Both probes return `true`, yet neither returns `mid` on the spot — a `true` only proves *no later version* is the first bad one, never that `mid` itself is. `hi = mid` keeps `mid` alive as a candidate; only `lo == hi` proves the flip has been pinned down.

### Visualization

```text
version :  1    2    3    4  │  5    6    7
isBad   :  F    F    F    F  │  T    T    T
                             ↑ first true = 5

step 1   lo=1 ─────────── mid=4 ─────────── hi=7    F → the flip is right
step 2                          lo=5 mid=6  hi=7    T → the flip is here or left
step 3                          lo=5 mid=5 hi=6     T → the flip is here or left
step 4                          lo=hi=5             answer = 5 ✓

range: 7 → 3 → 2 → 1
```

### Code

```go
// LeetCode supplies isBadVersion as an ambient API; taking it as a parameter
// keeps this self-contained and makes the predicate explicit.
func firstBadVersion(n int, isBadVersion func(int) bool) int {
    lo, hi := 1, n
    for lo < hi {
        mid := lo + (hi-lo)/2 // lo + (hi-lo)/2, not (lo+hi)/2: no overflow
        if isBadVersion(mid) {
            hi = mid // mid may itself be the first bad one — keep it
        } else {
            lo = mid + 1 // mid is good, so are all before it
        }
    }
    return lo // lo == hi == the flip
}
```

```python
def firstBadVersion(n, isBadVersion):
    lo, hi = 1, n
    while lo < hi:
        mid = lo + (hi - lo) // 2       # no overflow, unlike (lo + hi) // 2
        if isBadVersion(mid):
            hi = mid                    # mid may BE the first bad version
        else:
            lo = mid + 1                # mid is good, so is everything before
    return lo                           # lo == hi == the flip
```

### Complexity
Time O(log n) predicate calls — about 30 for a billion versions. Space O(1).

## 10. Solved Example 2

### Problem — Kth Missing Positive Number (LeetCode 1539)
Given a strictly increasing array `arr` of positive integers, return the `k`-th positive integer that is **missing** from it.

### Thought Process
1. The trick is finding a monotone quantity. Define `missing(i) = arr[i] - (i + 1)`: how many positive integers are absent *before* `arr[i]`.
2. Why that formula: by index `i` the array has supplied `i+1` numbers, but `arr[i]` itself is the `arr[i]`-th positive integer — the gap between them is exactly the count of skipped numbers.
3. `missing` is non-decreasing (the array is strictly increasing), so `P(i) = missing(i) >= k` is `F…F T…T`. Find the first true.
4. After the loop, `lo` = how many array elements sit *below* the k-th missing number.
5. So the answer is `k + lo`: the k-th missing number has `k-1` missing numbers and `lo` present numbers beneath it, making it the `(k + lo)`-th positive integer.

### Dry Run

Input: `arr = [2, 3, 4, 7, 11]`, `k = 5`

First, the derived table (verify this by hand — it is the whole algorithm):

| i | arr[i] | i + 1 | missing(i) = arr[i] − (i+1) |
|---|--------|-------|------------------------------|
| 0 | 2 | 1 | **1** (missing: 1) |
| 1 | 3 | 2 | **1** |
| 2 | 4 | 3 | **1** |
| 3 | 7 | 4 | **3** (missing: 1, 5, 6) |
| 4 | 11 | 5 | **6** (missing: 1, 5, 6, 8, 9, 10) |

Now the search for the first `i` with `missing(i) >= 5`, over the half-open range `[0, 5)`:

| step | lo | hi | mid | missing(mid) | ≥ 5 ? | move |
|------|----|----|-----|--------------|-------|------|
| 1 | 0 | 5 | 2 | 1 | no | `lo = 3` |
| 2 | 3 | 5 | 4 | 6 | yes | `hi = 4` |
| 3 | 3 | 4 | 3 | 3 | no | `lo = 4` |
| 4 | 4 | 4 | — | loop ends | | `lo = 4` |

Answer = `k + lo` = `5 + 4` = **9**

Check by hand: the missing positives are 1, 5, 6, 8, **9**, 10, 12… — the 5th is indeed 9. And `lo = 4` is right: exactly four array elements (2, 3, 4, 7) lie below 9.

### Visualization

```text
positives :  1   2   3   4   5   6   7   8   9  10  11
arr has   :      ●   ●   ●           ●              ●
missing   :  ✗           ✗   ✗   ✗       ✗   ✗   ✗
count     :  1           2   3       4   5              ← k = 5 lands on 9

index i   :  0   1   2   3   4
missing(i):  1   1   1   3   6
P(i)=≥5   :  F   F   F   F   T
                             ↑ lo = 4    answer = k + lo = 9
```

### Code

```go
func findKthPositive(arr []int, k int) int {
    // missing(i) = arr[i] - (i+1) = how many positives are absent before arr[i].
    // Non-decreasing because arr is strictly increasing, so P(i) = missing(i)>=k
    // is monotone and we can binary search the flip.
    lo, hi := 0, len(arr) // half-open [lo, hi); hi == len(arr) means "past the end"
    for lo < hi {
        mid := lo + (hi-lo)/2
        if arr[mid]-(mid+1) < k {
            lo = mid + 1 // fewer than k missing up to mid — go right
        } else {
            hi = mid // mid may be the first index with >= k missing
        }
    }
    // lo array elements lie below the answer, plus k-1 missing ones below it,
    // so the answer is the (k + lo)-th positive integer.
    return k + lo
}
```

```python
def findKthPositive(arr, k):
    # missing(i) = arr[i] - (i+1) counts positives absent before arr[i];
    # it is non-decreasing, so "missing(i) >= k" is F...F T...T.
    lo, hi = 0, len(arr)               # half-open; hi == len(arr) means past end
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if arr[mid] - (mid + 1) < k:
            lo = mid + 1               # fewer than k missing up to mid
        else:
            hi = mid                   # mid may be the first index with >= k
    # lo present numbers sit below the answer, plus k-1 missing ones.
    return k + lo
```

### Complexity
Time O(log n) — a pure boundary search; the `missing` values are computed on the fly, never materialised. Space O(1). (The naive walk over the positives is O(n + k).)

## 11. Solved Example 3

### Problem — Minimum Time to Complete Trips (LeetCode 2187)
Bus `i` takes `time[i]` minutes per trip and runs continuously. Return the minimum number of minutes needed for the fleet to complete `totalTrips` trips in total.

### Thought Process
1. Here the domain is not an index at all — it is *time*, a candidate answer. This is chapter 25's move stated in chapter 28's language.
2. In `t` minutes bus `i` finishes `t / time[i]` trips (integer division), so `tripsBy(t) = Σ t / time[i]`.
3. `P(t) = tripsBy(t) >= totalTrips` is monotone: more time never produces fewer trips. `F…F T…T` again.
4. Bracket it: `lo = 1` (any answer is at least one minute) and `hi = min(time) * totalTrips` — the fastest bus alone could do every trip in that long, so `P(hi)` is certainly true.
5. First-true search over `[1, hi]`.

### Dry Run

Input: `time = [1, 2, 3]`, `totalTrips = 5` → range `[1, 1 × 5] = [1, 5]`

| step | lo | hi | mid (t) | trips = ⌊t/1⌋ + ⌊t/2⌋ + ⌊t/3⌋ | ≥ 5 ? | move |
|------|----|----|---------|----------------------------------|-------|------|
| 1 | 1 | 5 | 3 | 3 + 1 + 1 = **5** | yes | `hi = 3` |
| 2 | 1 | 3 | 2 | 2 + 1 + 0 = **3** | no | `lo = 3` |
| 3 | 3 | 3 | — | loop ends, `lo == hi` | | return **3** |

Output: **3**

Row 2 shows the integer-division cliff that makes brute-forcing `t` pointless: between `t = 2` and `t = 3` the trip count jumps from 3 to 5, skipping 4 entirely. The predicate handles this without comment — it only ever asks "enough or not?", never "exactly how many?".

### Visualization

```text
t          :  1    2    3    4    5
bus(1 min) :  1    2    3    4    5
bus(2 min) :  0    1    1    2    2
bus(3 min) :  0    0    1    1    1
             ───────────────────────
total trips:  1    3    5    7    8
P(t) >= 5  :  F    F    T    T    T
                       ↑ first true = 3 = answer

step 1   lo=1 ─────── mid=3 ─────── hi=5    5 >= 5  T → hi = 3
step 2   lo=1 mid=2   hi=3                  3 >= 5  F → lo = 3
step 3            lo=hi=3                            answer = 3 ✓
```

### Code

```go
func minimumTime(time []int, totalTrips int) int {
    // P(t): can the fleet finish totalTrips within t minutes?
    // Monotone: more time never yields fewer trips.
    enough := func(t int) bool {
        trips := 0
        for _, x := range time {
            trips += t / x // whole trips bus x completes in t minutes
            if trips >= totalTrips {
                return true // early exit: the sum only grows
            }
        }
        return trips >= totalTrips
    }

    fastest := time[0]
    for _, x := range time {
        fastest = min(fastest, x)
    }

    lo, hi := 1, fastest*totalTrips // the fastest bus alone could do it all
    for lo < hi {
        mid := lo + (hi-lo)/2
        if enough(mid) {
            hi = mid // this much time works; try less
        } else {
            lo = mid + 1 // not enough time, nor is anything shorter
        }
    }
    return lo
}
```

```python
def minimumTime(time, totalTrips):
    def enough(t):
        """Can the fleet finish totalTrips within t minutes? Monotone in t."""
        return sum(t // x for x in time) >= totalTrips

    lo, hi = 1, min(time) * totalTrips   # fastest bus alone could do it all
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if enough(mid):
            hi = mid                     # this much time works; try less
        else:
            lo = mid + 1                 # not enough, nor is anything shorter
    return lo
```

### Complexity
Time O(n · log(min(time) · totalTrips)) — one O(n) predicate evaluation per halving. Space O(1). Enumerating every minute would be O(min(time) · totalTrips), which is up to 10¹⁴.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 278 | First Bad Version | Easy | Core binary search application |
| 1539 | Kth Missing | Easy | Core binary search application |
| 2187 | Min Time Trips | Medium | Core binary search application |
| 774 | Min Gas | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Monotonic Function Search logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Monotonic Function Search (Binary Search).
- **Signal:** monotonic, predicate, boolean search, first true, threshold.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Monotonic Function Search invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Monotonic Function Search
FAMILY : Binary Search (Advanced)
WHEN   : monotonic, predicate, boolean search, first true, threshold
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 278, 1539, 2187, 774
```

---

*Part of the DSA Patterns Handbook — pattern 28 of 100.*
