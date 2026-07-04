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
A representative **Binary Search on Answer** problem. The signal: binary search the answer value, using a feasibility check as the predicate.

### Thought Process
1. Confirm the pattern via its recognition signals (binary search answer, minimize maximum, feasible, parametric, capacity).
2. Reach for the Binary Search on Answer template below and map the problem's entities onto it.
3. If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Binary Search on Answer step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(log n), Space O(1). Each step halves the range; iterative form uses constant space.

## 10. Solved Example 2

### Problem — Ship Within Days (LeetCode 1011)
A representative **Binary Search on Answer** problem. The signal: binary search the answer value, using a feasibility check as the predicate.

### Thought Process
1. Confirm the pattern via its recognition signals (binary search answer, minimize maximum, feasible, parametric, capacity).
2. Reach for the Binary Search on Answer template below and map the problem's entities onto it.
3. If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Binary Search on Answer step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(log n), Space O(1). Each step halves the range; iterative form uses constant space.

## 11. Solved Example 3

### Problem — Split Array (LeetCode 410)
A representative **Binary Search on Answer** problem. The signal: binary search the answer value, using a feasibility check as the predicate.

### Thought Process
1. Confirm the pattern via its recognition signals (binary search answer, minimize maximum, feasible, parametric, capacity).
2. Reach for the Binary Search on Answer template below and map the problem's entities onto it.
3. If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Binary Search on Answer step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(log n), Space O(1). Each step halves the range; iterative form uses constant space.


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
