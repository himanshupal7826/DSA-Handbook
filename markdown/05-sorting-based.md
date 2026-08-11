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

**The question this pattern keeps answering:** *"This problem is hard because the data is in a random order — what if it weren't?"*

### Intuition
Without ordering, you cannot rule anything out. Any element might be the one that pairs with, overlaps, or beats the current one, so you check them all.

### Algorithm (taking "merge overlapping intervals" as the running example)
1. Take each interval in turn.
2. Compare it against every other interval to see if they overlap.
3. If they do, merge them and restart the comparisons, since a merge can create new overlaps.
4. Repeat until a full pass produces no merges.

### Complexity
- Time: **O(n²)** at best, and O(n³) if merges keep forcing restarts.
- Space: O(n).

### Drawbacks
- Every interval is compared with every other, including ones that are nowhere near it.
- The restart-after-merge loop is the real killer: the same pairs are re-examined many times.
- All of that work exists only because we don't know *where* things are relative to each other.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Sort first. Once the data is ordered, the thing you're looking for is always right next to you.**

Sorting costs O(n log n) once, and in exchange it converts a global search ("compare against everything") into a local one ("compare against your neighbour"). That is almost always a winning trade.

### The thought process

```text
We need    : to find some relationship between elements.
Obvious way: compare every pair.
Too slow   : O(n²), and most of those pairs were never relevant.
Notice     : if the data were sorted, the only candidates that matter
             are ADJACENT ones.
             - overlapping intervals become neighbours
             - the closest pair of numbers becomes a neighbour pair
             - duplicates become neighbours
Therefore  : pay O(n log n) once to sort.
Now        : a single linear sweep finishes the job → O(n log n) total.
```

### Why sorting helps: the invariant it buys you

After sorting intervals by start time, you get a guarantee:

> When you reach interval `i`, every interval that could possibly overlap it has already been seen.

Nothing later can start earlier. So you only ever need to compare against the **one** interval you're currently building. That is what turns the nested loop into a sweep.

The same guarantee shows up everywhere:

| After sorting by… | You gain the guarantee… |
|---|---|
| start time | overlaps are adjacent — merge in one sweep |
| value | duplicates are adjacent; closest pair is adjacent |
| end time | the earliest-finishing choice is first — greedy scheduling |
| a custom key | items sharing that key are grouped together |

### Steps (merge intervals)

```text
Step 1 → Sort the intervals by start.
Step 2 → Put the first interval into the result as the "current" one.
Step 3 → For each next interval:
             if it starts <= current's end   → they touch/overlap:
                  current.end = max(current.end, its end)
             else                            → there is a gap:
                  push it as the new current
Step 4 → The result list is the merged answer.
```

### Why `max` and not just "take the new end"

This is the classic bug. Consider `[1,10]` followed by `[2,3]`. The second is entirely *inside* the first. Overwriting would shrink the interval to `[1,3]` and lose coverage. `max(10, 3) = 10` keeps it correct.

Sorting by start guarantees the new interval starts later, but says **nothing** about where it ends.

### When *not* to reach for a comparison sort

Sorting is O(n log n), which is a lower bound only for *comparison* sorts. If the values come from a small known set, you can do better:

- **Counting sort** — values in a small range: tally them and rewrite. O(n + k).
- **Bucket / radix sort** — fixed-width keys. O(n) in practice.
- **Partial sort / heap** — you only need the top `k`, not the whole order. O(n log k).
- **Quickselect** — you only need the `k`-th element. O(n) average.

Ask "do I actually need the full ordering?" before paying for it.

### How should I recognize this?

```text
If you see...
  "merge / overlap / intervals", "closest pair", "k-th smallest"
  "group anagrams / group by", "minimum difference"
  "schedule the most meetings"
  and the input order is clearly irrelevant to the answer
        ↓
Think about...
  "If this were sorted, would the answer be sitting next to itself?"
        ↓
Use...
  sort by start   → merging / overlapping
  sort by end     → greedy scheduling
  sort by value   → duplicates, closest pairs, two-pointer setups
  counting sort   → small fixed value range
```

> **Warning:** sorting destroys the original indices. If the answer must be reported as *original* positions (like Two Sum), either sort `(value, index)` pairs or use a hash map instead.

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

```text
unsorted:   [8,10]  [1,3]  [2,6]      ← overlaps are far apart
   sort ↓
  sorted:   [1,3]  [2,6]  [8,10]      ← overlaps are now NEIGHBOURS

  sweep :   [1,3] + [2,6] → 2 <= 3 → merge → [1,6]
            [1,6] + [8,10] → 8 >  6 → gap   → start new
  result:   [1,6]  [8,10]
```

### Interview explanation
"The brute force is quadratic because any interval might overlap any other. If I sort by start time first, I get a strong guarantee: when I reach an interval, everything that could overlap it is already behind me. So I keep one 'current' interval and either extend its end with `max` or start a new one. Sorting is O(n log n) and the sweep is O(n), so O(n log n) overall — the sort dominates."

---

## 5. Generic Templates

> The shape is always the same: **sort by the right key, then sweep once comparing neighbours.**

```go
// SortAndSweep is the shape of nearly every sorting-based solution.
func MergeIntervals(intervals [][]int) [][]int {
    if len(intervals) == 0 {
        return nil
    }

    // Step 1: sort by start so overlaps become adjacent.
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0]
    })

    // Step 2: sweep, extending the last interval or starting a new one.
    merged := [][]int{{intervals[0][0], intervals[0][1]}}
    for _, iv := range intervals[1:] {
        last := merged[len(merged)-1]
        if iv[0] <= last[1] { // touches or overlaps
            if iv[1] > last[1] {
                last[1] = iv[1] // max: the new one may end earlier
            }
        } else {
            merged = append(merged, []int{iv[0], iv[1]})
        }
    }
    return merged
}

// CountingSort beats O(n log n) when values live in a small known range.
func CountingSort(nums []int, maxValue int) []int {
    count := make([]int, maxValue+1)
    for _, v := range nums {
        count[v]++
    }
    out := make([]int, 0, len(nums))
    for v, c := range count {
        for ; c > 0; c-- {
            out = append(out, v)
        }
    }
    return out
}
```

```python
def merge_intervals(intervals):
    if not intervals:
        return []
    intervals.sort(key=lambda iv: iv[0])       # overlaps become adjacent
    merged = [list(intervals[0])]
    for start, end in intervals[1:]:
        if start <= merged[-1][1]:             # touches or overlaps
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged

def counting_sort(nums, max_value):
    """O(n + k) when values are in a small known range."""
    count = [0] * (max_value + 1)
    for v in nums:
        count[v] += 1
    out = []
    for v, c in enumerate(count):
        out.extend([v] * c)
    return out
```

```java
import java.util.*;

public class SortingBased {
    public static int[][] mergeIntervals(int[][] intervals) {
        if (intervals.length == 0) return new int[0][];
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));

        List<int[]> merged = new ArrayList<>();
        merged.add(new int[]{intervals[0][0], intervals[0][1]});
        for (int i = 1; i < intervals.length; i++) {
            int[] last = merged.get(merged.size() - 1);
            if (intervals[i][0] <= last[1]) {
                last[1] = Math.max(last[1], intervals[i][1]);
            } else {
                merged.add(new int[]{intervals[i][0], intervals[i][1]});
            }
        }
        return merged.toArray(new int[0][]);
    }

    public static int[] countingSort(int[] nums, int maxValue) {
        int[] count = new int[maxValue + 1];
        for (int v : nums) count[v]++;
        int[] out = new int[nums.length];
        int i = 0;
        for (int v = 0; v <= maxValue; v++)
            for (int c = 0; c < count[v]; c++) out[i++] = v;
        return out;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

vector<vector<int>> mergeIntervals(vector<vector<int>> intervals) {
    if (intervals.empty()) return {};
    sort(intervals.begin(), intervals.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[0] < b[0]; });

    vector<vector<int>> merged{intervals[0]};
    for (size_t i = 1; i < intervals.size(); ++i) {
        if (intervals[i][0] <= merged.back()[1])
            merged.back()[1] = max(merged.back()[1], intervals[i][1]);
        else
            merged.push_back(intervals[i]);
    }
    return merged;
}

vector<int> countingSort(const vector<int>& nums, int maxValue) {
    vector<int> count(maxValue + 1, 0);
    for (int v : nums) ++count[v];
    vector<int> out;
    out.reserve(nums.size());
    for (int v = 0; v <= maxValue; ++v)
        out.insert(out.end(), count[v], v);
    return out;
}
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
Merge all overlapping intervals and return the non-overlapping result.

### Thought Process
1. Two intervals can only merge if they overlap, and in random order any pair might.
2. Sorting by **start** gives the key guarantee: when we reach an interval, everything that could overlap it is already processed.
3. So we only ever compare against the last interval in the result.
4. Overlap test: `current.start <= last.end` (using `<=` also merges touching intervals like `[1,4]` and `[4,5]`).
5. On merge, extend with `max` — the new interval may end *earlier* and must not shrink the old one.

### Dry Run

Input: `[[1,3], [2,6], [8,10], [15,18]]` (already sorted by start)

| interval  | last in result | `start <= last.end`? | action                         | result so far              |
|-----------|----------------|----------------------|--------------------------------|----------------------------|
| `[1,3]`   | —              | —                    | seed the result                | `[[1,3]]`                  |
| `[2,6]`   | `[1,3]`        | `2 <= 3` yes         | extend: `max(3,6) = 6`         | `[[1,6]]`                  |
| `[8,10]`  | `[1,6]`        | `8 <= 6` no          | gap → start new                | `[[1,6],[8,10]]`           |
| `[15,18]` | `[8,10]`       | `15 <= 10` no        | gap → start new                | `[[1,6],[8,10],[15,18]]`   |

Output: **`[[1,6], [8,10], [15,18]]`**

Extra case showing why `max` matters: `[[1,10],[2,3]]` → `2 <= 10` so merge, `max(10,3) = 10` → `[[1,10]]`. Taking the new end blindly would have given the wrong `[[1,3]]`.

### Visualization

```text
1---3
   2------6            merge (2 <= 3)  →  1------6
                8--10                     gap    →  8--10
                            15--18        gap    →  15--18

result: [1,6]  [8,10]  [15,18]
```

### Code

```go
func merge(intervals [][]int) [][]int {
    if len(intervals) == 0 {
        return nil
    }

    // Sort by start: overlaps become adjacent.
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0]
    })

    merged := [][]int{{intervals[0][0], intervals[0][1]}}
    for _, iv := range intervals[1:] {
        last := merged[len(merged)-1]
        if iv[0] <= last[1] {
            // Overlap: stretch the end, but never shrink it.
            if iv[1] > last[1] {
                last[1] = iv[1]
            }
        } else {
            // Gap: this interval starts a new block.
            merged = append(merged, []int{iv[0], iv[1]})
        }
    }
    return merged
}
```

```python
def merge(intervals):
    if not intervals:
        return []
    intervals.sort(key=lambda iv: iv[0])       # overlaps become adjacent
    merged = [list(intervals[0])]
    for start, end in intervals[1:]:
        if start <= merged[-1][1]:             # overlap
            merged[-1][1] = max(merged[-1][1], end)
        else:                                  # gap
            merged.append([start, end])
    return merged
```

### Complexity
Time O(n log n) — the sort dominates the O(n) sweep. Space O(n) for the output (O(log n) auxiliary if the sort is in-place).

---

## 10. Solved Example 2

### Problem — Sort an Array (LeetCode 912)
Sort `nums` in ascending order without using built-in sort, in guaranteed O(n log n).

### Thought Process
1. "Guaranteed O(n log n)" rules out quicksort, whose worst case is O(n²). Merge sort is the safe answer.
2. Merge sort rests on one easy observation: **merging two already-sorted lists is linear** — repeatedly take the smaller front element.
3. So: split in half, sort each half recursively, merge the two sorted halves.
4. The recursion bottoms out at length ≤ 1, which is sorted by definition.
5. Depth is `log n` and each level does O(n) merging work → O(n log n).

### Dry Run

Input: `[5, 2, 3, 1]`

**Split down:**

```text
            [5, 2, 3, 1]
           /            \
       [5, 2]          [3, 1]
       /    \          /    \
     [5]    [2]      [3]    [1]      ← length 1, already sorted
```

**Merge back up:**

| merging        | steps                                  | result      |
|----------------|----------------------------------------|-------------|
| `[5]` + `[2]`  | `2 < 5` → take 2, then 5               | `[2, 5]`    |
| `[3]` + `[1]`  | `1 < 3` → take 1, then 3               | `[1, 3]`    |
| `[2,5]`+`[1,3]`| `1<2` → 1; `2<3` → 2; `3<5` → 3; then 5| `[1,2,3,5]` |

Output: **`[1, 2, 3, 5]`**

Watch the final merge closely — each step only compares the two **front** elements, and each comparison permanently places one element. That's why the merge is O(n), not O(n²).

### Visualization

```text
left  = [2, 5]        right = [1, 3]        out = []
         ↑                     ↑
        2 vs 1 → 1 smaller  → out = [1],       advance right

left  = [2, 5]        right = [1, 3]        out = [1]
         ↑                        ↑
        2 vs 3 → 2 smaller  → out = [1,2],     advance left

left  = [2, 5]        right = [1, 3]        out = [1,2]
            ↑                     ↑
        5 vs 3 → 3 smaller  → out = [1,2,3],   right exhausted
                             append rest of left → [1,2,3,5]
```

### Code

```go
func sortArray(nums []int) []int {
    if len(nums) <= 1 {
        return nums
    }
    mid := len(nums) / 2
    left := sortArray(append([]int(nil), nums[:mid]...))
    right := sortArray(append([]int(nil), nums[mid:]...))
    return mergeSorted(left, right)
}

// mergeSorted combines two sorted slices in O(len(a)+len(b)).
func mergeSorted(a, b []int) []int {
    out := make([]int, 0, len(a)+len(b))
    i, j := 0, 0
    for i < len(a) && j < len(b) {
        if a[i] <= b[j] { // <= keeps equal elements stable
            out = append(out, a[i])
            i++
        } else {
            out = append(out, b[j])
            j++
        }
    }
    out = append(out, a[i:]...) // at most one of these is non-empty
    out = append(out, b[j:]...)
    return out
}
```

```python
def sortArray(nums):
    if len(nums) <= 1:
        return nums
    mid = len(nums) // 2
    left = sortArray(nums[:mid])
    right = sortArray(nums[mid:])

    out, i, j = [], 0, 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:        # <= keeps equal elements stable
            out.append(left[i]); i += 1
        else:
            out.append(right[j]); j += 1
    out.extend(left[i:])               # at most one of these is non-empty
    out.extend(right[j:])
    return out
```

### Complexity
Time O(n log n) guaranteed — `log n` levels, O(n) merging per level. Space O(n) for the merge buffers plus O(log n) recursion stack.

---

## 11. Solved Example 3

### Problem — Sort Colors (LeetCode 75)
Sort an array containing only `0`, `1`, and `2` in place.

### Thought Process
1. A comparison sort would cost O(n log n) — but comparison sorts are only forced when the values could be *anything*.
2. Here there are just **three possible values**. We don't need to compare elements at all; we only need to know how many of each there are.
3. That is **counting sort**: pass 1 tallies, pass 2 rewrites the array as `count[0]` zeros, then `count[1]` ones, then `count[2]` twos.
4. Two linear passes → O(n), beating the O(n log n) "lower bound" precisely because we never compare.

### Dry Run

Input: `nums = [2, 0, 2, 1, 1, 0]`

**Pass 1 — tally:**

| value | 0 | 1 | 2 |
|-------|---|---|---|
| count | 2 | 2 | 2 |

**Pass 2 — overwrite from the left:**

| write step        | array so far           |
|-------------------|------------------------|
| two `0`s          | `[0, 0, _, _, _, _]`   |
| two `1`s          | `[0, 0, 1, 1, _, _]`   |
| two `2`s          | `[0, 0, 1, 1, 2, 2]`   |

Output: **`[0, 0, 1, 1, 2, 2]`**

### Visualization

```text
input :  2  0  2  1  1  0
          ↓  tally
counts:  0→2   1→2   2→2
          ↓  rewrite left to right
output:  0  0 | 1  1 | 2  2
         └─2─┘ └─2─┘ └─2─┘
```

### Code

```go
func sortColors(nums []int) {
    // Pass 1: count how many of each value.
    var count [3]int
    for _, v := range nums {
        count[v]++
    }

    // Pass 2: rewrite the array in value order.
    i := 0
    for v := 0; v < 3; v++ {
        for c := 0; c < count[v]; c++ {
            nums[i] = v
            i++
        }
    }
}
```

```python
def sortColors(nums):
    count = [0, 0, 0]
    for v in nums:                 # pass 1: tally
        count[v] += 1
    i = 0
    for v in range(3):             # pass 2: rewrite in value order
        for _ in range(count[v]):
            nums[i] = v
            i += 1
```

### Complexity
Time O(n) — two linear passes. Space O(1) — three counters, sorted in place.

> This version reads the array twice. A **one-pass** in-place solution exists using three pointers — that is the Dutch National Flag pattern, covered in its own chapter.

---

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
