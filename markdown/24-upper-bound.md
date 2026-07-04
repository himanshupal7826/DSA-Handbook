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

```svg
<svg viewBox="0 0 620 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-24" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Upper bound (target = 4): first index where a[i] &gt; 4 (strict)</text>
  <rect x="24"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="96"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="81" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="168" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="240" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="274" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="312" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="346" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="384" y="52" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="418" y="81" text-anchor="middle" fill="#1e293b" font-weight="700">6</text>
  <rect x="456" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="81" text-anchor="middle" fill="#1e293b">9</text>
  <rect x="528" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="81" text-anchor="middle" fill="#1e293b">11</text>
  <line x1="384" y1="44" x2="384" y2="112" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="200" y="130" text-anchor="middle" fill="#d97706">predicate a[i] &lt;= 4  (false)</text>
  <text x="490" y="130" text-anchor="middle" fill="#2563eb">a[i] &gt; 4  (true)</text>
  <text x="418" y="150" text-anchor="middle" fill="#059669" font-weight="700">boundary = upper_bound</text>
  <text x="310" y="188" text-anchor="middle" fill="#64748b">note: equal values fall on the FALSE side (strict &gt;)</text>
</svg>
```

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
Given a sorted array of **distinct** integers and a target, return the index if the target is found, else the index where it would be inserted to keep the array sorted.

### Thought Process
1. The insert position is exactly the leftmost index `i` with `nums[i] >= target` — this is a lower-bound query on the sorted array.
2. Because the values are distinct, if the target is present the lower bound lands on it; if absent, it lands on the first larger element, i.e. the correct insertion slot.
3. Run the half-open `[lo, hi)` binary search: move `lo` past every element strictly less than target, and the surviving `lo` is the answer.

### Dry Run
`nums = [1, 3, 5, 6], target = 4`
- `lo=0, hi=4 → mid=2, nums[2]=5 >= 4 → hi=2`
- `lo=0, hi=2 → mid=1, nums[1]=3 < 4 → lo=2`
- `lo == hi == 2` → return `2` (4 inserts between 3 and 5). Correct.

### Visualization
```
input  ──▶ [ apply Upper Bound step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def searchInsert(nums, target):
    lo, hi = 0, len(nums)             # half-open [lo, hi)
    while lo < hi:
        mid = (lo + hi) // 2
        if nums[mid] < target:        # strictly less → discard left half
            lo = mid + 1
        else:
            hi = mid
    return lo                         # first index with nums[i] >= target
```

### Complexity
Time O(log n), Space O(1) — one binary search over the sorted array.

## 10. Solved Example 2

### Problem — Range Frequency (LeetCode 2080)
Build a structure over a fixed array that answers many `query(left, right, value)` calls: how many times does `value` occur in the subarray `arr[left..right]`?

### Thought Process
1. For each distinct value, store the **sorted list of indices** where it appears (indices are naturally increasing as we scan left to right).
2. A count within `[left, right]` is a count of indices in that band — the classic `upper_bound - lower_bound` trick on the value's index list.
3. `bisect_right(idxs, right)` gives how many indices are `<= right`; `bisect_left(idxs, left)` gives how many are `< left`. Their difference is the occurrences inside `[left, right]`.

### Dry Run
`arr = [12, 33, 4, 56, 22, 2, 34, 33, 22, 12, 34, 56]`; indices of `33` are `[1, 7]`.
- `query(4, 8, 33)`: `bisect_right([1,7], 8) = 2`, `bisect_left([1,7], 4) = 1`
- count = `2 - 1 = 1` (only index 7 lies in [4,8]). Correct.

### Visualization
```
input  ──▶ [ apply Upper Bound step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from bisect import bisect_left, bisect_right
from collections import defaultdict

class RangeFreqQuery:
    def __init__(self, arr):
        self.pos = defaultdict(list)
        for i, v in enumerate(arr):     # indices per value, already sorted
            self.pos[v].append(i)

    def query(self, left, right, value):
        idxs = self.pos.get(value)
        if not idxs:
            return 0
        # upper_bound(right) - lower_bound(left) = count in [left, right]
        return bisect_right(idxs, right) - bisect_left(idxs, left)
```

### Complexity
Build O(n); each query O(log k) where k is that value's frequency. Space O(n).

## 11. Solved Example 3

### Problem — Time Map (LeetCode 981)
Design a key-value store where `set(key, value, timestamp)` records a value at a time, and `get(key, timestamp)` returns the value stored at the greatest `timestamp_prev <= timestamp` (or `""` if none).

### Thought Process
1. `set` is always called with strictly increasing timestamps per key, so each key's list of `(timestamp, value)` pairs is kept sorted by timestamp automatically.
2. `get` needs the last entry whose timestamp is `<= t` — take the **upper bound** (`bisect_right`) of `t` in the timestamp list, which is the first index strictly greater than `t`.
3. Step back one index: `i - 1` is the largest timestamp `<= t`. If `i == 0`, nothing qualifies, so return `""`.

### Dry Run
`set(foo,bar,1)`, `set(foo,baz,4)` → `foo` timestamps `[1, 4]`.
- `get(foo, 3)`: `bisect_right([1,4], 3) = 1` → index `1-1 = 0` → value at ts 1 = `"bar"`. Correct.
- `get(foo, 4)`: `bisect_right([1,4], 4) = 2` → index `1` → `"baz"`. Correct.

### Visualization
```
input  ──▶ [ apply Upper Bound step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from bisect import bisect_right
from collections import defaultdict

class TimeMap:
    def __init__(self):
        self.store = defaultdict(list)   # key -> [(timestamp, value), ...]

    def set(self, key, value, timestamp):
        self.store[key].append((timestamp, value))   # timestamps increasing

    def get(self, key, timestamp):
        arr = self.store.get(key, [])
        # upper_bound on timestamp, then step back one
        i = bisect_right(arr, (timestamp, chr(127)))
        return arr[i - 1][1] if i else ""
```

### Complexity
`set` O(1) amortized; `get` O(log n) via binary search. Space O(n) total entries.


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
