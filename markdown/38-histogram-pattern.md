# 38 · Histogram Pattern

> **One-liner:** Monotonic stack finds the largest rectangle under a histogram.

---

## 1. Overview

### Definition
The **Histogram Pattern** pattern belongs to the *Stacks* family. Monotonic stack finds the largest rectangle under a histogram.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
histogram, largest rectangle, monotonic stack, area, maximal.

### Constraints
- Input size where the brute-force complexity would time out — the Histogram Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Histogram Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Histogram Pattern is the upgrade.
- The wording maps onto: histogram, largest rectangle, monotonic stack, area, maximal.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"For each bar, how far can a rectangle of that height stretch before it hits something shorter?"*

### Intuition
Fix each bar as the limiting height, then walk outward in both directions while the bars stay at least that tall.

### Algorithm
1. For each index `i`:
2. &nbsp;&nbsp;Walk left from `i` while `heights[left] >= heights[i]`.
3. &nbsp;&nbsp;Walk right from `i` while `heights[right] >= heights[i]`.
4. &nbsp;&nbsp;`area = heights[i] × (right − left − 1)`.
5. Keep the maximum.

### Complexity
- Time: **O(n²)** — each bar may scan the whole array.
- Space: O(1).

### Drawbacks
- On a sorted-ascending histogram like `[1,2,3,…,n]`, every bar walks all the way left. That is the full quadratic cost.
- And it is redundant: while walking left from bar `i`, we re-derive facts we already established when we processed bar `i−1`. Nothing is remembered between iterations.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Every rectangle is capped by its shortest bar — so for each bar, find the first shorter bar to its left and to its right. A stack finds all of them in one pass.**

The bar at `i` can extend until it meets something **strictly shorter**. Those two positions are its boundaries:

```text
width = rightSmaller - leftSmaller - 1
area  = heights[i] * width
```

The only hard part is computing `leftSmaller` and `rightSmaller` for every `i` cheaply. That is exactly what a **monotonic stack** does.

### The thought process

```text
We need    : for each bar, the nearest strictly-shorter bar on each side.
Obvious way: scan outward from every bar.
Too slow   : O(n^2), and it re-derives the same facts repeatedly.
Notice     : while scanning left to right, when a SHORT bar arrives,
             it is the right boundary for every taller bar behind it —
             and those taller bars can never be a boundary for anything
             further right, because this shorter bar blocks them.
Therefore  : keep a stack of indices with increasing heights.
             A new shorter bar pops them, and each pop settles one
             bar's rectangle completely.
Now        : each index is pushed once and popped once → O(n).
```

### Why a stack, and why it stays increasing

Think about what the stack means at any moment:

> The stack holds the bars that are **still waiting** for their right boundary — bars nothing shorter has appeared after yet.

That set is automatically increasing in height. If a taller bar sat above a shorter one, the shorter one would have popped it on arrival. So:

- **The bar below you on the stack is your nearest shorter bar on the left.** Everything between you and it was taller and already popped.
- **The bar that pops you is your nearest shorter bar on the right.**

Both boundaries come for free from the stack's structure. That is the whole trick.

### Steps

```text
Step 1 → Empty stack of indices; best = 0.
Step 2 → For i = 0 .. n  (n is a sentinel bar of height 0):
Step 3 →     While the stack is non-empty and heights[stack.top] >= current:
Step 4 →         top    = pop
Step 5 →         height = heights[top]
Step 6 →         width  = stack empty ? i : i - stack.top - 1
Step 7 →         best   = max(best, height * width)
Step 8 →     Push i.
Step 9 → Return best.
```

### Why the width formula looks the way it does

After popping `top`, the new stack top is `top`'s nearest shorter bar on the left, and `i` is its nearest shorter bar on the right. The rectangle spans everything strictly between them:

```text
       leftSmaller        top        rightSmaller
            ↓              ↓              ↓
   ...  [   2   ][  5  ][  6  ][   2   ] ...
            1      2      3       4          ← indices

   width = 4 - 1 - 1 = 2      (indices 2 and 3)
```

If the stack empties, no shorter bar exists to the left, so the rectangle reaches index 0 and the width is simply `i`.

### Why the sentinel bar of height 0

When the loop ends, bars may still be on the stack — those that never met anything shorter. Running one extra iteration at `i = n` with height `0` forces every one of them to pop and be measured. Without it you would need a duplicate drain loop after the main loop; the sentinel folds that into the same code path.

### Why `>=` rather than `>` in the pop test

With equal heights, popping on `>=` settles the earlier bar with a *too-small* width. That looks like a bug but isn't: the later equal bar is still on the stack and will eventually be measured with the **full** width, which covers the same rectangle. The maximum is unaffected, and `>=` keeps the stack strictly increasing, which keeps the "bar below me is my left boundary" invariant exact.

### How should I recognize this?

```text
If you see...
  "largest rectangle", "maximal rectangle in a matrix"
  "for each element, the nearest smaller/greater one"
  a histogram, skyline of bars, or a binary matrix of 0/1
        ↓
Think about...
  "What are this element's boundaries, and can a stack
   hand me both of them as it pops?"
        ↓
Use...
  monotonic INCREASING stack → nearest smaller elements
  monotonic DECREASING stack → nearest greater elements
  matrix version → run the histogram routine once per row
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-38" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Largest rectangle in histogram: pop fixes each bar's width</text>
  <line x1="30" y1="200" x2="470" y2="200" stroke="#475569"/>
  <rect x="40"  y="152" width="44" height="48"  fill="#eff6ff" stroke="#2563eb"/><text x="62"  y="220" text-anchor="middle" fill="#64748b">2</text>
  <rect x="88"  y="176" width="44" height="24"  fill="#eff6ff" stroke="#2563eb"/><text x="110" y="220" text-anchor="middle" fill="#64748b">1</text>
  <rect x="136" y="80"  width="44" height="120" fill="#ecfdf5" stroke="#059669"/><text x="158" y="220" text-anchor="middle" fill="#64748b">5</text>
  <rect x="184" y="56"  width="44" height="144" fill="#ecfdf5" stroke="#059669"/><text x="206" y="220" text-anchor="middle" fill="#64748b">6</text>
  <rect x="232" y="152" width="44" height="48"  fill="#eff6ff" stroke="#2563eb"/><text x="254" y="220" text-anchor="middle" fill="#64748b">2</text>
  <rect x="280" y="128" width="44" height="72"  fill="#eff6ff" stroke="#2563eb"/><text x="302" y="220" text-anchor="middle" fill="#64748b">3</text>
  <rect x="136" y="80" width="92" height="120" fill="none" stroke="#059669" stroke-width="3" stroke-dasharray="6 4"/>
  <text x="182" y="70" text-anchor="middle" fill="#059669" font-weight="700">area = 5 × 2 = 10</text>
  <text x="560" y="90"  text-anchor="middle" fill="#64748b">when a shorter</text>
  <text x="560" y="108" text-anchor="middle" fill="#64748b">bar arrives, pop</text>
  <text x="560" y="126" text-anchor="middle" fill="#64748b">taller bars and</text>
  <text x="560" y="144" text-anchor="middle" fill="#64748b">settle their area</text>
  <line x1="330" y1="150" x2="470" y2="150" stroke="#475569" marker-end="url(#ar-38)"/>
  <text x="400" y="142" text-anchor="middle" fill="#d97706">2 &lt; 6 → pop</text>
</svg>
```

```text
heights = [2, 1, 5, 6, 2, 3]

  6 |          █
  5 |       ▓▓▓█            ▓ = the winning rectangle
  4 |       ▓▓▓█               height 5, width 2 → area 10
  3 |       ▓▓▓█        █
  2 | █     ▓▓▓█  █     █
  1 | █  █  ▓▓▓█  █     █
    +──────────────────────
      0  1  2  3  4  5

bar 2 (height 5): blocked left by bar 1 (height 1)
                  blocked right by bar 4 (height 2)
    ⇒ width = 4 - 1 - 1 = 2,  area = 5 × 2 = 10
```

### Interview explanation
"Every rectangle is limited by its shortest bar, so for each bar I need the first strictly-shorter bar on each side. I get both with a monotonic increasing stack of indices. When a shorter bar arrives it pops everything taller — and for each popped bar, the popper is its right boundary and whatever is left underneath on the stack is its left boundary, so `width = i − stack.top − 1`. I append a sentinel bar of height 0 so everything still on the stack gets drained and measured. Each index is pushed and popped exactly once, so it's O(n) time and O(n) space."

---

## 5. Generic Templates

> Increasing stack of indices. A shorter arrival pops and settles; a sentinel drains the rest.

```go
// LargestRectangleArea computes the biggest rectangle in a histogram.
func LargestRectangleArea(heights []int) int {
    stack := []int{} // indices, heights strictly increasing bottom → top
    best := 0

    // i == len(heights) acts as a sentinel bar of height 0 that drains the stack.
    for i := 0; i <= len(heights); i++ {
        current := 0
        if i < len(heights) {
            current = heights[i]
        }

        for len(stack) > 0 && heights[stack[len(stack)-1]] >= current {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]

            height := heights[top]
            // After popping, the new top is top's nearest shorter bar on the
            // left; i is its nearest shorter bar on the right.
            width := i
            if len(stack) > 0 {
                width = i - stack[len(stack)-1] - 1
            }
            if area := height * width; area > best {
                best = area
            }
        }
        stack = append(stack, i)
    }
    return best
}

// NearestSmallerLeft returns, for each i, the index of the nearest strictly
// smaller element to the left, or -1. This is the stack's other product.
func NearestSmallerLeft(nums []int) []int {
    result := make([]int, len(nums))
    stack := []int{}

    for i, v := range nums {
        for len(stack) > 0 && nums[stack[len(stack)-1]] >= v {
            stack = stack[:len(stack)-1]
        }
        if len(stack) == 0 {
            result[i] = -1
        } else {
            result[i] = stack[len(stack)-1]
        }
        stack = append(stack, i)
    }
    return result
}
```

```python
def largest_rectangle_area(heights):
    """Biggest rectangle in a histogram, via a monotonic increasing stack."""
    stack = []                       # indices, heights increasing
    best = 0

    for i in range(len(heights) + 1):
        current = heights[i] if i < len(heights) else 0    # sentinel drains it

        while stack and heights[stack[-1]] >= current:
            height = heights[stack.pop()]
            # new stack top = nearest shorter bar on the left; i = on the right
            width = i if not stack else i - stack[-1] - 1
            best = max(best, height * width)

        stack.append(i)
    return best

def nearest_smaller_left(nums):
    """Index of the nearest strictly smaller element to the left, or -1."""
    result, stack = [], []
    for i, v in enumerate(nums):
        while stack and nums[stack[-1]] >= v:
            stack.pop()
        result.append(stack[-1] if stack else -1)
        stack.append(i)
    return result
```

```java
import java.util.*;

public class HistogramPattern {
    public static int largestRectangleArea(int[] heights) {
        Deque<Integer> stack = new ArrayDeque<>();   // indices, increasing heights
        int best = 0;

        for (int i = 0; i <= heights.length; i++) {
            int current = (i < heights.length) ? heights[i] : 0;   // sentinel

            while (!stack.isEmpty() && heights[stack.peek()] >= current) {
                int height = heights[stack.pop()];
                int width = stack.isEmpty() ? i : i - stack.peek() - 1;
                best = Math.max(best, height * width);
            }
            stack.push(i);
        }
        return best;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

int largestRectangleArea(const vector<int>& heights) {
    vector<int> stack;                       // indices, increasing heights
    int best = 0;
    int n = (int)heights.size();

    for (int i = 0; i <= n; ++i) {
        int current = (i < n) ? heights[i] : 0;              // sentinel

        while (!stack.empty() && heights[stack.back()] >= current) {
            int height = heights[stack.back()];
            stack.pop_back();
            int width = stack.empty() ? i : i - stack.back() - 1;
            best = max(best, height * width);
        }
        stack.push_back(i);
    }
    return best;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Histogram Pattern (Optimal) |
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

### Problem — Largest Rectangle in Histogram (LeetCode 84)
Find the area of the largest rectangle that fits inside the histogram.

### Thought Process
1. Any rectangle is capped by its shortest bar, so ask per bar: how wide can a rectangle of *this* height be?
2. It stretches until it meets a strictly shorter bar on each side.
3. A monotonic **increasing** stack of indices delivers both boundaries: whatever pops you is your right boundary, whatever sits below you is your left one.
4. `width = i − stack.top − 1` after the pop; if the stack empties, the bar reaches index 0 so `width = i`.
5. A sentinel bar of height `0` at index `n` drains everything still waiting.

### Dry Run

Input: `heights = [2, 1, 5, 6, 2, 3]`, plus a sentinel `0` at index 6

| i | height | stack before | pops (height × width = area) | stack after | best |
|---|--------|--------------|------------------------------|-------------|------|
| 0 | 2 | `[]`      | — | `[0]`     | 0 |
| 1 | 1 | `[0]`     | pop 0: `2 × 1 = 2` (stack empty → width = `i` = 1) | `[1]` | 2 |
| 2 | 5 | `[1]`     | — (`1 < 5`) | `[1,2]`   | 2 |
| 3 | 6 | `[1,2]`   | — (`5 < 6`) | `[1,2,3]` | 2 |
| 4 | 2 | `[1,2,3]` | pop 3: `6 × (4−2−1) = 6 × 1 = 6`<br>pop 2: `5 × (4−1−1) = 5 × 2 = **10**` | `[1,4]` | **10** |
| 5 | 3 | `[1,4]`   | — (`2 < 3`) | `[1,4,5]` | 10 |
| 6 | 0 (sentinel) | `[1,4,5]` | pop 5: `3 × (6−4−1) = 3 × 1 = 3`<br>pop 4: `2 × (6−1−1) = 2 × 4 = 8`<br>pop 1: `1 × 6 = 6` (stack empty → width = `i` = 6) | `[6]` | 10 |

Output: **10** — height 5 spanning indices 2 and 3.

Look at `i = 4`: bar 6 pops first with width 1 (it is hemmed in by bars 5 and 2), then bar 5 pops with width 2 — because bar 6 was taller, it doesn't block bar 5, so bar 5 stretches across both indices 2 and 3. That is the stack handing back the left boundary automatically.

### Visualization

```text
index :  0  1  2  3  4  5
height:  2  1  5  6  2  3

  6 |          █
  5 |       ▓▓▓█
  4 |       ▓▓▓█
  3 |       ▓▓▓█        █
  2 | █     ▓▓▓█  █     █
  1 | █  █  ▓▓▓█  █     █
    +──────────────────────

bar 2 (height 5): left boundary bar 1 (height 1), right boundary bar 4 (height 2)
    width = 4 - 1 - 1 = 2   →   area 10  ★
```

### Code

```go
func largestRectangleArea(heights []int) int {
    stack := []int{} // indices; heights increase from bottom to top
    best := 0

    // i == len(heights) is a sentinel bar of height 0 that drains the stack.
    for i := 0; i <= len(heights); i++ {
        current := 0
        if i < len(heights) {
            current = heights[i]
        }

        for len(stack) > 0 && heights[stack[len(stack)-1]] >= current {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]

            height := heights[top]
            // The new stack top is top's nearest shorter bar on the left;
            // i is its nearest shorter bar on the right.
            width := i
            if len(stack) > 0 {
                width = i - stack[len(stack)-1] - 1
            }
            if area := height * width; area > best {
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
    stack = []                        # indices; heights increasing
    best = 0

    for i in range(len(heights) + 1):
        current = heights[i] if i < len(heights) else 0     # sentinel drains it

        while stack and heights[stack[-1]] >= current:
            height = heights[stack.pop()]
            # new stack top = nearest shorter on the left; i = nearest on the right
            width = i if not stack else i - stack[-1] - 1
            best = max(best, height * width)

        stack.append(i)
    return best
```

### Complexity
Time **O(n)** — each index is pushed once and popped once. Space O(n).

---

## 10. Solved Example 2

### Problem — Maximal Rectangle (LeetCode 85)
Given a binary matrix of `'0'` and `'1'` characters, find the largest rectangle containing only `'1'`s.

### Thought Process
1. This looks two-dimensional, but there is a reduction that makes it one-dimensional.
2. **Treat each row as the ground line of a histogram.** For row `i`, the bar at column `j` is the number of consecutive `'1'`s ending at `(i, j)` going upward.
3. Any all-ones rectangle whose bottom edge lies on row `i` is exactly a rectangle in that histogram.
4. So: build the histogram incrementally per row, run the O(n) routine from Example 1, and keep the best across all rows.
5. Updating the heights is O(1) per cell: `'1'` → `height + 1`, `'0'` → reset to `0`.

### Dry Run

Input:

```text
1 0 1 0 0
1 0 1 1 1
1 1 1 1 1
1 0 0 1 0
```

| row | heights after this row | largest rectangle in that histogram |
|-----|------------------------|-------------------------------------|
| 0 | `[1, 0, 1, 0, 0]` | 1 |
| 1 | `[2, 0, 2, 1, 1]` | 3 — height 1 across columns 2–4 |
| 2 | `[3, 1, 3, 2, 2]` | **6** — height 2 across columns 2–4 |
| 3 | `[4, 0, 0, 3, 0]` | 4 — the single column of height 4 |

Output: **6**

Row 2 is the winner. Its histogram `[3,1,3,2,2]` has a height-2 rectangle spanning columns 2, 3, 4 — which back in the matrix is the 2×3 block of ones on rows 1 and 2. ✓

Notice the reset at row 3, column 2: the matrix has a `'0'` there, so the height drops from `3` to `0` rather than decreasing by one. A zero breaks the column completely.

### Visualization

```text
matrix            heights (row 2)      histogram
1 0 1 0 0
1 0 1 1 1          3 1 3 2 2            3 |█   █
1 1 1 1 1 ←row 2                        2 |█   █▓▓█▓▓█    ▓ = area 6
1 0 0 1 0                               1 |█ █ █▓▓█▓▓█
                                          +───────────
                                           0 1 2 3 4
```

### Code

```go
func maximalRectangle(matrix [][]byte) int {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return 0
    }

    heights := make([]int, len(matrix[0]))
    best := 0

    for _, row := range matrix {
        // Each row becomes the ground line of a histogram.
        for j, cell := range row {
            if cell == '1' {
                heights[j]++ // the column of ones grows
            } else {
                heights[j] = 0 // a zero breaks the column entirely
            }
        }
        if area := maxRectInHistogram(heights); area > best {
            best = area
        }
    }
    return best
}

// maxRectInHistogram is Example 1's routine, unchanged.
func maxRectInHistogram(heights []int) int {
    stack := []int{}
    best := 0

    for i := 0; i <= len(heights); i++ {
        current := 0
        if i < len(heights) {
            current = heights[i]
        }
        for len(stack) > 0 && heights[stack[len(stack)-1]] >= current {
            height := heights[stack[len(stack)-1]]
            stack = stack[:len(stack)-1]
            width := i
            if len(stack) > 0 {
                width = i - stack[len(stack)-1] - 1
            }
            if area := height * width; area > best {
                best = area
            }
        }
        stack = append(stack, i)
    }
    return best
}
```

```python
def maximalRectangle(matrix):
    if not matrix or not matrix[0]:
        return 0

    heights = [0] * len(matrix[0])
    best = 0

    for row in matrix:
        for j, cell in enumerate(row):
            heights[j] = heights[j] + 1 if cell == "1" else 0   # 0 breaks the column
        best = max(best, largestRectangleArea(heights))          # reuse Example 1
    return best
```

### Complexity
Time **O(rows × cols)** — one O(cols) histogram pass per row. Space O(cols).

---

## 11. Solved Example 3

### Problem — Count Submatrices With All Ones (LeetCode 1504)
Count how many submatrices consist entirely of `1`s.

### Thought Process
1. Same histogram reduction, but now we **count** rectangles instead of maximising one.
2. Build the same per-column heights. Then count submatrices whose **bottom-right corner** is `(i, j)` — every submatrix has exactly one, so no double counting.
3. Fix `(i, j)` and walk left with `k = j, j−1, …`, tracking `minHeight = min(minHeight, heights[k])`.
4. For each `k`, the widths `k..j` support exactly `minHeight` rectangles (one for each possible height from 1 up to `minHeight`). Add it.
5. `minHeight` only ever decreases as we walk left, which is what keeps the count correct.

### Dry Run

Input:

```text
1 0 1
1 1 0
1 1 0
```

**Heights per row:**

| row | heights |
|-----|---------|
| 0 | `[1, 0, 1]` |
| 1 | `[2, 1, 0]` |
| 2 | `[3, 2, 0]` |

**Counting, row by row** (for each `j`, walk `k` left tracking `minHeight`):

| row | j | walk `k` (minHeight → contribution) | row subtotal |
|-----|---|--------------------------------------|--------------|
| 0 | 0 | k=0: min 1 → +1 | |
| 0 | 1 | k=1: min 0 → +0 | |
| 0 | 2 | k=2: min 1 → +1; k=1: min 0 → +0; k=0: min 0 → +0 | **2** |
| 1 | 0 | k=0: min 2 → +2 | |
| 1 | 1 | k=1: min 1 → +1; k=0: min 1 → +1 | |
| 1 | 2 | heights[2] = 0 → all zero | **4** |
| 2 | 0 | k=0: min 3 → +3 | |
| 2 | 1 | k=1: min 2 → +2; k=0: min 2 → +2 | |
| 2 | 2 | heights[2] = 0 → all zero | **7** |

Total: `2 + 4 + 7` = **13**

Output: **13** ✓

Take row 2, `j = 1`: `heights = [3, 2, 0]`. At `k = 1` the min is 2, giving the 1×1 and 2×1 submatrices ending at that cell. At `k = 0` the min is still `min(2, 3) = 2`, giving the 1×2 and 2×2 ones. The taller column 0 is clamped by column 1 — which is exactly the "shortest bar caps the rectangle" rule again.

### Visualization

```text
row 2 heights:  3  2  0
                █  █
                █  █
                █

bottom-right at (2,1), walking left:

  k=1 : minHeight 2  →  2 rectangles   (1×1, 2×1)
  k=0 : minHeight 2  →  2 rectangles   (1×2, 2×2)
        (column 0 is height 3 but clamped by column 1)

  contribution from j=1: 4
```

### Code

```go
func numSubmat(mat [][]int) int {
    if len(mat) == 0 || len(mat[0]) == 0 {
        return 0
    }
    cols := len(mat[0])
    heights := make([]int, cols)
    total := 0

    for _, row := range mat {
        for j := 0; j < cols; j++ {
            if row[j] == 1 {
                heights[j]++
            } else {
                heights[j] = 0
            }
        }

        // Count submatrices whose bottom-right corner is (thisRow, j).
        for j := 0; j < cols; j++ {
            minHeight := heights[j]
            for k := j; k >= 0 && minHeight > 0; k-- {
                if heights[k] < minHeight {
                    minHeight = heights[k] // the shortest column caps the block
                }
                total += minHeight // one rectangle per height 1..minHeight
            }
        }
    }
    return total
}
```

```python
def numSubmat(mat):
    if not mat or not mat[0]:
        return 0
    cols = len(mat[0])
    heights = [0] * cols
    total = 0

    for row in mat:
        for j in range(cols):
            heights[j] = heights[j] + 1 if row[j] == 1 else 0

        for j in range(cols):                  # bottom-right corner at (row, j)
            min_height = heights[j]
            for k in range(j, -1, -1):
                if min_height == 0:
                    break
                min_height = min(min_height, heights[k])   # shortest column caps it
                total += min_height            # one per height 1..min_height
    return total
```

### Complexity
Time **O(rows × cols²)** — the inner leftward walk is what costs the extra factor. Space O(cols).

> There is an O(rows × cols) version using a monotonic stack that maintains the running count instead of re-walking left. It is faster but considerably harder to justify under interview pressure; this version is the one to write first and optimise only if asked.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 84 | Largest Rectangle | Easy | Core stacks application |
| 85 | Maximal Rectangle | Easy | Core stacks application |
| 1504 | Submatrices | Medium | Core stacks application |
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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Histogram Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Histogram Pattern (Stacks).
- **Signal:** histogram, largest rectangle, monotonic stack, area, maximal.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Histogram Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Histogram Pattern
FAMILY : Stacks (Advanced)
WHEN   : histogram, largest rectangle, monotonic stack, area, maximal
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 84, 85, 1504, 42
```

---

*Part of the DSA Patterns Handbook — pattern 38 of 100.*
