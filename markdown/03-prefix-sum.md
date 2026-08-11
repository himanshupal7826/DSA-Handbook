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

**The question this pattern keeps answering:** *"What is the sum of the elements between index `l` and index `r`?"* — asked many times, on the same array.

### Intuition
Just add them up. For each query `(l, r)`, loop from `l` to `r` and accumulate.

### Algorithm
1. Read the query `(l, r)`.
2. Set `total = 0`.
3. For `i` from `l` to `r`: `total += nums[i]`.
4. Return `total`. Repeat for the next query.

### Complexity
- Time: **O(n) per query**, so **O(q·n)** for `q` queries.
- Space: O(1).

### Drawbacks
- Two queries that overlap re-add the very same elements. `sumRange(0,5)` and `sumRange(0,6)` share five additions, and we redo all of them.
- With `q = 10⁴` queries on `n = 10⁴` elements that's 10⁸ additions for information we already computed.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Add everything up once, from the left. Then any range is the difference of two of those totals.**

Think of a running odometer. If the odometer reads 2 km when you pass point `l` and 10 km when you pass point `r`, the distance between them is `10 − 2 = 8`. You don't re-drive the road; you subtract two readings.

### The thought process

```text
We need    : sums of many ranges of the same array.
Obvious way: loop over each range and add.
Too slow   : overlapping ranges re-add the same elements, O(q·n).
Notice     : sum(l..r) = sum(0..r) - sum(0..l-1).
             Every range is the difference of two prefixes!
Therefore  : precompute all prefixes from index 0 in one pass.
Now        : each query is one subtraction — O(1).
```

### Why the array has size n+1

Define `pre[i] = nums[0] + nums[1] + … + nums[i-1]`, i.e. **the sum of the first `i` elements** (not "up to index `i`"). That gives `pre[0] = 0`, the sum of no elements.

That extra leading zero is not decoration — it removes every special case:

```text
sum of nums[l..r]  =  pre[r+1] - pre[l]
```

If `l = 0`, the formula needs `pre[0]`, and it exists and equals 0. With an `n`-sized array you'd have to write `if l == 0 { return pre[r] }` everywhere. One extra slot buys a branch-free formula.

### Steps

```text
Step 1 → Allocate pre with n+1 slots; pre[0] = 0.
Step 2 → For i = 0 .. n-1:  pre[i+1] = pre[i] + nums[i].
Step 3 → Answer any query (l, r) as pre[r+1] - pre[l].
```

### Why the subtraction is valid

The sums *telescope*. Writing them out:

```text
pre[r+1] = nums[0] + nums[1] + ... + nums[l-1] + nums[l] + ... + nums[r]
pre[l]   = nums[0] + nums[1] + ... + nums[l-1]
           └──────────── identical prefix ────┘
subtract:                                      nums[l] + ... + nums[r]
```

The shared head cancels exactly, leaving the range we wanted. Note this works with **negative numbers too** — nothing here assumes the values are positive.

### The companion trick: prefix + hash map

A second, very common use: *count subarrays whose sum equals `k`*. Since `sum(l..r) = pre[r+1] − pre[l]`, asking for `sum(l..r) == k` is the same as asking

```text
pre[l] == pre[r+1] - k
```

So while sweeping, keep a map `prefix value → how many times it occurred`. At each position, the number of subarrays ending here with sum `k` is exactly `count[running − k]`. This is Hash Map Lookup applied to prefixes — the same "compute exactly what you need, then look it up" move.

### How should I recognize this?

```text
If you see...
  "sum of the subarray / range", "range query", "running total"
  "how many subarrays sum to K", "cumulative", "average of a window"
  the same array queried repeatedly
        ↓
Think about...
  "Can I express this range as (something up to r) minus (something up to l)?"
        ↓
Use...
  prefix array          → repeated range-sum queries, O(1) each
  prefix + hash map     → counting subarrays with a target sum
  difference array      → the inverse problem: many range UPDATES
```

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

```text
nums =  [ 2 ,  4 ,  1 ,  3 ,  5 ]
pre  = [0,  2,   6,   7,  10,  15]
        ↑                ↑
      pre[1]=2        pre[4]=10

sum of nums[1..3] = 4+1+3 = 8   and   pre[4] - pre[1] = 10 - 2 = 8  ✓
```

### Interview explanation
"Since the array is fixed and the queries are many, I'll spend O(n) once to build a prefix array where `pre[i]` is the sum of the first `i` elements, with `pre[0] = 0`. Then `sumRange(l, r)` is just `pre[r+1] − pre[l]`, because the shared prefix cancels. Build O(n), query O(1), space O(n). If the array could be updated between queries, I'd switch to a Fenwick tree for O(log n) updates."

---

## 5. Generic Templates

> Build once, then subtract. The `n+1` sizing and the `pre[r+1] − pre[l]` formula are the two things to memorise.

```go
// BuildPrefix returns pre where pre[i] = sum of the first i elements.
// pre[0] = 0, so pre has len(nums)+1 entries.
func BuildPrefix(nums []int) []int {
    pre := make([]int, len(nums)+1)
    for i, v := range nums {
        pre[i+1] = pre[i] + v
    }
    return pre
}

// RangeSum returns the sum of nums[l..r], inclusive on both ends.
func RangeSum(pre []int, l, r int) int {
    return pre[r+1] - pre[l]
}

// CountSubarraysWithSum counts subarrays summing to k, using prefix + hash map.
func CountSubarraysWithSum(nums []int, k int) int {
    countOfPrefix := map[int]int{0: 1} // the empty prefix has sum 0
    running, total := 0, 0
    for _, x := range nums {
        running += x
        total += countOfPrefix[running-k] // subarrays ending here with sum k
        countOfPrefix[running]++
    }
    return total
}
```

```python
def build_prefix(nums):
    """pre[i] = sum of the first i elements; pre[0] = 0."""
    pre = [0] * (len(nums) + 1)
    for i, v in enumerate(nums):
        pre[i + 1] = pre[i] + v
    return pre

def range_sum(pre, l, r):
    """Sum of nums[l..r], inclusive."""
    return pre[r + 1] - pre[l]

def count_subarrays_with_sum(nums, k):
    from collections import defaultdict
    count_of_prefix = defaultdict(int)
    count_of_prefix[0] = 1           # the empty prefix has sum 0
    running = total = 0
    for x in nums:
        running += x
        total += count_of_prefix[running - k]
        count_of_prefix[running] += 1
    return total
```

```java
import java.util.*;

public class PrefixSum {
    // pre[i] = sum of the first i elements; pre[0] = 0.
    public static long[] buildPrefix(int[] nums) {
        long[] pre = new long[nums.length + 1];
        for (int i = 0; i < nums.length; i++) pre[i + 1] = pre[i] + nums[i];
        return pre;
    }

    // Sum of nums[l..r], inclusive.
    public static long rangeSum(long[] pre, int l, int r) {
        return pre[r + 1] - pre[l];
    }

    public static int countSubarraysWithSum(int[] nums, int k) {
        Map<Integer, Integer> countOfPrefix = new HashMap<>();
        countOfPrefix.put(0, 1);           // the empty prefix has sum 0
        int running = 0, total = 0;
        for (int x : nums) {
            running += x;
            total += countOfPrefix.getOrDefault(running - k, 0);
            countOfPrefix.merge(running, 1, Integer::sum);
        }
        return total;
    }
}
```

```cpp
#include <vector>
#include <unordered_map>
using namespace std;

// pre[i] = sum of the first i elements; pre[0] = 0. long long avoids overflow.
vector<long long> buildPrefix(const vector<int>& nums) {
    vector<long long> pre(nums.size() + 1, 0);
    for (size_t i = 0; i < nums.size(); ++i) pre[i + 1] = pre[i] + nums[i];
    return pre;
}

// Sum of nums[l..r], inclusive.
long long rangeSum(const vector<long long>& pre, int l, int r) {
    return pre[r + 1] - pre[l];
}

int countSubarraysWithSum(const vector<int>& nums, int k) {
    unordered_map<long long, int> countOfPrefix;
    countOfPrefix[0] = 1;                  // the empty prefix has sum 0
    long long running = 0;
    int total = 0;
    for (int x : nums) {
        running += x;
        auto it = countOfPrefix.find(running - k);
        if (it != countOfPrefix.end()) total += it->second;
        ++countOfPrefix[running];
    }
    return total;
}
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

### Problem — Range Sum Query (LeetCode 303)
Build a structure over a fixed `nums` that answers many `sumRange(left, right)` queries (inclusive on both ends).

### Thought Process
1. The array never changes, but the queries are many — so precompute.
2. In the constructor, build `pre` where `pre[i]` = sum of the first `i` elements, `pre[0] = 0`.
3. Each query is then `pre[right+1] − pre[left]`, a single subtraction.
4. The leading `0` slot is what makes `left = 0` work without a special case.

### Dry Run

Input: `nums = [-2, 0, 3, -5, 2, -1]`

**Build the prefix array** (each entry is the previous one plus the next element):

| i        | 0 | 1  | 2  | 3 | 4  | 5  | 6  |
|----------|---|----|----|---|----|----|----|
| nums[i]  |−2 | 0  | 3  |−5 | 2  |−1  | —  |
| pre[i]   | 0 | −2 | −2 | 1 | −4 | −2 | −3 |

Read it as: `pre[3] = -2 + 0 + 3 = 1` — the sum of the **first 3** elements.

**Answer queries:**

| query           | formula          | numbers      | result |
|-----------------|------------------|--------------|--------|
| `sumRange(0,2)` | `pre[3] − pre[0]`| `1 − 0`      | **1**  |
| `sumRange(2,5)` | `pre[6] − pre[2]`| `−3 − (−2)`  | **−1** |

Check by hand: `-2+0+3 = 1` ✓ and `3-5+2-1 = -1` ✓ (negatives are no problem).

### Visualization

```text
nums :   -2    0    3   -5    2   -1
pre  : 0   -2   -2    1   -4   -2   -3
       ↑              ↑
     pre[0]=0       pre[3]=1

sumRange(0,2) = pre[3] - pre[0] = 1 - 0 = 1
```

### Code

```go
type NumArray struct {
    pre []int // pre[i] = sum of the first i elements
}

func Constructor(nums []int) NumArray {
    pre := make([]int, len(nums)+1) // pre[0] = 0 already
    for i, v := range nums {
        pre[i+1] = pre[i] + v
    }
    return NumArray{pre: pre}
}

// SumRange returns the sum of nums[left..right], inclusive.
func (a *NumArray) SumRange(left int, right int) int {
    return a.pre[right+1] - a.pre[left]
}
```

```python
class NumArray:
    def __init__(self, nums):
        self.pre = [0] * (len(nums) + 1)     # pre[i] = sum of first i elements
        for i, v in enumerate(nums):
            self.pre[i + 1] = self.pre[i] + v

    def sumRange(self, left, right):          # inclusive [left, right]
        return self.pre[right + 1] - self.pre[left]
```

### Complexity
Time O(n) to build, **O(1) per query**. Space O(n) for the prefix array.

---

## 10. Solved Example 2

### Problem — Subarray Sum Equals K (LeetCode 560)
Count how many **contiguous** subarrays sum to exactly `k`.

### Thought Process
1. Checking all subarrays is O(n²). Can we do it in one pass?
2. Any subarray sum is `pre[r+1] − pre[l]`. Setting that equal to `k` and rearranging gives `pre[l] = pre[r+1] − k`.
3. So while sweeping with a running sum, the number of subarrays **ending here** with sum `k` is just how many times the value `running − k` has appeared as an earlier prefix.
4. Keep a map `prefix value → occurrence count`. Seed it with `{0: 1}` — the empty prefix — so subarrays that start at index 0 are counted.
5. As in Two Sum: **look up before you insert**, so the prefix you match is strictly earlier.

### Dry Run

Input: `nums = [1, 1, 1]`, `k = 2`

Start: `running = 0`, `total = 0`, `count = {0: 1}`

| x | running | need = running − k | count[need] | total | count after       |
|---|---------|--------------------|-------------|-------|-------------------|
| 1 | 1       | −1                 | 0           | 0     | `{0:1, 1:1}`      |
| 1 | 2       | 0                  | **1**       | 1     | `{0:1, 1:1, 2:1}` |
| 1 | 3       | 1                  | **1**       | 2     | `{0:1, 1:1, 2:1, 3:1}` |

Output: **2** — namely `nums[0..1]` and `nums[1..2]`.

Notice the seed `{0: 1}` earning its keep at step 2: `running − k = 0` matched the empty prefix, which is what represents the subarray starting at index 0.

### Visualization

```text
nums:   1    1    1
run :   1    2    3
             ↑    ↑
             |    └ run-k = 1 seen once → subarray [1..2]
             └ run-k = 0 seen once (empty prefix) → subarray [0..1]
```

### Code

```go
func subarraySum(nums []int, k int) int {
    countOfPrefix := map[int]int{0: 1} // empty prefix has sum 0
    running, total := 0, 0
    for _, x := range nums {
        running += x
        total += countOfPrefix[running-k] // look up BEFORE inserting
        countOfPrefix[running]++
    }
    return total
}
```

```python
from collections import defaultdict

def subarraySum(nums, k):
    count_of_prefix = defaultdict(int)
    count_of_prefix[0] = 1               # empty prefix has sum 0
    running = total = 0
    for x in nums:
        running += x
        total += count_of_prefix[running - k]   # look up BEFORE inserting
        count_of_prefix[running] += 1
    return total
```

### Complexity
Time O(n), Space O(n). A sliding window will **not** work here — negatives mean the running sum isn't monotonic, so shrinking from the left is not a valid move. Prefix + map handles negatives fine.

---

## 11. Solved Example 3

### Problem — Find Pivot Index (LeetCode 724)
Return the leftmost index where the sum of everything to its left equals the sum of everything to its right, or `−1`.

### Thought Process
1. We need left sum and right sum at every index — sounds like two prefix arrays.
2. But the right side is not independent: `right = total − left − nums[i]`.
3. So one number, `total`, plus a running `left`, is all the state we need — no array at all.
4. Sweep left to right; the first index where `left == total − left − nums[i]` is the answer.
5. Add `nums[i]` to `left` **after** the check, since `left` must exclude the current element.

### Dry Run

Input: `nums = [1, 7, 3, 6, 5, 6]`, `total = 28`

| i | nums[i] | left (before i) | right = 28 − left − nums[i] | equal? |
|---|---------|-----------------|-----------------------------|--------|
| 0 | 1       | 0               | 28 − 0 − 1 = 27             | no     |
| 1 | 7       | 1               | 28 − 1 − 7 = 20             | no     |
| 2 | 3       | 8               | 28 − 8 − 3 = 17             | no     |
| 3 | 6       | 11              | 28 − 11 − 6 = 11            | **yes** |

Output: **3**

Verify: left of index 3 is `1+7+3 = 11`; right is `5+6 = 11`. ✓

### Visualization

```text
        left sum = 11        pivot        right sum = 11
      ┌─────────────────┐     ┌─┐     ┌─────────┐
nums = [ 1  ,  7  ,  3  ] [ 6 ] [ 5  ,  6 ]
                            ↑
                        index 3   →  11 == 11  ✓
```

### Code

```go
func pivotIndex(nums []int) int {
    total := 0
    for _, x := range nums {
        total += x
    }

    left := 0
    for i, x := range nums {
        // right side = everything except the left part and nums[i] itself
        if left == total-left-x {
            return i
        }
        left += x // only now does nums[i] join the left side
    }
    return -1
}
```

```python
def pivotIndex(nums):
    total = sum(nums)
    left = 0
    for i, x in enumerate(nums):
        if left == total - left - x:   # right = total - left - nums[i]
            return i
        left += x                      # add AFTER the check
    return -1
```

### Complexity
Time O(n) — two linear passes. Space **O(1)** — no prefix array is stored, just two integers.

---

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
