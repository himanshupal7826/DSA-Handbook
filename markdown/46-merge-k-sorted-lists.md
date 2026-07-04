# 46 · Merge K Sorted Lists

> **One-liner:** A k-element min-heap merges k sorted sequences in O(N log k).

---

## 1. Overview

### Definition
The **Merge K Sorted Lists** pattern belongs to the *Heaps* family. A k-element min-heap merges k sorted sequences in O(N log k).

### Intuition
A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Why it works
Maintain a size-k heap (or two heaps) so each insertion is O(log k) and the best/median is at the top. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Heaps run priority schedulers (OS, Kubernetes), event simulations, Dijkstra routing, k-nearest-neighbor serving, and streaming top-k dashboards. Bounded heap size gives predictable memory under load.

---

## 2. Recognition Signals

### Keywords
merge k, sorted lists, heap, k way merge, priority queue.

### Constraints
- Input size where the brute-force complexity would time out — the Merge K Sorted Lists optimization is the intended solution.
- Structural hints in the statement that match this family (Heaps).

### Hidden clues
- The problem can be reframed so the Merge K Sorted Lists invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Merge K Sorted Lists is the upgrade.
- The wording maps onto: merge k, sorted lists, heap, k way merge, priority queue.

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
Redundant recomputation; does not exploit the structure the Merge K Sorted Lists pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Merge K Sorted Lists invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="mkl-46" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Min-heap pulls the smallest head across k sorted lists</text>
  <!-- k lists, heads highlighted -->
  <g font-size="12">
    <rect x="20" y="52" width="30" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="35" y="70" text-anchor="middle" fill="#1e293b">1</text>
    <line x1="52" y1="65" x2="66" y2="65" stroke="#475569" marker-end="url(#mkl-46)"/>
    <rect x="68" y="52" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="83" y="70" text-anchor="middle" fill="#1e293b">4</text>
    <line x1="100" y1="65" x2="114" y2="65" stroke="#475569" marker-end="url(#mkl-46)"/>
    <rect x="116" y="52" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="131" y="70" text-anchor="middle" fill="#1e293b">7</text>
    <rect x="20" y="102" width="30" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="35" y="120" text-anchor="middle" fill="#1e293b">2</text>
    <line x1="52" y1="115" x2="66" y2="115" stroke="#475569" marker-end="url(#mkl-46)"/>
    <rect x="68" y="102" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="83" y="120" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="20" y="152" width="30" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="35" y="170" text-anchor="middle" fill="#1e293b">3</text>
    <line x1="52" y1="165" x2="66" y2="165" stroke="#475569" marker-end="url(#mkl-46)"/>
    <rect x="68" y="152" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="83" y="170" text-anchor="middle" fill="#1e293b">6</text>
    <line x1="100" y1="165" x2="114" y2="165" stroke="#475569" marker-end="url(#mkl-46)"/>
    <rect x="116" y="152" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="131" y="170" text-anchor="middle" fill="#1e293b">8</text>
  </g>
  <text x="90" y="200" text-anchor="middle" fill="#64748b">k sorted lists (heads shaded)</text>
  <!-- heap of heads -->
  <line x1="170" y1="115" x2="255" y2="115" stroke="#475569" marker-end="url(#mkl-46)"/>
  <text x="360" y="52" text-anchor="middle" fill="#64748b">min-heap of current heads</text>
  <line x1="360" y1="94" x2="325" y2="136" stroke="#475569"/>
  <line x1="360" y1="94" x2="395" y2="136" stroke="#475569"/>
  <circle cx="360" cy="80" r="20" fill="#ecfdf5" stroke="#059669"/><text x="360" y="85" text-anchor="middle" fill="#1e293b">1</text>
  <circle cx="325" cy="150" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="325" y="155" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="395" cy="150" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="395" y="155" text-anchor="middle" fill="#1e293b">3</text>
  <text x="360" y="200" text-anchor="middle" fill="#64748b">pop 1, push its next 4</text>
  <!-- output -->
  <line x1="418" y1="80" x2="470" y2="80" stroke="#475569" marker-end="url(#mkl-46)"/>
  <text x="560" y="60" text-anchor="middle" fill="#64748b">merged output</text>
  <rect x="480" y="70" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="495" y="88" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="514" y="70" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb" stroke-dasharray="3 3"/><text x="529" y="88" text-anchor="middle" fill="#64748b">2</text>
  <rect x="548" y="70" width="30" height="26" rx="6" fill="#eff6ff" stroke="#2563eb" stroke-dasharray="3 3"/><text x="563" y="88" text-anchor="middle" fill="#64748b">3</text>
  <text x="560" y="120" text-anchor="middle" fill="#64748b">smallest emitted first</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Merge K Sorted Lis: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Merge K Sorted Lists problem. I'll a heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians. That brings the complexity down to O(n log k) time and O(k) space — here's the template."

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

| Metric | Brute Force | Merge K Sorted Lists (Optimal) |
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

### Problem — Merge K Lists (LeetCode 23)
A representative **Merge K Sorted Lists** problem. The signal: a k-element min-heap merges k sorted sequences in o(n log k).

### Thought Process
1. Confirm the pattern via its recognition signals (merge k, sorted lists, heap, k way merge, priority queue).
2. Reach for the Merge K Sorted Lists template below and map the problem's entities onto it.
3. A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Merge K Sorted Lists step-by-step ]
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

### Problem — Kth Sorted Matrix (LeetCode 378)
A representative **Merge K Sorted Lists** problem. The signal: a k-element min-heap merges k sorted sequences in o(n log k).

### Thought Process
1. Confirm the pattern via its recognition signals (merge k, sorted lists, heap, k way merge, priority queue).
2. Reach for the Merge K Sorted Lists template below and map the problem's entities onto it.
3. A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Merge K Sorted Lists step-by-step ]
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

### Problem — Smallest Range (LeetCode 632)
A representative **Merge K Sorted Lists** problem. The signal: a k-element min-heap merges k sorted sequences in o(n log k).

### Thought Process
1. Confirm the pattern via its recognition signals (merge k, sorted lists, heap, k way merge, priority queue).
2. Reach for the Merge K Sorted Lists template below and map the problem's entities onto it.
3. A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Merge K Sorted Lists step-by-step ]
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
| 23 | Merge K Lists | Easy | Core heaps application |
| 378 | Kth Sorted Matrix | Easy | Core heaps application |
| 632 | Smallest Range | Medium | Core heaps application |
| 373 | K Pairs | Medium | Core heaps application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Merge K Sorted Lists logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Merge K Sorted Lists (Heaps).
- **Signal:** merge k, sorted lists, heap, k way merge, priority queue.
- **Move:** A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.
- **Cost:** O(n log k) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Merge K Sorted Lists invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Merge K Sorted Lists
FAMILY : Heaps (Advanced)
WHEN   : merge k, sorted lists, heap, k way merge, priority queue
DO     : A heap gives O(1) access to the extreme element and O(log n) updates — perfect f
TIME   : O(n log k)    SPACE: O(k)
PRACTICE: 23, 378, 632, 373
```

---

*Part of the DSA Patterns Handbook — pattern 46 of 100.*
