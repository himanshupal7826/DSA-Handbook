# 45 · Two Heaps

> **One-liner:** A max-heap + min-heap split keeps the median at the heaps' tops.

---

## 1. Overview

### Definition
The **Two Heaps** pattern belongs to the *Heaps* family. A max-heap + min-heap split keeps the median at the heaps' tops.

### Intuition
A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Why it works
Maintain a size-k heap (or two heaps) so each insertion is O(log k) and the best/median is at the top. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Heaps run priority schedulers (OS, Kubernetes), event simulations, Dijkstra routing, k-nearest-neighbor serving, and streaming top-k dashboards. Bounded heap size gives predictable memory under load.

---

## 2. Recognition Signals

### Keywords
two heaps, median, max heap, min heap, balance.

### Constraints
- Input size where the brute-force complexity would time out — the Two Heaps optimization is the intended solution.
- Structural hints in the statement that match this family (Heaps).

### Hidden clues
- The problem can be reframed so the Two Heaps invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Two Heaps is the upgrade.
- The wording maps onto: two heaps, median, max heap, min heap, balance.

---

## 3. Brute Force Approach

### Intuition
Sort everything to get the k best — O(n log n) — or rescan repeatedly.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Two Heaps pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Two Heaps invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="twh-45" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Two heaps split around the median</text>
  <!-- divider -->
  <line x1="320" y1="44" x2="320" y2="200" stroke="#64748b" stroke-dasharray="4 4"/>
  <!-- left max-heap (lower half) -->
  <text x="128" y="58" text-anchor="middle" fill="#64748b">max-heap (lower half)</text>
  <line x1="128" y1="92" x2="93" y2="136" stroke="#475569"/>
  <line x1="128" y1="92" x2="163" y2="136" stroke="#475569"/>
  <circle cx="128" cy="78" r="20" fill="#ecfdf5" stroke="#059669"/><text x="128" y="83" text-anchor="middle" fill="#1e293b">3</text>
  <circle cx="93" cy="150" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="93" y="155" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="163" cy="150" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="163" y="155" text-anchor="middle" fill="#1e293b">2</text>
  <text x="128" y="200" text-anchor="middle" fill="#64748b">root 3 = max of lower</text>
  <!-- right min-heap (upper half) -->
  <text x="500" y="58" text-anchor="middle" fill="#64748b">min-heap (upper half)</text>
  <line x1="500" y1="92" x2="465" y2="136" stroke="#475569"/>
  <line x1="500" y1="92" x2="535" y2="136" stroke="#475569"/>
  <circle cx="500" cy="78" r="20" fill="#ecfdf5" stroke="#059669"/><text x="500" y="83" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="465" cy="150" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="465" y="155" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="535" cy="150" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="535" y="155" text-anchor="middle" fill="#1e293b">6</text>
  <text x="500" y="200" text-anchor="middle" fill="#64748b">root 4 = min of upper</text>
  <!-- median from the two roots -->
  <line x1="148" y1="78" x2="255" y2="78" stroke="#475569" marker-end="url(#twh-45)"/>
  <line x1="480" y1="78" x2="385" y2="78" stroke="#475569" marker-end="url(#twh-45)"/>
  <text x="320" y="74" text-anchor="middle" fill="#059669" font-weight="700">median</text>
  <text x="320" y="92" text-anchor="middle" fill="#1e293b">(3+4)/2 = 3.5</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Two Heaps         : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Two Heaps problem. I'll a heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians. That brings the complexity down to O(n log k) time and O(k) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Heaps** family template. Adapt the comparison/condition to the specific problem.

```go
// Top-K largest with a min-heap of size k (container/heap).
import "container/heap"
type MinHeap []int
func (h MinHeap) Len() int { return len(h) }
func (h MinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h MinHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MinHeap) Pop() any { old := *h; n := len(old); v := old[n-1]; *h = old[:n-1]; return v }

func topK(nums []int, k int) []int {
    h := &MinHeap{}
    for _, v := range nums {
        heap.Push(h, v)
        if h.Len() > k { heap.Pop(h) } // drop smallest, keep k largest
    }
    return *h
}
```

```python
import heapq
def top_k(nums, k):
    heap = []                        # min-heap of size k
    for v in nums:
        heapq.heappush(heap, v)
        if len(heap) > k:
            heapq.heappop(heap)      # evict smallest -> keep k largest
    return heap
```

```java
int[] topK(int[] nums, int k) {
    PriorityQueue<Integer> heap = new PriorityQueue<>(); // min-heap
    for (int v : nums) {
        heap.offer(v);
        if (heap.size() > k) heap.poll();
    }
    int[] res = new int[k];
    for (int i = 0; i < k; i++) res[i] = heap.poll();
    return res;
}
```

```cpp
vector<int> topK(vector<int>& nums, int k) {
    priority_queue<int, vector<int>, greater<int>> heap; // min-heap
    for (int v : nums) {
        heap.push(v);
        if ((int)heap.size() > k) heap.pop();
    }
    vector<int> res;
    while (!heap.empty()) { res.push_back(heap.top()); heap.pop(); }
    return res;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Two Heaps (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n log k)** |
| Time (best)  | — | **O(n log k)** |
| Time (average) | — | **O(n log k)** |
| Space | varies | **O(k)** |

> k-sized heap; pop/push is O(log k).

---

## 7. Common Mistakes

1. Using a max-heap when a min-heap of size k is what keeps the k largest.
2. Heap size growing to n instead of being capped at k.
3. Wrong comparator (min vs max) for the objective.
4. Two heaps: failing to rebalance sizes after each insert.
5. Two heaps: sign errors simulating a max-heap with a min-heap.
6. Forgetting tuple ordering for ties (e.g., (dist, point)).
7. Mutating heap-stored objects, breaking the heap invariant.
8. Popping all n for top-k instead of capping at k (O(n log n) vs O(n log k)).
9. Not handling k > n.
10. Median: returning the wrong heap top for even vs odd counts.

---

## 8. Interview Follow-Up Questions

1. **Q: Min-heap of size k vs sorting?**
   A: O(n log k) beats O(n log n) when k << n.

2. **Q: Kth largest in O(n) average?**
   A: Quickselect partitioning.

3. **Q: Two heaps for median?**
   A: Max-heap (low half) + min-heap (high half), balanced.

4. **Q: Merge k sorted lists?**
   A: Heap of the k current heads, O(N log k).

5. **Q: K closest points?**
   A: Heap by distance, size k.

6. **Q: Streaming top-k?**
   A: Maintain the size-k heap as data arrives.

7. **Q: Sliding-window median?**
   A: Two heaps + lazy deletion, or an ordered multiset.

8. **Q: Why O(1) peek?**
   A: The extreme is always at the root.

9. **Q: Stability with equal keys?**
   A: Add a secondary key (index) for deterministic order.

10. **Q: Heapify cost?**
   A: Building a heap from n items is O(n).

11. **Q: Task scheduler / CPU?**
   A: Greedy with a max-heap of frequencies.

12. **Q: IPO / max capital?**
   A: Two heaps: affordable projects by profit.

13. **Q: Decrease-key needed?**
   A: Use an indexed heap or lazy deletion.

14. **Q: Memory for huge n?**
   A: Heap stays O(k); good for bounded memory.

15. **Q: Top-k frequent?**
   A: Count then heap (or bucket sort) — O(n log k).

---

## 9. Solved Example 1

### Problem — Median Stream (LeetCode 295)
A representative **Two Heaps** problem. The signal: a max-heap + min-heap split keeps the median at the heaps' tops.

### Thought Process
1. Keep a max-heap `small` for the lower half and a min-heap `large` for the upper half.
2. On each insert, push to `small`, move its max into `large`, then rebalance so `small` never gets smaller than `large`.
3. The median is `small`'s top when sizes differ, else the average of both tops.

### Dry Run
add 1 → small=[1]. add 2 → small=[1], large=[2], median=(1+2)/2=1.5.
add 3 → push→balance → small=[2,1], large=[3], median=small top = 2.
Stream so far → medians 1, 1.5, 2.

### Visualization
```
input  ──▶ [ apply Two Heaps step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
import heapq
class MedianFinder:
    def __init__(self):
        self.small = []   # max-heap (values negated)
        self.large = []   # min-heap

    def addNum(self, num):
        heapq.heappush(self.small, -num)
        heapq.heappush(self.large, -heapq.heappop(self.small))
        if len(self.large) > len(self.small):
            heapq.heappush(self.small, -heapq.heappop(self.large))

    def findMedian(self):
        if len(self.small) > len(self.large):
            return float(-self.small[0])
        return (-self.small[0] + self.large[0]) / 2
```

### Complexity
Time O(log n) per insert, O(1) per query. Space O(n) across the two heaps.

## 10. Solved Example 2

### Problem — Sliding Median (LeetCode 480)
A representative **Two Heaps** problem. The signal: a max-heap + min-heap split keeps the median at the heaps' tops.

### Thought Process
1. A window's median needs order statistics under both insert and delete — a balanced multiset does both in O(log k).
2. Use a `SortedList`: slide by adding the incoming element and removing the outgoing one.
3. Read the median directly by index: middle element for odd k, average of the two middles for even k.

### Dry Run
nums=[1,3,-1,-3,5,3,6,7], k=3. Window [1,3,-1]→sorted[-1,1,3], median 1.
Slide → [3,-1,-3]→[-3,-1,3], median -1. Slide → [-1,-3,5]→[-3,-1,5], median -1.
Medians so far → 1, -1, -1, ...

### Visualization
```
input  ──▶ [ apply Two Heaps step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from sortedcontainers import SortedList
def medianSlidingWindow(nums, k):
    window = SortedList(nums[:k])
    res = []
    for i in range(k, len(nums) + 1):
        if k % 2:
            res.append(float(window[k // 2]))
        else:
            res.append((window[k // 2 - 1] + window[k // 2]) / 2)
        if i < len(nums):
            window.add(nums[i])
            window.remove(nums[i - k])
    return res
```

### Complexity
Time O(n log k), Space O(k). Each add/remove on the size-k ordered structure is O(log k).

## 11. Solved Example 3

### Problem — IPO (LeetCode 502)
A representative **Two Heaps** problem. The signal: a max-heap + min-heap split keeps the median at the heaps' tops.

### Thought Process
1. Sort projects by capital so cheaper-to-start ones unlock first (min-heap-by-capital behaviour).
2. As capital `w` grows, push every affordable project's profit into a max-heap.
3. Each of the k rounds greedily takes the highest available profit from the max-heap.

### Dry Run
k=2, w=0, profits=[1,2,3], capital=[0,1,1]. Sorted: (0,1),(1,2),(1,3).
Round1: affordable {1} → take 1 → w=1. Round2: affordable {2,3} → take 3 → w=4.
Answer → `4`.

### Visualization
```
input  ──▶ [ apply Two Heaps step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
import heapq
def findMaximizedCapital(k, w, profits, capital):
    projects = sorted(zip(capital, profits))     # ascending by capital
    available = []                               # max-heap of profits (negated)
    i = 0
    for _ in range(k):
        while i < len(projects) and projects[i][0] <= w:
            heapq.heappush(available, -projects[i][1])
            i += 1
        if not available:
            break
        w -= heapq.heappop(available)            # add best affordable profit
    return w
```

### Complexity
Time O(n log n), Space O(n). Sorting dominates; each project is pushed/popped at most once.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 295 | Median Stream | Easy | Core heaps application |
| 480 | Sliding Median | Easy | Core heaps application |
| 502 | IPO | Medium | Core heaps application |
| 1825 | Mean of Stream | Medium | Core heaps application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Top-K (size-k heap)**
- **K closest**
- **Two heaps (median)**
- **K-way merge**
- **Streaming median**

---

## 14. Production Engineering Applications

- **Scalability:** Heaps run priority schedulers (OS, Kubernetes), event simulations, Dijkstra routing, k-nearest-neighbor serving, and streaming top-k dashboards. Bounded heap size gives predictable memory under load.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(k)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Two Heaps logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Two Heaps (Heaps).
- **Signal:** two heaps, median, max heap, min heap, balance.
- **Move:** A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.
- **Cost:** O(n log k) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Two Heaps invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Two Heaps
FAMILY : Heaps (Advanced)
WHEN   : two heaps, median, max heap, min heap, balance
DO     : A heap gives O(1) access to the extreme element and O(log n) updates — perfect f
TIME   : O(n log k)    SPACE: O(k)
PRACTICE: 295, 480, 502, 1825
```

---

*Part of the DSA Patterns Handbook — pattern 45 of 100.*
