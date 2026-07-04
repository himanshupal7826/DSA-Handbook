# 07 · Same Direction Two Pointers

> **One-liner:** A reader and writer pointer compact/filter an array in place in O(n).

---

## 1. Overview

### Definition
The **Same Direction Two Pointers** pattern belongs to the *Two Pointers* family. A reader and writer pointer compact/filter an array in place in O(n).

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
two pointer, slow fast, read write, in place, remove, partition.

### Constraints
- Input size where the brute-force complexity would time out — the Same Direction Two Pointers optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Same Direction Two Pointers invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Same Direction Two Pointers is the upgrade.
- The wording maps onto: two pointer, slow fast, read write, in place, remove, partition.

---

## 3. Brute Force Approach

### Intuition
Check every pair/triplet with nested loops — O(n^2) or O(n^3).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Same Direction Two Pointers pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Same Direction Two Pointers invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="sd-07" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Compact in place · writer keeps the result, reader scans ahead</text>
  <g>
    <rect x="60"  y="46" width="74" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="97"  y="74" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="140" y="46" width="74" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="177" y="74" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="220" y="46" width="74" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="257" y="74" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="300" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="337" y="74" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="380" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="417" y="74" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="460" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="497" y="74" text-anchor="middle" fill="#1e293b">7</text>
  </g>
  <text x="150" y="112" text-anchor="middle" fill="#059669" font-weight="700">kept unique prefix</text>
  <text x="257" y="128" text-anchor="middle" fill="#059669" font-weight="700">w</text>
  <text x="417" y="128" text-anchor="middle" fill="#d97706" font-weight="700">r</text>
  <line x1="257" y1="140" x2="300" y2="140" stroke="#475569" marker-end="url(#sd-07)"/>
  <line x1="417" y1="140" x2="460" y2="140" stroke="#475569" marker-end="url(#sd-07)"/>
  <text x="320" y="176" text-anchor="middle" fill="#1e293b">reader r scans forward; on a keep, write to w+1 — both advance right</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Same Direction Two: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Same Direction Two Pointers problem. I'll maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks. That brings the complexity down to O(n) or O(n log n) time and O(1) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Two Pointers** family template. Adapt the comparison/condition to the specific problem.

```go
// Opposite-direction two pointers on a sorted array (pair sum).
func twoSumSorted(a []int, target int) (int, int) {
    l, r := 0, len(a)-1
    for l < r {
        s := a[l] + a[r]
        switch {
        case s == target:
            return l, r
        case s < target:
            l++ // need a bigger sum
        default:
            r-- // need a smaller sum
        }
    }
    return -1, -1
}
```

```python
def two_sum_sorted(a, target):
    l, r = 0, len(a) - 1
    while l < r:
        s = a[l] + a[r]
        if s == target:
            return (l, r)
        elif s < target:
            l += 1          # increase sum
        else:
            r -= 1          # decrease sum
    return (-1, -1)
```

```java
int[] twoSumSorted(int[] a, int target) {
    int l = 0, r = a.length - 1;
    while (l < r) {
        int s = a[l] + a[r];
        if (s == target) return new int[]{l, r};
        else if (s < target) l++;
        else r--;
    }
    return new int[]{-1, -1};
}
```

```cpp
pair<int,int> twoSumSorted(vector<int>& a, int target) {
    int l = 0, r = (int)a.size() - 1;
    while (l < r) {
        int s = a[l] + a[r];
        if (s == target) return {l, r};
        else if (s < target) ++l;
        else --r;
    }
    return {-1, -1};
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Same Direction Two Pointers (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n) or O(n log n)** |
| Time (best)  | — | **O(n) or O(n log n)** |
| Time (average) | — | **O(n) or O(n log n)** |
| Space | varies | **O(1)** |

> Sorting (if needed) dominates; the scan itself is O(n).

---

## 7. Common Mistakes

1. Forgetting to sort first when the technique requires sorted input.
2. Not skipping duplicates, producing repeated triplets/quadruplets.
3. Using `l <= r` when `l < r` is intended (or vice versa).
4. Advancing the wrong pointer and missing the answer.
5. Off-by-one at the boundaries (start at 0 and n-1).
6. Mutating original order when indices must map back to the input.
7. Integer overflow when summing large values.
8. Infinite loop from failing to move a pointer in some branch.
9. Assuming uniqueness of solution when multiple exist.
10. Mixing up reader/writer roles in same-direction variants.

---

## 8. Interview Follow-Up Questions

1. **Q: Why does sorted order let you move one pointer?**
   A: Monotonicity: increasing l raises the sum, decreasing r lowers it.

2. **Q: How to avoid duplicate triplets?**
   A: Skip equal neighbors after recording a hit.

3. **Q: Opposite vs same direction — when each?**
   A: Opposite for sorted pair/area problems; same direction for in-place filtering/windows.

4. **Q: Extend to 3Sum / 4Sum?**
   A: Fix outer elements, two-pointer the rest; generalize as k-sum recursion.

5. **Q: Unsorted input, can't sort?**
   A: Use a hash map (HashMap Lookup) for O(n) pair finding.

6. **Q: Container/area problems?**
   A: Move the pointer at the shorter wall to possibly increase area.

7. **Q: Cycle detection?**
   A: Fast/slow pointers (Floyd) detect cycles in O(1) space.

8. **Q: Palindrome check?**
   A: Converge from both ends comparing characters.

9. **Q: Stability of order?**
   A: Two-pointer partitioning can be unstable; note if order matters.

10. **Q: Complexity with sorting?**
   A: O(n log n) sort + O(n) scan = O(n log n).

11. **Q: Remove duplicates in place?**
   A: Writer index advances only on new values.

12. **Q: Dutch national flag?**
   A: Three pointers partition into <,=,> in one pass.

13. **Q: Find closest sum?**
   A: Track the minimal |sum - target| as pointers move.

14. **Q: Why O(1) space?**
   A: Only a few index variables beyond the input.

15. **Q: Multiple answers required?**
   A: Continue scanning after each hit, moving both pointers.

---

## 9. Solved Example 1

### Problem — Remove Duplicates (LeetCode 26)
The array is sorted; remove duplicates in place so each element appears once and return the new length.

### Thought Process
1. A writer index `w` marks the end of the deduped prefix; a reader `r` scans the rest.
2. Because the array is sorted, a value is new exactly when it differs from `nums[w-1]`.
3. On a new value, write it at `w` and advance `w`; return `w` as the length.

### Dry Run
nums = [1,1,2,3,3].
- w=1, r=1 (1)==nums[0] → skip.
- r=2 (2)!=nums[0](1) → nums[1]=2, w=2.
- r=3 (3)!=nums[1](2) → nums[2]=3, w=3.
- r=4 (3)==nums[2](3) → skip. Return 3, prefix [1,2,3].

### Visualization
```
input  ──▶ [ apply Same Direction Two Pointers step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def removeDuplicates(nums):
    if not nums:
        return 0
    w = 1
    for r in range(1, len(nums)):
        if nums[r] != nums[w - 1]:
            nums[w] = nums[r]
            w += 1
    return w
```

### Complexity
Time O(n), Space O(1) — one reader pass, in-place writer.

## 10. Solved Example 2

### Problem — Remove Element (LeetCode 27)
Remove every occurrence of `val` from the array in place and return the count of remaining elements.

### Thought Process
1. A writer index `w` collects the elements we keep; a reader `r` scans all positions.
2. Whenever `nums[r] != val`, copy it to `nums[w]` and advance `w`.
3. Order need not be preserved among kept elements; `w` is the final length.

### Dry Run
nums = [3,2,2,3], val = 3.
- r=0 (3)==val → skip, w=0.
- r=1 (2)!=val → nums[0]=2, w=1.
- r=2 (2)!=val → nums[1]=2, w=2.
- r=3 (3)==val → skip. Return 2, prefix [2,2].

### Visualization
```
input  ──▶ [ apply Same Direction Two Pointers step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def removeElement(nums, val):
    w = 0
    for r in range(len(nums)):
        if nums[r] != val:
            nums[w] = nums[r]
            w += 1
    return w
```

### Complexity
Time O(n), Space O(1) — single pass with an in-place writer.

## 11. Solved Example 3

### Problem — Move Zeroes (LeetCode 283)
Move all zeroes to the end in place while keeping the relative order of the non-zero elements.

### Thought Process
1. A writer index `w` points to where the next non-zero element belongs.
2. For each reader position with a non-zero value, swap it into `nums[w]` and advance `w`.
3. Swapping (rather than overwriting) drags the zeroes toward the tail automatically.

### Dry Run
nums = [0,1,0,3,12].
- r=0 (0) → skip, w=0.
- r=1 (1) → swap nums[0],nums[1] → [1,0,0,3,12], w=1.
- r=3 (3) → swap nums[1],nums[3] → [1,3,0,0,12], w=2.
- r=4 (12) → swap nums[2],nums[4] → [1,3,12,0,0].

### Visualization
```
input  ──▶ [ apply Same Direction Two Pointers step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def moveZeroes(nums):
    w = 0
    for r in range(len(nums)):
        if nums[r] != 0:
            nums[w], nums[r] = nums[r], nums[w]
            w += 1
    return nums
```

### Complexity
Time O(n), Space O(1) — a single in-place pass, order preserved.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 26 | Remove Duplicates | Easy | Core two pointers application |
| 27 | Remove Element | Easy | Core two pointers application |
| 283 | Move Zeroes | Medium | Core two pointers application |
| 80 | Remove Dup II | Medium | Core two pointers application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Opposite-direction (converging)**
- **Same-direction (reader/writer)**
- **Fast & slow (cycle/middle)**
- **Three-way partition (Dutch flag)**
- **k-Sum recursion**
- **Container/area maximization**

---

## 14. Production Engineering Applications

- **Scalability:** Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Same Direction Two Pointers logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Same Direction Two Pointers (Two Pointers).
- **Signal:** two pointer, slow fast, read write, in place, remove, partition.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Same Direction Two Pointers invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Same Direction Two Pointers
FAMILY : Two Pointers (Beginner)
WHEN   : two pointer, slow fast, read write, in place, remove, partition
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 26, 27, 283, 80
```

---

*Part of the DSA Patterns Handbook — pattern 07 of 100.*
