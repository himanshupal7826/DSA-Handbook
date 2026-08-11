# 27 · Peak Element

> **One-liner:** Follow the ascending slope with binary search to a peak.

---

## 1. Overview

### Definition
The **Peak Element** pattern belongs to the *Binary Search* family. Follow the ascending slope with binary search to a peak.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
peak, local maximum, bitonic, slope, binary search.

### Constraints
- Input size where the brute-force complexity would time out — the Peak Element optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Peak Element invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Peak Element is the upgrade.
- The wording maps onto: peak, local maximum, bitonic, slope, binary search.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Where does this sequence stop going up?"*

Running example: `nums = [1, 2, 3, 1]`. A **peak** is an index strictly greater than both its neighbours, with the out-of-bounds neighbours treated as `-∞`. Here index 2 (value 3) is a peak.

### Intuition
A peak is a purely local property — it depends on an element and its two neighbours, nothing else. So visit every element and ask the local question.

### Algorithm
1. For `i = 0 .. n-1`:
2. &nbsp;&nbsp;Let `left = nums[i-1]` if `i > 0` else `-∞`.
3. &nbsp;&nbsp;Let `right = nums[i+1]` if `i < n-1` else `-∞`.
4. &nbsp;&nbsp;If `nums[i] > left` and `nums[i] > right`, return `i`.

### Complexity
- Time: **O(n)** — up to one comparison pair per element.
- Space: O(1)

### Drawbacks
- On `[1, 2, 3, 1]` the scan checks index 0 (`1 > -∞` but `1 < 2` — fail), index 1 (`2 > 1` but `2 < 3` — fail), then index 2 (success). Each failure told us something we then threw away.
- The wasted fact: **when index 1 failed because `2 < 3`, that already proved a peak exists somewhere to the right.** The brute force learns "not here" and steps forward by one, when it could have jumped.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Binary search does not require a sorted array — it only requires a rule that proves "an answer definitely lies on this side". "Always walk uphill" is exactly such a rule.**

This is worth pausing on, because most people learn binary search as "the sorted-array algorithm" and it is not. `[1, 2, 3, 1]` is not sorted, yet it can be searched in O(log n). What binary search actually needs is a test at `mid` whose answer lets you throw away a half **without risk of discarding every valid answer**. Sortedness is one way to get that. Uphill-walking is another.

Everyday version: you are dropped on a foggy hillside and told to reach *any* summit. You can only feel the ground under your feet. Step in whichever direction goes up. You cannot walk uphill forever — the mountain is finite — so you must arrive at a top.

### The thought process

```text
We need    : the index of ANY peak (greater than both neighbours).
Obvious way: check every element's two neighbours.
Too slow   : O(n), and each failed check leaks information we discard.
Notice     : if nums[mid] < nums[mid+1], we are on an upward slope, and
             the array must eventually come back down (it ends at -inf).
Therefore  : a peak is guaranteed somewhere in (mid, hi].
Similarly  : if nums[mid] > nums[mid+1], we are on a downward slope, so a
             peak is guaranteed in [lo, mid].
Now        : one comparison always kills half the window → O(log n).
```

### Why a peak must exist at all

Pretend the array is bracketed by `-∞` sentinels:

```text
-inf   1   2   3   1   -inf
       └─── nums ────┘
```

The sequence starts by going **up** (from `-∞` into `nums[0]`) and ends by going **down** (from `nums[n-1]` into `-∞`). Any finite sequence that goes up and later goes down must turn around at least once, and a turning point is a peak.

A shorter proof: take the position of the **global maximum**. Neither neighbour can exceed it, and the problem guarantees no two adjacent values are equal, so both neighbours are strictly smaller — that position is a peak. So the answer always exists, and we are free to hunt for *any* one.

### Why the uphill rule never discards every peak

The algorithm keeps a window `[lo, hi]` under this invariant:

> **The window rises into its left edge and falls off its right edge** — i.e. `nums[lo-1] < nums[lo]` and `nums[hi] > nums[hi+1]`, using the `-∞` sentinels.

By the argument above, any window with that property contains a peak. It holds initially for `[0, n-1]` because both sentinels are `-∞`. Now compare `nums[mid]` with `nums[mid+1]`:

```text
Case A: nums[mid] < nums[mid+1]      →  new window [mid+1, hi]
        it rises into mid+1 (by the comparison) and still falls off at hi  ✔

Case B: nums[mid] > nums[mid+1]      →  new window [lo, mid]
        it still rises into lo and now falls off at mid (by the comparison) ✔
```

Either way the invariant survives, so the surviving half still contains a peak. The window strictly shrinks every iteration, and when `lo == hi` that single index satisfies both halves of the invariant — it is a peak. No sortedness was ever used.

A tiny counterexample for the classic mistake: on `[1, 2, 3, 1]` with `mid = 1`, `nums[1]=2 < nums[2]=3`, so we go right. Suppose you instead wrote `hi = mid` "because 2 is bigger than its left neighbour 1". The window becomes `[0,1]` = `[1,2]`, which rises into `0` but does **not** fall off at index 1 (`2 < 3`). The invariant is broken, and the search now reports index 1 — which is not a peak. The comparison direction is the entire algorithm.

### Steps

```text
Step 1 → lo = 0, hi = n-1.   (never n; we will read nums[mid+1])
Step 2 → while lo < hi:
Step 3 →     mid = lo + (hi-lo)/2        // rounds down, so mid+1 <= hi: safe
Step 4 →     if nums[mid] < nums[mid+1]: lo = mid + 1   // uphill → go right
Step 5 →     else:                       hi = mid       // downhill → keep mid
Step 6 → return lo    // lo == hi, and it is a peak
```

Rounding `mid` **down** is what makes `nums[mid+1]` a legal read: with `lo < hi`, `mid` is always strictly less than `hi`.

### How should I recognize this?

```text
If you see...
  "find a peak / local maximum", "any peak is fine"
  "mountain array", "increases then decreases", "bitonic"
  "O(log n) required" on an array that is NOT sorted
        ↓
Think about...
  "Does one comparison at mid prove which side still contains an answer?"
        ↓
Use...
  binary search on the slope: compare nums[mid] with nums[mid+1]
    ├─ nums[mid] < nums[mid+1]  → lo = mid + 1   (climb right)
    ├─ otherwise                → hi = mid       (peak here or left)
    └─ mountain variant → the same loop finds the UNIQUE summit
  caveat: needs no two adjacent values equal (a plateau breaks the rule)
```

### Visual explanation

```svg
<svg viewBox="0 0 620 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-27" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Peak element: a[mid] &lt; a[mid+1] means a peak lies to the right</text>
  <rect x="36"  y="141" width="44" height="19" rx="4" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="176" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="108" y="119" width="44" height="41" rx="4" fill="#fff7ed" stroke="#d97706"/><text x="130" y="176" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="180" y="97"  width="44" height="63" rx="4" fill="#fff7ed" stroke="#d97706"/><text x="202" y="176" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="252" y="75"  width="44" height="85" rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="274" y="176" text-anchor="middle" fill="#1e293b" font-weight="700">7</text>
  <rect x="324" y="86"  width="44" height="74" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="346" y="176" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="396" y="108" width="44" height="52" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="176" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="468" y="130" width="44" height="30" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="176" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="540" y="141" width="44" height="19" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="176" text-anchor="middle" fill="#1e293b">1</text>
  <line x1="202" y1="90" x2="266" y2="70" stroke="#475569" marker-end="url(#bs-27)"/>
  <text x="202" y="196" text-anchor="middle" fill="#64748b" font-weight="700">mid</text>
  <text x="274" y="196" text-anchor="middle" fill="#059669" font-weight="700">peak</text>
  <text x="150" y="196" text-anchor="middle" fill="#d97706">drop left half (lo = mid + 1)</text>
</svg>
```

```text
nums = [1, 2, 3, 1]        sentinels: -inf on both sides

        value
          3        ●               peak
          2     ●
          1  ●        ●
             0  1  2  3   index

step 1   lo=0 ........... hi=3    mid=1
         nums[1]=2 < nums[2]=3  → uphill → lo = 2
                                  (a peak must exist in [2,3])

step 2         lo=2 . hi=3        mid=2
         nums[2]=3 > nums[3]=1  → downhill → hi = 2
                                  (a peak must exist in [2,2])

step 3         lo=hi=2  → return 2      nums[2]=3 > 2 and > 1  ✓

window: 4 → 2 → 1     two comparisons instead of three scans
```

### Interview explanation
"A peak is guaranteed to exist: imagine `-∞` past both ends, so the array rises into the range and falls out of it, and anything that rises and later falls has a turning point. That means I don't need sortedness — I only need a rule telling me which half still contains a peak. Comparing `nums[mid]` with `nums[mid+1]` gives me that: if it's ascending, the right half rises in and still falls off the end, so it contains a peak, and I set `lo = mid + 1`; otherwise the left half including `mid` does, and I set `hi = mid`. The window shrinks every step and the last surviving index is a peak — O(log n) time, O(1) space. It relies on no two adjacent values being equal, since a plateau makes the slope test meaningless."

---

## 5. Generic Templates

> Compare with the **right** neighbour and climb. `hi = mid`, never `mid - 1` — `mid` may be the peak.

```go
// FindPeak returns the index of some element strictly greater than both of
// its neighbours (out-of-range neighbours count as -infinity).
// Requires no two ADJACENT elements to be equal. Works on unsorted input.
func FindPeak(nums []int) int {
    lo, hi := 0, len(nums)-1
    for lo < hi {
        mid := lo + (hi-lo)/2 // rounds down, so mid < hi and mid+1 is valid
        if nums[mid] < nums[mid+1] {
            lo = mid + 1 // ascending: a peak lies strictly to the right
        } else {
            hi = mid // descending: mid itself may be the peak — keep it
        }
    }
    return lo // lo == hi, and the invariant makes it a peak
}
```

```python
def find_peak(nums):
    """Index of an element greater than both neighbours (-inf outside the
    array). Requires no two ADJACENT elements to be equal. Works unsorted."""
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        mid = lo + (hi - lo) // 2      # rounds down, so mid + 1 is in range
        if nums[mid] < nums[mid + 1]:
            lo = mid + 1               # ascending: peak is strictly right
        else:
            hi = mid                   # descending: mid may BE the peak
    return lo                          # lo == hi is a peak
```

```java
public class PeakFinder {
    /** Index of an element greater than both neighbours (-inf outside).
     *  Requires no two adjacent elements to be equal. Works unsorted. */
    public static int findPeak(int[] nums) {
        int lo = 0, hi = nums.length - 1;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;     // rounds down: mid + 1 is valid
            if (nums[mid] < nums[mid + 1]) lo = mid + 1;  // climb right
            else hi = mid;                                // mid may be the peak
        }
        return lo;
    }
}
```

```cpp
#include <vector>
using namespace std;

// Index of an element greater than both neighbours (-inf outside the array).
// Requires no two adjacent elements to be equal. Works on unsorted input.
int findPeak(const vector<int>& nums) {
    int lo = 0, hi = (int)nums.size() - 1;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;        // rounds down: mid + 1 is valid
        if (nums[mid] < nums[mid + 1]) lo = mid + 1;  // climb right
        else hi = mid;                                // mid may be the peak
    }
    return lo;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Peak Element (Optimal) |
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

### Problem — Find Peak (LeetCode 162)
Given `nums` where no two **adjacent** elements are equal, return the index of *any* peak — an element strictly greater than both neighbours, with `nums[-1] = nums[n] = -∞`. Required: O(log n).

### Thought Process
1. A peak is guaranteed to exist: with `-∞` sentinels the array rises in and falls out, so it must turn around.
2. The array is *not* sorted, so the usual "compare with target" is useless. Compare with the **neighbour** instead.
3. `nums[mid] < nums[mid+1]` means we stand on an upward slope, and the array must come back down before the right end — so the right half contains a peak. Go right.
4. Otherwise we are on a downward slope (or already at the top), so the left half **including `mid`** contains a peak. `hi = mid`.
5. The window shrinks every step; when `lo == hi` that index is a peak.

### Dry Run

Input: `nums = [1, 2, 3, 1]`

| step | lo | hi | mid | nums[mid] | nums[mid+1] | slope | move | window now holds |
|------|----|----|-----|-----------|-------------|-------|------|------------------|
| 1 | 0 | 3 | 1 | 2 | 3 | up (2 < 3) | `lo = mid + 1 = 2` | `[3, 1]` |
| 2 | 2 | 3 | 2 | 3 | 1 | down (3 > 1) | `hi = mid = 2` | `[3]` |
| 3 | 2 | 2 | — | loop ends, `lo == hi` | | | | return **2** |

Output: **2**  (`nums[2] = 3`, and `3 > nums[1] = 2`, `3 > nums[3] = 1`)

Row 2 shows why `hi = mid` and not `hi = mid - 1`: at that moment `mid = 2` *is* the peak. Stepping past it would leave the window `[2,2] → [2,1]`, and the algorithm would report index 1, which is not a peak.

### Visualization

```text
        3            ●
        2         ●
        1      ●        ●
              [0] [1] [2] [3]
   -inf ────┘              └──── -inf     the array rises in, falls out

step 1   lo=0 ═══════════════ hi=3   mid=1   2 < 3  ↗  climb right
                     lo=2 ═══ hi=3   mid=2   3 > 1  ↘  keep mid, drop right
                     lo=hi=2                          answer = 2 ✓

invariant kept at every step:
   window rises into its left edge and falls off its right edge
   ⇒ it must contain a turning point
```

### Code

```go
func findPeakElement(nums []int) int {
    lo, hi := 0, len(nums)-1
    for lo < hi {
        // mid rounds down, so mid < hi and reading nums[mid+1] is always safe.
        mid := lo + (hi-lo)/2
        if nums[mid] < nums[mid+1] {
            // Uphill. The right half rises in and still falls off the end,
            // so it must contain a peak.
            lo = mid + 1
        } else {
            // Downhill (or already the top). The left half including mid
            // rises in and now falls off at mid, so it contains a peak.
            hi = mid
        }
    }
    return lo
}
```

```python
def findPeakElement(nums):
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        mid = lo + (hi - lo) // 2      # rounds down: nums[mid+1] is in range
        if nums[mid] < nums[mid + 1]:
            lo = mid + 1               # uphill - a peak lies to the right
        else:
            hi = mid                   # downhill - mid itself may be the peak
    return lo                          # lo == hi is a peak
```

### Complexity
Time O(log n) — one comparison halves the window, and no sortedness is needed. Space O(1).

## 10. Solved Example 2

### Problem — Peak Mountain (LeetCode 852)
`arr` is a mountain array: strictly increasing, then strictly decreasing, with at least one element on each side. Return the index of the single summit.

### Thought Process
1. A mountain is the special case where exactly **one** peak exists, so "find any peak" and "find the peak" are the same search.
2. The identical slope test applies: `arr[mid] < arr[mid+1]` means the summit is strictly to the right.
3. Otherwise `arr[mid] > arr[mid+1]` puts us past (or on) the summit, so it is at `mid` or left.
4. Strictness is guaranteed here — no plateaus — so the comparison is never ambiguous.
5. Convergence at `lo == hi` gives the unique summit index.

### Dry Run

Input: `arr = [0, 2, 5, 3, 1]`

| step | lo | hi | mid | arr[mid] | arr[mid+1] | slope | move |
|------|----|----|-----|----------|------------|-------|------|
| 1 | 0 | 4 | 2 | 5 | 3 | down (5 > 3) | `hi = 2` |
| 2 | 0 | 2 | 1 | 2 | 5 | up (2 < 5) | `lo = 2` |
| 3 | 2 | 2 | — | loop ends, `lo == hi` | | | return **2** |

Output: **2**  (`arr[2] = 5` is the summit)

Note the search never visited index 3 or 4 after step 1: the single comparison `5 > 3` retired the entire right side of the mountain in one move.

### Visualization

```text
        5           ●
        3              ●
        2        ●
        1                 ●
        0     ●
             [0]  [1]  [2]  [3]  [4]
              ▲▲▲▲▲▲▲▲▲▲ ▼▼▼▼▼▼▼▼▼▼
              increasing   decreasing

step 1  lo=0 ══════════════════ hi=4   mid=2   arr[2]=5 > arr[3]=3  ↘  hi=2
step 2  lo=0 ════════ hi=2             mid=1   arr[1]=2 < arr[2]=5  ↗  lo=2
step 3            lo=hi=2                       summit = index 2 ✓
```

### Code

```go
func peakIndexInMountainArray(arr []int) int {
    lo, hi := 0, len(arr)-1
    for lo < hi {
        mid := lo + (hi-lo)/2
        if arr[mid] < arr[mid+1] {
            lo = mid + 1 // still climbing — summit is strictly right
        } else {
            hi = mid // past the summit (or on it) — keep mid
        }
    }
    return lo
}
```

```python
def peakIndexInMountainArray(arr):
    lo, hi = 0, len(arr) - 1
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if arr[mid] < arr[mid + 1]:
            lo = mid + 1               # still climbing - summit is right
        else:
            hi = mid                   # past the summit (or on it) - keep mid
    return lo
```

### Complexity
Time O(log n) — the same halving loop as example 1. Space O(1). (A linear scan for the first descent is O(n) and is what this replaces.)

## 11. Solved Example 3

### Problem — Mountain Array (LeetCode 1095)
Find the **smallest** index whose value equals `target` in a *hidden* mountain array, using only `get(i)` and `length()`. Return `-1` if absent. The number of `get` calls is limited, so an O(n) scan is not allowed.

### Thought Process
1. Split the mountain at its summit and you get two ordinary monotonic arrays — one ascending, one descending. Each is binary-searchable.
2. So: **pass 1** finds the peak with the slope search from example 1.
3. **Pass 2** binary-searches the ascending half `[0, peak]`. Any hit there is automatically the smallest index, so return it immediately.
4. **Pass 3** only runs if pass 2 missed: binary-search the descending half `[peak+1, n-1]` with the comparison flipped (`val > target` ⇒ go right).
5. Three O(log n) passes, so still logarithmic in `get` calls.

### Dry Run

Input: `arr = [1, 2, 3, 4, 5, 3, 1]` (hidden), `target = 3`, `length = 7`

**Pass 1 — find the peak**

| step | lo | hi | mid | get(mid) | get(mid+1) | slope | move |
|------|----|----|-----|----------|------------|-------|------|
| 1 | 0 | 6 | 3 | 4 | 5 | up | `lo = 4` |
| 2 | 4 | 6 | 5 | 3 | 1 | down | `hi = 5` |
| 3 | 4 | 5 | 4 | 5 | 3 | down | `hi = 4` |
| 4 | 4 | 4 | — | done → **peak = 4** | | | |

**Pass 2 — ascending search in `[0, 4]` for 3**

| step | lo | hi | mid | get(mid) | vs target 3 | move |
|------|----|----|-----|----------|-------------|------|
| 1 | 0 | 4 | 2 | **3** | equal | return **2** |

Output: **2**

Pass 3 never runs — and that is the point. The descending half also contains a `3` (at index 5), but the ascending half is searched first, so the *smallest* index wins automatically. Reordering the two passes would return 5 and be wrong.

### Visualization

```text
idx      0   1   2   3   4   5   6
value    1   2   3   4   5   3   1
                 ▲           ▲
              target       target        both are 3 — we want the LEFT one

              ┌──── ascending ────┐┌── descending ──┐
              0 .............. peak=4 ............. 6

pass 1: slope search           → peak = 4
pass 2: binary search ↑ [0..4] → hit at index 2   ← returned
pass 3: binary search ↓ [5..6] → never reached

searching the ascending half FIRST is what makes the answer minimal
```

### Code

```go
// mountain hides the array behind get/length, mimicking the LeetCode API.
type mountain struct{ data []int }

func (m *mountain) get(i int) int { return m.data[i] }
func (m *mountain) length() int   { return len(m.data) }

func findInMountainArray(target int, m *mountain) int {
    n := m.length()

    // Pass 1: locate the summit with the slope search.
    lo, hi := 0, n-1
    for lo < hi {
        mid := lo + (hi-lo)/2
        if m.get(mid) < m.get(mid+1) {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    peak := lo

    // Pass 2: ascending half [0, peak]. A hit here is the smallest index.
    lo, hi = 0, peak
    for lo <= hi {
        mid := lo + (hi-lo)/2
        v := m.get(mid)
        if v == target {
            return mid
        } else if v < target {
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }

    // Pass 3: descending half [peak+1, n-1] — comparison flipped.
    lo, hi = peak+1, n-1
    for lo <= hi {
        mid := lo + (hi-lo)/2
        v := m.get(mid)
        if v == target {
            return mid
        } else if v > target {
            lo = mid + 1 // values shrink as index grows
        } else {
            hi = mid - 1
        }
    }
    return -1
}
```

```python
def findInMountainArray(target, mountain_arr):
    n = mountain_arr.length()

    # Pass 1: locate the summit with the slope search.
    lo, hi = 0, n - 1
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if mountain_arr.get(mid) < mountain_arr.get(mid + 1):
            lo = mid + 1
        else:
            hi = mid
    peak = lo

    # Pass 2: ascending half [0, peak]. A hit here is the smallest index.
    lo, hi = 0, peak
    while lo <= hi:
        mid = lo + (hi - lo) // 2
        v = mountain_arr.get(mid)
        if v == target:
            return mid
        elif v < target:
            lo = mid + 1
        else:
            hi = mid - 1

    # Pass 3: descending half [peak+1, n-1] - comparison flipped.
    lo, hi = peak + 1, n - 1
    while lo <= hi:
        mid = lo + (hi - lo) // 2
        v = mountain_arr.get(mid)
        if v == target:
            return mid
        elif v > target:
            lo = mid + 1                # values shrink as the index grows
        else:
            hi = mid - 1

    return -1
```

### Complexity
Time O(log n) — three independent binary searches, each halving its range; roughly `3·log₂ n` calls to `get`. Space O(1).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 162 | Find Peak | Easy | Core binary search application |
| 852 | Peak Mountain | Easy | Core binary search application |
| 1095 | Mountain Array | Medium | Core binary search application |
| 367 | Perfect Square | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Peak Element logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Peak Element (Binary Search).
- **Signal:** peak, local maximum, bitonic, slope, binary search.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Peak Element invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Peak Element
FAMILY : Binary Search (Advanced)
WHEN   : peak, local maximum, bitonic, slope, binary search
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 162, 852, 1095, 367
```

---

*Part of the DSA Patterns Handbook — pattern 27 of 100.*
