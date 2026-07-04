# 40 · Monotonic Queue

> **One-liner:** A deque kept monotone yields O(1) window min/max amortized.

---

## 1. Overview

### Definition
The **Monotonic Queue** pattern belongs to the *Queues* family. A deque kept monotone yields O(1) window min/max amortized.

### Intuition
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Why it works
Use a deque (monotonic queue) or FIFO queue to maintain window extrema / level order in O(1) amortized per element. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.

---

## 2. Recognition Signals

### Keywords
monotonic queue, deque, window max, window min, amortized.

### Constraints
- Input size where the brute-force complexity would time out — the Monotonic Queue optimization is the intended solution.
- Structural hints in the statement that match this family (Queues).

### Hidden clues
- The problem can be reframed so the Monotonic Queue invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Monotonic Queue is the upgrade.
- The wording maps onto: monotonic queue, deque, window max, window min, amortized.

---

## 3. Brute Force Approach

### Intuition
Recompute the window extremum or re-traverse levels each step — O(nk) / O(n^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Monotonic Queue pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Monotonic Queue invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 230" width="100%" height="230" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-40" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Monotonic (decreasing) deque: front = max, pop back the smaller</text>
  <text x="120" y="88" text-anchor="middle" fill="#64748b">front</text>
  <text x="360" y="88" text-anchor="middle" fill="#64748b">back</text>
  <rect x="90"  y="96" width="60" height="46" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="120" y="124" text-anchor="middle" fill="#1e293b" font-weight="700">8</text>
  <rect x="156" y="96" width="60" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="186" y="124" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="222" y="96" width="60" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="252" y="124" text-anchor="middle" fill="#1e293b">2</text>
  <text x="120" y="164" text-anchor="middle" fill="#059669" font-weight="700">max</text>
  <rect x="430" y="96" width="60" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="460" y="124" text-anchor="middle" fill="#1e293b" font-weight="700">4</text>
  <text x="460" y="88" text-anchor="middle" fill="#64748b">incoming</text>
  <line x1="424" y1="119" x2="290" y2="119" stroke="#475569" marker-end="url(#ar-40)"/>
  <text x="356" y="112" text-anchor="middle" fill="#d97706">2 &lt; 4 → pop back</text>
  <path d="M430,142 Q360,196 292,150" fill="none" stroke="#475569" stroke-dasharray="5 4" marker-end="url(#ar-40)"/>
  <text x="360" y="192" text-anchor="middle" fill="#2563eb">then push 4 at back → deque [8, 6, 4]</text>
  <line x1="120" y1="76" x2="120" y2="94" stroke="#475569" marker-end="url(#ar-40)"/>
  <text x="120" y="70" text-anchor="middle" fill="#64748b">pop front when it exits the window</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Monotonic Queue   : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Monotonic Queue problem. I'll a double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier. That brings the complexity down to O(n) time and O(k) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Queues** family template. Adapt the comparison/condition to the specific problem.

```go
// Sliding window maximum with a monotonic decreasing deque of indices.
func maxSlidingWindow(nums []int, k int) []int {
    dq := []int{}      // indices, values decreasing
    res := []int{}
    for i, v := range nums {
        for len(dq) > 0 && nums[dq[len(dq)-1]] < v { dq = dq[:len(dq)-1] }
        dq = append(dq, i)
        if dq[0] <= i-k { dq = dq[1:] }          // evict out-of-window
        if i >= k-1 { res = append(res, nums[dq[0]]) }
    }
    return res
}
```

```python
from collections import deque
def max_sliding_window(nums, k):
    dq, res = deque(), []          # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] < v:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()
        if i >= k - 1:
            res.append(nums[dq[0]])
    return res
```

```java
int[] maxSlidingWindow(int[] nums, int k) {
    Deque<Integer> dq = new ArrayDeque<>();
    int[] res = new int[nums.length - k + 1];
    for (int i = 0; i < nums.length; i++) {
        while (!dq.isEmpty() && nums[dq.peekLast()] < nums[i]) dq.pollLast();
        dq.offerLast(i);
        if (dq.peekFirst() <= i - k) dq.pollFirst();
        if (i >= k - 1) res[i - k + 1] = nums[dq.peekFirst()];
    }
    return res;
}
```

```cpp
vector<int> maxSlidingWindow(vector<int>& nums, int k) {
    deque<int> dq; vector<int> res;
    for (int i = 0; i < (int)nums.size(); ++i) {
        while (!dq.empty() && nums[dq.back()] < nums[i]) dq.pop_back();
        dq.push_back(i);
        if (dq.front() <= i - k) dq.pop_front();
        if (i >= k - 1) res.push_back(nums[dq.front()]);
    }
    return res;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Monotonic Queue (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(k)** |

> Each element enters/leaves the deque once; BFS visits each node/edge once.

---

## 7. Common Mistakes

1. Storing values instead of indices, so you can't evict by position.
2. Forgetting to evict indices that fell out of the window.
3. Wrong deque monotonicity for min vs max.
4. Emitting results before the first full window forms.
5. BFS: not marking nodes visited when enqueuing (causes revisits/TLE).
6. BFS: marking visited at dequeue time, allowing duplicates in the queue.
7. Mixing level boundaries in level-order BFS.
8. Using a list as a queue with O(n) pops from the front.
9. Off-by-one in window eviction condition.
10. Not handling k larger than the array length.

---

## 8. Interview Follow-Up Questions

1. **Q: Why a deque for window max?**
   A: It keeps a decreasing sequence of candidates; the front is always the max.

2. **Q: Amortized cost?**
   A: Each index is pushed and popped at most once → O(n).

3. **Q: Window minimum?**
   A: Same idea with an increasing deque.

4. **Q: BFS vs DFS for shortest path?**
   A: BFS gives shortest path in unweighted graphs.

5. **Q: Multi-source BFS?**
   A: Seed the queue with all sources at distance 0.

6. **Q: 0-1 BFS?**
   A: Use a deque: push front for 0-weight, back for 1-weight edges.

7. **Q: Level-order traversal?**
   A: Process the queue in size-batches per level.

8. **Q: Why mark visited at enqueue?**
   A: Prevents the same node being queued multiple times.

9. **Q: Shortest subarray with sum >= K (negatives)?**
   A: Monotonic deque on prefix sums.

10. **Q: Space complexity?**
   A: O(k) for the window / O(V) for BFS frontier.

11. **Q: Deque vs heap for window max?**
   A: Deque is O(n); heap is O(n log k).

12. **Q: Rotting oranges / spread problems?**
   A: Multi-source BFS by time layers.

13. **Q: Word ladder?**
   A: BFS over word-transformation graph.

14. **Q: Bidirectional BFS?**
   A: Search from both ends to cut the frontier.

15. **Q: Queue overflow in huge graphs?**
   A: Stream/iterative deepening or external memory.

---

## 9. Solved Example 1

### Problem — Sliding Window Max (LeetCode 239)
A representative **Monotonic Queue** problem. The signal: a deque kept monotone yields o(1) window min/max amortized.

### Thought Process
1. Confirm the pattern via its recognition signals (monotonic queue, deque, window max, window min, amortized).
2. Reach for the Monotonic Queue template below and map the problem's entities onto it.
3. A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Monotonic Queue step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque
def max_sliding_window(nums, k):
    dq, res = deque(), []          # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] < v:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()
        if i >= k - 1:
            res.append(nums[dq[0]])
    return res
```

### Complexity
Time O(n), Space O(k). Each element enters/leaves the deque once; BFS visits each node/edge once.

## 10. Solved Example 2

### Problem — Shortest Subarray (LeetCode 862)
A representative **Monotonic Queue** problem. The signal: a deque kept monotone yields o(1) window min/max amortized.

### Thought Process
1. Confirm the pattern via its recognition signals (monotonic queue, deque, window max, window min, amortized).
2. Reach for the Monotonic Queue template below and map the problem's entities onto it.
3. A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Monotonic Queue step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque
def max_sliding_window(nums, k):
    dq, res = deque(), []          # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] < v:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()
        if i >= k - 1:
            res.append(nums[dq[0]])
    return res
```

### Complexity
Time O(n), Space O(k). Each element enters/leaves the deque once; BFS visits each node/edge once.

## 11. Solved Example 3

### Problem — Limit Diff (LeetCode 1438)
A representative **Monotonic Queue** problem. The signal: a deque kept monotone yields o(1) window min/max amortized.

### Thought Process
1. Confirm the pattern via its recognition signals (monotonic queue, deque, window max, window min, amortized).
2. Reach for the Monotonic Queue template below and map the problem's entities onto it.
3. A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Monotonic Queue step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque
def max_sliding_window(nums, k):
    dq, res = deque(), []          # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] < v:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()
        if i >= k - 1:
            res.append(nums[dq[0]])
    return res
```

### Complexity
Time O(n), Space O(k). Each element enters/leaves the deque once; BFS visits each node/edge once.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 239 | Sliding Window Max | Easy | Core queues application |
| 862 | Shortest Subarray | Easy | Core queues application |
| 1438 | Limit Diff | Medium | Core queues application |
| 1696 | Jump VI | Medium | Core queues application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Monotonic deque (window max/min)**
- **FIFO BFS**
- **Multi-source BFS**
- **0-1 BFS**
- **Level-order traversal**

---

## 14. Production Engineering Applications

- **Scalability:** Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(k)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Monotonic Queue logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Monotonic Queue (Queues).
- **Signal:** monotonic queue, deque, window max, window min, amortized.
- **Move:** A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Monotonic Queue invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Monotonic Queue
FAMILY : Queues (Advanced)
WHEN   : monotonic queue, deque, window max, window min, amortized
DO     : A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand fro
TIME   : O(n)    SPACE: O(k)
PRACTICE: 239, 862, 1438, 1696
```

---

*Part of the DSA Patterns Handbook — pattern 40 of 100.*
