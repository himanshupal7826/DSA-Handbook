# 40 · Monotonic Queue

> **One-liner:** A deque kept monotone yields O(1) window min/max amortized.

---

## 1. Overview

### Definition
The **Monotonic Queue** pattern belongs to the *Queues* family. A deque kept monotone yields O(1) window min/max amortized.

### Intuition
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Why it works
Use a deque (monotonic queue) or FIFO queue to maintain window extrema / level order in O(1) amortized per element. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.

---

## 2. Recognition Signals

### Keywords
monotonic queue, deque, window max, window min, amortized.

### Constraints
- Input size where the brute-force complexity would time out — the Monotonic Queue optimization is the intended solution.
- Structural hints in the statement that match this family (Queues).

### Hidden clues
- The problem can be reframed so the Monotonic Queue invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Monotonic Queue is the upgrade.
- The wording maps onto: monotonic queue, deque, window max, window min, amortized.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the maximum (or minimum) of every window, without re-scanning the whole window every time it moves?"*

Running example: `nums = [1, 3, -1, -3, 5]`, `k = 3`. There are three windows; report the max of each.

### Intuition
A window of size `k` slides one step at a time. The obvious thing to do is stop at each position and look at all `k` values to find the biggest one. That is correct and takes three lines of code — you just do the same scan again and again.

### Algorithm
1. For every start index `i` from `0` to `n - k`:
2. Scan `nums[i .. i+k-1]` and remember the largest value seen.
3. Append that value to the output.
4. Return the output.

### Complexity
- Time: **O(n·k)** — `n - k + 1` windows, each scanned in `k` steps.
- Space: O(1) beyond the output.

### Drawbacks

Watch the actual comparisons on the running example:

```text
window 0: [ 1 ,  3 , -1 ]        reads 1, 3, -1   → max 3
window 1: [ 3 , -1 , -3 ]        reads 3, -1, -3  → max 3
window 2: [-1 , -3 ,  5 ]        reads -1, -3, 5  → max 5
                ^^^^^^^
        3 and -1 are read twice; -1 and -3 are read twice.
        Only ONE value is new per step, yet we redo all k reads.
```

- Each step introduces exactly **one** new element and removes exactly **one** old one, but we recompute the answer from all `k` elements anyway.
- The brute force never exploits an obvious fact: `-3` sits behind the larger `-1`, so `-3` can never be the maximum of any window that still contains `-1`. It is dead weight, and we keep looking at it.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Keep only the elements that could still become the window's maximum — a value that is smaller than something to its right is already dead, so throw it away forever.**

The Fixed Window chapter taught you to maintain a running *sum*: when an element leaves the window you subtract it, and the sum stays correct in O(1). Try that with a *maximum* and it breaks. If the departing element **was** the max, subtracting it tells you nothing — the new maximum is some value you never recorded, and you are back to scanning. A max cannot be "un-added". That is the exact gap this pattern fills: instead of one running value, keep a short **ordered list of surviving candidates**.

### The thought process

```text
We need    : max of each k-sized window, all n-k+1 of them
Obvious way: rescan the k values at every position
Too slow   : O(n*k) — and only one element actually changed
Notice     : a sum can be un-added when an element leaves; a MAX cannot,
             because if the leaver WAS the max the new max is unknown
Notice     : if nums[j] <= nums[i] and j < i, then j is smaller AND leaves
             the window earlier — j can never be the max again
Therefore  : keep a list of indices whose values decrease left→right;
             every discarded index was provably useless
Now        : the front of that list is the answer, in O(1)
```

### Why the monotonic deque works

Store **indices**, not values — you need positions to know when something expires.

Two rules keep the list valid, and each has a one-line proof:

| Rule | When | Why it is safe |
|------|------|----------------|
| **Pop the back** while `nums[back] <= v` | before pushing the arriving value `v` at index `i` | `back` sits to the *left* of `i`, so it expires *first*, and its value is *not larger*. Any window containing `back` from now on also contains `i`. It can never be the unique max again → delete it, forever. |
| **Pop the front** while `front <= i - k` | after pushing | The front is the leftmost surviving candidate. If its index has slid past the window's left edge it is simply not in the window anymore. |

After both rules, the deque holds indices with **strictly decreasing values**, all inside the window. The largest is therefore at the **front** — read it in O(1).

Why the back-pop uses `<=` and not `<`: with equal values, keeping the older duplicate buys nothing (it expires sooner) and complicates nothing to drop. Either comparison is correct for the maximum; `<=` keeps the deque shorter.

**A tiny counterexample if you skip the front-pop.** On `[5,1,1]` with `k = 2`: index 0 (value 5) never gets popped from the back, so at `i = 2` the front is still index 0 and you would report `5` for the window `[1,1]`. The front-pop is what enforces "inside the window".

**Amortised O(1).** Each index is `append`ed exactly once and removed at most once, from either end. Total deque work across the whole scan is ≤ 2n operations, so the inner `for` loops are O(1) *on average* even though a single step can pop many indices.

### Steps

```text
Step 1 → for each index i with value v:
Step 2 →   while deque non-empty and nums[deque.back] <= v: pop back
Step 3 →   push i at the back
Step 4 →   if deque.front <= i - k: pop front        (it expired)
Step 5 →   if i >= k-1: emit nums[deque.front]       (window is full)
```

For the window **minimum**, flip one character: pop the back while `nums[back] >= v`, and the deque becomes increasing.

### How should I recognize this?

```text
If you see...
  "maximum/minimum of every subarray of size k", "sliding window max",
  a DP recurrence of the form dp[i] = nums[i] + max(dp[i-k .. i-1]),
  or n up to 1e5 with an O(n*k) obvious solution
        ↓
Think about...
  "Can the quantity I track be un-done when an element leaves?"
  Sums and counts: yes → plain sliding window.
  Max, min, "best so far": NO → you need surviving candidates.
        ↓
Use...
  a deque of INDICES kept monotone
    · window maximum      → decreasing deque, pop back while <= v
    · window minimum      → increasing deque, pop back while >= v
    · both at once (range constraints, LC 1438) → run two deques
    · window over prefix sums (LC 862) → increasing deque, pop the front
      as soon as it satisfies the target; it is optimal and never needed again
```

### Visual explanation

```svg
<svg viewBox="0 0 640 230" width="100%" height="230" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-40" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Monotonic (decreasing) deque: front = max, pop back the smaller</text>
  <text x="120" y="88" text-anchor="middle" fill="#64748b">front</text>
  <text x="360" y="88" text-anchor="middle" fill="#64748b">back</text>
  <rect x="90"  y="96" width="60" height="46" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="120" y="124" text-anchor="middle" fill="#1e293b" font-weight="700">8</text>
  <rect x="156" y="96" width="60" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="186" y="124" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="222" y="96" width="60" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="252" y="124" text-anchor="middle" fill="#1e293b">2</text>
  <text x="120" y="164" text-anchor="middle" fill="#059669" font-weight="700">max</text>
  <rect x="430" y="96" width="60" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="460" y="124" text-anchor="middle" fill="#1e293b" font-weight="700">4</text>
  <text x="460" y="88" text-anchor="middle" fill="#64748b">incoming</text>
  <line x1="424" y1="119" x2="290" y2="119" stroke="#475569" marker-end="url(#ar-40)"/>
  <text x="356" y="112" text-anchor="middle" fill="#d97706">2 &lt; 4 → pop back</text>
  <path d="M430,142 Q360,196 292,150" fill="none" stroke="#475569" stroke-dasharray="5 4" marker-end="url(#ar-40)"/>
  <text x="360" y="192" text-anchor="middle" fill="#2563eb">then push 4 at back → deque [8, 6, 4]</text>
  <line x1="120" y1="76" x2="120" y2="94" stroke="#475569" marker-end="url(#ar-40)"/>
  <text x="120" y="70" text-anchor="middle" fill="#64748b">pop front when it exits the window</text>
</svg>
```

```text
nums = [1, 3, -1, -3, 5]   k = 3        (deque holds INDICES)

i=0  v= 1   back-pops: none            deque=[0]        vals=(1)
i=1  v= 3   1 <= 3 → pop 0             deque=[1]        vals=(3)
i=2  v=-1   3 <= -1? no                deque=[1,2]      vals=(3,-1)
            front=1 > i-k=-1, stays    window [1,3,-1]  → max = nums[1] = 3
i=3  v=-3   -1 <= -3? no               deque=[1,2,3]    vals=(3,-1,-3)
            front=1 > i-k=0, stays     window [3,-1,-3] → max = nums[1] = 3
i=4  v= 5   pop 3, 2, 1 (all <= 5)     deque=[4]        vals=(5)
            front=4 > i-k=1, stays     window [-1,-3,5] → max = nums[4] = 5

output = [3, 3, 5]      pushes: 5, pops: 4  →  linear, not 5*3
```

### Interview explanation
"A sliding-window sum works because you can subtract the element that leaves, but a maximum can't be undone that way — if the leaver was the max, the new max is unknown. So instead of one number I keep a deque of candidate **indices** whose values are decreasing. When a new value arrives I pop every index at the back whose value is `<=` it, because those elements are both smaller and expire earlier, so they can never win again. Then I pop the front if its index has slid out of the window. The front is always the current maximum, read in O(1). Every index is pushed once and popped once, so the whole thing is O(n) time and O(k) space."

---

## 5. Generic Templates

> Keep a deque of indices whose values are monotone; pop the back to preserve order, pop the front to preserve the window.

```go
// windowMaximums returns the maximum of every k-sized window of nums.
// The deque holds indices whose values are strictly decreasing front -> back,
// so the front is always the maximum of the current window.
// For window minimums, change the back-pop comparison to `>=`.
func windowMaximums(nums []int, k int) []int {
	if k <= 0 || len(nums) < k {
		return nil
	}
	deque := make([]int, 0, len(nums))
	out := make([]int, 0, len(nums)-k+1)
	for i, v := range nums {
		// smaller AND older -> can never be the max again
		for len(deque) > 0 && nums[deque[len(deque)-1]] <= v {
			deque = deque[:len(deque)-1]
		}
		deque = append(deque, i)
		if deque[0] <= i-k { // the front slid out of the window
			deque = deque[1:]
		}
		if i >= k-1 { // first full window has formed
			out = append(out, nums[deque[0]])
		}
	}
	return out
}
```

```python
from collections import deque


def window_maximums(nums, k):
    """Maximum of every k-sized window. Deque holds indices, values decreasing."""
    if k <= 0 or len(nums) < k:
        return []
    dq, out = deque(), []
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] <= v:      # smaller AND older -> useless
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:                   # front slid out of the window
            dq.popleft()
        if i >= k - 1:
            out.append(nums[dq[0]])
    return out
```

```java
// Deque holds indices whose values decrease from first to last.
int[] windowMaximums(int[] nums, int k) {
    if (k <= 0 || nums.length < k) return new int[0];
    Deque<Integer> dq = new ArrayDeque<>();
    int[] out = new int[nums.length - k + 1];
    for (int i = 0; i < nums.length; i++) {
        while (!dq.isEmpty() && nums[dq.peekLast()] <= nums[i]) dq.pollLast();
        dq.offerLast(i);
        if (dq.peekFirst() <= i - k) dq.pollFirst();   // expired
        if (i >= k - 1) out[i - k + 1] = nums[dq.peekFirst()];
    }
    return out;
}
```

```cpp
// Deque holds indices whose values decrease from front to back.
vector<int> windowMaximums(const vector<int>& nums, int k) {
    vector<int> out;
    if (k <= 0 || (int)nums.size() < k) return out;
    deque<int> dq;
    for (int i = 0; i < (int)nums.size(); ++i) {
        while (!dq.empty() && nums[dq.back()] <= nums[i]) dq.pop_back();
        dq.push_back(i);
        if (dq.front() <= i - k) dq.pop_front();       // expired
        if (i >= k - 1) out.push_back(nums[dq.front()]);
    }
    return out;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Monotonic Queue (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(k)** |

> Each element enters/leaves the deque once; BFS visits each node/edge once.

---

## 7. Common Mistakes

1. Storing values instead of indices, so you can't evict by position.
2. Forgetting to evict indices that fell out of the window.
3. Wrong deque monotonicity for min vs max.
4. Emitting results before the first full window forms.
5. BFS: not marking nodes visited when enqueuing (causes revisits/TLE).
6. BFS: marking visited at dequeue time, allowing duplicates in the queue.
7. Mixing level boundaries in level-order BFS.
8. Using a list as a queue with O(n) pops from the front.
9. Off-by-one in window eviction condition.
10. Not handling k larger than the array length.

---

## 8. Interview Follow-Up Questions

1. **Q: Why a deque for window max?**
   A: It keeps a decreasing sequence of candidates; the front is always the max.

2. **Q: Amortized cost?**
   A: Each index is pushed and popped at most once → O(n).

3. **Q: Window minimum?**
   A: Same idea with an increasing deque.

4. **Q: BFS vs DFS for shortest path?**
   A: BFS gives shortest path in unweighted graphs.

5. **Q: Multi-source BFS?**
   A: Seed the queue with all sources at distance 0.

6. **Q: 0-1 BFS?**
   A: Use a deque: push front for 0-weight, back for 1-weight edges.

7. **Q: Level-order traversal?**
   A: Process the queue in size-batches per level.

8. **Q: Why mark visited at enqueue?**
   A: Prevents the same node being queued multiple times.

9. **Q: Shortest subarray with sum >= K (negatives)?**
   A: Monotonic deque on prefix sums.

10. **Q: Space complexity?**
   A: O(k) for the window / O(V) for BFS frontier.

11. **Q: Deque vs heap for window max?**
   A: Deque is O(n); heap is O(n log k).

12. **Q: Rotting oranges / spread problems?**
   A: Multi-source BFS by time layers.

13. **Q: Word ladder?**
   A: BFS over word-transformation graph.

14. **Q: Bidirectional BFS?**
   A: Search from both ends to cut the frontier.

15. **Q: Queue overflow in huge graphs?**
   A: Stream/iterative deepening or external memory.

---

## 9. Solved Example 1

### Problem — Sliding Window Max (LeetCode 239)
Given an array `nums` and a window size `k`, return the maximum value inside each window as the window slides one position at a time from left to right.

### Thought Process
1. Rescanning each window is O(n·k); only one element changes per step, so most of that work is repeated.
2. A running max cannot be repaired when the max itself leaves — so keep **candidates**, not one number.
3. Keep a deque of **indices** whose values decrease front → back; the front is the window's max.
4. Before pushing `i`, pop every back index with value `<= nums[i]`: smaller **and** expiring earlier, so provably useless.
5. After pushing, pop the front if `front <= i - k`; once `i >= k-1`, emit `nums[front]`.

### Dry Run

Input: `nums = [1,3,-1,-3,5]`, `k = 3`

| i | v | back-pops | deque (indices) | values | front expired? | emit |
|---|----|-----------|-----------------|--------|----------------|------|
| 0 | 1 | — | `[0]` | `(1)` | `0 <= -3`? no | — (window not full) |
| 1 | 3 | pop 0 (`1 <= 3`) | `[1]` | `(3)` | `1 <= -2`? no | — |
| 2 | -1 | none (`3 > -1`) | `[1,2]` | `(3,-1)` | `1 <= -1`? no | `nums[1] = 3` |
| 3 | -3 | none (`-1 > -3`) | `[1,2,3]` | `(3,-1,-3)` | `1 <= 0`? no | `nums[1] = 3` |
| 4 | 5 | pop 3, 2, 1 | `[4]` | `(5)` | `4 <= 1`? no | `nums[4] = 5` |

Output: **`[3,3,5]`**

Row `i=4` is the whole pattern in one line: three back-pops at once, yet those indices were each pushed only once — that is why the amortised cost stays O(1) per element. Row `i=3` shows the other half: index 1 is still the max even though two newer elements arrived, because both are smaller.

### Visualization

```text
                 window
             ┌──────────────┐
nums:   1    3   -1   -3    5
idx :   0    1    2    3    4

deque after each i   (front is the max)
i=0   [0]                       front→ 1
i=1   [1]            0 popped: 1 <= 3
i=2   [1, 2]                    front→ 3   ← emit 3
i=3   [1, 2, 3]                 front→ 3   ← emit 3
i=4   [4]            3,2,1 all popped: <= 5
                                front→ 5   ← emit 5

values along the deque are always DECREASING:  3 > -1 > -3
```

### Code

```go
// maxSlidingWindow returns the maximum of every k-sized window of nums.
func maxSlidingWindow(nums []int, k int) []int {
	if k <= 0 || len(nums) < k {
		return nil
	}
	deque := make([]int, 0, len(nums)) // indices, nums[...] decreasing
	out := make([]int, 0, len(nums)-k+1)
	for i, v := range nums {
		for len(deque) > 0 && nums[deque[len(deque)-1]] <= v {
			deque = deque[:len(deque)-1] // smaller and older -> never the max again
		}
		deque = append(deque, i)
		if deque[0] <= i-k {
			deque = deque[1:] // front slid out of the window
		}
		if i >= k-1 {
			out = append(out, nums[deque[0]])
		}
	}
	return out
}
```

```python
from collections import deque


def max_sliding_window(nums, k):
    if k <= 0 or len(nums) < k:
        return []
    dq, out = deque(), []                    # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] <= v:
            dq.pop()                         # smaller and older -> never the max again
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()                     # front slid out of the window
        if i >= k - 1:
            out.append(nums[dq[0]])
    return out
```

### Complexity
Time O(n) — each index is appended once and removed at most once, so the inner loops do ≤ 2n work in total. Space O(k) — the deque never holds more than one window's worth of indices.

## 10. Solved Example 2

### Problem — Shortest Subarray (LeetCode 862)
Given an integer array `nums` (which **may contain negatives**) and an integer `k`, return the length of the shortest non-empty subarray whose sum is at least `k`, or `-1` if none exists.

### Thought Process
1. Write it with prefix sums: `prefix[j] - prefix[i]` is the sum of `nums[i..j-1]`, so we want the smallest `j - i` with `prefix[j] - prefix[i] >= k`.
2. Negatives kill the plain two-pointer window: growing the window can *shrink* the sum, so "shrink while the sum is too big" is not a valid rule.
3. For a fixed right end `j`, the best left end is the **smallest** `prefix[i]` among indices we have not used yet — so keep candidate indices with increasing `prefix`.
4. Pop from the **front** while `prefix[j] - prefix[front] >= k`: that front gives a valid subarray, and any later `j` would only give a longer one, so record the length and discard it forever.
5. Pop from the **back** while `prefix[back] >= prefix[j]`: `j` is both later and no larger, so it dominates `back` as a left end.

### Dry Run

Input: `nums = [2,-1,2]`, `k = 3` → `prefix = [0,2,1,3]`

| j | prefix[j] | front-pops (record length) | back-pops | deque (indices) | prefix values | best |
|---|-----------|----------------------------|-----------|-----------------|---------------|------|
| 0 | 0 | deque empty | none | `[0]` | `(0)` | 4 (∞) |
| 1 | 2 | `2 - 0 = 2 < 3` stop | `prefix[0]=0 >= 2`? no | `[0,1]` | `(0,2)` | 4 |
| 2 | 1 | `1 - 0 = 1 < 3` stop | pop 1 (`2 >= 1`) | `[0,2]` | `(0,1)` | 4 |
| 3 | 3 | `3 - 0 = 3 >= 3` → len `3-0=3`, pop 0; then `3 - 1 = 2 < 3` stop | none | `[2,3]` | `(1,3)` | **3** |

Output: **`3`** (the whole array `[2,-1,2]` sums to 3)

Row `j=2` is the subtle one: `prefix[2] = 1` is *smaller* than `prefix[1] = 2` and comes later, so index 1 could never beat index 2 as a left end — it is popped from the back and never considered again.

### Visualization

```text
prefix:   0    2    1    3
index :   0    1    2    3

deque must stay INCREASING in prefix value:

 j=1   [0, 1]      (0, 2)  ✓ increasing
 j=2   push 1 → (0, 2, 1)  ✗ not increasing
       pop back 1        → (0, 1)   ✓   deque=[0,2]
 j=3   3 - prefix[0] = 3 ≥ k  → answer candidate len = 3 - 0 = 3
       index 0 popped from the FRONT: a later j could only be longer
```

### Code

```go
// shortestSubarray returns the length of the shortest subarray with sum >= k,
// or -1 when no such subarray exists. nums may contain negative values.
func shortestSubarray(nums []int, k int) int {
	n := len(nums)
	prefix := make([]int, n+1)
	for i, v := range nums {
		prefix[i+1] = prefix[i] + v
	}
	deque := make([]int, 0, n+1) // indices into prefix, prefix values increasing
	best := n + 1
	for j := 0; j <= n; j++ {
		// front already reaches the target: shortest for this j, retire it
		for len(deque) > 0 && prefix[j]-prefix[deque[0]] >= k {
			if j-deque[0] < best {
				best = j - deque[0]
			}
			deque = deque[1:]
		}
		// a later index with a smaller prefix dominates an earlier larger one
		for len(deque) > 0 && prefix[deque[len(deque)-1]] >= prefix[j] {
			deque = deque[:len(deque)-1]
		}
		deque = append(deque, j)
	}
	if best <= n {
		return best
	}
	return -1
}
```

```python
from collections import deque


def shortest_subarray(nums, k):
    n = len(nums)
    prefix = [0] * (n + 1)
    for i, v in enumerate(nums):
        prefix[i + 1] = prefix[i] + v

    dq, best = deque(), n + 1            # dq holds indices with increasing prefix
    for j in range(n + 1):
        while dq and prefix[j] - prefix[dq[0]] >= k:
            best = min(best, j - dq.popleft())   # optimal for this j, retire it
        while dq and prefix[dq[-1]] >= prefix[j]:
            dq.pop()                     # later + smaller prefix dominates
        dq.append(j)
    return best if best <= n else -1
```

### Complexity
Time O(n) — each prefix index enters the deque once and leaves at most once. Space O(n) — the prefix array plus a deque bounded by `n + 1` indices.

## 11. Solved Example 3

### Problem — Limit Diff (LeetCode 1438)
Given an array `nums` and an integer `limit`, return the length of the longest subarray such that the difference between its maximum and its minimum is at most `limit`.

### Thought Process
1. The condition `max - min <= limit` is **monotone**: shrinking a valid window keeps it valid, so a two-pointer window works.
2. But the check needs both the window max *and* the window min at every step — two extrema that cannot be maintained by adding/subtracting.
3. Run two monotonic deques over the same window: `maxDq` decreasing (front = max) and `minDq` increasing (front = min). Here we store **values**, since we only ever evict from the left edge.
4. Extend `right`; while `maxDq[0] - minDq[0] > limit`, advance `left`, popping a deque front only when it equals the value leaving.
5. Track the largest `right - left + 1` seen.

### Dry Run

Input: `nums = [8,2,4,7]`, `limit = 4`

| right | v | maxDq (decreasing) | minDq (increasing) | max−min | shrink? | left | best |
|-------|---|--------------------|--------------------|---------|---------|------|------|
| 0 | 8 | `[8]` | `[8]` | `8-8 = 0` | no | 0 | 1 |
| 1 | 2 | `[8,2]` | `[2]` | `8-2 = 6 > 4` | drop `nums[0]=8` from maxDq | 1 | 1 |
| 1 | — | `[2]` | `[2]` | `2-2 = 0` | stop | 1 | 1 |
| 2 | 4 | `[4]` (2 popped) | `[2,4]` | `4-2 = 2` | no | 1 | 2 |
| 3 | 7 | `[7]` (4 popped) | `[2,4,7]` | `7-2 = 5 > 4` | drop `nums[1]=2` from minDq | 2 | 2 |
| 3 | — | `[7]` | `[4,7]` | `7-4 = 3` | stop | 2 | 2 |

Output: **`2`** (e.g. `[2,4]` or `[4,7]`)

Note the shrink rows: `left` advances but a deque front is popped *only if it equals the departing value*. At `right=3` the max `7` is not `nums[1]`, so `maxDq` is untouched — the leaving element was already absent from that deque, discarded earlier as dominated.

### Visualization

```text
nums = [8, 2, 4, 7]   limit = 4

right=1                right=3
  window [8, 2]          window [2, 4, 7]        7 - 2 = 5 > limit
  maxDq  8 → 2           maxDq  7                       ↓ shrink left
  minDq  2               minDq  2 → 4 → 7        window [4, 7]
  8 - 2 = 6 > 4                                  maxDq  7
       ↓ shrink left                             minDq  4 → 7
  window [2]                                     7 - 4 = 3 ≤ 4  ✓ len 2
                                                 best = 2

maxDq always reads DOWN the values; minDq always reads UP.
```

### Code

```go
// longestSubarray returns the longest window whose max-min is at most limit.
func longestSubarray(nums []int, limit int) int {
	maxDq := make([]int, 0, len(nums)) // values, decreasing: front = window max
	minDq := make([]int, 0, len(nums)) // values, increasing: front = window min
	left, best := 0, 0
	for right, v := range nums {
		for len(maxDq) > 0 && maxDq[len(maxDq)-1] < v {
			maxDq = maxDq[:len(maxDq)-1]
		}
		maxDq = append(maxDq, v)
		for len(minDq) > 0 && minDq[len(minDq)-1] > v {
			minDq = minDq[:len(minDq)-1]
		}
		minDq = append(minDq, v)

		for maxDq[0]-minDq[0] > limit { // window too wide in value -> shrink
			if maxDq[0] == nums[left] {
				maxDq = maxDq[1:]
			}
			if minDq[0] == nums[left] {
				minDq = minDq[1:]
			}
			left++
		}
		if right-left+1 > best {
			best = right - left + 1
		}
	}
	return best
}
```

```python
from collections import deque


def longest_subarray(nums, limit):
    max_dq, min_dq = deque(), deque()    # values: decreasing / increasing
    left = best = 0
    for right, v in enumerate(nums):
        while max_dq and max_dq[-1] < v:
            max_dq.pop()
        max_dq.append(v)
        while min_dq and min_dq[-1] > v:
            min_dq.pop()
        min_dq.append(v)

        while max_dq[0] - min_dq[0] > limit:     # shrink from the left
            if max_dq[0] == nums[left]:
                max_dq.popleft()
            if min_dq[0] == nums[left]:
                min_dq.popleft()
            left += 1
        best = max(best, right - left + 1)
    return best
```

### Complexity
Time O(n) — each value is pushed into each deque once and popped at most once; `left` only moves forward. Space O(n) — worst case (a strictly increasing array) one deque holds every element.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 239 | Sliding Window Max | Easy | Core queues application |
| 862 | Shortest Subarray | Easy | Core queues application |
| 1438 | Limit Diff | Medium | Core queues application |
| 1696 | Jump VI | Medium | Core queues application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Monotonic deque (window max/min)**
- **FIFO BFS**
- **Multi-source BFS**
- **0-1 BFS**
- **Level-order traversal**

---

## 14. Production Engineering Applications

- **Scalability:** Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(k)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Monotonic Queue logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Monotonic Queue (Queues).
- **Signal:** monotonic queue, deque, window max, window min, amortized.
- **Move:** A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Monotonic Queue invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Monotonic Queue
FAMILY : Queues (Advanced)
WHEN   : monotonic queue, deque, window max, window min, amortized
DO     : A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand fro
TIME   : O(n)    SPACE: O(k)
PRACTICE: 239, 862, 1438, 1696
```

---

*Part of the DSA Patterns Handbook — pattern 40 of 100.*
