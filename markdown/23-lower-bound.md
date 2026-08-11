# 23 · Lower Bound

> **One-liner:** First index with value ≥ target — the bisect_left primitive.

---

## 1. Overview

### Definition
The **Lower Bound** pattern belongs to the *Binary Search* family. First index with value ≥ target — the bisect_left primitive.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
lower bound, first >=, bisect left, insert position.

### Constraints
- Input size where the brute-force complexity would time out — the Lower Bound optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Lower Bound invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Lower Bound is the upgrade.
- The wording maps onto: lower bound, first >=, bisect left, insert position.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"In a sorted array, where does `target` **begin**?"* — the first index whose value is `>= target`.

### Intuition
Walk from the left and stop at the first element that is not smaller than the target.

### Algorithm
1. For `i` from `0` to `n−1`:
2. &nbsp;&nbsp;If `nums[i] >= target`, return `i`.
3. If the loop finishes, every element was smaller — return `n`.

### Complexity
- Time: **O(n)** per query.
- Space: O(1).

### Drawbacks
- It is correct, and for one query on a small array it is fine.
- But it ignores the sortedness completely. Looking at `nums[mid]` tells you about **half the array at once**, and the linear scan throws that away.
- With `q` queries it becomes O(q·n); binary search makes it O(q·log n).

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Binary search not for an exact value, but for the boundary where "too small" turns into "good enough".**

Picture the array through the lens of the test `nums[i] >= target`. Because the array is sorted, the answers to that test form a block of `false` followed by a block of `true`:

```text
nums   :  1   3   5   6        target = 4
>= 4?  :  F   F   T   T
                  ↑
              lower bound = 2
```

Lower bound is **the index of the first `T`**. That's all it is. There is no "not found" case — if every answer is `F`, the boundary sits at `n`.

### The thought process

```text
We need    : the first index with nums[i] >= target.
Obvious way: scan from the left.
Too slow   : O(n), and it ignores that the array is sorted.
Notice     : "nums[i] >= target" is FALSE for a prefix and TRUE forever after.
             A sorted array makes that test monotone.
Therefore  : binary search for the F→T boundary.
Now        : O(log n), and it never needs an equality check.
```

### Steps

```text
Step 1 → lo = 0, hi = n            ← note: n, not n-1
Step 2 → While lo < hi:
Step 3 →     mid = lo + (hi - lo) / 2
Step 4 →     if nums[mid] < target → answer is strictly right → lo = mid + 1
Step 5 →     else                  → mid still qualifies      → hi = mid
Step 6 → Return lo.
```

### Why the half-open range `[lo, hi)` is the right shape

Two reasons, and they are the whole reason this template has no off-by-one bugs.

**1. `hi = n` is expressible.** The answer can legitimately be "past the end" (every element is smaller). With an inclusive `[lo, hi]` range and `hi = n-1`, there is no way to *represent* that answer without a special case afterwards.

**2. The invariant is uniform.** Throughout the loop:

```text
everything left of lo  →  definitely < target
everything at or right of hi →  definitely >= target
[lo, hi) is the region still unknown
```

`lo = mid + 1` and `hi = mid` both preserve that, and both strictly shrink the range, so the loop always terminates. When `lo == hi` the unknown region is empty and `lo` is the boundary.

### Why `hi = mid` and not `hi = mid - 1`

Because when `nums[mid] >= target`, `mid` **is itself a candidate** — it might be the very first such index. Discarding it with `mid - 1` would lose the answer. Meanwhile `lo = mid + 1` *is* safe, because `nums[mid] < target` proves `mid` can never be the answer.

That asymmetry is the heart of the template: **one side excludes `mid`, the other keeps it.**

### Why `lo + (hi - lo) / 2` and not `(lo + hi) / 2`

They agree mathematically, but `lo + hi` can overflow a 32-bit int when both are near the maximum. Go and Python integers make this a non-issue in practice; in Java and C++ it is a real bug that famously sat in the JDK's binary search for years. Write the safe form out of habit.

### Lower bound vs upper bound

They differ by a single comparison:

```text
lower bound → first index with nums[i] >= target   (uses <  in the test)
upper bound → first index with nums[i] >  target   (uses <= in the test)
```

And they combine into the two facts you actually use:

```text
count of target        = upperBound(target) - lowerBound(target)
target is present iff  lowerBound(target) < n && nums[lowerBound(target)] == target
```

### How should I recognize this?

```text
If you see...
  sorted data plus "first / leftmost / insert position"
  "how many elements are less than X"
  "smallest element >= X", "count occurrences of X"
  a monotone predicate: false…false, true…true
        ↓
Think about...
  "Where does FALSE become TRUE?"
        ↓
Use...
  lo=0, hi=n, half-open; nums[mid] < target → lo=mid+1, else hi=mid
```

### Visual explanation

```svg
<svg viewBox="0 0 620 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-23" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Lower bound (target = 5): first index where a[i] &gt;= 5</text>
  <rect x="24"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="96"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="81" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="168" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="240" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="274" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="312" y="52" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="346" y="81" text-anchor="middle" fill="#1e293b" font-weight="700">6</text>
  <rect x="384" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="81" text-anchor="middle" fill="#1e293b">7</text>
  <rect x="456" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="81" text-anchor="middle" fill="#1e293b">9</text>
  <rect x="528" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="81" text-anchor="middle" fill="#1e293b">11</text>
  <line x1="312" y1="44" x2="312" y2="112" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="185" y="130" text-anchor="middle" fill="#d97706">predicate a[i] &lt; 5  (false)</text>
  <text x="470" y="130" text-anchor="middle" fill="#2563eb">a[i] &gt;= 5  (true)</text>
  <text x="346" y="150" text-anchor="middle" fill="#059669" font-weight="700">boundary = lower_bound</text>
  <text x="310" y="188" text-anchor="middle" fill="#64748b">first true when the predicate flips false → true</text>
</svg>
```

```text
nums = [1, 3, 5, 6]   target = 4

lo=0 hi=4  mid=2  nums[2]=5 >= 4  → mid qualifies → hi=2
lo=0 hi=2  mid=1  nums[1]=3 <  4  → mid is out    → lo=2
lo=2 hi=2  → range empty → answer 2

           1   3   5   6
          [F] [F] [T] [T]
                   ↑
              first TRUE = 2
```

### Interview explanation
"I'll treat this as a boundary search rather than a value search. Because the array is sorted, the predicate `nums[i] >= target` is false on a prefix and true on the rest, so I binary search for the first true. I use a half-open range `[0, n)` — that lets the answer be `n` when every element is smaller, without a special case. When `nums[mid] < target` I know `mid` can't be the answer, so `lo = mid + 1`; otherwise `mid` is still a candidate, so `hi = mid`, never `mid - 1`. O(log n) time, O(1) space, and no equality check anywhere."

---

## 5. Generic Templates

> `lo = 0`, `hi = n`, `while lo < hi`. One branch excludes `mid`, the other keeps it.

```go
// LowerBound returns the first index i with nums[i] >= target,
// or len(nums) if no such index exists. nums must be sorted ascending.
func LowerBound(nums []int, target int) int {
    lo, hi := 0, len(nums) // half-open [lo, hi)
    for lo < hi {
        mid := lo + (hi-lo)/2 // written this way to avoid overflow
        if nums[mid] < target {
            lo = mid + 1 // mid is too small: it can never be the answer
        } else {
            hi = mid // mid still qualifies: keep it in range
        }
    }
    return lo
}

// UpperBound returns the first index i with nums[i] > target.
// The only change from LowerBound is <= instead of <.
func UpperBound(nums []int, target int) int {
    lo, hi := 0, len(nums)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] <= target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}

// CountOccurrences uses both bounds to count copies of target in O(log n).
func CountOccurrences(nums []int, target int) int {
    return UpperBound(nums, target) - LowerBound(nums, target)
}

// Contains reports whether target is present, via the lower bound.
func Contains(nums []int, target int) bool {
    i := LowerBound(nums, target)
    return i < len(nums) && nums[i] == target
}
```

```python
def lower_bound(nums, target):
    """First index i with nums[i] >= target, or len(nums)."""
    lo, hi = 0, len(nums)              # half-open [lo, hi)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] < target:
            lo = mid + 1               # mid too small: never the answer
        else:
            hi = mid                   # mid still qualifies: keep it
    return lo

def upper_bound(nums, target):
    """First index i with nums[i] > target. Only <= differs from lower_bound."""
    lo, hi = 0, len(nums)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] <= target:
            lo = mid + 1
        else:
            hi = mid
    return lo

def count_occurrences(nums, target):
    return upper_bound(nums, target) - lower_bound(nums, target)

def contains(nums, target):
    i = lower_bound(nums, target)
    return i < len(nums) and nums[i] == target

# The standard library ships both:
#   from bisect import bisect_left  as lower_bound
#   from bisect import bisect_right as upper_bound
```

```java
public class LowerBoundPattern {
    // First index i with nums[i] >= target, or nums.length.
    public static int lowerBound(int[] nums, int target) {
        int lo = 0, hi = nums.length;              // half-open [lo, hi)
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;          // overflow-safe
            if (nums[mid] < target) lo = mid + 1;  // mid can't be the answer
            else hi = mid;                         // mid still qualifies
        }
        return lo;
    }

    // First index i with nums[i] > target. Only <= differs.
    public static int upperBound(int[] nums, int target) {
        int lo = 0, hi = nums.length;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] <= target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    public static int countOccurrences(int[] nums, int target) {
        return upperBound(nums, target) - lowerBound(nums, target);
    }

    public static boolean contains(int[] nums, int target) {
        int i = lowerBound(nums, target);
        return i < nums.length && nums[i] == target;
    }
}
```

```cpp
#include <vector>
using namespace std;

// First index i with nums[i] >= target, or nums.size().
int lowerBound(const vector<int>& nums, int target) {
    int lo = 0, hi = (int)nums.size();             // half-open [lo, hi)
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;              // overflow-safe
        if (nums[mid] < target) lo = mid + 1;      // mid can't be the answer
        else hi = mid;                             // mid still qualifies
    }
    return lo;
}

// First index i with nums[i] > target. Only <= differs.
int upperBound(const vector<int>& nums, int target) {
    int lo = 0, hi = (int)nums.size();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

int countOccurrences(const vector<int>& nums, int target) {
    return upperBound(nums, target) - lowerBound(nums, target);
}

// The STL ships both: std::lower_bound / std::upper_bound.
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Lower Bound (Optimal) |
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

### Problem — Search Insert Position (LeetCode 35)
Given a sorted array of distinct integers and a `target`, return the index of the target if present, otherwise the index where it should be inserted.

### Thought Process
1. Both cases the problem describes are the *same* index: the first position whose value is `>= target`.
   - Target present → that position is the target itself.
   - Target absent → that position is the first larger element, which is exactly where it belongs.
2. So this is a plain lower bound. No equality check is needed anywhere.
3. Half-open `[0, n)` handles "target is bigger than everything" by returning `n`, with no special case.

### Dry Run

Input: `nums = [1, 3, 5, 6]`, `target = 4`

| lo | hi | mid | nums[mid] | `nums[mid] < 4`? | action |
|----|----|-----|-----------|------------------|--------|
| 0 | 4 | 2 | 5 | no  | `mid` qualifies → `hi = 2` |
| 0 | 2 | 1 | 3 | yes | `mid` is out → `lo = 2` |
| 2 | 2 | — | — | — | `lo == hi` → return **2** |

Output: **2** — inserting `4` at index 2 gives `[1, 3, 4, 5, 6]`, still sorted. ✓

**Edge cases from the same code:**

| input | result | why |
|---|---|---|
| `target = 5` | 2 | present at index 2; lower bound lands on it |
| `target = 0` | 0 | smaller than everything → insert at the front |
| `target = 7` | 4 | larger than everything → `hi = n = 4` is returned |

### Visualization

```text
nums  :   1    3    5    6          target = 4
>= 4? :   F    F    T    T
index :   0    1    2    3    (4)
                    ↑
              first TRUE → insert at 2
```

### Code

```go
func searchInsert(nums []int, target int) int {
    lo, hi := 0, len(nums) // half-open: hi = n lets "past the end" be an answer
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] < target {
            lo = mid + 1 // mid is too small, discard it
        } else {
            hi = mid // mid still qualifies, keep it in range
        }
    }
    return lo
}
```

```python
def searchInsert(nums, target):
    lo, hi = 0, len(nums)          # half-open [lo, hi)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] < target:
            lo = mid + 1           # mid too small, discard
        else:
            hi = mid               # mid still qualifies
    return lo
```

### Complexity
Time O(log n) — the range halves each iteration. Space O(1).

---

## 10. Solved Example 2

### Problem — Longest Increasing Subsequence (LeetCode 300)
Return the length of the longest **strictly increasing** subsequence.

### Thought Process
1. The O(n²) DP is the natural first answer. The O(n log n) version uses a lower bound in a clever way.
2. Keep an array `tails`, where `tails[k]` = **the smallest possible tail value** of any increasing subsequence of length `k+1`.
3. `tails` is always sorted — a longer subsequence must end at a larger value — so we can binary search it.
4. For each `x`, find the first tail `>= x` (a lower bound):
   - **Past the end** → `x` is bigger than every tail, so it extends the longest run. Append it.
   - **Inside** → replace that tail with `x`. Same length, but a smaller tail, which can only make future extensions easier.
5. The answer is `len(tails)`.

> **Important:** `tails` is *not* itself a valid subsequence. Only its **length** is the answer. Saying otherwise is a common interview slip.

Why *lower* bound and not upper? Lower bound finds the first tail `>= x`, so an equal tail gets **replaced**. That is what enforces *strictly* increasing. Using upper bound instead would allow equal values through and solve the non-decreasing variant.

### Dry Run

Input: `nums = [10, 9, 2, 5, 3, 7]`

| x | lower bound in `tails` | past the end? | action | `tails` after |
|---|------------------------|---------------|--------|---------------|
| 10 | 0 in `[]`        | yes | append   | `[10]`     |
| 9  | 0 in `[10]`      | no  | replace index 0 | `[9]`  |
| 2  | 0 in `[9]`       | no  | replace index 0 | `[2]`  |
| 5  | 1 in `[2]`       | yes | append   | `[2, 5]`   |
| 3  | 1 in `[2,5]`     | no  | replace index 1 | `[2, 3]` |
| 7  | 2 in `[2,3]`     | yes | append   | `[2, 3, 7]` |

Output: **`len(tails) = 3`**

Check by hand: `2 → 3 → 7` is increasing and has length 3. No length-4 increasing subsequence exists in `[10,9,2,5,3,7]`. ✓

Watch the `3` step: it replaced the `5`. Both `[2,5]` and `[2,3]` represent length-2 subsequences, but ending at `3` leaves more room for what comes next — and indeed `7` then extended it.

### Visualization

```text
nums:  10   9   2   5   3   7

tails evolves, always sorted:

  [10]
  [9]              9 replaces 10   (same length, smaller tail)
  [2]              2 replaces 9
  [2, 5]           5 is bigger than every tail → append, length 2
  [2, 3]           3 replaces 5    (same length, smaller tail)
  [2, 3, 7]        7 appends       → length 3   ★
```

### Code

```go
func lengthOfLIS(nums []int) int {
    // tails[k] = smallest tail among increasing subsequences of length k+1.
    tails := []int{}

    for _, x := range nums {
        // Lower bound: first tail >= x. Using >= (not >) enforces STRICT increase.
        i := lowerBoundInts(tails, x)
        if i == len(tails) {
            tails = append(tails, x) // x extends the longest run
        } else {
            tails[i] = x // same length, but a smaller tail is strictly better
        }
    }
    return len(tails)
}

func lowerBoundInts(nums []int, target int) int {
    lo, hi := 0, len(nums)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}
```

```python
from bisect import bisect_left

def lengthOfLIS(nums):
    tails = []                      # tails[k] = smallest tail of an LIS of length k+1
    for x in nums:
        i = bisect_left(tails, x)   # lower bound: >= enforces STRICT increase
        if i == len(tails):
            tails.append(x)         # x extends the longest run
        else:
            tails[i] = x            # same length, smaller tail is better
    return len(tails)
```

### Complexity
Time **O(n log n)** — one binary search per element. Space O(n) for `tails`.

---

## 11. Solved Example 3

### Problem — Russian Doll Envelopes (LeetCode 354)
Envelope `(w, h)` fits inside `(W, H)` only if `w < W` **and** `h < H`. Return the largest number that can be nested.

### Thought Process
1. This is LIS in two dimensions. Sorting by width reduces it to one dimension — then we just need an LIS on the heights.
2. But there is a trap. If two envelopes share a width, sorting by height *ascending* would let the LIS chain them together — and they can't nest, because nesting needs `w < W` **strictly**.
3. **Fix: sort by width ascending, and by height *descending* when widths tie.** Now equal-width envelopes appear in decreasing height order, so a strictly increasing run can never pick two of them.
4. Then run the O(n log n) LIS from the previous example on the heights.

### Dry Run

Input: `envelopes = [[5,4], [6,4], [6,7], [2,3]]`

**Step 1 — sort** (width ascending, height descending on ties):

```text
[2,3]  [5,4]  [6,7]  [6,4]
                └──────┘
        width 6 appears twice → heights ordered 7 then 4 (descending)
```

**Step 2 — LIS on the heights `[3, 4, 7, 4]`:**

| h | lower bound in `tails` | action | `tails` after |
|---|------------------------|--------|---------------|
| 3 | 0 in `[]`      | append  | `[3]`       |
| 4 | 1 in `[3]`     | append  | `[3, 4]`    |
| 7 | 2 in `[3,4]`   | append  | `[3, 4, 7]` |
| 4 | 1 in `[3,4,7]` | replace index 1 | `[3, 4, 7]` |

Output: **3** — the chain `[2,3] → [5,4] → [6,7]`. ✓

**See the descending-height trick work:** the two width-6 envelopes give heights `7` then `4`. Since `4 < 7`, the later one cannot extend a run containing the earlier one. Had we sorted heights ascending (`4` then `7`), the LIS would have chained `4 → 7` and returned **4**, claiming `[6,4]` nests inside `[6,7]` — which is wrong, since their widths are equal.

### Visualization

```text
sorted:   [2,3]   [5,4]   [6,7]   [6,4]
heights:    3       4       7       4
            └───────┴───────┘
            strictly increasing 3 → 4 → 7   → answer 3

same width, heights descending (7 then 4)
   ⇒ the strict LIS can never take both   ✓
```

### Code

```go
func maxEnvelopes(envelopes [][]int) int {
    // Width ascending; on ties, height DESCENDING so equal widths can never
    // both appear in a strictly increasing run of heights.
    sort.Slice(envelopes, func(i, j int) bool {
        if envelopes[i][0] == envelopes[j][0] {
            return envelopes[i][1] > envelopes[j][1]
        }
        return envelopes[i][0] < envelopes[j][0]
    })

    // Now it is just an LIS over the heights.
    tails := []int{}
    for _, e := range envelopes {
        h := e[1]
        // sort.SearchInts is the standard library's lower bound:
        // the first index i with tails[i] >= h.
        i := sort.SearchInts(tails, h)
        if i == len(tails) {
            tails = append(tails, h)
        } else {
            tails[i] = h
        }
    }
    return len(tails)
}
```

```python
from bisect import bisect_left

def maxEnvelopes(envelopes):
    # Width ascending; on ties, height DESCENDING.
    envelopes.sort(key=lambda e: (e[0], -e[1]))

    tails = []                          # LIS over the heights
    for _, h in envelopes:
        i = bisect_left(tails, h)
        if i == len(tails):
            tails.append(h)
        else:
            tails[i] = h
    return len(tails)
```

### Complexity
Time **O(n log n)** — the sort and the LIS are both O(n log n). Space O(n).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 35 | Search Insert | Easy | Core binary search application |
| 300 | LIS | Easy | Core binary search application |
| 354 | Russian Dolls | Medium | Core binary search application |
| 2300 | Spells Potions | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Lower Bound logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Lower Bound (Binary Search).
- **Signal:** lower bound, first >=, bisect left, insert position.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Lower Bound invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Lower Bound
FAMILY : Binary Search (Intermediate)
WHEN   : lower bound, first >=, bisect left, insert position
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 35, 300, 354, 2300
```

---

*Part of the DSA Patterns Handbook — pattern 23 of 100.*
