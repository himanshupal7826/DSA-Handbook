# 22 · Last Occurrence

> **One-liner:** Bias binary search right to find the last matching index.

---

## 1. Overview

### Definition
The **Last Occurrence** pattern belongs to the *Binary Search* family. Bias binary search right to find the last matching index.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
last, rightmost, binary search, duplicates, boundary.

### Constraints
- Input size where the brute-force complexity would time out — the Last Occurrence optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Last Occurrence invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Last Occurrence is the upgrade.
- The wording maps onto: last, rightmost, binary search, duplicates, boundary.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Where does the target **end**? Give me the rightmost index."*

Running example: `nums = [5, 7, 7, 8, 8, 10]`, `target = 8`. (Answer: index 4.)

### Intuition
Scan from the **right** and return the first index whose value equals the target — starting from the right makes the first hit the rightmost hit.

### Algorithm
1. For `i` from `n − 1` down to `0`:
2. &nbsp;&nbsp;If `nums[i] == target`, return `i`.
3. Return `-1`.

### Complexity
- Time: **O(n)** — worst case the target sits at the front or is absent.
- Space: O(1).

### Drawbacks
- The tempting patch — binary search for any match, then walk **right** while `nums[i+1] == target` — is still O(n). On `[8,8,8,…,8]` with a million entries, the probe lands in the middle and the walk covers half a million indices. You paid for a logarithmic search and got a linear one.
- The wasted work is concrete: on the running example the right-to-left scan reads `10`, then `8`. The `10` comparison already proved (via sortedness) that every index above 5 is too large — but the scan can't use that; it only ever learns about the one cell it touched.
- The scan also can't answer the neighbouring question "how many 8s are there?" without a second pass, whereas the boundary approach below gets it by subtraction.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Binary search can only ever find a *first* TRUE — so to find the last target, search for the first thing that is *bigger*, and step back one.**

That sentence is worth re-reading, because it dissolves the whole difficulty of "last occurrence" problems. A collapsing `[lo, hi)` range always converges on a wall with FALSEs on the left and TRUEs on the right; it points at the *start* of the TRUE block. There is no separate "find the last one" loop to memorise. You reframe: the last 8 is the cell immediately before the first thing greater than 8.

### The thought process

```text
We need    : the RIGHTMOST index holding target.
Obvious way: binary search, then walk right.
Too slow   : O(n) when duplicates are dense.
Notice     : the loop converges on a FIRST-TRUE wall — it cannot converge on a last-true.
Reframe    : first index with a[i] >  target   is one PAST the last target.
Therefore  : run the same loop with <= instead of <, then subtract 1.
Now        : O(log n), no walking.
```

### Why the comparison becomes `<=` — and nothing else changes

The lower bound (chapter 21) asks "is `a[mid]` too small to be the answer?" and answers `a[mid] < target`. The upper bound asks the *same* question about a different wall:

```text
lower bound wall : first index with a[i] >= target    →  push lo past everything <  target
upper bound wall : first index with a[i] >  target    →  push lo past everything <= target
```

So the only edit is one character in the comparison:

```text
lower bound:   if a[mid] <  target  → lo = mid + 1   else hi = mid
upper bound:   if a[mid] <= target  → lo = mid + 1   else hi = mid
                        ↑
             equal values are now "already handled, move past them"
```

With `<=`, landing exactly on a target is no longer a reason to keep `mid` — that copy is accounted for, and we want to know whether there are *more* to its right. That is what drags `lo` to the far end of the run of equal values.

### The loop invariant, in words

> **The answer, if it exists, is always inside `[lo, hi)`.**

True at the start (`[0, n)` is everything), preserved by both branches (each discards only indices proved impossible), and when `lo == hi`:

```text
every index < lo   →  proved a[i] <= target
every index >= lo  →  proved a[i] >  target
```

`lo` is the upper bound. Termination is the same argument as always: integer division rounds down, so `lo <= mid < hi`, meaning `lo = mid + 1` strictly grows `lo` and `hi = mid` strictly shrinks `hi`. The gap falls by at least 1 each pass.

And `mid = lo + (hi - lo) / 2`, never `(lo + hi) / 2` — with `lo` and `hi` near 2×10⁹ the sum overflows a 32-bit int and wraps negative, producing an out-of-range index or an endless loop. `hi - lo` is always ≤ `hi`, so the subtraction form is safe by construction.

### Turning the upper bound into the last occurrence

```text
i = upperBound(nums, target)          # first index with nums[i] > target
if i > 0 and nums[i-1] == target → i-1 is the LAST occurrence
else                             → target is absent, return -1
```

Both guards earn their place. `i > 0` catches a target smaller than everything (`lo` never moves, so `i-1` would be `-1`, an out-of-bounds read in most languages). `nums[i-1] == target` catches a target that falls in a gap between two present values.

> **Integer shortcut:** for integers, `nums[i] > target` and `nums[i] >= target + 1` are the same condition, so `upperBound(t) == lowerBound(t + 1)`. If you only ever want to write *one* loop, write the lower bound and call it with `t + 1`. This does **not** work for floats or for values at the type's maximum.

### One algorithm, four variants

| Want | Move `lo` when | Return |
|------|----------------|--------|
| **lower bound** — first `i` with `a[i] >= t` (ch. 23) | `a[mid] <  t` | `lo` |
| **upper bound** — first `i` with `a[i] > t` (ch. 24) | `a[mid] <= t` | `lo` |
| **first occurrence** of `t` (ch. 21) | `a[mid] <  t` | `lo` if `lo < n && a[lo] == t`, else `-1` |
| **last occurrence** of `t` (this chapter) | `a[mid] <= t` | `lo-1` if `lo > 0 && a[lo-1] == t`, else `-1` |
| **count** of `t` | — | `upperBound(t) − lowerBound(t)` |

Four rows, one loop body. The middle column holds a single character of difference; the right column holds the rest.

### Steps

```text
Step 1 → lo = 0, hi = n
Step 2 → while lo < hi:
Step 3 →     mid = lo + (hi - lo) / 2
Step 4 →     if nums[mid] <= target → lo = mid + 1    (this copy is handled; look right)
Step 5 →     else                   → hi = mid        (too big; the wall is here or left)
Step 6 → if lo > 0 and nums[lo-1] == target → return lo - 1
Step 7 → return -1
```

### How should I recognize this?

```text
If you see...
  "last/rightmost occurrence", "ending position", "greatest index such that ...",
  "largest value <= x", "the most recent entry at or before time t",
  a sorted array WITH DUPLICATES
        ↓
Think about...
  "What is the first thing that is TOO BIG? My answer is right before it."
        ↓
Use...
  the upper-bound loop (<= moves lo), then step back one
  ├─ want the count of targets     → upperBound(t) - lowerBound(t)
  ├─ want the largest value <= t   → upperBound(t) - 1  (no equality check needed)
  └─ integers only                 → upperBound(t) == lowerBound(t+1)
```

### Visual explanation

```svg
<svg viewBox="0 0 620 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-22" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Last occurrence of 4: on a match, bias RIGHT (lo = mid + 1)</text>
  <rect x="24"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="96"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="81" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="168" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="240" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="274" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="312" y="52" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="346" y="81" text-anchor="middle" fill="#1e293b" font-weight="700">4</text>
  <rect x="384" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="81" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="456" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="81" text-anchor="middle" fill="#1e293b">8</text>
  <rect x="528" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="81" text-anchor="middle" fill="#1e293b">9</text>
  <line x1="384" y1="44" x2="384" y2="112" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="346" y="150" text-anchor="middle" fill="#059669" font-weight="700">last index with a[i] = 4</text>
  <text x="472" y="130" text-anchor="middle" fill="#2563eb">a[i] &gt; 4</text>
  <text x="210" y="130" text-anchor="middle" fill="#d97706">← earlier matches skipped</text>
  <line x1="290" y1="168" x2="390" y2="168" stroke="#475569" marker-end="url(#bs-22)"/>
  <text x="340" y="188" text-anchor="middle" fill="#64748b">keep the rightmost boundary</text>
</svg>
```

```text
nums = [ 5,  7,  7,  8,  8, 10 ]     target = 8
index    0   1   2   3   4   5

predicate "nums[i] > 8":
         F   F   F   F   F   T
                             ↑
                 first TRUE = 5 = one PAST the last 8
                 last occurrence = 5 - 1 = 4  ★

step 1  [lo=0 ─────────────────── hi=6)   mid=3  nums[3]=8 <= 8 → move past → lo=4
step 2                  [lo=4 ─── hi=6)   mid=5  nums[5]=10 > 8 → too big   → hi=5
step 3                  [lo=4 hi=5)       mid=4  nums[4]=8 <= 8 → move past → lo=5
        lo == hi == 5

then check: 5 > 0 and nums[4] == 8  →  last occurrence = 4

note steps 1 and 3: we landed ON an 8 twice and moved RIGHT both times —
that is the entire difference from chapter 21, where we would have moved left
```

### Interview explanation
"Binary search converges on a first-`true` boundary, so I never try to search for a 'last' anything directly — I search for the first element that is *strictly greater* than the target and subtract one. That's the upper bound, and it's the lower-bound loop with `<` changed to `<=`: when `nums[mid] <= target` that copy is already accounted for, so `lo = mid + 1` pushes past it, and otherwise `hi = mid` because `mid` is too big. I keep the half-open invariant that the answer stays inside `[lo, hi)`, and use `lo + (hi-lo)/2` so the midpoint can't overflow. Afterwards I guard with `lo > 0 && nums[lo-1] == target` to distinguish 'present' from 'absent'. O(log n) time, O(1) space — and as a bonus, `upperBound − lowerBound` gives the number of copies for free."

---

## 5. Generic Templates

> Same loop as the lower bound with `<` swapped for `<=`; then step back one index.

```go
// UpperBound returns the first index i with a[i] > target (len(a) if none).
// Invariant: the answer always lies in [lo, hi).
func UpperBound(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2 // overflow-safe midpoint
        if a[mid] <= target {
            lo = mid + 1 // equal counts as "handled" → look further right
        } else {
            hi = mid // strictly greater → the wall is here or to the left
        }
    }
    return lo
}

// LastOccurrence returns the rightmost index of target, or -1 if absent.
func LastOccurrence(a []int, target int) int {
    i := UpperBound(a, target)
    if i > 0 && a[i-1] == target {
        return i - 1
    }
    return -1
}

// CountEqual returns how many copies of target the sorted slice holds.
func CountEqual(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi { // lower bound: first index with a[i] >= target
        mid := lo + (hi-lo)/2
        if a[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return UpperBound(a, target) - lo // upper bound minus lower bound
}
```

```python
def upper_bound(a, target):
    """First index i with a[i] > target (len(a) if none)."""
    lo, hi = 0, len(a)
    while lo < hi:
        mid = lo + (hi - lo) // 2      # overflow-safe habit
        if a[mid] <= target:
            lo = mid + 1               # equal is "handled" → look further right
        else:
            hi = mid                   # strictly greater → wall is here or left
    return lo


def last_occurrence(a, target):
    """Rightmost index of target, or -1 if absent."""
    i = upper_bound(a, target)
    return i - 1 if i > 0 and a[i - 1] == target else -1


def count_equal(a, target):
    """How many copies of target the sorted list holds."""
    lo, hi = 0, len(a)
    while lo < hi:                     # lower bound: first index >= target
        mid = lo + (hi - lo) // 2
        if a[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return upper_bound(a, target) - lo
```

```java
public class LastOccurrenceSearch {
    // First index i with a[i] > target (a.length if none).
    public static int upperBound(int[] a, int target) {
        int lo = 0, hi = a.length;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;        // overflow-safe
            if (a[mid] <= target) lo = mid + 1;  // equal → look further right
            else hi = mid;                       // strictly greater → wall is left
        }
        return lo;
    }

    // Rightmost index of target, or -1 if absent.
    public static int lastOccurrence(int[] a, int target) {
        int i = upperBound(a, target);
        return (i > 0 && a[i - 1] == target) ? i - 1 : -1;
    }

    // How many copies of target the sorted array holds.
    public static int countEqual(int[] a, int target) {
        int lo = 0, hi = a.length;
        while (lo < hi) {                        // lower bound
            int mid = lo + (hi - lo) / 2;
            if (a[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return upperBound(a, target) - lo;
    }
}
```

```cpp
#include <vector>
using namespace std;

// First index i with a[i] > target (a.size() if none).
int upperBound(const vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;         // overflow-safe
        if (a[mid] <= target) lo = mid + 1;   // equal → look further right
        else hi = mid;                        // strictly greater → wall is left
    }
    return lo;
}

// Rightmost index of target, or -1 if absent.
int lastOccurrence(const vector<int>& a, int target) {
    int i = upperBound(a, target);
    return (i > 0 && a[i - 1] == target) ? i - 1 : -1;
}

// How many copies of target the sorted vector holds.
int countEqual(const vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size();
    while (lo < hi) {                         // lower bound
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return upperBound(a, target) - lo;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Last Occurrence (Optimal) |
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

### Problem — First Last Position (LeetCode 34)
Given a sorted array with duplicates, return `[first, last]` — the leftmost and rightmost indices of `target` — or `[-1, -1]` if it is absent. Required complexity: O(log n).

### Thought Process
1. Two walls, two searches: `first` is the **lower bound** (first index with `nums[i] >= target`), `last` is the **upper bound minus one** (first index with `nums[i] > target`, step back).
2. Both searches are the same loop; only the comparison differs — `<` for the lower bound, `<=` for the upper bound.
3. Run the lower bound first and use it as the presence test: if it lands past the end, or on a value that isn't the target, return `[-1, -1]` and skip the second search.
4. If the target *is* present, `upperBound(target) - 1` is guaranteed to be in range and to hold the target, so no second guard is needed.
5. As a free extra, `upperBound − lowerBound` is the number of copies.

### Dry Run

Input: `nums = [5, 7, 7, 8, 8, 10]`, `target = 8`

**Search A — lower bound** (`nums[mid] < 8` moves `lo`):

| step | `lo` | `hi` | `mid` | `nums[mid]` | `< 8`? | action |
|------|------|------|-------|-------------|--------|--------|
| 1 | 0 | 6 | **3** | 8 | no | `hi = 3` — keep the candidate |
| 2 | 0 | 3 | **1** | 7 | yes | `lo = 2` |
| 3 | 2 | 3 | **2** | 7 | yes | `lo = 3` |
| 4 | 3 | 3 | — | — | — | stop → `first = 3` |

**Search B — upper bound** (`nums[mid] <= 8` moves `lo`):

| step | `lo` | `hi` | `mid` | `nums[mid]` | `<= 8`? | action |
|------|------|------|-------|-------------|---------|--------|
| 1 | 0 | 6 | **3** | 8 | **yes** | `lo = 4` — move *past* this copy |
| 2 | 4 | 6 | **5** | 10 | no | `hi = 5` |
| 3 | 4 | 5 | **4** | 8 | **yes** | `lo = 5` — move past this copy too |
| 4 | 5 | 5 | — | — | — | stop → upper bound = 5, `last = 4` |

Output: **`[3, 4]`** — and the count is `5 − 3 = 2`, which matches the two 8s.

Compare step 1 of the two searches. Both probe index 3 and both see the value 8. Search A treats it as a candidate and moves `hi` **left**; search B treats it as already handled and moves `lo` **right**. One character of difference in the comparison, opposite directions, opposite walls.

### Visualization

```text
nums  =  5   7   7   8   8  10
index    0   1   2   3   4   5

>= 8  :  F   F   F   T   T   T     lower bound = 3   → first = 3
>  8  :  F   F   F   F   F   T     upper bound = 5   → last  = 5 - 1 = 4
                     ├───────┤
                     the run of 8s

count = upper - lower = 5 - 3 = 2
```

### Code

```go
// lowerBoundIdx: first index i with a[i] >= target, or len(a).
func lowerBoundIdx(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if a[mid] < target {
            lo = mid + 1 // strictly smaller → answer is right
        } else {
            hi = mid // equal or bigger → mid is still a candidate
        }
    }
    return lo
}

// upperBoundIdx: first index i with a[i] > target, or len(a).
// Identical loop; only the comparison changes from < to <=.
func upperBoundIdx(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if a[mid] <= target {
            lo = mid + 1 // equal is handled → move PAST it
        } else {
            hi = mid // strictly bigger → the wall is here or left
        }
    }
    return lo
}

func searchRange(nums []int, target int) []int {
    first := lowerBoundIdx(nums, target)
    if first == len(nums) || nums[first] != target {
        return []int{-1, -1} // absent
    }
    last := upperBoundIdx(nums, target) - 1 // one before the first bigger value
    return []int{first, last}
}
```

```python
def searchRange(nums, target):
    def lower_bound(t):                 # first index with nums[i] >= t
        lo, hi = 0, len(nums)
        while lo < hi:
            mid = lo + (hi - lo) // 2
            if nums[mid] < t:
                lo = mid + 1
            else:
                hi = mid                # still a candidate
        return lo

    def upper_bound(t):                 # first index with nums[i] > t
        lo, hi = 0, len(nums)
        while lo < hi:
            mid = lo + (hi - lo) // 2
            if nums[mid] <= t:
                lo = mid + 1            # equal is handled → move past it
            else:
                hi = mid
        return lo

    first = lower_bound(target)
    if first == len(nums) or nums[first] != target:
        return [-1, -1]                 # absent

    return [first, upper_bound(target) - 1]
```

### Complexity
Time **O(log n)** — two halving searches. Space **O(1)**.

---

## 10. Solved Example 2

### Problem — K Closest (LeetCode 658)
Given a sorted array `arr`, an integer `k` and a value `x`, return the `k` elements closest to `x`, sorted ascending. When two elements are equally close, prefer the smaller one.

### Thought Process
1. **Key observation:** the answer is always a *contiguous* window of length `k`. (If it skipped an element, that skipped element would be closer to `x` than at least one element you kept.) So the whole problem reduces to finding one number: the window's left index.
2. The left index ranges over `[0, n − k]`. Binary search *that* range instead of the array.
3. Compare the two elements that would swap if the window slid one step right: `arr[mid]` leaves, `arr[mid + k]` enters. If the entering element is strictly closer — `x − arr[mid] > arr[mid+k] − x` — slide right (`lo = mid + 1`); otherwise the current left edge is at least as good (`hi = mid`).
4. That predicate is monotonic: as `mid` grows, `x − arr[mid]` shrinks and `arr[mid+k] − x` grows, so "keep left" is false…false, true…true. We are again searching for the first `true`.
5. **Why `hi` starts at `n − k`, not `n − k + 1`:** index `n − k` is the last legal left edge, and testing it would read `arr[n]`, out of bounds. It never needs testing — it is the fallback answer if every smaller candidate loses. So it sits at `hi` as a guaranteed-true sentinel, and the loop probes only strictly smaller candidates.
6. On a tie (`x − arr[mid] == arr[mid+k] − x`) we take `hi = mid`, keeping the left window — which is exactly the "prefer the smaller value" rule.

### Dry Run

Input: `arr = [1, 2, 3, 4, 5]`, `k = 2`, `x = 4` → left index searched in `[0, 3]`, so `lo = 0`, `hi = 3`

| step | `lo` | `hi` | `mid` | leaving `arr[mid]` | entering `arr[mid+k]` | `x−arr[mid]` | `arr[mid+k]−x` | entering closer? | action |
|------|------|------|-------|--------------------|-----------------------|--------------|----------------|------------------|--------|
| 1 | 0 | 3 | **1** | `arr[1]=2` | `arr[3]=4` | 4−2 = **2** | 4−4 = **0** | yes (2 > 0) | `lo = 2` — slide right |
| 2 | 2 | 3 | **2** | `arr[2]=3` | `arr[4]=5` | 4−3 = **1** | 5−4 = **1** | **tie** (1 > 1 is false) | `hi = 2` — keep left |
| 3 | 2 | 2 | — | — | — | — | — | — | stop → left = **2** |

Output: **`arr[2:4] = [3, 4]`**

Step 2 is the tie-break in action: 3 and 5 are both distance 1 from 4, and the `>` (not `>=`) comparison keeps the window whose extra element is the *smaller* value, 3. Flipping that to `>=` would return `[4, 5]` and fail the problem's tie rule.

Sanity check with the canonical example `arr = [1,2,3,4,5], k = 4, x = 3`: `hi = 1`, step 1 probes `mid = 0` where `x−arr[0] = 2` and `arr[4]−x = 2` — a tie, so `hi = 0` and the answer is `arr[0:4] = [1,2,3,4]`. ✓

### Visualization

```text
arr =   1   2   3   4   5        k = 2, x = 4
index   0   1   2   3   4

left index candidates:  0   1   2   3
"keep left?"            F   F   T   T(sentinel, never probed)
                                ↑ first TRUE = 2  ★

mid=1:  window [2,3]  →  slide?  2 leaves (dist 2), 4 enters (dist 0)   YES
mid=2:  window [3,4]  →  slide?  3 leaves (dist 1), 5 enters (dist 1)   tie → NO

answer = arr[2 : 2+2] = [3, 4]

the array is sorted, but we binary search the WINDOW POSITION, not the values
```

### Code

```go
func findClosestElements(arr []int, k int, x int) []int {
    lo, hi := 0, len(arr)-k // candidate left edges; hi is the untested sentinel

    for lo < hi {
        mid := lo + (hi-lo)/2
        // Sliding right swaps arr[mid] out for arr[mid+k].
        if x-arr[mid] > arr[mid+k]-x {
            lo = mid + 1 // the entering element is strictly closer → slide right
        } else {
            hi = mid // left edge is at least as good; ties keep the smaller value
        }
    }
    return arr[lo : lo+k]
}
```

```python
def findClosestElements(arr, k, x):
    lo, hi = 0, len(arr) - k           # candidate left edges; hi is the sentinel

    while lo < hi:
        mid = lo + (hi - lo) // 2
        # sliding right swaps arr[mid] out for arr[mid + k]
        if x - arr[mid] > arr[mid + k] - x:
            lo = mid + 1               # entering element is strictly closer
        else:
            hi = mid                   # keep left; ties prefer the smaller value

    return arr[lo:lo + k]
```

### Complexity
Time **O(log(n − k) + k)** — the binary search over left edges, plus copying out the `k`-element window. Space **O(k)** for the returned slice, O(1) extra.

---

## 11. Solved Example 3

### Problem — Single Element (LeetCode 540)
In a sorted array where every element appears exactly twice except one, find the element that appears once. Required: O(log n) time, O(1) space.

### Thought Process
1. Before the single element, the pairs are perfectly aligned: `(0,1), (2,3), (4,5), …` — each pair *starts* at an even index. After the single element, every pair is shifted by one and starts at an **odd** index.
2. So define, over **even** indices `e`: `broken(e) = (nums[e] != nums[e+1])`. That is false, false, …, true, true — monotonic. Once again: find the first `true`.
3. Search only even indices. Compute `mid` as usual, then round it **down** to even (`mid -= mid & 1`). Since `lo` is always even and `mid >= lo`, rounding down never falls below `lo`.
4. `broken(mid)` false → the pairing is still intact through `mid+1`, so the single element is strictly after → `lo = mid + 2` (the next even index). True → `mid` is a candidate → `hi = mid`.
5. `hi` starts at `n − 1`, the last (even) index — the array has odd length, and that final element is the fallback answer if every pair before it is intact. Like example 2, it is a guaranteed-true sentinel that never needs probing.

### Dry Run

Input: `nums = [1, 1, 2, 3, 3, 4, 4]` (n = 7) → `lo = 0`, `hi = 6`

| step | `lo` | `hi` | raw `mid` | even `mid` | `nums[mid]` | `nums[mid+1]` | pair intact? | action |
|------|------|------|-----------|------------|-------------|---------------|--------------|--------|
| 1 | 0 | 6 | 0+3 = 3 | **2** | 2 | 3 | **no** — broken | `hi = 2` (candidate) |
| 2 | 0 | 2 | 0+1 = 1 | **0** | 1 | 1 | yes | `lo = 2` (skip the whole pair) |
| 3 | 2 | 2 | — | — | — | — | — | stop → answer `nums[2] = 2` |

Output: **2**

A second trace, `nums = [3,3,7,7,10,11,11]`: step 1 `mid = 3 → 2`, `nums[2]=7 == nums[3]=7` intact → `lo = 4`; step 2 `lo=4, hi=6, mid = 5 → 4`, `nums[4]=10 != nums[5]=11` broken → `hi = 4`; stop → `nums[4] = 10`. ✓

Step 2 in the first trace shows why `lo = mid + 2` and not `mid + 1`: an intact pair rules out **both** of its indices, and jumping by 2 keeps `lo` even so the "even index starts a pair" invariant survives.

### Visualization

```text
index    0   1   2   3   4   5   6
nums   [ 1,  1,  2,  3,  3,  4,  4 ]
pairs   └──┘    ?   └──┘    └──┘
                ↑ the single element breaks the alignment

even index e :   0        2        4        6
nums[e]==nums[e+1]?  T    F        F        (n/a → sentinel true)
"broken?"        F        T        T        T
                          ↑ first TRUE = 2  ★  answer = nums[2] = 2

BEFORE the single: pairs start at EVEN indices
AFTER  the single: pairs start at ODD indices
```

### Code

```go
func singleNonDuplicate(nums []int) int {
    // Search even indices only; hi is the last index and acts as the sentinel.
    lo, hi := 0, len(nums)-1

    for lo < hi {
        mid := lo + (hi-lo)/2
        mid -= mid & 1 // round down to an even index (lo is always even)

        if nums[mid] == nums[mid+1] {
            lo = mid + 2 // pair intact → the single element is strictly after
        } else {
            hi = mid // pairing already broken at or before mid
        }
    }
    return nums[lo]
}
```

```python
def singleNonDuplicate(nums):
    # search even indices only; hi is the last index and acts as the sentinel
    lo, hi = 0, len(nums) - 1

    while lo < hi:
        mid = lo + (hi - lo) // 2
        mid -= mid & 1                 # round down to an even index

        if nums[mid] == nums[mid + 1]:
            lo = mid + 2               # pair intact → single element is after
        else:
            hi = mid                   # pairing broken at or before mid

    return nums[lo]
```

### Complexity
Time **O(log n)** — each step halves the number of candidate pairs. Space **O(1)**.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 34 | First Last Position | Easy | Core binary search application |
| 658 | K Closest | Easy | Core binary search application |
| 540 | Single Element | Medium | Core binary search application |
| 374 | Guess | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Last Occurrence logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Last Occurrence (Binary Search).
- **Signal:** last, rightmost, binary search, duplicates, boundary.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Last Occurrence invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Last Occurrence
FAMILY : Binary Search (Intermediate)
WHEN   : last, rightmost, binary search, duplicates, boundary
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 34, 658, 540, 374
```

---

*Part of the DSA Patterns Handbook — pattern 22 of 100.*
