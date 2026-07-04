# 32 · Sweep Line

> **One-liner:** Sort start/end events and sweep a line to track active state.

---

## 1. Overview

### Definition
The **Sweep Line** pattern belongs to the *Intervals* family. Sort start/end events and sweep a line to track active state.

### Intuition
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Why it works
Sort by start (or process start/end events), then sweep once merging or counting overlaps. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Interval logic schedules calendar/meeting systems, allocates cloud resources (min machines for overlapping jobs), reconciles time-series gaps, and powers range-based access control. Sweep-line scales to millions of events with a single ordered pass.

---

## 2. Recognition Signals

### Keywords
sweep line, events, start end, skyline, scan.

### Constraints
- Input size where the brute-force complexity would time out — the Sweep Line optimization is the intended solution.
- Structural hints in the statement that match this family (Intervals).

### Hidden clues
- The problem can be reframed so the Sweep Line invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Sweep Line is the upgrade.
- The wording maps onto: sweep line, events, start end, skyline, scan.

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
Redundant recomputation; does not exploit the structure the Sweep Line pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Sweep Line invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="swp32" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Split each interval into +1 start &amp; −1 end events, then sweep</text>
  <rect x="112" y="34" width="208" height="18" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="216" y="47" text-anchor="middle" fill="#1e293b">[1,5]</text>
  <rect x="164" y="56" width="208" height="18" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="268" y="69" text-anchor="middle" fill="#1e293b">[2,6]</text>
  <rect x="476" y="34" width="104" height="18" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="528" y="47" text-anchor="middle" fill="#1e293b">[8,10]</text>
  <g text-anchor="middle" font-size="11">
    <path d="M112,96 l6,10 l-12,0 Z" fill="#059669"/><text x="112" y="120" fill="#059669">+1</text>
    <path d="M164,96 l6,10 l-12,0 Z" fill="#059669"/><text x="164" y="120" fill="#059669">+1</text>
    <path d="M320,106 l6,-10 l-12,0 Z" fill="#d97706"/><text x="320" y="120" fill="#d97706">−1</text>
    <path d="M372,106 l6,-10 l-12,0 Z" fill="#d97706"/><text x="372" y="120" fill="#d97706">−1</text>
    <path d="M476,96 l6,10 l-12,0 Z" fill="#059669"/><text x="476" y="120" fill="#059669">+1</text>
    <path d="M580,106 l6,-10 l-12,0 Z" fill="#d97706"/><text x="580" y="120" fill="#d97706">−1</text>
  </g>
  <line x1="60" y1="184" x2="600" y2="184" stroke="#cbd5e1"/>
  <text x="30" y="150" fill="#64748b">count</text>
  <polyline points="60,184 112,184 112,162 164,162 164,140 320,140 320,162 372,162 372,184 476,184 476,162 580,162 580,184" fill="none" stroke="#059669" stroke-width="2"/>
  <line x1="130" y1="140" x2="130" y2="128" stroke="#059669"/><text x="150" y="132" fill="#059669" font-weight="700">peak = 2</text>
  <g fill="#64748b" text-anchor="middle" font-size="11">
    <text x="112" y="200">1</text><text x="164" y="200">2</text><text x="320" y="200">5</text>
    <text x="372" y="200">6</text><text x="476" y="200">8</text><text x="580" y="200">10</text>
  </g>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Sweep Line        : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Sweep Line problem. I'll sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps. That brings the complexity down to O(n log n) time and O(n) space — here's the template."

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

| Metric | Brute Force | Sweep Line (Optimal) |
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

### Problem — Skyline (LeetCode 218)
Given buildings as `[left, right, height]`, return the skyline as a list of key points `[x, height]` where the visible height changes.

### Thought Process
1. Turn each building into two events: a start `(left, -height)` and an end `(right, +height)`; sort events (starts before ends at equal x, taller starts first via the negative height).
2. Sweep x left to right maintaining a multiset of active heights (a max-heap with lazy deletion).
3. Whenever the current max height changes after processing an event's x, emit a key point.

### Dry Run
Buildings `[[2,9,10],[3,7,15]]`.
- Events sorted: `(2,-10),(3,-15),(7,15),(9,10)`.
- x=2: add 10, max 0→10 → emit `[2,10]`.
- x=3: add 15, max 10→15 → emit `[3,15]`.
- x=7: remove 15, max 15→10 → emit `[7,10]`.
- x=9: remove 10, max 10→0 → emit `[9,0]`.

### Visualization
```
input  ──▶ [ apply Sweep Line step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
import heapq

def getSkyline(buildings):
    events = []
    for l, r, h in buildings:
        events.append((l, -h))   # start: negative height
        events.append((r, h))    # end: positive height
    events.sort()
    res = []
    heap = [0]                   # max-heap via negation
    active = {0: 1}
    prev = 0
    for x, h in events:
        if h < 0:                # building starts
            heapq.heappush(heap, h)
            active[-h] = active.get(-h, 0) + 1
        else:                    # building ends
            active[h] -= 1
        while active.get(-heap[0], 0) == 0:  # lazy delete
            heapq.heappop(heap)
        cur = -heap[0]
        if cur != prev:
            res.append([x, cur])
            prev = cur
    return res
```

### Complexity
Time O(n log n), Space O(n). Sorting events plus heap operations per event.

## 10. Solved Example 2

### Problem — Meeting Rooms II (LeetCode 253)
Given meeting intervals, find the minimum number of rooms needed — solved here with a pure event sweep.

### Thought Process
1. Split each meeting into a `+1` start event and a `-1` end event on the timeline.
2. Sort all events by time; at equal time, process ends before starts so a room freed exactly at another's start is reused.
3. Sweep left to right accumulating the running count of concurrent meetings; the peak is the answer.

### Dry Run
Input `[[0,30],[5,10],[15,20]]`.
- Events: `(0,+1),(5,+1),(10,-1),(15,+1),(20,-1),(30,-1)`.
- Sweep count: 0→1 (at 0), →2 (at 5), →1 (at 10), →2 (at 15), →1 (at 20), →0 (at 30).
- Peak = 2 rooms.

### Visualization
```
input  ──▶ [ apply Sweep Line step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def minMeetingRooms(intervals):
    events = []
    for s, e in intervals:
        events.append((s, 1))    # meeting starts
        events.append((e, -1))   # meeting ends
    events.sort(key=lambda x: (x[0], x[1]))  # end (-1) before start (+1)
    cur = best = 0
    for _, delta in events:
        cur += delta
        best = max(best, cur)
    return best
```

### Complexity
Time O(n log n), Space O(n). Sorting the 2n events dominates the linear sweep.

## 11. Solved Example 3

### Problem — Flight Bookings (LeetCode 1109)
Given bookings `[first, last, seats]` over `n` flights (1-indexed), return the total seats reserved on each flight.

### Thought Process
1. Each booking adds `seats` to a contiguous range of flights — a range-update, point-query task, ideal for a difference array.
2. For booking `[first, last, seats]`, do `diff[first-1] += seats` and `diff[last] -= seats`.
3. A prefix sum over the difference array reconstructs each flight's total.

### Dry Run
`bookings=[[1,2,10],[2,3,20]]`, `n=3`.
- diff (size 4): +10 at 0, -10 at 2; +20 at 1, -20 at 3 → `[10,20,-10,-20]`.
- Prefix over first n: 10, 10+20=30, 30-10=20.
- Answer `[10,30,20]`.

### Visualization
```
input  ──▶ [ apply Sweep Line step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def corpFlightBookings(bookings, n):
    diff = [0] * (n + 1)
    for first, last, seats in bookings:
        diff[first - 1] += seats
        diff[last] -= seats
    res, running = [], 0
    for i in range(n):
        running += diff[i]
        res.append(running)
    return res
```

### Complexity
Time O(n + m) for m bookings, Space O(n) for the difference array.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 218 | Skyline | Easy | Core intervals application |
| 253 | Meeting Rooms II | Easy | Core intervals application |
| 1109 | Flight Bookings | Medium | Core intervals application |
| 850 | Rectangle Area | Medium | Core intervals application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Sweep Line logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Sweep Line (Intervals).
- **Signal:** sweep line, events, start end, skyline, scan.
- **Move:** Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.
- **Cost:** O(n log n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Sweep Line invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Sweep Line
FAMILY : Intervals (Advanced)
WHEN   : sweep line, events, start end, skyline, scan
DO     : Sorting linearizes the geometry so a single left-to-right sweep resolves all ove
TIME   : O(n log n)    SPACE: O(n)
PRACTICE: 218, 253, 1109, 850
```

---

*Part of the DSA Patterns Handbook — pattern 32 of 100.*
