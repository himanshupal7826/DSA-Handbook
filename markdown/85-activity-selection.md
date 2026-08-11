# 85 · Activity Selection

> **One-liner:** Pick earliest-finishing compatible activities to maximize count.

---

## 1. Overview

### Definition
The **Activity Selection** pattern belongs to the *Greedy* family. Pick earliest-finishing compatible activities to maximize count.

### Intuition
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Why it works
Make the locally optimal choice that a proof (exchange argument) shows is globally safe — usually after sorting. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.

---

## 2. Recognition Signals

### Keywords
activity selection, greedy, earliest finish, intervals, scheduling.

### Constraints
- Input size where the brute-force complexity would time out — the Activity Selection optimization is the intended solution.
- Structural hints in the statement that match this family (Greedy).

### Hidden clues
- The problem can be reframed so the Activity Selection invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Activity Selection is the upgrade.
- The wording maps onto: activity selection, greedy, earliest finish, intervals, scheduling.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which activities can I fit in, given they compete for the same resource?"*

### Intuition
Try every subset of activities and keep the largest conflict-free one.

### Algorithm
1. Enumerate all `2ⁿ` subsets.
2. For each, check every pair for overlap.
3. Keep the largest that passes.

### Complexity
- Time: **O(2ⁿ · n²)**.
- Space: O(n).

### Drawbacks
- Unusable past about 20 activities.
- More importantly, it treats the problem as *search* when it is really *decision*. There is a rule that picks the right activity every single time — the interesting question is not how to search faster, but **why that rule is provably correct**.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Repeatedly take the activity that finishes earliest among those still compatible — finishing early leaves the most room for everything after it.**

The rule is trivial to state. This chapter is about **why it is optimal**, and about recognising the cases where it stops being optimal.

### The thought process

```text
We need    : the largest set of non-conflicting activities.
Obvious way: try every subset.
Hopeless   : O(2^n).
Notice     : once an activity is chosen, only its FINISH time constrains
             what can follow. Its start time is history.
Therefore  : always take the activity that finishes earliest.
Now        : O(n log n), dominated by the sort — and provably optimal,
             by the exchange argument below.
```

### The two conditions every greedy needs

A greedy algorithm is correct only if both hold. Naming them turns "does greedy work here?" from a guess into a check.

**1. Greedy-choice property** — *some* optimal solution contains the greedy first choice.

**2. Optimal substructure** — after committing to that choice, the remaining problem is the same problem on a smaller input, and solving it optimally gives an overall optimum.

Activity selection has both. Most greedy failures come from the first one failing.

### Proving the greedy choice: the exchange argument

This is a reusable template, not a one-off trick. Learn the shape and you can apply it to any greedy proof.

```text
1. Let g be the greedy choice (here: the activity finishing earliest).
2. Let S be ANY optimal solution.
3. If g is in S, we are done.
4. Otherwise, let f be the activity in S that finishes earliest.
5. Show that swapping f for g keeps S valid and the same size.
6. Conclude S' = S - {f} + {g} is also optimal, so an optimal
   solution containing the greedy choice exists.
```

**Step 5 for this problem.** Every other activity in `S` starts at or after `f` ends. Since `g` finishes no later than `f` (it finishes earliest of all), everything in `S` also starts at or after `g` ends. So swapping introduces no conflict, and `|S'| = |S|`.

The sentence that carries the whole argument:

> **Once an activity is chosen, only its finish time constrains the future. Its start time is history.**

Minimising the finish time therefore maximises the room left over.

### Why the tempting alternatives fail

Both wrong answers have small counterexamples worth memorising:

```text
EARLIEST START:   [0,10]  [1,2]  [3,4]
                  picking [0,10] first blocks both others → 1
                  optimum is 2

SHORTEST FIRST:   [0,5]  [4,6]  [5,10]
                  the shortest is [4,6]; it blocks BOTH others → 1
                  optimum is 2  ([0,5] and [5,10])
```

Each fails the greedy-choice property: no optimal solution need contain their first pick.

### Where greedy genuinely breaks: weights

Add a value to each activity and ask for maximum **total value** rather than maximum count. The exchange argument collapses immediately — swapping `f` for `g` preserves the *size* of the solution but not its *value*.

```text
[0,10] worth 100
[0,3]  worth 1      earliest-end greedy takes [0,3], [4,6], [7,9]
[4,6]  worth 1      → total value 3
[7,9]  worth 1      optimum is [0,10] alone → value 100
```

**Weighted interval scheduling needs DP**, not greedy: sort by finish time, and for each interval choose between taking it (plus the best solution ending before it starts, found by binary search) and skipping it. That is O(n log n) and is the standard follow-up to this problem.

| Problem | Correct approach |
|---|---|
| Maximum **count** of non-overlapping | greedy by earliest finish — O(n log n) |
| Maximum **total weight** | DP over sorted intervals + binary search — O(n log n) |
| Minimum resources for **all** activities | different question — min-heap of end times |

### Steps

```text
Step 1 → Sort activities by FINISH time, ascending.
Step 2 → count = 0, lastFinish = -infinity
Step 3 → For each activity in that order:
Step 4 →     if activity.start >= lastFinish:
Step 5 →         count++;  lastFinish = activity.finish
Step 6 → Return count (or n - count if asked for removals).
```

### How should I recognize this?

```text
If you see...
  "maximum number of activities / meetings / jobs without overlap"
  "minimum removals to eliminate overlaps"
  "minimum arrows / taps / points to cover every interval"
  each item has a start and an end, competing for one resource
        ↓
Think about...
  "Does the greedy-choice property hold — is there an optimal
   solution containing the earliest-finishing item?"
  "Are the items WEIGHTED? If so, greedy is wrong — use DP."
        ↓
Use...
  unweighted count → sort by FINISH, sweep, take whatever fits
  weighted value   → sort by finish, DP with binary search
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-85" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Sort by finish time, greedily keep each activity that starts after the last kept finish</text>
  <line x1="40" y1="215" x2="600" y2="215" stroke="#475569" marker-end="url(#a-85)"/>
  <text x="605" y="219" fill="#64748b">time</text>
  <text x="40" y="235" text-anchor="middle" fill="#64748b">1</text>
  <text x="180" y="235" text-anchor="middle" fill="#64748b">3</text>
  <text x="320" y="235" text-anchor="middle" fill="#64748b">5</text>
  <text x="460" y="235" text-anchor="middle" fill="#64748b">7</text>
  <text x="530" y="235" text-anchor="middle" fill="#64748b">8</text>
  <!-- kept A 1 to 3 -->
  <rect x="40" y="45" width="140" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="110" y="63" text-anchor="middle" fill="#059669" font-weight="700">A [1,3] KEEP</text>
  <!-- skipped B 2 to 5 overlaps A -->
  <rect x="110" y="79" width="210" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="215" y="97" text-anchor="middle" fill="#d97706">B [2,5] skip (starts 2 &lt; 3)</text>
  <!-- kept C 4 to 7 -->
  <rect x="250" y="113" width="210" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="355" y="131" text-anchor="middle" fill="#059669" font-weight="700">C [4,7] KEEP</text>
  <!-- kept D 8 wide -->
  <rect x="460" y="147" width="120" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="520" y="165" text-anchor="middle" fill="#059669" font-weight="700">D [8,9] KEEP</text>
  <text x="320" y="200" text-anchor="middle" fill="#64748b">picked = 3 — each start ≥ previous kept finish</text>
</svg>
```

```text
activities:  [1,2]  [2,3]  [3,4]  [1,3]

sorted by FINISH:   [1,2]   [2,3]   [1,3]   [3,4]
                    end 2   end 3   end 3   end 4

take [1,2]              lastFinish = 2
[2,3]:  2 >= 2  ✓       take, lastFinish = 3
[1,3]:  1 <  3  ✗       skip — starts before the last one finished
[3,4]:  3 >= 3  ✓       take, lastFinish = 4

kept 3 of 4

  1──2
     2──3
        3──4
  1─────3       ← conflicts with both of the first two
```

### Interview explanation
"The rule is to sort by finish time and greedily take every activity that starts at or after the last one I took. What makes it correct is an exchange argument: take any optimal solution and look at the activity in it that finishes earliest. The globally-earliest-finishing activity finishes no later, so swapping it in cannot introduce a conflict — everything else in that solution already starts after an even later time. The solution stays valid and the same size, so an optimal solution containing the greedy choice exists. The intuition behind it is that once an activity is committed, only its finish time constrains what follows; its start is history. Sorting by start or by duration both fail on small counterexamples. And I'd flag the boundary: if the activities carry **weights** and I need maximum total value, greedy breaks — one long high-value interval can beat three short ones — so that variant needs DP over intervals sorted by finish, with binary search for the last compatible one."

---

## 5. Generic Templates

> Sort by finish, sweep once. If the activities are weighted, switch to DP.

```go
// MaxActivities returns the largest number of mutually non-overlapping
// activities. Touching activities are compatible.
func MaxActivities(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    // Earliest FINISH first — the whole correctness argument rests here.
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][1] < intervals[b][1]
    })

    count := 0
    lastFinish := math.MinInt32
    for _, activity := range intervals {
        if activity[0] >= lastFinish { // starts after the last one finished
            count++
            lastFinish = activity[1]
        }
    }
    return count
}

// SelectedActivities returns the chosen activities, not just how many.
func SelectedActivities(intervals [][]int) [][]int {
    if len(intervals) == 0 {
        return nil
    }
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][1] < intervals[b][1]
    })

    chosen := [][]int{}
    lastFinish := math.MinInt32
    for _, activity := range intervals {
        if activity[0] >= lastFinish {
            chosen = append(chosen, activity)
            lastFinish = activity[1]
        }
    }
    return chosen
}

// MaxWeightedActivities is the DP for the WEIGHTED variant, where greedy
// is provably wrong. intervals[i] = {start, finish, weight}.
func MaxWeightedActivities(intervals [][]int) int {
    n := len(intervals)
    if n == 0 {
        return 0
    }

    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][1] < intervals[b][1]
    })

    finishes := make([]int, n)
    for i := range intervals {
        finishes[i] = intervals[i][1]
    }

    // best[i] = the maximum weight using only the first i intervals.
    best := make([]int, n+1)
    for i := 1; i <= n; i++ {
        start, weight := intervals[i-1][0], intervals[i-1][2]

        // Binary search the last interval that finishes at or before `start`.
        compatible := sort.SearchInts(finishes[:i-1], start+1)

        take := best[compatible] + weight
        skip := best[i-1]
        if take > skip {
            best[i] = take
        } else {
            best[i] = skip
        }
    }
    return best[n]
}
```

```python
def max_activities(intervals):
    """Largest set of mutually non-overlapping activities."""
    if not intervals:
        return 0
    intervals.sort(key=lambda iv: iv[1])        # earliest FINISH first

    count, last_finish = 0, float("-inf")
    for start, finish in intervals:
        if start >= last_finish:                # starts after the last finished
            count += 1
            last_finish = finish
    return count

def selected_activities(intervals):
    """The chosen activities, not just how many."""
    if not intervals:
        return []
    intervals.sort(key=lambda iv: iv[1])

    chosen, last_finish = [], float("-inf")
    for activity in intervals:
        if activity[0] >= last_finish:
            chosen.append(activity)
            last_finish = activity[1]
    return chosen

def max_weighted_activities(intervals):
    """WEIGHTED variant, where greedy is provably wrong.
    intervals[i] = (start, finish, weight)."""
    from bisect import bisect_right
    if not intervals:
        return 0
    intervals.sort(key=lambda iv: iv[1])
    finishes = [iv[1] for iv in intervals]

    best = [0] * (len(intervals) + 1)
    for i in range(1, len(intervals) + 1):
        start, _, weight = intervals[i - 1]
        # Last interval finishing at or before `start`.
        compatible = bisect_right(finishes, start, 0, i - 1)
        best[i] = max(best[i - 1], best[compatible] + weight)
    return best[len(intervals)]
```

```java
import java.util.*;

public class ActivitySelection {
    // Unweighted: greedy by earliest finish.
    public static int maxActivities(int[][] intervals) {
        if (intervals.length == 0) return 0;
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));

        int count = 0;
        long lastFinish = Long.MIN_VALUE;
        for (int[] activity : intervals) {
            if (activity[0] >= lastFinish) {
                count++;
                lastFinish = activity[1];
            }
        }
        return count;
    }

    // Weighted: greedy is WRONG here, so use DP + binary search.
    public static int maxWeightedActivities(int[][] intervals) {
        int n = intervals.length;
        if (n == 0) return 0;
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));

        int[] finishes = new int[n];
        for (int i = 0; i < n; i++) finishes[i] = intervals[i][1];

        int[] best = new int[n + 1];
        for (int i = 1; i <= n; i++) {
            int start = intervals[i - 1][0], weight = intervals[i - 1][2];
            int compatible = upperBound(finishes, i - 1, start);
            best[i] = Math.max(best[i - 1], best[compatible] + weight);
        }
        return best[n];
    }

    // First index in [0, size) whose finish is > target.
    private static int upperBound(int[] finishes, int size, int target) {
        int lo = 0, hi = size;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (finishes[mid] <= target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
}
```

```cpp
#include <algorithm>
#include <climits>
#include <vector>
using namespace std;

// Unweighted: greedy by earliest finish.
int maxActivities(vector<vector<int>> intervals) {
    if (intervals.empty()) return 0;
    sort(intervals.begin(), intervals.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[1] < b[1]; });

    int count = 0;
    long long lastFinish = LLONG_MIN;
    for (const auto& activity : intervals) {
        if (activity[0] >= lastFinish) {
            ++count;
            lastFinish = activity[1];
        }
    }
    return count;
}

// Weighted: greedy is WRONG, so use DP + binary search.
int maxWeightedActivities(vector<vector<int>> intervals) {
    int n = (int)intervals.size();
    if (n == 0) return 0;
    sort(intervals.begin(), intervals.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[1] < b[1]; });

    vector<int> finishes(n);
    for (int i = 0; i < n; ++i) finishes[i] = intervals[i][1];

    vector<int> best(n + 1, 0);
    for (int i = 1; i <= n; ++i) {
        int start = intervals[i - 1][0], weight = intervals[i - 1][2];
        int compatible = int(upper_bound(finishes.begin(),
                                         finishes.begin() + (i - 1), start)
                             - finishes.begin());
        best[i] = max(best[i - 1], best[compatible] + weight);
    }
    return best[n];
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Activity Selection (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n log n)** |
| Time (best)  | — | **O(n log n)** |
| Time (average) | — | **O(n log n)** |
| Space | varies | **O(1)** |

> Sorting dominates; the greedy sweep is O(n).

---

## 7. Common Mistakes

1. Assuming greedy works without proving the exchange argument.
2. Sorting by the wrong key (e.g., start instead of finish time).
3. Ties broken incorrectly, flipping the result.
4. Greedy on a problem that actually needs DP.
5. Not handling the empty / single-element case.
6. Integer overflow in running totals (e.g., gas station).
7. Resetting accumulators at the wrong moment.
8. Off-by-one in reachability (jump game).
9. Forgetting that local optimum ≠ global without the safety proof.
10. Mutating input order when it matters downstream.

---

## 8. Interview Follow-Up Questions

1. **Q: How to know greedy is valid?**
   A: Prove an exchange argument: swapping to the greedy choice never worsens the optimum.

2. **Q: Activity selection key?**
   A: Sort by earliest finish time.

3. **Q: Jump game reachability?**
   A: Track the farthest reachable index.

4. **Q: Jump game II min jumps?**
   A: BFS-like greedy over reach boundaries.

5. **Q: Gas station start?**
   A: Reset start when the running tank goes negative.

6. **Q: Huffman coding?**
   A: Repeatedly merge the two smallest weights (heap).

7. **Q: Greedy vs DP?**
   A: Greedy when local choice is safe; DP when you must compare futures.

8. **Q: Fractional vs 0/1 knapsack?**
   A: Fractional is greedy; 0/1 needs DP.

9. **Q: Min arrows to burst balloons?**
   A: Greedy by end coordinate.

10. **Q: Task scheduling with cooldown?**
   A: Greedy with counts + idle slots, or heap.

11. **Q: Why O(n log n)?**
   A: Sorting dominates the single greedy pass.

12. **Q: Counterexample habit?**
   A: Always try to break greedy with a small case.

13. **Q: Stability of choice?**
   A: Document tie-breaking explicitly.

14. **Q: Interval partitioning (min rooms)?**
   A: Sweep / heap of end times.

15. **Q: Coin change greedy fails when?**
   A: Non-canonical coin systems need DP.

---

## 9. Solved Example 1

### Problem — Non-overlapping Intervals (LeetCode 435)
Return the minimum number of intervals to remove so that the rest do not overlap.

### Thought Process
1. Removing the fewest is keeping the most, so solve the activity-selection problem and subtract: `answer = n − kept`.
2. Sort by **finish** time, then take greedily.
3. Touching is allowed here — `[1,2]` and `[2,3]` do not overlap — so the test is `start >= lastFinish`.
4. The correctness rests on the exchange argument, worked through below.
5. O(n log n) for the sort, O(n) for the sweep.

### Dry Run

Input: `intervals = [[1,2], [2,3], [3,4], [1,3]]`

**Sorted by finish:** `[1,2]` (2), `[2,3]` (3), `[1,3]` (3), `[3,4]` (4)

| interval | start | `start >= lastFinish`? | action | lastFinish | kept |
|----------|-------|------------------------|--------|------------|------|
| `[1,2]` | 1 | `1 >= −∞` yes | keep | 2 | 1 |
| `[2,3]` | 2 | `2 >= 2` yes (touching is fine) | keep | 3 | 2 |
| `[1,3]` | 1 | `1 >= 3` **no** | skip | 3 | 2 |
| `[3,4]` | 3 | `3 >= 3` yes | keep | 4 | **3** |

Kept 3 of 4 → removals = `4 − 3` = **1**

Output: **1** ✓ — dropping `[1,3]` leaves three pairwise non-overlapping intervals.

**The exchange argument on this input.** Suppose some optimal solution does *not* contain `[1,2]`, the earliest-finishing interval. Let `f` be its earliest-finishing member — say `[2,3]`. Every other interval in that solution starts at or after `3`. Since `[1,2]` finishes at `2 ≤ 3`, swapping it in for `[2,3]` keeps every remaining interval compatible, and the count is unchanged. So an optimal solution containing `[1,2]` exists — which is exactly what licenses the greedy to commit to it.

### Visualization

```text
  1──2
     2──3
        3──4
  1─────3          ← starts at 1, before lastFinish 3 → skipped

kept: [1,2] [2,3] [3,4]        removed: 1
```

### Code

```go
func eraseOverlapIntervals(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    // Earliest FINISH first: this ordering is what the exchange
    // argument justifies.
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][1] < intervals[b][1]
    })

    kept := 0
    lastFinish := math.MinInt32
    for _, interval := range intervals {
        // >= : touching intervals do not overlap in this problem.
        if interval[0] >= lastFinish {
            kept++
            lastFinish = interval[1]
        }
    }

    return len(intervals) - kept
}
```

```python
def eraseOverlapIntervals(intervals):
    if not intervals:
        return 0
    intervals.sort(key=lambda iv: iv[1])        # earliest FINISH first

    kept, last_finish = 0, float("-inf")
    for start, finish in intervals:
        if start >= last_finish:                # >= : touching is fine
            kept += 1
            last_finish = finish
    return len(intervals) - kept
```

### Complexity
Time **O(n log n)** — the sort dominates. Space O(1) beyond the sort.

---

## 10. Solved Example 2

### Problem — Minimum Number of Arrows to Burst Balloons (LeetCode 452)
Each balloon spans `[start, end]`. An arrow at `x` bursts every balloon with `start <= x <= end`. Return the minimum number of arrows.

### Thought Process
1. This is the same greedy read as a **covering** problem rather than a selection one — the dual formulation.
2. Each arrow serves one group of mutually overlapping balloons, so the arrow count equals the group count.
3. Sort by end. Fire the first arrow at the **earliest end** — the furthest right you can shoot while still bursting that balloon, which maximises what else it catches.
4. Skip every balloon already burst (`start <= arrowPosition`); the first one that isn't needs a new arrow at *its* end.
5. Here touching **does** count as overlapping — a balloon starting exactly at the arrow is burst — so the comparison is `<=`.

### Dry Run

Input: `points = [[10,16], [2,8], [1,6], [7,12]]`

**Sorted by end:** `[1,6]` (6), `[2,8]` (8), `[7,12]` (12), `[10,16]` (16)

| balloon | start | `start <= arrowPosition`? | action | arrowPosition | arrows |
|---------|-------|---------------------------|--------|---------------|--------|
| `[1,6]` | 1 | — (first) | shoot at its end | **6** | 1 |
| `[2,8]` | 2 | `2 <= 6` yes | already burst → skip | 6 | 1 |
| `[7,12]` | 7 | `7 <= 6` **no** | new arrow at its end | **12** | **2** |
| `[10,16]` | 10 | `10 <= 12` yes | already burst → skip | 12 | 2 |

Output: **2** ✓ — an arrow at `x = 6` bursts `[1,6]` and `[2,8]`; one at `x = 12` bursts `[7,12]` and `[10,16]`.

**Why shoot at the end and not the start?** Shooting `[1,6]` at `x = 1` bursts only that balloon. Shooting at `x = 6` is the rightmost position that still bursts it, so it sweeps up every balloon whose range reaches back that far. This is the same "finishing early leaves the most room" intuition, mirrored: *committing as late as still permitted* catches the most.

### Visualization

```text
      1────────6
        2────────8
              7──────────12
                 10──────────16

arrow ↑ at 6            ↑ at 12
      bursts 2          bursts 2

selection view: how many groups?    covering view: how many arrows?
                    same answer — the two are duals
```

### Code

```go
func findMinArrowShots(points [][]int) int {
    if len(points) == 0 {
        return 0
    }

    // Earliest end first: shooting at the end catches the most balloons.
    sort.Slice(points, func(a, b int) bool {
        return points[a][1] < points[b][1]
    })

    arrows := 1
    arrowPosition := points[0][1] // fire at the first balloon's end

    for _, balloon := range points[1:] {
        // <= : a balloon starting exactly at the arrow is still burst.
        if balloon[0] > arrowPosition {
            arrows++
            arrowPosition = balloon[1] // a new arrow, at this balloon's end
        }
    }
    return arrows
}
```

```python
def findMinArrowShots(points):
    if not points:
        return 0
    points.sort(key=lambda p: p[1])             # earliest END first

    arrows = 1
    arrow_position = points[0][1]               # fire at the first end

    for start, end in points[1:]:
        if start > arrow_position:              # not covered by the current arrow
            arrows += 1
            arrow_position = end
    return arrows
```

### Complexity
Time **O(n log n)**, Space O(1) beyond the sort.

---

## 11. Solved Example 3

### Problem — Maximum Length of Pair Chain (LeetCode 646)
Pair `(a, b)` can follow `(c, d)` only when `b < c` — **strictly**. Return the longest chain.

### Thought Process
1. Same greedy, with one boundary change: chaining needs a strict gap, so the test is `start > lastFinish`, not `>=`.
2. That single character changes the answer on touching pairs, which is worth seeing side by side with Example 1.
3. There is also an O(n²) DP for this problem. It gives the same answer and is strictly worse here — but it is the formulation that survives when weights are added.
4. **When weights are added, greedy becomes wrong**, and only the DP works. That boundary is the real lesson of this chapter.

### Dry Run

Input: `pairs = [[1,2], [2,3], [3,4]]` — already sorted by second element

| pair | start | `start > lastFinish`? | action | lastFinish | chain |
|------|-------|------------------------|--------|------------|-------|
| `[1,2]` | 1 | `1 > −∞` yes | keep | 2 | 1 |
| `[2,3]` | 2 | `2 > 2` **no** | skip — needs a strict gap | 2 | 1 |
| `[3,4]` | 3 | `3 > 2` yes | keep | 4 | **2** |

Output: **2** ✓ — the chain `[1,2] → [3,4]`.

**The same input, two problems, two answers:**

| problem | test | result |
|---|---|---|
| Non-overlapping (435) | `start >= lastFinish` | keeps **3** |
| Pair Chain (646) | `start > lastFinish` | keeps **2** |

`[1,2]` and `[2,3]` do not *overlap*, but they cannot *chain*. Read the statement, then pick the comparison.

### Where greedy stops working

Attach a weight to each interval and ask for maximum **total weight** instead of maximum count:

```text
[0,10] worth 100
[0,3]  worth 1
[4,6]  worth 1
[7,9]  worth 1
```

Earliest-finish greedy takes `[0,3]`, `[4,6]`, `[7,9]` — three intervals, total weight **3**. The optimum is `[0,10]` alone, weight **100**.

The exchange argument fails precisely here: swapping the greedy choice in preserves the *count* of a solution but says nothing about its *value*. The greedy-choice property no longer holds, so the algorithm loses its justification.

**The DP that does work:** sort by finish time, then for each interval choose between taking it (its weight plus the best total ending at or before its start, located by binary search) and skipping it:

```text
best[i] = max( best[i-1],                       skip interval i
               best[lastCompatible] + weight )  take interval i
```

O(n log n), and it degenerates to the greedy answer when all weights are 1.

### Visualization

```text
unweighted (count):        weighted (value):

  [0,3] [4,6] [7,9]          [0,10] worth 100
  → 3 intervals              [0,3] [4,6] [7,9] worth 1 each

  greedy gives 3  ✓          greedy gives 3   ✗
                             optimum is 100   (one long interval)

  the exchange argument preserves SIZE, not VALUE
      ⇒ weights break greedy  ⇒  use DP
```

### Code

```go
func findLongestChain(pairs [][]int) int {
    if len(pairs) == 0 {
        return 0
    }

    sort.Slice(pairs, func(a, b int) bool {
        return pairs[a][1] < pairs[b][1]
    })

    count := 0
    lastFinish := math.MinInt32
    for _, pair := range pairs {
        // Strict >: chaining needs a real gap, unlike non-overlap.
        if pair[0] > lastFinish {
            count++
            lastFinish = pair[1]
        }
    }
    return count
}

// findMaxWeightChain is the WEIGHTED variant, where greedy is wrong.
// pairs[i] = {start, finish, weight}.
func findMaxWeightChain(pairs [][]int) int {
    n := len(pairs)
    if n == 0 {
        return 0
    }

    sort.Slice(pairs, func(a, b int) bool {
        return pairs[a][1] < pairs[b][1]
    })

    finishes := make([]int, n)
    for i := range pairs {
        finishes[i] = pairs[i][1]
    }

    // best[i] = maximum total weight using only the first i intervals.
    best := make([]int, n+1)
    for i := 1; i <= n; i++ {
        start, weight := pairs[i-1][0], pairs[i-1][2]

        // Rightmost earlier interval whose finish is <= start.
        compatible := sort.SearchInts(finishes[:i-1], start+1)

        take := best[compatible] + weight
        skip := best[i-1]
        if take > skip {
            best[i] = take
        } else {
            best[i] = skip
        }
    }
    return best[n]
}
```

```python
from bisect import bisect_right

def findLongestChain(pairs):
    if not pairs:
        return 0
    pairs.sort(key=lambda p: p[1])              # earliest finish first

    count, last_finish = 0, float("-inf")
    for start, finish in pairs:
        if start > last_finish:                 # strict: chaining needs a gap
            count += 1
            last_finish = finish
    return count

def findMaxWeightChain(pairs):
    """WEIGHTED variant, where greedy is wrong. pairs = (start, finish, weight)."""
    n = len(pairs)
    if n == 0:
        return 0
    pairs.sort(key=lambda p: p[1])
    finishes = [p[1] for p in pairs]

    best = [0] * (n + 1)
    for i in range(1, n + 1):
        start, _, weight = pairs[i - 1]
        compatible = bisect_right(finishes, start, 0, i - 1)
        best[i] = max(best[i - 1], best[compatible] + weight)
    return best[n]
```

### Complexity
Greedy: **O(n log n)** time, O(1) extra space. Weighted DP: **O(n log n)** time, O(n) space.

> The takeaway worth carrying out of this chapter is the *test*, not the rule. Before trusting any greedy, ask whether the exchange argument actually goes through. Here it does for counts and fails for weights — and knowing which side of that line you are on is what separates a correct answer from a plausible one.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 435 | Non-overlapping | Easy | Core greedy application |
| 452 | Min Arrows | Easy | Core greedy application |
| 646 | Max Chain | Medium | Core greedy application |
| 1353 | Max Events | Medium | Core greedy application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Activity selection / scheduling**
- **Jump game reachability**
- **Gas station circuit**
- **Huffman / merge-cost**

---

## 14. Production Engineering Applications

- **Scalability:** Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Activity Selection logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Activity Selection (Greedy).
- **Signal:** activity selection, greedy, earliest finish, intervals, scheduling.
- **Move:** When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).
- **Cost:** O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Activity Selection invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Activity Selection
FAMILY : Greedy (Intermediate)
WHEN   : activity selection, greedy, earliest finish, intervals, scheduling
DO     : When a greedy choice provably never hurts, a single sorted pass yields the optim
TIME   : O(n log n)    SPACE: O(1)
PRACTICE: 435, 452, 646, 1353
```

---

*Part of the DSA Patterns Handbook — pattern 85 of 100.*
