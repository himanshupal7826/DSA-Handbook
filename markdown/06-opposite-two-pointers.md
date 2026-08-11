# 06 · Opposite Direction Two Pointers

> **One-liner:** Shrink a window from both ends toward the middle on sorted/symmetric data.

---

## 1. Overview

### Definition
The **Opposite Direction Two Pointers** pattern belongs to the *Two Pointers* family. Shrink a window from both ends toward the middle on sorted/symmetric data.

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
two pointer, left right, converge, sorted, pair sum, palindrome.

### Constraints
- Input size where the brute-force complexity would time out — the Opposite Direction Two Pointers optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Opposite Direction Two Pointers invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Opposite Direction Two Pointers is the upgrade.
- The wording maps onto: two pointer, left right, converge, sorted, pair sum, palindrome.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which pair of elements — one from somewhere, one from somewhere else — satisfies my condition?"*

Running example: a **sorted** array and a `target`; find the two values that add to it.

### Intuition
With no strategy, try every pair.

### Algorithm
1. For each index `i` from `0` to `n−1`:
2. &nbsp;&nbsp;For each index `j` from `i+1` to `n−1`:
3. &nbsp;&nbsp;&nbsp;&nbsp;If `nums[i] + nums[j] == target`, return the pair.
4. Otherwise keep going.

### Complexity
- Time: **O(n²)**.
- Space: O(1).

### Drawbacks
- It throws away the single most useful fact we were given: **the array is sorted**.
- When `nums[i] + nums[j]` comes out too large, the brute force learns nothing from that. But it just proved something: with `nums[j]` being the largest remaining candidate, *no* `j' > j` can help either. A whole block of pairs could have been discarded, and wasn't.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Start with the widest possible pair — first and last — and let the comparison tell you which end to move in.**

Because the array is sorted, moving the left pointer right can only **increase** the sum, and moving the right pointer left can only **decrease** it. So the sum has a steering wheel, and the comparison against `target` tells you which way to turn.

### The thought process

```text
We need    : two values summing to target, in a SORTED array.
Obvious way: try all pairs.
Too slow   : O(n²), and it ignores the sortedness.
Notice     : put left at the smallest value and right at the largest.
             sum too small?  the only way to grow it is left++
             sum too big?    the only way to shrink it is right--
             Each move throws away a whole row of pairs, safely.
Therefore  : walk the two pointers toward each other.
Now        : every step eliminates one index for good → O(n).
```

### Why each move is safe (this is the part worth understanding)

Suppose `nums[left] + nums[right] < target`.

Ask: could `nums[left]` pair with anything at all? Its best possible partner is the biggest remaining value, which is `nums[right]` — and even *that* fell short. So `nums[left]` is hopeless with **every** remaining index. We can discard it entirely and do `left++`.

The mirror argument holds when the sum is too big: `nums[right]` is too large even paired with the smallest remaining value, so `right--`.

Each step permanently removes one index from consideration. There are `n` indices, so the loop runs at most `n` times — that is where O(n) comes from.

### Steps

```text
Step 1 → left = 0, right = n-1.
Step 2 → While left < right:
Step 3 →     sum = nums[left] + nums[right]
Step 4 →     if sum == target → found it, return.
Step 5 →     if sum <  target → left++    (need a bigger sum)
Step 6 →     if sum >  target → right--   (need a smaller sum)
Step 7 → Loop ended → no such pair exists.
```

### Why `left < right` and not `left <= right`

`left == right` would mean pairing an element with itself, which isn't a pair. Stopping at `left < right` also guarantees termination: every iteration moves one pointer inward, so the gap strictly shrinks.

### The same shape, different condition

Opposite-direction pointers aren't only for sums. The skeleton is always *"two ends, move the one that can still help"*:

| Problem | Condition checked | Which pointer moves |
|---|---|---|
| Pair with sum `target` | `sum` vs `target` | the end that fixes the sum |
| Palindrome check | `s[left] == s[right]` | both, inward, on a match |
| Reverse in place | always | both, after swapping |
| Container with most water | which wall is shorter | the shorter wall |

### How should I recognize this?

```text
If you see...
  a SORTED array (or one you're allowed to sort)
  "find a pair", "two numbers that sum to", "closest pair"
  "palindrome", "reverse in place", "from both ends"
  a nested loop where one index counts up and the other counts down
        ↓
Think about...
  "If I stand at both ends, does the comparison tell me
   which end can be safely thrown away?"
        ↓
Use...
  left = 0, right = n-1, walk inward while left < right.
```

> **Prerequisite check:** this only works when moving a pointer changes the quantity in a *predictable direction*. Sortedness is the usual source of that guarantee. On unsorted data with arbitrary indices, use a hash map instead.

### Visual explanation

```svg
<svg viewBox="0 0 640 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="op-06" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Sorted array · target = 10 · converge L and R</text>
  <g>
    <rect x="60"  y="46" width="74" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="97"  y="74" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="140" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="177" y="74" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="220" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="257" y="74" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="300" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="337" y="74" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="380" y="46" width="74" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="417" y="74" text-anchor="middle" fill="#1e293b">8</text>
    <rect x="460" y="46" width="74" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="497" y="74" text-anchor="middle" fill="#1e293b">11</text>
  </g>
  <text x="97"  y="112" text-anchor="middle" fill="#059669" font-weight="700">L</text>
  <text x="497" y="112" text-anchor="middle" fill="#059669" font-weight="700">R</text>
  <line x1="110" y1="126" x2="176" y2="126" stroke="#475569" marker-end="url(#op-06)"/>
  <line x1="484" y1="126" x2="418" y2="126" stroke="#475569" marker-end="url(#op-06)"/>
  <text x="320" y="164" text-anchor="middle" fill="#1e293b">1 + 11 = 12 &gt; 10  →  move R inward to shrink the sum</text>
</svg>
```

```text
nums = [2, 3, 5, 7, 9]   target = 12

 [2,  3,  5,  7,  9]      2 + 9 = 11 < 12  → too small → left++
  ↑               ↑
 left           right

 [2,  3,  5,  7,  9]      3 + 9 = 12 = 12  → FOUND
      ↑           ↑
     left       right
```

### Interview explanation
"The array is sorted, so I'll use two pointers at the ends. If the sum is too small, the left value can't work with anything — its best partner is already the largest element — so I move left in. If the sum is too big, I move right in by the same argument. Each step eliminates one index permanently, so it's O(n) time and O(1) space, versus O(n²) for the brute force."

---

## 5. Generic Templates

> Two ends, walk inward, let the comparison choose the pointer.

```go
// TwoSumSorted finds two values in a sorted slice that add to target.
// Returns their indices, or nil if no such pair exists.
func TwoSumSorted(nums []int, target int) []int {
    left, right := 0, len(nums)-1
    for left < right {
        sum := nums[left] + nums[right]
        switch {
        case sum == target:
            return []int{left, right}
        case sum < target:
            left++ // nums[left] is too small even with the biggest partner
        default:
            right-- // nums[right] is too big even with the smallest partner
        }
    }
    return nil
}

// IsPalindrome walks inward comparing mirrored characters.
func IsPalindrome(s string) bool {
    left, right := 0, len(s)-1
    for left < right {
        if s[left] != s[right] {
            return false
        }
        left++
        right--
    }
    return true
}

// ReverseInPlace swaps the ends and closes in.
func ReverseInPlace(nums []int) {
    for left, right := 0, len(nums)-1; left < right; left, right = left+1, right-1 {
        nums[left], nums[right] = nums[right], nums[left]
    }
}
```

```python
def two_sum_sorted(nums, target):
    """Indices of the two values summing to target, in a sorted list."""
    left, right = 0, len(nums) - 1
    while left < right:
        total = nums[left] + nums[right]
        if total == target:
            return [left, right]
        if total < target:
            left += 1       # too small: nums[left] can never work
        else:
            right -= 1      # too big: nums[right] can never work
    return None

def is_palindrome(s):
    left, right = 0, len(s) - 1
    while left < right:
        if s[left] != s[right]:
            return False
        left += 1
        right -= 1
    return True

def reverse_in_place(nums):
    left, right = 0, len(nums) - 1
    while left < right:
        nums[left], nums[right] = nums[right], nums[left]
        left += 1
        right -= 1
```

```java
public class OppositeTwoPointers {
    public static int[] twoSumSorted(int[] nums, int target) {
        int left = 0, right = nums.length - 1;
        while (left < right) {
            int sum = nums[left] + nums[right];
            if (sum == target) return new int[]{left, right};
            if (sum < target) left++;      // too small
            else right--;                  // too big
        }
        return null;
    }

    public static boolean isPalindrome(String s) {
        int left = 0, right = s.length() - 1;
        while (left < right) {
            if (s.charAt(left) != s.charAt(right)) return false;
            left++; right--;
        }
        return true;
    }

    public static void reverseInPlace(int[] nums) {
        for (int left = 0, right = nums.length - 1; left < right; left++, right--) {
            int t = nums[left]; nums[left] = nums[right]; nums[right] = t;
        }
    }
}
```

```cpp
#include <string>
#include <vector>
using namespace std;

vector<int> twoSumSorted(const vector<int>& nums, int target) {
    int left = 0, right = (int)nums.size() - 1;
    while (left < right) {
        int sum = nums[left] + nums[right];
        if (sum == target) return {left, right};
        if (sum < target) ++left;      // too small
        else --right;                  // too big
    }
    return {};
}

bool isPalindrome(const string& s) {
    int left = 0, right = (int)s.size() - 1;
    while (left < right) {
        if (s[left] != s[right]) return false;
        ++left; --right;
    }
    return true;
}

void reverseInPlace(vector<int>& nums) {
    for (int left = 0, right = (int)nums.size() - 1; left < right; ++left, --right)
        swap(nums[left], nums[right]);
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Opposite Direction Two Pointers (Optimal) |
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

### Problem — Two Sum II, Input Array Is Sorted (LeetCode 167)
Given a **1-indexed** sorted array and a `target`, return the two 1-based indices whose values add up to the target. Exactly one solution exists, and you must use O(1) extra space.

### Thought Process
1. O(1) space rules out a hash map — so we must exploit the sortedness instead.
2. Put `left` at the smallest value and `right` at the largest.
3. Compare `nums[left] + nums[right]` with `target`:
   - too small → the only way to grow the sum is `left++`
   - too big → the only way to shrink it is `right--`
4. Each move discards an index that provably cannot be part of any answer.
5. Convert to 1-based indices when returning.

### Dry Run

Input: `numbers = [2, 7, 11, 15]`, `target = 9`

| left | right | nums[left] | nums[right] | sum | vs target | action |
|------|-------|------------|-------------|-----|-----------|--------|
| 0    | 3     | 2          | 15          | 17  | too big   | `right--` |
| 0    | 2     | 2          | 11          | 13  | too big   | `right--` |
| 0    | 1     | 2          | 7           | 9   | **equal** | return `[1, 2]` |

Output: **`[1, 2]`** (1-based)

Why discarding `15` was safe: `15` paired with the *smallest* value (2) already overshot 9, so it overshoots with every other value too.

### Visualization

```text
[ 2,  7, 11, 15]   2+15 = 17 > 9   → right--
  ↑           ↑
 left       right

[ 2,  7, 11, 15]   2+11 = 13 > 9   → right--
  ↑       ↑

[ 2,  7, 11, 15]   2+ 7 =  9 = 9   → FOUND, 1-based [1,2]
  ↑   ↑
```

### Code

```go
func twoSumSorted(numbers []int, target int) []int {
    left, right := 0, len(numbers)-1
    for left < right {
        sum := numbers[left] + numbers[right]
        if sum == target {
            return []int{left + 1, right + 1} // problem uses 1-based indices
        }
        if sum < target {
            left++ // need a bigger sum
        } else {
            right-- // need a smaller sum
        }
    }
    return nil
}
```

```python
def twoSum(numbers, target):
    left, right = 0, len(numbers) - 1
    while left < right:
        total = numbers[left] + numbers[right]
        if total == target:
            return [left + 1, right + 1]   # 1-based indices
        if total < target:
            left += 1                      # need a bigger sum
        else:
            right -= 1                     # need a smaller sum
    return []
```

### Complexity
Time O(n) — each iteration retires one index. Space O(1).

---

## 10. Solved Example 2

### Problem — Valid Palindrome (LeetCode 125)
Return `true` if `s` reads the same forwards and backwards, considering only alphanumeric characters and ignoring case.

### Thought Process
1. A palindrome is defined by mirrored positions matching — so compare the ends and walk inward.
2. Building a cleaned copy of the string would work but costs O(n) space; skipping junk in place costs O(1).
3. Before each comparison, advance `left` past non-alphanumeric characters and pull `right` back past them.
4. Compare lowercased. On a mismatch, return `false` immediately.
5. If the pointers meet without a mismatch, it's a palindrome.

### Dry Run

Input: `s = "A man, a plan, a canal: Panama"`

The alphanumeric content is `amanaplanacanalpanama` (lowercased).

| step | left char | right char | note |
|------|-----------|------------|------|
| 1 | `A` → `a` | `a` | match, move both inward |
| 2 | `m`  (space skipped) | `m` | match |
| 3 | `a` | `a` | match |
| 4 | `n` (comma skipped) | `n` | match |
| … | … | … | all mirrored pairs match |
| last | pointers cross | | → return **`true`** |

A failing case: `s = "race a car"` → cleaned `raceacar`; `r` vs `r` ✓, `a` vs `a` ✓, `c` vs `c` ✓, then `e` vs `a` ✗ → **`false`**.

### Visualization

```text
"A man, a plan, a canal: Panama"
  ↑                            ↑
 left                        right
 'a'                          'a'      match → move inward

"A man, a plan, a canal: Panama"
     ↑                     ↑
    'm'   (skipped ' ')   'm'          match → move inward
```

### Code

```go
func isPalindrome(s string) bool {
    left, right := 0, len(s)-1
    for left < right {
        // Skip anything that is not a letter or digit.
        for left < right && !isAlnum(s[left]) {
            left++
        }
        for left < right && !isAlnum(s[right]) {
            right--
        }
        if toLower(s[left]) != toLower(s[right]) {
            return false
        }
        left++
        right--
    }
    return true
}

func isAlnum(c byte) bool {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func toLower(c byte) byte {
    if c >= 'A' && c <= 'Z' {
        return c + ('a' - 'A')
    }
    return c
}
```

```python
def isPalindrome(s):
    left, right = 0, len(s) - 1
    while left < right:
        while left < right and not s[left].isalnum():   # skip junk
            left += 1
        while left < right and not s[right].isalnum():
            right -= 1
        if s[left].lower() != s[right].lower():
            return False
        left += 1
        right -= 1
    return True
```

### Complexity
Time O(n) — each character is visited at most once by either pointer. Space O(1) — no cleaned copy is built.

---

## 11. Solved Example 3

### Problem — Container With Most Water (LeetCode 11)
Each `height[i]` is a vertical line. Pick two lines that, with the x-axis, hold the most water. Return that maximum area.

### Thought Process
1. Area between `left` and `right` is `width × shorter wall = (right − left) × min(h[left], h[right])`.
2. Start as wide as possible — `left = 0`, `right = n−1` — because width is maximal there.
3. From now on every move **shrinks the width**, so the only way to improve is to find a taller limiting wall.
4. Move the **shorter** wall inward. Keeping the shorter wall can never help: it caps the height no matter who it's paired with, and the width only gets smaller.
5. Track the best area seen.

### Why moving the shorter wall is the right choice

Say `h[left] < h[right]`. Consider keeping `left` fixed and trying every `right' < right`:

```text
area = (right' - left) × min(h[left], h[right'])
       └── smaller than before ──┘   └── at most h[left] ──┘
```

The width strictly decreased, and the height is still capped by `h[left]`. So **no** pairing that keeps `left` can beat the area we just computed. `left` is finished — discard it. That is exactly one index retired per step, giving O(n).

### Dry Run

Input: `height = [1, 8, 6, 2, 5, 4, 8, 3, 7]` (indices 0..8)

| left | right | h[left] | h[right] | width | height=min | area | best | move |
|------|-------|---------|----------|-------|-----------|------|------|------|
| 0 | 8 | 1 | 7 | 8 | 1 | 8  | 8  | left is shorter → `left++` |
| 1 | 8 | 8 | 7 | 7 | 7 | **49** | 49 | right is shorter → `right--` |
| 1 | 7 | 8 | 3 | 6 | 3 | 18 | 49 | right shorter → `right--` |
| 1 | 6 | 8 | 8 | 5 | 8 | 40 | 49 | equal → move either, say `right--` |
| 1 | 5 | 8 | 4 | 4 | 4 | 16 | 49 | `right--` |
| 1 | 4 | 8 | 5 | 3 | 5 | 15 | 49 | `right--` |
| 1 | 3 | 8 | 2 | 2 | 2 | 4  | 49 | `right--` |
| 1 | 2 | 8 | 6 | 1 | 6 | 6  | 49 | `right--` → pointers meet, stop |

Output: **49** — lines at index 1 (height 8) and index 8 (height 7), width 7.

### Visualization

```text
index :  0  1  2  3  4  5  6  7  8
height:  1  8  6  2  5  4  8  3  7

           8 |█                 █
             |█     █           █
             |█  █  █     █     █   █
             |█  █  █  █  █  █  █   █
           1 |█  █  █  █  █  █  █ █ █
             └──────────────────────
                ↑                 ↑
              left=1           right=8
       width 7 × min(8,7)=7  →  area 49  ★
```

### Code

```go
func maxArea(height []int) int {
    left, right := 0, len(height)-1
    best := 0

    for left < right {
        h := height[left]
        if height[right] < h {
            h = height[right] // the shorter wall caps the water
        }
        area := (right - left) * h
        if area > best {
            best = area
        }

        // Retire the shorter wall: keeping it can never beat this area.
        if height[left] < height[right] {
            left++
        } else {
            right--
        }
    }
    return best
}
```

```python
def maxArea(height):
    left, right = 0, len(height) - 1
    best = 0
    while left < right:
        h = min(height[left], height[right])    # shorter wall caps the water
        best = max(best, (right - left) * h)
        if height[left] < height[right]:        # retire the shorter wall
            left += 1
        else:
            right -= 1
    return best
```

### Complexity
Time O(n) — one pass, one index retired per step. Space O(1).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 167 | Two Sum II | Easy | Core two pointers application |
| 125 | Valid Palindrome | Easy | Core two pointers application |
| 11 | Container Water | Medium | Core two pointers application |
| 344 | Reverse String | Medium | Core two pointers application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Opposite Direction Two Pointers logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Opposite Direction Two Pointers (Two Pointers).
- **Signal:** two pointer, left right, converge, sorted, pair sum, palindrome.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Opposite Direction Two Pointers invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Opposite Direction Two Pointers
FAMILY : Two Pointers (Beginner)
WHEN   : two pointer, left right, converge, sorted, pair sum, palindrome
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 167, 125, 11, 344
```

---

*Part of the DSA Patterns Handbook — pattern 06 of 100.*
