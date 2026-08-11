# 11 · Four Sum Pattern

> **One-liner:** Generalize k-sum: recurse fixing elements down to a two-pointer base case.

---

## 1. Overview

### Definition
The **Four Sum Pattern** pattern belongs to the *Two Pointers* family. Generalize k-sum: recurse fixing elements down to a two-pointer base case.

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
4sum, k-sum, quadruplet, recursion, two pointer.

### Constraints
- Input size where the brute-force complexity would time out — the Four Sum Pattern optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Four Sum Pattern invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Four Sum Pattern is the upgrade.
- The wording maps onto: 4sum, k-sum, quadruplet, recursion, two pointer.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which four elements sum to a target?"* — and, more usefully, *"how do I stop the exponent from growing every time the problem adds a number?"*

### Intuition
Four unknowns, four nested loops.

### Algorithm
1. Loop `i`, then `j > i`, then `k > j`, then `l > k`.
2. If the four values sum to `target`, record the quadruplet.
3. Deduplicate the collected quadruplets at the end.

### Complexity
- Time: **O(n⁴)**.
- Space: O(number of results).

### Drawbacks
- At `n = 200`, O(n⁴) is 1.6 × 10⁹ — already too slow, and the constraints go higher.
- Each extra number in the problem statement adds a whole factor of `n`. That's the real problem: the approach doesn't scale with `k`.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Fix numbers with loops until only two are left, then finish with two pointers.**

Two pointers solve the last two in O(n) instead of O(n²). So you always save exactly one factor of `n`, no matter how big `k` gets.

```text
k-Sum = (k-2) nested loops  +  one two-pointer sweep
```

### The thought process

```text
We need    : quadruplets summing to target.
Obvious way: four nested loops.
Too slow   : O(n^4).
Notice     : we already know 3Sum = fix one + two pointers = O(n^2).
             So 4Sum = fix one + 3Sum = O(n^3).
             Unrolled: fix TWO + two pointers.
Therefore  : sort, loop i, loop j, then two-point the remaining suffix.
Now        : O(n^3) — one factor of n cheaper, and the same recipe
             extends to any k.
```

### Steps

```text
Step 1 → Sort the array.
Step 2 → For i = 0 .. n-4:      skip if nums[i] == nums[i-1]
Step 3 →   For j = i+1 .. n-3:  skip if nums[j] == nums[j-1]   (j > i+1 !)
Step 4 →     left = j+1, right = n-1
Step 5 →     while left < right:
Step 6 →         sum = nums[i]+nums[j]+nums[left]+nums[right]
Step 7 →         sum < target → left++
Step 8 →         sum > target → right--
Step 9 →         sum == target → record, skip duplicates on both sides, move both
```

### The dedup rule that trips everyone: `j > i+1`

For the outer index the guard is `i > 0 && nums[i] == nums[i-1]`. For the inner index it must be:

```go
if j > i+1 && nums[j] == nums[j-1] { continue }
```

**Not** `j > 0`. Here's why. Take `nums = [2, 2, 2, 2]`, `target = 8`. When `i = 0` and `j = 1`, we have `nums[j] == nums[j-1]` (both `2`). With a `j > 0` guard we would skip `j = 1` entirely and never find `[2,2,2,2]`.

The rule in words: **the first `j` of each new `i` is always allowed.** Only *repeats within the same `i`* get skipped. `j > i+1` says exactly that.

### Pruning: why it matters here more than in 3Sum

With three nested levels, cheap early exits pay off a lot. Because the array is sorted:

```text
smallest possible sum from here = nums[i] + nums[i+1] + nums[i+2] + nums[i+3]
    → if that already exceeds target, break out entirely

largest possible sum with this i = nums[i] + nums[n-3] + nums[n-2] + nums[n-1]
    → if that is still below target, this i is hopeless → continue
```

These turn many worst-case inputs into near-linear ones without changing the O(n³) bound.

### The other half of this pattern: split into two halves

Sometimes the four numbers come from **four separate arrays** (LeetCode 454). Then indices can't be ordered, sorting doesn't help, and two pointers don't apply. A different trade works:

```text
a + b + c + d = 0
        ⇕
   (a + b) = -(c + d)
```

Count every `a+b` sum in a hash map (n² pairs), then for every `c+d` look up how many partners exist. That's **O(n²) time and O(n²) space** — the *meet in the middle* idea, splitting `k` numbers into two halves of `k/2`.

| Situation | Tool |
|---|---|
| One array, indices must satisfy `i<j<k<l` | sort + fix `k−2` + two pointers |
| Separate arrays, any combination allowed | split in half + hash map of pair sums |

### How should I recognize this?

```text
If you see...
  "find all quadruplets", "four numbers such that..."
  a sum problem where k > 3
        ↓
Think about...
  "Can I peel off numbers with loops until exactly two remain?"
  "Or are these separate arrays — should I split and hash pair sums?"
        ↓
Use...
  one array   → sort, (k-2) loops, two pointers, skip equal neighbours
  k arrays    → hash the first half's sums, look up the second half's
```

### Visual explanation

```svg
<svg viewBox="0 0 640 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="fos-11" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Sorted · fix a[i], a[j], then two-pointer the rest (k-sum → 2-sum)</text>
  <g>
    <rect x="50"  y="46" width="62" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="81"  y="74" text-anchor="middle" fill="#1e293b">-2</text>
    <rect x="120" y="46" width="62" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="151" y="74" text-anchor="middle" fill="#1e293b">-1</text>
    <rect x="190" y="46" width="62" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="221" y="74" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="260" y="46" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="291" y="74" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="330" y="46" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="361" y="74" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="400" y="46" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="431" y="74" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="470" y="46" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="501" y="74" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="540" y="46" width="62" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="571" y="74" text-anchor="middle" fill="#1e293b">4</text>
  </g>
  <text x="81"  y="112" text-anchor="middle" fill="#d97706" font-weight="700">i</text>
  <text x="151" y="112" text-anchor="middle" fill="#d97706" font-weight="700">j</text>
  <text x="221" y="112" text-anchor="middle" fill="#059669" font-weight="700">L</text>
  <text x="571" y="112" text-anchor="middle" fill="#059669" font-weight="700">R</text>
  <line x1="221" y1="126" x2="284" y2="126" stroke="#475569" marker-end="url(#fos-11)"/>
  <line x1="571" y1="126" x2="508" y2="126" stroke="#475569" marker-end="url(#fos-11)"/>
  <text x="320" y="164" text-anchor="middle" fill="#1e293b">two outer loops fix i &amp; j; inner L,R sweep for the remaining sum</text>
</svg>
```

```text
nums = [1, 0, -1, 0, -2, 2]  target = 0    sorted → [-2, -1, 0, 0, 1, 2]

i = 0 (-2), j = 1 (-1)  ⇒  the pair must total +3

[-2, -1,  0,  0,  1,  2]      -2 + -1 + 1 + 2 = 0  ✓  → [-2,-1,1,2]
          ↑              ↑
        left          right
```

### Interview explanation
"4Sum is 3Sum with one more loop, and 3Sum is 2Sum with one more loop. The general recipe is: sort, then fix `k−2` elements with nested loops, and solve the final two with two pointers in O(n). So 4Sum is O(n³). The dedup rule needs care — for the inner index the guard is `j > i+1`, not `j > 0`, otherwise inputs like `[2,2,2,2]` lose their only answer. I'd also prune using the smallest and largest reachable sums. If instead the numbers come from four *different* arrays, sorting doesn't help; I'd hash all `a+b` sums and look up `-(c+d)`, which is O(n²) time and space."

---

## 5. Generic Templates

> `k−2` loops, then two pointers. The recursive version below is the same idea written once for all `k`.

```go
// FourSum returns all unique quadruplets summing to target.
func FourSum(nums []int, target int) [][]int {
    sort.Ints(nums)
    n := len(nums)
    result := [][]int{}

    for i := 0; i < n-3; i++ {
        if i > 0 && nums[i] == nums[i-1] {
            continue // dedup the first fixed number
        }
        for j := i + 1; j < n-2; j++ {
            // j > i+1, NOT j > 0: the first j of each i must be allowed.
            if j > i+1 && nums[j] == nums[j-1] {
                continue
            }

            left, right := j+1, n-1
            for left < right {
                sum := nums[i] + nums[j] + nums[left] + nums[right]
                switch {
                case sum < target:
                    left++
                case sum > target:
                    right--
                default:
                    result = append(result, []int{nums[i], nums[j], nums[left], nums[right]})
                    for left < right && nums[left] == nums[left+1] {
                        left++
                    }
                    for left < right && nums[right] == nums[right-1] {
                        right--
                    }
                    left++
                    right--
                }
            }
        }
    }
    return result
}

// KSum generalises the same recipe: peel off one number at a time until
// two remain, then run the two-pointer sweep. nums must be sorted.
func KSum(nums []int, target, k, start int) [][]int {
    result := [][]int{}
    if start >= len(nums) {
        return result
    }

    if k == 2 {
        left, right := start, len(nums)-1
        for left < right {
            sum := nums[left] + nums[right]
            switch {
            case sum < target:
                left++
            case sum > target:
                right--
            default:
                result = append(result, []int{nums[left], nums[right]})
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            }
        }
        return result
    }

    for i := start; i <= len(nums)-k; i++ {
        if i > start && nums[i] == nums[i-1] {
            continue // dedup within this level
        }
        for _, rest := range KSum(nums, target-nums[i], k-1, i+1) {
            result = append(result, append([]int{nums[i]}, rest...))
        }
    }
    return result
}
```

```python
def four_sum(nums, target):
    nums.sort()
    n, result = len(nums), []

    for i in range(n - 3):
        if i > 0 and nums[i] == nums[i - 1]:
            continue                          # dedup the first fixed number
        for j in range(i + 1, n - 2):
            if j > i + 1 and nums[j] == nums[j - 1]:
                continue                      # j > i+1, NOT j > 0

            left, right = j + 1, n - 1
            while left < right:
                total = nums[i] + nums[j] + nums[left] + nums[right]
                if total < target:
                    left += 1
                elif total > target:
                    right -= 1
                else:
                    result.append([nums[i], nums[j], nums[left], nums[right]])
                    while left < right and nums[left] == nums[left + 1]:
                        left += 1
                    while left < right and nums[right] == nums[right - 1]:
                        right -= 1
                    left += 1
                    right -= 1
    return result

def k_sum(nums, target, k, start=0):
    """Generic k-Sum on a SORTED list: peel one number until two remain."""
    result = []
    if start >= len(nums):
        return result

    if k == 2:
        left, right = start, len(nums) - 1
        while left < right:
            total = nums[left] + nums[right]
            if total < target:
                left += 1
            elif total > target:
                right -= 1
            else:
                result.append([nums[left], nums[right]])
                while left < right and nums[left] == nums[left + 1]:
                    left += 1
                while left < right and nums[right] == nums[right - 1]:
                    right -= 1
                left += 1
                right -= 1
        return result

    for i in range(start, len(nums) - k + 1):
        if i > start and nums[i] == nums[i - 1]:
            continue
        for rest in k_sum(nums, target - nums[i], k - 1, i + 1):
            result.append([nums[i]] + rest)
    return result
```

```java
import java.util.*;

public class FourSumPattern {
    public static List<List<Integer>> fourSum(int[] nums, int target) {
        Arrays.sort(nums);
        int n = nums.length;
        List<List<Integer>> result = new ArrayList<>();

        for (int i = 0; i < n - 3; i++) {
            if (i > 0 && nums[i] == nums[i - 1]) continue;
            for (int j = i + 1; j < n - 2; j++) {
                if (j > i + 1 && nums[j] == nums[j - 1]) continue;  // j > i+1

                int left = j + 1, right = n - 1;
                while (left < right) {
                    // long guards against int overflow when values are extreme.
                    long sum = (long) nums[i] + nums[j] + nums[left] + nums[right];
                    if (sum < target) left++;
                    else if (sum > target) right--;
                    else {
                        result.add(Arrays.asList(nums[i], nums[j], nums[left], nums[right]));
                        while (left < right && nums[left] == nums[left + 1]) left++;
                        while (left < right && nums[right] == nums[right - 1]) right--;
                        left++; right--;
                    }
                }
            }
        }
        return result;
    }
}
```

```cpp
#include <algorithm>
#include <vector>
using namespace std;

vector<vector<int>> fourSum(vector<int> nums, int target) {
    sort(nums.begin(), nums.end());
    int n = (int)nums.size();
    vector<vector<int>> result;

    for (int i = 0; i + 3 < n; ++i) {
        if (i > 0 && nums[i] == nums[i - 1]) continue;
        for (int j = i + 1; j + 2 < n; ++j) {
            if (j > i + 1 && nums[j] == nums[j - 1]) continue;   // j > i+1

            int left = j + 1, right = n - 1;
            while (left < right) {
                long long sum = (long long)nums[i] + nums[j] + nums[left] + nums[right];
                if (sum < target) ++left;
                else if (sum > target) --right;
                else {
                    result.push_back({nums[i], nums[j], nums[left], nums[right]});
                    while (left < right && nums[left] == nums[left + 1]) ++left;
                    while (left < right && nums[right] == nums[right - 1]) --right;
                    ++left; --right;
                }
            }
        }
    }
    return result;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Four Sum Pattern (Optimal) |
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

### Problem — 4Sum (LeetCode 18)
Return all **unique** quadruplets `[a, b, c, d]` from distinct indices with `a + b + c + d == target`.

### Thought Process
1. Sort, so two pointers work and duplicates sit next to each other.
2. Fix two elements with nested loops (`i`, then `j`), leaving a plain two-sum on the suffix.
3. Two pointers finish that in O(n) → O(n³) overall.
4. Dedup `i` with `i > 0 && nums[i] == nums[i-1]`, and `j` with **`j > i+1`** && `nums[j] == nums[j-1]`.
5. After each hit, skip duplicates on both pointers and move both.

### Dry Run

Input: `nums = [1, 0, -1, 0, -2, 2]`, `target = 0` → sorted: **`[-2, -1, 0, 0, 1, 2]`** (indices 0..5)

**i = 0 (`-2`), j = 1 (`-1`)** — the pair must total `0 − (−2) − (−1) = 3`

| left | right | values | sum | action |
|------|-------|--------|-----|--------|
| 2 | 5 | 0, 2 | −1 | < 0 → `left++` |
| 3 | 5 | 0, 2 | −1 | < 0 → `left++` |
| 4 | 5 | 1, 2 | **0** | record **`[-2,-1,1,2]`**, move both → loop ends |

**i = 0, j = 2 (`0`)** — pair must total `2`

| left | right | values | sum | action |
|------|-------|--------|-----|--------|
| 3 | 5 | 0, 2 | **0** | record **`[-2,0,0,2]`**, move both → loop ends |

**i = 0, j = 3 (`0`)** — `j > i+1` (3 > 1) and `nums[3] == nums[2]` → **skipped**. Without this, `[-2,0,0,2]` would be emitted twice.

**i = 1 (`-1`), j = 2 (`0`)** — pair must total `1`

| left | right | values | sum | action |
|------|-------|--------|-----|--------|
| 3 | 5 | 0, 2 | 1 | > 0 → `right--` |
| 3 | 4 | 0, 1 | **0** | record **`[-1,0,0,1]`**, move both → loop ends |

**i = 1, j = 3** → skipped (duplicate `0`). **i = 2 (`0`), j = 3 (`0`)** → sum `0+0+1+2 = 3 > 0`, `right--`, pointers meet, nothing found.

Output: **`[[-2,-1,1,2], [-2,0,0,2], [-1,0,0,1]]`**

### Why `j > i+1` and not `j > 0`

Try `nums = [2,2,2,2]`, `target = 8`. At `i = 0, j = 1`: `nums[1] == nums[0]`, so a `j > 0` guard would `continue` and the loop would never form `[2,2,2,2]` — the one correct answer. `j > i+1` allows the *first* `j` under each `i` and only skips repeats after it.

### Visualization

```text
sorted: [-2, -1,  0,  0,  1,  2]
          0   1   2   3   4   5

i=0, j=1 fix (-2,-1)  ⇒  remaining pair must total 3

        [-2, -1,  0,  0,  1,  2]
                          ↑    ↑    1 + 2 = 3  ✓ → [-2,-1,1,2]
                        left right

i=0, j=3 is another 0  →  skipped (j > i+1 and equals nums[j-1])
```

### Code

```go
func fourSum(nums []int, target int) [][]int {
    sort.Ints(nums)
    n := len(nums)
    result := [][]int{}

    for i := 0; i < n-3; i++ {
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }
        // Prune: the smallest sum reachable from i already overshoots.
        if nums[i]+nums[i+1]+nums[i+2]+nums[i+3] > target {
            break
        }
        // Prune: the largest sum reachable with this i still falls short.
        if nums[i]+nums[n-3]+nums[n-2]+nums[n-1] < target {
            continue
        }

        for j := i + 1; j < n-2; j++ {
            if j > i+1 && nums[j] == nums[j-1] {
                continue // j > i+1: the first j of each i is always allowed
            }

            left, right := j+1, n-1
            for left < right {
                sum := nums[i] + nums[j] + nums[left] + nums[right]
                switch {
                case sum < target:
                    left++
                case sum > target:
                    right--
                default:
                    result = append(result, []int{nums[i], nums[j], nums[left], nums[right]})
                    for left < right && nums[left] == nums[left+1] {
                        left++
                    }
                    for left < right && nums[right] == nums[right-1] {
                        right--
                    }
                    left++
                    right--
                }
            }
        }
    }
    return result
}
```

```python
def fourSum(nums, target):
    nums.sort()
    n, result = len(nums), []

    for i in range(n - 3):
        if i > 0 and nums[i] == nums[i - 1]:
            continue
        if nums[i] + nums[i+1] + nums[i+2] + nums[i+3] > target:
            break                                   # smallest reachable overshoots
        if nums[i] + nums[n-3] + nums[n-2] + nums[n-1] < target:
            continue                                # largest reachable falls short

        for j in range(i + 1, n - 2):
            if j > i + 1 and nums[j] == nums[j - 1]:
                continue                            # j > i+1, not j > 0

            left, right = j + 1, n - 1
            while left < right:
                total = nums[i] + nums[j] + nums[left] + nums[right]
                if total < target:
                    left += 1
                elif total > target:
                    right -= 1
                else:
                    result.append([nums[i], nums[j], nums[left], nums[right]])
                    while left < right and nums[left] == nums[left + 1]:
                        left += 1
                    while left < right and nums[right] == nums[right - 1]:
                        right -= 1
                    left += 1
                    right -= 1
    return result
```

### Complexity
Time **O(n³)** — two nested loops over an O(n) sweep. Space O(1) beyond the output.

---

## 10. Solved Example 2

### Problem — 4Sum II (LeetCode 454)
Given four arrays of equal length `n`, count the index tuples `(i, j, k, l)` with `a[i] + b[j] + c[k] + d[l] == 0`.

### Thought Process
1. This looks like 4Sum, but it is a different problem: the numbers come from **four separate arrays**, so any combination is legal and there is no `i<j<k<l` ordering to exploit.
2. Sorting therefore buys nothing, and two pointers don't apply.
3. But we can **split the four arrays into two halves** and rewrite the condition:
   `a + b + c + d = 0` ⇔ `a + b = −(c + d)`.
4. Enumerate all `n²` sums of `a+b` into a map `sum → how many ways`.
5. Enumerate all `n²` sums of `c+d` and add `map[−(c+d)]` to the answer.
6. We also want *counts*, not distinct tuples — so no deduplication at all.

That is **meet in the middle**: O(n⁴) → O(n²) by splitting `k` numbers into two groups of `k/2`.

### Dry Run

Input: `nums1 = [1,2]`, `nums2 = [-2,-1]`, `nums3 = [-1,2]`, `nums4 = [0,2]`

**Step 1 — count every `a + b`:**

| a | b  | a+b |
|---|----|-----|
| 1 | −2 | −1  |
| 1 | −1 | 0   |
| 2 | −2 | 0   |
| 2 | −1 | 1   |

map = `{−1: 1, 0: 2, 1: 1}`

**Step 2 — for each `c + d`, look up `−(c+d)`:**

| c  | d | c+d | need = −(c+d) | map[need] | running total |
|----|---|-----|---------------|-----------|---------------|
| −1 | 0 | −1  | 1             | 1         | 1 |
| −1 | 2 | 1   | −1            | 1         | 2 |
| 2  | 0 | 2   | −2            | 0         | 2 |
| 2  | 2 | 4   | −4            | 0         | 2 |

Output: **`2`**

The two tuples are `(0,0,0,1)` → `1 + (−2) + (−1) + 2 = 0` and `(1,1,0,0)` → `2 + (−1) + (−1) + 0 = 0`. ✓

### Visualization

```text
   first half              second half
  ┌────────────┐          ┌────────────┐
  │  a  +  b   │          │  c  +  d   │
  └────────────┘          └────────────┘
        │                        │
   build a map              for each sum,
   sum → count              look up -(sum)
        │                        │
        └──────── match ─────────┘

  n² pairs stored  +  n² lookups  =  O(n²)
```

### Code

```go
func fourSumCount(nums1, nums2, nums3, nums4 []int) int {
    // First half: how many ways can a+b make each sum?
    countAB := make(map[int]int, len(nums1)*len(nums2))
    for _, a := range nums1 {
        for _, b := range nums2 {
            countAB[a+b]++
        }
    }

    // Second half: every c+d needs a partner of -(c+d).
    total := 0
    for _, c := range nums3 {
        for _, d := range nums4 {
            total += countAB[-(c + d)]
        }
    }
    return total
}
```

```python
from collections import defaultdict

def fourSumCount(nums1, nums2, nums3, nums4):
    count_ab = defaultdict(int)
    for a in nums1:                       # first half: n² sums
        for b in nums2:
            count_ab[a + b] += 1

    total = 0
    for c in nums3:                       # second half: n² lookups
        for d in nums4:
            total += count_ab[-(c + d)]
    return total
```

### Complexity
Time **O(n²)**, Space **O(n²)** for the map. Compare with O(n⁴) brute force — at `n = 200` that is 1.6 × 10⁹ operations versus 4 × 10⁴.

---

## 11. Solved Example 3

### Problem — 3Sum, solved by the generic k-Sum routine (LeetCode 15)
Find all unique triplets summing to zero — but this time using one routine that handles **any** `k`.

### Thought Process
1. 2Sum, 3Sum, 4Sum all share a shape: peel off one number, recurse on a smaller `k` with an adjusted target.
2. Base case `k == 2`: the two-pointer sweep on the sorted suffix.
3. Recursive case: for each candidate first element, solve `(k−1)`-Sum on the rest for `target − nums[i]`, then prepend.
4. Dedup at every level with the same rule: skip `nums[i] == nums[i-1]` when `i > start`. `start`, not `0` — each recursion level has its own left edge, exactly like `j > i+1` in the unrolled version.
5. Calling it with `k = 3` reproduces 3Sum; `k = 4` reproduces 4Sum.

### Dry Run

Input: `nums = [-1, 0, 1, 2, -1, -4]`, `target = 0`, `k = 3` → sorted: **`[-4, -1, -1, 0, 1, 2]`**

**Level 1 (`k = 3`, start = 0)** — peel off the first number:

| i | nums[i] | recurse as | result of the 2-Sum call | prepend → |
|---|---------|------------|--------------------------|-----------|
| 0 | −4 | 2-Sum on `[-1,-1,0,1,2]` for target `4` | none (max pair is `1+2 = 3`) | — |
| 1 | −1 | 2-Sum on `[-1,0,1,2]` for target `1` | `[-1,2]`, `[0,1]` | `[-1,-1,2]`, `[-1,0,1]` |
| 2 | −1 | `i > start` and `nums[2] == nums[1]` | **skipped** | — |
| 3 | 0  | 2-Sum on `[1,2]` for target `0` | none | — |

**Inside the `i = 1` call** — 2-Sum on indices 2..5 for target `1`:

| left | right | values | sum | action |
|------|-------|--------|-----|--------|
| 2 | 5 | −1, 2 | **1** | record `[-1,2]`; move both |
| 3 | 4 | 0, 1  | **1** | record `[0,1]`; move both |
| 4 | 3 | — | — | stop |

Output: **`[[-1,-1,2], [-1,0,1]]`** — identical to the hand-rolled 3Sum. ✓

### Visualization

```text
kSum(k=3, target=0)
   │
   ├─ peel -4 → kSum(k=2, target=4)  → nothing
   │
   ├─ peel -1 → kSum(k=2, target=1)  → [-1,2], [0,1]
   │                                     ↓ prepend -1
   │                                   [-1,-1,2], [-1,0,1]
   │
   ├─ peel -1 → SKIPPED (duplicate at this level)
   │
   └─ peel  0 → kSum(k=2, target=0)  → nothing

base case k=2 is always the two-pointer sweep
```

### Code

```go
func threeSumViaKSum(nums []int) [][]int {
    sort.Ints(nums) // kSum requires sorted input
    return kSum(nums, 0, 3, 0)
}

// kSum finds unique k-tuples in the sorted nums[start:] summing to target.
func kSum(nums []int, target, k, start int) [][]int {
    result := [][]int{}
    if start+k > len(nums) {
        return result // not enough elements left
    }

    if k == 2 { // base case: the two-pointer sweep
        left, right := start, len(nums)-1
        for left < right {
            sum := nums[left] + nums[right]
            switch {
            case sum < target:
                left++
            case sum > target:
                right--
            default:
                result = append(result, []int{nums[left], nums[right]})
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            }
        }
        return result
    }

    // Recursive case: peel off one number, solve (k-1)-Sum on the rest.
    for i := start; i <= len(nums)-k; i++ {
        if i > start && nums[i] == nums[i-1] {
            continue // dedup relative to THIS level's left edge
        }
        for _, rest := range kSum(nums, target-nums[i], k-1, i+1) {
            tuple := append([]int{nums[i]}, rest...)
            result = append(result, tuple)
        }
    }
    return result
}
```

```python
def threeSumViaKSum(nums):
    nums.sort()                      # kSum requires sorted input
    return kSum(nums, 0, 3, 0)

def kSum(nums, target, k, start):
    """Unique k-tuples in the sorted nums[start:] summing to target."""
    result = []
    if start + k > len(nums):
        return result                # not enough elements left

    if k == 2:                       # base case: two-pointer sweep
        left, right = start, len(nums) - 1
        while left < right:
            total = nums[left] + nums[right]
            if total < target:
                left += 1
            elif total > target:
                right -= 1
            else:
                result.append([nums[left], nums[right]])
                while left < right and nums[left] == nums[left + 1]:
                    left += 1
                while left < right and nums[right] == nums[right - 1]:
                    right -= 1
                left += 1
                right -= 1
        return result

    for i in range(start, len(nums) - k + 1):
        if i > start and nums[i] == nums[i - 1]:
            continue                 # dedup relative to THIS level's left edge
        for rest in kSum(nums, target - nums[i], k - 1, i + 1):
            result.append([nums[i]] + rest)
    return result
```

### Complexity
Time **O(n^(k−1))** — `k−2` levels of looping over an O(n) base sweep, so O(n²) for 3Sum and O(n³) for 4Sum. Space O(k) recursion depth beyond the output.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 18 | 4Sum | Easy | Core two pointers application |
| 454 | 4Sum II | Easy | Core two pointers application |
| 15 | 3Sum | Medium | Core two pointers application |
| 1 | Two Sum | Medium | Core two pointers application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Four Sum Pattern logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Four Sum Pattern (Two Pointers).
- **Signal:** 4sum, k-sum, quadruplet, recursion, two pointer.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Four Sum Pattern invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Four Sum Pattern
FAMILY : Two Pointers (Intermediate)
WHEN   : 4sum, k-sum, quadruplet, recursion, two pointer
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 18, 454, 15, 1
```

---

*Part of the DSA Patterns Handbook — pattern 11 of 100.*
