# 88 · Huffman Greedy

> **One-liner:** Repeatedly merge the two smallest weights via a heap for optimal cost.

---

## 1. Overview

### Definition
The **Huffman Greedy** pattern belongs to the *Greedy* family. Repeatedly merge the two smallest weights via a heap for optimal cost.

### Intuition
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Why it works
Make the locally optimal choice that a proof (exchange argument) shows is globally safe — usually after sorting. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.

---

## 2. Recognition Signals

### Keywords
huffman, greedy, heap, encoding, merge cost, optimal.

### Constraints
- Input size where the brute-force complexity would time out — the Huffman Greedy optimization is the intended solution.
- Structural hints in the statement that match this family (Greedy).

### Hidden clues
- The problem can be reframed so the Huffman Greedy invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Huffman Greedy is the upgrade.
- The wording maps onto: huffman, greedy, heap, encoding, merge cost, optimal.

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
Redundant recomputation; does not exploit the structure the Huffman Greedy pattern is built to use.

---

## 4. Optimal Approach

### Core idea
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Huffman Greedy invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-88" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Pop the two smallest weights, merge them into a parent, push it back</text>
  <!-- min heap leaves: 2 3 5 7 -->
  <text x="60" y="55" fill="#64748b">min-heap:</text>
  <circle cx="150" cy="70" r="20" fill="#ecfdf5" stroke="#059669"/><text x="150" y="75" text-anchor="middle" fill="#059669" font-weight="700">2</text>
  <circle cx="210" cy="70" r="20" fill="#ecfdf5" stroke="#059669"/><text x="210" y="75" text-anchor="middle" fill="#059669" font-weight="700">3</text>
  <circle cx="270" cy="70" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="270" y="75" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="330" cy="70" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="330" y="75" text-anchor="middle" fill="#1e293b">7</text>
  <text x="180" y="105" text-anchor="middle" fill="#059669">two smallest</text>
  <line x1="400" y1="70" x2="450" y2="70" stroke="#475569" marker-end="url(#a-88)"/>
  <text x="425" y="60" text-anchor="middle" fill="#64748b">merge</text>
  <!-- merged subtree: parent 5 with children 2 and 3 -->
  <circle cx="530" cy="60" r="22" fill="#fff7ed" stroke="#d97706"/><text x="530" y="65" text-anchor="middle" fill="#d97706" font-weight="700">5</text>
  <line x1="514" y1="75" x2="495" y2="110" stroke="#475569"/>
  <line x1="546" y1="75" x2="565" y2="110" stroke="#475569"/>
  <circle cx="490" cy="125" r="18" fill="#ecfdf5" stroke="#059669"/><text x="490" y="130" text-anchor="middle" fill="#059669" font-weight="700">2</text>
  <circle cx="570" cy="125" r="18" fill="#ecfdf5" stroke="#059669"/><text x="570" y="130" text-anchor="middle" fill="#059669" font-weight="700">3</text>
  <text x="320" y="185" text-anchor="middle" fill="#64748b">push parent 5 back → heap now {5, 5, 7}, repeat until one node remains</text>
  <text x="320" y="212" text-anchor="middle" fill="#059669" font-weight="700">smaller weights sit deeper → shorter codes for frequent symbols</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Huffman Greedy    : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Huffman Greedy problem. I'll when a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n). That brings the complexity down to O(n log n) time and O(1) space — here's the template."

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

| Metric | Brute Force | Huffman Greedy (Optimal) |
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

### Problem — Min Cost Sticks (LeetCode 1167)
A representative **Huffman Greedy** problem. The signal: repeatedly merge the two smallest weights via a heap for optimal cost.

### Thought Process
1. Confirm the pattern via its recognition signals (huffman, greedy, heap, encoding, merge cost, optimal).
2. Reach for the Huffman Greedy template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Huffman Greedy step-by-step ]
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

### Problem — Last Stone (LeetCode 1046)
A representative **Huffman Greedy** problem. The signal: repeatedly merge the two smallest weights via a heap for optimal cost.

### Thought Process
1. Confirm the pattern via its recognition signals (huffman, greedy, heap, encoding, merge cost, optimal).
2. Reach for the Huffman Greedy template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Huffman Greedy step-by-step ]
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

### Problem — Largest Number (LeetCode 2231)
A representative **Huffman Greedy** problem. The signal: repeatedly merge the two smallest weights via a heap for optimal cost.

### Thought Process
1. Confirm the pattern via its recognition signals (huffman, greedy, heap, encoding, merge cost, optimal).
2. Reach for the Huffman Greedy template below and map the problem's entities onto it.
3. When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Huffman Greedy step-by-step ]
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
| 1167 | Min Cost Sticks | Easy | Core greedy application |
| 1046 | Last Stone | Easy | Core greedy application |
| 2231 | Largest Number | Medium | Core greedy application |
| 630 | Course III | Medium | Core greedy application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Huffman Greedy logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Huffman Greedy (Greedy).
- **Signal:** huffman, greedy, heap, encoding, merge cost, optimal.
- **Move:** When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).
- **Cost:** O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Huffman Greedy invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Huffman Greedy
FAMILY : Greedy (Advanced)
WHEN   : huffman, greedy, heap, encoding, merge cost, optimal
DO     : When a greedy choice provably never hurts, a single sorted pass yields the optim
TIME   : O(n log n)    SPACE: O(1)
PRACTICE: 1167, 1046, 2231, 630
```

---

*Part of the DSA Patterns Handbook — pattern 88 of 100.*
