# 10 · Three Sum Pattern

> **One-liner:** Fix one element, then two-pointer the rest for triplets summing to target.

---

## 1. Overview

### Definition
The **Three Sum Pattern** pattern belongs to the *Two Pointers* family. Fix one element, then two-pointer the rest for triplets summing to target.

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
3sum, triplet, sorted, two pointer, target sum.

### Constraints
- Input size where the brute-force complexity would time out — the Three Sum Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Three Sum Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Three Sum Pattern is the upgrade.
- The wording maps onto: 3sum, triplet, sorted, two pointer, target sum.

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
Redundant recomputation; does not exploit the structure the Three Sum Pattern pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Three Sum Pattern invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ts-10" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Sorted · fix a[i], then two-pointer the rest for sum = 4</text>
  <g>
    <rect x="60"  y="46" width="74" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="97"  y="74" text-anchor="middle" fill="#1e293b">-4</text>
    <rect x="140" y="46" width="74" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="177" y="74" text-anchor="middle" fill="#1e293b">-1</text>
    <rect x="220" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="257" y="74" text-anchor="middle" fill="#1e293b">-1</text>
    <rect x="300" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="337" y="74" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="380" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="417" y="74" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="460" y="46" width="74" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="497" y="74" text-anchor="middle" fill="#1e293b">2</text>
  </g>
  <text x="97"  y="112" text-anchor="middle" fill="#d97706" font-weight="700">i (fixed)</text>
  <text x="177" y="112" text-anchor="middle" fill="#059669" font-weight="700">L</text>
  <text x="497" y="112" text-anchor="middle" fill="#059669" font-weight="700">R</text>
  <line x1="190" y1="126" x2="256" y2="126" stroke="#475569" marker-end="url(#ts-10)"/>
  <line x1="484" y1="126" x2="418" y2="126" stroke="#475569" marker-end="url(#ts-10)"/>
  <text x="320" y="164" text-anchor="middle" fill="#1e293b">need a[L] + a[R] = -a[i] = 4  →  move L/R by the sum</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Three Sum Pattern : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Three Sum Pattern problem. I'll maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks. That brings the complexity down to O(n) or O(n log n) time and O(1) space — here's the template."

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

| Metric | Brute Force | Three Sum Pattern (Optimal) |
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

### Problem — 3Sum (LeetCode 15)
A representative **Three Sum Pattern** problem. The signal: fix one element, then two-pointer the rest for triplets summing to target.

### Thought Process
1. Confirm the pattern via its recognition signals (3sum, triplet, sorted, two pointer, target sum).
2. Reach for the Three Sum Pattern template below and map the problem's entities onto it.
3. Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Three Sum Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n) or O(n log n), Space O(1). Sorting (if needed) dominates; the scan itself is O(n).

## 10. Solved Example 2

### Problem — 3Sum Closest (LeetCode 16)
A representative **Three Sum Pattern** problem. The signal: fix one element, then two-pointer the rest for triplets summing to target.

### Thought Process
1. Confirm the pattern via its recognition signals (3sum, triplet, sorted, two pointer, target sum).
2. Reach for the Three Sum Pattern template below and map the problem's entities onto it.
3. Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Three Sum Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n) or O(n log n), Space O(1). Sorting (if needed) dominates; the scan itself is O(n).

## 11. Solved Example 3

### Problem — 3Sum Smaller (LeetCode 259)
A representative **Three Sum Pattern** problem. The signal: fix one element, then two-pointer the rest for triplets summing to target.

### Thought Process
1. Confirm the pattern via its recognition signals (3sum, triplet, sorted, two pointer, target sum).
2. Reach for the Three Sum Pattern template below and map the problem's entities onto it.
3. Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Three Sum Pattern step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n) or O(n log n), Space O(1). Sorting (if needed) dominates; the scan itself is O(n).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 15 | 3Sum | Easy | Core two pointers application |
| 16 | 3Sum Closest | Easy | Core two pointers application |
| 259 | 3Sum Smaller | Medium | Core two pointers application |
| 18 | 4Sum | Medium | Core two pointers application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Three Sum Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Three Sum Pattern (Two Pointers).
- **Signal:** 3sum, triplet, sorted, two pointer, target sum.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Three Sum Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Three Sum Pattern
FAMILY : Two Pointers (Intermediate)
WHEN   : 3sum, triplet, sorted, two pointer, target sum
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 15, 16, 259, 18
```

---

*Part of the DSA Patterns Handbook — pattern 10 of 100.*
