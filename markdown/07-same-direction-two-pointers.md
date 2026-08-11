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

**The question this pattern keeps answering:** *"Rebuild this array, keeping only the elements I want, without allocating a second array."*

Running example: remove duplicates from a **sorted** array, in place.

### Intuition
The obvious move is to physically delete each unwanted element: when you find one, shift everything after it one slot to the left.

### Algorithm
1. Scan from left to right.
2. When `nums[i] == nums[i-1]` (a duplicate), delete it.
3. Deleting means shifting every element after `i` one position left.
4. Shrink the logical length and re-check the same index.

### Complexity
- Time: **O(n²)** — a single delete costs O(n), and there can be O(n) of them.
- Space: O(1).

### Drawbacks
- Every shift moves elements that will very likely be moved again by the next delete. The array is rewritten over and over.
- The alternative — copying the keepers into a fresh array — is O(n) time but needs O(n) extra space, which the problem forbids.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Use two pointers moving the same way: one *reads* every element, the other marks where the next *kept* element should be written.**

Nothing is ever shifted. The reader runs ahead; whenever it finds something worth keeping, it hands it back to the writer, which advances by exactly one.

The two pointers have genuinely different jobs, and naming them that way makes the code obvious:

| Pointer | Job | Moves |
|---|---|---|
| `read` (fast) | inspects every element | every iteration |
| `write` (slow) | the slot the next keeper goes into | only when we keep something |

### The thought process

```text
We need    : to compact an array in place, dropping some elements.
Obvious way: delete each unwanted element and shift the rest left.
Too slow   : each delete is O(n) → O(n²), and shifts get redone.
Notice     : we don't need the array correct at every moment.
             We only need it correct at the END.
Notice too : the region we've already written is always BEHIND the
             region we're still reading, so writing can never clobber
             anything we haven't read yet.
Therefore  : one pass — read everything, write only the keepers.
Now        : O(n) time, O(1) space, zero shifting.
```

### Why writing can never destroy unread data

This is the invariant that makes it safe:

```text
write <= read     at all times
```

`write` only advances when `read` advances, and it starts at or behind `read`. So `nums[write]` is always a slot that has **already been read**. Overwriting it loses nothing.

```text
[ kept | kept | kept |  ???  |  unread  ...  ]
                        ↑        ↑
                      write     read
       ← finished →         ← still to come →
```

### Steps (remove duplicates from a sorted array)

```text
Step 1 → If the array is empty, return 0.
Step 2 → write = 1  (the first element is always kept).
Step 3 → For read = 1 .. n-1:
Step 4 →     if nums[read] != nums[write-1]:      ← new distinct value
Step 5 →         nums[write] = nums[read]
Step 6 →         write++
Step 7 → Return write — the count of kept elements.
```

### Why compare against `nums[write-1]` and not `nums[read-1]`

`nums[write-1]` is *the last value we actually kept*. `nums[read-1]` is just the previous element in the raw scan, which may be a duplicate we already decided to drop.

On sorted input both happen to work, but only the `write-1` version generalises — for example to "keep at most **two** of each", where you compare against `nums[write-2]`. Anchor the comparison to what you've kept, not to what you've seen.

### The three common conditions

The skeleton never changes; only the keep-test does:

| Problem | Keep `nums[read]` when… |
|---|---|
| Remove duplicates (sorted) | `nums[read] != nums[write-1]` |
| Remove all copies of `val` | `nums[read] != val` |
| Move zeroes to the end | `nums[read] != 0` |
| Keep at most `k` of each | `write < k \|\| nums[read] != nums[write-k]` |

### How should I recognize this?

```text
If you see...
  "in place", "O(1) extra space", "return the new length"
  "remove / filter / compact / partition"
  "move all X to the end", "the first k elements should be..."
        ↓
Think about...
  "Can I keep one pointer scanning and another marking
   where the next keeper belongs?"
        ↓
Use...
  read  → visits every element
  write → advances only when an element is kept
```

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

```text
nums = [1, 1, 2, 3, 3]      keep an element if it differs from the last kept

read=1  nums[1]=1 == kept 1  → skip
read=2  nums[2]=2 != kept 1  → nums[1]=2, write=2   [1,2,2,3,3]
read=3  nums[3]=3 != kept 2  → nums[2]=3, write=3   [1,2,3,3,3]
read=4  nums[4]=3 == kept 3  → skip

answer: 3, and nums[:3] = [1,2,3]
```

### Interview explanation
"I'll use two pointers moving the same direction. `read` visits every element; `write` marks where the next kept element goes. Since `write` never gets ahead of `read`, writing only ever touches slots I've already read, so nothing is lost. When `read` finds an element worth keeping, I copy it to `write` and advance `write`. At the end, `write` is the new length. One pass, O(n) time, O(1) space — no shifting at all."

---

## 5. Generic Templates

> One reader, one writer. Change only the keep-condition.

```go
// CompactInPlace keeps the elements satisfying keep(i) and returns the new length.
// Elements beyond the returned length are left as garbage.
func CompactInPlace(nums []int, keep func(i int) bool) int {
    write := 0
    for read := 0; read < len(nums); read++ {
        if keep(read) {
            nums[write] = nums[read]
            write++ // only advances for keepers
        }
    }
    return write
}

// RemoveDuplicates on a sorted slice: keep a value only if it differs
// from the last one we kept.
func RemoveDuplicates(nums []int) int {
    if len(nums) == 0 {
        return 0
    }
    write := 1 // the first element is always kept
    for read := 1; read < len(nums); read++ {
        if nums[read] != nums[write-1] {
            nums[write] = nums[read]
            write++
        }
    }
    return write
}
```

```python
def compact_in_place(nums, keep):
    """Keep elements where keep(i) is true; return the new length."""
    write = 0
    for read in range(len(nums)):
        if keep(read):
            nums[write] = nums[read]
            write += 1                 # only advances for keepers
    return write

def remove_duplicates(nums):
    """Sorted input: keep a value only if it differs from the last kept."""
    if not nums:
        return 0
    write = 1                          # first element is always kept
    for read in range(1, len(nums)):
        if nums[read] != nums[write - 1]:
            nums[write] = nums[read]
            write += 1
    return write
```

```java
import java.util.function.IntPredicate;

public class SameDirectionTwoPointers {
    // Keep elements satisfying keep; return the new length.
    public static int compactInPlace(int[] nums, IntPredicate keep) {
        int write = 0;
        for (int read = 0; read < nums.length; read++) {
            if (keep.test(read)) nums[write++] = nums[read];
        }
        return write;
    }

    // Sorted input: keep a value only if it differs from the last kept.
    public static int removeDuplicates(int[] nums) {
        if (nums.length == 0) return 0;
        int write = 1;
        for (int read = 1; read < nums.length; read++) {
            if (nums[read] != nums[write - 1]) nums[write++] = nums[read];
        }
        return write;
    }
}
```

```cpp
#include <functional>
#include <vector>
using namespace std;

// Keep elements satisfying keep; return the new length.
int compactInPlace(vector<int>& nums, const function<bool(int)>& keep) {
    int write = 0;
    for (int read = 0; read < (int)nums.size(); ++read)
        if (keep(read)) nums[write++] = nums[read];
    return write;
}

// Sorted input: keep a value only if it differs from the last kept.
int removeDuplicates(vector<int>& nums) {
    if (nums.empty()) return 0;
    int write = 1;
    for (int read = 1; read < (int)nums.size(); ++read)
        if (nums[read] != nums[write - 1]) nums[write++] = nums[read];
    return write;
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

### Problem — Remove Duplicates from Sorted Array (LeetCode 26)
Remove duplicates in place so each value appears once, and return the new length `k`. The first `k` slots must hold the distinct values in order.

### Thought Process
1. The array is sorted, so duplicates are always adjacent — we never need to look far back.
2. `write` marks where the next distinct value goes; `write−1` is the last value we kept.
3. Keep `nums[read]` exactly when it differs from `nums[write-1]`.
4. `write` starts at 1 because the very first element is always kept.
5. `write` never passes `read`, so overwriting is always safe.

### Dry Run

Input: `nums = [1, 1, 2, 3, 3]`, start `write = 1`

| read | nums[read] | last kept = nums[write−1] | different? | action | array | write |
|------|-----------|---------------------------|------------|--------|-------|-------|
| 1 | 1 | `nums[0]` = 1 | no  | skip | `[1,1,2,3,3]` | 1 |
| 2 | 2 | `nums[0]` = 1 | yes | `nums[1] = 2` | `[1,2,2,3,3]` | 2 |
| 3 | 3 | `nums[1]` = 2 | yes | `nums[2] = 3` | `[1,2,3,3,3]` | 3 |
| 4 | 3 | `nums[2]` = 3 | no  | skip | `[1,2,3,3,3]` | 3 |

Output: **`3`**, with `nums[0..2] = [1, 2, 3]`.

The trailing `[3,3]` is leftover garbage — the problem explicitly does not care about anything past index `k−1`.

### Visualization

```text
        kept region        garbage
       ┌──────────┐
nums = [ 1 , 2 , 3 , 3 , 3 ]
                   ↑       ↑
                 write=3  read finished

return 3
```

### Code

```go
func removeDuplicates(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    write := 1 // the first element is always kept
    for read := 1; read < len(nums); read++ {
        // nums[write-1] is the last value we actually kept.
        if nums[read] != nums[write-1] {
            nums[write] = nums[read]
            write++
        }
    }
    return write
}
```

```python
def removeDuplicates(nums):
    if not nums:
        return 0
    write = 1                              # first element is always kept
    for read in range(1, len(nums)):
        if nums[read] != nums[write - 1]:  # differs from the last kept
            nums[write] = nums[read]
            write += 1
    return write
```

### Complexity
Time O(n) — one pass. Space O(1) — in place, no shifting.

---

## 10. Solved Example 2

### Problem — Remove Element (LeetCode 27)
Remove every occurrence of `val` in place and return the new length `k`. The order of the remaining elements may change, and anything past `k` is ignored.

### Thought Process
1. Same skeleton, simpler condition: keep `nums[read]` when `nums[read] != val`.
2. No sortedness is needed here — the test looks only at the current element.
3. `write` counts the survivors, so it *is* the answer at the end.

### Dry Run

Input: `nums = [3, 2, 2, 3]`, `val = 3`, start `write = 0`

| read | nums[read] | == val? | action | array | write |
|------|-----------|---------|--------|-------|-------|
| 0 | 3 | yes | skip | `[3,2,2,3]` | 0 |
| 1 | 2 | no  | `nums[0] = 2` | `[2,2,2,3]` | 1 |
| 2 | 2 | no  | `nums[1] = 2` | `[2,2,2,3]` | 2 |
| 3 | 3 | yes | skip | `[2,2,2,3]` | 2 |

Output: **`2`**, with `nums[0..1] = [2, 2]`.

Note step `read = 1`: we wrote `2` over the `3` at index 0. That was safe because index 0 had already been read.

### Visualization

```text
read:   3    2    2    3
        ✗    ✓    ✓    ✗
             ↓    ↓
write: [2] [2]  ...            → new length 2
```

### Code

```go
func removeElement(nums []int, val int) int {
    write := 0
    for read := 0; read < len(nums); read++ {
        if nums[read] != val { // keep everything that isn't val
            nums[write] = nums[read]
            write++
        }
    }
    return write
}
```

```python
def removeElement(nums, val):
    write = 0
    for read in range(len(nums)):
        if nums[read] != val:          # keep everything that isn't val
            nums[write] = nums[read]
            write += 1
    return write
```

### Complexity
Time O(n), Space O(1).

---

## 11. Solved Example 3

### Problem — Move Zeroes (LeetCode 283)
Move all `0`s to the end of the array in place, keeping the **relative order** of the non-zero elements.

### Thought Process
1. First do the familiar compaction: keep every non-zero, writing them to the front in order. That preserves their relative order automatically, since `read` scans left to right.
2. After that pass, `write` equals the number of non-zeros — and everything from `write` onward is stale.
3. Second pass: fill `nums[write..n-1]` with `0`.
4. Two passes, both linear — still O(n), and no extra memory.

> A one-pass variant *swaps* `nums[read]` and `nums[write]` instead of copying. It works and also preserves order, but the two-pass version is easier to read and just as fast.

### Dry Run

Input: `nums = [0, 1, 0, 3, 12]`

**Pass 1 — compact the non-zeros:**

| read | nums[read] | zero? | action | array | write |
|------|-----------|-------|--------|-------|-------|
| 0 | 0  | yes | skip | `[0,1,0,3,12]` | 0 |
| 1 | 1  | no  | `nums[0] = 1`  | `[1,1,0,3,12]` | 1 |
| 2 | 0  | yes | skip | `[1,1,0,3,12]` | 1 |
| 3 | 3  | no  | `nums[1] = 3`  | `[1,3,0,3,12]` | 2 |
| 4 | 12 | no  | `nums[2] = 12` | `[1,3,12,3,12]`| 3 |

**Pass 2 — zero-fill from index `write = 3`:**

```text
[1, 3, 12, 0, 0]
```

Output: **`[1, 3, 12, 0, 0]`** — the non-zeros kept their original order `1, 3, 12`.

### Visualization

```text
after pass 1:   [ 1 , 3 , 12 | 3 , 12 ]
                 └ non-zeros ┘  └ stale ┘
                              ↑
                           write = 3

after pass 2:   [ 1 , 3 , 12 | 0 , 0 ]
```

### Code

```go
func moveZeroes(nums []int) {
    // Pass 1: compact the non-zeros to the front, preserving order.
    write := 0
    for read := 0; read < len(nums); read++ {
        if nums[read] != 0 {
            nums[write] = nums[read]
            write++
        }
    }

    // Pass 2: everything from write onward is stale — zero it out.
    for i := write; i < len(nums); i++ {
        nums[i] = 0
    }
}
```

```python
def moveZeroes(nums):
    write = 0
    for read in range(len(nums)):      # pass 1: compact non-zeros
        if nums[read] != 0:
            nums[write] = nums[read]
            write += 1
    for i in range(write, len(nums)):  # pass 2: zero-fill the tail
        nums[i] = 0
```

### Complexity
Time O(n) — two linear passes. Space O(1) — fully in place.

---

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
