# 08 · Fast and Slow Pointer

> **One-liner:** Two pointers at different speeds detect cycles and find midpoints.

---

## 1. Overview

### Definition
The **Fast and Slow Pointer** pattern belongs to the *Two Pointers* family. Two pointers at different speeds detect cycles and find midpoints.

### Intuition
Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.

### Why it works
Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.

---

## 2. Recognition Signals

### Keywords
floyd, cycle, tortoise hare, middle, linked list cycle.

### Constraints
- Input size where the brute-force complexity would time out — the Fast and Slow Pointer optimization is the intended solution.
- Structural hints in the statement that match this family (Two Pointers).

### Hidden clues
- The problem can be reframed so the Fast and Slow Pointer invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Fast and Slow Pointer is the upgrade.
- The wording maps onto: floyd, cycle, tortoise hare, middle, linked list cycle.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Does this linked list loop forever — and if so, where does the loop begin?"* (and its cousin: *"where is the middle?"*)

### Intuition
A cycle means you revisit a node. So write down every node you visit; the first repeat is proof of a cycle.

### Algorithm
1. Create an empty set of visited node **addresses** (not values — values can legitimately repeat).
2. Walk the list one node at a time.
3. If the current node is already in the set → there is a cycle, and this node is the entrance.
4. Otherwise add it and continue.
5. Reaching `nil` means no cycle.

### Complexity
- Time: O(n).
- Space: **O(n)** — the set can hold every node.

### Drawbacks
- The time is already optimal; the problem is the **memory**. For a list of 10⁷ nodes we allocate a set of 10⁷ pointers just to answer a yes/no question.
- Interviewers almost always follow up with *"now do it in O(1) space."*

A second brute force, for finding the middle: walk once to count the length `n`, then walk again `n/2` steps. That's O(1) space but needs two passes — and it isn't possible at all if you're only allowed to consume the list once (a stream).

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Run two pointers at different speeds. Their *gap* carries the information, so you don't have to store anything.**

Two runners on a circular track: the faster one will inevitably lap the slower one. On a straight track, it never will — it just reaches the end. That single difference detects a cycle with two variables and no memory.

And if the fast pointer moves exactly twice as fast, then when fast reaches the end, slow has covered exactly half — so the same trick finds the middle for free.

### The thought process

```text
We need    : detect a cycle (and find its start) in O(1) space.
Obvious way: remember every node visited.
Too costly : O(n) memory just to answer yes/no.
Notice     : if there is a loop, a faster pointer must eventually
             lap a slower one — they will land on the same node.
             If there is no loop, the fast one just runs off the end.
Therefore  : slow moves 1 step, fast moves 2 steps.
             fast hits nil  → no cycle
             fast == slow   → cycle
Now        : O(1) space, no allocation at all.
```

### Why they must meet if a cycle exists

Once **both** pointers are inside the loop, look at the gap from fast to slow measured *around the loop*. Every step, fast advances 2 and slow advances 1, so that gap shrinks by exactly **1** per step.

A gap that decreases by exactly 1 each step can never jump over 0 — it must land on it. So they meet.

This is also why the step sizes must be 1 and 2. If fast moved 3 steps, the gap would shrink by 2 each time and could skip past 0 in an even-length loop.

### Finding where the cycle *starts* (the surprising part)

Detection gives you *a* node inside the loop, not the entrance. But there's a clean way to get the entrance:

> **Reset one pointer to `head`. Now advance both one step at a time. They meet exactly at the cycle entrance.**

Here is why, with the only algebra in this chapter. Let:

```text
L = steps from head to the cycle entrance
C = length of the cycle
k = steps from the entrance to the meeting point (around the cycle)
```

When they meet, slow has walked `L + k`, and fast has walked exactly twice that, `2(L + k)`. Fast's extra distance is whatever it gained by going around the loop some whole number of times:

```text
2(L + k) − (L + k) = L + k = m · C        for some integer m ≥ 1
```

Rearranged:

```text
L = m·C − k
```

Read that in plain English: **the distance from the head to the entrance is the same as the distance from the meeting point onward to the entrance** (possibly after a few extra full laps, which change nothing about where you land). So a pointer starting at `head` and a pointer starting at the meeting point, both moving one step at a time, arrive at the entrance together.

### Steps

```text
Phase 1 — detect
  Step 1 → slow = head, fast = head
  Step 2 → while fast != nil and fast.next != nil:
  Step 3 →     slow = slow.next          (1 step)
  Step 4 →     fast = fast.next.next     (2 steps)
  Step 5 →     if slow == fast → cycle found, go to phase 2
  Step 6 → fast ran off the end → no cycle

Phase 2 — locate the entrance
  Step 7 → p = head  (leave the other pointer at the meeting node)
  Step 8 → while p != meeting: advance BOTH by 1
  Step 9 → they meet at the cycle entrance
```

### Why the loop guard is `fast != nil && fast.next != nil`

Fast takes two steps, so both the node it stands on *and* the one after must exist before it moves. Checking only `fast != nil` crashes on an even-length list when `fast.next` is `nil`. This single condition also handles the empty list and the one-node list correctly.

### The same two pointers, other jobs

| Goal | Setup | Answer |
|---|---|---|
| Detect a cycle | slow +1, fast +2 | they meet ⇒ cycle |
| Cycle entrance | then reset one to head, both +1 | meeting node |
| **Middle** of the list | slow +1, fast +2 | slow, when fast hits the end |
| `k`-th from the end | fast starts `k` ahead, both +1 | slow, when fast hits the end |
| Is it a palindrome? | find the middle, reverse the half | compare halves |

### How should I recognize this?

```text
If you see...
  a linked list plus "O(1) extra space"
  "cycle", "loop", "does it repeat forever"
  "middle node", "k-th from the end", "reorder / palindrome list"
  a sequence where the next state depends only on the current one
        ↓
Think about...
  "Two pointers at different speeds — does the GAP tell me
   what I would otherwise have to store?"
        ↓
Use...
  slow += 1, fast += 2, guarded by (fast != nil && fast.next != nil)
```

> Beyond linked lists: the same trick finds cycles in any "next state" function — Happy Number (LeetCode 202) and Find the Duplicate Number (LeetCode 287) are both this pattern in disguise.

### Visual explanation

```svg
<svg viewBox="0 0 640 200" width="100%" height="200" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="fs-08" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">slow +1, fast +2 each step · fast reaches the end / meets in a cycle</text>
  <g>
    <rect x="40"  y="50" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="71"  y="78" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="122" y="50" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="153" y="78" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="204" y="50" width="62" height="46" rx="6" fill="#ecfdf5" stroke="#059669"/><text x="235" y="78" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="286" y="50" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="317" y="78" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="368" y="50" width="62" height="46" rx="6" fill="#fff7ed" stroke="#d97706"/><text x="399" y="78" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="450" y="50" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="481" y="78" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="532" y="50" width="62" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="563" y="78" text-anchor="middle" fill="#1e293b">7</text>
  </g>
  <text x="235" y="122" text-anchor="middle" fill="#059669" font-weight="700">slow</text>
  <text x="399" y="122" text-anchor="middle" fill="#d97706" font-weight="700">fast</text>
  <line x1="235" y1="136" x2="313" y2="136" stroke="#475569" marker-end="url(#fs-08)"/>
  <line x1="399" y1="150" x2="559" y2="150" stroke="#475569" marker-end="url(#fs-08)"/>
  <text x="274" y="132" text-anchor="middle" fill="#64748b">+1</text>
  <text x="479" y="166" text-anchor="middle" fill="#64748b">+2</text>
</svg>
```

```text
3 → 2 → 0 → -4
    ↑         │
    └─────────┘        (the tail links back to node "2")

start : slow=3  fast=3
step 1: slow=2  fast=0
step 2: slow=0  fast=2
step 3: slow=-4 fast=-4      ← they meet, so there is a cycle

phase 2: p=head(3), q=meeting(-4)
step 1 : p=2,       q=2      ← the cycle entrance
```

### Interview explanation
"I'll use Floyd's cycle detection: a slow pointer moving one node at a time and a fast pointer moving two. If the list ends, `fast` hits `nil` and there's no cycle. If there is a cycle, the gap between them shrinks by exactly one each step, so they must land on the same node. To find the entrance I then reset one pointer to `head` and advance both by one — because the head-to-entrance distance equals the meeting-point-to-entrance distance, they meet exactly at the start of the cycle. O(n) time, O(1) space."

---

## 5. Generic Templates

> `slow += 1`, `fast += 2`, always guarded by `fast != nil && fast.next != nil`.

```go
// HasCycle reports whether the list contains a cycle. O(1) space.
func HasCycle(head *ListNode) bool {
    slow, fast := head, head
    for fast != nil && fast.Next != nil {
        slow = slow.Next      // 1 step
        fast = fast.Next.Next // 2 steps
        if slow == fast {     // compare pointers, not values
            return true
        }
    }
    return false // fast ran off the end
}

// DetectCycleStart returns the first node of the cycle, or nil.
func DetectCycleStart(head *ListNode) *ListNode {
    slow, fast := head, head
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
        if slow == fast {
            // Phase 2: head-to-entrance == meeting-to-entrance.
            p := head
            for p != slow {
                p = p.Next
                slow = slow.Next
            }
            return p
        }
    }
    return nil
}

// MiddleNode returns the middle node (the second one if the length is even).
func MiddleNode(head *ListNode) *ListNode {
    slow, fast := head, head
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }
    return slow
}
```

```python
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

def has_cycle(head):
    slow = fast = head
    while fast and fast.next:
        slow = slow.next            # 1 step
        fast = fast.next.next       # 2 steps
        if slow is fast:            # identity, not equality
            return True
    return False

def detect_cycle_start(head):
    slow = fast = head
    while fast and fast.next:
        slow = slow.next
        fast = fast.next.next
        if slow is fast:
            p = head                # head-to-entrance == meeting-to-entrance
            while p is not slow:
                p = p.next
                slow = slow.next
            return p
    return None

def middle_node(head):
    slow = fast = head
    while fast and fast.next:
        slow = slow.next
        fast = fast.next.next
    return slow
```

```java
public class FastSlowPointer {
    public static class ListNode {
        int val; ListNode next;
        ListNode(int val) { this.val = val; }
    }

    public static boolean hasCycle(ListNode head) {
        ListNode slow = head, fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;            // 1 step
            fast = fast.next.next;       // 2 steps
            if (slow == fast) return true;
        }
        return false;
    }

    public static ListNode detectCycleStart(ListNode head) {
        ListNode slow = head, fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;
            fast = fast.next.next;
            if (slow == fast) {
                ListNode p = head;       // head-to-entrance == meeting-to-entrance
                while (p != slow) { p = p.next; slow = slow.next; }
                return p;
            }
        }
        return null;
    }

    public static ListNode middleNode(ListNode head) {
        ListNode slow = head, fast = head;
        while (fast != null && fast.next != null) {
            slow = slow.next;
            fast = fast.next.next;
        }
        return slow;
    }
}
```

```cpp
struct ListNode {
    int val;
    ListNode* next;
    explicit ListNode(int v) : val(v), next(nullptr) {}
};

bool hasCycle(ListNode* head) {
    ListNode *slow = head, *fast = head;
    while (fast && fast->next) {
        slow = slow->next;          // 1 step
        fast = fast->next->next;    // 2 steps
        if (slow == fast) return true;
    }
    return false;
}

ListNode* detectCycleStart(ListNode* head) {
    ListNode *slow = head, *fast = head;
    while (fast && fast->next) {
        slow = slow->next;
        fast = fast->next->next;
        if (slow == fast) {
            ListNode* p = head;     // head-to-entrance == meeting-to-entrance
            while (p != slow) { p = p->next; slow = slow->next; }
            return p;
        }
    }
    return nullptr;
}

ListNode* middleNode(ListNode* head) {
    ListNode *slow = head, *fast = head;
    while (fast && fast->next) {
        slow = slow->next;
        fast = fast->next->next;
    }
    return slow;
}
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Fast and Slow Pointer (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **O(n) or O(n log n)** |
| Time (best)  | — | **O(n) or O(n log n)** |
| Time (average) | — | **O(n) or O(n log n)** |
| Space | varies | **O(1)** |

> Sorting (if needed) dominates; the scan itself is O(n).

---

## 7. Common Mistakes

1. Forgetting to sort first when the technique requires sorted input.
2. Not skipping duplicates, producing repeated triplets/quadruplets.
3. Using `l <= r` when `l < r` is intended (or vice versa).
4. Advancing the wrong pointer and missing the answer.
5. Off-by-one at the boundaries (start at 0 and n-1).
6. Mutating original order when indices must map back to the input.
7. Integer overflow when summing large values.
8. Infinite loop from failing to move a pointer in some branch.
9. Assuming uniqueness of solution when multiple exist.
10. Mixing up reader/writer roles in same-direction variants.

---

## 8. Interview Follow-Up Questions

1. **Q: Why does sorted order let you move one pointer?**
   A: Monotonicity: increasing l raises the sum, decreasing r lowers it.

2. **Q: How to avoid duplicate triplets?**
   A: Skip equal neighbors after recording a hit.

3. **Q: Opposite vs same direction — when each?**
   A: Opposite for sorted pair/area problems; same direction for in-place filtering/windows.

4. **Q: Extend to 3Sum / 4Sum?**
   A: Fix outer elements, two-pointer the rest; generalize as k-sum recursion.

5. **Q: Unsorted input, can't sort?**
   A: Use a hash map (HashMap Lookup) for O(n) pair finding.

6. **Q: Container/area problems?**
   A: Move the pointer at the shorter wall to possibly increase area.

7. **Q: Cycle detection?**
   A: Fast/slow pointers (Floyd) detect cycles in O(1) space.

8. **Q: Palindrome check?**
   A: Converge from both ends comparing characters.

9. **Q: Stability of order?**
   A: Two-pointer partitioning can be unstable; note if order matters.

10. **Q: Complexity with sorting?**
   A: O(n log n) sort + O(n) scan = O(n log n).

11. **Q: Remove duplicates in place?**
   A: Writer index advances only on new values.

12. **Q: Dutch national flag?**
   A: Three pointers partition into <,=,> in one pass.

13. **Q: Find closest sum?**
   A: Track the minimal |sum - target| as pointers move.

14. **Q: Why O(1) space?**
   A: Only a few index variables beyond the input.

15. **Q: Multiple answers required?**
   A: Continue scanning after each hit, moving both pointers.

---

## 9. Solved Example 1

### Problem — Linked List Cycle (LeetCode 141)
Return `true` if the linked list has a cycle.

### Thought Process
1. A hash set of visited nodes works but costs O(n) memory.
2. Instead run two pointers at different speeds: `slow` one node per step, `fast` two.
3. No cycle → `fast` reaches the end and we return `false`.
4. Cycle → both eventually enter the loop, the gap between them shrinks by exactly 1 per step, so it must hit 0 and they land on the same node.
5. Compare **node identity**, not values — two different nodes may hold the same number.

### Dry Run

Input: `head = [3, 2, 0, -4]` with the tail linking back to the node with value `2` (index 1).

```text
index :  0     1     2     3
value :  3  →  2  →  0  →  -4
            ↑              │
            └──────────────┘
```

| step | slow (1×)      | fast (2×)        | same node? |
|------|----------------|------------------|------------|
| start| `3` (idx 0)    | `3` (idx 0)      | — (not yet moved) |
| 1    | `2` (idx 1)    | `0` (idx 2)      | no |
| 2    | `0` (idx 2)    | `2` (idx 1)      | no |
| 3    | `-4` (idx 3)   | `-4` (idx 3)     | **yes → `true`** |

Output: **`true`**

For a list with no cycle, say `[1, 2]`: step 1 gives `slow = 2`, `fast = nil` → loop guard fails → **`false`**.

### Visualization

```text
step 2:   3     2     0    -4
                ↑     ↑
              fast   slow          gap (around the loop) = 2

step 3:   3     2     0    -4
                            ↑↑
                        slow,fast   gap = 0  →  cycle detected
```

The gap goes 2 → 1 → 0. It shrinks by exactly one each step, so it can never skip past zero.

### Code

```go
func hasCycle(head *ListNode) bool {
    slow, fast := head, head
    // fast takes two steps, so both it and its successor must exist.
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
        if slow == fast { // pointer identity, not value equality
            return true
        }
    }
    return false // fast ran off the end: no cycle
}
```

```python
def hasCycle(head):
    slow = fast = head
    while fast and fast.next:      # fast needs two nodes ahead
        slow = slow.next
        fast = fast.next.next
        if slow is fast:           # identity, not value
            return True
    return False                   # fast ran off the end
```

### Complexity
Time O(n), Space **O(1)** — two pointers, no set.

---

## 10. Solved Example 2

### Problem — Linked List Cycle II (LeetCode 142)
Return the node where the cycle begins, or `nil` if there is no cycle.

### Thought Process
1. Phase 1 is exactly Problem 141 — but the meeting node is somewhere *inside* the loop, not its entrance.
2. Phase 2 uses the distance identity `L = m·C − k`: the head-to-entrance distance equals the meeting-point-to-entrance distance.
3. So reset one pointer to `head`, keep the other at the meeting node, and advance both **one** step at a time.
4. Where they meet is the entrance.

### Dry Run

Input: `head = [3, 2, 0, -4]`, tail links back to index 1.

**Phase 1** (from the previous example): they meet at index 3, the node `-4`.

**Phase 2:** `p = head` (index 0), `q = meeting` (index 3).

| step | p            | q                        | same? |
|------|--------------|--------------------------|-------|
| start| `3` (idx 0)  | `-4` (idx 3)             | no |
| 1    | `2` (idx 1)  | `2` (idx 1) — `-4.next`  | **yes** |

Output: the node with value **`2`** (index 1) — the cycle entrance. ✓

**Check the algebra:** `L = 1` (head → entrance), `C = 3` (the loop 1→2→3→1), `k = 2` (entrance → meeting). Indeed `L + k = 3 = 1 · C`, so `L = C − k = 1`. Both pointers needed exactly 1 step. ✓

### Visualization

```text
        L = 1        ┌──── C = 3 ────┐
head → [3] ───────► [2] → [0] → [-4]
                     ↑              │
                     └──────────────┘
                     entrance    meeting (k = 2 from entrance)

from head    : 1 step  → entrance
from meeting : 1 step  → entrance     (C - k = 3 - 2 = 1)
```

### Code

```go
func detectCycle(head *ListNode) *ListNode {
    slow, fast := head, head

    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next

        if slow == fast {
            // Phase 2: head-to-entrance equals meeting-to-entrance.
            p := head
            for p != slow {
                p = p.Next
                slow = slow.Next
            }
            return p
        }
    }
    return nil // no cycle
}
```

```python
def detectCycle(head):
    slow = fast = head
    while fast and fast.next:
        slow = slow.next
        fast = fast.next.next
        if slow is fast:
            p = head                 # head-to-entrance == meeting-to-entrance
            while p is not slow:
                p = p.next
                slow = slow.next
            return p
    return None
```

### Complexity
Time O(n) — each phase is at most one traversal. Space O(1).

---

## 11. Solved Example 3

### Problem — Middle of the Linked List (LeetCode 876)
Return the middle node. If there are two middles, return the **second** one.

### Thought Process
1. Counting the length then walking half of it needs two passes; we can do it in one.
2. If `fast` moves exactly twice as fast as `slow`, then whenever `fast` has covered `d` nodes, `slow` has covered `d/2`.
3. So when `fast` falls off the end, `slow` is sitting at the middle.
4. The loop guard `fast != nil && fast.next != nil` naturally produces the **second** middle on even-length lists — which is exactly what this problem wants.

### Dry Run — odd length

Input: `[1, 2, 3, 4, 5]`

| step | slow | fast | guard `fast != nil && fast.next != nil` |
|------|------|------|------------------------------------------|
| start| 1    | 1    | ok |
| 1    | 2    | 3    | ok |
| 2    | 3    | 5    | `fast.next == nil` → stop |

Output: node **`3`** → the list from there is `[3, 4, 5]`. ✓

### Dry Run — even length

Input: `[1, 2, 3, 4, 5, 6]`

| step | slow | fast | guard |
|------|------|------|-------|
| start| 1    | 1    | ok |
| 1    | 2    | 3    | ok |
| 2    | 3    | 5    | ok |
| 3    | 4    | nil  | `fast == nil` → stop |

Output: node **`4`** — the **second** of the two middles (`3` and `4`), as required. ✓

### Visualization

```text
[1] [2] [3] [4] [5]
 ↑           ↑
slow        fast          after 2 steps: slow travelled 2, fast travelled 4
     slow is always at exactly half of fast's distance

[1] [2] [3] [4] [5] [6]
             ↑           fast fell off the end → slow = second middle
```

### Code

```go
func middleNode(head *ListNode) *ListNode {
    slow, fast := head, head
    for fast != nil && fast.Next != nil {
        slow = slow.Next      // covers half the ground...
        fast = fast.Next.Next // ...of fast
    }
    return slow // fast is done, so slow is at the middle
}
```

```python
def middleNode(head):
    slow = fast = head
    while fast and fast.next:
        slow = slow.next          # covers half the ground...
        fast = fast.next.next     # ...of fast
    return slow
```

### Complexity
Time O(n) — a single pass. Space O(1).

> Want the **first** middle on even-length lists instead? Change the guard to `fast.Next != nil && fast.Next.Next != nil`. That single choice is the source of most off-by-one bugs in list problems.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 141 | Linked List Cycle | Easy | Core two pointers application |
| 142 | Cycle II | Easy | Core two pointers application |
| 876 | Middle of List | Medium | Core two pointers application |
| 202 | Happy Number | Medium | Core two pointers application |

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

- **Opposite-direction (converging)**
- **Same-direction (reader/writer)**
- **Fast & slow (cycle/middle)**
- **Three-way partition (Dutch flag)**
- **k-Sum recursion**
- **Container/area maximization**

---

## 14. Production Engineering Applications

- **Scalability:** Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **O(1)**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Fast and Slow Pointer logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Fast and Slow Pointer (Two Pointers).
- **Signal:** floyd, cycle, tortoise hare, middle, linked list cycle.
- **Move:** Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.
- **Cost:** O(n) or O(n log n) time, O(1) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Fast and Slow Pointer invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Fast and Slow Pointer
FAMILY : Two Pointers (Intermediate)
WHEN   : floyd, cycle, tortoise hare, middle, linked list cycle
DO     : Maintain two indices and an invariant that tells you which pointer to advance, e
TIME   : O(n) or O(n log n)    SPACE: O(1)
PRACTICE: 141, 142, 876, 202
```

---

*Part of the DSA Patterns Handbook — pattern 08 of 100.*
