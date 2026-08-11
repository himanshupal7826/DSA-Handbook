# 43 · Top K Elements

> **One-liner:** Maintain a size-k heap to track the k best elements in O(n log k).

---

## 1. Overview

### Definition
The **Top K Elements** pattern belongs to the *Heaps* family. Maintain a size-k heap to track the k best elements in O(n log k).

### Intuition
A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Why it works
Maintain a size-k heap (or two heaps) so each insertion is O(log k) and the best/median is at the top. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Heaps run priority schedulers (OS, Kubernetes), event simulations, Dijkstra routing, k-nearest-neighbor serving, and streaming top-k dashboards. Bounded heap size gives predictable memory under load.

---

## 2. Recognition Signals

### Keywords
top k, heap, priority queue, k largest, frequency.

### Constraints
- Input size where the brute-force complexity would time out — the Top K Elements optimization is the intended solution.
- Structural hints in the statement that match this family (Heaps).

### Hidden clues
- The problem can be reframed so the Top K Elements invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Top K Elements is the upgrade.
- The wording maps onto: top k, heap, priority queue, k largest, frequency.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which are the `k` best items — when `k` is tiny and `n` is enormous?"*

Running example: `nums = [3, 1, 5, 2, 4]`, `k = 2`. Find the 2 largest values (and hence the 2nd largest).

### Intuition
Put everything in order, then read off the front. Sorting is one line and obviously correct, so it is the honest first answer in an interview.

### Algorithm
1. Sort `nums` in descending order.
2. Take the first `k` entries.
3. The `k`-th largest is the last of them.

### Complexity
- Time: **O(n log n)** — the sort dominates.
- Space: O(n) for a copy, or O(1)–O(log n) if you may sort in place.

### Drawbacks

Look at what the sort actually computed on the running example:

```text
input        3   1   5   2   4          k = 2
sorted desc  5   4   3   2   1
             ^^^^^^^  ^^^^^^^^^
             wanted   pure waste

The sort proved that 3 > 2 > 1 — a complete ordering of the three losers.
We asked for the top 2. Every comparison used to rank 3, 2 and 1 against
each other is discarded.
```

- **The exact wasted work:** ordering the `n - k` items you will never return. For `n = 10^6`, `k = 10`, that is ~999 990 items sorted for nothing.
- **The fact it fails to exploit:** you never need the losers *ranked* — you only need to know that each one is worse than your current `k` survivors. That is a single comparison per item, not a full ordering.
- The other naive fix, "scan for the max `k` times", is O(n·k) — better when `k` is 2, disastrous when `k` is 1000.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Never hold more than `k` items: keep a heap of exactly the `k` best seen so far, and arrange it so the *weakest survivor* is the one sitting at the root, ready to be thrown out in O(log k).**

Imagine a talent show with only `k` seats on stage. Every new contestant walks on, making `k+1`. You immediately send home whoever is worst. To do that quickly you need the worst performer standing at the front — which is why, when you want the `k` **largest** values, you keep a **min**-heap.

### The thought process

```text
We need    : the k best of n items
Obvious way: sort everything, take the first k
Too slow   : O(n log n), and it ranks n-k items we throw away
Notice     : we never need the losers ordered — just "worse than my k"
Notice     : the only question we ever ask our survivors is
             "who is the WEAKEST of you, so I can evict them?"
Therefore  : store the survivors in a heap whose ROOT is the weakest
             → k largest  ⇒  MIN-heap        (root = smallest survivor)
             → k smallest ⇒  MAX-heap        (root = largest survivor)
Now        : push, and pop when the size exceeds k → O(n log k), O(k) space
```

### Why the size-k heap is correct (and why the heap type is flipped)

**The invariant:** after processing the first `i` items, the heap contains exactly the `k` largest among those `i` items (or all of them, if `i < k`).

**Why the eviction is safe.** When item `i+1` arrives, the heap momentarily holds `k+1` candidates. The smallest of those `k+1` cannot possibly belong to the `k` largest of the same `k+1` items — there are `k` others that are at least as big. So popping the minimum restores the invariant with zero risk. Induction does the rest; after the last item, the heap is the answer and its root is the `k`-th largest.

**The counter-intuitive rule, stated plainly:**

| You want | Heap type | Root holds | Evict when |
|----------|-----------|------------|------------|
| the `k` **largest** | **MIN**-heap | the *smallest* of your `k` survivors | `size > k` → pop the root |
| the `k` **smallest** | **MAX**-heap | the *largest* of your `k` survivors | `size > k` → pop the root |

Reach for a max-heap to find the largest values and you get O(n log n) and O(n) space — you would be storing everything and popping `k` times at the end. The flip is what caps memory at `k`.

**A tiny check on the running example.** With `k = 2` on `[3,1,5,2,4]`, when `4` arrives the heap holds `{3,5}`. The root is `3`. Since three values (`4`, `5`, and `3` itself) are all ≥ 3, `3` cannot be in the final top-2 — pop it. Root becomes `4`, the 2nd largest.

**Quickselect, the other option.** Partition around a random pivot and recurse into only the side that contains position `k`. It runs in **O(n) average** (O(n²) worst case, made vanishingly unlikely by a random pivot) and O(1) extra space.

| Approach | Time | Space | Use it when |
|----------|------|-------|-------------|
| Full sort | O(n log n) | O(n) | `n` is small, or you genuinely need the whole order |
| **Size-k heap** | **O(n log k)** | **O(k)** | data arrives as a **stream**, `k ≪ n`, you need a *running* answer, or `n` does not fit in memory |
| Quickselect | O(n) avg | O(1) | the whole array is already in memory, one-shot query, and you may reorder it |

Prefer the heap for anything streaming or online: quickselect must see all `n` items at once and shuffles them, while the heap answers correctly after *every* element and touches each item once.

### Steps

```text
Step 1 → create an empty MIN-heap (for the k largest)
Step 2 → for each value v:
Step 3 →   push v
Step 4 →   if heap size > k: pop the root (the weakest survivor)
Step 5 → the root is the k-th largest; the heap contents are the top k
```

### How should I recognize this?

```text
If you see...
  "k-th largest / smallest", "top k", "k most frequent",
  "k closest", "n is up to 1e5 and k is up to 100",
  or a stream / "elements arrive one at a time"
        ↓
Think about...
  "Do I need all n ranked, or only k of them?"
  Only k → do NOT sort. Cap your storage at k.
  Then: "Which end of my k do I need to throw away?"
        ↓
Use...
  a size-k heap of the OPPOSITE polarity
    · k largest values        → min-heap of values
    · k smallest / k closest  → max-heap keyed by the distance
    · k most frequent         → count first, then min-heap keyed by count
    · ties matter (words)     → make the comparator a total order on
                                (count, tie-break) so the result is stable
    · one-shot, in memory     → quickselect instead, O(n) average
```

### Visual explanation

```svg
<svg viewBox="0 0 640 235" width="100%" height="235" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="topk-43" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Min-heap of size k=3 keeps the k largest; root = smallest kept</text>
  <!-- before -->
  <text x="128" y="56" text-anchor="middle" fill="#64748b">before</text>
  <line x1="128" y1="90" x2="95" y2="132" stroke="#475569"/>
  <line x1="128" y1="90" x2="161" y2="132" stroke="#475569"/>
  <circle cx="128" cy="76" r="20" fill="#fff7ed" stroke="#d97706"/><text x="128" y="81" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="95" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="95" y="151" text-anchor="middle" fill="#1e293b">8</text>
  <circle cx="161" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="161" y="151" text-anchor="middle" fill="#1e293b">12</text>
  <text x="128" y="196" text-anchor="middle" fill="#64748b">root 5 = smallest of top-k</text>
  <!-- new element -->
  <line x1="200" y1="146" x2="268" y2="146" stroke="#475569" marker-end="url(#topk-43)"/>
  <rect x="272" y="62" width="96" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="320" y="84" text-anchor="middle" fill="#1e293b">new = 10</text>
  <text x="320" y="120" text-anchor="middle" fill="#059669">10 &gt; root 5</text>
  <text x="320" y="138" text-anchor="middle" fill="#64748b">pop 5, push 10, sift down</text>
  <line x1="372" y1="146" x2="418" y2="146" stroke="#475569" marker-end="url(#topk-43)"/>
  <!-- after -->
  <text x="500" y="56" text-anchor="middle" fill="#64748b">after</text>
  <line x1="500" y1="90" x2="467" y2="132" stroke="#475569"/>
  <line x1="500" y1="90" x2="533" y2="132" stroke="#475569"/>
  <circle cx="500" cy="76" r="20" fill="#ecfdf5" stroke="#059669"/><text x="500" y="81" text-anchor="middle" fill="#1e293b">8</text>
  <circle cx="467" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="467" y="151" text-anchor="middle" fill="#1e293b">10</text>
  <circle cx="533" cy="146" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="533" y="151" text-anchor="middle" fill="#1e293b">12</text>
  <text x="500" y="196" text-anchor="middle" fill="#64748b">new root 8</text>
</svg>
```

```text
nums = [3, 1, 5, 2, 4]   k = 2   → MIN-heap of the 2 largest so far

value   after push        size > k ?      after evict     root (k-th largest)
─────────────────────────────────────────────────────────────────────────────
  3     [3]               1 > 2 ? no      [3]             —  (fewer than k)
  1     [1, 3]            2 > 2 ? no      [1, 3]          1
  5     [1, 3, 5]         3 > 2 ? YES     [3, 5]          3     ← evicted 1
  2     [2, 3, 5]         3 > 2 ? YES     [3, 5]          3     ← evicted 2
  4     [3, 5, 4]         3 > 2 ? YES     [4, 5]          4     ← evicted 3

answer: 2nd largest = 4        top-2 = {4, 5}

the heap NEVER holds more than 3 items, whatever n is —
that is the O(k) space, and each push/pop is log 2, not log n.
```

### Interview explanation
"Sorting gives O(n log n), but it ranks the `n - k` items I'm going to throw away. Since I only ever need to know which of my survivors is the *weakest*, I keep a heap of size `k` — and here's the part that trips people up: for the `k` **largest** I use a **min**-heap, so the smallest survivor is at the root and costs O(log k) to evict. I push every element, and whenever the heap exceeds size `k` I pop the root; that's safe because the smallest of `k+1` items can never be in the top `k` of those items. At the end the root is the `k`-th largest. It's O(n log k) time and O(k) space. If the whole array were in memory and I only needed one answer I'd mention quickselect for O(n) average, but the heap is what I'd write for a stream."

---

## 5. Generic Templates

> Push everything, pop when you exceed `k`, and flip the heap: **min-heap for the `k` largest**.

```go
// kIntHeap is a MIN-heap of ints. Flip Less to `>` to keep the k SMALLEST.
type kIntHeap []int

func (h kIntHeap) Len() int           { return len(h) }
func (h kIntHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h kIntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *kIntHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *kIntHeap) Pop() any {
	old := *h
	last := old[len(old)-1]
	*h = old[:len(old)-1]
	return last
}

// kLargest returns the k largest values of nums (in no particular order).
// The heap holds at most k items, so memory never depends on n.
func kLargest(nums []int, k int) []int {
	if k <= 0 {
		return nil
	}
	h := &kIntHeap{}
	for _, v := range nums {
		heap.Push(h, v)
		if h.Len() > k {
			heap.Pop(h) // the weakest survivor cannot be in the top k
		}
	}
	return *h
}
```

```python
import heapq


def k_largest(nums, k):
    """The k largest values of nums, using a size-k MIN-heap."""
    if k <= 0:
        return []
    heap = []                        # min-heap: root is the weakest survivor
    for v in nums:
        heapq.heappush(heap, v)
        if len(heap) > k:
            heapq.heappop(heap)      # cannot be in the top k
    return heap


def k_smallest(nums, k):
    """The k smallest values — same shape, opposite polarity (negate to invert)."""
    if k <= 0:
        return []
    heap = []                        # max-heap emulated with negated values
    for v in nums:
        heapq.heappush(heap, -v)
        if len(heap) > k:
            heapq.heappop(heap)
    return [-v for v in heap]
```

```java
// The k largest values of nums, using a size-k MIN-heap.
List<Integer> kLargest(int[] nums, int k) {
    if (k <= 0) return new ArrayList<>();
    // natural order = min-heap; root is the weakest survivor
    PriorityQueue<Integer> heap = new PriorityQueue<>();
    for (int v : nums) {
        heap.offer(v);
        if (heap.size() > k) heap.poll();   // cannot be in the top k
    }
    return new ArrayList<>(heap);
}

// For the k smallest, flip the comparator: new PriorityQueue<>(Comparator.reverseOrder())
```

```cpp
// The k largest values of nums, using a size-k MIN-heap.
vector<int> kLargest(const vector<int>& nums, int k) {
    vector<int> out;
    if (k <= 0) return out;
    // greater<int> turns priority_queue into a MIN-heap: top() is the weakest
    priority_queue<int, vector<int>, greater<int>> heap;
    for (int v : nums) {
        heap.push(v);
        if ((int)heap.size() > k) heap.pop();   // cannot be in the top k
    }
    while (!heap.empty()) { out.push_back(heap.top()); heap.pop(); }
    return out;
}

// For the k smallest, drop greater<int> so it becomes a max-heap.
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Top K Elements (Optimal) |
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

### Problem — Kth Largest (LeetCode 215)
Given an unsorted array `nums` and an integer `k`, return the `k`-th largest element — that is, the `k`-th value in sorted-descending order, not the `k`-th distinct value.

### Thought Process
1. Sorting answers it in O(n log n) but ranks every element we do not care about.
2. Only `k` values can ever be the answer, so store only `k`.
3. Use a **min**-heap: with the `k` largest inside it, the root is the *smallest* of them — precisely the `k`-th largest.
4. Push each value; if the heap grows to `k+1`, pop the root. The smallest of `k+1` items cannot be among their `k` largest, so the eviction is always safe.
5. After the last value, return the root.

### Dry Run

Input: `nums = [3,2,1,5,6,4]`, `k = 2`

| v | heap after push | size > 2? | evicted | heap after | root = k-th largest so far |
|---|-----------------|-----------|---------|------------|-----------------------------|
| 3 | `{3}` | no | — | `{3}` | — (fewer than k seen) |
| 2 | `{2, 3}` | no | — | `{2, 3}` | 2 |
| 1 | `{1, 2, 3}` | yes | **1** | `{2, 3}` | 2 |
| 5 | `{2, 3, 5}` | yes | **2** | `{3, 5}` | 3 |
| 6 | `{3, 5, 6}` | yes | **3** | `{5, 6}` | 5 |
| 4 | `{4, 5, 6}` | yes | **4** | `{5, 6}` | **5** |

Output: **`5`**

(Heap contents are shown as a set; a heap only promises the *root*, not a sorted array.) The last row is the invariant working: `4` arrives, joins the heap, and is immediately identified as the weakest of `{4,5,6}` — two values beat it, so with `k = 2` it can never be an answer. Note the heap never exceeds 3 entries no matter how long `nums` is.

### Visualization

```text
size-2 MIN-heap; the root is the DOOR — everything leaves through it

after 3,2      after 5              after 6              after 4
    2              3                    5                    5
     \              \                    \                    \
      3              5                    6                    6
    ^                ^                    ^                    ^
  root=2          root=3               root=5               root=5
                (1 and 2 evicted)   (3 evicted)         (4 evicted instantly)

why a MIN-heap for the LARGEST values?
  the only thing we ever ask is "who is the weakest of my k?"
  a min-heap puts that answer at index 0, so eviction is O(log k).
```

### Code

```go
// intMinHeap is a min-heap of ints: the weakest survivor sits at the root.
type intMinHeap []int

func (h intMinHeap) Len() int           { return len(h) }
func (h intMinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h intMinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *intMinHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *intMinHeap) Pop() any {
	old := *h
	last := old[len(old)-1]
	*h = old[:len(old)-1]
	return last
}

// findKthLargest returns the k-th largest value using a size-k MIN-heap.
func findKthLargest(nums []int, k int) int {
	survivors := &intMinHeap{}
	for _, v := range nums {
		heap.Push(survivors, v)
		if survivors.Len() > k {
			heap.Pop(survivors) // smallest of k+1 can't be in their top k
		}
	}
	return (*survivors)[0] // root = smallest survivor = k-th largest
}
```

```python
import heapq


def find_kth_largest(nums, k):
    survivors = []                       # min-heap of the k largest so far
    for v in nums:
        heapq.heappush(survivors, v)
        if len(survivors) > k:
            heapq.heappop(survivors)     # smallest of k+1 can't be in their top k
    return survivors[0]                  # root = k-th largest
```

### Complexity
Time O(n log k) — `n` pushes and up to `n` pops, each on a heap of at most `k+1` entries. Space O(k) — the heap size is capped regardless of `n`, which is what makes this work on a stream.

## 10. Solved Example 2

### Problem — Top K Frequent (LeetCode 347)
Given an integer array `nums` and an integer `k`, return the `k` most frequently occurring values.

### Thought Process
1. Count occurrences in one pass with a hash map — `O(n)` and unavoidable.
2. Now it is a top-k problem over the *distinct* values, scored by count.
3. Same rule as before: for the `k` **highest** counts, keep a size-`k` **min**-heap keyed by count, so the least frequent survivor is at the root.
4. Push each `(value, count)` pair; pop the root whenever the heap exceeds `k`.
5. Pop the remaining `k` entries — they come out weakest-first, so fill the output array backwards to get them in descending order.

### Dry Run

Input: `nums = [1,1,1,2,2,3]`, `k = 2` → counts `{1: 3, 2: 2, 3: 1}`

| entry pushed | heap after push (by count) | size > 2? | evicted (root) | heap after |
|--------------|----------------------------|-----------|----------------|------------|
| `(1, count 3)` | `{1:3}` | no | — | `{1:3}` |
| `(2, count 2)` | `{1:3, 2:2}` | no | — | `{1:3, 2:2}` |
| `(3, count 1)` | `{1:3, 2:2, 3:1}` | yes | `(3, count 1)` | `{1:3, 2:2}` |

Draining the heap weakest-first gives `(2, count 2)` then `(1, count 3)`, so filling backwards yields:

Output: **`[1, 2]`**

The map's iteration order is not defined, but the result is: the comparator is a *total* order on `(count, value)`, so the same two entries survive whatever order they arrive in, and the drain always emits them highest-count-first.

### Visualization

```text
step 1 — count            step 2 — size-2 MIN-heap keyed by COUNT

 1 → ###   (3)                  push 1:3      [1:3]
 2 → ##    (2)                  push 2:3      [2:2, 1:3]   root = 2:2
 3 → #     (1)                  push 3:1      [3:1, 1:3, 2:2]  root = 3:1
                                size 3 > 2 → pop root  ✗ 3:1
                                              [2:2, 1:3]

drain (weakest first):  2:2 , 1:3
fill output backwards:  [ _ , 2 ] → [ 1 , 2 ]

the heap is keyed by count, never by value — the value is just cargo.
```

### Code

```go
type countEntry struct {
	value int
	count int
}

// countHeap is a MIN-heap on count: its root is the least frequent survivor.
// The value tie-break only exists to make the result deterministic.
type countHeap []countEntry

func (h countHeap) Len() int { return len(h) }
func (h countHeap) Less(i, j int) bool {
	if h[i].count != h[j].count {
		return h[i].count < h[j].count
	}
	return h[i].value > h[j].value
}
func (h countHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *countHeap) Push(x any)   { *h = append(*h, x.(countEntry)) }
func (h *countHeap) Pop() any {
	old := *h
	last := old[len(old)-1]
	*h = old[:len(old)-1]
	return last
}

// topKFrequent returns the k most frequent values, most frequent first.
func topKFrequent(nums []int, k int) []int {
	counts := make(map[int]int, len(nums))
	for _, v := range nums {
		counts[v]++
	}
	survivors := &countHeap{}
	for value, count := range counts {
		heap.Push(survivors, countEntry{value: value, count: count})
		if survivors.Len() > k {
			heap.Pop(survivors) // least frequent of k+1 can't be in their top k
		}
	}
	out := make([]int, survivors.Len())
	for i := len(out) - 1; i >= 0; i-- { // drained weakest-first, so fill backwards
		out[i] = heap.Pop(survivors).(countEntry).value
	}
	return out
}
```

```python
import heapq
from collections import Counter


def top_k_frequent(nums, k):
    counts = Counter(nums)
    survivors = []                                  # min-heap of (count, value)
    for value, count in counts.items():
        heapq.heappush(survivors, (count, value))
        if len(survivors) > k:
            heapq.heappop(survivors)                # least frequent of k+1
    out = [0] * len(survivors)
    for i in range(len(out) - 1, -1, -1):           # drained weakest-first
        out[i] = heapq.heappop(survivors)[1]
    return out
```

### Complexity
Time O(n log k) — O(n) to count, then one push (and at most one pop) per *distinct* value on a heap capped at `k+1`. Space O(n) for the count map plus O(k) for the heap.

## 11. Solved Example 3

### Problem — Top K Words (LeetCode 692)
Given a list of `words` and an integer `k`, return the `k` most frequent words, sorted by frequency from highest to lowest, with ties broken by lexicographical order (smaller word first).

### Thought Process
1. Count the words, then it is top-k again — but now "best" is a **two-part** score.
2. Define the comparison once and stick to it: `a` is *worse* than `b` if `a.count < b.count`, or the counts tie and `a.word > b.word` (later alphabetically loses).
3. That comparison is a total order on distinct words, so a size-`k` heap ordered "worst at the root" is well defined.
4. Push every `(word, count)`; whenever the heap exceeds `k`, pop the root — the worst of `k+1` can never be in their top `k`.
5. Drain the heap (worst first) and fill the output backwards to get best-first order.

### Dry Run

Input: `words = ["i","love","leetcode","i","love","coding"]`, `k = 2`
Counts: `{i: 2, love: 2, leetcode: 1, coding: 1}`

| entry pushed | root after push (the *worst*) | size > 2? | evicted | heap after |
|--------------|-------------------------------|-----------|---------|------------|
| `i` (2) | `i` (2) | no | — | `{i:2}` |
| `love` (2) | `love` (2) — tie on count, `"love" > "i"` so it loses | no | — | `{i:2, love:2}` |
| `leetcode` (1) | `leetcode` (1) — lowest count | yes | `leetcode` | `{i:2, love:2}` |
| `coding` (1) | `coding` (1) — lowest count | yes | `coding` | `{i:2, love:2}` |

Draining worst-first gives `love` then `i`; filling backwards yields:

Output: **`["i", "love"]`**

Row 2 is the tie-break rule doing real work: `i` and `love` both appear twice, so count alone cannot separate them. Because `"love"` sorts after `"i"`, `love` becomes the root — and had `k` been `1`, `love` is exactly the one that would have been evicted.

### Visualization

```text
score = (count, word), compared as:   higher count wins
                                      tie → smaller word wins

              i (2)   love (2)   leetcode (1)   coding (1)
  best  ──────────────────────────────────────────────────▶  worst

size-2 heap, WORST at the root:

  push i        [ i:2 ]                       root = i
  push love     [ love:2 , i:2 ]              root = love   ("love" > "i")
  push leetcode [ leetcode:1 , i:2 , love:2 ] root = leetcode
                size 3 > 2 → pop  ✗ leetcode
  push coding   → same story        → pop  ✗ coding

drain worst-first: love , i     →  fill backwards  →  [ "i" , "love" ]
```

### Code

```go
type wordEntry struct {
	word  string
	count int
}

// wordHeap puts the WORST entry at the root: lower count first, and on a tie
// the lexicographically larger word (which loses the tie-break).
type wordHeap []wordEntry

func (h wordHeap) Len() int { return len(h) }
func (h wordHeap) Less(i, j int) bool {
	if h[i].count != h[j].count {
		return h[i].count < h[j].count
	}
	return h[i].word > h[j].word
}
func (h wordHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *wordHeap) Push(x any)   { *h = append(*h, x.(wordEntry)) }
func (h *wordHeap) Pop() any {
	old := *h
	last := old[len(old)-1]
	*h = old[:len(old)-1]
	return last
}

// topKFrequentWords returns the k most frequent words, highest count first,
// ties broken by the lexicographically smaller word.
func topKFrequentWords(words []string, k int) []string {
	counts := make(map[string]int, len(words))
	for _, w := range words {
		counts[w]++
	}
	survivors := &wordHeap{}
	for word, count := range counts {
		heap.Push(survivors, wordEntry{word: word, count: count})
		if survivors.Len() > k {
			heap.Pop(survivors) // the worst of k+1 can't be in their top k
		}
	}
	out := make([]string, survivors.Len())
	for i := len(out) - 1; i >= 0; i-- { // drained worst-first, so fill backwards
		out[i] = heap.Pop(survivors).(wordEntry).word
	}
	return out
}
```

```python
import heapq
from collections import Counter


class Worst:
    """Wrapper so heapq's min-heap pops the WORST word first."""

    def __init__(self, word, count):
        self.word, self.count = word, count

    def __lt__(self, other):
        if self.count != other.count:
            return self.count < other.count      # lower count is worse
        return self.word > other.word            # tie: later alphabetically is worse


def top_k_frequent_words(words, k):
    counts = Counter(words)
    survivors = []
    for word, count in counts.items():
        heapq.heappush(survivors, Worst(word, count))
        if len(survivors) > k:
            heapq.heappop(survivors)             # the worst of k+1
    out = [""] * len(survivors)
    for i in range(len(out) - 1, -1, -1):        # drained worst-first
        out[i] = heapq.heappop(survivors).word
    return out
```

### Complexity
Time O(n log k) — O(n) to count `n` words, then one push and at most one pop per distinct word on a heap capped at `k+1`. Space O(n) for the counts plus O(k) for the heap. (A full sort by `(-count, word)` would be O(u log u) over the `u` distinct words — fine offline, but it cannot answer after every element the way the heap can.)

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 215 | Kth Largest | Easy | Core heaps application |
| 347 | Top K Frequent | Easy | Core heaps application |
| 692 | Top K Words | Medium | Core heaps application |
| 973 | K Closest | Medium | Core heaps application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Top K Elements logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Top K Elements (Heaps).
- **Signal:** top k, heap, priority queue, k largest, frequency.
- **Move:** A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.
- **Cost:** O(n log k) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Top K Elements invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Top K Elements
FAMILY : Heaps (Intermediate)
WHEN   : top k, heap, priority queue, k largest, frequency
DO     : A heap gives O(1) access to the extreme element and O(log n) updates — perfect f
TIME   : O(n log k)    SPACE: O(k)
PRACTICE: 215, 347, 692, 973
```

---

*Part of the DSA Patterns Handbook — pattern 43 of 100.*
