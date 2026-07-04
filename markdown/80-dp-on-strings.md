# 80 · DP on Strings

> **One-liner:** Substring/subsequence DP for edit distance, matching, palindromes.

---

## 1. Overview

### Definition
The **DP on Strings** pattern belongs to the *Dynamic Programming* family. Substring/subsequence DP for edit distance, matching, palindromes.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
string dp, edit distance, palindrome, interleaving, matching.

### Constraints
- Input size where the brute-force complexity would time out — the DP on Strings optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the DP on Strings invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — DP on Strings is the upgrade.
- The wording maps onto: string dp, edit distance, palindrome, interleaving, matching.

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
Redundant recomputation; does not exploit the structure the DP on Strings pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the DP on Strings invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 620 262" width="100%" height="262" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr80" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
    <marker id="arr80g" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#059669"/></marker>
  </defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">LCS grid: dp[i][j] over "ac" &amp; "ac"</text>
  <text x="306" y="56" text-anchor="middle" fill="#64748b">a</text>
  <text x="358" y="56" text-anchor="middle" fill="#64748b">c</text>
  <text x="214" y="148" text-anchor="middle" fill="#64748b">a</text>
  <text x="214" y="200" text-anchor="middle" fill="#64748b">c</text>
  <rect x="230" y="64"  width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="254" y="93"  text-anchor="middle" fill="#1e293b">0</text>
  <rect x="282" y="64"  width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="306" y="93"  text-anchor="middle" fill="#1e293b">0</text>
  <rect x="334" y="64"  width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="358" y="93"  text-anchor="middle" fill="#1e293b">0</text>
  <rect x="230" y="116" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="254" y="145" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="282" y="116" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="306" y="145" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="334" y="116" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="358" y="145" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="230" y="168" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="254" y="197" text-anchor="middle" fill="#1e293b">0</text>
  <rect x="282" y="168" width="48" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="306" y="197" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="334" y="168" width="48" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="358" y="197" text-anchor="middle" font-weight="700" fill="#1e293b">2</text>
  <line x1="316" y1="150" x2="342" y2="176" stroke="#059669" marker-end="url(#arr80g)"/>
  <line x1="358" y1="140" x2="358" y2="164" stroke="#475569" marker-end="url(#arr80)"/>
  <line x1="308" y1="192" x2="330" y2="192" stroke="#475569" marker-end="url(#arr80)"/>
  <text x="440" y="150" fill="#059669" font-weight="700">match c=c</text>
  <text x="440" y="168" fill="#64748b">dp[i-1][j-1]+1</text>
  <text x="150" y="236" fill="#059669">match: diagonal + 1</text>
  <text x="150" y="252" fill="#64748b">else: max(up, left)</text>
  <text x="425" y="236" fill="#059669" font-weight="700">answer = dp[n][m] = 2</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
DP on Strings     : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a DP on Strings problem. I'll optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it. That brings the complexity down to O(states × transitions) time and O(states) space — here's the template."

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

| Metric | Brute Force | DP on Strings (Optimal) |
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

### Problem — Edit Distance (LeetCode 72)
Return the minimum number of single-character insert / delete / replace operations to turn `word1` into `word2`.

### Thought Process
1. Let `dp[i][j]` = edit distance between the first `i` chars of `word1` and first `j` chars of `word2`.
2. Base cases: `dp[i][0] = i` (delete all), `dp[0][j] = j` (insert all).
3. If `word1[i-1] == word2[j-1]`, characters align: `dp[i][j] = dp[i-1][j-1]`.
4. Otherwise take `1 + min(dp[i-1][j]` delete, `dp[i][j-1]` insert, `dp[i-1][j-1]` replace`)`.

### Dry Run
`word1="horse", word2="ros"` → answer 3.
- `horse → rorse` (replace h→r), then `rorse → rose` (delete r), then `rose → ros` (delete e).
- Table corner `dp[5][3] = 3`, matching the three operations traced above.

### Visualization
```
input  ──▶ [ fill dp[i][j] over the two strings ]
state  ──▶ each cell reuses the three neighbors above/left/diagonal
output ──▶ dp[m][n] holds the minimum edit distance
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
                dp[i][j] = 1 + min(dp[i - 1][j],      # delete
                                   dp[i][j - 1],      # insert
                                   dp[i - 1][j - 1])  # replace
    return dp[m][n]
```

### Complexity
Time O(m·n), Space O(m·n) (reducible to O(n) with a rolling row).

## 10. Solved Example 2

### Problem — Longest Palindrome (LeetCode 5)
Return the longest contiguous substring of `s` that reads the same forwards and backwards.

### Thought Process
1. Every palindrome has a center: either one character (odd length) or a gap between two characters (even length).
2. For each of the `2n-1` possible centers, expand outward while the two ends match.
3. Track the widest `[left, right]` window found and return that slice at the end.

### Dry Run
`s = "babad"` → answer "bab" (or "aba").
- Center at index 1 ('a'): expand to `b a b` → length 3, record [0,2].
- Center at index 2 ('b'): expand to `a b a` → length 3, no improvement; best stays "bab".

### Visualization
```
input  ──▶ [ try each center, expand outward ]
state  ──▶ best [left, right] window widens only when both ends match
output ──▶ s[left : right + 1] is the longest palindrome
```

### Code
```python
def longestPalindrome(s):
    if not s:
        return ""
    start, end = 0, 0

    def expand(l, r):
        while l >= 0 and r < len(s) and s[l] == s[r]:
            l -= 1
            r += 1
        return l + 1, r - 1        # last valid window

    for i in range(len(s)):
        l1, r1 = expand(i, i)      # odd-length center
        l2, r2 = expand(i, i + 1)  # even-length center
        if r1 - l1 > end - start:
            start, end = l1, r1
        if r2 - l2 > end - start:
            start, end = l2, r2
    return s[start:end + 1]
```

### Complexity
Time O(n²), Space O(1).

## 11. Solved Example 3

### Problem — Regex Match (LeetCode 10)
Return whether the full string `s` matches pattern `p`, where `.` matches any single char and `*` matches zero or more of the preceding element.

### Thought Process
1. Let `dp[i][j]` = does `s[:i]` match `p[:j]`. Answer is `dp[len(s)][len(p)]`.
2. A plain char or `.` at `p[j-1]` consumes one char: `dp[i][j] = dp[i-1][j-1]` if they align.
3. A `*` gives two choices — zero occurrences: `dp[i][j-2]`; or one more occurrence when `p[j-2]` matches `s[i-1]`: `dp[i-1][j]`.
4. Seed `dp[0][0]=True` and precompute empty-string-vs-pattern for leading `x*` groups.

### Dry Run
`s = "aab", p = "c*a*b"` → True.
- `c*` matches zero 'c' → `dp[0][2]=True`.
- `a*` absorbs both 'a's → `dp[2][4]=True`.
- final `b` matches `b` → `dp[3][5]=True`.

### Visualization
```
input  ──▶ [ fill dp[i][j] over string s and pattern p ]
state  ──▶ '*' branches into zero-use (j-2) or one-more-use (i-1)
output ──▶ dp[len(s)][len(p)] is the match verdict
```

### Code
```python
def isMatch(s, p):
    m, n = len(s), len(p)
    dp = [[False] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = True
    for j in range(1, n + 1):                 # empty s vs pattern (x* groups)
        if p[j - 1] == '*':
            dp[0][j] = dp[0][j - 2]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if p[j - 1] == '*':
                dp[i][j] = dp[i][j - 2]        # zero of preceding element
                if p[j - 2] == s[i - 1] or p[j - 2] == '.':
                    dp[i][j] = dp[i][j] or dp[i - 1][j]
            elif p[j - 1] == '.' or p[j - 1] == s[i - 1]:
                dp[i][j] = dp[i - 1][j - 1]
    return dp[m][n]
```

### Complexity
Time O(m·n), Space O(m·n).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 72 | Edit Distance | Easy | Core dynamic programming application |
| 5 | Longest Palindrome | Easy | Core dynamic programming application |
| 10 | Regex Match | Medium | Core dynamic programming application |
| 115 | Distinct Subseq | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same DP on Strings logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** DP on Strings (Dynamic Programming).
- **Signal:** string dp, edit distance, palindrome, interleaving, matching.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the DP on Strings invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: DP on Strings
FAMILY : Dynamic Programming (Advanced)
WHEN   : string dp, edit distance, palindrome, interleaving, matching
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 72, 5, 10, 115
```

---

*Part of the DSA Patterns Handbook — pattern 80 of 100.*
