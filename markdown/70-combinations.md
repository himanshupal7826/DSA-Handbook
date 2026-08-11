# 70 · Combinations

> **One-liner:** Choose elements with a moving start index to avoid duplicates.

---

## 1. Overview

### Definition
The **Combinations** pattern belongs to the *Backtracking* family. Choose elements with a moving start index to avoid duplicates.

### Intuition
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Why it works
Build candidates incrementally; prune branches that can't lead to a solution (choose → explore → un-choose). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Backtracking solves configuration/constraint problems: test-case generation, SAT-style feasibility, resource allocation, and puzzle/AI move generation. Pruning is the difference between feasible and intractable in production solvers.

---

## 2. Recognition Signals

### Keywords
combinations, choose k, backtracking, start index, combination sum.

### Constraints
- Input size where the brute-force complexity would time out — the Combinations optimization is the intended solution.
- Structural hints in the statement that match this family (Backtracking).

### Hidden clues
- The problem can be reframed so the Combinations invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Combinations is the upgrade.
- The wording maps onto: combinations, choose k, backtracking, start index, combination sum.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which groups of items — order irrelevant — satisfy my condition?"* — pick exactly `k`, or reach a target sum.

### Intuition
Generate every subset, then keep the ones that qualify.

### Algorithm
1. Enumerate all `2ⁿ` subsets (by bitmask, or by recursion).
2. For each, test the condition: is its size `k`? does it sum to the target?
3. Keep the ones that pass.

### Complexity
- Time: **O(n · 2ⁿ)** regardless of how few subsets actually qualify.
- Space: O(n).

### Drawbacks
- It generates then filters, so the cost is fixed by `2ⁿ` and not by the answer size. Asking for `k = 2` out of `n = 20` means building a million subsets to keep 190.
- And it cannot express **reuse**: "use each coin as many times as you like" has no bitmask encoding at all, because the answer isn't a subset of the input.
- Most importantly, it learns nothing from failure. If a partial sum already exceeds the target, every extension of it is doomed — but the filter only finds out at the end.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Build combinations incrementally in increasing index order, and abandon a branch the moment it can no longer succeed.**

Two mechanisms do all the work:

```text
1. the START index  →  guarantees each combination is generated exactly once
2. PRUNING          →  abandons doomed branches before entering them
```

### The thought process

```text
We need    : all groups satisfying a condition; order does not matter.
Obvious way: generate all subsets, then filter.
Wasteful   : cost is 2^n no matter how few qualify, and reuse
             cannot be expressed at all.
Notice     : building incrementally lets us test the condition on a
             PARTIAL answer. "Sum already too big" kills a whole subtree.
Notice too : looping from a `start` index makes [1,2] reachable but
             [2,1] impossible — so no duplicate work, no dedup pass.
Therefore  : recurse with a start index, prune early, record at the leaves.
Now        : the work tracks the answer size far more closely.
```

### The one decision that defines this chapter: `i` or `i + 1`?

This single character separates the two halves of the family:

```text
backtrack(i + 1)   →  each element used AT MOST ONCE
backtrack(i)       →  each element may be REUSED unlimited times
```

Both loop `for i := start; ...`, so both still generate each combination once, in increasing index order. The difference is only whether the current element stays available.

| Problem | Recurse with | Why |
|---|---|---|
| Combinations (77) | `i + 1` | choose `k` distinct positions |
| Combination Sum (39) | **`i`** | unlimited reuse of each candidate |
| Combination Sum II (40) | `i + 1` | each input element used once |
| Combination Sum III (216) | `i + 1` | distinct digits 1–9 |

### Two kinds of pruning, and why sorting enables both

**1. Sort the candidates, then `break` instead of `continue`.**

Once sorted ascending, if `candidates[i]` already exceeds what remains, every later candidate does too. So you can stop the loop entirely rather than skipping one element:

```go
if candidates[i] > remaining {
    break // sorted: everything after is even bigger
}
```

`break` versus `continue` is a real difference — it abandons the entire rest of the loop, not just one branch.

**2. Count-based pruning for fixed-size combinations.**

If you still need `need = k − len(path)` more elements, the loop must leave at least that many available:

```text
i <= n - need + 1
```

Starting later than that guarantees running out before reaching length `k`.

### The duplicate rule, one more time

When the input can contain duplicates and each element may be used **once**, the same combination can be reached through different branches. Sort, then skip a candidate equal to its predecessor at the same level:

```go
if i > start && candidates[i] == candidates[i-1] {
    continue
}
```

Note the interplay: with **reuse allowed** (`backtrack(i)`), duplicates in the input are usually not even possible — repeated values are expressed by reusing one candidate, so the input is a set. The skip rule belongs to the `i + 1` half of the family.

### Where the target must be tested

Track `remaining = target − sum(path)` and pass it down. Then:

```text
remaining == 0  →  a complete answer, record it
remaining <  0  →  overshot; but with sorted input and the break above,
                   this branch is never even entered
```

Passing `remaining` down beats recomputing the sum at each node — O(1) instead of O(k) per call.

### Steps

```text
Step 1 → Sort the candidates (enables both the break and the dedup skip).
Step 2 → define backtrack(start, remaining):
Step 3 →     if remaining == 0: record a COPY; return
Step 4 →     for i = start .. n-1:
Step 5 →         if candidates[i] > remaining: break     ← sorted, so stop
Step 6 →         if i > start and candidates[i] == candidates[i-1]: continue
Step 7 →         append candidates[i]                    ← choose
Step 8 →         backtrack(i or i+1, remaining - candidates[i])  ← reuse?
Step 9 →         remove the last element                 ← un-choose
```

### How should I recognize this?

```text
If you see...
  "all combinations of k", "all ways to sum to target"
  "each number may be used once / unlimited times"
  order does NOT matter — [2,3] and [3,2] are the same answer
        ↓
Think about...
  "Can an element repeat? → i vs i+1"
  "Can I tell this branch is doomed before entering it?"
        ↓
Use...
  sort → loop from start → prune with break → record at remaining == 0
  duplicates in input + single use → skip equal siblings (i > start)
```

> Asking **how many** ways rather than **which** ways? That is Coin Change / knapsack DP, not backtracking. Enumeration is only necessary when the actual combinations are the output.

### Visual explanation

```svg
<svg viewBox="0 0 660 290" width="100%" height="290" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-70" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="330" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">C(4,2): pick increasing numbers, prune branches too short</text>
  <!-- level 1 edges -->
  <line x1="330" y1="50" x2="120" y2="105" stroke="#475569" marker-end="url(#a-70)"/>
  <line x1="330" y1="50" x2="300" y2="105" stroke="#475569" marker-end="url(#a-70)"/>
  <line x1="330" y1="50" x2="440" y2="105" stroke="#475569" marker-end="url(#a-70)"/>
  <line x1="330" y1="50" x2="580" y2="105" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#a-70)"/>
  <!-- level 2 edges under [1] -->
  <line x1="120" y1="135" x2="55"  y2="200" stroke="#475569" marker-end="url(#a-70)"/>
  <line x1="120" y1="135" x2="145" y2="200" stroke="#475569" marker-end="url(#a-70)"/>
  <line x1="120" y1="135" x2="235" y2="200" stroke="#475569" marker-end="url(#a-70)"/>
  <!-- nodes -->
  <rect x="298" y="35"  width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="330" y="55"  text-anchor="middle" fill="#1e293b">[ ]</text>
  <rect x="88"  y="105" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="120" y="125" text-anchor="middle" fill="#1e293b">[1]</text>
  <rect x="268" y="105" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="300" y="125" text-anchor="middle" fill="#1e293b">[2]</text>
  <rect x="408" y="105" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="440" y="125" text-anchor="middle" fill="#1e293b">[3]</text>
  <rect x="540" y="105" width="80" height="30" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="580" y="125" text-anchor="middle" fill="#b91c1c">4: ✗ &lt;k left</text>
  <rect x="23"  y="200" width="64" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="55"  y="220" text-anchor="middle" fill="#1e293b">[1,2]</text>
  <rect x="113" y="200" width="64" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="145" y="220" text-anchor="middle" fill="#1e293b">[1,3]</text>
  <rect x="203" y="200" width="64" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="235" y="220" text-anchor="middle" fill="#1e293b">[1,4]</text>
  <text x="440" y="165" text-anchor="middle" fill="#64748b">[2] &amp; [3] expand the same way</text>
  <text x="145" y="262" text-anchor="middle" fill="#059669" font-weight="700">size == k ──▶ record combination</text>
</svg>
```

```text
candidates = [2, 3, 6, 7]  (sorted), target = 7
recursing with `i` — reuse allowed

                    remaining 7
        ┌───────────────┼──────────┬─────────┐
      take 2          take 3     take 6    take 7
      rem 5           rem 4      rem 1     rem 0 ✓ [7]
     ┌──┴──┐            │          │
  take 2  take 3     take 3      6 > 1
  rem 3   rem 2      rem 1       → break
    │       │
 take 2  3 > 2 → break
 rem 1
    │
 take 3 → rem 0 ✓ [2,2,3]

answers: [2,2,3] and [7]
```

### Interview explanation
"I'll build combinations incrementally with a `start` index, which forces increasing order so each one is generated exactly once. The key decision is whether I recurse with `i` or `i + 1`: `i + 1` uses each element at most once, `i` allows unlimited reuse — that single character is the difference between Combinations and Combination Sum. I sort the candidates first, which lets me `break` out of the loop as soon as one exceeds what remains, since everything after it is larger. I also pass the remaining target down instead of recomputing the sum, so each node is O(1). If the input has duplicates and each element may be used once, I additionally skip a candidate equal to its predecessor when `i > start`, so equal siblings don't produce the same combination twice."

---

## 5. Generic Templates

> `start` index for uniqueness, sorting for pruning, `i` vs `i+1` for reuse.

```go
// Combine picks k numbers from 1..n. The count-based prune skips branches
// that cannot possibly reach length k.
func Combine(n, k int) [][]int {
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        if len(path) == k {
            snapshot := make([]int, k)
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        // Need this many more, so at least this many must remain.
        need := k - len(path)
        for i := start; i <= n-need+1; i++ {
            path = append(path, i)
            backtrack(i + 1) // i+1: each number used at most once
            path = path[:len(path)-1]
        }
    }

    backtrack(1)
    return result
}

// CombinationSum allows UNLIMITED reuse of each candidate.
func CombinationSum(candidates []int, target int) [][]int {
    sort.Ints(candidates) // sorting is what makes `break` valid

    result := [][]int{}
    path := []int{}

    var backtrack func(start, remaining int)
    backtrack = func(start, remaining int) {
        if remaining == 0 {
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        for i := start; i < len(candidates); i++ {
            if candidates[i] > remaining {
                break // sorted: every later candidate is even bigger
            }
            path = append(path, candidates[i])
            backtrack(i, remaining-candidates[i]) // i: reuse allowed
            path = path[:len(path)-1]
        }
    }

    backtrack(0, target)
    return result
}

// CombinationSum2 uses each element ONCE and skips duplicate siblings.
func CombinationSum2(candidates []int, target int) [][]int {
    sort.Ints(candidates) // needed for BOTH the break and the dedup skip

    result := [][]int{}
    path := []int{}

    var backtrack func(start, remaining int)
    backtrack = func(start, remaining int) {
        if remaining == 0 {
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        for i := start; i < len(candidates); i++ {
            if candidates[i] > remaining {
                break
            }
            // i > start: the first candidate at each level is always allowed.
            if i > start && candidates[i] == candidates[i-1] {
                continue
            }
            path = append(path, candidates[i])
            backtrack(i+1, remaining-candidates[i]) // i+1: single use
            path = path[:len(path)-1]
        }
    }

    backtrack(0, target)
    return result
}
```

```python
def combine(n, k):
    """Pick k numbers from 1..n, with a count-based prune."""
    result, path = [], []

    def backtrack(start):
        if len(path) == k:
            result.append(path[:])
            return
        need = k - len(path)            # at least this many must remain
        for i in range(start, n - need + 2):
            path.append(i)
            backtrack(i + 1)            # i+1: used at most once
            path.pop()

    backtrack(1)
    return result

def combination_sum(candidates, target):
    """UNLIMITED reuse of each candidate."""
    candidates.sort()                   # makes `break` valid
    result, path = [], []

    def backtrack(start, remaining):
        if remaining == 0:
            result.append(path[:])
            return
        for i in range(start, len(candidates)):
            if candidates[i] > remaining:
                break                   # sorted: later ones are bigger
            path.append(candidates[i])
            backtrack(i, remaining - candidates[i])   # i: reuse allowed
            path.pop()

    backtrack(0, target)
    return result

def combination_sum2(candidates, target):
    """Each element used ONCE; duplicate siblings skipped."""
    candidates.sort()                   # needed for break AND dedup
    result, path = [], []

    def backtrack(start, remaining):
        if remaining == 0:
            result.append(path[:])
            return
        for i in range(start, len(candidates)):
            if candidates[i] > remaining:
                break
            if i > start and candidates[i] == candidates[i - 1]:
                continue                # i > start, not i > 0
            path.append(candidates[i])
            backtrack(i + 1, remaining - candidates[i])   # i+1: single use
            path.pop()

    backtrack(0, target)
    return result
```

```java
import java.util.*;

public class CombinationsPattern {
    public static List<List<Integer>> combinationSum(int[] candidates, int target) {
        Arrays.sort(candidates);                    // makes break valid
        List<List<Integer>> result = new ArrayList<>();
        backtrackSum(candidates, 0, target, new ArrayList<>(), result);
        return result;
    }

    private static void backtrackSum(int[] candidates, int start, int remaining,
                                     List<Integer> path, List<List<Integer>> result) {
        if (remaining == 0) {
            result.add(new ArrayList<>(path));      // a COPY
            return;
        }
        for (int i = start; i < candidates.length; i++) {
            if (candidates[i] > remaining) break;   // sorted: later are bigger
            path.add(candidates[i]);
            backtrackSum(candidates, i, remaining - candidates[i], path, result); // i: reuse
            path.remove(path.size() - 1);
        }
    }

    public static List<List<Integer>> combinationSum2(int[] candidates, int target) {
        Arrays.sort(candidates);
        List<List<Integer>> result = new ArrayList<>();
        backtrackSum2(candidates, 0, target, new ArrayList<>(), result);
        return result;
    }

    private static void backtrackSum2(int[] candidates, int start, int remaining,
                                      List<Integer> path, List<List<Integer>> result) {
        if (remaining == 0) {
            result.add(new ArrayList<>(path));
            return;
        }
        for (int i = start; i < candidates.length; i++) {
            if (candidates[i] > remaining) break;
            if (i > start && candidates[i] == candidates[i - 1]) continue;  // i > start
            path.add(candidates[i]);
            backtrackSum2(candidates, i + 1, remaining - candidates[i], path, result);
            path.remove(path.size() - 1);
        }
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

void backtrackSum(const vector<int>& candidates, int start, int remaining,
                  vector<int>& path, vector<vector<int>>& result) {
    if (remaining == 0) {
        result.push_back(path);
        return;
    }
    for (int i = start; i < (int)candidates.size(); ++i) {
        if (candidates[i] > remaining) break;       // sorted: later are bigger
        path.push_back(candidates[i]);
        backtrackSum(candidates, i, remaining - candidates[i], path, result); // i: reuse
        path.pop_back();
    }
}

vector<vector<int>> combinationSum(vector<int> candidates, int target) {
    sort(candidates.begin(), candidates.end());
    vector<vector<int>> result;
    vector<int> path;
    backtrackSum(candidates, 0, target, path, result);
    return result;
}

void backtrackSum2(const vector<int>& candidates, int start, int remaining,
                   vector<int>& path, vector<vector<int>>& result) {
    if (remaining == 0) {
        result.push_back(path);
        return;
    }
    for (int i = start; i < (int)candidates.size(); ++i) {
        if (candidates[i] > remaining) break;
        if (i > start && candidates[i] == candidates[i - 1]) continue;   // i > start
        path.push_back(candidates[i]);
        backtrackSum2(candidates, i + 1, remaining - candidates[i], path, result);
        path.pop_back();
    }
}

vector<vector<int>> combinationSum2(vector<int> candidates, int target) {
    sort(candidates.begin(), candidates.end());
    vector<vector<int>> result;
    vector<int> path;
    backtrackSum2(candidates, 0, target, path, result);
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Combinations (Optimal) |
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

### Problem — Combinations (LeetCode 77)
Return all combinations of `k` numbers chosen from `1..n`.

### Thought Process
1. This is the base case of the chapter: a fixed size, no target, no duplicates.
2. `start` index plus `backtrack(i + 1)` — each number is used at most once, and increasing order means `[1,2]` is generated but `[2,1]` never is.
3. Record only when `len(path) == k`.
4. The count-based prune is worth deriving rather than memorising, below.
5. Record a copy, as always.

**Deriving the prune.** Suppose the path has `len(path)` numbers and we still need `need = k − len(path)`. If we start the next choice at `i`, the numbers available are `i, i+1, …, n` — that is `n − i + 1` of them. We need at least `need`:

```text
n - i + 1 >= need     ⟺     i <= n - need + 1
```

So the loop bound is `i <= n − need + 1`. Anything beyond it runs out before reaching length `k`.

### Dry Run

Input: `n = 4`, `k = 2`

| call | path | need | loop bound `n − need + 1` | i values tried |
|------|------|------|----------------------------|----------------|
| `backtrack(1)` | `[]` | 2 | `4 − 2 + 1 = 3` | 1, 2, 3 — **4 is pruned** |
| `backtrack(2)` via i=1 | `[1]` | 1 | `4 − 1 + 1 = 4` | 2, 3, 4 → records `[1,2]`, `[1,3]`, `[1,4]` |
| `backtrack(3)` via i=2 | `[2]` | 1 | 4 | 3, 4 → records `[2,3]`, `[2,4]` |
| `backtrack(4)` via i=3 | `[3]` | 1 | 4 | 4 → records `[3,4]` |

Output: **`[[1,2], [1,3], [1,4], [2,3], [2,4], [3,4]]`** ✓ — that is `C(4,2) = 6`.

The prune at the top level is the useful bit: starting at `4` leaves only one number when two are needed, so the branch is skipped without ever being entered.

### Visualization

```text
n = 4, k = 2

start=1, need=2 → i ≤ 3
   ├── [1] → i = 2,3,4  →  [1,2] [1,3] [1,4]
   ├── [2] → i = 3,4    →  [2,3] [2,4]
   ├── [3] → i = 4      →  [3,4]
   └── [4]              →  PRUNED (only one number left, need two)
```

### Code

```go
func combine(n int, k int) [][]int {
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        if len(path) == k { // complete only at length k
            snapshot := make([]int, k)
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        // Need `need` more numbers, and i..n must contain at least that many:
        //   n - i + 1 >= need   ⟺   i <= n - need + 1
        need := k - len(path)
        for i := start; i <= n-need+1; i++ {
            path = append(path, i)    // choose
            backtrack(i + 1)          // explore; i+1 means each used once
            path = path[:len(path)-1] // un-choose
        }
    }

    backtrack(1)
    return result
}
```

```python
def combine(n, k):
    result, path = [], []

    def backtrack(start):
        if len(path) == k:
            result.append(path[:])      # a COPY
            return

        # i..n must hold at least `need` numbers:  i <= n - need + 1
        need = k - len(path)
        for i in range(start, n - need + 2):
            path.append(i)              # choose
            backtrack(i + 1)            # explore; i+1 means used once
            path.pop()                  # un-choose

    backtrack(1)
    return result
```

### Complexity
Time **O(k · C(n, k))** — one length-`k` copy per combination. Space O(k) beyond the output.

---

## 10. Solved Example 2

### Problem — Combination Sum (LeetCode 39)
Given **distinct** candidates and a target, return all unique combinations summing to the target. **Each candidate may be used unlimited times.**

### Thought Process
1. Unlimited reuse is the whole difference: recurse with `i`, not `i + 1`, so the current candidate stays available.
2. Still loop from `start`, which keeps combinations in non-decreasing order — that is what prevents `[2,2,3]` and `[3,2,2]` both appearing.
3. Sort the candidates so that once one exceeds the remaining target, we can `break` rather than `continue`.
4. Pass `remaining` down instead of recomputing the sum; `remaining == 0` is a complete answer.
5. Because `remaining` never goes negative (the `break` prevents it), there is no "overshot" case to handle.

### Dry Run

Input: `candidates = [2, 3, 6, 7]` (sorted), `target = 7`

| call | path | remaining | loop | outcome |
|------|------|-----------|------|---------|
| `backtrack(0, 7)` | `[]` | 7 | i=0 (2) | descend |
| `backtrack(0, 5)` | `[2]` | 5 | i=0 (2) | descend |
| `backtrack(0, 3)` | `[2,2]` | 3 | i=0 (2) | descend |
| `backtrack(0, 1)` | `[2,2,2]` | 1 | `2 > 1` → **break** | dead end |
| back at rem 3 | `[2,2]` | 3 | i=1 (3) | `3 − 3 = 0` → **record `[2,2,3]`** |
| back at rem 3 | `[2,2]` | 3 | i=2 (6) | `6 > 3` → break |
| back at rem 5 | `[2]` | 5 | i=1 (3) → rem 2 | then `3 > 2` → break |
| back at rem 5 | `[2]` | 5 | i=2 (6) | `6 > 5` → break |
| back at rem 7 | `[]` | 7 | i=1 (3) → rem 4 | subtree finds nothing |
| back at rem 7 | `[]` | 7 | i=2 (6) → rem 1 | `6 > 1` inside → break |
| back at rem 7 | `[]` | 7 | i=3 (7) | `7 − 7 = 0` → **record `[7]`** |

Output: **`[[2,2,3], [7]]`** ✓

Watch the `i` versus `i + 1`: from `[2]` we recursed with `i = 0` again, which is how `[2,2]` and then `[2,2,2]` became reachable. With `i + 1` the answer `[2,2,3]` could never be built.

### Visualization

```text
candidates = [2, 3, 6, 7]   target = 7    (recursing with i → reuse)

                remaining 7
     ┌──────────────┼─────────┬────────┐
   take 2         take 3    take 6   take 7
   rem 5          rem 4     rem 1    rem 0 ✓ [7]
   ┌──┴──┐          │         │
 take 2  take 3   take 3    6 > 1 → break
 rem 3   rem 2    rem 1
   │       │
take 2   3 > 2 → break
rem 1
   │
take 3 → rem 0 ✓ [2,2,3]
```

### Code

```go
func combinationSum(candidates []int, target int) [][]int {
    // Sorting is what makes the `break` below valid.
    sort.Ints(candidates)

    result := [][]int{}
    path := []int{}

    var backtrack func(start, remaining int)
    backtrack = func(start, remaining int) {
        if remaining == 0 {
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        for i := start; i < len(candidates); i++ {
            if candidates[i] > remaining {
                break // sorted: every later candidate is even bigger
            }

            path = append(path, candidates[i])       // choose
            // i, NOT i+1: the same candidate stays available for reuse.
            backtrack(i, remaining-candidates[i])    // explore
            path = path[:len(path)-1]                // un-choose
        }
    }

    backtrack(0, target)
    return result
}
```

```python
def combinationSum(candidates, target):
    candidates.sort()                   # makes the break valid
    result, path = [], []

    def backtrack(start, remaining):
        if remaining == 0:
            result.append(path[:])
            return

        for i in range(start, len(candidates)):
            if candidates[i] > remaining:
                break                   # sorted: later ones are bigger
            path.append(candidates[i])                   # choose
            backtrack(i, remaining - candidates[i])      # i: reuse allowed
            path.pop()                                   # un-choose

    backtrack(0, target)
    return result
```

### Complexity
Time **O(n^(target / min(candidates)))** in the worst case — the depth is bounded by how many times the smallest candidate fits into the target. Space O(target / min) for the recursion depth.

---

## 11. Solved Example 3

### Problem — Combination Sum II (LeetCode 40)
Same as above, but each element may be used **at most once**, and the input **may contain duplicates**. The result must not contain duplicate combinations.

### Thought Process
1. Two changes from Example 2, and they are independent:
   - single use → recurse with `i + 1`
   - duplicate inputs → skip equal siblings with `i > start`
2. Sorting now serves **three** purposes: the `break` prune, the duplicate skip, and keeping output order canonical.
3. `i > start` is again the crucial detail — the first candidate at each level must be allowed, or a legitimate `[1,1,6]` could never be built.
4. Record at `remaining == 0`.

### Dry Run

Input: `candidates = [10, 1, 2, 7, 6, 1, 5]`, `target = 8`

**Sorted:** `[1, 1, 2, 5, 6, 7, 10]` (indices 0..6)

| level | path | remaining | i | decision |
|-------|------|-----------|---|----------|
| `backtrack(0, 8)` | `[]` | 8 | i=0 (`1`) | take → descend |
| `backtrack(1, 7)` | `[1]` | 7 | i=1 (`1`) | `i > start`? `1 > 1` **no** → **allowed** → descend |
| `backtrack(2, 6)` | `[1,1]` | 6 | i=2 (`2`) → rem 4; then `5 > 4` break | nothing |
| | `[1,1]` | 6 | i=3 (`5`) → rem 1; `6 > 1` break | nothing |
| | `[1,1]` | 6 | i=4 (`6`) | rem 0 → **record `[1,1,6]`** |
| | `[1,1]` | 6 | i=5 (`7`) | `7 > 6` → break |
| back to `backtrack(1,7)` | `[1]` | 7 | i=2 (`2`) → rem 5 | i=3 (`5`) → rem 0 → **record `[1,2,5]`** |
| | `[1]` | 7 | i=3 (`5`) → rem 2 | `6 > 2` → break |
| | `[1]` | 7 | i=5 (`7`) | rem 0 → **record `[1,7]`** |
| back to `backtrack(0,8)` | `[]` | 8 | i=1 (`1`) | `i > start` (1>0) and `nums[1]==nums[0]` → **skip** |
| | `[]` | 8 | i=2 (`2`) → rem 6 | i=4 (`6`) → rem 0 → **record `[2,6]`** |
| | `[]` | 8 | i=3..6 | all dead ends or `> 8` |

Output: **`[[1,1,6], [1,2,5], [1,7], [2,6]]`** ✓

**The two `1`s, handled correctly.** At the top level the second `1` is skipped — otherwise `[1,7]` would be produced twice. But one level down, with `start = 1`, the second `1` *is* used, which is the only way `[1,1,6]` exists. That is precisely what `i > start` (rather than `i > 0`) buys.

### Visualization

```text
sorted: [1, 1, 2, 5, 6, 7, 10]
index:   0  1  2  3  4  5   6

top level (start=0):  i=0 ✓    i=1 ✗ skip (equal sibling)    i=2 ✓ ...

inside the first 1 (start=1):  i=1 is now the FIRST candidate → allowed
                               → [1,1,...] is still reachable

results: [1,1,6]  [1,2,5]  [1,7]  [2,6]
```

### Code

```go
func combinationSum2(candidates []int, target int) [][]int {
    // Sorting serves three purposes here: the break prune, the duplicate
    // skip, and canonical output order.
    sort.Ints(candidates)

    result := [][]int{}
    path := []int{}

    var backtrack func(start, remaining int)
    backtrack = func(start, remaining int) {
        if remaining == 0 {
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        for i := start; i < len(candidates); i++ {
            if candidates[i] > remaining {
                break // sorted: everything after is bigger
            }
            // i > start, NOT i > 0: the first candidate at each level is
            // always allowed, so [1,1,6] remains reachable.
            if i > start && candidates[i] == candidates[i-1] {
                continue
            }

            path = append(path, candidates[i])        // choose
            // i+1, NOT i: each element may be used only once.
            backtrack(i+1, remaining-candidates[i])   // explore
            path = path[:len(path)-1]                 // un-choose
        }
    }

    backtrack(0, target)
    return result
}
```

```python
def combinationSum2(candidates, target):
    candidates.sort()                   # break prune + duplicate skip
    result, path = [], []

    def backtrack(start, remaining):
        if remaining == 0:
            result.append(path[:])
            return

        for i in range(start, len(candidates)):
            if candidates[i] > remaining:
                break                   # sorted: later ones are bigger
            if i > start and candidates[i] == candidates[i - 1]:
                continue                # i > start, not i > 0
            path.append(candidates[i])                       # choose
            backtrack(i + 1, remaining - candidates[i])      # i+1: single use
            path.pop()                                       # un-choose

    backtrack(0, target)
    return result
```

### Complexity
Time **O(n · 2ⁿ)** worst case — bounded by the number of subsets, with pruning usually cutting far below that. Space O(n) beyond the output.

> Lining up the three examples shows the whole family in two knobs: `i` versus `i + 1` decides reuse, and the `i > start` skip decides duplicate handling. Everything else — sort, break, record a copy — is identical.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 77 | Combinations | Easy | Core backtracking application |
| 39 | Combination Sum | Easy | Core backtracking application |
| 40 | Combination Sum II | Medium | Core backtracking application |
| 216 | Comb Sum III | Medium | Core backtracking application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Combinations logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Combinations (Backtracking).
- **Signal:** combinations, choose k, backtracking, start index, combination sum.
- **Move:** DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.
- **Cost:** O(branches^depth) time, O(depth) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Combinations invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Combinations
FAMILY : Backtracking (Intermediate)
WHEN   : combinations, choose k, backtracking, start index, combination sum
DO     : DFS over the decision tree with pruning. Each recursion makes a choice, recurses
TIME   : O(branches^depth)    SPACE: O(depth)
PRACTICE: 77, 39, 40, 216
```

---

*Part of the DSA Patterns Handbook — pattern 70 of 100.*
