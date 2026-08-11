# 69 · Subsets

> **One-liner:** Include/exclude each element to enumerate the power set.

---

## 1. Overview

### Definition
The **Subsets** pattern belongs to the *Backtracking* family. Include/exclude each element to enumerate the power set.

### Intuition
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Why it works
Build candidates incrementally; prune branches that can't lead to a solution (choose → explore → un-choose). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Backtracking solves configuration/constraint problems: test-case generation, SAT-style feasibility, resource allocation, and puzzle/AI move generation. Pruning is the difference between feasible and intractable in production solvers.

---

## 2. Recognition Signals

### Keywords
subsets, power set, backtracking, include exclude, combinations.

### Constraints
- Input size where the brute-force complexity would time out — the Subsets optimization is the intended solution.
- Structural hints in the statement that match this family (Backtracking).

### Hidden clues
- The problem can be reframed so the Subsets invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Subsets is the upgrade.
- The wording maps onto: subsets, power set, backtracking, include exclude, combinations.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"List every possible selection."* — every subset, every combination, every arrangement.

### Intuition
There are `2ⁿ` subsets of an `n`-element set, and each corresponds to a binary number: bit `i` says whether element `i` is in.

### Algorithm
1. For each integer `mask` from `0` to `2ⁿ − 1`:
2. &nbsp;&nbsp;Start an empty list.
3. &nbsp;&nbsp;For each bit position `i`, if bit `i` of `mask` is set, append `nums[i]`.
4. &nbsp;&nbsp;Add the list to the result.

### Complexity
- Time: **O(n · 2ⁿ)** — and that is optimal, because the output itself has that size.
- Space: O(n · 2ⁿ) for the result.

### Drawbacks
- For plain subsets this is genuinely fine — and worth knowing.
- But it falls apart the moment the problem adds **constraints**: "no duplicates in the output", "sum to a target", "no two queens attack". Bit enumeration generates everything and can only filter *afterwards*, so it explores branches that were doomed from their first element.
- It also doesn't generalise past `n = 64`, and it can't express variable-length choices like "any number of coins".

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Build the answer one decision at a time; when a decision leads nowhere, undo it and try the next.**

That undo step is what "backtracking" names. It is depth-first search over a tree of decisions, where the path from the root to the current node is the partial answer.

```text
                    []
           /                 \
      include 1            exclude 1
        [1]                    []
      /     \                /     \
   [1,2]     [1]           [2]      []
```

### The thought process

```text
We need    : every valid selection.
Obvious way: enumerate all 2^n masks and filter.
Fine for subsets, bad in general: constraints can't prune a mask
             after the fact, and variable-length choices don't fit.
Notice     : building incrementally lets us check a constraint the
             MOMENT it breaks, discarding a whole subtree at once.
Therefore  : recurse over decisions, and undo each on the way back.
Now        : same worst case, but pruning often makes it far faster —
             and the code expresses the constraints directly.
```

### The universal template

Every problem in this family is these five lines with different contents:

```text
backtrack(path, choices):
    1. if the path is a complete answer:  record a COPY, return
    2. for each candidate in choices:
    3.     if the candidate is invalid:   skip it            ← the pruning
    4.     apply it to path               ← choose
    5.     backtrack(path, remaining choices)                ← explore
    6.     undo it from path              ← un-choose
```

Steps 4 and 6 must be exact mirrors. If `choose` appends one element, `un-choose` removes exactly one.

### The bug that hits everyone: record a *copy*

```go
// WRONG
result = append(result, path)
```

`path` is a slice that keeps being mutated. Storing it stores a **reference**, so every recorded answer ends up pointing at the same underlying array — and after the recursion unwinds, they all read as empty or garbage.

```go
// RIGHT
snapshot := make([]int, len(path))
copy(snapshot, path)
result = append(result, snapshot)
```

The same trap exists in Python (`result.append(path)` versus `result.append(path[:])`) and Java (`new ArrayList<>(path)`). **When you record, you must freeze.**

### The `start` index, and why it is not the same as `visited`

For *subsets and combinations*, order does not matter — `[1,2]` and `[2,1]` are the same answer. Passing a `start` index and looping from it forces every selection into increasing index order, which generates each combination exactly once:

```text
for i := start; i < len(nums); i++ {
    ...
    backtrack(i+1, ...)   // i+1: each element used at most once
    ...
}
```

For *permutations*, order **does** matter, so you loop over all indices and track a `used[]` array instead. That single difference — `start` versus `used` — is what separates the two families.

| Problem type | Loop control | Recurse with |
|---|---|---|
| Subsets / combinations | `i := start` | `i + 1` |
| Combinations with reuse | `i := start` | `i` (reuse allowed) |
| Permutations | all `i`, skip `used[i]` | mark, recurse, unmark |

### Skipping duplicates: sort first, then skip equal siblings

When the input contains duplicates, the same answer can be produced by different branches. The fix is mechanical:

1. **Sort** so equal values sit together.
2. Inside the loop, skip a value equal to its predecessor **at the same level**:

```go
if i > start && nums[i] == nums[i-1] {
    continue
}
```

`i > start`, not `i > 0`. The **first** candidate at each level is always allowed; only *repeats within the same loop* are skipped. Using `i > 0` would suppress legitimate uses of a value deeper in the tree.

### How should I recognize this?

```text
If you see...
  "all subsets / combinations / permutations", "generate every ..."
  "find all ways to ...", "N-Queens", "word search", "sudoku"
  the answer is a LIST of arrangements, not a single number
        ↓
Think about...
  "What is one decision? What makes an answer complete?
   What makes a partial answer already doomed?"
        ↓
Use...
  choose → explore → un-choose
  record a COPY, never the live path
  start index for combinations, used[] for permutations
  sort + skip equal siblings for duplicate inputs
```

> If the question asks **how many** rather than **which ones**, stop and consider DP. Counting rarely needs to enumerate.

### Visual explanation

```svg
<svg viewBox="0 0 640 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-69" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="18" text-anchor="middle" font-weight="700" fill="#1e293b">Subsets of [1,2]: at each element, exclude or include</text>
  <!-- edges -->
  <line x1="320" y1="50" x2="170" y2="100" stroke="#475569" marker-end="url(#a-69)"/>
  <line x1="320" y1="50" x2="470" y2="100" stroke="#475569" marker-end="url(#a-69)"/>
  <line x1="170" y1="130" x2="90"  y2="190" stroke="#475569" marker-end="url(#a-69)"/>
  <line x1="170" y1="130" x2="250" y2="190" stroke="#475569" marker-end="url(#a-69)"/>
  <line x1="470" y1="130" x2="390" y2="190" stroke="#475569" marker-end="url(#a-69)"/>
  <line x1="470" y1="130" x2="550" y2="190" stroke="#475569" marker-end="url(#a-69)"/>
  <!-- edge labels -->
  <text x="230" y="78"  text-anchor="middle" fill="#64748b">skip 1</text>
  <text x="410" y="78"  text-anchor="middle" fill="#64748b">take 1</text>
  <text x="118" y="168" text-anchor="middle" fill="#64748b">skip 2</text>
  <text x="222" y="168" text-anchor="middle" fill="#64748b">take 2</text>
  <text x="418" y="168" text-anchor="middle" fill="#64748b">skip 2</text>
  <text x="522" y="168" text-anchor="middle" fill="#64748b">take 2</text>
  <!-- nodes -->
  <rect x="285" y="35"  width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="55"  text-anchor="middle" fill="#1e293b">{ }</text>
  <rect x="135" y="100" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="170" y="120" text-anchor="middle" fill="#1e293b">{ }</text>
  <rect x="435" y="100" width="70" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="470" y="120" text-anchor="middle" fill="#1e293b">{1}</text>
  <rect x="55"  y="190" width="70" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="90"  y="210" text-anchor="middle" fill="#1e293b">{ }</text>
  <rect x="215" y="190" width="70" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="250" y="210" text-anchor="middle" fill="#1e293b">{2}</text>
  <rect x="355" y="190" width="70" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="390" y="210" text-anchor="middle" fill="#1e293b">{1}</text>
  <rect x="515" y="190" width="70" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="550" y="210" text-anchor="middle" fill="#1e293b">{1,2}</text>
  <text x="320" y="252" text-anchor="middle" fill="#059669" font-weight="700">leaves = all 2^n = 4 subsets</text>
</svg>
```

```text
nums = [1, 2, 3], generating all subsets

                      []
        ┌──────────────┼──────────────┐
       [1]            [2]            [3]
     ┌──┴──┐           │
  [1,2]  [1,3]      [2,3]
     │
 [1,2,3]

every NODE is a valid subset, so we record on entry, not only at leaves
the `start` index is what stops [2,1] from ever being generated
```

### Interview explanation
"I'll use backtracking: build the answer one decision at a time, and undo each decision on the way back out. The template is choose, explore, un-choose. Two details matter most. First, when I record an answer I must store a copy — the path keeps mutating, so storing a reference would leave every result pointing at the same array. Second, I pass a `start` index and recurse with `i+1`, which forces selections into increasing index order and generates each combination exactly once; permutations instead loop over all indices with a `used` array, because there order matters. If the input has duplicates I sort first and skip a value equal to its predecessor when `i > start` — the first candidate at each level is always allowed, only repeats within the same loop are skipped. It's O(n · 2ⁿ) for subsets, which is optimal since that's the output size."

---

## 5. Generic Templates

> Choose → explore → un-choose. Record a copy. `start` for combinations, `used` for permutations.

```go
// Subsets generates every subset. Each node of the decision tree is a
// valid answer, so we record on entry rather than only at the leaves.
func Subsets(nums []int) [][]int {
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        // Record a COPY: `path` keeps mutating underneath us.
        snapshot := make([]int, len(path))
        copy(snapshot, path)
        result = append(result, snapshot)

        for i := start; i < len(nums); i++ {
            path = append(path, nums[i])   // choose
            backtrack(i + 1)               // explore (i+1: no reuse)
            path = path[:len(path)-1]      // un-choose
        }
    }

    backtrack(0)
    return result
}

// SubsetsWithDuplicates sorts first, then skips equal siblings.
func SubsetsWithDuplicates(nums []int) [][]int {
    sort.Ints(nums) // equal values must be adjacent for the skip to work
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        snapshot := make([]int, len(path))
        copy(snapshot, path)
        result = append(result, snapshot)

        for i := start; i < len(nums); i++ {
            // i > start, NOT i > 0: the first candidate at each level is
            // always allowed; only repeats within this loop are skipped.
            if i > start && nums[i] == nums[i-1] {
                continue
            }
            path = append(path, nums[i])
            backtrack(i + 1)
            path = path[:len(path)-1]
        }
    }

    backtrack(0)
    return result
}

// Permutations uses `used` instead of `start`, because order matters.
func Permutations(nums []int) [][]int {
    result := [][]int{}
    path := []int{}
    used := make([]bool, len(nums))

    var backtrack func()
    backtrack = func() {
        if len(path) == len(nums) { // complete only at full length
            snapshot := make([]int, len(path))
            copy(snapshot, path)
            result = append(result, snapshot)
            return
        }

        for i := 0; i < len(nums); i++ { // every index, not just from start
            if used[i] {
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
def subsets(nums):
    """Every node of the decision tree is a valid subset."""
    result, path = [], []

    def backtrack(start):
        result.append(path[:])          # a COPY: path keeps mutating

        for i in range(start, len(nums)):
            path.append(nums[i])        # choose
            backtrack(i + 1)            # explore (i+1: no reuse)
            path.pop()                  # un-choose

    backtrack(0)
    return result

def subsets_with_duplicates(nums):
    nums.sort()                         # equal values must be adjacent
    result, path = [], []

    def backtrack(start):
        result.append(path[:])
        for i in range(start, len(nums)):
            # i > start, NOT i > 0
            if i > start and nums[i] == nums[i - 1]:
                continue
            path.append(nums[i])
            backtrack(i + 1)
            path.pop()

    backtrack(0)
    return result

def permutations(nums):
    """Order matters, so track `used` instead of a start index."""
    result, path = [], []
    used = [False] * len(nums)

    def backtrack():
        if len(path) == len(nums):
            result.append(path[:])
            return
        for i in range(len(nums)):
            if used[i]:
                continue
            used[i] = True
            path.append(nums[i])
            backtrack()
            path.pop()
            used[i] = False

    backtrack()
    return result
```

```java
import java.util.*;

public class SubsetsPattern {
    public static List<List<Integer>> subsets(int[] nums) {
        List<List<Integer>> result = new ArrayList<>();
        backtrack(nums, 0, new ArrayList<>(), result);
        return result;
    }

    private static void backtrack(int[] nums, int start,
                                  List<Integer> path, List<List<Integer>> result) {
        result.add(new ArrayList<>(path));       // a COPY, not the live list

        for (int i = start; i < nums.length; i++) {
            path.add(nums[i]);                   // choose
            backtrack(nums, i + 1, path, result); // explore
            path.remove(path.size() - 1);        // un-choose
        }
    }

    public static List<List<Integer>> subsetsWithDup(int[] nums) {
        Arrays.sort(nums);                       // equal values adjacent
        List<List<Integer>> result = new ArrayList<>();
        backtrackDup(nums, 0, new ArrayList<>(), result);
        return result;
    }

    private static void backtrackDup(int[] nums, int start,
                                     List<Integer> path, List<List<Integer>> result) {
        result.add(new ArrayList<>(path));
        for (int i = start; i < nums.length; i++) {
            if (i > start && nums[i] == nums[i - 1]) continue;   // i > start
            path.add(nums[i]);
            backtrackDup(nums, i + 1, path, result);
            path.remove(path.size() - 1);
        }
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

void backtrackSubsets(const vector<int>& nums, int start,
                      vector<int>& path, vector<vector<int>>& result) {
    result.push_back(path);                      // a COPY (push_back copies)

    for (int i = start; i < (int)nums.size(); ++i) {
        path.push_back(nums[i]);                 // choose
        backtrackSubsets(nums, i + 1, path, result);  // explore
        path.pop_back();                         // un-choose
    }
}

vector<vector<int>> subsets(const vector<int>& nums) {
    vector<vector<int>> result;
    vector<int> path;
    backtrackSubsets(nums, 0, path, result);
    return result;
}

void backtrackDup(const vector<int>& nums, int start,
                  vector<int>& path, vector<vector<int>>& result) {
    result.push_back(path);
    for (int i = start; i < (int)nums.size(); ++i) {
        if (i > start && nums[i] == nums[i - 1]) continue;   // i > start
        path.push_back(nums[i]);
        backtrackDup(nums, i + 1, path, result);
        path.pop_back();
    }
}

vector<vector<int>> subsetsWithDup(vector<int> nums) {
    sort(nums.begin(), nums.end());              // equal values adjacent
    vector<vector<int>> result;
    vector<int> path;
    backtrackDup(nums, 0, path, result);
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Subsets (Optimal) |
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

### Problem — Subsets (LeetCode 78)
Given an array of **distinct** integers, return all possible subsets (the power set).

### Thought Process
1. Each element is one binary decision: in or out. That is a decision tree of depth `n`.
2. Unlike most backtracking problems, **every node of the tree is a valid answer** — a partial path *is* a subset. So record on entry, not only at the leaves.
3. Pass a `start` index and recurse with `i + 1`, which forces increasing index order. That is what stops `[2,1]` from ever being generated alongside `[1,2]`.
4. Record a **copy** — `path` keeps mutating as the recursion unwinds.
5. Choose, explore, un-choose.

### Dry Run

Input: `nums = [1, 2, 3]`

| call | path on entry | recorded | loop does |
|------|---------------|----------|-----------|
| `backtrack(0)` | `[]` | **`[]`** | tries i=0,1,2 |
| `backtrack(1)` via i=0 | `[1]` | **`[1]`** | tries i=1,2 |
| `backtrack(2)` via i=1 | `[1,2]` | **`[1,2]`** | tries i=2 |
| `backtrack(3)` via i=2 | `[1,2,3]` | **`[1,2,3]`** | loop ends |
| back at `backtrack(1)`, i=2 | `[1,3]` | **`[1,3]`** | loop ends |
| back at `backtrack(0)`, i=1 | `[2]` | **`[2]`** | tries i=2 |
| `backtrack(3)` via i=2 | `[2,3]` | **`[2,3]`** | loop ends |
| back at `backtrack(0)`, i=2 | `[3]` | **`[3]`** | loop ends |

Output: **`[[], [1], [1,2], [1,2,3], [1,3], [2], [2,3], [3]]`** ✓

That is 8 subsets = `2³`. ✓

Follow the un-choose: after recording `[1,2,3]` the path pops back to `[1,2]`, then to `[1]`, and only then does the loop at that level try `i = 2` to build `[1,3]`. Without the pop, `[1,3]` would come out as `[1,2,3,3]`.

### Visualization

```text
                      []
        ┌──────────────┼──────────────┐
       [1]            [2]            [3]
     ┌──┴──┐           │
  [1,2]  [1,3]      [2,3]
     │
 [1,2,3]

every node is recorded — 8 nodes, 8 subsets
recursing with i+1 means [2,1] is never even considered
```

### Code

```go
func subsets(nums []int) [][]int {
    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        // Every node is a valid subset, so record on entry.
        // Store a COPY: `path` keeps mutating underneath us.
        snapshot := make([]int, len(path))
        copy(snapshot, path)
        result = append(result, snapshot)

        for i := start; i < len(nums); i++ {
            path = append(path, nums[i]) // choose
            backtrack(i + 1)             // explore; i+1 means no reuse
            path = path[:len(path)-1]    // un-choose
        }
    }

    backtrack(0)
    return result
}
```

```python
def subsets(nums):
    result, path = [], []

    def backtrack(start):
        result.append(path[:])          # a COPY; every node is a valid subset

        for i in range(start, len(nums)):
            path.append(nums[i])        # choose
            backtrack(i + 1)            # explore; i+1 means no reuse
            path.pop()                  # un-choose

    backtrack(0)
    return result
```

### Complexity
Time **O(n · 2ⁿ)** — there are `2ⁿ` subsets and copying each costs O(n). That is optimal, since the output itself is that large. Space O(n) for the recursion and path, excluding the output.

---

## 10. Solved Example 2

### Problem — Subsets II (LeetCode 90)
Same as above, but the input **may contain duplicates**, and the result must not contain duplicate subsets.

### Thought Process
1. With `[1,2,2]`, picking the first `2` or the second `2` produces the identical subset `[2]` by two different branches.
2. Filtering afterwards works but is wasteful; better to never generate the duplicate.
3. **Sort first**, so equal values are adjacent and the duplicate branches become *siblings* in the loop.
4. Skip a candidate equal to its predecessor **within the same loop**: `if i > start && nums[i] == nums[i-1] { continue }`.
5. `i > start`, not `i > 0` — the first candidate at each level must always be allowed, or `[2,2]` could never be built.

### Dry Run

Input: `nums = [1, 2, 2]` (already sorted)

| call | path | recorded | loop decisions |
|------|------|----------|----------------|
| `backtrack(0)` | `[]` | **`[]`** | i=0 (`1`) allowed; i=1 (`2`) allowed; i=2 (`2`): `i>start` (2>0) and `nums[2]==nums[1]` → **skip** |
| `backtrack(1)` via i=0 | `[1]` | **`[1]`** | i=1 (`2`) allowed; i=2: `2>1` and equal → **skip** |
| `backtrack(2)` via i=1 | `[1,2]` | **`[1,2]`** | i=2: `i>start` is `2>2` = false → **allowed** |
| `backtrack(3)` via i=2 | `[1,2,2]` | **`[1,2,2]`** | loop ends |
| `backtrack(2)` via i=1 (top level) | `[2]` | **`[2]`** | i=2: `2>2` false → **allowed** |
| `backtrack(3)` via i=2 | `[2,2]` | **`[2,2]`** | loop ends |

Output: **`[[], [1], [1,2], [1,2,2], [2], [2,2]]`** ✓

Six subsets, no duplicates. Without the skip we would also get a second `[2]` and a second `[1,2]`.

**Why `i > start` and not `i > 0`.** Look at the row producing `[1,2,2]`: there `start = 2` and `i = 2`, so `i > start` is false and the second `2` is used. With an `i > 0` test it would have been skipped, and `[1,2,2]` — a legitimate subset — would never be generated.

### Visualization

```text
sorted: [1, 2, 2]
              indices 0  1  2

level 0 loop:   i=0 (1) ✓    i=1 (2) ✓    i=2 (2) ✗ skip — same value as i=1
                                              at the SAME level

but deeper, with start=2:  i=2 is the FIRST candidate → allowed
                           → [2,2] and [1,2,2] are still built
```

### Code

```go
func subsetsWithDup(nums []int) [][]int {
    // Sorting puts equal values next to each other, which is what makes
    // the "skip my equal predecessor" test work.
    sort.Ints(nums)

    result := [][]int{}
    path := []int{}

    var backtrack func(start int)
    backtrack = func(start int) {
        snapshot := make([]int, len(path))
        copy(snapshot, path)
        result = append(result, snapshot)

        for i := start; i < len(nums); i++ {
            // i > start, NOT i > 0: the first candidate at each level is
            // always allowed; only repeats within THIS loop are skipped.
            if i > start && nums[i] == nums[i-1] {
                continue
            }

            path = append(path, nums[i])
            backtrack(i + 1)
            path = path[:len(path)-1]
        }
    }

    backtrack(0)
    return result
}
```

```python
def subsetsWithDup(nums):
    nums.sort()                         # equal values must be adjacent
    result, path = [], []

    def backtrack(start):
        result.append(path[:])

        for i in range(start, len(nums)):
            # i > start, NOT i > 0
            if i > start and nums[i] == nums[i - 1]:
                continue
            path.append(nums[i])
            backtrack(i + 1)
            path.pop()

    backtrack(0)
    return result
```

### Complexity
Time **O(n · 2ⁿ)** worst case (all distinct); far less when duplicates prune branches. Space O(n) beyond the output.

---

## 11. Solved Example 3

### Problem — Combinations (LeetCode 77)
Return all combinations of `k` numbers chosen from `1..n`.

### Thought Process
1. Same skeleton as subsets, with one change: an answer is complete only when `len(path) == k`, so we record at the **leaves** rather than at every node.
2. The `start` index still enforces increasing order, so each combination appears once.
3. There is an easy and valuable **prune**: if the numbers remaining from `i` to `n` are fewer than the numbers still needed, the branch can never complete. Cutting it early saves a lot of dead recursion.
4. The bound is `i <= n - (k - len(path)) + 1`.
5. Record a copy, as always.

### Dry Run

Input: `n = 4`, `k = 2`

The prune bound at each level: `n − (k − len(path)) + 1`.

| call | path | need | loop bound | branches taken |
|------|------|------|------------|----------------|
| `backtrack(1)` | `[]` | 2 | `4 − 2 + 1 = 3` | i = 1, 2, 3 — **i = 4 pruned** |
| `backtrack(2)` via i=1 | `[1]` | 1 | `4 − 1 + 1 = 4` | i = 2, 3, 4 → records `[1,2]`, `[1,3]`, `[1,4]` |
| `backtrack(3)` via i=2 | `[2]` | 1 | 4 | i = 3, 4 → records `[2,3]`, `[2,4]` |
| `backtrack(4)` via i=3 | `[3]` | 1 | 4 | i = 4 → records `[3,4]` |

Output: **`[[1,2], [1,3], [1,4], [2,3], [2,4], [3,4]]`** ✓

That is `C(4,2) = 6` combinations. ✓

**The prune, made concrete.** At the top level `i = 4` is skipped: starting from `4` leaves only the single number `4`, and we need two. Without the bound we would push `[4]`, recurse, find the loop empty, and return having accomplished nothing. The bound cuts that branch before entering it.

### Visualization

```text
n = 4, k = 2

start=1, path=[]        i can be 1, 2, 3      (4 pruned: only one number left)
   ├── [1] → i = 2,3,4  →  [1,2] [1,3] [1,4]
   ├── [2] → i = 3,4    →  [2,3] [2,4]
   └── [3] → i = 4      →  [3,4]

recording happens only when len(path) == k
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

        // Prune: we still need (k - len(path)) numbers, so there must be
        // at least that many left from i to n.
        need := k - len(path)
        for i := start; i <= n-need+1; i++ {
            path = append(path, i)    // choose
            backtrack(i + 1)          // explore
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
        if len(path) == k:              # complete only at length k
            result.append(path[:])
            return

        # Prune: at least (k - len(path)) numbers must remain from i to n.
        need = k - len(path)
        for i in range(start, n - need + 2):
            path.append(i)              # choose
            backtrack(i + 1)            # explore
            path.pop()                  # un-choose

    backtrack(1)
    return result
```

### Complexity
Time **O(k · C(n, k))** — one copy of length `k` per combination. Space O(k) beyond the output.

> The three examples differ only in *when* you record and *what* you skip: subsets record at every node, combinations record at depth `k`, and duplicate handling adds one skip test. Recognising that the skeleton is fixed is what makes this family feel like one problem instead of twenty.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 78 | Subsets | Easy | Core backtracking application |
| 90 | Subsets II | Easy | Core backtracking application |
| 77 | Combinations | Medium | Core backtracking application |
| 39 | Combination Sum | Medium | Core backtracking application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Subsets logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Subsets (Backtracking).
- **Signal:** subsets, power set, backtracking, include exclude, combinations.
- **Move:** DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.
- **Cost:** O(branches^depth) time, O(depth) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Subsets invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Subsets
FAMILY : Backtracking (Intermediate)
WHEN   : subsets, power set, backtracking, include exclude, combinations
DO     : DFS over the decision tree with pruning. Each recursion makes a choice, recurses
TIME   : O(branches^depth)    SPACE: O(depth)
PRACTICE: 78, 90, 77, 39
```

---

*Part of the DSA Patterns Handbook — pattern 69 of 100.*
