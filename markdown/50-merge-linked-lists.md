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

**The question this pattern keeps answering:** *"Two (or more) chains are already sorted — how do I zip them into one without re-sorting anything?"*

Running example: merge `A = 1 → 4` with `B = 2 → 3`.

### Intuition
Forget the lists are sorted. Pour every value into an array, sort the array, rebuild a
list from it. Guaranteed correct because sorting doesn't care where the numbers came from.

### Algorithm
1. Walk `A` and `B`, appending every `Val` to one slice → `[1, 4, 2, 3]`.
2. Sort the slice → `[1, 2, 3, 4]`.
3. Allocate a fresh node per value and chain them together.
4. Return the new head.

### Complexity
- Time: **O(n log n)** — the sort dominates, where `n` is the total node count.
- Space: **O(n)** — the slice plus a whole second set of nodes.

### Drawbacks
- **It throws away the only useful fact in the problem.** The inputs are already sorted, so
  the comparisons the sort performs are almost all re-deriving order you were handed for free.
- Concretely, on `[1, 4]` and `[2, 3]` the sort compares `1↔4` and `2↔3` — two comparisons
  whose answers were already encoded in the input lists' links.
- It allocates `n` new nodes when the answer needs **zero** new nodes: the correct list is
  the same nodes with different `Next` pointers.
- It cannot stream. Merging two 10 GB sorted files this way needs 20 GB of RAM; the optimal
  version needs two pointers.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Both lists are sorted, so the smaller of the two front nodes is the smallest node left anywhere — take it, advance that list, repeat.**

It is the shuffle at the end of a card game: two sorted piles face up, you keep taking
whichever top card is lower. You never look deeper than one card into either pile, because
a sorted pile can't be hiding anything smaller underneath.

### The thought process

```text
We need    : one sorted list from two sorted lists.
Obvious way: dump everything into an array and sort it.
Too slow   : O(n log n), plus n fresh nodes, for information we already had.
Notice     : if A and B are sorted, min(A.head, B.head) is the global minimum
             of everything not yet placed. No deeper look is ever needed.
Therefore  : compare the two heads, splice the smaller one on, advance it.
Now        : O(n) time, O(1) space, zero new nodes.
```

### Why the "smaller head" choice is always safe

Suppose the output so far ends with value `t`, and the remaining heads are `a` and `b`
with `a <= b`. Could some node *behind* `a` or `b` be smaller than `a`?

- Behind `a`: no — `A` is sorted, so everything after `a` is `>= a`.
- Behind `b`: no — `B` is sorted, so everything after `b` is `>= b >= a`.

So `a` is the minimum of everything left, and appending it keeps the output sorted. The
greedy choice is not a heuristic; it is forced.

**Use `<=`, not `<`.** With `<`, equal values pull from `B` first, which reverses the
relative order of equal elements — the merge stops being *stable*. Stability is what makes
this same routine safe as the merge step of merge sort.

### Why a dummy node

Without one, the first splice is a special case: there is no `tail` to attach to yet, so
you need an `if this is the first node, set head = ... else tail.Next = ...` in the hot
loop, plus a separate variable for the head you must remember to return.

A dummy node is a fake node that exists only so `tail` always points at *something*:

```text
dummy → (nothing yet)
tail ────┘

every step:  tail.Next = chosen ;  tail = chosen     ← no branch, ever
at the end:  return dummy.Next                        ← skip the fake node
```

One throwaway node buys you a loop with no special cases. (Chapter 51 is entirely about
this trick.)

### Steps

```text
Step 1 → dummy = new node, tail = dummy
Step 2 → while a != nil and b != nil:
Step 3 →     if a.Val <= b.Val: tail.Next = a; a = a.Next
Step 4 →     else:              tail.Next = b; b = b.Next
Step 5 →     tail = tail.Next
Step 6 → one list is empty; the other is already sorted:
Step 7 →     tail.Next = (a if a != nil else b)      ← attach the whole rest at once
Step 8 → return dummy.Next
```

Step 7 is not an optimization detail — it is the reason the loop can stop early. Whatever
remains is a sorted suffix that already outranks everything placed, so it is appended
whole, in O(1).

### How should I recognize this?

```text
If you see...
  "two sorted lists", "merge", "k sorted lists"
  "sort a linked list in O(n log n) and O(1) space"
  "merge intervals / streams that arrive in order"
        ↓
Think about...
  "Is the smallest thing left always at the front of one of my inputs?"
        ↓
Use...
  dummy + tail, splice min(heads), attach the leftover in one move
    · 2 lists      → the loop as written
    · k lists      → merge pairs tournament-style, O(N log k)
    · sort a list  → split at the middle, sort both, merge (merge sort)
```

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

```text
A: 1 → 4        B: 2 → 3        dummy → _        tail = dummy

step 1   a=1  b=2   1 <= 2  → take A          merged: 1        a=4  b=2
step 2   a=4  b=2   2 <  4  → take B          merged: 1 2      a=4  b=3
step 3   a=4  b=3   3 <  4  → take B          merged: 1 2 3    a=4  b=nil
step 4   b == nil   → attach the rest of A    merged: 1 2 3 4

return dummy.Next = 1 → 2 → 3 → 4
```

### Interview explanation
"Since both lists are sorted, the smaller of the two head nodes is the smallest node left
anywhere — nothing behind a sorted head can beat it — so I greedily splice that one on and
advance only that list. I use a dummy node so the first append needs no special case and
so I have a stable handle to return, and I compare with `<=` to keep the merge stable. When
one list empties I attach the entire remainder in one assignment. That's O(n + m) time and
O(1) extra space, because I re-link the original nodes instead of allocating new ones."

---

## 5. Generic Templates

> Dummy + tail; splice `min(a, b)` with `<=`; when one side empties, attach the rest whole.

```go
type ListNode struct {
    Val  int
    Next *ListNode
}

// MergeTwo splices two sorted lists into a single sorted chain.
// It allocates nothing but the sentinel and is stable (ties take from a).
func MergeTwo(a, b *ListNode) *ListNode {
    dummy := &ListNode{} // sentinel: tail always has somewhere to write
    tail := dummy
    for a != nil && b != nil {
        if a.Val <= b.Val { // <= keeps equal values in a-then-b order
            tail.Next = a
            a = a.Next
        } else {
            tail.Next = b
            b = b.Next
        }
        tail = tail.Next
    }
    if a != nil { // the leftover is sorted and all >= everything placed
        tail.Next = a
    } else {
        tail.Next = b
    }
    return dummy.Next
}

// MergeAll folds k sorted lists pairwise: O(N log k) instead of O(N k).
func MergeAll(lists []*ListNode) *ListNode {
    if len(lists) == 0 {
        return nil
    }
    for len(lists) > 1 {
        var round []*ListNode
        for i := 0; i < len(lists); i += 2 {
            if i+1 < len(lists) {
                round = append(round, MergeTwo(lists[i], lists[i+1]))
            } else {
                round = append(round, lists[i]) // odd one out rides along
            }
        }
        lists = round
    }
    return lists[0]
}
```

```python
class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt


def merge_two(a, b):
    """Splice two sorted lists into one. Stable; allocates only the sentinel."""
    dummy = ListNode()          # sentinel: tail always has somewhere to write
    tail = dummy
    while a and b:
        if a.val <= b.val:      # <= keeps equal values in a-then-b order
            tail.next, a = a, a.next
        else:
            tail.next, b = b, b.next
        tail = tail.next
    tail.next = a or b          # the leftover suffix is already sorted
    return dummy.next


def merge_all(lists):
    """Fold k sorted lists pairwise: O(N log k)."""
    if not lists:
        return None
    while len(lists) > 1:
        nxt = []
        for i in range(0, len(lists), 2):
            if i + 1 < len(lists):
                nxt.append(merge_two(lists[i], lists[i + 1]))
            else:
                nxt.append(lists[i])
        lists = nxt
    return lists[0]
```

```java
class ListNode { int val; ListNode next; ListNode(int v) { val = v; } }

ListNode mergeTwo(ListNode a, ListNode b) {
    ListNode dummy = new ListNode(0); // sentinel
    ListNode tail = dummy;
    while (a != null && b != null) {
        if (a.val <= b.val) { tail.next = a; a = a.next; } // <= is stable
        else               { tail.next = b; b = b.next; }
        tail = tail.next;
    }
    tail.next = (a != null) ? a : b;  // attach the sorted leftover whole
    return dummy.next;
}
```

```cpp
struct ListNode {
    int val;
    ListNode* next;
    ListNode(int v) : val(v), next(nullptr) {}
};

ListNode* mergeTwo(ListNode* a, ListNode* b) {
    ListNode dummy(0);               // sentinel on the stack
    ListNode* tail = &dummy;
    while (a && b) {
        if (a->val <= b->val) { tail->next = a; a = a->next; } // <= is stable
        else                  { tail->next = b; b = b->next; }
        tail = tail->next;
    }
    tail->next = a ? a : b;          // attach the sorted leftover whole
    return dummy.next;
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
Given the heads of two lists that are each sorted ascending, splice them into one sorted
list and return its head. Reuse the existing nodes.

### Thought Process
1. Both inputs are sorted, so the smaller of the two head values is the smallest value left
   in either list — nothing behind a sorted head can undercut it.
2. Splice that node onto the output and advance only the list it came from.
3. Use a dummy node so the very first splice looks like every other splice, and so there is
   a stable handle (`dummy.Next`) to return.
4. Break ties with `<=` so equal values keep their `a`-before-`b` order (stability).
5. When one list runs out, the other is a sorted suffix that already outranks everything
   placed — attach it whole in one assignment.

### Dry Run

Input: `a = 1 → 4`, `b = 2 → 3`

| step | `a` head | `b` head | comparison | node spliced | `tail` after | output so far |
|------|----------|----------|------------|--------------|--------------|---------------|
| start| `1`      | `2`      | —          | —            | `dummy`      | *(empty)* |
| 1    | `1`      | `2`      | `1 <= 2` → take `a` | `1` | `1` | `1` |
| 2    | `4`      | `2`      | `4 > 2` → take `b`  | `2` | `2` | `1 → 2` |
| 3    | `4`      | `3`      | `4 > 3` → take `b`  | `3` | `3` | `1 → 2 → 3` |
| 4    | `4`      | `nil`    | `b` empty → attach the rest of `a` | `4` | — | `1 → 2 → 3 → 4` |

Output: **`1 → 2 → 3 → 4`**

Step 4 is the payoff: the tail `4` is appended by a single pointer write, not by looping
through it. If `a` had 10,000 nodes left, that step would still cost one assignment.

### Visualization

```text
             a                          b
             ↓                          ↓
A:      [1] → [4]                B:  [2] → [3]

dummy → _ ← tail

step 1  take 1 :  dummy → 1                 a → 4   b → 2
step 2  take 2 :  dummy → 1 → 2             a → 4   b → 3
step 3  take 3 :  dummy → 1 → 2 → 3         a → 4   b → nil
step 4  attach :  dummy → 1 → 2 → 3 → 4     (one write, whole suffix)
                        ↑
                  return dummy.Next
```

### Code

```go
func mergeTwoLists(a, b *ListNode) *ListNode {
    dummy := &ListNode{} // sentinel so tail always has somewhere to write
    tail := dummy
    for a != nil && b != nil {
        if a.Val <= b.Val { // <= keeps equal values stable (a before b)
            tail.Next = a
            a = a.Next
        } else {
            tail.Next = b
            b = b.Next
        }
        tail = tail.Next
    }
    if a != nil { // whatever is left is sorted and >= everything placed
        tail.Next = a
    } else {
        tail.Next = b
    }
    return dummy.Next // skip the sentinel
}
```

```python
def mergeTwoLists(a, b):
    dummy = ListNode()          # sentinel so tail always has somewhere to write
    tail = dummy
    while a and b:
        if a.val <= b.val:      # <= keeps equal values stable (a before b)
            tail.next, a = a, a.next
        else:
            tail.next, b = b, b.next
        tail = tail.next
    tail.next = a or b          # attach the sorted leftover in one move
    return dummy.next           # skip the sentinel
```

### Complexity
Time O(n + m) — every node is spliced at most once, and the leftover costs O(1).
Space O(1) — one sentinel plus two pointers; no new nodes are allocated.

---

## 10. Solved Example 2

### Problem — Merge K Lists (LeetCode 23)
You are given an array of `k` sorted linked lists. Merge all of them into one sorted list.

### Thought Process
1. The obvious extension — merge list 0 with 1, then that with 2, then with 3 — is
   quadratic: the growing accumulator is re-walked on every merge, giving O(N·k).
2. The waste is that the *same* early nodes get compared again in every round.
3. Merge in **pairs** instead: `(0,1)`, `(2,3)`, `(4,5)`… Each round halves the number of
   lists while touching every node exactly once.
4. After `log k` rounds one list remains, and each node participated in `log k` merges →
   O(N log k).
5. Every merge is exactly Example 1's routine — no new idea, just a better schedule.

### Dry Run

Input: `lists = [ [1,4], [2,6], [3,5] ]`

| round | lists at start | pairings | lists after |
|-------|----------------|----------|-------------|
| 1 | `[1,4]`, `[2,6]`, `[3,5]` | merge(`[1,4]`,`[2,6]`) = `[1,2,4,6]`; `[3,5]` has no partner, carried over | `[1,2,4,6]`, `[3,5]` |
| 2 | `[1,2,4,6]`, `[3,5]` | merge(`[1,2,4,6]`,`[3,5]`) = `[1,2,3,4,5,6]` | `[1,2,3,4,5,6]` |

Only one list left → stop.

Output: **`1 → 2 → 3 → 4 → 5 → 6`**

Six nodes, `k = 3`, so `⌈log₂3⌉ = 2` rounds — matching the two rows above. Chaining
one-by-one instead would have re-walked `[1,4]` in every round.

### Visualization

```text
round 1     [1,4]   [2,6]      [3,5]
              └──┬───┘           │      (odd list rides along untouched)
                 ▼               ▼
round 2     [1,2,4,6]         [3,5]
                 └───────┬──────┘
                         ▼
result           [1,2,3,4,5,6]

each node crosses log2(k) merge levels → O(N log k)
```

### Code

```go
// mergePair is Example 1's routine, renamed so this block stands alone.
func mergePair(a, b *ListNode) *ListNode {
    dummy := &ListNode{}
    tail := dummy
    for a != nil && b != nil {
        if a.Val <= b.Val {
            tail.Next = a
            a = a.Next
        } else {
            tail.Next = b
            b = b.Next
        }
        tail = tail.Next
    }
    if a != nil {
        tail.Next = a
    } else {
        tail.Next = b
    }
    return dummy.Next
}

func mergeKLists(lists []*ListNode) *ListNode {
    if len(lists) == 0 {
        return nil
    }
    for len(lists) > 1 { // one round halves the number of lists
        var round []*ListNode
        for i := 0; i < len(lists); i += 2 {
            if i+1 < len(lists) {
                round = append(round, mergePair(lists[i], lists[i+1]))
            } else {
                round = append(round, lists[i]) // odd one out, carried over
            }
        }
        lists = round
    }
    return lists[0]
}
```

```python
def mergeKLists(lists):
    if not lists:
        return None
    while len(lists) > 1:            # one round halves the number of lists
        nxt = []
        for i in range(0, len(lists), 2):
            if i + 1 < len(lists):
                nxt.append(mergeTwoLists(lists[i], lists[i + 1]))
            else:
                nxt.append(lists[i])  # odd one out, carried over
        lists = nxt
    return lists[0]
```

### Complexity
Time **O(N log k)** — `log k` rounds, and each round touches all `N` nodes once.
Space O(k) for the round buffer (O(1) if you merge in place in the same slice).

---

## 11. Solved Example 3

### Problem — Sort List (LeetCode 148)
Sort a linked list in ascending order. The expected solution is O(n log n) time and O(1)
extra space (ignoring recursion).

### Thought Process
1. Quicksort needs random access to pick pivots well; a list has none. Merge sort only ever
   walks forward — a perfect fit.
2. Merge sort needs three things: split in half, sort each half, merge. We already have the
   merge from Example 1.
3. Split with slow/fast pointers. Start `fast` one node ahead so `slow` stops on the **last
   node of the left half**, then cut with `slow.Next = nil`.
4. That off-by-one start matters: with `fast = head` a two-node list would put `slow` on the
   second node, the "left half" would be the whole list, and the recursion would never shrink.
5. Base case: zero or one node is already sorted.

### Dry Run

Input: `4 → 2 → 1 → 3`

**Splitting** (`slow = head`, `fast = head.Next`)

| call | list | `slow` stops at | left | right |
|------|------|-----------------|------|-------|
| 1 | `4,2,1,3` | node `2` | `4,2` | `1,3` |
| 2 | `4,2`     | node `4` | `4`  | `2`   |
| 3 | `1,3`     | node `1` | `1`  | `3`   |

**Merging back up** (each row is Example 1's routine)

| merge | inputs | result |
|-------|--------|--------|
| a | `4` and `2`       | `2 → 4` |
| b | `1` and `3`       | `1 → 3` |
| c | `2 → 4` and `1 → 3` | `1 → 2 → 3 → 4` |

Output: **`1 → 2 → 3 → 4`**

Trace merge `c` by hand: heads `2` vs `1` → take `1`; `2` vs `3` → take `2`; `4` vs `3` →
take `3`; right side empty → attach `4`. Exactly the Example 1 loop.

### Visualization

```text
                   [4, 2, 1, 3]
                    /        \                split
              [4, 2]          [1, 3]
              /    \          /    \          split
           [4]    [2]      [1]    [3]         base case
              \    /          \    /
              [2, 4]          [1, 3]          merge
                    \        /
                   [1, 2, 3, 4]               merge

depth = log2(n) levels, O(n) work per level  →  O(n log n)
```

### Code

```go
// splitAtMiddle cuts the list in two and returns both heads.
// fast starts one node ahead so slow lands on the LAST node of the left half.
func splitAtMiddle(head *ListNode) (*ListNode, *ListNode) {
    slow, fast := head, head.Next
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }
    right := slow.Next
    slow.Next = nil // cut
    return head, right
}

// mergeSorted is Example 1's routine, renamed so this block stands alone.
func mergeSorted(a, b *ListNode) *ListNode {
    dummy := &ListNode{}
    tail := dummy
    for a != nil && b != nil {
        if a.Val <= b.Val {
            tail.Next = a
            a = a.Next
        } else {
            tail.Next = b
            b = b.Next
        }
        tail = tail.Next
    }
    if a != nil {
        tail.Next = a
    } else {
        tail.Next = b
    }
    return dummy.Next
}

func sortList(head *ListNode) *ListNode {
    if head == nil || head.Next == nil { // 0 or 1 node is already sorted
        return head
    }
    left, right := splitAtMiddle(head)
    return mergeSorted(sortList(left), sortList(right))
}
```

```python
def sortList(head):
    if head is None or head.next is None:   # 0 or 1 node is already sorted
        return head
    # split: fast starts one ahead so slow lands on the last left-half node
    slow, fast = head, head.next
    while fast and fast.next:
        slow, fast = slow.next, fast.next.next
    right, slow.next = slow.next, None      # cut
    return mergeTwoLists(sortList(head), sortList(right))
```

### Complexity
Time O(n log n) — `log n` levels of splitting, O(n) merging work per level.
Space O(log n) for the recursion stack; no arrays and no new nodes.

---

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
