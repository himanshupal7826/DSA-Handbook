# 47 · Median of Stream

> **One-liner:** Online median via balanced two-heap, O(log n) insert, O(1) query.

---

## 1. Overview

### Definition
The **Median of Stream** pattern belongs to the *Heaps* family. Online median via balanced two-heap, O(log n) insert, O(1) query.

### Intuition
A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.

### Why it works
Maintain a size-k heap (or two heaps) so each insertion is O(log k) and the best/median is at the top. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Heaps run priority schedulers (OS, Kubernetes), event simulations, Dijkstra routing, k-nearest-neighbor serving, and streaming top-k dashboards. Bounded heap size gives predictable memory under load.

---

## 2. Recognition Signals

### Keywords
median, stream, two heaps, online, running median.

### Constraints
- Input size where the brute-force complexity would time out — the Median of Stream optimization is the intended solution.
- Structural hints in the statement that match this family (Heaps).

### Hidden clues
- The problem can be reframed so the Median of Stream invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Median of Stream is the upgrade.
- The wording maps onto: median, stream, two heaps, online, running median.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Report a statistic about the middle of my data, over and over, as the data keeps arriving."*

### Intuition
Store everything. Sort when asked.

### Algorithm
1. Append each arriving value to a list.
2. On each `findMedian()` call, sort the list.
3. Return the middle element, or the mean of the two middle ones.

### Complexity
- Time: O(1) per insert, **O(n log n) per query**.
- Space: O(n).

### Drawbacks
- Keeping a **sorted** list instead makes queries O(1), but each insert becomes O(n) because of the shifting. Either way one of the two operations is linear.
- The real issue is structural: **a median is not subtractable.** A running sum or count can be updated by adding the new value and subtracting the old one. A median cannot — removing one element can move it anywhere. So none of the cheap "maintain a running aggregate" tricks apply.

That single fact is why this pattern needs a data structure rather than a variable.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Store the data as two halves that face each other, so the answer is always sitting at the boundary.**

```text
      small half                      large half
  ┌─────────────────────┐      ┌─────────────────────┐
  │      max-heap       │      │      min-heap       │
  │  top = its LARGEST  │◀────▶│  top = its SMALLEST │
  └─────────────────────┘      └─────────────────────┘
              └──────── the median lives here ────────┘
```

Nothing is ever sorted. Both operations become cheap: `O(log n)` to insert, `O(1)` to read.

### The thought process

```text
We need    : the middle value, repeatedly, on growing data.
Obvious way: keep a list; sort on query (or insert in order).
Stuck      : one of insert/query is always O(n log n) or O(n).
Notice     : a median is NOT subtractable — no running-total trick
             will work. We need structure, not a variable.
Notice too : we never need the data ordered. We only need to know
             where the boundary between the halves is.
Therefore  : two heaps facing each other, tops = the boundary.
Now        : O(log n) insert, O(1) query.
```

### The two invariants

```text
1. ORDER:  max(low)  <=  min(high)
2. SIZE:   len(low) - len(high)  ∈  {0, 1}
```

Invariant 1 makes the tops the true middle. Invariant 2 says `low` carries the extra element on an odd count, so an odd count reads `low.top` directly.

### The three-step insert, and why the middle step exists

```text
Step 1 → push the value onto `low`
Step 2 → move low's top across to `high`
Step 3 → if high is now larger, move high's top back to low
```

Step 2 is the one that looks pointless and isn't. Pushing straight onto `low` may violate the ORDER invariant, because the new value could exceed something already in `high`. Sending `low`'s current maximum over to `high` repairs it **without any explicit comparison** — the heaps do the comparing. Step 3 then fixes the sizes.

### Reading the answer

```text
len(low) > len(high)  →  odd count   →  median = low.top
len(low) == len(high) →  even count  →  median = (low.top + high.top) / 2
```

For the even case prefer `low.top/2.0 + high.top/2.0` over `(low.top + high.top)/2.0`: the sum of two values near the integer limit overflows, the halves do not.

### The hard variant: a sliding window needs deletion

A binary heap can remove its **top**, not an arbitrary element. So the moment an old value must leave from the *middle* of the structure, the plain design breaks.

**Lazy deletion** is the standard fix, and it rests on one observation:

> You don't have to remove a value when it expires. You only have to make sure it is never *read*. And the only element you ever read is a top.

So:

```text
1. Keep a map  pending[value] → how many copies are due for removal.
2. Track the LOGICAL sizes yourself. heap.Len() now over-counts,
   so it can no longer be trusted for the size invariant.
3. Before reading any top, "prune": while the top is in `pending`,
   decrement its count and pop it for real.
```

The critical discipline: **`lowSize`/`highSize` are your own counters, not `heap.Len()`.** Every balance decision must use them. Mixing the two is the bug that makes lazy deletion so error-prone.

Cost stays **O(log k)** amortised: each value is inserted once and genuinely popped at most once.

### The follow-ups interviewers actually ask

Both exploit a constraint that makes the heaps unnecessary:

| Constraint | Better structure | Why |
|---|---|---|
| All values are in a small range (e.g. 0–100) | **counting array** + prefix scan | O(1) insert, O(range) query — no comparisons at all |
| 99% of values in 0–100, rare outliers | counting array for the bulk, plus two small lists for the tails | keeps the common case O(1) |
| Values arrive sorted | a plain array with an index | the median is a direct lookup |

### How should I recognize this?

```text
If you see...
  "median of a data stream", "running median", "middle value"
  "design a structure supporting add + median"
  a rolling statistic that is NOT a sum, count, or extremum
        ↓
Think about...
  "Is this statistic subtractable? If not, I need structure."
  "Can I split the data so the answer sits at the boundary?"
        ↓
Use...
  unbounded stream     → two heaps, sizes within 1
  sliding window       → two heaps + lazy deletion, or an ordered multiset
  small value range    → counting array, O(1) insert
```

### Visual explanation

```svg
<svg viewBox="0 0 640 255" width="100%" height="255" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="mds-47" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Median of a stream: two balanced heaps, read the roots</text>
  <text x="320" y="42" text-anchor="middle" fill="#64748b">add x, then rebalance so sizes differ by at most 1</text>
  <!-- divider -->
  <line x1="320" y1="58" x2="320" y2="212" stroke="#64748b" stroke-dasharray="4 4"/>
  <!-- left max-heap lower half -->
  <text x="128" y="72" text-anchor="middle" fill="#64748b">max-heap (lower half)</text>
  <line x1="128" y1="106" x2="93" y2="150" stroke="#475569"/>
  <line x1="128" y1="106" x2="163" y2="150" stroke="#475569"/>
  <circle cx="128" cy="92" r="20" fill="#ecfdf5" stroke="#059669"/><text x="128" y="97" text-anchor="middle" fill="#1e293b">4</text>
  <circle cx="93" cy="164" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="93" y="169" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="163" cy="164" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="163" y="169" text-anchor="middle" fill="#1e293b">3</text>
  <text x="128" y="214" text-anchor="middle" fill="#64748b">root 4 = max of lower</text>
  <!-- right min-heap upper half -->
  <text x="500" y="72" text-anchor="middle" fill="#64748b">min-heap (upper half)</text>
  <line x1="500" y1="106" x2="465" y2="150" stroke="#475569"/>
  <line x1="500" y1="106" x2="535" y2="150" stroke="#475569"/>
  <circle cx="500" cy="92" r="20" fill="#ecfdf5" stroke="#059669"/><text x="500" y="97" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="465" cy="164" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="465" y="169" text-anchor="middle" fill="#1e293b">8</text>
  <circle cx="535" cy="164" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="535" y="169" text-anchor="middle" fill="#1e293b">9</text>
  <text x="500" y="214" text-anchor="middle" fill="#64748b">root 5 = min of upper</text>
  <!-- median -->
  <line x1="148" y1="92" x2="255" y2="92" stroke="#475569" marker-end="url(#mds-47)"/>
  <line x1="480" y1="92" x2="385" y2="92" stroke="#475569" marker-end="url(#mds-47)"/>
  <text x="320" y="88" text-anchor="middle" fill="#059669" font-weight="700">median</text>
  <text x="320" y="106" text-anchor="middle" fill="#1e293b">(4+5)/2 = 4.5</text>
</svg>
```

```text
stream: 1, 2, 3, 4

after 1:  low [1]        high []        len 1 vs 0 → median = 1
after 2:  low [1]        high [2]       len 1 vs 1 → (1+2)/2 = 1.5
after 3:  low [2,1]      high [3]       len 2 vs 1 → median = 2
after 4:  low [2,1]      high [3,4]     len 2 vs 2 → (2+3)/2 = 2.5
               ▲              ▲
           max-heap       min-heap
           top = 2        top = 3

every value in low  <=  every value in high
```

### Interview explanation
"A median isn't subtractable, so no running-aggregate trick works — I need a structure. I keep two heaps: a max-heap for the smaller half and a min-heap for the larger half, with sizes differing by at most one. The invariant that everything in the low heap is at most everything in the high heap makes the two tops the middle elements, so the median is an O(1) peek and insertion is O(log n). To insert I push onto the low heap, move its top across to the high heap — that step repairs the ordering without any explicit comparison — then move back if the high heap grew larger. For a sliding-window version I'd add lazy deletion: mark expired values in a map, track the logical sizes myself since `heap.Len()` now over-counts, and prune before reading any top. And if the values were bounded to a small range I'd drop the heaps entirely for a counting array."

---

## 5. Generic Templates

> Two heaps, two invariants, a three-step insert — plus lazy deletion when values must expire.

```go
// maxHalf keeps the largest value on top (the low half).
type maxHalf []int

func (h maxHalf) Len() int           { return len(h) }
func (h maxHalf) Less(i, j int) bool { return h[i] > h[j] }
func (h maxHalf) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *maxHalf) Push(x any)        { *h = append(*h, x.(int)) }
func (h *maxHalf) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

// minHalf keeps the smallest value on top (the high half).
type minHalf []int

func (h minHalf) Len() int           { return len(h) }
func (h minHalf) Less(i, j int) bool { return h[i] < h[j] }
func (h minHalf) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *minHalf) Push(x any)        { *h = append(*h, x.(int)) }
func (h *minHalf) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

// StreamMedian is the unbounded-stream version: no deletion needed.
type StreamMedian struct {
    low  *maxHalf
    high *minHalf
}

func NewStreamMedian() *StreamMedian {
    return &StreamMedian{low: &maxHalf{}, high: &minHalf{}}
}

func (s *StreamMedian) Add(value int) {
    heap.Push(s.low, value)                  // 1. always into low
    heap.Push(s.high, heap.Pop(s.low))       // 2. repair the ORDER invariant
    if s.high.Len() > s.low.Len() {          // 3. repair the SIZE invariant
        heap.Push(s.low, heap.Pop(s.high))
    }
}

func (s *StreamMedian) Median() float64 {
    if s.low.Len() > s.high.Len() {
        return float64((*s.low)[0]) // odd count: the extra element is in low
    }
    return float64((*s.low)[0])/2.0 + float64((*s.high)[0])/2.0
}

// BoundedMedian is the follow-up answer when values live in a small range:
// a counting array, O(1) insert and no comparisons at all.
type BoundedMedian struct {
    counts []int // counts[v] = how many times v has been seen
    total  int
}

func NewBoundedMedian(maxValue int) *BoundedMedian {
    return &BoundedMedian{counts: make([]int, maxValue+1)}
}

func (b *BoundedMedian) Add(value int) {
    b.counts[value]++
    b.total++
}

// Median scans the counts to find the middle position(s).
func (b *BoundedMedian) Median() float64 {
    lowerRank := (b.total - 1) / 2 // 0-based rank of the lower middle
    upperRank := b.total / 2       // equals lowerRank when total is odd

    lowerValue, upperValue := 0, 0
    seen := 0
    for value, count := range b.counts {
        if count == 0 {
            continue
        }
        if seen <= lowerRank && lowerRank < seen+count {
            lowerValue = value
        }
        if seen <= upperRank && upperRank < seen+count {
            upperValue = value
            break // upperRank >= lowerRank, so both are now known
        }
        seen += count
    }
    return float64(lowerValue)/2.0 + float64(upperValue)/2.0
}
```

```python
import heapq

class StreamMedian:
    """low is a max-heap (negated); high is a min-heap."""

    def __init__(self):
        self.low = []
        self.high = []

    def add(self, value):
        heapq.heappush(self.low, -value)                      # 1. into low
        heapq.heappush(self.high, -heapq.heappop(self.low))   # 2. repair ORDER
        if len(self.high) > len(self.low):                    # 3. repair SIZE
            heapq.heappush(self.low, -heapq.heappop(self.high))

    def median(self):
        if len(self.low) > len(self.high):
            return float(-self.low[0])
        return (-self.low[0] + self.high[0]) / 2.0

class BoundedMedian:
    """Follow-up: values in a small known range need no heaps at all."""

    def __init__(self, max_value):
        self.counts = [0] * (max_value + 1)
        self.total = 0

    def add(self, value):
        self.counts[value] += 1
        self.total += 1

    def median(self):
        lower_rank = (self.total - 1) // 2
        upper_rank = self.total // 2
        lower = upper = 0
        seen = 0
        for value, count in enumerate(self.counts):
            if count == 0:
                continue
            if seen <= lower_rank < seen + count:
                lower = value
            if seen <= upper_rank < seen + count:
                upper = value
                break
            seen += count
        return (lower + upper) / 2.0
```

```java
import java.util.*;

public class StreamMedian {
    private final PriorityQueue<Integer> low  = new PriorityQueue<>(Comparator.reverseOrder());
    private final PriorityQueue<Integer> high = new PriorityQueue<>();

    public void add(int value) {
        low.add(value);          // 1. into low
        high.add(low.poll());    // 2. repair ORDER
        if (high.size() > low.size()) low.add(high.poll());   // 3. repair SIZE
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

class StreamMedian {
    priority_queue<int> low;                                  // max-heap: small half
    priority_queue<int, vector<int>, greater<int>> high;      // min-heap: large half

public:
    void add(int value) {
        low.push(value);                     // 1. into low
        high.push(low.top()); low.pop();     // 2. repair ORDER
        if (high.size() > low.size()) {      // 3. repair SIZE
            low.push(high.top());
            high.pop();
        }
    }

    double median() const {
        if (low.size() > high.size()) return low.top();       // odd count
        return low.top() / 2.0 + high.top() / 2.0;
    }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Median of Stream (Optimal) |
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
Design a structure supporting `addNum(num)` and `findMedian()` on an unbounded stream.

### Thought Process
1. A median is not subtractable, so we need a structure rather than a running variable.
2. Split the data into a low half (max-heap) and a high half (min-heap); the two tops straddle the middle.
3. Insert with the three-step ritual so both invariants hold no matter what arrives.
4. Read the median from the tops — `low`'s top on an odd count, the average of both on an even one.
5. Halve each side before adding in the even case to avoid integer overflow.

### Dry Run

Operations: `addNum(1)`, `addNum(2)`, `findMedian()`, `addNum(3)`, `findMedian()`

| operation | after step 1 (push low) | after step 2 (low→high) | after step 3 (rebalance) | low | high | median |
|-----------|-------------------------|--------------------------|---------------------------|-----|------|--------|
| `addNum(1)` | low `[1]` | low `[]`, high `[1]` | high bigger → move back | `[1]` | `[]` | — |
| `addNum(2)` | low `[2,1]` | low `[1]`, high `[2]` | equal sizes → no move | `[1]` | `[2]` | — |
| `findMedian()` | | | | `[1]` | `[2]` | `1/2 + 2/2` = **1.5** |
| `addNum(3)` | low `[3,1]` | low `[1]`, high `[2,3]` | high bigger → move `2` back | `[2,1]` | `[3]` | — |
| `findMedian()` | | | | `[2,1]` | `[3]` | low.top = **2** |

Output: **1.5**, then **2** ✓

Check by hand: the data is `{1,2}` then `{1,2,3}`, whose medians are 1.5 and 2. ✓

Watch `addNum(3)`: pushing 3 onto the max-heap put it on top, and step 2 immediately shipped it to `high` where it belongs. We never compared 3 to anything — the heap ordering did it for us.

### Visualization

```text
after addNum(3):

     low (max-heap)         high (min-heap)
        [2, 1]                   [3]
          ▲                       ▲
       top = 2                 top = 3

  sorted view:   1   2 │ 3
                       ↑
                 median = 2   (low holds the extra element)
```

### Code

```go
type MedianFinder struct {
    low  *maxHalfHeap // smaller half; top is its largest
    high *minHalfHeap // larger half; top is its smallest
}

func NewMedianFinder() MedianFinder {
    return MedianFinder{low: &maxHalfHeap{}, high: &minHalfHeap{}}
}

func (m *MedianFinder) AddNum(num int) {
    heap.Push(m.low, num)                 // 1. always into low
    heap.Push(m.high, heap.Pop(m.low))    // 2. repair the ORDER invariant
    if m.high.Len() > m.low.Len() {       // 3. repair the SIZE invariant
        heap.Push(m.low, heap.Pop(m.high))
    }
}

func (m *MedianFinder) FindMedian() float64 {
    if m.low.Len() > m.high.Len() {
        return float64((*m.low)[0]) // odd count: extra element lives in low
    }
    return float64((*m.low)[0])/2.0 + float64((*m.high)[0])/2.0
}

type maxHalfHeap []int

func (h maxHalfHeap) Len() int           { return len(h) }
func (h maxHalfHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h maxHalfHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *maxHalfHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *maxHalfHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

type minHalfHeap []int

func (h minHalfHeap) Len() int           { return len(h) }
func (h minHalfHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h minHalfHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *minHalfHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *minHalfHeap) Pop() any {
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
        heapq.heappush(self.high, -heapq.heappop(self.low))   # 2. repair ORDER
        if len(self.high) > len(self.low):                    # 3. repair SIZE
            heapq.heappush(self.low, -heapq.heappop(self.high))

    def findMedian(self):
        if len(self.low) > len(self.high):
            return float(-self.low[0])
        return (-self.low[0] + self.high[0]) / 2.0
```

### Complexity
`addNum` **O(log n)**, `findMedian` **O(1)**, space O(n).

---

## 10. Solved Example 2

### Problem — Sliding Window Median (LeetCode 480)
Return the median of every window of size `k`.

### Thought Process
1. Same two heaps, but now values **expire** — and a heap cannot remove from its middle.
2. **Lazy deletion**: don't remove an expired value, just make sure it is never *read*. Since the only thing we ever read is a top, it suffices to discard expired values when they surface there.
3. Keep `pending[value] → count` of values due for removal.
4. **Track the logical sizes yourself.** Once stale entries linger, `heap.Len()` over-counts, so every balance decision must use `lowSize`/`highSize` instead.
5. Before reading any top — for the median, for a balance move, or to decide which half a departing value belonged to — **prune** first.

### Dry Run

Input: `nums = [1, 3, -1, -3, 5, 3, 6, 7]`, `k = 3`

| window | low (max-heap, live values) | high (min-heap, live) | lowSize / highSize | median |
|--------|------------------------------|------------------------|--------------------|--------|
| `[1, 3, -1]`  | `[1, -1]` | `[3]`  | 2 / 1 | **1** |
| `[3, -1, -3]` | `[-1, -3]` | `[3]` | 2 / 1 | **−1** |
| `[-1, -3, 5]` | `[-1, -3]` | `[5]` | 2 / 1 | **−1** |
| `[-3, 5, 3]`  | `[3, -3]` | `[5]`  | 2 / 1 | **3** |
| `[5, 3, 6]`   | `[5, 3]` | `[6]`   | 2 / 1 | **5** |
| `[3, 6, 7]`   | `[6, 3]` | `[7]`   | 2 / 1 | **6** |

Output: **`[1, -1, -1, 3, 5, 6]`** ✓

**Lazy deletion in action.** Sliding from window 1 to window 2 removes the value `1`:

```text
1. prune low → its top is -1... wait, low is a MAX-heap: top is 1
2. 1 <= low.top (1)  →  it belonged to the LOW half  →  lowSize-- (2 → 1)
3. pending[1] = 1
4. prune low → top IS 1 and it is pending → pop it for real, pending[1] = 0
5. add -3: -3 <= low.top → into low, lowSize++ (1 → 2)
6. rebalance using lowSize/highSize, NOT heap.Len()
```

Step 6 is the whole discipline. At that moment `heap.Len()` may still count entries that are logically gone; only the manual counters are trustworthy.

### Visualization

```text
window [1, 3, -1]        low(max) [1, -1]     high(min) [3]
                              ▲
                          median = 1        (lowSize 2 > highSize 1)

slide: 1 expires
       ├─ mark pending[1]
       ├─ lowSize 2 → 1
       └─ prune: 1 is at the top → really popped now

       -3 arrives → low [-1, -3], high [3]   → median = -1
```

### Code

```go
// slidingMedian is two heaps plus lazy deletion.
type slidingMedian struct {
    low     *maxLazyHeap   // smaller half
    high    *minLazyHeap   // larger half
    pending map[int]int    // value -> copies awaiting removal
    lowSize int            // LIVE elements in low (heap.Len() over-counts)
    highSize int           // LIVE elements in high
}

func newSlidingMedian() *slidingMedian {
    return &slidingMedian{
        low:     &maxLazyHeap{},
        high:    &minLazyHeap{},
        pending: map[int]int{},
    }
}

// pruneLow discards stale entries sitting at low's top.
func (s *slidingMedian) pruneLow() {
    for s.low.Len() > 0 {
        top := (*s.low)[0]
        if s.pending[top] == 0 {
            return
        }
        s.pending[top]--
        heap.Pop(s.low)
    }
}

func (s *slidingMedian) pruneHigh() {
    for s.high.Len() > 0 {
        top := (*s.high)[0]
        if s.pending[top] == 0 {
            return
        }
        s.pending[top]--
        heap.Pop(s.high)
    }
}

func (s *slidingMedian) add(value int) {
    s.pruneLow()
    if s.lowSize == 0 || value <= (*s.low)[0] {
        heap.Push(s.low, value)
        s.lowSize++
    } else {
        heap.Push(s.high, value)
        s.highSize++
    }
    s.rebalance()
}

func (s *slidingMedian) remove(value int) {
    s.pruneLow()
    // Decide which half it belonged to BEFORE marking it pending,
    // otherwise pruning could change the top we are comparing against.
    inLow := s.lowSize > 0 && value <= (*s.low)[0]

    s.pending[value]++
    if inLow {
        s.lowSize--
        s.pruneLow()
    } else {
        s.highSize--
        s.pruneHigh()
    }
    s.rebalance()
}

// rebalance uses the LOGICAL sizes, never heap.Len().
func (s *slidingMedian) rebalance() {
    if s.lowSize > s.highSize+1 {
        s.pruneLow()
        heap.Push(s.high, heap.Pop(s.low))
        s.lowSize--
        s.highSize++
    } else if s.lowSize < s.highSize {
        s.pruneHigh()
        heap.Push(s.low, heap.Pop(s.high))
        s.highSize--
        s.lowSize++
    }
}

func (s *slidingMedian) median() float64 {
    s.pruneLow()
    s.pruneHigh()
    if s.lowSize > s.highSize {
        return float64((*s.low)[0])
    }
    return float64((*s.low)[0])/2.0 + float64((*s.high)[0])/2.0
}

func medianSlidingWindow(nums []int, k int) []float64 {
    s := newSlidingMedian()
    medians := make([]float64, 0, len(nums)-k+1)

    for i, v := range nums {
        s.add(v)
        if i >= k {
            s.remove(nums[i-k]) // the value leaving the window
        }
        if i >= k-1 {
            medians = append(medians, s.median())
        }
    }
    return medians
}

type maxLazyHeap []int

func (h maxLazyHeap) Len() int           { return len(h) }
func (h maxLazyHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h maxLazyHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *maxLazyHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *maxLazyHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

type minLazyHeap []int

func (h minLazyHeap) Len() int           { return len(h) }
func (h minLazyHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h minLazyHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *minLazyHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *minLazyHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import bisect

def medianSlidingWindow(nums, k):
    """Python ships no lazy-deletion heap, and a sorted window is clearer here.
    bisect.insort is O(k) for the shift, giving O(n*k) overall."""
    window = sorted(nums[:k])

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
Go version: **O(n log k)** amortised — each value is inserted once and genuinely popped at most once; stale entries are bounded by the number of removals. Space O(k) live plus the pending map.

Python version: O(n · k) from the list shifting, but far shorter. Reach for `SortedList` from `sortedcontainers` if you need O(n log k) in Python.

---

## 11. Solved Example 3

### Problem — Moving Average from Data Stream (LeetCode 346)
Return the average of the last `size` values as each new value arrives.

### Thought Process
1. Included here as the deliberate contrast: an **average is subtractable**, a median is not.
2. So no heaps, no structure — just a running sum and a queue holding the window.
3. On each value: add it to the sum and the queue. If the queue is now oversized, subtract and drop the front.
4. The average is `sum / len(queue)`, which handles the warm-up period before the window is full.
5. This is why medians need their own chapter: swap "average" for "median" and none of this works.

### Dry Run

Input: `size = 3`, then `next(1)`, `next(10)`, `next(3)`, `next(5)`

| call | queue after add | sum | oversized? | queue after evict | sum | average |
|------|-----------------|-----|------------|--------------------|-----|---------|
| `next(1)`  | `[1]`         | 1  | no  | `[1]`        | 1  | `1/1` = **1.0** |
| `next(10)` | `[1,10]`      | 11 | no  | `[1,10]`     | 11 | `11/2` = **5.5** |
| `next(3)`  | `[1,10,3]`    | 14 | no  | `[1,10,3]`   | 14 | `14/3` ≈ **4.66667** |
| `next(5)`  | `[1,10,3,5]`  | 19 | yes | drop `1` → `[10,3,5]` | 18 | `18/3` = **6.0** |

Output: **1.0, 5.5, 4.66667, 6.0** ✓

The last row is the whole point: evicting `1` cost one subtraction. Evicting a value from a *median* structure would require knowing where it sits — which is exactly what forced the two heaps and the lazy-deletion machinery in Example 2.

### Visualization

```text
subtractable statistic → O(1) eviction:

   sum 14   [1, 10, 3]        add 5 → sum 19, queue [1,10,3,5]
                              evict 1 → sum 19 - 1 = 18, queue [10,3,5]
                              average = 18/3 = 6.0

a median has no such shortcut — removing one value can move it anywhere
```

### Code

```go
type MovingAverage struct {
    size   int
    window []int // the last `size` values, oldest first
    sum    int   // running total of `window`
}

func NewMovingAverage(size int) MovingAverage {
    return MovingAverage{size: size}
}

func (m *MovingAverage) Next(value int) float64 {
    m.window = append(m.window, value)
    m.sum += value

    // An average IS subtractable: eviction is one subtraction.
    if len(m.window) > m.size {
        m.sum -= m.window[0]
        m.window = m.window[1:]
    }

    return float64(m.sum) / float64(len(m.window))
}
```

```python
from collections import deque

class MovingAverage:
    def __init__(self, size):
        self.size = size
        self.window = deque()
        self.total = 0

    def next(self, value):
        self.window.append(value)
        self.total += value
        if len(self.window) > self.size:     # averages are subtractable
            self.total -= self.window.popleft()
        return self.total / len(self.window)
```

### Complexity
**O(1)** per call, space O(size). Compare with O(log k) per step for the median — the gap is exactly the price of a statistic you cannot subtract.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 295 | Median Stream | Easy | Core heaps application |
| 480 | Sliding Median | Easy | Core heaps application |
| 346 | Moving Average | Medium | Core heaps application |
| 703 | Kth Largest Stream | Medium | Core heaps application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Median of Stream logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Median of Stream (Heaps).
- **Signal:** median, stream, two heaps, online, running median.
- **Move:** A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.
- **Cost:** O(n log k) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Median of Stream invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Median of Stream
FAMILY : Heaps (Advanced)
WHEN   : median, stream, two heaps, online, running median
DO     : A heap gives O(1) access to the extreme element and O(log n) updates — perfect f
TIME   : O(n log k)    SPACE: O(k)
PRACTICE: 295, 480, 346, 703
```

---

*Part of the DSA Patterns Handbook — pattern 47 of 100.*
