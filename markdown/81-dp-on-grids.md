# 81 · DP on Grids

> **One-liner:** 2D DP accumulating optimal paths/areas across a grid.

---

## 1. Overview

### Definition
The **DP on Grids** pattern belongs to the *Dynamic Programming* family. 2D DP accumulating optimal paths/areas across a grid.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
grid dp, paths, min path sum, 2d dp, robot.

### Constraints
- Input size where the brute-force complexity would time out — the DP on Grids optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the DP on Grids invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — DP on Grids is the upgrade.
- The wording maps onto: grid dp, paths, min path sum, 2d dp, robot.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How many ways / what is the best way to walk from one corner of a grid to the other, when each step only goes right or down?"*

Running example: count the paths from the top-left to the bottom-right of a 3×3 grid.

### Intuition
Stand on a cell and try both legal moves. Recurse from each. When you fall off the grid the branch is dead; when you land on the goal you found one path.

### Algorithm
1. `walk(r, c)` = number of paths from `(r, c)` to the bottom-right corner.
2. If `r` or `c` is out of bounds, return 0.
3. If `(r, c)` is the corner, return 1.
4. Return `walk(r+1, c) + walk(r, c+1)`.
5. Answer is `walk(0, 0)`.

### Complexity
- Time: **O(2^(m+n))** — a binary branch at every one of the `m+n-2` steps.
- Space: O(m + n) recursion stack.

### Drawbacks
- Different move orders land on the same cell, and the recursion re-derives that cell's answer from scratch every time. In a 3×3 grid, `walk(1,1)` is reached from `(0,0)` two ways:

```text
(0,0) --right--> (0,1) --down--> (1,1)
(0,0) --down---> (1,0) --right-> (1,1)     ← same cell, recomputed
```

  In a 10×10 grid the centre cell is reached tens of thousands of times, and its answer is identical every single time.
- The brute force ignores the one fact that trivialises the problem: **how you arrived at a cell is irrelevant — only which cell you are on matters.** There are only `m·n` cells, so there are only `m·n` distinct questions.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **A cell can only be entered from the cell above it or the cell to its left, so its answer is a one-line combination of exactly those two — and if you fill the grid in reading order, both are already computed when you get there.**

It is the way water fills a terraced field. You never need to look ahead; each terrace is determined by the two terraces feeding into it. Sweep top-to-bottom, left-to-right, and the information flows with you.

### The thought process

```text
We need    : an aggregate (count / min / max) over all corner-to-corner paths.
Obvious way: enumerate paths recursively.
Too slow   : 2^(m+n) — the branch count explodes.
Notice     : the recursion's arguments are just (row, col).
Notice too : arrival history never affects the future, only position does.
Therefore  : one number per cell. dp[i][j] combines dp[i-1][j] and dp[i][j-1].
Now        : O(m*n) time, and the memory collapses to a single row.
```

### Why the rolling 1-D row works (the aliasing trick)

The 2-D table is easy but wasteful: row `i` only ever reads row `i-1`. So keep **one** array `dp` of length `n` and overwrite it in place. The subtle part is what `dp[j]` and `dp[j-1]` actually mean at the instant you use them.

Sweep the row **left to right**. You are at column `j`:

```text
dp[0] dp[1] ... dp[j-1] | dp[j] dp[j+1] ... dp[n-1]
└── already overwritten ─┘ └── not touched yet ─────┘
    = values for ROW i        = values for ROW i-1

so, at this exact moment:
    dp[j]    is still ROW i-1 at column j   ==  the cell ABOVE
    dp[j-1]  is already ROW i at column j-1 ==  the cell to the LEFT
```

That is the whole trick. `dp[j] = dp[j] + dp[j-1]` reads *above* on the left-hand side of the `+` and *left* on the right-hand side, in a single statement, with no extra buffer.

**And it only works left-to-right.** Watch it break. Unique paths, 3×3, row 1, starting from `dp = [1, 1, 1]` (row 0):

```text
left-to-right (correct)                right-to-left (WRONG)
  j=1: dp[1] = dp[1] + dp[0]             j=2: dp[2] = dp[2] + dp[1]
             =  1(above) + 1(left) = 2              =  1(above) + 1(ALSO above) = 2
  j=2: dp[2] = dp[2] + dp[1]             j=1: dp[1] = dp[1] + dp[0]
             =  1(above) + 2(left) = 3              =  1(above) + 1(left)  = 2
  dp = [1, 2, 3]   ✓                     dp = [1, 2, 2]   ✗ (dp[2] should be 3)
```

Going right-to-left, `dp[j-1]` has *not* been overwritten yet, so it is still the row above — the code silently computes "above + above-left", which is a different (wrong) recurrence. No crash, just a wrong number.

> **Rule of thumb:** if the recurrence reads `dp[j-1]` you must sweep **forward** so that slot already holds the current row. If it reads `dp[j+1]` (as in the triangle problem) forward is still fine, because `j+1` is untouched and *should* be the previous row. Write down which row you want each slot to be from, then pick the direction that delivers it.

### Steps

```text
Step 1 → State: dp[i][j] = the answer for standing on cell (i, j).
Step 2 → Recurrence: combine the two cells that can reach (i, j).
Step 3 → Base: fill row 0 and column 0 — they have exactly one incoming path.
Step 4 → Sweep rows top to bottom, columns left to right.
Step 5 → (Optional) collapse to one array; keep the sweep left to right.
Step 6 → Answer is the bottom-right cell.
```

### How should I recognize this?

```text
If you see...
  "robot / path / grid", moves restricted to right+down (or down+diagonal),
  "how many ways", "minimum cost path", "largest square", obstacles
        ↓
Think about...
  "Which cells can step INTO this cell?"
  That set of predecessors IS the recurrence.
        ↓
Use...
  count problems  -> dp[i][j] = dp[i-1][j] + dp[i][j-1]
  cost problems   -> dp[i][j] = grid[i][j] + min(dp[i-1][j], dp[i][j-1])
  obstacles       -> force dp[i][j] = 0 on a blocked cell
  then collapse the table to one rolling row, sweeping LEFT TO RIGHT
```

### Visual explanation

```svg
<svg viewBox="0 0 620 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr81" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
    <marker id="arr81a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Unique Paths: dp[i][j] = dp[i-1][j] + dp[i][j-1]</text>
  <rect x="250" y="52"  width="48" height="48" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="274" y="81"  text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="52"  width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="326" y="81"  text-anchor="middle" fill="#1e293b">1</text>
  <rect x="354" y="52"  width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="378" y="81"  text-anchor="middle" fill="#1e293b">1</text>
  <rect x="250" y="104" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="274" y="133" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="104" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="326" y="133" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="354" y="104" width="48" height="48" rx="6" fill="#fff7ed" stroke="#d97706" stroke-width="2"/><text x="378" y="133" text-anchor="middle" font-weight="700" fill="#1e293b">3</text>
  <rect x="250" y="156" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="274" y="185" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="156" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="326" y="185" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="354" y="156" width="48" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="378" y="185" text-anchor="middle" font-weight="700" fill="#1e293b">6</text>
  <line x1="378" y1="80" x2="378" y2="102" stroke="#d97706" marker-end="url(#arr81a)"/>
  <line x1="328" y1="128" x2="352" y2="128" stroke="#d97706" marker-end="url(#arr81a)"/>
  <text x="472" y="124" fill="#d97706" font-weight="700">up 1 + left 2</text>
  <text x="472" y="142" fill="#64748b">= 3</text>
  <text x="274" y="228" text-anchor="middle" fill="#059669">start</text>
  <text x="378" y="228" text-anchor="middle" fill="#059669" font-weight="700">answer = 6</text>
</svg>
```

```text
Unique paths on a 3x3 grid, one rolling row.

  start        row 0 has exactly one path to each cell (all rights)
  dp = [ 1  1  1 ]

  row 1        dp[j] += dp[j-1]     "above + left"
       dp[1] = 1 + 1 = 2
       dp[2] = 1 + 2 = 3
  dp = [ 1  2  3 ]

  row 2
       dp[1] = 2 + 1 = 3
       dp[2] = 3 + 3 = 6
  dp = [ 1  3  6 ]            answer = dp[n-1] = 6

full table, for comparison — the rolling row is its last snapshot:

        1   1   1
        1   2   3
        1   3  [6]
```

### Interview explanation
"Grid DP is the observation that a cell's answer depends only on the cell itself, not on the route taken to it. Since moves are right and down, a cell can only be entered from above or from the left, so `dp[i][j]` is a one-line combination of `dp[i-1][j]` and `dp[i][j-1]` — a sum for counting problems, a min plus the cell's own cost for cheapest-path problems. The base cases are the first row and first column, which have exactly one way in. Filling top-to-bottom and left-to-right guarantees both predecessors are ready, so it's O(m·n) time. Because a row only reads the row above, I keep a single array and update it in place left-to-right: at column `j`, `dp[j]` is still the previous row (the cell above) while `dp[j-1]` is already the current row (the cell to the left). That gets space down to O(n)."

---

## 5. Generic Templates

> One rolling row, swept left to right: `dp[j]` is the cell above, `dp[j-1]` is the cell to the left.

```go
// CountGridPaths counts right/down paths across an m x n grid.
// dp[j] = number of paths to the current row's column j.
func CountGridPaths(m, n int) int {
    if m <= 0 || n <= 0 {
        return 0
    }
    dp := make([]int, n)
    for j := range dp {
        dp[j] = 1 // row 0: a single all-rights path reaches every cell
    }

    for i := 1; i < m; i++ {
        // dp[0] stays 1: column 0 is reachable only by going straight down.
        for j := 1; j < n; j++ {
            // dp[j] is still row i-1 (ABOVE); dp[j-1] is already row i (LEFT).
            dp[j] += dp[j-1]
        }
    }
    return dp[n-1]
}

// MinGridPathCost returns the cheapest right/down path cost through grid.
// dp[j] = cheapest cost to reach the current row's column j.
func MinGridPathCost(grid [][]int) int {
    if len(grid) == 0 || len(grid[0]) == 0 {
        return 0
    }
    m, n := len(grid), len(grid[0])

    dp := make([]int, n)
    dp[0] = grid[0][0]
    for j := 1; j < n; j++ {
        dp[j] = dp[j-1] + grid[0][j] // row 0: only rightward moves
    }

    for i := 1; i < m; i++ {
        dp[0] += grid[i][0] // column 0: only downward moves
        for j := 1; j < n; j++ {
            above, left := dp[j], dp[j-1]
            if left < above {
                above = left
            }
            dp[j] = grid[i][j] + above
        }
    }
    return dp[n-1]
}
```

```python
def count_grid_paths(m, n):
    """dp[j] = number of right/down paths to column j of the current row."""
    if m <= 0 or n <= 0:
        return 0
    dp = [1] * n                       # row 0: one all-rights path per cell

    for _ in range(1, m):
        # dp[0] stays 1: column 0 is reached only by going straight down.
        for j in range(1, n):          # LEFT TO RIGHT, so dp[j-1] is this row
            dp[j] += dp[j - 1]         # dp[j] = above, dp[j-1] = left
    return dp[n - 1]


def min_grid_path_cost(grid):
    """dp[j] = cheapest cost to reach column j of the current row."""
    if not grid or not grid[0]:
        return 0
    m, n = len(grid), len(grid[0])

    dp = [0] * n
    dp[0] = grid[0][0]
    for j in range(1, n):              # row 0: only rightward moves
        dp[j] = dp[j - 1] + grid[0][j]

    for i in range(1, m):
        dp[0] += grid[i][0]            # column 0: only downward moves
        for j in range(1, n):
            dp[j] = grid[i][j] + min(dp[j], dp[j - 1])   # above vs left
    return dp[n - 1]
```

```java
public class GridDP {
    // dp[j] = number of right/down paths to column j of the current row.
    public static int countGridPaths(int m, int n) {
        if (m <= 0 || n <= 0) return 0;
        int[] dp = new int[n];
        java.util.Arrays.fill(dp, 1);          // row 0

        for (int i = 1; i < m; i++)
            for (int j = 1; j < n; j++)        // left to right
                dp[j] += dp[j - 1];            // dp[j] = above, dp[j-1] = left
        return dp[n - 1];
    }

    // dp[j] = cheapest cost to reach column j of the current row.
    public static int minGridPathCost(int[][] grid) {
        if (grid.length == 0 || grid[0].length == 0) return 0;
        int m = grid.length, n = grid[0].length;

        int[] dp = new int[n];
        dp[0] = grid[0][0];
        for (int j = 1; j < n; j++) dp[j] = dp[j - 1] + grid[0][j];  // row 0

        for (int i = 1; i < m; i++) {
            dp[0] += grid[i][0];                                     // column 0
            for (int j = 1; j < n; j++)
                dp[j] = grid[i][j] + Math.min(dp[j], dp[j - 1]);     // above/left
        }
        return dp[n - 1];
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

// dp[j] = number of right/down paths to column j of the current row.
int countGridPaths(int m, int n) {
    if (m <= 0 || n <= 0) return 0;
    vector<int> dp(n, 1);                       // row 0

    for (int i = 1; i < m; ++i)
        for (int j = 1; j < n; ++j)             // left to right
            dp[j] += dp[j - 1];                 // dp[j]=above, dp[j-1]=left
    return dp[n - 1];
}

// dp[j] = cheapest cost to reach column j of the current row.
int minGridPathCost(vector<vector<int>>& grid) {
    if (grid.empty() || grid[0].empty()) return 0;
    int m = (int)grid.size(), n = (int)grid[0].size();

    vector<int> dp(n, 0);
    dp[0] = grid[0][0];
    for (int j = 1; j < n; ++j) dp[j] = dp[j - 1] + grid[0][j];   // row 0

    for (int i = 1; i < m; ++i) {
        dp[0] += grid[i][0];                                       // column 0
        for (int j = 1; j < n; ++j)
            dp[j] = grid[i][j] + min(dp[j], dp[j - 1]);            // above/left
    }
    return dp[n - 1];
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | DP on Grids (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(states × transitions)** |
| Time (best)  | — | **O(states × transitions)** |
| Time (average) | — | **O(states × transitions)** |
| Space | varies | **O(states)** |

> Each state computed once; space often reducible to a rolling row.

---

## 7. Common Mistakes

1. Wrong loop direction (0/1 needs reverse; unbounded needs forward).
2. Ill-defined state that doesn't capture all needed information.
3. Incorrect base cases.
4. Off-by-one in dimensions (use size n+1 frequently).
5. Forgetting to initialize unreachable states to ±infinity.
6. Memoization key collisions / missing dimensions.
7. Recomputing instead of reading the memo.
8. Space-optimizing prematurely and breaking the recurrence.
9. Integer overflow on counts/sums.
10. Not reconstructing the solution when the problem asks for it.

---

## 8. Interview Follow-Up Questions

1. **Q: Top-down vs bottom-up?**
   A: Memoized recursion vs iterative table; same complexity, different constants/stack use.

2. **Q: How to find the state?**
   A: Identify the minimal info to make a decision and recurse.

3. **Q: 0/1 vs unbounded knapsack?**
   A: 0/1 iterates capacity in reverse; unbounded forward (reuse).

4. **Q: Space optimization?**
   A: Keep only the previous row(s) you depend on.

5. **Q: Reconstruct the answer?**
   A: Store choices or backtrack through the table.

6. **Q: LIS in O(n log n)?**
   A: Patience sorting with binary search.

7. **Q: LCS / edit distance?**
   A: 2D grid DP aligning two sequences.

8. **Q: Coin change (min vs ways)?**
   A: Min-coins vs count-ways differ in init and loop order.

9. **Q: Why overlapping subproblems matter?**
   A: They make memoization pay off (vs divide & conquer).

10. **Q: Tree DP?**
   A: Combine children's states post-order; reroot for all-roots.

11. **Q: Bitmask DP?**
   A: Encode subsets as bitmasks for ≤20 elements.

12. **Q: State machine DP?**
   A: Model hold/sell/cooldown states (stock problems).

13. **Q: Digit DP?**
   A: Count numbers with a tight-bound flag over digits.

14. **Q: Interval DP?**
   A: dp[i][j] over a range, split at k (matrix chain, burst balloons).

15. **Q: Prove correctness?**
   A: Show optimal substructure and a correct recurrence.

---

## 9. Solved Example 1

### Problem — Unique Paths (LeetCode 62)
A robot starts at the top-left of an `m × n` grid and may move only right or down. Count the distinct paths to the bottom-right corner.

### Thought Process
1. **What does `dp[i][j]` mean?** *The number of distinct right/down paths that start at the top-left corner and end standing on cell `(i, j)`.*
2. **How do we compute it?** The last move into `(i, j)` was either a *down* step from `(i-1, j)` or a *right* step from `(i, j-1)`. Those two sets of paths are disjoint (they differ in the final move) and together they are all of them, so `dp[i][j] = dp[i-1][j] + dp[i][j-1]` — a plain sum, no `min`, no `max`.
3. **What is the base case?** `dp[0][j] = 1` and `dp[i][0] = 1`. On the top row the only way in is a run of rights; on the left column the only way in is a run of downs. Exactly one path each. (`dp[0][0] = 1`: the empty path.)
4. **Why this direction?** Both reads are *above* and *left*, so sweeping rows top-to-bottom and columns left-to-right always finds them finished. Collapsed to one array, the sweep must stay left-to-right so that `dp[j]` is still the row above while `dp[j-1]` is already this row.
5. Answer is `dp[m-1][n-1]`.

### Dry Run

Input: `m = 3, n = 3`

Start with the top row: `dp = [1, 1, 1]`.

| row `i` | col `j` | `dp[j]` before (= **above**) | `dp[j-1]` (= **left**) | `dp[j]` after | array after |
|---------|---------|------------------------------|-------------------------|---------------|-------------|
| 1 | 1 | 1 | 1 | `1 + 1` = **2** | `[1, 2, 1]` |
| 1 | 2 | 1 | 2 | `1 + 2` = **3** | `[1, 2, 3]` |
| 2 | 1 | 2 | 1 | `2 + 1` = **3** | `[1, 3, 3]` |
| 2 | 2 | 3 | 3 | `3 + 3` = **6** | `[1, 3, 6]` |

Output: **6**

Look at row 2, column 2. `dp[2]` read `3`, which is the value column 2 had at the end of *row 1* — the cell above. `dp[1]` read `3`, which was written one line earlier in *this* row — the cell to the left. Same array, two different rows, and the only thing keeping them straight is the left-to-right order.

### Visualization

```text
full table                     the six paths, as move strings
   1   1   1                     RRDD   RDRD   RDDR
   1   2   3                     DRRD   DRDR   DDRR
   1   3  [6]                    (6 of them — matches dp[2][2])

how each cell is born:

        (i-1, j)
           |  down
           v
(i, j-1) --+--> (i, j)     dp[i][j] = dp[i-1][j] + dp[i][j-1]
    right

rolling row, snapshots after each row:

  row 0 : [ 1  1  1 ]
  row 1 : [ 1  2  3 ]
  row 2 : [ 1  3  6 ]  <- answer in the last slot
```

### Code

```go
// uniquePaths counts right/down paths across an m x n grid using one rolling
// row. dp[j] = paths to column j of the row being processed.
func uniquePaths(m int, n int) int {
    dp := make([]int, n)
    for j := range dp {
        dp[j] = 1 // row 0: exactly one all-rights path per cell
    }

    for i := 1; i < m; i++ {
        // dp[0] stays 1: column 0 is only reachable by going straight down.
        for j := 1; j < n; j++ {
            // dp[j] is still row i-1 (ABOVE), dp[j-1] is already row i (LEFT).
            dp[j] += dp[j-1]
        }
    }
    return dp[n-1]
}
```

```python
def uniquePaths(m, n):
    dp = [1] * n                     # row 0: one all-rights path per cell

    for _ in range(1, m):
        # dp[0] stays 1: column 0 is reached only by going straight down.
        for j in range(1, n):        # LEFT TO RIGHT keeps the aliasing correct
            dp[j] += dp[j - 1]       # dp[j] = above, dp[j-1] = left
    return dp[n - 1]
```

### Complexity
Time O(m·n) — one addition per cell. Space O(n) — a single rolling row instead of the full table.

---

## 10. Solved Example 2

### Problem — Min Path Sum (LeetCode 64)
Given an `m × n` grid of non-negative numbers, find the right/down path from top-left to bottom-right whose numbers sum to the smallest total.

### Thought Process
1. **What does `dp[i][j]` mean?** *The smallest possible sum along any right/down path from the top-left corner to cell `(i, j)`, counting `grid[i][j]` itself.*
2. **How do we compute it?** You must pay `grid[i][j]` no matter how you arrive, and you arrive from above or from the left. So take the cheaper of the two arrivals and add the toll: `dp[i][j] = grid[i][j] + min(dp[i-1][j], dp[i][j-1])`. Nothing else can influence the cell — this is optimal substructure in one line.
3. **What is the base case?** `dp[0][0] = grid[0][0]`. The top row has no cell above it, so it is a running prefix sum: `dp[0][j] = dp[0][j-1] + grid[0][j]`. Symmetrically the left column accumulates downward. Seeding them explicitly is cleaner than sprinkling bounds checks into the `min`.
4. **Why this direction?** Same up/left dependency, so rows forward and columns forward. In the rolling row, `dp[j]` before assignment is the cell **above**, `dp[j-1]` is the cell **left** — and `dp[0] += grid[i][0]` maintains the left column.
5. Answer is `dp[m-1][n-1]`.

### Dry Run

Input:
```text
grid =  1  3  1
        1  5  1
        4  2  1
```

Top row prefix sums: `dp = [1, 4, 5]`.

| row `i` | col `j` | `grid[i][j]` | above `dp[j]` | left `dp[j-1]` | `dp[j]` = grid + min | array after |
|---------|---------|--------------|---------------|-----------------|----------------------|-------------|
| 1 | 0 | 1 | — | — | `1 + 1` = **2** (column rule) | `[2, 4, 5]` |
| 1 | 1 | 5 | 4 | 2 | `5 + min(4,2)` = **7** | `[2, 7, 5]` |
| 1 | 2 | 1 | 5 | 7 | `1 + min(5,7)` = **6** | `[2, 7, 6]` |
| 2 | 0 | 4 | — | — | `2 + 4` = **6** (column rule) | `[6, 7, 6]` |
| 2 | 1 | 2 | 7 | 6 | `2 + min(7,6)` = **8** | `[6, 8, 6]` |
| 2 | 2 | 1 | 6 | 8 | `1 + min(6,8)` = **7** | `[6, 8, 7]` |

Output: **7** — the path `1 → 3 → 1 → 1 → 1`.

Row `i=1, j=1` is instructive: the cell above holds `4`, the cell to the left holds `2`, so the algorithm commits to arriving from the left and never reconsiders. That is safe precisely because the future cost from `(1,1)` onward does not depend on how you got there.

### Visualization

```text
grid                cheapest-arrival table (the full 2-D version)
 1  3  1              1   4   5
 1  5  1              2   7   6
 4  2  1              6   8  [7]

the winning path                one cell's decision, zoomed in

 [1]->[3]->[1]                        dp[0][1] = 4
             |                            |  (above)
             v                            v
  1    5    [1]           dp[1][0] = 2 --> [ 5 + min(4, 2) = 7 ]
             |               (left)
             v
  4    2    [1]           the left arrival (2) wins, so dp[1][1] = 7

 1 + 3 + 1 + 1 + 1 = 7
```

### Code

```go
// minPathSum returns the cheapest right/down path total through grid.
// dp[j] = cheapest cost to reach column j of the row being processed.
func minPathSum(grid [][]int) int {
    if len(grid) == 0 || len(grid[0]) == 0 {
        return 0
    }
    m, n := len(grid), len(grid[0])

    dp := make([]int, n)
    dp[0] = grid[0][0]
    for j := 1; j < n; j++ {
        dp[j] = dp[j-1] + grid[0][j] // top row: only rightward arrivals
    }

    for i := 1; i < m; i++ {
        dp[0] += grid[i][0] // left column: only downward arrivals
        for j := 1; j < n; j++ {
            above, left := dp[j], dp[j-1] // dp[j] = row i-1, dp[j-1] = row i
            if left < above {
                above = left
            }
            dp[j] = grid[i][j] + above
        }
    }
    return dp[n-1]
}
```

```python
def minPathSum(grid):
    if not grid or not grid[0]:
        return 0
    m, n = len(grid), len(grid[0])

    dp = [0] * n
    dp[0] = grid[0][0]
    for j in range(1, n):
        dp[j] = dp[j - 1] + grid[0][j]        # top row: rightward only

    for i in range(1, m):
        dp[0] += grid[i][0]                   # left column: downward only
        for j in range(1, n):
            # dp[j] is still row i-1 (above); dp[j-1] is already row i (left).
            dp[j] = grid[i][j] + min(dp[j], dp[j - 1])
    return dp[n - 1]
```

### Complexity
Time O(m·n) — one comparison and one addition per cell. Space O(n) for the rolling row.

---

## 11. Solved Example 3

### Problem — Triangle (LeetCode 120)
Given a triangular array of numbers, find the minimum top-to-bottom path sum, where from index `j` on a row you may step to index `j` or `j+1` on the row below.

### Thought Process
1. **What does `dp[j]` mean?** *The smallest sum of any path that starts on cell `j` of the row currently being processed and walks all the way down to the bottom row.* Note the direction: this state looks **downward**, not back to the apex.
2. **How do we compute it?** From `(i, j)` the two legal next cells are `(i+1, j)` and `(i+1, j+1)`, so `dp[j] = triangle[i][j] + min(dp[j], dp[j+1])`, where `dp` currently holds row `i+1`'s answers.
3. **What is the base case?** `dp = triangle[last]` — from a bottom cell there is nowhere to go, so its best downward total is its own value.
4. **Why bottom-up?** Because the recurrence reads row `i+1`. Going top-down with this state definition would need answers that don't exist yet. (Top-down is possible with the *other* state — "best sum from the apex to here" — but then every row grows and you must special-case both edges. Bottom-up needs no edge cases at all, because `dp[j+1]` is always in range for a row of length `j+1 <` the row below.) Within a row, sweeping `j` forward is safe: writing `dp[j]` only destroys a value that no later `j` will read, since later cells read `dp[j']` and `dp[j'+1]` for `j' > j`.
5. Answer is `dp[0]` after processing the apex.

### Dry Run

Input:
```text
triangle = [ [2],
             [3, 4],
             [6, 5, 7],
             [4, 1, 8, 3] ]
```

Base: `dp = [4, 1, 8, 3]` (the bottom row).

| row processed | `j` | `triangle[i][j]` | `dp[j]` (below, same index) | `dp[j+1]` (below, one right) | new `dp[j]` | array after row |
|---------------|-----|------------------|------------------------------|-------------------------------|-------------|-----------------|
| `[6,5,7]` | 0 | 6 | 4 | 1 | `6 + 1` = **7** | |
| `[6,5,7]` | 1 | 5 | 1 | 8 | `5 + 1` = **6** | |
| `[6,5,7]` | 2 | 7 | 8 | 3 | `7 + 3` = **10** | `[7, 6, 10, 3]` |
| `[3,4]` | 0 | 3 | 7 | 6 | `3 + 6` = **9** | |
| `[3,4]` | 1 | 4 | 6 | 10 | `4 + 6` = **10** | `[9, 10, 10, 3]` |
| `[2]` | 0 | 2 | 9 | 10 | `2 + 9` = **11** | `[11, 10, 10, 3]` |

Output: **11** — the path `2 → 3 → 5 → 1`.

Only the first `i+1` slots of `dp` are meaningful after processing row `i`; the tail is stale leftovers, and that is fine because nothing above ever reads that far right.

### Visualization

```text
        2                    dp after each row (live cells in brackets)

      3   4                  bottom : [4] [1] [8] [3]
                             row 2  : [7] [6][10]  3
    6   5   7                row 1  : [9][10] 10   3
                             row 0  :[11] 10  10   3
  4   1   8   3
                             answer = dp[0] = 11

the winning path, and why each step was chosen:

   2      min(9, 10) -> go to index 0
   |
   3      min(7, 6)  -> go to index 1
    \
      5   min(1, 8)  -> go to index 1
      |
      1   bottom row
                     2 + 3 + 5 + 1 = 11
```

### Code

```go
// minimumTotal returns the minimum top-to-bottom path sum of a triangle.
// dp[j] = best total from cell j of the current row down to the bottom.
func minimumTotal(triangle [][]int) int {
    if len(triangle) == 0 {
        return 0
    }

    last := len(triangle) - 1
    dp := make([]int, len(triangle[last]))
    copy(dp, triangle[last]) // base: a bottom cell's best total is itself

    for i := last - 1; i >= 0; i-- { // rows below are already final
        for j := 0; j < len(triangle[i]); j++ {
            down, downRight := dp[j], dp[j+1]
            if downRight < down {
                down = downRight
            }
            dp[j] = triangle[i][j] + down
        }
    }
    return dp[0]
}
```

```python
def minimumTotal(triangle):
    if not triangle:
        return 0

    dp = triangle[-1][:]                    # base: bottom cells stand alone

    for i in range(len(triangle) - 2, -1, -1):    # rows below are final
        for j in range(len(triangle[i])):
            # dp[j] and dp[j+1] both still describe row i+1.
            dp[j] = triangle[i][j] + min(dp[j], dp[j + 1])
    return dp[0]
```

### Complexity
Time O(n²) for a triangle with `n` rows — that is one O(1) step per cell, and a triangle has `n(n+1)/2` cells. Space O(n) using a single array the width of the bottom row.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 62 | Unique Paths | Easy | Core dynamic programming application |
| 64 | Min Path Sum | Easy | Core dynamic programming application |
| 120 | Triangle | Medium | Core dynamic programming application |
| 221 | Maximal Square | Medium | Core dynamic programming application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **0/1 & unbounded knapsack**
- **Subset sum / partition**
- **LIS / LCS**
- **Grid / string DP**
- **Tree / bitmask / digit / state-machine DP**

---

## 14. Production Engineering Applications

- **Scalability:** DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(states)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same DP on Grids logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** DP on Grids (Dynamic Programming).
- **Signal:** grid dp, paths, min path sum, 2d dp, robot.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the DP on Grids invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: DP on Grids
FAMILY : Dynamic Programming (Advanced)
WHEN   : grid dp, paths, min path sum, 2d dp, robot
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 62, 64, 120, 221
```

---

*Part of the DSA Patterns Handbook — pattern 81 of 100.*
