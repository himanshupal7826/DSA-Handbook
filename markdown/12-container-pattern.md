# 12 · Container Pattern

> **One-liner:** Greedy two-pointer maximizing area by moving the limiting boundary.

---

## 1. Overview

### Definition
The **Container Pattern** pattern belongs to the *Two Pointers* family. Greedy two-pointer maximizing area by moving the limiting boundary.

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
container, water, area, max area, trapping rain, two pointer.

### Constraints
- Input size where the brute-force complexity would time out — the Container Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Container Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Container Pattern is the upgrade.
- The wording maps onto: container, water, area, max area, trapping rain, two pointer.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How much can be held between two boundaries?"* — where the answer is always capped by the **weaker** boundary.

### Intuition
Try every possible pair of boundaries and measure what they hold.

### Algorithm (max-water container)
1. For each `left` from `0` to `n−1`:
2. &nbsp;&nbsp;For each `right` from `left+1` to `n−1`:
3. &nbsp;&nbsp;&nbsp;&nbsp;`area = (right − left) × min(height[left], height[right])`.
4. Keep the maximum.

### Complexity
- Time: **O(n²)**.
- Space: O(1).

### Drawbacks
- At `n = 10⁵`, that's 5 × 10⁹ pairs.
- The wasted effort has a clear shape: after computing one pair we learn something about a *whole family* of other pairs, and then throw that knowledge away.

For trapping rain water the naive version is even worse: for every index, scan left for the tallest bar and right for the tallest bar — O(n²) with a lot of repeated scanning.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **What you can hold is decided by the **shorter** of the two walls — so the shorter wall is the one that must move.**

Every container problem is this same sentence with different nouns:

| Problem | The two boundaries | Capacity formula |
|---|---|---|
| Container with most water | two chosen lines | `width × min(leftHeight, rightHeight)` |
| Trapping rain water | tallest bar to the left / right | `min(leftMax, rightMax) − height[i]` |
| Largest rectangle in histogram | first shorter bar left / right | `height[i] × (right − left − 1)` |

Notice the `min` in every row. That is the whole family.

### The thought process

```text
We need    : the best "capacity" between two boundaries.
Obvious way: try every pair of boundaries.
Too slow   : O(n^2).
Notice     : capacity is capped by the SHORTER wall.
             So keeping the shorter wall can never help —
             its cap follows it everywhere, and the width only shrinks.
Therefore  : start at maximum width and always discard the shorter wall.
Now        : each step retires one index → O(n).
```

### Why discarding the shorter wall is safe

Say `height[left] < height[right]`. Could `left` do better with some closer partner `right' < right`?

```text
area with right'  =  (right' - left)  ×  min(height[left], height[right'])
                      └── smaller ──┘     └──── still at most height[left] ────┘
```

The width strictly shrank and the height is still capped by `height[left]`. So **no** pair keeping `left` can beat the area we just measured. `left` is finished — advance it.

That's one index retired per step, so the sweep is O(n).

### The second shape: precomputed boundaries (rain water)

Trapping rain water asks a slightly different question — not "which pair is best" but "how much sits above *each* index":

```text
water[i] = min(maxToTheLeft[i], maxToTheRight[i]) - height[i]
```

The direct way is two prefix passes: build `leftMax[]` scanning right, `rightMax[]` scanning left, then sum. That's O(n) time, O(n) space, and is genuinely easier to reason about.

The two-pointer version removes the arrays. The trick is knowing **which side is safe to settle**:

> If `height[left] < height[right]`, then `rightMax ≥ height[right] > height[left]`.
> So for index `left`, the `min(leftMax, rightMax)` is guaranteed to be `leftMax` —
> we can settle it now without ever knowing the real `rightMax`.

That single implication is what makes the O(1)-space version correct. If it doesn't click yet, write the two-array version in the interview first; it's fully correct and easy to defend.

### The third shape: nearest smaller boundary (histogram)

For the largest rectangle, the boundaries of the bar at `i` are *the first bar shorter than it* on each side. Finding those for every `i` is the **monotonic stack** pattern:

- Keep a stack of indices whose heights are increasing.
- When a shorter bar arrives, it is the right boundary for everything taller — pop and settle them.
- After popping, the new stack top is the left boundary.

### Steps (max-water container)

```text
Step 1 → left = 0, right = n-1, best = 0.
Step 2 → While left < right:
Step 3 →     h = min(height[left], height[right])
Step 4 →     best = max(best, (right - left) * h)
Step 5 →     move the pointer at the SHORTER wall inward
Step 6 → Return best.
```

### How should I recognize this?

```text
If you see...
  "how much water", "container", "trap", "area between bars"
  "largest rectangle", "how much can be held"
  a picture in the problem statement with bars or walls
        ↓
Think about...
  "What are the two boundaries, and which one is the bottleneck?"
        ↓
Use...
  best pair overall      → two pointers, discard the shorter wall
  per-index capacity     → leftMax / rightMax arrays, or two pointers
  nearest smaller bound  → monotonic stack
```

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="cp-12" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Area = min(height) × width · move the shorter wall inward</text>
  <line x1="60" y1="210" x2="590" y2="210" stroke="#64748b"/>
  <rect x="85" y="165" width="420" height="45" fill="#fff7ed" stroke="#d97706"/>
  <text x="295" y="193" text-anchor="middle" fill="#d97706" font-weight="700">area = 3 × 6 = 18</text>
  <g>
    <rect x="70"  y="165" width="30" height="45"  rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
    <rect x="140" y="90"  width="30" height="120" rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="210" y="120" width="30" height="90"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="280" y="180" width="30" height="30"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="350" y="135" width="30" height="75"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="420" y="150" width="30" height="60"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="490" y="75"  width="30" height="135" rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  </g>
  <text x="85"  y="228" text-anchor="middle" fill="#059669" font-weight="700">L = 3</text>
  <text x="505" y="228" text-anchor="middle" fill="#059669" font-weight="700">R = 9</text>
  <line x1="100" y1="150" x2="150" y2="150" stroke="#475569" marker-end="url(#cp-12)"/>
  <text x="150" y="146" text-anchor="middle" fill="#64748b">move shorter (L) →</text>
</svg>
```

```text
height = [1, 8, 6, 2, 5, 4, 8, 3, 7]

  8 |    █           █
  6 |    █  █        █
  5 |    █  █     █  █
  4 |    █  █  █  █  █        █
  1 | █  █  █  █  █  █  █  █  █
    +──────────────────────────
      0  1  2  3  4  5  6  7  8
         ↑                    ↑
       left=1              right=8

  width 7 × min(8, 7) = 7  →  area 49
  the RIGHT wall (7) is shorter → it is the bottleneck → move it
```

### Interview explanation
"Every container problem is capped by the shorter of its two boundaries. So I start with the widest pair and repeatedly discard the shorter wall — keeping it can't help, because its height caps the result no matter who it pairs with, and moving inward only shrinks the width. Each step retires one index, so it's O(n) time and O(1) space. For trapping rain water the same reasoning applies per index: whichever side is shorter is the side whose `max` is definitely the binding constraint, so I can settle that index immediately."

---

## 5. Generic Templates

> Two boundaries, a `min`, and a rule for which boundary to move.

```go
// MaxArea: best pair of walls. Discard the shorter wall each step.
func MaxArea(height []int) int {
    left, right, best := 0, len(height)-1, 0
    for left < right {
        h := height[left]
        if height[right] < h {
            h = height[right] // the shorter wall caps the water
        }
        if area := (right - left) * h; area > best {
            best = area
        }
        if height[left] < height[right] {
            left++ // the short wall can never do better
        } else {
            right--
        }
    }
    return best
}

// TrapTwoArrays: per-index capacity, the easy-to-defend O(n) space version.
func TrapTwoArrays(height []int) int {
    n := len(height)
    if n == 0 {
        return 0
    }

    leftMax := make([]int, n)
    leftMax[0] = height[0]
    for i := 1; i < n; i++ {
        leftMax[i] = max(leftMax[i-1], height[i])
    }

    rightMax := make([]int, n)
    rightMax[n-1] = height[n-1]
    for i := n - 2; i >= 0; i-- {
        rightMax[i] = max(rightMax[i+1], height[i])
    }

    total := 0
    for i := 0; i < n; i++ {
        total += min(leftMax[i], rightMax[i]) - height[i]
    }
    return total
}

func max(a, b int) int {
    if a > b {
        return a
    }
    return b
}

func min(a, b int) int {
    if a < b {
        return a
    }
    return b
}
```

```python
def max_area(height):
    """Best pair of walls: discard the shorter wall each step."""
    left, right, best = 0, len(height) - 1, 0
    while left < right:
        h = min(height[left], height[right])       # shorter wall caps it
        best = max(best, (right - left) * h)
        if height[left] < height[right]:
            left += 1                              # short wall can't improve
        else:
            right -= 1
    return best

def trap_two_arrays(height):
    """Per-index capacity, O(n) space, easy to reason about."""
    n = len(height)
    if n == 0:
        return 0

    left_max = [0] * n
    left_max[0] = height[0]
    for i in range(1, n):
        left_max[i] = max(left_max[i - 1], height[i])

    right_max = [0] * n
    right_max[n - 1] = height[n - 1]
    for i in range(n - 2, -1, -1):
        right_max[i] = max(right_max[i + 1], height[i])

    return sum(min(left_max[i], right_max[i]) - height[i] for i in range(n))
```

```java
public class ContainerPattern {
    public static int maxArea(int[] height) {
        int left = 0, right = height.length - 1, best = 0;
        while (left < right) {
            int h = Math.min(height[left], height[right]);   // shorter wall caps it
            best = Math.max(best, (right - left) * h);
            if (height[left] < height[right]) left++;        // short wall can't improve
            else right--;
        }
        return best;
    }

    public static int trapTwoArrays(int[] height) {
        int n = height.length;
        if (n == 0) return 0;

        int[] leftMax = new int[n];
        leftMax[0] = height[0];
        for (int i = 1; i < n; i++) leftMax[i] = Math.max(leftMax[i - 1], height[i]);

        int[] rightMax = new int[n];
        rightMax[n - 1] = height[n - 1];
        for (int i = n - 2; i >= 0; i--) rightMax[i] = Math.max(rightMax[i + 1], height[i]);

        int total = 0;
        for (int i = 0; i < n; i++) total += Math.min(leftMax[i], rightMax[i]) - height[i];
        return total;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

int maxArea(const vector<int>& height) {
    int left = 0, right = (int)height.size() - 1, best = 0;
    while (left < right) {
        int h = min(height[left], height[right]);        // shorter wall caps it
        best = max(best, (right - left) * h);
        if (height[left] < height[right]) ++left;        // short wall can't improve
        else --right;
    }
    return best;
}

int trapTwoArrays(const vector<int>& height) {
    int n = (int)height.size();
    if (n == 0) return 0;

    vector<int> leftMax(n), rightMax(n);
    leftMax[0] = height[0];
    for (int i = 1; i < n; ++i) leftMax[i] = max(leftMax[i - 1], height[i]);
    rightMax[n - 1] = height[n - 1];
    for (int i = n - 2; i >= 0; --i) rightMax[i] = max(rightMax[i + 1], height[i]);

    int total = 0;
    for (int i = 0; i < n; ++i) total += min(leftMax[i], rightMax[i]) - height[i];
    return total;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Container Pattern (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n) or O(n log n)** |
| Time (best)  | — | **O(n) or O(n log n)** |
| Time (average) | — | **O(n) or O(n log n)** |
| Space | varies | **O(1)** |

> Sorting (if needed) dominates; the scan itself is O(n).

---

## 7. Common Mistakes

1. Forgetting to sort first when the technique requires sorted input.
2. Not skipping duplicates, producing repeated triplets/quadruplets.
3. Using `l <= r` when `l < r` is intended (or vice versa).
4. Advancing the wrong pointer and missing the answer.
5. Off-by-one at the boundaries (start at 0 and n-1).
6. Mutating original order when indices must map back to the input.
7. Integer overflow when summing large values.
8. Infinite loop from failing to move a pointer in some branch.
9. Assuming uniqueness of solution when multiple exist.
10. Mixing up reader/writer roles in same-direction variants.

---

## 8. Interview Follow-Up Questions

1. **Q: Why does sorted order let you move one pointer?**
   A: Monotonicity: increasing l raises the sum, decreasing r lowers it.

2. **Q: How to avoid duplicate triplets?**
   A: Skip equal neighbors after recording a hit.

3. **Q: Opposite vs same direction — when each?**
   A: Opposite for sorted pair/area problems; same direction for in-place filtering/windows.

4. **Q: Extend to 3Sum / 4Sum?**
   A: Fix outer elements, two-pointer the rest; generalize as k-sum recursion.

5. **Q: Unsorted input, can't sort?**
   A: Use a hash map (HashMap Lookup) for O(n) pair finding.

6. **Q: Container/area problems?**
   A: Move the pointer at the shorter wall to possibly increase area.

7. **Q: Cycle detection?**
   A: Fast/slow pointers (Floyd) detect cycles in O(1) space.

8. **Q: Palindrome check?**
   A: Converge from both ends comparing characters.

9. **Q: Stability of order?**
   A: Two-pointer partitioning can be unstable; note if order matters.

10. **Q: Complexity with sorting?**
   A: O(n log n) sort + O(n) scan = O(n log n).

11. **Q: Remove duplicates in place?**
   A: Writer index advances only on new values.

12. **Q: Dutch national flag?**
   A: Three pointers partition into <,=,> in one pass.

13. **Q: Find closest sum?**
   A: Track the minimal |sum - target| as pointers move.

14. **Q: Why O(1) space?**
   A: Only a few index variables beyond the input.

15. **Q: Multiple answers required?**
   A: Continue scanning after each hit, moving both pointers.

---

## 9. Solved Example 1

### Problem — Container With Most Water (LeetCode 11)
Each `height[i]` is a vertical line. Choose two lines that, with the x-axis, hold the most water.

### Thought Process
1. `area = width × min(height[left], height[right])` — the shorter wall is the bottleneck.
2. Start at the widest possible pair, `left = 0` and `right = n−1`, since width is maximal there.
3. Every later move shrinks the width, so the only way to improve is a taller bottleneck.
4. Move the **shorter** wall inward: keeping it can't help, because its height caps every pairing and the width only decreases.
5. Track the best area seen.

### Dry Run

Input: `height = [1, 8, 6, 2, 5, 4, 8, 3, 7]`

| left | right | h[left] | h[right] | width | min | area | best | which wall is shorter → move |
|------|-------|---------|----------|-------|-----|------|------|------------------------------|
| 0 | 8 | 1 | 7 | 8 | 1 | 8  | 8  | left → `left++` |
| 1 | 8 | 8 | 7 | 7 | 7 | **49** | **49** | right → `right--` |
| 1 | 7 | 8 | 3 | 6 | 3 | 18 | 49 | right → `right--` |
| 1 | 6 | 8 | 8 | 5 | 8 | 40 | 49 | tie → move either (`right--`) |
| 1 | 5 | 8 | 4 | 4 | 4 | 16 | 49 | right → `right--` |
| 1 | 4 | 8 | 5 | 3 | 5 | 15 | 49 | right → `right--` |
| 1 | 3 | 8 | 2 | 2 | 2 | 4  | 49 | right → `right--` |
| 1 | 2 | 8 | 6 | 1 | 6 | 6  | 49 | right → `right--`; pointers meet → stop |

Output: **49** — lines at index 1 (height 8) and index 8 (height 7), width 7.

Look at row 1: we discarded index 0 (height 1) after one measurement. That was safe because a wall of height 1 caps every container it joins at 1, and no width can exceed the 8 we just used.

### Visualization

```text
index :  0  1  2  3  4  5  6  7  8
height:  1  8  6  2  5  4  8  3  7

      8 |    █           █
      7 |    █           █     █
      6 |    █  █        █     █
      5 |    █  █     █  █     █
      1 | █  █  █  █  █  █  █  █ █
        +─────────────────────────
             ↑                  ↑
           left=1            right=8
        width 7 × min(8,7)=7 → 49  ★
```

### Code

```go
func maxArea(height []int) int {
    left, right := 0, len(height)-1
    best := 0

    for left < right {
        h := height[left]
        if height[right] < h {
            h = height[right] // the shorter wall caps the water
        }
        if area := (right - left) * h; area > best {
            best = area
        }

        // Retire the shorter wall: it can never beat what we just measured.
        if height[left] < height[right] {
            left++
        } else {
            right--
        }
    }
    return best
}
```

```python
def maxArea(height):
    left, right, best = 0, len(height) - 1, 0
    while left < right:
        h = min(height[left], height[right])       # shorter wall caps the water
        best = max(best, (right - left) * h)
        if height[left] < height[right]:           # retire the shorter wall
            left += 1
        else:
            right -= 1
    return best
```

### Complexity
Time O(n) — one index retired per step. Space O(1).

---

## 10. Solved Example 2

### Problem — Trapping Rain Water (LeetCode 42)
Given an elevation map, compute how much rainwater is trapped after it rains.

### Thought Process
1. Ask the question **per index**, not per pair: how much water sits on top of bar `i`?
2. Water at `i` is held in by the tallest bar to its left and the tallest to its right, capped by the shorter of the two:
   `water[i] = min(leftMax[i], rightMax[i]) − height[i]`
3. Computing those two arrays takes two passes — correct, simple, O(n) time and O(n) space.
4. The two-pointer version drops the arrays. The key implication: **if `height[left] < height[right]`, then `rightMax ≥ height[right] > height[left]`**, so `min(leftMax, rightMax)` for index `left` must be `leftMax` — we can settle it now without knowing the true `rightMax`.
5. Settle whichever side is shorter, advance that pointer, and repeat.

### Dry Run

Input: `height = [3, 0, 2, 0, 4]`

**First, the array version, to see what the answer should be:**

| i | height | leftMax | rightMax | min | water = min − height |
|---|--------|---------|----------|-----|----------------------|
| 0 | 3 | 3 | 4 | 3 | 0 |
| 1 | 0 | 3 | 4 | 3 | **3** |
| 2 | 2 | 3 | 4 | 3 | **1** |
| 3 | 0 | 3 | 4 | 3 | **3** |
| 4 | 4 | 4 | 4 | 4 | 0 |

Total: **7**

**Now the two-pointer version** — start `left = 0`, `right = 4`, `leftMax = 0`, `rightMax = 0`, `water = 0`:

| left | right | h[left] | h[right] | shorter side | action | water |
|------|-------|---------|----------|--------------|--------|-------|
| 0 | 4 | 3 | 4 | left | `3 ≥ leftMax(0)` → raise `leftMax = 3`; `left++` | 0 |
| 1 | 4 | 0 | 4 | left | `0 < leftMax(3)` → add `3 − 0 = 3`; `left++` | 3 |
| 2 | 4 | 2 | 4 | left | `2 < leftMax(3)` → add `3 − 2 = 1`; `left++` | 4 |
| 3 | 4 | 0 | 4 | left | `0 < leftMax(3)` → add `3 − 0 = 3`; `left++` | **7** |
| 4 | 4 | — | — | — | `left == right` → stop | 7 |

Output: **7** — the two versions agree. ✓

### Visualization

```text
height = [3, 0, 2, 0, 4]

  4 |                █
  3 | █  ~  ~  ~     █        ~ = trapped water
  2 | █  ~  █  ~     █
  1 | █  ~  █  ~     █
    +────────────────────
      0  1  2  3  4

  water above index 1 = min(leftMax 3, rightMax 4) - 0 = 3
  water above index 2 = min(3, 4) - 2 = 1
  water above index 3 = min(3, 4) - 0 = 3
  total = 7
```

### Code

```go
func trap(height []int) int {
    left, right := 0, len(height)-1
    leftMax, rightMax := 0, 0
    water := 0

    for left < right {
        if height[left] < height[right] {
            // rightMax >= height[right] > height[left], so leftMax is the
            // binding constraint here — index `left` can be settled now.
            if height[left] >= leftMax {
                leftMax = height[left] // new wall, holds no water itself
            } else {
                water += leftMax - height[left]
            }
            left++
        } else {
            // Mirror image: rightMax is the binding constraint.
            if height[right] >= rightMax {
                rightMax = height[right]
            } else {
                water += rightMax - height[right]
            }
            right--
        }
    }
    return water
}
```

```python
def trap(height):
    left, right = 0, len(height) - 1
    left_max = right_max = water = 0

    while left < right:
        if height[left] < height[right]:
            # right_max >= height[right] > height[left], so left_max binds here
            if height[left] >= left_max:
                left_max = height[left]        # new wall, holds no water itself
            else:
                water += left_max - height[left]
            left += 1
        else:
            if height[right] >= right_max:
                right_max = height[right]
            else:
                water += right_max - height[right]
            right -= 1
    return water
```

### Complexity
Time O(n), Space **O(1)**. The two-array version is also O(n) time but O(n) space — reach for it first if you need to be sure of correctness under interview pressure.

---

## 11. Solved Example 3

### Problem — Largest Rectangle in Histogram (LeetCode 84)
Find the area of the largest rectangle that fits inside the histogram.

### Thought Process
1. Any maximal rectangle has some bar as its **limiting height**. So ask, for each bar `i`: how wide can a rectangle of height `height[i]` stretch?
2. It stretches until it hits a **strictly shorter** bar on either side. So we need, for every `i`, the nearest shorter bar to the left and to the right.
3. Scanning for those is O(n²). A **monotonic increasing stack** finds them all in O(n).
4. Keep a stack of indices with increasing heights. When a shorter bar arrives, it *is* the right boundary for everything taller — pop and settle each one.
5. After popping, the new stack top is that bar's left boundary, so `width = i − stack.top − 1`. If the stack empties, the bar extended all the way to index 0, so `width = i`.
6. Append a sentinel height of `0` at the end to force every remaining bar to be settled.

### Dry Run

Input: `heights = [2, 1, 5, 6, 2, 3]`, with a sentinel `0` at index 6

| i | h | stack (indices) before | action | area computed | best |
|---|---|------------------------|--------|---------------|------|
| 0 | 2 | `[]`      | push 0 | — | 0 |
| 1 | 1 | `[0]`     | `h[0]=2 > 1` → pop 0: height 2, stack empty → width = `i` = 1 | `2×1 = 2` | 2 |
|   |   | `[]`      | push 1 | — | 2 |
| 2 | 5 | `[1]`     | `h[1]=1 < 5` → push 2 | — | 2 |
| 3 | 6 | `[1,2]`   | `h[2]=5 < 6` → push 3 | — | 2 |
| 4 | 2 | `[1,2,3]` | pop 3: height 6, top now 2 → width = `4−2−1 = 1` | `6×1 = 6` | 6 |
|   |   | `[1,2]`   | pop 2: height 5, top now 1 → width = `4−1−1 = 2` | `5×2 = **10**` | **10** |
|   |   | `[1]`     | `h[1]=1 < 2` → push 4 | — | 10 |
| 5 | 3 | `[1,4]`   | `h[4]=2 < 3` → push 5 | — | 10 |
| 6 | 0 (sentinel) | `[1,4,5]` | pop 5: height 3, top 4 → width = `6−4−1 = 1` | `3×1 = 3` | 10 |
|   |   | `[1,4]`   | pop 4: height 2, top 1 → width = `6−1−1 = 4` | `2×4 = 8` | 10 |
|   |   | `[1]`     | pop 1: height 1, stack empty → width = `6` | `1×6 = 6` | 10 |

Output: **10** — the rectangle of height 5 spanning indices 2 and 3.

### Visualization

```text
index :  0  1  2  3  4  5
height:  2  1  5  6  2  3

  6 |          █
  5 |       ▓▓▓█          ▓ = the winning rectangle
  4 |       ▓▓▓█             height 5, width 2  →  area 10
  3 |       ▓▓▓█        █
  2 | █     ▓▓▓█  █     █
  1 | █  █  ▓▓▓█  █     █
    +──────────────────────
      0  1  2  3  4  5

bar 2 (height 5) is blocked on the left by bar 1 (height 1)
                and on the right by bar 4 (height 2)
    ⇒ width = 4 - 1 - 1 = 2
```

### Code

```go
func largestRectangleArea(heights []int) int {
    stack := []int{} // indices with strictly increasing heights
    best := 0

    // i == len(heights) acts as a sentinel bar of height 0, which forces
    // every index still on the stack to be settled.
    for i := 0; i <= len(heights); i++ {
        current := 0
        if i < len(heights) {
            current = heights[i]
        }

        for len(stack) > 0 && heights[stack[len(stack)-1]] >= current {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]

            height := heights[top]
            // The new stack top is the nearest shorter bar on the left;
            // if the stack is empty, this bar reaches index 0.
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
    stack = []            # indices with increasing heights
    best = 0

    for i in range(len(heights) + 1):
        current = heights[i] if i < len(heights) else 0   # sentinel 0 at the end

        while stack and heights[stack[-1]] >= current:
            height = heights[stack.pop()]
            # new stack top is the nearest shorter bar on the left
            width = i if not stack else i - stack[-1] - 1
            best = max(best, height * width)

        stack.append(i)
    return best
```

### Complexity
Time **O(n)** — every index is pushed once and popped once. Space O(n) for the stack.

> This is the Monotonic Stack pattern; the Histogram Pattern chapter goes deeper on it, including the "maximal rectangle in a binary matrix" extension that runs this routine once per row.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 11 | Container Water | Easy | Core two pointers application |
| 42 | Trapping Rain | Easy | Core two pointers application |
| 84 | Largest Rectangle | Medium | Core two pointers application |
| 407 | Trapping II | Medium | Core two pointers application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Opposite-direction (converging)**
- **Same-direction (reader/writer)**
- **Fast & slow (cycle/middle)**
- **Three-way partition (Dutch flag)**
- **k-Sum recursion**
- **Container/area maximization**

---

## 14. Production Engineering Applications

- **Scalability:** Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Container Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Container Pattern (Two Pointers).
- **Signal:** container, water, area, max area, trapping rain, two pointer.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Container Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Container Pattern
FAMILY : Two Pointers (Intermediate)
WHEN   : container, water, area, max area, trapping rain, two pointer
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 11, 42, 84, 407
```

---

*Part of the DSA Patterns Handbook — pattern 12 of 100.*
