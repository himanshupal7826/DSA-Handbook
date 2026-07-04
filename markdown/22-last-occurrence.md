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

### Intuition
Linear scan checks each candidate — O(n).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Last Occurrence pattern is built to use.

---

## 4. Optimal Approach

### Core idea
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Last Occurrence invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Last Occurrence   : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Last Occurrence problem. I'll if the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration. That brings the complexity down to O(log n) time and O(1) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Binary Search** family template. Adapt the comparison/condition to the specific problem.

```go
// Lower bound: first index with a[i] >= target. Half-open invariant [lo, hi).
func lowerBound(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2     // avoids overflow
        if a[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}
```

```python
def lower_bound(a, target):
    lo, hi = 0, len(a)            # half-open [lo, hi)
    while lo < hi:
        mid = (lo + hi) // 2
        if a[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return lo                     # first index with a[i] >= target
```

```java
int lowerBound(int[] a, int target) {
    int lo = 0, hi = a.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
```

```cpp
int lowerBound(vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
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
Given a sorted array with duplicates, return `[first, last]` — the leftmost and rightmost indices of `target`, or `[-1, -1]` if absent.

### Thought Process
1. Run a lower-bound search: first index with `nums[i] >= target`. That is the *first* occurrence (if it equals target).
2. For the *last* occurrence, run an upper-bound search: first index with `nums[i] > target`, then subtract 1 — this is the Last Occurrence move.
3. Guard the empty/absent case: if the first index is out of range or `nums[first] != target`, return `[-1, -1]`.

### Dry Run
`nums = [5,7,7,8,8,10], target = 8`
- lower_bound(8) → first index with value ≥ 8 → index 3.
- upper_bound(8) → first index with value > 8 → index 5; last = 5 - 1 = 4.
- `nums[3] == 8`, so answer = `[3, 4]`.

### Visualization
```
[5,7,7,8,8,10]  target=8
        ^   ^
     first=3 last=upper(5)-1=4  ──▶ [3,4]
```

### Code
```python
def searchRange(nums, target):
    def lower_bound(x):
        lo, hi = 0, len(nums)
        while lo < hi:
            mid = (lo + hi) // 2
            if nums[mid] < x:
                lo = mid + 1
            else:
                hi = mid
        return lo

    first = lower_bound(target)
    if first == len(nums) or nums[first] != target:
        return [-1, -1]
    last = lower_bound(target + 1) - 1   # upper bound - 1
    return [first, last]
```

### Complexity
Time O(log n) — two binary searches; Space O(1).

## 10. Solved Example 2

### Problem — K Closest (LeetCode 658)
Given a sorted array `arr`, return the `k` elements closest to `x`, in ascending order (ties prefer the smaller value).

### Thought Process
1. The answer is a contiguous window of length `k`. We only need its left index `lo`, which ranges over `[0, len(arr) - k]`.
2. Binary search that left bound: compare the window edges. If `x - arr[mid] > arr[mid + k] - x`, the right edge is closer, so slide right (`lo = mid + 1`); otherwise keep left (`hi = mid`).
3. When `lo` converges, `arr[lo : lo + k]` is the closest window, already sorted.

### Dry Run
`arr = [1,2,3,4,5], k = 4, x = 3`, search lo in `[0,1]`.
- mid=0: `x-arr[0]=2` vs `arr[4]-x=2` → not greater → `hi = 0`.
- lo==hi==0 → window `arr[0:4]` = `[1,2,3,4]`.

### Visualization
```
[1,2,3,4,5] k=4 x=3
 lo=0 ─────┘ window arr[0:4] = [1,2,3,4]
```

### Code
```python
def findClosestElements(arr, k, x):
    lo, hi = 0, len(arr) - k          # left bound of the window
    while lo < hi:
        mid = (lo + hi) // 2
        if x - arr[mid] > arr[mid + k] - x:
            lo = mid + 1              # right edge closer → shift window right
        else:
            hi = mid
    return arr[lo:lo + k]
```

### Complexity
Time O(log(n - k) + k) — binary search plus slicing the window; Space O(1) extra.

## 11. Solved Example 3

### Problem — Single Element (LeetCode 540)
In a sorted array where every element appears exactly twice except one, find the single element in O(log n) time.

### Thought Process
1. Pairs `(0,1),(2,3),...` start at even indices. Before the single element, each pair's first member sits at an even index and equals its right neighbor.
2. Binary search on even indices. Use `mid ^ 1` to get mid's pair partner (flips the low bit): if `nums[mid] == nums[mid ^ 1]`, the single element is to the right (`lo = mid + 2`); else it's at `mid` or to the left (`hi = mid`).
3. Keep `lo` even so the invariant holds; `lo` converges on the answer.

### Dry Run
`nums = [1,1,2,3,3,4,4]`, lo=0, hi=6.
- mid=2 (even), `mid^1=3`: `nums[2]=2 != nums[3]=3` → `hi = 2`.
- mid=0, `mid^1=1`: `nums[0]=1 == nums[1]=1` → `lo = 2`.
- lo==hi==2 → answer `nums[2] = 2`.

### Visualization
```
[1,1,2,3,3,4,4]
     ^ pairs break here → single = nums[2] = 2
```

### Code
```python
def singleNonDuplicate(nums):
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if mid % 2 == 1:          # keep mid on an even index
            mid -= 1
        if nums[mid] == nums[mid + 1]:
            lo = mid + 2          # pair intact → single is to the right
        else:
            hi = mid              # break here or earlier
    return nums[lo]
```

### Complexity
Time O(log n) — binary search over pairs; Space O(1).


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
