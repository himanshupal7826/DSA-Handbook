# 24 · Upper Bound

> **One-liner:** First index with value > target — the bisect_right primitive.

---

## 1. Overview

### Definition
The **Upper Bound** pattern belongs to the *Binary Search* family. First index with value > target — the bisect_right primitive.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
upper bound, first >, bisect right, count, insert.

### Constraints
- Input size where the brute-force complexity would time out — the Upper Bound optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the Upper Bound invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Upper Bound is the upgrade.
- The wording maps onto: upper bound, first >, bisect right, count, insert.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"In a sorted array, where does `target` **end**?"* — the first index whose value is strictly `> target`.

### Intuition
Scan from the left until you pass every copy of the target.

### Algorithm
1. For `i` from `0` to `n−1`:
2. &nbsp;&nbsp;If `nums[i] > target`, return `i`.
3. If the loop finishes, nothing exceeded the target — return `n`.

### Complexity
- Time: **O(n)** per query.
- Space: O(1).

### Drawbacks
- Correct but blind to the sortedness.
- It is especially wasteful in the problems this pattern actually appears in — "how many values are ≤ X", "the latest entry at or before time T" — which are asked thousands of times over the same fixed data. O(q·n) becomes O(q·log n) for free.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Same boundary search as lower bound — just move the boundary one notch to the right by using `<=` instead of `<`.**

Look at the array through the predicate `nums[i] > target`. Sortedness makes it false on a prefix and true afterwards:

```text
nums   :  1   2   2   2   3        target = 2
>  2?  :  F   F   F   F   T
                          ↑
                    upper bound = 4

>= 2?  :  F   T   T   T   T
              ↑
        lower bound = 1
```

Lower bound is where the target's block **starts**; upper bound is where it **ends** (one past the last copy).

### The thought process

```text
We need    : the first index with nums[i] > target.
Obvious way: scan from the left.
Too slow   : O(n), ignores sortedness.
Notice     : "nums[i] > target" is FALSE for a prefix, TRUE after.
             Same monotone shape as lower bound.
Therefore  : the same binary search, with the comparison relaxed
             from < to <= so that EQUAL values get skipped past.
Now        : O(log n).
```

### The one-character difference

```text
lower bound:  if nums[mid] <  target  → lo = mid + 1
upper bound:  if nums[mid] <= target  → lo = mid + 1
                             ↑
                     that = is the whole difference
```

Read the branch as *"is `mid` disqualified?"*:

- Lower bound wants the first `>= target`, so only values **strictly less** are disqualified.
- Upper bound wants the first `> target`, so values **less than or equal** are disqualified — equals get skipped rather than kept.

### Why both exist: the two facts you actually use

```text
count of target in nums   =  upperBound(target) - lowerBound(target)

last index <= target      =  upperBound(target) - 1
                             (or "none" when upperBound(target) == 0)
```

The second one is the workhorse for "the most recent record at or before time T" — snapshots, version stores, time-series lookups. Take the upper bound and step back one.

That `− 1` needs a guard: if `upperBound` returns `0`, nothing in the array is `<= target`, and index `−1` doesn't exist.

### Steps

```text
Step 1 → lo = 0, hi = n            ← half-open, so "past the end" is expressible
Step 2 → While lo < hi:
Step 3 →     mid = lo + (hi - lo) / 2
Step 4 →     if nums[mid] <= target → mid is disqualified → lo = mid + 1
Step 5 →     else                   → mid still qualifies  → hi = mid
Step 6 → Return lo.
```

### A useful identity (integers only)

For integer data:

```text
upperBound(nums, t)  ==  lowerBound(nums, t + 1)
```

"First value `> t`" and "first value `>= t+1`" are the same thing when values are integers. Go's standard library only ships a lower bound (`sort.SearchInts`), so this identity is how you get an upper bound from it:

```go
upper := sort.SearchInts(nums, target+1)
```

It does **not** hold for floats or strings — there is no "next" float — so write the explicit `<=` version there.

### How should I recognize this?

```text
If you see...
  sorted data plus "last / rightmost / at or before"
  "how many are <= X", "count occurrences of X"
  "the most recent value at time T", versioned or timestamped lookups
        ↓
Think about...
  "Do I want where the target's block STARTS (lower)
   or where it ENDS (upper)?"
        ↓
Use...
  upper: nums[mid] <= target → lo = mid+1, else hi = mid
  then subtract 1 if you want the last qualifying index
```

### Visual explanation

```svg
<svg viewBox="0 0 620 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-24" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Upper bound (target = 4): first index where a[i] &gt; 4 (strict)</text>
  <rect x="24"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="58"  y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="96"  y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="130" y="81" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="168" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="202" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="240" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="274" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="312" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="346" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="384" y="52" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="418" y="81" text-anchor="middle" fill="#1e293b" font-weight="700">6</text>
  <rect x="456" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="490" y="81" text-anchor="middle" fill="#1e293b">9</text>
  <rect x="528" y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="562" y="81" text-anchor="middle" fill="#1e293b">11</text>
  <line x1="384" y1="44" x2="384" y2="112" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="200" y="130" text-anchor="middle" fill="#d97706">predicate a[i] &lt;= 4  (false)</text>
  <text x="490" y="130" text-anchor="middle" fill="#2563eb">a[i] &gt; 4  (true)</text>
  <text x="418" y="150" text-anchor="middle" fill="#059669" font-weight="700">boundary = upper_bound</text>
  <text x="310" y="188" text-anchor="middle" fill="#64748b">note: equal values fall on the FALSE side (strict &gt;)</text>
</svg>
```

```text
nums = [1, 2, 2, 2, 3]   target = 2

lo=0 hi=5  mid=2  nums[2]=2 <= 2  → disqualified → lo=3
lo=3 hi=5  mid=4  nums[4]=3 >  2  → qualifies    → hi=4
lo=3 hi=4  mid=3  nums[3]=2 <= 2  → disqualified → lo=4
lo=4 hi=4  → range empty → answer 4

        1    2    2    2    3
   lower↑                   ↑upper
        1                   4
   count of 2 = 4 - 1 = 3   ✓
```

### Interview explanation
"Upper bound is the same boundary search as lower bound with one character changed: the disqualifying test becomes `nums[mid] <= target` instead of `<`, so equal elements get skipped past rather than kept. That gives me the first index strictly greater than the target — one past the last copy. I keep the half-open `[0, n)` range so 'everything is ≤ target' returns `n` naturally. The two bounds together give me the occurrence count as a subtraction, and `upperBound − 1` gives the last element at or before a value, which is the usual shape for timestamped lookups. O(log n) time, O(1) space."

---

## 5. Generic Templates

> Identical to lower bound except for `<=`. Subtract 1 to get the last qualifying index.

```go
// UpperBound returns the first index i with nums[i] > target,
// or len(nums) if every element is <= target. nums must be sorted ascending.
func UpperBound(nums []int, target int) int {
    lo, hi := 0, len(nums) // half-open [lo, hi)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] <= target {
            lo = mid + 1 // <= : equal values are skipped past
        } else {
            hi = mid // mid still qualifies
        }
    }
    return lo
}

// LastAtMost returns the largest index i with nums[i] <= target, or -1.
func LastAtMost(nums []int, target int) int {
    return UpperBound(nums, target) - 1 // -1 when nothing qualifies
}

// CountAtMost returns how many elements are <= target.
func CountAtMost(nums []int, target int) int {
    return UpperBound(nums, target)
}

// CountEqual counts copies of target using both bounds.
func CountEqual(nums []int, target int) int {
    lo, hi := 0, len(nums)
    for lo < hi { // lower bound
        mid := lo + (hi-lo)/2
        if nums[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return UpperBound(nums, target) - lo
}
```

```python
def upper_bound(nums, target):
    """First index i with nums[i] > target, or len(nums)."""
    lo, hi = 0, len(nums)              # half-open [lo, hi)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] <= target:
            lo = mid + 1               # <= : equal values are skipped past
        else:
            hi = mid                   # mid still qualifies
    return lo

def last_at_most(nums, target):
    """Largest index i with nums[i] <= target, or -1."""
    return upper_bound(nums, target) - 1

def count_at_most(nums, target):
    return upper_bound(nums, target)

def count_equal(nums, target):
    from bisect import bisect_left
    return upper_bound(nums, target) - bisect_left(nums, target)

# The standard library ships it as bisect.bisect_right.
```

```java
public class UpperBoundPattern {
    // First index i with nums[i] > target, or nums.length.
    public static int upperBound(int[] nums, int target) {
        int lo = 0, hi = nums.length;               // half-open [lo, hi)
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] <= target) lo = mid + 1;  // <= skips equal values
            else hi = mid;
        }
        return lo;
    }

    // Largest index i with nums[i] <= target, or -1.
    public static int lastAtMost(int[] nums, int target) {
        return upperBound(nums, target) - 1;
    }

    public static int countEqual(int[] nums, int target) {
        int lo = 0, hi = nums.length;
        while (lo < hi) {                           // lower bound
            int mid = lo + (hi - lo) / 2;
            if (nums[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return upperBound(nums, target) - lo;
    }
}
```

```cpp
#include <vector>
using namespace std;

// First index i with nums[i] > target, or nums.size().
int upperBound(const vector<int>& nums, int target) {
    int lo = 0, hi = (int)nums.size();              // half-open [lo, hi)
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (nums[mid] <= target) lo = mid + 1;      // <= skips equal values
        else hi = mid;
    }
    return lo;
}

// Largest index i with nums[i] <= target, or -1.
int lastAtMost(const vector<int>& nums, int target) {
    return upperBound(nums, target) - 1;
}

// The STL ships this as std::upper_bound.
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Upper Bound (Optimal) |
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

### Problem — Search Insert Position (LeetCode 35)
Given a sorted array of **distinct** integers and a `target`, return the index of the target if present, else the index where it should be inserted.

### Thought Process
1. Read the requirement carefully: when the target is present we must return **its own** index. That is where the target's block *starts* — a **lower** bound.
2. So this problem is deliberately included here as the contrast case. Upper bound would return the index *after* the target, which is off by one when the target exists.
3. With **distinct** values the two bounds differ by exactly 1 on a hit and agree on a miss — which is why it is easy to reach for the wrong one and still pass some tests.
4. Use `nums[mid] < target → lo = mid + 1`. The `<` (not `<=`) is what keeps an equal element as a candidate.

### Dry Run

Input: `nums = [1, 3, 5, 6]`, `target = 5` (chosen because the target is **present** — that is where the two bounds diverge)

| lo | hi | mid | nums[mid] | `nums[mid] < 5`? | action |
|----|----|-----|-----------|------------------|--------|
| 0 | 4 | 2 | 5 | no  | `mid` qualifies → `hi = 2` |
| 0 | 2 | 1 | 3 | yes | `mid` is out → `lo = 2` |
| 2 | 2 | — | — | — | `lo == hi` → return **2** |

Output: **2** — the index of `5` itself. ✓

**The contrast, on the same input:**

| query | lower bound | upper bound | which does LeetCode 35 want? |
|---|---|---|---|
| `target = 5` (present) | **2** ✓ | 3 ✗ | lower |
| `target = 4` (absent)  | 2 ✓ | 2 ✓ | either works |

So: **"insert before existing equals" → lower bound. "Insert after existing equals" → upper bound.**

### Visualization

```text
nums  :   1    3    5    6        target = 5
index :   0    1    2    3   (4)

>= 5? :   F    F    T    T        lower bound = 2   ← what this problem wants
>  5? :   F    F    F    T        upper bound = 3
                    ↑    ↑
              the target  one past it
```

### Code

```go
func searchInsert(nums []int, target int) int {
    // Lower bound: strictly-less is the only disqualifier, so an equal
    // element stays a candidate and we land on the target itself.
    lo, hi := 0, len(nums)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}

// upperBoundInts is the sibling: the first index with nums[i] > target.
// Swapping it into searchInsert would return 3 instead of 2 for target 5.
func upperBoundInts(nums []int, target int) int {
    lo, hi := 0, len(nums)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] <= target { // <= : skip past equal values
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}
```

```python
def searchInsert(nums, target):
    # Lower bound: only strictly-smaller elements are disqualified, so an
    # equal element stays a candidate and we land on the target itself.
    lo, hi = 0, len(nums)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return lo

def upper_bound_ints(nums, target):
    """The sibling: first index with nums[i] > target."""
    lo, hi = 0, len(nums)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] <= target:        # <= : skip past equal values
            lo = mid + 1
        else:
            hi = mid
    return lo
```

### Complexity
Time O(log n), Space O(1).

---

## 10. Solved Example 2

### Problem — Range Frequency Queries (LeetCode 2080)
Build a structure over a fixed array answering many `query(left, right, value)` calls: how many times does `value` appear in `arr[left..right]`?

### Thought Process
1. Scanning the range per query is O(n) each — too slow for many queries.
2. Invert the data: for each distinct value, store **the sorted list of indices where it appears**. Scanning left to right builds these already sorted, for free.
3. Now the question becomes: how many entries of that index list fall in `[left, right]`?
4. That is a classic two-bound subtraction:
   - `upperBound(indices, right)` = how many indices are `<= right`
   - `lowerBound(indices, left)`  = how many indices are `< left`
   - the difference is how many lie inside `[left, right]`
5. Each query is O(log k) where `k` is how often that value occurs.

Note the pairing: **upper** bound on the right edge (inclusive, so we skip *past* equals) and **lower** bound on the left edge (so we stop *before* equals). Using the same bound on both sides is the classic off-by-one here.

### Dry Run

Input: `arr = [12, 33, 4, 56, 22, 2, 34, 33, 22, 12, 34, 56]`

**Build the index map** (only the entry we need is shown):

```text
33 → [1, 7]        (arr[1] = 33 and arr[7] = 33)
```

**`query(4, 8, 33)`:**

| step | computation | result | meaning |
|------|-------------|--------|---------|
| upper bound of `right = 8` in `[1,7]` | first index `> 8` | **2** | 2 occurrences at position `<= 8` |
| lower bound of `left = 4` in `[1,7]`  | first index `>= 4` | **1** | 1 occurrence at position `< 4` |
| subtract | `2 − 1` | **1** | occurrences inside `[4, 8]` |

Output: **1** — only `arr[7]` qualifies; `arr[1]` is left of the range. ✓

**`query(0, 11, 33)`** → `2 − 0 = ` **2** (both occurrences). ✓

### Visualization

```text
positions of 33 :   1              7
arr indices     :   0  1 ... 4 ... 7  8 ... 11
query range     :         └──────────┘
                          4          8

  indices <= 8  : {1, 7}   → upper bound = 2
  indices <  4  : {1}      → lower bound = 1
  inside [4,8]  : 2 - 1 = 1
```

### Code

```go
type RangeFreqQuery struct {
    positions map[int][]int // value -> sorted list of indices where it occurs
}

func Constructor(arr []int) RangeFreqQuery {
    positions := make(map[int][]int)
    for i, v := range arr {
        // Scanning left to right keeps each list sorted automatically.
        positions[v] = append(positions[v], i)
    }
    return RangeFreqQuery{positions: positions}
}

func (q *RangeFreqQuery) Query(left int, right int, value int) int {
    idx, ok := q.positions[value]
    if !ok {
        return 0
    }
    // upper on the right edge (inclusive), lower on the left edge.
    return upperBoundIdx(idx, right) - lowerBoundIdx(idx, left)
}

// upperBoundIdx: first position with nums[i] > target.
func upperBoundIdx(nums []int, target int) int {
    lo, hi := 0, len(nums)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] <= target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}

// lowerBoundIdx: first position with nums[i] >= target.
func lowerBoundIdx(nums []int, target int) int {
    lo, hi := 0, len(nums)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}
```

```python
from bisect import bisect_left, bisect_right
from collections import defaultdict

class RangeFreqQuery:
    def __init__(self, arr):
        self.positions = defaultdict(list)     # value -> sorted indices
        for i, v in enumerate(arr):
            self.positions[v].append(i)        # left-to-right keeps it sorted

    def query(self, left, right, value):
        idx = self.positions.get(value)
        if not idx:
            return 0
        # upper on the inclusive right edge, lower on the left edge
        return bisect_right(idx, right) - bisect_left(idx, left)
```

### Complexity
Build O(n) time and space. Each query **O(log k)** where `k` is the number of occurrences of that value.

---

## 11. Solved Example 3

### Problem — Time Based Key-Value Store (LeetCode 981)
Implement `set(key, value, timestamp)` and `get(key, timestamp)`, where `get` returns the value stored at the **largest timestamp ≤ the requested one**, or `""` if none exists.

### Thought Process
1. "Largest entry at or before T" is exactly `upperBound(T) − 1`.
2. `set` is guaranteed to be called with strictly increasing timestamps per key, so appending keeps each key's list sorted — no sorting needed.
3. `get` runs an upper bound over that key's timestamps, then steps back one index.
4. Guard the step-back: if the upper bound is `0`, every stored timestamp is greater than `T`, so nothing qualifies and we return `""`.
5. Binary searching **timestamps only** (not the pairs) keeps the comparison trivial.

### Dry Run

Operations: `set("foo","bar",1)`, `set("foo","baz",4)` → `foo`'s timestamps are `[1, 4]`

| call | upper bound of T in `[1,4]` | step back `−1` | result |
|------|------------------------------|----------------|--------|
| `get("foo", 1)` | first `> 1` → **1** | index 0 → ts 1 | **`"bar"`** |
| `get("foo", 3)` | first `> 3` → **1** | index 0 → ts 1 | **`"bar"`** |
| `get("foo", 4)` | first `> 4` → **2** | index 1 → ts 4 | **`"baz"`** |
| `get("foo", 5)` | first `> 5` → **2** | index 1 → ts 4 | **`"baz"`** |
| `get("foo", 0)` | first `> 0` → **0** | `0 − 1 = −1` | **`""`** (guard fires) |

Output for the sequence above: `"bar"`, `"bar"`, `"baz"`, `"baz"`, `""` ✓

`get("foo", 3)` is the interesting one: no entry has timestamp 3, and the answer is the most recent earlier entry — which is precisely what stepping back from the upper bound gives.

### Visualization

```text
timestamps for "foo":    1        4
values             :   "bar"    "baz"

get(3):
        1        4
        ●        ●
             ↑
          T = 3

  upper bound of 3  →  index 1  (the first timestamp > 3)
  step back         →  index 0  →  "bar"    ★
```

### Code

```go
type TimeMap struct {
    times  map[string][]int    // key -> timestamps, ascending
    values map[string][]string // key -> values, parallel to times
}

func NewTimeMap() TimeMap {
    return TimeMap{
        times:  make(map[string][]int),
        values: make(map[string][]string),
    }
}

func (m *TimeMap) Set(key string, value string, timestamp int) {
    // Timestamps arrive in increasing order per key, so appending keeps
    // the slice sorted with no extra work.
    m.times[key] = append(m.times[key], timestamp)
    m.values[key] = append(m.values[key], value)
}

func (m *TimeMap) Get(key string, timestamp int) string {
    ts := m.times[key]

    // Upper bound: the first index whose timestamp is > the one requested.
    lo, hi := 0, len(ts)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if ts[mid] <= timestamp {
            lo = mid + 1
        } else {
            hi = mid
        }
    }

    if lo == 0 {
        return "" // every stored timestamp is later than the request
    }
    return m.values[key][lo-1] // step back one: the latest at or before
}
```

```python
from bisect import bisect_right
from collections import defaultdict

class TimeMap:
    def __init__(self):
        self.times = defaultdict(list)     # key -> ascending timestamps
        self.values = defaultdict(list)    # key -> parallel values

    def set(self, key, value, timestamp):
        # Timestamps arrive increasing per key, so append keeps it sorted.
        self.times[key].append(timestamp)
        self.values[key].append(value)

    def get(self, key, timestamp):
        ts = self.times.get(key, [])
        i = bisect_right(ts, timestamp)    # first index with ts > timestamp
        if i == 0:
            return ""                      # nothing at or before this time
        return self.values[key][i - 1]     # step back one
```

### Complexity
`set` O(1) amortised. `get` **O(log n)** for the key's entry count. Space O(total entries).

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 35 | Search Insert | Easy | Core binary search application |
| 2080 | Range Frequency | Easy | Core binary search application |
| 981 | Time Map | Medium | Core binary search application |
| 1351 | Count Negatives | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Upper Bound logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Upper Bound (Binary Search).
- **Signal:** upper bound, first >, bisect right, count, insert.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Upper Bound invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Upper Bound
FAMILY : Binary Search (Intermediate)
WHEN   : upper bound, first >, bisect right, count, insert
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 35, 2080, 981, 1351
```

---

*Part of the DSA Patterns Handbook — pattern 24 of 100.*
