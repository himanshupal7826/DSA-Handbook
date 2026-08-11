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

**The question this pattern keeps answering:** *"How many things are happening at the same time — and what is the busiest moment?"*

### Intuition
Compare every meeting against every other one to see if they clash.

### Algorithm
1. For each pair `(i, j)` with `i < j`:
2. &nbsp;&nbsp;They overlap if `start[i] < end[j]` **and** `start[j] < end[i]`.
3. For "can I attend all?", return `false` on the first clash.
4. For "how many rooms?", the pairwise view doesn't even answer the question — you would have to check, for every candidate instant, how many meetings cover it.

### Complexity
- Time: **O(n²)** for the pairwise check; worse if you sample time instants.
- Space: O(1).

### Drawbacks
- Most pairs are nowhere near each other in time, and we compare them anyway.
- The room-count version is the real problem: the *maximum simultaneous overlap* is a global property, and no amount of pairwise checking assembles it directly.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Stop thinking about intervals. Think about a timeline of arrivals and departures, processed in time order.**

A meeting is not one thing — it is two **events**: someone walks in, and later someone walks out. Sort all events by time, walk through them, and keep a counter:

```text
+1 when a meeting starts
-1 when a meeting ends
```

The counter is the number of rooms in use *right now*. Its maximum over the whole timeline is the answer.

### The thought process

```text
We need    : the maximum number of overlapping intervals.
Obvious way: compare all pairs.
Doesn't work: overlap is a global count, not a pairwise fact.
Notice     : the count only changes at a start or an end.
             Between events, nothing happens.
Therefore  : sort the events by time and sweep, tracking a
             running counter of "currently active".
Now        : O(n log n) for the sort, O(n) for the sweep.
```

### Two equivalent implementations

**A. Event sweep** — split starts and ends into two sorted arrays and merge-walk them.

```text
starts: 0   5  15
ends  : 10 20  30

pointer into each; whichever time is smaller happens next
start → count++,  end → count--
```

**B. Min-heap of end times** — sort meetings by start; the heap holds the end times of meetings still running.

```text
for each meeting in start order:
    if the earliest end <= this start → that room is free → reuse it (pop)
    push this meeting's end
    rooms = max(rooms, heap size)
```

Both are O(n log n). Use the heap when you need to know *which* room; use the sweep when you only need the count.

### The tie-break rule that decides correctness

When a meeting **ends at exactly the moment** another **starts**, do they need two rooms?

For meetings, no — `[0,10]` and `[10,20]` share a room, because the interval is half-open in spirit: you leave at 10, the next person arrives at 10.

So when a start and an end land on the same timestamp, **process the end first**:

```text
process ends before starts at equal times  →  [0,10] and [10,20] need 1 room  ✓
process starts before ends at equal times  →  they would need 2 rooms         ✗
```

In the two-array sweep this falls out of using `<=`:

```go
if starts[i] < ends[j] { count++ } else { count-- }   // ties take the `else` → end first
```

In the heap version it falls out of `heap[0] <= start` (not `<`).

If a problem *does* treat endpoints as closed — "the lecture hall must be empty before the next class" — flip the comparison. Always ask which convention the problem wants.

### Steps (minimum rooms, heap version)

```text
Step 1 → Sort meetings by start time.
Step 2 → Create an empty min-heap of end times.
Step 3 → For each meeting:
Step 4 →     if heap is non-empty and heap.min <= meeting.start:
                 pop  ← that room has freed up
Step 5 →     push meeting.end
Step 6 →     rooms = max(rooms, heap.size())
Step 7 → Return rooms.
```

### How should I recognize this?

```text
If you see...
  "minimum number of rooms / platforms / servers / CPUs"
  "can this person attend all meetings"
  "maximum number of overlapping intervals"
  "how many are active at the busiest moment"
        ↓
Think about...
  "Turn each interval into a +1 event and a -1 event,
   then walk the timeline in order."
        ↓
Use...
  can-attend-all → sort by start, check adjacent pairs
  room count     → event sweep, or a min-heap of end times
  bounded times  → a difference array is even simpler
```

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

```text
meetings: [0,30]  [5,10]  [15,20]

timeline:  0    5    10   15   20        30
           │    │    │    │    │         │
events  : +1   +1   -1   +1   -1        -1
count   :  1    2    1    2    1         0
                ↑
        maximum = 2  →  two rooms needed
```

### Interview explanation
"I'll stop treating each meeting as one object and treat it as two events: a `+1` when it starts and a `−1` when it ends. Sorting all events by time and sweeping gives me a running count of how many meetings are active, and the maximum of that count is the number of rooms. The one subtlety is ties: when a meeting ends exactly when another starts they can share a room, so I process the end event first. That's O(n log n) for the sort and O(n) for the sweep. Equivalently I can sort by start and keep a min-heap of end times, popping whenever the earliest end is at or before the current start — the heap size is the rooms in use."

---

## 5. Generic Templates

> Two events per interval, processed in time order. Ends win ties.

```go
// CanAttendAll reports whether the meetings are pairwise non-overlapping.
func CanAttendAll(intervals [][]int) bool {
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][0] < intervals[b][0]
    })
    for i := 1; i < len(intervals); i++ {
        // Sorted by start, so only the immediate predecessor can clash.
        if intervals[i][0] < intervals[i-1][1] {
            return false
        }
    }
    return true
}

// MinRooms counts the maximum simultaneous overlap via an event sweep.
func MinRooms(intervals [][]int) int {
    starts := make([]int, len(intervals))
    ends := make([]int, len(intervals))
    for i, iv := range intervals {
        starts[i], ends[i] = iv[0], iv[1]
    }
    sort.Ints(starts)
    sort.Ints(ends)

    rooms, best := 0, 0
    i, j := 0, 0
    for i < len(starts) {
        if starts[i] < ends[j] {
            rooms++ // a meeting begins
            i++
            if rooms > best {
                best = rooms
            }
        } else {
            rooms-- // a meeting ends; ties land here, so ends go first
            j++
        }
    }
    return best
}
```

```python
import heapq

def can_attend_all(intervals):
    """True if no two meetings overlap."""
    intervals.sort(key=lambda iv: iv[0])
    for i in range(1, len(intervals)):
        if intervals[i][0] < intervals[i - 1][1]:   # only the predecessor can clash
            return False
    return True

def min_rooms(intervals):
    """Maximum simultaneous overlap, via an event sweep."""
    starts = sorted(iv[0] for iv in intervals)
    ends = sorted(iv[1] for iv in intervals)

    rooms = best = 0
    i = j = 0
    while i < len(starts):
        if starts[i] < ends[j]:
            rooms += 1                    # a meeting begins
            i += 1
            best = max(best, rooms)
        else:
            rooms -= 1                    # a meeting ends; ties come here
            j += 1
    return best

def min_rooms_heap(intervals):
    """Same answer, min-heap of end times. Heap size = rooms in use."""
    intervals.sort(key=lambda iv: iv[0])
    ends = []                             # min-heap of end times
    for start, end in intervals:
        if ends and ends[0] <= start:     # <= : ending exactly now frees the room
            heapq.heappop(ends)
        heapq.heappush(ends, end)
    return len(ends)
```

```java
import java.util.*;

public class MeetingRooms {
    public static boolean canAttendAll(int[][] intervals) {
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
        for (int i = 1; i < intervals.length; i++)
            if (intervals[i][0] < intervals[i - 1][1]) return false;
        return true;
    }

    // Min-heap of end times: the heap size is the rooms in use.
    public static int minRooms(int[][] intervals) {
        if (intervals.length == 0) return 0;
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));

        PriorityQueue<Integer> ends = new PriorityQueue<>();
        for (int[] iv : intervals) {
            if (!ends.isEmpty() && ends.peek() <= iv[0]) ends.poll();  // room freed
            ends.add(iv[1]);
        }
        return ends.size();
    }
}
```

```cpp
#include <algorithm>
#include <queue>
#include <vector>
using namespace std;

bool canAttendAll(vector<vector<int>> intervals) {
    sort(intervals.begin(), intervals.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[0] < b[0]; });
    for (size_t i = 1; i < intervals.size(); ++i)
        if (intervals[i][0] < intervals[i - 1][1]) return false;
    return true;
}

// Min-heap of end times: the heap size is the rooms in use.
int minRooms(vector<vector<int>> intervals) {
    sort(intervals.begin(), intervals.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[0] < b[0]; });

    priority_queue<int, vector<int>, greater<int>> ends;
    for (const auto& iv : intervals) {
        if (!ends.empty() && ends.top() <= iv[0]) ends.pop();   // room freed
        ends.push(iv[1]);
    }
    return (int)ends.size();
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
Given meeting intervals, determine whether a person could attend **all** of them.

### Thought Process
1. "Attend all" means no two meetings overlap at all.
2. Checking every pair is O(n²) — but after sorting by start time, a meeting can only clash with the one **immediately before it**.
3. Why? Everything earlier starts even sooner; if it doesn't reach the previous meeting's start, it certainly doesn't reach this one's. Sorting reduces a global check to a local one.
4. So: sort by start, then check each adjacent pair.
5. Use `<` not `<=`: a meeting starting exactly when the previous ends is fine.

### Dry Run

Input: `intervals = [[0,30], [5,10], [15,20]]` → sorted by start (already is)

| i | previous | current | `current.start < previous.end`? | verdict |
|---|----------|---------|--------------------------------|---------|
| 1 | `[0,30]` | `[5,10]` | `5 < 30` → **yes** | overlap → return **`false`** |

Output: **`false`** — the 0–30 meeting swallows the 5–10 one.

**A passing case**, `intervals = [[7,10], [2,4]]` → sorted: `[[2,4], [7,10]]`

| i | previous | current | `7 < 4`? | verdict |
|---|----------|---------|----------|---------|
| 1 | `[2,4]` | `[7,10]` | no | no overlap |

Output: **`true`** ✓

**The boundary case**, `[[0,10], [10,20]]`: `10 < 10` is false, so they don't clash — you leave at 10 and arrive at 10. That is the convention this problem uses.

### Visualization

```text
sorted:   0────────────────────────────30
              5────10
                        15────20

          the 5–10 meeting starts at 5, before 30  →  clash  ✗

sorted:   2──4
                 7────10
          7 is not before 4  →  no clash  ✓
```

### Code

```go
func canAttendMeetings(intervals [][]int) bool {
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][0] < intervals[b][0]
    })

    for i := 1; i < len(intervals); i++ {
        // Sorted by start, so only the immediate predecessor can clash.
        // Strict <: starting exactly when the previous ends is fine.
        if intervals[i][0] < intervals[i-1][1] {
            return false
        }
    }
    return true
}
```

```python
def canAttendMeetings(intervals):
    intervals.sort(key=lambda iv: iv[0])
    for i in range(1, len(intervals)):
        # Only the immediate predecessor can clash once sorted.
        # Strict <: starting exactly when the previous ends is fine.
        if intervals[i][0] < intervals[i - 1][1]:
            return False
    return True
```

### Complexity
Time O(n log n) — the sort dominates the O(n) scan. Space O(1) beyond the sort.

---

## 10. Solved Example 2

### Problem — Meeting Rooms II (LeetCode 253)
Return the **minimum number of conference rooms** required.

### Thought Process
1. The answer is the maximum number of meetings active at any one instant.
2. Sort meetings by start time and process them in order. Keep a **min-heap of end times** for the meetings currently occupying rooms.
3. Before placing a meeting, check the heap's smallest end time — the room that frees up soonest. If it is `<= this meeting's start`, that room is available: pop it.
4. Push this meeting's end time (it now occupies a room).
5. The heap **size** is the number of rooms in use, and its maximum is the answer. Since we only ever pop at most one per meeting, the final size *is* the maximum.
6. Why check only the earliest end? If the soonest-freeing room isn't free yet, none of the others are either.

### Dry Run

Input: `intervals = [[0,30], [5,10], [15,20]]` → sorted by start (already is)

| meeting | heap before | earliest end `<= start`? | action | heap after | rooms |
|---------|-------------|---------------------------|--------|------------|-------|
| `[0,30]`  | `[]`      | heap empty | push 30 | `[30]`     | 1 |
| `[5,10]`  | `[30]`    | `30 <= 5`? **no** | need a new room; push 10 | `[10, 30]` | **2** |
| `[15,20]` | `[10,30]` | `10 <= 15`? **yes** | pop 10 (room freed), push 20 | `[20, 30]` | 2 |

Output: **2**

Step 2 is where a room gets added: the 0–30 meeting is still running at time 5, so the 5–10 meeting needs its own room. Step 3 reuses the room the 5–10 meeting vacated at time 10.

### Visualization

```text
room 1:  0━━━━━━━━━━━━━━━━━━━━━━━━━━━━30
room 2:      5━━━10      15━━━20
                         └ reuses the room freed at 10

busiest instant (e.g. t = 6): two meetings active  →  2 rooms
```

### Code

```go
// minEndHeap is a min-heap of meeting end times.
type minEndHeap []int

func (h minEndHeap) Len() int            { return len(h) }
func (h minEndHeap) Less(i, j int) bool  { return h[i] < h[j] }
func (h minEndHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *minEndHeap) Push(x any)         { *h = append(*h, x.(int)) }
func (h *minEndHeap) Pop() any {
    old := *h
    n := len(old)
    last := old[n-1]
    *h = old[:n-1]
    return last
}

func minMeetingRooms(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][0] < intervals[b][0]
    })

    ends := &minEndHeap{} // end times of meetings currently in rooms
    heap.Init(ends)

    for _, iv := range intervals {
        // The soonest-freeing room; if it isn't free, no other room is either.
        // <= : a meeting ending exactly now releases the room.
        if ends.Len() > 0 && (*ends)[0] <= iv[0] {
            heap.Pop(ends)
        }
        heap.Push(ends, iv[1])
    }

    // We pop at most once per meeting, so the final size is the peak.
    return ends.Len()
}
```

```python
import heapq

def minMeetingRooms(intervals):
    if not intervals:
        return 0
    intervals.sort(key=lambda iv: iv[0])

    ends = []                          # min-heap of end times
    for start, end in intervals:
        # Soonest-freeing room; <= means ending exactly now frees it.
        if ends and ends[0] <= start:
            heapq.heappop(ends)
        heapq.heappush(ends, end)

    return len(ends)                   # peak occupancy
```

### Complexity
Time **O(n log n)** — sorting plus at most `n` heap pushes and pops. Space O(n) for the heap.

---

## 11. Solved Example 3

### Problem — Car Pooling (LeetCode 1094)
A car with `capacity` seats drives one direction. Each trip `[numPassengers, from, to]` boards passengers at `from` and drops them at `to`. Return `true` if the car never exceeds capacity.

### Thought Process
1. Same question as Meeting Rooms II — peak simultaneous occupancy — but now we compare it against a fixed limit instead of reporting it.
2. Each trip is two events: `+numPassengers` at `from`, `−numPassengers` at `to`.
3. **Half-open ranges:** passengers leave *at* `to`, so location `to` is already free. The drop event goes at `to`, with no `+1`.
4. Locations are capped at 1000 by the constraints, so instead of sorting events we can index a fixed array directly — a **difference array**, which is the event sweep with O(1) bucketing.
5. Sweep locations in increasing order accumulating occupancy; if it ever exceeds `capacity`, return `false`.

### Dry Run

Input: `trips = [[2,1,5], [3,3,7]]`, `capacity = 4`

**Events:**

| trip | boards | drops |
|------|--------|-------|
| `[2,1,5]` | `+2` at location 1 | `−2` at location 5 |
| `[3,3,7]` | `+3` at location 3 | `−3` at location 7 |

**Sweep by location:**

| location | change | occupancy | ≤ 4? |
|----------|--------|-----------|------|
| 1 | +2 | 2 | yes |
| 2 | 0  | 2 | yes |
| 3 | +3 | **5** | **no → `false`** |

Output: **`false`** — at location 3 the car holds 5 people but seats only 4.

**With `capacity = 5`** the sweep continues: location 5 drops to `5 − 2 = 3`, location 7 drops to `0`, never exceeding 5 → **`true`**. Note the first group leaves at location 5 exactly when nobody is boarding there — that is the half-open convention doing its job.

### Visualization

```text
location:  1   2   3   4   5   6   7
trip1   : [--- 2 passengers ---)          drops at 5
trip2   :         [--- 3 passengers ---)  drops at 7
          ─────────────────────────────
occupied:  2   2   5   5   3   3   0
                   ↑
              5 > capacity 4  →  false
```

### Code

```go
func carPooling(trips [][]int, capacity int) bool {
    const maxLocation = 1001
    // change[i] = net passengers boarding/leaving at location i.
    change := make([]int, maxLocation+1)

    for _, t := range trips {
        num, from, to := t[0], t[1], t[2]
        change[from] += num // board here
        change[to] -= num   // leave here: the range is half-open [from, to)
    }

    occupancy := 0
    for _, delta := range change {
        occupancy += delta
        if occupancy > capacity {
            return false
        }
    }
    return true
}
```

```python
def carPooling(trips, capacity):
    change = [0] * 1002                # locations 0..1000, plus slack
    for num, start, end in trips:
        change[start] += num           # board here
        change[end] -= num             # leave here: half-open [start, end)

    occupancy = 0
    for delta in change:
        occupancy += delta
        if occupancy > capacity:
            return False
    return True
```

### Complexity
Time O(m + maxLocation) for `m` trips, Space O(maxLocation).

> When locations are unbounded, drop the fixed array and sort the events instead — O(m log m). That is the Sweep Line pattern, and the difference array is simply its O(1)-bucketing special case.

---

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
