# 88 · Huffman Greedy

> **One-liner:** Repeatedly merge the two smallest weights via a heap for optimal cost.

---

## 1. Overview

### Definition
The **Huffman Greedy** pattern belongs to the *Greedy* family. Repeatedly merge the two smallest weights via a heap for optimal cost.

### Intuition
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Why it works
Make the locally optimal choice that a proof (exchange argument) shows is globally safe — usually after sorting. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.

---

## 2. Recognition Signals

### Keywords
huffman, greedy, heap, encoding, merge cost, optimal.

### Constraints
- Input size where the brute-force complexity would time out — the Huffman Greedy optimization is the intended solution.
- Structural hints in the statement that match this family (Greedy).

### Hidden clues
- The problem can be reframed so the Huffman Greedy invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Huffman Greedy is the upgrade.
- The wording maps onto: huffman, greedy, heap, encoding, merge cost, optimal.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"I must combine these items one pair at a time, and each combination costs something — what order minimises the total?"*

### Intuition
The order of merges changes the total cost, so try every order.

### Algorithm
1. Pick any two items to merge; the cost is their combined size.
2. Replace them with the merged item.
3. Recurse on the smaller collection.
4. Take the minimum over every choice of pair at every step.

### Complexity
- Time: **O(n! )**-ish — there are `C(n,2)` choices at the first step, `C(n−1,2)` at the next, and so on.
- Space: O(n) recursion depth.

### Drawbacks
- Unusable past about 10 items.
- And it is unnecessary. There is a local rule — always merge the two smallest — that is provably optimal. The value of this chapter is the *proof*, because the same argument justifies a whole family of "combine cheaply" problems.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Always merge the two smallest items — because whatever you merge early gets counted again at every merge above it, so the smallest things should be merged deepest.**

### The thought process

```text
We need    : the cheapest sequence of pairwise merges.
Obvious way: try every order.
Hopeless   : factorial.
Notice     : a merged item is merged AGAIN later, so its size is paid
             once more each time. An item's total contribution is
             (its size) x (how many merges it participates in)
             = its DEPTH in the merge tree.
Therefore  : to minimise the total, big items must be shallow and
             small items deep — so merge the two smallest first.
Now        : a min-heap gives them in O(log n) each → O(n log n).
```

### The cost model, made precise

Think of the merges as a binary tree: each leaf is an original item and each internal node is a merge. The cost of a merge is the sum of everything beneath it, so:

```text
total cost = Σ over items ( size of item × depth of item )
```

That single formula is why this is Huffman coding. Minimising a depth-weighted sum means **the largest weights get the smallest depths** — and building bottom-up by repeatedly taking the two smallest achieves exactly that.

### Why the greedy choice is safe

The exchange argument again, in its Huffman form.

Let `a` and `b` be the two smallest items. In an optimal merge tree, take the two deepest leaves — they must be siblings (an internal node has two children, and if one deepest leaf had no sibling at that depth the tree could be shortened).

Now swap `a` and `b` into those two deepest positions. Since `a` and `b` are the smallest of all items, moving them **deeper** and moving the displaced items **shallower** cannot increase `Σ size × depth`:

```text
swapping a small weight to a deeper slot and a large weight to a
shallower slot changes the total by (small - large) × (depthDiff) ≤ 0
```

So there is an optimal tree in which the two smallest are siblings at the bottom — which is exactly what the greedy commits to. After merging them, the remaining problem is the same problem on `n − 1` items.

### Steps

```text
Step 1 → Put every item in a MIN-heap.
Step 2 → total = 0
Step 3 → While more than one item remains:
Step 4 →     a = pop smallest
Step 5 →     b = pop next smallest
Step 6 →     total += a + b        ← the cost of this merge
Step 7 →     push (a + b)          ← the merged item can merge again
Step 8 → Return total
```

Sorting once is **not** enough: merged items re-enter the collection and may be smaller than originals still waiting. That is precisely what a heap handles and a sorted array does not.

### The mirror image: always take the two largest

Some problems in this family want the opposite extreme — Last Stone Weight repeatedly smashes the two **heaviest** stones. The skeleton is identical; only the heap direction flips.

| Problem | Heap | Merge rule |
|---|---|---|
| Connect sticks / Huffman (1167) | **min**-heap | cost is `a + b`, minimise the total |
| Last Stone Weight (1046) | **max**-heap | push back `|a − b|` if non-zero |
| Merge k sorted lists | min-heap | not a cost problem — just ordering |

The tell is *"repeatedly take the extreme two, combine, put the result back."* When you see it, reach for a heap rather than re-sorting.

### When greedy is not the answer

Not every "combine things" problem is Huffman. If merges are **constrained** — only adjacent items may combine, as in matrix-chain multiplication or "burst balloons" — the exchange argument breaks, because you cannot freely move items to be siblings. Those need interval DP, O(n³).

```text
any two may merge      →  greedy with a heap,  O(n log n)
only ADJACENT may merge →  interval DP,        O(n^3)
```

### How should I recognize this?

```text
If you see...
  "minimum cost to connect / combine / merge everything"
  "repeatedly take the two smallest (or largest) and combine"
  "build an optimal prefix code", "minimise total weighted depth"
        ↓
Think about...
  "Does an item's cost get paid again each time it is merged?
   Then its depth is what matters → smallest go deepest."
  "Can ANY two combine, or only adjacent ones?"
        ↓
Use...
  any two, minimise → min-heap, merge the two smallest
  any two, extremes → max-heap, same skeleton
  adjacent only     → interval DP, not greedy
```

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-88" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Pop the two smallest weights, merge them into a parent, push it back</text>
  <!-- min heap leaves: 2 3 5 7 -->
  <text x="60" y="55" fill="#64748b">min-heap:</text>
  <circle cx="150" cy="70" r="20" fill="#ecfdf5" stroke="#059669"/><text x="150" y="75" text-anchor="middle" fill="#059669" font-weight="700">2</text>
  <circle cx="210" cy="70" r="20" fill="#ecfdf5" stroke="#059669"/><text x="210" y="75" text-anchor="middle" fill="#059669" font-weight="700">3</text>
  <circle cx="270" cy="70" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="270" y="75" text-anchor="middle" fill="#1e293b">5</text>
  <circle cx="330" cy="70" r="20" fill="#eff6ff" stroke="#2563eb"/><text x="330" y="75" text-anchor="middle" fill="#1e293b">7</text>
  <text x="180" y="105" text-anchor="middle" fill="#059669">two smallest</text>
  <line x1="400" y1="70" x2="450" y2="70" stroke="#475569" marker-end="url(#a-88)"/>
  <text x="425" y="60" text-anchor="middle" fill="#64748b">merge</text>
  <!-- merged subtree: parent 5 with children 2 and 3 -->
  <circle cx="530" cy="60" r="22" fill="#fff7ed" stroke="#d97706"/><text x="530" y="65" text-anchor="middle" fill="#d97706" font-weight="700">5</text>
  <line x1="514" y1="75" x2="495" y2="110" stroke="#475569"/>
  <line x1="546" y1="75" x2="565" y2="110" stroke="#475569"/>
  <circle cx="490" cy="125" r="18" fill="#ecfdf5" stroke="#059669"/><text x="490" y="130" text-anchor="middle" fill="#059669" font-weight="700">2</text>
  <circle cx="570" cy="125" r="18" fill="#ecfdf5" stroke="#059669"/><text x="570" y="130" text-anchor="middle" fill="#059669" font-weight="700">3</text>
  <text x="320" y="185" text-anchor="middle" fill="#64748b">push parent 5 back → heap now {5, 5, 7}, repeat until one node remains</text>
  <text x="320" y="212" text-anchor="middle" fill="#059669" font-weight="700">smaller weights sit deeper → shorter codes for frequent symbols</text>
</svg>
```

```text
sticks = [2, 4, 3]

heap {2, 3, 4}   pop 2 and 3  →  cost 5,  push 5
heap {4, 5}      pop 4 and 5  →  cost 9,  push 9
heap {9}         done                       total = 14

as a merge tree:

              9
            /   \
           5     4        depth 1
          / \
         2   3            depth 2

cost = 2x2 + 3x2 + 4x1 = 4 + 6 + 4 = 14
       └── the smallest items sit deepest ──┘
```

### Interview explanation
"Each merge costs the combined size, and a merged item gets merged again later — so an item's size is paid once for every merge it takes part in. That means the total is the sum of `size × depth` in the merge tree, and minimising a depth-weighted sum means the largest items must be shallowest. Building bottom-up, that translates to always merging the two smallest, which a min-heap supplies in O(log n). The proof is an exchange argument: in any optimal tree the two deepest leaves are siblings, and swapping the two globally smallest items into those slots can't increase the total, so an optimal tree containing the greedy choice exists. Sorting once isn't sufficient, because merged items re-enter the pool and can be smaller than originals still waiting — that's exactly what the heap handles. Overall O(n log n). I'd also flag the boundary: if only *adjacent* items may merge, the exchange argument fails and you need interval DP instead."

---

## 5. Generic Templates

> Min-heap, pop two, push the sum. Flip the heap for the take-the-largest variants.

```go
// MinMergeCost returns the minimum total cost of merging every item into
// one, where merging a and b costs a + b.
func MinMergeCost(items []int) int {
    if len(items) <= 1 {
        return 0 // nothing to merge
    }

    remaining := &minCostHeap{}
    *remaining = append(*remaining, items...)
    heap.Init(remaining)

    total := 0
    for remaining.Len() > 1 {
        // The two smallest go deepest in the merge tree.
        first := heap.Pop(remaining).(int)
        second := heap.Pop(remaining).(int)

        merged := first + second
        total += merged // this merge costs the combined size

        // The merged item competes again — which is why a heap is needed
        // and a single sort is not enough.
        heap.Push(remaining, merged)
    }
    return total
}

type minCostHeap []int

func (h minCostHeap) Len() int           { return len(h) }
func (h minCostHeap) Less(i, j int) bool { return h[i] < h[j] } // min-heap
func (h minCostHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *minCostHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *minCostHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}

// SmashLargestTwo is the mirror image: repeatedly combine the two LARGEST,
// pushing back their difference. Same skeleton, flipped heap.
func SmashLargestTwo(weights []int) int {
    remaining := &maxCostHeap{}
    *remaining = append(*remaining, weights...)
    heap.Init(remaining)

    for remaining.Len() > 1 {
        heaviest := heap.Pop(remaining).(int)
        second := heap.Pop(remaining).(int)

        if heaviest != second {
            heap.Push(remaining, heaviest-second) // the survivor
        }
        // Equal weights annihilate each other: nothing is pushed back.
    }

    if remaining.Len() == 0 {
        return 0
    }
    return (*remaining)[0]
}

type maxCostHeap []int

func (h maxCostHeap) Len() int           { return len(h) }
func (h maxCostHeap) Less(i, j int) bool { return h[i] > h[j] } // max-heap
func (h maxCostHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *maxCostHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *maxCostHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

def min_merge_cost(items):
    """Minimum total cost of merging everything, where merging a and b
    costs a + b."""
    if len(items) <= 1:
        return 0

    remaining = list(items)
    heapq.heapify(remaining)            # min-heap

    total = 0
    while len(remaining) > 1:
        first = heapq.heappop(remaining)    # the two smallest go deepest
        second = heapq.heappop(remaining)

        merged = first + second
        total += merged                     # this merge costs the sum
        heapq.heappush(remaining, merged)   # it competes again

    return total

def smash_largest_two(weights):
    """Mirror image: combine the two LARGEST, push back the difference."""
    remaining = [-w for w in weights]   # max-heap via negation
    heapq.heapify(remaining)

    while len(remaining) > 1:
        heaviest = -heapq.heappop(remaining)
        second = -heapq.heappop(remaining)
        if heaviest != second:
            heapq.heappush(remaining, -(heaviest - second))
        # Equal weights annihilate: nothing is pushed back.

    return -remaining[0] if remaining else 0
```

```java
import java.util.*;

public class HuffmanGreedy {
    // Merging a and b costs a + b; minimise the total.
    public static long minMergeCost(int[] items) {
        if (items.length <= 1) return 0;

        PriorityQueue<Long> remaining = new PriorityQueue<>();   // min-heap
        for (int item : items) remaining.add((long) item);

        long total = 0;
        while (remaining.size() > 1) {
            long first = remaining.poll();       // two smallest go deepest
            long second = remaining.poll();
            long merged = first + second;
            total += merged;
            remaining.add(merged);               // it competes again
        }
        return total;
    }

    // Mirror image: combine the two LARGEST.
    public static int smashLargestTwo(int[] weights) {
        PriorityQueue<Integer> remaining = new PriorityQueue<>(Comparator.reverseOrder());
        for (int w : weights) remaining.add(w);

        while (remaining.size() > 1) {
            int heaviest = remaining.poll();
            int second = remaining.poll();
            if (heaviest != second) remaining.add(heaviest - second);
        }
        return remaining.isEmpty() ? 0 : remaining.peek();
    }
}
```

```cpp
#include <queue>
#include <vector>
using namespace std;

// Merging a and b costs a + b; minimise the total.
long long minMergeCost(const vector<int>& items) {
    if (items.size() <= 1) return 0;

    priority_queue<long long, vector<long long>, greater<>> remaining;  // min-heap
    for (int item : items) remaining.push(item);

    long long total = 0;
    while (remaining.size() > 1) {
        long long first = remaining.top(); remaining.pop();
        long long second = remaining.top(); remaining.pop();

        long long merged = first + second;
        total += merged;
        remaining.push(merged);          // the merged item competes again
    }
    return total;
}

// Mirror image: combine the two LARGEST.
int smashLargestTwo(const vector<int>& weights) {
    priority_queue<int> remaining(weights.begin(), weights.end());  // max-heap

    while (remaining.size() > 1) {
        int heaviest = remaining.top(); remaining.pop();
        int second = remaining.top(); remaining.pop();
        if (heaviest != second) remaining.push(heaviest - second);
    }
    return remaining.empty() ? 0 : remaining.top();
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Huffman Greedy (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n log n)** |
| Time (best)  | — | **O(n log n)** |
| Time (average) | — | **O(n log n)** |
| Space | varies | **O(1)** |

> Sorting dominates; the greedy sweep is O(n).

---

## 7. Common Mistakes

1. Assuming greedy works without proving the exchange argument.
2. Sorting by the wrong key (e.g., start instead of finish time).
3. Ties broken incorrectly, flipping the result.
4. Greedy on a problem that actually needs DP.
5. Not handling the empty / single-element case.
6. Integer overflow in running totals (e.g., gas station).
7. Resetting accumulators at the wrong moment.
8. Off-by-one in reachability (jump game).
9. Forgetting that local optimum ≠ global without the safety proof.
10. Mutating input order when it matters downstream.

---

## 8. Interview Follow-Up Questions

1. **Q: How to know greedy is valid?**
   A: Prove an exchange argument: swapping to the greedy choice never worsens the optimum.

2. **Q: Activity selection key?**
   A: Sort by earliest finish time.

3. **Q: Jump game reachability?**
   A: Track the farthest reachable index.

4. **Q: Jump game II min jumps?**
   A: BFS-like greedy over reach boundaries.

5. **Q: Gas station start?**
   A: Reset start when the running tank goes negative.

6. **Q: Huffman coding?**
   A: Repeatedly merge the two smallest weights (heap).

7. **Q: Greedy vs DP?**
   A: Greedy when local choice is safe; DP when you must compare futures.

8. **Q: Fractional vs 0/1 knapsack?**
   A: Fractional is greedy; 0/1 needs DP.

9. **Q: Min arrows to burst balloons?**
   A: Greedy by end coordinate.

10. **Q: Task scheduling with cooldown?**
   A: Greedy with counts + idle slots, or heap.

11. **Q: Why O(n log n)?**
   A: Sorting dominates the single greedy pass.

12. **Q: Counterexample habit?**
   A: Always try to break greedy with a small case.

13. **Q: Stability of choice?**
   A: Document tie-breaking explicitly.

14. **Q: Interval partitioning (min rooms)?**
   A: Sweep / heap of end times.

15. **Q: Coin change greedy fails when?**
   A: Non-canonical coin systems need DP.

---

## 9. Solved Example 1

### Problem — Minimum Cost to Connect Sticks (LeetCode 1167)
You have sticks of various lengths. Connecting two sticks of lengths `x` and `y` costs `x + y` and produces one stick of length `x + y`. Return the minimum total cost to connect them all into one.

### Thought Process
1. A connected stick gets connected **again**, so its length is paid once more at every later merge — an original stick's total contribution is `length × depth` in the merge tree.
2. Minimising `Σ length × depth` means the longest sticks must be shallowest, so the **shortest go deepest**.
3. Built bottom-up, that means always merging the two shortest available sticks.
4. A min-heap supplies them in O(log n), and the merged stick is pushed back to compete again.
5. Sorting once is not enough: a merged stick may be shorter than originals still waiting.

### Dry Run

Input: `sticks = [2, 4, 3]`

| step | heap before | pop two | cost of this merge | running total | heap after |
|------|-------------|---------|--------------------|---------------|------------|
| 1 | `{2, 3, 4}` | `2`, `3` | `2 + 3 = 5` | **5** | `{4, 5}` |
| 2 | `{4, 5}` | `4`, `5` | `4 + 5 = 9` | **14** | `{9}` |
| 3 | `{9}` | — | — | 14 | done |

Output: **14** ✓

**Cross-check with the depth formula.** The merge tree is:

```text
              9
            /   \
           5     4        depth 1
          / \
         2   3            depth 2
```

`Σ length × depth = 2×2 + 3×2 + 4×1 = 4 + 6 + 4 = 14` ✓ — the two shortest sticks sit deepest, exactly as the greedy intends.

**A wrong order, for contrast.** Merging `4` and `3` first costs 7, then `7 + 2` costs 9 → total **16**. That tree puts the *longest* stick at depth 2, and it costs 2 more.

**A longer case**, `sticks = [1, 8, 3, 5]`:

| step | heap | pop | cost | total |
|------|------|-----|------|-------|
| 1 | `{1,3,5,8}` | `1`, `3` | 4 | 4 |
| 2 | `{4,5,8}` | `4`, `5` | 9 | 13 |
| 3 | `{8,9}` | `8`, `9` | 17 | **30** |

Output: **30** ✓ — note step 2 merged the freshly created `4`, which no single upfront sort could have anticipated.

### Visualization

```text
sticks {2, 3, 4}

  merge 2+3  →  cost 5      sticks {4, 5}
  merge 4+5  →  cost 9      sticks {9}
                ─────────
                total 14

  the merged 5 re-enters the pool and competes on its own merits —
  which is why a HEAP is required, not a one-time sort
```

### Code

```go
func connectSticks(sticks []int) int {
    if len(sticks) <= 1 {
        return 0 // nothing to connect
    }

    remaining := &stickHeap{}
    *remaining = append(*remaining, sticks...)
    heap.Init(remaining)

    total := 0
    for remaining.Len() > 1 {
        // The two shortest sticks belong deepest in the merge tree.
        first := heap.Pop(remaining).(int)
        second := heap.Pop(remaining).(int)

        merged := first + second
        total += merged // this connection costs the combined length

        // The merged stick competes again — it may now be the shortest,
        // which is why a single upfront sort would be wrong.
        heap.Push(remaining, merged)
    }

    return total
}

type stickHeap []int

func (h stickHeap) Len() int           { return len(h) }
func (h stickHeap) Less(i, j int) bool { return h[i] < h[j] } // min-heap
func (h stickHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *stickHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *stickHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

def connectSticks(sticks):
    if len(sticks) <= 1:
        return 0

    remaining = list(sticks)
    heapq.heapify(remaining)            # min-heap

    total = 0
    while len(remaining) > 1:
        first = heapq.heappop(remaining)     # two shortest go deepest
        second = heapq.heappop(remaining)

        merged = first + second
        total += merged                      # this connection costs the sum
        heapq.heappush(remaining, merged)    # it competes again

    return total
```

### Complexity
Time **O(n log n)** — `n − 1` merges, each with a constant number of heap operations. Space O(n) for the heap.

---

## 10. Solved Example 2

### Problem — Last Stone Weight (LeetCode 1046)
Repeatedly smash the two **heaviest** stones. If they weigh `x` and `y` with `x ≥ y`, the heavier survives with weight `x − y`; if they are equal both are destroyed. Return the weight of the last remaining stone, or `0`.

### Thought Process
1. Structurally identical to Example 1 — repeatedly take the two extreme items and put a result back — but the extreme is now the **largest**, so the heap flips to a max-heap.
2. The combination rule also changes: push back `|x − y|` instead of `x + y`, and push nothing when they are equal.
3. Each round removes at least one stone, so the loop runs at most `n − 1` times.
4. At the end either one stone remains or the heap is empty.
5. No cost is accumulated — this problem asks for the survivor, not a total.

### Dry Run

Input: `stones = [2, 7, 4, 1, 8, 1]`

| round | heap (largest first) | pop two | result | heap after |
|-------|----------------------|---------|--------|------------|
| 1 | `{8, 7, 4, 2, 1, 1}` | `8`, `7` | `8 − 7 = 1` → push | `{4, 2, 1, 1, 1}` |
| 2 | `{4, 2, 1, 1, 1}` | `4`, `2` | `4 − 2 = 2` → push | `{2, 1, 1, 1}` |
| 3 | `{2, 1, 1, 1}` | `2`, `1` | `2 − 1 = 1` → push | `{1, 1, 1}` |
| 4 | `{1, 1, 1}` | `1`, `1` | equal → **both destroyed** | `{1}` |
| 5 | `{1}` | — | one stone left → stop | `{1}` |

Output: **1** ✓

Round 4 is the case worth noting: equal stones annihilate, so nothing is pushed back and the heap shrinks by two rather than one.

**The all-annihilate case:** `stones = [1, 1]` → round 1 pops both, they are equal, nothing is pushed, and the heap is empty → return **0** ✓.

### Visualization

```text
{8, 7, 4, 2, 1, 1}

  8 vs 7  →  1 survives     {4, 2, 1, 1, 1}
  4 vs 2  →  2 survives     {2, 1, 1, 1}
  2 vs 1  →  1 survives     {1, 1, 1}
  1 vs 1  →  both destroyed {1}
                             ↑
                        answer = 1

same skeleton as Example 1, with the heap direction and the
combination rule flipped
```

### Code

```go
func lastStoneWeight(stones []int) int {
    remaining := &stoneHeap{}
    *remaining = append(*remaining, stones...)
    heap.Init(remaining)

    for remaining.Len() > 1 {
        heaviest := heap.Pop(remaining).(int)
        second := heap.Pop(remaining).(int)

        if heaviest != second {
            // The heavier one survives, lightened by the other.
            heap.Push(remaining, heaviest-second)
        }
        // Equal stones annihilate: nothing goes back, so the heap
        // shrinks by two instead of one.
    }

    if remaining.Len() == 0 {
        return 0 // everything annihilated
    }
    return (*remaining)[0]
}

type stoneHeap []int

func (h stoneHeap) Len() int           { return len(h) }
func (h stoneHeap) Less(i, j int) bool { return h[i] > h[j] } // max-heap
func (h stoneHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *stoneHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *stoneHeap) Pop() any {
    old := *h
    last := old[len(old)-1]
    *h = old[:len(old)-1]
    return last
}
```

```python
import heapq

def lastStoneWeight(stones):
    remaining = [-s for s in stones]    # max-heap via negation
    heapq.heapify(remaining)

    while len(remaining) > 1:
        heaviest = -heapq.heappop(remaining)
        second = -heapq.heappop(remaining)

        if heaviest != second:
            heapq.heappush(remaining, -(heaviest - second))
        # Equal stones annihilate: nothing is pushed back.

    return -remaining[0] if remaining else 0
```

### Complexity
Time **O(n log n)** — at most `n − 1` rounds, each with a constant number of heap operations. Space O(n).

---

## 11. Solved Example 3

### Problem — Largest Number After Digit Swaps by Parity (LeetCode 2231)
You may swap any two digits of a positive integer **as long as they have the same parity** (both odd or both even). Return the largest number obtainable.

### Thought Process
1. Not a heap problem — included because it is the *other* greedy shape: when items may be freely rearranged **within a class**, sort each class and lay them back down greedily.
2. Swaps are unrestricted inside each parity class, so any permutation of the odd digits among the odd positions is reachable, and likewise for the even ones.
3. The parity of each **position** is therefore fixed: an odd digit's slot can only ever hold odd digits.
4. So: collect the odd digits and the even digits, sort each descending, then walk the original number putting the largest available digit of the matching parity into each slot.
5. Greedy from the most significant digit is optimal because a larger digit earlier always beats any improvement later.

### Dry Run

Input: `num = 1234`

**Step 1 — split by parity:**

| class | digits | sorted descending |
|-------|--------|-------------------|
| odd   | `1, 3` | `[3, 1]` |
| even  | `2, 4` | `[4, 2]` |

**Step 2 — rebuild, taking the largest available digit of the matching parity:**

| position | original digit | parity | takes | result so far |
|----------|----------------|--------|-------|---------------|
| 0 | `1` | odd | `3` | `3` |
| 1 | `2` | even | `4` | `34` |
| 2 | `3` | odd | `1` | `341` |
| 3 | `4` | even | `2` | `3412` |

Output: **3412** ✓

Note the parities are preserved position by position: positions 0 and 2 held odd digits before and after; positions 1 and 3 held even ones.

**A second case**, `num = 65875`:

| class | digits | sorted descending |
|-------|--------|-------------------|
| odd   | `5, 7, 5` | `[7, 5, 5]` |
| even  | `6, 8` | `[8, 6]` |

| position | original | parity | takes |
|----------|----------|--------|-------|
| 0 | `6` | even | `8` |
| 1 | `5` | odd | `7` |
| 2 | `8` | even | `6` |
| 3 | `7` | odd | `5` |
| 4 | `5` | odd | `5` |

Output: **87655** ✓

### Visualization

```text
num = 1234

  odd  digits {1, 3}  →  sorted desc [3, 1]
  even digits {2, 4}  →  sorted desc [4, 2]

  position :   0     1     2     3
  parity   :  odd  even   odd  even     ← FIXED by the original digits
  take     :   3     4     1     2
             ─────────────────────
  result   :  3 4 1 2

  swaps are free WITHIN a parity class, so each class is
  independently sorted and laid down largest-first
```

### Code

```go
func largestInteger(num int) int {
    digits := []int{}
    for x := num; x > 0; x /= 10 {
        digits = append(digits, x%10)
    }
    for l, r := 0, len(digits)-1; l < r; l, r = l+1, r-1 {
        digits[l], digits[r] = digits[r], digits[l] // most significant first
    }

    // Swaps are unrestricted within a parity class, so each class can be
    // sorted independently.
    odds, evens := []int{}, []int{}
    for _, d := range digits {
        if d%2 == 1 {
            odds = append(odds, d)
        } else {
            evens = append(evens, d)
        }
    }
    sort.Sort(sort.Reverse(sort.IntSlice(odds)))
    sort.Sort(sort.Reverse(sort.IntSlice(evens)))

    // Each POSITION's parity is fixed, so refill greedily from the front.
    oddIndex, evenIndex := 0, 0
    result := 0
    for _, d := range digits {
        if d%2 == 1 {
            result = result*10 + odds[oddIndex]
            oddIndex++
        } else {
            result = result*10 + evens[evenIndex]
            evenIndex++
        }
    }

    return result
}
```

```python
def largestInteger(num):
    digits = [int(c) for c in str(num)]

    # Swaps are free within a parity class → sort each independently.
    odds = sorted((d for d in digits if d % 2 == 1), reverse=True)
    evens = sorted((d for d in digits if d % 2 == 0), reverse=True)

    # Each POSITION's parity is fixed, so refill greedily from the front.
    odd_index = even_index = 0
    result = 0
    for d in digits:
        if d % 2 == 1:
            result = result * 10 + odds[odd_index]
            odd_index += 1
        else:
            result = result * 10 + evens[even_index]
            even_index += 1

    return result
```

### Complexity
Time **O(k log k)** for `k` digits — dominated by sorting the two classes. Space O(k).

> Two greedy shapes sit side by side in this chapter. Examples 1 and 2 repeatedly extract an extreme and feed the result back, which needs a heap. Example 3 partitions into independent classes and sorts each once. Recognising which shape you have — *does my choice change the pool, or not?* — is what decides whether you need a heap at all.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1167 | Min Cost Sticks | Easy | Core greedy application |
| 1046 | Last Stone | Easy | Core greedy application |
| 2231 | Largest Number | Medium | Core greedy application |
| 630 | Course III | Medium | Core greedy application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Activity selection / scheduling**
- **Jump game reachability**
- **Gas station circuit**
- **Huffman / merge-cost**

---

## 14. Production Engineering Applications

- **Scalability:** Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Huffman Greedy logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Huffman Greedy (Greedy).
- **Signal:** huffman, greedy, heap, encoding, merge cost, optimal.
- **Move:** When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).
- **Cost:** O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Huffman Greedy invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Huffman Greedy
FAMILY : Greedy (Advanced)
WHEN   : huffman, greedy, heap, encoding, merge cost, optimal
DO     : When a greedy choice provably never hurts, a single sorted pass yields the optim
TIME   : O(n log n)    SPACE: O(1)
PRACTICE: 1167, 1046, 2231, 630
```

---

*Part of the DSA Patterns Handbook — pattern 88 of 100.*
