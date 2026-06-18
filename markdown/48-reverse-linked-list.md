# 48 · Reverse Linked List

> **One-liner:** Rewire next-pointers with prev/curr/next to reverse in O(n), O(1).

---

## 1. Overview

### Definition
The **Reverse Linked List** pattern belongs to the *Linked Lists* family. Rewire next-pointers with prev/curr/next to reverse in O(n), O(1).

### Intuition
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Why it works
Rewire pointers in place with a few pointers (prev/curr/next) and a dummy head — O(1) space. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).

---

## 2. Recognition Signals

### Keywords
reverse, linked list, pointers, prev curr next, iterative.

### Constraints
- Input size where the brute-force complexity would time out — the Reverse Linked List optimization is the intended solution.
- Structural hints in the statement that match this family (Linked Lists).

### Hidden clues
- The problem can be reframed so the Reverse Linked List invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Reverse Linked List is the upgrade.
- The wording maps onto: reverse, linked list, pointers, prev curr next, iterative.

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
Redundant recomputation; does not exploit the structure the Reverse Linked List pattern is built to use.

---

## 4. Optimal Approach

### Core idea
Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the Reverse Linked List invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation
```
brute  : recompute everything each step      ──▶ slow
Reverse Linked Lis: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a Reverse Linked List problem. I'll most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure. That brings the complexity down to O(n) time and O(1) space — here's the template."

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

| Metric | Brute Force | Reverse Linked List (Optimal) |
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

### Problem — Reverse List (LeetCode 206)
A representative **Reverse Linked List** problem. The signal: rewire next-pointers with prev/curr/next to reverse in o(n), o(1).

### Thought Process
1. Confirm the pattern via its recognition signals (reverse, linked list, pointers, prev curr next, iterative).
2. Reach for the Reverse Linked List template below and map the problem's entities onto it.
3. Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Reverse Linked List step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(1). In-place pointer manipulation, single traversal.

## 10. Solved Example 2

### Problem — Reverse II (LeetCode 92)
A representative **Reverse Linked List** problem. The signal: rewire next-pointers with prev/curr/next to reverse in o(n), o(1).

### Thought Process
1. Confirm the pattern via its recognition signals (reverse, linked list, pointers, prev curr next, iterative).
2. Reach for the Reverse Linked List template below and map the problem's entities onto it.
3. Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Reverse Linked List step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(1). In-place pointer manipulation, single traversal.

## 11. Solved Example 3

### Problem — Palindrome List (LeetCode 234)
A representative **Reverse Linked List** problem. The signal: rewire next-pointers with prev/curr/next to reverse in o(n), o(1).

### Thought Process
1. Confirm the pattern via its recognition signals (reverse, linked list, pointers, prev curr next, iterative).
2. Reach for the Reverse Linked List template below and map the problem's entities onto it.
3. Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply Reverse Linked List step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
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

### Complexity
Time O(n), Space O(1). In-place pointer manipulation, single traversal.


## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 206 | Reverse List | Easy | Core linked lists application |
| 92 | Reverse II | Easy | Core linked lists application |
| 234 | Palindrome List | Medium | Core linked lists application |
| 25 | Reverse K Group | Medium | Core linked lists application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Reverse Linked List logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Reverse Linked List (Linked Lists).
- **Signal:** reverse, linked list, pointers, prev curr next, iterative.
- **Move:** Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.
- **Cost:** O(n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Reverse Linked List invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Reverse Linked List
FAMILY : Linked Lists (Beginner)
WHEN   : reverse, linked list, pointers, prev curr next, iterative
DO     : Most list problems are pointer-rewiring; a dummy sentinel removes head edge case
TIME   : O(n)    SPACE: O(1)
PRACTICE: 206, 92, 234, 25
```

---

*Part of the DSA Patterns Handbook — pattern 48 of 100.*
