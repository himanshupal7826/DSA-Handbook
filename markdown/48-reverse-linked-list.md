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

**The question this pattern keeps answering:** *"Can I turn this list around without allocating a second copy of it?"*

Running example: reverse `1 → 2 → 3`.

### Intuition
A linked list only lets you walk forward, so the easy fix is to stop using it as a list.
Copy the values into an array, reverse the array, then walk the list again and write the
values back. No pointer surgery at all.

### Algorithm
1. Walk the list and append every `Val` to a slice → `[1, 2, 3]`.
2. Reverse the slice → `[3, 2, 1]`.
3. Walk the list a second time, writing the slice back into the nodes in order.
4. Return the original `head` (the *nodes* never moved, only the numbers inside them).

### Complexity
- Time: **O(n)** — three passes, but still linear.
- Space: **O(n)** — the slice is as long as the list.

### Drawbacks
- The O(n) buffer buys nothing. For a 10-million-node list you allocate 10 million ints
  just to reorder pointers you already own.
- **It reverses the values, not the list.** Anything else holding a pointer to a specific
  node now sees a different number in it. In an LRU cache or a free-list — the places real
  linked lists live — that is a bug, not an optimization.
- It ignores the one fact that makes lists cheap: *a list is defined entirely by its
  `Next` pointers*. Flipping those pointers is the whole job, and there are only n of them.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Walk the list once and flip each node's `Next` to point at the node you just came from.**

Think of a line of people, each with a hand on the shoulder of the person in front. To
reverse the line nobody has to move — each person just lets go and puts their hand on the
shoulder of the person *behind* them. Same people, same positions, opposite direction.

You need exactly three pointers to do it: `prev` (the part already reversed), `curr` (the
node being flipped right now), and `next` (a temporary hold on the part not yet reversed).

### The thought process

```text
We need    : the same nodes, linked in the opposite order, no extra memory.
Obvious way: copy the values out, reverse, copy back.
Too costly : O(n) buffer, and it mutates values instead of links.
Notice     : a list IS its Next pointers. Reversing the list = flipping each
             Next once. There are only n of them.
Therefore  : walk once; at each node set curr.Next = prev.
Now        : one pass, three pointers, O(1) space.
```

### Why you must save `next` **before** rewiring

This is the single line beginners drop, so look at what happens without it.

At `curr = 1`, the only thing in the whole program that knows where `2` lives is `1.Next`.
If you overwrite it first:

```text
curr.Next = prev        →   1.Next = nil
curr      = curr.Next   →   curr = nil        ← you meant "go to 2"
```

You just cut the rope you were standing on. Nodes `2` and `3` are still in memory, but no
variable points at them any more — the rest of the list is gone, permanently. The fix is
one line, moved one line earlier:

```text
next = curr.Next        ← hold the rest of the list FIRST
curr.Next = prev        ← now it is safe to destroy curr.Next
prev = curr
curr = next
```

**Rule:** save the pointer you are about to overwrite, then overwrite it.

### Why the loop is correct

The invariant, true before every iteration:

> `prev` is the head of the correctly-reversed part; `curr` is the head of the
> untouched part; every node is in exactly one of the two.

Each iteration moves exactly one node across the boundary and restores the invariant.
When `curr` becomes `nil` the untouched part is empty, so `prev` is the reversed whole
list — which is why you **return `prev`, not `head`**. (`head` is now the *tail*, pointing
at `nil`.)

### Steps

```text
Step 1 → prev = nil, curr = head
Step 2 → while curr != nil:
Step 3 →     next = curr.Next      (save the rest of the list)
Step 4 →     curr.Next = prev      (flip this one link)
Step 5 →     prev = curr           (grow the reversed part)
Step 6 →     curr = next           (advance into the untouched part)
Step 7 → return prev               (the old tail is the new head)
```

### How should I recognize this?

```text
If you see...
  "reverse a linked list", "reverse in place", "O(1) extra space"
  "palindrome list", "reorder list", "reverse nodes in k-groups"
  any problem where a sublist must come out backwards
        ↓
Think about...
  "Can I just flip Next pointers instead of moving data?"
        ↓
Use...
  prev/curr/next, saving next FIRST, and return prev
    · whole list          → the loop as written
    · a sublist [l, r]    → dummy node + walk to l-1, then flip r-l links
    · fixed blocks of k   → reverse a block, stitch tail to the next block
```

### Visual explanation

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="rev48" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Reverse: at curr, flip next-pointer to prev, then step all forward</text>
  <text x="70" y="52" text-anchor="middle" fill="#64748b">BEFORE</text>
  <!-- before row: 1 to 2 to 3 -->
  <rect x="150" y="38" width="46" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="173" y="60" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="250" y="38" width="46" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="273" y="60" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="350" y="38" width="46" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="373" y="60" text-anchor="middle" fill="#1e293b">3</text>
  <line x1="198" y1="55" x2="248" y2="55" stroke="#475569" marker-end="url(#rev48)"/>
  <line x1="298" y1="55" x2="348" y2="55" stroke="#475569" marker-end="url(#rev48)"/>
  <text x="173" y="88" text-anchor="middle" fill="#2563eb" font-weight="700">prev</text>
  <text x="273" y="88" text-anchor="middle" fill="#059669" font-weight="700">curr</text>
  <text x="373" y="88" text-anchor="middle" fill="#64748b">next</text>
  <text x="70" y="150" text-anchor="middle" fill="#64748b">AFTER</text>
  <!-- after row: 2 points back to 1 -->
  <rect x="150" y="136" width="46" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="173" y="158" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="250" y="136" width="46" height="34" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="273" y="158" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="350" y="136" width="46" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="373" y="158" text-anchor="middle" fill="#1e293b">3</text>
  <line x1="248" y1="153" x2="198" y2="153" stroke="#059669" marker-end="url(#rev48)"/>
  <line x1="398" y1="153" x2="348" y2="153" stroke="#475569" marker-end="url(#rev48)"/>
  <text x="173" y="188" text-anchor="middle" fill="#64748b">tail</text>
  <text x="273" y="188" text-anchor="middle" fill="#2563eb" font-weight="700">prev</text>
  <text x="373" y="188" text-anchor="middle" fill="#059669" font-weight="700">curr</text>
  <text x="430" y="158" fill="#059669" font-weight="700">flipped</text>
</svg>
```

```text
start   prev=nil                curr=1 → 2 → 3

iter 1  next=2
        1.Next=nil              prev=1              curr=2 → 3
        reversed: 1             remaining: 2 → 3

iter 2  next=3
        2.Next=1                prev=2              curr=3
        reversed: 2 → 1         remaining: 3

iter 3  next=nil
        3.Next=2                prev=3              curr=nil
        reversed: 3 → 2 → 1     remaining: (empty)

curr == nil  →  return prev = 3 → 2 → 1
```

### Interview explanation
"I'll reverse it in place with three pointers. `prev` starts at nil, `curr` at the head.
At each node I first save `curr.Next` — that's essential, because the next line destroys
it — then point `curr.Next` back at `prev`, and slide both pointers forward. The invariant
is that `prev` always heads the reversed prefix and `curr` heads the untouched suffix, so
when `curr` hits nil, `prev` is the new head and that's what I return. One pass, O(n) time,
O(1) space — and no values are moved, only links."

---

## 5. Generic Templates

> Save `next`, flip `curr.Next` to `prev`, slide both forward, return `prev`.

```go
type ListNode struct {
    Val  int
    Next *ListNode
}

// ReverseList reverses a singly linked list in place and returns the new head.
func ReverseList(head *ListNode) *ListNode {
    var prev *ListNode
    curr := head
    for curr != nil {
        next := curr.Next // 1. hold the rest of the list BEFORE overwriting
        curr.Next = prev  // 2. flip this link
        prev = curr       // 3. reversed part grows by one node
        curr = next       // 4. step into the untouched part
    }
    return prev // old tail is the new head
}

// ReverseSegment reverses exactly n nodes starting at head and returns
// (newHead, oldHead). oldHead is the segment's new tail — stitch it yourself.
func ReverseSegment(head *ListNode, n int) (*ListNode, *ListNode) {
    var prev *ListNode
    curr := head
    for i := 0; i < n && curr != nil; i++ {
        next := curr.Next
        curr.Next = prev
        prev = curr
        curr = next
    }
    return prev, head
}
```

```python
class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt


def reverse_list(head):
    """Reverse a singly linked list in place; return the new head."""
    prev, curr = None, head
    while curr:
        nxt = curr.next      # 1. hold the rest of the list BEFORE overwriting
        curr.next = prev     # 2. flip this link
        prev = curr          # 3. reversed part grows by one node
        curr = nxt           # 4. step into the untouched part
    return prev              # old tail is the new head


def reverse_segment(head, n):
    """Reverse n nodes from head; return (new_head, new_tail)."""
    prev, curr, i = None, head, 0
    while curr and i < n:
        nxt = curr.next
        curr.next = prev
        prev, curr, i = curr, nxt, i + 1
    return prev, head
```

```java
class ListNode {
    int val;
    ListNode next;
    ListNode(int v) { val = v; }
}

ListNode reverseList(ListNode head) {
    ListNode prev = null, curr = head;
    while (curr != null) {
        ListNode next = curr.next; // 1. hold the rest of the list
        curr.next = prev;          // 2. flip this link
        prev = curr;               // 3. grow the reversed part
        curr = next;               // 4. advance
    }
    return prev;                   // old tail is the new head
}
```

```cpp
struct ListNode {
    int val;
    ListNode* next;
    ListNode(int v) : val(v), next(nullptr) {}
};

ListNode* reverseList(ListNode* head) {
    ListNode* prev = nullptr;
    ListNode* curr = head;
    while (curr) {
        ListNode* next = curr->next; // 1. hold the rest of the list
        curr->next = prev;           // 2. flip this link
        prev = curr;                 // 3. grow the reversed part
        curr = next;                 // 4. advance
    }
    return prev;                     // old tail is the new head
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
Given the head of a singly linked list, reverse it and return the head of the reversed
list. The nodes must be re-linked in place — you may not build a new list.

### Thought Process
1. `prev` starts at `nil`; it will grow into the reversed list and end up as the new head.
2. For the node under `curr`, **first** save `curr.Next` — the next line destroys it.
3. Point `curr.Next` back at `prev`. That single assignment is the whole reversal.
4. Slide `prev` and `curr` forward one node each.
5. When `curr` is `nil` every node has been flipped, so return `prev`.

### Dry Run

Input: `1 → 2 → 3`

Every pointer, after every statement of every iteration:

| iter | `next = curr.Next` | `curr.Next = prev` | `prev = curr` | `curr = next` | list state |
|------|--------------------|--------------------|---------------|---------------|------------|
| —    | (start) `prev=nil`, `curr=1` | — | — | — | `1→2→3` |
| 1    | `next=2`           | `1.Next=nil`       | `prev=1`      | `curr=2`      | reversed `1` · rest `2→3` |
| 2    | `next=3`           | `2.Next=1`         | `prev=2`      | `curr=3`      | reversed `2→1` · rest `3` |
| 3    | `next=nil`         | `3.Next=2`         | `prev=3`      | `curr=nil`    | reversed `3→2→1` · rest empty |

Loop guard `curr != nil` now fails.

Output: **`3 → 2 → 1`**

Look at iteration 1. The moment `1.Next` becomes `nil`, the only remaining route to nodes
`2` and `3` is the `next` variable saved in the previous column. Swap those two columns and
the answer becomes `1` — a one-node list, with the rest leaked.

### Visualization

```text
             prev        curr
              ↓           ↓
before      [nil]      [1]→[2]→[3]

after iter1  [1]→nil    [2]→[3]          prev=1   curr=2
after iter2  [2]→[1]→nil  [3]            prev=2   curr=3
after iter3  [3]→[2]→[1]→nil  (nil)      prev=3   curr=nil
              ↑
            new head (returned)
```

### Code

```go
func reverseList(head *ListNode) *ListNode {
    var prev *ListNode // reversed part; also the answer
    curr := head       // untouched part
    for curr != nil {
        next := curr.Next // MUST come first: the next line overwrites curr.Next
        curr.Next = prev  // flip the link backwards
        prev = curr       // reversed part grows
        curr = next       // advance into the untouched part
    }
    return prev // the old tail
}
```

```python
def reverseList(head):
    prev, curr = None, head
    while curr:
        nxt = curr.next      # MUST come first: the next line overwrites curr.next
        curr.next = prev     # flip the link backwards
        prev = curr          # reversed part grows
        curr = nxt           # advance into the untouched part
    return prev              # the old tail
```

### Complexity
Time O(n) — each node is visited once and one pointer is written per node.
Space O(1) — three pointer variables, regardless of list length.

---

## 10. Solved Example 2

### Problem — Reverse II (LeetCode 92)
Reverse only the nodes from position `left` to position `right` (1-indexed) and leave the
rest of the list untouched. One pass.

### Thought Process
1. `left` may be `1`, so the head itself can move — put a **dummy** node in front and the
   head stops being a special case.
2. Walk `prev` to the node just *before* position `left`. It never moves again; it is the
   anchor the reversed block hangs off.
3. Instead of a separate reverse-then-stitch, repeatedly **head-insert**: unhook the node
   after `curr` and splice it directly behind `prev`.
4. Do that exactly `right - left` times — each move drags one node to the front of the block.
5. `curr` naturally drifts to the back of the block and stays connected to the tail, so
   nothing needs re-stitching. Return `dummy.Next`.

### Dry Run

Input: `1 → 2 → 3 → 4 → 5`, `left = 2`, `right = 4`

Setup: `prev = node1` (the node before position 2), `curr = node2`, moves `= right-left = 2`.

| move | `nxt = curr.Next` | `curr.Next = nxt.Next` | `nxt.Next = prev.Next` | `prev.Next = nxt` | list after |
|------|-------------------|------------------------|------------------------|-------------------|------------|
| 1    | `nxt=3`           | `2.Next=4`             | `3.Next=2`             | `1.Next=3`        | `1→3→2→4→5` |
| 2    | `nxt=4`           | `2.Next=5`             | `4.Next=3`             | `1.Next=4`        | `1→4→3→2→5` |

Output: **`1 → 4 → 3 → 2 → 5`**

Notice `curr` stays pinned to node `2` the entire time — it starts as the block's head and
ends as the block's tail, which is exactly why `2 → 5` is already correct at the end.

### Visualization

```text
            prev  curr
              ↓    ↓
start    1 →  [2 → 3 → 4] → 5        block to reverse

move 1   pull 3 out, insert after prev
         1 → 3 → 2 → 4 → 5

move 2   pull 4 out, insert after prev
         1 → 4 → 3 → 2 → 5
              └───────┘
              block reversed; curr(=2) still points at 5
```

With `left = 1` the anchor is the dummy itself, so `dummy.Next` is rewritten instead of a
real node's `Next` — the same four lines, no `if` needed.

### Code

```go
func reverseBetween(head *ListNode, left, right int) *ListNode {
    dummy := &ListNode{Next: head} // left may be 1: dummy removes that special case
    prev := dummy
    for i := 0; i < left-1; i++ { // stop just before position `left`
        prev = prev.Next
    }
    curr := prev.Next             // block head now, block tail at the end
    for i := 0; i < right-left; i++ {
        nxt := curr.Next          // node to pull to the front
        curr.Next = nxt.Next      // unhook it
        nxt.Next = prev.Next      // it now leads the block
        prev.Next = nxt           // anchor points at the new block head
    }
    return dummy.Next
}
```

```python
def reverseBetween(head, left, right):
    dummy = ListNode(0, head)        # left may be 1: dummy removes that special case
    prev = dummy
    for _ in range(left - 1):        # stop just before position `left`
        prev = prev.next
    curr = prev.next                 # block head now, block tail at the end
    for _ in range(right - left):
        nxt = curr.next              # node to pull to the front
        curr.next = nxt.next         # unhook it
        nxt.next = prev.next         # it now leads the block
        prev.next = nxt              # anchor points at the new block head
    return dummy.next
```

### Complexity
Time O(n) — at most `left-1` steps to reach the anchor plus `right-left` constant-time
splices. Space O(1) — a dummy and three pointers.

---

## 11. Solved Example 3

### Problem — Palindrome List (LeetCode 234)
Return `true` if the values of the linked list read the same forwards and backwards.
Aim for O(n) time and O(1) extra space.

### Thought Process
1. Comparing front to back needs backwards movement, which a singly linked list forbids —
   so *make* a backwards half by reversing it.
2. Find where the second half starts with slow/fast pointers: `fast` moves two nodes per
   `slow` step, so when `fast` runs out, `slow` is at the midpoint.
3. Reverse from `slow` onward using the exact prev/curr/next loop from Example 1.
4. Walk `left` from the original head and `right` from the reversed half; any mismatch means
   not a palindrome.
5. Stop when `right` hits `nil`. The two halves overlap harmlessly on odd lengths, so no
   length parity check is needed.

### Dry Run

Input: `1 → 2 → 2 → 1` (nodes `n0 n1 n2 n3`)

**Phase 1 — find the midpoint**

| step | `slow` | `fast` | guard `fast != nil && fast.Next != nil` |
|------|--------|--------|------------------------------------------|
| start| `n0(1)`| `n0(1)`| true |
| 1    | `n1(2)`| `n2(2)`| true |
| 2    | `n2(2)`| `nil`  | false → stop |

`slow = n2`, the first node of the second half.

**Phase 2 — reverse from `slow`**

| iter | `nxt` | rewire | `prev` | `slow` |
|------|-------|--------|--------|--------|
| 1    | `n3`  | `n2.Next=nil` | `n2` | `n3` |
| 2    | `nil` | `n3.Next=n2`  | `n3` | `nil` |

Reversed second half: `n3(1) → n2(2)`.

**Phase 3 — compare**

| step | `left` | `right` | values | verdict |
|------|--------|---------|--------|---------|
| 1    | `n0`   | `n3`    | `1 == 1` | continue |
| 2    | `n1`   | `n2`    | `2 == 2` | continue |
| 3    | `n2`   | `nil`   | —        | loop ends |

Output: **`true`**

For `1 → 2` the compare loop's first step sees `1` vs `2` and returns `false` immediately.

### Visualization

```text
original    1 → 2 → 2 → 1
                    ↑
                   slow  (start of second half)

after reversing the tail:

  left ──▶ 1 → 2 ─┐            ┌─ 1 ◀── right
                  ↓            ↓
             (first half)  (second half, backwards)

compare  1 vs 1  ✓
compare  2 vs 2  ✓
right == nil → palindrome
```

### Code

```go
func isPalindrome(head *ListNode) bool {
    // 1. slow lands on the first node of the second half
    slow, fast := head, head
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }
    // 2. reverse the second half in place (Example 1's loop)
    var prev *ListNode
    for slow != nil {
        nxt := slow.Next
        slow.Next = prev
        prev = slow
        slow = nxt
    }
    // 3. walk both halves inwards; the shorter one (prev) ends the loop
    left, right := head, prev
    for right != nil {
        if left.Val != right.Val {
            return false
        }
        left, right = left.Next, right.Next
    }
    return true
}
```

```python
def isPalindrome(head):
    # 1. slow lands on the first node of the second half
    slow = fast = head
    while fast and fast.next:
        slow = slow.next
        fast = fast.next.next
    # 2. reverse the second half in place (Example 1's loop)
    prev = None
    while slow:
        nxt = slow.next
        slow.next = prev
        prev = slow
        slow = nxt
    # 3. walk both halves inwards; the shorter one (prev) ends the loop
    left, right = head, prev
    while right:
        if left.val != right.val:
            return False
        left, right = left.next, right.next
    return True
```

### Complexity
Time O(n) — one pass to find the middle, one to reverse half, one to compare half.
Space O(1) — only pointers; the reversal is in place.

---

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
