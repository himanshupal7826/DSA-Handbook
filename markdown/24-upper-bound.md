# 24 · Upper Bound

> **One-liner:** First index with value > target — the bisect_right primitive.

---

## 1. Overview

### Definition
The **Upper Bound** pattern belongs to the *Binary Search* family. First index with value > target — the bisect_right primitive.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
upper bound, first >, bisect right, count, insert.

### Constraints
- Input size where the brute-force complexity would time out — the Upper Bound optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Upper Bound invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Upper Bound is the upgrade.
- The wording maps onto: upper bound, first >, bisect right, count, insert.

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
Redundant recomputation; does not exploit the structure the Upper Bound pattern is built to use.

---

## 4. Optimal Approach

### Core idea
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Upper Bound invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation
```
brute  : recompute everything each step      ──▶ slow
Upper Bound       : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Upper Bound problem. I'll if the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration. That brings the complexity down to O(log n) time and O(1) space — here's the template."

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

| Metric | Brute Force | Upper Bound (Optimal) |
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
A representative **Upper Bound** problem. The signal: first index with value > target — the bisect_right primitive.

### Thought Process
1. Confirm the pattern via its recognition signals (upper bound, first >, bisect right, count, insert).
2. Reach for the Upper Bound template below and map the problem's entities onto it.
3. If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Upper Bound step-by-step ]
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

### Problem — Range Frequency (LeetCode 2080)
A representative **Upper Bound** problem. The signal: first index with value > target — the bisect_right primitive.

### Thought Process
1. Confirm the pattern via its recognition signals (upper bound, first >, bisect right, count, insert).
2. Reach for the Upper Bound template below and map the problem's entities onto it.
3. If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Upper Bound step-by-step ]
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

### Problem — Time Map (LeetCode 981)
A representative **Upper Bound** problem. The signal: first index with value > target — the bisect_right primitive.

### Thought Process
1. Confirm the pattern via its recognition signals (upper bound, first >, bisect right, count, insert).
2. Reach for the Upper Bound template below and map the problem's entities onto it.
3. If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Upper Bound step-by-step ]
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
| 35 | Search Insert | Easy | Core binary search application |
| 2080 | Range Frequency | Easy | Core binary search application |
| 981 | Time Map | Medium | Core binary search application |
| 1351 | Count Negatives | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Upper Bound logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Upper Bound (Binary Search).
- **Signal:** upper bound, first >, bisect right, count, insert.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Upper Bound invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Upper Bound
FAMILY : Binary Search (Intermediate)
WHEN   : upper bound, first >, bisect right, count, insert
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 35, 2080, 981, 1351
```

---

*Part of the DSA Patterns Handbook — pattern 24 of 100.*
