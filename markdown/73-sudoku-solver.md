# 73 · Sudoku Solver

> **One-liner:** Fill cells with valid candidates, backtracking on dead ends.

---

## 1. Overview

### Definition
The **Sudoku Solver** pattern belongs to the *Backtracking* family. Fill cells with valid candidates, backtracking on dead ends.

### Intuition
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Why it works
Build candidates incrementally; prune branches that can't lead to a solution (choose → explore → un-choose). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Backtracking solves configuration/constraint problems: test-case generation, SAT-style feasibility, resource allocation, and puzzle/AI move generation. Pruning is the difference between feasible and intractable in production solvers.

---

## 2. Recognition Signals

### Keywords
sudoku, constraint propagation, backtracking, grid, try undo.

### Constraints
- Input size where the brute-force complexity would time out — the Sudoku Solver optimization is the intended solution.
- Structural hints in the statement that match this family (Backtracking).

### Hidden clues
- The problem can be reframed so the Sudoku Solver invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Sudoku Solver is the upgrade.
- The wording maps onto: sudoku, constraint propagation, backtracking, grid, try undo.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Fill in every blank so that all the rules hold."* — and, crucially, **one** valid filling is enough.

### Intuition
Try every possible assignment of digits to blanks, then check whether the finished board is legal.

### Algorithm
1. Collect the `k` empty cells.
2. Enumerate all `9ᵏ` ways to fill them with digits 1–9.
3. For each complete board, verify every row, column, and 3×3 box.
4. Return the first legal board.

### Complexity
- Time: **O(9ᵏ · 81)** — a typical puzzle has around 50 blanks, giving `9⁵⁰ ≈ 10⁴⁷` boards.
- Space: O(k).

### Drawbacks
- Utterly impossible: `10⁴⁷` is beyond astronomical.
- The waste is structural. Placing two `5`s in the same row is illegal **immediately**, but generate-then-check discovers it only after filling all 50 blanks — having explored `9⁴⁸` doomed completions.
- It also keeps searching after finding an answer, because it has no way to stop.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Fill one blank at a time, reject illegal digits instantly, and — because one solution is enough — return a boolean that unwinds the entire recursion the moment you succeed.**

Three mechanisms:

```text
1. CONSTRAINT SETS  →  "is this digit legal here?" is O(1), not a scan
2. FILL IN ORDER    →  one blank at a time; an illegal prefix is never extended
3. RETURN bool      →  the first solution stops everything
```

### The thought process

```text
We need    : ONE legal completion of the board.
Obvious way: fill everything, then check.
Impossible : 9^50 boards, and illegality is only noticed at the end.
Notice     : a digit is illegal the instant it is placed. Checking then
             discards a whole subtree rather than one leaf.
Notice too : we do not want all solutions — we want one. So the
             recursion should be able to STOP.
Therefore  : backtrack over blanks, check in O(1), and propagate a
             `true` upward the moment the board is full.
Now        : a real puzzle solves in milliseconds.
```

### The one difference from "collect all solutions"

Every earlier backtracking chapter returned `void` and appended to a result list. Here the recursion returns **`bool`**:

```text
COLLECT ALL                      FIND ONE
─────────────────────────        ─────────────────────────
func backtrack()                 func backtrack() bool
    record; keep looping             if solved: return true
                                     if backtrack() { return true }   ← stop
                                     undo
                                 return false
```

That `if backtrack() { return true }` is the whole mechanism. A success at depth 50 returns `true` to depth 49, which returns `true` to depth 48, and so on — the entire search unwinds without trying any remaining candidates. Without it, the solver finds the answer and then keeps going, undoing the very board it just solved.

**This is also why the board is mutated in place and not restored on success.** The `true` return means "the board is final, do not touch it".

### The three constraint sets

Same idea as N-Queens, one dimension richer:

```text
rowSeen[row][digit]      digit already used in this row
colSeen[col][digit]      ... in this column
boxSeen[box][digit]      ... in this 3x3 block

box = (row / 3) * 3 + (col / 3)      integer division
```

Seed all three from the puzzle's given digits **before** the search starts. Then placing a digit is three writes, and undoing it is three writes back.

The alternative — rescanning the row, column, and box on every candidate — is O(27) per check instead of O(1). Correct, but noticeably slower and no simpler to write.

### Steps

```text
Step 1 → Seed rowSeen / colSeen / boxSeen from the given digits.
Step 2 → define solve(index):        index = 0..80 over the flattened board
Step 3 →     if index == 81:  return true          ← board complete
Step 4 →     row, col = index/9, index%9
Step 5 →     if the cell is already filled: return solve(index + 1)
Step 6 →     for digit = 1..9:
Step 7 →         if any of the three sets already has it: skip
Step 8 →         write the digit; mark all three sets       ← choose
Step 9 →         if solve(index + 1): return true           ← explore & STOP
Step 10 →        erase the digit; unmark all three          ← un-choose
Step 11 →    return false                                    ← no digit worked
```

Step 11 matters: returning `false` tells the caller "every digit failed here, so *your* choice was wrong" — which is what makes the backtracking actually back up.

### Ordering heuristics (worth naming, rarely worth writing)

Scanning cells in index order is fine for LeetCode. Real solvers pick the **most constrained cell** next — the blank with the fewest legal digits. That is the *minimum remaining values* heuristic, and it cuts the search dramatically because it fails fast.

Mention it; implement it only if asked. The index-order version is far easier to get right under time pressure.

### Grid search is the same pattern with a different "undo"

Word Search (find a word by stepping through adjacent cells) is this same skeleton, except the constraint is "don't reuse a cell on the current path". The neat trick there is to **mark the cell in the board itself** — overwrite it with a sentinel — and restore it on the way out, avoiding a separate `visited` grid.

### How should I recognize this?

```text
If you see...
  "solve the puzzle", "fill in the blanks", "is there a valid assignment"
  "find a path spelling this word", "can the board be completed"
  ONE answer is enough (not all of them)
        ↓
Think about...
  "What is the next blank? Which candidates are legal in O(1)?
   How do I stop as soon as I succeed?"
        ↓
Use...
  backtracking that returns bool
  constraint sets for O(1) legality
  mutate in place; undo on failure, NOT on success
```

### Visual explanation

```svg
<svg viewBox="0 0 660 270" width="100%" height="270" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-73" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="330" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">Sudoku: try digits in an empty cell, prune ones that clash</text>
  <!-- edges -->
  <line x1="330" y1="52" x2="90"  y2="115" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#a-73)"/>
  <line x1="330" y1="52" x2="250" y2="115" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#a-73)"/>
  <line x1="330" y1="52" x2="410" y2="115" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#a-73)"/>
  <line x1="330" y1="52" x2="570" y2="115" stroke="#059669" marker-end="url(#a-73)"/>
  <line x1="570" y1="149" x2="570" y2="200" stroke="#475569" marker-end="url(#a-73)"/>
  <!-- root -->
  <rect x="250" y="35"  width="160" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="330" y="55"  text-anchor="middle" fill="#1e293b">empty cell (r,c)</text>
  <!-- digit tries -->
  <rect x="30"  y="115" width="120" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="90"  y="130" text-anchor="middle" fill="#b91c1c">try 1 ✗</text><text x="90"  y="144" text-anchor="middle" fill="#64748b">in row</text>
  <rect x="190" y="115" width="120" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="250" y="130" text-anchor="middle" fill="#b91c1c">try 2 ✗</text><text x="250" y="144" text-anchor="middle" fill="#64748b">in column</text>
  <rect x="350" y="115" width="120" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="410" y="130" text-anchor="middle" fill="#b91c1c">try 3 ✗</text><text x="410" y="144" text-anchor="middle" fill="#64748b">in 3x3 box</text>
  <rect x="510" y="115" width="120" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="570" y="130" text-anchor="middle" fill="#059669" font-weight="700">try 4 ✓</text><text x="570" y="144" text-anchor="middle" fill="#64748b">valid</text>
  <!-- recurse -->
  <rect x="490" y="200" width="160" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="570" y="220" text-anchor="middle" fill="#1e293b">recurse next cell →</text>
  <text x="250" y="192" text-anchor="middle" fill="#64748b">clashing digits are pruned before we recurse</text>
  <text x="250" y="220" text-anchor="middle" fill="#475569">if the branch dead-ends, undo &amp; try the next digit</text>
</svg>
```

```text
      5 3 . | . 7 . | . . .
      6 . . | 1 9 5 | . . .
      . 9 8 | . . . | . 6 .
      ------+-------+------
      8 . . | . 6 . | . . 3
      ...

first blank is (0,2). Which digits are legal?

  row 0 already has {5,3,7}          → 5, 3, 7 rejected
  col 2 already has {8}              → 8 rejected
  box 0 already has {5,3,6,9,8}      → 6, 9 also rejected

  candidates: 1, 2, 4        ← try 1 first, recurse; if the rest of the
                               board fails, undo and try 2, then 4
```

### Interview explanation
"This is backtracking with two additions over the enumerate-everything version. First, three constraint sets — row, column, and 3×3 box — seeded from the given digits, so checking whether a digit is legal is O(1) rather than a 27-cell scan. The box index is `(row/3)*3 + col/3`. Second, and more importantly, the recursion returns a boolean instead of `void`, because I only need *one* solution: when a placement leads to a complete board I return `true`, and every caller immediately returns `true` too, so the search stops instead of undoing the answer. I mutate the board in place and only undo on failure. Returning `false` from a cell where no digit worked is what makes the caller back up and revise its own choice."

---

## 5. Generic Templates

> Return `bool` to stop at the first solution. Undo on failure, never on success.

```go
// SolveSudoku fills the board in place. Returns whether a solution exists.
func SolveSudoku(board [][]byte) bool {
    var rowSeen, colSeen, boxSeen [9][9]bool

    // Seed the constraint sets from the given digits.
    for row := 0; row < 9; row++ {
        for col := 0; col < 9; col++ {
            if board[row][col] == '.' {
                continue
            }
            digit := int(board[row][col] - '1')
            rowSeen[row][digit] = true
            colSeen[col][digit] = true
            boxSeen[boxIndex(row, col)][digit] = true
        }
    }

    var solve func(index int) bool
    solve = func(index int) bool {
        if index == 81 {
            return true // every cell filled
        }

        row, col := index/9, index%9
        if board[row][col] != '.' {
            return solve(index + 1) // a given digit: skip it
        }

        box := boxIndex(row, col)
        for digit := 0; digit < 9; digit++ {
            if rowSeen[row][digit] || colSeen[col][digit] || boxSeen[box][digit] {
                continue // O(1) rejection
            }

            board[row][col] = byte('1' + digit) // choose
            rowSeen[row][digit] = true
            colSeen[col][digit] = true
            boxSeen[box][digit] = true

            if solve(index + 1) {
                return true // SUCCESS: stop, and do NOT undo
            }

            board[row][col] = '.' // un-choose
            rowSeen[row][digit] = false
            colSeen[col][digit] = false
            boxSeen[box][digit] = false
        }

        return false // no digit worked here: the caller must revise
    }

    return solve(0)
}

// boxIndex maps a cell to its 3x3 block, numbered row-major 0..8.
func boxIndex(row, col int) int {
    return (row/3)*3 + col/3
}

// SearchGrid is the same skeleton for path-finding in a grid: mark the
// cell in the board itself, and restore it on the way out.
func SearchGrid(board [][]byte, word string) bool {
    if len(word) == 0 {
        return true
    }
    rows, cols := len(board), len(board[0])

    var explore func(row, col, matched int) bool
    explore = func(row, col, matched int) bool {
        if matched == len(word) {
            return true
        }
        if row < 0 || row >= rows || col < 0 || col >= cols {
            return false
        }
        if board[row][col] != word[matched] {
            return false // wrong letter, or already on the path (sentinel)
        }

        original := board[row][col]
        board[row][col] = '#' // mark: cannot be reused on this path

        found := explore(row-1, col, matched+1) ||
            explore(row+1, col, matched+1) ||
            explore(row, col-1, matched+1) ||
            explore(row, col+1, matched+1)

        board[row][col] = original // restore, whatever happened
        return found
    }

    for row := 0; row < rows; row++ {
        for col := 0; col < cols; col++ {
            if explore(row, col, 0) {
                return true
            }
        }
    }
    return false
}
```

```python
def solve_sudoku(board):
    """Fills the board in place. Returns whether a solution exists."""
    row_seen = [[False] * 9 for _ in range(9)]
    col_seen = [[False] * 9 for _ in range(9)]
    box_seen = [[False] * 9 for _ in range(9)]

    def box_index(row, col):
        return (row // 3) * 3 + col // 3

    for row in range(9):                # seed from the given digits
        for col in range(9):
            if board[row][col] == ".":
                continue
            digit = int(board[row][col]) - 1
            row_seen[row][digit] = True
            col_seen[col][digit] = True
            box_seen[box_index(row, col)][digit] = True

    def solve(index):
        if index == 81:
            return True                 # every cell filled

        row, col = divmod(index, 9)
        if board[row][col] != ".":
            return solve(index + 1)     # a given digit

        box = box_index(row, col)
        for digit in range(9):
            if row_seen[row][digit] or col_seen[col][digit] or box_seen[box][digit]:
                continue                # O(1) rejection

            board[row][col] = str(digit + 1)                      # choose
            row_seen[row][digit] = col_seen[col][digit] = box_seen[box][digit] = True

            if solve(index + 1):
                return True             # SUCCESS: stop, do NOT undo

            board[row][col] = "."                                 # un-choose
            row_seen[row][digit] = col_seen[col][digit] = box_seen[box][digit] = False

        return False                    # no digit worked: caller must revise

    return solve(0)
```

```java
public class SudokuSolver {
    private final boolean[][] rowSeen = new boolean[9][9];
    private final boolean[][] colSeen = new boolean[9][9];
    private final boolean[][] boxSeen = new boolean[9][9];

    public boolean solveSudoku(char[][] board) {
        for (int r = 0; r < 9; r++)
            for (int c = 0; c < 9; c++)
                if (board[r][c] != '.') {
                    int d = board[r][c] - '1';
                    rowSeen[r][d] = colSeen[c][d] = boxSeen[boxIndex(r, c)][d] = true;
                }
        return solve(board, 0);
    }

    private boolean solve(char[][] board, int index) {
        if (index == 81) return true;
        int row = index / 9, col = index % 9;
        if (board[row][col] != '.') return solve(board, index + 1);

        int box = boxIndex(row, col);
        for (int d = 0; d < 9; d++) {
            if (rowSeen[row][d] || colSeen[col][d] || boxSeen[box][d]) continue;

            board[row][col] = (char) ('1' + d);                   // choose
            rowSeen[row][d] = colSeen[col][d] = boxSeen[box][d] = true;

            if (solve(board, index + 1)) return true;             // SUCCESS: stop

            board[row][col] = '.';                                // un-choose
            rowSeen[row][d] = colSeen[col][d] = boxSeen[box][d] = false;
        }
        return false;
    }

    private static int boxIndex(int row, int col) { return (row / 3) * 3 + col / 3; }
}
```

```cpp
#include <vector>
using namespace std;

int boxIndex(int row, int col) { return (row / 3) * 3 + col / 3; }

bool solveFrom(vector<vector<char>>& board, int index,
               bool rowSeen[9][9], bool colSeen[9][9], bool boxSeen[9][9]) {
    if (index == 81) return true;
    int row = index / 9, col = index % 9;
    if (board[row][col] != '.') return solveFrom(board, index + 1, rowSeen, colSeen, boxSeen);

    int box = boxIndex(row, col);
    for (int d = 0; d < 9; ++d) {
        if (rowSeen[row][d] || colSeen[col][d] || boxSeen[box][d]) continue;

        board[row][col] = char('1' + d);                          // choose
        rowSeen[row][d] = colSeen[col][d] = boxSeen[box][d] = true;

        if (solveFrom(board, index + 1, rowSeen, colSeen, boxSeen)) return true;  // stop

        board[row][col] = '.';                                    // un-choose
        rowSeen[row][d] = colSeen[col][d] = boxSeen[box][d] = false;
    }
    return false;
}

bool solveSudoku(vector<vector<char>>& board) {
    bool rowSeen[9][9] = {}, colSeen[9][9] = {}, boxSeen[9][9] = {};
    for (int r = 0; r < 9; ++r)
        for (int c = 0; c < 9; ++c)
            if (board[r][c] != '.') {
                int d = board[r][c] - '1';
                rowSeen[r][d] = colSeen[c][d] = boxSeen[boxIndex(r, c)][d] = true;
            }
    return solveFrom(board, 0, rowSeen, colSeen, boxSeen);
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Sudoku Solver (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(branches^depth)** |
| Time (best)  | — | **O(branches^depth)** |
| Time (average) | — | **O(branches^depth)** |
| Space | varies | **O(depth)** |

> Exponential by nature; pruning cuts the constant/branches drastically.

---

## 7. Common Mistakes

1. Forgetting to un-choose (restore state) after recursion.
2. Adding a reference to `path` instead of a copy to the result.
3. Not advancing the start index, producing duplicate combinations.
4. Missing duplicate-skip logic for inputs with repeats.
5. No pruning, causing timeouts on large search spaces.
6. Incorrect base case / termination condition.
7. Using a `used[]` array incorrectly in permutations.
8. Mutating shared structures without restoring them.
9. Exponential memory by storing all partial states.
10. Off-by-one in the recursion depth / level.

---

## 8. Interview Follow-Up Questions

1. **Q: Subsets vs combinations vs permutations?**
   A: Subsets: all sizes. Combinations: choose k with start index. Permutations: order matters, use used[].

2. **Q: How to handle duplicates?**
   A: Sort, then skip equal siblings at the same depth.

3. **Q: Why choose/un-choose?**
   A: It reuses one path buffer across the whole search.

4. **Q: Pruning strategies?**
   A: Bound checks, constraint propagation, ordering choices.

5. **Q: N-Queens pruning?**
   A: Track used columns and both diagonals as sets.

6. **Q: Sudoku?**
   A: Try valid digits per cell; backtrack on contradiction.

7. **Q: Combination sum (reuse allowed)?**
   A: Recurse with the same index `i`.

8. **Q: Time complexity bound?**
   A: Often O(2^n), O(n!), or O(k^n) depending on the tree.

9. **Q: Iterative alternative?**
   A: Bitmask enumeration for subsets.

10. **Q: Memoize backtracking?**
   A: If subproblems overlap, convert to DP.

11. **Q: Generate palindromic partitions?**
   A: Backtrack on cut positions, check palindrome.

12. **Q: Word search in grid?**
   A: DFS with visited marks, backtrack the mark.

13. **Q: Why copy the path?**
   A: The buffer keeps mutating; results need snapshots.

14. **Q: Lexicographic order?**
   A: Iterate choices in sorted order.

15. **Q: Limit results (first k)?**
   A: Early-return once enough solutions are found.

---

## 9. Solved Example 1

### Problem — Sudoku Solver (LeetCode 37)
Fill the empty cells of a 9×9 Sudoku board so every row, column and 3×3 box contains the digits 1–9 exactly once. The puzzle is guaranteed to have a unique solution.

### Thought Process
1. Walk the 81 cells in index order; a given digit is skipped, a blank is a decision point.
2. Three constraint sets — row, column, box — seeded from the givens, make each legality check O(1).
3. Try digits 1–9, rejecting illegal ones before recursing.
4. The recursion returns **`bool`**. On success, return `true` all the way up so the search stops instead of undoing the answer.
5. Undo only on failure. Returning `false` from a blank where nothing fits tells the caller its own digit was wrong.

### Dry Run

Input (the first three rows shown; `.` is blank):

```text
      5 3 . | . 7 . | . . .
      6 . . | 1 9 5 | . . .
      . 9 8 | . . . | . 6 .
```

The first blank is index 2 → `(row 0, col 2)`, which lives in box `(0/3)*3 + (2/3) = 0`.

| candidate | rowSeen[0] has it? | colSeen[2] has it? | boxSeen[0] has it? | verdict |
|-----------|--------------------|---------------------|---------------------|---------|
| 1 | no | no | no | **legal → try it** |
| 2 | no | no | no | legal (tried if 1 fails) |
| 3 | **yes** (row 0 has 3) | — | — | rejected |
| 4 | no | no | no | legal |
| 5 | **yes** (row 0 has 5) | — | — | rejected |
| 6 | no | no | **yes** (box 0 has 6) | rejected |
| 7 | **yes** (row 0 has 7) | — | — | rejected |
| 8 | no | **yes** (col 2 has 8) | — | rejected |
| 9 | no | no | **yes** (box 0 has 9) | rejected |

So only `{1, 2, 4}` are worth trying — six of the nine digits are eliminated by three array lookups.

The search places `1`, recurses, and eventually completes the board. The final answer for this puzzle is:

```text
      5 3 4 | 6 7 8 | 9 1 2
      6 7 2 | 1 9 5 | 3 4 8
      1 9 8 | 3 4 2 | 5 6 7
      ------+-------+------
      8 5 9 | 7 6 1 | 4 2 3
      4 2 6 | 8 5 3 | 7 9 1
      7 1 3 | 9 2 4 | 8 5 6
      ------+-------+------
      9 6 1 | 5 3 7 | 2 8 4
      2 8 7 | 4 1 9 | 6 3 5
      3 4 5 | 2 8 6 | 1 7 9
```

Cell `(0,2)` did indeed end up as `4`, so the first two candidates led to dead ends deeper in the board and were undone. ✓

**What the `true` return prevents.** Suppose the last blank is filled successfully at depth 50. That call returns `true`; depth 49 sees it and returns `true` without trying its remaining digits; and so on to depth 0. If the function returned `void` instead, depth 49 would carry on, erase its digit in the un-choose step, and destroy the solved board.

### Visualization

```text
index order:  0  1  2  3 ... 80

  cell 0 = '5'  given   → skip
  cell 1 = '3'  given   → skip
  cell 2 = '.'  blank   → candidates {1,2,4}   (6 digits rejected in O(1))
                            try 1 → recurse
                              ... deeper failure ...
                            undo, try 2 → recurse
                              ... deeper failure ...
                            undo, try 4 → recurse → eventually true
                          return true, and every caller returns true
```

### Code

```go
func solveSudoku(board [][]byte) {
    var rowSeen, colSeen, boxSeen [9][9]bool

    boxOf := func(row, col int) int { return (row/3)*3 + col/3 }

    // Seed the constraint sets from the given digits.
    for row := 0; row < 9; row++ {
        for col := 0; col < 9; col++ {
            if board[row][col] == '.' {
                continue
            }
            digit := int(board[row][col] - '1')
            rowSeen[row][digit] = true
            colSeen[col][digit] = true
            boxSeen[boxOf(row, col)][digit] = true
        }
    }

    var solve func(index int) bool
    solve = func(index int) bool {
        if index == 81 {
            return true // every cell filled
        }

        row, col := index/9, index%9
        if board[row][col] != '.' {
            return solve(index + 1) // a given digit, nothing to decide
        }

        box := boxOf(row, col)
        for digit := 0; digit < 9; digit++ {
            if rowSeen[row][digit] || colSeen[col][digit] || boxSeen[box][digit] {
                continue // O(1) rejection
            }

            board[row][col] = byte('1' + digit) // choose
            rowSeen[row][digit] = true
            colSeen[col][digit] = true
            boxSeen[box][digit] = true

            if solve(index + 1) {
                return true // SUCCESS: unwind without undoing
            }

            board[row][col] = '.' // un-choose (failure only)
            rowSeen[row][digit] = false
            colSeen[col][digit] = false
            boxSeen[box][digit] = false
        }

        return false // nothing fits here: the caller's digit was wrong
    }

    solve(0)
}
```

```python
def solveSudoku(board):
    row_seen = [[False] * 9 for _ in range(9)]
    col_seen = [[False] * 9 for _ in range(9)]
    box_seen = [[False] * 9 for _ in range(9)]

    def box_of(row, col):
        return (row // 3) * 3 + col // 3

    for row in range(9):                    # seed from the givens
        for col in range(9):
            if board[row][col] == ".":
                continue
            d = int(board[row][col]) - 1
            row_seen[row][d] = col_seen[col][d] = box_seen[box_of(row, col)][d] = True

    def solve(index):
        if index == 81:
            return True                     # every cell filled

        row, col = divmod(index, 9)
        if board[row][col] != ".":
            return solve(index + 1)         # a given digit

        box = box_of(row, col)
        for d in range(9):
            if row_seen[row][d] or col_seen[col][d] or box_seen[box][d]:
                continue                    # O(1) rejection

            board[row][col] = str(d + 1)                          # choose
            row_seen[row][d] = col_seen[col][d] = box_seen[box][d] = True

            if solve(index + 1):
                return True                 # SUCCESS: do NOT undo

            board[row][col] = "."                                 # un-choose
            row_seen[row][d] = col_seen[col][d] = box_seen[box][d] = False

        return False                        # caller's digit was wrong

    solve(0)
```

### Complexity
Time **O(9^b)** in theory for `b` blanks, but the constraint pruning collapses it — real puzzles solve in milliseconds. Space O(1): the board is fixed size and the recursion depth is at most 81.

---

## 10. Solved Example 2

### Problem — N-Queens (LeetCode 51), stopping at the first solution
Place `n` non-attacking queens. LeetCode 51 asks for **all** arrangements; here we find just **one**, to isolate the return-boolean mechanism.

### Thought Process
1. Same constraint-set search as the N-Queens chapter: one queen per row, with column and both diagonals tracked.
2. The only change is the return type. `bool` instead of `void`, and `if place(row+1) { return true }` instead of a bare recursive call.
3. That single line converts "enumerate everything" into "stop at the first success" — and it is the difference between the two problem statements.
4. On success nothing is undone; the board is the answer.
5. Returning `false` after the loop means every column failed, so the caller must move its own queen.

### Dry Run

Input: `n = 4`

| row | column tried | conflict? | action |
|-----|--------------|-----------|--------|
| 0 | 0 | none | place; recurse |
| 1 | 0, 1 | column / diagonal | rejected |
| 1 | 2 | none | place; recurse |
| 2 | 0..3 | all conflict | **return `false`** → row 1 undoes col 2 |
| 1 | 3 | none | place; recurse |
| 2 | 0 | none | place; recurse |
| 3 | 0..3 | all conflict | **return `false`** → unwinds to row 0 |
| 0 | 1 | none | place; recurse |
| 1 | 3 | none | place; recurse |
| 2 | 0 | none | place; recurse |
| 3 | 2 | none | place → `row == 4` → **return `true`** |

The `true` at row 3 propagates: row 2 returns `true` without trying column 3, row 1 returns `true`, row 0 returns `true`. The search stops.

Output:

```text
. Q . .
. . . Q
Q . . .
. . Q .
```

✓ — this is the first of the two solutions for `n = 4`.

**Contrast with collecting all.** The all-solutions version records the board at `row == n` and then *continues* the loop, eventually finding the mirror image `[2,0,3,1]` as well. Here the first `true` cuts off that entire remaining search.

### Visualization

```text
find ONE                          find ALL
──────────────────────            ──────────────────────
if place(row+1) {                 place(row+1)
    return true                   // loop keeps going
}
undo                              undo

row 3 succeeds → true             row 3 succeeds → record
  → row 2 returns true              → row 2 keeps trying col 3
    → row 1 returns true              → ... finds the 2nd solution
      → done, 1 board                 → done, 2 boards
```

### Code

```go
// solveNQueensAny returns one valid board, or nil if none exists.
func solveNQueensAny(n int) []string {
    queenCol := make([]int, n)
    cols := make([]bool, n)
    diag := make([]bool, 2*n-1) // "\" diagonals: row-col+n-1
    anti := make([]bool, 2*n-1) // "/" diagonals: row+col

    var place func(row int) bool
    place = func(row int) bool {
        if row == n {
            return true // a complete placement
        }

        for col := 0; col < n; col++ {
            d, a := row-col+n-1, row+col
            if cols[col] || diag[d] || anti[a] {
                continue
            }

            cols[col], diag[d], anti[a] = true, true, true // choose
            queenCol[row] = col

            if place(row + 1) {
                return true // SUCCESS: stop, leave the marks in place
            }

            cols[col], diag[d], anti[a] = false, false, false // un-choose
        }

        return false // no column worked: the caller must move its queen
    }

    if !place(0) {
        return nil
    }

    board := make([]string, n)
    for row := 0; row < n; row++ {
        line := make([]byte, n)
        for c := range line {
            line[c] = '.'
        }
        line[queenCol[row]] = 'Q'
        board[row] = string(line)
    }
    return board
}
```

```python
def solveNQueensAny(n):
    """One valid board, or None. The bool return is the only difference
    from the collect-all version."""
    queen_col = [0] * n
    cols = [False] * n
    diag = [False] * (2 * n - 1)
    anti = [False] * (2 * n - 1)

    def place(row):
        if row == n:
            return True                 # a complete placement

        for col in range(n):
            d, a = row - col + n - 1, row + col
            if cols[col] or diag[d] or anti[a]:
                continue

            cols[col] = diag[d] = anti[a] = True     # choose
            queen_col[row] = col

            if place(row + 1):
                return True             # SUCCESS: stop

            cols[col] = diag[d] = anti[a] = False    # un-choose

        return False                    # caller must move its queen

    if not place(0):
        return None
    return ["." * c + "Q" + "." * (n - c - 1) for c in queen_col]
```

### Complexity
Same worst case as the collect-all version, but it stops at the first success — typically far sooner. Space O(n).

---

## 11. Solved Example 3

### Problem — Word Search (LeetCode 79)
Given a grid of characters and a word, return `true` if the word can be spelled by moving between horizontally or vertically adjacent cells, using each cell **at most once**.

### Thought Process
1. Try every cell as a starting point; from each, walk in four directions matching the word one letter at a time.
2. The constraint is "no cell reused **on the current path**" — which is per-path, not global. A cell rejected on one path must be available on another.
3. So a global `visited` grid would be wrong unless carefully unmarked. The neat move is to **mark the cell in the board itself** with a sentinel and restore it on the way out.
4. That sentinel does double duty: it can never equal a letter of the word, so the ordinary "does this cell match?" test also rejects revisits — no separate check needed.
5. Return `bool`, stopping at the first successful path.

### Dry Run

Input:

```text
board = A B C E
        S F C S
        A D E E
```

**Searching for `"ABCCED"`:**

| step | cell | letter needed | match? | action |
|------|------|---------------|--------|--------|
| 1 | (0,0) | `A` | yes | mark `#`, need `B` |
| 2 | (0,1) | `B` | yes | mark `#`, need `C` |
| 3 | (0,2) | `C` | yes | mark `#`, need `C` |
| 4 | (0,3) `E`, (1,2) `C` | `C` | (1,2) matches | mark `#`, need `E` |
| 5 | (2,2) | `E` | yes | mark `#`, need `D` |
| 6 | (2,1) | `D` | yes | mark `#`, word complete → **`true`** |

Output: **`true`** ✓ — the path is `(0,0) → (0,1) → (0,2) → (1,2) → (2,2) → (2,1)`.

**Searching for `"ABCB"`:**

| step | cell | letter needed | note |
|------|------|---------------|------|
| 1 | (0,0) | `A` | mark `#` |
| 2 | (0,1) | `B` | mark `#` |
| 3 | (0,2) | `C` | mark `#` |
| 4 | back to (0,1) | `B` | the cell now holds `#`, **not** `B` → rejected |
| — | all other neighbours of (0,2) fail | | → unwind, and no start succeeds |

Output: **`false`** ✓

That step 4 is the whole point of the sentinel: without it, the walk would happily reuse `(0,1)` and wrongly report `true`.

### Visualization

```text
board:   A  B  C  E          searching "ABCCED"
         S  F  C  S
         A  D  E  E

path:    A→ B→ C
                ↓
               C            marked cells hold '#', so the path
                ↓            cannot step back onto itself
            D← E

for "ABCB": A→B→C, then B is needed again — but that cell now
reads '#', so the match fails.  Restoring on the way out means
the cell is available again for a different starting path.
```

### Code

```go
func exist(board [][]byte, word string) bool {
    if len(word) == 0 {
        return true
    }
    rows, cols := len(board), len(board[0])

    var explore func(row, col, matched int) bool
    explore = func(row, col, matched int) bool {
        if matched == len(word) {
            return true // the whole word has been matched
        }
        if row < 0 || row >= rows || col < 0 || col >= cols {
            return false
        }
        // A '#' sentinel can never equal a letter, so this single test
        // rejects both wrong letters AND cells already on this path.
        if board[row][col] != word[matched] {
            return false
        }

        original := board[row][col]
        board[row][col] = '#' // mark: off-limits for the rest of this path

        found := explore(row-1, col, matched+1) ||
            explore(row+1, col, matched+1) ||
            explore(row, col-1, matched+1) ||
            explore(row, col+1, matched+1)

        board[row][col] = original // restore: other paths may use this cell
        return found
    }

    for row := 0; row < rows; row++ {
        for col := 0; col < cols; col++ {
            if explore(row, col, 0) {
                return true // SUCCESS: stop searching
            }
        }
    }
    return false
}
```

```python
def exist(board, word):
    if not word:
        return True
    rows, cols = len(board), len(board[0])

    def explore(row, col, matched):
        if matched == len(word):
            return True                 # whole word matched
        if not (0 <= row < rows and 0 <= col < cols):
            return False
        # '#' never equals a letter, so this rejects wrong letters AND
        # cells already on the current path.
        if board[row][col] != word[matched]:
            return False

        original = board[row][col]
        board[row][col] = "#"           # mark: off-limits for this path

        found = (explore(row - 1, col, matched + 1)
                 or explore(row + 1, col, matched + 1)
                 or explore(row, col - 1, matched + 1)
                 or explore(row, col + 1, matched + 1))

        board[row][col] = original      # restore for other paths
        return found

    for row in range(rows):
        for col in range(cols):
            if explore(row, col, 0):
                return True
    return False
```

### Complexity
Time **O(rows · cols · 4^L)** for a word of length `L` — each start explores up to four directions per letter. Space **O(L)** for the recursion; the in-board marking uses no extra grid.

> The restore-on-the-way-out is what makes the constraint *per-path* rather than global. Every backtracking problem in this chapter shares that shape — the only real variation is what "mark" and "restore" mean.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 37 | Sudoku Solver | Easy | Core backtracking application |
| 51 | N-Queens | Easy | Core backtracking application |
| 79 | Word Search | Medium | Core backtracking application |
| 36 | Valid Sudoku | Medium | Core backtracking application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Subsets (power set)**
- **Combinations**
- **Permutations**
- **Constraint solving (N-Queens, Sudoku)**
- **Grid DFS / word search**

---

## 14. Production Engineering Applications

- **Scalability:** Backtracking solves configuration/constraint problems: test-case generation, SAT-style feasibility, resource allocation, and puzzle/AI move generation. Pruning is the difference between feasible and intractable in production solvers.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(depth)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Sudoku Solver logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Sudoku Solver (Backtracking).
- **Signal:** sudoku, constraint propagation, backtracking, grid, try undo.
- **Move:** DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.
- **Cost:** O(branches^depth) time, O(depth) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Sudoku Solver invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Sudoku Solver
FAMILY : Backtracking (Advanced)
WHEN   : sudoku, constraint propagation, backtracking, grid, try undo
DO     : DFS over the decision tree with pruning. Each recursion makes a choice, recurses
TIME   : O(branches^depth)    SPACE: O(depth)
PRACTICE: 37, 51, 79, 36
```

---

*Part of the DSA Patterns Handbook — pattern 73 of 100.*
