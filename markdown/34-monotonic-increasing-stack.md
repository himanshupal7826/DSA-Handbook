# 34 · Monotonic Increasing Stack

> **One-liner:** Maintain an increasing stack to find nearest smaller elements.

---

## 1. Overview

### Definition
The **Monotonic Increasing Stack** pattern belongs to the *Stacks* family. Maintain an increasing stack to find nearest smaller elements.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
monotonic stack, increasing, previous smaller, next smaller.

### Constraints
- Input size where the brute-force complexity would time out — the Monotonic Increasing Stack optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Monotonic Increasing Stack invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Monotonic Increasing Stack is the upgrade.
- The wording maps onto: monotonic stack, increasing, previous smaller, next smaller.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"For each element, where is the nearest **smaller** element — and how far away is it?"*

Running example: `nums = [2, 1, 5, 6, 3]`. For every index, find the nearest strictly
smaller element to its **right**.

### Intuition
There is nothing clever to see at first. Stand on each element, walk to the right one
step at a time, and stop at the first value that is smaller. If you fall off the end,
there is no answer. Repeat for every element.

### Algorithm
1. For each index `i` from `0` to `n-1`:
2. Walk `j = i+1, i+2, …` to the right.
3. The first `j` with `nums[j] < nums[i]` is the answer — record it and stop.
4. If no such `j` exists, record "none".
5. Return the array of answers.

### Complexity
- Time: **O(n²)** — every one of the `n` starts can walk to the end of the array, and a
  long run of large values is re-walked from every start inside it.
- Space: O(1) beyond the output.

### Drawbacks
- **The exact wasted work.** On `[2, 1, 5, 6, 3]` the scan from `i=2` (value 5) steps over
  index 3 (value 6) and stops at index 4 (value 3). In doing so it *proved* that 3 is also
  the answer for index 3 — and then throws that fact away. The very next iteration,
  `i=3`, rediscovers it from scratch. On `[6, 6, 6, 6, 1]` this repeats maximally:
  4 + 3 + 2 + 1 = 10 steps to compute five answers that are all the same element.
- **The fact it never exploits.** While the scan from `i` walks past an index `j` with
  `nums[j] >= nums[i]`, it has learned that `j` is worse than `i` in *both* ways at once:
  `j` is further left and no smaller. Nothing to the right of `i` will ever want `j`. The
  brute force notices this and forgets it; the optimal approach notices it and *deletes*
  `j`.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **If a later element is at least as small as an earlier one, the earlier one is dead — it has already been answered and it can never be anyone else's answer again, so pop it and never look at it once more.**

Picture a queue of people, each one only interested in the first person *shorter* than
themselves standing further down the line. A short person walks in and instantly satisfies
every taller person still waiting — all of them, at once — and those people go home
forever. Whoever is still waiting must therefore be in **increasing** order of height:
anybody taller than someone in front of them would already have left. That waiting list,
shortest at the top, is the monotonic increasing stack.

### The thought process

```text
We need    : for each i, the nearest strictly smaller element to its right
Obvious way: from each i, walk right until something smaller shows up
Too slow   : O(n^2) — every run of large values is re-walked from every start inside it
Notice     : if j < i and nums[j] >= nums[i], then j is finished twice over —
             i settles j's "next smaller", and no k > i can ever want j as its
             "previous smaller" because i is nearer and no larger
Therefore  : delete j the moment i arrives; the indices still waiting always have
             increasing values, and the newest one is the smallest
Now        : deletions happen from the newest end → that is a stack, and each index
             is pushed once and popped at most once → O(n) overall
```

### Why the stack (and why it must be increasing) works

Start from the *set of unresolved indices*, not from the data structure. At any moment
that set is exactly "indices whose nearest-smaller-to-the-right has not shown up yet". Two
facts pin it down:

1. **It is always increasing in value.** If two unresolved indices `j < i` had
   `nums[j] >= nums[i]`, then `i` itself already settled `j` — contradiction. So the
   values, read left to right, must strictly increase.
2. **A newcomer resolves it from the newest end backwards.** The newest unresolved index
   holds the smallest value. A new value `nums[i]` knocks out the newest ones first and
   stops as soon as it meets something smaller than itself. Newest-out-first *is* a stack.

**Why the answer is the *nearest* one.** When `i` pops `j`, could some index `k` between
them have been smaller? No. If `nums[k] < nums[j]`, then when `k` arrived it would have
popped everything above `j` (those are larger than `nums[j]`) and then `j` too. So every
index strictly between `j` and `i` had a value `>= nums[j]`, and `i` is genuinely the
first smaller one.

**Store indices, not values.** The value is one array lookup away (`nums[stack[top]]`), but
the *position* cannot be recovered from a value. You almost always need the position:
distances (`i - j` for "days until warmer"), widths (`right - left - 1` for histogram
rectangles), spans (`i - prevGreater` for stock span). Push `i`, not `nums[i]`.

### The direction table (identical in every chapter of this family)

| You want, for each `i` … | Scan | Stack values | Pop while | Read the answer from |
|---|---|---|---|---|
| **next smaller** to the right | left → right | **increasing** | `nums[top] >= nums[i]` | the pop — `i` is the popped index's answer |
| **previous smaller** to the left | left → right | **increasing** | `nums[top] >= nums[i]` | what is left on top *before* pushing `i` |
| **next greater** to the right | left → right | decreasing | `nums[top] <= nums[i]` | the pop — `i` is the popped index's answer |
| **previous greater** to the left | left → right | decreasing | `nums[top] <= nums[i]` | what is left on top *before* pushing `i` |

The four rows are really **two passes**: rows 1–2 are one increasing-stack pass read in two
ways, rows 3–4 one decreasing-stack pass read in two ways.

**Duplicates — where the strictness goes.** In one pass the two readings get opposite
strictness, and you cannot have both strict:

```text
pop while nums[top] >  nums[i]  →  pop gives "next strictly smaller",
                                   top gives "previous smaller-or-equal"
pop while nums[top] >= nums[i]  →  pop gives "next smaller-or-equal",
                                   top gives "previous strictly smaller"
```

Choose the comparison the problem's tie-breaking needs, then remember the other reading
flipped. (For greater-queries, mirror `>`/`>=` to `<`/`<=`.)

### Steps

```text
Step 1 → stack = empty list of INDICES; answers default to "none"
Step 2 → for i = 0 … n-1:
Step 3 →   while stack is non-empty and nums[stack.top] >= nums[i]:
Step 4 →       j = pop  →  nextSmaller[j] = i        (i settles j)
Step 5 →   prevSmaller[i] = stack.top if stack is non-empty else "none"
Step 6 →   push i
Step 7 → anything still on the stack has no smaller element to its right
```

### How should I recognize this?

```text
If you see...
  "nearest / next / previous smaller", "first element less than",
  "how far until", "span", "width until a shorter bar",
  "sum of subarray minimums", n up to 1e5 with an obvious O(n^2) scan
        ↓
Think about...
  "When a new element arrives, which earlier elements just became useless forever?"
        ↓
Use...
  A monotonic stack of indices.
    smaller-queries → increasing stack, pop while top >= current
    greater-queries → decreasing stack, pop while top <= current  (chapter 35)
    need the distance/width → you stored indices, so subtract them
    need every bar flushed  → append a sentinel (chapter 38)
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-34" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Increasing stack: pop while top &gt; incoming (nearest smaller)</text>
  <text x="130" y="52" text-anchor="middle" fill="#64748b">scan array →</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="148" y="88" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="88" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="244" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">3</text>
  <text x="244" y="122" text-anchor="middle" fill="#059669" font-weight="700">incoming</text>
  <text x="490" y="52" text-anchor="middle" fill="#64748b">stack (bottom → top)</text>
  <rect x="452" y="150" width="76" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="490" y="172" text-anchor="middle" fill="#1e293b">1  keep</text>
  <rect x="452" y="112" width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="134" text-anchor="middle" fill="#1e293b">5  pop</text>
  <rect x="452" y="74"  width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="96"  text-anchor="middle" fill="#1e293b">6  pop</text>
  <line x1="270" y1="82" x2="448" y2="90" stroke="#475569" marker-end="url(#ar-34)"/>
  <text x="360" y="76" text-anchor="middle" fill="#d97706">3 &lt; 6 and 3 &lt; 5 → pop</text>
  <text x="490" y="214" text-anchor="middle" fill="#059669" font-weight="700">then push 3 → stack [1, 3]</text>
</svg>
```

```text
nums  =   2    1    5    6    3
index     0    1    2    3    4

i=0 v=2  stack empty                  prev[0] = none    push 0 → stack(vals) [2]
i=1 v=1  2 >= 1 → pop 0, next[0] = 1  prev[1] = none    push 1 → [1]
i=2 v=5  1 >= 5? no                   prev[2] = 1       push 2 → [1,5]
i=3 v=6  5 >= 6? no                   prev[3] = 5       push 3 → [1,5,6]
i=4 v=3  6 >= 3 → pop 3, next[3] = 3
         5 >= 3 → pop 2, next[2] = 3
         1 >= 3? no                   prev[4] = 1       push 4 → [1,3]

end: indices 1 and 4 never popped → they have no smaller element to the right

previous smaller : [ --, --,  1,  5,  1 ]     (values; -- = none)
next     smaller : [  1, --,  3,  3, -- ]
```

Five pushes, three pops, one pass — not the ten steps the brute force needed.

### Interview explanation
"For each element I need the nearest smaller one, and the brute force rescans the same
stretch of array over and over. The key observation is that when a new element arrives,
every earlier element that is at least as large is finished forever: the newcomer is its
next-smaller, and it can never be anyone else's previous-smaller because the newcomer is
both nearer and no larger. So I keep a stack of *indices* whose values increase from bottom
to top, pop everything `>=` the incoming value — recording the incoming index as their
answer — and whatever remains on top is the incoming element's previous smaller. Each index
is pushed once and popped at most once, so it's O(n) time and O(n) space."

---

## 5. Generic Templates

> One increasing stack, one pass: **the pop tells you the next smaller, the leftover top tells you the previous smaller.**

```go
// nearestSmaller returns, for every index i, the index of the nearest smaller
// element on each side. prev[i] = -1 and next[i] = len(nums) mean "none".
//
// Pop condition `>=` means: prev[i] is the previous STRICTLY smaller element,
// next[i] is the next SMALLER-OR-EQUAL element. Use `>` to swap the strictness.
func nearestSmaller(nums []int) (prev, next []int) {
	n := len(nums)
	prev, next = make([]int, n), make([]int, n)
	for i := 0; i < n; i++ {
		prev[i], next[i] = -1, n
	}
	stack := make([]int, 0, n) // indices; values increase bottom → top
	for i := 0; i < n; i++ {
		// Everything at least as large as nums[i] is settled by i and dies here.
		for len(stack) > 0 && nums[stack[len(stack)-1]] >= nums[i] {
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
def nearest_smaller(nums):
    """prev[i] = index of previous strictly smaller (-1 if none),
       next[i] = index of next smaller-or-equal (len(nums) if none)."""
    n = len(nums)
    prev, next_ = [-1] * n, [n] * n
    stack = []                                  # indices, values increasing
    for i in range(n):
        while stack and nums[stack[-1]] >= nums[i]:
            next_[stack.pop()] = i              # i settles the popped index
        if stack:
            prev[i] = stack[-1]                 # survivor is strictly smaller
        stack.append(i)
    return prev, next_
```

```java
// prev[i] = previous strictly smaller index (-1), next[i] = next smaller-or-equal (n).
int[][] nearestSmaller(int[] nums) {
    int n = nums.length;
    int[] prev = new int[n], next = new int[n];
    Arrays.fill(prev, -1);
    Arrays.fill(next, n);
    Deque<Integer> stack = new ArrayDeque<>();  // indices, values increasing
    for (int i = 0; i < n; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] >= nums[i])
            next[stack.pop()] = i;
        if (!stack.isEmpty()) prev[i] = stack.peek();
        stack.push(i);
    }
    return new int[][]{prev, next};
}
```

```cpp
// prev[i] = previous strictly smaller index (-1), next[i] = next smaller-or-equal (n).
pair<vector<int>, vector<int>> nearestSmaller(const vector<int>& nums) {
    int n = nums.size();
    vector<int> prev(n, -1), nxt(n, n), stack;   // stack holds indices
    for (int i = 0; i < n; ++i) {
        while (!stack.empty() && nums[stack.back()] >= nums[i]) {
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

| Metric | Brute Force | Monotonic Increasing Stack (Optimal) |
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

### Problem — Daily Temps (LeetCode 739)
Given daily temperatures, return for each day how many days you must wait for a **warmer**
day (0 if none ever comes).

This is a *greater* question, so it uses row 3 of the direction table: same machinery,
**decreasing** stack, pop while `top <= current`. Chapter 39 is devoted to it.

### Thought Process
1. "Days until warmer" = distance to the **next strictly greater** element — so the stack
   must hold *indices*, otherwise the distance is unrecoverable.
2. The stack holds days that are still waiting for a warmer day.
3. When day `i` arrives, every waiting day `j` with `temps[j] < temps[i]` is answered right
   now: `res[j] = i - j`. It is the *first* such day because any earlier warm day would
   already have popped `j`.
4. Push `i`. Days left on the stack at the end keep their default 0.

### Dry Run

Input: `[73, 74, 75, 71, 69, 76]`

| i | t | pops (`j` → `res[j] = i-j`) | stack after (indices) | stack temps |
|---|----|---|---|---|
| 0 | 73 | — | `[0]` | `[73]` |
| 1 | 74 | `0` → `res[0]=1-0=1` | `[1]` | `[74]` |
| 2 | 75 | `1` → `res[1]=2-1=1` | `[2]` | `[75]` |
| 3 | 71 | none (`75 > 71`) | `[2,3]` | `[75,71]` |
| 4 | 69 | none (`71 > 69`) | `[2,3,4]` | `[75,71,69]` |
| 5 | 76 | `4`→`res[4]=1`, `3`→`res[3]=2`, `2`→`res[2]=3` | `[5]` | `[76]` |

Output: **`[1, 1, 3, 2, 1, 0]`**

Row `i=5` is the whole pattern in one line: one warm day settles three pending days in a
single burst, and each of those indices leaves the stack forever. Index 5 is never popped,
so it keeps the default 0.

### Visualization

```text
day     0    1    2    3    4    5
temp   73   74   75   71   69   76
                 └────┬────┴────┘
                      day 5 pops 4, then 3, then 2  (newest first)

waiting stack over time (top on the right):
  [73]  [74]  [75]  [75,71]  [75,71,69]  [76]
         ^ temps in the stack always DECREASE bottom → top

res =   1    1    3    2    1    0
        ↑              ↑
     5-4=1 for day 4, 5-2=3 for day 2 — distances need INDICES
```

### Code

```go
func dailyTemperatures(temps []int) []int {
	res := make([]int, len(temps))
	stack := make([]int, 0, len(temps)) // indices of days still waiting; temps decreasing
	for i, t := range temps {
		for len(stack) > 0 && temps[stack[len(stack)-1]] < t {
			j := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			res[j] = i - j // today is the first warmer day for day j
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
        while stack and temps[stack[-1]] < t:
            j = stack.pop()
            res[j] = i - j
        stack.append(i)
    return res
```

### Complexity
Time O(n) — each day is pushed once and popped at most once, so the inner `while` runs at
most `n` times in total. Space O(n) — the stack in the worst case of a decreasing array.

---

## 10. Solved Example 2

### Problem — Next Greater (LeetCode 496)
`nums1` is a subset of `nums2` (all values distinct). For each value of `nums1`, return the
first value to its **right in `nums2`** that is greater, or `-1`.

### Thought Process
1. Ignore `nums1` at first: solve "next greater element" for the whole of `nums2` in one
   pass with a decreasing stack of indices.
2. When `nums2[i]` beats the stack top `j`, `nums2[i]` is `j`'s answer — record
   `answer[nums2[j]] = nums2[i]` in a map, because `nums1` addresses elements by value.
3. Indices never popped have no greater element to the right → `-1`.
4. Finally look up each element of `nums1` in the map.

### Dry Run

Input: `nums1 = [4, 1, 2]`, `nums2 = [1, 3, 4, 2]`

| i | `nums2[i]` | pops (value → its next greater) | stack after (indices) | stack values | map so far |
|---|---|---|---|---|---|
| 0 | 1 | — | `[0]` | `[1]` | `{}` |
| 1 | 3 | `1 → 3` | `[1]` | `[3]` | `{1:3}` |
| 2 | 4 | `3 → 4` | `[2]` | `[4]` | `{1:3, 3:4}` |
| 3 | 2 | none (`4 > 2`) | `[2,3]` | `[4,2]` | `{1:3, 3:4}` |

Leftovers `4` and `2` never found anything greater → they are absent from the map.
Lookup: `4 → -1`, `1 → 3`, `2 → -1`.

Output: **`[-1, 3, -1]`**

### Visualization

```text
nums2 =  1    3    4    2
         └─▶3 └─▶4      (each pop pairs a value with the element that popped it)

stack values (top right):  [1]  [3]  [4]  [4,2]
                                       ^ never popped → answer -1

nums1 =  4    1    2
         ↓    ↓    ↓
        -1    3   -1
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

## 11. Solved Example 3

### Problem — Largest Rectangle (LeetCode 84)
Given bar heights of a histogram (all bars width 1), return the area of the largest
rectangle that fits inside it.

This is the increasing stack in its natural habitat — see chapter 38 for the full
derivation.

### Thought Process
1. Every candidate rectangle is limited by its shortest bar, so it is enough to ask, for
   each bar `i`: how wide can a rectangle of height `heights[i]` grow?
2. It grows left until a strictly shorter bar and right until a shorter bar — exactly the
   nearest-smaller query this chapter answers.
3. With an increasing stack, popping `i` reveals both boundaries at once: the new stack top
   is the left boundary `left`, the current index is the right boundary `i`, so
   `width = i - left - 1`.
4. Append a sentinel height `0` so every remaining bar is forced out of the stack and
   measured.

### Dry Run

Input: `heights = [2, 1, 5, 6, 2]`, scanned with a virtual sentinel `0` at index 5.

| i | h | pop | popped height | left = new top | width = `i-left-1` | area | best |
|---|---|---|---|---|---|---|---|
| 0 | 2 | — | | | | | 0 |
| 1 | 1 | `0` | 2 | none (−1) | `1-(-1)-1 = 1` | 2 | 2 |
| 2 | 5 | — | | | | | 2 |
| 3 | 6 | — | | | | | 2 |
| 4 | 2 | `3` | 6 | 2 | `4-2-1 = 1` | 6 | 6 |
| 4 | 2 | `2` | 5 | 1 | `4-1-1 = 2` | **10** | **10** |
| 5 | 0 | `4` | 2 | 1 | `5-1-1 = 3` | 6 | 10 |
| 5 | 0 | `1` | 1 | none (−1) | `5-(-1)-1 = 5` | 5 | 10 |

Output: **`10`**

The winning row is `i=4, pop 2`: bar `5` reaches left to index 2 and right to index 3, so
width 2 and area 10. Without the sentinel row the last two rectangles (`2×3` and `1×5`)
would never be measured at all.

### Visualization

```text
index    0    1    2    3    4
height   2    1    5    6    2
                   █    █
                 ┌─██──██─┐          ← height 5, width 2, area 10  ★
              █  │ ██   ██ │  █
              ██ │ ██   ██ │  ██
         ────────┴─────────┴──────

stack (indices, heights increasing bottom → top):
  [0]  →  [1]  →  [1,2]  →  [1,2,3]  →  [1,4]  →  []
   2       1      1,5       1,5,6      1,2     drained by the sentinel
```

### Code

```go
func largestRectangleArea(heights []int) int {
	best := 0
	stack := make([]int, 0, len(heights)+1) // indices; heights increase bottom → top
	for i := 0; i <= len(heights); i++ {
		h := 0 // sentinel at i == len(heights) forces every bar out
		if i < len(heights) {
			h = heights[i]
		}
		for len(stack) > 0 && heights[stack[len(stack)-1]] >= h {
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			left := -1 // no shorter bar on the left → rectangle starts at index 0
			if len(stack) > 0 {
				left = stack[len(stack)-1]
			}
			if area := heights[top] * (i - left - 1); area > best {
				best = area
			}
		}
		stack = append(stack, i)
	}
	return best
}
```

```python
def largestRectangleArea(heights):
    best = 0
    stack = []                                  # indices, heights increasing
    for i in range(len(heights) + 1):
        h = heights[i] if i < len(heights) else 0   # sentinel drains the stack
        while stack and heights[stack[-1]] >= h:
            height = heights[stack.pop()]
            left = stack[-1] if stack else -1
            best = max(best, height * (i - left - 1))
        stack.append(i)
    return best
```

### Complexity
Time O(n) — `n+1` pushes and at most `n+1` pops. Space O(n) — the stack holds at most every
index once (a strictly increasing histogram).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 739 | Daily Temps | Easy | Core stacks application |
| 496 | Next Greater | Easy | Core stacks application |
| 84 | Largest Rectangle | Medium | Core stacks application |
| 901 | Stock Span | Medium | Core stacks application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Monotonic Increasing Stack logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Monotonic Increasing Stack (Stacks).
- **Signal:** monotonic stack, increasing, previous smaller, next smaller.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Monotonic Increasing Stack invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Monotonic Increasing Stack
FAMILY : Stacks (Intermediate)
WHEN   : monotonic stack, increasing, previous smaller, next smaller
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 739, 496, 84, 901
```

---

*Part of the DSA Patterns Handbook — pattern 34 of 100.*
