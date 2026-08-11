# 86 · Jump Game

> **One-liner:** Track farthest reach greedily to decide reachability / min jumps.

---

## 1. Overview

### Definition
The **Jump Game** pattern belongs to the *Greedy* family. Track farthest reach greedily to decide reachability / min jumps.

### Intuition
When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).

### Why it works
Make the locally optimal choice that a proof (exchange argument) shows is globally safe — usually after sorting. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.

---

## 2. Recognition Signals

### Keywords
jump game, greedy, reachable, farthest, min jumps.

### Constraints
- Input size where the brute-force complexity would time out — the Jump Game optimization is the intended solution.
- Structural hints in the statement that match this family (Greedy).

### Hidden clues
- The problem can be reframed so the Jump Game invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Jump Game is the upgrade.
- The wording maps onto: jump game, greedy, reachable, farthest, min jumps.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Can I get there — and if so, in how few moves?"* — where each position tells you how far you may travel.

### Intuition
From each index, try every jump length it allows, and recurse.

### Algorithm
1. `canReach(i)`: if `i` is the last index, success.
2. For each step `s` from `1` to `nums[i]`, recurse on `i + s`.
3. Return true if any branch succeeds.

### Complexity
- Time: **O(2ⁿ)** in the worst case — every index branches into up to `n` others.
- Space: O(n) recursion depth.

### Drawbacks
- Exponential, and the reason is familiar: index 7 might be reachable from indices 3, 5 and 6, and each route re-explores everything beyond it.
- Memoising fixes that and gives O(n²). But there is a **greedy** insight that does it in O(n) with no table at all — and finding it is the point of the chapter.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **You never need to know *which* jumps to take — only how far you could possibly have reached by now.**

Collapse the whole set of reachable positions into a single number.

```text
farthest = the largest index reachable using any sequence of jumps
           from the positions seen so far
```

Sweep left to right, updating `farthest = max(farthest, i + nums[i])`. If you ever stand on an index beyond `farthest`, no sequence of jumps could have brought you there — the answer is no.

### The thought process

```text
We need    : whether the end is reachable (or the fewest jumps).
Obvious way: try every jump length from every index.
Too slow   : O(2^n), and it re-explores shared suffixes.
Notice     : from index i we may land ANYWHERE in [i+1, i+nums[i]].
             So reachability is not a set of scattered points — it is
             a contiguous PREFIX of the array.
Therefore  : one number describes it: the farthest index reached.
Now        : one linear sweep, O(n) time and O(1) space.
```

**Why reachability is a contiguous prefix** — this is what licenses the collapse. If index `j` is reachable, so is every index between the jump's origin and `j`, because a jump of length `nums[i]` permits *any* shorter length too. There are no gaps, so the reachable set is fully described by its maximum.

### Steps (can I reach the end?)

```text
Step 1 → farthest = 0
Step 2 → For i = 0 .. n-1:
Step 3 →     if i > farthest:  return false     ← stranded before here
Step 4 →     farthest = max(farthest, i + nums[i])
Step 5 →     if farthest >= n-1: return true    ← optional early exit
Step 6 → Return true
```

### Fewest jumps: the same sweep, seen as levels

For the minimum number of jumps, notice the structure is a **BFS in disguise**. Everything reachable in one jump forms level 1, everything reachable in two jumps forms level 2, and so on. Because each level is a contiguous range, you can track it with two numbers instead of a queue:

```text
currentEnd = the last index reachable with the jumps taken so far
farthest   = the last index reachable with ONE more jump
```

Sweep `i` forward, always updating `farthest`. When `i` reaches `currentEnd`, the current level is exhausted — take a jump, and the new level extends to `farthest`.

```text
for i = 0 .. n-2:                    ← note n-2, see below
    farthest = max(farthest, i + nums[i])
    if i == currentEnd:
        jumps++
        currentEnd = farthest
```

**Why the loop stops at `n−2`.** Arriving at the last index means we are already done; running to `n−1` would trigger one final level boundary and count a jump that is never taken. This off-by-one is the classic bug in this problem.

### When greedy is not enough

The collapse works because a jump of length `k` allows **any** distance from 1 to `k`. Change that and the contiguity breaks:

| Variant | Reachable set | Approach |
|---|---|---|
| Jump up to `nums[i]` (55, 45) | contiguous range | **greedy**, O(n) |
| Jump **exactly** `±arr[i]` (1306) | scattered indices | **BFS/DFS** with visited |
| Jump costs vary | weighted | Dijkstra or DP |

Jump Game III is the instructive one: `i + arr[i]` and `i − arr[i]` are two specific destinations, not a range. With gaps in the reachable set, a single `farthest` number cannot describe it — so you fall back to an explicit traversal with a `visited` array.

### How should I recognize this?

```text
If you see...
  "can you reach the last index", "minimum jumps to the end"
  "each element tells you how far you may move"
  "minimum number of steps/refuels/taps to cover a range"
        ↓
Think about...
  "Is the set of reachable positions a contiguous RANGE?
   If yes, one number describes it → greedy.
   If it has gaps → BFS."
        ↓
Use...
  reachability  → track `farthest`, fail when i > farthest
  fewest jumps  → track `currentEnd` and `farthest`, loop to n-2
  exact jumps   → BFS/DFS with visited
```

### Visual explanation

```svg
<svg viewBox="0 0 640 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="a-86" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Track the farthest reachable index; extend the frontier while i ≤ reach</text>
  <!-- nums 2 3 1 1 4, indices 0..4 -->
  <g>
    <rect x="60"  y="60" width="80" height="50" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="100" y="90" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="150" y="60" width="80" height="50" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="190" y="90" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="240" y="60" width="80" height="50" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="280" y="90" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="330" y="60" width="80" height="50" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="370" y="90" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="420" y="60" width="80" height="50" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="460" y="90" text-anchor="middle" fill="#1e293b">4</text>
  </g>
  <text x="100" y="128" text-anchor="middle" fill="#64748b">i0</text>
  <text x="190" y="128" text-anchor="middle" fill="#64748b">i1</text>
  <text x="280" y="128" text-anchor="middle" fill="#64748b">i2</text>
  <text x="370" y="128" text-anchor="middle" fill="#64748b">i3</text>
  <text x="460" y="128" text-anchor="middle" fill="#64748b">i4</text>
  <!-- reach frontier bar -->
  <line x1="60" y1="145" x2="500" y2="145" stroke="#059669" stroke-width="3" marker-end="url(#a-86)"/>
  <text x="280" y="165" text-anchor="middle" fill="#059669" font-weight="700">reach = max(reach, i + nums[i]) = 4 ≥ last index → reachable</text>
  <text x="320" y="188" text-anchor="middle" fill="#64748b">at i1: reach = max(2, 1+3) = 4 covers the end</text>
</svg>
```

```text
nums = [2, 3, 1, 1, 4]

i=0  nums[0]=2  → farthest = max(0, 0+2) = 2
i=1  nums[1]=3  → farthest = max(2, 1+3) = 4      ← reaches the end
i=2  nums[2]=1  → farthest = max(4, 2+1) = 4
i=3  nums[3]=1  → farthest = 4
i=4                already at the end

index    :  0    1    2    3    4
reachable: [────────────]                after i=0
reachable: [───────────────────────]     after i=1   → true

a jump of 3 permits 1, 2 or 3 — so there are never gaps
```

### Interview explanation
"The key realisation is that from index `i` I may land anywhere in `[i+1, i+nums[i]]` — any shorter jump is allowed too — so the set of reachable positions is always a contiguous prefix with no gaps. That means it's fully described by a single number: the farthest index reachable so far. I sweep left to right updating `farthest = max(farthest, i + nums[i])`, and if I ever reach an index beyond `farthest`, nothing could have got me there, so it's unreachable. That's O(n) time, O(1) space. For the minimum-jumps version it's really a BFS where each level is a contiguous range, so I track the current level's end and the farthest reachable — when `i` hits the level end I take a jump. The loop must stop at `n−2`, otherwise landing on the last index triggers one extra level boundary and over-counts. And I'd flag that this collapse only works because jumps allow *any* distance up to the value — Jump Game III allows exactly `±arr[i]`, which leaves gaps, so that one needs a real BFS."

---

## 5. Generic Templates

> Collapse reachability into one number. For levels, track two.

```go
// CanReachEnd reports whether the last index is reachable.
func CanReachEnd(nums []int) bool {
    farthest := 0

    for i := 0; i < len(nums); i++ {
        if i > farthest {
            return false // stranded: nothing could have brought us here
        }
        if i+nums[i] > farthest {
            farthest = i + nums[i]
        }
        if farthest >= len(nums)-1 {
            return true // early exit
        }
    }
    return true
}

// MinJumps returns the fewest jumps to reach the last index.
// This is a BFS whose levels happen to be contiguous ranges.
func MinJumps(nums []int) int {
    jumps, currentEnd, farthest := 0, 0, 0

    // n-2, NOT n-1: arriving at the last index means we are already done,
    // and running to n-1 would count one jump too many.
    for i := 0; i < len(nums)-1; i++ {
        if i+nums[i] > farthest {
            farthest = i + nums[i] // the reach of ONE more jump
        }
        if i == currentEnd { // this level is exhausted
            jumps++
            currentEnd = farthest
        }
    }
    return jumps
}

// CanReachZero handles EXACT jumps (i ± arr[i]), where the reachable set
// has gaps and a single `farthest` number no longer describes it.
func CanReachZero(arr []int, start int) bool {
    visited := make([]bool, len(arr))
    queue := []int{start}
    visited[start] = true

    for len(queue) > 0 {
        current := queue[0]
        queue = queue[1:]

        if arr[current] == 0 {
            return true
        }

        for _, next := range []int{current + arr[current], current - arr[current]} {
            if next >= 0 && next < len(arr) && !visited[next] {
                visited[next] = true
                queue = append(queue, next)
            }
        }
    }
    return false
}
```

```python
def can_reach_end(nums):
    """Reachability collapses to a single number."""
    farthest = 0
    for i, jump in enumerate(nums):
        if i > farthest:
            return False                # stranded
        farthest = max(farthest, i + jump)
        if farthest >= len(nums) - 1:
            return True                 # early exit
    return True

def min_jumps(nums):
    """A BFS whose levels are contiguous ranges."""
    jumps = current_end = farthest = 0

    # len(nums)-1, NOT len(nums): arriving at the last index is already
    # done, and going further would count one jump too many.
    for i in range(len(nums) - 1):
        farthest = max(farthest, i + nums[i])   # reach of ONE more jump
        if i == current_end:                    # level exhausted
            jumps += 1
            current_end = farthest
    return jumps

def can_reach_zero(arr, start):
    """EXACT jumps (i ± arr[i]) leave gaps → a real BFS is needed."""
    from collections import deque
    visited = [False] * len(arr)
    queue = deque([start])
    visited[start] = True

    while queue:
        current = queue.popleft()
        if arr[current] == 0:
            return True
        for nxt in (current + arr[current], current - arr[current]):
            if 0 <= nxt < len(arr) and not visited[nxt]:
                visited[nxt] = True
                queue.append(nxt)
    return False
```

```java
import java.util.*;

public class JumpGame {
    public static boolean canReachEnd(int[] nums) {
        int farthest = 0;
        for (int i = 0; i < nums.length; i++) {
            if (i > farthest) return false;            // stranded
            farthest = Math.max(farthest, i + nums[i]);
            if (farthest >= nums.length - 1) return true;
        }
        return true;
    }

    // BFS with contiguous levels: loop to n-2, not n-1.
    public static int minJumps(int[] nums) {
        int jumps = 0, currentEnd = 0, farthest = 0;
        for (int i = 0; i < nums.length - 1; i++) {
            farthest = Math.max(farthest, i + nums[i]);
            if (i == currentEnd) {
                jumps++;
                currentEnd = farthest;
            }
        }
        return jumps;
    }

    // EXACT jumps leave gaps → real BFS.
    public static boolean canReachZero(int[] arr, int start) {
        boolean[] visited = new boolean[arr.length];
        Queue<Integer> queue = new ArrayDeque<>();
        queue.add(start);
        visited[start] = true;

        while (!queue.isEmpty()) {
            int current = queue.poll();
            if (arr[current] == 0) return true;
            for (int next : new int[]{current + arr[current], current - arr[current]})
                if (next >= 0 && next < arr.length && !visited[next]) {
                    visited[next] = true;
                    queue.add(next);
                }
        }
        return false;
    }
}
```

```cpp
#include <algorithm>
#include <queue>
#include <vector>
using namespace std;

bool canReachEnd(const vector<int>& nums) {
    int farthest = 0;
    for (int i = 0; i < (int)nums.size(); ++i) {
        if (i > farthest) return false;                 // stranded
        farthest = max(farthest, i + nums[i]);
        if (farthest >= (int)nums.size() - 1) return true;
    }
    return true;
}

// BFS with contiguous levels: loop to n-2, not n-1.
int minJumps(const vector<int>& nums) {
    int jumps = 0, currentEnd = 0, farthest = 0;
    for (int i = 0; i + 1 < (int)nums.size(); ++i) {
        farthest = max(farthest, i + nums[i]);
        if (i == currentEnd) {
            ++jumps;
            currentEnd = farthest;
        }
    }
    return jumps;
}

// EXACT jumps leave gaps → real BFS.
bool canReachZero(const vector<int>& arr, int start) {
    vector<bool> visited(arr.size(), false);
    queue<int> q;
    q.push(start);
    visited[start] = true;

    while (!q.empty()) {
        int current = q.front();
        q.pop();
        if (arr[current] == 0) return true;
        for (int next : {current + arr[current], current - arr[current]})
            if (next >= 0 && next < (int)arr.size() && !visited[next]) {
                visited[next] = true;
                q.push(next);
            }
    }
    return false;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Jump Game (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n log n)** |
| Time (best)  | — | **O(n log n)** |
| Time (average) | — | **O(n log n)** |
| Space | varies | **O(1)** |

> Sorting dominates; the greedy sweep is O(n).

---

## 7. Common Mistakes

1. Assuming greedy works without proving the exchange argument.
2. Sorting by the wrong key (e.g., start instead of finish time).
3. Ties broken incorrectly, flipping the result.
4. Greedy on a problem that actually needs DP.
5. Not handling the empty / single-element case.
6. Integer overflow in running totals (e.g., gas station).
7. Resetting accumulators at the wrong moment.
8. Off-by-one in reachability (jump game).
9. Forgetting that local optimum ≠ global without the safety proof.
10. Mutating input order when it matters downstream.

---

## 8. Interview Follow-Up Questions

1. **Q: How to know greedy is valid?**
   A: Prove an exchange argument: swapping to the greedy choice never worsens the optimum.

2. **Q: Activity selection key?**
   A: Sort by earliest finish time.

3. **Q: Jump game reachability?**
   A: Track the farthest reachable index.

4. **Q: Jump game II min jumps?**
   A: BFS-like greedy over reach boundaries.

5. **Q: Gas station start?**
   A: Reset start when the running tank goes negative.

6. **Q: Huffman coding?**
   A: Repeatedly merge the two smallest weights (heap).

7. **Q: Greedy vs DP?**
   A: Greedy when local choice is safe; DP when you must compare futures.

8. **Q: Fractional vs 0/1 knapsack?**
   A: Fractional is greedy; 0/1 needs DP.

9. **Q: Min arrows to burst balloons?**
   A: Greedy by end coordinate.

10. **Q: Task scheduling with cooldown?**
   A: Greedy with counts + idle slots, or heap.

11. **Q: Why O(n log n)?**
   A: Sorting dominates the single greedy pass.

12. **Q: Counterexample habit?**
   A: Always try to break greedy with a small case.

13. **Q: Stability of choice?**
   A: Document tie-breaking explicitly.

14. **Q: Interval partitioning (min rooms)?**
   A: Sweep / heap of end times.

15. **Q: Coin change greedy fails when?**
   A: Non-canonical coin systems need DP.

---

## 9. Solved Example 1

### Problem — Jump Game (LeetCode 55)
Each `nums[i]` is the **maximum** jump length from index `i`. Return `true` if the last index is reachable from index 0.

### Thought Process
1. A jump of length `nums[i]` permits any distance from 1 to `nums[i]`, so the reachable set never has gaps — it is a contiguous prefix.
2. A contiguous prefix is described by one number: `farthest`, the largest index reachable so far.
3. Sweep left to right updating `farthest = max(farthest, i + nums[i])`.
4. If we ever stand on an index greater than `farthest`, no sequence of jumps could have delivered us there → return `false`.
5. Once `farthest` reaches the last index we can stop early.

### Dry Run — reachable

Input: `nums = [2, 3, 1, 1, 4]`

| i | `i > farthest`? | `i + nums[i]` | `farthest` after | reached the end? |
|---|-----------------|----------------|-------------------|------------------|
| 0 | `0 > 0` no | `0 + 2 = 2` | **2** | `2 >= 4`? no |
| 1 | `1 > 2` no | `1 + 3 = 4` | **4** | `4 >= 4` **yes → true** |

Output: **`true`** ✓ — for example jump `0 → 1 → 4`.

### Dry Run — unreachable

Input: `nums = [3, 2, 1, 0, 4]`

| i | `i > farthest`? | `i + nums[i]` | `farthest` after |
|---|-----------------|----------------|-------------------|
| 0 | no | `0 + 3 = 3` | **3** |
| 1 | `1 > 3` no | `1 + 2 = 3` | 3 |
| 2 | `2 > 3` no | `2 + 1 = 3` | 3 |
| 3 | `3 > 3` no | `3 + 0 = 3` | 3 |
| 4 | `4 > 3` **yes** | — | **return `false`** |

Output: **`false`** ✓ — index 3 holds a `0`, and nothing can jump past it.

The `i > farthest` test is doing the real work: at `i = 4` the sweep discovers it is standing somewhere unreachable, which is exactly the failure condition.

### Visualization

```text
nums = [2, 3, 1, 1, 4]

index    :  0    1    2    3    4
after i=0: [─────────]                 farthest 2
after i=1: [────────────────────]      farthest 4  → end reached

nums = [3, 2, 1, 0, 4]

index    :  0    1    2    3    4
           [───────────────]           farthest stalls at 3
                             ↑
                        i = 4 > 3  →  stranded, false
```

### Code

```go
func canJump(nums []int) bool {
    farthest := 0 // the largest index reachable so far

    for i := 0; i < len(nums); i++ {
        // No sequence of jumps could have delivered us past `farthest`.
        if i > farthest {
            return false
        }

        // A jump of nums[i] permits ANY length up to nums[i], so the
        // reachable set stays contiguous and one number describes it.
        if i+nums[i] > farthest {
            farthest = i + nums[i]
        }

        if farthest >= len(nums)-1 {
            return true // early exit
        }
    }
    return true
}
```

```python
def canJump(nums):
    farthest = 0                        # largest index reachable so far

    for i, jump in enumerate(nums):
        if i > farthest:
            return False                # stranded: nothing reaches here
        farthest = max(farthest, i + jump)
        if farthest >= len(nums) - 1:
            return True                 # early exit
    return True
```

### Complexity
Time **O(n)** — a single sweep. Space **O(1)**.

---

## 10. Solved Example 2

### Problem — Jump Game II (LeetCode 45)
Return the **minimum** number of jumps to reach the last index. Reaching it is guaranteed.

### Thought Process
1. This is a shortest-path question, so it is a BFS — but each "level" (everything reachable in exactly `k` jumps) is a contiguous range, so no queue is needed.
2. Track two numbers: `currentEnd`, the last index reachable with the jumps already counted, and `farthest`, the last index reachable with one more.
3. Sweep `i` forward, always updating `farthest`.
4. When `i` reaches `currentEnd`, the current level is used up: take a jump and extend the level to `farthest`.
5. **Loop to `n−2`, not `n−1`** — arriving at the last index means we are done, and continuing would trigger one more level boundary and count a jump that never happens.

### Dry Run

Input: `nums = [2, 3, 1, 1, 4]` → loop `i = 0 .. 3`

| i | `i + nums[i]` | `farthest` | `i == currentEnd`? | action | jumps | currentEnd |
|---|----------------|------------|---------------------|--------|-------|------------|
| 0 | `0 + 2 = 2` | **2** | `0 == 0` **yes** | take a jump, extend | **1** | **2** |
| 1 | `1 + 3 = 4` | **4** | `1 == 2` no | — | 1 | 2 |
| 2 | `2 + 1 = 3` | 4 | `2 == 2` **yes** | take a jump, extend | **2** | **4** |
| 3 | `3 + 1 = 4` | 4 | `3 == 4` no | — | 2 | 4 |

Output: **2** ✓ — the route is `0 → 1 → 4`.

**Reading the levels:**

```text
level 0: index 0            (0 jumps)
level 1: indices 1..2       (1 jump)  — currentEnd becomes 2
level 2: indices 3..4       (2 jumps) — currentEnd becomes 4, which is the end
```

**The `n−2` bound, made concrete.** If the loop ran to `i = 4`, then at `i = 4 == currentEnd` it would increment `jumps` to 3 — counting a jump *out of* the destination we had already arrived at. Stopping at `n−2` is what prevents that.

### Visualization

```text
nums  =  2    3    1    1    4
index :  0    1    2    3    4

level 0: [0]
level 1:      [1    2]              1 jump  — reach 2
level 2:            [3    4]        2 jumps — reach 4  ★

  each level is a contiguous range, so two numbers replace a BFS queue
```

### Code

```go
func jump(nums []int) int {
    jumps := 0
    currentEnd := 0 // last index reachable with the jumps counted so far
    farthest := 0   // last index reachable with ONE more jump

    // n-1 as the bound (so i goes to n-2): arriving at the last index
    // means we are done. Running to n-1 would trigger one extra level
    // boundary and count a jump that is never taken.
    for i := 0; i < len(nums)-1; i++ {
        if i+nums[i] > farthest {
            farthest = i + nums[i]
        }

        if i == currentEnd { // this level is exhausted
            jumps++
            currentEnd = farthest // the next level reaches this far
        }
    }

    return jumps
}
```

```python
def jump(nums):
    jumps = current_end = farthest = 0

    # Stop at n-2: arriving at the last index is already done, and going
    # to n-1 would count one jump too many.
    for i in range(len(nums) - 1):
        farthest = max(farthest, i + nums[i])   # reach of ONE more jump
        if i == current_end:                    # level exhausted
            jumps += 1
            current_end = farthest

    return jumps
```

### Complexity
Time **O(n)** — one sweep. Space **O(1)** — two integers instead of a BFS queue.

---

## 11. Solved Example 3

### Problem — Jump Game III (LeetCode 1306)
From index `i` you may move to `i + arr[i]` or `i − arr[i]`. Starting at `start`, return `true` if you can reach **any** index whose value is `0`.

### Thought Process
1. The jump is now **exact**, not "up to" — two specific destinations rather than a range.
2. That breaks the collapse. The reachable set has gaps, so no single `farthest` number can describe it.
3. So this is a genuine graph traversal: nodes are indices, edges go to `i ± arr[i]`.
4. Use BFS (or DFS) with a `visited` array — without it, `i + arr[i]` and `i − arr[i]` can bounce back and forth forever.
5. Success is reaching any index holding `0`.

### Dry Run — reachable

Input: `arr = [4, 2, 3, 0, 3, 1, 2]`, `start = 5`

| step | dequeue | `arr[current]` | is it 0? | neighbours `current ± arr[current]` | enqueued |
|------|---------|----------------|----------|--------------------------------------|----------|
| 1 | 5 | 1 | no | `6`, `4` | 6, 4 |
| 2 | 6 | 2 | no | `8` (out of range), `4` (visited) | — |
| 3 | 4 | 3 | no | `7` (out of range), `1` | 1 |
| 4 | 1 | 2 | no | `3`, `−1` (out of range) | 3 |
| 5 | 3 | **0** | **yes** | — | → **`true`** |

Output: **`true`** ✓

### Dry Run — unreachable

Input: `arr = [3, 0, 2, 1, 2]`, `start = 2`

| step | dequeue | `arr[current]` | neighbours | enqueued |
|------|---------|----------------|------------|----------|
| 1 | 2 | 2 | `4`, `0` | 4, 0 |
| 2 | 4 | 2 | `6` (out), `2` (visited) | — |
| 3 | 0 | 3 | `3`, `−3` (out) | 3 |
| 4 | 3 | 1 | `4` (visited), `2` (visited) | — |
| 5 | queue empty | — | — | → **`false`** |

Output: **`false`** ✓

The only zero sits at index 1, and the reachable set is `{2, 4, 0, 3}` — index 1 is never among them. Note the reachable set here is `{0, 2, 3, 4}`, which has a **gap at 1** — precisely the situation that a single `farthest` number cannot represent, and why Examples 1 and 2's greedy does not transfer.

### Visualization

```text
arr = [3, 0, 2, 1, 2],  start = 2

        0 ←──── 2 ────→ 4
        │       ↑        │
        ↓       └────────┘
        3 ──────┘

reachable: {0, 2, 3, 4}        index 1 (the only zero) is unreachable

  the set has a GAP at 1 → not a contiguous range
  → a single `farthest` cannot describe it → BFS with visited
```

### Code

```go
func canReach(arr []int, start int) bool {
    // Exact jumps leave gaps in the reachable set, so we need a real
    // traversal rather than a single `farthest` value.
    visited := make([]bool, len(arr))

    queue := []int{start}
    visited[start] = true

    for len(queue) > 0 {
        current := queue[0]
        queue = queue[1:]

        if arr[current] == 0 {
            return true
        }

        // Exactly two destinations, not a range.
        for _, next := range []int{current + arr[current], current - arr[current]} {
            if next >= 0 && next < len(arr) && !visited[next] {
                visited[next] = true // without this, jumps bounce forever
                queue = append(queue, next)
            }
        }
    }

    return false
}
```

```python
from collections import deque

def canReach(arr, start):
    # Exact jumps leave gaps, so a single `farthest` cannot work.
    visited = [False] * len(arr)
    queue = deque([start])
    visited[start] = True

    while queue:
        current = queue.popleft()
        if arr[current] == 0:
            return True

        # Exactly two destinations, not a range.
        for nxt in (current + arr[current], current - arr[current]):
            if 0 <= nxt < len(arr) and not visited[nxt]:
                visited[nxt] = True     # without this, jumps bounce forever
                queue.append(nxt)

    return False
```

### Complexity
Time **O(n)** — each index is enqueued at most once. Space **O(n)** for `visited` and the queue.

> The three examples map the boundary of the greedy exactly. "Jump **up to** `nums[i]`" keeps the reachable set contiguous, so one number suffices and the sweep is O(1) space. "Jump **exactly** `±arr[i]`" punches holes in it, and the moment there are holes you owe the problem a real traversal.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 55 | Jump Game | Easy | Core greedy application |
| 45 | Jump Game II | Easy | Core greedy application |
| 1306 | Jump III | Medium | Core greedy application |
| 1326 | Min Taps | Medium | Core greedy application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Activity selection / scheduling**
- **Jump game reachability**
- **Gas station circuit**
- **Huffman / merge-cost**

---

## 14. Production Engineering Applications

- **Scalability:** Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Jump Game logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Jump Game (Greedy).
- **Signal:** jump game, greedy, reachable, farthest, min jumps.
- **Move:** When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).
- **Cost:** O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Jump Game invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Jump Game
FAMILY : Greedy (Intermediate)
WHEN   : jump game, greedy, reachable, farthest, min jumps
DO     : When a greedy choice provably never hurts, a single sorted pass yields the optim
TIME   : O(n log n)    SPACE: O(1)
PRACTICE: 55, 45, 1306, 1326
```

---

*Part of the DSA Patterns Handbook — pattern 86 of 100.*
