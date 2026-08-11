# 71 · Permutations

> **One-liner:** Place each unused element in each position to enumerate orderings.

---

## 1. Overview

### Definition
The **Permutations** pattern belongs to the *Backtracking* family. Place each unused element in each position to enumerate orderings.

### Intuition
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Why it works
Build candidates incrementally; prune branches that can't lead to a solution (choose → explore → un-choose). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Backtracking solves configuration/constraint problems: test-case generation, SAT-style feasibility, resource allocation, and puzzle/AI move generation. Pruning is the difference between feasible and intractable in production solvers.

---

## 2. Recognition Signals

### Keywords
permutations, arrange, backtracking, used array, swap.

### Constraints
- Input size where the brute-force complexity would time out — the Permutations optimization is the intended solution.
- Structural hints in the statement that match this family (Backtracking).

### Hidden clues
- The problem can be reframed so the Permutations invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Permutations is the upgrade.
- The wording maps onto: permutations, arrange, backtracking, used array, swap.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"List every ordering."* — where, unlike combinations, **order is the answer**.

### Intuition
Generate every sequence of length `n` over the input values, then discard the ones that aren't valid arrangements.

### Algorithm
1. Build all `nⁿ` sequences by choosing any element at each of the `n` positions.
2. Discard any sequence that reuses an element.
3. Keep the rest.

### Complexity
- Time: **O(n · nⁿ)** to generate, of which only `n!` survive.
- Space: O(n).

### Drawbacks
- The waste is enormous: at `n = 8` it builds 16.7 million sequences to keep 40,320 — over 99.7% discarded.
- And every rejection is discovered at the very end. A sequence starting `[1, 1, …]` is already invalid after two positions, but the generate-then-filter approach explores all `n^(n−2)` completions of it anyway.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **At each position, choose only from the elements not yet used — so every path you build is a valid permutation by construction.**

Nothing is ever discarded. The decision tree has exactly `n!` leaves, one per permutation.

### The thought process

```text
We need    : all n! orderings.
Obvious way: build all n^n sequences and filter out the invalid ones.
Wasteful   : 99%+ discarded, and invalidity is only noticed at the end.
Notice     : the constraint "each element once" can be enforced at the
             moment of choosing, not after the fact.
Therefore  : track which elements are used; loop over the unused ones.
Now        : every leaf is a valid answer — O(n · n!), which is optimal
             because that is the output size.
```

### `used[]` instead of `start` — and why

This is the single structural difference from the Subsets/Combinations chapters:

```text
COMBINATIONS: order is irrelevant, so [1,2] and [2,1] are the SAME answer.
              → loop from `start`, recurse with i+1
              → each combination generated exactly once

PERMUTATIONS: order IS the answer, so [1,2] and [2,1] are DIFFERENT.
              → loop over ALL indices every time
              → track used[] so no element is picked twice
```

A `start` index would forbid ever going "backwards" to a smaller index — which is exactly what permutations must do. So `start` is replaced by `used`.

| | Combinations | Permutations |
|---|---|---|
| Loop | `for i := start; …` | `for i := 0; i < n; i++` |
| Skip rule | — | `if used[i] { continue }` |
| Recurse | `backtrack(i+1)` | `backtrack()` |
| Record when | length `k` (or every node) | length `n` |
| Count | `C(n,k)` | `n!` |

### Steps

```text
Step 1 → used = all false; path = empty
Step 2 → define backtrack():
Step 3 →     if len(path) == n:  record a COPY;  return
Step 4 →     for i = 0 .. n-1:
Step 5 →         if used[i]: skip
Step 6 →         used[i] = true;  append nums[i]      ← choose
Step 7 →         backtrack()                          ← explore
Step 8 →         remove last;  used[i] = false        ← un-choose
```

Step 8 must undo **both** things step 6 did. Forgetting to reset `used[i]` is the classic bug — the first branch consumes every element and all later branches find nothing available.

### Duplicates: a different rule from combinations

With duplicate inputs, `[1a, 1b, 2]` and `[1b, 1a, 2]` are the same permutation reached twice. Sort first, then add:

```go
if i > 0 && nums[i] == nums[i-1] && !used[i-1] {
    continue
}
```

Read it as: **use a duplicate only if its identical predecessor is already in the path.** That forces equal values to be consumed strictly left to right, so exactly one of their interchangeable orderings survives.

The `!used[i-1]` part is what makes it correct, and it is easy to get backwards:

```text
used[i-1] == true   → the predecessor is in the path ABOVE me;
                      I am extending it, which is the canonical order → ALLOW

used[i-1] == false  → the predecessor was already tried and undone at
                      THIS level; picking me now repeats that branch → SKIP
```

Note this differs from the combinations rule (`i > start`), because permutations have no `start` — the "same level" notion is carried by `used` instead.

### There is no free lunch on complexity

`n!` grows faster than anything else in this book:

```text
n = 8   →  40,320
n = 10  →  3.6 million
n = 12  →  479 million
```

O(n · n!) is optimal *for producing all permutations*, because that is the output size. If the problem only wants **one** permutation — the next one, the k-th one — do **not** enumerate. That is what the third example is about.

### The O(1)-space alternative: next permutation

To step from one arrangement to the next in lexicographic order, there is a four-step in-place algorithm that touches each element at most twice. It is the right tool whenever you need to *walk* permutations rather than *collect* them, and it is what `std::next_permutation` implements.

### How should I recognize this?

```text
If you see...
  "all permutations / arrangements / orderings"
  "in how many orders", "rearrange", "next permutation"
  order MATTERS — [1,2] and [2,1] are different answers
        ↓
Think about...
  "Do I need ALL of them, or just the next / k-th one?"
        ↓
Use...
  all of them   → backtracking with used[]
  duplicates    → sort + skip when nums[i]==nums[i-1] && !used[i-1]
  just the next → the in-place four-step algorithm, O(n) time O(1) space
```

### Visual explanation

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-71" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="330" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">Permutations of [1,2,3]: pick an unused element each level</text>
  <!-- level 1 -->
  <line x1="330" y1="50" x2="130" y2="100" stroke="#475569" marker-end="url(#a-71)"/>
  <line x1="330" y1="50" x2="330" y2="100" stroke="#475569" marker-end="url(#a-71)"/>
  <line x1="330" y1="50" x2="530" y2="100" stroke="#475569" marker-end="url(#a-71)"/>
  <!-- level 2 under [1] -->
  <line x1="130" y1="130" x2="80"  y2="185" stroke="#475569" marker-end="url(#a-71)"/>
  <line x1="130" y1="130" x2="200" y2="185" stroke="#475569" marker-end="url(#a-71)"/>
  <!-- level 3 -->
  <line x1="80"  y1="215" x2="80"  y2="245" stroke="#475569" marker-end="url(#a-71)"/>
  <line x1="200" y1="215" x2="200" y2="245" stroke="#475569" marker-end="url(#a-71)"/>
  <!-- nodes -->
  <rect x="298" y="35"  width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="330" y="55"  text-anchor="middle" fill="#1e293b">[ ]</text>
  <rect x="98"  y="100" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="130" y="120" text-anchor="middle" fill="#1e293b">[1]</text>
  <rect x="298" y="100" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="330" y="120" text-anchor="middle" fill="#1e293b">[2]</text>
  <rect x="498" y="100" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="530" y="120" text-anchor="middle" fill="#1e293b">[3]</text>
  <rect x="48"  y="185" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="80"  y="205" text-anchor="middle" fill="#1e293b">[1,2]</text>
  <rect x="168" y="185" width="64" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="205" text-anchor="middle" fill="#1e293b">[1,3]</text>
  <rect x="40"  y="245" width="80" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="80"  y="265" text-anchor="middle" fill="#1e293b">[1,2,3]</text>
  <rect x="160" y="245" width="80" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="200" y="265" text-anchor="middle" fill="#1e293b">[1,3,2]</text>
  <text x="435" y="205" text-anchor="middle" fill="#64748b">[2] &amp; [3] branches</text>
  <text x="435" y="222" text-anchor="middle" fill="#64748b">mirror this shape</text>
  <text x="435" y="266" text-anchor="middle" fill="#059669" font-weight="700">3! = 6 leaves</text>
</svg>
```

```text
nums = [1, 2, 3]

                       []
        ┌───────────────┼───────────────┐
       [1]             [2]             [3]
      ┌─┴─┐           ┌─┴─┐           ┌─┴─┐
   [1,2] [1,3]     [2,1] [2,3]     [3,1] [3,2]
     │     │         │     │         │     │
 [1,2,3][1,3,2] [2,1,3][2,3,1] [3,1,2][3,2,1]

3 choices, then 2, then 1  →  3! = 6 leaves
only leaves are recorded (unlike subsets, where every node counts)
```

### Interview explanation
"Permutations differ from combinations in one structural way: order matters, so I can't use a `start` index that only ever moves forward. Instead I loop over every index each time and keep a `used` array so no element is picked twice — that makes every path a valid permutation by construction, with no filtering. The un-choose step has to reset both the path and `used[i]`; forgetting the second is the usual bug. For duplicate inputs I sort and then skip `nums[i] == nums[i-1] && !used[i-1]`, which means a duplicate may only be used if its identical predecessor is already in the path — forcing equal values to be consumed left to right so each distinct permutation appears once. It's O(n · n!), which is optimal since that's the output size. If the problem only needs the *next* permutation rather than all of them, I'd use the in-place four-step algorithm instead: O(n) time, O(1) space."

---

## 5. Generic Templates

> `used[]` instead of `start`. Undo both the path and the flag.

```go
// Permutations generates all n! orderings.
func Permutations(nums []int) [][]int {
    result := [][]int{}
    path := []int{}
    used := make([]bool, len(nums))

    var backtrack func()
    backtrack = func() {
        if len(path) == len(nums) {
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        // Every index, every time — order matters, so we may go "backwards".
        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }

            used[i] = true                // choose
            path = append(path, nums[i])

            backtrack()                   // explore

            path = path[:len(path)-1]     // un-choose: BOTH of them
            used[i] = false
        }
    }

    backtrack()
    return result
}

// PermutationsUnique handles duplicate inputs.
func PermutationsUnique(nums []int) [][]int {
    sort.Ints(nums) // equal values must be adjacent for the skip to work

    result := [][]int{}
    path := []int{}
    used := make([]bool, len(nums))

    var backtrack func()
    backtrack = func() {
        if len(path) == len(nums) {
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }
            // Use a duplicate only if its identical predecessor is already
            // in the path — forcing equal values left-to-right.
            if i > 0 && nums[i] == nums[i-1] && !used[i-1] {
                continue
            }

            used[i] = true
            path = append(path, nums[i])
            backtrack()
            path = path[:len(path)-1]
            used[i] = false
        }
    }

    backtrack()
    return result
}

// NextPermutation rearranges nums into the next lexicographic order,
// in place, in O(n) time and O(1) space.
func NextPermutation(nums []int) {
    n := len(nums)

    // 1. Find the rightmost position where the sequence stops descending.
    pivot := n - 2
    for pivot >= 0 && nums[pivot] >= nums[pivot+1] {
        pivot--
    }

    if pivot >= 0 {
        // 2. Find the rightmost element greater than the pivot.
        successor := n - 1
        for nums[successor] <= nums[pivot] {
            successor--
        }
        // 3. Swap them.
        nums[pivot], nums[successor] = nums[successor], nums[pivot]
    }

    // 4. Reverse the suffix, turning it from descending into ascending —
    //    the smallest arrangement of those elements.
    for left, right := pivot+1, n-1; left < right; left, right = left+1, right-1 {
        nums[left], nums[right] = nums[right], nums[left]
    }
}
```

```python
def permutations(nums):
    """All n! orderings."""
    result, path = [], []
    used = [False] * len(nums)

    def backtrack():
        if len(path) == len(nums):
            result.append(path[:])
            return

        for i in range(len(nums)):      # every index, every time
            if used[i]:
                continue
            used[i] = True              # choose
            path.append(nums[i])
            backtrack()                 # explore
            path.pop()                  # un-choose: BOTH
            used[i] = False

    backtrack()
    return result

def permutations_unique(nums):
    """Duplicate inputs: equal values must be consumed left to right."""
    nums.sort()
    result, path = [], []
    used = [False] * len(nums)

    def backtrack():
        if len(path) == len(nums):
            result.append(path[:])
            return

        for i in range(len(nums)):
            if used[i]:
                continue
            # Use a duplicate only if its predecessor is already in the path.
            if i > 0 and nums[i] == nums[i - 1] and not used[i - 1]:
                continue
            used[i] = True
            path.append(nums[i])
            backtrack()
            path.pop()
            used[i] = False

    backtrack()
    return result

def next_permutation(nums):
    """Next lexicographic order, in place, O(n) time and O(1) space."""
    n = len(nums)

    pivot = n - 2                       # 1. rightmost non-descending step
    while pivot >= 0 and nums[pivot] >= nums[pivot + 1]:
        pivot -= 1

    if pivot >= 0:
        successor = n - 1               # 2. rightmost element bigger than it
        while nums[successor] <= nums[pivot]:
            successor -= 1
        nums[pivot], nums[successor] = nums[successor], nums[pivot]   # 3. swap

    nums[pivot + 1:] = reversed(nums[pivot + 1:])                     # 4. reverse
```

```java
import java.util.*;

public class PermutationsPattern {
    public static List<List<Integer>> permute(int[] nums) {
        List<List<Integer>> result = new ArrayList<>();
        backtrack(nums, new boolean[nums.length], new ArrayList<>(), result);
        return result;
    }

    private static void backtrack(int[] nums, boolean[] used,
                                  List<Integer> path, List<List<Integer>> result) {
        if (path.size() == nums.length) {
            result.add(new ArrayList<>(path));      // a COPY
            return;
        }
        for (int i = 0; i < nums.length; i++) {     // every index, every time
            if (used[i]) continue;
            used[i] = true;                          // choose
            path.add(nums[i]);
            backtrack(nums, used, path, result);     // explore
            path.remove(path.size() - 1);            // un-choose: BOTH
            used[i] = false;
        }
    }

    public static void nextPermutation(int[] nums) {
        int n = nums.length, pivot = n - 2;
        while (pivot >= 0 && nums[pivot] >= nums[pivot + 1]) pivot--;

        if (pivot >= 0) {
            int successor = n - 1;
            while (nums[successor] <= nums[pivot]) successor--;
            int t = nums[pivot]; nums[pivot] = nums[successor]; nums[successor] = t;
        }

        for (int l = pivot + 1, r = n - 1; l < r; l++, r--) {
            int t = nums[l]; nums[l] = nums[r]; nums[r] = t;
        }
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

void backtrackPermute(const vector<int>& nums, vector<bool>& used,
                      vector<int>& path, vector<vector<int>>& result) {
    if (path.size() == nums.size()) {
        result.push_back(path);
        return;
    }
    for (int i = 0; i < (int)nums.size(); ++i) {    // every index, every time
        if (used[i]) continue;
        used[i] = true;                              // choose
        path.push_back(nums[i]);
        backtrackPermute(nums, used, path, result);  // explore
        path.pop_back();                             // un-choose: BOTH
        used[i] = false;
    }
}

vector<vector<int>> permute(const vector<int>& nums) {
    vector<vector<int>> result;
    vector<int> path;
    vector<bool> used(nums.size(), false);
    backtrackPermute(nums, used, path, result);
    return result;
}

void nextPermutation(vector<int>& nums) {
    int n = (int)nums.size(), pivot = n - 2;
    while (pivot >= 0 && nums[pivot] >= nums[pivot + 1]) --pivot;

    if (pivot >= 0) {
        int successor = n - 1;
        while (nums[successor] <= nums[pivot]) --successor;
        swap(nums[pivot], nums[successor]);
    }
    reverse(nums.begin() + pivot + 1, nums.end());
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Permutations (Optimal) |
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

### Problem — Permutations (LeetCode 46)
Given an array of **distinct** integers, return all possible permutations.

### Thought Process
1. Order matters, so a `start` index is wrong — we must be able to pick a smaller index after a larger one.
2. Track `used[]` and loop over **every** index, skipping the ones already taken.
3. Every path of length `n` is a valid permutation, so nothing is ever filtered out.
4. Record only at full length — unlike subsets, intermediate nodes are not answers.
5. Un-choose must reset both `path` and `used[i]`.

### Dry Run

Input: `nums = [1, 2, 3]`

| depth 0 pick | depth 1 pick | depth 2 pick | recorded |
|--------------|--------------|--------------|----------|
| `1` | `2` | `3` | **`[1,2,3]`** |
| `1` | `3` | `2` | **`[1,3,2]`** |
| `2` | `1` | `3` | **`[2,1,3]`** |
| `2` | `3` | `1` | **`[2,3,1]`** |
| `3` | `1` | `2` | **`[3,1,2]`** |
| `3` | `2` | `1` | **`[3,2,1]`** |

Output: **`[[1,2,3], [1,3,2], [2,1,3], [2,3,1], [3,1,2], [3,2,1]]`** ✓ — that is `3! = 6`.

Trace the first backtrack in detail. After recording `[1,2,3]`:

```text
return from depth 3 → pop 3, used[2] = false      path = [1,2]
return from depth 2 → pop 2, used[1] = false      path = [1]
now the depth-1 loop continues at i = 2 → picks 3 → path = [1,3]
```

That reset of `used[1]` is what makes `2` available again for the `[1,3,2]` branch. Skipping it would leave `2` permanently consumed and the output would be missing four of the six permutations.

### Visualization

```text
                       []
        ┌───────────────┼───────────────┐
       [1]             [2]             [3]
      ┌─┴─┐           ┌─┴─┐           ┌─┴─┐
   [1,2] [1,3]     [2,1] [2,3]     [3,1] [3,2]
     │     │         │     │         │     │
 [1,2,3][1,3,2] [2,1,3][2,3,1] [3,1,2][3,2,1]

3 choices → 2 → 1  =  6 leaves, all recorded
```

### Code

```go
func permute(nums []int) [][]int {
    result := [][]int{}
    path := []int{}
    used := make([]bool, len(nums))

    var backtrack func()
    backtrack = func() {
        if len(path) == len(nums) { // only full-length paths are answers
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        // Every index each time: order matters, so we may pick a smaller
        // index after a larger one. That is why there is no `start`.
        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }

            used[i] = true                // choose
            path = append(path, nums[i])

            backtrack()                   // explore

            path = path[:len(path)-1]     // un-choose: BOTH the path...
            used[i] = false               // ...and the flag
        }
    }

    backtrack()
    return result
}
```

```python
def permute(nums):
    result, path = [], []
    used = [False] * len(nums)

    def backtrack():
        if len(path) == len(nums):
            result.append(path[:])      # a COPY
            return

        for i in range(len(nums)):      # every index, every time
            if used[i]:
                continue
            used[i] = True              # choose
            path.append(nums[i])
            backtrack()                 # explore
            path.pop()                  # un-choose: BOTH
            used[i] = False

    backtrack()
    return result
```

### Complexity
Time **O(n · n!)** — `n!` permutations, each copied in O(n). That is optimal, since the output is that large. Space O(n) for the recursion, path and flags.

---

## 10. Solved Example 2

### Problem — Permutations II (LeetCode 47)
Same, but the input **may contain duplicates**, and the result must contain each distinct permutation exactly once.

### Thought Process
1. With `[1, 1, 2]`, picking the first `1` then the second gives the same permutation as picking them the other way round.
2. Sort so equal values are adjacent, then add one skip rule.
3. **Use a duplicate only if its identical predecessor is already in the path**: `if i > 0 && nums[i] == nums[i-1] && !used[i-1] { continue }`.
4. That forces equal values to be consumed strictly left to right, so exactly one of their interchangeable orderings survives.
5. Everything else is unchanged from Example 1.

### Dry Run

Input: `nums = [1, 1, 2]` (already sorted) — call the two ones `1ₐ` (index 0) and `1ᵦ` (index 1).

| depth | path | i | `used[i-1]` | decision |
|-------|------|---|-------------|----------|
| 0 | `[]` | 0 (`1ₐ`) | — | take → `used[0] = true` |
| 1 | `[1]` | 1 (`1ᵦ`) | `used[0] = **true**` | rule says skip only if `!used[0]`, which is false → **allowed** |
| 2 | `[1,1]` | 2 (`2`) | — | take → record **`[1,1,2]`** |
| 1 (back) | `[1]` | 2 (`2`) | — | take → `[1,2]` |
| 2 | `[1,2]` | 1 (`1ᵦ`) | `used[0] = true` → allowed | record **`[1,2,1]`** |
| 0 (back) | `[]` | 1 (`1ᵦ`) | `used[0] = **false**` (undone) | `nums[1]==nums[0] && !used[0]` → **SKIP** |
| 0 | `[]` | 2 (`2`) | — | take → `[2]` |
| 1 | `[2]` | 0 (`1ₐ`) | — | take → `[2,1]` |
| 2 | `[2,1]` | 1 (`1ᵦ`) | `used[0] = true` → allowed | record **`[2,1,1]`** |
| 1 (back) | `[2]` | 1 (`1ᵦ`) | `used[0] = false` | **SKIP** |

Output: **`[[1,1,2], [1,2,1], [2,1,1]]`** ✓ — three distinct permutations, not `3! = 6`.

**The rule, read carefully.** The two decisive rows are the ones where `i = 1`:

- Inside the `1ₐ` branch, `used[0]` is `true` — the predecessor is *above me in the path*, so taking `1ᵦ` extends it in canonical order. **Allowed.**
- Back at the top level, `used[0]` is `false` — `1ₐ` was already tried and undone *at this level*, so starting a branch with `1ᵦ` would repeat exactly what `1ₐ` already did. **Skipped.**

### Visualization

```text
sorted: [1ₐ, 1ᵦ, 2]

top level:   take 1ₐ  ✓        take 1ᵦ  ✗ (predecessor undone at this level)
                                        take 2   ✓

inside 1ₐ:   take 1ᵦ  ✓ (predecessor is in the path above → canonical)

results: [1,1,2]  [1,2,1]  [2,1,1]      — 3, not 6
```

### Code

```go
func permuteUnique(nums []int) [][]int {
    // Sorting puts equal values next to each other, which the skip needs.
    sort.Ints(nums)

    result := [][]int{}
    path := []int{}
    used := make([]bool, len(nums))

    var backtrack func()
    backtrack = func() {
        if len(path) == len(nums) {
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        for i := 0; i < len(nums); i++ {
            if used[i] {
                continue
            }
            // Use a duplicate only if its identical predecessor is already
            // in the path. If the predecessor was undone at THIS level,
            // starting with this copy would repeat that same branch.
            if i > 0 && nums[i] == nums[i-1] && !used[i-1] {
                continue
            }

            used[i] = true
            path = append(path, nums[i])
            backtrack()
            path = path[:len(path)-1]
            used[i] = false
        }
    }

    backtrack()
    return result
}
```

```python
def permuteUnique(nums):
    nums.sort()                         # equal values must be adjacent
    result, path = [], []
    used = [False] * len(nums)

    def backtrack():
        if len(path) == len(nums):
            result.append(path[:])
            return

        for i in range(len(nums)):
            if used[i]:
                continue
            # Only extend a duplicate whose predecessor is already in the path.
            if i > 0 and nums[i] == nums[i - 1] and not used[i - 1]:
                continue
            used[i] = True
            path.append(nums[i])
            backtrack()
            path.pop()
            used[i] = False

    backtrack()
    return result
```

### Complexity
Time **O(n · n!)** worst case (all distinct); much less when duplicates collapse branches. Space O(n).

---

## 11. Solved Example 3

### Problem — Next Permutation (LeetCode 31)
Rearrange the numbers into the **next** lexicographically greater permutation, in place. If none exists, rearrange into the smallest (ascending) order.

### Thought Process
1. Enumerating all `n!` permutations to find the next one is absurd — `n = 12` alone is 479 million.
2. Think about what "next" means. A **descending** suffix is already the largest arrangement of its elements, so nothing inside it can increase. The change must happen just before it.
3. Four steps:
   - **Find the pivot**: the rightmost index `i` with `nums[i] < nums[i+1]`. Everything to its right is descending.
   - If no pivot exists, the whole array is descending — it is the last permutation, so reverse it to get the first.
   - **Find the successor**: the rightmost element greater than the pivot. Swapping gives the smallest possible increase at that position.
   - **Reverse the suffix**: it was descending, so reversing makes it ascending — the smallest arrangement of what remains.
4. O(n) time, O(1) space.

### Dry Run

Input: `nums = [1, 3, 2]`

| step | action | array |
|------|--------|-------|
| — | start | `[1, 3, 2]` |
| 1 | find pivot: `nums[1]=3 >= nums[2]=2` → move left; `nums[0]=1 < nums[1]=3` → **pivot = 0** | `[1, 3, 2]` |
| 2 | find rightmost element `> 1`: `nums[2] = 2` → **successor = 2** | `[1, 3, 2]` |
| 3 | swap pivot and successor | `[2, 3, 1]` |
| 4 | reverse the suffix from index 1: `[3,1] → [1,3]` | **`[2, 1, 3]`** |

Output: **`[2, 1, 3]`** ✓

Verify by listing permutations of `{1,2,3}` in order: `123, 132, 213, 231, 312, 321`. The one after `132` is indeed `213`. ✓

**The no-pivot case**, `nums = [3, 2, 1]`: scanning left from index 1, every `nums[i] >= nums[i+1]`, so `pivot` falls to `−1`. Steps 2 and 3 are skipped, and step 4 reverses from index `0`, giving **`[1, 2, 3]`** — the smallest permutation. ✓

**A case with duplicates**, `nums = [1, 1, 5]`: pivot is index 1 (`1 < 5`); the rightmost element greater than `1` is `5` at index 2; swap → `[1, 5, 1]`; reverse the one-element suffix → **`[1, 5, 1]`**. ✓

### Visualization

```text
[1, 3, 2]
    ↑  └─ descending suffix: already maximal, cannot grow
  pivot = 0 (the last place where the sequence rises)

step 2: rightmost element > 1  is  2
step 3: swap        →  [2, 3, 1]
step 4: reverse the suffix [3,1]  →  [1,3]

        →  [2, 1, 3]

swapping with the RIGHTMOST greater element gives the smallest bump;
reversing the suffix makes the tail as small as possible
```

### Code

```go
func nextPermutation(nums []int) {
    n := len(nums)

    // 1. Find the pivot: the rightmost index that is still ascending.
    //    Everything to its right is non-increasing, hence already maximal.
    pivot := n - 2
    for pivot >= 0 && nums[pivot] >= nums[pivot+1] {
        pivot--
    }

    if pivot >= 0 {
        // 2. Find the rightmost element greater than the pivot. It is the
        //    smallest value that still increases this position.
        successor := n - 1
        for nums[successor] <= nums[pivot] {
            successor--
        }
        // 3. Swap: the position now holds the smallest possible larger value.
        nums[pivot], nums[successor] = nums[successor], nums[pivot]
    }
    // If pivot < 0 the array was fully descending — the last permutation —
    // and step 4 alone turns it into the first.

    // 4. The suffix is descending; reversing makes it ascending, which is
    //    the smallest arrangement of those elements.
    for left, right := pivot+1, n-1; left < right; left, right = left+1, right-1 {
        nums[left], nums[right] = nums[right], nums[left]
    }
}
```

```python
def nextPermutation(nums):
    n = len(nums)

    # 1. Rightmost ascending step; everything after it is already maximal.
    pivot = n - 2
    while pivot >= 0 and nums[pivot] >= nums[pivot + 1]:
        pivot -= 1

    if pivot >= 0:
        # 2. Rightmost element greater than the pivot = smallest valid bump.
        successor = n - 1
        while nums[successor] <= nums[pivot]:
            successor -= 1
        nums[pivot], nums[successor] = nums[successor], nums[pivot]   # 3. swap

    # 4. The suffix was descending; reversing gives the smallest tail.
    nums[pivot + 1:] = reversed(nums[pivot + 1:])
```

### Complexity
Time **O(n)** — each step scans at most once. Space **O(1)**, fully in place.

> Calling this repeatedly walks every permutation in lexicographic order using constant extra memory, which is how `std::next_permutation` works. It is the right tool whenever you need to *iterate* permutations rather than *materialise* them.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 46 | Permutations | Easy | Core backtracking application |
| 47 | Permutations II | Easy | Core backtracking application |
| 31 | Next Permutation | Medium | Core backtracking application |
| 60 | Permutation Sequence | Medium | Core backtracking application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Permutations logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Permutations (Backtracking).
- **Signal:** permutations, arrange, backtracking, used array, swap.
- **Move:** DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.
- **Cost:** O(branches^depth) time, O(depth) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Permutations invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Permutations
FAMILY : Backtracking (Intermediate)
WHEN   : permutations, arrange, backtracking, used array, swap
DO     : DFS over the decision tree with pruning. Each recursion makes a choice, recurses
TIME   : O(branches^depth)    SPACE: O(depth)
PRACTICE: 46, 47, 31, 60
```

---

*Part of the DSA Patterns Handbook — pattern 71 of 100.*
