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

### Intuition
Generate all candidates then filter — wasteful, explores invalid branches fully.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Combinations pattern is built to use.

---

## 4. Optimal Approach

### Core idea
DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Combinations invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

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

```
brute  : recompute everything each step      ──▶ slow
Combinations      : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Combinations problem. I'll dFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next. That brings the complexity down to O(branches^depth) time and O(depth) space — here's the template."

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
A representative **Combinations** problem. The signal: choose elements with a moving start index to avoid duplicates.

### Thought Process
1. Confirm the pattern via its recognition signals (combinations, choose k, backtracking, start index, combination sum).
2. Reach for the Combinations template below and map the problem's entities onto it.
3. DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Combinations step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(branches^depth), Space O(depth). Exponential by nature; pruning cuts the constant/branches drastically.

## 10. Solved Example 2

### Problem — Combination Sum (LeetCode 39)
A representative **Combinations** problem. The signal: choose elements with a moving start index to avoid duplicates.

### Thought Process
1. Confirm the pattern via its recognition signals (combinations, choose k, backtracking, start index, combination sum).
2. Reach for the Combinations template below and map the problem's entities onto it.
3. DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Combinations step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(branches^depth), Space O(depth). Exponential by nature; pruning cuts the constant/branches drastically.

## 11. Solved Example 3

### Problem — Combination Sum II (LeetCode 40)
A representative **Combinations** problem. The signal: choose elements with a moving start index to avoid duplicates.

### Thought Process
1. Confirm the pattern via its recognition signals (combinations, choose k, backtracking, start index, combination sum).
2. Reach for the Combinations template below and map the problem's entities onto it.
3. DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Combinations step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(branches^depth), Space O(depth). Exponential by nature; pruning cuts the constant/branches drastically.


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
