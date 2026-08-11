# 84 · Digit DP

> **One-liner:** Count numbers in a range satisfying digit constraints via tight-flag DP.

---

## 1. Overview

### Definition
The **Digit DP** pattern belongs to the *Dynamic Programming* family. Count numbers in a range satisfying digit constraints via tight-flag DP.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
digit dp, count numbers, tight, bounds, constraints.

### Constraints
- Input size where the brute-force complexity would time out — the Digit DP optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Digit DP invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Digit DP is the upgrade.
- The wording maps onto: digit dp, count numbers, tight, bounds, constraints.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"How many numbers from 1 to N have some property about their digits?"*

### Intuition
Loop from 1 to N and test each number.

### Algorithm
1. For each `x` from `1` to `N`:
2. &nbsp;&nbsp;Extract its digits.
3. &nbsp;&nbsp;Check the property (contains a `1`, all digits distinct, digits from a given set…).
4. &nbsp;&nbsp;Increment a counter if it holds.

### Complexity
- Time: **O(N · log N)** — `N` numbers, each with about `log₁₀ N` digits.
- Space: O(1).

### Drawbacks
- Fine for `N = 10⁶`, hopeless for `N = 10⁹` and utterly impossible for the `10¹⁸` bounds these problems usually carry.
- The waste has a shape worth naming: numbers `500,000,000` through `599,999,999` all share the prefix `5`, and once you have fixed that prefix the count of valid completions is **the same regardless of which prefix it was**. The brute force recomputes that identical subproblem a hundred million times.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Build the number one digit at a time from the most significant end, and memoise on the small amount of state that actually distinguishes one prefix from another.**

The count of numbers is astronomically large; the number of *distinct situations* while building one is tiny.

### The thought process

```text
We need    : count numbers in [1, N] with a digit property.
Obvious way: test every number.
Impossible : N can be 10^18.
Notice     : while building a number left to right, all that matters
             for the REST of it is a handful of facts — how many digits
             remain, whether we are still hugging N's prefix, and
             whatever the property needs to remember.
Therefore  : recurse over digit positions, carrying that state, and
             memoise it.
Now        : O(digits x states x 10) — about a thousand operations.
```

### The three pieces of state

Almost every digit-DP carries these. The first two are universal; the third is problem-specific.

**1. `pos` — which digit position we are filling** (0 = most significant).

**2. `tight` — are we still hugging N's prefix?**

This is the one that makes the problem finite, and the one people get wrong.

```text
tight = true   every digit so far equals N's digit, so this position
               is capped at N's digit here — going higher would
               exceed N

tight = false  some earlier digit was already strictly smaller, so N
               can no longer be exceeded and this position is free
               to be 0-9
```

The update rule is the whole trick:

```text
nextTight = tight && (chosenDigit == limit)
```

Once `tight` becomes false it **stays** false for the rest of the number — you can never become constrained again.

**3. `started` — have we placed a non-zero digit yet?**

Needed whenever leading zeros would be miscounted. Building a 3-digit-wide number `007` should count as the number `7`, not as a 3-digit number containing two zeros. Until `started` is true, a chosen `0` is *padding*, not a digit.

Whether you need `started` depends on the property:

| Property | Needs `started`? |
|---|---|
| Count occurrences of the digit 1 | no — leading zeros contribute no 1s |
| All digits distinct | **yes** — padding zeros must not count as "used 0" |
| Digits drawn from a given set | **yes** — shorter numbers are separate cases |

### Why you can only memoise the `tight == false` states

This is the subtlety that breaks naive implementations.

When `tight` is true, the digits available at this position depend on **N itself**, not just on `pos`. Two different prefixes reaching the same `pos` with `tight == true` are not interchangeable. But when `tight` is false, every digit `0..9` is available and the number of valid completions depends only on `pos` and the property state — so it is safe to cache and reuse.

```text
memo[pos][state]  is filled ONLY when tight == false and started == true
```

There is exactly one `tight == true` path through the whole recursion (the one tracing N's own digits), so leaving it uncached costs nothing.

### Steps

```text
Step 1 → Convert N to a digit array d[0..k-1].
Step 2 → define solve(pos, state, tight, started):
Step 3 →     if pos == k:  return the base value for this state
Step 4 →     if not tight and started and memo has (pos, state): return it
Step 5 →     limit = d[pos] if tight else 9
Step 6 →     total = 0
Step 7 →     for digit = 0 .. limit:
Step 8 →         work out the next state from the property's rules
Step 9 →         total += solve(pos+1, nextState,
                                tight && digit == limit,
                                started || digit > 0)
Step 10 →    if not tight and started: memo[pos][state] = total
Step 11 →    return total
```

### The `f(B) − f(A−1)` trick

For a range `[A, B]` rather than `[1, N]`, count up to each endpoint and subtract:

```text
answer = countUpTo(B) - countUpTo(A - 1)
```

That is why these routines are always written as "count from 0 up to N" — a single-sided routine composes into any range.

### Counting *occurrences* rather than *numbers*

Some problems ask "how many times does the digit 1 appear across all numbers up to N", not "how many numbers contain a 1". The change is small: instead of returning `1` at the base case, return the accumulated count carried in the state. The recursion sums contributions rather than counting leaves.

### How should I recognize this?

```text
If you see...
  "how many numbers in [1, N] such that <digit property>"
  "count numbers with no repeated digits / with digits from a set"
  "sum of digits of all numbers up to N"
  N up to 10^9 or 10^18 — far too large to iterate
        ↓
Think about...
  "Build the number digit by digit. What must I remember
   for the remaining positions to be decidable?"
        ↓
Use...
  solve(pos, state, tight, started), memoised on (pos, state)
  ONLY when tight is false
  range [A,B]  →  countUpTo(B) - countUpTo(A-1)
```

### Visual explanation

```svg
<svg viewBox="0 0 620 262" width="100%" height="262" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr84" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Digit DP over N = 57: tight vs free branching</text>
  <rect x="230" y="40" width="160" height="42" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="310" y="60" text-anchor="middle" fill="#1e293b">pos 0, tight</text>
  <text x="310" y="76" text-anchor="middle" fill="#64748b" font-size="11">first digit &#8804; 5</text>
  <line x1="270" y1="84" x2="160" y2="134" stroke="#475569" marker-end="url(#arr84)"/>
  <text x="188" y="112" text-anchor="middle" fill="#059669">d0 in 0..4</text>
  <line x1="350" y1="84" x2="452" y2="134" stroke="#475569" marker-end="url(#arr84)"/>
  <text x="432" y="112" text-anchor="middle" fill="#d97706">d0 = 5</text>
  <rect x="60" y="136" width="180" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="150" y="156" text-anchor="middle" font-weight="700" fill="#1e293b">FREE</text>
  <text x="150" y="172" text-anchor="middle" fill="#64748b" font-size="11">below bound, unrestricted</text>
  <rect x="380" y="136" width="180" height="44" rx="6" fill="#fff7ed" stroke="#d97706"/>
  <text x="470" y="156" text-anchor="middle" font-weight="700" fill="#1e293b">TIGHT</text>
  <text x="470" y="172" text-anchor="middle" fill="#64748b" font-size="11">still on the bound</text>
  <line x1="150" y1="182" x2="150" y2="212" stroke="#475569" marker-end="url(#arr84)"/>
  <line x1="470" y1="182" x2="470" y2="212" stroke="#475569" marker-end="url(#arr84)"/>
  <text x="150" y="232" text-anchor="middle" fill="#059669">pos 1: digit 0..9 (any)</text>
  <text x="470" y="232" text-anchor="middle" fill="#d97706">pos 1: digit 0..7 (&#8804; N)</text>
  <text x="310" y="254" text-anchor="middle" fill="#64748b">memo keyed on (pos, tight) so free subtrees are reused</text>
</svg>
```

```text
N = 13, counting how many times the digit '1' appears in 1..13

digits of N: [1, 3]

pos 0, tight=true, limit=1
 ├── digit 0 → tight becomes false (0 < 1)
 │      pos 1, limit=9, free choice: 00..09, i.e. numbers 0-9
 │      exactly one of them (the number 1) contributes a '1'   → 1
 │
 └── digit 1 → tight stays true (1 == 1), one '1' banked
        pos 1, tight=true, limit=3   → numbers 10..13
         ├── 0 → "10", ones so far 1  → 1
         ├── 1 → "11", ones so far 2  → 2
         ├── 2 → "12", ones so far 1  → 1
         └── 3 → "13", ones so far 1  → 1     subtotal 5

total = 1 + 5 = 6
```

### Interview explanation
"N is far too large to iterate, but the number of *distinct situations* while building a number digit by digit is tiny — so I'll do a digit DP. I recurse over positions from the most significant end, carrying three things: the position, a `tight` flag saying whether every digit so far has matched N's prefix, and whatever the property needs to remember. `tight` is what bounds the digit I may place: if it's true this position is capped at N's digit, and it stays true only if I choose exactly that digit. Once it goes false it never comes back. I also carry a `started` flag when leading zeros would be miscounted — `007` must count as 7, not as a three-digit number. The key detail is that I only memoise states where `tight` is false, because a tight state's available digits depend on N itself rather than just on the position; there's only one tight path through the whole recursion, so leaving it uncached costs nothing. That gives roughly O(digits × states × 10). For a range `[A, B]` I'd compute `countUpTo(B) − countUpTo(A−1)`."

---

## 5. Generic Templates

> `solve(pos, state, tight, started)`, memoised only when `tight` is false.

```go
// CountDistinctDigitNumbers counts the integers in [1, n] whose decimal
// digits are all different. It is the canonical shape of a digit DP.
func CountDistinctDigitNumbers(n int) int {
    if n < 0 {
        return 0
    }
    digits := toDigits(n)

    // memo[pos][usedMask]: valid only for tight == false && started == true,
    // because a tight state's available digits depend on n itself.
    memo := make(map[[2]int]int)

    var solve func(pos, usedMask int, tight, started bool) int
    solve = func(pos, usedMask int, tight, started bool) int {
        if pos == len(digits) {
            if started {
                return 1 // one complete number
            }
            return 0 // nothing was ever placed: this is the number 0
        }

        key := [2]int{pos, usedMask}
        if !tight && started {
            if cached, ok := memo[key]; ok {
                return cached
            }
        }

        limit := 9
        if tight {
            limit = digits[pos] // capped by n's digit at this position
        }

        total := 0
        for digit := 0; digit <= limit; digit++ {
            // tight survives only if we pick exactly the limiting digit.
            nextTight := tight && digit == limit

            if !started && digit == 0 {
                // Still a leading zero: padding, not a real digit, so the
                // used-mask is untouched.
                total += solve(pos+1, usedMask, nextTight, false)
                continue
            }
            if usedMask&(1<<digit) != 0 {
                continue // this digit already appeared
            }
            total += solve(pos+1, usedMask|(1<<digit), nextTight, true)
        }

        if !tight && started {
            memo[key] = total
        }
        return total
    }

    return solve(0, 0, true, false)
}

// CountInRange shows the two-sided composition.
func CountInRange(low, high int) int {
    return CountDistinctDigitNumbers(high) - CountDistinctDigitNumbers(low-1)
}

func toDigits(n int) []int {
    if n == 0 {
        return []int{0}
    }
    digits := []int{}
    for n > 0 {
        digits = append(digits, n%10)
        n /= 10
    }
    // Reverse: most significant first.
    for l, r := 0, len(digits)-1; l < r; l, r = l+1, r-1 {
        digits[l], digits[r] = digits[r], digits[l]
    }
    return digits
}
```

```python
from functools import lru_cache

def count_distinct_digit_numbers(n):
    """Integers in [1, n] whose decimal digits are all different."""
    if n < 0:
        return 0
    digits = [int(c) for c in str(n)]

    # Cached only for tight == False and started == True: a tight state's
    # available digits depend on n itself, not just on pos.
    @lru_cache(maxsize=None)
    def cached(pos, used_mask):
        return walk(pos, used_mask, False, True)

    def walk(pos, used_mask, tight, started):
        if pos == len(digits):
            return 1 if started else 0

        if not tight and started:
            return cached(pos, used_mask)

        limit = digits[pos] if tight else 9
        total = 0
        for digit in range(limit + 1):
            next_tight = tight and digit == limit
            if not started and digit == 0:
                # Leading zero: padding, so the mask is untouched.
                total += walk(pos + 1, used_mask, next_tight, False)
            elif not used_mask & (1 << digit):
                total += walk(pos + 1, used_mask | (1 << digit), next_tight, True)
        return total

    return walk(0, 0, True, False)

def count_in_range(low, high):
    """Two-sided composition."""
    return count_distinct_digit_numbers(high) - count_distinct_digit_numbers(low - 1)
```

```java
import java.util.*;

public class DigitDP {
    private int[] digits;
    private Map<Long, Integer> memo;

    public int countDistinctDigitNumbers(int n) {
        if (n < 0) return 0;
        String s = Integer.toString(n);
        digits = new int[s.length()];
        for (int i = 0; i < s.length(); i++) digits[i] = s.charAt(i) - '0';
        memo = new HashMap<>();
        return solve(0, 0, true, false);
    }

    private int solve(int pos, int usedMask, boolean tight, boolean started) {
        if (pos == digits.length) return started ? 1 : 0;

        long key = ((long) pos << 12) | usedMask;
        if (!tight && started && memo.containsKey(key)) return memo.get(key);

        int limit = tight ? digits[pos] : 9;
        int total = 0;

        for (int digit = 0; digit <= limit; digit++) {
            boolean nextTight = tight && digit == limit;
            if (!started && digit == 0) {
                total += solve(pos + 1, usedMask, nextTight, false);   // padding
            } else if ((usedMask & (1 << digit)) == 0) {
                total += solve(pos + 1, usedMask | (1 << digit), nextTight, true);
            }
        }

        if (!tight && started) memo.put(key, total);
        return total;
    }
}
```

```cpp
#include <string>
#include <unordered_map>
using namespace std;

string nDigits;
unordered_map<int, int> digitMemo;

int solveDigits(int pos, int usedMask, bool tight, bool started) {
    if (pos == (int)nDigits.size()) return started ? 1 : 0;

    int key = pos * 1024 + usedMask;
    if (!tight && started) {
        auto it = digitMemo.find(key);
        if (it != digitMemo.end()) return it->second;
    }

    int limit = tight ? nDigits[pos] - '0' : 9;
    int total = 0;

    for (int digit = 0; digit <= limit; ++digit) {
        bool nextTight = tight && digit == limit;
        if (!started && digit == 0) {
            total += solveDigits(pos + 1, usedMask, nextTight, false);  // padding
        } else if (!(usedMask & (1 << digit))) {
            total += solveDigits(pos + 1, usedMask | (1 << digit), nextTight, true);
        }
    }

    if (!tight && started) digitMemo[key] = total;
    return total;
}

int countDistinctDigitNumbers(int n) {
    if (n < 0) return 0;
    nDigits = to_string(n);
    digitMemo.clear();
    return solveDigits(0, 0, true, false);
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Digit DP (Optimal) |
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

### Problem — Number of Digit One (LeetCode 233)
Count the total number of times the digit `1` appears across all integers from `1` to `n`.

### Thought Process
1. This counts **occurrences**, not numbers — `11` contributes two. So the recursion sums a carried tally rather than counting leaves.
2. State: `pos`, `onesSoFar`, and `tight`. No `started` flag is needed, because a leading zero contributes no `1`s either way.
3. At the base case return `onesSoFar` — the number of `1`s in this fully-built number.
4. `tight` caps the digit at this position and survives only if we pick exactly that cap.
5. Memoise on `(pos, onesSoFar)` when `tight` is false.

### Dry Run

Input: `n = 13` → digits `[1, 3]`

**Position 0, `tight = true`, so the limit is `1`:**

| digit | new `onesSoFar` | `nextTight` | subtree |
|-------|------------------|-------------|---------|
| 0 | 0 | `true && 0==1` → **false** | free 2nd digit: numbers 00–09 |
| 1 | 1 | `true && 1==1` → **true** | 2nd digit capped: numbers 10–13 |

**The `digit = 0` subtree** (position 1, free, `onesSoFar = 0`): the ten completions are `00…09`. Only `01` carries a `1`, so this subtree returns **1**.

**The `digit = 1` subtree** (position 1, `tight`, limit `3`, `onesSoFar = 1`):

| digit | number | `onesSoFar` at the base | contributes |
|-------|--------|--------------------------|-------------|
| 0 | 10 | 1 | 1 |
| 1 | 11 | **2** | 2 |
| 2 | 12 | 1 | 1 |
| 3 | 13 | 1 | 1 |

Subtotal: **5**

Total: `1 + 5` = **6** ✓

Check by hand: `1, 10, 11, 12, 13` contain `1, 1, 2, 1, 1` ones → `6`. ✓

Note how `digit = 1` at position 0 banked a `1` that then applies to all four of `10`–`13` — that is the tally being carried down rather than recomputed.

### Visualization

```text
n = 13, digits [1, 3]

pos 0, tight, limit 1
 ├── 0 → tight OFF        pos 1 free: 00..09
 │                        only "01" has a 1              → 1
 └── 1 → tight ON, ones=1 pos 1 capped at 3: 10..13
          10 → 1
          11 → 2
          12 → 1
          13 → 1                                          → 5

                                                    total  6
```

### Code

```go
func countDigitOne(n int) int {
    if n <= 0 {
        return 0
    }

    digits := []int{}
    for x := n; x > 0; x /= 10 {
        digits = append(digits, x%10)
    }
    for l, r := 0, len(digits)-1; l < r; l, r = l+1, r-1 {
        digits[l], digits[r] = digits[r], digits[l] // most significant first
    }

    // Cached only for tight == false: a tight state's available digits
    // depend on n itself, not merely on the position.
    memo := make(map[[2]int]int)

    var solve func(pos, onesSoFar int, tight bool) int
    solve = func(pos, onesSoFar int, tight bool) int {
        if pos == len(digits) {
            return onesSoFar // this number contributed this many 1s
        }

        key := [2]int{pos, onesSoFar}
        if !tight {
            if cached, ok := memo[key]; ok {
                return cached
            }
        }

        limit := 9
        if tight {
            limit = digits[pos]
        }

        total := 0
        for digit := 0; digit <= limit; digit++ {
            nextOnes := onesSoFar
            if digit == 1 {
                nextOnes++
            }
            // tight survives only when we pick exactly the limiting digit.
            total += solve(pos+1, nextOnes, tight && digit == limit)
        }

        if !tight {
            memo[key] = total
        }
        return total
    }

    return solve(0, 0, true)
}
```

```python
from functools import lru_cache

def countDigitOne(n):
    if n <= 0:
        return 0
    digits = [int(c) for c in str(n)]

    @lru_cache(maxsize=None)
    def free(pos, ones_so_far):
        """Only valid when tight is False."""
        return walk(pos, ones_so_far, False)

    def walk(pos, ones_so_far, tight):
        if pos == len(digits):
            return ones_so_far          # this number contributed this many 1s
        if not tight:
            return free(pos, ones_so_far)

        limit = digits[pos]
        total = 0
        for digit in range(limit + 1):
            next_ones = ones_so_far + (1 if digit == 1 else 0)
            total += walk(pos + 1, next_ones, tight and digit == limit)
        return total

    return walk(0, 0, True)
```

### Complexity
Time **O(k² · 10)** where `k` is the number of digits (`onesSoFar` is at most `k`), so about 200 operations for `n = 10⁹`. Space O(k²).

---

## 10. Solved Example 2

### Problem — Numbers At Most N Given Digit Set (LeetCode 902)
Given a set of allowed digits (as sorted strings) and a number `n`, count how many positive integers `≤ n` can be written using **only** those digits, with unlimited repetition.

### Thought Process
1. Two separate cases, which is what makes `started` necessary here:
   - numbers with **fewer** digits than `n` — every position is free, so there are `|D|^length` of them
   - numbers with **exactly** as many digits as `n` — these must respect `tight`
2. The `started` flag handles the first case naturally: while it is false, choosing a leading zero just shortens the number.
3. Note `0` is generally **not** in the allowed set, so a leading zero is always padding, never a real digit.
4. At the base case, count `1` only if `started` — otherwise we built the number zero, which is not positive.
5. Memoise on `pos` alone once `tight` is false and `started` is true: no other state is carried.

### Dry Run

Input: `digits = ["1","3","5","7"]`, `n = 100`

`n` has 3 digits, and the allowed set has 4 members.

**Numbers with 1 digit:** any allowed digit → `4` numbers (`1, 3, 5, 7`).

**Numbers with 2 digits:** both positions free → `4 × 4 = 16` numbers (`11, 13, …, 77`).

**Numbers with 3 digits:** must be `≤ 100`. Position 0 is `tight` with limit `1`:

| digit at pos 0 | allowed? | consequence |
|----------------|----------|-------------|
| `1` | yes | `tight` stays on; position 1 is now capped at `0` |
| `3, 5, 7` | yes, but `3 > 1` | exceeds the limit → not generated |

Continuing the `1` branch: position 1 is `tight` with limit `0`, and `0` is **not** in the allowed set, so there is no legal digit. That branch dies.

**3-digit total: 0.** (Which is right — the smallest 3-digit number from `{1,3,5,7}` is `111 > 100`.)

Total: `4 + 16 + 0` = **20** ✓

### Visualization

```text
digits = {1,3,5,7},  n = 100  (3 digits)

length 1:  _            4 choices              →  4
length 2:  _ _          4 x 4                  → 16
length 3:  _ _ _        must be <= 100
             ↑
        pos 0 capped at 1 → only '1' is allowed and <= 1
        pos 1 capped at 0 → no allowed digit is <= 0 → dead

                                          total = 20
```

### Code

```go
func atMostNGivenDigitSet(digits []string, n int) int {
    numberDigits := []int{}
    for x := n; x > 0; x /= 10 {
        numberDigits = append(numberDigits, x%10)
    }
    for l, r := 0, len(numberDigits)-1; l < r; l, r = l+1, r-1 {
        numberDigits[l], numberDigits[r] = numberDigits[r], numberDigits[l]
    }

    allowed := make([]int, len(digits))
    for i, d := range digits {
        allowed[i] = int(d[0] - '0')
    }

    // Once tight is off and the number has started, only `pos` matters.
    memo := make(map[int]int)

    var solve func(pos int, tight, started bool) int
    solve = func(pos int, tight, started bool) int {
        if pos == len(numberDigits) {
            if started {
                return 1 // a complete positive number
            }
            return 0 // nothing placed: this is zero, not counted
        }

        if !tight && started {
            if cached, ok := memo[pos]; ok {
                return cached
            }
        }

        total := 0

        // Option A: still not started — leave this position empty, which
        // means building a SHORTER number.
        if !started {
            total += solve(pos+1, false, false)
        }

        limit := 9
        if tight {
            limit = numberDigits[pos]
        }
        for _, digit := range allowed {
            if digit > limit {
                break // `allowed` is sorted, so everything after is bigger
            }
            total += solve(pos+1, tight && digit == limit, true)
        }

        if !tight && started {
            memo[pos] = total
        }
        return total
    }

    return solve(0, true, false)
}
```

```python
from functools import lru_cache

def atMostNGivenDigitSet(digits, n):
    number_digits = [int(c) for c in str(n)]
    allowed = [int(d) for d in digits]

    @lru_cache(maxsize=None)
    def free(pos):
        """Only valid when tight is False and started is True."""
        return walk(pos, False, True)

    def walk(pos, tight, started):
        if pos == len(number_digits):
            return 1 if started else 0      # zero is not a positive number
        if not tight and started:
            return free(pos)

        total = 0
        if not started:
            # Leave this position empty → build a SHORTER number.
            total += walk(pos + 1, False, False)

        limit = number_digits[pos] if tight else 9
        for digit in allowed:
            if digit > limit:
                break                       # `allowed` is sorted
            total += walk(pos + 1, tight and digit == limit, True)
        return total

    return walk(0, True, False)
```

### Complexity
Time **O(k · |D|)** where `k` is the digit count — a few dozen operations even for `n = 10⁹`. Space O(k).

---

## 11. Solved Example 3

### Problem — Numbers With Repeated Digits (LeetCode 1012)
Count the positive integers `≤ n` that have **at least one repeated digit**.

### Thought Process
1. "At least one repeat" is awkward to track directly — you would have to remember *which* digit repeated and stop double-counting.
2. **Complement it.** Counting numbers with **all distinct** digits is easy, and:

```text
answer = n − (count of numbers in [1, n] with all distinct digits)
```

3. Distinctness needs a 10-bit `usedMask` of which digits have appeared.
4. `started` is essential here: a leading zero is padding and must **not** mark `0` as used. Without it, `007` would wrongly block a later real `0`.
5. Memoise on `(pos, usedMask)` when `tight` is false and `started` is true.

Reaching for the complement is the general move whenever the property is "at least one …" — the negation is usually a clean state to track.

### Dry Run

Input: `n = 20` → digits `[2, 0]`

Counting **distinct-digit** numbers in `[1, 20]`.

**Position 0, `tight = true`, limit `2`:**

| digit | branch | result |
|-------|--------|--------|
| `0` | padding (`started` still false), `tight` → false | 1-digit numbers: `1`–`9` all have distinct digits → **9** |
| `1` | `started`, mask `{1}`, `tight` → false | second digit free, any of `0,2,3,…,9` (not `1`) → **9** |
| `2` | `started`, mask `{2}`, `tight` stays **true** (limit at pos 1 is `0`) | second digit may only be `0`, which is unused → **1** (the number `20`) |

Distinct-digit total: `9 + 9 + 1` = **19**

Answer: `20 − 19` = **1** ✓

The single number with a repeated digit in `[1, 20]` is `11`. ✓

**A second case**, `n = 100`: the distinct-digit count comes to 90, so the answer is `100 − 90 = 10` — namely `11, 22, 33, 44, 55, 66, 77, 88, 99` and `100` (whose two zeros repeat). That last one is easy to forget by hand and is exactly why the DP is more trustworthy than enumeration.

### Visualization

```text
n = 20, counting ALL-DISTINCT numbers

pos 0, tight, limit 2
 ├── 0  padding → 1-digit numbers 1..9        →  9
 ├── 1  mask {1}, free 2nd digit (not 1)      →  9
 └── 2  mask {2}, tight, 2nd digit capped 0
          '0' unused → the number 20          →  1
                                          ───────
                                              19

answer = n - 19 = 20 - 19 = 1        (only 11 repeats)
```

### Code

```go
func numDupDigitsAtMostN(n int) int {
    // Complement: counting ALL-DISTINCT numbers is far easier.
    return n - countDistinctBelow(n)
}

// countDistinctBelow counts integers in [1, n] whose digits are all different.
func countDistinctBelow(n int) int {
    if n <= 0 {
        return 0
    }

    digits := []int{}
    for x := n; x > 0; x /= 10 {
        digits = append(digits, x%10)
    }
    for l, r := 0, len(digits)-1; l < r; l, r = l+1, r-1 {
        digits[l], digits[r] = digits[r], digits[l]
    }

    memo := make(map[[2]int]int)

    var solve func(pos, usedMask int, tight, started bool) int
    solve = func(pos, usedMask int, tight, started bool) int {
        if pos == len(digits) {
            if started {
                return 1
            }
            return 0 // nothing placed: the number zero
        }

        key := [2]int{pos, usedMask}
        if !tight && started {
            if cached, ok := memo[key]; ok {
                return cached
            }
        }

        limit := 9
        if tight {
            limit = digits[pos]
        }

        total := 0
        for digit := 0; digit <= limit; digit++ {
            nextTight := tight && digit == limit

            if !started && digit == 0 {
                // Leading zero is PADDING: it must not mark 0 as used,
                // or a later genuine 0 would be wrongly rejected.
                total += solve(pos+1, usedMask, nextTight, false)
                continue
            }
            if usedMask&(1<<digit) != 0 {
                continue // this digit already appeared
            }
            total += solve(pos+1, usedMask|(1<<digit), nextTight, true)
        }

        if !tight && started {
            memo[key] = total
        }
        return total
    }

    return solve(0, 0, true, false)
}
```

```python
from functools import lru_cache

def numDupDigitsAtMostN(n):
    """Complement: counting ALL-DISTINCT numbers is far easier."""
    return n - count_distinct_below(n)

def count_distinct_below(n):
    if n <= 0:
        return 0
    digits = [int(c) for c in str(n)]

    @lru_cache(maxsize=None)
    def free(pos, used_mask):
        return walk(pos, used_mask, False, True)

    def walk(pos, used_mask, tight, started):
        if pos == len(digits):
            return 1 if started else 0
        if not tight and started:
            return free(pos, used_mask)

        limit = digits[pos] if tight else 9
        total = 0
        for digit in range(limit + 1):
            next_tight = tight and digit == limit
            if not started and digit == 0:
                # Padding: must NOT mark 0 as used.
                total += walk(pos + 1, used_mask, next_tight, False)
            elif not used_mask & (1 << digit):
                total += walk(pos + 1, used_mask | (1 << digit), next_tight, True)
        return total

    return walk(0, 0, True, False)
```

### Complexity
Time **O(k · 2¹⁰ · 10)** where `k` is the digit count — about 10⁵ operations even for `n = 10⁹`. Space O(k · 2¹⁰).

> Two habits transfer from this chapter to every digit-DP problem: **complement an "at least one" property**, and **only memoise the non-tight states**. Together they turn a class of problems that looks intimidating into a fill-in-the-blanks template.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 233 | Number of Digit One | Easy | Core dynamic programming application |
| 902 | Numbers At Most N | Easy | Core dynamic programming application |
| 1012 | Repeated Digit | Medium | Core dynamic programming application |
| 600 | No Adjacent Ones | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Digit DP logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Digit DP (Dynamic Programming).
- **Signal:** digit dp, count numbers, tight, bounds, constraints.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Digit DP invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Digit DP
FAMILY : Dynamic Programming (Expert)
WHEN   : digit dp, count numbers, tight, bounds, constraints
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 233, 902, 1012, 600
```

---

*Part of the DSA Patterns Handbook — pattern 84 of 100.*
