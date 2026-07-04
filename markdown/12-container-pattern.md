# 12 · Container Pattern

> **One-liner:** Greedy two-pointer maximizing area by moving the limiting boundary.

---

## 1. Overview

### Definition
The **Container Pattern** pattern belongs to the *Two Pointers* family. Greedy two-pointer maximizing area by moving the limiting boundary.

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
container, water, area, max area, trapping rain, two pointer.

### Constraints
- Input size where the brute-force complexity would time out — the Container Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Container Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Container Pattern is the upgrade.
- The wording maps onto: container, water, area, max area, trapping rain, two pointer.

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
Redundant recomputation; does not exploit the structure the Container Pattern pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Container Pattern invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="cp-12" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Area = min(height) × width · move the shorter wall inward</text>
  <line x1="60" y1="210" x2="590" y2="210" stroke="#64748b"/>
  <rect x="85" y="165" width="420" height="45" fill="#fff7ed" stroke="#d97706"/>
  <text x="295" y="193" text-anchor="middle" fill="#d97706" font-weight="700">area = 3 × 6 = 18</text>
  <g>
    <rect x="70"  y="165" width="30" height="45"  rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
    <rect x="140" y="90"  width="30" height="120" rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="210" y="120" width="30" height="90"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="280" y="180" width="30" height="30"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="350" y="135" width="30" height="75"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="420" y="150" width="30" height="60"  rx="4" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="490" y="75"  width="30" height="135" rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  </g>
  <text x="85"  y="228" text-anchor="middle" fill="#059669" font-weight="700">L = 3</text>
  <text x="505" y="228" text-anchor="middle" fill="#059669" font-weight="700">R = 9</text>
  <line x1="100" y1="150" x2="150" y2="150" stroke="#475569" marker-end="url(#cp-12)"/>
  <text x="150" y="146" text-anchor="middle" fill="#64748b">move shorter (L) →</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Container Pattern : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Container Pattern problem. I'll maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks. That brings the complexity down to O(n) or O(n log n) time and O(1) space — here's the template."

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

| Metric | Brute Force | Container Pattern (Optimal) |
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

### Problem — Container Water (LeetCode 11)
A representative **Container Pattern** problem. The signal: greedy two-pointer maximizing area by moving the limiting boundary.

### Thought Process
1. Confirm the pattern via its recognition signals (container, water, area, max area, trapping rain, two pointer).
2. Reach for the Container Pattern template below and map the problem's entities onto it.
3. Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Container Pattern step-by-step ]
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

### Problem — Trapping Rain (LeetCode 42)
A representative **Container Pattern** problem. The signal: greedy two-pointer maximizing area by moving the limiting boundary.

### Thought Process
1. Confirm the pattern via its recognition signals (container, water, area, max area, trapping rain, two pointer).
2. Reach for the Container Pattern template below and map the problem's entities onto it.
3. Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Container Pattern step-by-step ]
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

### Problem — Largest Rectangle (LeetCode 84)
A representative **Container Pattern** problem. The signal: greedy two-pointer maximizing area by moving the limiting boundary.

### Thought Process
1. Confirm the pattern via its recognition signals (container, water, area, max area, trapping rain, two pointer).
2. Reach for the Container Pattern template below and map the problem's entities onto it.
3. Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Container Pattern step-by-step ]
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
| 11 | Container Water | Easy | Core two pointers application |
| 42 | Trapping Rain | Easy | Core two pointers application |
| 84 | Largest Rectangle | Medium | Core two pointers application |
| 407 | Trapping II | Medium | Core two pointers application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Container Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Container Pattern (Two Pointers).
- **Signal:** container, water, area, max area, trapping rain, two pointer.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Container Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Container Pattern
FAMILY : Two Pointers (Intermediate)
WHEN   : container, water, area, max area, trapping rain, two pointer
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 11, 42, 84, 407
```

---

*Part of the DSA Patterns Handbook — pattern 12 of 100.*
