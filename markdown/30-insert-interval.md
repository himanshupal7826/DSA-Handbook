# 30 · Insert Interval

> **One-liner:** Insert one interval into a sorted set, merging overlaps around it.

---

## 1. Overview

### Definition
The **Insert Interval** pattern belongs to the *Intervals* family. Insert one interval into a sorted set, merging overlaps around it.

### Intuition
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Why it works
Sort by start (or process start/end events), then sweep once merging or counting overlaps. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Interval logic schedules calendar/meeting systems, allocates cloud resources (min machines for overlapping jobs), reconciles time-series gaps, and powers range-based access control. Sweep-line scales to millions of events with a single ordered pass.

---

## 2. Recognition Signals

### Keywords
insert interval, merge, overlap, before after, sorted intervals.

### Constraints
- Input size where the brute-force complexity would time out — the Insert Interval optimization is the intended solution.
- Structural hints in the statement that match this family (Intervals).

### Hidden clues
- The problem can be reframed so the Insert Interval invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Insert Interval is the upgrade.
- The wording maps onto: insert interval, merge, overlap, before after, sorted intervals.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"A new interval arrives into an already-sorted, non-overlapping list — how do I fold it in?"*

### Intuition
Append the new interval, then re-run a full merge from scratch.

### Algorithm
1. Append `newInterval` to the list.
2. Sort everything by start.
3. Sweep once, merging any interval that overlaps the previous one.
4. Return the merged result.

### Complexity
- Time: **O(n log n)** — dominated by the sort.
- Space: O(n).

### Drawbacks
- The input was **already sorted and already non-overlapping**. Sorting it again destroys and rebuilds a guarantee we were handed for free.
- Only a contiguous *slice* of the list can possibly touch the new interval. Re-merging all `n` intervals to discover that is wasted work.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **The existing intervals are already sorted, so they split into exactly three consecutive groups: those entirely before the new one, those that touch it, and those entirely after.**

```text
existing:  [1,2]  [3,5]  [6,7]  [8,10]  [12,16]
new     :          [4 ─────────────── 8]

  group A          group B                group C
  ends before      overlaps               starts after
  [1,2]            [3,5] [6,7] [8,10]     [12,16]
                   └── merge into one ──┘
```

Copy group A unchanged, collapse group B into a single interval, copy group C unchanged. One pass, no sorting.

### The thought process

```text
We need    : insert an interval into a sorted, non-overlapping list.
Obvious way: append, re-sort, re-merge.
Wasteful   : the input was already sorted — we threw that away.
Notice     : sortedness means the intervals that overlap the new one
             are CONSECUTIVE. Everything before them ends too early;
             everything after them starts too late.
Therefore  : walk once. Emit the "before" group, absorb the middle
             group into one interval, emit the "after" group.
Now        : O(n), no sort at all.
```

### Steps

```text
Step 1 → i = 0, result = []
Step 2 → While intervals[i] ends BEFORE the new one starts:
             emit it unchanged; i++
Step 3 → While intervals[i] starts at or before the new one ends:
             newStart = min(newStart, intervals[i].start)
             newEnd   = max(newEnd,   intervals[i].end)
             i++
Step 4 → Emit the merged new interval.
Step 5 → Emit every remaining interval unchanged.
```

### The two comparisons, precisely

Everything hinges on getting these right:

```text
"ends strictly before"  →  intervals[i].end < newInterval.start   → group A
"overlaps or touches"   →  intervals[i].start <= newInterval.end  → group B
```

Note both use the *opposite* endpoints. Group A compares an existing **end** against the new **start**; group B compares an existing **start** against the new **end**. Mixing those up is the classic bug.

### Why `<` in one place and `<=` in the other

`[1,2]` and `[3,5]` do **not** overlap for integer intervals — but `[1,3]` and `[3,5]` do touch, and LeetCode wants touching intervals merged into `[1,5]`. So:

- Group A uses `end < start` (strict): an interval ending exactly at the new start is *not* skipped — it belongs in the merge.
- Group B uses `start <= end` (inclusive): an interval starting exactly at the new end *is* absorbed.

If the problem treated intervals as half-open (`[start, end)`, common for time slots), you would flip both to the other strictness.

### Why `min` and `max` and not just the endpoints

The new interval might be entirely swallowed by an existing one. Inserting `[4,5]` into a list containing `[3,10]` must produce `[3,10]`, not `[4,5]` or `[3,5]`. Taking `min` of the starts and `max` of the ends handles containment in either direction without a special case.

### How should I recognize this?

```text
If you see...
  "insert into a sorted list of non-overlapping intervals"
  "add a booking / reservation / range and merge"
  the input is PROMISED sorted and disjoint
        ↓
Think about...
  "Three groups: before, overlapping, after.
   Which comparison separates each pair?"
        ↓
Use...
  skip while end < newStart
  absorb while start <= newEnd, taking min/max
  copy the rest
```

### Visual explanation

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ins30" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Insert [2,5]: fuse the overlapped bars, keep the rest</text>
  <text x="30" y="60" fill="#64748b">before</text>
  <rect x="112" y="48" width="104" height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="164" y="62" text-anchor="middle" fill="#1e293b">[1,3]</text>
  <rect x="372" y="48" width="156" height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="450" y="62" text-anchor="middle" fill="#1e293b">[6,9]</text>
  <rect x="164" y="74" width="156" height="20" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="242" y="88" text-anchor="middle" fill="#1e293b">new [2,5]</text>
  <text x="200" y="112" text-anchor="middle" fill="#d97706">[1,3] &amp; [2,5] touch → fuse</text>
  <line x1="242" y1="118" x2="242" y2="150" stroke="#475569" marker-end="url(#ins30)"/>
  <line x1="60" y1="132" x2="590" y2="132" stroke="#cbd5e1"/>
  <g fill="#64748b" text-anchor="middle">
    <line x1="60"  y1="128" x2="60"  y2="136" stroke="#94a3b8"/><text x="60"  y="150">0</text>
    <line x1="164" y1="128" x2="164" y2="136" stroke="#94a3b8"/><text x="164" y="150">2</text>
    <line x1="268" y1="128" x2="268" y2="136" stroke="#94a3b8"/><text x="268" y="150">4</text>
    <line x1="372" y1="128" x2="372" y2="136" stroke="#94a3b8"/><text x="372" y="150">6</text>
    <line x1="476" y1="128" x2="476" y2="136" stroke="#94a3b8"/><text x="476" y="150">8</text>
    <line x1="580" y1="128" x2="580" y2="136" stroke="#94a3b8"/><text x="580" y="150">10</text>
  </g>
  <text x="30" y="182" fill="#64748b">after</text>
  <rect x="112" y="170" width="208" height="20" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="216" y="184" text-anchor="middle" fill="#1e293b">[1,5]</text>
  <rect x="372" y="170" width="156" height="20" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="450" y="184" text-anchor="middle" fill="#1e293b">[6,9]</text>
</svg>
```

```text
intervals = [[1,3], [6,9]]      newInterval = [2,5]

[1,3]:  end 3 <  start 2 ?  no   → not "before"
        start 1 <= end 5   ?  yes → ABSORB
                                    new = [min(2,1), max(5,3)] = [1,5]

[6,9]:  start 6 <= end 5   ?  no  → stop absorbing

emit [1,5], then copy [6,9]      →  [[1,5], [6,9]]
```

### Interview explanation
"The list is already sorted and disjoint, so I won't re-sort. Sortedness means the intervals overlapping the new one form a contiguous block, which splits the list into three groups. I copy everything that ends before the new interval starts, then absorb everything that starts at or before the new interval ends — taking the min of starts and max of ends so containment works either way — then copy the rest. One pass, O(n) time and O(n) output space, versus O(n log n) if I re-sorted."

---

## 5. Generic Templates

> Three groups, two comparisons, one pass. Never re-sort a sorted input.

```go
// InsertInterval folds newInterval into a sorted, non-overlapping list.
func InsertInterval(intervals [][]int, newInterval []int) [][]int {
    result := [][]int{}
    start, end := newInterval[0], newInterval[1]
    i, n := 0, len(intervals)

    // Group A: ends strictly before the new interval starts.
    for i < n && intervals[i][1] < start {
        result = append(result, intervals[i])
        i++
    }

    // Group B: overlaps or touches — absorb into one interval.
    for i < n && intervals[i][0] <= end {
        if intervals[i][0] < start {
            start = intervals[i][0] // min of the starts
        }
        if intervals[i][1] > end {
            end = intervals[i][1] // max of the ends
        }
        i++
    }
    result = append(result, []int{start, end})

    // Group C: starts after the new interval ends.
    for i < n {
        result = append(result, intervals[i])
        i++
    }
    return result
}

// MergeIntervals is the sibling for an UNSORTED list: sort, then sweep.
func MergeIntervals(intervals [][]int) [][]int {
    if len(intervals) == 0 {
        return nil
    }
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][0] < intervals[b][0]
    })

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
```

```python
def insert_interval(intervals, new_interval):
    """Fold new_interval into a sorted, non-overlapping list."""
    result = []
    start, end = new_interval
    i, n = 0, len(intervals)

    while i < n and intervals[i][1] < start:      # group A: ends before
        result.append(intervals[i])
        i += 1

    while i < n and intervals[i][0] <= end:       # group B: overlaps/touches
        start = min(start, intervals[i][0])
        end = max(end, intervals[i][1])
        i += 1
    result.append([start, end])

    while i < n:                                  # group C: starts after
        result.append(intervals[i])
        i += 1
    return result

def merge_intervals(intervals):
    """Sibling for an UNSORTED list: sort, then sweep."""
    if not intervals:
        return []
    intervals.sort(key=lambda iv: iv[0])
    merged = [list(intervals[0])]
    for start, end in intervals[1:]:
        if start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
```

```java
import java.util.*;

public class InsertIntervalPattern {
    public static int[][] insertInterval(int[][] intervals, int[] newInterval) {
        List<int[]> result = new ArrayList<>();
        int start = newInterval[0], end = newInterval[1];
        int i = 0, n = intervals.length;

        while (i < n && intervals[i][1] < start) result.add(intervals[i++]);   // group A

        while (i < n && intervals[i][0] <= end) {                              // group B
            start = Math.min(start, intervals[i][0]);
            end = Math.max(end, intervals[i][1]);
            i++;
        }
        result.add(new int[]{start, end});

        while (i < n) result.add(intervals[i++]);                              // group C
        return result.toArray(new int[0][]);
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

vector<vector<int>> insertInterval(const vector<vector<int>>& intervals,
                                   vector<int> newInterval) {
    vector<vector<int>> result;
    int start = newInterval[0], end = newInterval[1];
    int i = 0, n = (int)intervals.size();

    while (i < n && intervals[i][1] < start) result.push_back(intervals[i++]);  // group A

    while (i < n && intervals[i][0] <= end) {                                   // group B
        start = min(start, intervals[i][0]);
        end = max(end, intervals[i][1]);
        ++i;
    }
    result.push_back({start, end});

    while (i < n) result.push_back(intervals[i++]);                             // group C
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Insert Interval (Optimal) |
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

### Problem — Insert Interval (LeetCode 57)
Given a list of non-overlapping intervals **sorted by start**, insert `newInterval` and merge where necessary.

### Thought Process
1. The input is already sorted and disjoint, so re-sorting would waste the guarantee we were given.
2. Sortedness means the intervals that overlap the new one are **consecutive**, splitting the list into three groups: before, overlapping, after.
3. Copy the "before" group (`end < newStart`) unchanged.
4. Absorb the overlapping group (`start <= newEnd`) with `min` on starts and `max` on ends.
5. Copy the remainder unchanged.

### Dry Run

Input: `intervals = [[1,3], [6,9]]`, `newInterval = [2,5]`

Start: `start = 2`, `end = 5`

| interval | `end < 2`? (group A) | `start <= 5`? (group B) | action | running new interval |
|----------|----------------------|--------------------------|--------|----------------------|
| `[1,3]`  | `3 < 2` → no | `1 <= 5` → **yes** | absorb | `[min(2,1), max(5,3)] = [1,5]` |
| `[6,9]`  | — | `6 <= 5` → no | stop absorbing | `[1,5]` |

Emit `[1,5]`, then copy `[6,9]`.

Output: **`[[1,5], [6,9]]`** ✓

**A second case showing containment**, `intervals = [[1,10]]`, `newInterval = [4,5]`:
`1 <= 5` → absorb → `[min(4,1), max(5,10)] = [1,10]`. The new interval is swallowed whole, exactly as it should be. Taking `max` of the ends is what prevents the wrong answer `[1,5]`.

### Visualization

```text
intervals:  [1───3]        [6─────9]
new      :     [2────5]

group A : none            (nothing ends before 2)
group B : [1,3]           (starts at 1 <= 5) → merge → [1,5]
group C : [6,9]           (starts at 6 > 5)  → copied

result  :  [1─────5]       [6─────9]
```

### Code

```go
func insert(intervals [][]int, newInterval []int) [][]int {
    result := [][]int{}
    start, end := newInterval[0], newInterval[1]
    i, n := 0, len(intervals)

    // Group A: ends strictly before the new interval starts.
    for i < n && intervals[i][1] < start {
        result = append(result, intervals[i])
        i++
    }

    // Group B: overlaps or touches — absorb into one interval.
    for i < n && intervals[i][0] <= end {
        if intervals[i][0] < start {
            start = intervals[i][0] // min of the starts
        }
        if intervals[i][1] > end {
            end = intervals[i][1] // max of the ends: handles containment
        }
        i++
    }
    result = append(result, []int{start, end})

    // Group C: everything that starts after the new interval ends.
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

    while i < n and intervals[i][1] < start:    # group A: ends before
        result.append(intervals[i])
        i += 1

    while i < n and intervals[i][0] <= end:     # group B: overlaps/touches
        start = min(start, intervals[i][0])
        end = max(end, intervals[i][1])         # max handles containment
        i += 1
    result.append([start, end])

    while i < n:                                # group C: starts after
        result.append(intervals[i])
        i += 1
    return result
```

### Complexity
Time **O(n)** — a single pass, no sorting. Space O(n) for the output.

---

## 10. Solved Example 2

### Problem — Merge Intervals (LeetCode 56)
Given an **unsorted** list of intervals, merge all overlapping ones.

### Thought Process
1. This is the same problem with the sortedness guarantee removed — so we must pay for it ourselves.
2. Sorting by start restores the property that makes everything work: overlapping intervals become adjacent.
3. Then sweep once, keeping only the last interval in the result:
   - `start <= last.end` → they touch or overlap → extend `last.end` with `max`
   - otherwise → there is a gap → push a new interval
4. `max` is essential: the incoming interval may be entirely inside the previous one.

### Dry Run

Input: `[[1,3], [2,6], [8,10], [15,18]]` (already sorted by start here)

| interval | last in result | `start <= last.end`? | action | result |
|----------|----------------|----------------------|--------|--------|
| `[1,3]`  | — | — | seed | `[[1,3]]` |
| `[2,6]`  | `[1,3]` | `2 <= 3` yes | extend to `max(3,6) = 6` | `[[1,6]]` |
| `[8,10]` | `[1,6]` | `8 <= 6` no  | gap → push | `[[1,6],[8,10]]` |
| `[15,18]`| `[8,10]`| `15 <= 10` no | gap → push | `[[1,6],[8,10],[15,18]]` |

Output: **`[[1,6], [8,10], [15,18]]`** ✓

**Why `max` matters:** on `[[1,10],[2,3]]`, the test `2 <= 10` passes, and `max(10,3) = 10` keeps `[1,10]`. Blindly assigning the new end would give `[1,3]` and silently lose coverage.

### Visualization

```text
unsorted:   [8,10]  [1,3]  [2,6]      overlaps are far apart
    sort ↓
sorted  :   [1,3]  [2,6]  [8,10]      overlaps are now NEIGHBOURS

1───3
   2──────6        2 <= 3 → merge → 1──────6
              8──10                  8 > 6  → new block
```

### Code

```go
func merge(intervals [][]int) [][]int {
    if len(intervals) == 0 {
        return nil
    }

    // Restore the guarantee that Insert Interval was handed for free.
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][0] < intervals[b][0]
    })

    merged := [][]int{{intervals[0][0], intervals[0][1]}}
    for _, iv := range intervals[1:] {
        last := merged[len(merged)-1]
        if iv[0] <= last[1] { // touches or overlaps
            if iv[1] > last[1] {
                last[1] = iv[1] // max: never shrink the interval
            }
        } else {
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
        if start <= merged[-1][1]:             # touches or overlaps
            merged[-1][1] = max(merged[-1][1], end)   # never shrink
        else:
            merged.append([start, end])        # gap
    return merged
```

### Complexity
Time **O(n log n)** — the sort dominates the O(n) sweep. Space O(n).

> Compare with Example 1: given sortedness, insertion is O(n). Take it away and you pay O(n log n) to get it back. That is what the guarantee was worth.

---

## 11. Solved Example 3

### Problem — Range Module (LeetCode 715)
Track a set of half-open ranges `[left, right)` supporting `addRange`, `queryRange` (is the whole range covered?) and `removeRange`.

### Thought Process
1. Store the covered ranges as a **sorted list of disjoint intervals** — the same shape Example 1 assumed, maintained as an invariant across every operation.
2. `addRange` is Insert Interval verbatim: skip, absorb, copy.
3. `removeRange` is the mirror operation — it can **split** one interval into two: the part left of the removal and the part right of it.
4. `queryRange(l, r)` finds the last interval starting at or before `l` (an upper bound, stepped back one) and checks whether it reaches `r`. Since the intervals are disjoint, only that one can possibly cover `l`.
5. These are **half-open** ranges, so touching ranges like `[1,3)` and `[3,5)` merge into `[1,5)` — the comparison is `end < left` rather than `end <= left`.

### Dry Run

| operation | intervals after | explanation |
|-----------|-----------------|-------------|
| `addRange(10, 20)` | `[[10,20]]` | first range |
| `removeRange(14, 16)` | `[[10,14], [16,20]]` | `[10,20)` is split: keep `[10,14)` on the left, `[16,20)` on the right |
| `queryRange(10, 14)` | — | last interval starting `<= 10` is `[10,14)`; its end `14 >= 14` → **`true`** |
| `queryRange(13, 15)` | — | last interval starting `<= 13` is `[10,14)`; its end `14 >= 15`? no → **`false`** |
| `queryRange(16, 17)` | — | last interval starting `<= 16` is `[16,20)`; its end `20 >= 17` → **`true`** |

Output: **`true`, `false`, `true`** ✓

`queryRange(13,15)` is the instructive one: the range straddles the hole at `[14,16)`. Because the stored intervals are disjoint, no *other* interval can help — checking the single candidate is enough.

### Visualization

```text
addRange(10,20)      10 ████████████████████ 20

removeRange(14,16)   10 ██████│      │██████ 20
                            14        16
                        [10,14)      [16,20)

queryRange(13,15):   13 ──┬──┘ hole ✗        → false
queryRange(16,17):        16 ├──┤ inside     → true
```

### Code

```go
type RangeModule struct {
    // Sorted, disjoint, half-open ranges [start, end).
    ranges [][]int
}

func NewRangeModule() RangeModule {
    return RangeModule{ranges: [][]int{}}
}

// AddRange is Insert Interval: skip, absorb, copy.
func (m *RangeModule) AddRange(left int, right int) {
    result := [][]int{}
    i, n := 0, len(m.ranges)

    // Ends strictly before left: no contact (half-open, so touching merges).
    for i < n && m.ranges[i][1] < left {
        result = append(result, m.ranges[i])
        i++
    }
    // Overlaps or touches: absorb.
    for i < n && m.ranges[i][0] <= right {
        if m.ranges[i][0] < left {
            left = m.ranges[i][0]
        }
        if m.ranges[i][1] > right {
            right = m.ranges[i][1]
        }
        i++
    }
    result = append(result, []int{left, right})

    for i < n {
        result = append(result, m.ranges[i])
        i++
    }
    m.ranges = result
}

// QueryRange checks the single interval that could possibly cover left.
func (m *RangeModule) QueryRange(left int, right int) bool {
    // Upper bound on start, stepped back one: the last start <= left.
    lo, hi := 0, len(m.ranges)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if m.ranges[mid][0] <= left {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    if lo == 0 {
        return false // every stored range starts after left
    }
    return m.ranges[lo-1][1] >= right
}

// RemoveRange can split one interval into two.
func (m *RangeModule) RemoveRange(left int, right int) {
    result := [][]int{}
    for _, r := range m.ranges {
        if r[1] <= left || r[0] >= right {
            result = append(result, r) // no overlap: keep as-is
            continue
        }
        if r[0] < left {
            result = append(result, []int{r[0], left}) // surviving left piece
        }
        if r[1] > right {
            result = append(result, []int{right, r[1]}) // surviving right piece
        }
    }
    m.ranges = result
}
```

```python
from bisect import bisect_right

class RangeModule:
    def __init__(self):
        self.ranges = []                  # sorted, disjoint, half-open [start, end)

    def addRange(self, left, right):      # Insert Interval: skip, absorb, copy
        result = []
        i, n = 0, len(self.ranges)
        while i < n and self.ranges[i][1] < left:
            result.append(self.ranges[i])
            i += 1
        while i < n and self.ranges[i][0] <= right:
            left = min(left, self.ranges[i][0])
            right = max(right, self.ranges[i][1])
            i += 1
        result.append([left, right])
        result.extend(self.ranges[i:])
        self.ranges = result

    def queryRange(self, left, right):
        starts = [r[0] for r in self.ranges]
        i = bisect_right(starts, left)    # last start <= left
        return i > 0 and self.ranges[i - 1][1] >= right

    def removeRange(self, left, right):   # may split one interval into two
        result = []
        for s, e in self.ranges:
            if e <= left or s >= right:
                result.append([s, e])     # no overlap
                continue
            if s < left:
                result.append([s, left])  # surviving left piece
            if e > right:
                result.append([right, e]) # surviving right piece
        self.ranges = result
```

### Complexity
`queryRange` **O(log n)**. `addRange` and `removeRange` are O(n) as written because they rebuild the list; with a balanced BST or ordered map they become O(log n) plus the number of intervals actually touched.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 57 | Insert Interval | Easy | Core intervals application |
| 56 | Merge Intervals | Easy | Core intervals application |
| 715 | Range Module | Medium | Core intervals application |
| 352 | Data Stream | Medium | Core intervals application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Insert Interval logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Insert Interval (Intervals).
- **Signal:** insert interval, merge, overlap, before after, sorted intervals.
- **Move:** Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.
- **Cost:** O(n log n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Insert Interval invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Insert Interval
FAMILY : Intervals (Intermediate)
WHEN   : insert interval, merge, overlap, before after, sorted intervals
DO     : Sorting linearizes the geometry so a single left-to-right sweep resolves all ove
TIME   : O(n log n)    SPACE: O(n)
PRACTICE: 57, 56, 715, 352
```

---

*Part of the DSA Patterns Handbook — pattern 30 of 100.*
