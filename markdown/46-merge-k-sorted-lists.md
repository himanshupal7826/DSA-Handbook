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

**The question this pattern keeps answering:** *"I have `k` sequences that are each already sorted — how do I combine them without throwing that away?"*

### Intuition
Dump everything into one array and sort it.

### Algorithm
1. Walk all `k` lists, collecting every value into one array of size `N`.
2. Sort the array.
3. Rebuild the answer from it.

### Complexity
- Time: **O(N log N)** where `N` is the total number of elements.
- Space: O(N).

### Drawbacks
- The inputs were **already sorted**, and we destroyed that structure just to rebuild it.
- It needs all `N` elements in memory at once — impossible when the lists are streams, or when `N` is enormous and you only need the first few values.

A second brute force — merge list 1 with list 2, then that with list 3, and so on — is also poor: the accumulated result gets re-walked every time, costing O(k·N).

---

## 4. Optimal Approach

### Core idea

One sentence:

> **The next smallest value overall is always at the front of one of the `k` lists — so keep just those `k` fronts in a min-heap and repeatedly take the winner.**

You never look at more than `k` candidates at a time, no matter how long the lists are.

### The thought process

```text
We need    : one sorted sequence from k sorted sequences.
Obvious way: concatenate and sort.
Wasteful   : throws away the sortedness we were given, and needs
             everything in memory.
Notice     : because each list is sorted, the global minimum can
             only be at the FRONT of some list. Never in the middle.
             So there are only k candidates at any moment.
Therefore  : keep the k fronts in a min-heap. Pop the winner, then
             push that list's next element in its place.
Now        : O(N log k) time and O(k) space, and it streams.
```

### Why the heap holds exactly `k` items

This is the invariant: **one entry per list — its current front.**

Pop the smallest, and that list's front advances by one, so you push its successor. The heap size stays at `k` (shrinking only as lists run out). That is why the cost per element is `log k`, not `log N`.

Crucially, the popped element **must** carry enough information to find its successor. In a linked list that's just `node.Next`. In a matrix it means storing `(value, row, col)` so you know where to look next. Forgetting to store the origin is the most common bug in this pattern.

### Steps

```text
Step 1 → Push the first element of every non-empty list into a min-heap.
          Each entry remembers which list it came from.
Step 2 → While the heap is non-empty:
Step 3 →     pop the smallest → append it to the output
Step 4 →     if that list has a next element, push it
Step 5 → The output is the fully merged sequence.
```

### Why O(N log k) beats O(N log N) — and when it matters

Every element is pushed once and popped once, on a heap capped at `k`:

```text
concatenate + sort   :  O(N log N),  needs all N in memory
heap merge           :  O(N log k),  needs only k in memory
```

With `k = 10` lists of a million elements each, `log k ≈ 3.3` versus `log N ≈ 23`. But the memory difference is the bigger win: the heap version works on infinite streams and can stop early after producing just the first few values — which is exactly what "kth smallest" problems need.

### The alternative: divide and conquer

Merging lists pairwise in a tournament — `k` lists → `k/2` → `k/4` → … — also gives **O(N log k)**, with O(1) extra space beyond the merge itself.

| | Heap | Divide and conquer |
|---|---|---|
| Time | O(N log k) | O(N log k) |
| Extra space | O(k) | O(1) iterative, O(log k) recursive |
| Streams / early exit | **yes** | no — needs all lists up front |
| Needs a comparator type | yes | no |

Use the heap when you need to stop early or the input streams; use divide and conquer when all data is present and you want minimal memory.

### The other face of this pattern: "kth smallest"

Many problems are secretly a k-way merge you stop early:

```text
kth smallest in k sorted lists       →  merge, stop after k pops
kth smallest in a sorted matrix      →  each row is a sorted list
smallest range covering all k lists  →  merge, and track the current max
                                        alongside the heap's min
```

That last one is worth noticing: the heap gives you the minimum of the current frontier for free, and tracking the maximum separately gives you the whole span in O(1).

### How should I recognize this?

```text
If you see...
  "merge k sorted ...", "k sorted lists / arrays / rows"
  "kth smallest in a sorted matrix"
  "smallest range covering elements from each list"
  several already-sorted inputs
        ↓
Think about...
  "The answer's next element is at the front of ONE of these.
   I only ever need k candidates."
        ↓
Use...
  min-heap of the k fronts, each entry remembering its origin
  (or divide-and-conquer pairwise merging when memory is tight)
```

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

```text
lists:   A: 1 → 4 → 5
         B: 1 → 3 → 4
         C: 2 → 6

heap holds one front per list:

  {1ᴬ, 1ᴮ, 2ᶜ}   pop 1ᴬ → push 4ᴬ    output: 1
  {1ᴮ, 2ᶜ, 4ᴬ}   pop 1ᴮ → push 3ᴮ    output: 1 1
  {2ᶜ, 3ᴮ, 4ᴬ}   pop 2ᶜ → push 6ᶜ    output: 1 1 2
  {3ᴮ, 4ᴬ, 6ᶜ}   pop 3ᴮ → push 4ᴮ    output: 1 1 2 3
   ...

never more than k = 3 candidates in play
```

### Interview explanation
"Each list is already sorted, so the next value in the merged output has to be at the front of one of them — there are only `k` candidates at any time. I'll put those `k` fronts in a min-heap, and each entry remembers which list it came from so I can push its successor after popping it. Every element is pushed and popped once on a heap of size `k`, giving O(N log k) time and O(k) space. That beats concatenate-and-sort's O(N log N), and more importantly it only ever holds `k` elements — so it works on streams and lets me stop early for a 'kth smallest' variant. Divide-and-conquer pairwise merging is the same time bound with O(1) space if I don't need early exit."

---

## 5. Generic Templates

> One heap entry per list, each remembering its origin so its successor can be found.

```go
// entry is one candidate: a value plus where it came from.
type entry struct {
    value    int
    listIdx  int // which list
    elemIdx  int // position within that list
}

type entryHeap []entry

func (h entryHeap) Len() int           { return len(h) }
func (h entryHeap) Less(i, j int) bool { return h[i].value < h[j].value } // min-heap
func (h entryHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *entryHeap) Push(x any)        { *h = append(*h, x.(entry)) }
func (h *entryHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

// MergeKSortedArrays merges k sorted slices into one sorted slice.
func MergeKSortedArrays(lists [][]int) []int {
    frontier := &entryHeap{}
    total := 0

    // Seed with the first element of every non-empty list.
    for i, list := range lists {
        total += len(list)
        if len(list) > 0 {
            *frontier = append(*frontier, entry{value: list[0], listIdx: i, elemIdx: 0})
        }
    }
    heap.Init(frontier)

    merged := make([]int, 0, total)
    for frontier.Len() > 0 {
        smallest := heap.Pop(frontier).(entry)
        merged = append(merged, smallest.value)

        // Replace it with the next element from the SAME list.
        nextIdx := smallest.elemIdx + 1
        if nextIdx < len(lists[smallest.listIdx]) {
            heap.Push(frontier, entry{
                value:   lists[smallest.listIdx][nextIdx],
                listIdx: smallest.listIdx,
                elemIdx: nextIdx,
            })
        }
    }
    return merged
}

// MergeTwoSorted is the building block for the divide-and-conquer variant.
func MergeTwoSorted(a, b []int) []int {
    out := make([]int, 0, len(a)+len(b))
    i, j := 0, 0
    for i < len(a) && j < len(b) {
        if a[i] <= b[j] {
            out = append(out, a[i])
            i++
        } else {
            out = append(out, b[j])
            j++
        }
    }
    out = append(out, a[i:]...)
    out = append(out, b[j:]...)
    return out
}
```

```python
import heapq

def merge_k_sorted_arrays(lists):
    """Min-heap of the k fronts; each entry remembers its origin."""
    frontier = []
    for list_idx, values in enumerate(lists):
        if values:
            # (value, which list, position in that list)
            frontier.append((values[0], list_idx, 0))
    heapq.heapify(frontier)

    merged = []
    while frontier:
        value, list_idx, elem_idx = heapq.heappop(frontier)
        merged.append(value)

        next_idx = elem_idx + 1                  # successor from the SAME list
        if next_idx < len(lists[list_idx]):
            heapq.heappush(frontier, (lists[list_idx][next_idx], list_idx, next_idx))
    return merged

def merge_two_sorted(a, b):
    """Building block for the divide-and-conquer variant."""
    out, i, j = [], 0, 0
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            out.append(a[i]); i += 1
        else:
            out.append(b[j]); j += 1
    out.extend(a[i:])
    out.extend(b[j:])
    return out
```

```java
import java.util.*;

public class MergeKSorted {
    public static List<Integer> mergeKSortedArrays(int[][] lists) {
        // int[]{value, listIdx, elemIdx}
        PriorityQueue<int[]> frontier =
            new PriorityQueue<>((a, b) -> Integer.compare(a[0], b[0]));

        for (int i = 0; i < lists.length; i++)
            if (lists[i].length > 0) frontier.add(new int[]{lists[i][0], i, 0});

        List<Integer> merged = new ArrayList<>();
        while (!frontier.isEmpty()) {
            int[] smallest = frontier.poll();
            merged.add(smallest[0]);

            int listIdx = smallest[1], nextIdx = smallest[2] + 1;
            if (nextIdx < lists[listIdx].length)
                frontier.add(new int[]{lists[listIdx][nextIdx], listIdx, nextIdx});
        }
        return merged;
    }
}
```

```cpp
#include <queue>
#include <tuple>
#include <vector>
using namespace std;

vector<int> mergeKSortedArrays(const vector<vector<int>>& lists) {
    // (value, listIdx, elemIdx); greater<> makes it a MIN-heap.
    using Entry = tuple<int, int, int>;
    priority_queue<Entry, vector<Entry>, greater<Entry>> frontier;

    for (int i = 0; i < (int)lists.size(); ++i)
        if (!lists[i].empty()) frontier.emplace(lists[i][0], i, 0);

    vector<int> merged;
    while (!frontier.empty()) {
        auto [value, listIdx, elemIdx] = frontier.top();
        frontier.pop();
        merged.push_back(value);

        int nextIdx = elemIdx + 1;               // successor from the SAME list
        if (nextIdx < (int)lists[listIdx].size())
            frontier.emplace(lists[listIdx][nextIdx], listIdx, nextIdx);
    }
    return merged;
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

### Problem — Merge k Sorted Lists (LeetCode 23)
Merge `k` sorted linked lists into one sorted linked list.

### Thought Process
1. Each list is sorted, so the smallest unmerged value is at the head of one of them — only `k` candidates at any moment.
2. Put those `k` heads in a min-heap ordered by node value.
3. Pop the smallest, attach it to the output, then push **that node's `Next`** — the linked list itself remembers the origin, so no index bookkeeping is needed.
4. Use a dummy head node so appending never needs a "is this the first one?" branch.
5. Stop when the heap empties.

### Dry Run

Input: `lists = [[1,4,5], [1,3,4], [2,6]]` — call them A, B, C

| step | heap (values) | pop | push next | output so far |
|------|---------------|-----|-----------|---------------|
| seed | `1ᴬ, 1ᴮ, 2ᶜ` | — | — | — |
| 1 | `1ᴬ, 1ᴮ, 2ᶜ` | `1ᴬ` | `4ᴬ` | `1` |
| 2 | `1ᴮ, 2ᶜ, 4ᴬ` | `1ᴮ` | `3ᴮ` | `1 1` |
| 3 | `2ᶜ, 3ᴮ, 4ᴬ` | `2ᶜ` | `6ᶜ` | `1 1 2` |
| 4 | `3ᴮ, 4ᴬ, 6ᶜ` | `3ᴮ` | `4ᴮ` | `1 1 2 3` |
| 5 | `4ᴬ, 4ᴮ, 6ᶜ` | `4ᴬ` | `5ᴬ` | `1 1 2 3 4` |
| 6 | `4ᴮ, 5ᴬ, 6ᶜ` | `4ᴮ` | — (B exhausted) | `1 1 2 3 4 4` |
| 7 | `5ᴬ, 6ᶜ` | `5ᴬ` | — (A exhausted) | `1 1 2 3 4 4 5` |
| 8 | `6ᶜ` | `6ᶜ` | — (C exhausted) | `1 1 2 3 4 4 5 6` |

Output: **`[1, 1, 2, 3, 4, 4, 5, 6]`** ✓

The heap never exceeded 3 entries, even though 8 elements passed through it. That is the O(k) space bound in action.

### Visualization

```text
A:  1 → 4 → 5
B:  1 → 3 → 4          heap holds one head per list
C:  2 → 6

  {1ᴬ 1ᴮ 2ᶜ} ──pop 1ᴬ──▶ push 4ᴬ    output: 1
  {1ᴮ 2ᶜ 4ᴬ} ──pop 1ᴮ──▶ push 3ᴮ    output: 1 1
  {2ᶜ 3ᴮ 4ᴬ} ──pop 2ᶜ──▶ push 6ᶜ    output: 1 1 2
                 ...
```

### Code

```go
// nodeHeap is a min-heap of list nodes ordered by value.
type nodeHeap []*ListNode

func (h nodeHeap) Len() int           { return len(h) }
func (h nodeHeap) Less(i, j int) bool { return h[i].Val < h[j].Val }
func (h nodeHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *nodeHeap) Push(x any)        { *h = append(*h, x.(*ListNode)) }
func (h *nodeHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

func mergeKLists(lists []*ListNode) *ListNode {
    frontier := &nodeHeap{}

    // Seed with the head of every non-empty list.
    for _, head := range lists {
        if head != nil {
            *frontier = append(*frontier, head)
        }
    }
    heap.Init(frontier)

    // A dummy head removes the "is this the first node?" branch.
    dummy := &ListNode{}
    tail := dummy

    for frontier.Len() > 0 {
        smallest := heap.Pop(frontier).(*ListNode)
        tail.Next = smallest
        tail = tail.Next

        // The node itself remembers its origin: just push its successor.
        if smallest.Next != nil {
            heap.Push(frontier, smallest.Next)
        }
    }

    tail.Next = nil // detach any leftover links from the input
    return dummy.Next
}
```

```python
import heapq

def mergeKLists(lists):
    frontier = []
    for i, head in enumerate(lists):
        if head:
            # i breaks ties: ListNode is not comparable in Python.
            heapq.heappush(frontier, (head.val, i, head))

    dummy = ListNode()
    tail = dummy
    while frontier:
        _, i, node = heapq.heappop(frontier)
        tail.next = node
        tail = tail.next
        if node.next:
            heapq.heappush(frontier, (node.next.val, i, node.next))

    tail.next = None
    return dummy.next
```

### Complexity
Time **O(N log k)** for `N` total nodes — each is pushed and popped once on a heap of size ≤ `k`. Space **O(k)**.

---

## 10. Solved Example 2

### Problem — Kth Smallest Element in a Sorted Matrix (LeetCode 378)
Each row **and** each column of an `n × n` matrix is sorted ascending. Return the `k`-th smallest element.

### Thought Process
1. Read the matrix as `n` sorted lists — one per row. Now it is exactly a k-way merge.
2. But we don't need the full merge: we only need the `k`-th value, so **stop after `k` pops**.
3. Seed the heap with the first element of each row: `(value, row, col)`. The `col` is what lets us find the successor.
4. Pop `k` times; after each pop, push the next element from the **same row** if one exists.
5. The `k`-th popped value is the answer. Only `k` pops happen, so we never touch most of the matrix.

Note we only use the *rows* being sorted. Column sortedness is what makes the alternative binary-search-on-value approach work.

### Dry Run

Input: `matrix = [[1,5,9], [10,11,13], [12,13,15]]`, `k = 8`

| pop # | heap before (value@row,col) | popped | push next from that row | heap after |
|-------|------------------------------|--------|--------------------------|------------|
| seed | — | — | — | `1@0,0  10@1,0  12@2,0` |
| 1 | `1, 10, 12`  | **1**  | `5@0,1`  | `5, 10, 12` |
| 2 | `5, 10, 12`  | **5**  | `9@0,2`  | `9, 10, 12` |
| 3 | `9, 10, 12`  | **9**  | row 0 exhausted | `10, 12` |
| 4 | `10, 12`     | **10** | `11@1,1` | `11, 12` |
| 5 | `11, 12`     | **11** | `13@1,2` | `12, 13` |
| 6 | `12, 13`     | **12** | `13@2,1` | `13, 13` |
| 7 | `13, 13`     | **13** (row 1) | row 1 exhausted | `13@2,1` |
| 8 | `13`         | **13** (row 2) | `15@2,2` | `15` |

Output: **13** ✓

Cross-check by flattening: `[1,5,9,10,11,12,13,13,15]` — the 8th smallest is `13`. ✓

The heap held at most 3 entries and we never looked at `15` until the final push. With a large matrix and small `k`, most of the data is never read.

### Visualization

```text
matrix rows are k sorted lists:

  row 0:   1    5    9
  row 1:  10   11   13
  row 2:  12   13   15

heap keeps one front per row and advances only the row that just won:

  {1, 10, 12} → pop 1  → {5, 10, 12}  → pop 5  → {9, 10, 12} → ...

stop after k = 8 pops → 13
```

### Code

```go
// cell is one candidate from the matrix: a value and where it came from.
type cell struct {
    value int
    row   int
    col   int
}

type cellHeap []cell

func (h cellHeap) Len() int           { return len(h) }
func (h cellHeap) Less(i, j int) bool { return h[i].value < h[j].value }
func (h cellHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *cellHeap) Push(x any)        { *h = append(*h, x.(cell)) }
func (h *cellHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

func kthSmallest(matrix [][]int, k int) int {
    n := len(matrix)

    // Seed with the first element of each row. Only n rows can matter,
    // and never more than k of them.
    frontier := &cellHeap{}
    for row := 0; row < n && row < k; row++ {
        *frontier = append(*frontier, cell{value: matrix[row][0], row: row, col: 0})
    }
    heap.Init(frontier)

    result := 0
    for popped := 0; popped < k; popped++ {
        smallest := heap.Pop(frontier).(cell)
        result = smallest.value

        // Advance only the row that just won.
        if smallest.col+1 < len(matrix[smallest.row]) {
            heap.Push(frontier, cell{
                value: matrix[smallest.row][smallest.col+1],
                row:   smallest.row,
                col:   smallest.col + 1,
            })
        }
    }
    return result
}
```

```python
import heapq

def kthSmallest(matrix, k):
    n = len(matrix)
    # (value, row, col) — col is what lets us find the successor.
    frontier = [(matrix[row][0], row, 0) for row in range(min(n, k))]
    heapq.heapify(frontier)

    result = 0
    for _ in range(k):
        result, row, col = heapq.heappop(frontier)
        if col + 1 < len(matrix[row]):          # advance only the winning row
            heapq.heappush(frontier, (matrix[row][col + 1], row, col + 1))
    return result
```

### Complexity
Time **O(k log n)** — `k` pops on a heap of at most `n` entries. Space O(n).

> There is also an O(n log(max − min)) binary-search-on-value solution that counts how many elements are ≤ a candidate. It wins when `k` is close to `n²`, and it is the one that genuinely needs the columns to be sorted too.

---

## 11. Solved Example 3

### Problem — Smallest Range Covering Elements from K Lists (LeetCode 632)
Given `k` sorted lists, find the smallest range `[a, b]` that contains at least one number from **each** list.

### Thought Process
1. A valid range must span one element from every list. Consider a "frontier" of exactly one element per list — the range `[min, max]` of that frontier is always valid.
2. The heap gives the frontier's **minimum** for free. Track the frontier's **maximum** in a plain variable as we push.
3. To shrink the range we must raise the minimum — and the only way is to advance the list that currently owns it. So: pop the min, push its successor, update the max.
4. Record `[min, max]` before each advance, keeping the smallest span seen.
5. Stop as soon as any list runs out — from then on no frontier covering all `k` lists exists.

### Dry Run

Input: `nums = [[4,10,15,24,26], [0,9,12,20], [5,18,22,30]]` — lists A, B, C

| step | frontier (value from each list) | min | max | span | best so far |
|------|--------------------------------|-----|-----|------|-------------|
| seed | `4ᴬ, 0ᴮ, 5ᶜ` | 0 | 5 | 5 | **[0,5]** |
| 1 | pop `0ᴮ`, push `9ᴮ` → `4ᴬ, 9ᴮ, 5ᶜ` | 4 | 9 | 5 | [0,5] (tie, keep first) |
| 2 | pop `4ᴬ`, push `10ᴬ` → `10ᴬ, 9ᴮ, 5ᶜ` | 5 | 10 | 5 | [0,5] |
| 3 | pop `5ᶜ`, push `18ᶜ` → `10ᴬ, 9ᴮ, 18ᶜ` | 9 | 18 | 9 | [0,5] |
| 4 | pop `9ᴮ`, push `12ᴮ` → `10ᴬ, 12ᴮ, 18ᶜ` | 10 | 18 | 8 | [0,5] |
| 5 | pop `10ᴬ`, push `15ᴬ` → `15ᴬ, 12ᴮ, 18ᶜ` | 12 | 18 | 6 | [0,5] |
| 6 | pop `12ᴮ`, push `20ᴮ` → `15ᴬ, 20ᴮ, 18ᶜ` | 15 | 20 | 5 | [0,5] |
| 7 | pop `15ᴬ`, push `24ᴬ` → `24ᴬ, 20ᴮ, 18ᶜ` | 18 | 24 | 6 | [0,5] |
| 8 | pop `18ᶜ`, push `22ᶜ` → `24ᴬ, 20ᴮ, 22ᶜ` | 20 | 24 | **4** | **[20,24]** ★ |
| 9 | pop `20ᴮ` → list B is exhausted | — | — | — | stop |

Output: **`[20, 24]`** ✓

Verify: `24 ∈ A`, `20 ∈ B`, `22 ∈ C` — all three lists are represented, and the span is 4.

Step 9 is the stopping rule: once B has no successor, every future frontier would be missing a B element, so no smaller valid range can exist.

### Visualization

```text
A:  4   10   15   24   26
B:  0    9   12   20
C:  5   18   22   30

frontier at step 8:      A=24   B=20   C=22
                                ↑           ↑
                             min=20      max=24     span = 4  ★

the heap supplies min; max is tracked as we push
```

### Code

```go
// item is one frontier element plus where it came from.
type item struct {
    value   int
    listIdx int
    elemIdx int
}

type itemHeap []item

func (h itemHeap) Len() int           { return len(h) }
func (h itemHeap) Less(i, j int) bool { return h[i].value < h[j].value }
func (h itemHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *itemHeap) Push(x any)        { *h = append(*h, x.(item)) }
func (h *itemHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

func smallestRange(nums [][]int) []int {
    frontier := &itemHeap{}
    currentMax := math.MinInt32

    // Seed with one element from every list.
    for i, list := range nums {
        *frontier = append(*frontier, item{value: list[0], listIdx: i, elemIdx: 0})
        if list[0] > currentMax {
            currentMax = list[0]
        }
    }
    heap.Init(frontier)

    bestStart, bestEnd := math.MinInt32, math.MaxInt32

    for {
        smallest := (*frontier)[0]

        // The frontier covers every list, so [min, max] is a valid range.
        if currentMax-smallest.value < bestEnd-bestStart {
            bestStart, bestEnd = smallest.value, currentMax
        }

        // The only way to shrink the range is to raise the minimum.
        nextIdx := smallest.elemIdx + 1
        if nextIdx == len(nums[smallest.listIdx]) {
            break // this list is exhausted: no future frontier covers all lists
        }

        nextValue := nums[smallest.listIdx][nextIdx]
        heap.Pop(frontier)
        heap.Push(frontier, item{
            value:   nextValue,
            listIdx: smallest.listIdx,
            elemIdx: nextIdx,
        })
        if nextValue > currentMax {
            currentMax = nextValue
        }
    }

    return []int{bestStart, bestEnd}
}
```

```python
import heapq

def smallestRange(nums):
    # (value, list index, element index)
    frontier = [(values[0], i, 0) for i, values in enumerate(nums)]
    heapq.heapify(frontier)
    current_max = max(values[0] for values in nums)

    best = [float("-inf"), float("inf")]

    while True:
        value, list_idx, elem_idx = frontier[0]

        # The frontier covers every list, so [value, current_max] is valid.
        if current_max - value < best[1] - best[0]:
            best = [value, current_max]

        next_idx = elem_idx + 1
        if next_idx == len(nums[list_idx]):
            break                       # this list is exhausted

        next_value = nums[list_idx][next_idx]
        heapq.heapreplace(frontier, (next_value, list_idx, next_idx))
        current_max = max(current_max, next_value)

    return best
```

### Complexity
Time **O(N log k)** where `N` is the total number of elements — each is pushed and popped at most once. Space O(k).

---

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
