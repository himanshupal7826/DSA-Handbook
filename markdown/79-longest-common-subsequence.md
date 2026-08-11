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

**The question this pattern keeps answering:** *"How similar are these two sequences?"* — the longest shared subsequence, the fewest edits, the smallest deletion cost.

### Intuition
Generate every subsequence of the first string and check which ones also appear in the second.

### Algorithm
1. Enumerate all `2ᵐ` subsequences of `text1`.
2. For each, scan `text2` to test whether it appears as a subsequence there.
3. Track the longest that does.

### Complexity
- Time: **O(2ᵐ · n)**.
- Space: O(m).

### Drawbacks
- At `m = 30` this is a billion checks; the constraints go to 1,000.
- The recursive framing is no better on its own: `lcs(i, j)` branches into `lcs(i−1, j)` and `lcs(i, j−1)`, which both reach `lcs(i−1, j−1)`. The same pair of positions is recomputed along exponentially many routes — while there are only `m × n` distinct pairs in total.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Walk both strings from the end. At each step either the two current characters match — in which case they pair up — or one of them must be discarded.**

There are only `m × n` positions to consider, so fill a table instead of recursing blindly.

### The four DP questions

**1. What does `dp[i][j]` mean?**

```text
dp[i][j] = the length of the longest common subsequence of
           the FIRST i characters of text1 and the FIRST j of text2
```

Note "first `i` characters", not "index `i`". That off-by-one convention is deliberate — see below.

**2. How do we compute it?**

Compare `text1[i−1]` and `text2[j−1]` (the last characters of those prefixes):

```text
MATCH     → the pair contributes 1, and we shrink BOTH prefixes:
            dp[i][j] = dp[i-1][j-1] + 1

MISMATCH  → they cannot both be the last character of the answer, so
            discard one and take whichever is better:
            dp[i][j] = max( dp[i-1][j], dp[i][j-1] )
```

**3. What is the base case?**

```text
dp[0][j] = 0   an empty first string shares nothing
dp[i][0] = 0   an empty second string shares nothing
```

**4. Why iterate forward, row by row?**

`dp[i][j]` reads only `dp[i−1][j−1]`, `dp[i−1][j]` and `dp[i][j−1]` — all above or to the left. Filling top-to-bottom, left-to-right means every dependency is already final.

### Why the table is `(m+1) × (n+1)` and not `m × n`

The extra row and column hold the **empty prefix**. Without them, `dp[0][0]` would have to mean "first character of each", and every formula would need a guard for `i = 0` or `j = 0`.

With the padding, the base cases are just a row and a column of zeros, and the recurrence applies uniformly to every real cell. The cost is one extra row and column; the benefit is no special cases anywhere.

The price is the shift: **`dp[i][j]` talks about `text1[i-1]` and `text2[j-1]`.** Write that down before coding — mixing up the shift is the single most common bug in this family.

### The same table, three problems

Change only the recurrence:

| Problem | Match | Mismatch |
|---|---|---|
| **LCS** (1143) | `dp[i-1][j-1] + 1` | `max(dp[i-1][j], dp[i][j-1])` |
| **Edit Distance** (72) | `dp[i-1][j-1]` (free) | `1 + min(` replace, delete, insert `)` |
| **Delete Operations** (583) | `dp[i-1][j-1]` | `1 + min(dp[i-1][j], dp[i][j-1])` |
| Longest Common **Substring** | `dp[i-1][j-1] + 1` | **`0`** — substrings must be contiguous |

That last row is worth pausing on. A subsequence may skip characters, so a mismatch keeps the best result so far. A *substring* cannot, so a mismatch resets to zero — and the answer becomes the max over the whole table rather than the bottom-right corner.

### The three edit-distance moves, and which cell each one reads

For Edit Distance the mismatch branch takes the cheapest of three operations. Each corresponds to a neighbouring cell:

```text
dp[i-1][j-1]  →  REPLACE text1[i-1] with text2[j-1]   (both consumed)
dp[i-1][j]    →  DELETE  text1[i-1]                   (only text1 consumed)
dp[i][j-1]    →  INSERT  text2[j-1]                   (only text2 consumed)
```

Reading "which string got consumed" off the indices is the reliable way to remember which is which.

Base cases differ too: `dp[i][0] = i` (delete every character) and `dp[0][j] = j` (insert every character) — not zeros.

### Space optimisation

Each row depends only on the row above, so two rows suffice — or one row plus a saved diagonal value:

```text
O(m × n) space  →  O(min(m, n)) space
```

Do this only when asked. The full table is what lets you **reconstruct** the actual subsequence or edit script by walking backwards from the corner, and that is usually the more valuable follow-up.

### The thought process

```text
We need    : how similar two sequences are.
Obvious way: enumerate every subsequence of one and test it against the other.
Too slow   : O(2^m x n), and shared prefixes are recomputed endlessly.
Notice     : while walking both strings, all that matters is HOW MUCH of
             each remains — only m x n distinct pairs of positions exist.
Therefore  : fill a table indexed by those two positions.
Now        : O(m x n).
```

### Steps

```text
Step 1 → Allocate dp with (m+1) x (n+1) cells; the extra row and column
          stand for the EMPTY prefix.
Step 2 → Fill the base row and column (zeros for LCS, i and j for edit
          distance).
Step 3 → For i = 1 .. m, for j = 1 .. n:
Step 4 →     if a[i-1] == b[j-1]:  take the DIAGONAL
Step 5 →     else:                 combine the neighbours (max for LCS,
                                    1 + min for edit distance)
Step 6 → Read the answer off dp[m][n].
```

### How should I recognize this?

```text
If you see...
  TWO strings or arrays compared
  "longest common ...", "edit distance", "minimum operations to make equal"
  "delete/insert/replace to transform A into B"
  "is one a subsequence of the other"
        ↓
Think about...
  "At the last character of each prefix: do they match?
   If not, which one do I discard?"
        ↓
Use...
  a (m+1) x (n+1) table, dp[i][j] over the FIRST i and FIRST j characters
  match → take the diagonal;  mismatch → best of the neighbours
```

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

```text
text1 = "abcde", text2 = "ace"

        ""   a   c   e
   ""    0   0   0   0
   a     0   1   1   1
   b     0   1   1   1
   c     0   1   2   2
   d     0   1   2   2
   e     0   1   2   3
                     ↑
              answer = 3   ("ace")

MATCH (e.g. row c, col c): take the DIAGONAL and add 1
MISMATCH (e.g. row b, col c): take max(above, left) — carry the best forward
```

### Interview explanation
"I'll build a 2D table where `dp[i][j]` is the LCS length of the first `i` characters of one string and the first `j` of the other. The extra row and column for empty prefixes are what remove all the boundary special cases — the cost is remembering that `dp[i][j]` refers to `text1[i-1]` and `text2[j-1]`. The recurrence follows from one question: do the last characters of the two prefixes match? If they do, they can be paired, so I take the diagonal and add one. If not, they can't both end the answer, so I discard one and take the better of the two neighbours. Base cases are zeros. I fill row by row, since every cell reads only above and to the left. That's O(m·n) time and space, and the space drops to one row if I don't need to reconstruct the actual subsequence. Edit Distance is the same table with a different recurrence — the three mismatch options map exactly to the diagonal, above and left cells, which is how I remember which is replace, delete and insert."

---

## 5. Generic Templates

> `(m+1) × (n+1)` table. `dp[i][j]` covers the FIRST `i` and FIRST `j` characters.

```go
// LCSLength returns the length of the longest common subsequence.
// dp[i][j] = LCS of the first i chars of a and the first j chars of b.
func LCSLength(a, b string) int {
    m, n := len(a), len(b)

    // (m+1) x (n+1): the extra row/column hold the EMPTY prefix, which
    // makes the base cases a row and column of zeros with no special cases.
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            // dp[i][j] concerns a[i-1] and b[j-1] — mind the shift.
            if a[i-1] == b[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1 // pair them up
            } else if dp[i-1][j] >= dp[i][j-1] {
                dp[i][j] = dp[i-1][j] // discard a[i-1]
            } else {
                dp[i][j] = dp[i][j-1] // discard b[j-1]
            }
        }
    }
    return dp[m][n]
}

// LCSString reconstructs one actual longest common subsequence by walking
// the finished table backwards from the corner.
func LCSString(a, b string) string {
    m, n := len(a), len(b)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }
    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if a[i-1] == b[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1
            } else if dp[i-1][j] >= dp[i][j-1] {
                dp[i][j] = dp[i-1][j]
            } else {
                dp[i][j] = dp[i][j-1]
            }
        }
    }

    // Walk back: a diagonal step means those characters were paired.
    out := []byte{}
    i, j := m, n
    for i > 0 && j > 0 {
        switch {
        case a[i-1] == b[j-1]:
            out = append(out, a[i-1])
            i--
            j--
        case dp[i-1][j] >= dp[i][j-1]:
            i--
        default:
            j--
        }
    }
    for l, r := 0, len(out)-1; l < r; l, r = l+1, r-1 {
        out[l], out[r] = out[r], out[l]
    }
    return string(out)
}

// LCSLengthCompact uses two rows instead of the full table.
// It cannot reconstruct the subsequence — only the length.
func LCSLengthCompact(a, b string) int {
    if len(b) > len(a) {
        a, b = b, a // keep the inner dimension small
    }
    previous := make([]int, len(b)+1)
    current := make([]int, len(b)+1)

    for i := 1; i <= len(a); i++ {
        for j := 1; j <= len(b); j++ {
            if a[i-1] == b[j-1] {
                current[j] = previous[j-1] + 1
            } else if previous[j] >= current[j-1] {
                current[j] = previous[j]
            } else {
                current[j] = current[j-1]
            }
        }
        previous, current = current, previous
    }
    return previous[len(b)]
}
```

```python
def lcs_length(a, b):
    """dp[i][j] = LCS of the first i chars of a and the first j chars of b."""
    m, n = len(a), len(b)
    # (m+1) x (n+1): the padding row/column hold the EMPTY prefix.
    dp = [[0] * (n + 1) for _ in range(m + 1)]

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            # dp[i][j] concerns a[i-1] and b[j-1] — mind the shift.
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1     # pair them up
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])   # discard one
    return dp[m][n]

def lcs_string(a, b):
    """Reconstruct one actual LCS by walking the table backwards."""
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])

    out, i, j = [], m, n
    while i > 0 and j > 0:
        if a[i - 1] == b[j - 1]:
            out.append(a[i - 1])        # a diagonal step = a paired character
            i -= 1
            j -= 1
        elif dp[i - 1][j] >= dp[i][j - 1]:
            i -= 1
        else:
            j -= 1
    return "".join(reversed(out))

def lcs_length_compact(a, b):
    """Two rows instead of the full table. Length only, no reconstruction."""
    if len(b) > len(a):
        a, b = b, a
    previous = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        current = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            if a[i - 1] == b[j - 1]:
                current[j] = previous[j - 1] + 1
            else:
                current[j] = max(previous[j], current[j - 1])
        previous = current
    return previous[len(b)]
```

```java
public class LCS {
    // dp[i][j] = LCS of the first i chars of a and the first j chars of b.
    public static int lcsLength(String a, String b) {
        int m = a.length(), n = b.length();
        int[][] dp = new int[m + 1][n + 1];         // padding row/column = empty prefix

        for (int i = 1; i <= m; i++)
            for (int j = 1; j <= n; j++)
                if (a.charAt(i - 1) == b.charAt(j - 1))
                    dp[i][j] = dp[i - 1][j - 1] + 1;            // pair them
                else
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);   // discard one

        return dp[m][n];
    }

    // Edit Distance: same table, different recurrence and base cases.
    public static int editDistance(String a, String b) {
        int m = a.length(), n = b.length();
        int[][] dp = new int[m + 1][n + 1];

        for (int i = 0; i <= m; i++) dp[i][0] = i;  // delete everything
        for (int j = 0; j <= n; j++) dp[0][j] = j;  // insert everything

        for (int i = 1; i <= m; i++)
            for (int j = 1; j <= n; j++)
                if (a.charAt(i - 1) == b.charAt(j - 1))
                    dp[i][j] = dp[i - 1][j - 1];                // free
                else
                    dp[i][j] = 1 + Math.min(dp[i - 1][j - 1],   // replace
                               Math.min(dp[i - 1][j],           // delete
                                        dp[i][j - 1]));         // insert

        return dp[m][n];
    }
}
```

```cpp
#include <algorithm>
#include <string>
#include <vector>
using namespace std;

// dp[i][j] = LCS of the first i chars of a and the first j chars of b.
int lcsLength(const string& a, const string& b) {
    int m = (int)a.size(), n = (int)b.size();
    vector<vector<int>> dp(m + 1, vector<int>(n + 1, 0));   // padding = empty prefix

    for (int i = 1; i <= m; ++i)
        for (int j = 1; j <= n; ++j)
            if (a[i - 1] == b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = max(dp[i - 1][j], dp[i][j - 1]);

    return dp[m][n];
}

// Edit Distance: same table, different recurrence and base cases.
int editDistance(const string& a, const string& b) {
    int m = (int)a.size(), n = (int)b.size();
    vector<vector<int>> dp(m + 1, vector<int>(n + 1, 0));

    for (int i = 0; i <= m; ++i) dp[i][0] = i;       // delete everything
    for (int j = 0; j <= n; ++j) dp[0][j] = j;       // insert everything

    for (int i = 1; i <= m; ++i)
        for (int j = 1; j <= n; ++j)
            if (a[i - 1] == b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
            else dp[i][j] = 1 + min({dp[i - 1][j - 1],   // replace
                                     dp[i - 1][j],       // delete
                                     dp[i][j - 1]});     // insert

    return dp[m][n];
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

### Problem — Longest Common Subsequence (LeetCode 1143)
Return the length of the longest subsequence common to both strings. A subsequence keeps relative order but need not be contiguous.

### Thought Process

**What does `dp[i][j]` mean?** The LCS length of the **first `i`** characters of `text1` and the **first `j`** of `text2`.

**How do we compute it?** Compare the last characters of those prefixes, `text1[i-1]` and `text2[j-1]`:
- **match** → they can be paired, so `dp[i][j] = dp[i-1][j-1] + 1`
- **mismatch** → they cannot both end the answer, so discard one: `max(dp[i-1][j], dp[i][j-1])`

**What is the base case?** `dp[0][j] = dp[i][0] = 0` — an empty prefix shares nothing.

**Why fill row by row?** Every cell reads only the diagonal, above, and left neighbours, all of which are already final in that order.

### Dry Run

Input: `text1 = "abcde"`, `text2 = "ace"`

|       | **""** | **a** | **c** | **e** |
|-------|--------|-------|-------|-------|
| **""**| 0 | 0 | 0 | 0 |
| **a** | 0 | **1** | 1 | 1 |
| **b** | 0 | 1 | 1 | 1 |
| **c** | 0 | 1 | **2** | 2 |
| **d** | 0 | 1 | 2 | 2 |
| **e** | 0 | 1 | 2 | **3** |

Output: **`dp[5][3] = 3`** ✓ — the subsequence is `"ace"`.

**Three cells worth reading closely:**

- **Row `a`, column `a`**: `text1[0] = 'a'` equals `text2[0] = 'a'` → diagonal `dp[0][0] = 0`, plus 1 → **1**.
- **Row `b`, column `c`**: `'b' ≠ 'c'` → `max(dp[1][2], dp[2][1]) = max(1, 1)` → **1**. The mismatch carries the best result forward rather than resetting.
- **Row `c`, column `c`**: `'c' = 'c'` → diagonal `dp[2][1] = 1`, plus 1 → **2**.

That middle case is the difference between subsequence and **substring**. For a longest common *substring* the mismatch would write `0`, because contiguity is required — and the answer would be the maximum anywhere in the table rather than the corner.

### Visualization

```text
        ""   a   c   e
   ""    0   0   0   0
   a     0  [1]  1   1        match 'a' → diagonal + 1
   b     0   1   1   1        mismatch  → carry the best forward
   c     0   1  [2]  2        match 'c' → diagonal + 1
   d     0   1   2   2
   e     0   1   2  [3]       match 'e' → diagonal + 1
                        ↑
                   answer 3 = "ace"
```

### Code

```go
func longestCommonSubsequence(text1 string, text2 string) int {
    m, n := len(text1), len(text2)

    // (m+1) x (n+1): the extra row and column represent the EMPTY prefix,
    // which turns every base case into a plain zero.
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            // dp[i][j] is about text1[i-1] and text2[j-1] — mind the shift.
            if text1[i-1] == text2[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1 // pair the two characters
            } else if dp[i-1][j] >= dp[i][j-1] {
                dp[i][j] = dp[i-1][j] // discard text1[i-1]
            } else {
                dp[i][j] = dp[i][j-1] // discard text2[j-1]
            }
        }
    }

    return dp[m][n]
}
```

```python
def longestCommonSubsequence(text1, text2):
    m, n = len(text1), len(text2)
    # The padding row/column represent the EMPTY prefix → base cases are zeros.
    dp = [[0] * (n + 1) for _ in range(m + 1)]

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            # dp[i][j] is about text1[i-1] and text2[j-1] — mind the shift.
            if text1[i - 1] == text2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1          # pair them
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])   # discard one

    return dp[m][n]
```

### Complexity
Time **O(m · n)**, Space **O(m · n)** — reducible to O(min(m, n)) with two rows if reconstruction is not needed.

---

## 10. Solved Example 2

### Problem — Edit Distance (LeetCode 72)
Return the minimum number of operations to convert `word1` into `word2`. The allowed operations are insert, delete, and replace a character.

### Thought Process

**What does `dp[i][j]` mean?** The minimum operations to turn the first `i` characters of `word1` into the first `j` of `word2`.

**What is the base case?** Not zeros this time:
- `dp[i][0] = i` — turning `i` characters into nothing means `i` deletions.
- `dp[0][j] = j` — turning nothing into `j` characters means `j` insertions.

**How do we compute it?**
- **match** → the characters already agree, so nothing is spent: `dp[i][j] = dp[i-1][j-1]`
- **mismatch** → pay 1 and take the cheapest of three moves, each reading a different neighbour:

```text
dp[i-1][j-1]  →  REPLACE word1[i-1] with word2[j-1]   (both consumed)
dp[i-1][j]    →  DELETE  word1[i-1]                   (only word1 consumed)
dp[i][j-1]    →  INSERT  word2[j-1]                   (only word2 consumed)
```

Reading *which string got consumed* off the indices is the reliable way to keep the three straight.

### Dry Run

Input: `word1 = "horse"`, `word2 = "ros"`

|       | **""** | **r** | **o** | **s** |
|-------|--------|-------|-------|-------|
| **""**| 0 | 1 | 2 | 3 |
| **h** | 1 | **1** | 2 | 3 |
| **o** | 2 | 2 | **1** | 2 |
| **r** | 3 | **2** | 2 | 2 |
| **s** | 4 | 3 | 3 | **2** |
| **e** | 5 | 4 | 4 | **3** |

Output: **`dp[5][3] = 3`** ✓

**Reading the table back as an edit script:**

```text
horse → rorse    replace 'h' with 'r'
rorse → rose     delete 'r'
rose  → ros      delete 'e'
```

Three operations. ✓

**Two cells worth checking by hand:**

- **Row `h`, column `r`**: `'h' ≠ 'r'` → `1 + min(dp[0][0]=0, dp[0][1]=1, dp[1][0]=1) = 1 + 0 = 1`. The winning move is the diagonal — a **replace**.
- **Row `o`, column `o`**: `'o' = 'o'` → free, so `dp[2][2] = dp[1][1] = 1`. A match costs nothing and simply inherits the diagonal.

### Visualization

```text
        ""   r   o   s
   ""    0   1   2   3       base: insert j characters
   h     1  [1]  2   3       mismatch → 1 + min(diag, up, left)
   o     2   2  [1]  2       match    → inherit the diagonal, free
   r     3  [2]  2   2
   s     4   3   3  [2]
   e     5   4   4  [3]
                       ↑
                 answer = 3

  diagonal = replace   up = delete   left = insert
```

### Code

```go
func minDistance(word1 string, word2 string) int {
    m, n := len(word1), len(word2)

    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    // Base cases are NOT zeros here.
    for i := 0; i <= m; i++ {
        dp[i][0] = i // delete every character of word1
    }
    for j := 0; j <= n; j++ {
        dp[0][j] = j // insert every character of word2
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                dp[i][j] = dp[i-1][j-1] // already equal: costs nothing
                continue
            }

            // Each neighbour corresponds to one operation:
            //   diagonal = replace, above = delete, left = insert.
            best := dp[i-1][j-1] // replace
            if dp[i-1][j] < best {
                best = dp[i-1][j] // delete
            }
            if dp[i][j-1] < best {
                best = dp[i][j-1] // insert
            }
            dp[i][j] = best + 1
        }
    }

    return dp[m][n]
}
```

```python
def minDistance(word1, word2):
    m, n = len(word1), len(word2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]

    for i in range(m + 1):
        dp[i][0] = i                    # delete every character of word1
    for j in range(n + 1):
        dp[0][j] = j                    # insert every character of word2

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if word1[i - 1] == word2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]     # already equal: free
            else:
                dp[i][j] = 1 + min(
                    dp[i - 1][j - 1],   # replace
                    dp[i - 1][j],       # delete from word1
                    dp[i][j - 1],       # insert from word2
                )

    return dp[m][n]
```

### Complexity
Time **O(m · n)**, Space **O(m · n)**, reducible to O(min(m, n)).

---

## 11. Solved Example 3

### Problem — Delete Operation for Two Strings (LeetCode 583)
Return the minimum number of **deletions** (from either string) needed to make the two strings equal.

### Thought Process
1. Only deletions are allowed — no replace, no insert. So the two strings must be whittled down to something they **both** contain.
2. The largest such common remainder is exactly the **LCS**. Anything larger cannot exist in both; anything smaller wastes deletions.
3. So the answer follows directly:

```text
deletions = (m - LCS) + (n - LCS) = m + n - 2 * LCS
```

4. That means one call to Example 1 answers this problem.
5. Alternatively, solve it directly with a `dp[i][j] = minimum deletions to equalise the two prefixes` table — useful to know, because it shows how the recurrence shifts when only two of the three operations are allowed.

### Dry Run

Input: `word1 = "sea"`, `word2 = "eat"`

**Via the LCS shortcut:**

The LCS of `"sea"` and `"eat"` is `"ea"`, of length 2.

```text
deletions = 3 + 3 - 2 * 2 = 6 - 4 = 2
```

Output: **2** ✓ — delete `'s'` from `"sea"` to get `"ea"`, and delete `'t'` from `"eat"` to get `"ea"`. ✓

**Via the direct table** — `dp[i][j]` = deletions to make the two prefixes equal:

|       | **""** | **e** | **a** | **t** |
|-------|--------|-------|-------|-------|
| **""**| 0 | 1 | 2 | 3 |
| **s** | 1 | 2 | 3 | 4 |
| **e** | 2 | **1** | 2 | 3 |
| **a** | 3 | 2 | **1** | **2** |

Output: **`dp[3][3] = 2`** ✓ — the two methods agree.

**Reading the table.** Base cases are `dp[i][0] = i` and `dp[0][j] = j`: emptying a prefix costs one deletion per character. Row `e`, column `e` is a match, so it inherits the diagonal `dp[1][0] = 1` for free. Row `a`, column `t` is a mismatch, so we delete from one side: `1 + min(dp[2][3]=3, dp[3][2]=1) = 2`.

Note the mismatch branch has only **two** options here, not three — there is no replace, because replacement is not an allowed operation.

### Visualization

```text
"sea"  and  "eat"

     LCS = "ea"  (length 2)

   sea  →  delete 's'  →  ea      1 deletion
   eat  →  delete 't'  →  ea      1 deletion
                                  ─────────────
                                  2 total

   formula: m + n - 2*LCS = 3 + 3 - 4 = 2
```

### Code

```go
func minDistanceDelete(word1 string, word2 string) int {
    // Only deletions are allowed, so both strings must be reduced to a
    // common subsequence — and the largest one is the LCS.
    lcs := lcsLengthFor583(word1, word2)
    return len(word1) + len(word2) - 2*lcs
}

// lcsLengthFor583 is Example 1's routine, repeated here so this snippet
// stands alone.
func lcsLengthFor583(a, b string) int {
    dp := make([][]int, len(a)+1)
    for i := range dp {
        dp[i] = make([]int, len(b)+1)
    }
    for i := 1; i <= len(a); i++ {
        for j := 1; j <= len(b); j++ {
            if a[i-1] == b[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1
            } else if dp[i-1][j] >= dp[i][j-1] {
                dp[i][j] = dp[i-1][j]
            } else {
                dp[i][j] = dp[i][j-1]
            }
        }
    }
    return dp[len(a)][len(b)]
}

// minDistanceDeleteDirect solves it without going through the LCS.
// dp[i][j] = deletions needed to make the two prefixes equal.
func minDistanceDeleteDirect(word1 string, word2 string) int {
    m, n := len(word1), len(word2)

    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }

    for i := 0; i <= m; i++ {
        dp[i][0] = i // empty the prefix, one deletion per character
    }
    for j := 0; j <= n; j++ {
        dp[0][j] = j
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                dp[i][j] = dp[i-1][j-1] // keep both: free
                continue
            }
            // Only TWO options — there is no replace operation here.
            if dp[i-1][j] < dp[i][j-1] {
                dp[i][j] = dp[i-1][j] + 1 // delete from word1
            } else {
                dp[i][j] = dp[i][j-1] + 1 // delete from word2
            }
        }
    }

    return dp[m][n]
}
```

```python
def minDistance(word1, word2):
    """Only deletions allowed → reduce both to their LCS."""
    lcs = longestCommonSubsequence(word1, word2)
    return len(word1) + len(word2) - 2 * lcs

def minDistance_direct(word1, word2):
    """dp[i][j] = deletions needed to make the two prefixes equal."""
    m, n = len(word1), len(word2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]

    for i in range(m + 1):
        dp[i][0] = i                    # empty the prefix
    for j in range(n + 1):
        dp[0][j] = j

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if word1[i - 1] == word2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]         # keep both: free
            else:
                # Only TWO options — no replace operation exists here.
                dp[i][j] = 1 + min(dp[i - 1][j], dp[i][j - 1])

    return dp[m][n]
```

### Complexity
Time **O(m · n)**, Space **O(m · n)**.

> All three examples are one table with one question at each cell — *do the last characters match?* — and a different answer for what to do when they don't. Once that is internalised, the whole two-sequence DP family reduces to picking the right mismatch branch.

---

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
