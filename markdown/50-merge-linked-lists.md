# 50 · Merge Linked Lists

> **One-liner:** Splice two sorted lists with a dummy head and pointer chasing.

---

## 1. Overview

### Definition
The **Merge Linked Lists** pattern belongs to the *Linked Lists* family. Splice two sorted lists with a dummy head and pointer chasing.

### Intuition
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Why it works
Rewire pointers in place with a few pointers (prev/curr/next) and a dummy head — O(1) space. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).

---

## 2. Recognition Signals

### Keywords
merge, sorted lists, linked list, dummy, two pointer.

### Constraints
- Input size where the brute-force complexity would time out — the Merge Linked Lists optimization is the intended solution.
- Structural hints in the statement that match this family (Linked Lists).

### Hidden clues
- The problem can be reframed so the Merge Linked Lists invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Merge Linked Lists is the upgrade.
- The wording maps onto: merge, sorted lists, linked list, dummy, two pointer.

---

## 3. Brute Force Approach

### Intuition
Copy to an array, manipulate, rebuild — O(n) extra space.

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the Merge Linked Lists pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Merge Linked Lists invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="mrg50" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Merge: splice the smaller head each step into one sorted chain</text>
  <!-- list A -->
  <text x="40" y="65" fill="#2563eb" font-weight="700">A</text>
  <rect x="70" y="45" width="44" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="92" y="67" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="160" y="45" width="44" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="182" y="67" text-anchor="middle" fill="#1e293b">4</text>
  <line x1="114" y1="62" x2="158" y2="62" stroke="#475569" marker-end="url(#mrg50)"/>
  <!-- list B -->
  <text x="40" y="145" fill="#059669" font-weight="700">B</text>
  <rect x="70" y="125" width="44" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="92" y="147" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="160" y="125" width="44" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="182" y="147" text-anchor="middle" fill="#1e293b">3</text>
  <line x1="114" y1="142" x2="158" y2="142" stroke="#475569" marker-end="url(#mrg50)"/>
  <!-- merged -->
  <text x="30" y="212" fill="#64748b" font-weight="700">merged</text>
  <rect x="110" y="192" width="40" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="130" y="212" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="200" y="192" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="220" y="212" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="290" y="192" width="40" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="310" y="212" text-anchor="middle" fill="#1e293b">3</text>
  <rect x="380" y="192" width="40" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="400" y="212" text-anchor="middle" fill="#1e293b">4</text>
  <line x1="150" y1="207" x2="198" y2="207" stroke="#475569" marker-end="url(#mrg50)"/>
  <line x1="240" y1="207" x2="288" y2="207" stroke="#475569" marker-end="url(#mrg50)"/>
  <line x1="330" y1="207" x2="378" y2="207" stroke="#475569" marker-end="url(#mrg50)"/>
  <line x1="92" y1="79" x2="126" y2="190" stroke="#64748b" stroke-dasharray="3,3" marker-end="url(#mrg50)"/>
  <line x1="92" y1="159" x2="216" y2="190" stroke="#64748b" stroke-dasharray="3,3" marker-end="url(#mrg50)"/>
</svg>
```

```
brute  : recompute everything each step      ──▶ slow
Merge Linked Lists: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Merge Linked Lists problem. I'll most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure. That brings the complexity down to O(n) time and O(1) space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **Linked Lists** family template. Adapt the comparison/condition to the specific problem.

```go
// Reverse a singly linked list in place.
type ListNode struct { Val int; Next *ListNode }
func reverseList(head *ListNode) *ListNode {
    var prev *ListNode
    for head != nil {
        next := head.Next   // save
        head.Next = prev    // reverse pointer
        prev = head         // advance prev
        head = next         // advance head
    }
    return prev
}
```

```python
class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt

def reverse_list(head):
    prev = None
    while head:
        nxt = head.next      # save next
        head.next = prev     # reverse pointer
        prev = head          # advance
        head = nxt
    return prev
```

```java
class ListNode { int val; ListNode next; ListNode(int v){val=v;} }
ListNode reverseList(ListNode head) {
    ListNode prev = null;
    while (head != null) {
        ListNode next = head.next;
        head.next = prev;
        prev = head;
        head = next;
    }
    return prev;
}
```

```cpp
struct ListNode { int val; ListNode* next; ListNode(int v):val(v),next(nullptr){} };
ListNode* reverseList(ListNode* head) {
    ListNode* prev = nullptr;
    while (head) {
        ListNode* next = head->next;
        head->next = prev;
        prev = head;
        head = next;
    }
    return prev;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Merge Linked Lists (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n)** |
| Time (best)  | — | **O(n)** |
| Time (average) | — | **O(n)** |
| Space | varies | **O(1)** |

> In-place pointer manipulation, single traversal.

---

## 7. Common Mistakes

1. Losing the `next` pointer before rewiring (save it first).
2. Not using a dummy head, then special-casing head insert/delete.
3. Null-pointer dereference at the list's end.
4. Creating cycles by mis-wiring `next`.
5. Fast/slow: advancing fast without checking `fast.next` for null.
6. Off-by-one finding the middle (even vs odd length).
7. Forgetting to disconnect the tail when splitting lists.
8. Returning the old head instead of the new one after reversal.
9. Memory leaks in C++ when removing nodes (delete them).
10. Reversing in k-groups but not stitching segments correctly.

---

## 8. Interview Follow-Up Questions

1. **Q: Why a dummy node?**
   A: It gives a stable handle so head insert/delete needs no special case.

2. **Q: Find the middle?**
   A: Fast/slow pointers; fast moves 2x.

3. **Q: Detect a cycle?**
   A: Floyd's tortoise & hare; meeting implies a cycle.

4. **Q: Find cycle start?**
   A: Reset one pointer to head after meeting; advance both by 1.

5. **Q: Reverse in k-groups?**
   A: Reverse each block, connect previous tail to new head.

6. **Q: Merge two sorted lists?**
   A: Dummy head + splice smaller node each step.

7. **Q: Remove nth from end?**
   A: Two pointers n apart, then delete.

8. **Q: Palindrome list?**
   A: Find middle, reverse second half, compare.

9. **Q: Why O(1) space?**
   A: Only a few pointers beyond the list.

10. **Q: Recursion vs iteration?**
   A: Recursion is clean but O(n) stack; iteration is O(1).

11. **Q: Copy list with random pointer?**
   A: Interleave clones or use a hash map.

12. **Q: Reorder list?**
   A: Split, reverse second half, merge alternately.

13. **Q: Sort a linked list?**
   A: Merge sort fits lists naturally (O(n log n), O(1) extra with bottom-up).

14. **Q: Intersection of two lists?**
   A: Two pointers switching heads equalize lengths.

15. **Q: Doubly linked tricks?**
   A: Prev pointers simplify deletion and LRU caches.

---

## 9. Solved Example 1

### Problem — Merge Two Lists (LeetCode 21)
A representative **Merge Linked Lists** problem. The signal: splice two sorted lists with a dummy head and pointer chasing.

### Thought Process
1. Use a dummy head and a `tail` pointer so appending never needs a special first-node case.
2. Compare the fronts of both lists; splice the smaller node onto `tail` and advance that list.
3. When one list empties, attach the remaining list wholesale.

### Dry Run
Input `1→2→4` and `1→3→4`.
- 1(a) ≤ 1(b): tail→1a; then 3 vs 1b: tail→1b; 2 vs 3: tail→2; 4 vs 3: tail→3; 4 vs 4: tail→4a
- b still has 4 → attach → `1→1→2→3→4→4`

### Visualization
```
input  ──▶ [ apply Merge Linked Lists step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def mergeTwoLists(l1, l2):
    dummy = tail = ListNode()
    while l1 and l2:
        if l1.val <= l2.val:
            tail.next, l1 = l1, l1.next
        else:
            tail.next, l2 = l2, l2.next
        tail = tail.next
    tail.next = l1 or l2          # attach the leftover
    return dummy.next
```

### Complexity
Time O(n + m), Space O(1). One pass over both lists, pointers only.

## 10. Solved Example 2

### Problem — Merge K Lists (LeetCode 23)
A representative **Merge Linked Lists** problem. The signal: splice two sorted lists with a dummy head and pointer chasing.

### Thought Process
1. The smallest unused node is always at the head of one of the k lists — a min-heap gives it in O(log k).
2. Seed the heap with the head of every non-empty list, keyed by value (tie-break on list index so nodes never compare).
3. Pop the min, append it to the result, and push its successor; repeat until the heap drains.

### Dry Run
Input `[1→4, 1→3, 2→6]`.
- heap fronts {1a,1b,2}; pop 1a, push 4 → out `1`
- fronts {1b,2,4}; pop 1b, push 3 → `1→1`
- pop 2, push 6 → `1→1→2`; then 3, 4, 6 → `1→1→2→3→4→6`

### Visualization
```
input  ──▶ [ apply Merge Linked Lists step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
import heapq

def mergeKLists(lists):
    heap = [(node.val, i, node) for i, node in enumerate(lists) if node]
    heapq.heapify(heap)
    dummy = tail = ListNode()
    while heap:
        val, i, node = heapq.heappop(heap)
        tail.next = node
        tail = node
        if node.next:
            heapq.heappush(heap, (node.next.val, i, node.next))
    return dummy.next
```

### Complexity
Time O(N log k) for N total nodes across k lists, Space O(k) for the heap.

## 11. Solved Example 3

### Problem — Sort List (LeetCode 148)
A representative **Merge Linked Lists** problem. The signal: splice two sorted lists with a dummy head and pointer chasing.

### Thought Process
1. Merge sort fits linked lists perfectly: splitting and merging are pointer operations, no random access needed.
2. Split the list in half with slow/fast pointers, cutting the link at the midpoint.
3. Recursively sort each half, then merge the two sorted halves with the two-pointer splice.

### Dry Run
Input `4→2→1→3`.
- split → `4→2` and `1→3`
- sort halves → `2→4` and `1→3`
- merge → `1→2→3→4`

### Visualization
```
input  ──▶ [ apply Merge Linked Lists step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
```python
def sortList(head):
    if not head or not head.next:
        return head
    slow, fast = head, head.next          # split into two halves
    while fast and fast.next:
        slow = slow.next
        fast = fast.next.next
    mid, slow.next = slow.next, None
    left, right = sortList(head), sortList(mid)
    dummy = tail = ListNode()             # merge sorted halves
    while left and right:
        if left.val <= right.val:
            tail.next, left = left, left.next
        else:
            tail.next, right = right, right.next
        tail = tail.next
    tail.next = left or right
    return dummy.next
```

### Complexity
Time O(n log n), Space O(log n) for the recursion stack.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 21 | Merge Two Lists | Easy | Core linked lists application |
| 23 | Merge K Lists | Easy | Core linked lists application |
| 148 | Sort List | Medium | Core linked lists application |
| 2 | Add Two Numbers | Medium | Core linked lists application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Reverse (whole / k-group)**
- **Cycle detection**
- **Merge sorted lists**
- **Dummy-node insert/delete**
- **Fast/slow midpoint**

---

## 14. Production Engineering Applications

- **Scalability:** Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Merge Linked Lists logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Merge Linked Lists (Linked Lists).
- **Signal:** merge, sorted lists, linked list, dummy, two pointer.
- **Move:** Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.
- **Cost:** O(n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Merge Linked Lists invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Merge Linked Lists
FAMILY : Linked Lists (Beginner)
WHEN   : merge, sorted lists, linked list, dummy, two pointer
DO     : Most list problems are pointer-rewiring; a dummy sentinel removes head edge case
TIME   : O(n)    SPACE: O(1)
PRACTICE: 21, 23, 148, 2
```

---

*Part of the DSA Patterns Handbook — pattern 50 of 100.*
