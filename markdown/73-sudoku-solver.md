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

### Intuition
Generate all candidates then filter — wasteful, explores invalid branches fully.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Sudoku Solver pattern is built to use.

---

## 4. Optimal Approach

### Core idea
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Sudoku Solver invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Sudoku Solver     : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Sudoku Solver problem. I'll dFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next. That brings the complexity down to O(branches^depth) time and O(depth) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Backtracking** family template. Adapt the comparison/condition to the specific problem.

```go
// Subsets via choose/explore/un-choose.
func subsets(nums []int) [][]int {
    res := [][]int{}
    var path []int
    var dfs func(start int)
    dfs = func(start int) {
        cp := make([]int, len(path)); copy(cp, path)
        res = append(res, cp)                 // record current subset
        for i := start; i < len(nums); i++ {
            path = append(path, nums[i])       // choose
            dfs(i + 1)                         // explore
            path = path[:len(path)-1]          // un-choose
        }
    }
    dfs(0)
    return res
}
```

```python
def subsets(nums):
    res, path = [], []
    def dfs(start):
        res.append(path[:])                    # record
        for i in range(start, len(nums)):
            path.append(nums[i])               # choose
            dfs(i + 1)                          # explore
            path.pop()                          # un-choose
    dfs(0)
    return res
```

```java
List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    dfs(nums, 0, new ArrayList<>(), res);
    return res;
}
void dfs(int[] nums, int start, List<Integer> path, List<List<Integer>> res) {
    res.add(new ArrayList<>(path));
    for (int i = start; i < nums.length; i++) {
        path.add(nums[i]);
        dfs(nums, i + 1, path, res);
        path.remove(path.size() - 1);
    }
}
```

```cpp
void dfs(vector<int>& nums, int start, vector<int>& path, vector<vector<int>>& res) {
    res.push_back(path);
    for (int i = start; i < (int)nums.size(); ++i) {
        path.push_back(nums[i]);
        dfs(nums, i + 1, path, res);
        path.pop_back();
    }
}
vector<vector<int>> subsets(vector<int>& nums) {
    vector<vector<int>> res; vector<int> path;
    dfs(nums, 0, path, res);
    return res;
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
A representative **Sudoku Solver** problem. The signal: fill cells with valid candidates, backtracking on dead ends.

### Thought Process
1. Scan the 9×9 grid for the next empty cell (`'.'`); if none remain the board is solved.
2. Try digits `'1'`..`'9'`; a digit is valid only if it is absent from that row, column, and 3×3 box.
3. Place a valid digit and recurse; if the recursion solves the rest, propagate `True`.
4. Otherwise reset the cell to `'.'` and try the next digit; return `False` when no digit fits.

### Dry Run
Solving from the first empty cell:
- Cell (0,2) empty: try `'1'` — already in row → skip; `'4'` valid → place, recurse.
- A deeper cell finds no valid digit → return `False`, undo `'4'`.
- Backtrack to (0,2), try the next digit; keep going until every cell is consistent.
- No empty cell remains → return `True`; the board is mutated in place to the solution.

### Visualization
```
next empty cell → try 1..9 valid in row/col/box → recurse; first full grid returns True, undo on dead ends
```

### Code
```python
def solveSudoku(board):
    def valid(r, c, ch):
        for i in range(9):
            if board[r][i] == ch or board[i][c] == ch:
                return False
            if board[3 * (r // 3) + i // 3][3 * (c // 3) + i % 3] == ch:
                return False
        return True

    def solve():
        for r in range(9):
            for c in range(9):
                if board[r][c] == '.':
                    for ch in "123456789":
                        if valid(r, c, ch):
                            board[r][c] = ch
                            if solve():
                                return True
                            board[r][c] = '.'
                    return False  # no digit works here → backtrack
        return True  # no empty cell left → solved

    solve()
```

### Complexity
Time O(9^(m)) worst case where m is the number of empty cells, Space O(m) for the recursion depth (board solved in place).

## 10. Solved Example 2

### Problem — N-Queens (LeetCode 51)
A representative **Sudoku Solver** problem. The signal: fill cells with valid candidates, backtracking on dead ends.

### Thought Process
1. Place exactly one queen per row, recursing from row 0 down to row n.
2. Track occupied `cols`, `diag` (r − c), and `anti` (r + c) as sets so a conflict check is O(1).
3. If a column is free on all three axes, place the queen, recurse to the next row, then undo before trying the next column.
4. When `row == n`, build the `"...Q.."` board strings from the recorded queen columns and append.

### Dry Run
n = 4, place row by row:
- row0 → col0; cols={0}, diag={0}, anti={0}.
- row1 → col2 is the only safe column; recurse.
- row2 → no safe column → backtrack up past row1 to row0.
- row0=col1, row1=col3, row2=col0, row3=col2 succeeds → `.Q..`,`...Q`,`Q...`,`..Q.`; its mirror also solves → 2 boards.

### Visualization
```
row-by-row placement, sets cols/diag(r-c)/anti(r+c) prune attacked columns before recursing
```

### Code
```python
def solveNQueens(n):
    res, cols, diag, anti = [], set(), set(), set()
    queens = []  # queens[r] = column of the queen in row r

    def backtrack(row):
        if row == n:
            res.append(["".join("Q" if c == queens[r] else "."
                                 for c in range(n)) for r in range(n)])
            return
        for col in range(n):
            if col in cols or (row - col) in diag or (row + col) in anti:
                continue
            cols.add(col); diag.add(row - col); anti.add(row + col)
            queens.append(col)
            backtrack(row + 1)
            queens.pop()
            cols.remove(col); diag.remove(row - col); anti.remove(row + col)

    backtrack(0)
    return res
```

### Complexity
Time O(n!) as columns/diagonals prune the branching, Space O(n) for the recursion depth and the three tracking sets.

## 11. Solved Example 3

### Problem — Word Search (LeetCode 79)
A representative **Sudoku Solver** problem. The signal: fill cells with valid candidates, backtracking on dead ends.

### Thought Process
1. Try starting a DFS from every cell that matches `word[0]`.
2. At index `k`, if the current cell equals `word[k]`, mark it visited (temporarily set to `'#'`).
3. Recurse into the 4 neighbors for `word[k+1]`; success at any neighbor propagates `True`.
4. Restore the cell after exploring, and return `True` immediately when `k` reaches `len(word)`.

### Dry Run
board `[["A","B"],["C","D"]]`, word = `"ABD"`:
- Start at (0,0)=`A` matches word[0]; mark `'#'`, look for `'B'`.
- Right neighbor (0,1)=`B` matches word[1]; mark `'#'`, look for `'D'`.
- Down neighbor (1,1)=`D` matches word[2]; next index == len(word) → return `True`.
- Path A→B→D found → overall `True` (cells restored on the way out).

### Visualization
```
DFS from each cell, char by char, mark visited '#' then restore; True when index == len(word)
```

### Code
```python
def exist(board, word):
    rows, cols = len(board), len(board[0])

    def dfs(r, c, k):
        if k == len(word):
            return True
        if r < 0 or r >= rows or c < 0 or c >= cols or board[r][c] != word[k]:
            return False
        board[r][c] = '#'                       # mark visited
        found = (dfs(r + 1, c, k + 1) or dfs(r - 1, c, k + 1) or
                 dfs(r, c + 1, k + 1) or dfs(r, c - 1, k + 1))
        board[r][c] = word[k]                   # restore
        return found

    return any(dfs(r, c, 0) for r in range(rows) for c in range(cols))
```

### Complexity
Time O(m·n·4^L) where L is the word length, Space O(L) for the recursion depth (grid marked in place).


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
