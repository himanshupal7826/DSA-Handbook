# 100 · Mo's Algorithm

> **One-liner:** Reorder offline range queries by sqrt blocks for O((n+q)√n).

---

## 1. Overview

### Definition
The **Mo's Algorithm** pattern belongs to the *Advanced* family. Reorder offline range queries by sqrt blocks for O((n+q)√n).

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
mo's algorithm, offline queries, sqrt decomposition, range queries, add remove.

### Constraints
- Input size where the brute-force complexity would time out — the Mo's Algorithm optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Mo's Algorithm invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Mo's Algorithm is the upgrade.
- The wording maps onto: mo's algorithm, offline queries, sqrt decomposition, range queries, add remove.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"I have a pile of range questions whose answers cannot be built from prefixes — how do I answer all of them without rescanning each range?"*

Running example: `nums = [1, 2, 1, 3, 2, 2, 4, 1]`, and four queries asking **how many distinct values** each range contains.

```text
idx    0  1  2  3  4  5  6  7
nums   1  2  1  3  2  2  4  1

Q0 = [4,7]     Q1 = [0,3]     Q2 = [1,6]     Q3 = [3,5]
```

### Intuition
Answer each query on its own. Walk the range, drop the values into a set, report the set's size. Then throw the set away and start the next query from scratch.

### Algorithm
1. For each query `[left, right]`, create an empty set.
2. Loop `i` from `left` to `right`, inserting `nums[i]`.
3. Record the set's size as that query's answer.
4. Discard the set and repeat for the next query.

### Complexity
- Time: **O(q · n)** — every query walks its whole range, and a range can be the entire array.
- Space: O(n) for the set.

### Drawbacks

- **The same elements are re-scanned over and over.** `Q2 = [1,6]` and `Q0 = [4,7]` overlap on indices `4, 5, 6`; `Q3 = [3,5]` overlaps both. Those three positions get inserted into three separate sets, and nothing learned in one query is carried into the next:

```text
Q1 [0,3]   ████░░░░
Q3 [3,5]   ░░░███░░
Q2 [1,6]   ░██████░
Q0 [4,7]   ░░░░████
              ↑↑↑
        indices 4,5,6 are visited by three different queries
```

- **The obvious fix — prefix sums — does not work here.** Distinct-count is not additive, so you cannot subtract one prefix from another:

```text
distinct(nums[0..6]) = |{1,2,3,4}| = 4
distinct(nums[0..0]) = |{1}|       = 1
        4 - 1 = 3        ← what a prefix decomposition would claim
distinct(nums[1..6]) = |{2,1,3,2,2,4}| = 4    ← the truth
```

The `1` at index 0 also appears at index 2, so removing the prefix removes a *count*, not a *value*. Fenwick trees and prefix arrays need an invertible, decomposable operation; "how many different values" is neither.

- **The brute force also ignores a gift the problem is handing us:** all four queries are printed on the page before we compute anything. We are free to answer them in any order we like, and we are throwing that freedom away.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Because every query is known in advance and the answers do not depend on the order we produce them, we may reorder the queries so that a single sliding window can crawl from one range to the next, adding and removing one element at a time.**

Think of a librarian with a stack of requests, each asking about a different shelf span. Rather than walking back to the entrance for every request, she sorts the requests so consecutive ones are physically near each other, then strolls once through the stacks, stepping a shelf at a time and shouting out an answer whenever her current span happens to match a request.

### The thought process

```text
We need    : q answers, each over a contiguous range, on a STATIC array.
Obvious way: rescan every range.  O(q * n).
Too slow   : ranges overlap heavily and nothing is reused.
Blocked    : prefix sums / Fenwick need an invertible op — "distinct count"
             and "sum of count(x)^2" are not.
Notice     : (a) all the queries are given up front, and
             (b) an answer does not care WHEN it was computed.
Therefore  : we may answer them in ANY order — so pick the order that makes
             a two-pointer window travel the least total distance.
Now        : sort by (left / blockSize, then right). Total pointer travel
             collapses to O((n + q) * sqrt(n)).
```

### What makes a problem "offline-able"

Two conditions, and both are hard requirements:

| Requirement | What it means | What breaks without it |
|---|---|---|
| **All queries known up front** | You can read the whole query list before answering anything | If query *k* depends on answer *k−1*, or arrives over a network, you cannot reorder |
| **Order-independent answers** | The array does not change between queries | If an update sits between two queries, "the array" is a different array for each — one window cannot represent both |

If a problem gives you `queries[][]` as a parameter, condition 1 holds. If the array is never mutated, condition 2 holds. That is the whole test.

### Why the add/remove operations must be O(1) and reversible

Mo's does not compute answers — it *maintains* them. You supply two functions over a window `[curLeft, curRight]`:

```text
add(i)     : element nums[i] just entered the window  → repair the answer
remove(i)  : element nums[i] just left the window     → repair the answer
```

For "count distinct", the maintained state is a frequency table plus a running `distinct` counter:

```text
add(i)     : if count[v] == 0 { distinct++ };  count[v]++
remove(i)  : count[v]--;  if count[v] == 0 { distinct-- }
```

Two properties matter:

- **Reversible.** The window *shrinks* as well as grows — `left` moves right, `right` moves left. An "add-only" state (a running maximum, say) cannot be undone, so Mo's cannot maintain it. Everything that works with Mo's is essentially a multiset counter you can decrement.
- **O(1).** The algorithm's whole cost is *number of pointer moves × cost per move*. We are about to prove the moves total `O((n + q)√n)`. If each `add` cost `O(log n)`, that becomes `O((n + q)√n · log n)` — usually the difference between passing and timing out. Keep the counter in a flat array (coordinate-compress the values first), never a hash map in the inner loop.

### The sorting rule, and why it is the whole algorithm

```text
blockSize = n / sqrt(q)

sort queries by:
    1st key:  left / blockSize        (which block the LEFT end falls in)
    2nd key:  right                   (ascending — or alternating, see below)
```

That is it. Everything else is a two-pointer loop.

### Why O((n + q) · √n) — the cost derivation

Count how far each pointer travels in total.

**The `left` pointer — bounded by the *first* sort key.**
Inside one block, every query's `left` lies in the same window of `blockSize` consecutive positions. So moving from one query to the next inside a block costs at most `blockSize` steps.

```text
left travel  ≤  q * blockSize        (within blocks)
             +  n                    (one forward sweep across all block boundaries)
             =  O(q * blockSize + n)
```

**The `right` pointer — bounded by the *second* sort key.**
Inside one block, `right` is sorted ascending, so it only ever moves **forward**: at most `n` steps for the entire block, no matter how many queries the block holds. At a block boundary it may rewind all the way, another `n`.

```text
number of blocks =  n / blockSize
right travel     ≤  n per block  *  (n / blockSize)  =  O(n^2 / blockSize)
```

**Balance the two.**

```text
total  =  O(q * blockSize  +  n^2 / blockSize)

  blockSize small  → right pointer suffers (many blocks, many rewinds)
  blockSize large  → left pointer suffers  (long strides inside a block)

set them equal:   q * B = n^2 / B   →   B^2 = n^2 / q   →   B = n / sqrt(q)

total  =  O(n * sqrt(q))       →  with q ≈ n this is O(n * sqrt(n))
```

The familiar form `O((n + q)·√n)` is what you get by taking the simpler `blockSize = √n`; both are correct, and `n/√q` is strictly better when `q` is much smaller or much larger than `n`.

**The alternating-direction trick.** With `right` always ascending, every block boundary forces a full rewind of the right pointer. Sort `right` **ascending in even blocks and descending in odd blocks**, and the right pointer ends one block exactly where the next one starts. Same asymptotics, roughly half the constant — and correctness is untouched, because the answers were order-independent to begin with.

### When NOT to use Mo's

| Situation | Why Mo's fails | Use instead |
|---|---|---|
| Queries arrive one at a time (a class with a `query()` method) | Nothing to sort | Segment tree / Fenwick / per-value binary search |
| Updates interleaved with queries | The window can't represent two different arrays | Segment tree, Fenwick, or **Mo's with updates** (3D sort, `O(n^{5/3})`) |
| The answer *is* prefix-decomposable (sum, xor, count ≤ v) | Mo's is a `√n` factor slower for nothing | Prefix sums / Fenwick, `O(1)` or `O(log n)` |
| `add`/`remove` cannot be `O(1)` or cannot be undone | The cost model collapses | Rethink the state, or use a different structure |

Example 2 below is a live case of row 1 *and* row 3 at once — a problem that looks like Mo's and should not be solved with Mo's.

### Steps

```text
Step 1 → Read ALL queries. If you cannot, stop: Mo's does not apply.
Step 2 → Coordinate-compress the values so counts fit in a flat int array.
Step 3 → blockSize = round(n / sqrt(q)), clamped to at least 1.
Step 4 → Sort queries by (left/blockSize) then by right
         (ascending in even blocks, descending in odd blocks).
Step 5 → Keep curLeft = 0, curRight = -1 (an empty window) and the state
         that add/remove maintain.
Step 6 → For each sorted query: GROW first, then SHRINK —
             while curLeft  > left  { curLeft--;  add(curLeft)  }
             while curRight < right { curRight++; add(curRight) }
             while curLeft  < left  { remove(curLeft);  curLeft++  }
             while curRight > right { remove(curRight); curRight-- }
         Growing before shrinking keeps the window from ever inverting.
Step 7 → Store the current state into answers[query.originalIndex].
```

### How should I recognize this?

```text
If you see...
  a STATIC array plus a LIST of ranges given all at once
  "answer the following q queries", n and q both around 1e5
  an aggregate that is NOT a sum: distinct count, mode, #pairs of equals,
    "sum of count(x)^2", k-th smallest in range
  no updates anywhere in the statement
        ↓
Think about...
  "Can I read every query before answering any of them?"      → offline?
  "If one element enters or leaves the range, can I fix the
   answer in O(1) — and can I undo that fix?"                  → add/remove?
        ↓
Use...
  Mo's algorithm: sort by (left/blockSize, right), slide two pointers.
      blockSize = n / sqrt(q)
  BUT: queries arrive online          → segment tree / Fenwick / per-value binsearch
       updates interleaved with reads → Mo's with updates, or a segment tree
       the answer is a plain sum      → prefix sums; Mo's would just be slower
```

### Visual explanation

```svg
<svg viewBox="0 0 640 290" width="100%" height="290" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="mo-100" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Mo's: sort queries by (block of L, then R); pointers slide in O((n+q)√n)</text>
  <!-- array with blocks of size 3 -->
  <text x="30" y="55" fill="#64748b" font-weight="700">array (block size √9 = 3)</text>
  <g>
    <rect x="40" y="65" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="70" y="90" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="100" y="65" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="130" y="90" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="160" y="65" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="190" y="90" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="220" y="65" width="60" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="250" y="90" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="280" y="65" width="60" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="310" y="90" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="340" y="65" width="60" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="370" y="90" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="400" y="65" width="60" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="430" y="90" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="460" y="65" width="60" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="90" text-anchor="middle" fill="#1e293b">7</text>
    <rect x="520" y="65" width="60" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="550" y="90" text-anchor="middle" fill="#1e293b">8</text>
  </g>
  <text x="130" y="124" text-anchor="middle" fill="#2563eb">block 0</text>
  <text x="310" y="124" text-anchor="middle" fill="#059669">block 1</text>
  <text x="490" y="124" text-anchor="middle" fill="#d97706">block 2</text>
  <!-- unsorted queries -->
  <text x="30" y="160" fill="#64748b" font-weight="700">queries [L,R]</text>
  <text x="180" y="160" fill="#1e293b">Q1[5,7]  Q2[0,4]  Q3[1,8]  Q4[3,6]</text>
  <line x1="300" y1="175" x2="300" y2="205" stroke="#475569" stroke-width="1.5" marker-end="url(#mo-100)"/>
  <text x="410" y="196" text-anchor="middle" fill="#64748b">sort by (L / block, then R)</text>
  <!-- sorted order -->
  <text x="30" y="235" fill="#64748b" font-weight="700">sorted order</text>
  <rect x="160" y="220" width="90" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="205" y="238" text-anchor="middle" fill="#1e293b">Q2[0,4]</text>
  <rect x="256" y="220" width="90" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="301" y="238" text-anchor="middle" fill="#1e293b">Q3[1,8]</text>
  <rect x="352" y="220" width="90" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="397" y="238" text-anchor="middle" fill="#1e293b">Q4[3,6]</text>
  <rect x="448" y="220" width="90" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="493" y="238" text-anchor="middle" fill="#1e293b">Q1[5,7]</text>
  <text x="320" y="272" text-anchor="middle" fill="#64748b">grouped by L-block; within a block R only moves forward, so pointers travel little</text>
</svg>
```

```text
nums:  idx  0  1  2  3  4  5  6  7
            1  2  1  3  2  2  4  1

n = 8, q = 4  →  blockSize = round(8 / sqrt(4)) = 4
                 block(left) = left / 4     block 0: left 0..3   block 1: left 4..7

  given order            sorted order                window it lands on
  ───────────            ─────────────────────       ───────────────────
  Q0 [4,7]               Q1 [0,3]   block 0, r=3     [====....]
  Q1 [0,3]      ──▶      Q3 [3,5]   block 0, r=5     [...===..]
  Q2 [1,6]               Q2 [1,6]   block 0, r=6     [.======.]
  Q3 [3,5]               Q0 [4,7]   block 1, r=7     [....====]

  left  : 0 → 3 → 1 → 4      stays inside one block, so short hops
  right : 3 → 5 → 6 → 7      inside block 0 it only ever goes FORWARD

  total pointer moves = 15, versus 8+4+6+4 = 22 elements rescanned by brute force
  — and the gap widens as n^2/blockSize + q*blockSize beats q*n.
```

### Interview explanation
"The array is static and I'm handed every query up front, so this is an *offline* problem — I can answer the queries in whatever order I like. That lets me use Mo's algorithm: I keep one window `[curLeft, curRight]` plus a frequency table, and I define `add(i)` and `remove(i)` to repair the answer in O(1) when a single element enters or leaves. Both must be O(1) and reversible, because the window shrinks as well as grows. Then I sort the queries by `left / blockSize` and, within a block, by `right` — so the right pointer only moves forward inside a block. The left pointer travels at most `blockSize` per query and the right pointer at most `n` per block, giving `q·blockSize + n²/blockSize`; setting `blockSize = n/√q` balances them at `O(n√q)`, the usual `O((n+q)√n)`. I'd note it doesn't apply if the queries were online or if there were updates between them — then I'd reach for a segment tree instead."

---

## 5. Generic Templates

> Sort by `(left/blockSize, right)`, then grow the window before you shrink it.

```go
// MoQuery is one offline range request. Index remembers where the answer goes,
// because Mo's answers queries out of order.
type MoQuery struct {
    Left, Right, Index int
}

// MoSolve answers every query offline in O((n + q) * sqrt(n)) pointer moves.
//
// add(i) and remove(i) must be O(1) and exact inverses of each other: the
// window shrinks as often as it grows. current() reads the answer for the
// window they are jointly maintaining.
func MoSolve(n int, queries []MoQuery, add func(i int), remove func(i int), current func() int) []int {
    q := len(queries)
    answers := make([]int, q)
    if n == 0 || q == 0 {
        return answers
    }

    // blockSize = n / sqrt(q) balances the two pointers:
    //   left  travels O(blockSize) per query   -> q * blockSize
    //   right travels O(n) per block           -> n^2 / blockSize
    blockSize := int(math.Round(float64(n) / math.Sqrt(float64(q))))
    if blockSize < 1 {
        blockSize = 1
    }

    order := append([]MoQuery(nil), queries...)
    sort.Slice(order, func(a, b int) bool {
        blockA, blockB := order[a].Left/blockSize, order[b].Left/blockSize
        if blockA != blockB {
            return blockA < blockB
        }
        // Alternating the right-pointer direction per block removes the long
        // rewind at every boundary. Plain ascending is also correct.
        if blockA%2 == 0 {
            return order[a].Right < order[b].Right
        }
        return order[a].Right > order[b].Right
    })

    curLeft, curRight := 0, -1 // an empty window
    for _, query := range order {
        // GROW first, then SHRINK, so the window never inverts.
        for curLeft > query.Left {
            curLeft--
            add(curLeft)
        }
        for curRight < query.Right {
            curRight++
            add(curRight)
        }
        for curLeft < query.Left {
            remove(curLeft)
            curLeft++
        }
        for curRight > query.Right {
            remove(curRight)
            curRight--
        }
        answers[query.Index] = current()
    }
    return answers
}

// CompressToRanks maps arbitrary values onto 0..k-1 so the frequency table can
// be a flat array — a map lookup in the inner loop would cost the whole win.
func CompressToRanks(values []int) []int {
    rank := make(map[int]int, len(values))
    coded := make([]int, len(values))
    for i, v := range values {
        r, seen := rank[v]
        if !seen {
            r = len(rank)
            rank[v] = r
        }
        coded[i] = r
    }
    return coded
}
```

```python
def mo_solve(n, queries, add, remove, current):
    """Answer offline range queries in O((n + q) * sqrt(n)) pointer moves.

    queries: list of (left, right, index) — index says where the answer goes.
    add(i) / remove(i): O(1) and exact inverses; the window shrinks too.
    current(): reads the answer for the window they maintain.
    """
    q = len(queries)
    answers = [0] * q
    if n == 0 or q == 0:
        return answers

    # left travels O(block) per query; right travels O(n) per block.
    block = max(1, round(n / (q ** 0.5)))

    def sort_key(item):
        left, right, _ = item
        b = left // block
        # Alternate direction per block so the right pointer never rewinds
        # at a block boundary. Plain `right` is also correct.
        return (b, right if b % 2 == 0 else -right)

    cur_left, cur_right = 0, -1          # an empty window
    for left, right, index in sorted(queries, key=sort_key):
        while cur_left > left:           # GROW first...
            cur_left -= 1
            add(cur_left)
        while cur_right < right:
            cur_right += 1
            add(cur_right)
        while cur_left < left:           # ...then SHRINK, so it never inverts
            remove(cur_left)
            cur_left += 1
        while cur_right > right:
            remove(cur_right)
            cur_right -= 1
        answers[index] = current()
    return answers


def compress_to_ranks(values):
    """Dense 0-based codes, so the frequency table is a flat list not a dict."""
    rank = {}
    for v in values:
        if v not in rank:
            rank[v] = len(rank)
    return [rank[v] for v in values]
```

```java
import java.util.*;
import java.util.function.IntConsumer;
import java.util.function.IntSupplier;

public class Mo {
    // One offline request; index remembers where its answer belongs.
    public static class Query {
        public final int left, right, index;
        public Query(int left, int right, int index) {
            this.left = left; this.right = right; this.index = index;
        }
    }

    // add / remove must be O(1) and exact inverses: the window shrinks too.
    public static int[] solve(int n, Query[] queries, IntConsumer add,
                              IntConsumer remove, IntSupplier current) {
        int q = queries.length;
        int[] answers = new int[q];
        if (n == 0 || q == 0) return answers;

        // left travels O(block) per query; right travels O(n) per block.
        final int block = Math.max(1, (int) Math.round(n / Math.sqrt(q)));

        Query[] order = queries.clone();
        Arrays.sort(order, (a, b) -> {
            int blockA = a.left / block, blockB = b.left / block;
            if (blockA != blockB) return Integer.compare(blockA, blockB);
            // Alternate direction per block to kill the boundary rewind.
            return blockA % 2 == 0 ? Integer.compare(a.right, b.right)
                                   : Integer.compare(b.right, a.right);
        });

        int curLeft = 0, curRight = -1;               // empty window
        for (Query query : order) {
            while (curLeft > query.left) add.accept(--curLeft);      // grow
            while (curRight < query.right) add.accept(++curRight);
            while (curLeft < query.left) remove.accept(curLeft++);   // shrink
            while (curRight > query.right) remove.accept(curRight--);
            answers[query.index] = current.getAsInt();
        }
        return answers;
    }
}
```

```cpp
#include <algorithm>
#include <cmath>
#include <functional>
#include <vector>
using namespace std;

// One offline request; index remembers where its answer belongs.
struct MoQuery { int left, right, index; };

// add / remove must be O(1) and exact inverses: the window shrinks too.
vector<int> moSolve(int n, vector<MoQuery> queries,
                    const function<void(int)>& add,
                    const function<void(int)>& remove,
                    const function<int()>& current) {
    int q = (int)queries.size();
    vector<int> answers(q, 0);
    if (n == 0 || q == 0) return answers;

    // left travels O(block) per query; right travels O(n) per block.
    int block = max(1, (int)llround(n / sqrt((double)q)));

    sort(queries.begin(), queries.end(), [block](const MoQuery& a, const MoQuery& b) {
        int blockA = a.left / block, blockB = b.left / block;
        if (blockA != blockB) return blockA < blockB;
        // Alternate direction per block to kill the boundary rewind.
        return blockA % 2 == 0 ? a.right < b.right : a.right > b.right;
    });

    int curLeft = 0, curRight = -1;                   // empty window
    for (const MoQuery& query : queries) {
        while (curLeft > query.left) add(--curLeft);          // grow first
        while (curRight < query.right) add(++curRight);
        while (curLeft < query.left) remove(curLeft++);       // then shrink
        while (curRight > query.right) remove(curRight--);
        answers[query.index] = current();
    }
    return answers;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Mo's Algorithm (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **Varies (often O(log n) per op)** |
| Time (best)  | — | **Varies (often O(log n) per op)** |
| Time (average) | — | **Varies (often O(log n) per op)** |
| Space | varies | **O(n) to O(n log n)** |

> Build cost amortized over many fast queries/updates.

---

## 7. Common Mistakes

1. Mixing 0-indexed and 1-indexed conventions (Fenwick is 1-indexed).
2. Segment tree: wrong recursion bounds or lazy-propagation push-down.
3. Trie: not marking end-of-word, or leaking memory on delete.
4. Sparse table on a non-idempotent operation (sums need a different trick).
5. Bitmask DP exceeding memory for n > ~22.
6. Meet-in-the-middle: incorrect merge of the two halves.
7. Euler tour: off-by-one in in/out times.
8. Network flow: forgetting residual/back edges.
9. SCC/Tarjan: mishandling the low-link update and stack.
10. Mo's algorithm: wrong block size or add/remove ordering.

---

## 8. Interview Follow-Up Questions

1. **Q: Fenwick vs segment tree?**
   A: Fenwick is smaller/faster for prefix sums; segment tree is more general (min/max, lazy ranges).

2. **Q: Range update + range query?**
   A: Segment tree with lazy propagation, or two Fenwicks.

3. **Q: Trie use cases?**
   A: Prefix search, autocomplete, word dictionaries, XOR-maximization.

4. **Q: Sparse table limits?**
   A: O(1) queries but only static, idempotent operations (min/max/gcd).

5. **Q: Bitmask DP feasibility?**
   A: n ≲ 20–22 because of 2^n states.

6. **Q: Meet-in-the-middle when?**
   A: n ≲ 40 subset problems: split into 2^(n/2).

7. **Q: Euler tour purpose?**
   A: Flatten a tree so subtrees are contiguous ranges.

8. **Q: Heavy-light decomposition?**
   A: Path queries on trees via O(log n) chains + segment tree.

9. **Q: Max flow = min cut?**
   A: By the max-flow min-cut theorem; models matching/assignment.

10. **Q: SCC algorithms?**
   A: Tarjan (one DFS) or Kosaraju (two passes).

11. **Q: Bridges / articulation points?**
   A: Tarjan's low-link values in one DFS.

12. **Q: Mo's algorithm complexity?**
   A: O((n+q)√n) for offline range queries.

13. **Q: When is the build cost worth it?**
   A: When many queries/updates amortize the O(n log n) build.

14. **Q: Persistence?**
   A: Persistent segment trees answer historical-version queries.

15. **Q: Coordinate compression?**
   A: Map large/sparse keys to a dense index range first.

---

## 9. Solved Example 1

> The original chapter listed three placeholder titles ("in range", "Range Frequency", "range queries"). They are replaced here with three concrete, named problems chosen to show Mo's **working**, Mo's being the **wrong tool**, and Mo's being **irreplaceable** — in that order.

### Problem — Count Distinct Elements in Each Query Range (the canonical Mo's problem; SPOJ **DQUERY**)
You are given a static array `nums` and a list of ranges. For every range `[left, right]`, report how many *different* values it contains. All ranges are handed to you at once.

### Thought Process
1. Distinct-count is not prefix-decomposable — `distinct(0..r) − distinct(0..l−1)` is simply wrong — so Fenwick/prefix sums are out.
2. But the array never changes and every range is known up front: the problem is **offline**, so the answers may be produced in any order.
3. If one element enters or leaves a window, the distinct count changes by at most one, and I can repair it in O(1) with a frequency table. It is also reversible, so a window may shrink.
4. Therefore sort the queries by `(left / blockSize, right)` and drag one window across all of them.
5. `blockSize = round(n / √q)`; alternate the right-direction per block for the constant-factor win.

### Dry Run

Input: `nums = [1, 2, 1, 3, 2, 2, 4, 1]`, `queries = [[4,7], [0,3], [1,6], [3,5]]`

`n = 8`, `q = 4` → `blockSize = round(8 / √4) = 4`. Block of a query = `left / 4`.

| query | left | block | right | sort position |
|---|---|---|---|---|
| Q0 `[4,7]` | 4 | **1** | 7 | 4th |
| Q1 `[0,3]` | 0 | **0** | 3 | 1st (block 0, smallest right) |
| Q2 `[1,6]` | 1 | **0** | 6 | 3rd |
| Q3 `[3,5]` | 3 | **0** | 5 | 2nd |

Processing order: **Q1 → Q3 → Q2 → Q0**. Window starts empty at `curLeft = 0, curRight = −1`.

| step | query | pointer moves (grow then shrink) | window | counts inside window | `distinct` |
|---|---|---|---|---|---|
| 1 | Q1 `[0,3]` | right: −1→3, `add(0..3)` | `[0,3]` = `1 2 1 3` | 1×2, 2×1, 3×1 | **3** |
| 2 | Q3 `[3,5]` | right: 3→5, `add(4)`, `add(5)`; left: 0→3, `remove(0..2)` | `[3,5]` = `3 2 2` | 3×1, 2×2 | **2** |
| 3 | Q2 `[1,6]` | left: 3→1, `add(2)`, `add(1)`; right: 5→6, `add(6)` | `[1,6]` = `2 1 3 2 2 4` | 2×3, 1×1, 3×1, 4×1 | **4** |
| 4 | Q0 `[4,7]` | right: 6→7, `add(7)`; left: 1→4, `remove(1..3)` | `[4,7]` = `2 2 4 1` | 2×2, 4×1, 1×1 | **3** |

Written back to their original slots: **`[3, 3, 4, 2]`**

Step 2 is the one that shows the rule earning its keep. `remove(2)` drops `nums[2] = 1`, whose count goes `1 → 0`, so `distinct` finally drops from 3 to 2 — but `remove(0)` had already dropped the *other* `1` at index 0 without changing `distinct`, because its count only went `2 → 1`. Only the transition *through zero* moves the answer. That is why the counter must be exact, not a set.

### Visualization

```text
idx    0  1  2  3  4  5  6  7
nums   1  2  1  3  2  2  4  1

Q1 [0,3]   [========]                 distinct = 3   (1,2,3)
              add 0,1,2,3

Q3 [3,5]         [=======]            distinct = 2   (3,2)
              add 4,5      remove 0,1,2
              count[1]: 2 → 1 → 0  ← only the 1→0 step decrements distinct

Q2 [1,6]      [==================]    distinct = 4   (1,2,3,4)
              add 2,1      add 6

Q0 [4,7]                 [=========]  distinct = 3   (1,2,4)
              add 7        remove 1,2,3
              count[3]: 1 → 0      ← the value 3 leaves, distinct 4 → 3

left  : 0 → 3 → 1 → 4     (short hops: every left is inside block 0 or block 1)
right : 3 → 5 → 6 → 7     (monotone forward inside block 0)
```

### Code

```go
// distinctQuery is one offline request; index remembers where the answer goes,
// because Mo's produces answers out of order.
type distinctQuery struct {
    left, right, index int
}

// countDistinctInRanges answers every range's distinct-count offline.
// Two facts make this legal: all queries are known up front, and an answer
// does not depend on when it was computed.
func countDistinctInRanges(nums []int, queries [][]int) []int {
    n, q := len(nums), len(queries)
    answers := make([]int, q)
    if n == 0 || q == 0 {
        return answers
    }

    // Compress values to 0..k-1 so the frequency table is a flat array.
    // A map lookup inside add/remove would cost the whole win.
    rank := make(map[int]int, n)
    coded := make([]int, n)
    for i, v := range nums {
        r, seen := rank[v]
        if !seen {
            r = len(rank)
            rank[v] = r
        }
        coded[i] = r
    }

    // blockSize = n / sqrt(q) balances left travel (q*blockSize) against
    // right travel (n^2 / blockSize).
    blockSize := int(math.Round(float64(n) / math.Sqrt(float64(q))))
    if blockSize < 1 {
        blockSize = 1
    }

    order := make([]distinctQuery, q)
    for i, qy := range queries {
        order[i] = distinctQuery{left: qy[0], right: qy[1], index: i}
    }
    sort.Slice(order, func(a, b int) bool {
        blockA, blockB := order[a].left/blockSize, order[b].left/blockSize
        if blockA != blockB {
            return blockA < blockB
        }
        // Alternating direction per block removes the rewind at each boundary.
        if blockA%2 == 0 {
            return order[a].right < order[b].right
        }
        return order[a].right > order[b].right
    })

    count := make([]int, len(rank))
    distinct := 0

    // add and remove are O(1) and exact inverses of one another.
    add := func(i int) {
        if count[coded[i]] == 0 {
            distinct++
        }
        count[coded[i]]++
    }
    remove := func(i int) {
        count[coded[i]]--
        if count[coded[i]] == 0 {
            distinct--
        }
    }

    curLeft, curRight := 0, -1 // empty window
    for _, qy := range order {
        // GROW first, then SHRINK: the window never inverts.
        for curLeft > qy.left {
            curLeft--
            add(curLeft)
        }
        for curRight < qy.right {
            curRight++
            add(curRight)
        }
        for curLeft < qy.left {
            remove(curLeft)
            curLeft++
        }
        for curRight > qy.right {
            remove(curRight)
            curRight--
        }
        answers[qy.index] = distinct
    }
    return answers
}
```

```python
def count_distinct_in_ranges(nums, queries):
    """Distinct count per range, offline, via Mo's algorithm."""
    n, q = len(nums), len(queries)
    answers = [0] * q
    if n == 0 or q == 0:
        return answers

    # Flat frequency array beats a dict inside add/remove.
    rank = {}
    for v in nums:
        if v not in rank:
            rank[v] = len(rank)
    coded = [rank[v] for v in nums]

    # Balances left travel (q*block) against right travel (n^2/block).
    block = max(1, round(n / (q ** 0.5)))

    def sort_key(item):
        left, right, _ = item
        b = left // block
        return (b, right if b % 2 == 0 else -right)

    count = [0] * len(rank)
    state = {"distinct": 0}

    def add(i):
        if count[coded[i]] == 0:
            state["distinct"] += 1
        count[coded[i]] += 1

    def remove(i):
        count[coded[i]] -= 1
        if count[coded[i]] == 0:
            state["distinct"] -= 1

    ordered = sorted(((l, r, i) for i, (l, r) in enumerate(queries)), key=sort_key)

    cur_left, cur_right = 0, -1                 # empty window
    for left, right, index in ordered:
        while cur_left > left:                  # grow...
            cur_left -= 1
            add(cur_left)
        while cur_right < right:
            cur_right += 1
            add(cur_right)
        while cur_left < left:                  # ...then shrink
            remove(cur_left)
            cur_left += 1
        while cur_right > right:
            remove(cur_right)
            cur_right -= 1
        answers[index] = state["distinct"]
    return answers
```

### Complexity
Time **O(n·√q + q·log q)** — the sort, plus `O(q·blockSize + n²/blockSize) = O(n√q)` pointer moves, each O(1). With `q ≈ n` that is the familiar **O((n+q)√n)**. Space O(n) for the codes and the frequency table.

---

## 10. Solved Example 2

### Problem — Range Frequency Queries (LeetCode 2080)
Build a structure over a static `arr` supporting `query(left, right, value)`: how many times does `value` occur in `arr[left..right]`?

**This is the example where Mo's is the wrong answer, and knowing that is the point.**

### Thought Process
1. It smells like Mo's: static array, range queries, and `add`/`remove` would be trivial (`count[v]++`, `count[v]--`).
2. But LeetCode hands you a **class with a `query` method**. The queries arrive one at a time — you cannot see them all, so you cannot sort them. Mo's precondition fails outright.
3. Even offline, Mo's would cost `O((n+q)√n)`. With `n, q ≈ 10⁵` that is ~3·10⁷ pointer moves for a question that has an `O(log n)` answer.
4. The better structure: for each value, store the **sorted list of positions where it occurs**. Building it is one pass, since indices are appended in increasing order.
5. Then `query(left, right, value)` = how many of that value's positions land in `[left, right]` = two binary searches: `upperBound(right) − lowerBound(left)`.

### Dry Run

Input: `arr = [1, 2, 1, 3, 1]`

**Build** — one pass, appending indices in increasing order (so each list is already sorted):

| value | positions |
|---|---|
| `1` | `[0, 2, 4]` |
| `2` | `[1]` |
| `3` | `[3]` |

**Queries** — `lo` = first position `≥ left`, `hi` = first position `> right`, answer = `hi − lo`:

| query | positions list | `lo` = search(left) | `hi` = search(right+1) | `hi − lo` | check |
|---|---|---|---|---|---|
| `query(0, 4, 1)` | `[0,2,4]` | search(0) = 0 | search(5) = 3 | **3** | all three `1`s |
| `query(1, 3, 1)` | `[0,2,4]` | search(1) = 1 | search(4) = 2 | **1** | only index 2 |
| `query(0, 2, 3)` | `[3]` | search(0) = 0 | search(3) = 0 | **0** | the `3` sits at index 3, outside |
| `query(3, 3, 3)` | `[3]` | search(3) = 0 | search(4) = 1 | **1** | exactly the single `3` |
| `query(0, 4, 9)` | `[]` (absent) | — | — | **0** | value never occurs |

The `right + 1` in the second search is what makes the range **inclusive**; searching `right` would drop an occurrence sitting exactly at `right`, as row 4 shows.

### Visualization

```text
arr:  idx  0  1  2  3  4
           1  2  1  3  1

positions[1] = [ 0 , 2 , 4 ]
                 ^       ^
query(1, 3, 1):
    lo = first position >= 1        → index 1 in the list (value 2)
    hi = first position >= 3+1 = 4  → index 2 in the list (value 4)
    answer = hi - lo = 2 - 1 = 1                     ★

positions[1] = [ 0 | 2 | 4 ]
                 ↑   ↑↑↑ ↑
                 lo   in  hi        "in" is the half-open slice [lo, hi)

──────────────────────────────────────────────────────────────────
what Mo's would have to do instead (if the queries were offline):

    sort q queries, then slide a window across up to n positions per block
    O((n + q) * sqrt(n))   vs   O(log n) per query here
    ...and it cannot even start, because query() is called one at a time.
```

### Code

```go
// RangeFreqQuery answers "how often does value occur in arr[left..right]?"
// ONLINE — each query arrives through a method call, so Mo's algorithm cannot
// be used at all: there is no query list to sort.
type RangeFreqQuery struct {
    positions map[int][]int // value -> its indices, ascending
}

// Constructor indexes the array by value in one pass. Indices are appended in
// increasing order, so each list comes out sorted for free.
func Constructor(arr []int) RangeFreqQuery {
    positions := make(map[int][]int, len(arr))
    for i, v := range arr {
        positions[v] = append(positions[v], i)
    }
    return RangeFreqQuery{positions: positions}
}

// Query counts this value's positions falling inside [left, right].
// right+1 keeps the range INCLUSIVE at the upper end.
func (r *RangeFreqQuery) Query(left int, right int, value int) int {
    positions := r.positions[value]
    if len(positions) == 0 {
        return 0
    }
    lo := sort.SearchInts(positions, left)    // first position >= left
    hi := sort.SearchInts(positions, right+1) // first position >  right
    return hi - lo
}
```

```python
import bisect
from collections import defaultdict


class RangeFreqQuery:
    """Online range-frequency. Mo's algorithm is inapplicable here: queries
    arrive one at a time, so there is nothing to sort."""

    def __init__(self, arr):
        # Indices appended in increasing order, so each list is already sorted.
        self.positions = defaultdict(list)
        for i, v in enumerate(arr):
            self.positions[v].append(i)

    def query(self, left, right, value):
        positions = self.positions.get(value)
        if not positions:
            return 0
        lo = bisect.bisect_left(positions, left)      # first position >= left
        hi = bisect.bisect_right(positions, right)    # first position >  right
        return hi - lo
```

### Complexity
Build **O(n)** time and space. Each query **O(log n)** — one binary search per end. Compare with Mo's `O((n+q)√n)` *and* its requirement that queries be offline: here the simpler structure is both faster and applicable. **Mo's is a fallback for aggregates that resist decomposition, not a default for "range query".**

---

## 11. Solved Example 3

### Problem — Sum of Squared Frequencies in a Range (the "powerful array" shape; Codeforces 86D)
For each query range `[left, right]`, compute `Σ count(x)²` over all distinct values `x` in that range, where `count(x)` is how many times `x` occurs inside the range.

This is where Mo's is genuinely irreplaceable: the answer is quadratic in the frequencies, so no prefix array, Fenwick tree, or per-value index can decompose it — but one element entering or leaving changes it by an amount you can compute in O(1).

### Thought Process
1. `Σ count(x)²` mixes values together non-linearly, so `answer(l..r)` cannot be recovered from `answer(0..r)` and `answer(0..l−1)`. Every decomposable structure is out.
2. The incremental rule, though, is a one-liner. If a value's count goes `c → c + 1`, the sum changes by `(c+1)² − c² = 2c + 1`:

```text
add(i)     : sum += 2 * count[v] + 1 ;  count[v]++
remove(i)  : sum -= 2 * count[v] - 1 ;  count[v]--
```

3. Both are O(1) and exact inverses — `add` then `remove` restores `sum` and `count` — which is exactly Mo's contract.
4. Static array plus all queries up front ⇒ offline ⇒ sort by `(left/blockSize, right)` and slide.
5. Free self-check: `Σ count(x)² = length + 2 · (number of index pairs holding equal values)`, so `pairs = (sum − length) / 2`.

### Dry Run

Input: `nums = [1, 2, 1, 1, 3, 2]`, `queries = [[0,2], [3,5], [1,4], [4,4]]`

`n = 6`, `q = 4` → `blockSize = round(6 / √4) = 3`. Blocks: Q0 `left=0`→0, Q2 `left=1`→0, Q1 `left=3`→**1**, Q3 `left=4`→**1**.
Block 0 sorts `right` **ascending** (Q0 r=2, then Q2 r=4); block 1 is odd so it sorts `right` **descending** (Q1 r=5, then Q3 r=4).

Processing order: **Q0 → Q2 → Q1 → Q3**, starting from `curLeft = 0, curRight = −1, sum = 0`.

| # | op | value | `count[v]` before | delta applied | `sum` | window now |
|---|---|---|---|---|---|---|
| 1 | `add(0)` | 1 | 0 | `+2·0+1 = +1` | **1** | `[0,0]` |
| 2 | `add(1)` | 2 | 0 | `+1` | **2** | `[0,1]` |
| 3 | `add(2)` | 1 | 1 | `+2·1+1 = +3` | **5** | `[0,2]` → **Q0 = 5** |
| 4 | `add(3)` | 1 | 2 | `+2·2+1 = +5` | **10** | `[0,3]` |
| 5 | `add(4)` | 3 | 0 | `+1` | **11** | `[0,4]` |
| 6 | `remove(0)` | 1 | 3 | `−(2·3−1) = −5` | **6** | `[1,4]` → **Q2 = 6** |
| 7 | `add(5)` | 2 | 1 | `+2·1+1 = +3` | **9** | `[1,5]` |
| 8 | `remove(1)` | 2 | 2 | `−(2·2−1) = −3` | **6** | `[2,5]` |
| 9 | `remove(2)` | 1 | 2 | `−3` | **3** | `[3,5]` → **Q1 = 3** |
| 10 | `remove(3)` | 1 | 1 | `−(2·1−1) = −1` | **2** | `[4,5]` |
| 11 | `remove(5)` | 2 | 1 | `−1` | **1** | `[4,4]` → **Q3 = 1** |

Written back to their original slots: **`[5, 3, 6, 1]`**

Check Q2 by hand: `nums[1..4] = 2,1,1,3` → counts `1×2, 2×1, 3×1` → `4 + 1 + 1 = 6` ✓. And the pair identity: `(6 − 4)/2 = 1` pair of equal elements — indeed only the two `1`s ✓.

Row 6 is the one to stare at. Removing a value whose count is 3 subtracts `5`, exactly undoing row 4's `+5`. **Every delta is symmetric**, which is why the window may shrink as freely as it grows.

### Visualization

```text
idx    0  1  2  3  4  5
nums   1  2  1  1  3  2

the state is just a frequency table plus one running number:

  window [0,3] = 1 2 1 1      count: 1→3, 2→1      sum = 3^2 + 1^2 = 10
                                                         ^^^^^^^^^^^^
  add another 1  (count 3 → 4):   4^2 - 3^2 = 2*3 + 1 = 7
  drop one    1  (count 3 → 2):   3^2 - 2^2 = 2*3 - 1 = 5      symmetric

  ┌───────────────────────────────────────────────────────────────┐
  │  add(i)    : sum += 2*count[v] + 1 ;  count[v]++              │
  │  remove(i) : sum -= 2*count[v] - 1 ;  count[v]--              │
  │  O(1) each, and exact inverses  ⇒  Mo's applies               │
  └───────────────────────────────────────────────────────────────┘

pointer travel over the 4 sorted queries:

  Q0 [0,2]   [=====]                     sum =  5
  Q2 [1,4]      [==========]             sum =  6
  Q1 [3,5]            [========]         sum =  3
  Q3 [4,4]                 [==]          sum =  1

  right : 2 → 4 → 5 → 4     block 1 sorts right DESCENDING, so 5 then 4
```

### Code

```go
// squaresQuery is one offline request; index says where its answer belongs.
type squaresQuery struct {
    left, right, index int
}

// sumOfSquaredCounts answers, per range, the sum of count(x)^2 over the values
// inside it. No prefix/Fenwick decomposition exists for this aggregate, but the
// incremental delta is O(1) and reversible — the exact case Mo's exists for.
func sumOfSquaredCounts(nums []int, queries [][]int) []int {
    n, q := len(nums), len(queries)
    answers := make([]int, q)
    if n == 0 || q == 0 {
        return answers
    }

    // Dense codes so the frequency table is a flat array, not a map.
    rank := make(map[int]int, n)
    coded := make([]int, n)
    for i, v := range nums {
        r, seen := rank[v]
        if !seen {
            r = len(rank)
            rank[v] = r
        }
        coded[i] = r
    }

    blockSize := int(math.Round(float64(n) / math.Sqrt(float64(q))))
    if blockSize < 1 {
        blockSize = 1
    }

    order := make([]squaresQuery, q)
    for i, qy := range queries {
        order[i] = squaresQuery{left: qy[0], right: qy[1], index: i}
    }
    sort.Slice(order, func(a, b int) bool {
        blockA, blockB := order[a].left/blockSize, order[b].left/blockSize
        if blockA != blockB {
            return blockA < blockB
        }
        if blockA%2 == 0 {
            return order[a].right < order[b].right
        }
        return order[a].right > order[b].right
    })

    count := make([]int, len(rank))
    sum := 0

    // (c+1)^2 - c^2 = 2c + 1        and        c^2 - (c-1)^2 = 2c - 1
    add := func(i int) {
        sum += 2*count[coded[i]] + 1
        count[coded[i]]++
    }
    remove := func(i int) {
        sum -= 2*count[coded[i]] - 1
        count[coded[i]]--
    }

    curLeft, curRight := 0, -1
    for _, qy := range order {
        for curLeft > qy.left {
            curLeft--
            add(curLeft)
        }
        for curRight < qy.right {
            curRight++
            add(curRight)
        }
        for curLeft < qy.left {
            remove(curLeft)
            curLeft++
        }
        for curRight > qy.right {
            remove(curRight)
            curRight--
        }
        answers[qy.index] = sum
    }
    return answers
}
```

```python
def sum_of_squared_counts(nums, queries):
    """Per range, the sum of count(x)^2. Offline, via Mo's algorithm."""
    n, q = len(nums), len(queries)
    answers = [0] * q
    if n == 0 or q == 0:
        return answers

    rank = {}
    for v in nums:
        if v not in rank:
            rank[v] = len(rank)
    coded = [rank[v] for v in nums]

    block = max(1, round(n / (q ** 0.5)))

    def sort_key(item):
        left, right, _ = item
        b = left // block
        return (b, right if b % 2 == 0 else -right)

    count = [0] * len(rank)
    state = {"sum": 0}

    def add(i):                       # (c+1)^2 - c^2 = 2c + 1
        state["sum"] += 2 * count[coded[i]] + 1
        count[coded[i]] += 1

    def remove(i):                    # c^2 - (c-1)^2 = 2c - 1
        state["sum"] -= 2 * count[coded[i]] - 1
        count[coded[i]] -= 1

    ordered = sorted(((l, r, i) for i, (l, r) in enumerate(queries)), key=sort_key)

    cur_left, cur_right = 0, -1
    for left, right, index in ordered:
        while cur_left > left:
            cur_left -= 1
            add(cur_left)
        while cur_right < right:
            cur_right += 1
            add(cur_right)
        while cur_left < left:
            remove(cur_left)
            cur_left += 1
        while cur_right > right:
            remove(cur_right)
            cur_right -= 1
        answers[index] = state["sum"]
    return answers
```

### Complexity
Time **O(n·√q + q·log q)** — `O(q·blockSize + n²/blockSize) = O(n√q)` O(1) pointer moves plus the sort; **O((n+q)√n)** in the usual `q ≈ n` regime. Space O(n).

> The three examples are one lesson. Example 1: the aggregate resists decomposition but is O(1)-repairable → Mo's. Example 2: a simpler structure exists *and* the queries are online → not Mo's. Example 3: nothing else can express the aggregate at all → Mo's, without apology. Ask "offline?" and "O(1) reversible?" in that order, and you will never reach for it by mistake.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| Distinct | in range | Easy | Core advanced application |
| 2080 | Range Frequency | Easy | Core advanced application |
| Offline | range queries | Medium | Core advanced application |
| 1languages | count | Medium | Core advanced application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Trie**
- **Segment tree (+ lazy)**
- **Fenwick / BIT**
- **Sparse table**
- **Bitmask DP**
- **Meet in the middle**
- **Euler tour / HLD**
- **Max flow**
- **SCC / Tarjan**
- **Mo's algorithm**

---

## 14. Production Engineering Applications

- **Scalability:** These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n) to O(n log n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Mo's Algorithm logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Mo's Algorithm (Advanced).
- **Signal:** mo's algorithm, offline queries, sqrt decomposition, range queries, add remove.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Mo's Algorithm invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Mo's Algorithm
FAMILY : Advanced (Expert)
WHEN   : mo's algorithm, offline queries, sqrt decomposition, range queries, add remove
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: Distinct, 2080, Offline, 1languages
```

---

*Part of the DSA Patterns Handbook — pattern 100 of 100.*
