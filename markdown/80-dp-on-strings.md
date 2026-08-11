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

**The question this pattern keeps answering:** *"What is the best way to line up two strings (or a string with itself), one character at a time?"*

Running example: turn `"sea"` into `"eat"` using insert / delete / replace, as cheaply as possible.

### Intuition
Look at the last character of each string. Either they already agree (nothing to pay, step both back), or they don't — and then you must pay for one of three repairs: delete the last char of the first string, insert the missing char, or replace one with the other. Try all three and recurse.

### Algorithm
1. `solve(i, j)` = cost of turning the first `i` chars of `a` into the first `j` chars of `b`.
2. If `i == 0` return `j` (insert everything). If `j == 0` return `i` (delete everything).
3. If `a[i-1] == b[j-1]` return `solve(i-1, j-1)`.
4. Otherwise return `1 + min(solve(i-1, j), solve(i, j-1), solve(i-1, j-1))`.
5. Answer is `solve(len(a), len(b))`.

### Complexity
- Time: **O(3^(m+n))** — three branches, and each branch shrinks the total length by only one.
- Space: O(m + n) recursion stack.

### Drawbacks
- The same pair `(i, j)` is reached by many different op sequences. From `solve(3,3)`:

```text
solve(3,3) → solve(2,3)  → solve(1,2)      "delete, then insert"
solve(3,3) → solve(3,2)  → solve(2,1)
solve(3,3) → solve(2,2)  → solve(1,2)      "replace, then insert"  ← same node!
```

  `solve(1,2)` is computed twice here, and at depth 6 the same node is reached dozens of times. Nothing about it changes between visits — it only depends on `i` and `j`.
- The brute force never exploits the one fact that makes the whole family easy: **the answer depends only on how much of each string is left, not on which operations got you there.** That is exactly two numbers, so there are only `(m+1)·(n+1)` distinct questions in the entire recursion.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **A string-DP state is nothing but a pair of prefix lengths — `dp[i][j]` answers the whole question for "first `i` chars of A vs first `j` chars of B" — so a grid of `(m+1)×(n+1)` cells holds every subproblem exactly once.**

Think of it as a spreadsheet. Row `i` is "I have consumed `i` characters of A", column `j` is "I have consumed `j` characters of B". Each cell asks one small question, answers it by peeking at two or three neighbours that are already filled in, and writes down a number. When you reach the bottom-right corner you have the answer, and you never asked the same question twice.

### The thought process

```text
We need    : the best alignment of two strings.
Obvious way: recurse on "what do I do with the last character?".
Too slow   : three branches per character -> 3^(m+n).
Notice     : the recursion's arguments are only (i, j) — two small integers.
Notice too : (i, j) has at most (m+1)(n+1) values, but the recursion visits
             many of them thousands of times.
Therefore  : give every (i, j) a cell in a grid, compute it once, read it forever.
Now        : O(m*n) time, and each cell is O(1) work.
```

### Why the fill order is forced (this is the whole game)

A cell may only be computed **after** every cell it reads. So the fill order is decided by the recurrence, not by taste. There are exactly two shapes in this chapter:

**Shape 1 — prefix DP (edit distance, LCS, regex).** `dp[i][j]` reads `dp[i-1][j]`, `dp[i][j-1]`, `dp[i-1][j-1]` — all **up and/or left**:

```text
      j-1   j
i-1    ↘    ↓
i      →   [?]      every arrow comes from a smaller i or a smaller j
```

So a plain `for i = 1..m { for j = 1..n }` sweep works: by the time you touch `(i, j)`, row `i-1` is entirely done and row `i` is done up to `j-1`.

**Shape 2 — interval DP (palindromes).** `dp[i][j]` = "is `s[i..j]` a palindrome" reads `dp[i+1][j-1]` — that is **one row DOWN and one column LEFT**:

```text
      j-1   j
i          [?]
i+1   [x]           the dependency is BELOW, not above
```

A naive `for i = 0..n-1` ascending would ask for row `i+1` before it exists. Two orders fix it, and they are the same order in disguise:

* iterate by **increasing substring length**, or
* iterate `i` **descending**, `j` ascending.

Let's actually watch it happen on `s = "abba"`. `dp[i][j] = (s[i]==s[j]) && (j-i < 2 || dp[i+1][j-1])`. Filling by length:

```text
length 1 (free):            length 2:                  length 3:
    j 0  1  2  3                j 0  1  2  3               j 0  1  2  3
i 0   T  .  .  .            i 0   T  F  .  .           i 0   T  F  F  .
i 1   -  T  .  .            i 1   -  T  T  .           i 1   -  T  T  F
i 2   -  -  T  .            i 2   -  -  T  F           i 2   -  -  T  F
i 3   -  -  -  T            i 3   -  -  -  T           i 3   -  -  -  T

length 4:
    j 0  1  2  3      dp[0][3]: s[0]='a' == s[3]='a', and it needs dp[1][2].
i 0   T  F  F [T]     dp[1][2] is the length-2 cell "bb" — filled two rounds
i 1   -  T  T  F      ago, so it is available. Answer: "abba" is a palindrome.
i 2   -  -  T  F
i 3   -  -  -  T
```

Now break it deliberately. With ascending `i`, computing `dp[0][3]` happens in the very first row — at that moment `dp[1][2]` is still `false` (its default), so `"abba"` would be reported as **not** a palindrome. The bug is silent: no crash, just a wrong answer. That is why the loop order is part of the algorithm, not an implementation detail.

### Steps

```text
Step 1 → Write the state as an English sentence. "dp[i][j] = <answer> for
         the first i chars of A and the first j chars of B."
Step 2 → Write the recurrence by asking "what happens at the last character?"
Step 3 → Fill in the base row and base column (one string empty).
Step 4 → Look at which neighbours the recurrence reads.
Step 5 → Choose the loop order so those neighbours are already written.
Step 6 → Read the answer out of the corner cell.
```

### How should I recognize this?

```text
If you see...
  two strings compared / aligned / interleaved / matched,
  or one string cut into substrings,
  and lengths around 1000 (so O(n^2) is fine but O(2^n) is not)
        ↓
Think about...
  "What are the smallest facts that pin down a subproblem?"
  Two strings  -> a pair of prefix lengths (i, j)
  One string   -> a substring range (i, j)
        ↓
Use...
  prefix pair  -> dp[i][j] from up / left / diagonal, sweep rows forward
  substring    -> dp[i][j] from dp[i+1][j-1], sweep by INCREASING LENGTH
                  (or i descending, j ascending)
```

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

```text
Edit distance grid for a = "sea", b = "eat"

            ""   e    a    t
       ""    0    1    2    3      base row: insert j characters
       s     1    1    2    3
       e     2    1    2    3
       a     3    2    1  [ 2 ]    answer
             ^
             base column: delete i characters

each cell looks at three already-filled neighbours:

        dp[i-1][j-1]  dp[i-1][j]        match    -> take the diagonal
        dp[i][j-1]    dp[i][j]          mismatch -> 1 + min of all three
```

### Interview explanation
"String DP problems are all the same move: the state is a pair of prefix lengths, `dp[i][j]`, meaning the answer for the first `i` characters of one string and the first `j` of the other. I derive the recurrence by asking what happens at the last character — either the two characters agree and I move diagonally for free, or I pay one operation and move up, left, or diagonally. Base cases are the empty-string row and column. Since every cell reads only cells above and to the left, a simple forward double loop is a valid fill order. That's O(m·n) time and O(m·n) space, which I can drop to O(n) by keeping only the previous row. The one variation to watch for is interval DP on a single string — there `dp[i][j]` reads `dp[i+1][j-1]`, so I must iterate by increasing substring length instead."

---

## 5. Generic Templates

> Two skeletons cover this chapter: **prefix-pair DP** sweeps rows forward; **interval DP** sweeps by increasing length.

```go
// LCSLength is the prefix-pair skeleton.
// dp[i][j] = length of the longest common subsequence of a[:i] and b[:j].
// Reads only up / left / diagonal, so a forward row sweep is a legal order.
func LCSLength(a, b string) int {
    m, n := len(a), len(b)
    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1) // dp[0][*] and dp[*][0] are 0: empty prefix
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if a[i-1] == b[j-1] {
                dp[i][j] = dp[i-1][j-1] + 1 // matched pair, extend the diagonal
            } else if dp[i-1][j] >= dp[i][j-1] {
                dp[i][j] = dp[i-1][j] // drop a[i-1]
            } else {
                dp[i][j] = dp[i][j-1] // drop b[j-1]
            }
        }
    }
    return dp[m][n]
}

// PalindromeTable is the interval skeleton.
// table[i][j] reports whether s[i..j] is a palindrome. Because the recurrence
// reads table[i+1][j-1] (one row BELOW), we must fill shorter spans first.
func PalindromeTable(s string) [][]bool {
    n := len(s)
    table := make([][]bool, n)
    for i := range table {
        table[i] = make([]bool, n)
        table[i][i] = true // every single character is a palindrome
    }

    for length := 2; length <= n; length++ { // increasing span length
        for i := 0; i+length-1 < n; i++ {
            j := i + length - 1
            if s[i] != s[j] {
                continue
            }
            // length 2 has an empty interior; longer spans consult the inside,
            // which was decided in an earlier (shorter) round.
            if length == 2 || table[i+1][j-1] {
                table[i][j] = true
            }
        }
    }
    return table
}
```

```python
def lcs_length(a, b):
    """dp[i][j] = LCS length of a[:i] and b[:j]. Reads up / left / diagonal."""
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]   # empty prefix rows are 0

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1   # extend the diagonal
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
    return dp[m][n]


def palindrome_table(s):
    """table[i][j] = is s[i..j] a palindrome. Fill SHORT spans first, because
    the recurrence reads table[i+1][j-1], which lives one row below."""
    n = len(s)
    table = [[False] * n for _ in range(n)]
    for i in range(n):
        table[i][i] = True                        # single characters

    for length in range(2, n + 1):                # increasing span length
        for i in range(0, n - length + 1):
            j = i + length - 1
            if s[i] != s[j]:
                continue
            if length == 2 or table[i + 1][j - 1]:
                table[i][j] = True
    return table
```

```java
public class StringDP {
    // dp[i][j] = LCS length of a[:i] and b[:j]; reads up / left / diagonal.
    public static int lcsLength(String a, String b) {
        int m = a.length(), n = b.length();
        int[][] dp = new int[m + 1][n + 1];        // empty-prefix borders are 0

        for (int i = 1; i <= m; i++) {
            for (int j = 1; j <= n; j++) {
                if (a.charAt(i - 1) == b.charAt(j - 1))
                    dp[i][j] = dp[i - 1][j - 1] + 1;   // extend the diagonal
                else
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
        return dp[m][n];
    }

    // table[i][j] = is s[i..j] a palindrome. Shorter spans MUST come first:
    // the recurrence reads table[i + 1][j - 1], one row below.
    public static boolean[][] palindromeTable(String s) {
        int n = s.length();
        boolean[][] table = new boolean[n][n];
        for (int i = 0; i < n; i++) table[i][i] = true;

        for (int length = 2; length <= n; length++) {
            for (int i = 0; i + length - 1 < n; i++) {
                int j = i + length - 1;
                if (s.charAt(i) != s.charAt(j)) continue;
                if (length == 2 || table[i + 1][j - 1]) table[i][j] = true;
            }
        }
        return table;
    }
}
```

```cpp
#include <string>
#include <vector>
using namespace std;

// dp[i][j] = LCS length of a[:i] and b[:j]; reads up / left / diagonal.
int lcsLength(const string& a, const string& b) {
    int m = (int)a.size(), n = (int)b.size();
    vector<vector<int>> dp(m + 1, vector<int>(n + 1, 0)); // empty-prefix borders

    for (int i = 1; i <= m; ++i) {
        for (int j = 1; j <= n; ++j) {
            if (a[i - 1] == b[j - 1])
                dp[i][j] = dp[i - 1][j - 1] + 1;          // extend the diagonal
            else
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[m][n];
}

// table[i][j] = is s[i..j] a palindrome. Fill SHORT spans first: the
// recurrence reads table[i + 1][j - 1], which lives one row below.
vector<vector<bool>> palindromeTable(const string& s) {
    int n = (int)s.size();
    vector<vector<bool>> table(n, vector<bool>(n, false));
    for (int i = 0; i < n; ++i) table[i][i] = true;

    for (int length = 2; length <= n; ++length) {
        for (int i = 0; i + length - 1 < n; ++i) {
            int j = i + length - 1;
            if (s[i] != s[j]) continue;
            if (length == 2 || table[i + 1][j - 1]) table[i][j] = true;
        }
    }
    return table;
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
Return the minimum number of single-character insert / delete / replace operations needed to turn `word1` into `word2`.

### Thought Process
1. **What does `dp[i][j]` mean?** *The minimum number of operations to turn the first `i` characters of `word1` into the first `j` characters of `word2`.* Not "the answer at `i`" — a complete, standalone question.
2. **How do we compute it?** Look at the last character of each prefix. If `word1[i-1] == word2[j-1]` they already agree, so `dp[i][j] = dp[i-1][j-1]` — free. Otherwise pay 1 and pick the cheapest repair: `dp[i-1][j]` (**delete** `word1[i-1]`), `dp[i][j-1]` (**insert** `word2[j-1]`), `dp[i-1][j-1]` (**replace** one with the other).
3. **Base case?** `dp[i][0] = i`: turning `i` characters into the empty string costs `i` deletions. `dp[0][j] = j`: building `j` characters from nothing costs `j` insertions. `dp[0][0] = 0`.
4. **Direction?** Every read is up (`i-1`), left (`j-1`), or diagonal — never down or right. So `i` ascending, `j` ascending is legal: those neighbours are already written.
5. Answer is the corner `dp[m][n]`.

### Dry Run

Input: `word1 = "sea"`, `word2 = "eat"`

Base row `dp[0] = [0,1,2,3]`; base column `dp[i][0] = i`.

| i | j | `word1[i-1]` | `word2[j-1]` | match? | up `dp[i-1][j]` | left `dp[i][j-1]` | diag `dp[i-1][j-1]` | `dp[i][j]` |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | s | e | no  | 1 | 1 | 0 | `1 + min(1,1,0)` = **1** |
| 1 | 2 | s | a | no  | 2 | 1 | 1 | `1 + min(2,1,1)` = **2** |
| 1 | 3 | s | t | no  | 3 | 2 | 2 | `1 + min(3,2,2)` = **3** |
| 2 | 1 | e | e | **yes** | — | — | 1 | diag = **1** |
| 2 | 2 | e | a | no  | 2 | 1 | 1 | `1 + min(2,1,1)` = **2** |
| 2 | 3 | e | t | no  | 3 | 2 | 2 | `1 + min(3,2,2)` = **3** |
| 3 | 1 | a | e | no  | 1 | 3 | 2 | `1 + min(1,3,2)` = **2** |
| 3 | 2 | a | a | **yes** | — | — | 1 | diag = **1** |
| 3 | 3 | a | t | no  | 3 | 1 | 2 | `1 + min(3,1,2)` = **2** |

Output: **2** — `"sea"` → `"ea"` (delete `s`) → `"eat"` (insert `t`).

Row `i=2, j=1` is the one to stare at: `e` matches `e`, so the cell copies the diagonal `dp[1][0] = 1` *unchanged*. A match never costs anything and never consults the up/left neighbours — the algorithm is only allowed to charge for a mismatch.

### Visualization

```text
            ""    e     a     t
       ""  [ 0 ]  1     2     3
       s     1  [ 1 ]   2     3
       e     2  [ 1 ]   2     3
       a     3    2   [ 1 ] [ 2 ]  <- answer

the cheapest path traced backwards from dp[3][3]:

  dp[3][3]=2  --left--> dp[3][2]=1   (insert 't')
  dp[3][2]=1  --diag--> dp[2][1]=1   (match 'a')
  dp[2][1]=1  --diag--> dp[1][0]=1   (match 'e')
  dp[1][0]=1  --up----> dp[0][0]=0   (delete 's')

  two paid moves  =>  edit distance 2
```

### Code

```go
// minDistance returns the edit distance between word1 and word2.
// dp[i][j] = ops to turn word1[:i] into word2[:j].
func minDistance(word1 string, word2 string) int {
    m, n := len(word1), len(word2)

    dp := make([][]int, m+1)
    for i := range dp {
        dp[i] = make([]int, n+1)
    }
    for i := 0; i <= m; i++ {
        dp[i][0] = i // delete every remaining character
    }
    for j := 0; j <= n; j++ {
        dp[0][j] = j // insert every needed character
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if word1[i-1] == word2[j-1] {
                dp[i][j] = dp[i-1][j-1] // characters agree: free
                continue
            }
            del, ins, rep := dp[i-1][j], dp[i][j-1], dp[i-1][j-1]
            best := del
            if ins < best {
                best = ins
            }
            if rep < best {
                best = rep
            }
            dp[i][j] = 1 + best
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
        dp[i][0] = i                    # delete every remaining character
    for j in range(n + 1):
        dp[0][j] = j                    # insert every needed character

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if word1[i - 1] == word2[j - 1]:
                dp[i][j] = dp[i - 1][j - 1]      # agree: free
            else:
                dp[i][j] = 1 + min(dp[i - 1][j],      # delete
                                   dp[i][j - 1],      # insert
                                   dp[i - 1][j - 1])  # replace
    return dp[m][n]
```

### Complexity
Time O(m·n) — one constant-time decision per grid cell. Space O(m·n) for the table, reducible to O(n) because a row only ever reads the row directly above it.

---

## 10. Solved Example 2

### Problem — Longest Palindrome (LeetCode 5)
Return the longest contiguous substring of `s` that reads the same forwards and backwards.

### Thought Process
1. **What does `dp[i][j]` mean?** *A boolean: is the substring `s[i..j]` (inclusive on both ends) a palindrome?*
2. **How do we compute it?** A span is a palindrome exactly when its two ends match **and** its interior is a palindrome: `dp[i][j] = (s[i] == s[j]) && dp[i+1][j-1]`. The second term is the whole reason this is DP and not a rescan — the interior was already decided.
3. **Base case?** `dp[i][i] = true` — one character always reads the same both ways. And a span of length 2 has an *empty* interior, which is vacuously a palindrome, so `dp[i][i+1] = (s[i] == s[i+1])`. Without that second base case the code would index `dp[i+1][i]`, a cell below the diagonal that means nothing.
4. **Direction?** `dp[i][j]` reads `dp[i+1][j-1]` — one row **below**, one column left. Ascending `i` would read row `i+1` before it exists. Iterating by **increasing span length** guarantees the interior (which is exactly 2 shorter) is already final.
5. Track the widest `true` span as you go and slice it out at the end.

### Dry Run

Input: `s = "babad"` (indices `b=0 a=1 b=2 a=3 d=4`)

| length | i | j | `s[i]`,`s[j]` | ends match? | interior `dp[i+1][j-1]` | `dp[i][j]` | best so far |
|--------|---|---|---------------|-------------|--------------------------|-----------|-------------|
| 1 | 0..4 | = i | — | — | — | all **true** | `"b"` (len 1) |
| 2 | 0 | 1 | b, a | no | — | false | `"b"` |
| 2 | 1 | 2 | a, b | no | — | false | `"b"` |
| 2 | 2 | 3 | b, a | no | — | false | `"b"` |
| 2 | 3 | 4 | a, d | no | — | false | `"b"` |
| 3 | 0 | 2 | b, b | **yes** | `dp[1][1]` = true | **true** | **`"bab"` (len 3)** |
| 3 | 1 | 3 | a, a | **yes** | `dp[2][2]` = true | **true** | `"bab"` (tie, keep first) |
| 3 | 2 | 4 | b, d | no | — | false | `"bab"` |
| 4 | 0 | 3 | b, a | no | — | false | `"bab"` |
| 4 | 1 | 4 | a, d | no | — | false | `"bab"` |
| 5 | 0 | 4 | b, d | no | — | false | `"bab"` |

Output: **`"bab"`** (`"aba"` is an equally valid answer; LeetCode accepts either.)

The length-3 rows are the point of the whole ordering: `dp[0][2]` consults `dp[1][1]`, which was written in the **length-1** round. Had we swept `i` upward instead, `dp[0][2]` would have been asked before `dp[1][1]` existed.

### Visualization

```text
s = b  a  b  a  d
    0  1  2  3  4

fill order (each number is the round that writes the cell):

      j=  0    1    2    3    4
  i=0     1    2    3    4    5
  i=1     -    1    2    3    4
  i=2     -    -    1    2    3
  i=3     -    -    -    1    2
  i=4     -    -    -    -    1

  round = span length. Diagonals fill outward from the main diagonal.

dp[0][2] "bab"          dp[0][3] "baba"
   ends  b == b  OK        ends  b != a  -> false immediately
   inner dp[1][1] "a"      (no need to look inside at all)
   -> true, length 3
```

### Code

```go
// longestPalindrome returns the longest palindromic substring of s using an
// interval DP table filled by INCREASING span length.
func longestPalindrome(s string) string {
    n := len(s)
    if n == 0 {
        return ""
    }

    // isPal[i][j] = true when s[i..j] reads the same both ways.
    isPal := make([][]bool, n)
    for i := range isPal {
        isPal[i] = make([]bool, n)
        isPal[i][i] = true // base case: one character
    }

    bestStart, bestLen := 0, 1

    for length := 2; length <= n; length++ { // shorter spans are already final
        for i := 0; i+length-1 < n; i++ {
            j := i + length - 1
            if s[i] != s[j] {
                continue // ends disagree: cannot be a palindrome
            }
            // length 2 has an empty interior; longer spans read the interior,
            // which was decided in the round for length-2.
            if length == 2 || isPal[i+1][j-1] {
                isPal[i][j] = true
                if length > bestLen {
                    bestStart, bestLen = i, length
                }
            }
        }
    }
    return s[bestStart : bestStart+bestLen]
}
```

```python
def longestPalindrome(s):
    n = len(s)
    if n == 0:
        return ""

    # is_pal[i][j] = does s[i..j] read the same both ways?
    is_pal = [[False] * n for _ in range(n)]
    for i in range(n):
        is_pal[i][i] = True                  # base case: one character

    best_start, best_len = 0, 1

    for length in range(2, n + 1):           # shorter spans are already final
        for i in range(0, n - length + 1):
            j = i + length - 1
            if s[i] != s[j]:
                continue                     # ends disagree
            if length == 2 or is_pal[i + 1][j - 1]:
                is_pal[i][j] = True
                if length > best_len:
                    best_start, best_len = i, length

    return s[best_start:best_start + best_len]
```

### Complexity
Time O(n²) — one cell per `(i, j)` pair with `i <= j`, each O(1). Space O(n²) for the table.

> **Follow-up:** the same answer comes out of *expand around centre* in O(n²) time but **O(1)** space — for each of the `2n-1` centres, walk outward while the ends match. Mention it as the space-optimal alternative; the DP table is the one to reach for when the problem also asks *how many* palindromic substrings there are, or needs the table reused (e.g. palindrome partitioning).

---

## 11. Solved Example 3

### Problem — Regex Match (LeetCode 10)
Return whether the **entire** string `s` matches pattern `p`, where `.` matches any single character and `*` matches zero or more of the element immediately before it.

### Thought Process
1. **What does `dp[i][j]` mean?** *Does the first `i` characters of `s` match the first `j` characters of `p`, completely?* Prefix-pair DP again — the `*` only changes the transitions, not the shape.
2. **How do we compute it?** Two cases at `p[j-1]`:
   - Not a `*`: it must consume exactly one character, so `dp[i][j] = dp[i-1][j-1]` **and** `p[j-1]` matches `s[i-1]` (equal, or `p[j-1] == '.'`).
   - A `*`: it and its preceding element `p[j-2]` form one unit with two choices. **Zero copies:** throw the whole `x*` away → `dp[i][j-2]`. **One more copy:** only if `p[j-2]` matches `s[i-1]`; then consume that one character but keep the `x*` available → `dp[i-1][j]`. `dp[i][j]` is the OR of the two.
3. **Base case?** `dp[0][0] = true` (empty matches empty). Row 0 is not all false: a pattern like `a*b*` matches the empty string, so for each `j` where `p[j-1] == '*'`, set `dp[0][j] = dp[0][j-2]`. Column 0 beyond `dp[0][0]` is false — a non-empty string cannot match an empty pattern.
4. **Direction?** `dp[i][j]` reads `dp[i-1][j-1]`, `dp[i][j-2]`, `dp[i-1][j]` — all up and/or left. Forward `i`, forward `j` is legal.
5. Answer is `dp[len(s)][len(p)]`.

### Dry Run

Input: `s = "aab"`, `p = "c*a*b"`

Pattern positions: `j=1` → `c`, `j=2` → `*`, `j=3` → `a`, `j=4` → `*`, `j=5` → `b`.

Row 0 (empty `s`): `dp[0][0]=T`; `dp[0][2] = dp[0][0] = T` (`c*` takes zero `c`s); `dp[0][4] = dp[0][2] = T` (`a*` takes zero `a`s). All other row-0 cells are false.

| i | `s[i-1]` | j | `p[j-1]` | rule applied | value |
|---|----------|---|----------|--------------|-------|
| 1 | a | 1 | c | plain char, `c != a` | F |
| 1 | a | 2 | `*` | zero: `dp[1][0]=F`; more: `p[0]='c' != 'a'` | F |
| 1 | a | 3 | a | plain char, `a == a` → `dp[0][2]` = T | **T** |
| 1 | a | 4 | `*` | zero: `dp[1][2]=F`; more: `p[2]='a' == 'a'` → `dp[0][4]` = T | **T** |
| 1 | a | 5 | b | plain char, `b != a` | F |
| 2 | a | 3 | a | `a == a` → `dp[1][2]` = F | F |
| 2 | a | 4 | `*` | zero: `dp[2][2]=F`; more: `p[2]='a' == 'a'` → `dp[1][4]` = T | **T** |
| 2 | a | 5 | b | `b != a` | F |
| 3 | b | 4 | `*` | zero: `dp[3][2]=F`; more: `p[2]='a' != 'b'` | F |
| 3 | b | 5 | b | `b == b` → `dp[2][4]` = T | **T** |

Output: **true**

Follow `dp[2][4]` → `dp[1][4]` → `dp[0][4]`. That chain is `a*` eating its second `a`, then its first `a`, then finally taking the zero-copies exit. The `dp[i-1][j]` transition — *stay on the same `j`* — is what lets one `*` absorb an arbitrary run.

### Visualization

```text
p prefix:   ""    c    c*   c*a  c*a*  c*a*b
     j =     0    1    2     3     4     5
  ""  i=0    T    F    T     F     T     F
  a   i=1    F    F    F     T     T     F
  a   i=2    F    F    F     F     T     F
  b   i=3    F    F    F     F     F   [ T ]  <- answer

the two moves a '*' can make, drawn:

    zero copies                one more copy
    dp[i][j-2] ────► dp[i][j]  dp[i-1][j] ────► dp[i][j]
    (skip "x*" entirely)       (same j: the star stays reusable)
```

### Code

```go
// isMatch reports whether s matches the regex p ('.' = any char, '*' = zero or
// more of the previous element). dp[i][j] = does s[:i] match p[:j].
func isMatch(s string, p string) bool {
    m, n := len(s), len(p)

    dp := make([][]bool, m+1)
    for i := range dp {
        dp[i] = make([]bool, n+1)
    }
    dp[0][0] = true // empty matches empty

    // Empty s against patterns like "a*b*": each x* may take zero copies.
    for j := 2; j <= n; j++ {
        if p[j-1] == '*' {
            dp[0][j] = dp[0][j-2]
        }
    }

    matches := func(i, j int) bool { // does p[j-1] cover s[i-1]?
        return p[j-1] == '.' || p[j-1] == s[i-1]
    }

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            if p[j-1] == '*' {
                dp[i][j] = dp[i][j-2] // zero copies of p[j-2]
                if !dp[i][j] && (p[j-2] == '.' || p[j-2] == s[i-1]) {
                    dp[i][j] = dp[i-1][j] // one more copy, star stays available
                }
            } else if matches(i, j) {
                dp[i][j] = dp[i-1][j-1] // consume one character each
            }
        }
    }
    return dp[m][n]
}
```

```python
def isMatch(s, p):
    m, n = len(s), len(p)
    dp = [[False] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = True                              # empty matches empty

    for j in range(2, n + 1):                    # empty s vs "a*b*" patterns
        if p[j - 1] == '*':
            dp[0][j] = dp[0][j - 2]

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if p[j - 1] == '*':
                dp[i][j] = dp[i][j - 2]          # zero copies of p[j-2]
                if not dp[i][j] and p[j - 2] in ('.', s[i - 1]):
                    dp[i][j] = dp[i - 1][j]      # one more copy, star reusable
            elif p[j - 1] in ('.', s[i - 1]):
                dp[i][j] = dp[i - 1][j - 1]      # consume one character each
    return dp[m][n]
```

### Complexity
Time O(m·n) — each cell does O(1) work (a `*` inspects two neighbours). Space O(m·n), reducible to O(n) since only the previous row is read.

---

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
