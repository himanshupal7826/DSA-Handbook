# 25 · Binary Search on Answer

> **One-liner:** Binary search the answer value, using a feasibility check as the predicate.

---

## 1. Overview

### Definition
The **Binary Search on Answer** pattern belongs to the *Binary Search* family. Binary search the answer value, using a feasibility check as the predicate.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
binary search answer, minimize maximum, feasible, parametric, capacity.

### Constraints
- Input size where the brute-force complexity would time out — the Binary Search on Answer optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Binary Search on Answer invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Binary Search on Answer is the upgrade.
- The wording maps onto: binary search answer, minimize maximum, feasible, parametric, capacity.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the smallest (or largest) value that still works?"*

Running example: Koko has piles `[3, 6, 7, 11]` and `h = 8` hours. She eats at some integer speed `k` bananas/hour and can only work on one pile per hour. What is the **slowest** speed that still empties every pile within 8 hours?

### Intuition
There is no array to search here — the answer is a *number* we have to invent. So invent them all: try `k = 1`, then `k = 2`, then `k = 3`… and stop at the first speed that finishes in time. Checking one speed is easy: add up `ceil(pile / k)` over the piles and compare with `h`.

### Algorithm
1. For `k = 1, 2, 3, … max(piles)`:
2. &nbsp;&nbsp;Compute `hours = ceil(3/k) + ceil(6/k) + ceil(7/k) + ceil(11/k)`.
3. &nbsp;&nbsp;If `hours <= h`, return `k`.
4. The loop always ends: `k = max(piles)` needs exactly one hour per pile.

### Complexity
- Time: **O(n · maxPile)** — one full O(n) scan per candidate speed, and there are `maxPile` candidates. With `maxPile` up to 10⁹ that is hopeless.
- Space: O(1)

### Drawbacks
- Look at the candidates we actually test for `[3,6,7,11], h=8`:

  ```text
  k = 1 → 27 hours   too slow
  k = 2 → 14 hours   too slow
  k = 3 → 10 hours   too slow
  k = 4 →  8 hours   FITS  ← answer
  ```

  Three full scans were spent proving "still too slow", and each one only ruled out **one** speed.
- The fact being thrown away is huge: **if `k = 3` is too slow, then `k = 2` and `k = 1` are too slow as well.** The answers come in a block of `no`s followed by a block of `yes`es, and the brute force walks that block one step at a time instead of jumping to its edge.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Stop searching the array — search the ANSWER. Guess a value `x`, ask a yes/no question `feasible(x)`, and because the yes/no answers form `F F F T T T`, binary search finds the boundary.**

Think of a dimmer switch. You are looking for the lowest brightness at which you can still read. You don't test every notch — you jump to the middle, ask "can I read?", and that single answer eliminates half the dial. It works only because brightness is *monotone*: if you can read at a setting, you can read at every brighter one.

### The thought process

```text
We need    : the smallest eating speed k that finishes within h hours.
Obvious way: try k = 1, 2, 3, ... and stop at the first that fits.
Too slow   : O(n · maxPile); maxPile can be 10^9.
Notice     : "does speed k fit in h hours?" is a cheap O(n) yes/no question.
Notice too : that answer is monotone — faster never hurts, so once it is
             yes, it stays yes forever.
Therefore  : the yes/no array over k looks like  F F F T T T T
             and finding the first T is exactly binary search.
Now        : O(log maxPile) questions × O(n) each → O(n log maxPile).
```

### Why the monotone predicate is the whole problem

Binary search on an answer needs one thing and one thing only: a function

```text
feasible(x) = true  ⟺  an answer of "x" is good enough
```

that is **monotone** — once it flips to true it never flips back:

```text
x        :  1   2   3   4   5   6   7   8   9  10  11
feasible :  F   F   F   T   T   T   T   T   T   T   T
                     ↑
                     the single boundary — that is the answer
```

Everything else is boilerplate. Beginners get this backwards: they memorise the `lo`/`hi`/`mid` loop and then flail at the modelling. Flip it. **Spend your thinking on inventing `feasible`, and copy the loop.**

Why does monotonicity make halving safe? Suppose you test `mid` and get **true**. Because the predicate never flips back, everything to the right of `mid` is also true — so no answer smaller than `mid` lives there. The whole right side can be discarded, keeping `mid` itself because it might be the boundary (`hi = mid`). Suppose instead you get **false**. Then everything to the *left* is also false, so the answer is strictly greater (`lo = mid + 1`). Either way, half the candidates die on one question.

Break monotonicity and the method collapses. If the pattern were `F T F T`, then testing the middle `F` tells you nothing — the answer could be on either side, and discarding a half can throw the answer away. So before you write a single line, sanity-check the claim "if `x` works, does `x + 1` work too?"

### Steps

```text
Step 1 → Decide WHAT you are guessing. It is the quantity the problem asks
         you to minimise or maximise: a speed, a capacity, a time, a length.
Step 2 → Write feasible(x): a plain, honest simulation — usually a greedy
         O(n) pass — returning "is x good enough?". Prove it is monotone.
Step 3 → Pick the search range [lo, hi] so that lo is definitely too small
         (or the smallest legal value) and hi is definitely big enough.
Step 4 → Binary search the boundary:
             while lo < hi:
                 mid = lo + (hi-lo)/2
                 if feasible(mid): hi = mid      // mid might be the answer
                 else:             lo = mid + 1  // mid is provably too small
         return lo
```

### How should I recognize this?

```text
If you see...
  "minimize the maximum ...", "maximize the minimum ..."
  "smallest capacity / speed / time such that ..."
  "the least k so that ... is possible"
  a huge value range (up to 1e9) but a small array (n up to 1e5)
        ↓
Think about...
  "If I were HANDED an answer x, could I check it in O(n)?
   And if x works, does every larger x work too?"
        ↓
Use...
  binary search over the answer range, with feasible(x) as the predicate
    ├─ minimising → find the FIRST true   (mid = lo + (hi-lo)/2,   hi = mid)
    ├─ maximising → find the LAST true    (mid = lo + (hi-lo+1)/2, lo = mid)
    └─ real-valued answer → loop ~100 times, or until hi - lo < 1e-9
```

### Visual explanation

```svg
<svg viewBox="0 0 620 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-25" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Search on the ANSWER: feasible(x) is monotonic — find smallest true x</text>
  <text x="310" y="44" text-anchor="middle" fill="#64748b">candidate answer x  (e.g. min capacity that meets the SLA)</text>
  <rect x="24"  y="56" width="68" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="84" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="96"  y="56" width="68" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="84" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="168" y="56" width="68" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="84" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="240" y="56" width="68" height="46" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="274" y="84" text-anchor="middle" fill="#1e293b" font-weight="700">6</text>
  <rect x="312" y="56" width="68" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="346" y="84" text-anchor="middle" fill="#1e293b">7</text>
  <rect x="384" y="56" width="68" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="84" text-anchor="middle" fill="#1e293b">8</text>
  <rect x="456" y="56" width="68" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="84" text-anchor="middle" fill="#1e293b">9</text>
  <rect x="528" y="56" width="68" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="84" text-anchor="middle" fill="#1e293b">10</text>
  <text x="58"  y="122" text-anchor="middle" fill="#d97706">F</text>
  <text x="130" y="122" text-anchor="middle" fill="#d97706">F</text>
  <text x="202" y="122" text-anchor="middle" fill="#d97706">F</text>
  <text x="274" y="122" text-anchor="middle" fill="#059669" font-weight="700">T</text>
  <text x="346" y="122" text-anchor="middle" fill="#2563eb">T</text>
  <text x="418" y="122" text-anchor="middle" fill="#2563eb">T</text>
  <text x="490" y="122" text-anchor="middle" fill="#2563eb">T</text>
  <text x="562" y="122" text-anchor="middle" fill="#2563eb">T</text>
  <line x1="240" y1="48" x2="240" y2="132" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="150" y="152" text-anchor="middle" fill="#d97706">infeasible (too small)</text>
  <text x="274" y="152" text-anchor="middle" fill="#059669" font-weight="700">answer = 6</text>
  <line x1="470" y1="170" x2="300" y2="170" stroke="#475569" marker-end="url(#bs-25)"/>
  <text x="385" y="190" text-anchor="middle" fill="#64748b">binary search the boundary instead of scanning every x</text>
</svg>
```

```text
piles = [3, 6, 7, 11],  h = 8      answer range k ∈ [1 .. 11]

  k :  1   2   3   4   5   6   7   8   9  10  11
  F :  F   F   F   T   T   T   T   T   T   T   T
                   ↑ first T = answer

step 1   lo=1 ............................. hi=11   mid=6  → 6 hrs ≤ 8  T → hi=6
step 2   lo=1 .............. hi=6                   mid=3  → 10 hrs > 8 F → lo=4
step 3            lo=4 ..... hi=6                   mid=5  → 8 hrs ≤ 8  T → hi=5
step 4            lo=4 . hi=5                       mid=4  → 8 hrs ≤ 8  T → hi=4
step 5            lo=hi=4                           answer = 4

4 questions instead of 11 — and 30 questions would cover a billion.
```

### Interview explanation
"The answer here is a speed, not an array element, so I'll binary search the answer space instead of the input. The key observation is that feasibility is monotone: if Koko finishes in time at speed `k`, she also finishes at any faster speed — so the predicate looks like `F F F T T T` and I just need the first `T`. My predicate is an O(n) pass summing `ceil(pile/k)` and comparing to `h`. I search `k` in `[1, max(piles)]`, keeping `mid` when it's feasible and moving past it when it isn't. That's O(n log max(piles)) time and O(1) space. The only real thinking is the predicate — the loop is boilerplate."

---

## 5. Generic Templates

> Binary search the *value*, not the index. `SmallestFeasible` finds the first true; `LargestFeasible` finds the last true and must round `mid` **up** or it stalls.

```go
// SmallestFeasible returns the smallest x in [lo, hi] with feasible(x) == true.
// feasible must be monotone increasing: false...false true...true.
func SmallestFeasible(lo, hi int, feasible func(int) bool) int {
    for lo < hi {
        mid := lo + (hi-lo)/2 // rounds down
        if feasible(mid) {
            hi = mid // mid may itself be the boundary — keep it
        } else {
            lo = mid + 1 // mid is provably too small — discard it
        }
    }
    return lo
}

// LargestFeasible returns the largest x in [lo, hi] with feasible(x) == true.
// feasible must be monotone decreasing: true...true false...false.
func LargestFeasible(lo, hi int, feasible func(int) bool) int {
    for lo < hi {
        mid := lo + (hi-lo+1)/2 // round UP: with hi == lo+1 a rounded-down
        if feasible(mid) {      // mid equals lo, and lo = mid loops forever
            lo = mid
        } else {
            hi = mid - 1
        }
    }
    return lo
}

// SmallestFeasibleFloat is the real-valued form: no integer boundary exists,
// so run a fixed number of halvings until the range is narrower than eps.
func SmallestFeasibleFloat(lo, hi float64, feasible func(float64) bool) float64 {
    for i := 0; i < 100; i++ { // 100 halvings shrink any range below 1e-30
        mid := lo + (hi-lo)/2
        if feasible(mid) {
            hi = mid
        } else {
            lo = mid
        }
    }
    return hi
}
```

```python
def smallest_feasible(lo, hi, feasible):
    """Smallest x in [lo, hi] with feasible(x); feasible is F...F T...T."""
    while lo < hi:
        mid = lo + (hi - lo) // 2          # rounds down
        if feasible(mid):
            hi = mid                       # mid may be the boundary
        else:
            lo = mid + 1                   # mid is provably too small
    return lo


def largest_feasible(lo, hi, feasible):
    """Largest x in [lo, hi] with feasible(x); feasible is T...T F...F."""
    while lo < hi:
        mid = lo + (hi - lo + 1) // 2      # round UP or the loop stalls
        if feasible(mid):
            lo = mid
        else:
            hi = mid - 1
    return lo


def smallest_feasible_float(lo, hi, feasible):
    """Real-valued answer: halve a fixed number of times instead of exactly."""
    for _ in range(100):
        mid = lo + (hi - lo) / 2
        if feasible(mid):
            hi = mid
        else:
            lo = mid
    return hi
```

```java
import java.util.function.DoublePredicate;
import java.util.function.IntPredicate;

public class AnswerSearch {
    /** Smallest x in [lo, hi] with feasible(x); feasible is F...F T...T. */
    public static int smallestFeasible(int lo, int hi, IntPredicate feasible) {
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;      // rounds down
            if (feasible.test(mid)) hi = mid;  // mid may be the boundary
            else lo = mid + 1;                 // mid is provably too small
        }
        return lo;
    }

    /** Largest x in [lo, hi] with feasible(x); feasible is T...T F...F. */
    public static int largestFeasible(int lo, int hi, IntPredicate feasible) {
        while (lo < hi) {
            int mid = lo + (hi - lo + 1) / 2;  // round UP or the loop stalls
            if (feasible.test(mid)) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Real-valued answer: halve a fixed number of times. */
    public static double smallestFeasibleFloat(double lo, double hi, DoublePredicate feasible) {
        for (int i = 0; i < 100; i++) {
            double mid = lo + (hi - lo) / 2;
            if (feasible.test(mid)) hi = mid;
            else lo = mid;
        }
        return hi;
    }
}
```

```cpp
#include <functional>

// Smallest x in [lo, hi] with feasible(x); feasible is F...F T...T.
int smallestFeasible(int lo, int hi, const std::function<bool(int)>& feasible) {
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;   // rounds down
        if (feasible(mid)) hi = mid;    // mid may be the boundary
        else lo = mid + 1;              // mid is provably too small
    }
    return lo;
}

// Largest x in [lo, hi] with feasible(x); feasible is T...T F...F.
int largestFeasible(int lo, int hi, const std::function<bool(int)>& feasible) {
    while (lo < hi) {
        int mid = lo + (hi - lo + 1) / 2;  // round UP or the loop stalls
        if (feasible(mid)) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

// Real-valued answer: halve a fixed number of times.
double smallestFeasibleFloat(double lo, double hi, const std::function<bool(double)>& feasible) {
    for (int i = 0; i < 100; ++i) {
        double mid = lo + (hi - lo) / 2;
        if (feasible(mid)) hi = mid;
        else lo = mid;
    }
    return hi;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Binary Search on Answer (Optimal) |
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

### Problem — Koko Bananas (LeetCode 875)
Koko eats bananas at some integer speed `k` per hour and works on only one pile per hour (leftovers of a pile wait for the next hour). Return the **smallest** `k` that empties all piles within `h` hours.

### Thought Process
1. The answer is a *speed*, not an array element — so the thing to search is the range of possible speeds, `[1, max(piles)]`.
2. `feasible(k)` = "does speed `k` finish in time?" = `Σ ceil(pile/k) <= h`. That is one honest O(n) pass.
3. It is monotone: eating faster never costs more hours, so `feasible` is `F…F T…T` in `k`.
4. So find the **first true** — keep `mid` when feasible (`hi = mid`), skip past it when not (`lo = mid + 1`).
5. `k = max(piles)` always works (one pile per hour), so the range is guaranteed to contain a true.

### Dry Run

Input: `piles = [3, 6, 7, 11]`, `h = 8` → search `k` in `[1, 11]`

| step | lo | hi | mid | hours = ceil(3/mid)+ceil(6/mid)+ceil(7/mid)+ceil(11/mid) | ≤ 8 ? | move |
|------|----|----|-----|------------------------------------------------------------|-------|------|
| 1 | 1 | 11 | 6 | 1 + 1 + 2 + 2 = **6** | yes | `hi = 6` |
| 2 | 1 | 6 | 3 | 1 + 2 + 3 + 4 = **10** | no | `lo = 4` |
| 3 | 4 | 6 | 5 | 1 + 2 + 2 + 3 = **8** | yes | `hi = 5` |
| 4 | 4 | 5 | 4 | 1 + 2 + 2 + 3 = **8** | yes | `hi = 4` |
| 5 | 4 | 4 | — | loop ends, `lo == hi` | — | return `lo` |

Output: **4**

Row 4 is the one that matters: `mid = 4` is feasible, yet we do **not** return it — we set `hi = mid`, because a speed of 4 might still not be the *smallest* feasible one. Only when `lo == hi` has the boundary been pinned down. Row 3 shows the mirror rule: `mid = 5` was feasible too, so 5 was never a candidate for "smallest" once 4 survived.

### Visualization

```text
k        :  1    2    3    4    5    6    7    8    9   10   11
hours    : 27   14   10    8    8    6    6    5    5    4    4
feasible :  F    F    F    T    T    T    T    T    T    T    T
                       ↑
                    first T = 4 = answer

lo/hi walk:
  1 ─────────────────────────────────────────────── 11    mid=6  T
  1 ─────────────────── 6                                  mid=3  F
              4 ─────── 6                                  mid=5  T
              4 ─── 5                                      mid=4  T
              4                                            done → 4
```

### Code

```go
func minEatingSpeed(piles []int, h int) int {
    // feasible(k): can Koko finish every pile within h hours at speed k?
    // Monotone: a larger k never needs more hours.
    feasible := func(k int) bool {
        hours := 0
        for _, p := range piles {
            hours += (p + k - 1) / k // ceil(p / k) with integer math
        }
        return hours <= h
    }

    lo, hi := 1, 1
    for _, p := range piles {
        hi = max(hi, p) // speed max(piles) clears one pile per hour
    }

    for lo < hi { // find the first k where feasible(k) is true
        mid := lo + (hi-lo)/2
        if feasible(mid) {
            hi = mid // mid works, but something slower might too
        } else {
            lo = mid + 1 // mid is too slow, and so is everything below it
        }
    }
    return lo
}
```

```python
def minEatingSpeed(piles, h):
    def feasible(k):
        """Can Koko finish within h hours at speed k? Monotone in k."""
        hours = sum((p + k - 1) // k for p in piles)   # ceil(p / k)
        return hours <= h

    lo, hi = 1, max(piles)          # speed max(piles) clears a pile per hour
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if feasible(mid):
            hi = mid                # mid works; something slower might too
        else:
            lo = mid + 1            # mid too slow, and so is everything below
    return lo
```

### Complexity
Time O(n · log(max(piles))) — about 30 feasibility questions for a billion-wide range, each an O(n) scan. Space O(1) — only `lo`, `hi`, `mid` and a running sum.

## 10. Solved Example 2

### Problem — Ship Within Days (LeetCode 1011)
Packages must be shipped **in the given order**. Each day the ship carries a prefix of the remaining packages whose total weight fits its capacity. Return the smallest capacity that ships everything within `days` days.

### Thought Process
1. The answer is a *capacity*. Search the range `[max(weights), sum(weights)]`: it must at least fit the heaviest package, and one day carrying everything always works.
2. `feasible(cap)` = greedily pack: keep adding packages to today until the next one would overflow `cap`, then start a new day. Feasible if `daysUsed <= days`.
3. Greedy packing is optimal here because the order is fixed — delaying a package that still fits can never reduce the day count.
4. Monotone: a bigger ship fits at least as much per day, so it never needs more days.
5. First-true search again.

### Dry Run

Input: `weights = [3,2,2,4,1,4]`, `days = 3` → search `cap` in `[4, 16]`

| step | lo | hi | mid (cap) | greedy packing | days used | ≤ 3 ? | move |
|------|----|----|-----------|----------------|-----------|-------|------|
| 1 | 4 | 16 | 10 | `[3,2,2] [4,1,4]` | 2 | yes | `hi = 10` |
| 2 | 4 | 10 | 7 | `[3,2,2] [4,1] [4]` | 3 | yes | `hi = 7` |
| 3 | 4 | 7 | 5 | `[3,2] [2] [4,1] [4]` | 4 | no | `lo = 6` |
| 4 | 6 | 7 | 6 | `[3,2] [2,4] [1,4]` | 3 | yes | `hi = 6` |
| 5 | 6 | 6 | — | loop ends, `lo == hi` | — | — | return `lo` |

Output: **6**

Row 3 is the instructive one. Capacity 5 fails not because the total is too big but because the *fixed order* forces a bad split: `[3,2]` fills the day, then the lone `2` cannot be joined by the `4`. One unit more of capacity (row 4) lets `[2,4]` ride together and the day count drops from 4 to 3.

### Visualization

```text
weights = 3  2  2  4  1  4        days allowed = 3

cap = 5   | 3 2 | 2 | 4 1 | 4 |          → 4 days  ✗
cap = 6   | 3 2 | 2 4 | 1 4 |            → 3 days  ✓   ← smallest that fits
cap = 7   | 3 2 2 | 4 1 | 4 |            → 3 days  ✓
cap = 10  | 3 2 2 | 4 1 4 |              → 2 days  ✓

cap      :  4    5    6    7   ...  16
feasible :  F    F    T    T   ...   T
                      ↑ first T
```

### Code

```go
func shipWithinDays(weights []int, days int) int {
    // feasible(cap): can we ship in order within `days` using capacity cap?
    // Monotone: a larger cap never needs more days.
    feasible := func(cap int) bool {
        used, load := 1, 0
        for _, w := range weights {
            if load+w > cap { // today is full — open a new day
                used++
                load = 0
            }
            load += w
        }
        return used <= days
    }

    lo, hi := 0, 0
    for _, w := range weights {
        lo = max(lo, w) // must fit the heaviest package on its own
        hi += w         // one day carrying everything always works
    }

    for lo < hi { // first capacity that is big enough
        mid := lo + (hi-lo)/2
        if feasible(mid) {
            hi = mid // this ship suffices; try a smaller one
        } else {
            lo = mid + 1 // too small, and so is anything below
        }
    }
    return lo
}
```

```python
def shipWithinDays(weights, days):
    def feasible(cap):
        """Greedily fill each day; monotone in cap."""
        used, load = 1, 0
        for w in weights:
            if load + w > cap:      # today is full - open a new day
                used += 1
                load = 0
            load += w
        return used <= days

    lo, hi = max(weights), sum(weights)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if feasible(mid):
            hi = mid                # this ship suffices; try a smaller one
        else:
            lo = mid + 1            # too small, and so is anything below
    return lo
```

### Complexity
Time O(n · log(sum(weights))) — an O(n) greedy packing per binary-search step. Space O(1).

## 11. Solved Example 3

### Problem — Split Array Largest Sum (LeetCode 410)
Split `nums` into exactly `k` non-empty **contiguous** subarrays so that the largest subarray sum is as small as possible. Return that minimized largest sum.

### Thought Process
1. "Minimize the maximum" is the loudest possible signal for this pattern. The answer is a *sum cap*.
2. Flip the question: instead of "what is the best split into k pieces?", ask "**with a cap of `x`, how few pieces can I get away with?**" — that is easy to answer greedily.
3. `feasible(x)` = greedily extend the current piece while the running sum stays `<= x`, cutting when it would exceed. Feasible if `pieces <= k`.
4. Monotone: raising the cap can only let pieces grow, so the piece count never increases.
5. Range `[max(nums), sum(nums)]`: the cap must fit the largest single element, and one piece holding everything is always allowed.

### Dry Run

Input: `nums = [7, 2, 5, 10, 8]`, `k = 2` → search cap in `[10, 32]`

| step | lo | hi | mid (cap) | greedy pieces | count | ≤ 2 ? | move |
|------|----|----|-----------|---------------|-------|-------|------|
| 1 | 10 | 32 | 21 | `[7,2,5]=14` `[10,8]=18` | 2 | yes | `hi = 21` |
| 2 | 10 | 21 | 15 | `[7,2,5]=14` `[10]` `[8]` | 3 | no | `lo = 16` |
| 3 | 16 | 21 | 18 | `[7,2,5]=14` `[10,8]=18` | 2 | yes | `hi = 18` |
| 4 | 16 | 18 | 17 | `[7,2,5]=14` `[10]` `[8]` | 3 | no | `lo = 18` |
| 5 | 18 | 18 | — | loop ends, `lo == hi` | — | — | return `lo` |

Output: **18**

Rows 3 and 4 pin the boundary exactly: at cap 18 the pair `10 + 8` just barely fits, at cap 17 it does not and a third piece is forced. 18 is therefore the smallest achievable "largest sum".

### Visualization

```text
nums = 7  2  5  10  8      k = 2 pieces allowed

cap = 17   | 7 2 5 |  10  |  8  |        3 pieces  ✗
cap = 18   | 7 2 5 |  10 8      |        2 pieces  ✓   ← 10+8 = 18 fits exactly
cap = 21   | 7 2 5 |  10 8      |        2 pieces  ✓

cap      :  10  ...  15   16   17   18   19  ...  32
feasible :   F  ...   F    F    F    T    T  ...   T
                                     ↑ first T = 18
```

### Code

```go
func splitArray(nums []int, k int) int {
    // feasible(cap): can nums be cut into <= k contiguous pieces, each
    // summing to at most cap? Monotone: a larger cap needs fewer pieces.
    feasible := func(cap int) bool {
        pieces, cur := 1, 0
        for _, x := range nums {
            if cur+x > cap { // this piece is full — cut before x
                pieces++
                cur = 0
            }
            cur += x
        }
        return pieces <= k
    }

    lo, hi := 0, 0
    for _, x := range nums {
        lo = max(lo, x) // a piece must hold the biggest element
        hi += x         // one piece may hold everything
    }

    for lo < hi { // smallest cap that still fits in k pieces
        mid := lo + (hi-lo)/2
        if feasible(mid) {
            hi = mid // cap works; try a tighter one
        } else {
            lo = mid + 1 // cap forces too many pieces
        }
    }
    return lo
}
```

```python
def splitArray(nums, k):
    def feasible(cap):
        """Fewest contiguous pieces with every sum <= cap; monotone in cap."""
        pieces, cur = 1, 0
        for x in nums:
            if cur + x > cap:       # this piece is full - cut before x
                pieces += 1
                cur = 0
            cur += x
        return pieces <= k

    lo, hi = max(nums), sum(nums)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if feasible(mid):
            hi = mid                # cap works; try a tighter one
        else:
            lo = mid + 1            # cap forces too many pieces
    return lo
```

### Complexity
Time O(n · log(sum(nums))) — one O(n) greedy cut per binary-search step, and the range shrinks by half each time. Space O(1) — no table, just the running piece sum.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 875 | Koko Bananas | Easy | Core binary search application |
| 1011 | Ship Within Days | Easy | Core binary search application |
| 410 | Split Array | Medium | Core binary search application |
| 1482 | Bouquets | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Binary Search on Answer logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Binary Search on Answer (Binary Search).
- **Signal:** binary search answer, minimize maximum, feasible, parametric, capacity.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Binary Search on Answer invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Binary Search on Answer
FAMILY : Binary Search (Advanced)
WHEN   : binary search answer, minimize maximum, feasible, parametric, capacity
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 875, 1011, 410, 1482
```

---

*Part of the DSA Patterns Handbook — pattern 25 of 100.*
