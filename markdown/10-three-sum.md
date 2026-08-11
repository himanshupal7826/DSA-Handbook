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

**The question this pattern keeps answering:** *"Which three elements satisfy a condition on their sum?"*

### Intuition
Three unknowns, so three nested loops.

### Algorithm
1. For each `i` from `0` to `n−3`:
2. &nbsp;&nbsp;For each `j` from `i+1` to `n−2`:
3. &nbsp;&nbsp;&nbsp;&nbsp;For each `k` from `j+1` to `n−1`:
4. &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;If `nums[i] + nums[j] + nums[k] == 0`, record the triplet.
5. Afterwards, remove duplicate triplets (e.g. by sorting each one and putting them in a set).

### Complexity
- Time: **O(n³)** — plus the deduplication pass.
- Space: O(number of triplets) for the set.

### Drawbacks
- At `n = 3000`, O(n³) is 2.7 × 10¹⁰ operations. Hopeless.
- Deduplication is bolted on at the end, which is both slow and fiddly.
- The innermost loop is doing a *search*, and we already know how to do that faster.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Fix one number, and the problem collapses into Two Sum — which sorting lets you solve with two pointers in O(n).**

That's the whole trick. If you commit to `nums[i]` as the first element, the other two must add up to `−nums[i]`. You already have an O(n) tool for that.

### The thought process

```text
We need    : triplets summing to zero.
Obvious way: three nested loops.
Too slow   : O(n^3).
Notice     : once the FIRST number is fixed, the remaining question is
             "find two numbers summing to -nums[i]" — that's Two Sum.
Notice too : if the array is sorted, Two Sum takes O(n) with two pointers
             and no extra memory.
Therefore  : sort once, loop over the first element, two-point the rest.
Now        : O(n) outer × O(n) inner = O(n^2). And sorting hands us
             duplicate handling for free, because equal values sit together.
```

### Why sort first — it buys you two things

1. **Two pointers become possible.** Moving `left` right raises the sum; moving `right` left lowers it. Without sortedness there's no steering.
2. **Duplicates become adjacent**, so skipping them is a local check (`nums[i] == nums[i-1]`) rather than a global set.

That second benefit is the one people underestimate. Deduplicating *during* the scan is far cheaper than deduplicating a pile of triplets afterwards.

### Steps

```text
Step 1 → Sort the array.
Step 2 → For i = 0 .. n-3:
Step 3 →     if i > 0 and nums[i] == nums[i-1]: skip   ← dedup the first number
Step 4 →     left = i+1, right = n-1
Step 5 →     while left < right:
Step 6 →         sum = nums[i] + nums[left] + nums[right]
Step 7 →         sum < 0 → left++      (need more)
Step 8 →         sum > 0 → right--     (need less)
Step 9 →         sum == 0 → record it, then advance BOTH past their duplicates
```

### The three deduplication rules (where every bug lives)

**Rule 1 — skip a repeated first element, but only after using it once.**

```go
if i > 0 && nums[i] == nums[i-1] { continue }
```

The `i > 0` matters. Without it, `i = 0` reads `nums[-1]`. And the check must be against the *previous* index, not the next: we want to use the first copy and skip later ones. Checking `nums[i] == nums[i+1]` would skip the first copy and break inputs like `[-1,-1,2]`.

**Rule 2 — after recording a hit, move both pointers past their duplicates.**

```go
for left < right && nums[left] == nums[left+1] { left++ }
for left < right && nums[right] == nums[right-1] { right-- }
left++
right--
```

**Rule 3 — move both pointers on a hit, not just one.** With `nums[i]` fixed, if `nums[left]` stayed put its partner is uniquely determined, so keeping it can only reproduce the same triplet.

### Why this doesn't miss anything

Every triplet has a smallest-index member. The outer loop tries every possible first element, and for each one the two-pointer sweep provably finds *all* valid pairs in the remaining suffix (each step retires an index that cannot participate). So no triplet escapes.

### The generalisation: k-Sum

The same recipe stacks:

```text
2Sum (sorted) : two pointers                          O(n)
3Sum          : fix 1, then 2Sum                      O(n^2)
4Sum          : fix 2, then 2Sum                      O(n^3)
k-Sum         : fix k-2, then 2Sum                    O(n^(k-1))
```

### How should I recognize this?

```text
If you see...
  "find all triplets / three numbers such that..."
  "sum to zero / to target", "closest to target", "count triplets less than"
  the order of the answer doesn't matter, and duplicates must not repeat
        ↓
Think about...
  "If I fix one element, is what's left just Two Sum?"
        ↓
Use...
  sort → outer loop over the fixed element → two pointers inside
  and dedup by SKIPPING EQUAL NEIGHBOURS, not with a set
```

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

```text
nums = [-1, 0, 1, 2, -1, -4]      sorted → [-4, -1, -1, 0, 1, 2]

i = 1 (value -1), so left+right must total +1

[-4, -1, -1,  0,  1,  2]      -1 + (-1) + 2 = 0  ✓  record [-1,-1,2]
          ↑              ↑
        left          right

[-4, -1, -1,  0,  1,  2]      -1 +   0  + 1 = 0  ✓  record [-1,0,1]
              ↑      ↑
            left   right
```

### Interview explanation
"I'll sort the array first — that costs O(n log n) but makes everything else easy. Then I fix the first element with an outer loop, which reduces the rest to Two Sum on a sorted array, solvable with two pointers in O(n). Total O(n²), which beats O(n³). Sorting also makes duplicates adjacent, so I dedupe by skipping equal neighbours rather than collecting triplets in a set — for the fixed element I skip if it equals the previous one, and after each hit I advance both pointers past their duplicates. O(n²) time and O(1) extra space beyond the output."

---

## 5. Generic Templates

> Sort, fix the outer element, two-point the rest, skip equal neighbours.

```go
// ThreeSum returns every unique triplet summing to zero.
func ThreeSum(nums []int) [][]int {
    sort.Ints(nums) // enables two pointers AND groups duplicates
    result := [][]int{}

    for i := 0; i < len(nums)-2; i++ {
        // Rule 1: use the first copy of a value, skip the rest.
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }
        // Smallest possible value is already positive: no triplet can reach 0.
        if nums[i] > 0 {
            break
        }

        left, right := i+1, len(nums)-1
        for left < right {
            sum := nums[i] + nums[left] + nums[right]
            switch {
            case sum < 0:
                left++ // need a bigger sum
            case sum > 0:
                right-- // need a smaller sum
            default:
                result = append(result, []int{nums[i], nums[left], nums[right]})
                // Rule 2: step past duplicates on both sides.
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                // Rule 3: move BOTH — keeping one fixed repeats the triplet.
                left++
                right--
            }
        }
    }
    return result
}
```

```python
def three_sum(nums):
    """Every unique triplet summing to zero."""
    nums.sort()                       # enables two pointers AND groups duplicates
    result = []

    for i in range(len(nums) - 2):
        if i > 0 and nums[i] == nums[i - 1]:   # rule 1: skip repeated first element
            continue
        if nums[i] > 0:                        # smallest is positive: impossible
            break

        left, right = i + 1, len(nums) - 1
        while left < right:
            total = nums[i] + nums[left] + nums[right]
            if total < 0:
                left += 1                      # need a bigger sum
            elif total > 0:
                right -= 1                     # need a smaller sum
            else:
                result.append([nums[i], nums[left], nums[right]])
                while left < right and nums[left] == nums[left + 1]:
                    left += 1                  # rule 2
                while left < right and nums[right] == nums[right - 1]:
                    right -= 1
                left += 1                      # rule 3: move both
                right -= 1
    return result
```

```java
import java.util.*;

public class ThreeSumPattern {
    public static List<List<Integer>> threeSum(int[] nums) {
        Arrays.sort(nums);
        List<List<Integer>> result = new ArrayList<>();

        for (int i = 0; i < nums.length - 2; i++) {
            if (i > 0 && nums[i] == nums[i - 1]) continue;   // rule 1
            if (nums[i] > 0) break;

            int left = i + 1, right = nums.length - 1;
            while (left < right) {
                int sum = nums[i] + nums[left] + nums[right];
                if (sum < 0) left++;
                else if (sum > 0) right--;
                else {
                    result.add(Arrays.asList(nums[i], nums[left], nums[right]));
                    while (left < right && nums[left] == nums[left + 1]) left++;   // rule 2
                    while (left < right && nums[right] == nums[right - 1]) right--;
                    left++; right--;                                               // rule 3
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

vector<vector<int>> threeSum(vector<int> nums) {
    sort(nums.begin(), nums.end());
    vector<vector<int>> result;

    for (int i = 0; i + 2 < (int)nums.size(); ++i) {
        if (i > 0 && nums[i] == nums[i - 1]) continue;   // rule 1
        if (nums[i] > 0) break;

        int left = i + 1, right = (int)nums.size() - 1;
        while (left < right) {
            int sum = nums[i] + nums[left] + nums[right];
            if (sum < 0) ++left;
            else if (sum > 0) --right;
            else {
                result.push_back({nums[i], nums[left], nums[right]});
                while (left < right && nums[left] == nums[left + 1]) ++left;      // rule 2
                while (left < right && nums[right] == nums[right - 1]) --right;
                ++left; --right;                                                  // rule 3
            }
        }
    }
    return result;
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
Return all **unique** triplets `[nums[i], nums[j], nums[k]]` with distinct indices that sum to zero.

### Thought Process
1. Sort first: it enables two pointers and puts equal values side by side.
2. Fix `nums[i]` as the smallest member of the triplet; the rest is "find two values summing to `−nums[i]`".
3. Two pointers on the suffix solve that in O(n).
4. Dedupe by skipping equal neighbours — for `i`, and for both pointers after a hit.
5. Once `nums[i] > 0` we can stop: the array is sorted, so the two larger values are positive too and the sum can never be zero.

### Dry Run

Input: `nums = [-1, 0, 1, 2, -1, -4]` → sorted: **`[-4, -1, -1, 0, 1, 2]`** (indices 0..5)

**i = 0, value `-4`** — need `left + right = 4`

| left | right | values | sum | action |
|------|-------|--------|-----|--------|
| 1 | 5 | −1, 2 | −3 | < 0 → `left++` |
| 2 | 5 | −1, 2 | −3 | < 0 → `left++` |
| 3 | 5 | 0, 2  | −2 | < 0 → `left++` |
| 4 | 5 | 1, 2  | −1 | < 0 → `left++` |
| 5 | 5 | —     | —  | `left == right` → stop |

**i = 1, value `-1`** — need `left + right = 1`

| left | right | values | sum | action |
|------|-------|--------|-----|--------|
| 2 | 5 | −1, 2 | **0** | record **`[-1,-1,2]`**; no dups adjacent; `left→3`, `right→4` |
| 3 | 4 | 0, 1  | **0** | record **`[-1,0,1]`**; `left→4`, `right→3` |
| 4 | 3 | —     | —     | `left > right` → stop |

**i = 2, value `-1`** — `nums[2] == nums[1]` → **skipped by rule 1.** This is what stops `[-1,-1,2]` and `[-1,0,1]` from being emitted twice.

**i = 3, value `0`** — need `left + right = 0`

| left | right | values | sum | action |
|------|-------|--------|-----|--------|
| 4 | 5 | 1, 2 | 3 | > 0 → `right--` |
| 4 | 4 | —    | — | stop |

Output: **`[[-1,-1,2], [-1,0,1]]`**

### Visualization

```text
sorted: [-4, -1, -1,  0,  1,  2]
          0    1   2   3   4   5

i=1 fixes -1, so the pair must total +1:

        [-4, -1, -1,  0,  1,  2]
                  ↑           ↑     -1 + 2 = 1 ✓  → [-1,-1,2]
                left        right

        [-4, -1, -1,  0,  1,  2]
                      ↑    ↑        0 + 1 = 1 ✓  → [-1,0,1]

i=2 is another -1  →  skipped (identical work, duplicate output)
```

### Code

```go
func threeSum(nums []int) [][]int {
    sort.Ints(nums)
    result := [][]int{}

    for i := 0; i < len(nums)-2; i++ {
        if nums[i] > 0 {
            break // smallest of the three is positive: sum can't be 0
        }
        if i > 0 && nums[i] == nums[i-1] {
            continue // already used this value as the fixed element
        }

        left, right := i+1, len(nums)-1
        for left < right {
            sum := nums[i] + nums[left] + nums[right]
            switch {
            case sum < 0:
                left++
            case sum > 0:
                right--
            default:
                result = append(result, []int{nums[i], nums[left], nums[right]})
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
    return result
}
```

```python
def threeSum(nums):
    nums.sort()
    result = []
    for i in range(len(nums) - 2):
        if nums[i] > 0:
            break                                  # sum can't reach 0
        if i > 0 and nums[i] == nums[i - 1]:
            continue                               # value already used as fixed element
        left, right = i + 1, len(nums) - 1
        while left < right:
            total = nums[i] + nums[left] + nums[right]
            if total < 0:
                left += 1
            elif total > 0:
                right -= 1
            else:
                result.append([nums[i], nums[left], nums[right]])
                while left < right and nums[left] == nums[left + 1]:
                    left += 1
                while left < right and nums[right] == nums[right - 1]:
                    right -= 1
                left += 1
                right -= 1
    return result
```

### Complexity
Time **O(n²)** — an O(n) two-pointer sweep for each of `n` fixed elements; the O(n log n) sort is dominated. Space O(1) beyond the output.

---

## 10. Solved Example 2

### Problem — 3Sum Closest (LeetCode 16)
Return the sum of the three integers whose total is **closest** to `target`.

### Thought Process
1. Same skeleton: sort, fix one element, two pointers on the rest.
2. The only change is what we do with the comparison. Instead of requiring an exact match, we record how close we got.
3. Track `best` — the closest sum seen so far — and update it whenever `|sum − target|` improves.
4. Steer as usual: `sum < target` → `left++`, `sum > target` → `right--`.
5. `sum == target` is the best possible result, so return immediately.

**No deduplication is needed here** — we return a single number, not a list, so repeated triplets are harmless.

### Dry Run

Input: `nums = [-1, 2, 1, -4]`, `target = 1` → sorted: **`[-4, -1, 1, 2]`**

**i = 0, value `-4`**

| left | right | sum | \|sum − 1\| | best so far | action |
|------|-------|-----|-------------|-------------|--------|
| 1 | 3 | −4−1+2 = **−3** | 4 | −3 (first) | −3 < 1 → `left++` |
| 2 | 3 | −4+1+2 = **−1** | 2 | **−1** (closer) | −1 < 1 → `left++` |
| 3 | 3 | — | — | — | stop |

**i = 1, value `-1`**

| left | right | sum | \|sum − 1\| | best so far | action |
|------|-------|-----|-------------|-------------|--------|
| 2 | 3 | −1+1+2 = **2** | 1 | **2** (closer than −1, whose distance was 2) | 2 > 1 → `right--` |
| 2 | 2 | — | — | — | stop |

**i = 2** — `left = 3`, `right = 3`, loop never runs.

Output: **`2`** (from the triplet `[-1, 1, 2]`) ✓

### Visualization

```text
sorted: [-4, -1,  1,  2]     target = 1

candidate sums and their distance from the target:

   -3  ·······|······· distance 4
   -1  ····|·········· distance 2
    2  ·|················ distance 1   ★ closest
        ↑
      target 1
```

### Code

```go
func threeSumClosest(nums []int, target int) int {
    sort.Ints(nums)
    best := nums[0] + nums[1] + nums[2] // any valid triplet as a starting point

    for i := 0; i < len(nums)-2; i++ {
        left, right := i+1, len(nums)-1
        for left < right {
            sum := nums[i] + nums[left] + nums[right]
            if abs(sum-target) < abs(best-target) {
                best = sum
            }
            switch {
            case sum < target:
                left++ // need a bigger sum
            case sum > target:
                right-- // need a smaller sum
            default:
                return sum // exact hit: cannot do better
            }
        }
    }
    return best
}

func abs(x int) int {
    if x < 0 {
        return -x
    }
    return x
}
```

```python
def threeSumClosest(nums, target):
    nums.sort()
    best = nums[0] + nums[1] + nums[2]      # any valid triplet to start
    for i in range(len(nums) - 2):
        left, right = i + 1, len(nums) - 1
        while left < right:
            total = nums[i] + nums[left] + nums[right]
            if abs(total - target) < abs(best - target):
                best = total
            if total < target:
                left += 1                    # need a bigger sum
            elif total > target:
                right -= 1                   # need a smaller sum
            else:
                return total                 # exact hit
    return best
```

### Complexity
Time O(n²), Space O(1).

---

## 11. Solved Example 3

### Problem — 3Sum Smaller (LeetCode 259)
**Count** the index triplets `i < j < k` with `nums[i] + nums[j] + nums[k] < target`.

### Thought Process
1. We need a count, not the triplets themselves — so we should aim to count many at once rather than enumerate.
2. Sort, fix `nums[i]`, two pointers as usual.
3. **The key insight:** if `nums[i] + nums[left] + nums[right] < target`, then replacing `right` with *any* index between `left+1` and `right` gives an even smaller sum — because the array is sorted.
4. So that single test validates `right − left` triplets at once. Add them and do `left++`.
5. If the sum is too big, `right--` as usual.

Counting in blocks is what keeps this O(n²) instead of O(n³).

### Dry Run

Input: `nums = [-2, 0, 1, 3]`, `target = 2` → already sorted

**i = 0, value `-2`**

| left | right | sum | < 2? | count added | why |
|------|-------|-----|------|-------------|-----|
| 1 | 3 | −2+0+3 = **1** | yes | `right − left = 2` | both `(-2,0,1)` and `(-2,0,3)` work |
| 2 | 3 | −2+1+3 = **2** | no  | 0 | not strictly less → `right--` |
| 2 | 2 | — | — | — | stop |

Running count: **2**

**i = 1, value `0`**

| left | right | sum | < 2? | action |
|------|-------|-----|------|--------|
| 2 | 3 | 0+1+3 = **4** | no | `right--` |
| 2 | 2 | — | — | stop |

**i = 2** — `left = 3`, `right = 3`, loop never runs.

Output: **`2`** — the triplets `[-2, 0, 1]` and `[-2, 0, 3]`. ✓

### Visualization

```text
sorted: [-2,  0,  1,  3]      target = 2
          i   ↑       ↑
             left   right

-2 + 0 + 3 = 1 < 2   ✓
   ⇒ everything between left+1 and right also works, because the
     array is sorted and those values are ≤ nums[right]:

        -2 + 0 + 1  = -1  ✓
        -2 + 0 + 3  =  1  ✓
   ⇒ count += right - left = 3 - 1 = 2   (two triplets in one step)
```

### Code

```go
func threeSumSmaller(nums []int, target int) int {
    sort.Ints(nums)
    count := 0

    for i := 0; i < len(nums)-2; i++ {
        left, right := i+1, len(nums)-1
        for left < right {
            if nums[i]+nums[left]+nums[right] < target {
                // Every index in (left, right] pairs with left to stay under
                // target, because the array is sorted.
                count += right - left
                left++
            } else {
                right-- // sum too big: shrink it
            }
        }
    }
    return count
}
```

```python
def threeSumSmaller(nums, target):
    nums.sort()
    count = 0
    for i in range(len(nums) - 2):
        left, right = i + 1, len(nums) - 1
        while left < right:
            if nums[i] + nums[left] + nums[right] < target:
                count += right - left     # all of (left, right] work at once
                left += 1
            else:
                right -= 1                # sum too big
    return count
```

### Complexity
Time O(n²), Space O(1). The `count += right - left` step is what avoids the O(n³) enumeration.

---

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
