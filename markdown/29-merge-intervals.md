# 29 · Merge Intervals

> **One-liner:** Sort by start, then merge overlapping intervals in one pass.

---

## 1. Overview

### Definition
The **Merge Intervals** pattern belongs to the *Intervals* family. Sort by start, then merge overlapping intervals in one pass.

### Intuition
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Why it works
Sort by start (or process start/end events), then sweep once merging or counting overlaps. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Interval logic schedules calendar/meeting systems, allocates cloud resources (min machines for overlapping jobs), reconciles time-series gaps, and powers range-based access control. Sweep-line scales to millions of events with a single ordered pass.

---

## 2. Recognition Signals

### Keywords
intervals, merge, overlap, sort by start, union.

### Constraints
- Input size where the brute-force complexity would time out — the Merge Intervals optimization is the intended solution.
- Structural hints in the statement that match this family (Intervals).

### Hidden clues
- The problem can be reframed so the Merge Intervals invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Merge Intervals is the upgrade.
- The wording maps onto: intervals, merge, overlap, sort by start, union.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which of these ranges are really the same range?"*

Running example: `[[1,3], [2,6], [8,10], [15,18]]`. Two intervals overlap when neither ends before the other begins; `[1,3]` and `[2,6]` overlap and should become `[1,6]`.

### Intuition
Overlap is a property of a *pair*, so check every pair. When a pair overlaps, fuse it into one interval — but that new interval may now overlap something you already looked at, so you have to start over. Repeat until a full pass changes nothing.

### Algorithm
1. Repeat until a pass makes no change:
2. &nbsp;&nbsp;For every pair `(i, j)`:
3. &nbsp;&nbsp;&nbsp;&nbsp;If they overlap (`a[i].start <= a[j].end` and `a[j].start <= a[i].end`):
4. &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Replace them with `[min(starts), max(ends)]` and restart the pass.
5. Return whatever is left.

### Complexity
- Time: **O(n³)** in the worst case — O(n²) pairs per pass and up to O(n) passes (each pass may fuse only one pair).
- Space: O(n)

### Drawbacks
- On the running example the first pass compares `[1,3]` against `[2,6]`, `[8,10]` and `[15,18]`, even though the last two start *after* `[1,3]` has long finished. In the given order the comparison `[8,10]` vs `[15,18]` is made and re-made on every pass.
- The fact being ignored: **intervals live on a line, and a line has an order.** If you walked left to right, an interval that starts at 15 would obviously not need checking against one that ended at 3 — but unordered input forces every comparison to be made explicitly.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Sort by start time, and then the only interval that can possibly overlap the one in your hand is the last one you emitted — so a single left-to-right pass is enough.**

Think of merging calendar blocks by hand. If the meetings are shuffled you keep flipping back and forth through the pile. If you first lay them out in start order, you just run your finger down the page: either the next block begins before the current block ended (stretch the current one) or it begins after (start a new one).

### The shared move for every interval problem: SORT FIRST, then sweep

Every chapter in this family opens the same way — **sort, then make one pass**. What changes from problem to problem is the *sort key*, and choosing it wrong is the single biggest source of wrong answers:

| Goal | Sort by | The sweep rule |
|------|---------|----------------|
| **Merge / union overlapping ranges** | **start** | extend the last block: `end = max(end, cur.end)` |
| **Insert one interval into a sorted set** | already sorted by **start** | three phases: copy-left, absorb-overlaps, copy-right |
| **Most non-overlapping intervals (greedy)** | **end** | keep it if `cur.start >= lastKeptEnd` |
| **Fewest rooms / peak concurrency** | split into **+1 / −1 events** by time | running counter; answer is its maximum |

This chapter is row 1: **sort by start.**

### The thought process

```text
We need    : the union of a pile of ranges, as few disjoint ranges as possible.
Obvious way: compare every pair, fuse, repeat.
Too slow   : O(n^3), and most comparisons are between ranges that are nowhere
             near each other.
Notice     : intervals sit on a number line, and merging is a LOCAL operation.
Notice too : if we visit them in start order, everything already emitted lies
             entirely to the left of where we are now.
Therefore  : only the most recently emitted block can still be touched.
Now        : one comparison per interval → O(n) sweep, O(n log n) with the sort.
```

### Why comparing against only the last block is safe

This is the step that turns O(n²) into O(n), so it deserves a proof.

After sorting, we process intervals in non-decreasing start order and keep a result list of **disjoint** blocks, in left-to-right order. Let `L` be the last block in that list and `B` any earlier one. Because the blocks are disjoint and ordered, `B.end < L.start`.

Now take the current interval `[s, e]`. Its start `s` is at least the start of every interval processed so far, and `L.start` came from one of those — so `s >= L.start`. Chain it together:

```text
s  >=  L.start  >  B.end        ⇒   s > B.end   ⇒   no overlap with B
```

So the current interval **cannot** reach back past `L`. Checking `L` alone is not a heuristic; it is complete.

### Why the merge must use `max` — the mistake that quietly corrupts output

When the current interval overlaps `L`, the new end is `max(L.end, e)`, **never** just `e`:

```text
sorted input : [1,10]  [2,3]
                 └──── contains ────┘

with max :  [1,10] then 2 <= 10 → end = max(10, 3) = 10  →  [[1,10]]   ✓
without  :  [1,10] then 2 <= 10 → end = 3               →  [[1,3]]     ✗ !!
```

Sorting by start says nothing about the ends. A short interval nested inside a long one arrives *after* it and would shrink the block. `max` is what makes a contained interval a no-op.

One more decision to make explicitly: **do touching intervals merge?** `[1,3]` and `[3,5]` share only the point 3. Using `s <= L.end` merges them into `[1,5]`; using `s < L.end` keeps them separate. LeetCode 56 wants them merged. Say which convention you are using before you write the comparison.

### Steps

```text
Step 1 → Sort the intervals by start.
Step 2 → result = [ first interval ]  (a copy, so we never mutate the input)
Step 3 → For each remaining interval [s, e]:
Step 4 →     last = result[len(result)-1]
Step 5 →     if s <= last.end:  last.end = max(last.end, e)   // overlap → fuse
Step 6 →     else:              append [s, e]                 // gap → new block
Step 7 → Return result.
```

### How should I recognize this?

```text
If you see...
  "merge overlapping intervals", "union of ranges", "combine time slots"
  "remove covered intervals", "employee free time", "total covered length"
  input shaped [[start, end], ...] with no ordering promised
        ↓
Think about...
  "If I lay these on a number line in start order, does one pass solve it?"
        ↓
Use...
  sort by START, sweep, compare only against the last emitted block
    ├─ overlapping (s <= lastEnd) → lastEnd = max(lastEnd, e)   ← max, always
    ├─ disjoint    (s >  lastEnd) → start a new block
    └─ different goal? re-pick the sort key from the table above
```

### Visual explanation

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="mrg29" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Sort by start, sweep left→right, fuse overlapping bars</text>
  <text x="30" y="60" fill="#64748b">input</text>
  <rect x="112" y="48" width="104" height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="164" y="62" text-anchor="middle" fill="#1e293b">[1,3]</text>
  <rect x="164" y="72" width="208" height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="268" y="86" text-anchor="middle" fill="#1e293b">[2,6]</text>
  <rect x="476" y="48" width="104" height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="528" y="62" text-anchor="middle" fill="#1e293b">[8,10]</text>
  <text x="268" y="108" text-anchor="middle" fill="#d97706">[1,3] &amp; [2,6] overlap</text>
  <line x1="320" y1="114" x2="320" y2="150" stroke="#475569" marker-end="url(#mrg29)"/>
  <line x1="60" y1="132" x2="590" y2="132" stroke="#cbd5e1"/>
  <g fill="#64748b" text-anchor="middle">
    <line x1="60"  y1="128" x2="60"  y2="136" stroke="#94a3b8"/><text x="60"  y="150">0</text>
    <line x1="164" y1="128" x2="164" y2="136" stroke="#94a3b8"/><text x="164" y="150">2</text>
    <line x1="268" y1="128" x2="268" y2="136" stroke="#94a3b8"/><text x="268" y="150">4</text>
    <line x1="372" y1="128" x2="372" y2="136" stroke="#94a3b8"/><text x="372" y="150">6</text>
    <line x1="476" y1="128" x2="476" y2="136" stroke="#94a3b8"/><text x="476" y="150">8</text>
    <line x1="580" y1="128" x2="580" y2="136" stroke="#94a3b8"/><text x="580" y="150">10</text>
  </g>
  <text x="30" y="182" fill="#64748b">merged</text>
  <rect x="112" y="170" width="260" height="20" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="242" y="184" text-anchor="middle" fill="#1e293b">[1,6]</text>
  <rect x="476" y="170" width="104" height="20" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="528" y="184" text-anchor="middle" fill="#1e293b">[8,10]</text>
</svg>
```

```text
input (already in start order): [1,3]  [2,6]  [8,10]  [15,18]

  0    2    4    6    8   10   12   14   16   18
  ├────┼────┼────┼────┼────┼────┼────┼────┼────┤
   ▓▓▓▓▓                                          [1,3]
     ▓▓▓▓▓▓▓▓▓▓                                   [2,6]   2 <= 3 → fuse
                  ▓▓▓▓▓                           [8,10]  8 >  6 → new block
                                      ▓▓▓▓▓▓      [15,18] 15 > 10 → new block

result:
   ████████████                                   [1,6]
                  █████                           [8,10]
                                      ██████      [15,18]

one finger moving right — never a backward glance
```

### Interview explanation
"I'd sort by start time first, because that makes merging a local operation. Once the intervals are in start order, every block I've already emitted lies entirely to the left of where I am, so the only one the current interval can still overlap is the most recent — I never need to look further back. For each interval I check whether its start is at most the last block's end; if so I extend that block's end to the *maximum* of the two ends, which matters because a short interval nested inside a long one would otherwise shrink it. Otherwise there's a gap and I open a new block. That's O(n log n) for the sort and O(n) for the sweep, with O(n) output space."

---

## 5. Generic Templates

> Sort by start. Compare only with the last block. Extend with `max`, never with the new end.

```go
// MergeIntervals returns the union of the given [start, end] intervals as a
// minimal set of disjoint intervals, in increasing order.
// Touching intervals ([1,3] and [3,5]) are merged; use `<` for `<=` to keep
// them apart.
func MergeIntervals(intervals [][]int) [][]int {
    if len(intervals) == 0 {
        return [][]int{}
    }
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0] // sort by START
    })

    result := [][]int{{intervals[0][0], intervals[0][1]}} // copy, don't alias
    for _, cur := range intervals[1:] {
        last := result[len(result)-1]
        if cur[0] <= last[1] {
            // Overlap. max is essential: cur may be nested inside last,
            // in which case last[1] must not shrink.
            last[1] = max(last[1], cur[1])
        } else {
            result = append(result, []int{cur[0], cur[1]}) // gap → new block
        }
    }
    return result
}
```

```python
def merge_intervals(intervals):
    """Union of [start, end] intervals as a minimal disjoint set, in order.
    Touching intervals are merged; use `<` instead of `<=` to keep them apart."""
    if not intervals:
        return []
    intervals = sorted(intervals, key=lambda iv: iv[0])      # sort by START

    result = [list(intervals[0])]                            # copy, don't alias
    for start, end in intervals[1:]:
        last = result[-1]
        if start <= last[1]:
            # Overlap. max is essential: this interval may be nested inside
            # the last one, and last[1] must not shrink.
            last[1] = max(last[1], end)
        else:
            result.append([start, end])                      # gap -> new block
    return result
```

```java
import java.util.*;

public class IntervalMerger {
    /** Union of [start, end] intervals as a minimal disjoint set, in order. */
    public static int[][] mergeIntervals(int[][] intervals) {
        if (intervals.length == 0) return new int[0][];
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));  // by START

        List<int[]> result = new ArrayList<>();
        result.add(new int[]{intervals[0][0], intervals[0][1]});        // copy
        for (int i = 1; i < intervals.length; i++) {
            int[] last = result.get(result.size() - 1);
            if (intervals[i][0] <= last[1]) {
                // max is essential: intervals[i] may be nested inside last.
                last[1] = Math.max(last[1], intervals[i][1]);
            } else {
                result.add(new int[]{intervals[i][0], intervals[i][1]});
            }
        }
        return result.toArray(new int[0][]);
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

// Union of [start, end] intervals as a minimal disjoint set, in order.
vector<vector<int>> mergeIntervals(vector<vector<int>> intervals) {
    if (intervals.empty()) return {};
    sort(intervals.begin(), intervals.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[0] < b[0]; });

    vector<vector<int>> result{{intervals[0][0], intervals[0][1]}};  // copy
    for (size_t i = 1; i < intervals.size(); ++i) {
        vector<int>& last = result.back();
        if (intervals[i][0] <= last[1]) {
            // max is essential: intervals[i] may be nested inside last.
            last[1] = max(last[1], intervals[i][1]);
        } else {
            result.push_back({intervals[i][0], intervals[i][1]});
        }
    }
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Merge Intervals (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n log n)** |
| Time (best)  | — | **O(n log n)** |
| Time (average) | — | **O(n log n)** |
| Space | varies | **O(n)** |

> Sorting dominates; the sweep is O(n).

---

## 7. Common Mistakes

1. Sorting by end when the algorithm needs sorting by start (or vice versa).
2. Using `<` instead of `<=` for touching intervals (depends on problem).
3. Forgetting to extend the end with `max` (intervals can be nested).
4. Mutating shared interval objects unexpectedly.
5. Off-by-one with inclusive vs exclusive endpoints.
6. Not handling empty input.
7. Sweep-line: processing end events before start events at the same coordinate.
8. Counting overlaps wrong by not using a min-heap of end times.
9. Assuming intervals are pre-sorted when they aren't.
10. Greedy scheduling sorted by the wrong key (use earliest finish time).

---

## 8. Interview Follow-Up Questions

1. **Q: Why sort by start for merging?**
   A: Overlaps with earlier intervals can only come from the most recent merged one.

2. **Q: Insert into sorted intervals?**
   A: Three phases: before, overlapping (merge), after.

3. **Q: Minimum meeting rooms?**
   A: Min-heap of end times, or sweep start/end events.

4. **Q: Max non-overlapping intervals?**
   A: Greedy by earliest finish time.

5. **Q: Interval intersection of two lists?**
   A: Two-pointer over both sorted lists.

6. **Q: Touching intervals merge?**
   A: Depends on whether endpoints are inclusive.

7. **Q: Sweep line for skyline?**
   A: Process building edges; track max height with a heap.

8. **Q: Count active intervals at time t?**
   A: Prefix sum of +1/-1 events.

9. **Q: Remove covered intervals?**
   A: Sort and track max end.

10. **Q: Why O(n log n)?**
   A: Dominated by the sort.

11. **Q: Online interval insertion?**
   A: Interval tree / ordered map for O(log n) ops.

12. **Q: Car pooling / booking?**
   A: Difference array on time, or sweep.

13. **Q: Employee free time?**
   A: Merge all, then gaps are free time.

14. **Q: Stability of sort?**
   A: Usually irrelevant; ties broken arbitrarily.

15. **Q: Endpoints as floats?**
   A: Same logic; careful with equality comparisons.

---

## 9. Solved Example 1

### Problem — Merge Intervals (LeetCode 56)
Given an array of intervals `[start, end]`, merge every group of overlapping intervals and return the minimal set of disjoint intervals covering exactly the same points.

### Thought Process
1. Sort by **start**. This is row 1 of the sort-key table: merging is a union, and unions are built left to right.
2. Seed the result with a *copy* of the first interval, so the input is never mutated behind the caller's back.
3. For each subsequent interval, compare only with the last emitted block — sorting proves nothing earlier can still be reached.
4. Overlap (`start <= last.end`) → extend with `last.end = max(last.end, end)`. Gap → append a new block.
5. `max` is not cosmetic: a nested interval would otherwise shorten the block.

### Dry Run

Input: `[[1,3], [2,6], [8,10], [15,18]]` (already in start order)

| step | interval | last block | `start <= last.end`? | action | result so far |
|------|----------|-----------|----------------------|--------|---------------|
| 1 | `[1,3]` | — | — | seed | `[[1,3]]` |
| 2 | `[2,6]` | `[1,3]` | 2 ≤ 3 → yes | `end = max(3, 6) = 6` | `[[1,6]]` |
| 3 | `[8,10]` | `[1,6]` | 8 ≤ 6 → no | new block | `[[1,6],[8,10]]` |
| 4 | `[15,18]` | `[8,10]` | 15 ≤ 10 → no | new block | `[[1,6],[8,10],[15,18]]` |

Output: **`[[1,6],[8,10],[15,18]]`**

Now the run that exposes the `max` rule — input `[[1,4], [2,3]]`:

| step | interval | last block | `start <= last.end`? | with `max` | with plain `= end` |
|------|----------|-----------|----------------------|------------|--------------------|
| 1 | `[1,4]` | — | — | `[[1,4]]` | `[[1,4]]` |
| 2 | `[2,3]` | `[1,4]` | 2 ≤ 4 → yes | `end = max(4,3) = 4` → `[[1,4]]` ✓ | `end = 3` → `[[1,3]]` ✗ |

`[2,3]` is entirely *inside* `[1,4]`, so merging it must change nothing. Sorting by start gives no promise at all about ends, which is exactly why the ends need `max`.

### Visualization

```text
  1    3    5    7    9   11   13   15   17   19
  ├────┼────┼────┼────┼────┼────┼────┼────┼────┤
  ▓▓▓▓▓                                            [1,3]
    ▓▓▓▓▓▓▓▓▓▓                                     [2,6]   overlap → fuse
                  ▓▓▓▓▓                            [8,10]  gap    → new
                                      ▓▓▓▓▓▓▓      [15,18] gap    → new

  ███████████                                      [1,6]
                  █████                            [8,10]
                                      ███████      [15,18]

nesting case:
  ▓▓▓▓▓▓▓▓▓▓  [1,4]
    ▓▓▓▓▓     [2,3]   ← inside; max(4,3)=4 keeps the block at [1,4]
  ██████████  [1,4]
```

### Code

```go
func mergeIntervals(intervals [][]int) [][]int {
    if len(intervals) == 0 {
        return [][]int{}
    }
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0] // sort by START
    })

    result := [][]int{{intervals[0][0], intervals[0][1]}} // copy, never alias
    for _, cur := range intervals[1:] {
        last := result[len(result)-1]
        if cur[0] <= last[1] {
            // Overlap (or touch). max, because cur may be nested inside last.
            last[1] = max(last[1], cur[1])
        } else {
            result = append(result, []int{cur[0], cur[1]}) // gap → new block
        }
    }
    return result
}
```

```python
def merge(intervals):
    if not intervals:
        return []
    intervals = sorted(intervals, key=lambda iv: iv[0])   # sort by START

    result = [list(intervals[0])]                         # copy, never alias
    for start, end in intervals[1:]:
        last = result[-1]
        if start <= last[1]:
            # Overlap (or touch). max, because this may be nested inside last.
            last[1] = max(last[1], end)
        else:
            result.append([start, end])                   # gap -> new block
    return result
```

### Complexity
Time O(n log n) — the sort dominates; the sweep is a single O(n) pass with one comparison per interval. Space O(n) for the output (O(log n) auxiliary if the sort is in place).

## 10. Solved Example 2

### Problem — Insert Interval (LeetCode 57)
Given a list of non-overlapping intervals **already sorted by start**, insert a new interval and merge where necessary, returning the still-sorted, still-disjoint result.

### Thought Process
1. The input is already sorted, so re-sorting would be wasted work — this is O(n), not O(n log n).
2. Sorted order splits the list into exactly three consecutive regions relative to the new interval: entirely left, overlapping, entirely right.
3. **Left**: `intervals[i].end < new.start` → copy through untouched.
4. **Overlapping**: `intervals[i].start <= new.end` → absorb by widening `new` to `[min(starts), max(ends)]`. Push `new` once the absorbing stops.
5. **Right**: copy the rest through. Three simple `while` loops, no branching inside a single loop.

### Dry Run

Input: `intervals = [[1,3], [6,9]]`, `newInterval = [2,5]`

| phase | interval examined | test | outcome | `new` is now | result so far |
|-------|-------------------|------|---------|--------------|---------------|
| left | `[1,3]` | `3 < 2`? no | phase ends immediately | `[2,5]` | `[]` |
| absorb | `[1,3]` | `1 <= 5`? yes | widen | `[min(2,1), max(5,3)] = [1,5]` | `[]` |
| absorb | `[6,9]` | `6 <= 5`? no | phase ends | `[1,5]` | `[]` |
| push | — | — | emit `new` | — | `[[1,5]]` |
| right | `[6,9]` | — | copy through | — | `[[1,5],[6,9]]` |

Output: **`[[1,5],[6,9]]`**

The absorb row is where `min` earns its place. The new interval starts at 2, but it swallowed `[1,3]`, which starts at **1** — so the merged block must begin at 1, not 2. Widening happens on *both* sides.

### Visualization

```text
  0    2    4    6    8   10
  ├────┼────┼────┼────┼────┤
  ▓▓▓▓▓▓                        [1,3]   existing
                ▓▓▓▓▓▓▓▓        [6,9]   existing
     ░░░░░░░░░░                 [2,5]   new

  phase 1 (left)   : nothing — [1,3] does not end before 2
  phase 2 (absorb) : [1,3] overlaps → new = [1,5]
                     [6,9] starts at 6 > 5 → stop
  phase 3 (right)  : copy [6,9]

  ████████████                  [1,5]
                ████████        [6,9]

           left        overlapping        right
     ├──────────────┤├───────────────┤├────────────┤
     end < new.start   start <= new.end   the rest
```

### Code

```go
func insertInterval(intervals [][]int, newInterval []int) [][]int {
    result := [][]int{}
    start, end := newInterval[0], newInterval[1]
    i, n := 0, len(intervals)

    // Phase 1: everything that finishes before the new interval begins.
    for i < n && intervals[i][1] < start {
        result = append(result, intervals[i])
        i++
    }

    // Phase 2: everything that overlaps — absorb it by widening BOTH ends.
    for i < n && intervals[i][0] <= end {
        start = min(start, intervals[i][0])
        end = max(end, intervals[i][1])
        i++
    }
    result = append(result, []int{start, end})

    // Phase 3: everything that starts after the widened interval ends.
    for i < n {
        result = append(result, intervals[i])
        i++
    }
    return result
}
```

```python
def insert(intervals, newInterval):
    result = []
    start, end = newInterval
    i, n = 0, len(intervals)

    # Phase 1: everything that finishes before the new interval begins.
    while i < n and intervals[i][1] < start:
        result.append(intervals[i])
        i += 1

    # Phase 2: everything that overlaps - absorb it, widening BOTH ends.
    while i < n and intervals[i][0] <= end:
        start = min(start, intervals[i][0])
        end = max(end, intervals[i][1])
        i += 1
    result.append([start, end])

    # Phase 3: everything that starts after the widened interval ends.
    while i < n:
        result.append(intervals[i])
        i += 1
    return result
```

### Complexity
Time O(n) — each interval is examined by exactly one of the three loops. Space O(n) for the output. No sort is needed because the input already carries the order this pattern would have created.

## 11. Solved Example 3

### Problem — Interval Intersection (LeetCode 986)
Given two lists of closed intervals, each sorted and internally disjoint, return the list of all their pairwise **intersections**.

### Thought Process
1. Both lists are already in start order, so a two-pointer sweep replaces the O(m·n) pairwise comparison.
2. For the pair currently under the pointers, the overlap is `[max(startA, startB), min(endA, endB)]`.
3. That range is real only if `lo <= hi`; otherwise the two intervals miss each other entirely and nothing is emitted.
4. Then advance the pointer of whichever interval **ends first** — it can never intersect anything further right, because every remaining interval in the other list starts at or after the current one.
5. Stop when either list runs out.

### Dry Run

Input: `A = [[0,2], [5,10]]`, `B = [[1,5], [8,12]]`

| step | A[i] | B[j] | `lo = max(starts)` | `hi = min(ends)` | `lo <= hi`? | emit | ends first → advance |
|------|------|------|--------------------|------------------|-------------|------|----------------------|
| 1 | `[0,2]` | `[1,5]` | max(0,1) = 1 | min(2,5) = 2 | yes | `[1,2]` | A (2 < 5) → `i = 1` |
| 2 | `[5,10]` | `[1,5]` | max(5,1) = 5 | min(10,5) = 5 | yes | `[5,5]` | B (5 ≤ 10) → `j = 1` |
| 3 | `[5,10]` | `[8,12]` | max(5,8) = 8 | min(10,12) = 10 | yes | `[8,10]` | A (10 < 12) → `i = 2` |
| 4 | — | — | `i` past the end | — | — | — | loop ends |

Output: **`[[1,2],[5,5],[8,10]]`**

Step 2 produces the degenerate interval `[5,5]` — a single shared point. These are closed intervals, so `lo <= hi` (not `lo < hi`) is the correct validity test and `[5,5]` is a legitimate answer. Step 2 also shows the discard rule: `B[0] = [1,5]` ends at 5, and every remaining interval of `A` starts at 5 or later, so `[1,5]` has nothing left to meet and can be retired.

### Visualization

```text
   0    2    4    6    8   10   12
   ├────┼────┼────┼────┼────┼────┤
A  ▓▓▓▓▓▓                            [0,2]
A            ▓▓▓▓▓▓▓▓▓▓▓             [5,10]
B     ░░░░░░░░░░                     [1,5]
B                  ░░░░░░░░░░        [8,12]

        ██                           [1,2]   = max(0,1) .. min(2,5)
             ▪                       [5,5]   = single shared point
                   ██████            [8,10]  = max(5,8) .. min(10,12)

advance rule: retire the interval that ENDS first —
              nothing further right can still reach back to it
```

### Code

```go
func intervalIntersection(a [][]int, b [][]int) [][]int {
    result := [][]int{}
    i, j := 0, 0
    for i < len(a) && j < len(b) {
        // The overlap of two intervals is [later start, earlier end].
        lo := max(a[i][0], b[j][0])
        hi := min(a[i][1], b[j][1])
        if lo <= hi { // closed intervals, so a single point counts
            result = append(result, []int{lo, hi})
        }
        // Retire whichever ends first: every remaining interval on the other
        // side starts at or after the current one, so it can meet nothing more.
        if a[i][1] < b[j][1] {
            i++
        } else {
            j++
        }
    }
    return result
}
```

```python
def intervalIntersection(A, B):
    result = []
    i = j = 0
    while i < len(A) and j < len(B):
        # The overlap of two intervals is [later start, earlier end].
        lo = max(A[i][0], B[j][0])
        hi = min(A[i][1], B[j][1])
        if lo <= hi:                 # closed intervals: a single point counts
            result.append([lo, hi])
        # Retire whichever ends first - it can meet nothing further right.
        if A[i][1] < B[j][1]:
            i += 1
        else:
            j += 1
    return result
```

### Complexity
Time O(m + n) — every iteration retires exactly one interval, so the pointers advance a combined `m + n` times. Space O(1) beyond the output. No sort is needed; both inputs arrive sorted.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 56 | Merge Intervals | Easy | Core intervals application |
| 57 | Insert Interval | Easy | Core intervals application |
| 986 | Interval Intersection | Medium | Core intervals application |
| 759 | Free Time | Medium | Core intervals application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Merge intervals**
- **Insert interval**
- **Meeting rooms (min concurrent)**
- **Sweep line / events**
- **Greedy interval scheduling**

---

## 14. Production Engineering Applications

- **Scalability:** Interval logic schedules calendar/meeting systems, allocates cloud resources (min machines for overlapping jobs), reconciles time-series gaps, and powers range-based access control. Sweep-line scales to millions of events with a single ordered pass.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Merge Intervals logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Merge Intervals (Intervals).
- **Signal:** intervals, merge, overlap, sort by start, union.
- **Move:** Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.
- **Cost:** O(n log n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Merge Intervals invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Merge Intervals
FAMILY : Intervals (Intermediate)
WHEN   : intervals, merge, overlap, sort by start, union
DO     : Sorting linearizes the geometry so a single left-to-right sweep resolves all ove
TIME   : O(n log n)    SPACE: O(n)
PRACTICE: 56, 57, 986, 759
```

---

*Part of the DSA Patterns Handbook — pattern 29 of 100.*
