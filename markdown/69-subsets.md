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

### Intuition
Generate all candidates then filter — wasteful, explores invalid branches fully.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Subsets pattern is built to use.

---

## 4. Optimal Approach

### Core idea
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Subsets invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Subsets           : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Subsets problem. I'll dFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next. That brings the complexity down to O(branches^depth) time and O(depth) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Backtracking** family template. Adapt the comparison/condition to the specific problem.

```go
// Subsets via choose/explore/un-choose.
func subsets(nums []int) [][]int {
    res := [][]int{}
    var path []int
    var dfs func(start int)
    dfs = func(start int) {
        cp := make([]int, len(path)); copy(cp, path)
        res = append(res, cp)                 // record current subset
        for i := start; i < len(nums); i++ {
            path = append(path, nums[i])       // choose
            dfs(i + 1)                         // explore
            path = path[:len(path)-1]          // un-choose
        }
    }
    dfs(0)
    return res
}
```

```python
def subsets(nums):
    res, path = [], []
    def dfs(start):
        res.append(path[:])                    # record
        for i in range(start, len(nums)):
            path.append(nums[i])               # choose
            dfs(i + 1)                          # explore
            path.pop()                          # un-choose
    dfs(0)
    return res
```

```java
List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    dfs(nums, 0, new ArrayList<>(), res);
    return res;
}
void dfs(int[] nums, int start, List<Integer> path, List<List<Integer>> res) {
    res.add(new ArrayList<>(path));
    for (int i = start; i < nums.length; i++) {
        path.add(nums[i]);
        dfs(nums, i + 1, path, res);
        path.remove(path.size() - 1);
    }
}
```

```cpp
void dfs(vector<int>& nums, int start, vector<int>& path, vector<vector<int>>& res) {
    res.push_back(path);
    for (int i = start; i < (int)nums.size(); ++i) {
        path.push_back(nums[i]);
        dfs(nums, i + 1, path, res);
        path.pop_back();
    }
}
vector<vector<int>> subsets(vector<int>& nums) {
    vector<vector<int>> res; vector<int> path;
    dfs(nums, 0, path, res);
    return res;
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
Given a set of **distinct** integers, return the full power set (every possible subset).

### Thought Process
1. Every element is a binary choice: include it or not — so the power set has 2^n members.
2. DFS from a `start` index; append a *copy* of the current path at every node (every partial path is itself a valid subset).
3. Loop `i` from `start` onward, choose `nums[i]`, recurse with `i+1`, then un-choose to explore the next branch.

### Dry Run
For `nums = [1,2]`:
- dfs(0): record `[]`; pick 1 → dfs(1): record `[1]`; pick 2 → dfs(2): record `[1,2]`.
- back to dfs(0), pick 2 → dfs(2): record `[2]`.
- Result: `[[], [1], [1,2], [2]]`.

### Visualization
```
[]──▶ include/exclude each index ──▶ power set of 2^n subsets
```

### Code
```python
def subsets(nums):
    res, path = [], []
    def dfs(start):
        res.append(path[:])                    # every node is a subset
        for i in range(start, len(nums)):
            path.append(nums[i])               # choose
            dfs(i + 1)                          # explore
            path.pop()                          # un-choose
    dfs(0)
    return res
```

### Complexity
Time O(n·2^n) to build all 2^n subsets, Space O(n) recursion depth (plus output).

## 10. Solved Example 2

### Problem — Subsets II (LeetCode 90)
The input may contain **duplicates**; return all *unique* subsets.

### Thought Process
1. Sort first so equal values sit next to each other.
2. Same include/exclude DFS as Subsets, but skip a value that equals its predecessor *within the same loop level* (`i > start and nums[i] == nums[i-1]`).
3. That skip keeps only the first branch among equal siblings, eliminating duplicate subsets.

### Dry Run
For `nums = [1,2,2]` (already sorted):
- record `[]`; pick 1 → `[1]`; pick 2 → `[1,2]`; pick 2 → `[1,2,2]`.
- at level under `[1]`, second 2 has `i>start and nums[i]==nums[i-1]` → **skipped**.
- Result: `[[], [1], [1,2], [1,2,2], [2], [2,2]]`.

### Visualization
```
sort ──▶ skip equal siblings at same depth ──▶ unique subsets only
```

### Code
```python
def subsetsWithDup(nums):
    nums.sort()
    res, path = [], []
    def dfs(start):
        res.append(path[:])
        for i in range(start, len(nums)):
            if i > start and nums[i] == nums[i - 1]:
                continue                        # skip duplicate sibling
            path.append(nums[i])
            dfs(i + 1)
            path.pop()
    dfs(0)
    return res
```

### Complexity
Time O(n·2^n) worst case, Space O(n) recursion depth (plus output).

## 11. Solved Example 3

### Problem — Combinations (LeetCode 77)
Return all combinations of `k` numbers chosen from `1..n`.

### Thought Process
1. Fixed-size subset problem: only record a path once its length reaches `k`.
2. DFS carrying a `start` value so numbers are strictly increasing (no permutations, no reuse).
3. Prune: stop looping once not enough numbers remain to reach length `k` (`start` too large).

### Dry Run
For `n = 4, k = 2`:
- start 1 → `[1]` → then 2,3,4 give `[1,2],[1,3],[1,4]`.
- start 2 → `[2]` → `[2,3],[2,4]`; start 3 → `[3,4]`.
- Result: `[[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]]`.

### Visualization
```
1..n ──▶ pick increasing indices ──▶ record when len(path)==k
```

### Code
```python
def combine(n, k):
    res, path = [], []
    def dfs(start):
        if len(path) == k:
            res.append(path[:])
            return
        # prune: need (k-len(path)) more numbers
        for i in range(start, n - (k - len(path)) + 2):
            path.append(i)
            dfs(i + 1)
            path.pop()
    dfs(1)
    return res
```

### Complexity
Time O(k·C(n,k)), Space O(k) recursion depth (plus output).


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
