# 89 · Trie

> **One-liner:** Prefix tree for fast word/prefix lookups and autocomplete.

---

## 1. Overview

### Definition
The **Trie** pattern belongs to the *Advanced* family. Prefix tree for fast word/prefix lookups and autocomplete.

### Intuition
Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.

### Why it works
Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile. Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.

---

## 2. Recognition Signals

### Keywords
trie, prefix tree, autocomplete, word dictionary, insert search.

### Constraints
- Input size where the brute-force complexity would time out — the Trie optimization is the intended solution.
- Structural hints in the statement that match this family (Advanced).

### Hidden clues
- The problem can be reframed so the Trie invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — Trie is the upgrade.
- The wording maps onto: trie, prefix tree, autocomplete, word dictionary, insert search.

---

## 3. Brute Force Approach

**The question this pattern keeps answering:** *"Is there any word in my dictionary that **starts with** this string — and what are they?"*

Running example: dictionary `{cat, car, card, dog}`; queries like `startsWith("ca")` and `search("car")`.

### Intuition
Keep the words in a list (or a hash set) and, for every prefix query, look at each word and check whether the prefix matches its first few letters.

### Algorithm
1. Store the words in a slice: `["cat", "car", "card", "dog"]`.
2. For `search(word)`: compare `word` against every stored word.
3. For `startsWith(p)`: for every stored word `w`, compare `p` with `w[0:len(p)]`.
4. Return as soon as something matches; otherwise return false.

### Complexity
- Time: **O(N · L)** per query — `N` words, up to `L` characters compared each.
- Space: O(total characters) — every word stored in full.

### Drawbacks
- **A hash set cannot help here at all.** `set.Contains("car")` is O(1), but a hash of `"car"` tells you nothing about `"card"`; the hash of a prefix has no relationship to the hash of the word. So prefix queries fall back to a full scan.
- **The same letters are re-read over and over.** For `startsWith("ca")` on the dictionary above:

  ```text
  "cat"  → compare 'c','a'   ← 2 comparisons
  "car"  → compare 'c','a'   ← the SAME 2 comparisons
  "card" → compare 'c','a'   ← the SAME 2 comparisons again
  "dog"  → compare 'd'       ← fails on letter 1
  ```

  Three identical two-letter walks. The words physically share the prefix `ca`, and the brute force refuses to notice.
- The fact being wasted: **words that share a prefix agree on their first letters**. One walk should decide all of them at once.

---

## 4. Optimal Approach

### Core idea

One sentence:

> **Store the letters, not the words: make every node in a tree stand for one prefix, and let its children be the letters that may follow it.**

Think of a filing cabinet with 26 drawers. Drawer `c` holds everything beginning with `c`. Inside it are 26 more drawers; drawer `a` holds everything beginning with `ca`. Following a word is just opening drawers, one letter at a time. Reaching a drawer *is* the answer to "does any word start with this?" — you never look at the words themselves.

### The thought process

```text
We need    : "does any word start with P?" and "is W an exact word?", fast.
Obvious way: keep the words in a list and scan.
Too slow   : O(N·L) per query, and hashing cannot shortcut prefixes.
Notice     : cat, car, card all begin with "ca" — the scan walks 'c','a'
             three separate times over three separate strings.
Therefore  : merge shared prefixes into one path. One node = one prefix.
Now        : a query walks len(query) nodes and stops. O(L), independent of N.
```

### Why one node per prefix is the right shape

Ask what a query actually needs. `startsWith("ca")` does not care *which* words follow — only whether the path `c → a` exists. So the structure only has to answer "can I keep walking?".

That gives the node its job: **a node is a prefix, and its children are exactly the letters that legally extend that prefix.**

Inserting `cat`, `car`, `card`, `dog` builds this (`*` = a word ends here):

```text
            (root)          ← the empty prefix ""
            /    \
           c      d         ← prefixes "c" and "d"
           |      |
           a      o         ← prefixes "ca" and "do"
          / \     |
        t*   r*   g*        ← "cat", "car", "dog"
              |
              d*            ← "card"
```

Read any node as the string spelled by the path from the root down to it. `t` and `r` are **siblings** — both are ways to extend `ca` — not a chain.

Two things worth naming:

1. **The saving is real.** The four words are 13 characters; the trie has 9 nodes. `c` and `a` are stored **once** and serve three words. With a dictionary of a million URLs all starting `https://`, the saving is enormous.
2. **`isWord` is not optional.** Look at node `r`. The path `c→a→r` exists because of `card`, so "does the path exist" is true — but is `car` itself a word? Only the `isWord` flag can say. Without it, `search("car")` and `search("ca")` would both wrongly return true.

That is the whole difference between the two operations:

| Operation | Walk the path | Then check |
|---|---|---|
| `startsWith(p)` | `p`'s letters | did I land on a node at all? |
| `search(w)` | `w`'s letters | did I land on a node **with `isWord`**? |

### Steps

```text
Step 1 → Insert(word): start at root.
Step 2 →   For each letter: if the child is missing, create it. Move into it.
Step 3 →   At the end, set isWord = true on the node you landed on.
Step 4 → Walk(s): start at root, follow each letter's child.
Step 5 →   If a child is nil, the path falls off the trie → return nil.
Step 6 → StartsWith(p) = Walk(p) != nil
Step 7 → Search(w)     = Walk(w) != nil AND that node's isWord
```

### How should I recognize this?

```text
If you see...
  "prefix", "autocomplete", "starts with", "dictionary of words"
  a set of strings queried MANY times (design / online problems)
  words with a shared alphabet and modest length (words[i].length <= 10..2000)
  a DFS on a grid/board that must test many candidate words
        ↓
Think about...
  "Am I being asked about prefixes, not whole strings?
   Are lots of my strings sharing their opening letters?"
        ↓
Use...
  a trie: node = prefix, children[26] = next letter, isWord = ends here.
    · plain lookup / autocomplete   → Insert + Walk
    · wildcards ('.')               → recurse over all 26 children on '.'
    · search many words in a grid   → walk the board and the trie together,
                                      prune the moment the child is nil
```

### Visual explanation

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="tr-89" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="320" y="20" text-anchor="middle" font-weight="700" fill="#1e293b">Trie of {cat, car, dog} &amp; one shared prefix "ca"</text>
  <!-- edges -->
  <line x1="320" y1="52" x2="210" y2="92"  stroke="#475569" marker-end="url(#tr-89)"/>
  <line x1="320" y1="52" x2="450" y2="92"  stroke="#475569" marker-end="url(#tr-89)"/>
  <line x1="200" y1="112" x2="200" y2="152" stroke="#475569" marker-end="url(#tr-89)"/>
  <line x1="190" y1="172" x2="150" y2="202" stroke="#475569" marker-end="url(#tr-89)"/>
  <line x1="210" y1="172" x2="255" y2="202" stroke="#475569" marker-end="url(#tr-89)"/>
  <line x1="450" y1="112" x2="450" y2="152" stroke="#475569" marker-end="url(#tr-89)"/>
  <line x1="450" y1="172" x2="450" y2="202" stroke="#475569" marker-end="url(#tr-89)"/>
  <!-- root -->
  <circle cx="320" cy="42" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="320" y="46" text-anchor="middle" fill="#64748b">•</text>
  <!-- c / d -->
  <circle cx="200" cy="102" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="107" text-anchor="middle" fill="#1e293b">c</text>
  <circle cx="450" cy="102" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="450" y="107" text-anchor="middle" fill="#1e293b">d</text>
  <!-- a / o -->
  <circle cx="200" cy="162" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="200" y="167" text-anchor="middle" fill="#1e293b">a</text>
  <circle cx="450" cy="162" r="16" fill="#eff6ff" stroke="#2563eb"/><text x="450" y="167" text-anchor="middle" fill="#1e293b">o</text>
  <!-- leaves (end of word) -->
  <circle cx="145" cy="216" r="16" fill="#ecfdf5" stroke="#059669"/><text x="145" y="221" text-anchor="middle" fill="#1e293b">t</text>
  <circle cx="260" cy="216" r="16" fill="#ecfdf5" stroke="#059669"/><text x="260" y="221" text-anchor="middle" fill="#1e293b">r</text>
  <circle cx="450" cy="216" r="16" fill="#ecfdf5" stroke="#059669"/><text x="450" y="221" text-anchor="middle" fill="#1e293b">g</text>
  <text x="540" y="212" text-anchor="middle" fill="#059669" font-weight="700">green =</text>
  <text x="540" y="228" text-anchor="middle" fill="#059669" font-weight="700">isEnd</text>
</svg>
```

```text
insert cat, car, card, dog          startsWith("ca")   →  root -c-> -a->  ✔ (node exists)
                                     search("ca")      →  lands on 'a', isWord=false  ✘
   root                              search("car")     →  lands on 'r', isWord=true   ✔
   ├─ c                              search("ca")      →  ONE walk decided all three
   │  └─ a                                                words at once
   │     ├─ t *
   │     └─ r *
   │        └─ d *
   └─ d
      └─ o
         └─ g *

9 nodes for 13 letters — "c" and "a" are stored once and shared.
```

### Interview explanation
"A hash set answers exact membership in O(1) but is useless for prefixes, because hashing `car` tells you nothing about `card`. So I'll build a trie: each node represents one prefix and holds up to 26 child pointers, one per next letter. Insert walks the word creating missing children and flags the last node as a word end; `startsWith` just checks that the walk didn't fall off, and `search` additionally checks that end-of-word flag — that flag is what separates `car` the word from `car` the prefix of `card`. Every operation is O(L) in the length of the query string and completely independent of how many words are stored, at a cost of O(total characters × 26) pointers."

---

## 5. Generic Templates

> One node per prefix; children are the next letters; a flag marks where words end.

```go
// TrieNode represents exactly one prefix.
// children[c] is the node for that prefix extended by the letter 'a'+c.
type TrieNode struct {
    children [26]*TrieNode
    isWord   bool // some inserted word ends exactly here
}

// Trie stores a set of lowercase words, sharing their common prefixes.
type Trie struct{ root *TrieNode }

func NewTrie() *Trie { return &Trie{root: &TrieNode{}} }

// Insert walks the word's letters, creating nodes that do not exist yet.
func (t *Trie) Insert(word string) {
    node := t.root
    for i := 0; i < len(word); i++ {
        c := word[i] - 'a'
        if node.children[c] == nil {
            node.children[c] = &TrieNode{}
        }
        node = node.children[c]
    }
    node.isWord = true
}

// walk follows s from the root and returns the node it lands on,
// or nil if the path falls off the trie.
func (t *Trie) walk(s string) *TrieNode {
    node := t.root
    for i := 0; i < len(s); i++ {
        node = node.children[s[i]-'a']
        if node == nil {
            return nil
        }
    }
    return node
}

// Search reports whether this exact word was inserted.
func (t *Trie) Search(word string) bool {
    node := t.walk(word)
    return node != nil && node.isWord
}

// StartsWith reports whether any inserted word has this prefix.
func (t *Trie) StartsWith(prefix string) bool {
    return t.walk(prefix) != nil
}
```

```python
class TrieNode:
    __slots__ = ("children", "is_word")

    def __init__(self):
        self.children = {}      # letter -> TrieNode
        self.is_word = False    # some inserted word ends exactly here


class Trie:
    def __init__(self):
        self.root = TrieNode()

    def insert(self, word):
        node = self.root
        for ch in word:
            if ch not in node.children:
                node.children[ch] = TrieNode()
            node = node.children[ch]
        node.is_word = True

    def _walk(self, s):
        """Node reached by following s, or None if the path falls off."""
        node = self.root
        for ch in s:
            node = node.children.get(ch)
            if node is None:
                return None
        return node

    def search(self, word):
        node = self._walk(word)
        return node is not None and node.is_word

    def starts_with(self, prefix):
        return self._walk(prefix) is not None
```

```java
public class Trie {
    private static class Node {
        Node[] children = new Node[26];
        boolean isWord;                 // some word ends exactly here
    }

    private final Node root = new Node();

    public void insert(String word) {
        Node node = root;
        for (char ch : word.toCharArray()) {
            int c = ch - 'a';
            if (node.children[c] == null) node.children[c] = new Node();
            node = node.children[c];
        }
        node.isWord = true;
    }

    /** Node reached by following s, or null if the path falls off the trie. */
    private Node walk(String s) {
        Node node = root;
        for (char ch : s.toCharArray()) {
            node = node.children[ch - 'a'];
            if (node == null) return null;
        }
        return node;
    }

    public boolean search(String word) {
        Node node = walk(word);
        return node != null && node.isWord;
    }

    public boolean startsWith(String prefix) {
        return walk(prefix) != null;
    }
}
```

```cpp
#include <string>
using namespace std;

struct TrieNode {
    TrieNode* children[26] = {};
    bool isWord = false;            // some word ends exactly here
};

class Trie {
public:
    void insert(const string& word) {
        TrieNode* node = &root;
        for (char ch : word) {
            int c = ch - 'a';
            if (!node->children[c]) node->children[c] = new TrieNode();
            node = node->children[c];
        }
        node->isWord = true;
    }

    bool search(const string& word) const {
        const TrieNode* node = walk(word);
        return node && node->isWord;
    }

    bool startsWith(const string& prefix) const { return walk(prefix) != nullptr; }

private:
    TrieNode root;

    // Node reached by following s, or nullptr if the path falls off.
    const TrieNode* walk(const string& s) const {
        const TrieNode* node = &root;
        for (char ch : s) {
            node = node->children[ch - 'a'];
            if (!node) return nullptr;
        }
        return node;
    }
};
```

---

## 6. Complexity Analysis

| Metric | Brute Force | Trie (Optimal) |
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

### Problem — Implement Trie (LeetCode 208)
Design a data structure supporting three operations on lowercase words: `insert(word)`, `search(word)` (was this **exact** word inserted?) and `startsWith(prefix)` (does **any** inserted word begin with this prefix?).

### Thought Process
1. `search` alone could be a hash set — but `startsWith` cannot, because a prefix's hash says nothing about the word's hash.
2. So walk the string letter by letter: one node per prefix, 26 child slots per node.
3. `insert` creates missing children as it walks, then flags the final node `isWord`.
4. Both queries share the same walk; factor it into one helper that returns the landing node or `nil`.
5. `startsWith` = "the walk survived". `search` = "the walk survived **and** `isWord`".

### Dry Run

Input: `insert("apple")`, `search("apple")`, `search("app")`, `startsWith("app")`, `insert("app")`, `search("app")`

| # | Operation | Path walked | Landed on | `isWord` there | Result |
|---|-----------|-------------|-----------|----------------|--------|
| 1 | `insert("apple")` | creates `a→p→p→l→e` | node `e` | set to **true** | — |
| 2 | `search("apple")` | `a→p→p→l→e` ✔ | node `e` | true | **true** |
| 3 | `search("app")` | `a→p→p` ✔ | node `app` | **false** | **false** |
| 4 | `startsWith("app")` | `a→p→p` ✔ | node `app` | (not checked) | **true** |
| 5 | `insert("app")` | `a→p→p` already exists | node `app` | set to **true** | — |
| 6 | `search("app")` | `a→p→p` ✔ | node `app` | **true** | **true** |

Output: **`true, false, true, true`**

Rows 3 and 4 are the whole lesson: the *same* landing node gives `false` for `search` and `true` for `startsWith`. Row 5 changes nothing structurally — it only flips one boolean — and that flips row 6.

### Visualization

```text
after insert("apple"):

  root
   └─ a ─ p ─ p ─ l ─ e*        (* = isWord)
              ↑
        search("app") lands here, isWord = false  → false
        startsWith("app") lands here              → true

after insert("app"):

  root
   └─ a ─ p ─ p*─ l ─ e*        one flag flipped, no new nodes
              ↑
        search("app") → true
```

### Code

```go
type trieNode struct {
    children [26]*trieNode
    isWord   bool // an inserted word ends exactly here
}

type Trie struct{ root *trieNode }

func NewTrie() *Trie { return &Trie{root: &trieNode{}} }

func (t *Trie) Insert(word string) {
    node := t.root
    for i := 0; i < len(word); i++ {
        c := word[i] - 'a'
        if node.children[c] == nil {
            node.children[c] = &trieNode{}
        }
        node = node.children[c]
    }
    node.isWord = true
}

// walk follows s from the root; nil means the path fell off the trie.
func (t *Trie) walk(s string) *trieNode {
    node := t.root
    for i := 0; i < len(s); i++ {
        node = node.children[s[i]-'a']
        if node == nil {
            return nil
        }
    }
    return node
}

func (t *Trie) Search(word string) bool {
    node := t.walk(word)
    return node != nil && node.isWord // the flag is what makes "car" != "ca"
}

func (t *Trie) StartsWith(prefix string) bool {
    return t.walk(prefix) != nil // landing anywhere is enough
}
```

```python
class Trie:
    def __init__(self):
        self.children = {}     # letter -> Trie node
        self.is_word = False

    def insert(self, word):
        node = self
        for ch in word:
            if ch not in node.children:
                node.children[ch] = Trie()
            node = node.children[ch]
        node.is_word = True

    def _walk(self, s):
        node = self
        for ch in s:
            node = node.children.get(ch)
            if node is None:
                return None
        return node

    def search(self, word):
        node = self._walk(word)
        return node is not None and node.is_word

    def startsWith(self, prefix):
        return self._walk(prefix) is not None
```

### Complexity
Time O(L) per operation — `L` = length of the query string; the number of stored words never enters the cost. Space O(total inserted characters × 26) pointers in the worst case, far less when prefixes are shared.

---

## 10. Solved Example 2

### Problem — Word Dictionary (LeetCode 211)
Same as a trie, but `search(word)` may contain the wildcard `'.'`, which matches **any single letter**. `addWord("bad")` then `search(".ad")` must return `true`.

### Thought Process
1. Without wildcards this is exactly LeetCode 208 — a plain trie walk.
2. A `'.'` means "I don't know which child to take", so the walk stops being a single path.
3. Turn the loop into recursion: at a normal letter, descend into that one child; at `'.'`, **try all 26 children** and succeed if any branch succeeds.
4. Base case: characters exhausted → answer is that node's `isWord`.
5. Cost: each `'.'` multiplies the branching by up to 26, so worst case O(26^d · L) with `d` dots — fine because words are short.

### Dry Run

Input: `addWord("bad")`, `addWord("dad")`, `addWord("mad")`, then four searches.

The trie after the three inserts:

```text
root ─┬─ b ─ a ─ d*
      ├─ d ─ a ─ d*
      └─ m ─ a ─ d*
```

| # | Query | Step-by-step | Result |
|---|-------|--------------|--------|
| 1 | `search("pad")` | at root, need child `p` → **missing** → stop | **false** |
| 2 | `search("bad")` | `b` ✔ → `a` ✔ → `d` ✔, `isWord` = true | **true** |
| 3 | `search(".ad")` | `.` at root → try `b`: `b`→`a`→`d`, `isWord` ✔ | **true** |
| 4 | `search("b..")` | `b` ✔ → `.` → only child `a` ✔ → `.` → only child `d`, `isWord` ✔ | **true** |

Output: **`false, true, true, true`**

Row 3 shows the branching: the wildcard tried child `b` first and it happened to work, so `d` and `m` were never explored. Had `"..d"` been queried with only `bad` stored, the recursion would have tried all 26 first letters and 25 of them would have returned immediately on a `nil` child — that early `nil` check is what keeps wildcards cheap in practice.

### Visualization

```text
search(".ad")            search("b..")

   root                     root
  / | \  ← '.' fans out      |  ← 'b' is a normal letter: one child
 b  d  m                     b
 |                           |  ← '.' fans out, but only 'a' exists
 a  (first branch tried)     a
 |                           |  ← '.' fans out, but only 'd' exists
 d*  isWord → TRUE           d*  isWord → TRUE
```

### Code

```go
type dictNode struct {
    children [26]*dictNode
    isWord   bool
}

type WordDictionary struct{ root *dictNode }

func NewWordDictionary() *WordDictionary {
    return &WordDictionary{root: &dictNode{}}
}

func (d *WordDictionary) AddWord(word string) {
    node := d.root
    for i := 0; i < len(word); i++ {
        c := word[i] - 'a'
        if node.children[c] == nil {
            node.children[c] = &dictNode{}
        }
        node = node.children[c]
    }
    node.isWord = true
}

func (d *WordDictionary) Search(word string) bool {
    return dictMatch(d.root, word, 0)
}

// dictMatch reports whether word[i:] can be matched starting at node.
func dictMatch(node *dictNode, word string, i int) bool {
    if node == nil {
        return false
    }
    if i == len(word) {
        return node.isWord // characters exhausted: must land on a word end
    }
    if word[i] == '.' {
        for c := 0; c < 26; c++ { // wildcard: any child may work
            if dictMatch(node.children[c], word, i+1) {
                return true
            }
        }
        return false
    }
    return dictMatch(node.children[word[i]-'a'], word, i+1)
}
```

```python
class WordDictionary:
    def __init__(self):
        self.children = {}
        self.is_word = False

    def addWord(self, word):
        node = self
        for ch in word:
            if ch not in node.children:
                node.children[ch] = WordDictionary()
            node = node.children[ch]
        node.is_word = True

    def search(self, word):
        return self._match(word, 0)

    def _match(self, word, i):
        if i == len(word):
            return self.is_word          # ran out of letters: must be a word end
        ch = word[i]
        if ch == '.':                    # wildcard: any child may work
            return any(child._match(word, i + 1) for child in self.children.values())
        child = self.children.get(ch)
        return child is not None and child._match(word, i + 1)
```

### Complexity
Time O(L) when the query has no dots; worst case O(26^d · L) with `d` wildcards, since each dot fans out over 26 children. `addWord` is O(L). Space O(total characters) for the trie plus O(L) recursion depth.

---

## 11. Solved Example 3

### Problem — Word Search II (LeetCode 212)
Given an `m × n` board of letters and a list of words, return every word that can be spelled by a path of **adjacent** cells (up/down/left/right), using each cell at most once per word.

### Thought Process
1. Doing one DFS per word costs `O(words × cells × 4^L)` — and re-walks the same board prefixes for every word.
2. Flip it: walk the board **once**, carrying a pointer into a trie built from all the words.
3. At each step, look up the current letter as a child of the current trie node. If it's `nil`, **no word in the whole dictionary continues this way** — prune the entire subtree immediately.
4. Store the finished word on its end node so a hit needs no string building; blank it after reporting to avoid duplicates.
5. Mark visited cells in place (`'#'`) and restore them on the way out.

### Dry Run

Input: `board = [['c','a'], ['t','r']]`, `words = ["cat", "car", "ca", "rat"]`

```text
board            trie of the 4 words
 (0,0) (0,1)       root ─┬─ c ─ a* ─┬─ t*        (* = word ends here)
   c     a               │          └─ r*
 (1,0) (1,1)             └─ r ─ a ─ t*
   t     r
```
Adjacency: `c–a`, `c–t`, `a–r`, `t–r`.

| Start cell | Trie node reached | Word ends here? | Next move | Outcome |
|---|---|---|---|---|
| `(0,0)='c'` | `c` | no | try `(1,0)='t'` | `c→t` missing in trie → **prune** |
| | | | try `(0,1)='a'` | `c→a` exists |
| `(0,1)='a'` | `ca` | **yes → collect `"ca"`** | try `(1,1)='r'` | `ca→r` exists |
| `(1,1)='r'` | `car` | **yes → collect `"car"`** | try `(1,0)='t'` | `car→t` missing → **prune** |
| `(0,1)='a'` | — | — | try `(0,0)` | already visited (`'#'`) |
| `(0,1)='a'` (start) | root has no child `a` | — | — | **prune at step 0** |
| `(1,0)='t'` (start) | root has no child `t` | — | — | **prune at step 0** |
| `(1,1)='r'` (start) | `r` | no | `(0,1)='a'` → `ra` exists, not a word | then `ra→c` missing → **prune** |

Output: **`["ca", "car"]`**

`"cat"` is in the dictionary but `t` is not adjacent to `a` on this board, so the walk never reaches it — and notice the trie told us that in one comparison (`car→t` is `nil`), not by trying to match a whole string. Two of the four starting cells were rejected before a single step, because the root has no `a` and no `t` child.

### Visualization

```text
board walk carrying a trie pointer (▲ = current trie node)

  start (0,0) 'c'          move to (0,1) 'a'         move to (1,1) 'r'
  root ─ c ▲               root ─ c ─ a ▲            root ─ c ─ a ─ r ▲
         #  a                     #    #                    #    #    #
         t  r                     t    r                    t    #

  nothing collected        collect "ca"              collect "car"
  (0,0) marked '#'         (0,1) marked '#'          next letter 't':
                                                     child is nil → PRUNE
```

### Code

```go
type wordNode struct {
    children [26]*wordNode
    word     string // non-empty only at an end-of-word node: the word itself
}

func findWords(board [][]byte, words []string) []string {
    root := &wordNode{}
    for _, w := range words { // build one trie from ALL the words
        node := root
        for i := 0; i < len(w); i++ {
            c := w[i] - 'a'
            if node.children[c] == nil {
                node.children[c] = &wordNode{}
            }
            node = node.children[c]
        }
        node.word = w
    }

    rows, cols := len(board), len(board[0])
    found := []string{}

    var dfs func(r, c int, node *wordNode)
    dfs = func(r, c int, node *wordNode) {
        if r < 0 || r >= rows || c < 0 || c >= cols {
            return
        }
        letter := board[r][c]
        if letter == '#' { // already used on this path
            return
        }
        child := node.children[letter-'a']
        if child == nil { // no dictionary word continues this way
            return
        }
        if child.word != "" {
            found = append(found, child.word)
            child.word = "" // report each word once
        }
        board[r][c] = '#'
        dfs(r+1, c, child)
        dfs(r-1, c, child)
        dfs(r, c+1, child)
        dfs(r, c-1, child)
        board[r][c] = letter // restore for other paths
    }

    for r := 0; r < rows; r++ {
        for c := 0; c < cols; c++ {
            dfs(r, c, root)
        }
    }
    return found
}
```

```python
def findWords(board, words):
    root = {}
    for w in words:                       # build one trie from ALL the words
        node = root
        for ch in w:
            node = node.setdefault(ch, {})
        node["$"] = w                     # "$" marks an end node, holding the word

    rows, cols = len(board), len(board[0])
    found = []

    def dfs(r, c, node):
        if not (0 <= r < rows and 0 <= c < cols):
            return
        letter = board[r][c]
        child = node.get(letter)
        if child is None:                 # no dictionary word continues this way
            return
        if "$" in child:
            found.append(child.pop("$"))  # report each word once
        board[r][c] = "#"
        dfs(r + 1, c, child)
        dfs(r - 1, c, child)
        dfs(r, c + 1, child)
        dfs(r, c - 1, child)
        board[r][c] = letter              # restore for other paths

    for r in range(rows):
        for c in range(cols):
            dfs(r, c, root)
    return found
```

### Complexity
Time O(total letters in `words`) to build the trie, plus O(rows × cols × 4 × 3^(L−1)) for the search, where `L` is the longest word — the trie prune is what keeps the real running time far below that bound. Space O(total letters) for the trie plus O(L) recursion depth; the board is modified in place, so no visited matrix is needed.

---

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
| 208 | Implement Trie | Easy | Core advanced application |
| 211 | Word Dictionary | Easy | Core advanced application |
| 212 | Word Search II | Medium | Core advanced application |
| 648 | Replace Words | Medium | Core advanced application |

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
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same Trie logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** Trie (Advanced).
- **Signal:** trie, prefix tree, autocomplete, word dictionary, insert search.
- **Move:** Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.
- **Cost:** Varies (often O(log n) per op) time, O(n) to O(n log n) space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the Trie invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: Trie
FAMILY : Advanced (Expert)
WHEN   : trie, prefix tree, autocomplete, word dictionary, insert search
DO     : Match the data structure to the operation mix: range queries → segment/Fenwick; 
TIME   : Varies (often O(log n) per op)    SPACE: O(n) to O(n log n)
PRACTICE: 208, 211, 212, 648
```

---

*Part of the DSA Patterns Handbook — pattern 89 of 100.*
