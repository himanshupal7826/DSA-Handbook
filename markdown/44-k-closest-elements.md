# 44 · K Closest Elements

> **One-liner:** Heap (or binary search) selects the k nearest items by distance.

---

## 1. Overview

### Definition
The **K Closest Elements** pattern belongs to the *Heaps* family. Heap (or binary search) selects the k nearest items by distance.

### Intuition
A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Why it works
Maintain a size-k heap (or two heaps) so each insertion is O(log k) and the best/median is at the top. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Heaps run priority schedulers (OS, Kubernetes), event simulations, Dijkstra routing, k-nearest-neighbor serving, and streaming top-k dashboards. Bounded heap size gives predictable memory under load.

---

## 2. Recognition Signals

### Keywords
k closest, heap, distance, origin, binary search.

### Constraints
- Input size where the brute-force complexity would time out — the K Closest Elements optimization is the intended solution.
- Structural hints in the statement that match this family (Heaps).

### Hidden clues
- The problem can be reframed so the K Closest Elements invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — K Closest Elements is the upgrade.
- The wording maps onto: k closest, heap, distance, origin, binary search.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which `k` items are closest to some reference point?"*

### Intuition
Measure every item's distance, sort by it, take the first `k`.

### Algorithm
1. Compute each item's distance from the reference.
2. Sort all `n` items by that distance.
3. Return the first `k`.

### Complexity
- Time: **O(n log n)** — the sort dominates.
- Space: O(n).

### Drawbacks
- We fully ordered all `n` items when the answer only needs `k` of them — and doesn't even care in what order those `k` come out.
- Worse, sorting requires holding all `n` items at once. If the data is a **stream** of a billion points and `k = 10`, that's impossible.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Keep a heap of exactly `k` items and evict the worst one each time something better arrives.**

The heap becomes a "top-k so far" container of fixed size. You never store more than `k` items, and you never sort anything fully.

### The thought process

```text
We need    : the k closest items out of n.
Obvious way: sort everything by distance, take k.
Wasteful   : we ordered all n items to use only k, and we needed
             all n in memory at once.
Notice     : at any moment we only care about the k best SO FAR,
             plus one number: how good the worst of those k is.
Therefore  : keep a heap of size k whose top is the WORST of the k.
             A new item either beats that worst one (swap) or is
             discarded immediately.
Now        : O(n log k) time, O(k) space, and it works on a stream.
```

### The counter-intuitive part: which heap do I use?

To keep the `k` **closest** items, use a **max-heap** on distance.

That feels backwards, so make it concrete. The heap's top is the item you are willing to throw away — so the top must be the **worst** item you are currently keeping:

```text
keeping the k SMALLEST  →  the worst kept item is the LARGEST  →  max-heap
keeping the k LARGEST   →  the worst kept item is the SMALLEST →  min-heap
```

The rule: **the heap type is the opposite of what you are keeping.** The top is your eviction candidate, and comparing against it is O(1) — that single comparison is what lets you reject most items without any heap work at all.

### Steps

```text
Step 1 → Create a max-heap ordered by distance.
Step 2 → For each item:
Step 3 →     if heap.size < k:  push it
Step 4 →     else if distance(item) < heap.top.distance:
Step 5 →         pop the top (the worst kept), push the new item
Step 6 →     else: discard it — it cannot be in the answer
Step 7 → The heap now holds the k closest, in no particular order.
```

### Why O(n log k) and not O(n log n)

Every item costs at most one push and one pop on a heap that **never exceeds size `k`**, so each operation is `log k`, not `log n`. When `k` is small and `n` is huge — "top 10 of a billion" — that is the difference between practical and impossible.

Also worth saying out loud in an interview: the output is **unordered**. If the problem wants the `k` closest *sorted*, add an O(k log k) sort at the end; it doesn't change the overall complexity.

### When a heap is the wrong tool

Two common cases beat it:

| Situation | Better tool | Why |
|---|---|---|
| Input is **sorted** and you want `k` closest to a value | binary search + two pointers, or binary search on the window's left edge | **O(log n + k)** — sortedness already localises the answer |
| You need the `k` closest but may reorder the input | **Quickselect** | O(n) average, no heap at all |

The heap wins when the data is unsorted **and** streaming, or when you must not disturb the input. Say which one applies before you start coding.

### How should I recognize this?

```text
If you see...
  "k closest / k smallest / k largest / top k"
  "k most frequent", "kth from the ..."
  a huge n with a small k, or a stream
        ↓
Think about...
  "Do I need all n ordered, or just the best k?"
  "What is the worst item I'm currently keeping?"
        ↓
Use...
  unsorted + streaming → heap of size k (opposite type to what you keep)
  sorted input         → binary search + two pointers, O(log n + k)
  may reorder, offline → quickselect, O(n) average
```

### Visual explanation

```svg
<svg viewBox="0 0 640 235" width="100%" height="235" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="kcl-44" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Max-heap of size k=3 by distance; root = farthest, evicted by closer</text>
  <!-- before -->
  <text x="128" y="56" text-anchor="middle" fill="#64748b">before</text>
  <line x1="128" y1="90" x2="95" y2="132" stroke="#475569"/>
  <line x1="128" y1="90" x2="161" y2="132" stroke="#475569"/>
  <circle cx="128" cy="76" r="20" fill="#fff7ed" stroke="#d97706"/><text x="128" y="81" text-anchor="middle" fill="#1e293b">d=9</text>
  <circle cx="95" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="95" y="151" text-anchor="middle" fill="#1e293b">d=4</text>
  <circle cx="161" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="161" y="151" text-anchor="middle" fill="#1e293b">d=6</text>
  <text x="128" y="196" text-anchor="middle" fill="#64748b">root d=9 = farthest kept</text>
  <!-- new element -->
  <line x1="200" y1="146" x2="268" y2="146" stroke="#475569" marker-end="url(#kcl-44)"/>
  <rect x="272" y="62" width="96" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="320" y="84" text-anchor="middle" fill="#1e293b">new d=3</text>
  <text x="320" y="120" text-anchor="middle" fill="#059669">3 &lt; root 9</text>
  <text x="320" y="138" text-anchor="middle" fill="#64748b">pop d=9, push d=3, sift down</text>
  <line x1="372" y1="146" x2="418" y2="146" stroke="#475569" marker-end="url(#kcl-44)"/>
  <!-- after -->
  <text x="500" y="56" text-anchor="middle" fill="#64748b">after</text>
  <line x1="500" y1="90" x2="467" y2="132" stroke="#475569"/>
  <line x1="500" y1="90" x2="533" y2="132" stroke="#475569"/>
  <circle cx="500" cy="76" r="20" fill="#ecfdf5" stroke="#059669"/><text x="500" y="81" text-anchor="middle" fill="#1e293b">d=6</text>
  <circle cx="467" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="467" y="151" text-anchor="middle" fill="#1e293b">d=4</text>
  <circle cx="533" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="533" y="151" text-anchor="middle" fill="#1e293b">d=3</text>
  <text x="500" y="196" text-anchor="middle" fill="#64748b">new farthest d=6</text>
</svg>
```

```text
points, keeping the k=2 closest to the origin

incoming: (1,3) d=10   (-2,2) d=8   (5,8) d=89   (0,1) d=1

max-heap by distance (top = worst kept):

  push (1,3)          heap: [10]
  push (-2,2)         heap: [10, 8]      top = 10
  (5,8) d=89 vs 10    89 > 10 → DISCARD immediately, no heap work
  (0,1) d=1  vs 10    1 < 10  → pop 10, push 1

  heap: [8, 1]  →  the two closest are (-2,2) and (0,1)
```

### Interview explanation
"I don't need all `n` items ordered — only the best `k`, and not even in order. So I'll keep a heap of size `k`. Since I'm keeping the `k` *closest*, the heap is a **max**-heap on distance: its top is the worst item I'm currently keeping, which is exactly the one to evict. That makes the reject test a single O(1) comparison, so far-away points cost nothing. Each item is at most one push and one pop on a size-`k` heap, giving O(n log k) time and O(k) space — and it works on a stream, which sorting cannot. If the input were sorted I'd use binary search plus two pointers for O(log n + k) instead."

---

## 5. Generic Templates

> Heap of size `k`, type **opposite** to what you're keeping. Compare against the top before doing any heap work.

```go
// maxDistHeap keeps the worst (largest-distance) item at the top so it is
// the natural eviction candidate.
type scored struct {
    value    int
    distance int
}

type maxDistHeap []scored

func (h maxDistHeap) Len() int            { return len(h) }
func (h maxDistHeap) Less(i, j int) bool  { return h[i].distance > h[j].distance } // max-heap
func (h maxDistHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *maxDistHeap) Push(x any)         { *h = append(*h, x.(scored)) }
func (h *maxDistHeap) Pop() any {
    old := *h
    n := len(old)
    last := old[n-1]
    *h = old[:n-1]
    return last
}

// KClosest keeps the k items with the smallest distance, in O(n log k).
func KClosest(values []int, k int, distance func(int) int) []int {
    if k <= 0 {
        return nil
    }

    worst := &maxDistHeap{}
    heap.Init(worst)

    for _, v := range values {
        d := distance(v)

        if worst.Len() < k {
            heap.Push(worst, scored{value: v, distance: d})
            continue
        }
        // O(1) rejection: the top is the worst item we currently keep.
        if d < (*worst)[0].distance {
            heap.Pop(worst)
            heap.Push(worst, scored{value: v, distance: d})
        }
    }

    result := make([]int, 0, worst.Len())
    for _, s := range *worst {
        result = append(result, s.value) // unordered by design
    }
    return result
}

// KClosestSorted is the alternative when the input is already SORTED:
// binary search the window's left edge. O(log n + k), no heap.
func KClosestSorted(sorted []int, k, target int) []int {
    lo, hi := 0, len(sorted)-k // lo is the leftmost index of the k-window
    for lo < hi {
        mid := lo + (hi-lo)/2
        // Compare the two candidates that would fall outside the window.
        if target-sorted[mid] > sorted[mid+k]-target {
            lo = mid + 1 // the right side is closer: shift the window right
        } else {
            hi = mid
        }
    }
    return sorted[lo : lo+k]
}
```

```python
import heapq

def k_closest(values, k, distance):
    """k items with the smallest distance, in O(n log k)."""
    if k <= 0:
        return []

    worst = []                      # max-heap via negated distance
    for v in values:
        d = distance(v)
        if len(worst) < k:
            heapq.heappush(worst, (-d, v))
        elif d < -worst[0][0]:      # O(1) rejection against the worst kept
            heapq.heapreplace(worst, (-d, v))
    return [v for _, v in worst]    # unordered by design

def k_closest_sorted(sorted_values, k, target):
    """Input already sorted: binary search the window's left edge. O(log n + k)."""
    lo, hi = 0, len(sorted_values) - k
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if target - sorted_values[mid] > sorted_values[mid + k] - target:
            lo = mid + 1            # the right side is closer
        else:
            hi = mid
    return sorted_values[lo:lo + k]
```

```java
import java.util.*;
import java.util.function.IntUnaryOperator;

public class KClosestPattern {
    // Keeping the k SMALLEST distances, so the heap is a MAX-heap.
    public static List<Integer> kClosest(int[] values, int k, IntUnaryOperator distance) {
        if (k <= 0) return List.of();

        PriorityQueue<int[]> worst =
            new PriorityQueue<>((a, b) -> Integer.compare(b[1], a[1]));  // max by distance

        for (int v : values) {
            int d = distance.applyAsInt(v);
            if (worst.size() < k) {
                worst.add(new int[]{v, d});
            } else if (d < worst.peek()[1]) {      // O(1) rejection
                worst.poll();
                worst.add(new int[]{v, d});
            }
        }

        List<Integer> result = new ArrayList<>();
        for (int[] s : worst) result.add(s[0]);    // unordered by design
        return result;
    }
}
```

```cpp
#include <functional>
#include <queue>
#include <vector>
using namespace std;

// Keeping the k SMALLEST distances, so the heap is a MAX-heap.
vector<int> kClosest(const vector<int>& values, int k,
                     const function<int(int)>& distance) {
    if (k <= 0) return {};

    // pair<distance, value>; default priority_queue is a max-heap.
    priority_queue<pair<int, int>> worst;

    for (int v : values) {
        int d = distance(v);
        if ((int)worst.size() < k) {
            worst.emplace(d, v);
        } else if (d < worst.top().first) {        // O(1) rejection
            worst.pop();
            worst.emplace(d, v);
        }
    }

    vector<int> result;
    while (!worst.empty()) {
        result.push_back(worst.top().second);      // unordered by design
        worst.pop();
    }
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | K Closest Elements (Optimal) |
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

### Problem — K Closest Points to Origin (LeetCode 973)
Return the `k` points closest to the origin. The answer may be in any order.

### Thought Process
1. Sorting all `n` points is O(n log n) for an answer that needs only `k` of them, unordered.
2. Keep a heap of size `k`. Since we're keeping the `k` **closest**, the heap must be a **max**-heap on distance — its top is the worst point we're currently keeping, and therefore the eviction candidate.
3. Compare each new point against that top first. If it is farther, discard it immediately with zero heap operations.
4. **Skip the square root.** Comparing `√(x²+y²)` and comparing `x²+y²` give the same ordering, and squared distances stay exact integers.

### Dry Run

Input: `points = [[3,3], [5,-1], [-2,4]]`, `k = 2`

Squared distances: `[3,3] → 18`, `[5,-1] → 26`, `[-2,4] → 20`

| point | d² | heap before (distances) | heap full? | vs top | action | heap after |
|-------|-----|-------------------------|------------|--------|--------|------------|
| `[3,3]`  | 18 | `[]`      | no  | — | push | `[18]` |
| `[5,-1]` | 26 | `[18]`    | no  | — | push | `[26, 18]` — top is **26** |
| `[-2,4]` | 20 | `[26,18]` | yes | `20 < 26` | pop 26, push 20 | `[20, 18]` |

Output: **`[[3,3], [-2,4]]`** (in any order) ✓

Verify: distances are 18, 20, 26 — the two smallest are 18 and 20. ✓

The heap never held more than 2 points, even though 3 arrived. With a million points and `k = 2`, it still never holds more than 2.

### Visualization

```text
                 y
                 │    [-2,4] d²=20
                 │  ●
          [3,3]  │
             ●   │
    ─────────────┼──────────── x
                 │        ● [5,-1] d²=26
                 │

max-heap of size 2, top = worst kept:

  push 18        heap [18]
  push 26        heap [26, 18]   top = 26  ← the one to evict
  20 < 26        pop 26, push 20 → [20, 18]

kept: d²=18 and d²=20
```

### Code

```go
// pointHeap is a MAX-heap on squared distance: the top is the farthest
// point we are currently keeping, i.e. the eviction candidate.
type pointHeap [][]int

func squaredDistance(p []int) int { return p[0]*p[0] + p[1]*p[1] }

func (h pointHeap) Len() int           { return len(h) }
func (h pointHeap) Less(i, j int) bool { return squaredDistance(h[i]) > squaredDistance(h[j]) }
func (h pointHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *pointHeap) Push(x any)        { *h = append(*h, x.([]int)) }
func (h *pointHeap) Pop() any {
    old := *h
    n := len(old)
    last := old[n-1]
    *h = old[:n-1]
    return last
}

func kClosestPoints(points [][]int, k int) [][]int {
    if k <= 0 {
        return nil
    }

    farthest := &pointHeap{}
    heap.Init(farthest)

    for _, p := range points {
        if farthest.Len() < k {
            heap.Push(farthest, p)
            continue
        }
        // O(1) rejection: no square root, no heap work for distant points.
        if squaredDistance(p) < squaredDistance((*farthest)[0]) {
            heap.Pop(farthest)
            heap.Push(farthest, p)
        }
    }

    return *farthest // any order is acceptable
}
```

```python
import heapq

def kClosest(points, k):
    if k <= 0:
        return []

    farthest = []                      # max-heap via negated squared distance
    for x, y in points:
        d = x * x + y * y              # no square root: same ordering
        if len(farthest) < k:
            heapq.heappush(farthest, (-d, [x, y]))
        elif d < -farthest[0][0]:      # O(1) rejection against the worst kept
            heapq.heapreplace(farthest, (-d, [x, y]))

    return [p for _, p in farthest]    # any order is acceptable
```

### Complexity
Time **O(n log k)** — each point costs at most one push and one pop on a heap capped at `k`. Space **O(k)**.

> Quickselect gets this to O(n) average if you may reorder the input; the heap is the right answer when the points arrive as a stream.

---

## 10. Solved Example 2

### Problem — Find K Closest Elements (LeetCode 658)
Given a **sorted** array, return the `k` elements closest to `x`, **sorted ascending**. Ties prefer the smaller element.

### Thought Process
1. A heap would work in O(n log k) — but the array is **sorted**, and that changes everything.
2. The answer is always a **contiguous window** of `k` elements. If it weren't, you could swap in a nearer neighbour and improve it.
3. So we don't need to choose `k` elements at all — we only need to find the window's **left edge**, one number in `[0, n−k]`.
4. Binary search that edge. At candidate `mid`, compare the two elements that decide whether to shift right: `arr[mid]` (the one we'd drop) and `arr[mid+k]` (the one we'd gain).
   - `x − arr[mid] > arr[mid+k] − x` → the right side is strictly closer → shift right (`lo = mid+1`).
   - Otherwise keep `mid` as a candidate (`hi = mid`).
5. The `>` (not `>=`) is what makes ties prefer the smaller element — on a tie we don't shift.

### Dry Run

Input: `arr = [1, 2, 3, 4, 5]`, `k = 4`, `x = 3` → search `lo = 0`, `hi = n − k = 1`

| lo | hi | mid | arr[mid] | arr[mid+k] | `x − arr[mid]` | `arr[mid+k] − x` | shift right? | action |
|----|----|-----|----------|------------|-----------------|-------------------|--------------|--------|
| 0 | 1 | 0 | 1 | `arr[4] = 5` | `3 − 1 = 2` | `5 − 3 = 2` | `2 > 2` → **no** | `hi = 0` |
| 0 | 0 | — | — | — | — | — | — | `lo == hi` → stop |

Left edge = **0** → window `arr[0:4]`

Output: **`[1, 2, 3, 4]`** ✓

The tie at the first step is the interesting part: dropping `1` and gaining `5` are equally good by distance, so the rule "prefer the smaller element" says stay. `>=` instead of `>` would have shifted and returned `[2,3,4,5]` — wrong.

**A second case**, `arr = [1,2,3,4,5]`, `k = 4`, `x = -1`: at `mid = 0`, `−1 − 1 = −2` and `5 − (−1) = 6`; `−2 > 6` is false, so `hi = 0` and the window is `[1,2,3,4]`. ✓

### Visualization

```text
arr:  1   2   3   4   5        x = 3,  k = 4

candidate windows (only 2 exist):

  left = 0:  [1  2  3  4]  5      drop 5, keep 1
  left = 1:   1 [2  3  4  5]      drop 1, keep 5

  |3 - 1| = 2   vs   |5 - 3| = 2   → tie → prefer the smaller → left = 0
```

### Code

```go
func findClosestElements(arr []int, k int, x int) []int {
    // The answer is a contiguous window; binary search its LEFT EDGE.
    lo, hi := 0, len(arr)-k

    for lo < hi {
        mid := lo + (hi-lo)/2
        // arr[mid] is what we'd drop; arr[mid+k] is what we'd gain.
        // Strict >: on a tie we stay, which prefers the smaller element.
        if x-arr[mid] > arr[mid+k]-x {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return arr[lo : lo+k]
}
```

```python
def findClosestElements(arr, k, x):
    # The answer is a contiguous window; binary search its LEFT EDGE.
    lo, hi = 0, len(arr) - k

    while lo < hi:
        mid = lo + (hi - lo) // 2
        # arr[mid] is dropped, arr[mid+k] is gained.
        # Strict >: a tie stays put, which prefers the smaller element.
        if x - arr[mid] > arr[mid + k] - x:
            lo = mid + 1
        else:
            hi = mid
    return arr[lo:lo + k]
```

### Complexity
Time **O(log(n − k) + k)** — the binary search plus copying the window. Space O(1) beyond the output.

> This is the "when a heap is the wrong tool" case from the Approach. Sortedness localises the answer to a single window, so we search for one index instead of comparing `n` items.

---

## 11. Solved Example 3

### Problem — The k Strongest Values in an Array (LeetCode 1471)
Let `m` be the median (`arr[(n−1)/2]` after sorting). Value `a` is stronger than `b` if `|a − m| > |b − m|`, or if they tie and `a > b`. Return any `k` strongest values.

### Thought Process
1. A heap ordered by that comparator works — but sorting first reveals something better.
2. After sorting, the median sits in the middle, and **strength grows as you move away from it in either direction**. So the strongest values are always at the two **ends** of the sorted array.
3. That means two pointers: compare the leftmost and rightmost remaining candidates, take the stronger, and move that pointer inward. Repeat `k` times.
4. The tie rule "larger value wins" is automatic — on a tie, `arr[right] >= arr[left]` because the array is sorted, so we take the right one.
5. Note the median index is `(n−1)/2`, **not** `n/2`. For `n = 6` that is index 2, not 3.

### Dry Run

Input: `arr = [1, 2, 3, 4, 5]`, `k = 2` → sorted already; `n = 5`, median index `(5−1)/2 = 2`, so `m = 3`

| step | left | right | `arr[left]` | `arr[right]` | `\|left − m\|` | `\|right − m\|` | stronger | take | move |
|------|------|-------|-------------|--------------|----------------|------------------|----------|------|------|
| 1 | 0 | 4 | 1 | 5 | `\|1−3\| = 2` | `\|5−3\| = 2` | tie → right (larger value) | **5** | `right → 3` |
| 2 | 0 | 3 | 1 | 4 | `2` | `\|4−3\| = 1` | left | **1** | `left → 1` |

Output: **`[5, 1]`** ✓

**A longer case**, `arr = [6,7,11,7,6,8]`, `k = 5` → sorted `[6,6,7,7,8,11]`, `n = 6`, median index `(6−1)/2 = 2` → `m = 7`:

| step | candidates | distances | take |
|------|-----------|-----------|------|
| 1 | `6` vs `11` | 1 vs 4 | **11** |
| 2 | `6` vs `8`  | 1 vs 1 | tie → **8** (larger) |
| 3 | `6` vs `7`  | 1 vs 0 | **6** |
| 4 | `6` vs `7`  | 1 vs 0 | **6** |
| 5 | `7` vs `7`  | 0 vs 0 | tie → **7** |

Output: **`[11, 8, 6, 6, 7]`** ✓

Note how the median index matters: `(6−1)/2 = 2` gives `m = 7`. Using `n/2 = 3` would also give `7` here, but on `[1,2,3,4]` the two disagree — `(4−1)/2 = 1` → `m = 2`, while `4/2 = 2` → `m = 3` — and only the former matches the problem's definition.

### Visualization

```text
sorted:   6    6    7    7    8   11
                    ↑
                 median m = 7  (index (6-1)/2 = 2)

distance from m:  1    1    0    0    1    4
                  └────┘              └────┘
                weakest in the middle, strongest at the ENDS

two pointers walk inward, always taking the stronger end
```

### Code

```go
func getStrongest(arr []int, k int) []int {
    sort.Ints(arr)

    // Median index is (n-1)/2, not n/2.
    median := arr[(len(arr)-1)/2]

    result := make([]int, 0, k)
    left, right := 0, len(arr)-1

    for len(result) < k {
        leftDistance := median - arr[left] // arr[left] <= median, so this is |diff|
        rightDistance := arr[right] - median

        // On a tie the larger value wins, and arr[right] >= arr[left]
        // because the array is sorted — so ties fall to the right.
        if leftDistance > rightDistance {
            result = append(result, arr[left])
            left++
        } else {
            result = append(result, arr[right])
            right--
        }
    }
    return result
}
```

```python
def getStrongest(arr, k):
    arr.sort()
    median = arr[(len(arr) - 1) // 2]      # (n-1)//2, not n//2

    result = []
    left, right = 0, len(arr) - 1
    while len(result) < k:
        left_distance = median - arr[left]     # arr[left] <= median
        right_distance = arr[right] - median

        # Ties go right: arr[right] >= arr[left] in a sorted array.
        if left_distance > right_distance:
            result.append(arr[left])
            left += 1
        else:
            result.append(arr[right])
            right -= 1
    return result
```

### Complexity
Time **O(n log n)** — the sort dominates; the two-pointer walk is O(k). Space O(1) beyond the output.

> A size-`k` heap with the custom comparator would be O(n log k), which is asymptotically better when `k ≪ n`. The two-pointer version is chosen here because sorting is required to find the median anyway — once you've paid O(n log n), the O(k) walk is free.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 973 | K Closest Points | Easy | Core heaps application |
| 658 | K Closest Elements | Easy | Core heaps application |
| 1471 | Strongest | Medium | Core heaps application |
| 692 | Top K Words | Medium | Core heaps application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same K Closest Elements logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** K Closest Elements (Heaps).
- **Signal:** k closest, heap, distance, origin, binary search.
- **Move:** A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.
- **Cost:** O(n log k) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the K Closest Elements invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: K Closest Elements
FAMILY : Heaps (Intermediate)
WHEN   : k closest, heap, distance, origin, binary search
DO     : A heap gives O(1) access to the extreme element and O(log n) updates — perfect f
TIME   : O(n log k)    SPACE: O(k)
PRACTICE: 973, 658, 1471, 692
```

---

*Part of the DSA Patterns Handbook — pattern 44 of 100.*
