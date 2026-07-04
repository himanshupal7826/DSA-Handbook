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

### Intuition
Linear scan checks each candidate — O(n).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Lower Bound pattern is built to use.

---

## 4. Optimal Approach

### Core idea
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Lower Bound invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Lower Bound       : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Lower Bound problem. I'll if the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration. That brings the complexity down to O(log n) time and O(1) space — here's the template."

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

### Problem — Search Insert (LeetCode 35)
Given a sorted array and a target, return the index where target is found, or the leftmost index where it should be inserted to keep the array sorted.

### Thought Process
1. The insert position is exactly the first index `i` with `nums[i] >= target` — a textbook lower bound.
2. Run a half-open binary search on `[0, n)`: when `nums[mid] < target` the answer lies strictly right, else `mid` is still a candidate.
3. When the loop collapses, `lo` is the leftmost qualifying index (or `n` if target exceeds every element).

### Dry Run
`nums=[1,3,5,6]`, `target=4`.
- `lo=0,hi=4 → mid=2, nums[2]=5 >= 4 → hi=2`
- `lo=0,hi=2 → mid=1, nums[1]=3 < 4 → lo=2`
- `lo=2,hi=2` stop → return `2` (insert between 3 and 5). Correct.

### Visualization
```
[1, 3, 5, 6]  target 4
       ^ first index with value >= 4  ──▶ insert at 2
```

### Code
```python
def searchInsert(nums, target):
    lo, hi = 0, len(nums)            # half-open [lo, hi)
    while lo < hi:
        mid = (lo + hi) // 2
        if nums[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return lo                        # leftmost index with nums[i] >= target
```

### Complexity
Time O(log n), Space O(1) — a single binary search over the array.

## 10. Solved Example 2

### Problem — LIS (LeetCode 300)
Return the length of the longest strictly increasing subsequence of `nums`.

### Thought Process
1. Maintain a `tails` array where `tails[k]` is the smallest possible tail of any increasing subsequence of length `k+1` (patience sorting).
2. For each value `x`, use `bisect_left` (a lower bound) to find the first tail `>= x`; that is the pile `x` belongs on.
3. If the position is past the end, `x` extends the longest run (append); otherwise it replaces that tail, keeping piles as small as possible. The answer is `len(tails)`.

### Dry Run
`nums=[10,9,2,5,3,7]`.
- 10 → tails=[10]; 9 replaces → [9]; 2 replaces → [2]
- 5 appends → [2,5]; 3 replaces the 5 → [2,3]; 7 appends → [2,3,7]
- `len(tails)=3` (e.g. 2,3,7). Correct.

### Visualization
```
value ──▶ bisect_left(tails, value)  (first tail >= value)
tails ──▶ [2, 3, 7]   length = LIS length
```

### Code
```python
from bisect import bisect_left

def lengthOfLIS(nums):
    tails = []                       # tails[k] = smallest tail of an LIS of length k+1
    for x in nums:
        i = bisect_left(tails, x)    # lower bound: first tail >= x
        if i == len(tails):
            tails.append(x)          # x extends the longest run
        else:
            tails[i] = x             # keep piles minimal
    return len(tails)
```

### Complexity
Time O(n log n) — one lower-bound search per element; Space O(n) for `tails`.

## 11. Solved Example 3

### Problem — Russian Dolls (LeetCode 354)
Each envelope has a width and height; one fits inside another only if both dimensions are strictly larger. Return the maximum number of envelopes you can nest.

### Thought Process
1. Sort by width ascending, and on equal widths by height **descending** — the descending tie-break stops two same-width envelopes from ever counting as an increasing pair.
2. With widths handled by the sort, the answer reduces to the strictly increasing LIS on the heights sequence.
3. Compute that LIS in O(n log n) with `bisect_left` (lower bound) on a `tails` array, exactly as in problem 300.

### Dry Run
`[[5,4],[6,4],[6,7],[2,3]]` → sort → `[[2,3],[5,4],[6,7],[6,4]]`.
- heights = `[3, 4, 7, 4]`
- LIS via bisect_left: 3→[3]; 4→[3,4]; 7→[3,4,7]; 4 replaces 7→[3,4,4]
- `len(tails)=3` → answer `3`. Correct.

### Visualization
```
sort (w asc, h desc on ties) ──▶ heights [3, 4, 7, 4]
LIS on heights via bisect_left ──▶ length 3
```

### Code
```python
from bisect import bisect_left

def maxEnvelopes(envelopes):
    envelopes.sort(key=lambda e: (e[0], -e[1]))   # width asc, height desc on ties
    tails = []                                    # LIS on heights
    for _, h in envelopes:
        i = bisect_left(tails, h)                 # lower bound: first tail >= h
        if i == len(tails):
            tails.append(h)
        else:
            tails[i] = h
    return len(tails)
```

### Complexity
Time O(n log n) — sort plus one lower-bound search per envelope; Space O(n) for `tails`.


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
