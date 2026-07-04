# 42 · BFS Queue Pattern

> **One-liner:** Queue-driven level-by-level expansion for shortest unweighted paths.

---

## 1. Overview

### Definition
The **BFS Queue Pattern** pattern belongs to the *Queues* family. Queue-driven level-by-level expansion for shortest unweighted paths.

### Intuition
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Why it works
Use a deque (monotonic queue) or FIFO queue to maintain window extrema / level order in O(1) amortized per element. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.

---

## 2. Recognition Signals

### Keywords
bfs, queue, level order, shortest path, unweighted.

### Constraints
- Input size where the brute-force complexity would time out — the BFS Queue Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Queues).

### Hidden clues
- The problem can be reframed so the BFS Queue Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — BFS Queue Pattern is the upgrade.
- The wording maps onto: bfs, queue, level order, shortest path, unweighted.

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
Redundant recomputation; does not exploit the structure the BFS Queue Pattern pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the BFS Queue Pattern invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bfs-42" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">BFS: a FIFO queue expands the frontier level by level</text>
  <!-- tree -->
  <text x="18" y="70" fill="#64748b">L0</text>
  <text x="18" y="135" fill="#64748b">L1</text>
  <text x="18" y="200" fill="#64748b">L2</text>
  <line x1="110" y1="80" x2="72" y2="120" stroke="#475569"/>
  <line x1="110" y1="80" x2="160" y2="120" stroke="#475569"/>
  <line x1="70" y1="146" x2="49" y2="185" stroke="#475569"/>
  <line x1="70" y1="146" x2="95" y2="185" stroke="#475569"/>
  <line x1="162" y1="146" x2="162" y2="185" stroke="#475569"/>
  <circle cx="110" cy="65" r="18" fill="#ecfdf5" stroke="#059669"/><text x="110" y="70" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="70" cy="130" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="70" y="135" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="162" cy="130" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="162" y="135" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="47" cy="195" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="47" y="200" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="97" cy="195" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="97" y="200" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="162" cy="195" r="18" fill="#eff6ff" stroke="#2563eb"/><text x="162" y="200" text-anchor="middle" fill="#1e293b">6</text>
  <!-- queue popped level by level -->
  <line x1="300" y1="52" x2="300" y2="200" stroke="#475569" marker-end="url(#bfs-42)"/>
  <text x="300" y="222" text-anchor="middle" fill="#64748b">pop order</text>
  <text x="325" y="72" fill="#64748b">L0</text>
  <rect x="358" y="52" width="34" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="375" y="72" text-anchor="middle" fill="#1e293b">1</text>
  <text x="325" y="125" fill="#64748b">L1</text>
  <rect x="358" y="105" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="375" y="125" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="398" y="105" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="415" y="125" text-anchor="middle" fill="#1e293b">3</text>
  <text x="325" y="178" fill="#64748b">L2</text>
  <rect x="358" y="158" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="375" y="178" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="398" y="158" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="415" y="178" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="438" y="158" width="34" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="455" y="178" text-anchor="middle" fill="#1e293b">6</text>
  <text x="560" y="116" text-anchor="middle" fill="#64748b">dequeue front,</text>
  <text x="560" y="134" text-anchor="middle" fill="#64748b">enqueue its children</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
BFS Queue Pattern : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a BFS Queue Pattern problem. I'll a double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier. That brings the complexity down to O(n) time and O(k) space — here's the template."

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

| Metric | Brute Force | BFS Queue Pattern (Optimal) |
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

### Problem — Level Order (LeetCode 102)
A representative **BFS Queue Pattern** problem. The signal: queue-driven level-by-level expansion for shortest unweighted paths.

### Thought Process
1. Confirm the pattern via its recognition signals (bfs, queue, level order, shortest path, unweighted).
2. Reach for the BFS Queue Pattern template below and map the problem's entities onto it.
3. A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply BFS Queue Pattern step-by-step ]
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

### Problem — Rotting Oranges (LeetCode 994)
A representative **BFS Queue Pattern** problem. The signal: queue-driven level-by-level expansion for shortest unweighted paths.

### Thought Process
1. Confirm the pattern via its recognition signals (bfs, queue, level order, shortest path, unweighted).
2. Reach for the BFS Queue Pattern template below and map the problem's entities onto it.
3. A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply BFS Queue Pattern step-by-step ]
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

### Problem — Word Ladder (LeetCode 127)
A representative **BFS Queue Pattern** problem. The signal: queue-driven level-by-level expansion for shortest unweighted paths.

### Thought Process
1. Confirm the pattern via its recognition signals (bfs, queue, level order, shortest path, unweighted).
2. Reach for the BFS Queue Pattern template below and map the problem's entities onto it.
3. A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply BFS Queue Pattern step-by-step ]
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
| 102 | Level Order | Easy | Core queues application |
| 994 | Rotting Oranges | Easy | Core queues application |
| 127 | Word Ladder | Medium | Core queues application |
| 542 | 01 Matrix | Medium | Core queues application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same BFS Queue Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** BFS Queue Pattern (Queues).
- **Signal:** bfs, queue, level order, shortest path, unweighted.
- **Move:** A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the BFS Queue Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: BFS Queue Pattern
FAMILY : Queues (Intermediate)
WHEN   : bfs, queue, level order, shortest path, unweighted
DO     : A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand fro
TIME   : O(n)    SPACE: O(k)
PRACTICE: 102, 994, 127, 542
```

---

*Part of the DSA Patterns Handbook — pattern 42 of 100.*
