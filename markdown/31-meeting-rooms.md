# 31 · Meeting Rooms

> **One-liner:** Count maximum concurrent intervals to size resources (rooms/cores).

---

## 1. Overview

### Definition
The **Meeting Rooms** pattern belongs to the *Intervals* family. Count maximum concurrent intervals to size resources (rooms/cores).

### Intuition
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Why it works
Sort by start (or process start/end events), then sweep once merging or counting overlaps. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Interval logic schedules calendar/meeting systems, allocates cloud resources (min machines for overlapping jobs), reconciles time-series gaps, and powers range-based access control. Sweep-line scales to millions of events with a single ordered pass.

---

## 2. Recognition Signals

### Keywords
meeting rooms, min rooms, overlap count, heap, chronological.

### Constraints
- Input size where the brute-force complexity would time out — the Meeting Rooms optimization is the intended solution.
- Structural hints in the statement that match this family (Intervals).

### Hidden clues
- The problem can be reframed so the Meeting Rooms invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Meeting Rooms is the upgrade.
- The wording maps onto: meeting rooms, min rooms, overlap count, heap, chronological.

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
Redundant recomputation; does not exploit the structure the Meeting Rooms pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Meeting Rooms invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="mtg31" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Concurrent meetings → rooms needed = peak overlap</text>
  <rect x="145" y="36" width="85" height="86" fill="#ecfdf5" opacity="0.6"/>
  <rect x="315" y="36" width="85" height="86" fill="#ecfdf5" opacity="0.6"/>
  <rect x="60"  y="40" width="510" height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="315" y="54" text-anchor="middle" fill="#1e293b">[0,30]</text>
  <rect x="145" y="64" width="85"  height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="187" y="78" text-anchor="middle" fill="#1e293b">[5,10]</text>
  <rect x="315" y="88" width="85"  height="20" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="357" y="102" text-anchor="middle" fill="#1e293b">[15,20]</text>
  <line x1="60" y1="128" x2="570" y2="128" stroke="#cbd5e1"/>
  <g fill="#64748b" text-anchor="middle">
    <line x1="60"  y1="124" x2="60"  y2="132" stroke="#94a3b8"/><text x="60"  y="146">0</text>
    <line x1="145" y1="124" x2="145" y2="132" stroke="#94a3b8"/><text x="145" y="146">5</text>
    <line x1="230" y1="124" x2="230" y2="132" stroke="#94a3b8"/><text x="230" y="146">10</text>
    <line x1="315" y1="124" x2="315" y2="132" stroke="#94a3b8"/><text x="315" y="146">15</text>
    <line x1="400" y1="124" x2="400" y2="132" stroke="#94a3b8"/><text x="400" y="146">20</text>
    <line x1="570" y1="124" x2="570" y2="132" stroke="#94a3b8"/><text x="570" y="146">30</text>
  </g>
  <text x="30" y="176" fill="#64748b">rooms</text>
  <g text-anchor="middle" font-weight="700">
    <text x="102" y="176" fill="#64748b">1</text>
    <text x="187" y="176" fill="#059669">2</text>
    <text x="272" y="176" fill="#64748b">1</text>
    <text x="357" y="176" fill="#059669">2</text>
    <text x="485" y="176" fill="#64748b">1</text>
  </g>
  <text x="320" y="204" text-anchor="middle" fill="#059669" font-weight="700">peak = 2 → need 2 rooms</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Meeting Rooms     : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Meeting Rooms problem. I'll sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps. That brings the complexity down to O(n log n) time and O(n) space — here's the template."

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

| Metric | Brute Force | Meeting Rooms (Optimal) |
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

### Problem — Meeting Rooms (LeetCode 252)
Given meeting time intervals, decide whether a person can attend all of them (i.e., no two overlap).

### Thought Process
1. If any two meetings overlap, the person cannot attend all — so we only need to detect a single overlap.
2. Sort by start time; then overlaps can only occur between adjacent meetings.
3. Scan adjacent pairs: if the next meeting starts before the current one ends, return False.

### Dry Run
Input `[[0,30],[5,10],[15,20]]`. Sort by start → same order.
- `[0,30]` then `[5,10]`: 5 < 30 → overlap → return False.
- (If input were `[[7,10],[2,4]]`: sort → `[[2,4],[7,10]]`; 7 ≥ 4, no overlap → True.)

### Visualization
```
input  ──▶ [ apply Meeting Rooms step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def canAttendMeetings(intervals):
    intervals.sort(key=lambda x: x[0])
    for i in range(1, len(intervals)):
        if intervals[i][0] < intervals[i - 1][1]:
            return False
    return True
```

### Complexity
Time O(n log n), Space O(1). Sorting dominates; the adjacent scan is O(n).

## 10. Solved Example 2

### Problem — Meeting Rooms II (LeetCode 253)
Given meeting intervals, return the minimum number of rooms required to hold all meetings.

### Thought Process
1. The answer is the maximum number of meetings running at the same instant.
2. Sort meetings by start; keep a min-heap of end times for rooms currently in use.
3. For each meeting, if the earliest-ending room is free by its start, reuse it (pop); always push the new end. The heap size is the running room count.

### Dry Run
Input `[[0,30],[5,10],[15,20]]`, heap of ends.
- `[0,30]`: heap `[30]` → 1 room.
- `[5,10]`: 5 < 30, no free room → push → `[10,30]` → 2 rooms.
- `[15,20]`: earliest end 10 ≤ 15, reuse → pop 10, push 20 → `[20,30]` → still 2.
- Answer 2.

### Visualization
```
input  ──▶ [ apply Meeting Rooms step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
import heapq

def minMeetingRooms(intervals):
    if not intervals:
        return 0
    intervals.sort(key=lambda x: x[0])
    heap = []  # end times of rooms in use
    for s, e in intervals:
        if heap and heap[0] <= s:
            heapq.heapreplace(heap, e)   # reuse freed room
        else:
            heapq.heappush(heap, e)      # need a new room
    return len(heap)
```

### Complexity
Time O(n log n), Space O(n). Sort plus heap operations per meeting.

## 11. Solved Example 3

### Problem — Car Pooling (LeetCode 1094)
Given trips `[numPassengers, from, to]` and a car capacity, return whether all trips fit without ever exceeding capacity.

### Thought Process
1. This is a max-concurrent-load problem: passengers board at `from` and leave at `to`.
2. Use a difference array over locations: `diff[from] += num`, `diff[to] -= num`.
3. Sweep locations left to right accumulating the running load; if it ever exceeds capacity, return False.

### Dry Run
`trips=[[2,1,5],[3,3,7]]`, `capacity=4`.
- diff: +2 at 1, -2 at 5, +3 at 3, -3 at 7.
- Sweep: at 1 → 2; at 3 → 5 > 4 → return False.
- (Capacity 5 would give running max 5 ≤ 5 → True.)

### Visualization
```
input  ──▶ [ apply Meeting Rooms step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def carPooling(trips, capacity):
    diff = [0] * 1001            # locations 0..1000
    for num, start, end in trips:
        diff[start] += num
        diff[end] -= num
    load = 0
    for delta in diff:
        load += delta
        if load > capacity:
            return False
    return True
```

### Complexity
Time O(n + R) where R is the location range; Space O(R) for the difference array.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 252 | Meeting Rooms | Easy | Core intervals application |
| 253 | Meeting Rooms II | Easy | Core intervals application |
| 1094 | Car Pooling | Medium | Core intervals application |
| 2402 | Meeting III | Medium | Core intervals application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Meeting Rooms logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Meeting Rooms (Intervals).
- **Signal:** meeting rooms, min rooms, overlap count, heap, chronological.
- **Move:** Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.
- **Cost:** O(n log n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Meeting Rooms invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Meeting Rooms
FAMILY : Intervals (Intermediate)
WHEN   : meeting rooms, min rooms, overlap count, heap, chronological
DO     : Sorting linearizes the geometry so a single left-to-right sweep resolves all ove
TIME   : O(n log n)    SPACE: O(n)
PRACTICE: 252, 253, 1094, 2402
```

---

*Part of the DSA Patterns Handbook — pattern 31 of 100.*
