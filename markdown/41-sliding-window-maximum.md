# 41 · Sliding Window Maximum

> **One-liner:** Deque of candidate indices gives window maxima in O(n).

---

## 1. Overview

### Definition
The **Sliding Window Maximum** pattern belongs to the *Queues* family. Deque of candidate indices gives window maxima in O(n).

### Intuition
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Why it works
Use a deque (monotonic queue) or FIFO queue to maintain window extrema / level order in O(1) amortized per element. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.

---

## 2. Recognition Signals

### Keywords
sliding window maximum, deque, monotonic, window, max.

### Constraints
- Input size where the brute-force complexity would time out — the Sliding Window Maximum optimization is the intended solution.
- Structural hints in the statement that match this family (Queues).

### Hidden clues
- The problem can be reframed so the Sliding Window Maximum invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Sliding Window Maximum is the upgrade.
- The wording maps onto: sliding window maximum, deque, monotonic, window, max.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"I need `max(...)` of a trailing window at every index — how do I get it without looking at all `k` values each time?"*

Running example: `nums = [4, 1, 5, 2]`, `k = 2`. Three windows: `[4,1]`, `[1,5]`, `[5,2]`.

### Intuition
Stand at each window position and just look at everything inside it. Take the biggest. Move one step right and do it again. Nothing is remembered between positions, so nothing can go wrong — and nothing is saved either.

### Algorithm
1. For each start `i` from `0` to `n - k`:
2. Set `best = nums[i]`.
3. For `j` from `i+1` to `i+k-1`, `best = max(best, nums[j])`.
4. Append `best` to the output.

### Complexity
- Time: **O(n·k)** — with `n = 10^5` and `k = 10^4` that is 10^9 comparisons.
- Space: O(1) beyond the output.

### Drawbacks

The tempting "fix" is to carry a running max and only compare it with the newcomer. Watch it break:

```text
window [4, 1]   running max = 4                      ✓
slide: 4 leaves, 5 enters
        max(4, 5) = 5                                ✓ by luck
window [1, 5]   running max = 5
slide: 1 leaves, 2 enters
        max(5, 2) = 5                                ✓ by luck

now try  nums = [4, 1, 2],  k = 2
window [4, 1]   running max = 4
slide: 4 leaves — 4 WAS the max, so the stored 4 is now a lie.
        max(4, 2) = 4, but the real answer for [1, 2] is 2.       ✗
```

- **The specific wasted work:** consecutive windows share `k-1` elements, yet all `k` are re-read every step.
- **The fact the brute force fails to exploit:** a sum can be repaired when an element leaves (subtract it); a **maximum cannot**. If the departing element was the max, the new max is a value you never bothered to keep. So the fix is not "one number" — it is "a short list of values that could still become the max".

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Carry a shrinking list of *candidates* instead of a single max: any value with a bigger value to its right is dead, because that bigger value both beats it and outlives it.**

Think of a queue at a ticket counter where only the tallest person is served. If someone taller joins the back, everyone shorter already standing in front of them can go home — they will never be the tallest again while the taller person is present, and they leave the queue sooner anyway. What remains is a line of people whose heights decrease from front to back: the front is the answer.

### The thought process

```text
We need    : max over a window of size k, at every position
Obvious way: rescan the window each step
Too slow   : O(n*k)
Notice     : max cannot be un-added — dropping the max leaves no fallback
Notice     : if nums[j] <= nums[i] for j < i, then j is both smaller and
             expires earlier, so j is never again the answer
Therefore  : keep only indices whose values strictly decrease left to right
Now        : front = max (O(1)); each index is pushed once, popped once → O(n)
```

### Why the deque of indices works

Store **indices**, never bare values, so you can tell when a candidate expires.

**Rule 1 — pop the back while `nums[back] <= v`.** Index `back` is to the left of the arriving index `i`, so every future window that contains `back` also contains `i`. Since `nums[back] <= v`, `back` can never be the strict maximum again. Deleting it loses nothing.

**Rule 2 — pop the front while `front <= i - k`.** The front is the current best candidate, but "best" only counts if it is still inside the window. Once its index falls behind the left edge it must go.

Together these keep the deque **strictly decreasing in value and entirely inside the window**, so the front is the window max by construction.

**Why this is O(n), not O(n·k).** Rule 1's inner loop can pop many indices at one step — but each index enters the deque exactly once and leaves at most once. Over the whole array that is at most `n` pushes and `n` pops: **amortised O(1) per element**.

**Why not a heap?** A max-heap also answers "biggest so far", but it cannot delete the element that just left the window in O(log k) without extra bookkeeping. The usual workaround is lazy deletion (`(value, index)` pairs, discard stale tops), which costs O(n log n) and O(n) space. The deque is O(n) time and O(k) space because it *proactively throws away* everything that can never win, so nothing stale accumulates.

### Steps

```text
Step 1 → for i, v := range nums:
Step 2 →   pop the back while nums[back] <= v      (dominated candidates)
Step 3 →   push i at the back
Step 4 →   if front <= i - k: pop the front        (expired candidate)
Step 5 →   if i >= k-1: answer for this window is nums[front]
```

### How should I recognize this?

```text
If you see...
  "max/min of every subarray of length k"
  a DP recurrence  dp[i] = f(nums[i]) + max(dp[i-k .. i-1])
  "you may jump at most k steps"  /  "indices at most k apart"
  n up to 1e5 and the obvious loop is O(n*k)
        ↓
Think about...
  "Is the quantity reversible when an element leaves the window?"
  sum / count  → yes, plain sliding window
  max / min / best  → no, you need surviving candidates
        ↓
Use...
  a deque of INDICES, monotone by value
    · window maximum          → decreasing deque, pop back while <=
    · window minimum          → increasing deque, pop back while >=
    · DP over a k-window      → push dp[i] into the deque; read the front
                                BEFORE computing dp[i], push AFTER
    · need max AND min        → two deques over the same window
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-41" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Sliding window max (k=3): deque of indices, front = window max</text>
  <text x="60" y="52" text-anchor="middle" fill="#64748b">nums</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#64748b">1</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#64748b">3</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="148" y="88" text-anchor="middle" fill="#1e293b">-1</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="196" y="88" text-anchor="middle" fill="#1e293b">-3</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="244" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">5</text>
  <rect x="270" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="292" y="88" text-anchor="middle" fill="#64748b">3</text>
  <rect x="318" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="340" y="88" text-anchor="middle" fill="#64748b">6</text>
  <rect x="366" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="388" y="88" text-anchor="middle" fill="#64748b">7</text>
  <rect x="122" y="56" width="148" height="52" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="196" y="126" text-anchor="middle" fill="#64748b">window idx 2..4</text>
  <line x1="274" y1="82" x2="330" y2="82" stroke="#475569" marker-end="url(#ar-41)"/>
  <text x="302" y="76" text-anchor="middle" fill="#64748b">slide →</text>
  <text x="90" y="164" text-anchor="middle" fill="#64748b">deque of indices (values decreasing)</text>
  <rect x="30"  y="176" width="80" height="42" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="70"  y="202" text-anchor="middle" fill="#1e293b">i2 (-1) pop</text>
  <rect x="120" y="176" width="80" height="42" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="160" y="202" text-anchor="middle" fill="#1e293b">i3 (-3) pop</text>
  <rect x="230" y="176" width="90" height="42" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="275" y="202" text-anchor="middle" fill="#1e293b" font-weight="700">i4 (5) front</text>
  <line x1="216" y1="197" x2="228" y2="197" stroke="#475569" marker-end="url(#ar-41)"/>
  <text x="470" y="192" text-anchor="middle" fill="#059669" font-weight="700">5 pops smaller tails;</text>
  <text x="470" y="210" text-anchor="middle" fill="#059669" font-weight="700">answer = nums[front] = 5</text>
</svg>
```

```text
nums = [4, 1, 5, 2]   k = 2        deque holds INDICES; values shown below

i=0  v=4   back-pops: none        deque=[0]      vals=(4)     window not full
i=1  v=1   4 <= 1? no             deque=[0,1]    vals=(4,1)
           front 0 <= i-k = -1? no             window [4,1] → max = nums[0] = 4
i=2  v=5   pop 1 (1<=5), pop 0 (4<=5)
                                  deque=[2]      vals=(5)
           front 2 <= 0? no                    window [1,5] → max = nums[2] = 5
i=3  v=2   5 <= 2? no             deque=[2,3]    vals=(5,2)
           front 2 <= 1? no                    window [5,2] → max = nums[2] = 5

output = [4, 5, 5]

At i=2 both older candidates die at once — but each was pushed only once,
so the total pop count over the whole array is at most n.
```

### Interview explanation
"The naive solution rescans each window for O(n·k). I can't just keep a running max, because when the maximum itself leaves the window I have no fallback value. So I keep a deque of candidate **indices** whose values are strictly decreasing. When a new value arrives I pop from the back every index whose value is `<=` it — those are smaller *and* expire earlier, so they can never be the max again. Then I pop the front if it has slid out of the window. The front is always the current window's maximum in O(1). Each index is pushed once and popped once, so it's O(n) time and O(k) space — better than the O(n log n) heap-with-lazy-deletion alternative."

---

## 5. Generic Templates

> Wrap the deque in a tiny "window max oracle": `Push` the newest value, `Max` answers for the last `k` pushes in O(1). DP loops read it before pushing.

```go
// WindowMax answers "maximum of the last k pushed values" in O(1) amortised.
// Push after computing a value, Max before — that is exactly the shape of
// dp[i] = f(nums[i]) + max(dp[i-k .. i-1]).
type WindowMax struct {
	k     int
	vals  []int // every value pushed, in push order
	deque []int // indices into vals; vals[deque] strictly decreasing
}

func NewWindowMax(k int) *WindowMax { return &WindowMax{k: k} }

func (w *WindowMax) Push(v int) {
	i := len(w.vals)
	w.vals = append(w.vals, v)
	// dominated: smaller value AND expires earlier -> can never be the max
	for len(w.deque) > 0 && w.vals[w.deque[len(w.deque)-1]] <= v {
		w.deque = w.deque[:len(w.deque)-1]
	}
	w.deque = append(w.deque, i)
	if w.deque[0] <= i-w.k { // front slid out of the window
		w.deque = w.deque[1:]
	}
}

// Empty reports whether nothing has been pushed yet.
func (w *WindowMax) Empty() bool { return len(w.deque) == 0 }

// Max is the maximum of the last k pushed values. Panics if Empty.
func (w *WindowMax) Max() int { return w.vals[w.deque[0]] }
```

```python
from collections import deque


class WindowMax:
    """Maximum of the last k pushed values, O(1) amortised per push."""

    def __init__(self, k):
        self.k = k
        self.vals = []
        self.dq = deque()                 # indices into vals, values decreasing

    def push(self, v):
        i = len(self.vals)
        self.vals.append(v)
        while self.dq and self.vals[self.dq[-1]] <= v:
            self.dq.pop()                 # dominated: smaller and expires earlier
        self.dq.append(i)
        if self.dq[0] <= i - self.k:      # front slid out of the window
            self.dq.popleft()

    def empty(self):
        return not self.dq

    def max(self):
        return self.vals[self.dq[0]]
```

```java
// Maximum of the last k pushed values, O(1) amortised per push.
class WindowMax {
    private final int k;
    private final List<Integer> vals = new ArrayList<>();
    private final Deque<Integer> dq = new ArrayDeque<>();  // indices, values decreasing

    WindowMax(int k) { this.k = k; }

    void push(int v) {
        int i = vals.size();
        vals.add(v);
        while (!dq.isEmpty() && vals.get(dq.peekLast()) <= v) dq.pollLast();
        dq.offerLast(i);
        if (dq.peekFirst() <= i - k) dq.pollFirst();   // expired
    }

    boolean empty() { return dq.isEmpty(); }

    int max() { return vals.get(dq.peekFirst()); }
}
```

```cpp
// Maximum of the last k pushed values, O(1) amortised per push.
class WindowMax {
    int k;
    vector<int> vals;
    deque<int> dq;                         // indices into vals, values decreasing
public:
    explicit WindowMax(int k) : k(k) {}

    void push(int v) {
        int i = (int)vals.size();
        vals.push_back(v);
        while (!dq.empty() && vals[dq.back()] <= v) dq.pop_back();
        dq.push_back(i);
        if (dq.front() <= i - k) dq.pop_front();       // expired
    }

    bool empty() const { return dq.empty(); }

    int max() const { return vals[dq.front()]; }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Sliding Window Maximum (Optimal) |
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
A window of size `k` slides across `nums` from left to right, one position at a time. Return an array containing the maximum value in each window position.

### Thought Process
1. Rescanning every window is O(n·k), and a single running max breaks the moment the max leaves.
2. Keep a deque of **indices** whose values strictly decrease front → back.
3. Before pushing `i`, pop every back index with `nums[back] <= nums[i]` — dominated in value *and* in lifetime.
4. After pushing, pop the front if `front <= i - k`, because it has slid out of the window.
5. Once `i >= k-1` a full window exists, so emit `nums[front]`.

### Dry Run

Input: `nums = [1,3,-1,-3,5,3,6,7]`, `k = 3`

| i | v | back-pops | deque (indices) | values | front expired (`front <= i-3`)? | emit |
|---|----|-----------|-----------------|--------|----------------------------------|------|
| 0 | 1 | — | `[0]` | `(1)` | `0 <= -3`? no | — |
| 1 | 3 | pop 0 (`1<=3`) | `[1]` | `(3)` | `1 <= -2`? no | — |
| 2 | -1 | none | `[1,2]` | `(3,-1)` | `1 <= -1`? no | **3** |
| 3 | -3 | none | `[1,2,3]` | `(3,-1,-3)` | `1 <= 0`? no | **3** |
| 4 | 5 | pop 3, 2, 1 | `[4]` | `(5)` | `4 <= 1`? no | **5** |
| 5 | 3 | none | `[4,5]` | `(5,3)` | `4 <= 2`? no | **5** |
| 6 | 6 | pop 5, 4 | `[6]` | `(6)` | `6 <= 3`? no | **6** |
| 7 | 7 | pop 6 | `[7]` | `(7)` | `7 <= 4`? no | **7** |

Output: **`[3,3,5,5,6,7]`**

Rows `i=4` and `i=6` show the amortisation: three pops then two pops, but every index popped had been pushed exactly once — total pops over the run is 7, not 7×3. Row `i=3` shows the other rule doing nothing: index 1 is `> i-k = 0`, so the max stays index 1 even though two newer elements arrived.

### Visualization

```text
nums:  1    3   -1   -3    5    3    6    7
idx :  0    1    2    3    4    5    6    7

              [ 1  3 -1 ]                    front→ 3
                 [ 3 -1 -3 ]                 front→ 3
                    [-1 -3  5 ]              front→ 5
                        [-3  5  3 ]          front→ 5
                            [ 5  3  6 ]      front→ 6
                               [ 3  6  7 ]   front→ 7

deque values are ALWAYS decreasing front → back:

  i=3   deque = [1, 2, 3]      values  3 > -1 > -3
  i=4   arriving 5 sweeps all three away, since 3, -1, -3 are all <= 5
        deque = [4]            values  5
```

### Code

```go
// maxSlidingWindow returns the maximum of each k-sized window of nums.
func maxSlidingWindow(nums []int, k int) []int {
	if k <= 0 || len(nums) < k {
		return nil
	}
	deque := make([]int, 0, len(nums)) // indices; nums[deque] strictly decreasing
	out := make([]int, 0, len(nums)-k+1)
	for i, v := range nums {
		for len(deque) > 0 && nums[deque[len(deque)-1]] <= v {
			deque = deque[:len(deque)-1] // dominated: smaller and expires earlier
		}
		deque = append(deque, i)
		if deque[0] <= i-k {
			deque = deque[1:] // front slid out of the window
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


def max_sliding_window(nums, k):
    if k <= 0 or len(nums) < k:
        return []
    dq, out = deque(), []                    # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] <= v:
            dq.pop()                         # dominated: smaller and expires earlier
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()                     # front slid out of the window
        if i >= k - 1:
            out.append(nums[dq[0]])
    return out
```

### Complexity
Time O(n) — each index is appended once and removed at most once, so the inner loop does ≤ n pops in total. Space O(k) — the deque holds at most one window of indices (output not counted).

## 10. Solved Example 2

### Problem — Jump VI (LeetCode 1696)
You start at index `0` of `nums` and repeatedly jump forward between `1` and `k` steps until you reach the last index. Your score is the sum of the values you land on. Return the maximum score.

### Thought Process
1. Let `dp[i]` = the best score achievable when standing on index `i`. Then `dp[i] = nums[i] + max(dp[i-k .. i-1])`, because you must have jumped here from somewhere in the previous `k` indices.
2. Base case `dp[0] = nums[0]` — you start there for free.
3. Computing `max(dp[i-k .. i-1])` by scanning is O(n·k). But it is literally a sliding window maximum over the `dp` array.
4. Keep a deque of indices with decreasing `dp`. Read the front **before** computing `dp[i]`; push `i` **after**.
5. Evict the front while `front < i - k`, so the deque only holds legal predecessors. The answer is `dp[n-1]`.

### Dry Run

Input: `nums = [1,-1,-2,4,-7,3]`, `k = 2`

| i | evict front (`front < i-2`) | deque before read | best = dp[front] | dp[i] = nums[i] + best | back-pops (`dp[back] <= dp[i]`) | deque after |
|---|------------------------------|-------------------|------------------|------------------------|----------------------------------|-------------|
| 0 | — (base case) | — | — | `dp[0] = 1` | — | `[0]` |
| 1 | `0 < -1`? no | `[0]` | `dp[0] = 1` | `-1 + 1 = 0` | `dp[0]=1 <= 0`? no | `[0,1]` |
| 2 | `0 < 0`? no | `[0,1]` | `dp[0] = 1` | `-2 + 1 = -1` | `dp[1]=0 <= -1`? no | `[0,1,2]` |
| 3 | `0 < 1`? **yes**, pop | `[1,2]` | `dp[1] = 0` | `4 + 0 = 4` | pop 2 (`-1<=4`), pop 1 (`0<=4`) | `[3]` |
| 4 | `3 < 2`? no | `[3]` | `dp[3] = 4` | `-7 + 4 = -3` | `dp[3]=4 <= -3`? no | `[3,4]` |
| 5 | `3 < 3`? no | `[3,4]` | `dp[3] = 4` | `3 + 4 = 7` | — | `[3,5]` |

Output: **`7`** (jump 0 → 1 → 3 → 5, scoring `1 + (-1) + 4 + 3 = 7`)

Row `i=3` is the one to stare at: index 0 held the best `dp` so far (`1`), but it is now more than `k = 2` steps back, so it is *illegal*, not merely worse. That front eviction is what makes `dp[3]` build on `dp[1] = 0` instead of `dp[0] = 1`.

### Visualization

```text
nums:   1   -1   -2    4   -7    3
dp  :   1    0   -1    4   -3    7
idx :   0    1    2    3    4    5

legal predecessors of i are the k = 2 indices just before it:

  i=3 :        [1, 2]           max dp = dp[1] = 0   → dp[3] = 4 + 0 = 4
  i=5 :                 [3, 4]  max dp = dp[3] = 4   → dp[5] = 3 + 4 = 7
                         ^
                         deque front — index 4 sits behind it because
                         dp[4] = -3 <= dp[3] = 4, so it is dominated

answer = dp[5] = 7
```

### Code

```go
// maxResult returns the best score reachable at the last index when each jump
// advances between 1 and k positions.
func maxResult(nums []int, k int) int {
	n := len(nums)
	dp := make([]int, n)
	dp[0] = nums[0]
	deque := []int{0} // indices with decreasing dp values
	for i := 1; i < n; i++ {
		for deque[0] < i-k { // predecessor is out of jump range
			deque = deque[1:]
		}
		dp[i] = nums[i] + dp[deque[0]] // best legal predecessor
		for len(deque) > 0 && dp[deque[len(deque)-1]] <= dp[i] {
			deque = deque[:len(deque)-1] // dominated predecessor
		}
		deque = append(deque, i)
	}
	return dp[n-1]
}
```

```python
from collections import deque


def max_result(nums, k):
    n = len(nums)
    dp = [0] * n
    dp[0] = nums[0]
    dq = deque([0])                      # indices with decreasing dp values
    for i in range(1, n):
        while dq[0] < i - k:             # predecessor out of jump range
            dq.popleft()
        dp[i] = nums[i] + dp[dq[0]]      # best legal predecessor
        while dq and dp[dq[-1]] <= dp[i]:
            dq.pop()                     # dominated predecessor
        dq.append(i)
    return dp[-1]
```

### Complexity
Time O(n) — one pass, with each index pushed and popped from the deque at most once. Space O(n) for the `dp` array; the deque itself never exceeds `k+1` entries.

## 11. Solved Example 3

### Problem — Constrained Subseq (LeetCode 1425)
Pick a non-empty subsequence of `nums` in which every two consecutive chosen indices are at most `k` apart. Return the maximum possible sum of such a subsequence.

### Thought Process
1. Let `dp[i]` = the best sum of a valid subsequence that **ends at index `i`**. The answer is `max(dp)` over all `i`, since the subsequence may end anywhere.
2. Recurrence: `dp[i] = nums[i] + max(0, max(dp[i-k .. i-1]))`. The inner `max(0, ...)` says "or start a brand-new subsequence at `i`" — never extend a negative prefix.
3. Base: `dp[0] = nums[0]` (the window `dp[-k..-1]` is empty, so the inner max is 0).
4. `max(dp[i-k .. i-1])` is again a sliding window maximum — deque of indices with decreasing `dp`, front evicted while `front < i - k`.
5. Unlike Jump VI, track a running `answer` as you go instead of reading `dp[n-1]`.

### Dry Run

Input: `nums = [10,2,-10,5,20]`, `k = 2`

| i | evict front (`front < i-2`) | deque | best = `max(0, dp[front])` | dp[i] | back-pops | deque after | answer |
|---|------------------------------|-------|-----------------------------|-------|-----------|-------------|--------|
| 0 | deque empty → best 0 | `[]` | `0` | `10 + 0 = 10` | — | `[0]` | 10 |
| 1 | `0 < -1`? no | `[0]` | `max(0, 10) = 10` | `2 + 10 = 12` | pop 0 (`10<=12`) | `[1]` | 12 |
| 2 | `1 < 0`? no | `[1]` | `max(0, 12) = 12` | `-10 + 12 = 2` | `dp[1]=12 <= 2`? no | `[1,2]` | 12 |
| 3 | `1 < 1`? no | `[1,2]` | `max(0, 12) = 12` | `5 + 12 = 17` | pop 2 (`2<=17`), pop 1 (`12<=17`) | `[3]` | 17 |
| 4 | `3 < 2`? no | `[3]` | `max(0, 17) = 17` | `20 + 17 = 37` | — | `[3,4]` | **37** |

Output: **`37`** (the subsequence `10, 2, 5, 20` — index gaps 1, 2, 1, all ≤ `k`)

Row `i=2` is the interesting one: `dp[2] = 2` is worse than `dp[1] = 12`, but index 2 still enters the deque, because once index 1 expires it may become the best *legal* predecessor. Domination is only allowed to remove entries that are worse **and** expire no later.

### Visualization

```text
nums:  10    2  -10    5   20
dp  :  10   12    2   17   37
idx :   0    1    2    3    4

i=3, k=2 → legal predecessors are indices [1, 2]

   dp:      12    2
   deque:  [1,   2]        12 > 2, decreasing ✓
            ^ front → best predecessor = 12
   dp[3] = 5 + max(0, 12) = 17
   17 beats both, so both are popped from the back →  deque = [3]

why max(0, ...)?  if the best predecessor's dp were negative, extending it
would only hurt; starting fresh at i gives dp[i] = nums[i].

answer = max over all dp = 37
```

### Code

```go
// constrainedSubsetSum returns the largest sum of a subsequence in which
// consecutive chosen indices are at most k apart.
func constrainedSubsetSum(nums []int, k int) int {
	n := len(nums)
	dp := make([]int, n)
	deque := make([]int, 0, n) // indices with decreasing dp values
	answer := nums[0]
	for i := 0; i < n; i++ {
		for len(deque) > 0 && deque[0] < i-k {
			deque = deque[1:] // predecessor too far back to be legal
		}
		bestPrev := 0 // 0 means "start a fresh subsequence at i"
		if len(deque) > 0 && dp[deque[0]] > 0 {
			bestPrev = dp[deque[0]]
		}
		dp[i] = nums[i] + bestPrev
		if dp[i] > answer {
			answer = dp[i]
		}
		for len(deque) > 0 && dp[deque[len(deque)-1]] <= dp[i] {
			deque = deque[:len(deque)-1] // dominated predecessor
		}
		deque = append(deque, i)
	}
	return answer
}
```

```python
from collections import deque


def constrained_subset_sum(nums, k):
    n = len(nums)
    dp = [0] * n
    dq = deque()                              # indices with decreasing dp values
    answer = nums[0]
    for i in range(n):
        while dq and dq[0] < i - k:
            dq.popleft()                      # predecessor too far back
        best_prev = dp[dq[0]] if dq else 0
        dp[i] = nums[i] + max(0, best_prev)   # 0 -> start fresh at i
        answer = max(answer, dp[i])
        while dq and dp[dq[-1]] <= dp[i]:
            dq.pop()                          # dominated predecessor
        dq.append(i)
    return answer
```

### Complexity
Time O(n) — one pass; every index enters and leaves the deque at most once. Space O(n) for `dp`; the deque holds at most `k+1` indices.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 239 | Sliding Window Max | Easy | Core queues application |
| 1696 | Jump VI | Easy | Core queues application |
| 1425 | Constrained Subseq | Medium | Core queues application |
| 862 | Shortest Subarray | Medium | Core queues application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Sliding Window Maximum logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Sliding Window Maximum (Queues).
- **Signal:** sliding window maximum, deque, monotonic, window, max.
- **Move:** A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Sliding Window Maximum invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Sliding Window Maximum
FAMILY : Queues (Advanced)
WHEN   : sliding window maximum, deque, monotonic, window, max
DO     : A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand fro
TIME   : O(n)    SPACE: O(k)
PRACTICE: 239, 1696, 1425, 862
```

---

*Part of the DSA Patterns Handbook — pattern 41 of 100.*
