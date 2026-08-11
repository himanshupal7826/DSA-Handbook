# 26 · Search in Rotated Array

> **One-liner:** Identify the sorted half each step to binary-search a rotated array.

---

## 1. Overview

### Definition
The **Search in Rotated Array** pattern belongs to the *Binary Search* family. Identify the sorted half each step to binary-search a rotated array.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
rotated, pivot, sorted rotated, binary search, find min.

### Constraints
- Input size where the brute-force complexity would time out — the Search in Rotated Array optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Search in Rotated Array invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Search in Rotated Array is the upgrade.
- The wording maps onto: rotated, pivot, sorted rotated, binary search, find min.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"The array was sorted, then somebody cut it and swapped the two halves — can I still search it in O(log n)?"*

Running example: `nums = [4, 5, 6, 7, 0, 1, 2]`, `target = 0`. This is `[0,1,2,4,5,6,7]` rotated so that it now starts at `4`.

### Intuition
Plain binary search needs a globally sorted array, and this one isn't — `7` is followed by `0`. The safe move is to give up on the structure entirely and just look at every element until you find the target.

### Algorithm
1. For `i = 0 .. n-1`:
2. &nbsp;&nbsp;If `nums[i] == target`, return `i`.
3. Return `-1`.

### Complexity
- Time: **O(n)** — the target may be the last element examined.
- Space: O(1)

### Drawbacks
- On `[4,5,6,7,0,1,2]` looking for `0`, the scan reads `4, 5, 6, 7, 0` — five reads to find an element binary search reaches in three.
- The fact being ignored: **the array is still sorted almost everywhere.** There is exactly one "cliff" (`7 → 0`). Everything else is ascending order that the linear scan pays no attention to. One broken link should not cost you the whole logarithm.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Wherever you place `mid`, at least one of the two halves is completely sorted — figure out which one, and you can decide in O(1) whether the target lives there.**

There is only one cliff in the array. A cliff cannot be in two places at once, so it sits in the left half or the right half — never both. Whichever half does *not* contain it is an untouched slice of the original sorted array, and inside a sorted slice a single range check (`is target between the two endpoints?`) settles everything.

### The thought process

```text
We need    : the index of target in a rotated sorted array, in O(log n).
Obvious way: scan every element.
Too slow   : O(n) — throws away the sortedness that survived the rotation.
Notice     : rotation introduces exactly ONE descent (the pivot).
Notice too : that one descent lands in only one half of [lo..mid..hi],
             so the OTHER half is perfectly sorted.
Therefore  : identify the sorted half, and range-check the target against it.
Now        : if target is inside it, search there; otherwise search the other
             half. Either way one half dies → O(log n).
```

### Why `nums[lo] <= nums[mid]` identifies the sorted half

That single comparison is the entire trick, so it is worth proving.

```text
If nums[lo] <= nums[mid]  →  no cliff between lo and mid  →  LEFT half sorted
If nums[lo] >  nums[mid]  →  the cliff is inside the left →  RIGHT half sorted
```

A cliff is the only way values can go *down* as the index goes up. So if `nums[lo] <= nums[mid]`, no descent happened between `lo` and `mid`, and `nums[lo..mid]` is ascending. If instead `nums[lo] > nums[mid]`, a descent must have happened on the left — and since there is only one, the right side `nums[mid..hi]` is clean.

Concretely, with `lo=0, mid=3` on `[4,5,6,7,0,1,2]`: `nums[0]=4 <= nums[3]=7`, so `[4,5,6,7]` is sorted. Target `0` is not in `[4, 7]`, so it cannot be on the left — move right.

Two details that are easy to get wrong:

- **Use `<=`, not `<`.** When the window narrows to two elements, `mid == lo`, so `nums[lo] == nums[mid]`. A single element *is* sorted, and `<=` correctly says so. With `<` you would wrongly declare the right half sorted and could search the wrong side.
- **Range-check with the right strictness.** For a sorted left half we ask `nums[lo] <= target < nums[mid]` — `mid` itself was already compared for equality, so it is excluded. Symmetrically on the right: `nums[mid] < target <= nums[hi]`.

### Caveat: duplicates degrade the guarantee to O(n)

The comparison `nums[lo] <= nums[mid]` is only informative when values are distinct. With duplicates you can hit

```text
nums = [1, 0, 1, 1, 1],  lo=0, mid=2, hi=4
        ↑     ↑        ↑
       1  ==  1   ==   1     which half is sorted? impossible to say
```

Both `[1,0,1]` and `[1,1,1]` are consistent with what you can see. The only sound repair is to shrink the window by one on each side (`lo++`, `hi--`) and retry — which costs O(n) in the worst case (an array of all-equal values with one odd element). Say this out loud in an interview: **distinct values → O(log n) guaranteed; duplicates → O(log n) typical, O(n) worst case.**

### Steps

```text
Step 1 → lo = 0, hi = n-1 (closed interval, loop while lo <= hi).
Step 2 → mid = lo + (hi-lo)/2; if nums[mid] == target, done.
Step 3 → if nums[lo] <= nums[mid]:            // LEFT half is sorted
Step 4 →     if nums[lo] <= target < nums[mid]  → hi = mid - 1
Step 5 →     else                               → lo = mid + 1
Step 6 → else:                                 // RIGHT half is sorted
Step 7 →     if nums[mid] < target <= nums[hi]  → lo = mid + 1
Step 8 →     else                               → hi = mid - 1
Step 9 → loop ends without a hit → return -1.
```

### How should I recognize this?

```text
If you see...
  "sorted array rotated at some unknown pivot"
  "find target / find the minimum", "O(log n) required"
  an array that ascends, drops once, then ascends again
        ↓
Think about...
  "Which half of [lo..mid..hi] does the single cliff fall in?
   The other half is ordinary sorted territory."
        ↓
Use...
  binary search + the nums[lo] <= nums[mid] test
    ├─ searching for a target  → range-check it against the sorted half
    ├─ searching for the MIN   → compare nums[mid] with nums[hi] instead
    └─ duplicates present      → add the lo++/hi-- escape, note O(n) worst
```

### Visual explanation

```svg
<svg viewBox="0 0 620 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-26" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Rotated array, search 2: one side of mid is always sorted</text>
  <rect x="24"  y="56" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="85" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="96"  y="56" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="85" text-anchor="middle" fill="#1e293b">7</text>
  <rect x="168" y="56" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="85" text-anchor="middle" fill="#1e293b">8</text>
  <rect x="240" y="56" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="274" y="85" text-anchor="middle" fill="#1e293b" font-weight="700">9</text>
  <rect x="312" y="56" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="346" y="85" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="384" y="56" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="418" y="85" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="456" y="56" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="85" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="528" y="56" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="85" text-anchor="middle" fill="#1e293b">4</text>
  <line x1="312" y1="48" x2="312" y2="116" stroke="#b91c1c" stroke-width="2"/>
  <text x="312" y="132" text-anchor="middle" fill="#b91c1c" font-weight="700">pivot</text>
  <text x="58"  y="132" text-anchor="middle" fill="#64748b" font-weight="700">lo</text>
  <text x="274" y="132" text-anchor="middle" fill="#059669" font-weight="700">mid</text>
  <text x="562" y="132" text-anchor="middle" fill="#64748b" font-weight="700">hi</text>
  <text x="165" y="154" text-anchor="middle" fill="#059669">left half [6..9] sorted</text>
  <text x="165" y="172" text-anchor="middle" fill="#d97706">2 not in [6,9] → discard it</text>
  <line x1="300" y1="188" x2="470" y2="188" stroke="#475569" marker-end="url(#bs-26)"/>
  <text x="385" y="182" text-anchor="middle" fill="#64748b">search right half</text>
</svg>
```

```text
nums = [4, 5, 6, 7, 0, 1, 2]   target = 0
 idx      0  1  2  3  4  5  6                    the cliff is 7 → 0

step 1   lo=0            mid=3            hi=6
         [4  5  6  7] │ [0  1  2]
          └── sorted ──┘   nums[0]=4 <= nums[3]=7 → LEFT is sorted
          is 0 in [4,7)? NO  → discard the left, lo = 4

step 2                        lo=4  mid=5  hi=6
                              [0  1] │ [2]
                              nums[4]=0 <= nums[5]=1 → LEFT is sorted
                              is 0 in [0,1)? YES → discard the right, hi = 4

step 3                        lo=hi=mid=4
                              nums[4] == 0  → return 4  ✓
```

### Interview explanation
"Rotation introduces exactly one descent in the array, so at any `mid` that descent can only be in one half — which means the other half is a perfectly ordinary sorted range. I test `nums[lo] <= nums[mid]` to see whether the left half is the clean one, then ask whether the target falls between that half's two endpoints. If it does I recurse into it, otherwise into the other half; either way I discard half the array, so it's O(log n) time and O(1) space. I use `<=` rather than `<` so that a one-element half is still treated as sorted. If the array can contain duplicates that test becomes ambiguous when `nums[lo] == nums[mid] == nums[hi]`, and the fallback of shrinking both ends makes the worst case O(n)."

---

## 5. Generic Templates

> One comparison names the sorted half; one range check decides whether to go there.

```go
// SearchRotated finds target in a rotated sorted array of DISTINCT values.
// Returns its index, or -1.
func SearchRotated(nums []int, target int) int {
    lo, hi := 0, len(nums)-1
    for lo <= hi {
        mid := lo + (hi-lo)/2
        if nums[mid] == target {
            return mid
        }
        if nums[lo] <= nums[mid] { // left half [lo..mid] is sorted
            if nums[lo] <= target && target < nums[mid] {
                hi = mid - 1 // target lies inside the sorted left
            } else {
                lo = mid + 1
            }
        } else { // right half [mid..hi] is sorted
            if nums[mid] < target && target <= nums[hi] {
                lo = mid + 1 // target lies inside the sorted right
            } else {
                hi = mid - 1
            }
        }
    }
    return -1
}

// FindRotationPivot returns the index of the smallest element — i.e. how far
// the array was rotated. Compares with nums[hi], never nums[lo]: on a
// non-rotated array nums[lo] <= nums[mid] holds and would send us the wrong way.
func FindRotationPivot(nums []int) int {
    lo, hi := 0, len(nums)-1
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] > nums[hi] {
            lo = mid + 1 // the cliff, and the minimum, are to the right
        } else {
            hi = mid // mid could itself be the minimum — keep it
        }
    }
    return lo
}
```

```python
def search_rotated(nums, target):
    """Index of target in a rotated sorted array of distinct values, else -1."""
    lo, hi = 0, len(nums) - 1
    while lo <= hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] == target:
            return mid
        if nums[lo] <= nums[mid]:                  # left half is sorted
            if nums[lo] <= target < nums[mid]:
                hi = mid - 1                       # target is inside it
            else:
                lo = mid + 1
        else:                                      # right half is sorted
            if nums[mid] < target <= nums[hi]:
                lo = mid + 1                       # target is inside it
            else:
                hi = mid - 1
    return -1


def find_rotation_pivot(nums):
    """Index of the minimum. Compare with nums[hi]: nums[lo] misleads when
    the array was never rotated."""
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] > nums[hi]:
            lo = mid + 1                           # cliff is to the right
        else:
            hi = mid                               # mid may be the minimum
    return lo
```

```java
public class RotatedSearch {
    /** Index of target in a rotated sorted array of distinct values, else -1. */
    public static int searchRotated(int[] nums, int target) {
        int lo = 0, hi = nums.length - 1;
        while (lo <= hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] == target) return mid;
            if (nums[lo] <= nums[mid]) {                       // left sorted
                if (nums[lo] <= target && target < nums[mid]) hi = mid - 1;
                else lo = mid + 1;
            } else {                                           // right sorted
                if (nums[mid] < target && target <= nums[hi]) lo = mid + 1;
                else hi = mid - 1;
            }
        }
        return -1;
    }

    /** Index of the minimum; compare against nums[hi], not nums[lo]. */
    public static int findRotationPivot(int[] nums) {
        int lo = 0, hi = nums.length - 1;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] > nums[hi]) lo = mid + 1;   // cliff is to the right
            else hi = mid;                            // mid may be the minimum
        }
        return lo;
    }
}
```

```cpp
#include <vector>
using namespace std;

// Index of target in a rotated sorted array of distinct values, else -1.
int searchRotated(const vector<int>& nums, int target) {
    int lo = 0, hi = (int)nums.size() - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] == target) return mid;
        if (nums[lo] <= nums[mid]) {                          // left sorted
            if (nums[lo] <= target && target < nums[mid]) hi = mid - 1;
            else lo = mid + 1;
        } else {                                              // right sorted
            if (nums[mid] < target && target <= nums[hi]) lo = mid + 1;
            else hi = mid - 1;
        }
    }
    return -1;
}

// Index of the minimum; compare against nums[hi], not nums[lo].
int findRotationPivot(const vector<int>& nums) {
    int lo = 0, hi = (int)nums.size() - 1;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] > nums[hi]) lo = mid + 1;   // cliff is to the right
        else hi = mid;                            // mid may be the minimum
    }
    return lo;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Search in Rotated Array (Optimal) |
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

### Problem — Search Rotated (LeetCode 33)
A sorted array of **distinct** integers was rotated at an unknown pivot. Given the rotated array and a `target`, return the target's index, or `-1`. Required: O(log n).

### Thought Process
1. Rotation creates exactly one descent, so at any `mid` one half is guaranteed sorted.
2. `nums[lo] <= nums[mid]` ⇒ the left half `[lo..mid]` is the sorted one; otherwise the right half `[mid..hi]` is.
3. A sorted half is defined entirely by its two endpoints, so `target` belongs there iff it lies strictly between them (with `mid` excluded, since we already tested it for equality).
4. In the half, or not in the half — either answer discards the other half. That is the O(log n).
5. Use a closed interval `[lo, hi]` with `lo <= hi`, because we want to return `mid` on a direct hit.

### Dry Run

Input: `nums = [4, 5, 6, 7, 0, 1, 2]`, `target = 0`

| step | lo | hi | mid | nums[mid] | `nums[lo] <= nums[mid]`? | sorted half | target inside it? | move |
|------|----|----|-----|-----------|--------------------------|-------------|-------------------|------|
| 1 | 0 | 6 | 3 | 7 | 4 ≤ 7 → yes | left `[4 … 7]` | 0 ∉ [4, 7) → no | `lo = 4` |
| 2 | 4 | 6 | 5 | 1 | 0 ≤ 1 → yes | left `[0 … 1]` | 0 ∈ [0, 1) → yes | `hi = 4` |
| 3 | 4 | 4 | 4 | **0** | — | — | direct hit | return **4** |

Output: **4**

Row 2 is where the subtlety lives. The window `[4..6]` holds `[0,1,2]`, which contains no cliff at all — and the test still behaves: `nums[4] <= nums[5]` says "left sorted", and the range check `0 ∈ [0, 1)` correctly steers left. The algorithm never needs to know *where* the pivot is, only which side of `mid` is clean.

### Visualization

```text
idx    0   1   2   3   4   5   6
nums   4   5   6   7 │ 0   1   2        cliff between idx 3 and 4
                     ↑

step 1   lo=0 ─────── mid=3 ─────── hi=6      target 0
         └─ sorted 4..7 ─┘  0 not in [4,7) → go right
step 2               lo=4 ─ mid=5 ─ hi=6
                     └ 0..1 ┘  0 in [0,1)  → go left
step 3               lo=hi=4  nums[4]=0 = target  ✓

each step halves the window:  7 → 3 → 1
```

### Code

```go
func search(nums []int, target int) int {
    lo, hi := 0, len(nums)-1
    for lo <= hi {
        mid := lo + (hi-lo)/2
        if nums[mid] == target {
            return mid
        }
        // <= not <: when the window is 2 wide, mid == lo, and a single
        // element counts as sorted.
        if nums[lo] <= nums[mid] { // left half [lo..mid] is sorted
            if nums[lo] <= target && target < nums[mid] {
                hi = mid - 1 // target must be in the sorted left
            } else {
                lo = mid + 1 // so it is in the messy right
            }
        } else { // right half [mid..hi] is sorted
            if nums[mid] < target && target <= nums[hi] {
                lo = mid + 1 // target must be in the sorted right
            } else {
                hi = mid - 1 // so it is in the messy left
            }
        }
    }
    return -1
}
```

```python
def search(nums, target):
    lo, hi = 0, len(nums) - 1
    while lo <= hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] == target:
            return mid
        if nums[lo] <= nums[mid]:               # left half is sorted
            if nums[lo] <= target < nums[mid]:
                hi = mid - 1                    # target is in the sorted left
            else:
                lo = mid + 1                    # so it is in the messy right
        else:                                   # right half is sorted
            if nums[mid] < target <= nums[hi]:
                lo = mid + 1                    # target is in the sorted right
            else:
                hi = mid - 1                    # so it is in the messy left
    return -1
```

### Complexity
Time O(log n) — every iteration provably eliminates one half, whether or not the target was in the sorted side. Space O(1).

## 10. Solved Example 2

### Problem — Search Rotated II (LeetCode 81)
The same rotated array, but values may **repeat**. Return `true`/`false` for whether `target` is present.

### Thought Process
1. Reuse the LC33 logic — it is still correct whenever the sorted-half test is *informative*.
2. It stops being informative in exactly one situation: `nums[lo] == nums[mid] == nums[hi]`. Then both halves look identical from the endpoints and either could hold the cliff.
3. In that case no half can be safely discarded, so shrink the window by one on each side (`lo++`, `hi--`) and try again. This is safe because `nums[lo]` and `nums[hi]` both equal `nums[mid]`, which we already know is not the target.
4. That escape hatch is what costs the guarantee: `[1,1,1,…,1,0,1,…,1]` forces one-step shrinking, so the worst case is O(n).
5. Everything else is unchanged.

### Dry Run

Input: `nums = [1, 0, 1, 1, 1]`, `target = 0`

| step | lo | hi | mid | nums[lo], nums[mid], nums[hi] | situation | move |
|------|----|----|-----|-------------------------------|-----------|------|
| 1 | 0 | 4 | 2 | 1, 1, 1 | all equal → **ambiguous** | `lo = 1`, `hi = 3` |
| 2 | 1 | 3 | 2 | 0, 1, 1 | 0 ≤ 1 → left `[0 … 1]` sorted; 0 ∈ [0, 1) | `hi = 1` |
| 3 | 1 | 1 | 1 | nums[1] = **0** | direct hit | return **true** |

Output: **true**

Row 1 is the whole point of this variant. Seeing `1, 1, 1` at the three probes, the window `[1,0,1,1,1]` is indistinguishable from `[1,1,1,0,1]` — discarding either half could throw away the `0`. Dropping just one element from each end is the only move that is guaranteed not to lose the answer.

### Visualization

```text
nums = 1   0   1   1   1        target = 0
idx    0   1   2   3   4
       ↑       ↑       ↑
      lo      mid      hi
       1   ==  1   ==  1   → which side holds the cliff? unknowable

       shrink both ends:  lo++ , hi--
           1   0   1   1   1
               └──────┘          window [1..3] = [0,1,1]
               lo  mid  hi
               0 <= 1 → left [0..1] sorted, 0 ∈ [0,1) → hi = 1 → hit ✓

worst case: [1,1,1,1,1,1,0,1] — every step shrinks by 2 → O(n)
```

### Code

```go
func searchWithDuplicates(nums []int, target int) bool {
    lo, hi := 0, len(nums)-1
    for lo <= hi {
        mid := lo + (hi-lo)/2
        if nums[mid] == target {
            return true
        }
        if nums[lo] == nums[mid] && nums[mid] == nums[hi] {
            // Both halves look identical from the endpoints. Neither can be
            // discarded, but the two ends equal nums[mid] != target, so
            // dropping them loses nothing. This is the O(n) worst case.
            lo++
            hi--
        } else if nums[lo] <= nums[mid] { // left half is sorted
            if nums[lo] <= target && target < nums[mid] {
                hi = mid - 1
            } else {
                lo = mid + 1
            }
        } else { // right half is sorted
            if nums[mid] < target && target <= nums[hi] {
                lo = mid + 1
            } else {
                hi = mid - 1
            }
        }
    }
    return false
}
```

```python
def searchWithDuplicates(nums, target):
    lo, hi = 0, len(nums) - 1
    while lo <= hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] == target:
            return True
        if nums[lo] == nums[mid] == nums[hi]:
            # Ambiguous: neither half can be ruled out. The two ends equal
            # nums[mid] != target, so dropping them is safe. O(n) worst case.
            lo += 1
            hi -= 1
        elif nums[lo] <= nums[mid]:             # left half is sorted
            if nums[lo] <= target < nums[mid]:
                hi = mid - 1
            else:
                lo = mid + 1
        else:                                   # right half is sorted
            if nums[mid] < target <= nums[hi]:
                lo = mid + 1
            else:
                hi = mid - 1
    return False
```

### Complexity
Time O(log n) on typical input, **O(n) worst case** when duplicates force one-step shrinking (e.g. all values equal). Space O(1).

## 11. Solved Example 3

### Problem — Find Min (LeetCode 153)
Return the **minimum** value of a rotated sorted array of distinct values, in O(log n).

### Thought Process
1. The minimum is the element immediately after the cliff — so finding the min is finding the cliff.
2. There is no target to compare against, so compare `nums[mid]` with an endpoint instead. Use `nums[hi]`.
3. `nums[mid] > nums[hi]` means a descent exists somewhere in `(mid, hi]`, so the minimum is strictly right → `lo = mid + 1`.
4. Otherwise `nums[mid] <= nums[hi]` means `[mid..hi]` is clean, so the minimum is `mid` or to its left → `hi = mid` (never `mid - 1`; `mid` is still a candidate).
5. Half-open convergence with `lo < hi`; when they meet, `nums[lo]` is the answer.

### Dry Run

Input: `nums = [4, 5, 6, 7, 0, 1, 2]`

| step | lo | hi | mid | nums[mid] | nums[hi] | `nums[mid] > nums[hi]`? | meaning | move |
|------|----|----|-----|-----------|----------|-------------------------|---------|------|
| 1 | 0 | 6 | 3 | 7 | 2 | yes | cliff is right of `mid` | `lo = 4` |
| 2 | 4 | 6 | 5 | 1 | 2 | no | `[1,2]` is clean | `hi = 5` |
| 3 | 4 | 5 | 4 | 0 | 1 | no | `[0,1]` is clean | `hi = 4` |
| 4 | 4 | 4 | — | loop ends | | | | return `nums[4]` |

Output: **0**

Rows 2 and 3 use `hi = mid`, not `hi = mid - 1`. In row 3 `mid = 4` *is* the minimum — subtracting one would step over the answer and return `nums[5] = 1`.

### Visualization

```text
idx    0   1   2   3   4   5   6
nums   4   5   6   7 │ 0   1   2
                     ↑ minimum = 0 = first element after the cliff

step 1   lo=0 ─────── mid=3 ─────── hi=6    7 > 2 → cliff to the right
step 2                     lo=4 mid=5 hi=6  1 ≤ 2 → clean, keep left half
step 3                     lo=4 hi=5, mid=4 0 ≤ 1 → clean, keep mid itself
step 4                     lo=hi=4          nums[4] = 0  ✓

Why nums[hi] and not nums[lo]?  On a NON-rotated array [1,2,3]:
   nums[lo]=1 <= nums[mid]=2  would read as "cliff on the right" — wrong.
   nums[mid]=2 <= nums[hi]=3  correctly reads as "clean, go left".
```

### Code

```go
func findMin(nums []int) int {
    lo, hi := 0, len(nums)-1
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] > nums[hi] {
            // A descent exists in (mid, hi], so the minimum is strictly right.
            lo = mid + 1
        } else {
            // [mid..hi] is ascending, so the minimum is at mid or left of it.
            // hi = mid, never mid-1: mid itself may be the minimum.
            hi = mid
        }
    }
    return nums[lo]
}
```

```python
def findMin(nums):
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] > nums[hi]:
            lo = mid + 1        # a descent lies in (mid, hi] - go right
        else:
            hi = mid            # [mid..hi] is clean; mid may BE the minimum
    return nums[lo]
```

### Complexity
Time O(log n) — one endpoint comparison discards half the window each step. Space O(1). With duplicates (LeetCode 154) the `nums[mid] == nums[hi]` tie forces `hi--` and the worst case becomes O(n), for the same reason as example 2.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 33 | Search Rotated | Easy | Core binary search application |
| 81 | Search Rotated II | Easy | Core binary search application |
| 153 | Find Min | Medium | Core binary search application |
| 154 | Find Min II | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Search in Rotated Array logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Search in Rotated Array (Binary Search).
- **Signal:** rotated, pivot, sorted rotated, binary search, find min.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Search in Rotated Array invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Search in Rotated Array
FAMILY : Binary Search (Advanced)
WHEN   : rotated, pivot, sorted rotated, binary search, find min
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 33, 81, 153, 154
```

---

*Part of the DSA Patterns Handbook — pattern 26 of 100.*
