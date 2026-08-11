# 94 · Meet in the Middle

> **One-liner:** Split the input in half, enumerate each, then combine — 2^(n/2).

---

## 1. Overview

### Definition
The **Meet in the Middle** pattern belongs to the *Advanced* family. Split the input in half, enumerate each, then combine — 2^(n/2).

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
meet in the middle, split, 2^(n/2), subset sum, combine halves.

### Constraints
- Input size where the brute-force complexity would time out — the Meet in the Middle optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Meet in the Middle invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Meet in the Middle is the upgrade.
- The wording maps onto: meet in the middle, split, 2^(n/2), subset sum, combine halves.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Which subset gets closest to a target?"* — when `n` is around 40: too big for `2ⁿ`, too big for a DP over sums.

### Intuition
Enumerate every subset and score it.

### Algorithm
1. For each of the `2ⁿ` subsets:
2. &nbsp;&nbsp;Compute its sum.
3. &nbsp;&nbsp;Compare against the target and keep the best.

### Complexity
- Time: **O(2ⁿ)**.
- Space: O(1).

### Drawbacks
- At `n = 40` that is 1.1 × 10¹² subsets — roughly an hour of pure arithmetic, and far beyond any time limit.
- Subset-sum DP does not rescue you either: with values up to 10⁹ the sum axis is astronomically wide, so `O(n · sum)` is worse than the exponential.

```text
n = 20   2^20 = 1e6        fine
n = 40   2^40 = 1e12       hopeless
n = 40   2^20 twice = 2e6  ← the whole idea
```

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Split the items into two halves, enumerate each half completely, then *match* the halves against each other instead of enumerating their combination.**

```text
2^n           →       2^(n/2)  +  2^(n/2)   generated
                              then matched with sorting or hashing
              →       O(2^(n/2) · n)
```

Halving the exponent turns `10¹²` into `10⁶`. That is the entire pattern, and it is why it is called *meet in the middle*.

### The thought process

```text
We need    : the best subset of ~40 items.
Obvious way: enumerate all 2^n subsets.
Hopeless   : 2^40.
Notice     : every subset is (a subset of the first half) plus
             (a subset of the second half), independently.
Therefore  : enumerate the two halves SEPARATELY — 2^20 each — and
             then find the best pairing between them.
Now        : generation is cheap; the matching step is the work.
```

### The matching step is where the technique lives

Generating both halves is easy. The skill is combining them **without** trying all `2^(n/2) × 2^(n/2)` pairs — which would put you right back at `2ⁿ`.

| What you need | Matching technique | Cost |
|---|---|---|
| an **exact** target | hash set of one half, look up `target − x` | O(1) per item |
| the **closest** value | sort one half, binary search each item of the other | O(log) per item |
| closest, both sorted | **two pointers** walking inward | O(1) per item |
| best under a constraint | sort, then a running prefix maximum | O(1) per item |

The exact-match case is Two Sum on the two halves. The closest-value case is the one that appears most often, and sorting plus binary search is the reliable default.

### Steps

```text
Step 1 → Split the items into halves A and B (sizes as equal as possible).
Step 2 → Enumerate every subset sum of A  → list `sumsA`  (2^|A| entries)
Step 3 → Enumerate every subset sum of B  → list `sumsB`
Step 4 → Sort `sumsA`.
Step 5 → For each s in sumsB:
Step 6 →     binary search sumsA for the value closest to (target - s)
Step 7 →     check both the found element and its neighbour
Step 8 → Return the best pairing seen.
```

**Step 7 matters.** A lower-bound search returns the first element `>= x`; the closest value may be that one *or* the one just before it. Checking only one side is the standard bug here.

### Enumerating one half's subset sums

Iterate the masks of that half; each mask is a subset:

```text
for mask := 0; mask < (1 << len(half)); mask++ {
    sum := 0
    for i := range half {
        if mask & (1 << i) != 0 { sum += half[i] }
    }
}
```

That is `O(2^k · k)`. It can be reduced to `O(2^k)` by building each sum from a smaller mask (`sum[mask] = sum[mask &^ lowbit] + half[index(lowbit)]`), but the simple version is usually fast enough and much easier to get right.

### When you also need the subset *size*

Some problems constrain how many items may be chosen — "split into two arrays of equal length", "a non-empty proper subset". Then a bare sum is not enough: group each half's sums **by subset size**, and only combine sizes that add up to something legal.

```text
sumsA[k] = all sums achievable using exactly k items from A
```

That turns one sorted list into `|A| + 1` sorted lists, and the matching runs per compatible size pair.

### How should I recognize this?

```text
If you see...
  n around 30-40 — too big for 2^n, too small for anything polynomial
  "closest subset sum", "split into two groups", "choose any subset such that..."
  values too large for a sum-indexed DP
        ↓
Think about...
  "Can I split the items in half, solve each half exhaustively,
   and then MATCH the two halves cheaply?"
        ↓
Use...
  enumerate 2^(n/2) per half
  exact target → hash set;  closest → sort + binary search
  size constraints → group each half's sums by subset size
```

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="mm-94" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">n=4 [3,1,4,2], target=6: split, enumerate 2² each, combine</text>
  <!-- left half cells -->
  <rect x="120" y="40" width="46" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="143" y="66" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="170" y="40" width="46" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="193" y="66" text-anchor="middle" fill="#1e293b">1</text>
  <text x="168" y="98" text-anchor="middle" fill="#64748b">left half</text>
  <!-- right half cells -->
  <rect x="424" y="40" width="46" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="447" y="66" text-anchor="middle" fill="#1e293b">4</text>
  <rect x="474" y="40" width="46" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="497" y="66" text-anchor="middle" fill="#1e293b">2</text>
  <text x="472" y="98" text-anchor="middle" fill="#64748b">right half</text>
  <!-- subset sums -->
  <text x="168" y="128" text-anchor="middle" fill="#2563eb" font-weight="700">A subset sums</text>
  <rect x="90"  y="140" width="156" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="168" y="160" text-anchor="middle" fill="#1e293b">{ 0, 3, 1, 4 }</text>
  <text x="472" y="128" text-anchor="middle" fill="#059669" font-weight="700">B sums (sorted)</text>
  <rect x="394" y="140" width="156" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="472" y="160" text-anchor="middle" fill="#1e293b">{ 0, 2, 4, 6 }</text>
  <!-- combine arrows -->
  <line x1="246" y1="185" x2="300" y2="205" stroke="#475569" marker-end="url(#mm-94)"/>
  <line x1="394" y1="185" x2="340" y2="205" stroke="#475569" marker-end="url(#mm-94)"/>
  <text x="320" y="216" text-anchor="middle" fill="#1e293b" font-weight="700">for a in A: binary-search (6 − a) in B</text>
  <text x="320" y="240" text-anchor="middle" fill="#059669" font-weight="700">a=4 needs 2 ✓  ──▶  4 + 2 = 6 in O(2^(n/2) · n) not O(2^n)</text>
</svg>
```

```text
nums = [5, -7, 3, 5], goal = 6

split:   A = [5, -7]        B = [3, 5]

subset sums of A:  {0, 5, -7, -2}       (2^2 = 4)
subset sums of B:  {0, 3, 5, 8}         (2^2 = 4)

sort sumsA:  [-7, -2, 0, 5]

for each b in sumsB, look for the a closest to (goal - b):

   b = 0   want  6   →  closest a =  5   →  |5 + 0 - 6| = 1
   b = 3   want  3   →  closest a =  5   →  |5 + 3 - 6| = 2
   b = 5   want  1   →  closest a =  0   →  |0 + 5 - 6| = 1
   b = 8   want -2   →  closest a = -2   →  |-2 + 8 - 6| = 0   ★

answer: 0
```

### Interview explanation
"`n` is around 40, which is the signature of meet in the middle: too large for `2ⁿ` but exactly right for two independent halves of `2ⁿᐟ²`. Every subset is a subset of the first half combined with a subset of the second, and those choices are independent — so I enumerate all `2²⁰` subset sums of each half separately, which is about a million each. The skill is in the matching: I must not try all pairs, or I'm back at `2ⁿ`. For a closest-sum target I sort one half's sums and binary search each element of the other for `target − s`, checking both the element found and its predecessor since the closest value can be on either side. That's `O(2ⁿᐟ² · n)` overall. If the problem also constrains the subset size, I group each half's sums by how many items they use and only combine compatible size pairs."

---

## 5. Generic Templates

> Enumerate each half; match with sorting, hashing, or two pointers.

```go
// SubsetSums returns every subset sum of `items`, one per mask.
func SubsetSums(items []int) []int {
    total := 1 << len(items)
    sums := make([]int, 0, total)

    for mask := 0; mask < total; mask++ {
        sum := 0
        for i := range items {
            if mask&(1<<i) != 0 {
                sum += items[i]
            }
        }
        sums = append(sums, sum)
    }
    return sums
}

// SubsetSumsBySize groups each subset sum by how many items it uses,
// which is what size-constrained problems need.
func SubsetSumsBySize(items []int) [][]int {
    bySize := make([][]int, len(items)+1)

    for mask := 0; mask < (1 << len(items)); mask++ {
        sum, size := 0, 0
        for i := range items {
            if mask&(1<<i) != 0 {
                sum += items[i]
                size++
            }
        }
        bySize[size] = append(bySize[size], sum)
    }
    return bySize
}

// ClosestSubsetSum returns the smallest possible |subsetSum - goal|.
func ClosestSubsetSum(nums []int, goal int) int {
    middle := len(nums) / 2
    sumsA := SubsetSums(nums[:middle])
    sumsB := SubsetSums(nums[middle:])

    sort.Ints(sumsA) // so we can binary search it

    best := math.MaxInt32
    for _, b := range sumsB {
        want := goal - b

        // First index whose value is >= want.
        i := sort.SearchInts(sumsA, want)

        // The closest value may be at i OR at i-1 — check BOTH sides,
        // which is the step people usually forget.
        for _, candidate := range []int{i - 1, i} {
            if candidate < 0 || candidate >= len(sumsA) {
                continue
            }
            difference := sumsA[candidate] + b - goal
            if difference < 0 {
                difference = -difference
            }
            if difference < best {
                best = difference
            }
        }
    }
    return best
}

// ExactSubsetSum is the hash-set variant: does any subset hit the target?
func ExactSubsetSum(nums []int, target int) bool {
    middle := len(nums) / 2

    seen := make(map[int]struct{})
    for _, a := range SubsetSums(nums[:middle]) {
        seen[a] = struct{}{}
    }

    for _, b := range SubsetSums(nums[middle:]) {
        if _, ok := seen[target-b]; ok {
            return true
        }
    }
    return false
}
```

```python
from bisect import bisect_left

def subset_sums(items):
    """Every subset sum, one per mask."""
    sums = []
    for mask in range(1 << len(items)):
        total = sum(items[i] for i in range(len(items)) if mask & (1 << i))
        sums.append(total)
    return sums

def subset_sums_by_size(items):
    """Group each subset sum by how many items it uses."""
    by_size = [[] for _ in range(len(items) + 1)]
    for mask in range(1 << len(items)):
        chosen = [items[i] for i in range(len(items)) if mask & (1 << i)]
        by_size[len(chosen)].append(sum(chosen))
    return by_size

def closest_subset_sum(nums, goal):
    """Smallest possible |subsetSum - goal|."""
    middle = len(nums) // 2
    sums_a = sorted(subset_sums(nums[:middle]))     # sorted for binary search
    sums_b = subset_sums(nums[middle:])

    best = float("inf")
    for b in sums_b:
        want = goal - b
        i = bisect_left(sums_a, want)

        # The closest value may be at i OR i-1 — check BOTH sides.
        for candidate in (i - 1, i):
            if 0 <= candidate < len(sums_a):
                best = min(best, abs(sums_a[candidate] + b - goal))
    return best

def exact_subset_sum(nums, target):
    """Hash-set variant: does any subset hit the target exactly?"""
    middle = len(nums) // 2
    seen = set(subset_sums(nums[:middle]))
    return any(target - b in seen for b in subset_sums(nums[middle:]))
```

```java
import java.util.*;

public class MeetInTheMiddle {
    public static List<Integer> subsetSums(int[] items) {
        List<Integer> sums = new ArrayList<>(1 << items.length);
        for (int mask = 0; mask < (1 << items.length); mask++) {
            int sum = 0;
            for (int i = 0; i < items.length; i++)
                if ((mask & (1 << i)) != 0) sum += items[i];
            sums.add(sum);
        }
        return sums;
    }

    public static int closestSubsetSum(int[] nums, int goal) {
        int middle = nums.length / 2;
        int[] left = Arrays.copyOfRange(nums, 0, middle);
        int[] right = Arrays.copyOfRange(nums, middle, nums.length);

        List<Integer> sumsA = subsetSums(left);
        Collections.sort(sumsA);                    // for binary search
        List<Integer> sumsB = subsetSums(right);

        int best = Integer.MAX_VALUE;
        for (int b : sumsB) {
            int want = goal - b;
            int i = lowerBound(sumsA, want);

            // Check BOTH sides — the closest may be at i or i-1.
            for (int candidate : new int[]{i - 1, i}) {
                if (candidate < 0 || candidate >= sumsA.size()) continue;
                best = Math.min(best, Math.abs(sumsA.get(candidate) + b - goal));
            }
        }
        return best;
    }

    private static int lowerBound(List<Integer> sorted, int target) {
        int lo = 0, hi = sorted.size();
        while (lo < hi) {
            int mid = lo + (hi - lo) / 2;
            if (sorted.get(mid) < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }
}
```

```cpp
#include <algorithm>
#include <climits>
#include <cstdlib>
#include <vector>
using namespace std;

vector<int> subsetSums(const vector<int>& items) {
    vector<int> sums;
    sums.reserve(1 << items.size());
    for (int mask = 0; mask < (1 << (int)items.size()); ++mask) {
        int sum = 0;
        for (int i = 0; i < (int)items.size(); ++i)
            if (mask & (1 << i)) sum += items[i];
        sums.push_back(sum);
    }
    return sums;
}

int closestSubsetSum(const vector<int>& nums, int goal) {
    int middle = (int)nums.size() / 2;
    vector<int> sumsA = subsetSums({nums.begin(), nums.begin() + middle});
    vector<int> sumsB = subsetSums({nums.begin() + middle, nums.end()});

    sort(sumsA.begin(), sumsA.end());               // for binary search

    int best = INT_MAX;
    for (int b : sumsB) {
        int want = goal - b;
        auto it = lower_bound(sumsA.begin(), sumsA.end(), want);

        // Check BOTH sides — the closest may be at it or it-1.
        for (auto candidate : {it == sumsA.begin() ? it : prev(it), it}) {
            if (candidate == sumsA.end()) continue;
            best = min(best, abs(*candidate + b - goal));
        }
    }
    return best;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Meet in the Middle (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **Varies (often O(log n) per op)** |
| Time (best)  | — | **Varies (often O(log n) per op)** |
| Time (average) | — | **Varies (often O(log n) per op)** |
| Space | varies | **O(n) to O(n log n)** |

> Build cost amortized over many fast queries/updates.

---

## 7. Common Mistakes

1. Mixing 0-indexed and 1-indexed conventions (Fenwick is 1-indexed).
2. Segment tree: wrong recursion bounds or lazy-propagation push-down.
3. Trie: not marking end-of-word, or leaking memory on delete.
4. Sparse table on a non-idempotent operation (sums need a different trick).
5. Bitmask DP exceeding memory for n > ~22.
6. Meet-in-the-middle: incorrect merge of the two halves.
7. Euler tour: off-by-one in in/out times.
8. Network flow: forgetting residual/back edges.
9. SCC/Tarjan: mishandling the low-link update and stack.
10. Mo's algorithm: wrong block size or add/remove ordering.

---

## 8. Interview Follow-Up Questions

1. **Q: Fenwick vs segment tree?**
   A: Fenwick is smaller/faster for prefix sums; segment tree is more general (min/max, lazy ranges).

2. **Q: Range update + range query?**
   A: Segment tree with lazy propagation, or two Fenwicks.

3. **Q: Trie use cases?**
   A: Prefix search, autocomplete, word dictionaries, XOR-maximization.

4. **Q: Sparse table limits?**
   A: O(1) queries but only static, idempotent operations (min/max/gcd).

5. **Q: Bitmask DP feasibility?**
   A: n ≲ 20–22 because of 2^n states.

6. **Q: Meet-in-the-middle when?**
   A: n ≲ 40 subset problems: split into 2^(n/2).

7. **Q: Euler tour purpose?**
   A: Flatten a tree so subtrees are contiguous ranges.

8. **Q: Heavy-light decomposition?**
   A: Path queries on trees via O(log n) chains + segment tree.

9. **Q: Max flow = min cut?**
   A: By the max-flow min-cut theorem; models matching/assignment.

10. **Q: SCC algorithms?**
   A: Tarjan (one DFS) or Kosaraju (two passes).

11. **Q: Bridges / articulation points?**
   A: Tarjan's low-link values in one DFS.

12. **Q: Mo's algorithm complexity?**
   A: O((n+q)√n) for offline range queries.

13. **Q: When is the build cost worth it?**
   A: When many queries/updates amortize the O(n log n) build.

14. **Q: Persistence?**
   A: Persistent segment trees answer historical-version queries.

15. **Q: Coordinate compression?**
   A: Map large/sparse keys to a dense index range first.

---

## 9. Solved Example 1

### Problem — Closest Subsequence Sum (LeetCode 1755)
Given `nums` (length up to 40) and a `goal`, choose any subsequence and minimise `|sum − goal|`.

### Thought Process
1. `n ≤ 40` is the signature: `2⁴⁰` is hopeless, `2²⁰` twice is a million each.
2. Split into halves. Every subsequence is a subset of the left half plus a subset of the right half, chosen independently.
3. Enumerate all subset sums of each half.
4. Sort the left half's sums, then for each right-half sum `b` binary search for the value closest to `goal − b`.
5. Check **both** the found index and the one before it — the closest value can lie on either side of a lower-bound result.

### Dry Run

Input: `nums = [5, -7, 3, 5]`, `goal = 6`

**Split:** `A = [5, -7]`, `B = [3, 5]`

**All subset sums:**

| half | masks | sums |
|------|-------|------|
| A | `{}`, `{5}`, `{−7}`, `{5,−7}` | `0, 5, −7, −2` |
| B | `{}`, `{3}`, `{5}`, `{3,5}` | `0, 3, 5, 8` |

**Sort A:** `[−7, −2, 0, 5]`

**Match each `b` against `goal − b = 6 − b`:**

| `b` | want `6 − b` | lower bound in A | candidates checked | best `\|a + b − 6\|` |
|-----|---------------|-------------------|--------------------|----------------------|
| 0 | 6 | index 4 (past end) | `a = 5` | `\|5 + 0 − 6\| = 1` |
| 3 | 3 | index 3 (`5`) | `a = 0`, `a = 5` | `\|0+3−6\| = 3`, `\|5+3−6\| = 2` → **2** |
| 5 | 1 | index 3 (`5`) | `a = 0`, `a = 5` | `\|0+5−6\| = 1`, `\|5+5−6\| = 4` → **1** |
| 8 | −2 | index 1 (`−2`) | `a = −7`, `a = −2` | `\|−7+8−6\| = 5`, `\|−2+8−6\| = **0**` ★ |

Output: **0** ✓ — the subsequence `{5, −7, 3, 5}` sums to exactly 6.

**Why both sides must be checked.** At `b = 3` the lower bound landed on `5`, giving distance 2. But the *predecessor* `0` gives 3 — worse here. At `b = 5` the roles reverse: the predecessor `0` gives 1 while the found `5` gives 4. Neither side is reliably better, so both must be tried.

### Visualization

```text
nums = [5, -7, 3, 5],  goal = 6

  A = [5, -7]        sums  {0, 5, -7, -2}   sorted  [-7, -2, 0, 5]
  B = [3,  5]        sums  {0, 3, 5, 8}

  b = 8  →  want 6 - 8 = -2
            binary search finds -2 exactly
            |-2 + 8 - 6| = 0        ★

  2^40 subsets became 2^2 + 2^2 generated, then matched
```

### Code

```go
func minAbsDifference(nums []int, goal int) int {
    middle := len(nums) / 2

    sumsA := allSubsetSums(nums[:middle])
    sumsB := allSubsetSums(nums[middle:])

    sort.Ints(sumsA) // so each b can be matched by binary search

    best := math.MaxInt32
    for _, b := range sumsB {
        want := goal - b

        // First index in sumsA whose value is >= want.
        i := sort.SearchInts(sumsA, want)

        // The closest value may be at i OR at i-1. Checking only one
        // side is the classic bug here.
        for _, candidate := range []int{i - 1, i} {
            if candidate < 0 || candidate >= len(sumsA) {
                continue
            }
            difference := sumsA[candidate] + b - goal
            if difference < 0 {
                difference = -difference
            }
            if difference < best {
                best = difference
            }
        }
    }
    return best
}

// allSubsetSums returns one sum per subset mask of `items`.
func allSubsetSums(items []int) []int {
    sums := make([]int, 0, 1<<len(items))
    for mask := 0; mask < (1 << len(items)); mask++ {
        sum := 0
        for i := range items {
            if mask&(1<<i) != 0 {
                sum += items[i]
            }
        }
        sums = append(sums, sum)
    }
    return sums
}
```

```python
from bisect import bisect_left

def minAbsDifference(nums, goal):
    def all_subset_sums(items):
        sums = []
        for mask in range(1 << len(items)):
            sums.append(sum(items[i] for i in range(len(items)) if mask & (1 << i)))
        return sums

    middle = len(nums) // 2
    sums_a = sorted(all_subset_sums(nums[:middle]))     # sorted for searching
    sums_b = all_subset_sums(nums[middle:])

    best = float("inf")
    for b in sums_b:
        want = goal - b
        i = bisect_left(sums_a, want)

        # The closest value may be at i OR i-1 — check BOTH.
        for candidate in (i - 1, i):
            if 0 <= candidate < len(sums_a):
                best = min(best, abs(sums_a[candidate] + b - goal))
    return best
```

### Complexity
Time **O(2ⁿᐟ² · n)** — generating each half, sorting one, and one binary search per element of the other. Space O(2ⁿᐟ²).

---

## 10. Solved Example 2

### Problem — Split Array With Same Average (LeetCode 805)
Can `nums` be split into two non-empty parts whose **averages** are equal?

### Thought Process
1. Averages are awkward to compare directly. Normalise them away.
2. If part `A` has `k` elements and sum `sA`, and the whole array has `n` elements and sum `S`, equal averages means `sA/k = S/n`, i.e. `n·sA = k·S`.
3. Rewrite each element as `b[i] = n · nums[i] − S`. Then `Σ b over A = n·sA − k·S`, which is **zero** exactly when the averages match.
4. So the question becomes: **is there a non-empty proper subset of `b` summing to 0?**
5. Now it is meet in the middle — but sizes matter (the subset must be neither empty nor everything), so each half's sums are grouped by subset size.

**Why the transformation is worth doing.** It converts a two-variable condition (size *and* sum) into a single-value target of zero, which the matching step can hash directly.

### Dry Run

Input: `nums = [1, 2, 3, 4, 5, 6, 7, 8]`

`n = 8`, `S = 36`. Transform `b[i] = 8·nums[i] − 36`:

| nums[i] | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---------|---|---|---|---|---|---|---|---|
| b[i] | −28 | −20 | −12 | −4 | 4 | 12 | 20 | 28 |

**Split:** `A = [−28, −20, −12, −4]`, `B = [4, 12, 20, 28]`

Enumerating both halves, one match stands out:

```text
from A:  the subset {-28}     sum -28,  size 1
from B:  the subset { 28}     sum  28,  size 1

combined sum  = 0        ✓
combined size = 2, which is in [1, 7]   ✓ non-empty and proper
```

Output: **`true`** ✓

Checking directly: that subset is `nums = {1, 8}`, sum 9, size 2 → average 4.5. The rest is `{2,3,4,5,6,7}`, sum 27, size 6 → average 4.5. Equal ✓ — and the whole array averages `36/8 = 4.5` too, as it must.

**A failing case:** `nums = [3, 1]`. `n = 2`, `S = 4`, so `b = [2, −2]`. The only non-empty proper subsets are `{2}` and `{−2}`, neither summing to 0 → **`false`** ✓

**Why the size check is needed.** The empty subset sums to 0, and so does the *entire* array — `Σ b = n·S − n·S = 0` always. Both are degenerate, so the combined size must be strictly between 0 and `n`.

### Visualization

```text
nums = [1, 2, 3, 4, 5, 6, 7, 8]     n = 8, S = 36

  transform:  b[i] = 8*nums[i] - 36
              [-28, -20, -12, -4, 4, 12, 20, 28]

  goal: a NON-EMPTY PROPER subset of b summing to 0

  A = [-28, -20, -12, -4]        B = [4, 12, 20, 28]

  pick {-28} from A  (size 1)  +  pick {28} from B  (size 1)
       sum -28                        sum  28
                     total 0,  size 2  ∈ [1, 7]     ✓

  note: the empty subset and the FULL array both sum to 0 —
        which is exactly why sizes must be tracked
```

### Code

```go
func splitArraySameAverage(nums []int) bool {
    n := len(nums)
    if n < 2 {
        return false
    }

    total := 0
    for _, v := range nums {
        total += v
    }

    // b[i] = n*nums[i] - total. A subset of b sums to 0 exactly when
    // that subset's average equals the whole array's average.
    transformed := make([]int, n)
    for i, v := range nums {
        transformed[i] = n*v - total
    }

    middle := n / 2
    left, right := transformed[:middle], transformed[middle:]

    // For each achievable sum, remember WHICH SIZES achieve it, as a
    // bitmask over sizes 0..len(half). Sizes matter because the empty
    // subset and the full array both sum to 0.
    sizesForSum := make(map[int]int)
    for mask := 0; mask < (1 << len(left)); mask++ {
        sum, size := 0, 0
        for i := range left {
            if mask&(1<<i) != 0 {
                sum += left[i]
                size++
            }
        }
        sizesForSum[sum] |= 1 << size
    }

    for mask := 0; mask < (1 << len(right)); mask++ {
        sum, size := 0, 0
        for i := range right {
            if mask&(1<<i) != 0 {
                sum += right[i]
                size++
            }
        }

        leftSizes, ok := sizesForSum[-sum]
        if !ok {
            continue
        }

        // Any left-half size that makes the combined size a proper,
        // non-empty subset works.
        for leftSize := 0; leftSize <= len(left); leftSize++ {
            if leftSizes&(1<<leftSize) == 0 {
                continue
            }
            combined := leftSize + size
            if combined > 0 && combined < n {
                return true
            }
        }
    }

    return false
}
```

```python
def splitArraySameAverage(nums):
    n = len(nums)
    if n < 2:
        return False
    total = sum(nums)

    # b[i] = n*nums[i] - total; a subset sums to 0 iff its average matches.
    transformed = [n * v - total for v in nums]

    middle = n // 2
    left, right = transformed[:middle], transformed[middle:]

    # sum -> set of subset SIZES achieving it (sizes matter: the empty
    # subset and the full array both sum to 0).
    sizes_for_sum = {}
    for mask in range(1 << len(left)):
        chosen = [left[i] for i in range(len(left)) if mask & (1 << i)]
        sizes_for_sum.setdefault(sum(chosen), set()).add(len(chosen))

    for mask in range(1 << len(right)):
        chosen = [right[i] for i in range(len(right)) if mask & (1 << i)]
        need = -sum(chosen)
        for left_size in sizes_for_sum.get(need, ()):
            combined = left_size + len(chosen)
            if 0 < combined < n:            # non-empty and proper
                return True

    return False
```

### Complexity
Time **O(2ⁿᐟ² · n)**, Space **O(2ⁿᐟ²)**.

---

## 11. Solved Example 3

### Problem — Partition Array Into Two Arrays to Minimize Sum Difference (LeetCode 2035)
Given `2n` integers, split them into two arrays of **exactly `n` elements each**, minimising the absolute difference of their sums.

### Thought Process
1. `2n ≤ 30`, so `n ≤ 15` and each half has 15 elements — `2¹⁵ = 32,768` subsets per half. Meet in the middle fits exactly.
2. The size constraint is hard here: taking `k` elements from the left half means taking exactly `n − k` from the right.
3. So group each half's subset sums **by size**, giving `n + 1` buckets per half.
4. Let `S` be the total. If one part sums to `p`, the difference is `|S − 2p|` — so we want `p` as close to `S/2` as possible.
5. For each size `k`, match the left half's size-`k` sums against the right half's size-`(n−k)` sums: sort one bucket and binary search the other.

### Dry Run

Input: `nums = [3, 9, 7, 3]` → `2n = 4`, so `n = 2` and each part must have 2 elements.

`S = 22`, so the ideal part sum is `S/2 = 11`.

**Split:** `A = [3, 9]`, `B = [7, 3]`

**Subset sums by size:**

| half | size 0 | size 1 | size 2 |
|------|--------|--------|--------|
| A | `[0]` | `[3, 9]` | `[12]` |
| B | `[0]` | `[7, 3]` | `[10]` |

**Match size `k` from A with size `2 − k` from B:**

| `k` | A sums (size k) | B sums (size 2−k) | combined `p` | `\|S − 2p\| = \|22 − 2p\|` |
|-----|------------------|--------------------|--------------|-----------------------------|
| 0 | `0` | `10` | 10 | `\|22 − 20\| = **2**` |
| 1 | `3` | `7` | 10 | **2** |
| 1 | `3` | `3` | 6 | `\|22 − 12\| = 10` |
| 1 | `9` | `7` | 16 | `\|22 − 32\| = 10` |
| 1 | `9` | `3` | 12 | `\|22 − 24\| = **2**` |
| 2 | `12` | `0` | 12 | **2** |

Output: **2** ✓

Verify one of them: `k = 1` with A's `3` and B's `7` gives the part `{3, 7}` summing to 10, leaving `{9, 3}` summing to 12 → difference 2. ✓

**Why the size grouping is essential.** The single best sum overall would be `p = 11`, but no 2-element subset sums to 11 here. Ignoring sizes would happily pair A's size-0 subset with B's size-1 subset and report a 1-element part, which the problem forbids.

### Visualization

```text
nums = [3, 9, 7, 3]     total S = 22,  each part must hold 2 elements

  A = [3, 9]                     B = [7, 3]
  size 0: {0}                    size 0: {0}
  size 1: {3, 9}                 size 1: {7, 3}
  size 2: {12}                   size 2: {10}

  combine size k from A with size (2-k) from B:

     k=0:  0 + 10 = 10   →  |22 - 20| = 2   ★
     k=1:  3 +  7 = 10   →  |22 - 20| = 2   ★
     k=1:  9 +  3 = 12   →  |22 - 24| = 2   ★
     k=2: 12 +  0 = 12   →  |22 - 24| = 2   ★

  minimum difference = 2
```

### Code

```go
func minimumDifference(nums []int) int {
    half := len(nums) / 2 // each part must contain exactly `half` elements

    total := 0
    for _, v := range nums {
        total += v
    }

    left := sumsBySize(nums[:half])
    right := sumsBySize(nums[half:])

    // Sort each right-hand bucket so it can be binary searched.
    for size := range right {
        sort.Ints(right[size])
    }

    best := math.MaxInt32

    for k := 0; k <= half; k++ {
        need := half - k // taking k from the left means half-k from the right
        if need < 0 || need > half {
            continue
        }

        for _, a := range left[k] {
            // We want the part sum p = a + b as close as possible to
            // total/2, so b should be close to total/2 - a.
            want := total/2 - a
            bucket := right[need]

            i := sort.SearchInts(bucket, want)
            for _, candidate := range []int{i - 1, i} {
                if candidate < 0 || candidate >= len(bucket) {
                    continue
                }
                partSum := a + bucket[candidate]

                // One part sums to partSum, so the difference is |S - 2p|.
                difference := total - 2*partSum
                if difference < 0 {
                    difference = -difference
                }
                if difference < best {
                    best = difference
                }
            }
        }
    }

    return best
}

// sumsBySize[k] lists every subset sum using exactly k of the items.
func sumsBySize(items []int) [][]int {
    bySize := make([][]int, len(items)+1)

    for mask := 0; mask < (1 << len(items)); mask++ {
        sum, size := 0, 0
        for i := range items {
            if mask&(1<<i) != 0 {
                sum += items[i]
                size++
            }
        }
        bySize[size] = append(bySize[size], sum)
    }
    return bySize
}
```

```python
from bisect import bisect_left

def minimumDifference(nums):
    half = len(nums) // 2               # each part holds exactly `half` items
    total = sum(nums)

    def sums_by_size(items):
        by_size = [[] for _ in range(len(items) + 1)]
        for mask in range(1 << len(items)):
            chosen = [items[i] for i in range(len(items)) if mask & (1 << i)]
            by_size[len(chosen)].append(sum(chosen))
        return by_size

    left = sums_by_size(nums[:half])
    right = [sorted(bucket) for bucket in sums_by_size(nums[half:])]

    best = float("inf")
    for k in range(half + 1):
        need = half - k                 # k from the left ⇒ half-k from the right
        bucket = right[need]
        for a in left[k]:
            want = total // 2 - a       # aim the part sum at total/2
            i = bisect_left(bucket, want)
            for candidate in (i - 1, i):
                if 0 <= candidate < len(bucket):
                    part = a + bucket[candidate]
                    best = min(best, abs(total - 2 * part))

    return best
```

### Complexity
Time **O(2ⁿ · n)** where `n` is the half-length — generating both halves, sorting the buckets, and one binary search per left-hand sum. Space O(2ⁿ).

> All three examples split, enumerate, and match — the differences are only in the matching. Example 1 wants the closest value (sort + binary search), Example 2 wants an exact zero (hash), and Example 3 adds a size constraint (bucket by size first). Recognising *which* matching your problem needs is the whole skill once the split is obvious.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 1755 | Closest Subseq Sum | Easy | Core advanced application |
| 805 | Split Array Avg | Easy | Core advanced application |
| 2035 | Two Subsets | Medium | Core advanced application |
| 956 | Tallest Billboard | Medium | Core advanced application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Trie**
- **Segment tree (+ lazy)**
- **Fenwick / BIT**
- **Sparse table**
- **Bitmask DP**
- **Meet in the middle**
- **Euler tour / HLD**
- **Max flow**
- **SCC / Tarjan**
- **Mo's algorithm**

---

## 14. Production Engineering Applications

- **Scalability:** These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n) to O(n log n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Meet in the Middle logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Meet in the Middle (Advanced).
- **Signal:** meet in the middle, split, 2^(n/2), subset sum, combine halves.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Meet in the Middle invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Meet in the Middle
FAMILY : Advanced (Expert)
WHEN   : meet in the middle, split, 2^(n/2), subset sum, combine halves
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 1755, 805, 2035, 956
```

---

*Part of the DSA Patterns Handbook — pattern 94 of 100.*
