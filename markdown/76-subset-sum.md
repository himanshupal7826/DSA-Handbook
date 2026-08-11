# 76 · Subset Sum

> **One-liner:** Boolean DP: can a subset reach exactly the target sum?

---

## 1. Overview

### Definition
The **Subset Sum** pattern belongs to the *Dynamic Programming* family. Boolean DP: can a subset reach exactly the target sum?

### Intuition
Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.

### Why it works
Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.

---

## 2. Recognition Signals

### Keywords
subset sum, partition, dp, boolean, target.

### Constraints
- Input size where the brute-force complexity would time out — the Subset Sum optimization is the intended solution.
- Structural hints in the statement that match this family (Dynamic Programming).

### Hidden clues
- The problem can be reframed so the Subset Sum invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Subset Sum is the upgrade.
- The wording maps onto: subset sum, partition, dp, boolean, target.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Is there a subset of these numbers that adds up to exactly this target?"*

Running example: `nums = [2, 3, 4]`, `target = 6`.

### Intuition
Each number is either in the chosen subset or not. That is `2^n` subsets — small enough to list by hand here — so add each one up and look for the target.

### Algorithm
1. Recurse over the numbers. At index `i` branch twice: **include** `nums[i]` or **exclude** it.
2. Carry the running sum down each branch.
3. When the numbers run out, report `runningSum == target`.
4. Return true if any branch reported true.

### Complexity
- Time: **O(2^n)** — one branch per include/exclude decision.
- Space: O(n) recursion depth.

### Drawbacks
- **The exact wasted work:** all eight subsets of `[2, 3, 4]`:

  ```text
  {}      0        {2,3}   5
  {2}     2        {2,4}   6   ← hit
  {3}     3        {3,4}   7
  {4}     4        {2,3,4} 9
  ```

  Now add a duplicate and use `nums = [2, 3, 4, 3]`. The partial choices `{2, 3ᵃ}` and `{2, 3ᵇ}` both stand at running sum 5 with the multiset `{3, 4}` still undecided. That is **the same question asked twice**, and the recursion answers it twice.
- **The fact it fails to exploit:** a partial selection is fully summarised by its *running sum*. There are at most `target + 1` distinct running sums but `2^n` subsets — so once `n` passes about 12 the branches must be colliding constantly.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Stop tracking *which* numbers you picked and track only *which sums are reachable* — that turns `2^n` subsets into a single boolean row of length `target + 1`.**

Picture a row of light bulbs labelled `0, 1, 2, …, target`. Bulb 0 starts lit (the empty subset sums to 0). Feeding in a number `num` lights every bulb that sits `num` steps to the right of an already-lit bulb. After every number has been fed in, the answer is simply "is bulb `target` lit?".

### The thought process

```text
We need    : does SOME subset add up to exactly the target?
Obvious way: enumerate all 2^n subsets.
Too slow   : 2^n explodes past n ~ 25.
Notice     : two subsets with the same sum are interchangeable forever after.
Notice too : sums live in 0..target — a tiny, bounded set of states.
Therefore  : keep one boolean per sum, not one entry per subset.
Now        : n passes over target+1 booleans -> O(n * target).
```

### The recurrence, in words

```text
dp[s] means : "some subset of the numbers processed so far adds up to exactly s".
              It is a yes/no fact about the SUM, not about any particular subset.

dp[s] = dp[s]              ← s was already reachable without touching num
      OR dp[s - num]       ← s-num was reachable, so dropping num on top of that
                             subset reaches s. Note s-num must be >= 0.

base case  : dp[0] = true. The empty subset always exists and sums to 0. Every
             other cell starts false — with no numbers used, nothing else is
             reachable. Seeding dp[0] = false would leave the whole row dead.

answer     : dp[target].
```

Note how this is 0/1 knapsack with the arithmetic stripped out: `max` becomes `OR`, the "value" becomes a bare truth bit, and the weight axis becomes the sum axis. Everything else — including the loop direction — is identical.

### Why the sum loop must run downward

The 2-D table `dp[i][s]` would read only row `i-1`. Collapsing to one row makes `dp[s]` ambiguous: it means "before `num`" for cells this pass has not reached, and "after `num`" for cells it has. The recurrence needs the **before** meaning.

**Demonstrate it.** One number: `nums = [3]`, `target = 6`. Only `{}` and `{3}` exist, so 6 must be unreachable.

*Upward* (`s = 3, 4, 5, 6`):

```text
start        dp = [T, F, F, F, F, F, F]      (indices 0..6)
s=3   dp[3] |= dp[0] = T   → dp = [T,F,F,T,F,F,F]
s=4   dp[4] |= dp[1] = F   → unchanged
s=5   dp[5] |= dp[2] = F   → unchanged
s=6   dp[6] |= dp[3] = T   → dp = [T,F,F,T,F,F,T]
                    ^^^^^
        dp[3] was lit by THIS number a moment ago. Reading it here
        means "3 + 3", i.e. using the single 3 twice.  WRONG.
```

*Downward* (`s = 6, 5, 4, 3`):

```text
start        dp = [T, F, F, F, F, F, F]
s=6   dp[6] |= dp[3] = F   → unchanged   (dp[3] still says "before the 3")
s=5   dp[5] |= dp[2] = F   → unchanged
s=4   dp[4] |= dp[1] = F   → unchanged
s=3   dp[3] |= dp[0] = T   → dp = [T,F,F,T,F,F,F]

dp[6] = false.  CORRECT — {3} cannot make 6.
```

Downward, every cell you read has a **smaller** index than the cell you write, and smaller indices are exactly the ones this pass has not rewritten yet. (Flip the loop upward on purpose and you get unbounded subset sum: "can the target be made with unlimited copies?" — a different, also useful, problem.)

### Steps

```text
Step 1 → dp = [true, false, false, …] of length target+1
Step 2 → for each num in nums:
Step 3 →     for s = target down to num:      (DOWNWARD — each num once)
Step 4 →         if dp[s-num] { dp[s] = true }
Step 5 → answer = dp[target]
```

### How should I recognize this?

```text
If you see...
  "split into two equal halves", "can a subset sum to X",
  "closest to half the total", "assign + and - signs",
  numbers positive and the SUM bounded (≤ ~10^4-10^5)
        ↓
Think about...
  "Is the question really about reachable totals rather than about
   which items were chosen?"
        ↓
Use...
  boolean dp over sums, one pass per number, sum loop DOWNWARD
    ├─ exact target?      → dp[target]
    ├─ closest to half?   → largest s ≤ total/2 with dp[s]
    ├─ how many subsets?  → swap bool for int, OR for +=
    └─ which numbers?     → keep a 2-D table (or parent pointers) and walk back
```

### Visual explanation

```svg
<svg viewBox="0 0 640 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="as-76" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">Subset Sum (boolean): dp[s] = dp[s] OR dp[s-num]  · nums {2,3,4}, target 6</text>
  <text x="120" y="52" text-anchor="middle" fill="#64748b">s=0</text>
  <text x="186" y="52" text-anchor="middle" fill="#64748b">1</text>
  <text x="252" y="52" text-anchor="middle" fill="#64748b">2</text>
  <text x="318" y="52" text-anchor="middle" fill="#64748b">3</text>
  <text x="384" y="52" text-anchor="middle" fill="#64748b">4</text>
  <text x="450" y="52" text-anchor="middle" fill="#64748b">5</text>
  <text x="516" y="52" text-anchor="middle" fill="#64748b">6</text>
  <rect x="90"  y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="156" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="186" y="85" text-anchor="middle" fill="#64748b">F</text>
  <rect x="222" y="60" width="60" height="40" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="252" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="288" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="318" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="354" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="384" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="420" y="60" width="60" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="450" y="85" text-anchor="middle" fill="#1e293b">T</text>
  <rect x="486" y="60" width="60" height="40" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="516" y="85" text-anchor="middle" fill="#1e293b" font-weight="700">T</text>
  <path d="M252,58 Q384,24 516,58" fill="none" stroke="#475569" marker-end="url(#as-76)"/>
  <text x="384" y="28" text-anchor="middle" fill="#64748b">add num=4: dp[6] |= dp[6-4] = dp[2]</text>
  <text x="320" y="130" text-anchor="middle" fill="#059669" font-weight="700">dp[6] = true  answer · subset {2,4} sums to 6</text>
  <text x="320" y="152" text-anchor="middle" fill="#64748b">loop s downward so each number is used at most once</text>
</svg>
```

```text
nums = [2, 3, 4]   target = 6

sum index      0  1  2  3  4  5  6
start          T  .  .  .  .  .  .

num = 2   (s = 6 → 2, downward)
  s=6: dp[4]=F   s=5: dp[3]=F   s=4: dp[2]=F   s=3: dp[1]=F   s=2: dp[0]=T ✔
               T  .  T  .  .  .  .

num = 3   (s = 6 → 3, downward)
  s=6: dp[3]=F   s=5: dp[2]=T ✔   s=4: dp[1]=F   s=3: dp[0]=T ✔
               T  .  T  T  .  T  .

num = 4   (s = 6 → 4, downward)
  s=6: dp[2]=T ✔   s=5: dp[1]=F   s=4: dp[0]=T ✔
               T  .  T  T  T  T  T
                                 ^
                        dp[6] = true → subset {2,4}
```

### Interview explanation
"Two subsets that happen to share a sum behave identically from then on, so instead of tracking subsets I track reachable sums: `dp[s]` is a boolean meaning some subset adds up to exactly `s`. I seed `dp[0] = true` for the empty subset and, for each number, set `dp[s] |= dp[s-num]`. The sum loop runs **downward** so that `dp[s-num]` still describes the row before this number was offered — going upward would let one number be used twice, which silently solves the unbounded version instead. That's O(n × target) time and O(target) space, which is pseudo-polynomial: fine when the total is bounded, and the reason this problem is NP-complete in general."

---

## 5. Generic Templates

> Boolean row over sums, one pass per number, sum index **descending**.

```go
// SubsetSumTable returns reachable, where reachable[s] reports whether some
// subset of nums adds up to exactly s, for every s in 0..target.
// Returning the whole row (not just one bool) also answers "largest reachable
// sum not exceeding target", which several variants need.
func SubsetSumTable(nums []int, target int) []bool {
    reachable := make([]bool, target+1)
    reachable[0] = true // the empty subset sums to 0

    for _, num := range nums {
        // Descending: reachable[s-num] must still describe the state BEFORE
        // num was offered, so num is used at most once.
        for s := target; s >= num; s-- {
            if reachable[s-num] {
                reachable[s] = true
            }
        }
    }
    return reachable
}

// CanReachSum answers the plain yes/no question.
func CanReachSum(nums []int, target int) bool {
    return SubsetSumTable(nums, target)[target]
}
```

```python
def subset_sum_table(nums, target):
    """reachable[s] = some subset of nums adds up to exactly s, for s in 0..target."""
    reachable = [False] * (target + 1)
    reachable[0] = True                 # the empty subset sums to 0

    for num in nums:
        # descending: reachable[s - num] still describes the state before num
        for s in range(target, num - 1, -1):
            if reachable[s - num]:
                reachable[s] = True
    return reachable


def can_reach_sum(nums, target):
    return subset_sum_table(nums, target)[target]
```

```java
// reachable[s] = some subset of nums adds up to exactly s, for s in 0..target.
boolean[] subsetSumTable(int[] nums, int target) {
    boolean[] reachable = new boolean[target + 1];
    reachable[0] = true;                       // the empty subset sums to 0
    for (int num : nums) {
        // Descending keeps reachable[s - num] on the previous number's row.
        for (int s = target; s >= num; s--) {
            if (reachable[s - num]) reachable[s] = true;
        }
    }
    return reachable;
}

boolean canReachSum(int[] nums, int target) {
    return subsetSumTable(nums, target)[target];
}
```

```cpp
// reachable[s] = some subset of nums adds up to exactly s, for s in 0..target.
vector<char> subsetSumTable(const vector<int>& nums, int target) {
    vector<char> reachable(target + 1, 0);
    reachable[0] = 1;                          // the empty subset sums to 0
    for (int num : nums) {
        // Descending keeps reachable[s - num] on the previous number's row.
        for (int s = target; s >= num; --s) {
            if (reachable[s - num]) reachable[s] = 1;
        }
    }
    return reachable;
}

bool canReachSum(const vector<int>& nums, int target) {
    return subsetSumTable(nums, target)[target] != 0;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Subset Sum (Optimal) |
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

### Problem — Partition Equal (LeetCode 416)
Given an array of positive integers, decide whether it can be split into two groups whose sums are equal.

### Thought Process
1. Two equal groups each sum to `total / 2`, so an odd `total` is impossible before any work happens.
2. Choosing one group determines the other, so the question is exactly **"is `total/2` a reachable subset sum?"** — plain subset sum.
3. Boolean row over `0..total/2`, one pass per number, sum index descending.
4. Answer is the single cell `dp[total/2]`.

### The DP, spelled out

```text
What does dp[s] mean?
    dp[s] is true exactly when some subset of the numbers processed so far
    adds up to exactly s.

How is dp[s] computed?
    dp[s] = dp[s] OR dp[s - num]
      dp[s]        : s was already reachable without this num
      dp[s - num]  : s - num was reachable, so adding num lands on s

What is the base case?
    dp[0] = true — the empty subset sums to 0 and is always available.
    All other cells start false.

Why downward?
    dp[s-num] has to mean "reachable WITHOUT num". Sweeping s from target down
    to num, every cell read sits at a lower index than the cell written, and
    lower indices have not been rewritten yet in this pass.
```

### Dry Run

Input: `nums = [2, 3, 4, 3]` → `total = 12`, `target = 6`

| after num | writes performed (high → low) | reachable sums |
|---|---|---|
| *(start)* | seed `dp[0] = true` | `{0}` |
| `2` | `dp[2]` ← `dp[0]` ✔ | `{0,2}` |
| `3` | `dp[5]` ← `dp[2]` ✔, `dp[3]` ← `dp[0]` ✔ | `{0,2,3,5}` |
| `4` | `dp[6]` ← `dp[2]` ✔, `dp[4]` ← `dp[0]` ✔ | `{0,2,3,4,5,6}` |
| `3` | nothing new (`dp[6]`,`dp[5]`,`dp[3]` already true) | `{0,2,3,4,5,6}` |

Output: **`true`** — `{2, 4}` on one side, `{3, 3}` on the other.

The `3` row is the one that proves the direction matters. Sweeping down, `dp[5]` is written **before** `dp[3]`, so it reads a `dp[2]` that belongs to the previous number. Sweep upward and `dp[3]` would be lit first; then `dp[6]` would read that fresh `dp[3]` and declare 6 reachable as `3 + 3` — from a **single** 3.

### Visualization

```text
sum index    0  1  2  3  4  5  6
start        T  .  .  .  .  .  .
+2           T  .  T  .  .  .  .
+3           T  .  T  T  .  T  .
+4           T  .  T  T  T  T  T
+3           T  .  T  T  T  T  T
                                ^
                        dp[6] = true

      [ 2  4 ]  = 6            [ 3  3 ]  = 6
```

### Code

```go
func canPartition(nums []int) bool {
    total := 0
    for _, n := range nums {
        total += n
    }
    if total%2 != 0 { // an odd total cannot split into two equal halves
        return false
    }
    target := total / 2

    // reachable[s] = some subset of the numbers seen so far sums to exactly s
    reachable := make([]bool, target+1)
    reachable[0] = true // the empty subset sums to 0

    for _, num := range nums {
        // Downward: reachable[s-num] must still exclude num.
        for s := target; s >= num; s-- {
            if reachable[s-num] {
                reachable[s] = true
            }
        }
    }
    return reachable[target]
}
```

```python
def canPartition(nums):
    total = sum(nums)
    if total % 2:                       # odd total -> no equal split
        return False
    target = total // 2

    reachable = [False] * (target + 1)  # reachable[s] = some subset sums to s
    reachable[0] = True                 # the empty subset

    for num in nums:
        for s in range(target, num - 1, -1):    # downward -> num used once
            if reachable[s - num]:
                reachable[s] = True

    return reachable[target]
```

### Complexity
Time **O(n × total/2)** — one sweep of the row per number. Space **O(total/2)** — one boolean row; the 2-D table is never needed because each row reads only its predecessor.

---

## 10. Solved Example 2

### Problem — Target Sum (LeetCode 494)
Prefix every number with `+` or `-` and evaluate. Count how many of the `2^n` sign assignments produce `target`.

### Thought Process
1. Let `P` be the numbers that get `+` and `N` the ones that get `-`. Then `sum(P) − sum(N) = target` and `sum(P) + sum(N) = total`.
2. Adding those: `sum(P) = (total + target) / 2`. **Choosing signs is choosing the subset `P`** — nothing else.
3. So count subsets summing to `P`. If `(total + target)` is odd or `|target| > total`, no subset qualifies; answer 0.
4. Same row, same downward sweep as example 9 — only the cell type changes from boolean to a count, and `OR` becomes `+=`.

### The DP, spelled out

```text
What does dp[s] mean?
    dp[s] is the number of distinct subsets of the numbers processed so far
    whose elements add up to exactly s.

How is dp[s] computed?
    dp[s] += dp[s - num]
    Every subset summing to s-num that does not contain num becomes a NEW,
    distinct subset summing to s once num is added. dp[s]'s existing value
    already counts the subsets of s that avoid num, so += merges the two
    disjoint families.

What is the base case?
    dp[0] = 1 — exactly one subset sums to 0, the empty one. (A boolean row
    would say "true"; a counting row says "one".) Seeding 0 would zero the
    entire table forever.

Why downward?
    dp[s-num] must count only subsets that exclude num. Downward, the cells
    read are still on the previous number's row, so no subset can pick up two
    copies of the same array element.
```

### Dry Run

Input: `nums = [1, 2, 3]`, `target = 0` → `total = 6`, `P = (6 + 0) / 2 = 3`

| after num | sweep | dp[0] | dp[1] | dp[2] | dp[3] |
|---|---|---|---|---|---|
| *(start)* | — | 1 | 0 | 0 | 0 |
| `1` | s = 3 → 1 | 1 | 1 | 0 | 0 |
| `2` | s = 3 → 2 | 1 | 1 | 1 | 1 |
| `3` | s = 3 → 3 | 1 | 1 | 1 | 2 |

Output: **`2`**

The two subsets summing to 3 are `{3}` and `{1, 2}`, which correspond to the sign assignments `−1 −2 +3 = 0` and `+1 +2 −3 = 0`. Exactly the two expressions LeetCode expects.

Watch the `2` row cell by cell (sweep `s = 3, 2`): `dp[3] += dp[1]` uses `dp[1] = 1` — the count from the `1` row, which cannot contain a 2 — giving `{1,2}`. Then `dp[2] += dp[0]` gives `{2}`. Had the sweep gone upward, `dp[2]` would become 1 first and then `dp[3] += dp[1]` would still be fine here, but `dp[4] += dp[2]` (on a larger target) would have counted `{2,2}` from one single 2.

### Visualization

```text
total = 6, target = 0   →   sum(P) = (6 + 0)/2 = 3

  P = {3}      →   -1  -2  +3  = 0     ✔
  P = {1,2}    →   +1  +2  -3  = 0     ✔

count of subsets with sum 3  =  dp[3]  =  2
```

### Code

```go
func findTargetSumWays(nums []int, target int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    // |target| > total is unreachable; an odd (total+target) cannot be halved.
    if target > total || -target > total || (total+target)%2 != 0 {
        return 0
    }
    plus := (total + target) / 2 // the subset that receives '+'

    // ways[s] = number of subsets of the numbers seen so far summing to s
    ways := make([]int, plus+1)
    ways[0] = 1 // exactly one subset sums to 0: the empty one

    for _, num := range nums {
        // Downward: ways[s-num] must still exclude num.
        for s := plus; s >= num; s-- {
            ways[s] += ways[s-num]
        }
    }
    return ways[plus]
}
```

```python
def findTargetSumWays(nums, target):
    total = sum(nums)
    # |target| > total is unreachable; an odd (total + target) cannot be halved
    if abs(target) > total or (total + target) % 2:
        return 0
    plus = (total + target) // 2        # the subset that receives '+'

    ways = [0] * (plus + 1)             # ways[s] = # subsets summing to s
    ways[0] = 1                         # the empty subset

    for num in nums:
        for s in range(plus, num - 1, -1):      # downward -> each num once
            ways[s] += ways[s - num]

    return ways[plus]
```

### Complexity
Time **O(n × P)** with `P = (total + target) / 2`. Space **O(P)**.

---

## 11. Solved Example 3

### Problem — K Subsets (LeetCode 698)
Given `nums` and an integer `k`, decide whether the array can be split into `k` groups with **equal** sums.

### Thought Process
1. Each group must sum to `target = total / k`, so `total % k != 0` is an immediate no, and any single number greater than `target` is an immediate no.
2. Now it is subset sum done `k` times — but the groups interact, so a single boolean row over sums is not enough state. We need to remember **which numbers are already spent**.
3. `n ≤ 16` on this problem, so encode "spent" as a bitmask. The key simplification: for a given mask the total consumed is fixed, so the current bucket's fill level is forced — it is `sum(mask) mod target`. The state is the mask alone.
4. Fill buckets one at a time in a fixed order; when a bucket reaches exactly `target` the fill level wraps to 0 and the next bucket starts. Success is the full mask being reachable.

### The DP, spelled out

```text
What does dp[mask] mean?
    dp[mask] is true exactly when the numbers selected by mask can be packed,
    in some order, into completely-full buckets of size `target` plus one
    partially-filled bucket currently holding sum(mask) mod target units.
    (Because sum(mask) is fixed, the fill level is not extra state — it is
    derived from the mask.)

How is dp[mask] computed?
    dp[mask | 1<<j] = true   whenever   dp[mask] is true
                                 and    j is not already in mask
                                 and    (sum(mask) mod target) + nums[j] <= target
    In words: take any reachable packing, drop an unused number into the bucket
    that is currently open, and keep it only if that bucket does not overflow.
    Overflowing is the only way to fail, and forbidding it is the whole rule.

What is the base case?
    dp[0] = true — nothing placed, zero buckets started. All other masks false.

Why forward (increasing mask)?
    Every transition turns a 0 bit into a 1, so mask | 1<<j is numerically
    LARGER than mask. Iterating masks in increasing order therefore guarantees
    dp[mask] is final before it is used to push into any successor.

answer : dp[(1<<n) - 1]  — every number placed with no bucket overflowing,
         and since sum of all = k*target, the last bucket landed exactly full.
```

### Dry Run

Input: `nums = [2, 1, 3]`, `k = 2` → `total = 6`, `target = 3`. Bit `j` = index `j` of `nums`.

| mask | numbers in mask | sum | open bucket holds `sum % 3` | pushes to |
|---|---|---|---|---|
| `000` | — | 0 | 0 | +2 → `001`, +1 → `010`, +3 → `100` |
| `001` | 2 | 2 | 2 | +1 → `011` (2+1=3 ✔); +3 overflows (2+3=5) ✘ |
| `010` | 1 | 1 | 1 | +2 → `011` (1+2=3 ✔); +3 overflows (1+3=4) ✘ |
| `011` | 2,1 | 3 | 0 | +3 → `111` (0+3=3 ✔) |
| `100` | 3 | 3 | 0 | +2 → `101`, +1 → `110` |
| `101` | 2,3 | 5 | 2 | +1 → `111` (2+1=3 ✔) |
| `110` | 1,3 | 4 | 1 | +2 → `111` (1+2=3 ✔) |
| `111` | 2,1,3 | 6 | 0 | full mask reached |

Output: **`true`** — the buckets are `{2, 1}` and `{3}`.

Row `001` is the pruning at work: with the open bucket already holding 2, the number 3 simply cannot go anywhere, so that whole branch dies immediately instead of being explored.

### Visualization

```text
target = 3, two buckets

mask 000 ──┬── +2 ──▶ 001  [2 _]        ──+1──▶ 011  [2 1]│      ──+3──▶ 111 ✔
           ├── +1 ──▶ 010  [1 _]        ──+2──▶ 011  (same state)
           └── +3 ──▶ 100  [3]│         ──+2──▶ 101  [3]│[2 _] ──+1──▶ 111 ✔

  │ marks a bucket that just became exactly full (fill level wraps to 0)
  the two paths to 011 MERGE — that merge is why this is DP and not brute force
```

### Code

```go
func canPartitionKSubsets(nums []int, k int) bool {
    total := 0
    for _, v := range nums {
        total += v
    }
    if k <= 0 || total%k != 0 {
        return false
    }
    target := total / k
    n := len(nums)
    if target == 0 { // every number is 0: any k non-empty buckets work
        return n >= k
    }
    for _, v := range nums {
        if v > target { // one number alone overflows a bucket
            return false
        }
    }

    full := 1 << n

    // subsetSum[mask] = total of the numbers selected by mask
    subsetSum := make([]int, full)
    for mask := 1; mask < full; mask++ {
        low := mask & -mask                   // lowest set bit
        j := bits.TrailingZeros(uint(low))    // its index
        subsetSum[mask] = subsetSum[mask^low] + nums[j]
    }

    // packable[mask] = the numbers in mask fit into full buckets plus one
    // open bucket holding subsetSum[mask] % target
    packable := make([]bool, full)
    packable[0] = true // nothing placed yet

    // Increasing mask order: every successor has a larger value, so packable[mask]
    // is final before it is read.
    for mask := 0; mask < full; mask++ {
        if !packable[mask] {
            continue
        }
        open := subsetSum[mask] % target // how full the current bucket is
        for j := 0; j < n; j++ {
            if mask&(1<<j) != 0 {
                continue // already placed
            }
            if open+nums[j] <= target { // does not overflow the open bucket
                packable[mask|1<<j] = true
            }
        }
    }
    return packable[full-1]
}
```

```python
def canPartitionKSubsets(nums, k):
    total = sum(nums)
    if k <= 0 or total % k:
        return False
    target, n = total // k, len(nums)
    if target == 0:                      # every number is 0
        return n >= k
    if max(nums) > target:               # one number alone overflows a bucket
        return False

    full = 1 << n
    subset_sum = [0] * full              # subset_sum[mask] = total of mask
    for mask in range(1, full):
        low = mask & -mask
        subset_sum[mask] = subset_sum[mask ^ low] + nums[low.bit_length() - 1]

    packable = [False] * full            # packable[mask] = mask packs legally
    packable[0] = True                   # nothing placed yet

    for mask in range(full):             # increasing: successors are larger
        if not packable[mask]:
            continue
        open_bucket = subset_sum[mask] % target
        for j in range(n):
            if mask & (1 << j):
                continue
            if open_bucket + nums[j] <= target:
                packable[mask | (1 << j)] = True

    return packable[full - 1]
```

### Complexity
Time **O(2ⁿ × n)** — every mask offers every unused number once; with `n ≤ 16` that is about a million steps. Space **O(2ⁿ)** for the two mask-indexed arrays. (The classic alternative is backtracking with sorting and pruning: no big array, but exponential worst case and much more delicate to get right.)

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 416 | Partition Equal | Easy | Core dynamic programming application |
| 494 | Target Sum | Easy | Core dynamic programming application |
| 698 | K Subsets | Medium | Core dynamic programming application |
| 1049 | Last Stone II | Medium | Core dynamic programming application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Subset Sum logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Subset Sum (Dynamic Programming).
- **Signal:** subset sum, partition, dp, boolean, target.
- **Move:** Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.
- **Cost:** O(states × transitions) time, O(states) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Subset Sum invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Subset Sum
FAMILY : Dynamic Programming (Advanced)
WHEN   : subset sum, partition, dp, boolean, target
DO     : Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer 
TIME   : O(states × transitions)    SPACE: O(states)
PRACTICE: 416, 494, 698, 1049
```

---

*Part of the DSA Patterns Handbook — pattern 76 of 100.*
