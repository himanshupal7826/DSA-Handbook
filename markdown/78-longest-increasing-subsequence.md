# 78 · Longest Increasing Subsequence

> **One-liner:** O(n²) DP or O(n log n) patience sorting for longest increasing run.

---

## 1. Overview

### Definition
The **Longest Increasing Subsequence** pattern belongs to the *Dynamic Programming* family. O(n²) DP or O(n log n) patience sorting for longest increasing run.

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
lis, longest increasing, dp, patience, binary search.

### Constraints
- Input size where the brute-force complexity would time out — the Longest Increasing Subsequence optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Longest Increasing Subsequence invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Longest Increasing Subsequence is the upgrade.
- The wording maps onto: lis, longest increasing, dp, patience, binary search.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"What is the longest subsequence I can pull out that keeps increasing?"* — elements need not be adjacent, but must stay in their original order.

### Intuition
Every element is either in the subsequence or not. Try all `2ⁿ` choices and keep the longest increasing one.

### Algorithm
1. Enumerate every subsequence (all `2ⁿ` subsets of positions, in order).
2. Check whether it is strictly increasing.
3. Track the longest that passes.

### Complexity
- Time: **O(n · 2ⁿ)**.
- Space: O(n).

### Drawbacks
- At `n = 30` that is a billion subsequences. The constraints go to 2,500.
- And it re-derives the same facts endlessly. The best increasing run ending at position 5 is a fixed number, but the brute force recomputes it inside every subsequence that happens to pass through position 5.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **For each position, work out the longest increasing run that *ends there* — then the answer is the largest of those.**

Anchoring on "ends at `i`" is what makes the subproblems finite and reusable. There are only `n` of them.

### The four DP questions

**1. What does `dp[i]` mean?**

```text
dp[i] = the length of the longest strictly increasing subsequence
        that ENDS at index i (and therefore includes nums[i])
```

The "ends at `i`" part is essential. Defining it as "the LIS within the first `i` elements" sounds similar but does not compose — you would not know whether `nums[i]` could be appended to it.

**2. How do we compute `dp[i]`?**

Look at every earlier index `j`. If `nums[j] < nums[i]`, then any run ending at `j` can be extended by `nums[i]`:

```text
dp[i] = 1 + max( dp[j] )  over all j < i with nums[j] < nums[i]
      = 1                 if no such j exists
```

**3. What is the base case?**

```text
dp[i] = 1 for every i    — the single element nums[i] is itself a run of length 1
```

**4. Why iterate forward?**

`dp[i]` reads only `dp[j]` for `j < i`, so sweeping left to right guarantees every dependency is final.

**The answer is `max(dp)`, not `dp[n−1]`.** The longest run need not end at the last element — a classic slip.

That gives **O(n²)**, which is often enough and is always the right first answer.

### The O(n log n) version: patience sorting

Keep an array `tails`, where:

```text
tails[k] = the smallest possible tail value among all increasing
           subsequences of length k+1
```

`tails` is automatically sorted — a longer run must end at a larger value — so it can be binary searched.

For each `x`, find the first tail `>= x` (a **lower bound**):

- **past the end** → `x` exceeds every tail, so it extends the longest run. Append it.
- **inside** → replace that tail with `x`. Same length, smaller tail, which can only make future extensions easier.

The answer is `len(tails)`.

> **`tails` is not itself a valid subsequence.** Only its *length* is the answer. Claiming otherwise is a common interview slip — the array is a bookkeeping device, not a witness.

**Why lower bound and not upper bound?** Lower bound finds the first tail `>= x`, so an *equal* tail is replaced rather than appended — which enforces **strictly** increasing. Switching to upper bound solves the non-decreasing variant instead.

### Which version to write

| | O(n²) DP | O(n log n) patience |
|---|---|---|
| Length only | works | **faster** |
| Reconstruct the actual subsequence | **natural** (follow the `dp` values back) | needs extra parent tracking |
| **Count** how many LIS exist | **necessary** | does not extend cleanly |
| Explain under pressure | easy | needs the `tails` invariant stated precisely |

Lead with the O(n²) definition, then offer the O(n log n) refinement. If the question asks for a *count* of optimal solutions, you need the O(n²) form anyway.

### The reduction that keeps appearing

Many problems are LIS wearing a disguise:

```text
Russian Doll Envelopes  →  sort by width, LIS on heights
Max chain of pairs      →  sort by first, LIS on second
Longest Bitonic         →  LIS forward + LIS backward, combined
Minimum deletions to
  make it increasing    →  n - LIS(n)
```

The tell is *"pick a subset that stays ordered by two criteria at once"* — sort by one, LIS the other.

### The thought process

```text
We need    : the longest increasing subsequence.
Obvious way: enumerate all 2^n subsequences and test each.
Too slow   : O(n x 2^n), and it re-derives the same facts endlessly.
Notice     : the best run ENDING at a given index is a fixed number,
             and there are only n such numbers.
Therefore  : compute dp[i] = best run ending at i, left to right.
Now        : O(n^2) — and a patience-sorting refinement gives O(n log n).
```

### Steps

```text
Step 1 → dp[i] = 1 for every i (a lone element is a run of length 1).
Step 2 → For i = 1 .. n-1:
Step 3 →     For each j < i with nums[j] < nums[i]:
Step 4 →         dp[i] = max(dp[i], dp[j] + 1)
Step 5 → Return max(dp) — NOT dp[n-1].

O(n log n) refinement:
Step 6 → keep `tails`, where tails[k] is the smallest tail of a run of
          length k+1; binary search each value with a LOWER bound and
          either append it or replace the tail it lands on.
```

### How should I recognize this?

```text
If you see...
  "longest increasing subsequence", "longest chain"
  "maximum number of items that can be nested / stacked"
  "minimum deletions to make it sorted"
  order must be preserved, elements need not be adjacent
        ↓
Think about...
  "What is the best run ENDING at each position?"
        ↓
Use...
  length only        → patience sorting, O(n log n)
  count of LIS, or
  reconstruction     → O(n²) DP with dp[i] = LIS ending at i
  two criteria       → sort by one, LIS on the other
```

### Visual explanation

```svg
<svg viewBox="0 0 620 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="al-78" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">LIS: dp[i] = 1 + max(dp[j]) for j &lt; i with a[j] &lt; a[i]</text>
  <text x="70" y="80" text-anchor="middle" fill="#64748b">a[i]</text>
  <text x="70" y="134" text-anchor="middle" fill="#64748b">dp[i]</text>
  <rect x="120" y="56" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="147" y="81" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="190" y="56" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="217" y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="260" y="56" width="54" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="287" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="330" y="56" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="357" y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="400" y="56" width="54" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="427" y="81" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="120" y="110" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="147" y="135" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="190" y="110" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="217" y="135" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="260" y="110" width="54" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="287" y="135" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="330" y="110" width="54" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="357" y="135" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="400" y="110" width="54" height="40" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="427" y="135" text-anchor="middle" fill="#1e293b" font-weight="700">3</text>
  <path d="M287,152 Q357,190 427,152" fill="none" stroke="#475569" marker-end="url(#al-78)"/>
  <text x="357" y="184" text-anchor="middle" fill="#64748b">a[2]=4 &lt; a[4]=5, so dp[4] = dp[2] + 1</text>
  <text x="310" y="210" text-anchor="middle" fill="#059669" font-weight="700">LIS length = max dp = 3  (subsequence 3, 4, 5)</text>
</svg>
```

```text
nums = [10, 9, 2, 5, 3, 7, 101, 18]

index :   0   1   2   3   4   5    6    7
value :  10   9   2   5   3   7  101   18
dp    :   1   1   1   2   2   3    4    4
                      ↑       ↑    ↑
              dp[3]=2 (2,5)   |    dp[6] = dp[5]+1 = 4
                        dp[5]=3 (2,3,7)

answer = max(dp) = 4        e.g. 2 → 3 → 7 → 101
NOT dp[last] — the best run does not have to end at the last element
```

### Interview explanation
"I'll define `dp[i]` as the length of the longest strictly increasing subsequence that *ends at* index `i`. Anchoring on 'ends at i' is what makes the subproblems compose — I can then ask whether `nums[i]` extends any earlier run. So `dp[i] = 1 + max(dp[j])` over all `j < i` with `nums[j] < nums[i]`, and 1 if there is none. Every `dp[i]` starts at 1 because a single element is a run. The answer is the max over the whole array, not the last entry, since the best run need not end at the last element. That's O(n²). There's an O(n log n) refinement using patience sorting: keep an array where `tails[k]` is the smallest tail among runs of length `k+1`, which stays sorted, and binary search each new value with a lower bound so equal values are replaced rather than appended — that's what keeps it strictly increasing. I'd note `tails` isn't itself a valid subsequence, only its length is the answer. If the problem asked me to *count* the optimal subsequences, I'd stay with the O(n²) form, since the counting doesn't extend cleanly to patience sorting."

---

## 5. Generic Templates

> `dp[i]` = best run ending at `i`. Answer is the max, not the last entry.

```go
// LISLength returns the length of the longest strictly increasing
// subsequence, using the O(n^2) DP.
// dp[i] = length of the LIS ENDING at index i.
func LISLength(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    dp := make([]int, len(nums))
    for i := range dp {
        dp[i] = 1 // a single element is a run of length 1
    }

    best := 1
    for i := 1; i < len(nums); i++ {
        for j := 0; j < i; j++ {
            // nums[i] can extend any run ending at a smaller value.
            if nums[j] < nums[i] && dp[j]+1 > dp[i] {
                dp[i] = dp[j] + 1
            }
        }
        if dp[i] > best {
            best = dp[i] // the answer is the MAX, not dp[n-1]
        }
    }
    return best
}

// LISLengthFast is the O(n log n) patience-sorting version.
// tails[k] = the smallest tail among increasing runs of length k+1.
// NOTE: tails is NOT itself a valid subsequence — only its length is.
func LISLengthFast(nums []int) int {
    tails := []int{}

    for _, x := range nums {
        // Lower bound: first tail >= x. Using >= (not >) replaces an equal
        // tail, which is what enforces STRICT increase.
        position := lowerBound(tails, x)

        if position == len(tails) {
            tails = append(tails, x) // x beats every tail: extend
        } else {
            tails[position] = x // same length, smaller tail is strictly better
        }
    }
    return len(tails)
}

func lowerBound(sorted []int, target int) int {
    lo, hi := 0, len(sorted)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if sorted[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}

// LISSequence reconstructs one actual longest subsequence, which the
// patience version cannot do without extra bookkeeping.
func LISSequence(nums []int) []int {
    if len(nums) == 0 {
        return nil
    }

    dp := make([]int, len(nums))
    parent := make([]int, len(nums))
    for i := range dp {
        dp[i] = 1
        parent[i] = -1 // no predecessor
    }

    bestIndex := 0
    for i := 1; i < len(nums); i++ {
        for j := 0; j < i; j++ {
            if nums[j] < nums[i] && dp[j]+1 > dp[i] {
                dp[i] = dp[j] + 1
                parent[i] = j
            }
        }
        if dp[i] > dp[bestIndex] {
            bestIndex = i
        }
    }

    // Walk the parent chain backwards, then reverse.
    sequence := []int{}
    for at := bestIndex; at != -1; at = parent[at] {
        sequence = append(sequence, nums[at])
    }
    for l, r := 0, len(sequence)-1; l < r; l, r = l+1, r-1 {
        sequence[l], sequence[r] = sequence[r], sequence[l]
    }
    return sequence
}
```

```python
from bisect import bisect_left

def lis_length(nums):
    """O(n^2). dp[i] = length of the LIS ENDING at index i."""
    if not nums:
        return 0

    dp = [1] * len(nums)                # a single element is a run of 1
    for i in range(1, len(nums)):
        for j in range(i):
            if nums[j] < nums[i]:
                dp[i] = max(dp[i], dp[j] + 1)

    return max(dp)                      # the MAX, not dp[-1]

def lis_length_fast(nums):
    """O(n log n) patience sorting.
    tails[k] = smallest tail among runs of length k+1.
    tails is NOT a valid subsequence — only its length is the answer."""
    tails = []
    for x in nums:
        # bisect_left is a lower bound: an equal tail is REPLACED,
        # which enforces strict increase.
        position = bisect_left(tails, x)
        if position == len(tails):
            tails.append(x)             # x extends the longest run
        else:
            tails[position] = x         # smaller tail, same length
    return len(tails)

def lis_sequence(nums):
    """Reconstruct one actual longest subsequence."""
    if not nums:
        return []

    dp = [1] * len(nums)
    parent = [-1] * len(nums)
    best_index = 0

    for i in range(1, len(nums)):
        for j in range(i):
            if nums[j] < nums[i] and dp[j] + 1 > dp[i]:
                dp[i] = dp[j] + 1
                parent[i] = j
        if dp[i] > dp[best_index]:
            best_index = i

    sequence = []
    at = best_index
    while at != -1:
        sequence.append(nums[at])
        at = parent[at]
    return sequence[::-1]
```

```java
import java.util.*;

public class LIS {
    // O(n^2). dp[i] = length of the LIS ending at index i.
    public static int lisLength(int[] nums) {
        if (nums.length == 0) return 0;
        int[] dp = new int[nums.length];
        Arrays.fill(dp, 1);

        int best = 1;
        for (int i = 1; i < nums.length; i++) {
            for (int j = 0; j < i; j++)
                if (nums[j] < nums[i]) dp[i] = Math.max(dp[i], dp[j] + 1);
            best = Math.max(best, dp[i]);      // the MAX, not dp[n-1]
        }
        return best;
    }

    // O(n log n). tails[k] = smallest tail among runs of length k+1.
    public static int lisLengthFast(int[] nums) {
        List<Integer> tails = new ArrayList<>();
        for (int x : nums) {
            int position = lowerBound(tails, x);   // >= keeps it STRICT
            if (position == tails.size()) tails.add(x);
            else tails.set(position, x);
        }
        return tails.size();
    }

    private static int lowerBound(List<Integer> sorted, int target) {
        int lo = 0, hi = sorted.size();
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (sorted.get(mid) < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

// O(n^2). dp[i] = length of the LIS ending at index i.
int lisLength(const vector<int>& nums) {
    if (nums.empty()) return 0;
    vector<int> dp(nums.size(), 1);

    int best = 1;
    for (size_t i = 1; i < nums.size(); ++i) {
        for (size_t j = 0; j < i; ++j)
            if (nums[j] < nums[i]) dp[i] = max(dp[i], dp[j] + 1);
        best = max(best, dp[i]);               // the MAX, not dp.back()
    }
    return best;
}

// O(n log n). lower_bound replaces an equal tail → STRICT increase.
int lisLengthFast(const vector<int>& nums) {
    vector<int> tails;
    for (int x : nums) {
        auto it = lower_bound(tails.begin(), tails.end(), x);
        if (it == tails.end()) tails.push_back(x);
        else *it = x;
    }
    return (int)tails.size();
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Longest Increasing Subsequence (Optimal) |
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

### Problem — Longest Increasing Subsequence (LeetCode 300)
Return the length of the longest **strictly increasing** subsequence.

### Thought Process

**What does `dp[i]` mean?** The length of the longest strictly increasing subsequence that **ends at** index `i`.

**How do we compute it?** For each earlier `j` with `nums[j] < nums[i]`, the run ending at `j` can be extended by `nums[i]`. Take the best such `j`, or 1 if none exists.

**What is the base case?** `dp[i] = 1` for every `i` — a lone element is a run of length 1.

**Why iterate forward?** `dp[i]` reads only `dp[j]` for `j < i`, so a left-to-right sweep has every dependency ready.

**And the answer is `max(dp)`**, not `dp[n−1]` — the best run need not end at the last element.

### Dry Run

Input: `nums = [10, 9, 2, 5, 3, 7, 101, 18]`

| i | nums[i] | earlier `j` with `nums[j] < nums[i]` | best `dp[j]` | `dp[i]` |
|---|---------|--------------------------------------|--------------|---------|
| 0 | 10 | none | — | **1** |
| 1 | 9 | none (10 is not < 9) | — | **1** |
| 2 | 2 | none | — | **1** |
| 3 | 5 | j=2 (`2`) | 1 | **2** |
| 4 | 3 | j=2 (`2`) | 1 | **2** |
| 5 | 7 | j=2 (`2`), j=3 (`5`), j=4 (`3`) | 2 (from j=3 or j=4) | **3** |
| 6 | 101 | j=0..5 all smaller | 3 (from j=5) | **4** |
| 7 | 18 | j=0..5 all smaller | 3 (from j=5) | **4** |

`dp = [1, 1, 1, 2, 2, 3, 4, 4]` → answer **`max(dp) = 4`** ✓

One witness: `2 → 3 → 7 → 101` (indices 2, 4, 5, 6). ✓

**Note `dp[7] = 4` as well**, via `2 → 3 → 7 → 18`. Two different runs achieve the maximum — which is exactly what Example 3 will count.

### The O(n log n) version on the same input

| x | `tails` before | lower bound position | action | `tails` after |
|---|----------------|----------------------|--------|---------------|
| 10 | `[]` | 0 (past end) | append | `[10]` |
| 9 | `[10]` | 0 | replace | `[9]` |
| 2 | `[9]` | 0 | replace | `[2]` |
| 5 | `[2]` | 1 (past end) | append | `[2, 5]` |
| 3 | `[2,5]` | 1 | replace | `[2, 3]` |
| 7 | `[2,3]` | 2 (past end) | append | `[2, 3, 7]` |
| 101 | `[2,3,7]` | 3 (past end) | append | `[2, 3, 7, 101]` |
| 18 | `[2,3,7,101]` | 3 | replace | `[2, 3, 7, 18]` |

`len(tails) = 4` ✓ — the same answer.

Note the final `tails = [2, 3, 7, 18]` *is* a valid subsequence here, but that is a coincidence. Feed it `[3, 4, 1, 2]` and `tails` ends as `[1, 2]` while a valid LIS is `[3, 4]` — same length, different elements. **Only the length is meaningful.**

### Visualization

```text
index :   0   1   2   3   4   5    6    7
value :  10   9   2   5   3   7  101   18
dp    :   1   1   1   2   2   3    4    4
                  └───┴───┴────┘
                  2 → 3 → 7 → 101      length 4  ★

answer = max(dp) = 4, achieved at BOTH index 6 and index 7
```

### Code

```go
func lengthOfLIS(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    // dp[i] = length of the longest increasing subsequence ENDING at i.
    dp := make([]int, len(nums))
    for i := range dp {
        dp[i] = 1 // a lone element is a run of length 1
    }

    best := 1
    for i := 1; i < len(nums); i++ {
        for j := 0; j < i; j++ {
            // nums[i] extends any run that ends at a smaller value.
            if nums[j] < nums[i] && dp[j]+1 > dp[i] {
                dp[i] = dp[j] + 1
            }
        }
        if dp[i] > best {
            best = dp[i] // the answer is the MAX, not dp[n-1]
        }
    }
    return best
}

// lengthOfLISFast is the O(n log n) patience-sorting refinement.
func lengthOfLISFast(nums []int) int {
    // tails[k] = the smallest tail among increasing runs of length k+1.
    // It is NOT a valid subsequence; only its length is the answer.
    tails := []int{}

    for _, x := range nums {
        // sort.SearchInts is a lower bound: the first tail >= x. Using >=
        // (not >) replaces an equal tail, enforcing STRICT increase.
        position := sort.SearchInts(tails, x)

        if position == len(tails) {
            tails = append(tails, x) // x beats every tail: extend
        } else {
            tails[position] = x // same length, smaller tail is better
        }
    }
    return len(tails)
}
```

```python
from bisect import bisect_left

def lengthOfLIS(nums):
    """O(n^2). dp[i] = LIS length ENDING at index i."""
    if not nums:
        return 0

    dp = [1] * len(nums)                # a lone element is a run of 1
    for i in range(1, len(nums)):
        for j in range(i):
            if nums[j] < nums[i]:
                dp[i] = max(dp[i], dp[j] + 1)

    return max(dp)                      # the MAX, not dp[-1]

def lengthOfLIS_fast(nums):
    """O(n log n). tails[k] = smallest tail among runs of length k+1."""
    tails = []
    for x in nums:
        position = bisect_left(tails, x)    # lower bound → STRICT increase
        if position == len(tails):
            tails.append(x)
        else:
            tails[position] = x
    return len(tails)
```

### Complexity
O(n²) time and O(n) space for the DP; **O(n log n)** time and O(n) space for the patience version.

---

## 10. Solved Example 2

### Problem — Russian Doll Envelopes (LeetCode 354)
Envelope `(w, h)` fits inside `(W, H)` only if `w < W` **and** `h < H`. Return the largest number that can be nested.

### Thought Process
1. This is LIS in two dimensions. Sorting by width reduces it to one dimension — then it is an LIS on the heights.
2. But there is a trap. If two envelopes share a width, sorting their heights **ascending** would let the LIS chain them — and they cannot nest, because nesting requires `w < W` strictly.
3. **Fix: sort by width ascending, and by height *descending* when widths tie.** Equal-width envelopes then appear in decreasing height order, so a strictly increasing run can never take two of them.
4. Run the O(n log n) LIS from Example 1 on the heights.
5. Sorting is O(n log n) and the LIS is O(n log n), so the total is O(n log n).

### Dry Run

Input: `envelopes = [[5,4], [6,4], [6,7], [2,3]]`

**Step 1 — sort** (width ascending; height *descending* on ties):

```text
[2,3]   [5,4]   [6,7]   [6,4]
                 └───────┘
        width 6 appears twice → heights ordered 7 then 4
```

**Step 2 — LIS on the heights `[3, 4, 7, 4]`:**

| h | `tails` before | lower bound | action | `tails` after |
|---|----------------|-------------|--------|---------------|
| 3 | `[]` | 0 (past end) | append | `[3]` |
| 4 | `[3]` | 1 (past end) | append | `[3, 4]` |
| 7 | `[3,4]` | 2 (past end) | append | `[3, 4, 7]` |
| 4 | `[3,4,7]` | 1 | replace | `[3, 4, 7]` |

`len(tails) = 3`

Output: **3** ✓ — the chain `[2,3] → [5,4] → [6,7]`.

**The tiebreak, demonstrated.** The two width-6 envelopes give heights `7` then `4`. Since `4 < 7`, the later one cannot extend a run containing the earlier one. Had we sorted heights ascending (`4` then `7`), the height sequence would be `[3, 4, 4, 7]` and the LIS would find `3 → 4 → 7` using **both** width-6 envelopes — claiming `[6,4]` nests inside `[6,7]`, which is false since their widths are equal.

### Visualization

```text
sorted:   [2,3]   [5,4]   [6,7]   [6,4]
heights:    3       4       7       4
            └───────┴───────┘
            strictly increasing 3 → 4 → 7   →  answer 3

same width ⇒ heights DESCENDING (7 then 4)
          ⇒ a strict LIS can never take both     ✓
```

### Code

```go
func maxEnvelopes(envelopes [][]int) int {
    // Width ascending; on ties, height DESCENDING so two equal-width
    // envelopes can never both appear in a strictly increasing run.
    sort.Slice(envelopes, func(i, j int) bool {
        if envelopes[i][0] == envelopes[j][0] {
            return envelopes[i][1] > envelopes[j][1]
        }
        return envelopes[i][0] < envelopes[j][0]
    })

    // Now it is just an LIS over the heights.
    tails := []int{}
    for _, envelope := range envelopes {
        height := envelope[1]
        position := sort.SearchInts(tails, height) // lower bound
        if position == len(tails) {
            tails = append(tails, height)
        } else {
            tails[position] = height
        }
    }
    return len(tails)
}
```

```python
from bisect import bisect_left

def maxEnvelopes(envelopes):
    # Width ascending; on ties, height DESCENDING.
    envelopes.sort(key=lambda e: (e[0], -e[1]))

    tails = []                          # LIS over the heights
    for _, height in envelopes:
        position = bisect_left(tails, height)
        if position == len(tails):
            tails.append(height)
        else:
            tails[position] = height
    return len(tails)
```

### Complexity
Time **O(n log n)** — the sort and the LIS are both O(n log n). Space O(n).

---

## 11. Solved Example 3

### Problem — Number of Longest Increasing Subsequences (LeetCode 673)
Return **how many** longest increasing subsequences the array has.

### Thought Process
1. This is where the O(n log n) patience version stops helping — `tails` tracks lengths, not multiplicities. We need the O(n²) DP.
2. Keep two arrays: `length[i]` (the LIS ending at `i`, as before) and `count[i]` (how many such subsequences there are).
3. Scanning `j < i` with `nums[j] < nums[i]`, two cases:
   - `length[j] + 1 > length[i]` → a **strictly better** run found. Overwrite: `length[i] = length[j]+1`, `count[i] = count[j]`.
   - `length[j] + 1 == length[i]` → **another way** to achieve the same length. Accumulate: `count[i] += count[j]`.
4. Base: `length[i] = 1`, `count[i] = 1`.
5. The answer is the sum of `count[i]` over every `i` where `length[i]` equals the overall maximum.

The overwrite-versus-accumulate distinction is the whole problem. Using `+=` in the first case would double-count runs that were already superseded.

### Dry Run

Input: `nums = [1, 3, 5, 4, 7]`

| i | nums[i] | j scanned | comparison | `length[i]` | `count[i]` |
|---|---------|-----------|------------|-------------|------------|
| 0 | 1 | — | — | **1** | **1** |
| 1 | 3 | j=0 (`1<3`) | `1+1 = 2 > 1` → overwrite | **2** | **1** (= count[0]) |
| 2 | 5 | j=0 (`1<5`) | `1+1 = 2 > 1` → overwrite | 2 | 1 |
|   |   | j=1 (`3<5`) | `2+1 = 3 > 2` → overwrite | **3** | **1** (= count[1]) |
| 3 | 4 | j=0 (`1<4`) | `2 > 1` → overwrite | 2 | 1 |
|   |   | j=1 (`3<4`) | `3 > 2` → overwrite | **3** | **1** (= count[1]) |
|   |   | j=2 (`5<4`? no) | skipped | 3 | 1 |
| 4 | 7 | j=0 (`1<7`) | `2 > 1` → overwrite | 2 | 1 |
|   |   | j=1 (`3<7`) | `3 > 2` → overwrite | 3 | 1 |
|   |   | j=2 (`5<7`) | `3+1 = 4 > 3` → overwrite | **4** | **1** (= count[2]) |
|   |   | j=3 (`4<7`) | `3+1 = 4 == 4` → **accumulate** | 4 | **2** (`1 + count[3]`) |

Final: `length = [1, 2, 3, 3, 4]`, `count = [1, 1, 1, 1, 2]`

Maximum length is **4**, achieved only at index 4, whose count is **2**.

Output: **2** ✓ — the two subsequences are `1 → 3 → 5 → 7` and `1 → 3 → 4 → 7`. ✓

The decisive row is the last one: `j = 2` found a strictly longer run and *overwrote*, then `j = 3` found an equally long one and *accumulated*. Getting either branch wrong changes the answer.

**An edge case worth checking:** `nums = [2, 2, 2, 2, 2]`. No `j` has `nums[j] < nums[i]`, so every `length[i] = 1` and `count[i] = 1`. The maximum length is 1, achieved at all five indices, so the answer is **5** ✓ — five subsequences, each a single element.

### Visualization

```text
nums   :  1   3   5   4   7
length :  1   2   3   3   4
count  :  1   1   1   1   2
                  └───┴────┘
        both length-3 runs (…5 and …4) extend into 7,
        so count[4] = count[2] + count[3] = 1 + 1 = 2

  1 → 3 → 5 → 7
  1 → 3 → 4 → 7        two LIS of length 4
```

### Code

```go
func findNumberOfLIS(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    // length[i] = LIS length ending at i;  count[i] = how many such.
    length := make([]int, len(nums))
    count := make([]int, len(nums))
    for i := range nums {
        length[i] = 1
        count[i] = 1
    }

    longest := 1
    for i := 1; i < len(nums); i++ {
        for j := 0; j < i; j++ {
            if nums[j] >= nums[i] {
                continue
            }

            switch {
            case length[j]+1 > length[i]:
                // A strictly better run: replace, and inherit its count.
                length[i] = length[j] + 1
                count[i] = count[j]
            case length[j]+1 == length[i]:
                // Another way to reach the same length: accumulate.
                count[i] += count[j]
            }
        }
        if length[i] > longest {
            longest = length[i]
        }
    }

    // Sum the counts of every index achieving the maximum length.
    total := 0
    for i := range nums {
        if length[i] == longest {
            total += count[i]
        }
    }
    return total
}
```

```python
def findNumberOfLIS(nums):
    if not nums:
        return 0

    length = [1] * len(nums)            # LIS length ending at i
    count = [1] * len(nums)             # how many such subsequences

    for i in range(1, len(nums)):
        for j in range(i):
            if nums[j] >= nums[i]:
                continue
            if length[j] + 1 > length[i]:
                # A strictly better run: replace and inherit its count.
                length[i] = length[j] + 1
                count[i] = count[j]
            elif length[j] + 1 == length[i]:
                # Another way to the same length: accumulate.
                count[i] += count[j]

    longest = max(length)
    return sum(c for l, c in zip(length, count) if l == longest)
```

### Complexity
Time **O(n²)** — every pair `(j, i)` is examined once. Space O(n) for the two arrays.

> This is the case that justifies keeping the O(n²) formulation in your toolkit. Patience sorting is faster for the length alone, but it collapses the information the count needs — a good reminder that the "better" algorithm is only better for the question it was designed for.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 300 | LIS | Easy | Core dynamic programming application |
| 354 | Russian Dolls | Easy | Core dynamic programming application |
| 673 | Number of LIS | Medium | Core dynamic programming application |
| 1626 | Best Team | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Longest Increasing Subsequence logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Longest Increasing Subsequence (Dynamic Programming).
- **Signal:** lis, longest increasing, dp, patience, binary search.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Longest Increasing Subsequence invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Longest Increasing Subsequence
FAMILY : Dynamic Programming (Advanced)
WHEN   : lis, longest increasing, dp, patience, binary search
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 300, 354, 673, 1626
```

---

*Part of the DSA Patterns Handbook — pattern 78 of 100.*
