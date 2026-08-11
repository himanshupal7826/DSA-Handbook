# 35 · Monotonic Decreasing Stack

> **One-liner:** Maintain a decreasing stack to find nearest greater elements.

---

## 1. Overview

### Definition
The **Monotonic Decreasing Stack** pattern belongs to the *Stacks* family. Maintain a decreasing stack to find nearest greater elements.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
monotonic stack, decreasing, next greater, previous greater.

### Constraints
- Input size where the brute-force complexity would time out — the Monotonic Decreasing Stack optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Monotonic Decreasing Stack invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Monotonic Decreasing Stack is the upgrade.
- The wording maps onto: monotonic stack, decreasing, next greater, previous greater.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"For each element, where is the nearest **greater** element — and how far away is it?"*

Running example: `nums = [4, 5, 2, 10, 8]`. For every index, find the nearest strictly
greater element to its **right**.

### Intuition
Stand on each element and walk right until you meet something bigger. Stop there. If you
reach the end without finding anything, there is no answer. Do that for all `n` elements.

### Algorithm
1. For each index `i` from `0` to `n-1`:
2. Walk `j = i+1, i+2, …` to the right.
3. The first `j` with `nums[j] > nums[i]` is the answer — record it and stop.
4. If no such `j` exists, record "none".
5. Return the array of answers.

### Complexity
- Time: **O(n²)** — a descending stretch of the array is re-walked from every start inside
  it. On `[5, 4, 3, 2, 1]` that is 4 + 3 + 2 + 1 = 10 steps to produce five "none"s.
- Space: O(1) beyond the output.

### Drawbacks
- **The exact wasted work.** On `[4, 5, 2, 10, 8]` the scan from `i=1` (value 5) steps over
  index 2 (value 2) and stops at index 3 (value 10). It has just proved that 10 is *also*
  the answer for index 2 — and discards that. The next iteration, `i=2`, walks the same
  ground to rediscover the same 10.
- **The fact it never exploits.** The moment the scan passes an index `j` with
  `nums[j] <= nums[i]`, `j` is beaten on both counts: it is further left and no larger.
  No element to the right of `i` will ever choose `j`. The brute force sees this and shrugs;
  the optimal approach sees it and *deletes* `j`.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **If a later element is at least as large as an earlier one, the earlier one is dead — the newcomer has already answered it and stands nearer to everything on the right, so pop it and never look at it again.**

Picture a row of people each craning to spot the first person **taller** than themselves
further down the line. A tall person walks in and instantly satisfies every shorter person
still waiting — all of them at once — and they leave forever. Whoever is still waiting must
be in **decreasing** order of height: anybody shorter than someone in front of them would
already have gone. That waiting list, shortest at the top, is the monotonic decreasing stack.

### The thought process

```text
We need    : for each i, the nearest strictly greater element to its right
Obvious way: from each i, walk right until something bigger shows up
Too slow   : O(n^2) — every descending run is re-walked from every start inside it
Notice     : if j < i and nums[j] <= nums[i], then j is finished twice over —
             i settles j's "next greater", and no k > i can ever want j as its
             "previous greater" because i is nearer and no smaller
Therefore  : delete j the moment i arrives; the indices still waiting always have
             decreasing values, and the newest one is the smallest
Now        : deletions happen from the newest end → that is a stack, and each index
             is pushed once and popped at most once → O(n) overall
```

### Why the stack (and why it must be decreasing) works

Derive the structure from the *set of unresolved indices* rather than assuming it:

1. **It is always decreasing in value.** If two unresolved indices `j < i` had
   `nums[j] <= nums[i]`, then `i` already settled `j` — contradiction. So the values, read
   left to right, must strictly decrease.
2. **A newcomer resolves it from the newest end backwards.** The newest unresolved index
   holds the smallest value, so a big newcomer knocks out the newest entries first and
   stops the instant it meets something larger than itself. Newest-out-first *is* a stack.

**Why the answer is the *nearest* one.** When `i` pops `j`, could some index `k` between
them have been greater? No: if `nums[k] > nums[j]`, then on arrival `k` would have popped
everything above `j` (all smaller than `nums[j]`) and then `j` itself. So every index
strictly between `j` and `i` had a value `<= nums[j]`, and `i` really is the first greater
one. Tiny counterexample check — on `[2, 2, 3]` with a strict pop (`top < current`), index 0
is *not* popped by index 1, and both are popped by 3: correct, since 2 is not greater than 2.

**Store indices, not values.** `nums[stack[top]]` recovers the value in O(1), but no value
recovers a position — and positions are what most of these problems actually want:
distances (`i - j` days until warmer), widths (`right - left - 1` in a histogram), spans
(`i - prevGreater` for stock span). Push `i`, not `nums[i]`.

### The direction table (identical in every chapter of this family)

| You want, for each `i` … | Scan | Stack values | Pop while | Read the answer from |
|---|---|---|---|---|
| **next greater** to the right | left → right | **decreasing** | `nums[top] <= nums[i]` | the pop — `i` is the popped index's answer |
| **previous greater** to the left | left → right | **decreasing** | `nums[top] <= nums[i]` | what is left on top *before* pushing `i` |
| **next smaller** to the right | left → right | increasing | `nums[top] >= nums[i]` | the pop — `i` is the popped index's answer |
| **previous smaller** to the left | left → right | increasing | `nums[top] >= nums[i]` | what is left on top *before* pushing `i` |

The four rows are really **two passes**: rows 1–2 are one decreasing-stack pass read in two
ways, rows 3–4 one increasing-stack pass read in two ways (chapter 34).

**Duplicates — where the strictness goes.** In one pass the two readings get opposite
strictness, and you cannot have both strict:

```text
pop while nums[top] <  nums[i]  →  pop gives "next strictly greater",
                                   top gives "previous greater-or-equal"
pop while nums[top] <= nums[i]  →  pop gives "next greater-or-equal",
                                   top gives "previous strictly greater"
```

Choose the comparison the problem's tie-breaking needs, then remember the other reading
flipped. (For smaller-queries, mirror `<`/`<=` to `>`/`>=`.)

### Steps

```text
Step 1 → stack = empty list of INDICES; answers default to "none"
Step 2 → for i = 0 … n-1:
Step 3 →   while stack is non-empty and nums[stack.top] <= nums[i]:
Step 4 →       j = pop  →  nextGreater[j] = i        (i settles j)
Step 5 →   prevGreater[i] = stack.top if stack is non-empty else "none"
Step 6 →   push i
Step 7 → anything still on the stack has no greater element to its right
```

### How should I recognize this?

```text
If you see...
  "next greater", "first larger to the right", "days until warmer",
  "how long until the price rises", circular "next greater", "warmer/taller/louder",
  n up to 1e5 with an obvious O(n^2) scan
        ↓
Think about...
  "When a bigger element arrives, which earlier elements just became useless forever?"
        ↓
Use...
  A monotonic stack of indices.
    greater-queries → decreasing stack, pop while top <= current
    smaller-queries → increasing stack, pop while top >= current  (chapter 34)
    circular array  → loop i = 0 … 2n-1, use i % n, push only while i < n
    need a distance → you stored indices, so subtract them
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-35" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Decreasing stack: pop while top &lt; incoming (nearest greater)</text>
  <text x="130" y="52" text-anchor="middle" fill="#64748b">scan array →</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="148" y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="196" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">10</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="88" text-anchor="middle" fill="#1e293b">8</text>
  <text x="196" y="122" text-anchor="middle" fill="#059669" font-weight="700">incoming</text>
  <text x="490" y="52" text-anchor="middle" fill="#64748b">stack (bottom → top)</text>
  <rect x="452" y="150" width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="172" text-anchor="middle" fill="#1e293b">5  pop</text>
  <rect x="452" y="112" width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="134" text-anchor="middle" fill="#1e293b">2  pop</text>
  <line x1="222" y1="82" x2="448" y2="128" stroke="#475569" marker-end="url(#ar-35)"/>
  <text x="350" y="102" text-anchor="middle" fill="#d97706">10 &gt; 2 and 10 &gt; 5 → pop</text>
  <text x="490" y="196" text-anchor="middle" fill="#059669" font-weight="700">then push 10 → stack [10]</text>
</svg>
```

```text
nums  =   4    5    2   10    8
index     0    1    2    3    4

i=0 v=4   stack empty                  prev[0] = none    push 0 → stack(vals) [4]
i=1 v=5   4 <= 5 → pop 0, next[0] = 5  prev[1] = none    push 1 → [5]
i=2 v=2   5 <= 2? no                   prev[2] = 5       push 2 → [5,2]
i=3 v=10  2 <= 10 → pop 2, next[2] = 10
          5 <= 10 → pop 1, next[1] = 10
          stack empty                  prev[3] = none    push 3 → [10]
i=4 v=8   10 <= 8? no                  prev[4] = 10      push 4 → [10,8]

end: indices 3 and 4 were never popped → nothing greater lies to their right

next    greater : [  5, 10, 10, --, -- ]     (values; -- = none)
previous greater: [ --, --,  5, --, 10 ]
```

Five pushes, three pops — one pass instead of the brute force's ten steps.

### Interview explanation
"I need each element's nearest greater neighbour, and scanning right from every index
repeats the same walk. The observation is that when a new element arrives, every earlier
element that is no larger is finished forever: the newcomer is its next-greater, and it can
never be anyone else's previous-greater because the newcomer is both nearer and no smaller.
So I keep a stack of *indices* whose values decrease from bottom to top, pop everything
`<=` the incoming value — the incoming index is their answer — and whatever survives on top
is the incoming element's previous greater. Every index is pushed once and popped at most
once, so it's O(n) time and O(n) space."

---

## 5. Generic Templates

> One decreasing stack, one pass: **the pop tells you the next greater, the leftover top tells you the previous greater.**

```go
// nearestGreater returns, for every index i, the index of the nearest greater
// element on each side. prev[i] = -1 and next[i] = len(nums) mean "none".
//
// Pop condition `<=` means: prev[i] is the previous STRICTLY greater element,
// next[i] is the next GREATER-OR-EQUAL element. Use `<` to swap the strictness.
func nearestGreater(nums []int) (prev, next []int) {
	n := len(nums)
	prev, next = make([]int, n), make([]int, n)
	for i := 0; i < n; i++ {
		prev[i], next[i] = -1, n
	}
	stack := make([]int, 0, n) // indices; values decrease bottom → top
	for i := 0; i < n; i++ {
		// Everything no larger than nums[i] is settled by i and dies here.
		for len(stack) > 0 && nums[stack[len(stack)-1]] <= nums[i] {
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			next[top] = i
		}
		if len(stack) > 0 {
			prev[i] = stack[len(stack)-1]
		}
		stack = append(stack, i)
	}
	return prev, next
}
```

```python
def nearest_greater(nums):
    """prev[i] = index of previous strictly greater (-1 if none),
       next[i] = index of next greater-or-equal (len(nums) if none)."""
    n = len(nums)
    prev, next_ = [-1] * n, [n] * n
    stack = []                                  # indices, values decreasing
    for i in range(n):
        while stack and nums[stack[-1]] <= nums[i]:
            next_[stack.pop()] = i              # i settles the popped index
        if stack:
            prev[i] = stack[-1]                 # survivor is strictly greater
        stack.append(i)
    return prev, next_
```

```java
// prev[i] = previous strictly greater index (-1), next[i] = next greater-or-equal (n).
int[][] nearestGreater(int[] nums) {
    int n = nums.length;
    int[] prev = new int[n], next = new int[n];
    Arrays.fill(prev, -1);
    Arrays.fill(next, n);
    Deque<Integer> stack = new ArrayDeque<>();  // indices, values decreasing
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] <= nums[i])
            next[stack.pop()] = i;
        if (!stack.isEmpty()) prev[i] = stack.peek();
        stack.push(i);
    }
    return new int[][]{prev, next};
}
```

```cpp
// prev[i] = previous strictly greater index (-1), next[i] = next greater-or-equal (n).
pair<vector<int>, vector<int>> nearestGreater(const vector<int>& nums) {
    int n = nums.size();
    vector<int> prev(n, -1), nxt(n, n), stack;   // stack holds indices
    for (int i = 0; i < n; ++i) {
        while (!stack.empty() && nums[stack.back()] <= nums[i]) {
            nxt[stack.back()] = i;
            stack.pop_back();
        }
        if (!stack.empty()) prev[i] = stack.back();
        stack.push_back(i);
    }
    return {prev, nxt};
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Monotonic Decreasing Stack (Optimal) |
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

### Problem — Next Greater I (LeetCode 496)
`nums1` is a subset of `nums2` (all values distinct). For each value in `nums1`, return the
first value to its **right in `nums2`** that is greater, or `-1` if there is none.

### Thought Process
1. Forget `nums1` for a moment and answer "next greater element" for every position of
   `nums2` in one decreasing-stack pass.
2. The stack holds indices whose next-greater is still unknown; their values decrease from
   bottom to top.
3. When `nums2[i]` beats the top, `nums2[i]` is that index's answer. Store it in a map
   keyed by **value**, because `nums1` addresses elements by value, not position.
4. Indices never popped have nothing greater to their right → they never enter the map, so
   the lookup default `-1` covers them.

### Dry Run

Input: `nums1 = [4, 1, 2]`, `nums2 = [2, 4, 1, 3]`

| i | `nums2[i]` | pops (value → its next greater) | stack after (indices) | stack values | map so far |
|---|---|---|---|---|---|
| 0 | 2 | — | `[0]` | `[2]` | `{}` |
| 1 | 4 | `2 → 4` | `[1]` | `[4]` | `{2:4}` |
| 2 | 1 | none (`4 > 1`) | `[1,2]` | `[4,1]` | `{2:4}` |
| 3 | 3 | `1 → 3`, then stop (`4 > 3`) | `[1,3]` | `[4,3]` | `{2:4, 1:3}` |

Leftovers `4` and `3` are absent from the map → `-1`. Lookup `nums1`: `4 → -1`, `1 → 3`,
`2 → 4`.

Output: **`[-1, 3, 4]`**

Row `i=3` shows the invariant paying off: the `while` stops at `4` instead of scanning the
rest of the stack, because a decreasing stack guarantees everything below is even larger.

### Visualization

```text
nums2 =  2    4    1    3
         └───▶4    └───▶3          each pop pairs a value with the element that popped it

stack values (top on the right):
  [2]  →  [4]  →  [4,1]  →  [4,3]
                              ^ never popped → -1

nums1 =  4    1    2
         ↓    ↓    ↓
        -1    3    4
```

### Code

```go
func nextGreaterElement(nums1 []int, nums2 []int) []int {
	nextGreater := make(map[int]int, len(nums2))
	stack := make([]int, 0, len(nums2)) // indices into nums2; values decreasing
	for i, v := range nums2 {
		for len(stack) > 0 && nums2[stack[len(stack)-1]] < v {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			nextGreater[nums2[j]] = v
		}
		stack = append(stack, i)
	}
	res := make([]int, len(nums1))
	for i, v := range nums1 {
		if g, ok := nextGreater[v]; ok {
			res[i] = g
		} else {
			res[i] = -1
		}
	}
	return res
}
```

```python
def nextGreaterElement(nums1, nums2):
    next_greater = {}
    stack = []                              # indices into nums2, values decreasing
    for i, v in enumerate(nums2):
        while stack and nums2[stack[-1]] < v:
            next_greater[nums2[stack.pop()]] = v
        stack.append(i)
    return [next_greater.get(v, -1) for v in nums1]
```

### Complexity
Time O(n + m) — one pass over `nums2` (n) plus one map lookup per element of `nums1` (m).
Space O(n) for the stack and the map.

---

## 10. Solved Example 2

### Problem — Next Greater II (LeetCode 503)
Same question, but the array is **circular**: after the last element the search wraps around
to the front. Return each element's next greater value, or `-1`.

### Thought Process
1. Wrapping means an element may be answered by something to its *left* in the original
   array — but only after one full lap.
2. Simulate the lap by looping `i = 0 … 2n-1` and reading `nums[i % n]`. Two laps are
   enough: after a full circle, whatever is still unresolved is the maximum, and a third lap
   would find nothing new.
3. **Push only while `i < n`.** Pushing on the second lap would create duplicate entries for
   the same position and could overwrite a correct answer.
4. Everything still on the stack after both laps has no greater element anywhere → `-1`.

### Dry Run

Input: `nums = [1, 2, 1]` (n = 3, so `i` runs 0…5)

| i | `i%n` | value | pops (`j` → `res[j]`) | push? | stack after (indices) |
|---|---|---|---|---|---|
| 0 | 0 | 1 | — | yes | `[0]` |
| 1 | 1 | 2 | `0` → `res[0]=2` | yes | `[1]` |
| 2 | 2 | 1 | none (`2 > 1`) | yes | `[1,2]` |
| 3 | 0 | 1 | none (`1 = 1`, not greater) | no (lap 2) | `[1,2]` |
| 4 | 1 | 2 | `2` → `res[2]=2` | no (lap 2) | `[1]` |
| 5 | 2 | 1 | none | no (lap 2) | `[1]` |

Index 1 (value 2) is never popped — it is the maximum — so `res[1] = -1`.

Output: **`[2, -1, 2]`**

Row `i=4` is why the second lap exists: index 2 could only be answered by the `2` that sits
to its **left**. Row `i=3` is why pushes stop after the first lap — pushing index 0 again
would let it be answered twice.

### Visualization

```text
        ┌──────── wraps around ────────┐
        ▼                              │
index   0    1    2  │  0    1    2 ───┘
value   1    2    1  │  1    2    1
             ▲            lap 2: read only, never push
             └── pops index 0 (lap 1) and index 2 (lap 2)

res =   2   -1    2
             ^ the array maximum can never be answered
```

### Code

```go
func nextGreaterElements(nums []int) []int {
	n := len(nums)
	res := make([]int, n)
	for i := range res {
		res[i] = -1
	}
	stack := make([]int, 0, n) // indices; values decreasing
	for i := 0; i < 2*n; i++ {
		v := nums[i%n]
		for len(stack) > 0 && nums[stack[len(stack)-1]] < v {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			res[j] = v
		}
		if i < n { // push only on the first lap
			stack = append(stack, i)
		}
	}
	return res
}
```

```python
def nextGreaterElements(nums):
    n = len(nums)
    res = [-1] * n
    stack = []                              # indices, values decreasing
    for i in range(2 * n):
        v = nums[i % n]
        while stack and nums[stack[-1]] < v:
            res[stack.pop()] = v
        if i < n:                           # push only on the first lap
            stack.append(i)
    return res
```

### Complexity
Time O(n) — `2n` iterations, `n` pushes, at most `n` pops. Space O(n) for the stack.

---

## 11. Solved Example 3

### Problem — Daily Temps (LeetCode 739)
For each day, how many days must you wait for a strictly **warmer** temperature? Answer 0 if
no warmer day ever comes.

### Thought Process
1. "Days to wait" is the *distance* to the next greater element, so the stack must hold
   **indices** — values alone cannot produce `i - j`.
2. Keep unresolved days on a decreasing stack.
3. Day `i` pops every waiting day `j` with `temps[j] < temps[i]` and sets `res[j] = i - j`.
4. Use a **strict** `<`: an equally warm day is not warmer, so it must not pop.

### Dry Run

Input: `[73, 75, 71, 75]`

| i | t | pops (`j` → `res[j] = i-j`) | stack after (indices) | stack temps |
|---|----|---|---|---|
| 0 | 73 | — | `[0]` | `[73]` |
| 1 | 75 | `0` → `res[0] = 1-0 = 1` | `[1]` | `[75]` |
| 2 | 71 | none (`75 > 71`) | `[1,2]` | `[75,71]` |
| 3 | 75 | `2` → `res[2] = 3-2 = 1`; stops at index 1 because `75 < 75` is **false** | `[1,3]` | `[75,75]` |

Output: **`[1, 0, 1, 0]`**

Row `i=3` is the duplicates rule in action. With `<=` instead of `<`, index 1 would be
popped and `res[1]` would become 2 — wrong, because day 3 is not *warmer* than day 1, just
as warm. That is the only line of the algorithm that ties break.

### Visualization

```text
day     0    1    2    3
temp   73   75   71   75
        └─1─▶│    └─1─▶│
             └──── 75 is not warmer than 75 → index 1 stays, answer 0

stack temps over time:  [73]  [75]  [75,71]  [75,75]
                                              ^ equal values may coexist under `<`

res =   1    0    1    0
```

### Code

```go
func dailyTemperatures(temps []int) []int {
	res := make([]int, len(temps))
	stack := make([]int, 0, len(temps)) // indices of days still waiting; temps decreasing
	for i, t := range temps {
		for len(stack) > 0 && temps[stack[len(stack)-1]] < t { // strict: equal is not warmer
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			res[j] = i - j
		}
		stack = append(stack, i)
	}
	return res // days never popped keep 0
}
```

```python
def dailyTemperatures(temps):
    res = [0] * len(temps)
    stack = []                              # indices, temps decreasing
    for i, t in enumerate(temps):
        while stack and temps[stack[-1]] < t:   # strict: equal is not warmer
            j = stack.pop()
            res[j] = i - j
        stack.append(i)
    return res
```

### Complexity
Time O(n) — each day is pushed once and popped at most once. Space O(n) — the stack, worst
case a strictly decreasing temperature series.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 496 | Next Greater I | Easy | Core stacks application |
| 503 | Next Greater II | Easy | Core stacks application |
| 739 | Daily Temps | Medium | Core stacks application |
| 42 | Trapping Rain | Medium | Core stacks application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Monotonic Decreasing Stack logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Monotonic Decreasing Stack (Stacks).
- **Signal:** monotonic stack, decreasing, next greater, previous greater.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Monotonic Decreasing Stack invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Monotonic Decreasing Stack
FAMILY : Stacks (Intermediate)
WHEN   : monotonic stack, decreasing, next greater, previous greater
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 496, 503, 739, 42
```

---

*Part of the DSA Patterns Handbook — pattern 35 of 100.*
