# 37 · Previous Greater Element

> **One-liner:** Stack scan to find each element's previous greater neighbor / span.

---

## 1. Overview

### Definition
The **Previous Greater Element** pattern belongs to the *Stacks* family. Stack scan to find each element's previous greater neighbor / span.

### Intuition
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Why it works
Maintain a monotonic stack so each element is pushed and popped at most once — O(n). Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.

---

## 2. Recognition Signals

### Keywords
previous greater, monotonic stack, to the left, span.

### Constraints
- Input size where the brute-force complexity would time out — the Previous Greater Element optimization is the intended solution.
- Structural hints in the statement that match this family (Stacks).

### Hidden clues
- The problem can be reframed so the Previous Greater Element invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Previous Greater Element is the upgrade.
- The wording maps onto: previous greater, monotonic stack, to the left, span.

---

## 3. Brute Force Approach

### Intuition
For each element scan outward to find the next/previous greater or smaller — O(n^2).

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Previous Greater Element pattern is built to use.

---

## 4. Optimal Approach

### Core idea
A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Previous Greater Element invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar-37" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Previous greater: pop tops ≤ current, remaining top is the answer</text>
  <text x="130" y="52" text-anchor="middle" fill="#64748b">nums (scan →)</text>
  <rect x="30"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="88" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="78"  y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="100" y="88" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="126" y="60" width="44" height="44" rx="6" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="148" y="88" text-anchor="middle" fill="#1e293b" font-weight="700">3</text>
  <rect x="174" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="88" text-anchor="middle" fill="#1e293b">7</text>
  <rect x="222" y="60" width="44" height="44" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="244" y="88" text-anchor="middle" fill="#1e293b">1</text>
  <text x="148" y="122" text-anchor="middle" fill="#059669" font-weight="700">current 3</text>
  <text x="490" y="52" text-anchor="middle" fill="#64748b">stack (bottom → top)</text>
  <rect x="452" y="112" width="76" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="490" y="134" text-anchor="middle" fill="#1e293b">5  answer</text>
  <rect x="452" y="74"  width="76" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="490" y="96"  text-anchor="middle" fill="#1e293b">2  pop</text>
  <line x1="174" y1="82" x2="448" y2="128" stroke="#475569" marker-end="url(#ar-37)"/>
  <text x="330" y="150" text-anchor="middle" fill="#d97706">pop 2 (≤ 3); top 5 &gt; 3 → prev greater = 5</text>
  <text x="130" y="186" text-anchor="middle" fill="#64748b">result (previous greater)</text>
  <rect x="30"  y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="52"  y="222" text-anchor="middle" fill="#64748b">-1</text>
  <rect x="78"  y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="100" y="222" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="126" y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="148" y="222" text-anchor="middle" fill="#1e293b">5</text>
  <rect x="174" y="196" width="44" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="196" y="222" text-anchor="middle" fill="#64748b">-1</text>
  <rect x="222" y="196" width="44" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="244" y="222" text-anchor="middle" fill="#1e293b">7</text>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Previous Greater E: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Previous Greater Element problem. I'll a stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element. That brings the complexity down to O(n) time and O(n) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Stacks** family template. Adapt the comparison/condition to the specific problem.

```go
// Next greater element to the right using a monotonic decreasing stack.
func nextGreater(nums []int) []int {
    res := make([]int, len(nums))
    for i := range res { res[i] = -1 }
    stack := []int{} // indices, values decreasing from bottom to top
    for i, v := range nums {
        for len(stack) > 0 && nums[stack[len(stack)-1]] < v {
            top := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            res[top] = v
        }
        stack = append(stack, i)
    }
    return res
}
```

```python
def next_greater(nums):
    res = [-1] * len(nums)
    stack = []                      # indices, values decreasing
    for i, v in enumerate(nums):
        while stack and nums[stack[-1]] < v:
            res[stack.pop()] = v
        stack.append(i)
    return res
```

```java
int[] nextGreater(int[] nums) {
    int[] res = new int[nums.length];
    Arrays.fill(res, -1);
    Deque<Integer> stack = new ArrayDeque<>();
    for (int i = 0; i < nums.length; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i])
            res[stack.pop()] = nums[i];
        stack.push(i);
    }
    return res;
}
```

```cpp
vector<int> nextGreater(vector<int>& nums) {
    vector<int> res(nums.size(), -1);
    stack<int> st;                  // indices
    for (int i = 0; i < (int)nums.size(); ++i) {
        while (!st.empty() && nums[st.top()] < nums[i]) {
            res[st.top()] = nums[i]; st.pop();
        }
        st.push(i);
    }
    return res;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Previous Greater Element (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(n)** |

> Each index pushed/popped once; stack holds unresolved indices.

---

## 7. Common Mistakes

1. Storing values instead of indices when you need positions/distances.
2. Wrong monotonic direction (increasing vs decreasing) for the query.
3. Using `<` vs `<=` incorrectly with duplicates.
4. Forgetting to handle elements left on the stack at the end.
5. Not iterating in reverse when the problem is naturally right-to-left.
6. Circular array: forgetting to loop twice with modulo indexing.
7. Histogram: missing the sentinel zero-height bar to flush the stack.
8. Popping in the wrong order, corrupting results.
9. Mixing up 'greater' and 'smaller' semantics.
10. O(n^2) blowup by rescanning instead of trusting the stack invariant.

---

## 8. Interview Follow-Up Questions

1. **Q: Increasing vs decreasing stack — which?**
   A: Decreasing stack finds next greater; increasing finds next smaller.

2. **Q: Why amortized O(n)?**
   A: Each index is pushed once and popped at most once.

3. **Q: Previous greater element?**
   A: Same stack, but resolve as you push / scan the other direction.

4. **Q: Circular next greater?**
   A: Iterate 2n with modulo, don't push twice.

5. **Q: Largest rectangle in histogram?**
   A: Monotonic increasing stack of bar indices.

6. **Q: Daily temperatures?**
   A: Stack of unresolved days; pop when a warmer day arrives.

7. **Q: Stock span?**
   A: Previous greater index gives the span length.

8. **Q: Trapping rain water?**
   A: Stack or two-pointer; stack resolves bounded basins.

9. **Q: Handle ties?**
   A: Decide `<` vs `<=` based on whether equal counts as greater.

10. **Q: Space complexity?**
   A: O(n) worst case (monotonic input).

11. **Q: Maximal rectangle in matrix?**
   A: Histogram per row + stack.

12. **Q: Sum of subarray minimums?**
   A: Monotonic stack to count contribution of each element.

13. **Q: Why store indices?**
   A: To compute distances/widths between boundaries.

14. **Q: Sentinel trick?**
   A: Append a 0 (or +/-inf) to force final pops.

15. **Q: Relation to monotonic queue?**
   A: Queue variant supports sliding-window min/max.

---

## 9. Solved Example 1

### Problem — Stock Span (LeetCode 901)
A representative **Previous Greater Element** problem. The signal: stack scan to find each element's previous greater neighbor / span.

### Thought Process
1. The span for today's price is 1 + the number of consecutive earlier days whose price was less than or equal to today's — i.e. the distance back to the previous strictly greater price.
2. Keep a monotonic decreasing stack of `(price, span)` pairs. When a new price arrives, pop every pair whose price is `<= price`, accumulating their spans into the current span.
3. Push `(price, span)` for today; return that span. The popped days are now permanently subsumed, so each day is pushed and popped at most once.

### Dry Run
Prices 100, 80, 60, 70, 60, 75, 85:
- 100 → stack empty, span 1. push (100,1). stack=[(100,1)]
- 80 → 100>80, span 1. push (80,1). stack=[(100,1),(80,1)]
- 60 → 80>60, span 1. stack=[...,(80,1),(60,1)]
- 70 → pop (60,1) span=1+1=2; 80>70 stop. push (70,2). stack=[(100,1),(80,1),(70,2)]
- 75 → pop (70,2) span=1+2=3; 80>75 stop. push (75,3) → span 3
- 85 → pop (75,3) span=1+3=4, pop (80,1) span=5; 100>85 stop → span 5

### Visualization
```
input  ──▶ [ apply Previous Greater Element step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
class StockSpanner:
    def __init__(self):
        self.stack = []             # (price, span), prices strictly decreasing

    def next(self, price: int) -> int:
        span = 1
        while self.stack and self.stack[-1][0] <= price:
            span += self.stack.pop()[1]
        self.stack.append((price, span))
        return span
```

### Complexity
Time amortized O(1) per `next` call (O(n) total over n calls), Space O(n) for the stack.

## 10. Solved Example 2

### Problem — Daily Temps (LeetCode 739)
A representative **Previous Greater Element** problem. The signal: stack scan to find each element's previous greater neighbor / span.

### Thought Process
1. For each day we want how many days until a warmer temperature — that is the distance to the next strictly greater element on the right.
2. Scan left to right keeping a stack of indices whose warmer day is still unknown, with temperatures in non-increasing order.
3. When today is warmer than the temperature at the top index, pop it and record `today_index - popped_index` as its answer; repeat, then push today. Indices never resolved keep their default 0.

### Dry Run
temps = [73, 74, 75, 71, 69, 76]:
- i0 73 → stack=[0]
- i1 74>73 → pop 0, res[0]=1; push → stack=[1]
- i2 75>74 → pop 1, res[1]=1; push → stack=[2]
- i3 71 → stack=[2,3]
- i4 69 → stack=[2,3,4]
- i5 76 → pop 4 res[4]=1, pop 3 res[3]=2, pop 2 res[2]=3; push → res=[1,1,3,2,1,0]

### Visualization
```
input  ──▶ [ apply Previous Greater Element step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def dailyTemperatures(temperatures):
    res = [0] * len(temperatures)
    stack = []                      # indices, temps non-increasing
    for i, t in enumerate(temperatures):
        while stack and temperatures[stack[-1]] < t:
            j = stack.pop()
            res[j] = i - j
        stack.append(i)
    return res
```

### Complexity
Time O(n), Space O(n). Each index is pushed and popped at most once; stack holds days awaiting a warmer temperature.

## 11. Solved Example 3

### Problem — Largest Rectangle (LeetCode 84)
A representative **Previous Greater Element** problem. The signal: stack scan to find each element's previous greater neighbor / span.

### Thought Process
1. Each bar is the shortest bar of some maximal rectangle; that rectangle extends left to the previous smaller bar and right to the next smaller bar.
2. Keep an increasing stack of indices. When the current bar is shorter than the top, the top's rectangle ends here: pop it, its height is `heights[popped]`, and its width spans from the new top (previous smaller) up to the current index.
3. Append a sentinel height 0 so every remaining bar is flushed and measured at the end.

### Dry Run
heights = [2, 1, 5, 6, 2, 3] (plus sentinel 0):
- i0 h2 → stack=[0]
- i1 h1<2 → pop 0: area 2*(1-(-1)-1)=2; stack=[1]
- i2 h5,i3 h6 → stack=[1,2,3]
- i4 h2<6 → pop 3: 6*(4-2-1)=6; pop 2: 5*(4-1-1)=10 (best); stack=[1,4]
- i5 h3 → stack=[1,4,5]
- sentinel 0 → pop 5:3*1=3, pop 4:2*(6-1-1)=8, pop 1:1*6=6 → max area = 10

### Visualization
```
input  ──▶ [ apply Previous Greater Element step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def largestRectangleArea(heights):
    stack = []                      # indices, heights strictly increasing
    best = 0
    for i, h in enumerate(heights + [0]):
        while stack and heights[stack[-1]] >= h:
            height = heights[stack.pop()]
            left = stack[-1] if stack else -1
            best = max(best, height * (i - left - 1))
        stack.append(i)
    return best
```

### Complexity
Time O(n), Space O(n). Each index is pushed and popped at most once; the stack holds bars whose right boundary is not yet known.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 901 | Stock Span | Easy | Core stacks application |
| 739 | Daily Temps | Easy | Core stacks application |
| 84 | Largest Rectangle | Medium | Core stacks application |
| 496 | Next Greater | Medium | Core stacks application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Monotonic increasing stack**
- **Monotonic decreasing stack**
- **Next/previous greater**
- **Histogram largest rectangle**
- **Stock span / daily temperatures**

---

## 14. Production Engineering Applications

- **Scalability:** Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(n)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Previous Greater Element logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Previous Greater Element (Stacks).
- **Signal:** previous greater, monotonic stack, to the left, span.
- **Move:** A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.
- **Cost:** O(n) time, O(n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Previous Greater Element invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Previous Greater Element
FAMILY : Stacks (Intermediate)
WHEN   : previous greater, monotonic stack, to the left, span
DO     : A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relat
TIME   : O(n)    SPACE: O(n)
PRACTICE: 901, 739, 84, 496
```

---

*Part of the DSA Patterns Handbook — pattern 37 of 100.*
