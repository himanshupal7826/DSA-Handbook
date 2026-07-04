# 79 · Longest Common Subsequence

> **One-liner:** 2D grid DP aligning two sequences character by character.

---

## 1. Overview

### Definition
The **Longest Common Subsequence** pattern belongs to the *Dynamic Programming* family. 2D grid DP aligning two sequences character by character.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
lcs, common subsequence, dp, grid, edit distance.

### Constraints
- Input size where the brute-force complexity would time out — the Longest Common Subsequence optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Longest Common Subsequence invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Longest Common Subsequence is the upgrade.
- The wording maps onto: lcs, common subsequence, dp, grid, edit distance.

---

## 3. Brute Force Approach

### Intuition
Naive recursion recomputes overlapping subproblems — exponential time.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Longest Common Subsequence pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Longest Common Subsequence invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 620 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="alc-79" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">LCS grid: match ⇒ diag+1, else max(up, left)  · X=ABC, Y=BAC</text>
  <text x="192" y="48" text-anchor="middle" fill="#64748b">∅</text>
  <text x="236" y="48" text-anchor="middle" fill="#1e293b" font-weight="700">B</text>
  <text x="280" y="48" text-anchor="middle" fill="#1e293b" font-weight="700">A</text>
  <text x="324" y="48" text-anchor="middle" fill="#1e293b" font-weight="700">C</text>
  <text x="150" y="88" text-anchor="middle" fill="#64748b">∅</text>
  <text x="150" y="126" text-anchor="middle" fill="#1e293b" font-weight="700">A</text>
  <text x="150" y="164" text-anchor="middle" fill="#1e293b" font-weight="700">B</text>
  <text x="150" y="202" text-anchor="middle" fill="#1e293b" font-weight="700">C</text>
  <rect x="170" y="64" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="192" y="88" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="214" y="64" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="236" y="88" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="258" y="64" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="88" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="302" y="64" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="324" y="88" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="170" y="102" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="192" y="126" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="214" y="102" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="236" y="126" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="258" y="102" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="126" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="102" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="324" y="126" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="170" y="140" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="192" y="164" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="214" y="140" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="236" y="164" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="258" y="140" width="44" height="38" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="280" y="164" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="140" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="324" y="164" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="170" y="178" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="192" y="202" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="214" y="178" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="236" y="202" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="258" y="178" width="44" height="38" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="280" y="202" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="302" y="178" width="44" height="38" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="324" y="202" text-anchor="middle" fill="#1e293b" font-weight="700">2</text>
  <line x1="290" y1="150" x2="316" y2="188" stroke="#475569" marker-end="url(#alc-79)"/>
  <text x="440" y="150" text-anchor="middle" fill="#64748b">C = C match:</text>
  <text x="440" y="170" text-anchor="middle" fill="#64748b">dp = diag + 1 = 2</text>
  <text x="310" y="238" text-anchor="middle" fill="#059669" font-weight="700">LCS(ABC, BAC) = 2  (e.g. AC)</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Longest Common Sub: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Longest Common Subsequence problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Dynamic Programming** family template. Adapt the comparison/condition to the specific problem.

```go
// 0/1 Knapsack, space-optimized to 1D. dp[w] = best value at capacity w.
func knapsack(weights, values []int, cap int) int {
    dp := make([]int, cap+1)
    for i := range weights {
        for w := cap; w >= weights[i]; w-- {  // reverse: each item once
            if dp[w-weights[i]]+values[i] > dp[w] {
                dp[w] = dp[w-weights[i]] + values[i]
            }
        }
    }
    return dp[cap]
}
```

```python
def knapsack(weights, values, cap):
    dp = [0] * (cap + 1)               # dp[w] = best value for capacity w
    for wt, val in zip(weights, values):
        for w in range(cap, wt - 1, -1):   # reverse -> 0/1 (item used once)
            dp[w] = max(dp[w], dp[w - wt] + val)
    return dp[cap]
```

```java
int knapsack(int[] weights, int[] values, int cap) {
    int[] dp = new int[cap + 1];
    for (int i = 0; i < weights.length; i++)
        for (int w = cap; w >= weights[i]; w--)
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
    return dp[cap];
}
```

```cpp
int knapsack(vector<int>& weights, vector<int>& values, int cap) {
    vector<int> dp(cap + 1, 0);
    for (size_t i = 0; i < weights.size(); ++i)
        for (int w = cap; w >= weights[i]; --w)
            dp[w] = max(dp[w], dp[w - weights[i]] + values[i]);
    return dp[cap];
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Longest Common Subsequence (Optimal) |
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

### Problem — LCS (LeetCode 1143)
Given two strings `text1` and `text2`, return the length of their **longest common subsequence** (characters in the same relative order, not necessarily contiguous).

### Thought Process
1. Let `dp[i][j]` = LCS length of the first `i` chars of `text1` and first `j` chars of `text2`.
2. If `text1[i-1] == text2[j-1]`, the pair extends the LCS: `dp[i][j] = dp[i-1][j-1] + 1`.
3. Otherwise skip one character from either string: `dp[i][j] = max(dp[i-1][j], dp[i][j-1])`.
4. Answer is `dp[m][n]`; row 0 and column 0 are 0 (empty string matches nothing).

### Dry Run
`text1 = "abcde"`, `text2 = "ace"`.
- `a`==`a` → dp lifts to 1 along that diagonal.
- `c`==`c` builds on the `a` match → 2.
- `e`==`e` builds on the `ac` match → 3.
- Non-matching cells inherit the best neighbor; final `dp[5][3] = 3` ("ace").

### Visualization
```
input  ──▶ [ fill dp grid comparing text1[i] vs text2[j] ]
state  ──▶ match: diagonal+1, else max(up, left)
output ──▶ dp[m][n]
```

### Code
```python
def longestCommonSubsequence(text1, text2):
    m, n = len(text1), len(text2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if text1[i - 1] == text2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    return dp[m][n]
```

### Complexity
Time O(m × n), Space O(m × n) (reducible to O(n) with a rolling row).

## 10. Solved Example 2

### Problem — Edit Distance (LeetCode 72)
Given `word1` and `word2`, return the minimum number of insert, delete, or replace operations to convert `word1` into `word2`.

### Thought Process
1. Let `dp[i][j]` = min operations to turn the first `i` chars of `word1` into the first `j` chars of `word2`.
2. Base cases: `dp[i][0] = i` (delete all), `dp[0][j] = j` (insert all).
3. If the last chars match, no cost: `dp[i][j] = dp[i-1][j-1]`.
4. Else take 1 + min of replace `dp[i-1][j-1]`, delete `dp[i-1][j]`, insert `dp[i][j-1]`.

### Dry Run
`word1 = "horse"`, `word2 = "ros"`.
- Base row/col seed the deletes/inserts (`dp[i][0]=i`, `dp[0][j]=j`).
- `h`≠`r` → replace path; mismatches take `1+min(neighbors)`.
- `o`==`o` and `s`==`s` copy the diagonal, keeping cost flat.
- Final `dp[5][3] = 3` (replace h→r, delete r, delete e).

### Visualization
```
input  ──▶ [ fill dp grid over word1[i] vs word2[j] ]
state  ──▶ match: diagonal, else 1 + min(replace, delete, insert)
output ──▶ dp[m][n]
```

### Code
```python
def minDistance(word1, word2):
    m, n = len(word1), len(word2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if word1[i - 1] == word2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]
            else:
                dp[i][j] = 1 + min(dp[i - 1][j - 1],  # replace
                                   dp[i - 1][j],       # delete
                                   dp[i][j - 1])       # insert
    return dp[m][n]
```

### Complexity
Time O(m × n), Space O(m × n) (reducible to O(n) with a rolling row).

## 11. Solved Example 3

### Problem — Delete Ops (LeetCode 583)
Given `word1` and `word2`, return the minimum number of character deletions (from either string) needed to make the two strings equal.

### Thought Process
1. Whatever survives the deletions must be a common subsequence, so the largest string we can keep is the LCS.
2. Compute `L = LCS(word1, word2)` with the standard 2D DP.
3. Delete every non-LCS character from each: `m - L` from `word1`, `n - L` from `word2`.
4. Answer = `m + n - 2*L`.

### Dry Run
`word1 = "sea"`, `word2 = "eat"`.
- LCS DP finds "ea" → `L = 2`.
- `m = 3`, `n = 3`.
- Answer = `3 + 3 - 2*2 = 2` (delete `s` from "sea", `t` from "eat").

### Visualization
```
input  ──▶ [ fill LCS grid over word1 vs word2 ]
state  ──▶ match: diagonal+1, else max(up, left)
output ──▶ m + n - 2*dp[m][n]
```

### Code
```python
def minDistance(word1, word2):
    m, n = len(word1), len(word2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if word1[i - 1] == word2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    lcs = dp[m][n]
    return m + n - 2 * lcs
```

### Complexity
Time O(m × n), Space O(m × n) (reducible to O(n) with a rolling row).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1143 | LCS | Easy | Core dynamic programming application |
| 72 | Edit Distance | Easy | Core dynamic programming application |
| 583 | Delete Ops | Medium | Core dynamic programming application |
| 1092 | Shortest Supersequence | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Longest Common Subsequence logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Longest Common Subsequence (Dynamic Programming).
- **Signal:** lcs, common subsequence, dp, grid, edit distance.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Longest Common Subsequence invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Longest Common Subsequence
FAMILY : Dynamic Programming (Advanced)
WHEN   : lcs, common subsequence, dp, grid, edit distance
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 1143, 72, 583, 1092
```

---

*Part of the DSA Patterns Handbook — pattern 79 of 100.*
