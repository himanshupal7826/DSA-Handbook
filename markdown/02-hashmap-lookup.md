# 02 · Hash Map Lookup

> **One-liner:** Trade space for time: store seen values for O(1) existence/complement checks.

---

## 1. Overview

### Definition
The **Hash Map Lookup** pattern belongs to the *Foundations* family. Trade space for time: store seen values for O(1) existence/complement checks.

### Intuition
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Why it works
Precompute an auxiliary structure (hash map / prefix array) in one pass so each query is O(1). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.

---

## 2. Recognition Signals

### Keywords
hashmap, lookup, complement, seen, cache, O(1), dictionary.

### Constraints
- Input size where the brute-force complexity would time out — the Hash Map Lookup optimization is the intended solution.
- Structural hints in the statement that match this family (Foundations).

### Hidden clues
- The problem can be reframed so the Hash Map Lookup invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Hash Map Lookup is the upgrade.
- The wording maps onto: hashmap, lookup, complement, seen, cache, O(1), dictionary.

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
Redundant recomputation; does not exploit the structure the Hash Map Lookup pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Hash Map Lookup invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="hm-02" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Two Sum, target = 9: for each x, look up complement 9 − x</text>
  <!-- array with indices -->
  <g>
    <text x="93"  y="56" text-anchor="middle" fill="#64748b">i=0</text><rect x="65"  y="62" width="56" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="93"  y="90" text-anchor="middle" fill="#1e293b">2</text>
    <text x="163" y="56" text-anchor="middle" fill="#64748b">i=1</text><rect x="135" y="62" width="56" height="46" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="163" y="90" text-anchor="middle" fill="#1e293b">7</text>
    <text x="233" y="56" text-anchor="middle" fill="#64748b">i=2</text><rect x="205" y="62" width="56" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="233" y="90" text-anchor="middle" fill="#1e293b">11</text>
    <text x="303" y="56" text-anchor="middle" fill="#64748b">i=3</text><rect x="275" y="62" width="56" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="303" y="90" text-anchor="middle" fill="#1e293b">15</text>
  </g>
  <text x="163" y="128" text-anchor="middle" fill="#d97706" font-weight="700">current x = 7</text>
  <!-- seen map -->
  <text x="430" y="56" text-anchor="middle" fill="#64748b">seen{ value : index }</text>
  <rect x="380" y="62" width="100" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="430" y="90" text-anchor="middle" fill="#1e293b">2 : 0</text>
  <line x1="163" y1="150" x2="163" y2="176" stroke="#475569" marker-end="url(#hm-02)"/>
  <text x="320" y="170" text-anchor="middle" fill="#64748b">complement = 9 − 7 = 2, is 2 in seen?</text>
  <text x="320" y="200" text-anchor="middle" fill="#059669" font-weight="700">yes → found at index 0 → answer (0, 1)</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Hash Map Lookup   : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Hash Map Lookup problem. I'll trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes. That brings the complexity down to O(n) time and O(n) space — here's the template."

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

| Metric | Brute Force | Hash Map Lookup (Optimal) |
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

### Problem — Two Sum (LeetCode 1)
A representative **Hash Map Lookup** problem. The signal: trade space for time: store seen values for o(1) existence/complement checks.

### Thought Process
1. Confirm the pattern via its recognition signals (hashmap, lookup, complement, seen, cache, O(1), dictionary).
2. Reach for the Hash Map Lookup template below and map the problem's entities onto it.
3. Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Hash Map Lookup step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def prefix(nums):
    pre = [0]*(len(nums)+1)
    for i, v in enumerate(nums):
        pre[i+1] = pre[i] + v
    return pre

def range_sum(pre, l, r):       # inclusive [l, r]
    return pre[r+1] - pre[l]
```

### Complexity
Time O(n), Space O(n). One pass to build, O(1) per query.

## 10. Solved Example 2

### Problem — Contains Duplicate (LeetCode 217)
A representative **Hash Map Lookup** problem. The signal: trade space for time: store seen values for o(1) existence/complement checks.

### Thought Process
1. Confirm the pattern via its recognition signals (hashmap, lookup, complement, seen, cache, O(1), dictionary).
2. Reach for the Hash Map Lookup template below and map the problem's entities onto it.
3. Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Hash Map Lookup step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def prefix(nums):
    pre = [0]*(len(nums)+1)
    for i, v in enumerate(nums):
        pre[i+1] = pre[i] + v
    return pre

def range_sum(pre, l, r):       # inclusive [l, r]
    return pre[r+1] - pre[l]
```

### Complexity
Time O(n), Space O(n). One pass to build, O(1) per query.

## 11. Solved Example 3

### Problem — Group Anagrams (LeetCode 49)
A representative **Hash Map Lookup** problem. The signal: trade space for time: store seen values for o(1) existence/complement checks.

### Thought Process
1. Confirm the pattern via its recognition signals (hashmap, lookup, complement, seen, cache, O(1), dictionary).
2. Reach for the Hash Map Lookup template below and map the problem's entities onto it.
3. Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Hash Map Lookup step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def prefix(nums):
    pre = [0]*(len(nums)+1)
    for i, v in enumerate(nums):
        pre[i+1] = pre[i] + v
    return pre

def range_sum(pre, l, r):       # inclusive [l, r]
    return pre[r+1] - pre[l]
```

### Complexity
Time O(n), Space O(n). One pass to build, O(1) per query.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1 | Two Sum | Easy | Core foundations application |
| 217 | Contains Duplicate | Easy | Core foundations application |
| 49 | Group Anagrams | Medium | Core foundations application |
| 36 | Valid Sudoku | Medium | Core foundations application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Hash Map Lookup logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Hash Map Lookup (Foundations).
- **Signal:** hashmap, lookup, complement, seen, cache, O(1), dictionary.
- **Move:** Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Hash Map Lookup invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Hash Map Lookup
FAMILY : Foundations (Beginner)
WHEN   : hashmap, lookup, complement, seen, cache, O(1), dictionary
DO     : Trade O(n) extra space for O(1) lookups, collapsing nested work into independent
TIME   : O(n)    SPACE: O(n)
PRACTICE: 1, 217, 49, 36
```

---

*Part of the DSA Patterns Handbook — pattern 02 of 100.*
