# 33 · Interval Scheduling

> **One-liner:** Greedily pick earliest-finishing intervals to maximize non-overlap.

---

## 1. Overview

### Definition
The **Interval Scheduling** pattern belongs to the *Intervals* family. Greedily pick earliest-finishing intervals to maximize non-overlap.

### Intuition
Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.

### Why it works
Sort by start (or process start/end events), then sweep once merging or counting overlaps. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Interval logic schedules calendar/meeting systems, allocates cloud resources (min machines for overlapping jobs), reconciles time-series gaps, and powers range-based access control. Sweep-line scales to millions of events with a single ordered pass.

---

## 2. Recognition Signals

### Keywords
interval scheduling, greedy, non-overlapping, earliest finish, activity.

### Constraints
- Input size where the brute-force complexity would time out — the Interval Scheduling optimization is the intended solution.
- Structural hints in the statement that match this family (Intervals).

### Hidden clues
- The problem can be reframed so the Interval Scheduling invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Interval Scheduling is the upgrade.
- The wording maps onto: interval scheduling, greedy, non-overlapping, earliest finish, activity.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How many of these intervals can I pick without any two overlapping?"* — and its disguises: *"how many must I delete?"*, *"how few arrows do I need?"*

### Intuition
Try every subset and keep the largest one that happens to be conflict-free.

### Algorithm
1. Enumerate all `2ⁿ` subsets of the intervals.
2. For each subset, check every pair for overlap.
3. Keep the largest conflict-free subset found.

### Complexity
- Time: **O(2ⁿ · n²)**.
- Space: O(n).

### Drawbacks
- Hopeless past about 20 intervals.
- A DP over sorted intervals brings it down to O(n log n) or O(n²) — but even that is more machinery than this problem needs. There is a greedy rule that is simply *correct*, and the interesting question is **why**.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Always take the interval that finishes earliest. Finishing early leaves the most room for everything after it.**

The instinct to sort by *start* time, or by *shortest duration*, is very strong and both are wrong. Only "earliest end" is correct.

### The thought process

```text
We need    : the largest set of mutually non-overlapping intervals.
Obvious way: try all subsets.
Too slow   : O(2^n).
Notice     : the ONLY thing that constrains future picks is when the
             current one ends. Its start no longer matters once chosen.
             So among all candidates, the one ending soonest is never
             a worse choice.
Therefore  : sort by end time, and greedily take any interval that
             starts at or after the last one we took.
Now        : O(n log n), and one pass.
```

### Why "earliest end" is provably optimal

This is the part worth internalising, because it is the same exchange argument behind most greedy proofs.

Let `g` be the interval that ends earliest overall. Take any optimal solution `S`.

- If `S` already contains `g`, we agree — done.
- If not, let `f` be the interval in `S` that ends earliest. Since `g` ends no later than `f`, **swapping `f` for `g` cannot create a conflict**: everything else in `S` starts after `f` ends, and `g` ends at or before that.

The swap keeps the size the same, so `S' = S − {f} + {g}` is *also* optimal. Repeating the argument on what remains shows the greedy choice is safe at every step.

> The key sentence: **once an interval is chosen, only its end time matters.** Its start is history. So minimising the end time maximises the room left over.

### Why the tempting alternatives fail

```text
Sort by START:      [0,10]  [1,2]  [3,4]
                    taking [0,10] first blocks both others → 1
                    correct answer is 2

Sort by DURATION:   [0,5]  [4,6]  [5,10]
                    the shortest is [4,6]; taking it blocks BOTH others → 1
                    correct answer is 2 ([0,5] and [5,10])
```

Both counterexamples are small enough to keep in your head — worth doing, because these are the two wrong answers people actually give.

### Steps

```text
Step 1 → Sort the intervals by END time, ascending.
Step 2 → count = 0, lastEnd = -infinity
Step 3 → For each interval in that order:
Step 4 →     if interval.start >= lastEnd:      ← no conflict
Step 5 →         count++;  lastEnd = interval.end
Step 6 →     else: skip it
Step 7 → Return count (or n - count if the problem asks for removals).
```

### The three disguises

All three are the same loop with a different final line:

| Problem asks for | Answer |
|---|---|
| max non-overlapping intervals | `count` |
| **minimum removals** to make them non-overlapping | `n − count` |
| minimum **arrows/points** hitting every interval | `count` of "groups", i.e. the same greedy |

The arrow version is the same problem read upside down: shooting at the earliest end point pops every balloon that overlaps it, and each greedy pick corresponds to one arrow.

### The comparison that changes per problem

The greedy skeleton never changes; the **boundary convention** does. Get it from the problem statement, not from habit:

| Problem | Touching counts as… | Test to keep an interval |
|---|---|---|
| Non-overlapping Intervals (435) | not overlapping | `start >= lastEnd` |
| Minimum Arrows (452) | overlapping (one arrow pops both) | `start > arrowPos` starts a new arrow |
| Maximum Pair Chain (646) | not chainable (needs strict `<`) | `start > lastEnd` |

`[1,2]` and `[2,3]` are compatible in 435, burstable by one arrow in 452, and **not** chainable in 646. Same numbers, three different answers — read the statement.

### How should I recognize this?

```text
If you see...
  "maximum number of non-overlapping ..."
  "minimum number of intervals to remove"
  "minimum arrows / taps / platforms to cover everything"
  "schedule the most jobs / activities"
        ↓
Think about...
  "Once I commit to one, only its END constrains the future."
        ↓
Use...
  sort by END, sweep once, keep anything that starts after lastEnd
  (NOT by start, NOT by duration)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 215" width="100%" height="215" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="sch33" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Sort by finish, greedily keep any bar starting ≥ last kept end</text>
  <rect x="125" y="40" width="130" height="20" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="190" y="54" text-anchor="middle" fill="#1e293b">[1,3]</text>
  <text x="275" y="54" fill="#059669" font-weight="700">✓ keep</text>
  <rect x="190" y="66" width="195" height="20" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="287" y="80" text-anchor="middle" fill="#1e293b">[2,5]</text>
  <text x="405" y="80" fill="#d97706" font-weight="700">✗ starts 2 &lt; 3</text>
  <rect x="320" y="92" width="130" height="20" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="385" y="106" text-anchor="middle" fill="#1e293b">[4,6]</text>
  <text x="470" y="106" fill="#059669" font-weight="700">✓ keep</text>
  <rect x="450" y="118" width="130" height="20" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="515" y="132" text-anchor="middle" fill="#1e293b">[6,8]</text>
  <line x1="60" y1="158" x2="600" y2="158" stroke="#cbd5e1"/>
  <g fill="#64748b" text-anchor="middle">
    <line x1="60"  y1="154" x2="60"  y2="162" stroke="#94a3b8"/><text x="60"  y="176">0</text>
    <line x1="190" y1="154" x2="190" y2="162" stroke="#94a3b8"/><text x="190" y="176">2</text>
    <line x1="320" y1="154" x2="320" y2="162" stroke="#94a3b8"/><text x="320" y="176">4</text>
    <line x1="450" y1="154" x2="450" y2="162" stroke="#94a3b8"/><text x="450" y="176">6</text>
    <line x1="580" y1="154" x2="580" y2="162" stroke="#94a3b8"/><text x="580" y="176">8</text>
  </g>
  <text x="320" y="200" text-anchor="middle" fill="#059669" font-weight="700">3 non-overlapping intervals kept</text>
</svg>
```

```text
intervals: [1,2]  [2,3]  [3,4]  [1,3]

sorted by END:  [1,2]   [2,3]   [1,3]   [3,4]
                 end 2   end 3   end 3   end 4

take [1,2]           lastEnd = 2
[2,3]: 2 >= 2  ✓     take, lastEnd = 3
[1,3]: 1 <  3  ✗     skip (conflicts)
[3,4]: 3 >= 3  ✓     take, lastEnd = 4

kept 3 of 4  →  remove 1
```

### Interview explanation
"I'll sort by **end** time and greedily take every interval that starts at or after the last one I took. The reason earliest-end is optimal is an exchange argument: once an interval is chosen, only its end time constrains what comes next, so replacing any optimal solution's first interval with the globally-earliest-ending one can never introduce a conflict — the solution stays valid and the same size. Sorting by start or by duration both fail on small counterexamples. That's O(n log n) for the sort and O(n) for the sweep. If the problem asks for minimum removals, I return `n − count`."

---

## 5. Generic Templates

> Sort by end. Sweep once. Only the boundary comparison changes per problem.

```go
// MaxNonOverlapping returns the largest number of mutually
// non-overlapping intervals. Touching intervals are compatible.
func MaxNonOverlapping(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    // Earliest end first: the whole greedy rests on this.
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][1] < intervals[b][1]
    })

    count := 0
    lastEnd := math.MinInt32
    for _, iv := range intervals {
        if iv[0] >= lastEnd { // starts after the last kept one ends
            count++
            lastEnd = iv[1]
        }
    }
    return count
}

// MinRemovals is the same sweep, reported the other way round.
func MinRemovals(intervals [][]int) int {
    return len(intervals) - MaxNonOverlapping(intervals)
}

// MaxChain requires a STRICT gap: [1,2] and [2,3] cannot chain.
func MaxChain(pairs [][]int) int {
    if len(pairs) == 0 {
        return 0
    }
    sort.Slice(pairs, func(a, b int) bool {
        return pairs[a][1] < pairs[b][1]
    })

    count := 0
    lastEnd := math.MinInt32
    for _, p := range pairs {
        if p[0] > lastEnd { // strict: the only difference from above
            count++
            lastEnd = p[1]
        }
    }
    return count
}
```

```python
def max_non_overlapping(intervals):
    """Largest set of mutually non-overlapping intervals. Touching is OK."""
    if not intervals:
        return 0
    intervals.sort(key=lambda iv: iv[1])       # earliest END first

    count, last_end = 0, float("-inf")
    for start, end in intervals:
        if start >= last_end:                  # no conflict
            count += 1
            last_end = end
    return count

def min_removals(intervals):
    """Same sweep, reported the other way round."""
    return len(intervals) - max_non_overlapping(intervals)

def max_chain(pairs):
    """Strict gap required: [1,2] and [2,3] cannot chain."""
    if not pairs:
        return 0
    pairs.sort(key=lambda p: p[1])

    count, last_end = 0, float("-inf")
    for start, end in pairs:
        if start > last_end:                   # strict >, not >=
            count += 1
            last_end = end
    return count
```

```java
import java.util.*;

public class IntervalScheduling {
    // Touching intervals are compatible.
    public static int maxNonOverlapping(int[][] intervals) {
        if (intervals.length == 0) return 0;
        Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));  // earliest END

        int count = 0;
        long lastEnd = Long.MIN_VALUE;
        for (int[] iv : intervals) {
            if (iv[0] >= lastEnd) {
                count++;
                lastEnd = iv[1];
            }
        }
        return count;
    }

    public static int minRemovals(int[][] intervals) {
        return intervals.length - maxNonOverlapping(intervals);
    }

    // Strict gap required.
    public static int maxChain(int[][] pairs) {
        if (pairs.length == 0) return 0;
        Arrays.sort(pairs, (a, b) -> Integer.compare(a[1], b[1]));

        int count = 0;
        long lastEnd = Long.MIN_VALUE;
        for (int[] p : pairs) {
            if (p[0] > lastEnd) {          // strict >
                count++;
                lastEnd = p[1];
            }
        }
        return count;
    }
}
```

```cpp
#include <algorithm>
#include <climits>
#include <vector>
using namespace std;

// Touching intervals are compatible.
int maxNonOverlapping(vector<vector<int>> intervals) {
    if (intervals.empty()) return 0;
    sort(intervals.begin(), intervals.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[1] < b[1]; });

    int count = 0;
    long long lastEnd = LLONG_MIN;
    for (const auto& iv : intervals) {
        if (iv[0] >= lastEnd) {
            ++count;
            lastEnd = iv[1];
        }
    }
    return count;
}

int minRemovals(vector<vector<int>> intervals) {
    int n = (int)intervals.size();
    return n - maxNonOverlapping(move(intervals));
}

// Strict gap required.
int maxChain(vector<vector<int>> pairs) {
    if (pairs.empty()) return 0;
    sort(pairs.begin(), pairs.end(),
         [](const vector<int>& a, const vector<int>& b) { return a[1] < b[1]; });

    int count = 0;
    long long lastEnd = LLONG_MIN;
    for (const auto& p : pairs) {
        if (p[0] > lastEnd) {          // strict >
            ++count;
            lastEnd = p[1];
        }
    }
    return count;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Interval Scheduling (Optimal) |
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

### Problem — Non-overlapping Intervals (LeetCode 435)
Return the **minimum number of intervals to remove** so that the rest do not overlap.

### Thought Process
1. Removing the fewest is the same as **keeping the most** — so solve the max non-overlapping problem and subtract.
2. Sort by end time and greedily keep any interval starting at or after the last kept one's end.
3. Here touching is fine: `[1,2]` and `[2,3]` do not overlap, so the test is `start >= lastEnd`.
4. Answer = `n − kept`.

### Dry Run

Input: `intervals = [[1,2], [2,3], [3,4], [1,3]]`

**Sorted by end time:**

```text
[1,2]   [2,3]   [1,3]   [3,4]
 end 2   end 3   end 3   end 4
```

**Greedy sweep** (`lastEnd` starts at −∞):

| interval | start | `start >= lastEnd`? | action | lastEnd | kept |
|----------|-------|---------------------|--------|---------|------|
| `[1,2]` | 1 | `1 >= −∞` yes | keep | 2 | 1 |
| `[2,3]` | 2 | `2 >= 2` yes (touching is fine) | keep | 3 | 2 |
| `[1,3]` | 1 | `1 >= 3` **no** | skip | 3 | 2 |
| `[3,4]` | 3 | `3 >= 3` yes | keep | 4 | **3** |

Kept 3 of 4 → removals = `4 − 3` = **1**

Output: **1** — removing `[1,3]` leaves `[1,2]`, `[2,3]`, `[3,4]`, which are pairwise non-overlapping. ✓

Notice `[1,3]` was skipped even though it appeared before `[3,4]` in the sorted order. Ending at 3 while starting at 1 makes it strictly worse than `[2,3]`, which we had already taken.

### Visualization

```text
1──2
   2──3
      3──4
1─────3          ← overlaps both [1,2] and [2,3]

keep the three short ones, drop the long one  →  1 removal
```

### Code

```go
func eraseOverlapIntervals(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    // Earliest end first: finishing early leaves the most room.
    sort.Slice(intervals, func(a, b int) bool {
        return intervals[a][1] < intervals[b][1]
    })

    kept := 0
    lastEnd := math.MinInt32
    for _, iv := range intervals {
        // >= : touching intervals do not overlap in this problem.
        if iv[0] >= lastEnd {
            kept++
            lastEnd = iv[1]
        }
    }
    return len(intervals) - kept
}
```

```python
def eraseOverlapIntervals(intervals):
    if not intervals:
        return 0
    intervals.sort(key=lambda iv: iv[1])       # earliest END first

    kept, last_end = 0, float("-inf")
    for start, end in intervals:
        if start >= last_end:                  # >= : touching is fine here
            kept += 1
            last_end = end
    return len(intervals) - kept
```

### Complexity
Time O(n log n) — the sort dominates the O(n) sweep. Space O(1) beyond the sort.

---

## 10. Solved Example 2

### Problem — Minimum Number of Arrows to Burst Balloons (LeetCode 452)
Each balloon spans `[start, end]` on the x-axis. An arrow shot straight up at `x` bursts every balloon with `start <= x <= end`. Return the minimum number of arrows.

### Thought Process
1. This is the same greedy read upside down. A single arrow serves a group of mutually overlapping balloons, so the number of arrows equals the number of groups.
2. Sort by end. Shoot the first arrow at the **earliest end** — that is the furthest right you can shoot while still popping the first balloon, so it catches the most others.
3. Walk the rest: any balloon with `start <= arrowPosition` is already burst, so skip it.
4. The first balloon with `start > arrowPosition` needs a new arrow, placed at *its* end.
5. Here touching **does** count as overlapping: a balloon starting exactly at the arrow's x is burst, hence `<=`.

### Dry Run

Input: `points = [[10,16], [2,8], [1,6], [7,12]]`

**Sorted by end:**

```text
[1,6]   [2,8]   [7,12]   [10,16]
 end 6   end 8   end 12    end 16
```

**Greedy sweep:**

| balloon | start | `start <= arrowPos`? | action | arrowPos | arrows |
|---------|-------|----------------------|--------|----------|--------|
| `[1,6]`   | 1  | — (first) | shoot at its end | **6** | 1 |
| `[2,8]`   | 2  | `2 <= 6` yes | already burst → skip | 6 | 1 |
| `[7,12]`  | 7  | `7 <= 6` **no** | new arrow at its end | **12** | **2** |
| `[10,16]` | 10 | `10 <= 12` yes | already burst → skip | 12 | 2 |

Output: **2** — one arrow at x = 6 bursts `[1,6]` and `[2,8]`; one at x = 12 bursts `[7,12]` and `[10,16]`. ✓

Why shoot at the *end* rather than the start? Shooting at `[1,6]`'s start (x = 1) would burst only that balloon. Shooting at its end (x = 6) is the rightmost position that still bursts it — maximising what else gets caught.

### Visualization

```text
      1────────6
        2────────8
              7──────────12
                 10──────────16

arrow ↑ at 6            ↑ at 12
      bursts 2          bursts 2

total arrows: 2
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
    arrowPosition := points[0][1] // shoot at the first balloon's end

    for _, p := range points[1:] {
        // <= : a balloon starting exactly at the arrow is still burst.
        if p[0] > arrowPosition {
            arrows++
            arrowPosition = p[1] // new arrow at this balloon's end
        }
    }
    return arrows
}
```

```python
def findMinArrowShots(points):
    if not points:
        return 0
    points.sort(key=lambda p: p[1])            # earliest END first

    arrows = 1
    arrow_position = points[0][1]              # shoot at the first balloon's end

    for start, end in points[1:]:
        if start > arrow_position:             # not covered by the current arrow
            arrows += 1
            arrow_position = end
    return arrows
```

### Complexity
Time O(n log n), Space O(1) beyond the sort.

---

## 11. Solved Example 3

### Problem — Maximum Length of Pair Chain (LeetCode 646)
Pair `(a, b)` can follow `(c, d)` only when `b < c` — **strictly**. Return the longest chain.

### Thought Process
1. Identical greedy: sort by end, keep whatever can follow the last kept pair.
2. The one difference is the boundary: chaining needs `b < c` **strictly**, so the test is `start > lastEnd`, not `>=`.
3. That single character is the whole distinction from Example 1 — and it changes the answer on touching pairs.
4. Sorting by the second element is what makes the greedy valid, exactly as before.

### Dry Run

Input: `pairs = [[1,2], [2,3], [3,4]]` — already sorted by end

| pair | start | `start > lastEnd`? | action | lastEnd | chain length |
|------|-------|--------------------|--------|---------|--------------|
| `[1,2]` | 1 | `1 > −∞` yes | keep | 2 | 1 |
| `[2,3]` | 2 | `2 > 2` **no** | skip (needs a strict gap) | 2 | 1 |
| `[3,4]` | 3 | `3 > 2` yes | keep | 4 | **2** |

Output: **2** — the chain `[1,2] → [3,4]`. ✓

**The contrast with Example 1, on the very same input:**

| problem | test | result on `[[1,2],[2,3],[3,4]]` |
|---|---|---|
| Non-overlapping (435) | `start >= lastEnd` | keeps all **3** |
| Pair Chain (646) | `start > lastEnd` | keeps **2** |

`[1,2]` and `[2,3]` do not *overlap*, but they cannot *chain*. Read the statement, then pick the comparison.

### Visualization

```text
[1,2]   [2,3]   [3,4]

1──2
   2──3     needs 2 < 2  ✗  (not strict)
      3──4  needs 2 < 3  ✓

chain: [1,2] → [3,4]   length 2
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
    lastEnd := math.MinInt32
    for _, p := range pairs {
        // Strict >: chaining needs a real gap, unlike non-overlap.
        if p[0] > lastEnd {
            count++
            lastEnd = p[1]
        }
    }
    return count
}
```

```python
def findLongestChain(pairs):
    if not pairs:
        return 0
    pairs.sort(key=lambda p: p[1])             # earliest END first

    count, last_end = 0, float("-inf")
    for start, end in pairs:
        if start > last_end:                   # strict >: chaining needs a gap
            count += 1
            last_end = end
    return count
```

### Complexity
Time O(n log n), Space O(1) beyond the sort.

> There is also an O(n²) DP for this problem (LIS-style over sorted pairs). It gives the same answer but is strictly worse here — reach for DP only when the greedy exchange argument fails, for example when intervals carry unequal weights and you want maximum *value* rather than maximum *count*.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 435 | Non-overlapping | Easy | Core intervals application |
| 452 | Min Arrows | Easy | Core intervals application |
| 646 | Max Chain | Medium | Core intervals application |
| 1235 | Job Scheduling | Medium | Core intervals application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Interval Scheduling logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Interval Scheduling (Intervals).
- **Signal:** interval scheduling, greedy, non-overlapping, earliest finish, activity.
- **Move:** Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.
- **Cost:** O(n log n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Interval Scheduling invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Interval Scheduling
FAMILY : Intervals (Advanced)
WHEN   : interval scheduling, greedy, non-overlapping, earliest finish, activity
DO     : Sorting linearizes the geometry so a single left-to-right sweep resolves all ove
TIME   : O(n log n)    SPACE: O(n)
PRACTICE: 435, 452, 646, 1235
```

---

*Part of the DSA Patterns Handbook — pattern 33 of 100.*
