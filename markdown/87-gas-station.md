# 87 · Gas Station

> **One-liner:** Single pass: reset start when the running tank goes negative.

---

## 1. Overview

### Definition
The **Gas Station** pattern belongs to the *Greedy* family. Single pass: reset start when the running tank goes negative.

### Intuition
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Why it works
Make the locally optimal choice that a proof (exchange argument) shows is globally safe — usually after sorting. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.

---

## 2. Recognition Signals

### Keywords
gas station, greedy, circular, running total, reset start.

### Constraints
- Input size where the brute-force complexity would time out — the Gas Station optimization is the intended solution.
- Structural hints in the statement that match this family (Greedy).

### Hidden clues
- The problem can be reframed so the Gas Station invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Gas Station is the upgrade.
- The wording maps onto: gas station, greedy, circular, running total, reset start.

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
Redundant recomputation; does not exploit the structure the Gas Station pattern is built to use.

---

## 4. Optimal Approach

### Core idea
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Gas Station invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-87" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Run the tank across stations; when it drops below 0, restart start at the next station</text>
  <!-- stations gas minus cost: +2 +3 -4 +1 -2  -->
  <g>
    <rect x="40"  y="55" width="100" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="90"  y="82" text-anchor="middle" fill="#1e293b">S0 +2</text>
    <rect x="150" y="55" width="100" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="82" text-anchor="middle" fill="#1e293b">S1 +3</text>
    <rect x="260" y="55" width="100" height="44" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="310" y="82" text-anchor="middle" fill="#d97706">S2 −4</text>
    <rect x="370" y="55" width="100" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="420" y="82" text-anchor="middle" fill="#059669" font-weight="700">S3 +1</text>
    <rect x="480" y="55" width="100" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="530" y="82" text-anchor="middle" fill="#059669" font-weight="700">S4 +5</text>
  </g>
  <!-- running tank -->
  <text x="90"  y="130" text-anchor="middle" fill="#64748b">tank 2</text>
  <text x="200" y="130" text-anchor="middle" fill="#64748b">5</text>
  <text x="310" y="130" text-anchor="middle" fill="#b91c1c" font-weight="700">1 → &lt;0</text>
  <text x="420" y="130" text-anchor="middle" fill="#059669">1</text>
  <text x="530" y="130" text-anchor="middle" fill="#059669">6</text>
  <line x1="360" y1="150" x2="380" y2="150" stroke="#475569" marker-end="url(#a-87)"/>
  <text x="310" y="172" text-anchor="middle" fill="#b91c1c">tank &lt; 0 at S2</text>
  <text x="450" y="172" text-anchor="middle" fill="#059669" font-weight="700">restart start = S3</text>
  <text x="320" y="200" text-anchor="middle" fill="#64748b">if total sum ≥ 0, the last restart index is the unique answer</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Gas Station       : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Gas Station problem. I'll when a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n). That brings the complexity down to O(n log n) time and O(1) space — here's the template."

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

| Metric | Brute Force | Gas Station (Optimal) |
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

### Problem — Gas Station (LeetCode 134)
A representative **Gas Station** problem. The signal: single pass: reset start when the running tank goes negative.

### Thought Process
1. Confirm the pattern via its recognition signals (gas station, greedy, circular, running total, reset start).
2. Reach for the Gas Station template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Gas Station step-by-step ]
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

### Problem — Jump Game II (LeetCode 45)
A representative **Gas Station** problem. The signal: single pass: reset start when the running tank goes negative.

### Thought Process
1. Confirm the pattern via its recognition signals (gas station, greedy, circular, running total, reset start).
2. Reach for the Gas Station template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Gas Station step-by-step ]
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

### Problem — Min Refuel (LeetCode 871)
A representative **Gas Station** problem. The signal: single pass: reset start when the running tank goes negative.

### Thought Process
1. Confirm the pattern via its recognition signals (gas station, greedy, circular, running total, reset start).
2. Reach for the Gas Station template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Gas Station step-by-step ]
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
| 134 | Gas Station | Easy | Core greedy application |
| 45 | Jump Game II | Easy | Core greedy application |
| 871 | Min Refuel | Medium | Core greedy application |
| 1011 | Ship Days | Medium | Core greedy application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Gas Station logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Gas Station (Greedy).
- **Signal:** gas station, greedy, circular, running total, reset start.
- **Move:** When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).
- **Cost:** O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Gas Station invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Gas Station
FAMILY : Greedy (Intermediate)
WHEN   : gas station, greedy, circular, running total, reset start
DO     : When a greedy choice provably never hurts, a single sorted pass yields the optim
TIME   : O(n log n)    SPACE: O(1)
PRACTICE: 134, 45, 871, 1011
```

---

*Part of the DSA Patterns Handbook — pattern 87 of 100.*
