# 27 · Peak Element

> **One-liner:** Follow the ascending slope with binary search to a peak.

---

## 1. Overview

### Definition
The **Peak Element** pattern belongs to the *Binary Search* family. Follow the ascending slope with binary search to a peak.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
peak, local maximum, bitonic, slope, binary search.

### Constraints
- Input size where the brute-force complexity would time out — the Peak Element optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Peak Element invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Peak Element is the upgrade.
- The wording maps onto: peak, local maximum, bitonic, slope, binary search.

---

## 3. Brute Force Approach

### Intuition
Linear scan checks each candidate — O(n).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Peak Element pattern is built to use.

---

## 4. Optimal Approach

### Core idea
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Peak Element invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 620 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-27" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Peak element: a[mid] &lt; a[mid+1] means a peak lies to the right</text>
  <rect x="36"  y="141" width="44" height="19" rx="4" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="176" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="108" y="119" width="44" height="41" rx="4" fill="#fff7ed" stroke="#d97706"/><text x="130" y="176" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="180" y="97"  width="44" height="63" rx="4" fill="#fff7ed" stroke="#d97706"/><text x="202" y="176" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="252" y="75"  width="44" height="85" rx="4" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="274" y="176" text-anchor="middle" fill="#1e293b" font-weight="700">7</text>
  <rect x="324" y="86"  width="44" height="74" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="346" y="176" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="396" y="108" width="44" height="52" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="176" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="468" y="130" width="44" height="30" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="176" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="540" y="141" width="44" height="19" rx="4" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="176" text-anchor="middle" fill="#1e293b">1</text>
  <line x1="202" y1="90" x2="266" y2="70" stroke="#475569" marker-end="url(#bs-27)"/>
  <text x="202" y="196" text-anchor="middle" fill="#64748b" font-weight="700">mid</text>
  <text x="274" y="196" text-anchor="middle" fill="#059669" font-weight="700">peak</text>
  <text x="150" y="196" text-anchor="middle" fill="#d97706">drop left half (lo = mid + 1)</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Peak Element      : maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Peak Element problem. I'll if the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration. That brings the complexity down to O(log n) time and O(1) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Binary Search** family template. Adapt the comparison/condition to the specific problem.

```go
// Lower bound: first index with a[i] >= target. Half-open invariant [lo, hi).
func lowerBound(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2     // avoids overflow
        if a[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}
```

```python
def lower_bound(a, target):
    lo, hi = 0, len(a)            # half-open [lo, hi)
    while lo < hi:
        mid = (lo + hi) // 2
        if a[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return lo                     # first index with a[i] >= target
```

```java
int lowerBound(int[] a, int target) {
    int lo = 0, hi = a.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
```

```cpp
int lowerBound(vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Peak Element (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(log n)** |
| Time (best)  | — | **O(log n)** |
| Time (average) | — | **O(log n)** |
| Space | varies | **O(1)** |

> Each step halves the range; iterative form uses constant space.

---

## 7. Common Mistakes

1. Overflow in `(lo+hi)/2` — use `lo + (hi-lo)/2`.
2. Inconsistent interval convention (mixing closed and half-open).
3. Infinite loop when `lo`/`hi` don't make progress.
4. Wrong bias: lower-bound vs upper-bound off by one.
5. Returning `mid` for boundary problems instead of the boundary index.
6. Using `<=` vs `<` incorrectly in the loop condition.
7. Forgetting the array must be sorted (or predicate monotonic).
8. Mishandling all-true or all-false predicate ranges.
9. Searching values when you should search the *answer* space.
10. Not validating the final index against bounds.

---

## 8. Interview Follow-Up Questions

1. **Q: Lower vs upper bound difference?**
   A: Lower: first >= target. Upper: first > target. They bracket equal ranges.

2. **Q: Why half-open intervals?**
   A: They make termination and boundary reasoning uniform.

3. **Q: Binary search on answer — when?**
   A: When you can test feasibility(x) monotonically (minimize-the-max problems).

4. **Q: Rotated sorted array?**
   A: Detect which half is sorted, then search that half.

5. **Q: Find peak without full sort?**
   A: Move toward the ascending slope.

6. **Q: First/last occurrence with duplicates?**
   A: Bias the search left or right after a match.

7. **Q: Count of a value?**
   A: upper_bound - lower_bound.

8. **Q: Floating-point answer?**
   A: Iterate a fixed number of times or until precision epsilon.

9. **Q: 2D sorted matrix?**
   A: Treat as a single sorted list or staircase search.

10. **Q: Why O(log n)?**
   A: Each step discards half the candidates.

11. **Q: Avoid overflow in other languages?**
   A: Use unsigned shifts or wider types.

12. **Q: Predicate not monotonic?**
   A: Binary search doesn't apply; reconsider modeling.

13. **Q: Search insert position?**
   A: That's exactly lower_bound.

14. **Q: Median of two sorted arrays?**
   A: Binary search the partition point.

15. **Q: Off-by-one debugging tip?**
   A: Test arrays of size 0, 1, 2 and all-equal.

---

## 9. Solved Example 1

### Problem — Find Peak (LeetCode 162)
Given `nums` where no two adjacent elements are equal, return the index of **any** peak (`nums[i] > both neighbors`), treating `nums[-1] = nums[n] = -inf`.

### Thought Process
1. A peak must exist because the virtual `-inf` boundaries make the array "rise into" the range from both ends.
2. Compare `nums[mid]` with `nums[mid+1]`: if `nums[mid] < nums[mid+1]` we are on an ascending slope, so a peak lies to the right — set `lo = mid + 1`.
3. Otherwise `mid` could be the peak, so keep the left half including `mid` (`hi = mid`). Converge until `lo == hi`.

### Dry Run
`nums = [1,2,3,1]`, lo=0, hi=3.
- mid=1: `nums[1]=2 < nums[2]=3` → ascend right, lo=2.
- mid=2: `nums[2]=3 > nums[3]=1` → hi=2.
- lo==hi==2 → return 2 (value 3 is a peak). ✓

### Visualization
```
compare nums[mid] vs nums[mid+1]  ──▶ climb toward the higher neighbor
ascending slope  ──▶ peak is to the right (lo = mid + 1)
descending/level ──▶ peak is here or left (hi = mid)
```

### Code
```python
def findPeakElement(nums):
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if nums[mid] < nums[mid + 1]:
            lo = mid + 1          # climb toward the higher neighbor
        else:
            hi = mid              # peak is at mid or to its left
    return lo                     # lo == hi points at a peak
```

### Complexity
Time O(log n), Space O(1). Halves the range each step by following the ascending slope.

## 10. Solved Example 2

### Problem — Peak Mountain (LeetCode 852)
`arr` is a mountain array (strictly increasing then strictly decreasing). Return the index of the single peak.

### Thought Process
1. The array is bitonic, so there is exactly one peak where the slope flips from up to down.
2. Compare `arr[mid]` with `arr[mid+1]`: while ascending (`arr[mid] < arr[mid+1]`), the peak is strictly to the right — set `lo = mid + 1`.
3. Once `arr[mid] > arr[mid+1]` we are on the descending side, so the peak is at `mid` or left (`hi = mid`). Guaranteed convergence to the unique peak.

### Dry Run
`arr = [0,2,5,3,1]`, lo=0, hi=4.
- mid=2: `arr[2]=5 > arr[3]=3` → descending, hi=2.
- mid=1: `arr[1]=2 < arr[2]=5` → ascending, lo=2.
- lo==hi==2 → return 2 (peak value 5). ✓

### Visualization
```
mountain: /\   compare arr[mid] vs arr[mid+1]
ascending (arr[mid] < arr[mid+1]) ──▶ lo = mid + 1
descending (arr[mid] > arr[mid+1]) ──▶ hi = mid
```

### Code
```python
def peakIndexInMountainArray(arr):
    lo, hi = 0, len(arr) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if arr[mid] < arr[mid + 1]:
            lo = mid + 1          # still climbing the mountain
        else:
            hi = mid              # past the summit, go left
    return lo                     # lo == hi is the peak index
```

### Complexity
Time O(log n), Space O(1). One binary search over the bitonic slope.

## 11. Solved Example 3

### Problem — Mountain Array (LeetCode 1095)
Find the **smallest** index whose value equals `target` in a hidden mountain array, using only `mountain_arr.get(i)` and `mountain_arr.length()`. Return -1 if absent.

### Thought Process
1. First find the peak with the ascending-slope binary search (compare `get(mid)` to `get(mid+1)`).
2. The left half `[0, peak]` is strictly increasing — run a standard ascending binary search there; a hit is the smallest index, so return it immediately.
3. Otherwise search the right half `[peak+1, n-1]`, which is strictly decreasing, with the comparison flipped. Minimize calls to `get` by caching where cheap.

### Dry Run
`arr = [1,5,2]`, target=2, length=3.
- Find peak: mid=1, `get(1)=5 > get(2)=2` → hi=1; mid=0, `get(0)=1 < get(1)=5` → lo=1. peak=1.
- Ascending search [0,1] for 2: values 1,5 → miss.
- Descending search [2,2]: `get(2)=2` == target → return 2. ✓

### Visualization
```
step 1 ──▶ find peak (ascending-slope binary search)
step 2 ──▶ binary search ascending left half  [0 .. peak]
step 3 ──▶ binary search descending right half [peak+1 .. n-1]
```

### Code
```python
def findInMountainArray(target, mountain_arr):
    n = mountain_arr.length()

    # 1) locate the peak
    lo, hi = 0, n - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if mountain_arr.get(mid) < mountain_arr.get(mid + 1):
            lo = mid + 1
        else:
            hi = mid
    peak = lo

    # 2) ascending search in the left half (smallest index first)
    lo, hi = 0, peak
    while lo <= hi:
        mid = (lo + hi) // 2
        val = mountain_arr.get(mid)
        if val == target:
            return mid
        elif val < target:
            lo = mid + 1
        else:
            hi = mid - 1

    # 3) descending search in the right half
    lo, hi = peak + 1, n - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        val = mountain_arr.get(mid)
        if val == target:
            return mid
        elif val > target:
            lo = mid + 1
        else:
            hi = mid - 1

    return -1
```

### Complexity
Time O(log n), Space O(1). Three logarithmic passes: find peak, then each monotonic half.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 162 | Find Peak | Easy | Core binary search application |
| 852 | Peak Mountain | Easy | Core binary search application |
| 1095 | Mountain Array | Medium | Core binary search application |
| 367 | Perfect Square | Medium | Core binary search application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Classic search**
- **Lower/upper bound**
- **First/last occurrence**
- **Binary search on answer**
- **Rotated array search**
- **Peak finding**
- **Monotonic predicate search**

---

## 14. Production Engineering Applications

- **Scalability:** Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Peak Element logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Peak Element (Binary Search).
- **Signal:** peak, local maximum, bitonic, slope, binary search.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Peak Element invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Peak Element
FAMILY : Binary Search (Advanced)
WHEN   : peak, local maximum, bitonic, slope, binary search
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 162, 852, 1095, 367
```

---

*Part of the DSA Patterns Handbook — pattern 27 of 100.*
