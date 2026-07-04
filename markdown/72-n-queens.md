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

### Intuition
Generate all candidates then filter — wasteful, explores invalid branches fully.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the N Queens pattern is built to use.

---

## 4. Optimal Approach

### Core idea
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the N Queens invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
N Queens          : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a N Queens problem. I'll dFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next. That brings the complexity down to O(branches^depth) time and O(depth) space — here's the template."

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
A representative **N Queens** problem. The signal: place queens column by column, pruning conflicting diagonals/rows.

### Thought Process
1. Place exactly one queen per row, recursing from row 0 down to row n.
2. Track occupied `cols`, `diag` (r − c), and `anti` (r + c) as sets so a conflict check is O(1).
3. If a column is free on all three axes, place the queen (record its column), recurse to the next row, then undo before trying the next column.
4. When `row == n`, every row holds a safe queen — turn the recorded columns into `"...Q.."` strings and append the board.

### Dry Run
n = 4, place row by row:
- row0 → col0; cols={0}, diag={0}, anti={0}.
- row1 → col2 is safe (col1 hits anti, others clash); recurse.
- row2 → no safe column (all clash) → backtrack up to row1, then row0.
- Eventually row0=col1, row1=col3, row2=col0, row3=col2 succeeds → board `.Q..`,`...Q`,`Q...`,`..Q.`; the mirror solution is also found → 2 boards.

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
Time O(n!) (branching shrinks as columns/diagonals fill), Space O(n) for the recursion depth and the three tracking sets.

## 10. Solved Example 2

### Problem — N-Queens II (LeetCode 52)
A representative **N Queens** problem. The signal: place queens column by column, pruning conflicting diagonals/rows.

### Thought Process
1. Identical backtracking to LC51 — one queen per row, pruning with `cols`, `diag` (r − c), `anti` (r + c).
2. We only need the number of solutions, so never build board strings.
3. When `row == n`, a full valid placement was reached — increment a counter instead of appending a board.

### Dry Run
n = 4, count completions:
- Explore row0=col0 branch → dead-ends (no full placement).
- row0=col1 → row1=col3 → row2=col0 → row3=col2 completes → count = 1.
- row0=col2 → the mirror completes → count = 2.
- Remaining branches dead-end → return 2.

### Visualization
```
same row-by-row pruning as LC51, but each complete placement just bumps an int counter
```

### Code
```python
def totalNQueens(n):
    cols, diag, anti = set(), set(), set()
    count = 0

    def backtrack(row):
        nonlocal count
        if row == n:
            count += 1
            return
        for col in range(n):
            if col in cols or (row - col) in diag or (row + col) in anti:
                continue
            cols.add(col); diag.add(row - col); anti.add(row + col)
            backtrack(row + 1)
            cols.remove(col); diag.remove(row - col); anti.remove(row + col)

    backtrack(0)
    return count
```

### Complexity
Time O(n!), Space O(n) for the recursion stack and the three conflict sets — no board storage needed.

## 11. Solved Example 3

### Problem — Sudoku (LeetCode 37)
A representative **N Queens** problem. The signal: place queens column by column, pruning conflicting diagonals/rows.

### Thought Process
1. Scan the 9×9 grid for the next empty cell (`'.'`); if none remain the board is solved.
2. Try digits `'1'`..`'9'`; a digit is valid only if it is absent from that row, column, and 3×3 box.
3. Place a valid digit and recurse; if the recursion solves the rest, propagate `True`.
4. Otherwise reset the cell to `'.'` and try the next digit; return `False` when no digit fits.

### Dry Run
Solving from the top-left empty cell:
- First empty cell (0,2): try `'1'` — already in row → skip; `'4'` valid → place, recurse.
- Deeper cell hits a contradiction (no digit fits) → return `False`, undo `'4'`.
- Backtrack tries the next digit at (0,2); continue until every cell is filled consistently.
- All cells filled → return `True`, board mutated in place to the unique solution.

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
