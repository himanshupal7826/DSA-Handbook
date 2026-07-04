# 09 · Dutch National Flag

> **One-liner:** Three-way partition into <, =, > a pivot in a single O(n) pass.

---

## 1. Overview

### Definition
The **Dutch National Flag** pattern belongs to the *Two Pointers* family. Three-way partition into <, =, > a pivot in a single O(n) pass.

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
three way partition, sort colors, 0 1 2, pivot, quicksort partition.

### Constraints
- Input size where the brute-force complexity would time out — the Dutch National Flag optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Dutch National Flag invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Dutch National Flag is the upgrade.
- The wording maps onto: three way partition, sort colors, 0 1 2, pivot, quicksort partition.

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
Redundant recomputation; does not exploit the structure the Dutch National Flag pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Dutch National Flag invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="dnf-09" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">One pass · three regions around the pivot</text>
  <text x="116" y="52" text-anchor="middle" fill="#059669" font-weight="700">&lt; pivot</text>
  <text x="256" y="52" text-anchor="middle" fill="#2563eb" font-weight="700">= pivot</text>
  <text x="396" y="52" text-anchor="middle" fill="#64748b" font-weight="700">unknown</text>
  <text x="536" y="52" text-anchor="middle" fill="#d97706" font-weight="700">&gt; pivot</text>
  <g>
    <rect x="50"  y="62" width="62" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="81"  y="90" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="120" y="62" width="62" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="151" y="90" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="190" y="62" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="221" y="90" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="260" y="62" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="291" y="90" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="330" y="62" width="62" height="46" rx="6" fill="#ffffff" stroke="#64748b"/><text x="361" y="90" text-anchor="middle" fill="#1e293b">?</text>
    <rect x="400" y="62" width="62" height="46" rx="6" fill="#ffffff" stroke="#64748b"/><text x="431" y="90" text-anchor="middle" fill="#1e293b">?</text>
    <rect x="470" y="62" width="62" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="501" y="90" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="540" y="62" width="62" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="571" y="90" text-anchor="middle" fill="#1e293b">2</text>
  </g>
  <text x="221" y="132" text-anchor="middle" fill="#1e293b" font-weight="700">low</text>
  <text x="361" y="132" text-anchor="middle" fill="#1e293b" font-weight="700">mid</text>
  <text x="501" y="132" text-anchor="middle" fill="#1e293b" font-weight="700">high</text>
  <line x1="361" y1="146" x2="424" y2="146" stroke="#475569" marker-end="url(#dnf-09)"/>
  <text x="320" y="182" text-anchor="middle" fill="#1e293b">mid scans: =0 → swap to low++; =2 → swap to high--; =1 → mid++</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Dutch National Fla: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Dutch National Flag problem. I'll maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks. That brings the complexity down to O(n) or O(n log n) time and O(1) space — here's the template."

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

| Metric | Brute Force | Dutch National Flag (Optimal) |
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

### Problem — Sort Colors (LeetCode 75)
Sort an array of 0s, 1s, and 2s in place in a single pass (the classic Dutch National Flag problem).

### Thought Process
1. Keep three regions via `lo` (end of 0s), `mid` (scanner), and `hi` (start of 2s).
2. At `nums[mid]`: 0 → swap into the `lo` region and advance both `lo` and `mid`; 1 → just advance `mid`.
3. 2 → swap to the `hi` region and shrink `hi`, but do NOT advance `mid` (the swapped-in value is unexamined).

### Dry Run
nums = [2,0,1].
- lo=0,mid=0,hi=2: nums[0]=2 → swap with hi → [1,0,2], hi=1.
- mid=0: nums[0]=1 → mid=1.
- mid=1: nums[1]=0 → swap with lo → [0,1,2], lo=1,mid=2 → mid>hi, done.

### Visualization
```
input  ──▶ [ apply Dutch National Flag step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def sortColors(nums):
    lo, mid, hi = 0, 0, len(nums) - 1
    while mid <= hi:
        if nums[mid] == 0:
            nums[lo], nums[mid] = nums[mid], nums[lo]
            lo += 1
            mid += 1
        elif nums[mid] == 1:
            mid += 1
        else:
            nums[mid], nums[hi] = nums[hi], nums[mid]
            hi -= 1
    return nums
```

### Complexity
Time O(n), Space O(1) — one three-way-partition pass.

## 10. Solved Example 2

### Problem — Kth Largest (LeetCode 215)
Find the kth largest element in an unsorted array without fully sorting it.

### Thought Process
1. The kth largest sits at index `n-k` in ascending order — target that index with quickselect.
2. Partition around a random pivot using a three-way (Dutch flag) split into `< = >` regions.
3. Compare the target index to the equal region `[lt, gt]`; recurse into only the side that contains it.

### Dry Run
nums = [3,2,1,5,6,4], k = 2 → target index 4.
- Pivot say 4: partition → [3,2,1,4,5,6] with equal region at index 3.
- target 4 > gt(3) → search right half [5,6].
- Pivot 5: 6 is largest, target index 4 lands on 5 → return 5.

### Visualization
```
input  ──▶ [ apply Dutch National Flag step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
import random

def findKthLargest(nums, k):
    target = len(nums) - k          # index in ascending order
    lo, hi = 0, len(nums) - 1
    while True:
        pivot = nums[random.randint(lo, hi)]
        lt, i, gt = lo, lo, hi       # Dutch-flag three-way partition
        while i <= gt:
            if nums[i] < pivot:
                nums[lt], nums[i] = nums[i], nums[lt]
                lt += 1
                i += 1
            elif nums[i] > pivot:
                nums[i], nums[gt] = nums[gt], nums[i]
                gt -= 1
            else:
                i += 1
        if target < lt:
            hi = lt - 1
        elif target > gt:
            lo = gt + 1
        else:
            return nums[target]
```

### Complexity
Time O(n) average (O(n^2) worst), Space O(1) — in-place quickselect.

## 11. Solved Example 3

### Problem — Sort By Parity (LeetCode 905)
A representative **Dutch National Flag** problem. The signal: three-way partition into <, =, > a pivot in a single o(n) pass.

### Thought Process
1. Confirm the pattern via its recognition signals (three way partition, sort colors, 0 1 2, pivot, quicksort partition).
2. Reach for the Dutch National Flag template below and map the problem's entities onto it.
3. Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Dutch National Flag step-by-step ]
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
| 75 | Sort Colors | Easy | Core two pointers application |
| 215 | Kth Largest | Easy | Core two pointers application |
| 905 | Sort By Parity | Medium | Core two pointers application |
| 148 | Sort List | Medium | Core two pointers application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Dutch National Flag logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Dutch National Flag (Two Pointers).
- **Signal:** three way partition, sort colors, 0 1 2, pivot, quicksort partition.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Dutch National Flag invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Dutch National Flag
FAMILY : Two Pointers (Intermediate)
WHEN   : three way partition, sort colors, 0 1 2, pivot, quicksort partition
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 75, 215, 905, 148
```

---

*Part of the DSA Patterns Handbook — pattern 09 of 100.*
