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

**The question this pattern keeps answering:** *"What does the world look like at every moment — given a pile of things that each exist over a range?"*

### Intuition
Pick every point in time (or space) and ask what is active there.

### Algorithm
1. Collect every coordinate that could matter.
2. For each such coordinate `x`:
3. &nbsp;&nbsp;Scan **all** `n` intervals and test whether they cover `x`.
4. &nbsp;&nbsp;Compute the answer at `x` (count, max height, total, …).
5. Stitch the per-coordinate answers together.

### Complexity
- Time: **O(n²)** with `2n` interesting coordinates — worse if you sample every unit of time.
- Space: O(n).

### Drawbacks
- Between two consecutive events **nothing changes**. Re-deriving the state at each coordinate from scratch recomputes a fact that only changed in one small way.
- Sampling every unit of time is worse still: with coordinates up to 10⁹ it is impossible, and it silently assumes the coordinates are integers and dense.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Drag an imaginary vertical line left to right. It only needs to stop where something starts or stops — and at each stop you update the state instead of rebuilding it.**

That is the whole pattern, and it has exactly three parts:

```text
1. EVENTS      turn each interval into a start event and an end event
2. ORDER       sort events by coordinate, with a tie-break rule
3. ACTIVE SET  a structure holding what is currently "live",
               updated by +1 / -1 (or insert / remove) at each event
```

Everything else is a choice of what the active set *is*.

### The thought process

```text
We need    : a per-position answer over many overlapping ranges.
Obvious way: for each position, scan every range.
Too slow   : O(n^2), and it recomputes unchanged state.
Notice     : the state only changes at the 2n endpoints.
             Everywhere else it is constant.
Therefore  : sort the 2n events and sweep, maintaining the state
             incrementally.
Now        : O(n log n) — the sort dominates.
```

### Choosing the active set

This is the only real decision, and it follows directly from the question:

| The question is… | Active set | Cost per event |
|---|---|---|
| "how many are active?" | an integer counter | O(1) |
| "what is the tallest active?" | max-heap / multiset | O(log n) |
| "which ones are active?" | ordered set | O(log n) |
| "total covered length?" | counter + last coordinate | O(1) |

Meeting Rooms II wants a count → counter. The Skyline wants the tallest → heap.

### The tie-break rule is where correctness lives

When two events share a coordinate, the order you process them in changes the answer. There is no universal rule — it depends on what the problem means by "touching".

```text
counting overlaps (meetings):   process ENDS first
    → [0,10] and [10,20] need one room, not two

skyline outlines:               process STARTS first, tallest first
    → a taller building beginning exactly where another ends
      produces one clean step, not a spurious drop to 0 and back
```

Get this wrong and the code still runs, still looks right, and is wrong only on the boundary cases the tests care about. **Decide the rule explicitly, then encode it in the comparator.**

For the skyline the comparator is worth spelling out. Encoding a start as `−height` and an end as `0`, then sorting by `(x, key)` ascending gives all three rules at once:

```text
same x:  -15  <  -10  <  0
         ↑taller start  ↑shorter start  ↑ends
```

Starts sort before ends (negative before zero), and among starts the taller comes first — exactly what avoids a phantom notch.

### Steps

```text
Step 1 → Build 2 events per interval: (start, +) and (end, -).
Step 2 → Sort by coordinate, applying the tie-break rule.
Step 3 → active = empty
Step 4 → For each event in order:
Step 5 →     apply it to `active` (increment / insert / remove)
Step 6 →     read the current answer off `active`
Step 7 →     record it if it differs from the previous one
```

### Coordinate compression, and when you don't need it

When coordinates are huge (up to 10⁹) but few (`n ≤ 10⁵`), sorting the `2n` endpoints *is* the compression — you never touch the empty space between them.

When coordinates are small and dense (locations 0..1000), skip sorting entirely and index a fixed array: that is the **difference array**, the O(1)-bucketing special case of this same idea.

```text
sparse coordinates → sort the events        O(n log n)
dense, bounded     → difference array       O(n + range)
```

### How should I recognize this?

```text
If you see...
  many intervals plus "at any point", "maximum overlap", "outline",
  "merge / union of ranges", "how many are active"
  geometry with rectangles or segments
        ↓
Think about...
  "What are my events, and what does the moving line need to remember?"
        ↓
Use...
  count only        → integer counter
  extremum          → heap or multiset
  small dense range → difference array
  and DECIDE the tie-break rule before writing the comparator
```

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

```text
buildings: [2,9,10]  [3,7,15]

height
 15 |      ┌────┐
 10 |  ┌───┘    └───┐
  0 +──┴─────────────┴──────
     2  3        7   9

events sorted:  (2,start,10) (3,start,15) (7,end) (9,end)
active max   :      10           15         10      0
output       :  [2,10]       [3,15]     [7,10]  [9,0]

the line stops only at 2, 3, 7, 9 — never in between
```

### Interview explanation
"I'll sweep a line across the coordinate axis. Each interval becomes two events — a start and an end — and I sort all `2n` of them. Then I walk through in order maintaining an active set, which for this problem is a `<counter / max-heap>`. Between consecutive events nothing changes, so I only need to recompute at the `2n` stops. The subtle part is the tie-break at equal coordinates: for counting overlaps I process ends first so touching intervals share a resource, but for the skyline I process starts first and taller-first, so a taller building starting where another ends produces one clean step. That's O(n log n) for the sort and O(n log n) overall."

---

## 5. Generic Templates

> Events → sort with an explicit tie-break → maintain the active set.

```go
// SweepEvent is one endpoint of one interval.
type SweepEvent struct {
    X     int // coordinate where the change happens
    Delta int // +1 when an interval starts, -1 when it ends
}

// MaxOverlap returns the largest number of intervals active at once.
// Ends are processed before starts at equal coordinates, so intervals
// that merely touch do not count as overlapping.
func MaxOverlap(intervals [][]int) int {
    events := make([]SweepEvent, 0, len(intervals)*2)
    for _, iv := range intervals {
        events = append(events, SweepEvent{X: iv[0], Delta: +1})
        events = append(events, SweepEvent{X: iv[1], Delta: -1})
    }

    sort.Slice(events, func(i, j int) bool {
        if events[i].X != events[j].X {
            return events[i].X < events[j].X
        }
        // Tie-break: -1 sorts before +1, so ends are applied first.
        return events[i].Delta < events[j].Delta
    })

    active, best := 0, 0
    for _, e := range events {
        active += e.Delta
        if active > best {
            best = active
        }
    }
    return best
}

// CoveredLength returns the total length covered by the union of the
// intervals, counting overlapping regions only once.
func CoveredLength(intervals [][]int) int {
    events := make([]SweepEvent, 0, len(intervals)*2)
    for _, iv := range intervals {
        events = append(events, SweepEvent{X: iv[0], Delta: +1})
        events = append(events, SweepEvent{X: iv[1], Delta: -1})
    }
    sort.Slice(events, func(i, j int) bool {
        if events[i].X != events[j].X {
            return events[i].X < events[j].X
        }
        return events[i].Delta < events[j].Delta
    })

    total, active, lastX := 0, 0, 0
    for _, e := range events {
        // Anything covered since the previous event counts once.
        if active > 0 {
            total += e.X - lastX
        }
        active += e.Delta
        lastX = e.X
    }
    return total
}
```

```python
def max_overlap(intervals):
    """Largest number of intervals active at once. Ends win ties."""
    events = []
    for start, end in intervals:
        events.append((start, +1))
        events.append((end, -1))
    # (x, delta): -1 sorts before +1, so ends are applied first.
    events.sort()

    active = best = 0
    for _, delta in events:
        active += delta
        best = max(best, active)
    return best

def covered_length(intervals):
    """Total length of the union, counting overlaps once."""
    events = []
    for start, end in intervals:
        events.append((start, +1))
        events.append((end, -1))
    events.sort()

    total = active = 0
    last_x = 0
    for x, delta in events:
        if active > 0:                 # covered since the previous event
            total += x - last_x
        active += delta
        last_x = x
    return total
```

```java
import java.util.*;

public class SweepLine {
    // Largest number of intervals active at once. Ends win ties.
    public static int maxOverlap(int[][] intervals) {
        int[][] events = new int[intervals.length * 2][2];
        int k = 0;
        for (int[] iv : intervals) {
            events[k++] = new int[]{iv[0], +1};
            events[k++] = new int[]{iv[1], -1};
        }
        Arrays.sort(events, (a, b) ->
            a[0] != b[0] ? Integer.compare(a[0], b[0])
                         : Integer.compare(a[1], b[1]));  // -1 before +1

        int active = 0, best = 0;
        for (int[] e : events) {
            active += e[1];
            best = Math.max(best, active);
        }
        return best;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

// Largest number of intervals active at once. Ends win ties.
int maxOverlap(const vector<vector<int>>& intervals) {
    vector<pair<int, int>> events;               // (coordinate, delta)
    events.reserve(intervals.size() * 2);
    for (const auto& iv : intervals) {
        events.emplace_back(iv[0], +1);
        events.emplace_back(iv[1], -1);
    }
    // Default pair ordering puts -1 before +1 at equal coordinates.
    sort(events.begin(), events.end());

    int active = 0, best = 0;
    for (const auto& [x, delta] : events) {
        active += delta;
        best = max(best, active);
    }
    return best;
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

### Problem — The Skyline Problem (LeetCode 218)
Each building is `[left, right, height]`. Return the skyline as a list of "key points" `[x, height]` — the left endpoint of every horizontal segment of the outline.

### Thought Process
1. The outline only changes where a building **starts** or **ends**, so sweep over those `2n` coordinates.
2. At any position, the skyline height is the **tallest currently active building** — so the active set is a max-heap of heights.
3. A heap can't remove an arbitrary building when it ends. The fix: store `(height, rightEdge)` and **lazily discard** anything at the top whose `rightEdge <= x`. It only matters that the *top* is valid.
4. Push a sentinel `(height 0, right ∞)` so the heap is never empty and ground level is always available.
5. After processing each coordinate, compare the current max height with the previous one. Record a key point only when it **changes** — that is what makes consecutive equal heights collapse into one segment.

**The tie-break, encoded:** represent a start as `−height` and an end as `0`, then sort by `(x, key)`:

```text
same x:   -15   <   -10   <   0
        taller start  shorter start  end
```

Starts come before ends (negative before zero), and taller starts come first. That prevents a phantom drop to ground when one building begins exactly where another ends.

### Dry Run

Input: `buildings = [[2,9,10], [3,7,15]]`

**Events** — `(x, key, right)` where a start uses `key = −height`:

| x | key | right | meaning |
|---|-----|-------|---------|
| 2 | −10 | 9  | building A starts, height 10 |
| 3 | −15 | 7  | building B starts, height 15 |
| 7 | 0   | —  | something ends here |
| 9 | 0   | —  | something ends here |

**Sweep** (heap shown as heights with their right edges; ground `0@∞` always present):

| x | pop stale (`right <= x`) | push | heap after | max height | changed? | output |
|---|--------------------------|------|------------|------------|----------|--------|
| 2 | — | `10@9` | `{10@9, 0@∞}` | 10 | 0 → 10 | **`[2,10]`** |
| 3 | — | `15@7` | `{15@7, 10@9, 0@∞}` | 15 | 10 → 15 | **`[3,15]`** |
| 7 | `15@7` (`7 <= 7`) | — | `{10@9, 0@∞}` | 10 | 15 → 10 | **`[7,10]`** |
| 9 | `10@9` (`9 <= 9`) | — | `{0@∞}` | 0 | 10 → 0 | **`[9,0]`** |

Output: **`[[2,10], [3,15], [7,10], [9,0]]`** ✓

Read it back as a picture: rise to 10 at x=2, rise to 15 at x=3, fall back to 10 at x=7 when the tall building ends, fall to ground at x=9.

### Visualization

```text
height
 15 |      ┌────┐
 10 |  ┌───┘    └───┐
  0 +──┴─────────────┴────────
     2  3        7   9

  x=2  ▲ 10   new max      → [2,10]
  x=3  ▲ 15   new max      → [3,15]
  x=7  ▼ 10   15 expired   → [7,10]
  x=9  ▼  0   10 expired   → [9,0]
```

### Code

```go
// live is one building still under the sweep line.
type live struct {
    negHeight int // negative so the min-heap behaves as a max-heap on height
    right     int // where this building ends
}

type liveHeap []live

func (h liveHeap) Len() int           { return len(h) }
func (h liveHeap) Less(i, j int) bool { return h[i].negHeight < h[j].negHeight }
func (h liveHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *liveHeap) Push(x any)        { *h = append(*h, x.(live)) }
func (h *liveHeap) Pop() any {
    old := *h
    n := len(old)
    last := old[n-1]
    *h = old[:n-1]
    return last
}

func getSkyline(buildings [][]int) [][]int {
    type event struct{ x, key, right int } // key: -height for a start, 0 for an end

    events := make([]event, 0, len(buildings)*2)
    for _, b := range buildings {
        left, right, height := b[0], b[1], b[2]
        events = append(events, event{x: left, key: -height, right: right})
        events = append(events, event{x: right, key: 0, right: 0})
    }

    // Sort by x; at equal x, starts (negative key) before ends (key 0),
    // and among starts the taller one first.
    sort.Slice(events, func(i, j int) bool {
        if events[i].x != events[j].x {
            return events[i].x < events[j].x
        }
        return events[i].key < events[j].key
    })

    active := &liveHeap{{negHeight: 0, right: math.MaxInt32}} // ground level
    heap.Init(active)

    result := [][]int{}
    previousHeight := 0

    for _, e := range events {
        // Lazy deletion: only the top has to be valid.
        for (*active)[0].right <= e.x {
            heap.Pop(active)
        }
        if e.key != 0 { // a start event joins the active set
            heap.Push(active, live{negHeight: e.key, right: e.right})
        }

        currentHeight := -(*active)[0].negHeight
        if currentHeight != previousHeight { // record only real changes
            result = append(result, []int{e.x, currentHeight})
            previousHeight = currentHeight
        }
    }
    return result
}
```

```python
import heapq

def getSkyline(buildings):
    # key: -height for a start, 0 for an end.
    events = []
    for left, right, height in buildings:
        events.append((left, -height, right))
        events.append((right, 0, 0))
    # Starts before ends at equal x; taller starts first.
    events.sort()

    active = [(0, float("inf"))]        # (-height, right); ground level sentinel
    result = []
    previous_height = 0

    for x, key, right in events:
        while active[0][1] <= x:        # lazy deletion: only the top must be valid
            heapq.heappop(active)
        if key != 0:
            heapq.heappush(active, (key, right))

        current_height = -active[0][0]
        if current_height != previous_height:   # record only real changes
            result.append([x, current_height])
            previous_height = current_height

    return result
```

### Complexity
Time **O(n log n)** — sorting `2n` events, each with at most one heap push and one pop. Space O(n).

---

## 10. Solved Example 2

### Problem — Meeting Rooms II (LeetCode 253)
Return the minimum number of conference rooms required.

### Thought Process
1. The answer is the peak number of simultaneously active meetings — a pure **count**, so the active set is just an integer.
2. Turn each meeting into `+1` at its start and `−1` at its end.
3. Sort the events. **Tie-break: ends before starts**, so a meeting finishing exactly when another begins hands over its room instead of forcing a second one.
4. Sweep, tracking the running count and its maximum.
5. No heap needed — this is the cheapest possible active set.

### Dry Run

Input: `intervals = [[0,30], [5,10], [15,20]]`

**Events**, sorted by `(x, delta)` so `−1` precedes `+1` at equal `x`:

| x | delta | active after | peak |
|---|-------|--------------|------|
| 0  | +1 | 1 | 1 |
| 5  | +1 | **2** | **2** |
| 10 | −1 | 1 | 2 |
| 15 | +1 | 2 | 2 |
| 20 | −1 | 1 | 2 |
| 30 | −1 | 0 | 2 |

Output: **2**

**The tie-break, demonstrated** on `[[0,10], [10,20]]`:

| x | delta | active | note |
|---|-------|--------|------|
| 0  | +1 | 1 | |
| 10 | **−1** | 0 | end processed first — the room is released |
| 10 | +1 | 1 | the next meeting takes the same room |
| 20 | −1 | 0 | |

Peak = **1** ✓. Had starts been processed first, the peak would read 2 and we'd book a room that nobody needs.

### Visualization

```text
time :  0    5    10   15   20        30
        │    │    │    │    │         │
delta: +1   +1   -1   +1   -1        -1
count:  1    2    1    2    1         0
             ↑
        peak = 2  →  two rooms
```

### Code

```go
func minMeetingRoomsSweep(intervals [][]int) int {
    type event struct{ x, delta int }

    events := make([]event, 0, len(intervals)*2)
    for _, iv := range intervals {
        events = append(events, event{x: iv[0], delta: +1})
        events = append(events, event{x: iv[1], delta: -1})
    }

    // Ends before starts at the same coordinate: touching meetings share a room.
    sort.Slice(events, func(i, j int) bool {
        if events[i].x != events[j].x {
            return events[i].x < events[j].x
        }
        return events[i].delta < events[j].delta
    })

    active, rooms := 0, 0
    for _, e := range events {
        active += e.delta
        if active > rooms {
            rooms = active
        }
    }
    return rooms
}
```

```python
def minMeetingRooms(intervals):
    events = []
    for start, end in intervals:
        events.append((start, +1))
        events.append((end, -1))
    # (x, delta): -1 sorts before +1, so touching meetings share a room.
    events.sort()

    active = rooms = 0
    for _, delta in events:
        active += delta
        rooms = max(rooms, active)
    return rooms
```

### Complexity
Time O(n log n) for the sort, O(n) for the sweep. Space O(n) for the events.

> The Meeting Rooms chapter solves this with a min-heap of end times instead. Both are O(n log n); the sweep is simpler when you only need the count, the heap is better when you must know *which* room each meeting got.

---

## 11. Solved Example 3

### Problem — Corporate Flight Bookings (LeetCode 1109)
Flights are numbered `1..n`. Each booking `[first, last, seats]` reserves `seats` on every flight from `first` to `last` inclusive. Return the total seats booked per flight.

### Thought Process
1. Same events idea, but here the coordinates are **small and dense** — flights `1..n` with `n` given directly.
2. So we don't need to sort anything: index a fixed array by flight number. That is the **difference array**, the O(1)-bucketing form of a sweep.
3. Booking `[first, last, seats]` becomes `+seats` at index `first−1` and `−seats` at index `last` (converting 1-based flights to 0-based indices; the two `−1`s cancel on the end marker).
4. One prefix-sum pass over the deltas reconstructs the per-flight totals.
5. O(n + m) beats the O(m log m) sort you'd pay for a general sweep.

### Dry Run

Input: `bookings = [[1,2,10], [2,3,20]]`, `n = 3` → `delta` has `n+1 = 4` slots

| booking    | writes                            | delta after            |
|------------|-----------------------------------|------------------------|
| `[1,2,10]` | `delta[0] += 10`, `delta[2] -= 10` | `[10, 0, −10, 0]`     |
| `[2,3,20]` | `delta[1] += 20`, `delta[3] -= 20` | `[10, 20, −10, −20]`  |

**Prefix-sum sweep:**

| flight | index | delta | running total |
|--------|-------|-------|---------------|
| 1 | 0 | 10  | 10 |
| 2 | 1 | 20  | 30 |
| 3 | 2 | −10 | 20 |

Output: **`[10, 30, 20]`** ✓

Check flight 2: it is covered by both bookings, so `10 + 20 = 30`. ✓

### Visualization

```text
flight :    1      2      3
b1     : [-- 10 --]
b2     :        [-- 20 --]
         ────────────────────
total  :   10     30     20

delta  :  +10   +20   -10   (-20)
running:   10    30    20
```

### Code

```go
func corpFlightBookings(bookings [][]int, n int) []int {
    // delta[i] = net change entering flight index i.
    delta := make([]int, n+1)

    for _, b := range bookings {
        first, last, seats := b[0], b[1], b[2]
        delta[first-1] += seats // flight `first` is index first-1
        delta[last] -= seats    // stop after flight `last` (index last-1)
    }

    answer := make([]int, n)
    running := 0
    for i := 0; i < n; i++ {
        running += delta[i]
        answer[i] = running
    }
    return answer
}
```

```python
def corpFlightBookings(bookings, n):
    delta = [0] * (n + 1)
    for first, last, seats in bookings:
        delta[first - 1] += seats      # flight `first` is index first-1
        delta[last] -= seats           # stop after flight `last`

    answer, running = [], 0
    for i in range(n):
        running += delta[i]
        answer.append(running)
    return answer
```

### Complexity
Time **O(n + m)** for `m` bookings — no sorting at all. Space O(n).

> This is the decision rule for the whole pattern: **sparse coordinates → sort events; dense bounded coordinates → difference array.** Same idea, different bucketing cost.

---

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
