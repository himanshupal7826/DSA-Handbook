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

**The question this pattern keeps answering:** *"Split this array into groups — smaller than X, equal to X, greater than X — in one pass, in place."*

Running example: sort an array containing only `0`, `1`, `2`.

### Intuition
Either run a general-purpose sort, or count the values and rewrite the array.

### Algorithm
1. **Option A** — call a comparison sort. O(n log n).
2. **Option B** — counting sort: pass 1 tallies how many `0`s, `1`s, `2`s; pass 2 overwrites the array with that many of each. O(n), but **two passes**.

### Complexity
- Option A: O(n log n) time, O(1)–O(n) space.
- Option B: O(n) time, O(1) space, but reads the array twice.

### Drawbacks
- Option A compares elements when there are only three possible values — far more power than the problem needs.
- Option B is fine for plain integers, but it **overwrites** rather than rearranges. If the elements carry extra payload (objects keyed by a category), you can't just stamp `0` over them — you must move the actual items. And it can't be done in a single pass over a stream.
- Neither generalises to the real prize: **partitioning around a pivot**, which is the engine inside quicksort and quickselect.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Grow three regions at once — "definitely small" on the left, "definitely large" on the right — and scan the shrinking unknown middle.**

The array is always divided into four zones, and the whole algorithm is just three pointers maintaining them:

```text
[ 0 0 0 | 1 1 1 |   ? ? ? ?   | 2 2 2 ]
         ↑       ↑             ↑
        low     mid          high
  < pivot  == pivot   unknown    > pivot
```

- Everything **before** `low` is a `0`.
- Everything from `low` to `mid−1` is a `1`.
- Everything from `mid` to `high` is **unexamined**.
- Everything **after** `high` is a `2`.

We finish when the unknown region is empty.

### The thought process

```text
We need    : three groups, in place, one pass.
Obvious way: sort, or count and rewrite.
Not ideal  : sorting is overkill; counting needs two passes and
             cannot move real objects, only stamp values.
Notice     : with only three categories, each element needs at most
             ONE swap to reach the region it belongs in.
Therefore  : keep a boundary pointer for each region and a scanner
             for the unknown middle.
Now        : one pass, O(1) space, works on real objects too.
```

### Steps

```text
Step 1 → low = 0, mid = 0, high = n-1.
Step 2 → While mid <= high, look at nums[mid]:
Step 3 →     == 0 → swap(low, mid); low++; mid++
Step 4 →     == 1 → mid++                       (already in place)
Step 5 →     == 2 → swap(mid, high); high--     (do NOT advance mid)
Step 6 → Done when mid > high.
```

### The one rule people get wrong: why `mid` does not advance on a `2`

Look at where each swap brings its value **from**:

- On a `0`, we swap with `nums[low]`. That slot is in the "== 1" region, so it holds a `1` (or is `mid` itself). A `1` is fine where `mid` now stands, so we can safely advance `mid`.
- On a `2`, we swap with `nums[high]`. That slot is in the **unknown** region — we have never looked at it. It might be another `2`. Advancing `mid` would wave it through unexamined.

So: after a `0`-swap we know what arrived; after a `2`-swap we don't, and must re-inspect the same index.

```text
[2, 0, 1]   mid=0, high=2
 ↑       ↑
swap → [1, 0, 2], high=1

If we advanced mid here, we'd skip the 1 that just landed at index 0.
Instead we re-check index 0, see a 1, and advance normally.
```

### Why `mid <= high` and not `mid < high`

When `mid == high` there is still **one** unexamined element sitting at that index. Stopping early leaves it unsorted. Try `[1, 0]`: the loop must run with `mid == high == 1` to place the final element.

### The bigger prize: this *is* quicksort's partition

Replace "0 / 1 / 2" with "less than pivot / equal to pivot / greater than pivot" and you have three-way partitioning. That gives you:

- **Quickselect** — find the k-th smallest in O(n) average, by recursing into only one side.
- **Quicksort with duplicates** — the equal-block is finished immediately, so arrays full of repeats don't degrade to O(n²).

### How should I recognize this?

```text
If you see...
  "sort an array of 0s, 1s and 2s", "three categories / colours"
  "partition around a pivot", "k-th largest / smallest"
  "move all X to the front and Y to the back"
  "in place", "one pass", "O(1) space"
        ↓
Think about...
  "Can I name a left region, a right region, and scan
   the unknown middle between them?"
        ↓
Use...
  two categories  → two pointers (write pointer + scanner)
  three categories→ low / mid / high, advancing mid only when safe
```

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

```text
nums = [2, 0, 2, 1, 1, 0]

low mid high  nums[mid]  action                  array
 0   0   5       2       swap(mid,high), high--  [0,0,2,1,1,2]
 0   0   4       0       swap(low,mid), low++,mid++
 1   1   4       0       swap(low,mid), low++,mid++
 2   2   4       2       swap(mid,high), high--  [0,0,1,1,2,2]
 2   2   3       1       mid++
 2   3   3       1       mid++
 2   4   3       —       mid > high → stop

result: [0, 0, 1, 1, 2, 2]
```

### Interview explanation
"I'll keep three pointers: `low` is the boundary of the 0-region, `high` the boundary of the 2-region, and `mid` scans the unknown middle. On a 0, I swap it down to `low` and advance both `low` and `mid` — the value that came back is a known 1. On a 2, I swap it up to `high` and decrement `high`, but I deliberately do **not** advance `mid`, because the value that came back from the right is still unexamined. On a 1, I just advance `mid`. One pass, O(n) time, O(1) space. The same routine is quicksort's three-way partition, which is what makes quickselect O(n)."

---

## 5. Generic Templates

> Three pointers, four regions. Advance `mid` on `0` and `1`, never on `2`.

```go
// SortColors performs a three-way partition of 0/1/2 in a single pass.
func SortColors(nums []int) {
    low, mid, high := 0, 0, len(nums)-1

    for mid <= high { // <= : the element at mid == high is still unknown
        switch nums[mid] {
        case 0:
            nums[low], nums[mid] = nums[mid], nums[low]
            low++
            mid++ // what came back from low is a known 1
        case 1:
            mid++ // already in the right region
        default: // 2
            nums[mid], nums[high] = nums[high], nums[mid]
            high--
            // mid does NOT advance: the value from high is unexamined
        }
    }
}

// ThreeWayPartition splits nums around pivot and returns the bounds of the
// equal-to-pivot block: nums[lt:gt+1] all equal pivot.
func ThreeWayPartition(nums []int, pivot int) (lt, gt int) {
    lt, i, gt := 0, 0, len(nums)-1
    for i <= gt {
        switch {
        case nums[i] < pivot:
            nums[lt], nums[i] = nums[i], nums[lt]
            lt++
            i++
        case nums[i] > pivot:
            nums[i], nums[gt] = nums[gt], nums[i]
            gt--
        default:
            i++
        }
    }
    return lt, gt
}
```

```python
def sort_colors(nums):
    """Three-way partition of 0/1/2 in a single pass."""
    low, mid, high = 0, 0, len(nums) - 1
    while mid <= high:                 # <= : nums[mid] is still unknown
        if nums[mid] == 0:
            nums[low], nums[mid] = nums[mid], nums[low]
            low += 1
            mid += 1                   # what came back is a known 1
        elif nums[mid] == 1:
            mid += 1
        else:                          # 2
            nums[mid], nums[high] = nums[high], nums[mid]
            high -= 1
            # mid does NOT advance: the value from high is unexamined

def three_way_partition(nums, pivot):
    """Returns (lt, gt) where nums[lt:gt+1] all equal pivot."""
    lt, i, gt = 0, 0, len(nums) - 1
    while i <= gt:
        if nums[i] < pivot:
            nums[lt], nums[i] = nums[i], nums[lt]
            lt += 1; i += 1
        elif nums[i] > pivot:
            nums[i], nums[gt] = nums[gt], nums[i]
            gt -= 1
        else:
            i += 1
    return lt, gt
```

```java
public class DutchNationalFlag {
    public static void sortColors(int[] nums) {
        int low = 0, mid = 0, high = nums.length - 1;
        while (mid <= high) {              // <= : nums[mid] is still unknown
            if (nums[mid] == 0) {
                swap(nums, low++, mid++);  // what came back is a known 1
            } else if (nums[mid] == 1) {
                mid++;
            } else {
                swap(nums, mid, high--);   // mid does NOT advance
            }
        }
    }

    // Returns {lt, gt}: nums[lt..gt] all equal pivot.
    public static int[] threeWayPartition(int[] nums, int pivot) {
        int lt = 0, i = 0, gt = nums.length - 1;
        while (i <= gt) {
            if (nums[i] < pivot) swap(nums, lt++, i++);
            else if (nums[i] > pivot) swap(nums, i, gt--);
            else i++;
        }
        return new int[]{lt, gt};
    }

    private static void swap(int[] a, int i, int j) {
        int t = a[i]; a[i] = a[j]; a[j] = t;
    }
}
```

```cpp
#include <utility>
#include <vector>
using namespace std;

void sortColors(vector<int>& nums) {
    int low = 0, mid = 0, high = (int)nums.size() - 1;
    while (mid <= high) {                      // <= : nums[mid] still unknown
        if (nums[mid] == 0)      swap(nums[low++], nums[mid++]); // known 1 returns
        else if (nums[mid] == 1) ++mid;
        else                     swap(nums[mid], nums[high--]);  // mid stays put
    }
}

// Returns {lt, gt}: nums[lt..gt] all equal pivot.
pair<int, int> threeWayPartition(vector<int>& nums, int pivot) {
    int lt = 0, i = 0, gt = (int)nums.size() - 1;
    while (i <= gt) {
        if (nums[i] < pivot)      swap(nums[lt++], nums[i++]);
        else if (nums[i] > pivot) swap(nums[i], nums[gt--]);
        else                      ++i;
    }
    return {lt, gt};
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
Sort an array of `0`s (red), `1`s (white) and `2`s (blue) in place, in one pass, without a library sort.

### Thought Process
1. Three known categories means we can place each element directly instead of comparing.
2. Maintain four regions with `low`, `mid`, `high`: settled 0s, settled 1s, unknown, settled 2s.
3. `0` → swap to `low`, advance `low` and `mid` (what returns from `low` is a known `1`).
4. `1` → already correct, just advance `mid`.
5. `2` → swap to `high`, decrement `high`, and **hold `mid`** — the value that came back has never been examined.
6. Continue while `mid <= high`.

### Dry Run

Input: `nums = [2, 0, 2, 1, 1, 0]`, start `low = 0`, `mid = 0`, `high = 5`

| low | mid | high | nums[mid] | action | array after |
|-----|-----|------|-----------|--------|-------------|
| 0 | 0 | 5 | **2** | swap(0,5), `high→4`, mid held | `[0,0,2,1,1,2]` |
| 0 | 0 | 4 | **0** | swap(0,0), `low→1`, `mid→1` | `[0,0,2,1,1,2]` |
| 1 | 1 | 4 | **0** | swap(1,1), `low→2`, `mid→2` | `[0,0,2,1,1,2]` |
| 2 | 2 | 4 | **2** | swap(2,4), `high→3`, mid held | `[0,0,1,1,2,2]` |
| 2 | 2 | 3 | **1** | `mid→3` | `[0,0,1,1,2,2]` |
| 2 | 3 | 3 | **1** | `mid→4` | `[0,0,1,1,2,2]` |
| 2 | 4 | 3 | — | `mid > high` → stop | `[0,0,1,1,2,2]` |

Output: **`[0, 0, 1, 1, 2, 2]`**

Look at row 1: after swapping the `2` away, `mid` stayed at 0 — and that mattered, because a `0` had just arrived there and needed handling in row 2. Advancing would have left it stranded on the wrong side.

Look at the last row: the loop ran while `mid == high == 3`, placing the final unknown element. Using `mid < high` would have skipped it.

### Visualization

```text
final regions:

[ 0  0 | 1  1 | 2  2 ]
        ↑      ↑
       low    high+1
  <pivot  ==pivot  >pivot
```

### Code

```go
func sortColors(nums []int) {
    low, mid, high := 0, 0, len(nums)-1

    for mid <= high {
        switch nums[mid] {
        case 0:
            nums[low], nums[mid] = nums[mid], nums[low]
            low++
            mid++ // the value swapped back from low is a known 1
        case 1:
            mid++ // already in the middle region
        default: // 2
            nums[mid], nums[high] = nums[high], nums[mid]
            high--
            // mid stays: the value from high has not been examined yet
        }
    }
}
```

```python
def sortColors(nums):
    low, mid, high = 0, 0, len(nums) - 1
    while mid <= high:
        if nums[mid] == 0:
            nums[low], nums[mid] = nums[mid], nums[low]
            low += 1
            mid += 1          # value from low is a known 1
        elif nums[mid] == 1:
            mid += 1
        else:                 # 2
            nums[mid], nums[high] = nums[high], nums[mid]
            high -= 1
            # mid stays: value from high is unexamined
```

### Complexity
Time O(n) — every iteration either advances `mid` or decrements `high`, so at most `n` iterations. Space O(1).

---

## 10. Solved Example 2

### Problem — Kth Largest Element in an Array (LeetCode 215)
Return the `k`-th largest element (by value, so duplicates count).

### Thought Process
1. Sorting gives the answer in O(n log n) — but we only need **one** position, not the whole order.
2. Partitioning around a pivot tells us the pivot's final sorted position for free. If that position *is* the one we want, we're done.
3. If it isn't, the answer lies entirely on one side — so we recurse into **one** half instead of two. That's the difference between quicksort and quickselect.
4. Convert "k-th largest" to a 0-based index from the left: `target = n − k`.
5. Use three-way partitioning so arrays full of duplicates don't degrade.

**Why O(n) on average:** each step discards about half the elements, so the work is `n + n/2 + n/4 + … ≈ 2n`.

### Dry Run

Input: `nums = [3, 2, 1, 5, 6, 4]`, `k = 2` → `n = 6`, `target index = 6 − 2 = 4`

We want the element that would sit at index 4 if the array were sorted: sorted is `[1,2,3,4,5,6]`, so the answer should be `5`.

| step | working range | pivot | equal-block after partition | contains index 4? | next |
|------|---------------|-------|-----------------------------|-------------------|------|
| 1 | `[3,2,1,5,6,4]` (0..5) | `4` | indices 3..3 hold `4` → `[3,2,1,4,6,5]` | 4 > 3 → no, go right | search 4..5 |
| 2 | `[6,5]` (4..5) | `5` | indices 4..4 hold `5` → `[5,6]` | **yes, index 4** | done |

Output: **`5`** ✓

Notice step 1 threw away four of the six elements in one move — that is where the linear average time comes from.

### Visualization

```text
[3, 2, 1, 5, 6, 4]    pivot = 4
        ↓ three-way partition
[3, 2, 1 | 4 | 6, 5]
 < 4       =    > 4
 idx 0-2   3    idx 4-5

target index 4 > 3  →  recurse right only:  [6, 5]
                       pivot 5 → [5 | 6] → index 4 holds 5  ✓
```

### Code

```go
func findKthLargest(nums []int, k int) int {
    // The k-th largest sits at index n-k once sorted ascending.
    target := len(nums) - k
    left, right := 0, len(nums)-1

    for {
        // Three-way partition nums[left..right] around a pivot.
        pivot := nums[(left+right)/2]
        lt, i, gt := left, left, right
        for i <= gt {
            switch {
            case nums[i] < pivot:
                nums[lt], nums[i] = nums[i], nums[lt]
                lt++
                i++
            case nums[i] > pivot:
                nums[i], nums[gt] = nums[gt], nums[i]
                gt--
            default:
                i++
            }
        }

        // nums[lt..gt] all equal pivot and are in their final positions.
        switch {
        case target < lt:
            right = lt - 1 // answer is in the "less than" block
        case target > gt:
            left = gt + 1 // answer is in the "greater than" block
        default:
            return pivot // target landed inside the equal block
        }
    }
}
```

```python
def findKthLargest(nums, k):
    target = len(nums) - k          # index in ascending order
    left, right = 0, len(nums) - 1
    while True:
        pivot = nums[(left + right) // 2]
        lt, i, gt = left, left, right
        while i <= gt:              # three-way partition
            if nums[i] < pivot:
                nums[lt], nums[i] = nums[i], nums[lt]
                lt += 1; i += 1
            elif nums[i] > pivot:
                nums[i], nums[gt] = nums[gt], nums[i]
                gt -= 1
            else:
                i += 1
        if target < lt:
            right = lt - 1          # recurse into the "less than" block
        elif target > gt:
            left = gt + 1           # recurse into the "greater than" block
        else:
            return pivot            # target is inside the equal block
```

### Complexity
Time **O(n) average**, O(n²) worst case (a pathological pivot sequence); a random pivot makes the worst case vanishingly unlikely. Space O(1) — the loop replaces recursion.

> If you need the top `k` elements rather than just the `k`-th, a size-`k` heap is the better tool — O(n log k) with O(k) space, and it handles streams.

---

## 11. Solved Example 3

### Problem — Sort Array By Parity (LeetCode 905)
Rearrange the array so every even number comes before every odd number. Any valid arrangement is accepted.

### Thought Process
1. Only **two** categories here, so we need only two pointers — the simpler sibling of the flag partition.
2. `left` scans from the front looking for a misplaced odd; `right` scans from the back looking for a misplaced even.
3. When both have found a violation, one swap fixes both at once.
4. Stop when the pointers cross.
5. Because we only swap genuine violations, each swap does real work — no wasted moves.

### Dry Run

Input: `nums = [3, 1, 2, 4]`, start `left = 0`, `right = 3`

| left | right | nums[left] | nums[right] | situation | action | array |
|------|-------|-----------|-------------|-----------|--------|-------|
| 0 | 3 | 3 (odd) | 4 (even) | both misplaced | swap | `[4,1,2,3]` |
| 1 | 2 | 1 (odd) | 2 (even) | both misplaced | swap | `[4,2,1,3]` |
| 2 | 1 | — | — | `left > right` → stop | | `[4,2,1,3]` |

Output: **`[4, 2, 1, 3]`** — evens `4, 2` first, then odds `1, 3`. ✓

(Other outputs like `[2,4,3,1]` are equally valid; the problem only requires the grouping.)

### Visualization

```text
[3, 1, 2, 4]      left→3 is odd (wrong side), right→4 is even (wrong side)
 ↑        ↑
 swap  →  [4, 1, 2, 3]

[4, 1, 2, 3]      left→1 is odd, right→2 is even
    ↑  ↑
 swap  →  [4, 2, 1, 3]

    evens | odds
   [4, 2] | [1, 3]
```

### Code

```go
func sortArrayByParity(nums []int) []int {
    left, right := 0, len(nums)-1

    for left < right {
        leftIsEven := nums[left]%2 == 0
        rightIsOdd := nums[right]%2 != 0

        switch {
        case leftIsEven:
            left++ // already on the correct side
        case rightIsOdd:
            right-- // already on the correct side
        default:
            // left is odd and right is even: one swap fixes both.
            nums[left], nums[right] = nums[right], nums[left]
            left++
            right--
        }
    }
    return nums
}
```

```python
def sortArrayByParity(nums):
    left, right = 0, len(nums) - 1
    while left < right:
        if nums[left] % 2 == 0:        # already on the correct side
            left += 1
        elif nums[right] % 2 != 0:     # already on the correct side
            right -= 1
        else:                          # left odd, right even: one swap fixes both
            nums[left], nums[right] = nums[right], nums[left]
            left += 1
            right -= 1
    return nums
```

### Complexity
Time O(n) — the pointers move toward each other and together cover the array once. Space O(1), sorted in place.

---

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
