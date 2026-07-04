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

### Intuition
Linear scan checks each candidate — O(n).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Binary Search on Answer pattern is built to use.

---

## 4. Optimal Approach

### Core idea
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Binary Search on Answer invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Binary Search on A: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Binary Search on Answer problem. I'll if the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration. That brings the complexity down to O(log n) time and O(1) space — here's the template."

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
Koko eats bananas at speed `k` per hour, finishing one pile per hour (or less). Find the minimum integer `k` so she finishes all piles within `h` hours.

### Thought Process
1. The answer `k` is monotonic: if speed `k` works within `h` hours, any faster speed also works — so binary search `k`.
2. Feasibility `feasible(k)` = total hours `sum(ceil(p/k))` is `<= h`. Search `k` in `[1, max(piles)]`.
3. Find the smallest `k` for which `feasible(k)` is true using a lower-bound style search.

### Dry Run
piles=[3,6,7,11], h=8. Range [1,11], mid=6 → hours=1+1+2+2=6 ≤ 8 → feasible, go left (hi=6).
mid=3 → hours=1+2+3+4=10 > 8 → infeasible, lo=4. mid=5 → 1+2+2+3=8 ≤ 8 → hi=5.
mid=4 → 1+2+2+3=8 ≤ 8 → hi=4. lo=hi=4 → answer **4**.

### Visualization
```
speed k ──▶ [ hours = Σ ceil(pile/k) ]
predicate ──▶ feasible(k) = hours ≤ h  (monotonic in k)
output ──▶ smallest k that stays within h hours
```

### Code
```python
import math

def minEatingSpeed(piles, h):
    def feasible(k):
        return sum(math.ceil(p / k) for p in piles) <= h

    lo, hi = 1, max(piles)           # k must be at least 1
    while lo < hi:
        mid = (lo + hi) // 2
        if feasible(mid):
            hi = mid                 # mid works; try slower
        else:
            lo = mid + 1             # too slow; speed up
    return lo                        # smallest feasible speed
```

### Complexity
Time O(n log(max(piles))), Space O(1) — each of the log candidates costs an O(n) feasibility scan.

## 10. Solved Example 2

### Problem — Ship Within Days (LeetCode 1011)
Packages with given `weights` must ship in order within `days`. A ship has a fixed daily capacity. Find the minimum capacity that ships everything within `days`.

### Thought Process
1. Capacity is monotonic: a larger capacity needs the same or fewer days, so binary search the capacity.
2. Lower bound is `max(weights)` (must fit the heaviest package); upper bound is `sum(weights)` (ship all in one day).
3. `feasible(cap)` = greedily fill each day until the next package overflows `cap`, counting days; feasible if `days_needed <= days`.

### Dry Run
weights=[1,2,3,4,5,6,7,8,9,10], days=5. Range [10,55], mid=32 → greedy days=2 ≤ 5 → hi=32.
mid=21 → days=3 ≤ 5 → hi=21. mid=15 → days=5 ≤ 5 → hi=15. mid=12 → days=6 > 5 → lo=13.
mid=14 → days=5 → hi=14. mid=13 → days=6 → lo=14. lo=hi=14 → answer **15**.

### Visualization
```
capacity cap ──▶ [ greedily pack packages into days ]
predicate ──▶ feasible(cap) = days_needed ≤ days  (monotonic in cap)
output ──▶ smallest capacity shipping within days
```

### Code
```python
def shipWithinDays(weights, days):
    def feasible(cap):
        used, load = 1, 0
        for w in weights:
            if load + w > cap:       # start a new day
                used += 1
                load = 0
            load += w
        return used <= days

    lo, hi = max(weights), sum(weights)
    while lo < hi:
        mid = (lo + hi) // 2
        if feasible(mid):
            hi = mid                 # capacity suffices; shrink it
        else:
            lo = mid + 1             # too small; grow capacity
    return lo                        # minimum feasible capacity
```

### Complexity
Time O(n log(sum(weights))), Space O(1) — a greedy O(n) day-count per binary-search step.

## 11. Solved Example 3

### Problem — Split Array Largest Sum (LeetCode 410)
Split `nums` into `k` non-empty contiguous subarrays so the largest subarray sum is minimized. Return that minimized largest sum.

### Thought Process
1. Binary search the answer `cap` = the allowed largest subarray sum. Fewer splits are needed as `cap` grows — monotonic.
2. Search `cap` in `[max(nums), sum(nums)]`: it must fit the biggest element, and one part could hold everything.
3. `feasible(cap)` = greedily extend a running sum, starting a new subarray whenever adding would exceed `cap`; feasible if the number of subarrays is `<= k`.

### Dry Run
nums=[7,2,5,10,8], k=2. Range [10,32], mid=21 → greedy parts: [7,2,5]=14,[10,8]=18 → 2 ≤ 2 → hi=21.
mid=15 → [7,2,5]=14,[10],[8] → 3 > 2 → lo=16. mid=18 → [7,2,5],[10,8] → 2 → hi=18.
mid=17 → [7,2,5],[10],[8] → 3 → lo=18. lo=hi=18 → answer **18**.

### Visualization
```
cap (largest allowed sum) ──▶ [ greedily cut subarrays ]
predicate ──▶ feasible(cap) = pieces ≤ k  (monotonic in cap)
output ──▶ smallest cap achievable with k pieces
```

### Code
```python
def splitArray(nums, k):
    def feasible(cap):
        pieces, cur = 1, 0
        for x in nums:
            if cur + x > cap:        # cut here; open a new subarray
                pieces += 1
                cur = 0
            cur += x
        return pieces <= k

    lo, hi = max(nums), sum(nums)
    while lo < hi:
        mid = (lo + hi) // 2
        if feasible(mid):
            hi = mid                 # cap works; try a smaller max
        else:
            lo = mid + 1             # needs too many pieces; raise cap
    return lo                        # minimized largest subarray sum
```

### Complexity
Time O(n log(sum(nums))), Space O(1) — an O(n) greedy feasibility check per binary-search step.


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
