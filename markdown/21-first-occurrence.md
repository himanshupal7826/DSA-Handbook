# 21 · First Occurrence

> **One-liner:** Bias binary search left to find the first matching index.

---

## 1. Overview

### Definition
The **First Occurrence** pattern belongs to the *Binary Search* family. Bias binary search left to find the first matching index.

### Intuition
If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.

### Why it works
Halve the search space each step using a monotonic property or predicate — O(log n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.

---

## 2. Recognition Signals

### Keywords
first, leftmost, binary search, duplicates, boundary.

### Constraints
- Input size where the brute-force complexity would time out — the First Occurrence optimization is the intended solution.
- Structural hints in the statement that match this family (Binary Search).

### Hidden clues
- The problem can be reframed so the First Occurrence invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — First Occurrence is the upgrade.
- The wording maps onto: first, leftmost, binary search, duplicates, boundary.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Where does the target **start**? Give me the leftmost index, not just any index."*

Running example: `nums = [5, 7, 7, 8, 8, 10]`, `target = 8`. (Answer: index 3.)

### Intuition
Scan from the left and return the first index whose value equals the target. Because you started at the left, the first hit *is* the leftmost hit.

### Algorithm
1. For `i` from `0` to `n − 1`:
2. &nbsp;&nbsp;If `nums[i] == target`, return `i` — done, this is the first occurrence.
3. Return `-1`.

### Complexity
- Time: **O(n)** — worst case the target is at the end or absent.
- Space: O(1).

### Drawbacks
- The "fix": run a plain binary search first, then walk left while `nums[i-1] == target`. That is correct but still **O(n)** — an array of one million 8s degenerates to a million backward steps. The fast part of the algorithm gets swallowed by the slow tail.
- The real waste: a comparison against a *sorted* array already tells you which side the leftmost 8 is on. On the running example, `nums[3] == 8` proves no 8 exists at index 4 or beyond *for the purpose of finding the first one* — every candidate is at index ≤ 3. The scan-and-back-up approach never asks that question; it just plods.
- Two hidden bugs live in the back-up loop: forgetting the `i > 0` guard, and using it when the array is all target (walk the whole thing).

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Don't search for the value — search for the *boundary* between "too small" and "big enough", and never return early.**

An exact-match binary search stops the moment it touches *an* 8, which may be any of them. A boundary search refuses to stop: even when it lands on an 8 it treats that index as "still a candidate" and keeps squeezing leftwards. When the range finally collapses, `lo` is sitting exactly on the wall between the last value `< target` and the first value `>= target`.

### The thought process

```text
We need    : the LEFTMOST index holding target.
Obvious way: binary search, then walk left.
Too slow   : O(n) when the array is full of duplicates.
Notice     : "is nums[i] >= target?" is FALSE, FALSE, ..., FALSE, TRUE, ..., TRUE.
             Once true it stays true — the predicate is monotonic.
Therefore  : binary search for the first TRUE, not for the value.
Now        : never return early; let lo converge on the wall → O(log n).
```

### Why "never return early" is the whole trick

Chapter 20's search returns as soon as `nums[mid] == target`. With duplicates that is a coin flip:

```text
nums = [5, 7, 7, 8, 8, 10]     target = 8
                ↑
        first probe lands on index 3 (correct here — by luck)

nums = [8, 8, 8, 8, 8, 9]      target = 8
                 ↑
        first probe lands on index 2 or 3 — WRONG, the answer is 0
```

Replace "did I find it?" with "**could the answer still be here or to the left?**":

```text
nums[mid] <  target   → mid is too small; the answer is strictly right → lo = mid + 1
nums[mid] >= target   → mid is itself a candidate; keep it            → hi = mid
```

Nothing in that pair of rules mentions equality, and neither branch discards a possible answer. `hi = mid` (not `mid - 1`) is what keeps `mid` alive as a candidate — the half-open convention makes this the natural spelling.

### The loop invariant, in words

> **The answer, if it exists, is always inside `[lo, hi)`.**

It starts true (`[0, n)` is everything). Each branch removes only indices proved impossible. When `lo == hi`:

```text
every index < lo   →  proved nums[i] <  target
every index >= lo  →  proved nums[i] >= target
```

So `lo` is the *lower bound*. Termination is guaranteed because `lo <= mid < hi` always (integer division rounds down), so `lo = mid+1` strictly grows `lo` and `hi = mid` strictly shrinks `hi`.

Use `mid = lo + (hi-lo)/2`, never `(lo+hi)/2`: on a 32-bit machine with `lo = 1.5e9, hi = 2.0e9` the sum wraps negative and the search either indexes out of bounds or loops forever. The subtraction form can't overflow because `hi - lo <= hi`.

### First occurrence = lower bound + one equality check

The lower bound answers "where would the target go?", which is defined even when the target is absent. To answer "where **is** the target?" you add exactly one test at the end:

```text
i = lowerBound(nums, target)
if i < n and nums[i] == target → i is the FIRST occurrence
else                          → target is absent, return -1
```

Both guards matter: `i < n` catches a target larger than everything (`lo` lands on `n`), and `nums[i] == target` catches a target that simply isn't there (`lo` lands on the first larger value).

### One algorithm, four variants

Chapters 21–24 are **not** four algorithms. They are the loop above with one line changed:

| Want | Move `lo` when | Return |
|------|----------------|--------|
| **lower bound** — first `i` with `a[i] >= t` | `a[mid] <  t` | `lo` |
| **upper bound** — first `i` with `a[i] > t` | `a[mid] <= t` | `lo` |
| **first occurrence** of `t` (ch. 21) | `a[mid] <  t` | `lo` if `lo < n && a[lo] == t`, else `-1` |
| **last occurrence** of `t` (ch. 22) | `a[mid] <= t` | `lo-1` if `lo > 0 && a[lo-1] == t`, else `-1` |
| **count** of `t` | — | `upperBound(t) − lowerBound(t)` |

Read the middle column: `<` versus `<=`. That single character is the entire difference between chapters 21/23 and chapters 22/24.

### Steps

```text
Step 1 → lo = 0, hi = n
Step 2 → while lo < hi:
Step 3 →     mid = lo + (hi - lo) / 2
Step 4 →     if nums[mid] < target → lo = mid + 1     (too small; answer is right)
Step 5 →     else                  → hi = mid         (candidate; keep it)
Step 6 → if lo < n and nums[lo] == target → return lo
Step 7 → return -1
```

### How should I recognize this?

```text
If you see...
  "first/leftmost occurrence", "starting position", "first bad version",
  "smallest index such that ...", a sorted array WITH DUPLICATES,
  a predicate that is false-then-true
        ↓
Think about...
  "Is my condition monotonic — once true, does it stay true?"
        ↓
Use...
  the boundary search: never return early, let lo converge
  ├─ want the index even if absent  → return lo (that's the insert position)
  └─ want it only if present        → check lo < n && a[lo] == target
```

### Visual explanation

```svg
<svg viewBox="0 0 620 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="bs-21" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="310" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">First occurrence of 4: on a match, bias LEFT (hi = mid)</text>
  <rect x="24"  y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="58"  y="81" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="96"  y="52" width="68" height="48" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="130" y="81" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="168" y="52" width="68" height="48" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="202" y="81" text-anchor="middle" fill="#1e293b" font-weight="700">4</text>
  <rect x="240" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="274" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="312" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="346" y="81" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="384" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="418" y="81" text-anchor="middle" fill="#1e293b">6</text>
  <rect x="456" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="81" text-anchor="middle" fill="#1e293b">8</text>
  <rect x="528" y="52" width="68" height="48" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="562" y="81" text-anchor="middle" fill="#1e293b">9</text>
  <line x1="168" y1="44" x2="168" y2="112" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="115" y="130" text-anchor="middle" fill="#2563eb">a[i] &lt; 4</text>
  <text x="202" y="150" text-anchor="middle" fill="#059669" font-weight="700">first index with a[i] = 4</text>
  <line x1="230" y1="168" x2="330" y2="168" stroke="#475569" marker-end="url(#bs-21)"/>
  <text x="400" y="130" text-anchor="middle" fill="#d97706">later matches skipped →</text>
  <text x="280" y="188" text-anchor="middle" fill="#64748b">keep the leftmost boundary</text>
</svg>
```

```text
nums = [ 5,  7,  7,  8,  8, 10 ]     target = 8
index    0   1   2   3   4   5

predicate "nums[i] >= 8":
         F   F   F   T   T   T
                     ↑
                 the WALL — first TRUE — is the answer

step 1  [lo=0 ─────────────────── hi=6)   mid=3  nums[3]=8 >= 8 → candidate → hi=3
step 2  [lo=0 ───── hi=3)                 mid=1  nums[1]=7 <  8 → too small → lo=2
step 3  [lo=2 hi=3)                       mid=2  nums[2]=7 <  8 → too small → lo=3
        lo == hi == 3   ★

then check: 3 < 6 and nums[3] == 8  →  first occurrence = 3

note step 1: we landed ON an 8 and did NOT return — that's the whole pattern
```

### Interview explanation
"I don't search for the value, I search for a boundary. The predicate `nums[i] >= target` is monotonic — false, false, …, then true forever — so I binary search for the first `true`. I keep the half-open range `[lo, hi)` with the invariant that the answer is always inside it: if `nums[mid] < target` the answer is strictly to the right so `lo = mid + 1`; otherwise `mid` is itself a candidate so `hi = mid`. Crucially I never return early on equality, which is what makes it find the *leftmost* match rather than an arbitrary one. When the loop ends `lo` is the lower bound, and one check — `lo < n && nums[lo] == target` — converts it into the first occurrence or `-1`. O(log n) time, O(1) space, and the `mid = lo + (hi-lo)/2` form keeps it overflow-safe."

---

## 5. Generic Templates

> Never return early. `nums[mid] < target → lo = mid+1`, else `hi = mid`. `lo` converges on the wall.

```go
// LowerBound returns the first index i with a[i] >= target (len(a) if none).
// Invariant: the answer always lies in [lo, hi).
func LowerBound(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2 // overflow-safe midpoint
        if a[mid] < target {
            lo = mid + 1 // too small → the answer is strictly right
        } else {
            hi = mid // mid is still a candidate → keep it in range
        }
    }
    return lo
}

// FirstOccurrence returns the leftmost index of target, or -1 if absent.
func FirstOccurrence(a []int, target int) int {
    i := LowerBound(a, target)
    if i < len(a) && a[i] == target {
        return i
    }
    return -1
}

// FirstTrue returns the smallest v in [lo, hi) with pred(v) true, or hi.
// Works whenever pred is monotonic: false...false,true...true.
func FirstTrue(lo, hi int, pred func(int) bool) int {
    for lo < hi {
        mid := lo + (hi-lo)/2
        if pred(mid) {
            hi = mid // mid satisfies it → it or something left of it is the answer
        } else {
            lo = mid + 1
        }
    }
    return lo
}
```

```python
def lower_bound(a, target):
    """First index i with a[i] >= target (len(a) if none)."""
    lo, hi = 0, len(a)
    while lo < hi:
        mid = lo + (hi - lo) // 2      # overflow-safe habit
        if a[mid] < target:
            lo = mid + 1               # too small → answer is strictly right
        else:
            hi = mid                   # mid is still a candidate
    return lo


def first_occurrence(a, target):
    """Leftmost index of target, or -1 if absent."""
    i = lower_bound(a, target)
    return i if i < len(a) and a[i] == target else -1


def first_true(lo, hi, pred):
    """Smallest v in [lo, hi) with pred(v) true, or hi. pred must be monotonic."""
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if pred(mid):
            hi = mid
        else:
            lo = mid + 1
    return lo
```

```java
import java.util.function.IntPredicate;

public class FirstOccurrenceSearch {
    // First index i with a[i] >= target (a.length if none).
    public static int lowerBound(int[] a, int target) {
        int lo = 0, hi = a.length;
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;       // overflow-safe
            if (a[mid] < target) lo = mid + 1;  // too small → answer is right
            else hi = mid;                      // mid is still a candidate
        }
        return lo;
    }

    // Leftmost index of target, or -1 if absent.
    public static int firstOccurrence(int[] a, int target) {
        int i = lowerBound(a, target);
        return (i < a.length && a[i] == target) ? i : -1;
    }

    // Smallest v in [lo, hi) with pred(v) true, or hi. pred must be monotonic.
    public static int firstTrue(int lo, int hi, IntPredicate pred) {
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (pred.test(mid)) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }
}
```

```cpp
#include <functional>
#include <vector>
using namespace std;

// First index i with a[i] >= target (a.size() if none).
int lowerBound(const vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;        // overflow-safe
        if (a[mid] < target) lo = mid + 1;   // too small → answer is right
        else hi = mid;                       // mid is still a candidate
    }
    return lo;
}

// Leftmost index of target, or -1 if absent.
int firstOccurrence(const vector<int>& a, int target) {
    int i = lowerBound(a, target);
    return (i < (int)a.size() && a[i] == target) ? i : -1;
}

// Smallest v in [lo, hi) with pred(v) true, or hi. pred must be monotonic.
int firstTrue(int lo, int hi, const function<bool(int)>& pred) {
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (pred(mid)) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | First Occurrence (Optimal) |
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

### Problem — First Last Position (LeetCode 34)
Given a sorted array `nums` that may contain duplicates, return the starting and ending index of `target` as `[first, last]`, or `[-1, -1]` if it is absent. Required complexity: O(log n).

### Thought Process
1. `first` is the leftmost index with `nums[i] >= target` — a **lower bound**, then confirmed with one equality check.
2. `last` is one before the leftmost index with `nums[i] > target`. Rather than write a second loop with `<=`, note that on integers `nums[i] > target` is the same as `nums[i] >= target + 1` — so `last = lowerBound(target + 1) − 1` and we reuse the identical helper.
3. Run `lowerBound(target)` first. If it lands past the end, or on a value that isn't the target, the target is absent → `[-1, -1]`.
4. Otherwise the target *is* present, so `lowerBound(target + 1) − 1` is guaranteed to point at the last copy.
5. Two O(log n) searches, so still O(log n) overall.

### Dry Run

Input: `nums = [5, 7, 7, 8, 8, 10]`, `target = 8`

**Search A — `lowerBound(8)`** (first index with value ≥ 8):

| step | `lo` | `hi` | `mid` | `nums[mid]` | `< 8`? | action |
|------|------|------|-------|-------------|--------|--------|
| 1 | 0 | 6 | **3** | 8 | no — candidate | `hi = 3` |
| 2 | 0 | 3 | **1** | 7 | yes | `lo = 2` |
| 3 | 2 | 3 | **2** | 7 | yes | `lo = 3` |
| 4 | 3 | 3 | — | — | — | stop → **3** |

Check `3 < 6` and `nums[3] == 8` ✓, so the target is present and `first = 3`.

**Search B — `lowerBound(9)`** (first index with value ≥ 9, i.e. first index past the 8s):

| step | `lo` | `hi` | `mid` | `nums[mid]` | `< 9`? | action |
|------|------|------|-------|-------------|--------|--------|
| 1 | 0 | 6 | **3** | 8 | yes | `lo = 4` |
| 2 | 4 | 6 | **5** | 10 | no — candidate | `hi = 5` |
| 3 | 4 | 5 | **4** | 8 | yes | `lo = 5` |
| 4 | 5 | 5 | — | — | — | stop → **5** |

`last = 5 − 1 = 4`.

Output: **`[3, 4]`**

Step 1 of search A is the moment that separates this from chapter 20: `nums[3]` *equals* the target and the loop keeps going. An early return there would have been correct by accident; on `[8,8,8,8]` the same shortcut returns 1 or 2 instead of 0.

### Visualization

```text
nums  =  5   7   7   8   8  10
index    0   1   2   3   4   5

>= 8  :  F   F   F   T   T   T        lowerBound(8) = 3   ← first
>= 9  :  F   F   F   F   F   T        lowerBound(9) = 5   ← one past last
                     └───┬───┘
                      the 8s: [3, 4]

count of target = lowerBound(9) - lowerBound(8) = 5 - 3 = 2      (two 8s ✓)
```

### Code

```go
// rangeLowerBound: first index i with a[i] >= target, or len(a).
func rangeLowerBound(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2
        if a[mid] < target {
            lo = mid + 1 // too small → answer is strictly right
        } else {
            hi = mid // still a candidate → never return early
        }
    }
    return lo
}

func searchRange(nums []int, target int) []int {
    first := rangeLowerBound(nums, target)
    if first == len(nums) || nums[first] != target {
        return []int{-1, -1} // target is absent
    }
    // For integers, "> target" is the same as ">= target+1".
    last := rangeLowerBound(nums, target+1) - 1
    return []int{first, last}
}
```

```python
def searchRange(nums, target):
    def lower_bound(t):
        lo, hi = 0, len(nums)
        while lo < hi:
            mid = lo + (hi - lo) // 2
            if nums[mid] < t:
                lo = mid + 1        # too small → answer is strictly right
            else:
                hi = mid            # still a candidate → never return early
        return lo

    first = lower_bound(target)
    if first == len(nums) or nums[first] != target:
        return [-1, -1]             # target is absent

    # for integers, "> target" is the same as ">= target + 1"
    last = lower_bound(target + 1) - 1
    return [first, last]
```

### Complexity
Time **O(log n)** — two independent binary searches, each halving the range. Space **O(1)**.

---

## 10. Solved Example 2

### Problem — First Bad Version (LeetCode 278)
Versions `1..n` were released in order; from some version onwards every release is bad. Given the API `isBadVersion(v)`, find the first bad version with the fewest calls.

### Thought Process
1. There is no array — but `isBadVersion` is a **monotonic predicate**: false, false, …, true, true. That is the only structure a boundary search needs.
2. Search over versions with the same half-open range: `[lo, hi) = [1, n + 1)`. `hi` is `n + 1` because `n` itself can be the answer and `hi` is exclusive.
3. `isBadVersion(mid)` true → `mid` is a candidate, the answer is at `mid` or earlier → `hi = mid`. False → the answer is strictly after → `lo = mid + 1`.
4. Never return early even on a `true` — the *first* bad version may still be to the left.
5. `n` goes up to 2³¹ − 1, so `(lo + hi) / 2` genuinely overflows a 32-bit int here. This is the problem where the midpoint form stops being a stylistic preference.

### Dry Run

Input: `n = 5`, the first bad version is `4`

| step | `lo` | `hi` | `mid = lo+(hi-lo)/2` | `isBadVersion(mid)` | action |
|------|------|------|----------------------|---------------------|--------|
| 1 | 1 | 6 | 1 + 2 = **3** | false (good) | `lo = 4` — everything ≤ 3 is good |
| 2 | 4 | 6 | 4 + 1 = **5** | true (bad) | `hi = 5` — 5 is a candidate, keep it |
| 3 | 4 | 5 | 4 + 0 = **4** | true (bad) | `hi = 4` — 4 is a candidate, keep it |
| 4 | 4 | 4 | — | — | `lo == hi` → return **4** |

Output: **4** — three API calls for five versions.

Steps 2 and 3 both hit `true` and neither returns. Step 3 is the one that matters: version 5 was already known bad, but 4 turned out to be bad too, and only the collapse of the range proves that 4 is the *first*.

### Visualization

```text
version    1     2     3     4     5
status     good  good  good  BAD   BAD
predicate  F     F     F     T     T
                             ↑ first TRUE = answer

step 1  [lo=1 ─────────────────── hi=6)   mid=3  good → lo=4
step 2              [lo=4 ─────── hi=6)   mid=5  bad  → hi=5
step 3              [lo=4 ─ hi=5)         mid=4  bad  → hi=4
        lo == hi == 4  ★

a monotonic API call replaces the array lookup — the loop is unchanged
```

### Code

```go
// firstBad models the hidden state behind LeetCode's API so this runs standalone.
var firstBad int

func isBadVersion(version int) bool { return version >= firstBad }

func firstBadVersion(n int) int {
    lo, hi := 1, n+1 // half-open over VERSIONS; n must stay reachable

    for lo < hi {
        mid := lo + (hi-lo)/2 // n up to 2^31-1: (lo+hi)/2 would overflow
        if isBadVersion(mid) {
            hi = mid // mid is bad → it or an earlier one is the first
        } else {
            lo = mid + 1 // mid is good → the first bad one is strictly after
        }
    }
    return lo
}
```

```python
def firstBadVersion(n):
    lo, hi = 1, n + 1                  # half-open over versions

    while lo < hi:
        mid = lo + (hi - lo) // 2
        if isBadVersion(mid):
            hi = mid                   # candidate → keep it, look further left
        else:
            lo = mid + 1               # good → first bad one is strictly after

    return lo
```

### Complexity
Time **O(log n)** API calls — 31 calls even at `n = 2³¹ − 1`. Space **O(1)**.

---

## 11. Solved Example 3

### Problem — Search Insert (LeetCode 35)
Given a sorted array of distinct integers and a `target`, return the index of `target` if found, otherwise the index where it should be inserted to keep the array sorted.

### Thought Process
1. This is the lower bound *without* the final equality check — the "first occurrence" search stripped back to its bare boundary.
2. The insert position is the first index `i` with `nums[i] >= target`: everything before it is strictly smaller, everything from it onwards is at least as large, so slotting the target in at `i` keeps the order.
3. If the target is present, the lower bound lands directly on it — so "found" and "would insert" are the same index and no branch is needed.
4. The loop is identical to example 1's helper; only the return differs (`lo` unconditionally, instead of `lo` or `-1`).
5. A target above every element leaves `lo == n`, which is the correct append position — the half-open range makes that fall out for free.

### Dry Run

Input: `nums = [1, 3, 5, 6]`, `target = 4`

| step | `lo` | `hi` | `mid` | `nums[mid]` | `nums[mid] < 4`? | action |
|------|------|------|-------|-------------|------------------|--------|
| 1 | 0 | 4 | 0 + 2 = **2** | 5 | no — candidate | `hi = 2` |
| 2 | 0 | 2 | 0 + 1 = **1** | 3 | yes — too small | `lo = 2` |
| 3 | 2 | 2 | — | — | — | `lo == hi` → return **2** |

Output: **2** — inserting 4 at index 2 gives `[1, 3, 4, 5, 6]`. ✓

The three boundary cases on the same array:

| target | result | reason |
|--------|--------|--------|
| 5 (present) | **2** | lower bound lands on the target itself |
| 7 (above all) | **4** | `lo` runs to `n` — the append position |
| 0 (below all) | **0** | `hi` runs to 0 — the prepend position |

Contrast with example 1: identical loop, and the *only* difference is that `searchRange` follows it with `nums[lo] == target`. That check is what turns "where would it go" into "where is it".

### Visualization

```text
nums  = [ 1,   3,   5,   6 ]        target = 4
index     0    1    2    3    (4)  ← n is a legal answer

>= 4  :   F    F    T    T
                    ↑ first TRUE → insert at index 2

step 1  [lo=0 ─────────── hi=4)   mid=2  nums[2]=5 not < 4 → hi=2
step 2  [lo=0 ─ hi=2)             mid=1  nums[1]=3 <  4    → lo=2
        lo == hi == 2  ★

result: [1, 3, | 4 |, 5, 6]
```

### Code

```go
func searchInsert(nums []int, target int) int {
    lo, hi := 0, len(nums) // half-open; lo == len(nums) means "append"

    for lo < hi {
        mid := lo + (hi-lo)/2
        if nums[mid] < target {
            lo = mid + 1 // too small → the slot is strictly right
        } else {
            hi = mid // mid could be the slot → keep it
        }
    }
    return lo // first index with nums[i] >= target
}
```

```python
def searchInsert(nums, target):
    lo, hi = 0, len(nums)              # half-open; lo == len means "append"

    while lo < hi:
        mid = lo + (hi - lo) // 2
        if nums[mid] < target:
            lo = mid + 1               # too small → slot is strictly right
        else:
            hi = mid                   # mid could be the slot → keep it

    return lo                          # first index with nums[i] >= target
```

### Complexity
Time **O(log n)** — one boundary search. Space **O(1)**.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 34 | First Last Position | Easy | Core binary search application |
| 278 | First Bad Version | Easy | Core binary search application |
| 35 | Search Insert | Medium | Core binary search application |
| 744 | Smallest Letter | Medium | Core binary search application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same First Occurrence logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** First Occurrence (Binary Search).
- **Signal:** first, leftmost, binary search, duplicates, boundary.
- **Move:** If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.
- **Cost:** O(log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the First Occurrence invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: First Occurrence
FAMILY : Binary Search (Intermediate)
WHEN   : first, leftmost, binary search, duplicates, boundary
DO     : If the space is sorted (or a predicate is monotonic), comparing the middle lets 
TIME   : O(log n)    SPACE: O(1)
PRACTICE: 34, 278, 35, 744
```

---

*Part of the DSA Patterns Handbook — pattern 21 of 100.*
