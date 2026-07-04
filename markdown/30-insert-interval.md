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

### Intuition
Compare every pair of intervals for overlap — O(n^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Insert Interval pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Insert Interval invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Insert Interval   : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Insert Interval problem. I'll sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps. That brings the complexity down to O(n log n) time and O(n) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Intervals** family template. Adapt the comparison/condition to the specific problem.

```go
// Merge overlapping intervals.
func merge(intervals [][]int) [][]int {
    sort.Slice(intervals, func(i, j int) bool { return intervals[i][0] < intervals[j][0] })
    res := [][]int{}
    for _, in := range intervals {
        n := len(res)
        if n > 0 && in[0] <= res[n-1][1] {
            if in[1] > res[n-1][1] { res[n-1][1] = in[1] } // extend
        } else {
            res = append(res, in)
        }
    }
    return res
}
```

```python
def merge(intervals):
    intervals.sort(key=lambda x: x[0])
    res = []
    for s, e in intervals:
        if res and s <= res[-1][1]:
            res[-1][1] = max(res[-1][1], e)   # extend last
        else:
            res.append([s, e])
    return res
```

```java
int[][] merge(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    List<int[]> res = new ArrayList<>();
    for (int[] in : intervals) {
        if (!res.isEmpty() && in[0] <= res.get(res.size()-1)[1])
            res.get(res.size()-1)[1] = Math.max(res.get(res.size()-1)[1], in[1]);
        else res.add(in);
    }
    return res.toArray(new int[0][]);
}
```

```cpp
vector<vector<int>> merge(vector<vector<int>>& intervals) {
    sort(intervals.begin(), intervals.end());
    vector<vector<int>> res;
    for (auto& in : intervals) {
        if (!res.empty() && in[0] <= res.back()[1])
            res.back()[1] = max(res.back()[1], in[1]);
        else res.push_back(in);
    }
    return res;
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
Given a sorted list of non-overlapping intervals, insert a new interval, merging as needed, and return the still-sorted result.

### Thought Process
1. The input is already sorted and disjoint, so a single three-phase pass avoids re-sorting.
2. Emit every interval strictly left of the new one; then absorb all overlapping intervals by widening the new interval's bounds.
3. Push the widened interval, then emit the remaining strictly-right intervals.

### Dry Run
`intervals=[[1,2],[3,5],[6,7],[8,10],[12,16]]`, `newInterval=[4,8]`.
- Left: `[1,2]` (2 < 4) emitted.
- Overlap: `[3,5]`,`[6,7]`,`[8,10]` → new grows to `[3,10]`; push `[3,10]`.
- Right: `[12,16]` emitted.
- Result `[[1,2],[3,10],[12,16]]`.

### Visualization
```
input  ──▶ [ apply Insert Interval step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def insert(intervals, newInterval):
    res, i, n = [], 0, len(intervals)
    s, e = newInterval
    while i < n and intervals[i][1] < s:      # left of new
        res.append(intervals[i]); i += 1
    while i < n and intervals[i][0] <= e:     # overlapping
        s = min(s, intervals[i][0])
        e = max(e, intervals[i][1]); i += 1
    res.append([s, e])
    while i < n:                              # right of new
        res.append(intervals[i]); i += 1
    return res
```

### Complexity
Time O(n), Space O(n). One linear pass; no sort needed.

## 10. Solved Example 2

### Problem — Merge Intervals (LeetCode 56)
Given an unsorted array of intervals, merge all overlapping ones into non-overlapping intervals covering the same span.

### Thought Process
1. Sort by start; then any interval overlapping the running block appears right after it.
2. Track the last block in the result. If the next start is ≤ the last end, extend the block's end.
3. If there is a gap, the next interval opens a new block.

### Dry Run
Input `[[1,4],[4,5],[2,3]]`. Sort by start → `[[1,4],[2,3],[4,5]]`.
- `[1,4]` → res `[[1,4]]`.
- `[2,3]`: 2 ≤ 4, extend end max(4,3)=4 → `[[1,4]]`.
- `[4,5]`: 4 ≤ 4, extend → `[[1,5]]`.
- Result `[[1,5]]`.

### Visualization
```
input  ──▶ [ apply Insert Interval step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def merge(intervals):
    intervals.sort(key=lambda x: x[0])
    res = []
    for s, e in intervals:
        if res and s <= res[-1][1]:
            res[-1][1] = max(res[-1][1], e)   # extend last
        else:
            res.append([s, e])
    return res
```

### Complexity
Time O(n log n), Space O(n). Sorting dominates; the sweep is O(n).

## 11. Solved Example 3

### Problem — Range Module (LeetCode 715)
Design a structure over disjoint half-open ranges `[left, right)` supporting `addRange`, `queryRange`, and `removeRange`.

### Thought Process
1. Keep the tracked ranges as a sorted list of disjoint intervals — exactly the Insert-Interval invariant.
2. `addRange` is insert-and-merge: swallow every interval touching `[left,right)` and widen the bounds, just like inserting one interval.
3. `removeRange` is the mirror: split any overlapping interval into the surviving left/right pieces; `queryRange` finds the covering interval by binary search.

### Dry Run
`addRange(10,20)` → ranges `[[10,20]]`.
- `addRange(30,40)` → `[[10,20],[30,40]]`.
- `queryRange(10,19)` → covered by `[10,20]` → True.
- `removeRange(14,16)` → split `[10,20]` into `[10,14],[16,20]` → `[[10,14],[16,20],[30,40]]`.

### Visualization
```
input  ──▶ [ apply Insert Interval step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
import bisect

class RangeModule:
    def __init__(self):
        self.ranges = []  # sorted disjoint [start, end)

    def addRange(self, left, right):
        res, placed = [], False
        for s, e in self.ranges:
            if e < left:            # strictly left
                res.append([s, e])
            elif right < s:         # strictly right
                if not placed:
                    res.append([left, right]); placed = True
                res.append([s, e])
            else:                   # overlap: absorb
                left, right = min(left, s), max(right, e)
        if not placed:
            res.append([left, right])
        self.ranges = res

    def queryRange(self, left, right):
        i = bisect.bisect_right([s for s, _ in self.ranges], left) - 1
        return i >= 0 and self.ranges[i][0] <= left and right <= self.ranges[i][1]

    def removeRange(self, left, right):
        res = []
        for s, e in self.ranges:
            if e <= left or s >= right:
                res.append([s, e])
            else:
                if s < left:
                    res.append([s, left])
                if e > right:
                    res.append([right, e])
        self.ranges = res
```

### Complexity
Time O(n) per add/remove, O(log n) per query; Space O(n) for the stored ranges.


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
