# 03 · Prefix Sum

> **One-liner:** Precompute cumulative sums so any range query is O(1).

---

## 1. Overview

### Definition
The **Prefix Sum** pattern belongs to the *Foundations* family. Precompute cumulative sums so any range query is O(1).

### Intuition
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Why it works
Precompute an auxiliary structure (hash map / prefix array) in one pass so each query is O(1). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.

---

## 2. Recognition Signals

### Keywords
prefix, cumulative, range sum, subarray sum, running total.

### Constraints
- Input size where the brute-force complexity would time out — the Prefix Sum optimization is the intended solution.
- Structural hints in the statement that match this family (Foundations).

### Hidden clues
- The problem can be reframed so the Prefix Sum invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Prefix Sum is the upgrade.
- The wording maps onto: prefix, cumulative, range sum, subarray sum, running total.

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
Redundant recomputation; does not exploit the structure the Prefix Sum pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Prefix Sum invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 660 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ps-03" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="330" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">nums = [2,4,1,3,5]: build prefix, then rangeSum(1,3) = pre[4] − pre[1]</text>
  <text x="40" y="72" fill="#64748b">nums</text>
  <!-- nums row, range 1..3 highlighted -->
  <g>
    <rect x="120" y="52" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="148" y="78" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="180" y="52" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="208" y="78" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="240" y="52" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="268" y="78" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="300" y="52" width="56" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="328" y="78" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="360" y="52" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="388" y="78" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <text x="298" y="112" text-anchor="middle" fill="#059669" font-weight="700">range [1..3] sum = 8</text>
  <text x="40" y="162" fill="#64748b">pre</text>
  <!-- prefix row of n+1 cells -->
  <g>
    <rect x="90"  y="142" width="56" height="40" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="118" y="168" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="150" y="142" width="56" height="40" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="178" y="168" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="210" y="142" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="238" y="168" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="270" y="142" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="298" y="168" text-anchor="middle" fill="#1e293b">7</text>
    <rect x="330" y="142" width="56" height="40" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="358" y="168" text-anchor="middle" fill="#1e293b">10</text>
    <rect x="390" y="142" width="56" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="168" text-anchor="middle" fill="#1e293b">15</text>
  </g>
  <text x="178" y="202" text-anchor="middle" fill="#d97706">pre[1]=2</text>
  <text x="358" y="202" text-anchor="middle" fill="#d97706">pre[4]=10</text>
  <text x="530" y="168" text-anchor="middle" fill="#059669" font-weight="700">10 − 2 = 8</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Prefix Sum        : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Prefix Sum problem. I'll trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes. That brings the complexity down to O(n) time and O(n) space — here's the template."

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

| Metric | Brute Force | Prefix Sum (Optimal) |
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

### Problem — Range Sum (LeetCode 303)
A representative **Prefix Sum** problem. The signal: precompute cumulative sums so any range query is o(1).

### Thought Process
1. Many `sumRange(l, r)` queries hit the same array, so precompute once.
2. Build `pre` where `pre[i]` = sum of the first `i` elements (`pre[0]=0`).
3. Any inclusive range sum is then `pre[r+1] - pre[l]` in O(1).

### Dry Run
`nums=[-2,0,3,-5,2,-1]` → `pre=[0,-2,-2,1,-4,-2,-3]`
- `sumRange(0,2)` = `pre[3]-pre[0]` = `1-0` = **1**
- `sumRange(2,5)` = `pre[6]-pre[2]` = `-3-(-2)` = **-1**

### Visualization
```
pre: [0, -2, -2, 1, -4, -2, -3]
sumRange(0,2) = pre[3]-pre[0] = 1
```

### Code
```python
class NumArray:
    def __init__(self, nums):
        self.pre = [0]*(len(nums)+1)
        for i, v in enumerate(nums):
            self.pre[i+1] = self.pre[i] + v

    def sumRange(self, left, right):    # inclusive [left, right]
        return self.pre[right+1] - self.pre[left]
```

### Complexity
Time O(n) to build, O(1) per query. Space O(n).

## 10. Solved Example 2

### Problem — Subarray Sum K (LeetCode 560)
A representative **Prefix Sum** problem. The signal: precompute cumulative sums so any range query is o(1).

### Thought Process
1. A subarray sums to `k` iff `running - k` was a previous prefix sum.
2. Track the running prefix sum and a map of `prefix → count of occurrences`.
3. At each step add `count[running - k]` to the answer, then record `running`. Seed `count[0]=1` for subarrays starting at index 0.

### Dry Run
`nums=[1,1,1], k=2`, count={0:1}
- x=1: running=1, add count[-1]=0; count={0:1,1:1}
- x=1: running=2, add count[0]=1 → total=1; count={0:1,1:1,2:1}
- x=1: running=3, add count[1]=1 → total=2
Answer: **2**

### Visualization
```
running - k in count?  yes -> that many subarrays end here
```

### Code
```python
from collections import defaultdict

def subarraySum(nums, k):
    count = 0
    running = 0
    seen = defaultdict(int)
    seen[0] = 1
    for x in nums:
        running += x
        count += seen[running - k]
        seen[running] += 1
    return count
```

### Complexity
Time O(n), Space O(n). One pass with O(1) map lookups.

## 11. Solved Example 3

### Problem — Pivot Index (LeetCode 724)
A representative **Prefix Sum** problem. The signal: precompute cumulative sums so any range query is o(1).

### Thought Process
1. The pivot is where the left-side sum equals the right-side sum.
2. With `total = sum(nums)`, the right side at index `i` is `total - left - nums[i]`.
3. Sweep once keeping `left`; the first index where `left == total - left - nums[i]` is the pivot.

### Dry Run
`nums=[1,7,3,6,5,6]`, total=28
- i=0 left=0: right=28-0-1=27 ≠ 0
- i=1 left=1: right=28-1-7=20 ≠ 1
- i=2 left=8: right=28-8-3=17 ≠ 8
- i=3 left=11: right=28-11-6=11 == 11 → pivot **3**

### Visualization
```
left=11 | nums[3]=6 | right = 28-11-6 = 11  ✓ balanced at index 3
```

### Code
```python
def pivotIndex(nums):
    total = sum(nums)
    left = 0
    for i, x in enumerate(nums):
        if left == total - left - x:
            return i
        left += x
    return -1
```

### Complexity
Time O(n), Space O(1). Two linear sweeps, no extra array.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 303 | Range Sum | Easy | Core foundations application |
| 560 | Subarray Sum K | Easy | Core foundations application |
| 724 | Pivot Index | Medium | Core foundations application |
| 238 | Product Except Self | Medium | Core foundations application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Prefix Sum logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Prefix Sum (Foundations).
- **Signal:** prefix, cumulative, range sum, subarray sum, running total.
- **Move:** Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Prefix Sum invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Prefix Sum
FAMILY : Foundations (Beginner)
WHEN   : prefix, cumulative, range sum, subarray sum, running total
DO     : Trade O(n) extra space for O(1) lookups, collapsing nested work into independent
TIME   : O(n)    SPACE: O(n)
PRACTICE: 303, 560, 724, 238
```

---

*Part of the DSA Patterns Handbook — pattern 03 of 100.*
