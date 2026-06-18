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
1. Confirm the pattern via its recognition signals (two heaps, median, max heap, min heap, balance).
2. Reach for the Two Heaps template below and map the problem's entities onto it.
3. A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Two Heaps step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n log k), Space O(k). k-sized heap; pop/push is O(log k).

## 10. Solved Example 2

### Problem — Sliding Median (LeetCode 480)
A representative **Two Heaps** problem. The signal: a max-heap + min-heap split keeps the median at the heaps' tops.

### Thought Process
1. Confirm the pattern via its recognition signals (two heaps, median, max heap, min heap, balance).
2. Reach for the Two Heaps template below and map the problem's entities onto it.
3. A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Two Heaps step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n log k), Space O(k). k-sized heap; pop/push is O(log k).

## 11. Solved Example 3

### Problem — IPO (LeetCode 502)
A representative **Two Heaps** problem. The signal: a max-heap + min-heap split keeps the median at the heaps' tops.

### Thought Process
1. Confirm the pattern via its recognition signals (two heaps, median, max heap, min heap, balance).
2. Reach for the Two Heaps template below and map the problem's entities onto it.
3. A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Two Heaps step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n log k), Space O(k). k-sized heap; pop/push is O(log k).


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
