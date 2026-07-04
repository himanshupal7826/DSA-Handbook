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

### Intuition
Try all orderings/choices (often exponential) to find the optimum.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Activity Selection pattern is built to use.

---

## 4. Optimal Approach

### Core idea
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Activity Selection invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Activity Selection: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Activity Selection problem. I'll when a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n). That brings the complexity down to O(n log n) time and O(1) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Greedy** family template. Adapt the comparison/condition to the specific problem.

```go
// Maximum non-overlapping intervals: greedy by earliest finish time.
func maxNonOverlap(intervals [][]int) int {
    sort.Slice(intervals, func(i, j int) bool { return intervals[i][1] < intervals[j][1] })
    count, end := 0, math.MinInt
    for _, in := range intervals {
        if in[0] >= end {       // compatible with last chosen
            count++
            end = in[1]
        }
    }
    return count
}
```

```python
def max_non_overlap(intervals):
    intervals.sort(key=lambda x: x[1])     # earliest finish first
    count, end = 0, float('-inf')
    for s, e in intervals:
        if s >= end:                        # no overlap
            count += 1
            end = e
    return count
```

```java
int maxNonOverlap(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));
    int count = 0, end = Integer.MIN_VALUE;
    for (int[] in : intervals)
        if (in[0] >= end) { count++; end = in[1]; }
    return count;
}
```

```cpp
int maxNonOverlap(vector<vector<int>>& intervals) {
    sort(intervals.begin(), intervals.end(),
         [](auto& a, auto& b){ return a[1] < b[1]; });
    int count = 0, end = INT_MIN;
    for (auto& in : intervals)
        if (in[0] >= end) { count++; end = in[1]; }
    return count;
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

### Problem — Non-overlapping (LeetCode 435)
A representative **Activity Selection** problem. The signal: pick earliest-finishing compatible activities to maximize count.

### Thought Process
1. Confirm the pattern via its recognition signals (activity selection, greedy, earliest finish, intervals, scheduling).
2. Reach for the Activity Selection template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Activity Selection step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def max_non_overlap(intervals):
    intervals.sort(key=lambda x: x[1])     # earliest finish first
    count, end = 0, float('-inf')
    for s, e in intervals:
        if s >= end:                        # no overlap
            count += 1
            end = e
    return count
```

### Complexity
Time O(n log n), Space O(1). Sorting dominates; the greedy sweep is O(n).

## 10. Solved Example 2

### Problem — Min Arrows (LeetCode 452)
A representative **Activity Selection** problem. The signal: pick earliest-finishing compatible activities to maximize count.

### Thought Process
1. Confirm the pattern via its recognition signals (activity selection, greedy, earliest finish, intervals, scheduling).
2. Reach for the Activity Selection template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Activity Selection step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def max_non_overlap(intervals):
    intervals.sort(key=lambda x: x[1])     # earliest finish first
    count, end = 0, float('-inf')
    for s, e in intervals:
        if s >= end:                        # no overlap
            count += 1
            end = e
    return count
```

### Complexity
Time O(n log n), Space O(1). Sorting dominates; the greedy sweep is O(n).

## 11. Solved Example 3

### Problem — Max Chain (LeetCode 646)
A representative **Activity Selection** problem. The signal: pick earliest-finishing compatible activities to maximize count.

### Thought Process
1. Confirm the pattern via its recognition signals (activity selection, greedy, earliest finish, intervals, scheduling).
2. Reach for the Activity Selection template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Activity Selection step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def max_non_overlap(intervals):
    intervals.sort(key=lambda x: x[1])     # earliest finish first
    count, end = 0, float('-inf')
    for s, e in intervals:
        if s >= end:                        # no overlap
            count += 1
            end = e
    return count
```

### Complexity
Time O(n log n), Space O(1). Sorting dominates; the greedy sweep is O(n).


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
