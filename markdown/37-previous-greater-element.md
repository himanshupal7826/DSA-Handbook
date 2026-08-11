# 37 · Previous Greater Element

> **One-liner:** Stack scan to find each element's previous greater neighbor / span.

---

## 1. Overview

### Definition
The **Previous Greater Element** pattern belongs to the *Stacks* family. Stack scan to find each element's previous greater neighbor / span.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
previous greater, monotonic stack, to the left, span.

### Constraints
- Input size where the brute-force complexity would time out — the Previous Greater Element optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Previous Greater Element invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Previous Greater Element is the upgrade.
- The wording maps onto: previous greater, monotonic stack, to the left, span.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"For each element, what is the nearest element to its **left** that is greater — and how far back is it?"*

Running example: `nums = [5, 2, 3, 7, 1]`. The previous-greater values are
`[-1, 5, 5, -1, 7]`, and the distances back to them give the *span* of each element.

### Intuition
Stand on each element and walk **backwards** until you meet something bigger. That element
is the answer, and the number of steps you took is the span. Walk off the front of the
array and there is no answer.

### Algorithm
1. For each index `i` from `0` to `n-1`:
2. Walk `j = i-1, i-2, …` to the left.
3. The first `j` with `nums[j] > nums[i]` is the answer — record it and stop.
4. If the walk runs off the front, record "none" (span = `i + 1`).
5. Return the array of answers.

### Complexity
- Time: **O(n²)** — an ascending array is worst: from index `i` you step over every one of
  the `i` smaller elements before falling off the front. `[1, 2, 3, 4, 5]` costs
  1 + 2 + 3 + 4 = 10 steps to produce five "none"s.
- Space: O(1) beyond the output.

### Drawbacks
- **The exact wasted work.** On `[5, 2, 3, 7, 1]` the walk from `i=2` (value 3) steps over
  index 1 (value 2) and stops at index 0 (value 5). It has just re-walked exactly the
  ground that `i=1`'s own walk covered a moment earlier, and it learned nothing new about
  index 1 — the `2` is *never* going to be anybody's answer again, yet every later walk
  keeps tripping over it.
- **The fact it never exploits.** Once index 2 exists, index 1 is worthless as a candidate:
  it is further away *and* smaller. Any element that index 1 could have answered is answered
  by index 2 first. The brute force re-examines dead candidates forever; the optimal
  approach deletes them.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Keep only the elements that could still be somebody's answer: as soon as a new element is at least as large as an older one on its left, that older one is dead — nearer and bigger always wins — so pop it and never look at it again.**

Think of standing in a queue and looking **back** for the first person taller than you. If
someone tall is standing behind a shorter person, the shorter person is invisible to
everyone in front: they will always see the tall one first. So the only people worth
remembering are those forming a descending wall of heights from the start of the queue up
to where you stand. That wall is the monotonic decreasing stack, and its **top** is your
answer.

### The thought process

```text
We need    : for each i, the nearest element to the LEFT that is greater
Obvious way: walk backwards from every i
Too slow   : O(n^2) — every ascending run is re-walked from every later start
Notice     : if j < i and nums[j] <= nums[i], then j can never be the answer for any
             k > i: i is closer to k and at least as big, so k would pick i first
Therefore  : maintain only the surviving candidates; they always decrease left to
             right, and the answer for i is simply the closest survivor still standing
Now        : each index enters once and leaves once → O(n), and the answer is a
             single peek instead of a walk
```

### Why "read the surviving top" works

Everything hangs on one claim, so prove it before reaching for a data structure.

**Claim.** If `j < i` and `nums[j] <= nums[i]`, then `j` is not the previous-greater answer
for any index `k > i`.
**Proof.** Suppose `nums[j] > nums[k]`. Then `nums[i] >= nums[j] > nums[k]` too, and `i` is
nearer to `k` than `j` is. So `k`'s *nearest* greater element on the left is `i` or something
even closer — never `j`. `j` is dead. ∎

That single claim gives everything:

1. **The survivors decrease.** Every surviving candidate is strictly greater than the one to
   its right, or it would have been popped.
2. **The nearest survivor is the answer.** Everything popped between the top and `i` was
   `<= nums[i]` and therefore not a valid answer anyway; the first survivor is by definition
   both greater and the closest such element.
3. **The access pattern is a stack.** New candidates arrive at the right end and dead ones
   are removed from the right end. Newest-in, newest-out.

**Two knobs, and they overlap.** *Which reading* you take (the pop, or the surviving top)
flips next ↔ previous; so does *which way you scan*. They give the same answers, so pick
whichever is more comfortable:

```text
previous greater  =  scan left → right, read the surviving TOP before pushing i
next greater      =  scan right → left, read the surviving TOP before pushing i
next greater      =  scan left → right, read the POP (chapter 36)
```

Example 2 below deliberately solves "daily temperatures" — a *next*-greater problem — by
scanning right to left with this chapter's previous-greater code, to make the equivalence
concrete.

**Store indices, not values.** This chapter is the clearest case: the *value* of the
previous greater element is rarely the deliverable. Stock span wants `i - prevGreaterIndex`,
histogram width wants `right - left - 1`. You cannot subtract values to get a distance.
Push `i`, read `nums[stack[top]]` when you need the value.

### The direction table (identical in every chapter of this family)

| You want, for each `i` … | Scan | Stack values | Pop while | Read the answer from |
|---|---|---|---|---|
| **next greater** to the right | left → right | **decreasing** | `nums[top] <= nums[i]` | the pop — `i` is the popped index's answer |
| **previous greater** to the left | left → right | **decreasing** | `nums[top] <= nums[i]` | what is left on top *before* pushing `i` |
| **next smaller** to the right | left → right | increasing | `nums[top] >= nums[i]` | the pop — `i` is the popped index's answer |
| **previous smaller** to the left | left → right | increasing | `nums[top] >= nums[i]` | what is left on top *before* pushing `i` |

The four rows are really **two passes**: rows 1–2 are one decreasing-stack pass read in two
ways, rows 3–4 one increasing-stack pass read in two ways. This chapter is row 2.

**Duplicates — where the strictness goes.** In one pass the two readings get opposite
strictness, and you cannot have both strict:

```text
pop while nums[top] <  nums[i]  →  top gives "previous greater-or-equal",
                                   pop gives "next strictly greater"
pop while nums[top] <= nums[i]  →  top gives "previous strictly greater",
                                   pop gives "next greater-or-equal"
```

Stock span counts consecutive days with price *less than or equal to* today, which is
"previous strictly greater" — so it pops with `<=`. Get this backwards and every run of
equal prices reports a span of 1.

### Steps

```text
Step 1 → stack = empty list of INDICES; prev[i] = -1 for all i
Step 2 → for i = 0 … n-1:
Step 3 →   while stack is non-empty and nums[stack.top] <= nums[i]:
Step 4 →       pop            (that candidate is dead: nearer-and-bigger exists)
Step 5 →   prev[i] = stack.top if stack is non-empty else -1
Step 6 →   span[i] = i - prev[i]        (works even when prev[i] = -1 → i+1)
Step 7 →   push i              (i is now the newest live candidate)
```

### How should I recognize this?

```text
If you see...
  "previous greater", "nearest larger on the left", "span", "consecutive days
  up to today", "how far back until a bigger value", "left boundary of a rectangle",
  n up to 1e5 with an obvious backwards scan per element
        ↓
Think about...
  "Which earlier elements can still be somebody's answer, and which are shadowed
   by a nearer, bigger one?"
        ↓
Use...
  A decreasing stack of indices, popping while top <= current, then PEEK.
    want the value    → nums[stack.top]
    want the span     → i - stack.top   (i + 1 when the stack is empty)
    want previous smaller → increasing stack, pop while top >= current (chapter 34)
    want NEXT instead → same code scanned right to left  (chapter 36)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-37" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Previous greater: pop tops ≤ current, remaining top is the answer</text>
  <text x="130" y="52" text-anchor="middle" fill="#64748b">nums (scan →)</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="148" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">3</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="88" text-anchor="middle" fill="#1e293b">7</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="88" text-anchor="middle" fill="#1e293b">1</text>
  <text x="148" y="122" text-anchor="middle" fill="#059669" font-weight="700">current 3</text>
  <text x="490" y="52" text-anchor="middle" fill="#64748b">stack (bottom → top)</text>
  <rect x="452" y="112" width="76" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="490" y="134" text-anchor="middle" fill="#1e293b">5  answer</text>
  <rect x="452" y="74"  width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="96"  text-anchor="middle" fill="#1e293b">2  pop</text>
  <line x1="174" y1="82" x2="448" y2="128" stroke="#475569" marker-end="url(#ar-37)"/>
  <text x="330" y="150" text-anchor="middle" fill="#d97706">pop 2 (≤ 3); top 5 &gt; 3 → prev greater = 5</text>
  <text x="130" y="186" text-anchor="middle" fill="#64748b">result (previous greater)</text>
  <rect x="30"  y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="222" text-anchor="middle" fill="#64748b">-1</text>
  <rect x="78"  y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="100" y="222" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="126" y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="148" y="222" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="174" y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="222" text-anchor="middle" fill="#64748b">-1</text>
  <rect x="222" y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="244" y="222" text-anchor="middle" fill="#1e293b">7</text>
</svg>
```

```text
nums  =   5    2    3    7    1
index     0    1    2    3    4

i=0 v=5  stack empty                     prev[0] = none   push 0 → stack(vals) [5]
i=1 v=2  5 <= 2? no                      prev[1] = 5      push 1 → [5,2]
i=2 v=3  2 <= 3 → pop 1 (2 is shadowed by 3: nearer AND bigger)
         5 <= 3? no                      prev[2] = 5      push 2 → [5,3]
i=3 v=7  3 <= 7 → pop 2
         5 <= 7 → pop 0
         stack empty                     prev[3] = none   push 3 → [7]
i=4 v=1  7 <= 1? no                      prev[4] = 7      push 4 → [7,1]

previous greater : [ --,  5,  5, --,  7 ]     (values; -- = none)
span  = i - prev : [  1,  1,  2,  4,  1 ]     (index distance; i+1 when none)
```

The stack is always a descending wall — `[5,2]`, `[5,3]`, `[7]`, `[7,1]` — and the answer is
always the very next brick in that wall.

### Interview explanation
"For each element I want the nearest bigger element to its left. Instead of walking
backwards each time, I keep a stack of the only candidates that can still matter. The
argument is: if an earlier element is smaller than a later one, it is shadowed forever —
anything that would have picked it will meet the later, bigger element first. So I pop every
stack entry `<=` the current value, and whatever survives on top *is* the previous greater
element; then I push the current index. The stack is always decreasing, each index is pushed
and popped once, so it's O(n) time and O(n) space. I store indices rather than values
because the usual deliverable is a distance — the stock span is just `i` minus the surviving
top."

---

## 5. Generic Templates

> **Pop the shadowed candidates, then peek: the survivor on top is the previous greater element, and `i - top` is the span.**

```go
// previousGreater returns, for every i, the index of the nearest strictly greater
// element to the left (-1 when there is none), plus the span i - prev[i], which is
// the count of consecutive elements ending at i that are <= nums[i].
func previousGreater(nums []int) (prev, span []int) {
	n := len(nums)
	prev, span = make([]int, n), make([]int, n)
	stack := make([]int, 0, n) // indices; values decrease bottom → top
	for i := 0; i < n; i++ {
		// Anything no larger than nums[i] is shadowed by i and can never answer again.
		for len(stack) > 0 && nums[stack[len(stack)-1]] <= nums[i] {
			stack = stack[:len(stack)-1]
		}
		prev[i] = -1
		if len(stack) > 0 {
			prev[i] = stack[len(stack)-1]
		}
		span[i] = i - prev[i] // prev[i] == -1 gives the full prefix, i+1
		stack = append(stack, i)
	}
	return prev, span
}
```

```python
def previous_greater(nums):
    """prev[i] = index of nearest strictly greater element on the left (-1 if none),
       span[i] = i - prev[i] = run of elements <= nums[i] ending at i."""
    n = len(nums)
    prev, span = [-1] * n, [0] * n
    stack = []                                  # indices, values decreasing
    for i in range(n):
        while stack and nums[stack[-1]] <= nums[i]:
            stack.pop()                         # shadowed: nearer and bigger exists
        prev[i] = stack[-1] if stack else -1
        span[i] = i - prev[i]
        stack.append(i)
    return prev, span
```

```java
// prev[i] = nearest strictly greater index on the left (-1), span[i] = i - prev[i].
int[][] previousGreater(int[] nums) {
    int n = nums.length;
    int[] prev = new int[n], span = new int[n];
    Deque<Integer> stack = new ArrayDeque<>();  // indices, values decreasing
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] <= nums[i]) stack.pop();
        prev[i] = stack.isEmpty() ? -1 : stack.peek();
        span[i] = i - prev[i];
        stack.push(i);
    }
    return new int[][]{prev, span};
}
```

```cpp
// prev[i] = nearest strictly greater index on the left (-1), span[i] = i - prev[i].
pair<vector<int>, vector<int>> previousGreater(const vector<int>& nums) {
    int n = nums.size();
    vector<int> prev(n, -1), span(n, 0), stack;  // stack holds indices
    for (int i = 0; i < n; ++i) {
        while (!stack.empty() && nums[stack.back()] <= nums[i]) stack.pop_back();
        prev[i] = stack.empty() ? -1 : stack.back();
        span[i] = i - prev[i];
        stack.push_back(i);
    }
    return {prev, span};
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Previous Greater Element (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(n)** |

> Each index pushed/popped once; stack holds unresolved indices.

---

## 7. Common Mistakes

1. Storing values instead of indices when you need positions/distances.
2. Wrong monotonic direction (increasing vs decreasing) for the query.
3. Using `<` vs `<=` incorrectly with duplicates.
4. Forgetting to handle elements left on the stack at the end.
5. Not iterating in reverse when the problem is naturally right-to-left.
6. Circular array: forgetting to loop twice with modulo indexing.
7. Histogram: missing the sentinel zero-height bar to flush the stack.
8. Popping in the wrong order, corrupting results.
9. Mixing up 'greater' and 'smaller' semantics.
10. O(n^2) blowup by rescanning instead of trusting the stack invariant.

---

## 8. Interview Follow-Up Questions

1. **Q: Increasing vs decreasing stack — which?**
   A: Decreasing stack finds next greater; increasing finds next smaller.

2. **Q: Why amortized O(n)?**
   A: Each index is pushed once and popped at most once.

3. **Q: Previous greater element?**
   A: Same stack, but resolve as you push / scan the other direction.

4. **Q: Circular next greater?**
   A: Iterate 2n with modulo, don't push twice.

5. **Q: Largest rectangle in histogram?**
   A: Monotonic increasing stack of bar indices.

6. **Q: Daily temperatures?**
   A: Stack of unresolved days; pop when a warmer day arrives.

7. **Q: Stock span?**
   A: Previous greater index gives the span length.

8. **Q: Trapping rain water?**
   A: Stack or two-pointer; stack resolves bounded basins.

9. **Q: Handle ties?**
   A: Decide `<` vs `<=` based on whether equal counts as greater.

10. **Q: Space complexity?**
   A: O(n) worst case (monotonic input).

11. **Q: Maximal rectangle in matrix?**
   A: Histogram per row + stack.

12. **Q: Sum of subarray minimums?**
   A: Monotonic stack to count contribution of each element.

13. **Q: Why store indices?**
   A: To compute distances/widths between boundaries.

14. **Q: Sentinel trick?**
   A: Append a 0 (or +/-inf) to force final pops.

15. **Q: Relation to monotonic queue?**
   A: Queue variant supports sliding-window min/max.

---

## 9. Solved Example 1

### Problem — Stock Span (LeetCode 901)
Prices stream in one per day. For each new price, return its **span**: the number of
consecutive days ending today whose price was less than or equal to today's.

### Thought Process
1. The span stops at the first earlier day whose price is **strictly greater** than today's
   — that is exactly the previous-greater query, so `span = i - prevGreaterIndex`.
2. When the stack is empty there is no bigger day at all, and the span is the whole prefix
   `i + 1`. Writing `prev = -1` makes `i - prev` produce that automatically.
3. Pop with `<=`: a day with the *same* price is inside the span, not a boundary.
4. Popped days are gone for good — a nearer, bigger day shadows them — so the streaming
   version needs no history beyond the stack itself.

### Dry Run

Input: prices arriving as `100, 80, 60, 70, 60, 75, 85`

| i | price | pops (indices, all `<= price`) | surviving top | span = `i - top` | stack after |
|---|---|---|---|---|---|
| 0 | 100 | — | none (−1) | `0-(-1) = 1` | `[0]` |
| 1 | 80 | — (`100 > 80`) | 0 | `1-0 = 1` | `[0,1]` |
| 2 | 60 | — (`80 > 60`) | 1 | `2-1 = 1` | `[0,1,2]` |
| 3 | 70 | `2` (60) | 1 | `3-1 = 2` | `[0,1,3]` |
| 4 | 60 | — (`70 > 60`) | 3 | `4-3 = 1` | `[0,1,3,4]` |
| 5 | 75 | `4` (60), `3` (70) | 1 | `5-1 = 4` | `[0,1,5]` |
| 6 | 85 | `5` (75), `1` (80) | 0 | `6-0 = 6` | `[0,6]` |

Output: **`[1, 1, 1, 2, 1, 4, 6]`**

Row `i=5` is the pattern's whole economy: two dead days are discarded in one burst, and the
answer is then a single peek — no backwards walk over days 4, 3, 2. Row `i=6` shows why
those days never needed to be revisited: the 75 and 80 were shadowed, and only the 100 was
still standing.

### Visualization

```text
day     0     1     2     3     4     5     6
price  100    80    60    70    60    75    85
        │     │           │           │     │
        └─────┴───── the descending "wall" of live candidates ─────┘

stack prices (bottom → top), always decreasing:
  [100] [100,80] [100,80,60] [100,80,70] [100,80,70,60] [100,80,75] [100,85]

span   1     1     1     2     1     4     6
                                     ↑
                        5 - 1 = 4 : days 2,3,4,5 all ≤ 75
```

### Code

```go
// StockSpanner answers span queries on a streaming price series.
type StockSpanner struct {
	prices []int // every price seen, in arrival order
	stack  []int // indices of live candidates; prices decrease bottom → top
}

func NewStockSpanner() *StockSpanner { return &StockSpanner{} }

func (s *StockSpanner) Next(price int) int {
	i := len(s.prices)
	s.prices = append(s.prices, price)
	// Days no more expensive than today are shadowed by today, forever.
	for len(s.stack) > 0 && s.prices[s.stack[len(s.stack)-1]] <= price {
		s.stack = s.stack[:len(s.stack)-1]
	}
	prev := -1
	if len(s.stack) > 0 {
		prev = s.stack[len(s.stack)-1] // nearest strictly greater day
	}
	s.stack = append(s.stack, i)
	return i - prev // prev == -1 → the whole prefix, i+1
}
```

```python
class StockSpanner:
    def __init__(self):
        self.prices = []
        self.stack = []                         # indices, prices decreasing

    def next(self, price):
        i = len(self.prices)
        self.prices.append(price)
        while self.stack and self.prices[self.stack[-1]] <= price:
            self.stack.pop()                    # shadowed by today
        prev = self.stack[-1] if self.stack else -1
        self.stack.append(i)
        return i - prev                         # prev == -1 → i + 1
```

### Complexity
Time O(1) **amortized** per call — across `n` calls there are `n` pushes and at most `n`
pops, so O(n) total. Space O(n) for the price log and the stack.

---

## 10. Solved Example 2

### Problem — Daily Temps (LeetCode 739)
For each day, how many days must you wait for a strictly warmer temperature? Answer 0 if no
warmer day comes.

### Thought Process
1. This asks for the *next* greater element, not the previous one — but flipping the scan
   direction converts one into the other, so the previous-greater code solves it unchanged.
2. Walk the array **right to left**. The stack now holds candidate days that lie to the
   *right* of the current day.
3. Pop every candidate whose temperature is `<= temps[i]`: such a day is shadowed — it is
   further away and not warmer, so it can never be day `i`'s (or any earlier day's) answer.
4. The survivor on top is the nearest warmer day, so `res[i] = top - i`. An empty stack
   means no warmer day exists → 0.

### Dry Run

Input: `[73, 74, 75, 71, 69, 72, 76, 73]`, scanned from the right.

| i | t | pops (indices, temps `<= t`) | surviving top | `res[i]` | stack after (indices) |
|---|----|---|---|---|---|
| 7 | 73 | — | none | 0 | `[7]` |
| 6 | 76 | `7` (73) | none | 0 | `[6]` |
| 5 | 72 | — (`76 > 72`) | 6 | `6-5 = 1` | `[6,5]` |
| 4 | 69 | — (`72 > 69`) | 5 | `5-4 = 1` | `[6,5,4]` |
| 3 | 71 | `4` (69) | 5 | `5-3 = 2` | `[6,5,3]` |
| 2 | 75 | `3` (71), `5` (72) | 6 | `6-2 = 4` | `[6,2]` |
| 1 | 74 | — (`75 > 74`) | 2 | `2-1 = 1` | `[6,2,1]` |
| 0 | 73 | — (`74 > 73`) | 1 | `1-0 = 1` | `[6,2,1,0]` |

Output: **`[1, 1, 4, 2, 1, 1, 0, 0]`**

Row `i=2` is the interesting one: day 2 (75°) skips over days 3, 4 and 5 in a single peek
because all of them had already been shadowed. Compare with chapter 39, which produces the
identical array scanning left to right and reading the *pop* instead of the top.

### Visualization

```text
scan direction:  ◀──────────────────────────────────────────

day     0    1    2    3    4    5    6    7
temp   73   74   75   71   69   72   76   73
        └─1─▶│    └───────4──────────▶│
             └─1─▶│    ┌─2─▶│         │
                       └────┴──1──────┘      (69 → 72 is 1 day)

stack temps at each step (bottom → top, always decreasing):
 [73] [76] [76,72] [76,72,69] [76,72,71] [76,75] [76,75,74] [76,75,74,73]

res =   1    1    4    2    1    1    0    0
```

### Code

```go
func dailyTemperatures(temps []int) []int {
	res := make([]int, len(temps))
	stack := make([]int, 0, len(temps)) // indices to the RIGHT of i; temps decreasing
	for i := len(temps) - 1; i >= 0; i-- {
		// A later day that is not warmer than today is shadowed by today.
		for len(stack) > 0 && temps[stack[len(stack)-1]] <= temps[i] {
			stack = stack[:len(stack)-1]
		}
		if len(stack) > 0 {
			res[i] = stack[len(stack)-1] - i // nearest warmer day, as a distance
		}
		stack = append(stack, i)
	}
	return res // empty stack at step i leaves res[i] = 0
}
```

```python
def dailyTemperatures(temps):
    res = [0] * len(temps)
    stack = []                                  # indices to the right, temps decreasing
    for i in range(len(temps) - 1, -1, -1):
        while stack and temps[stack[-1]] <= temps[i]:
            stack.pop()                         # shadowed by today
        if stack:
            res[i] = stack[-1] - i
        stack.append(i)
    return res
```

### Complexity
Time O(n) — each index is pushed once and popped at most once. Space O(n) for the stack.

---

## 11. Solved Example 3

### Problem — Largest Rectangle (LeetCode 84)
Given bar heights of a histogram (each bar one unit wide), return the area of the largest
rectangle that fits inside it.

### Thought Process
1. Fix the bar that limits the height. A rectangle of height `heights[i]` extends left and
   right until it meets a **strictly shorter** bar.
2. So `left[i]` is the previous strictly smaller bar and `right[i]` is the next strictly
   smaller bar — the *smaller* mirror of this chapter's query (increasing stack, pop while
   `top >= current`).
3. The bars strictly between those two boundaries are all at least `heights[i]` tall, and
   there are `right[i] - left[i] - 1` of them. That is the width.
4. Two passes with the same skeleton — left to right for `left`, right to left for `right` —
   then one sweep taking the best `height × width`.

### Dry Run

Input: `heights = [2, 1, 5, 6, 2]`

Pass 1 (left → right), increasing stack, `left[i]` = previous strictly smaller index:

| i | h | pops | `left[i]` | stack after |
|---|---|---|---|---|
| 0 | 2 | — | −1 | `[0]` |
| 1 | 1 | `0` (2 ≥ 1) | −1 | `[1]` |
| 2 | 5 | — | 1 | `[1,2]` |
| 3 | 6 | — | 2 | `[1,2,3]` |
| 4 | 2 | `3` (6 ≥ 2), `2` (5 ≥ 2) | 1 | `[1,4]` |

Pass 2 (right → left), same rule, `right[i]` = next strictly smaller index (`5` = none):

| i | h | pops | `right[i]` | stack after |
|---|---|---|---|---|
| 4 | 2 | — | 5 | `[4]` |
| 3 | 6 | — | 4 | `[4,3]` |
| 2 | 5 | `3` (6 ≥ 5) | 4 | `[4,2]` |
| 1 | 1 | `2` (5 ≥ 1), `4` (2 ≥ 1) | 5 | `[1]` |
| 0 | 2 | — | 1 | `[1,0]` |

Combine:

| i | height | left | right | width = `right-left-1` | area |
|---|---|---|---|---|---|
| 0 | 2 | −1 | 1 | 1 | 2 |
| 1 | 1 | −1 | 5 | 5 | 5 |
| 2 | 5 | 1 | 4 | 2 | **10** |
| 3 | 6 | 2 | 4 | 1 | 6 |
| 4 | 2 | 1 | 5 | 3 | 6 |

Output: **`10`**

Bar 2 (height 5) reaches from index 2 to index 3 inclusive: `4 - 1 - 1 = 2` bars wide.
Chapter 38 shows how to fuse these two passes into one using a sentinel.

### Visualization

```text
index    0    1    2    3    4
height   2    1    5    6    2
                   █    █
              left │ ██ │ right
              (1)──┼─██─┼──(4)          width = 4 - 1 - 1 = 2, height 5 → area 10  ★
         █         │ ██ │         █
         ██        │ ██ │        ██
        ─────┴─────┴────┴─────────

left  = [-1, -1,  1,  2,  1]     previous strictly smaller index
right = [ 1,  5,  4,  4,  5]     next strictly smaller index (5 = past the end)
```

### Code

```go
func largestRectangleArea(heights []int) int {
	n := len(heights)
	left := make([]int, n)  // previous strictly smaller index, -1 if none
	right := make([]int, n) // next strictly smaller index, n if none
	stack := make([]int, 0, n)

	for i := 0; i < n; i++ { // pass 1: previous smaller
		for len(stack) > 0 && heights[stack[len(stack)-1]] >= heights[i] {
			stack = stack[:len(stack)-1]
		}
		left[i] = -1
		if len(stack) > 0 {
			left[i] = stack[len(stack)-1]
		}
		stack = append(stack, i)
	}

	stack = stack[:0]
	for i := n - 1; i >= 0; i-- { // pass 2: next smaller, same rule mirrored
		for len(stack) > 0 && heights[stack[len(stack)-1]] >= heights[i] {
			stack = stack[:len(stack)-1]
		}
		right[i] = n
		if len(stack) > 0 {
			right[i] = stack[len(stack)-1]
		}
		stack = append(stack, i)
	}

	best := 0
	for i := 0; i < n; i++ {
		if area := heights[i] * (right[i] - left[i] - 1); area > best {
			best = area
		}
	}
	return best
}
```

```python
def largestRectangleArea(heights):
    n = len(heights)
    left, right = [-1] * n, [n] * n
    stack = []
    for i in range(n):                          # pass 1: previous strictly smaller
        while stack and heights[stack[-1]] >= heights[i]:
            stack.pop()
        left[i] = stack[-1] if stack else -1
        stack.append(i)
    stack = []
    for i in range(n - 1, -1, -1):              # pass 2: next strictly smaller
        while stack and heights[stack[-1]] >= heights[i]:
            stack.pop()
        right[i] = stack[-1] if stack else n
        stack.append(i)
    return max((heights[i] * (right[i] - left[i] - 1) for i in range(n)), default=0)
```

### Complexity
Time O(n) — two monotonic passes plus one combining sweep, each index pushed and popped once
per pass. Space O(n) for the two boundary arrays and the stack.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 901 | Stock Span | Easy | Core stacks application |
| 739 | Daily Temps | Easy | Core stacks application |
| 84 | Largest Rectangle | Medium | Core stacks application |
| 496 | Next Greater | Medium | Core stacks application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Monotonic increasing stack**
- **Monotonic decreasing stack**
- **Next/previous greater**
- **Histogram largest rectangle**
- **Stock span / daily temperatures**

---

## 14. Production Engineering Applications

- **Scalability:** Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Previous Greater Element logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Previous Greater Element (Stacks).
- **Signal:** previous greater, monotonic stack, to the left, span.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Previous Greater Element invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Previous Greater Element
FAMILY : Stacks (Intermediate)
WHEN   : previous greater, monotonic stack, to the left, span
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 901, 739, 84, 496
```

---

*Part of the DSA Patterns Handbook — pattern 37 of 100.*
