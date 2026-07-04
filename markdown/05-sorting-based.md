# 05 · Sorting Based Problems

> **One-liner:** Reorder data so structure (pairs, gaps, greedy choices) becomes obvious.

---

## 1. Overview

### Definition
The **Sorting Based Problems** pattern belongs to the *Foundations* family. Reorder data so structure (pairs, gaps, greedy choices) becomes obvious.

### Intuition
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Why it works
Precompute an auxiliary structure (hash map / prefix array) in one pass so each query is O(1). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.

---

## 2. Recognition Signals

### Keywords
sort, order, comparator, custom sort, greedy sort.

### Constraints
- Input size where the brute-force complexity would time out — the Sorting Based Problems optimization is the intended solution.
- Structural hints in the statement that match this family (Foundations).

### Hidden clues
- The problem can be reframed so the Sorting Based Problems invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Sorting Based Problems is the upgrade.
- The wording maps onto: sort, order, comparator, custom sort, greedy sort.

---

## 3. Brute Force Approach

### Intuition
Nested loops re-examine pairs/ranges, giving O(n^2) or worse.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Sorting Based Problems pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Sorting Based Problems invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="sb-05" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Merge Intervals: sort by start, then scan &amp; merge overlaps</text>
  <text x="40" y="72" fill="#64748b">sorted</text>
  <!-- sorted intervals as bars: [1,3] [2,6] overlap, [8,10] apart -->
  <rect x="110" y="56" width="100" height="28" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="160" y="75" text-anchor="middle" fill="#1e293b">[1,3]</text>
  <rect x="160" y="90" width="200" height="28" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="260" y="109" text-anchor="middle" fill="#1e293b">[2,6]</text>
  <rect x="410" y="56" width="100" height="28" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="460" y="75" text-anchor="middle" fill="#1e293b">[8,10]</text>
  <text x="235" y="140" text-anchor="middle" fill="#d97706">[1,3] and [2,6] overlap (2 ≤ 3)</text>
  <line x1="300" y1="150" x2="300" y2="176" stroke="#475569" marker-end="url(#sb-05)"/>
  <text x="40" y="200" fill="#64748b">merged</text>
  <!-- merged result -->
  <rect x="110" y="182" width="250" height="28" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="235" y="201" text-anchor="middle" fill="#1e293b">[1,6]</text>
  <rect x="410" y="182" width="100" height="28" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="460" y="201" text-anchor="middle" fill="#1e293b">[8,10]</text>
  <text x="320" y="232" text-anchor="middle" fill="#059669" font-weight="700">one left-to-right pass after sorting</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Sorting Based Prob: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Sorting Based Problems problem. I'll trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes. That brings the complexity down to O(n) time and O(n) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Foundations** family template. Adapt the comparison/condition to the specific problem.

```go
// Prefix-sum style precompute: range sum in O(1) after O(n) build.
func prefix(nums []int) []int {
    pre := make([]int, len(nums)+1)
    for i, v := range nums {
        pre[i+1] = pre[i] + v
    }
    return pre
}
func rangeSum(pre []int, l, r int) int { return pre[r+1] - pre[l] }
```

```python
def prefix(nums):
    pre = [0]*(len(nums)+1)
    for i, v in enumerate(nums):
        pre[i+1] = pre[i] + v
    return pre

def range_sum(pre, l, r):       # inclusive [l, r]
    return pre[r+1] - pre[l]
```

```java
int[] prefix(int[] nums) {
    int[] pre = new int[nums.length + 1];
    for (int i = 0; i < nums.length; i++) pre[i+1] = pre[i] + nums[i];
    return pre;
}
int rangeSum(int[] pre, int l, int r) { return pre[r+1] - pre[l]; }
```

```cpp
vector<long long> prefix(vector<int>& nums) {
    vector<long long> pre(nums.size()+1, 0);
    for (size_t i = 0; i < nums.size(); ++i) pre[i+1] = pre[i] + nums[i];
    return pre;
}
long long rangeSum(vector<long long>& pre, int l, int r) { return pre[r+1] - pre[l]; }
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Sorting Based Problems (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(n)** |

> One pass to build, O(1) per query.

---

## 7. Common Mistakes

1. Off-by-one in prefix arrays (use size n+1 and 1-based prefix indices).
2. Rebuilding the auxiliary structure inside a loop instead of once.
3. Integer overflow on large sums — use 64-bit accumulators.
4. Forgetting that hashing has worst-case O(n) collisions (rare but real).
5. Choosing a map when a fixed-size array would be faster and O(1) space.
6. Mutating the input array when the caller still needs it.
7. Not handling empty input / single-element edge cases.
8. Confusing inclusive vs exclusive range boundaries.
9. Assuming hash-map iteration order is stable.
10. Ignoring negative numbers when reasoning about monotonic prefix sums.

---

## 8. Interview Follow-Up Questions

1. **Q: Why O(n) instead of O(n^2)?**
   A: Each element is touched a constant number of times; queries become O(1) reads.

2. **Q: Array vs hash map?**
   A: Array for small dense key domains; map for sparse/large/arbitrary keys.

3. **Q: How to make it O(1) extra space?**
   A: Sometimes you can accumulate on the fly without storing the whole prefix.

4. **Q: Handle updates between queries?**
   A: Switch to a Fenwick/Segment tree for O(log n) updates.

5. **Q: 2D version?**
   A: Use a 2D prefix-sum matrix; submatrix sum in O(1).

6. **Q: Streaming input?**
   A: Maintain running aggregates; use sketches for high cardinality.

7. **Q: Parallelize?**
   A: Counting/summing is associative — Map-Reduce by key.

8. **Q: Negative numbers break a technique?**
   A: Sliding-window-by-sum needs non-negativity; prefix+hashmap handles negatives.

9. **Q: Overflow risk?**
   A: Use wider integer types or modular arithmetic if required.

10. **Q: Memory pressure?**
   A: Compress keys or use approximate structures (Count-Min Sketch).

11. **Q: Detect duplicates fast?**
   A: A hash set gives O(1) membership.

12. **Q: Most frequent element?**
   A: Count then take the max value, or a heap for top-k.

13. **Q: Pivot/equilibrium index?**
   A: Compare left prefix to total minus prefix.

14. **Q: Why does prefix subtraction work?**
   A: Sums telescope: pre[r+1]-pre[l] = sum of [l..r].

15. **Q: Relation to difference arrays?**
   A: Difference array is the inverse: it supports range updates, prefix supports range queries.

---

## 9. Solved Example 1

### Problem — Merge Intervals (LeetCode 56)
A representative **Sorting Based Problems** problem. The signal: reorder data so structure (pairs, gaps, greedy choices) becomes obvious.

### Thought Process
1. Sort intervals by start so overlapping ones become adjacent.
2. Sweep once, keeping the last interval in the result.
3. If the current start ≤ last end, extend the last end (`max`); otherwise append a new interval.

### Dry Run
`[[1,3],[2,6],[8,10]]` → sorted same
- push [1,3]
- [2,6]: 2 ≤ 3 → merge → [1,6]
- [8,10]: 8 > 6 → push [8,10]
Result: `[[1,6],[8,10]]`

### Visualization
```
1--3
   2------6     -> merged 1------6
              8--10
```

### Code
```python
def merge(intervals):
    intervals.sort(key=lambda iv: iv[0])
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
```

### Complexity
Time O(n log n) for the sort, Space O(n) for the output.

## 10. Solved Example 2

### Problem — Sort Array (LeetCode 912)
A representative **Sorting Based Problems** problem. The signal: reorder data so structure (pairs, gaps, greedy choices) becomes obvious.

### Thought Process
1. The task asks to sort in guaranteed O(n log n) — implement merge sort explicitly.
2. Recursively split the array into halves until each has ≤ 1 element.
3. Merge two sorted halves by repeatedly taking the smaller front element.

### Dry Run
`[5,2,3,1]`
- split → [5,2] and [3,1]
- sort halves → [2,5] and [1,3]
- merge: 1,2,3,5 → `[1,2,3,5]`

### Visualization
```
[5,2,3,1] -> [5,2] [3,1] -> [2,5] [1,3] -> merge -> [1,2,3,5]
```

### Code
```python
def sortArray(nums):
    if len(nums) <= 1:
        return nums
    mid = len(nums) // 2
    left = sortArray(nums[:mid])
    right = sortArray(nums[mid:])
    merged, i, j = [], 0, 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            merged.append(left[i]); i += 1
        else:
            merged.append(right[j]); j += 1
    merged.extend(left[i:])
    merged.extend(right[j:])
    return merged
```

### Complexity
Time O(n log n) guaranteed, Space O(n) for merge buffers.

## 11. Solved Example 3

### Problem — Sort Colors (LeetCode 75)
A representative **Sorting Based Problems** problem. The signal: reorder data so structure (pairs, gaps, greedy choices) becomes obvious.

### Thought Process
1. Only three values (0,1,2), so a full comparison sort is overkill — use the Dutch National Flag partition.
2. Keep three pointers: `low` (next 0 slot), `mid` (scanner), `high` (next 2 slot).
3. Swap 0s to the front, 2s to the back; 1s just advance `mid` — one in-place pass.

### Dry Run
`[2,0,2,1,1,0]`  low=0 mid=0 high=5
- nums[0]=2 → swap with high → [0,0,2,1,1,2], high=4
- nums[0]=0 → swap with low → low=1, mid=1
- ... continues → `[0,0,1,1,2,2]`

### Visualization
```
[ 0s | 1s | mid scan | 2s ]
 low        mid      high
```

### Code
```python
def sortColors(nums):
    low, mid, high = 0, 0, len(nums) - 1
    while mid <= high:
        if nums[mid] == 0:
            nums[low], nums[mid] = nums[mid], nums[low]
            low += 1; mid += 1
        elif nums[mid] == 1:
            mid += 1
        else:                       # nums[mid] == 2
            nums[mid], nums[high] = nums[high], nums[mid]
            high -= 1
```

### Complexity
Time O(n) single pass, Space O(1) in-place.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 56 | Merge Intervals | Easy | Core foundations application |
| 912 | Sort Array | Easy | Core foundations application |
| 75 | Sort Colors | Medium | Core foundations application |
| 179 | Largest Number | Medium | Core foundations application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Hash-map counting**
- **1D / 2D prefix sums**
- **Difference arrays (inverse)**
- **Prefix + hashmap for subarray sums**
- **Custom-comparator sorting**

---

## 14. Production Engineering Applications

- **Scalability:** Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Sorting Based Problems logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Sorting Based Problems (Foundations).
- **Signal:** sort, order, comparator, custom sort, greedy sort.
- **Move:** Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Sorting Based Problems invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Sorting Based Problems
FAMILY : Foundations (Beginner)
WHEN   : sort, order, comparator, custom sort, greedy sort
DO     : Trade O(n) extra space for O(1) lookups, collapsing nested work into independent
TIME   : O(n)    SPACE: O(n)
PRACTICE: 56, 912, 75, 179
```

---

*Part of the DSA Patterns Handbook — pattern 05 of 100.*
