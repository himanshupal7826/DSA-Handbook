# 04 · Difference Array

> **One-liner:** Apply many range updates in O(1) each, then reconstruct with one pass.

---

## 1. Overview

### Definition
The **Difference Array** pattern belongs to the *Foundations* family. Apply many range updates in O(1) each, then reconstruct with one pass.

### Intuition
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Why it works
Precompute an auxiliary structure (hash map / prefix array) in one pass so each query is O(1). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.

---

## 2. Recognition Signals

### Keywords
difference, range update, increment range, imos, interval add.

### Constraints
- Input size where the brute-force complexity would time out — the Difference Array optimization is the intended solution.
- Structural hints in the statement that match this family (Foundations).

### Hidden clues
- The problem can be reframed so the Difference Array invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Difference Array is the upgrade.
- The wording maps onto: difference, range update, increment range, imos, interval add.

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
Redundant recomputation; does not exploit the structure the Difference Array pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Difference Array invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="da-04" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">add +2 to range [1..3]: mark diff[1] += 2, diff[4] −= 2</text>
  <text x="40" y="78" fill="#64748b">diff</text>
  <!-- diff row with +/- marks -->
  <g>
    <text x="118" y="52" text-anchor="middle" fill="#64748b">0</text><rect x="90"  y="58" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="118" y="85" text-anchor="middle" fill="#1e293b">0</text>
    <text x="178" y="52" text-anchor="middle" fill="#64748b">1</text><rect x="150" y="58" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="178" y="85" text-anchor="middle" fill="#059669" font-weight="700">+2</text>
    <text x="238" y="52" text-anchor="middle" fill="#64748b">2</text><rect x="210" y="58" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="238" y="85" text-anchor="middle" fill="#1e293b">0</text>
    <text x="298" y="52" text-anchor="middle" fill="#64748b">3</text><rect x="270" y="58" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="298" y="85" text-anchor="middle" fill="#1e293b">0</text>
    <text x="358" y="52" text-anchor="middle" fill="#64748b">4</text><rect x="330" y="58" width="56" height="42" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="358" y="85" text-anchor="middle" fill="#d97706" font-weight="700">−2</text>
  </g>
  <line x1="238" y1="112" x2="238" y2="150" stroke="#475569" marker-end="url(#da-04)"/>
  <text x="430" y="135" text-anchor="middle" fill="#64748b">running prefix of diff</text>
  <text x="40" y="182" fill="#64748b">result</text>
  <!-- reconstructed result -->
  <g>
    <rect x="90"  y="162" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="118" y="189" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="150" y="162" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="178" y="189" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="210" y="162" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="238" y="189" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="270" y="162" width="56" height="42" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="298" y="189" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="330" y="162" width="56" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="358" y="189" text-anchor="middle" fill="#1e293b">0</text>
  </g>
  <text x="238" y="230" text-anchor="middle" fill="#059669" font-weight="700">+2 applied across [1..3] with just two edits</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Difference Array  : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Difference Array problem. I'll trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes. That brings the complexity down to O(n) time and O(n) space — here's the template."

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

| Metric | Brute Force | Difference Array (Optimal) |
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

### Problem — Corporate Flight (LeetCode 1109)
A representative **Difference Array** problem. The signal: apply many range updates in o(1) each, then reconstruct with one pass.

### Thought Process
1. Each booking `[first, last, seats]` adds `seats` to a 1-indexed range — a classic range update.
2. Use a diff array: `diff[first-1] += seats` and `diff[last] -= seats` (marks start and one-past-end).
3. A running prefix sum over `diff` reconstructs the per-flight totals.

### Dry Run
`bookings=[[1,2,10],[2,3,20]], n=3`
- booking1: diff[0]+=10, diff[2]-=10
- booking2: diff[1]+=20, diff[3]-=20 → diff=[10,20,-10,-20]
- prefix: 10, 30, 20 → answer `[10,30,20]`

### Visualization
```
diff  = [ +10, +20, -10, -20 ]
prefix= [  10,  30,  20 ]      ← seats per flight
```

### Code
```python
def corpFlightBookings(bookings, n):
    diff = [0]*(n+1)
    for first, last, seats in bookings:
        diff[first-1] += seats
        diff[last]    -= seats
    res, running = [], 0
    for i in range(n):
        running += diff[i]
        res.append(running)
    return res
```

### Complexity
Time O(n + m) for m bookings, Space O(n).

## 10. Solved Example 2

### Problem — Range Addition (LeetCode 370)
A representative **Difference Array** problem. The signal: apply many range updates in o(1) each, then reconstruct with one pass.

### Thought Process
1. Each update `[start, end, inc]` adds `inc` to the inclusive range `[start, end]`.
2. Record only the boundaries in a diff array: `diff[start] += inc`, `diff[end+1] -= inc`.
3. After all updates, a single prefix sum materializes the final array.

### Dry Run
`length=5, updates=[[1,3,2],[2,4,3]]`
- upd1: diff[1]+=2, diff[4]-=2
- upd2: diff[2]+=3, diff[5]-=3 → diff=[0,2,3,0,-2,-3]
- prefix: 0,2,5,5,3 → answer `[0,2,5,5,3]`

### Visualization
```
diff  = [0, +2, +3, 0, -2, (-3)]
prefix= [0,  2,  5, 5,  3]
```

### Code
```python
def getModifiedArray(length, updates):
    diff = [0]*(length+1)
    for start, end, inc in updates:
        diff[start] += inc
        diff[end+1] -= inc
    res, running = [], 0
    for i in range(length):
        running += diff[i]
        res.append(running)
    return res
```

### Complexity
Time O(n + m) for m updates, Space O(n).

## 11. Solved Example 3

### Problem — Car Pooling (LeetCode 1094)
A representative **Difference Array** problem. The signal: apply many range updates in o(1) each, then reconstruct with one pass.

### Thought Process
1. Each trip `[num, start, end]` occupies `num` seats over the location range `[start, end)`.
2. On a diff array indexed by location: `diff[start] += num`, `diff[end] -= num` (passengers leave at `end`).
3. Sweep the running occupancy; if it ever exceeds `capacity`, return `False`.

### Dry Run
`trips=[[2,1,5],[3,3,7]], capacity=4`
- trip1: diff[1]+=2, diff[5]-=2
- trip2: diff[3]+=3, diff[7]-=3
- running by location: loc1→2, loc3→5 > 4 → return **False**

### Visualization
```
loc:   1   2   3   4   5 ...
occ:   2   2   5   5   3      5 > capacity(4) -> False
```

### Code
```python
def carPooling(trips, capacity):
    diff = [0]*1001                 # locations 0..1000
    for num, start, end in trips:
        diff[start] += num
        diff[end]   -= num
    running = 0
    for d in diff:
        running += d
        if running > capacity:
            return False
    return True
```

### Complexity
Time O(n + maxLoc), Space O(maxLoc).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1109 | Corporate Flight | Easy | Core foundations application |
| 370 | Range Addition | Easy | Core foundations application |
| 1094 | Car Pooling | Medium | Core foundations application |
| 1854 | Max Population | Medium | Core foundations application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Difference Array logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Difference Array (Foundations).
- **Signal:** difference, range update, increment range, imos, interval add.
- **Move:** Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Difference Array invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Difference Array
FAMILY : Foundations (Beginner)
WHEN   : difference, range update, increment range, imos, interval add
DO     : Trade O(n) extra space for O(1) lookups, collapsing nested work into independent
TIME   : O(n)    SPACE: O(n)
PRACTICE: 1109, 370, 1094, 1854
```

---

*Part of the DSA Patterns Handbook — pattern 04 of 100.*
