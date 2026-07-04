# 41 · Sliding Window Maximum

> **One-liner:** Deque of candidate indices gives window maxima in O(n).

---

## 1. Overview

### Definition
The **Sliding Window Maximum** pattern belongs to the *Queues* family. Deque of candidate indices gives window maxima in O(n).

### Intuition
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Why it works
Use a deque (monotonic queue) or FIFO queue to maintain window extrema / level order in O(1) amortized per element. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.

---

## 2. Recognition Signals

### Keywords
sliding window maximum, deque, monotonic, window, max.

### Constraints
- Input size where the brute-force complexity would time out — the Sliding Window Maximum optimization is the intended solution.
- Structural hints in the statement that match this family (Queues).

### Hidden clues
- The problem can be reframed so the Sliding Window Maximum invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Sliding Window Maximum is the upgrade.
- The wording maps onto: sliding window maximum, deque, monotonic, window, max.

---

## 3. Brute Force Approach

### Intuition
Recompute the window extremum or re-traverse levels each step — O(nk) / O(n^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Sliding Window Maximum pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Sliding Window Maximum invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-41" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Sliding window max (k=3): deque of indices, front = window max</text>
  <text x="60" y="52" text-anchor="middle" fill="#64748b">nums</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#64748b">1</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#64748b">3</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="148" y="88" text-anchor="middle" fill="#1e293b">-1</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="196" y="88" text-anchor="middle" fill="#1e293b">-3</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="244" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">5</text>
  <rect x="270" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="292" y="88" text-anchor="middle" fill="#64748b">3</text>
  <rect x="318" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="340" y="88" text-anchor="middle" fill="#64748b">6</text>
  <rect x="366" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="388" y="88" text-anchor="middle" fill="#64748b">7</text>
  <rect x="122" y="56" width="148" height="52" rx="8" fill="none" stroke="#059669" stroke-width="2"/>
  <text x="196" y="126" text-anchor="middle" fill="#64748b">window idx 2..4</text>
  <line x1="274" y1="82" x2="330" y2="82" stroke="#475569" marker-end="url(#ar-41)"/>
  <text x="302" y="76" text-anchor="middle" fill="#64748b">slide →</text>
  <text x="90" y="164" text-anchor="middle" fill="#64748b">deque of indices (values decreasing)</text>
  <rect x="30"  y="176" width="80" height="42" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="70"  y="202" text-anchor="middle" fill="#1e293b">i2 (-1) pop</text>
  <rect x="120" y="176" width="80" height="42" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="160" y="202" text-anchor="middle" fill="#1e293b">i3 (-3) pop</text>
  <rect x="230" y="176" width="90" height="42" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="275" y="202" text-anchor="middle" fill="#1e293b" font-weight="700">i4 (5) front</text>
  <line x1="216" y1="197" x2="228" y2="197" stroke="#475569" marker-end="url(#ar-41)"/>
  <text x="470" y="192" text-anchor="middle" fill="#059669" font-weight="700">5 pops smaller tails;</text>
  <text x="470" y="210" text-anchor="middle" fill="#059669" font-weight="700">answer = nums[front] = 5</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Sliding Window Max: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Sliding Window Maximum problem. I'll a double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier. That brings the complexity down to O(n) time and O(k) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Queues** family template. Adapt the comparison/condition to the specific problem.

```go
// Sliding window maximum with a monotonic decreasing deque of indices.
func maxSlidingWindow(nums []int, k int) []int {
    dq := []int{}      // indices, values decreasing
    res := []int{}
    for i, v := range nums {
        for len(dq) > 0 && nums[dq[len(dq)-1]] < v { dq = dq[:len(dq)-1] }
        dq = append(dq, i)
        if dq[0] <= i-k { dq = dq[1:] }          // evict out-of-window
        if i >= k-1 { res = append(res, nums[dq[0]]) }
    }
    return res
}
```

```python
from collections import deque
def max_sliding_window(nums, k):
    dq, res = deque(), []          # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] < v:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:
            dq.popleft()
        if i >= k - 1:
            res.append(nums[dq[0]])
    return res
```

```java
int[] maxSlidingWindow(int[] nums, int k) {
    Deque<Integer> dq = new ArrayDeque<>();
    int[] res = new int[nums.length - k + 1];
    for (int i = 0; i < nums.length; i++) {
        while (!dq.isEmpty() && nums[dq.peekLast()] < nums[i]) dq.pollLast();
        dq.offerLast(i);
        if (dq.peekFirst() <= i - k) dq.pollFirst();
        if (i >= k - 1) res[i - k + 1] = nums[dq.peekFirst()];
    }
    return res;
}
```

```cpp
vector<int> maxSlidingWindow(vector<int>& nums, int k) {
    deque<int> dq; vector<int> res;
    for (int i = 0; i < (int)nums.size(); ++i) {
        while (!dq.empty() && nums[dq.back()] < nums[i]) dq.pop_back();
        dq.push_back(i);
        if (dq.front() <= i - k) dq.pop_front();
        if (i >= k - 1) res.push_back(nums[dq.front()]);
    }
    return res;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Sliding Window Maximum (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(k)** |

> Each element enters/leaves the deque once; BFS visits each node/edge once.

---

## 7. Common Mistakes

1. Storing values instead of indices, so you can't evict by position.
2. Forgetting to evict indices that fell out of the window.
3. Wrong deque monotonicity for min vs max.
4. Emitting results before the first full window forms.
5. BFS: not marking nodes visited when enqueuing (causes revisits/TLE).
6. BFS: marking visited at dequeue time, allowing duplicates in the queue.
7. Mixing level boundaries in level-order BFS.
8. Using a list as a queue with O(n) pops from the front.
9. Off-by-one in window eviction condition.
10. Not handling k larger than the array length.

---

## 8. Interview Follow-Up Questions

1. **Q: Why a deque for window max?**
   A: It keeps a decreasing sequence of candidates; the front is always the max.

2. **Q: Amortized cost?**
   A: Each index is pushed and popped at most once → O(n).

3. **Q: Window minimum?**
   A: Same idea with an increasing deque.

4. **Q: BFS vs DFS for shortest path?**
   A: BFS gives shortest path in unweighted graphs.

5. **Q: Multi-source BFS?**
   A: Seed the queue with all sources at distance 0.

6. **Q: 0-1 BFS?**
   A: Use a deque: push front for 0-weight, back for 1-weight edges.

7. **Q: Level-order traversal?**
   A: Process the queue in size-batches per level.

8. **Q: Why mark visited at enqueue?**
   A: Prevents the same node being queued multiple times.

9. **Q: Shortest subarray with sum >= K (negatives)?**
   A: Monotonic deque on prefix sums.

10. **Q: Space complexity?**
   A: O(k) for the window / O(V) for BFS frontier.

11. **Q: Deque vs heap for window max?**
   A: Deque is O(n); heap is O(n log k).

12. **Q: Rotting oranges / spread problems?**
   A: Multi-source BFS by time layers.

13. **Q: Word ladder?**
   A: BFS over word-transformation graph.

14. **Q: Bidirectional BFS?**
   A: Search from both ends to cut the frontier.

15. **Q: Queue overflow in huge graphs?**
   A: Stream/iterative deepening or external memory.

---

## 9. Solved Example 1

### Problem — Sliding Window Max (LeetCode 239)
A representative **Sliding Window Maximum** problem. The signal: deque of candidate indices gives window maxima in o(n).

### Thought Process
1. Keep a deque of indices whose values are in strictly decreasing order — the front is always the max of the current window.
2. Before pushing index `i`, pop indices from the back whose value is `<= nums[i]`; they can never be the max while `i` is in the window.
3. Pop the front when it falls out of the window (`dq[0] <= i - k`), and once `i >= k-1` record `nums[dq[0]]` as that window's maximum.

### Dry Run
`nums=[1,3,-1,-3,5], k=3`
- i=0 v=1 → dq=[0]
- i=1 v=3 pops 0 → dq=[1]
- i=2 v=-1 → dq=[1,2]; window full → max=nums[1]=3
- i=3 v=-3 → dq=[1,2,3]; front 1 <= 3-3=0? no → max=nums[1]=3
- i=4 v=5 pops 3,2,1 → dq=[4]; max=nums[4]=5 → result `[3,3,5]`.

### Visualization
```
input  ──▶ [ apply Sliding Window Maximum step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque

def maxSlidingWindow(nums, k):
    dq, res = deque(), []          # dq holds indices, values decreasing
    for i, v in enumerate(nums):
        while dq and nums[dq[-1]] <= v:
            dq.pop()
        dq.append(i)
        if dq[0] <= i - k:         # front slid out of the window
            dq.popleft()
        if i >= k - 1:             # window fully formed
            res.append(nums[dq[0]])
    return res
```

### Complexity
Time O(n), Space O(k). Each index is pushed and popped from the deque at most once.

## 10. Solved Example 2

### Problem — Jump VI (LeetCode 1696)
A representative **Sliding Window Maximum** problem. The signal: deque of candidate indices gives window maxima in o(n).

### Thought Process
1. Let `dp[i]` be the max score to reach index `i`; then `dp[i] = nums[i] + max(dp[i-k .. i-1])`, since you can jump here from up to `k` steps back.
2. The `max(dp[i-k .. i-1])` is a sliding-window maximum over the `dp` array — maintain a deque of indices with decreasing `dp` values.
3. For each `i`, drop front indices older than `i-k`, read `dp[dq[0]]` as the best predecessor, compute `dp[i]`, then push `i` after popping smaller `dp` from the back. Answer is `dp[n-1]`.

### Dry Run
`nums=[1,-1,-2,4,-7,3], k=2`
- dp[0]=1, dq=[0]
- i=1: best=dp[0]=1 → dp[1]=1+(-1)=0; dq=[0,1]
- i=2: front 0 in window; best=dp[0]=1 → dp[2]=1+(-2)=-1; dq=[0,1,2]
- i=3: drop front 0 (0 < 3-2=1) → dq=[1,2]; best=dp[1]=0 → dp[3]=4; pops 2,1 → dq=[3]
- i=4: best=dp[3]=4 → dp[4]=-7+4=-3; dq=[3,4]
- i=5: best=dp[3]=4 → dp[5]=3+4=7 → answer **7**.

### Visualization
```
input  ──▶ [ apply Sliding Window Maximum step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque

def maxResult(nums, k):
    n = len(nums)
    dp = [0] * n
    dp[0] = nums[0]
    dq = deque([0])                    # indices with decreasing dp values
    for i in range(1, n):
        while dq[0] < i - k:           # front outside [i-k, i-1]
            dq.popleft()
        dp[i] = nums[i] + dp[dq[0]]    # best reachable predecessor
        while dq and dp[dq[-1]] <= dp[i]:
            dq.pop()
        dq.append(i)
    return dp[-1]
```

### Complexity
Time O(n), Space O(n) for the dp array (deque holds at most k+1 indices).

## 11. Solved Example 3

### Problem — Constrained Subseq (LeetCode 1425)
A representative **Sliding Window Maximum** problem. The signal: deque of candidate indices gives window maxima in o(n).

### Thought Process
1. Let `dp[i]` be the best subsequence sum ending at `i`; then `dp[i] = nums[i] + max(0, max(dp[i-k .. i-1]))` — extend the best window predecessor, or start fresh if it is negative.
2. Maintain a deque of indices with decreasing `dp` values to read `max(dp[i-k .. i-1])` in O(1), evicting the front once it leaves the window.
3. Unlike Jump VI, the subsequence can end anywhere, so track a running answer as the maximum `dp[i]` over all `i`.

### Dry Run
`nums=[10,2,-10,5,20], k=2`
- i=0: best=0 → dp[0]=10, ans=10, dq=[0]
- i=1: max(0,dp[0])=10 → dp[1]=12; pop 0 (10<=12) → dq=[1]; ans=12
- i=2: front 1 in window, max(0,dp[1])=12 → dp[2]=2; dq=[1,2]; ans=12
- i=3: front 1 stays (1 < 3-2=1 is false); max(0,dp[1])=12 → dp[3]=17; pops 2,1 → dq=[3]; ans=17
- i=4: max(0,dp[3])=17 → dp[4]=37; ans=**37**.

### Visualization
```
input  ──▶ [ apply Sliding Window Maximum step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
from collections import deque

def constrainedSubsetSum(nums, k):
    n = len(nums)
    dp = [0] * n
    dq = deque()                       # indices with decreasing dp values
    ans = float('-inf')
    for i in range(n):
        while dq and dq[0] < i - k:    # front outside window [i-k, i-1]
            dq.popleft()
        best = dp[dq[0]] if dq else 0
        dp[i] = nums[i] + max(0, best)
        ans = max(ans, dp[i])
        while dq and dp[dq[-1]] <= dp[i]:
            dq.pop()
        dq.append(i)
    return ans
```

### Complexity
Time O(n), Space O(n) for the dp array (deque holds at most k+1 indices).


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 239 | Sliding Window Max | Easy | Core queues application |
| 1696 | Jump VI | Easy | Core queues application |
| 1425 | Constrained Subseq | Medium | Core queues application |
| 862 | Shortest Subarray | Medium | Core queues application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Monotonic deque (window max/min)**
- **FIFO BFS**
- **Multi-source BFS**
- **0-1 BFS**
- **Level-order traversal**

---

## 14. Production Engineering Applications

- **Scalability:** Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(k)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Sliding Window Maximum logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Sliding Window Maximum (Queues).
- **Signal:** sliding window maximum, deque, monotonic, window, max.
- **Move:** A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.
- **Cost:** O(n) time, O(k) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Sliding Window Maximum invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Sliding Window Maximum
FAMILY : Queues (Advanced)
WHEN   : sliding window maximum, deque, monotonic, window, max
DO     : A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand fro
TIME   : O(n)    SPACE: O(k)
PRACTICE: 239, 1696, 1425, 862
```

---

*Part of the DSA Patterns Handbook — pattern 41 of 100.*
