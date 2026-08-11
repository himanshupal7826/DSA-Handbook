# 36 · Next Greater Element

> **One-liner:** Stack scan to find each element's next strictly greater neighbor.

---

## 1. Overview

### Definition
The **Next Greater Element** pattern belongs to the *Stacks* family. Stack scan to find each element's next strictly greater neighbor.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
next greater, monotonic stack, circular, to the right.

### Constraints
- Input size where the brute-force complexity would time out — the Next Greater Element optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Next Greater Element invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Next Greater Element is the upgrade.
- The wording maps onto: next greater, monotonic stack, circular, to the right.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"For each element, what is the first element to its **right** that is strictly greater?"*

Running example: `nums = [2, 1, 2, 4, 3]`. The answers are `[4, 2, 4, -1, -1]`.

### Intuition
Take one element at a time, walk rightwards, and stop at the first bigger value. Nothing
to stop at? The answer is `-1`. Repeat for all `n` elements.

### Algorithm
1. For each index `i` from `0` to `n-1`:
2. Walk `j = i+1, i+2, …` to the right.
3. If `nums[j] > nums[i]`, record `nums[j]` as the answer and stop.
4. If the walk falls off the end, record `-1`.
5. Return the array of answers.

### Complexity
- Time: **O(n²)** — the walk from `i` can cross the whole tail. A descending array like
  `[5, 4, 3, 2, 1]` costs 4 + 3 + 2 + 1 = 10 steps and every answer is `-1`.
- Space: O(1) beyond the output.

### Drawbacks
- **The exact wasted work.** On `[2, 1, 2, 4, 3]` the walk from `i=0` visits indices 1, 2, 3
  and stops at the `4`. Along the way it stepped over index 1 (`1`) and index 2 (`2`) — and
  it had *already computed* their answers on that very walk (`2` for index 1, `4` for index
  2). It throws both away, then recomputes them one loop later.
- **The fact it never exploits.** Every element the walk steps over is `<=` the element it
  started from. Such an element is beaten twice over: it sits further left *and* it is no
  bigger. Nothing to the right will ever pick it. The brute force keeps re-visiting these
  dead elements; the optimal approach removes them from the world.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **A bigger element arriving answers every smaller element still waiting — all at once — and those elements are then dead forever, because the newcomer is nearer and bigger than any of them.**

Think of a queue of people waiting to be told "who is the first person taller than me
further along?". When a tall person walks in, everyone shorter who is still waiting gets
their answer simultaneously and goes home. Nobody arriving later needs them: the tall
newcomer stands in front of them and is bigger, so it would always be chosen first. The
people still waiting are therefore in **decreasing** order of height.

### The thought process

```text
We need    : for each i, the first element to the right that is greater
Obvious way: walk right from every i
Too slow   : O(n^2) — the same descending run is re-walked from every start inside it
Notice     : a walk that steps over j has proved nums[j] <= nums[i]; from then on
             j is dead — anything that could answer j is met by i first
Therefore  : keep only the elements still WAITING for an answer; when nums[i] arrives
             it answers, and removes, every waiting element smaller than it
Now        : the waiting list is always decreasing, removals happen from its newest
             end, and every index enters and leaves once → O(n)
```

### Why "resolve on pop" is the whole trick

The stack is not the idea; it is the consequence. The idea is the *waiting list* of indices
whose answer has not appeared yet.

1. **The waiting list is decreasing.** If `j < i` were both waiting with
   `nums[j] <= nums[i]`, then `i` itself would already have answered `j`. So it can't
   happen: values decrease from the oldest entry to the newest.
2. **Removals are newest-first.** The newest waiter holds the smallest value, so an
   incoming value clears waiters from the newest end and stops as soon as it meets someone
   bigger. Newest-in, newest-out — a stack.
3. **The popped element's answer is the *nearest* one.** When `i` pops `j`, no index `k`
   between them was greater: had `nums[k] > nums[j]`, `k` would have cleared everything
   above `j` (all smaller than `nums[j]`) and then `j` too, so `j` would not still be
   waiting. Therefore `i` is genuinely the *first* greater element to the right of `j`.
4. **Leftovers are the answer-less ones.** Whatever is still on the stack after the pass has
   nothing greater to its right — that is where the `-1`s come from, and it is why you
   initialise the result array to `-1` and never write it again.

**Store indices, not values.** The value is `nums[stack[top]]`, one lookup away; the
position is unrecoverable from the value. Positions are what the variants need: the
*distance* `i - j` (LeetCode 739), the *width* between boundaries (LeetCode 84), the *span*
(LeetCode 901). Values-on-the-stack only works when the problem asks purely for values, as
in LeetCode 496 — and even then indices cost nothing extra.

### The direction table (identical in every chapter of this family)

| You want, for each `i` … | Scan | Stack values | Pop while | Read the answer from |
|---|---|---|---|---|
| **next greater** to the right | left → right | **decreasing** | `nums[top] <= nums[i]` | the pop — `i` is the popped index's answer |
| **previous greater** to the left | left → right | **decreasing** | `nums[top] <= nums[i]` | what is left on top *before* pushing `i` |
| **next smaller** to the right | left → right | increasing | `nums[top] >= nums[i]` | the pop — `i` is the popped index's answer |
| **previous smaller** to the left | left → right | increasing | `nums[top] >= nums[i]` | what is left on top *before* pushing `i` |

The four rows are really **two passes**: rows 1–2 are one decreasing-stack pass read in two
ways, rows 3–4 one increasing-stack pass read in two ways. This chapter lives in row 1;
chapter 37 lives in row 2 with the very same code.

**Duplicates — where the strictness goes.** In one pass the two readings get opposite
strictness, and you cannot have both strict:

```text
pop while nums[top] <  nums[i]  →  pop gives "next strictly greater",
                                   top gives "previous greater-or-equal"
pop while nums[top] <= nums[i]  →  pop gives "next greater-or-equal",
                                   top gives "previous strictly greater"
```

"Next greater" is conventionally **strict**, so this chapter pops with `<`. On the running
example that matters: at `i=2` the value `2` does *not* pop the earlier `2`, so index 0's
answer becomes `4` and not `2`.

### Steps

```text
Step 1 → res[i] = -1 for all i; stack = empty list of INDICES
Step 2 → for i = 0 … n-1:
Step 3 →   while stack is non-empty and nums[stack.top] < nums[i]:
Step 4 →       j = pop  →  res[j] = nums[i]        (i answers j)
Step 5 →   push i                                  (i now waits for its own answer)
Step 6 → leftovers keep res = -1
```

### How should I recognize this?

```text
If you see...
  "next greater element", "first larger to the right", "next warmer / taller / louder",
  "how many days until", "circular array, next greater", "next bigger permutation",
  n up to 1e5 and an obvious per-element rightward scan
        ↓
Think about...
  "When this bigger value arrives, whose question does it answer — and who dies with it?"
        ↓
Use...
  A decreasing stack of indices, popping while top < current.
    want the value    → res[j] = nums[i]
    want the distance → res[j] = i - j                     (chapter 39)
    circular array    → loop i = 0 … 2n-1 over i % n, push only while i < n
    subset lookup     → record answers in a value → answer map (LeetCode 496)
    look leftwards    → same code, read the surviving top  (chapter 37)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-36" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Next greater: incoming pops smaller tops and becomes their answer</text>
  <text x="130" y="52" text-anchor="middle" fill="#64748b">nums (scan →)</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="148" y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="196" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">4</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="88" text-anchor="middle" fill="#1e293b">3</text>
  <text x="196" y="122" text-anchor="middle" fill="#059669" font-weight="700">incoming 4</text>
  <text x="490" y="52" text-anchor="middle" fill="#64748b">stack (values)</text>
  <rect x="452" y="112" width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="134" text-anchor="middle" fill="#1e293b">2  pop</text>
  <rect x="452" y="74"  width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="96"  text-anchor="middle" fill="#1e293b">2  pop</text>
  <line x1="222" y1="82" x2="448" y2="90" stroke="#475569" marker-end="url(#ar-36)"/>
  <text x="350" y="150" text-anchor="middle" fill="#d97706">4 &gt; top → pop, answer[popped] = 4</text>
  <text x="130" y="186" text-anchor="middle" fill="#64748b">result (next greater)</text>
  <rect x="30"  y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="52"  y="222" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="78"  y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="100" y="222" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="126" y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="148" y="222" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="174" y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="222" text-anchor="middle" fill="#64748b">-1</text>
  <rect x="222" y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="222" text-anchor="middle" fill="#64748b">-1</text>
</svg>
```

```text
nums  =   2    1    2    4    3
index     0    1    2    3    4
res   =  -1   -1   -1   -1   -1        (everyone starts unanswered)

i=0 v=2  nothing to answer                     push 0 → stack(vals) [2]
i=1 v=1  2 < 1? no                             push 1 → [2,1]
i=2 v=2  1 < 2 → pop 1, res[1] = 2
         2 < 2? NO — equal is not greater      push 2 → [2,2]
i=3 v=4  2 < 4 → pop 2, res[2] = 4
         2 < 4 → pop 0, res[0] = 4             push 3 → [4]
i=4 v=3  4 < 3? no                             push 4 → [4,3]

leftovers on the stack: indices 3 and 4  →  res stays -1 for both

res   =   4    2    4   -1   -1
```

Five pushes, three pops, one pass — versus the brute force's ten steps.

### Interview explanation
"For every element I need the first larger element on its right. Scanning right from each
index redoes the same walk, so instead I keep a stack of *indices that are still waiting for
an answer*. When a new value arrives it pops — and answers — every waiting index smaller
than itself; those indices are then gone for good, because the newcomer is both nearer and
bigger, so nobody later could ever pick them. The waiting values are always decreasing, the
pops always happen at the newest end, and whatever remains at the end has no greater element
to its right, which gives the `-1`s. Each index is pushed once and popped at most once, so
it's O(n) time and O(n) space. For a circular array I run the loop `2n` times over `i % n`
and only push during the first lap."

---

## 5. Generic Templates

> **Everyone on the stack is still waiting; the incoming value answers all the smaller ones and they never come back.**

```go
// nextGreaterIndex returns, for every i, the index of the first strictly greater
// element to the right, or -1 when there is none. Take nums[res[i]] for the value
// or res[i]-i for the distance — that is why the stack holds indices.
func nextGreaterIndex(nums []int) []int {
	res := make([]int, len(nums))
	for i := range res {
		res[i] = -1
	}
	stack := make([]int, 0, len(nums)) // indices still waiting; values decreasing
	for i, v := range nums {
		for len(stack) > 0 && nums[stack[len(stack)-1]] < v { // strict: equal keeps waiting
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			res[j] = i
		}
		stack = append(stack, i)
	}
	return res // indices never popped keep -1
}

// nextGreaterCircular is the same routine on a circular array: two laps, push once.
func nextGreaterCircular(nums []int) []int {
	n := len(nums)
	res := make([]int, n)
	for i := range res {
		res[i] = -1
	}
	stack := make([]int, 0, n)
	for i := 0; i < 2*n; i++ {
		v := nums[i%n]
		for len(stack) > 0 && nums[stack[len(stack)-1]] < v {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			res[j] = i % n
		}
		if i < n {
			stack = append(stack, i)
		}
	}
	return res
}
```

```python
def next_greater_index(nums):
    """res[i] = index of the first strictly greater element to the right, else -1."""
    res = [-1] * len(nums)
    stack = []                                  # indices waiting, values decreasing
    for i, v in enumerate(nums):
        while stack and nums[stack[-1]] < v:    # strict: equal keeps waiting
            res[stack.pop()] = i
        stack.append(i)
    return res


def next_greater_circular(nums):
    n = len(nums)
    res = [-1] * n
    stack = []
    for i in range(2 * n):
        v = nums[i % n]
        while stack and nums[stack[-1]] < v:
            res[stack.pop()] = i % n
        if i < n:                               # push only on the first lap
            stack.append(i)
    return res
```

```java
// res[i] = index of the first strictly greater element to the right, else -1.
int[] nextGreaterIndex(int[] nums) {
    int n = nums.length;
    int[] res = new int[n];
    Arrays.fill(res, -1);
    Deque<Integer> stack = new ArrayDeque<>();  // indices waiting, values decreasing
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i])
            res[stack.pop()] = i;
        stack.push(i);
    }
    return res;
}
```

```cpp
// res[i] = index of the first strictly greater element to the right, else -1.
vector<int> nextGreaterIndex(const vector<int>& nums) {
    int n = nums.size();
    vector<int> res(n, -1), stack;              // stack holds indices
    for (int i = 0; i < n; ++i) {
        while (!stack.empty() && nums[stack.back()] < nums[i]) {
            res[stack.back()] = i;
            stack.pop_back();
        }
        stack.push_back(i);
    }
    return res;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Next Greater Element (Optimal) |
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
`nums1` is a subset of `nums2`, all values distinct. For each value of `nums1`, return the
first value to its **right in `nums2`** that is greater, or `-1`.

### Thought Process
1. Solve the general question on `nums2` first: one decreasing-stack pass gives every
   position its next greater element.
2. The queries arrive as *values*, not positions, and the values are distinct — so record
   each answer in a map `value → next greater value` as the pop happens.
3. Positions never popped have no greater element to their right, so they never enter the
   map.
4. Answer each `nums1[k]` with a map lookup defaulting to `-1`.

### Dry Run

Input: `nums1 = [4, 1, 2]`, `nums2 = [1, 3, 4, 2]`

| i | `nums2[i]` | pops (`j` → `res`) | stack after (indices) | stack values | map so far |
|---|---|---|---|---|---|
| 0 | 1 | — | `[0]` | `[1]` | `{}` |
| 1 | 3 | `0` → `1's answer = 3` | `[1]` | `[3]` | `{1:3}` |
| 2 | 4 | `1` → `3's answer = 4` | `[2]` | `[4]` | `{1:3, 3:4}` |
| 3 | 2 | none (`4 > 2`) | `[2,3]` | `[4,2]` | `{1:3, 3:4}` |

Leftover indices 2 and 3 (values `4`, `2`) never found anything greater.
Lookups: `4 → -1`, `1 → 3`, `2 → -1`.

Output: **`[-1, 3, -1]`**

### Visualization

```text
nums2 =  1    3    4    2
         └───▶3                     3 pops 1 and becomes its answer
              └───▶4                4 pops 3 and becomes its answer
                        (2 is still waiting when the array ends)

stack values:  [1]  →  [3]  →  [4]  →  [4,2]
                                        ^^^^ leftovers → -1

nums1 =  4    1    2
         ↓    ↓    ↓
        -1    3   -1
```

### Code

```go
func nextGreaterElement(nums1 []int, nums2 []int) []int {
	answer := make(map[int]int, len(nums2))
	stack := make([]int, 0, len(nums2)) // indices into nums2; values decreasing
	for i, v := range nums2 {
		for len(stack) > 0 && nums2[stack[len(stack)-1]] < v {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			answer[nums2[j]] = v // v is the first greater element to the right of j
		}
		stack = append(stack, i)
	}
	res := make([]int, len(nums1))
	for k, v := range nums1 {
		if g, ok := answer[v]; ok {
			res[k] = g
		} else {
			res[k] = -1
		}
	}
	return res
}
```

```python
def nextGreaterElement(nums1, nums2):
    answer = {}
    stack = []                                  # indices into nums2, values decreasing
    for i, v in enumerate(nums2):
        while stack and nums2[stack[-1]] < v:
            answer[nums2[stack.pop()]] = v
        stack.append(i)
    return [answer.get(v, -1) for v in nums1]
```

### Complexity
Time O(n + m) — one pass over `nums2` (n elements, each pushed and popped once) plus one
lookup per element of `nums1` (m). Space O(n) for the stack and map.

---

## 10. Solved Example 2

### Problem — Next Greater II (LeetCode 503)
The array is **circular**: the search for a greater element continues past the last element
back to the first. Return each element's next greater value, or `-1`.

### Thought Process
1. Circularity only means an element may be answered by something to its left — but only
   after the scan has wrapped once.
2. Simulate the wrap with `i = 0 … 2n-1`, reading `nums[i % n]`. Two laps suffice: after one
   full lap, anything still waiting is a maximum of the array, and no further lap can help.
3. **Push only while `i < n`.** On lap 2 the entries are re-read but never re-pushed —
   otherwise the same position could sit on the stack twice and get answered twice.
4. Everything still waiting at the end is `-1`.

### Dry Run

Input: `nums = [3, 8, 4, 1]` (n = 4, so `i` runs 0…7)

| i | `i%n` | value | pops (`j` → `res[j]`) | push? | stack after (indices) |
|---|---|---|---|---|---|
| 0 | 0 | 3 | — | yes | `[0]` |
| 1 | 1 | 8 | `0` → `res[0]=8` | yes | `[1]` |
| 2 | 2 | 4 | none (`8 > 4`) | yes | `[1,2]` |
| 3 | 3 | 1 | none (`4 > 1`) | yes | `[1,2,3]` |
| 4 | 0 | 3 | `3` → `res[3]=3` | no (lap 2) | `[1,2]` |
| 5 | 1 | 8 | `2` → `res[2]=8`, stop (`8 = 8`) | no (lap 2) | `[1]` |
| 6 | 2 | 4 | none | no (lap 2) | `[1]` |
| 7 | 3 | 1 | none | no (lap 2) | `[1]` |

Index 1 (value 8, the maximum) is never popped → `res[1] = -1`.

Output: **`[8, -1, 8, 3]`**

Rows `i=4` and `i=5` are the point of lap 2: indices 3 and 2 are answered by elements that
lie to their **left** in the original array. Row `i=5` also shows the strict comparison — the
`8` at position 1 does not pop itself.

### Visualization

```text
index    0    1    2    3  ╎  0    1    2    3
value    3    8    4    1  ╎  3    8    4    1
         └───▶8            ╎  ▲    ▲
                           ╎  │    └── answers index 2 (wrapped)
                           ╎  └─────── answers index 3 (wrapped)
                          lap 2: read only, never push

res =    8   -1    8    3
              ^ the maximum is answered by nobody
```

### Code

```go
func nextGreaterElements(nums []int) []int {
	n := len(nums)
	res := make([]int, n)
	for i := range res {
		res[i] = -1
	}
	stack := make([]int, 0, n) // indices still waiting; values decreasing
	for i := 0; i < 2*n; i++ {
		v := nums[i%n]
		for len(stack) > 0 && nums[stack[len(stack)-1]] < v {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			res[j] = v
		}
		if i < n { // lap 2 answers, it never enqueues
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
    stack = []                                  # indices waiting, values decreasing
    for i in range(2 * n):
        v = nums[i % n]
        while stack and nums[stack[-1]] < v:
            res[stack.pop()] = v
        if i < n:                               # lap 2 answers, never enqueues
            stack.append(i)
    return res
```

### Complexity
Time O(n) — `2n` iterations, `n` pushes and at most `n` pops. Space O(n) for the stack.

---

## 11. Solved Example 3

### Problem — Next Greater III (LeetCode 556)
Given a positive integer `n`, find the smallest integer that uses exactly the same digits
and is **greater than `n`**. Return `-1` if none exists or if it does not fit in 32 bits.

### Thought Process
1. Same question, different alphabet: instead of "next greater element" we want "next
   greater *arrangement*" — the next permutation of the digit string.
2. Scan from the right while digits are non-increasing. That suffix is already the largest
   arrangement of itself, so nothing inside it can grow — it is exactly the "decreasing run"
   this chapter keeps popping, except here the array itself stores it.
3. The first digit that breaks the run is the **pivot**. To grow the number as little as
   possible, swap the pivot with the *smallest digit to its right that is still bigger than
   it* — that digit is the rightmost one greater than the pivot, since the suffix descends.
4. After the swap the suffix is still descending, so reverse it to make it ascending — the
   smallest possible tail.
5. Reject the result if it overflows a signed 32-bit integer.

*(LeetCode names this function `nextGreaterElement` too; it is renamed here so it does not
collide with Example 1.)*

### Dry Run

Input: `n = 21453`

| step | digits | what happened |
|---|---|---|
| start | `2 1 4 5 3` | — |
| find pivot | `2 1 [4] 5 3` | scan right→left: `5 ≥ 3` keeps going, `4 < 5` stops → pivot at index 2 |
| find swap partner | `2 1 [4] 5 [3]` | rightmost digit greater than `4` is `5` at index 3 (`3` is too small) |
| swap | `2 1 5 4 3` | pivot replaced by the smallest digit that still increases the number |
| reverse suffix | `2 1 5 3 4` | the tail `4 3` becomes `3 4`, the smallest ordering |

Output: **`21534`**

The suffix `5 3` is the decreasing run; had the whole number been decreasing (`54321`), the
pivot scan would fall off the left end and the answer would be `-1`.

### Visualization

```text
        2    1    4    5    3
                  ▲    └────┘  suffix already at its maximum arrangement
                  pivot: the first digit smaller than its right neighbour

swap  : 2    1    5    4    3        ← 5 is the smallest digit > 4 in the suffix
reverse:2    1    5    3    4        ← tail sorted ascending = smallest tail
                       └──┘

21453  →  21534      (next larger arrangement of the same digits)
```

### Code

```go
func nextGreaterNumber(n int) int {
	digits := []byte(strconv.Itoa(n))
	// 1. rightmost pivot: the first digit smaller than its right neighbour.
	i := len(digits) - 2
	for i >= 0 && digits[i] >= digits[i+1] {
		i--
	}
	if i < 0 {
		return -1 // digits are fully descending: this is the largest arrangement
	}
	// 2. rightmost digit greater than the pivot (the suffix descends, so it is the
	//    smallest such digit).
	j := len(digits) - 1
	for digits[j] <= digits[i] {
		j--
	}
	digits[i], digits[j] = digits[j], digits[i]
	// 3. the suffix is still descending; reverse it to get the smallest tail.
	for l, r := i+1, len(digits)-1; l < r; l, r = l+1, r-1 {
		digits[l], digits[r] = digits[r], digits[l]
	}
	value, err := strconv.Atoi(string(digits))
	if err != nil || value > math.MaxInt32 {
		return -1
	}
	return value
}
```

```python
def nextGreaterNumber(n):
    digits = list(str(n))
    i = len(digits) - 2                                 # 1. find the pivot
    while i >= 0 and digits[i] >= digits[i + 1]:
        i -= 1
    if i < 0:
        return -1                                       # fully descending
    j = len(digits) - 1                                 # 2. rightmost digit > pivot
    while digits[j] <= digits[i]:
        j -= 1
    digits[i], digits[j] = digits[j], digits[i]
    digits[i + 1:] = reversed(digits[i + 1:])           # 3. smallest possible tail
    value = int("".join(digits))
    return value if value <= 2 ** 31 - 1 else -1
```

### Complexity
Time O(d) where `d` is the number of digits — three linear sweeps over the digit string.
Space O(d) for the mutable digit buffer.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 496 | Next Greater I | Easy | Core stacks application |
| 503 | Next Greater II | Easy | Core stacks application |
| 556 | Next Greater III | Medium | Core stacks application |
| 739 | Daily Temps | Medium | Core stacks application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Next Greater Element logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Next Greater Element (Stacks).
- **Signal:** next greater, monotonic stack, circular, to the right.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Next Greater Element invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Next Greater Element
FAMILY : Stacks (Intermediate)
WHEN   : next greater, monotonic stack, circular, to the right
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 496, 503, 556, 739
```

---

*Part of the DSA Patterns Handbook — pattern 36 of 100.*
