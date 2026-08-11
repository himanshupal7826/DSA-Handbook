# 72 · N Queens

> **One-liner:** Place queens column by column, pruning conflicting diagonals/rows.

---

## 1. Overview

### Definition
The **N Queens** pattern belongs to the *Backtracking* family. Place queens column by column, pruning conflicting diagonals/rows.

### Intuition
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Why it works
Build candidates incrementally; prune branches that can't lead to a solution (choose → explore → un-choose). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Backtracking solves configuration/constraint problems: test-case generation, SAT-style feasibility, resource allocation, and puzzle/AI move generation. Pruning is the difference between feasible and intractable in production solvers.

---

## 2. Recognition Signals

### Keywords
n queens, backtracking, constraints, diagonal, prune.

### Constraints
- Input size where the brute-force complexity would time out — the N Queens optimization is the intended solution.
- Structural hints in the statement that match this family (Backtracking).

### Hidden clues
- The problem can be reframed so the N Queens invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — N Queens is the upgrade.
- The wording maps onto: n queens, backtracking, constraints, diagonal, prune.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Place things on a board so that none of them conflict."*

### Intuition
Try every way to put `n` queens on `n²` squares, then check each arrangement.

### Algorithm
1. Enumerate every choice of `n` squares from the `n²` available.
2. For each arrangement, compare all `C(n,2)` pairs of queens.
3. Keep the arrangements where no pair shares a row, column, or diagonal.

### Complexity
- Time: **C(n², n) · n²** — for `n = 8` that is over 4 billion arrangements before any checking.
- Space: O(n).

### Drawbacks
- It ignores a fact the problem hands you for free: **no two queens can share a row**, so there is exactly one queen per row. That alone cuts the search space from `C(n², n)` to `nⁿ`.
- And it validates only at the very end. Two queens attacking each other in the first two rows dooms every completion, yet the brute force explores all of them.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Place one queen per row, and before placing each one, check in O(1) whether its column or either diagonal is already taken.**

Two ideas combine:

```text
1. ONE QUEEN PER ROW    →  the search is a choice of column per row: n^n, not C(n², n)
2. O(1) CONFLICT CHECK  →  maintain sets of used columns and diagonals
```

### The thought process

```text
We need    : all non-attacking placements of n queens.
Obvious way: try every set of n squares, then validate.
Hopeless   : C(n², n) arrangements, validated pairwise at the end.
Notice     : no two queens share a row ⇒ exactly one per row.
             So "which squares" becomes "which column for each row".
Notice too : a conflict can be detected the MOMENT a queen is placed,
             killing an entire subtree instead of a single leaf.
Therefore  : recurse row by row; keep sets of occupied columns and
             diagonals so each check is O(1).
Now        : n=8 solves instantly.
```

### The diagonal trick, which is the whole chapter

Checking "does this square share a diagonal with any placed queen?" looks like it needs a scan. It doesn't, because of two identities:

```text
"\" diagonals (top-left to bottom-right):   row - col  is CONSTANT
"/" diagonals (top-right to bottom-left):   row + col  is CONSTANT
```

Verify on a 4×4 board — the value of `row + col` for each square:

```text
      col 0   1   2   3
row 0   0   1   2   3
row 1   1   2   3   4
row 2   2   3   4   5
row 3   3   4   5   6
```

Every anti-diagonal has one value. Likewise `row − col` is constant along the other diagonal. So a diagonal is just a number, and "is it taken?" is an array lookup.

**Index shifting.** `row + col` ranges over `0 … 2n−2`, so an array of size `2n−1` holds it directly. But `row − col` ranges over `−(n−1) … n−1`, which cannot index an array — shift it by `n − 1`:

```go
diag  := row - col + n - 1   // 0 .. 2n-2
anti  := row + col           // 0 .. 2n-2
```

### Steps

```text
Step 1 → cols, diag, anti = all false; board = empty
Step 2 → define place(row):
Step 3 →     if row == n:  record the board;  return
Step 4 →     for col = 0 .. n-1:
Step 5 →         if cols[col] or diag[row-col+n-1] or anti[row+col]: skip
Step 6 →         mark all three; put a queen at (row, col)      ← choose
Step 7 →         place(row + 1)                                 ← explore
Step 8 →         unmark all three; remove the queen             ← un-choose
```

Step 8 must undo **all three** marks. Forgetting one leaves the board permanently over-constrained and silently loses solutions.

### Why this prunes so hard

The check in step 5 rejects a square before recursing, so an invalid prefix is never extended. For `n = 8` the theoretical `8⁸ ≈ 16.7 million` column choices collapse to about **2,057 nodes actually visited**, yielding 92 solutions. The constraint sets are doing almost all the work.

### Counting versus listing

If the problem asks only **how many** solutions exist (LeetCode 52), do not build boards. Increment a counter at step 3 and skip the string construction entirely — it is the same search with the output stage removed, and noticeably faster.

### The same shape, other problems

| Problem | One decision | Constraint sets |
|---|---|---|
| N-Queens | which column for this row | columns, both diagonals |
| Sudoku | which digit for this cell | row, column, 3×3 box |
| Graph colouring | which colour for this node | colours used by neighbours |
| Word Search | which direction to step | cells already on the path |

The recipe is identical: **pick the next slot, try each candidate, reject with an O(1) check, recurse, undo.**

### How should I recognize this?

```text
If you see...
  "place N things so none conflict", "N-Queens", "sudoku"
  "colour the map", "assign without collisions"
  a board or grid with rules about what may share a line/region
        ↓
Think about...
  "What is one decision? What constraint sets make the
   conflict check O(1) instead of a scan?"
        ↓
Use...
  recurse over slots (one per row/cell)
  boolean sets for each constraint dimension
  mark → recurse → unmark, undoing EVERY mark
```

### Visual explanation

```svg
<svg viewBox="0 0 660 290" width="100%" height="290" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-72" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="330" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">4-Queens: one queen per row, prune columns that attack</text>
  <!-- row0 to row1 choices, given queen at (row0,col1) -->
  <line x1="330" y1="52" x2="90"  y2="110" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#a-72)"/>
  <line x1="330" y1="52" x2="250" y2="110" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#a-72)"/>
  <line x1="330" y1="52" x2="410" y2="110" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#a-72)"/>
  <line x1="330" y1="52" x2="570" y2="110" stroke="#059669" marker-end="url(#a-72)"/>
  <line x1="570" y1="140" x2="570" y2="200" stroke="#475569" marker-end="url(#a-72)"/>
  <!-- root -->
  <rect x="258" y="35"  width="144" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="330" y="55"  text-anchor="middle" fill="#1e293b">row0: Q at col1</text>
  <!-- row1 candidates -->
  <rect x="30"  y="110" width="120" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="90"  y="125" text-anchor="middle" fill="#b91c1c">r1=c0 ✗</text><text x="90"  y="139" text-anchor="middle" fill="#64748b">diagonal</text>
  <rect x="190" y="110" width="120" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="250" y="125" text-anchor="middle" fill="#b91c1c">r1=c1 ✗</text><text x="250" y="139" text-anchor="middle" fill="#64748b">same col</text>
  <rect x="350" y="110" width="120" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="410" y="125" text-anchor="middle" fill="#b91c1c">r1=c2 ✗</text><text x="410" y="139" text-anchor="middle" fill="#64748b">diagonal</text>
  <rect x="510" y="110" width="120" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="570" y="125" text-anchor="middle" fill="#059669" font-weight="700">r1=c3 ✓</text><text x="570" y="139" text-anchor="middle" fill="#64748b">safe</text>
  <!-- continue -->
  <rect x="498" y="200" width="144" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="570" y="220" text-anchor="middle" fill="#1e293b">recurse row2 …</text>
  <text x="250" y="185" text-anchor="middle" fill="#64748b">3 of 4 columns pruned before recursing deeper</text>
  <text x="250" y="215" text-anchor="middle" fill="#475569">backtrack, undo the placement, try the next column</text>
</svg>
```

```text
n = 4, placing row by row

row 0:  . Q . .        col 1 taken, diag/anti marked
row 1:  . . . Q        cols 0 and 2 rejected by diagonal conflicts
row 2:  Q . . .
row 3:  . . Q .        complete → record

row+col identifies the "/" diagonals:

      col 0  1  2  3
row 0    0  1  2  3
row 1    1  2  3  4
row 2    2  3  4  5
row 3    3  4  5  6      ← every anti-diagonal has one value
```

### Interview explanation
"The key simplification is that no two queens can share a row, so there is exactly one queen per row and the problem becomes choosing a column for each row — that's `nⁿ` instead of `C(n², n)`. Then I make the conflict check O(1) using two identities: along one diagonal `row − col` is constant, and along the other `row + col` is constant. So I keep three boolean arrays — columns, `row−col` shifted by `n−1` to make it non-negative, and `row+col` — and before placing a queen I check all three. Because the check happens before recursing, an invalid prefix is never extended, which prunes enormously: for `n = 8` it visits about two thousand nodes instead of sixteen million. The un-choose step has to clear all three marks. If the problem only wants the count, I skip building the board strings entirely."

---

## 5. Generic Templates

> One decision per row, three O(1) constraint sets, undo every mark.

```go
// SolveNQueens returns every arrangement as a list of board rows.
func SolveNQueens(n int) [][]string {
    result := [][]string{}

    queenCol := make([]int, n)      // queenCol[row] = the column used
    cols := make([]bool, n)         // occupied columns
    diag := make([]bool, 2*n-1)     // "\" diagonals, keyed by row-col+n-1
    anti := make([]bool, 2*n-1)     // "/" diagonals, keyed by row+col

    var place func(row int)
    place = func(row int) {
        if row == n {
            result = append(result, renderBoard(queenCol, n))
            return
        }

        for col := 0; col < n; col++ {
            d, a := row-col+n-1, row+col
            if cols[col] || diag[d] || anti[a] {
                continue // O(1) rejection, before any recursion
            }

            cols[col], diag[d], anti[a] = true, true, true // choose
            queenCol[row] = col

            place(row + 1) // explore

            cols[col], diag[d], anti[a] = false, false, false // un-choose ALL
        }
    }

    place(0)
    return result
}

// renderBoard turns the column choices into the string form.
func renderBoard(queenCol []int, n int) []string {
    board := make([]string, n)
    for row := 0; row < n; row++ {
        line := make([]byte, n)
        for col := range line {
            line[col] = '.'
        }
        line[queenCol[row]] = 'Q'
        board[row] = string(line)
    }
    return board
}

// CountNQueens is the same search with the output stage removed.
func CountNQueens(n int) int {
    count := 0
    cols := make([]bool, n)
    diag := make([]bool, 2*n-1)
    anti := make([]bool, 2*n-1)

    var place func(row int)
    place = func(row int) {
        if row == n {
            count++ // no board is built
            return
        }
        for col := 0; col < n; col++ {
            d, a := row-col+n-1, row+col
            if cols[col] || diag[d] || anti[a] {
                continue
            }
            cols[col], diag[d], anti[a] = true, true, true
            place(row + 1)
            cols[col], diag[d], anti[a] = false, false, false
        }
    }

    place(0)
    return count
}
```

```python
def solve_n_queens(n):
    """Every arrangement, as a list of board rows."""
    result = []
    queen_col = [0] * n
    cols = [False] * n                  # occupied columns
    diag = [False] * (2 * n - 1)        # "\" diagonals: row - col + n - 1
    anti = [False] * (2 * n - 1)        # "/" diagonals: row + col

    def place(row):
        if row == n:
            result.append(["." * c + "Q" + "." * (n - c - 1) for c in queen_col])
            return

        for col in range(n):
            d, a = row - col + n - 1, row + col
            if cols[col] or diag[d] or anti[a]:
                continue                # O(1) rejection before recursing

            cols[col] = diag[d] = anti[a] = True    # choose
            queen_col[row] = col
            place(row + 1)                          # explore
            cols[col] = diag[d] = anti[a] = False   # un-choose ALL

    place(0)
    return result

def count_n_queens(n):
    """Same search, output stage removed."""
    cols = [False] * n
    diag = [False] * (2 * n - 1)
    anti = [False] * (2 * n - 1)
    count = 0

    def place(row):
        nonlocal count
        if row == n:
            count += 1
            return
        for col in range(n):
            d, a = row - col + n - 1, row + col
            if cols[col] or diag[d] or anti[a]:
                continue
            cols[col] = diag[d] = anti[a] = True
            place(row + 1)
            cols[col] = diag[d] = anti[a] = False

    place(0)
    return count
```

```java
import java.util.*;

public class NQueens {
    public static List<List<String>> solveNQueens(int n) {
        List<List<String>> result = new ArrayList<>();
        int[] queenCol = new int[n];
        boolean[] cols = new boolean[n];
        boolean[] diag = new boolean[2 * n - 1];    // row - col + n - 1
        boolean[] anti = new boolean[2 * n - 1];    // row + col
        place(0, n, queenCol, cols, diag, anti, result);
        return result;
    }

    private static void place(int row, int n, int[] queenCol, boolean[] cols,
                              boolean[] diag, boolean[] anti,
                              List<List<String>> result) {
        if (row == n) {
            List<String> board = new ArrayList<>();
            for (int r = 0; r < n; r++) {
                char[] line = new char[n];
                Arrays.fill(line, '.');
                line[queenCol[r]] = 'Q';
                board.add(new String(line));
            }
            result.add(board);
            return;
        }

        for (int col = 0; col < n; col++) {
            int d = row - col + n - 1, a = row + col;
            if (cols[col] || diag[d] || anti[a]) continue;   // O(1) rejection

            cols[col] = diag[d] = anti[a] = true;            // choose
            queenCol[row] = col;
            place(row + 1, n, queenCol, cols, diag, anti, result);
            cols[col] = diag[d] = anti[a] = false;           // un-choose ALL
        }
    }
}
```

```cpp
#include <string>
#include <vector>
using namespace std;

void place(int row, int n, vector<int>& queenCol, vector<bool>& cols,
           vector<bool>& diag, vector<bool>& anti,
           vector<vector<string>>& result) {
    if (row == n) {
        vector<string> board;
        for (int r = 0; r < n; ++r) {
            string line(n, '.');
            line[queenCol[r]] = 'Q';
            board.push_back(line);
        }
        result.push_back(board);
        return;
    }

    for (int col = 0; col < n; ++col) {
        int d = row - col + n - 1, a = row + col;
        if (cols[col] || diag[d] || anti[a]) continue;      // O(1) rejection

        cols[col] = diag[d] = anti[a] = true;               // choose
        queenCol[row] = col;
        place(row + 1, n, queenCol, cols, diag, anti, result);
        cols[col] = diag[d] = anti[a] = false;              // un-choose ALL
    }
}

vector<vector<string>> solveNQueens(int n) {
    vector<vector<string>> result;
    vector<int> queenCol(n);
    vector<bool> cols(n, false), diag(2 * n - 1, false), anti(2 * n - 1, false);
    place(0, n, queenCol, cols, diag, anti, result);
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | N Queens (Optimal) |
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

### Problem — N-Queens (LeetCode 51)
Place `n` queens on an `n × n` board so that none attack each other. Return every distinct solution as a list of board rows.

### Thought Process
1. No two queens share a row, so place exactly one per row — the search becomes "which column for each row".
2. Conflicts are column, `"\"` diagonal, and `"/"` diagonal. Keep a boolean array for each so every check is O(1).
3. `row − col` is constant along a `"\"` diagonal; shift by `n − 1` to make it a valid index. `row + col` is constant along a `"/"` diagonal and is already non-negative.
4. Check before recursing, so an invalid prefix is never extended.
5. Un-choose must clear all three marks.

### Dry Run

Input: `n = 4`

The recursion places one queen per row, rejecting any column whose column-, diag- or anti-set is already marked.

| row | columns tried | outcome |
|-----|---------------|---------|
| 0 | col 0 | placed; marks `cols[0]`, `diag[3]`, `anti[0]` |
| 1 | col 0 ✗ (column), col 1 ✗ (anti = 2? no — `diag[1-1+3]=3` taken) , col 2 ✓ | placed |
| 2 | every column conflicts | **dead end → backtrack** |
| 1 | col 3 ✓ | placed |
| 2 | col 1 ✓ | placed |
| 3 | every column conflicts | **dead end → backtrack all the way** |
| 0 | col 1 ✓ | placed; marks `cols[1]`, `diag[1-... ]`, `anti[1]` |
| 1 | col 3 ✓ | placed |
| 2 | col 0 ✓ | placed |
| 3 | col 2 ✓ | **row == 4 → record** |

First solution — queen columns `[1, 3, 0, 2]`:

```text
. Q . .
. . . Q
Q . . .
. . Q .
```

Continuing the search finds the mirror image, columns `[2, 0, 3, 1]`:

```text
. . Q .
Q . . .
. . . Q
. Q . .
```

Output: **both boards** ✓ — `n = 4` has exactly 2 solutions.

**Check one conflict by hand.** Queens at `(0,1)` and `(1,3)`: different columns ✓; `row − col` is `−1` and `−2` — different ✓; `row + col` is `1` and `4` — different ✓. No attack. Now try `(0,1)` and `(1,2)`: `row + col` is `1` and `3` (fine), but `row − col` is `−1` and `−1` — **same `"\"` diagonal**, so it is rejected. That is the `diag` array doing its job in O(1).

### Visualization

```text
row - col  (the "\" diagonals), n = 4, shifted by +3 to index an array:

      col 0  1  2  3
row 0    3  2  1  0
row 1    4  3  2  1
row 2    5  4  3  2
row 3    6  5  4  3
         ↑
   every "\" diagonal carries one value

solution [1,3,0,2]:
        . Q . .
        . . . Q
        Q . . .
        . . Q .
```

### Code

```go
func solveNQueens(n int) [][]string {
    result := [][]string{}

    queenCol := make([]int, n)  // queenCol[row] = chosen column
    cols := make([]bool, n)     // occupied columns
    diag := make([]bool, 2*n-1) // "\" diagonals, keyed by row-col+n-1
    anti := make([]bool, 2*n-1) // "/" diagonals, keyed by row+col

    var place func(row int)
    place = func(row int) {
        if row == n { // all rows filled: a complete solution
            board := make([]string, n)
            for r := 0; r < n; r++ {
                line := make([]byte, n)
                for c := range line {
                    line[c] = '.'
                }
                line[queenCol[r]] = 'Q'
                board[r] = string(line)
            }
            result = append(result, board)
            return
        }

        for col := 0; col < n; col++ {
            // row-col is constant along a "\" diagonal, shifted to be >= 0.
            // row+col is constant along a "/" diagonal.
            d, a := row-col+n-1, row+col

            if cols[col] || diag[d] || anti[a] {
                continue // O(1) rejection, before recursing
            }

            cols[col], diag[d], anti[a] = true, true, true // choose
            queenCol[row] = col

            place(row + 1) // explore

            cols[col], diag[d], anti[a] = false, false, false // un-choose ALL
        }
    }

    place(0)
    return result
}
```

```python
def solveNQueens(n):
    result = []
    queen_col = [0] * n
    cols = [False] * n                  # occupied columns
    diag = [False] * (2 * n - 1)        # "\" diagonals: row - col + n - 1
    anti = [False] * (2 * n - 1)        # "/" diagonals: row + col

    def place(row):
        if row == n:
            result.append(["." * c + "Q" + "." * (n - c - 1) for c in queen_col])
            return

        for col in range(n):
            d, a = row - col + n - 1, row + col
            if cols[col] or diag[d] or anti[a]:
                continue                # O(1) rejection before recursing

            cols[col] = diag[d] = anti[a] = True     # choose
            queen_col[row] = col
            place(row + 1)                           # explore
            cols[col] = diag[d] = anti[a] = False    # un-choose ALL

    place(0)
    return result
```

### Complexity
Time **O(n!)** loosely — row `0` has `n` choices, row `1` at most `n−1`, and so on, with the constraint sets pruning far below that in practice. Space O(n) for the arrays and recursion, excluding the output.

---

## 10. Solved Example 2

### Problem — N-Queens II (LeetCode 52)
Return only the **number** of distinct solutions.

### Thought Process
1. Identical search. The only change is what happens at a complete placement.
2. Instead of building `n` strings, increment a counter — the board is never materialised.
3. That removes an O(n²) step per solution, which matters at `n = 9` where there are 352 solutions.
4. Nothing about the pruning or the constraint sets changes.
5. This is the general lesson: **when a problem asks "how many", delete the output stage rather than writing a different algorithm.**

### Dry Run

Input: `n = 4`

The search visits exactly the same nodes as Example 1. The two complete placements — columns `[1,3,0,2]` and `[2,0,3,1]` — each hit `row == n` and increment the counter.

| complete placement reached | counter |
|----------------------------|---------|
| `[1, 3, 0, 2]` | 1 |
| `[2, 0, 3, 1]` | **2** |

Output: **2** ✓

**How much pruning is happening?** For `n = 8` there are `8⁸ = 16,777,216` ways to pick a column per row. The constraint checks reduce the nodes actually visited to roughly two thousand, and 92 of those are complete solutions. The O(1) rejection in the loop is what makes that difference.

Known values worth remembering as a sanity check:

| n | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| solutions | 1 | 0 | 0 | 2 | 10 | 4 | 40 | 92 |

`n = 2` and `n = 3` have **zero** solutions — a useful edge case, since the recursion must simply exhaust every branch and return 0.

### Visualization

```text
same tree as Example 1, different leaf action:

  row == n  →  Example 1: build n strings, append to result
            →  Example 2: count++          (no allocation at all)

n = 4  →  2 leaves reached  →  answer 2
n = 8  →  92 leaves reached out of ~2,000 nodes visited
```

### Code

```go
func totalNQueens(n int) int {
    count := 0

    cols := make([]bool, n)
    diag := make([]bool, 2*n-1)
    anti := make([]bool, 2*n-1)

    var place func(row int)
    place = func(row int) {
        if row == n {
            count++ // the only difference: no board is built
            return
        }

        for col := 0; col < n; col++ {
            d, a := row-col+n-1, row+col
            if cols[col] || diag[d] || anti[a] {
                continue
            }

            cols[col], diag[d], anti[a] = true, true, true
            place(row + 1)
            cols[col], diag[d], anti[a] = false, false, false
        }
    }

    place(0)
    return count
}
```

```python
def totalNQueens(n):
    cols = [False] * n
    diag = [False] * (2 * n - 1)
    anti = [False] * (2 * n - 1)
    count = 0

    def place(row):
        nonlocal count
        if row == n:
            count += 1                  # no board is built
            return
        for col in range(n):
            d, a = row - col + n - 1, row + col
            if cols[col] or diag[d] or anti[a]:
                continue
            cols[col] = diag[d] = anti[a] = True
            place(row + 1)
            cols[col] = diag[d] = anti[a] = False

    place(0)
    return count
```

### Complexity
Same search as Example 1, but **O(1)** work per solution instead of O(n²). Space O(n).

---

## 11. Solved Example 3

### Problem — Valid Sudoku (LeetCode 36)
Determine whether a partially filled 9×9 Sudoku board is **valid** — no digit repeats within any row, column, or 3×3 box. Empty cells are `'.'` and the board need not be solvable.

> **Why this and not Sudoku Solver (37) from the practice set?** Solver 37 is exactly *this* constraint logic plus the choose/explore/un-choose search from Examples 1 and 2. Getting the three constraint sets right is the half people actually get wrong, so it is worth isolating here; the Sudoku Solver chapter then assembles both halves.

### Thought Process
1. This is the constraint-set idea without any search — a single pass that only *checks*, which makes it the right stepping stone before the full solver.
2. Three families of constraints, so three sets of seen-digits: one per row, one per column, one per 3×3 box.
3. The box index is the piece worth knowing: `box = (row / 3) * 3 + (col / 3)`, using integer division. It maps each 3×3 block to `0..8`.
4. Scan every cell once; on a digit, check all three sets and then mark all three.
5. Any repeat means invalid; surviving the scan means valid.

**Deriving the box index.** `row / 3` gives which band of rows (0, 1 or 2) and `col / 3` gives which stack of columns. Numbering the boxes row-major means multiplying the band by 3 and adding the stack:

```text
box index:      col/3 = 0   1   2
     row/3 = 0        0   1   2
     row/3 = 1        3   4   5
     row/3 = 2        6   7   8
```

### Dry Run

Consider the first three rows of a board, focusing on cell `(0, 0) = '5'` and a conflict introduced at `(1, 0)`:

```text
row 0:  5 3 . | . 7 . | . . .
row 1:  6 . . | 1 9 5 | . . .
row 2:  . 9 8 | . . . | . 6 .
```

| cell | digit | row set | col set | box index | box set | verdict |
|------|-------|---------|---------|-----------|---------|---------|
| (0,0) | `5` | row0: {} → add | col0: {} → add | `(0/3)*3 + (0/3)` = **0** | box0: {} → add | ok |
| (0,1) | `3` | row0: {5} → add | col1: {} → add | 0 | box0: {5} → add | ok |
| (0,4) | `7` | row0: {5,3} → add | col4: {} → add | `(0/3)*3 + (4/3)` = **1** | box1: {} → add | ok |
| (1,0) | `6` | row1: {} → add | col0: **{5}** → add | 0 | box0: {5,3} → add | ok |
| (2,1) | `9` | row2: {} → add | col1: {3} → add | 0 | box0: {5,3,6} → add | ok |
| (2,2) | `8` | row2: {9} → add | col2: {} → add | 0 | box0: {5,3,6,9} → add | ok |

All checks pass so far. Now suppose `(2,2)` held `'5'` instead of `'8'`:

| cell | digit | box index | box set contains `5`? | verdict |
|------|-------|-----------|------------------------|---------|
| (2,2) | `5` | 0 | **yes** (from `(0,0)`) | **invalid → return false** |

Row 2 has no other `5` and column 2 has no other `5` — only the **box** check catches it. That is why all three constraint families are needed. ✓

### Visualization

```text
      col:  0 1 2 | 3 4 5 | 6 7 8
    row 0:  5 3 . | . 7 . | . . .      box 0 │ box 1 │ box 2
    row 1:  6 . . | 1 9 5 | . . .      ──────┼───────┼──────
    row 2:  . 9 8 | . . . | . 6 .      box 3 │ box 4 │ box 5
            ───────────────────────    ──────┼───────┼──────
                                       box 6 │ box 7 │ box 8

  box = (row/3)*3 + (col/3)      integer division

  cell (2,2) → (2/3)*3 + (2/3) = 0*3 + 0 = box 0
  cell (0,0) → box 0 as well  →  a 5 in both would collide
```

### Code

```go
func isValidSudoku(board [][]byte) bool {
    // Three constraint families, nine sets each. seen[d] marks digit d+1.
    var rowSeen, colSeen, boxSeen [9][9]bool

    for row := 0; row < 9; row++ {
        for col := 0; col < 9; col++ {
            cell := board[row][col]
            if cell == '.' {
                continue // empty cells constrain nothing
            }

            digit := int(cell - '1') // '1'..'9' → 0..8
            // Integer division maps the cell to its 3x3 block, row-major.
            box := (row/3)*3 + (col / 3)

            if rowSeen[row][digit] || colSeen[col][digit] || boxSeen[box][digit] {
                return false // a repeat in any of the three families
            }

            rowSeen[row][digit] = true
            colSeen[col][digit] = true
            boxSeen[box][digit] = true
        }
    }
    return true
}
```

```python
def isValidSudoku(board):
    # Three constraint families, nine sets each.
    row_seen = [set() for _ in range(9)]
    col_seen = [set() for _ in range(9)]
    box_seen = [set() for _ in range(9)]

    for row in range(9):
        for col in range(9):
            digit = board[row][col]
            if digit == ".":
                continue                # empty cells constrain nothing

            box = (row // 3) * 3 + col // 3     # row-major 3x3 block index

            if (digit in row_seen[row] or digit in col_seen[col]
                    or digit in box_seen[box]):
                return False

            row_seen[row].add(digit)
            col_seen[col].add(digit)
            box_seen[box].add(digit)

    return True
```

### Complexity
Time **O(81) = O(1)** — the board is a fixed size, so this is a constant-time check. Space O(1) for the 27 fixed-size sets.

> These same three sets, combined with the choose/explore/un-choose loop from Examples 1 and 2, give the full Sudoku **solver** — which is the subject of the next chapter. Validity checking is the constraint half; the search is the other.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 51 | N-Queens | Easy | Core backtracking application |
| 52 | N-Queens II | Easy | Core backtracking application |
| 37 | Sudoku | Medium | Core backtracking application |
| 79 | Word Search | Medium | Core backtracking application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same N Queens logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** N Queens (Backtracking).
- **Signal:** n queens, backtracking, constraints, diagonal, prune.
- **Move:** DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.
- **Cost:** O(branches^depth) time, O(depth) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the N Queens invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: N Queens
FAMILY : Backtracking (Advanced)
WHEN   : n queens, backtracking, constraints, diagonal, prune
DO     : DFS over the decision tree with pruning. Each recursion makes a choice, recurses
TIME   : O(branches^depth)    SPACE: O(depth)
PRACTICE: 51, 52, 37, 79
```

---

*Part of the DSA Patterns Handbook — pattern 72 of 100.*
