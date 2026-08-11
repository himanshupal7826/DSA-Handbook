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

**The question this pattern keeps answering:** *"What sits in the **middle** of my data — or, which item is best among those currently eligible?"*

### Intuition
Keep everything in a list. Whenever you need the answer, sort and look.

### Algorithm
1. Append each new value to a list.
2. When the median is requested, sort the list.
3. Return the middle element (or the average of the two middle ones).

### Complexity
- Time: **O(n log n) per query**, so O(q · n log n) overall.
- Space: O(n).

### Drawbacks
- The list was *almost* sorted already — one insertion changed it. Re-sorting from scratch throws that away.
- Inserting into a sorted array instead is O(n) per insert because of the shifting, which is better but still linear.
- And we sort the **whole** dataset to read **one** position. That is a lot of ordering nobody asked for.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Cut the data in half and guard each half with its own heap, arranged so the two heap tops are exactly the middle elements.**

```text
        small half                 large half
   ┌──────────────────┐      ┌──────────────────┐
   │   max-heap       │      │    min-heap      │
   │   top = LARGEST  │      │  top = SMALLEST  │
   │   of the small   │      │   of the large   │
   └──────────────────┘      └──────────────────┘
              ▲                    ▲
              └──── the middle ────┘
```

You never sort anything. The median is always one or two O(1) peeks away.

### The thought process

```text
We need    : the middle element, repeatedly, as data arrives.
Obvious way: keep a list and sort on demand.
Wasteful   : full ordering for one position, redone every query.
Notice     : we don't need the data sorted. We only need to know
             where the BOUNDARY between the two halves is.
Notice too : a max-heap gives the largest of the small half in O(1),
             and a min-heap gives the smallest of the large half.
             Those two ARE the middle elements.
Therefore  : maintain two heaps, balanced in size.
Now        : O(log n) insert, O(1) median.
```

### The two invariants

Everything rests on keeping these true at all times:

```text
1. ORDER:  every value in the low heap  <=  every value in the high heap
2. SIZE:   0 <= len(low) - len(high) <= 1
```

Invariant 1 makes the two tops the true middle. Invariant 2 decides which top to read: with an odd count the extra element lives in `low`, so `low`'s top *is* the median; with an even count, average the two tops.

### Why insertion needs three steps, not one

The natural instinct — "push to whichever heap keeps sizes balanced" — silently breaks invariant 1. A value pushed onto `low` might be larger than something already in `high`.

The fix is a fixed three-step ritual that restores both invariants no matter what arrives:

```text
Step 1 → push the new value onto `low`            (order may now be violated)
Step 2 → move low's top over to `high`            (order is restored:
                                                   low's largest is now in high)
Step 3 → if high is now bigger than low,
             move high's top back to low          (size is restored)
```

Step 2 is the one people skip. It is what guarantees the value lands on the correct side without ever comparing it to anything explicitly — the heaps do the comparison for you.

### Reading the median

```text
len(low) > len(high)   →  odd count   →  median = low.top
len(low) == len(high)  →  even count  →  median = (low.top + high.top) / 2
```

Use floating-point division for the even case, and watch for overflow when summing two large integers — `low.top/2.0 + high.top/2.0` sidesteps it.

### The same structure, a different job

Two heaps is not only about medians. The other classic shape is **"unlock, then choose"**:

| Problem | Heap A | Heap B |
|---|---|---|
| Streaming median | max-heap of the low half | min-heap of the high half |
| IPO / capital projects | min-heap by **cost** (what's affordable next) | max-heap by **profit** (best affordable) |
| Task scheduling | min-heap by available time | max-heap by priority |

In the second shape the heaps hold *different orderings of different things*: one decides **eligibility**, the other decides **choice among the eligible**.

### The limitation to state out loud

A binary heap supports "remove the top", **not** "remove an arbitrary element". So a plain two-heap structure cannot handle a **sliding window**, where an old value must leave from the middle.

Two standard fixes:

- **Lazy deletion** — keep a map of values pending removal; discard them when they surface at a top. Sizes must be tracked separately from `heap.Len()`.
- **Balanced BST / ordered multiset** — supports arbitrary removal directly (`SortedList` in Python, `multiset` in C++).

### Steps

```text
Step 1 → Create the two heaps: low (max-heap), high (min-heap).
Step 2 → To insert a value:
Step 3 →     push it onto `low`
Step 4 →     move low's top across to `high`     ← repairs the ORDER invariant
Step 5 →     if high is now larger, move its top back to low  ← repairs SIZE
Step 6 → To read the median:
Step 7 →     len(low) > len(high)  → low's top
Step 8 →     otherwise             → the average of the two tops
```

### How should I recognize this?

```text
If you see...
  "median of a stream", "find the middle", "balance two halves"
  "maximize X subject to affording it", "schedule by two criteria"
  a rolling statistic that needs the middle rather than the extremes
        ↓
Think about...
  "Can I split the data into two halves whose BOUNDARY
   is exactly what I'm being asked for?"
        ↓
Use...
  median      → max-heap (low half) + min-heap (high half), sizes within 1
  eligibility → min-heap on the cost + max-heap on the value
  window      → add lazy deletion, or use an ordered multiset instead
```

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

```text
stream: 1, 2, 3

after 1:   low [1]        high []           median = 1        (odd)
after 2:   low [1]        high [2]          median = 1.5      (even)
after 3:   low [2, 1]     high [3]          median = 2        (odd)
                ▲              ▲
             max-heap      min-heap
             top = 2       top = 3

every value in low  <=  every value in high
```

### Interview explanation
"I'll keep two heaps: a max-heap holding the smaller half and a min-heap holding the larger half, sized to differ by at most one. The invariant is that everything in the low heap is at most everything in the high heap, so the two heap tops are exactly the middle elements — the median is an O(1) peek. To insert I always push onto the low heap first, then move its top into the high heap, then move back if the high heap became larger. That middle step is what enforces the ordering invariant without any explicit comparison. Insert is O(log n), median is O(1). If the problem were a sliding window I'd need arbitrary removal, which a heap can't do — so I'd add lazy deletion or switch to an ordered multiset."

---

## 5. Generic Templates

> Two heaps, two invariants, and a fixed three-step insert.

```go
// maxHeap keeps the largest value on top (the small half).
type maxHeap []int

func (h maxHeap) Len() int           { return len(h) }
func (h maxHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h maxHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *maxHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *maxHeap) Pop() any {
    old := *h
    n := len(old)
    last := old[n-1]
    *h = old[:n-1]
    return last
}

// minHeap keeps the smallest value on top (the large half).
type minHeap []int

func (h minHeap) Len() int           { return len(h) }
func (h minHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h minHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *minHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *minHeap) Pop() any {
    old := *h
    n := len(old)
    last := old[n-1]
    *h = old[:n-1]
    return last
}

// MedianKeeper maintains the running median of a stream.
type MedianKeeper struct {
    low  *maxHeap // the smaller half; top is its largest
    high *minHeap // the larger half; top is its smallest
}

func NewMedianKeeper() *MedianKeeper {
    return &MedianKeeper{low: &maxHeap{}, high: &minHeap{}}
}

// Add inserts a value, restoring both invariants.
func (m *MedianKeeper) Add(value int) {
    // 1. Always push onto low first.
    heap.Push(m.low, value)
    // 2. Move low's largest into high — this is what enforces the ORDER
    //    invariant without comparing anything explicitly.
    heap.Push(m.high, heap.Pop(m.low))
    // 3. Restore the SIZE invariant: low may be equal to or one bigger.
    if m.high.Len() > m.low.Len() {
        heap.Push(m.low, heap.Pop(m.high))
    }
}

// Median is an O(1) peek at one or both tops.
func (m *MedianKeeper) Median() float64 {
    if m.low.Len() > m.high.Len() {
        return float64((*m.low)[0]) // odd count: the extra element is in low
    }
    // Halve each side before adding, to avoid overflow on large values.
    return float64((*m.low)[0])/2.0 + float64((*m.high)[0])/2.0
}
```

```python
import heapq

class MedianKeeper:
    """low is a max-heap (negated); high is a min-heap."""

    def __init__(self):
        self.low = []                  # max-heap via negation: small half
        self.high = []                 # min-heap: large half

    def add(self, value):
        heapq.heappush(self.low, -value)                  # 1. always into low
        heapq.heappush(self.high, -heapq.heappop(self.low))  # 2. enforce ORDER
        if len(self.high) > len(self.low):                # 3. enforce SIZE
            heapq.heappush(self.low, -heapq.heappop(self.high))

    def median(self):
        if len(self.low) > len(self.high):
            return float(-self.low[0])                    # odd: extra is in low
        return (-self.low[0] + self.high[0]) / 2.0
```

```java
import java.util.*;

public class TwoHeaps {
    private final PriorityQueue<Integer> low  = new PriorityQueue<>(Comparator.reverseOrder());
    private final PriorityQueue<Integer> high = new PriorityQueue<>();

    public void add(int value) {
        low.add(value);            // 1. always into low
        high.add(low.poll());      // 2. enforce ORDER
        if (high.size() > low.size()) low.add(high.poll());   // 3. enforce SIZE
    }

    public double median() {
        if (low.size() > high.size()) return low.peek();      // odd count
        return low.peek() / 2.0 + high.peek() / 2.0;          // avoids overflow
    }
}
```

```cpp
#include <queue>
#include <vector>
using namespace std;

class TwoHeaps {
    priority_queue<int> low;                                   // max-heap: small half
    priority_queue<int, vector<int>, greater<int>> high;       // min-heap: large half

public:
    void add(int value) {
        low.push(value);                     // 1. always into low
        high.push(low.top()); low.pop();     // 2. enforce ORDER
        if (high.size() > low.size()) {      // 3. enforce SIZE
            low.push(high.top());
            high.pop();
        }
    }

    double median() const {
        if (low.size() > high.size()) return low.top();        // odd count
        return low.top() / 2.0 + high.top() / 2.0;             // avoids overflow
    }
};
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

### Problem — Find Median from Data Stream (LeetCode 295)
Support `addNum(num)` and `findMedian()` on an unbounded stream.

### Thought Process
1. Sorting on every query is O(n log n) per call — far too slow for a stream.
2. Split the data into a small half (max-heap) and a large half (min-heap). The two tops are the middle elements.
3. Insert with the fixed ritual: push onto `low`, move `low`'s top to `high`, then move back if `high` grew larger.
4. Read the median from the tops: `low`'s top when the count is odd, the average of both when even.
5. `low` is allowed to hold the extra element, which is why an odd count reads from `low`.

### Dry Run

Operations: `addNum(1)`, `addNum(2)`, `findMedian()`, `addNum(3)`, `findMedian()`

| operation | step 1: push to low | step 2: move low→high | step 3: rebalance | low (max-heap) | high (min-heap) | median |
|-----------|--------------------|-----------------------|--------------------|----------------|-----------------|--------|
| `addNum(1)` | low `[1]` | high `[1]`, low `[]` | high bigger → move back | `[1]` | `[]` | — |
| `addNum(2)` | low `[2,1]` | move `2` → high `[2]`, low `[1]` | sizes equal, no move | `[1]` | `[2]` | — |
| `findMedian()` | | | | `[1]` | `[2]` | `(1+2)/2` = **1.5** |
| `addNum(3)` | low `[3,1]` | move `3` → high `[2,3]`, low `[1]` | high bigger → move `2` back | `[2,1]` | `[3]` | — |
| `findMedian()` | | | | `[2,1]` | `[3]` | low.top = **2** |

Output: **1.5**, then **2** ✓

Verify by hand: after three inserts the sorted data is `[1,2,3]`, whose median is `2`. ✓

Watch `addNum(3)`: pushing `3` onto the max-heap `low` puts it on top, and step 2 immediately ships it to `high` where it belongs. We never compared `3` against anything — the heap ordering did it.

### Visualization

```text
after addNum(3):

     low (max-heap)          high (min-heap)
        [2, 1]                   [3]
          ▲                       ▲
        top = 2                 top = 3

  sorted view:   1   2 │ 3
                       ↑
                  median = 2   (low has the extra element)
```

### Code

```go
type MedianFinder struct {
    low  *maxIntHeap // smaller half; top is its largest
    high *minIntHeap // larger half; top is its smallest
}

func NewMedianFinder() MedianFinder {
    return MedianFinder{low: &maxIntHeap{}, high: &minIntHeap{}}
}

func (m *MedianFinder) AddNum(num int) {
    heap.Push(m.low, num)                    // 1. always into low
    heap.Push(m.high, heap.Pop(m.low))       // 2. enforce the ORDER invariant
    if m.high.Len() > m.low.Len() {          // 3. enforce the SIZE invariant
        heap.Push(m.low, heap.Pop(m.high))
    }
}

func (m *MedianFinder) FindMedian() float64 {
    if m.low.Len() > m.high.Len() {
        return float64((*m.low)[0]) // odd count: the extra element sits in low
    }
    return float64((*m.low)[0])/2.0 + float64((*m.high)[0])/2.0
}

type maxIntHeap []int

func (h maxIntHeap) Len() int           { return len(h) }
func (h maxIntHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h maxIntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *maxIntHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *maxIntHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

type minIntHeap []int

func (h minIntHeap) Len() int           { return len(h) }
func (h minIntHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h minIntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *minIntHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *minIntHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

class MedianFinder:
    def __init__(self):
        self.low = []                  # max-heap via negation
        self.high = []                 # min-heap

    def addNum(self, num):
        heapq.heappush(self.low, -num)                        # 1. into low
        heapq.heappush(self.high, -heapq.heappop(self.low))   # 2. ORDER
        if len(self.high) > len(self.low):                    # 3. SIZE
            heapq.heappush(self.low, -heapq.heappop(self.high))

    def findMedian(self):
        if len(self.low) > len(self.high):
            return float(-self.low[0])
        return (-self.low[0] + self.high[0]) / 2.0
```

### Complexity
`addNum` **O(log n)** — a constant number of heap operations. `findMedian` **O(1)**. Space O(n).

---

## 10. Solved Example 2

### Problem — Sliding Window Median (LeetCode 480)
Return the median of every window of size `k`.

### Thought Process
1. This is the streaming median **plus removal from the middle** — and that is precisely what a binary heap cannot do. A heap removes its top, not an arbitrary element.
2. Two ways out:
   - **Lazy deletion**: keep the two heaps, plus a map of values pending removal, and track the logical sizes separately from `heap.Len()`. Discard stale values only when they surface at a top.
   - **Keep the window sorted**: binary search where the new value goes, and where the departing one is.
3. The sorted-window version is chosen here because it is short and obviously correct. Insertion and deletion are O(k) because of the shifting, giving O(n·k) overall — fine for the problem's constraints and much easier to defend.
4. Reading the median from a sorted window is a direct index lookup.
5. Use floating-point care on the even case: `(a + b) / 2` can overflow with values near the integer limit, so halve each side first.

### Dry Run

Input: `nums = [1, 3, -1, -3, 5, 3, 6, 7]`, `k = 3`

| window | sorted window | median |
|--------|---------------|--------|
| `[1, 3, -1]`  | `[-1, 1, 3]`  | **1** |
| `[3, -1, -3]` | `[-3, -1, 3]` | **−1** |
| `[-1, -3, 5]` | `[-3, -1, 5]` | **−1** |
| `[-3, 5, 3]`  | `[-3, 3, 5]`  | **3** |
| `[5, 3, 6]`   | `[3, 5, 6]`   | **5** |
| `[3, 6, 7]`   | `[3, 6, 7]`   | **6** |

Output: **`[1, -1, -1, 3, 5, 6]`** ✓

Trace one slide in detail — from window 1 to window 2:

```text
sorted window: [-1, 1, 3]
  remove nums[0] = 1  →  binary search finds it at index 1  →  [-1, 3]
  insert nums[3] = -3 →  binary search says index 0         →  [-3, -1, 3]
  median = element at index k/2 = 1  →  -1
```

The window stays sorted at all times, so the median is never searched for — it is read directly.

### Visualization

```text
nums:   1    3   -1   -3    5    3    6    7
       └────────┘                              sorted [-1, 1, 3]   → 1
            └────────┘                         sorted [-3,-1, 3]   → -1
                 └────────┘                    sorted [-3,-1, 5]   → -1
                      └────────┘               sorted [-3, 3, 5]   → 3
                           └────────┘          sorted [ 3, 5, 6]   → 5
                                └────────┘     sorted [ 3, 6, 7]   → 6
```

### Code

```go
func medianSlidingWindow(nums []int, k int) []float64 {
    // window is kept sorted at all times, so the median is a direct lookup.
    window := make([]int, k)
    copy(window, nums[:k])
    sort.Ints(window)

    medians := make([]float64, 0, len(nums)-k+1)
    medians = append(medians, medianOfSorted(window, k))

    for i := k; i < len(nums); i++ {
        // Remove the departing value: find it, then splice it out.
        out := sort.SearchInts(window, nums[i-k])
        window = append(window[:out], window[out+1:]...)

        // Insert the arriving value at its sorted position.
        in := sort.SearchInts(window, nums[i])
        window = append(window, 0)
        copy(window[in+1:], window[in:])
        window[in] = nums[i]

        medians = append(medians, medianOfSorted(window, k))
    }
    return medians
}

// medianOfSorted reads the median directly from a sorted window.
func medianOfSorted(window []int, k int) float64 {
    if k%2 == 1 {
        return float64(window[k/2])
    }
    // Halve each side before adding: avoids overflow near the integer limit.
    return float64(window[k/2-1])/2.0 + float64(window[k/2])/2.0
}
```

```python
import bisect

def medianSlidingWindow(nums, k):
    window = sorted(nums[:k])          # kept sorted at all times

    def median():
        if k % 2 == 1:
            return float(window[k // 2])
        return (window[k // 2 - 1] + window[k // 2]) / 2.0

    medians = [median()]
    for i in range(k, len(nums)):
        window.pop(bisect.bisect_left(window, nums[i - k]))   # remove departing
        bisect.insort(window, nums[i])                        # insert arriving
        medians.append(median())
    return medians
```

### Complexity
Time **O(n · k)** — each slide does an O(log k) search but an O(k) shift. Space O(k).

> The lazy-deletion two-heap version reaches O(n log k). It is the right answer when `k` is large, but it needs a pending-removal map and manual size tracking — worth mentioning in an interview, and worth writing only if asked.

---

## 11. Solved Example 3

### Problem — IPO (LeetCode 502)
You may complete at most `k` projects. Project `i` needs `capital[i]` to start and yields `profits[i]`, which is added to your capital. Starting with `w`, maximise the final capital.

### Thought Process
1. This is the **other** two-heap shape: one heap decides *what is eligible*, the other decides *what is best among the eligible*.
2. Greedy claim: at each step, take the most profitable project you can currently **afford**. Profits are non-negative, so your capital never decreases — anything affordable now stays affordable later. Taking the biggest profit first can therefore never close a door.
3. Sort the projects by capital ascending. Keep a pointer into that list.
4. Before each pick, advance the pointer, pushing every newly-affordable project's **profit** into a max-heap.
5. Pop the max profit, add it to `w`, and repeat up to `k` times. If the heap is ever empty, nothing is affordable and we stop early.

### Dry Run

Input: `k = 2`, `w = 0`, `profits = [1, 2, 3]`, `capital = [0, 1, 1]`

Sorted by capital: `(cost 0, profit 1)`, `(cost 1, profit 2)`, `(cost 1, profit 3)`

| round | capital `w` | newly affordable (cost ≤ w) | profit max-heap | pop | new `w` |
|-------|-------------|------------------------------|-----------------|-----|---------|
| 1 | 0 | `(0, 1)` | `[1]` | **1** | `0 + 1 = 1` |
| 2 | 1 | `(1, 2)`, `(1, 3)` | `[3, 2]` | **3** | `1 + 3 = 4` |

Output: **4** ✓

Round 2 is the point of the pattern: raising `w` to 1 *unlocked* two projects at once, and only then could we compare them and take the better one. Neither heap alone could have made that decision.

### Visualization

```text
projects sorted by cost:   (0,1)   (1,2)   (1,3)
                             │       │       │
w = 0  → unlocks ────────────┘       │       │      profit heap: [1]  → take 1
w = 1  → unlocks ────────────────────┴───────┘      profit heap: [3,2] → take 3

final capital = 0 + 1 + 3 = 4
```

### Code

```go
// profitHeap is a max-heap of profits among currently affordable projects.
type profitHeap []int

func (h profitHeap) Len() int           { return len(h) }
func (h profitHeap) Less(i, j int) bool { return h[i] > h[j] } // max-heap
func (h profitHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *profitHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *profitHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

func findMaximizedCapital(k int, w int, profits []int, capital []int) int {
    type project struct{ cost, profit int }

    projects := make([]project, len(profits))
    for i := range profits {
        projects[i] = project{cost: capital[i], profit: profits[i]}
    }
    // Cheapest first, so one forward pointer unlocks projects in order.
    sort.Slice(projects, func(a, b int) bool {
        return projects[a].cost < projects[b].cost
    })

    affordable := &profitHeap{}
    heap.Init(affordable)
    next := 0

    for round := 0; round < k; round++ {
        // Unlock everything the current capital can now afford.
        for next < len(projects) && projects[next].cost <= w {
            heap.Push(affordable, projects[next].profit)
            next++
        }
        if affordable.Len() == 0 {
            break // nothing affordable: no further project can ever be taken
        }
        w += heap.Pop(affordable).(int) // take the most profitable
    }
    return w
}
```

```python
import heapq

def findMaximizedCapital(k, w, profits, capital):
    projects = sorted(zip(capital, profits))   # cheapest first
    affordable = []                            # max-heap via negation
    next_index = 0

    for _ in range(k):
        # Unlock everything the current capital can now afford.
        while next_index < len(projects) and projects[next_index][0] <= w:
            heapq.heappush(affordable, -projects[next_index][1])
            next_index += 1
        if not affordable:
            break                              # nothing affordable, ever
        w += -heapq.heappop(affordable)        # take the most profitable
    return w
```

### Complexity
Time **O(n log n + k log n)** — sorting the projects, then at most `n` pushes and `k` pops. Space O(n) for the heap.

> Note the pointer `next` never resets. Across the whole run each project is unlocked exactly once, so the inner `while` is amortised O(1) per project rather than O(n) per round.

---

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
