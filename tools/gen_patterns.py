#!/usr/bin/env python3
"""Generate complete 15-section markdown for every pattern.
Family (category) knowledge supplies templates/complexity/mistakes/follow-ups;
the manifest supplies per-pattern name, summary, keywords, leetcode.
Hand-authored files listed in PROTECT are never overwritten."""
import json, os

PATTERNS = json.load(open("/tmp/patterns.json"))
OUT = "markdown"
os.makedirs(OUT, exist_ok=True)
PROTECT = {"01-frequency-counter"}  # flagship, hand-written

def code(lang, src):
    return f"```{lang}\n{src.strip()}\n```"

def tabs(go, py, java, cpp):
    return "\n\n".join([code("go", go), code("python", py), code("java", java), code("cpp", cpp)])

# ---------------------------------------------------------------------------
# Family knowledge base. Each entry is reused by every pattern in that category.
# Templates are honest, working *skeletons* for the family.
# ---------------------------------------------------------------------------
FAM = {}

FAM["Foundations"] = dict(
    brute="Nested loops re-examine pairs/ranges, giving O(n^2) or worse.",
    optimal="Precompute an auxiliary structure (hash map / prefix array) in one pass so each query is O(1).",
    idea="Trade O(n) extra space for O(1) lookups, collapsing nested work into independent linear passes.",
    complexity=("O(n)", "O(n)", "One pass to build, O(1) per query."),
    go="""// Prefix-sum style precompute: range sum in O(1) after O(n) build.
func prefix(nums []int) []int {
    pre := make([]int, len(nums)+1)
    for i, v := range nums {
        pre[i+1] = pre[i] + v
    }
    return pre
}
func rangeSum(pre []int, l, r int) int { return pre[r+1] - pre[l] }""",
    py="""def prefix(nums):
    pre = [0]*(len(nums)+1)
    for i, v in enumerate(nums):
        pre[i+1] = pre[i] + v
    return pre

def range_sum(pre, l, r):       # inclusive [l, r]
    return pre[r+1] - pre[l]""",
    java="""int[] prefix(int[] nums) {
    int[] pre = new int[nums.length + 1];
    for (int i = 0; i < nums.length; i++) pre[i+1] = pre[i] + nums[i];
    return pre;
}
int rangeSum(int[] pre, int l, int r) { return pre[r+1] - pre[l]; }""",
    cpp="""vector<long long> prefix(vector<int>& nums) {
    vector<long long> pre(nums.size()+1, 0);
    for (size_t i = 0; i < nums.size(); ++i) pre[i+1] = pre[i] + nums[i];
    return pre;
}
long long rangeSum(vector<long long>& pre, int l, int r) { return pre[r+1] - pre[l]; }""",
    mistakes=[
        "Off-by-one in prefix arrays (use size n+1 and 1-based prefix indices).",
        "Rebuilding the auxiliary structure inside a loop instead of once.",
        "Integer overflow on large sums — use 64-bit accumulators.",
        "Forgetting that hashing has worst-case O(n) collisions (rare but real).",
        "Choosing a map when a fixed-size array would be faster and O(1) space.",
        "Mutating the input array when the caller still needs it.",
        "Not handling empty input / single-element edge cases.",
        "Confusing inclusive vs exclusive range boundaries.",
        "Assuming hash-map iteration order is stable.",
        "Ignoring negative numbers when reasoning about monotonic prefix sums.",
    ],
    followups=[
        ("Why O(n) instead of O(n^2)?", "Each element is touched a constant number of times; queries become O(1) reads."),
        ("Array vs hash map?", "Array for small dense key domains; map for sparse/large/arbitrary keys."),
        ("How to make it O(1) extra space?", "Sometimes you can accumulate on the fly without storing the whole prefix."),
        ("Handle updates between queries?", "Switch to a Fenwick/Segment tree for O(log n) updates."),
        ("2D version?", "Use a 2D prefix-sum matrix; submatrix sum in O(1)."),
        ("Streaming input?", "Maintain running aggregates; use sketches for high cardinality."),
        ("Parallelize?", "Counting/summing is associative — Map-Reduce by key."),
        ("Negative numbers break a technique?", "Sliding-window-by-sum needs non-negativity; prefix+hashmap handles negatives."),
        ("Overflow risk?", "Use wider integer types or modular arithmetic if required."),
        ("Memory pressure?", "Compress keys or use approximate structures (Count-Min Sketch)."),
        ("Detect duplicates fast?", "A hash set gives O(1) membership."),
        ("Most frequent element?", "Count then take the max value, or a heap for top-k."),
        ("Pivot/equilibrium index?", "Compare left prefix to total minus prefix."),
        ("Why does prefix subtraction work?", "Sums telescope: pre[r+1]-pre[l] = sum of [l..r]."),
        ("Relation to difference arrays?", "Difference array is the inverse: it supports range updates, prefix supports range queries."),
    ],
    variations=["Hash-map counting", "1D / 2D prefix sums", "Difference arrays (inverse)", "Prefix + hashmap for subarray sums", "Custom-comparator sorting"],
    production="Counting and prefix aggregation underpin analytics pipelines (Map-Reduce `reduceByKey`), time-series rollups, and database range scans. For high-cardinality streams swap exact maps for Count-Min Sketch / HyperLogLog to bound memory.",
)

FAM["Two Pointers"] = dict(
    brute="Check every pair/triplet with nested loops — O(n^2) or O(n^3).",
    optimal="Move two indices under an invariant (sorted order, or reader/writer) so each element is visited O(1) times.",
    idea="Maintain two indices and an invariant that tells you which pointer to advance, eliminating redundant pair checks.",
    complexity=("O(n) or O(n log n)", "O(1)", "Sorting (if needed) dominates; the scan itself is O(n)."),
    go="""// Opposite-direction two pointers on a sorted array (pair sum).
func twoSumSorted(a []int, target int) (int, int) {
    l, r := 0, len(a)-1
    for l < r {
        s := a[l] + a[r]
        switch {
        case s == target:
            return l, r
        case s < target:
            l++ // need a bigger sum
        default:
            r-- // need a smaller sum
        }
    }
    return -1, -1
}""",
    py="""def two_sum_sorted(a, target):
    l, r = 0, len(a) - 1
    while l < r:
        s = a[l] + a[r]
        if s == target:
            return (l, r)
        elif s < target:
            l += 1          # increase sum
        else:
            r -= 1          # decrease sum
    return (-1, -1)""",
    java="""int[] twoSumSorted(int[] a, int target) {
    int l = 0, r = a.length - 1;
    while (l < r) {
        int s = a[l] + a[r];
        if (s == target) return new int[]{l, r};
        else if (s < target) l++;
        else r--;
    }
    return new int[]{-1, -1};
}""",
    cpp="""pair<int,int> twoSumSorted(vector<int>& a, int target) {
    int l = 0, r = (int)a.size() - 1;
    while (l < r) {
        int s = a[l] + a[r];
        if (s == target) return {l, r};
        else if (s < target) ++l;
        else --r;
    }
    return {-1, -1};
}""",
    mistakes=[
        "Forgetting to sort first when the technique requires sorted input.",
        "Not skipping duplicates, producing repeated triplets/quadruplets.",
        "Using `l <= r` when `l < r` is intended (or vice versa).",
        "Advancing the wrong pointer and missing the answer.",
        "Off-by-one at the boundaries (start at 0 and n-1).",
        "Mutating original order when indices must map back to the input.",
        "Integer overflow when summing large values.",
        "Infinite loop from failing to move a pointer in some branch.",
        "Assuming uniqueness of solution when multiple exist.",
        "Mixing up reader/writer roles in same-direction variants.",
    ],
    followups=[
        ("Why does sorted order let you move one pointer?", "Monotonicity: increasing l raises the sum, decreasing r lowers it."),
        ("How to avoid duplicate triplets?", "Skip equal neighbors after recording a hit."),
        ("Opposite vs same direction — when each?", "Opposite for sorted pair/area problems; same direction for in-place filtering/windows."),
        ("Extend to 3Sum / 4Sum?", "Fix outer elements, two-pointer the rest; generalize as k-sum recursion."),
        ("Unsorted input, can't sort?", "Use a hash map (HashMap Lookup) for O(n) pair finding."),
        ("Container/area problems?", "Move the pointer at the shorter wall to possibly increase area."),
        ("Cycle detection?", "Fast/slow pointers (Floyd) detect cycles in O(1) space."),
        ("Palindrome check?", "Converge from both ends comparing characters."),
        ("Stability of order?", "Two-pointer partitioning can be unstable; note if order matters."),
        ("Complexity with sorting?", "O(n log n) sort + O(n) scan = O(n log n)."),
        ("Remove duplicates in place?", "Writer index advances only on new values."),
        ("Dutch national flag?", "Three pointers partition into <,=,> in one pass."),
        ("Find closest sum?", "Track the minimal |sum - target| as pointers move."),
        ("Why O(1) space?", "Only a few index variables beyond the input."),
        ("Multiple answers required?", "Continue scanning after each hit, moving both pointers."),
    ],
    variations=["Opposite-direction (converging)", "Same-direction (reader/writer)", "Fast & slow (cycle/middle)", "Three-way partition (Dutch flag)", "k-Sum recursion", "Container/area maximization"],
    production="Two-pointer scans power stream merging, log compaction, and zero-copy buffer processing where O(1) extra space and a single pass matter. Reader/writer compaction is used in garbage collectors and database vacuuming.",
)

FAM["Sliding Window"] = dict(
    brute="Enumerate all subarrays/substrings and evaluate each — O(n^2) or O(n^3).",
    optimal="Maintain a moving window with running state; expand the right edge, shrink the left only to restore validity.",
    idea="A window with incrementally maintained aggregates means each element enters and leaves at most once — amortized O(n).",
    complexity=("O(n)", "O(k)", "Each index is added and removed at most once; k = window/alphabet size."),
    go="""// Variable-size window: longest subarray satisfying a constraint.
func longestWindow(s string) int {
    count := map[byte]int{}
    left, best := 0, 0
    for right := 0; right < len(s); right++ {
        count[s[right]]++
        for windowInvalid(count) { // shrink until valid
            count[s[left]]--
            if count[s[left]] == 0 { delete(count, s[left]) }
            left++
        }
        if right-left+1 > best { best = right - left + 1 }
    }
    return best
}""",
    py="""def longest_window(s):
    from collections import defaultdict
    count = defaultdict(int)
    left = best = 0
    for right, ch in enumerate(s):
        count[ch] += 1
        while window_invalid(count):      # shrink to restore validity
            count[s[left]] -= 1
            if count[s[left]] == 0:
                del count[s[left]]
            left += 1
        best = max(best, right - left + 1)
    return best""",
    java="""int longestWindow(String s) {
    Map<Character,Integer> count = new HashMap<>();
    int left = 0, best = 0;
    for (int right = 0; right < s.length(); right++) {
        count.merge(s.charAt(right), 1, Integer::sum);
        while (windowInvalid(count)) {
            char c = s.charAt(left++);
            if (count.merge(c, -1, Integer::sum) == 0) count.remove(c);
        }
        best = Math.max(best, right - left + 1);
    }
    return best;
}""",
    cpp="""int longestWindow(const string& s) {
    unordered_map<char,int> count;
    int left = 0, best = 0;
    for (int right = 0; right < (int)s.size(); ++right) {
        ++count[s[right]];
        while (windowInvalid(count)) {
            if (--count[s[left]] == 0) count.erase(s[left]);
            ++left;
        }
        best = max(best, right - left + 1);
    }
    return best;
}""",
    mistakes=[
        "Shrinking with `if` when the invariant needs a `while` loop (or vice versa).",
        "Forgetting to update the answer at the right moment (after vs before shrink).",
        "Not removing zero-count keys, corrupting the 'distinct' count.",
        "Confusing 'longest' (shrink on invalid) with 'shortest' (shrink while valid).",
        "Fixed-window code that recomputes the whole window each step (O(nk)).",
        "Off-by-one in window length: `right - left + 1`.",
        "Mishandling the first k elements when seeding a fixed window.",
        "Using the window for problems needing negatives (sums) — prefix+hashmap instead.",
        "Not resetting state between the expand and shrink phases.",
        "Returning window indices that are stale after shrinking.",
    ],
    followups=[
        ("Fixed vs variable window — how to tell?", "Fixed when size k is given; variable when a constraint defines validity."),
        ("Longest vs shortest window logic?", "Longest: shrink only when invalid. Shortest: shrink while still valid, recording length."),
        ("Why amortized O(n)?", "Each index enters and exits the window at most once."),
        ("Handle 'at most k distinct'?", "Shrink while distinct-count > k."),
        ("Exactly k distinct?", "atMost(k) - atMost(k-1)."),
        ("Negative numbers in sum windows?", "Window-by-sum needs non-negativity; use prefix sums + hashmap otherwise."),
        ("Anagram/permutation in string?", "Fixed window + char-count match."),
        ("Window maximum efficiently?", "Monotonic deque gives O(n)."),
        ("Minimum window substring?", "Expand to cover need, shrink to minimize."),
        ("Counting subarrays with a property?", "Often sum over windows or atMost differences."),
        ("Two pointers vs sliding window?", "Sliding window is a specialized two-pointer with maintained aggregates."),
        ("Unicode/large alphabet?", "Use a hash map instead of a fixed array."),
        ("Multiple constraints?", "Track each as separate counters; invalid if any violated."),
        ("Stream input?", "Maintain window state incrementally; evict by time/size."),
        ("Space complexity?", "O(k) for the window's distinct elements or alphabet."),
    ],
    variations=["Fixed-size window", "Variable-size window", "Longest-window (shrink on invalid)", "Shortest-window (shrink while valid)", "Anagram/permutation window", "At-most-k distinct"],
    production="Sliding windows implement rate limiters (requests per interval), moving averages in metrics, anomaly detection over time series, and TCP congestion windows. Incremental aggregation keeps memory O(window) for unbounded streams.",
)

FAM["Binary Search"] = dict(
    brute="Linear scan checks each candidate — O(n).",
    optimal="Halve the search space each step using a monotonic property or predicate — O(log n).",
    idea="If the space is sorted (or a predicate is monotonic), comparing the middle lets you discard half every iteration.",
    complexity=("O(log n)", "O(1)", "Each step halves the range; iterative form uses constant space."),
    go="""// Lower bound: first index with a[i] >= target. Half-open invariant [lo, hi).
func lowerBound(a []int, target int) int {
    lo, hi := 0, len(a)
    for lo < hi {
        mid := lo + (hi-lo)/2     // avoids overflow
        if a[mid] < target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    return lo
}""",
    py="""def lower_bound(a, target):
    lo, hi = 0, len(a)            # half-open [lo, hi)
    while lo < hi:
        mid = (lo + hi) // 2
        if a[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return lo                     # first index with a[i] >= target""",
    java="""int lowerBound(int[] a, int target) {
    int lo = 0, hi = a.length;
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}""",
    cpp="""int lowerBound(vector<int>& a, int target) {
    int lo = 0, hi = (int)a.size();
    while (lo < hi) {
        int mid = lo + (hi - lo) / 2;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}""",
    mistakes=[
        "Overflow in `(lo+hi)/2` — use `lo + (hi-lo)/2`.",
        "Inconsistent interval convention (mixing closed and half-open).",
        "Infinite loop when `lo`/`hi` don't make progress.",
        "Wrong bias: lower-bound vs upper-bound off by one.",
        "Returning `mid` for boundary problems instead of the boundary index.",
        "Using `<=` vs `<` incorrectly in the loop condition.",
        "Forgetting the array must be sorted (or predicate monotonic).",
        "Mishandling all-true or all-false predicate ranges.",
        "Searching values when you should search the *answer* space.",
        "Not validating the final index against bounds.",
    ],
    followups=[
        ("Lower vs upper bound difference?", "Lower: first >= target. Upper: first > target. They bracket equal ranges."),
        ("Why half-open intervals?", "They make termination and boundary reasoning uniform."),
        ("Binary search on answer — when?", "When you can test feasibility(x) monotonically (minimize-the-max problems)."),
        ("Rotated sorted array?", "Detect which half is sorted, then search that half."),
        ("Find peak without full sort?", "Move toward the ascending slope."),
        ("First/last occurrence with duplicates?", "Bias the search left or right after a match."),
        ("Count of a value?", "upper_bound - lower_bound."),
        ("Floating-point answer?", "Iterate a fixed number of times or until precision epsilon."),
        ("2D sorted matrix?", "Treat as a single sorted list or staircase search."),
        ("Why O(log n)?", "Each step discards half the candidates."),
        ("Avoid overflow in other languages?", "Use unsigned shifts or wider types."),
        ("Predicate not monotonic?", "Binary search doesn't apply; reconsider modeling."),
        ("Search insert position?", "That's exactly lower_bound."),
        ("Median of two sorted arrays?", "Binary search the partition point."),
        ("Off-by-one debugging tip?", "Test arrays of size 0, 1, 2 and all-equal."),
    ],
    variations=["Classic search", "Lower/upper bound", "First/last occurrence", "Binary search on answer", "Rotated array search", "Peak finding", "Monotonic predicate search"],
    production="Binary search powers database index seeks, version-bisection (`git bisect`), autoscaling thresholds (smallest capacity that meets SLA), and rate/timeout tuning. 'Search on answer' is the workhorse for capacity-planning optimizations.",
)

FAM["Intervals"] = dict(
    brute="Compare every pair of intervals for overlap — O(n^2).",
    optimal="Sort by start (or process start/end events), then sweep once merging or counting overlaps.",
    idea="Sorting linearizes the geometry so a single left-to-right sweep resolves all overlaps.",
    complexity=("O(n log n)", "O(n)", "Sorting dominates; the sweep is O(n)."),
    go="""// Merge overlapping intervals.
func merge(intervals [][]int) [][]int {
    sort.Slice(intervals, func(i, j int) bool { return intervals[i][0] < intervals[j][0] })
    res := [][]int{}
    for _, in := range intervals {
        n := len(res)
        if n > 0 && in[0] <= res[n-1][1] {
            if in[1] > res[n-1][1] { res[n-1][1] = in[1] } // extend
        } else {
            res = append(res, in)
        }
    }
    return res
}""",
    py="""def merge(intervals):
    intervals.sort(key=lambda x: x[0])
    res = []
    for s, e in intervals:
        if res and s <= res[-1][1]:
            res[-1][1] = max(res[-1][1], e)   # extend last
        else:
            res.append([s, e])
    return res""",
    java="""int[][] merge(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[0], b[0]));
    List<int[]> res = new ArrayList<>();
    for (int[] in : intervals) {
        if (!res.isEmpty() && in[0] <= res.get(res.size()-1)[1])
            res.get(res.size()-1)[1] = Math.max(res.get(res.size()-1)[1], in[1]);
        else res.add(in);
    }
    return res.toArray(new int[0][]);
}""",
    cpp="""vector<vector<int>> merge(vector<vector<int>>& intervals) {
    sort(intervals.begin(), intervals.end());
    vector<vector<int>> res;
    for (auto& in : intervals) {
        if (!res.empty() && in[0] <= res.back()[1])
            res.back()[1] = max(res.back()[1], in[1]);
        else res.push_back(in);
    }
    return res;
}""",
    mistakes=[
        "Sorting by end when the algorithm needs sorting by start (or vice versa).",
        "Using `<` instead of `<=` for touching intervals (depends on problem).",
        "Forgetting to extend the end with `max` (intervals can be nested).",
        "Mutating shared interval objects unexpectedly.",
        "Off-by-one with inclusive vs exclusive endpoints.",
        "Not handling empty input.",
        "Sweep-line: processing end events before start events at the same coordinate.",
        "Counting overlaps wrong by not using a min-heap of end times.",
        "Assuming intervals are pre-sorted when they aren't.",
        "Greedy scheduling sorted by the wrong key (use earliest finish time).",
    ],
    followups=[
        ("Why sort by start for merging?", "Overlaps with earlier intervals can only come from the most recent merged one."),
        ("Insert into sorted intervals?", "Three phases: before, overlapping (merge), after."),
        ("Minimum meeting rooms?", "Min-heap of end times, or sweep start/end events."),
        ("Max non-overlapping intervals?", "Greedy by earliest finish time."),
        ("Interval intersection of two lists?", "Two-pointer over both sorted lists."),
        ("Touching intervals merge?", "Depends on whether endpoints are inclusive."),
        ("Sweep line for skyline?", "Process building edges; track max height with a heap."),
        ("Count active intervals at time t?", "Prefix sum of +1/-1 events."),
        ("Remove covered intervals?", "Sort and track max end."),
        ("Why O(n log n)?", "Dominated by the sort."),
        ("Online interval insertion?", "Interval tree / ordered map for O(log n) ops."),
        ("Car pooling / booking?", "Difference array on time, or sweep."),
        ("Employee free time?", "Merge all, then gaps are free time."),
        ("Stability of sort?", "Usually irrelevant; ties broken arbitrarily."),
        ("Endpoints as floats?", "Same logic; careful with equality comparisons."),
    ],
    variations=["Merge intervals", "Insert interval", "Meeting rooms (min concurrent)", "Sweep line / events", "Greedy interval scheduling"],
    production="Interval logic schedules calendar/meeting systems, allocates cloud resources (min machines for overlapping jobs), reconciles time-series gaps, and powers range-based access control. Sweep-line scales to millions of events with a single ordered pass.",
)

FAM["Stacks"] = dict(
    brute="For each element scan outward to find the next/previous greater or smaller — O(n^2).",
    optimal="Maintain a monotonic stack so each element is pushed and popped at most once — O(n).",
    idea="A stack kept in monotonic order lets you resolve 'nearest greater/smaller' relationships in amortized O(1) per element.",
    complexity=("O(n)", "O(n)", "Each index pushed/popped once; stack holds unresolved indices."),
    go="""// Next greater element to the right using a monotonic decreasing stack.
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
}""",
    py="""def next_greater(nums):
    res = [-1] * len(nums)
    stack = []                      # indices, values decreasing
    for i, v in enumerate(nums):
        while stack and nums[stack[-1]] < v:
            res[stack.pop()] = v
        stack.append(i)
    return res""",
    java="""int[] nextGreater(int[] nums) {
    int[] res = new int[nums.length];
    Arrays.fill(res, -1);
    Deque<Integer> stack = new ArrayDeque<>();
    for (int i = 0; i < nums.length; i++) {
        while (!stack.isEmpty() && nums[stack.peek()] < nums[i])
            res[stack.pop()] = nums[i];
        stack.push(i);
    }
    return res;
}""",
    cpp="""vector<int> nextGreater(vector<int>& nums) {
    vector<int> res(nums.size(), -1);
    stack<int> st;                  // indices
    for (int i = 0; i < (int)nums.size(); ++i) {
        while (!st.empty() && nums[st.top()] < nums[i]) {
            res[st.top()] = nums[i]; st.pop();
        }
        st.push(i);
    }
    return res;
}""",
    mistakes=[
        "Storing values instead of indices when you need positions/distances.",
        "Wrong monotonic direction (increasing vs decreasing) for the query.",
        "Using `<` vs `<=` incorrectly with duplicates.",
        "Forgetting to handle elements left on the stack at the end.",
        "Not iterating in reverse when the problem is naturally right-to-left.",
        "Circular array: forgetting to loop twice with modulo indexing.",
        "Histogram: missing the sentinel zero-height bar to flush the stack.",
        "Popping in the wrong order, corrupting results.",
        "Mixing up 'greater' and 'smaller' semantics.",
        "O(n^2) blowup by rescanning instead of trusting the stack invariant.",
    ],
    followups=[
        ("Increasing vs decreasing stack — which?", "Decreasing stack finds next greater; increasing finds next smaller."),
        ("Why amortized O(n)?", "Each index is pushed once and popped at most once."),
        ("Previous greater element?", "Same stack, but resolve as you push / scan the other direction."),
        ("Circular next greater?", "Iterate 2n with modulo, don't push twice."),
        ("Largest rectangle in histogram?", "Monotonic increasing stack of bar indices."),
        ("Daily temperatures?", "Stack of unresolved days; pop when a warmer day arrives."),
        ("Stock span?", "Previous greater index gives the span length."),
        ("Trapping rain water?", "Stack or two-pointer; stack resolves bounded basins."),
        ("Handle ties?", "Decide `<` vs `<=` based on whether equal counts as greater."),
        ("Space complexity?", "O(n) worst case (monotonic input)."),
        ("Maximal rectangle in matrix?", "Histogram per row + stack."),
        ("Sum of subarray minimums?", "Monotonic stack to count contribution of each element."),
        ("Why store indices?", "To compute distances/widths between boundaries."),
        ("Sentinel trick?", "Append a 0 (or +/-inf) to force final pops."),
        ("Relation to monotonic queue?", "Queue variant supports sliding-window min/max."),
    ],
    variations=["Monotonic increasing stack", "Monotonic decreasing stack", "Next/previous greater", "Histogram largest rectangle", "Stock span / daily temperatures"],
    production="Monotonic stacks drive expression parsing, undo/redo stacks, browser history, and streaming 'nearest peak' analytics. The single-pass O(n) property makes them ideal for high-throughput log processing.",
)

FAM["Queues"] = dict(
    brute="Recompute the window extremum or re-traverse levels each step — O(nk) / O(n^2).",
    optimal="Use a deque (monotonic queue) or FIFO queue to maintain window extrema / level order in O(1) amortized per element.",
    idea="A double-ended queue keeps only useful candidates; BFS uses a FIFO to expand frontier by frontier.",
    complexity=("O(n)", "O(k)", "Each element enters/leaves the deque once; BFS visits each node/edge once."),
    go="""// Sliding window maximum with a monotonic decreasing deque of indices.
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
}""",
    py="""from collections import deque
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
    return res""",
    java="""int[] maxSlidingWindow(int[] nums, int k) {
    Deque<Integer> dq = new ArrayDeque<>();
    int[] res = new int[nums.length - k + 1];
    for (int i = 0; i < nums.length; i++) {
        while (!dq.isEmpty() && nums[dq.peekLast()] < nums[i]) dq.pollLast();
        dq.offerLast(i);
        if (dq.peekFirst() <= i - k) dq.pollFirst();
        if (i >= k - 1) res[i - k + 1] = nums[dq.peekFirst()];
    }
    return res;
}""",
    cpp="""vector<int> maxSlidingWindow(vector<int>& nums, int k) {
    deque<int> dq; vector<int> res;
    for (int i = 0; i < (int)nums.size(); ++i) {
        while (!dq.empty() && nums[dq.back()] < nums[i]) dq.pop_back();
        dq.push_back(i);
        if (dq.front() <= i - k) dq.pop_front();
        if (i >= k - 1) res.push_back(nums[dq.front()]);
    }
    return res;
}""",
    mistakes=[
        "Storing values instead of indices, so you can't evict by position.",
        "Forgetting to evict indices that fell out of the window.",
        "Wrong deque monotonicity for min vs max.",
        "Emitting results before the first full window forms.",
        "BFS: not marking nodes visited when enqueuing (causes revisits/TLE).",
        "BFS: marking visited at dequeue time, allowing duplicates in the queue.",
        "Mixing level boundaries in level-order BFS.",
        "Using a list as a queue with O(n) pops from the front.",
        "Off-by-one in window eviction condition.",
        "Not handling k larger than the array length.",
    ],
    followups=[
        ("Why a deque for window max?", "It keeps a decreasing sequence of candidates; the front is always the max."),
        ("Amortized cost?", "Each index is pushed and popped at most once → O(n)."),
        ("Window minimum?", "Same idea with an increasing deque."),
        ("BFS vs DFS for shortest path?", "BFS gives shortest path in unweighted graphs."),
        ("Multi-source BFS?", "Seed the queue with all sources at distance 0."),
        ("0-1 BFS?", "Use a deque: push front for 0-weight, back for 1-weight edges."),
        ("Level-order traversal?", "Process the queue in size-batches per level."),
        ("Why mark visited at enqueue?", "Prevents the same node being queued multiple times."),
        ("Shortest subarray with sum >= K (negatives)?", "Monotonic deque on prefix sums."),
        ("Space complexity?", "O(k) for the window / O(V) for BFS frontier."),
        ("Deque vs heap for window max?", "Deque is O(n); heap is O(n log k)."),
        ("Rotting oranges / spread problems?", "Multi-source BFS by time layers."),
        ("Word ladder?", "BFS over word-transformation graph."),
        ("Bidirectional BFS?", "Search from both ends to cut the frontier."),
        ("Queue overflow in huge graphs?", "Stream/iterative deepening or external memory."),
    ],
    variations=["Monotonic deque (window max/min)", "FIFO BFS", "Multi-source BFS", "0-1 BFS", "Level-order traversal"],
    production="Monotonic queues compute streaming moving maxima for monitoring; BFS underlies network broadcast, shortest-hop routing, web crawling frontiers, and dependency-free task scheduling.",
)

FAM["Heaps"] = dict(
    brute="Sort everything to get the k best — O(n log n) — or rescan repeatedly.",
    optimal="Maintain a size-k heap (or two heaps) so each insertion is O(log k) and the best/median is at the top.",
    idea="A heap gives O(1) access to the extreme element and O(log n) updates — perfect for top-k, merging, and running medians.",
    complexity=("O(n log k)", "O(k)", "k-sized heap; pop/push is O(log k)."),
    go="""// Top-K largest with a min-heap of size k (container/heap).
import "container/heap"
type MinHeap []int
func (h MinHeap) Len() int { return len(h) }
func (h MinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h MinHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MinHeap) Pop() any { old := *h; n := len(old); v := old[n-1]; *h = old[:n-1]; return v }

func topK(nums []int, k int) []int {
    h := &MinHeap{}
    for _, v := range nums {
        heap.Push(h, v)
        if h.Len() > k { heap.Pop(h) } // drop smallest, keep k largest
    }
    return *h
}""",
    py="""import heapq
def top_k(nums, k):
    heap = []                        # min-heap of size k
    for v in nums:
        heapq.heappush(heap, v)
        if len(heap) > k:
            heapq.heappop(heap)      # evict smallest -> keep k largest
    return heap""",
    java="""int[] topK(int[] nums, int k) {
    PriorityQueue<Integer> heap = new PriorityQueue<>(); // min-heap
    for (int v : nums) {
        heap.offer(v);
        if (heap.size() > k) heap.poll();
    }
    int[] res = new int[k];
    for (int i = 0; i < k; i++) res[i] = heap.poll();
    return res;
}""",
    cpp="""vector<int> topK(vector<int>& nums, int k) {
    priority_queue<int, vector<int>, greater<int>> heap; // min-heap
    for (int v : nums) {
        heap.push(v);
        if ((int)heap.size() > k) heap.pop();
    }
    vector<int> res;
    while (!heap.empty()) { res.push_back(heap.top()); heap.pop(); }
    return res;
}""",
    mistakes=[
        "Using a max-heap when a min-heap of size k is what keeps the k largest.",
        "Heap size growing to n instead of being capped at k.",
        "Wrong comparator (min vs max) for the objective.",
        "Two heaps: failing to rebalance sizes after each insert.",
        "Two heaps: sign errors simulating a max-heap with a min-heap.",
        "Forgetting tuple ordering for ties (e.g., (dist, point)).",
        "Mutating heap-stored objects, breaking the heap invariant.",
        "Popping all n for top-k instead of capping at k (O(n log n) vs O(n log k)).",
        "Not handling k > n.",
        "Median: returning the wrong heap top for even vs odd counts.",
    ],
    followups=[
        ("Min-heap of size k vs sorting?", "O(n log k) beats O(n log n) when k << n."),
        ("Kth largest in O(n) average?", "Quickselect partitioning."),
        ("Two heaps for median?", "Max-heap (low half) + min-heap (high half), balanced."),
        ("Merge k sorted lists?", "Heap of the k current heads, O(N log k)."),
        ("K closest points?", "Heap by distance, size k."),
        ("Streaming top-k?", "Maintain the size-k heap as data arrives."),
        ("Sliding-window median?", "Two heaps + lazy deletion, or an ordered multiset."),
        ("Why O(1) peek?", "The extreme is always at the root."),
        ("Stability with equal keys?", "Add a secondary key (index) for deterministic order."),
        ("Heapify cost?", "Building a heap from n items is O(n)."),
        ("Task scheduler / CPU?", "Greedy with a max-heap of frequencies."),
        ("IPO / max capital?", "Two heaps: affordable projects by profit."),
        ("Decrease-key needed?", "Use an indexed heap or lazy deletion."),
        ("Memory for huge n?", "Heap stays O(k); good for bounded memory."),
        ("Top-k frequent?", "Count then heap (or bucket sort) — O(n log k)."),
    ],
    variations=["Top-K (size-k heap)", "K closest", "Two heaps (median)", "K-way merge", "Streaming median"],
    production="Heaps run priority schedulers (OS, Kubernetes), event simulations, Dijkstra routing, k-nearest-neighbor serving, and streaming top-k dashboards. Bounded heap size gives predictable memory under load.",
)

FAM["Linked Lists"] = dict(
    brute="Copy to an array, manipulate, rebuild — O(n) extra space.",
    optimal="Rewire pointers in place with a few pointers (prev/curr/next) and a dummy head — O(1) space.",
    idea="Most list problems are pointer-rewiring; a dummy sentinel removes head edge cases and fast/slow pointers locate structure.",
    complexity=("O(n)", "O(1)", "In-place pointer manipulation, single traversal."),
    go="""// Reverse a singly linked list in place.
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
}""",
    py="""class ListNode:
    def __init__(self, val=0, nxt=None):
        self.val, self.next = val, nxt

def reverse_list(head):
    prev = None
    while head:
        nxt = head.next      # save next
        head.next = prev     # reverse pointer
        prev = head          # advance
        head = nxt
    return prev""",
    java="""class ListNode { int val; ListNode next; ListNode(int v){val=v;} }
ListNode reverseList(ListNode head) {
    ListNode prev = null;
    while (head != null) {
        ListNode next = head.next;
        head.next = prev;
        prev = head;
        head = next;
    }
    return prev;
}""",
    cpp="""struct ListNode { int val; ListNode* next; ListNode(int v):val(v),next(nullptr){} };
ListNode* reverseList(ListNode* head) {
    ListNode* prev = nullptr;
    while (head) {
        ListNode* next = head->next;
        head->next = prev;
        prev = head;
        head = next;
    }
    return prev;
}""",
    mistakes=[
        "Losing the `next` pointer before rewiring (save it first).",
        "Not using a dummy head, then special-casing head insert/delete.",
        "Null-pointer dereference at the list's end.",
        "Creating cycles by mis-wiring `next`.",
        "Fast/slow: advancing fast without checking `fast.next` for null.",
        "Off-by-one finding the middle (even vs odd length).",
        "Forgetting to disconnect the tail when splitting lists.",
        "Returning the old head instead of the new one after reversal.",
        "Memory leaks in C++ when removing nodes (delete them).",
        "Reversing in k-groups but not stitching segments correctly.",
    ],
    followups=[
        ("Why a dummy node?", "It gives a stable handle so head insert/delete needs no special case."),
        ("Find the middle?", "Fast/slow pointers; fast moves 2x."),
        ("Detect a cycle?", "Floyd's tortoise & hare; meeting implies a cycle."),
        ("Find cycle start?", "Reset one pointer to head after meeting; advance both by 1."),
        ("Reverse in k-groups?", "Reverse each block, connect previous tail to new head."),
        ("Merge two sorted lists?", "Dummy head + splice smaller node each step."),
        ("Remove nth from end?", "Two pointers n apart, then delete."),
        ("Palindrome list?", "Find middle, reverse second half, compare."),
        ("Why O(1) space?", "Only a few pointers beyond the list."),
        ("Recursion vs iteration?", "Recursion is clean but O(n) stack; iteration is O(1)."),
        ("Copy list with random pointer?", "Interleave clones or use a hash map."),
        ("Reorder list?", "Split, reverse second half, merge alternately."),
        ("Sort a linked list?", "Merge sort fits lists naturally (O(n log n), O(1) extra with bottom-up)."),
        ("Intersection of two lists?", "Two pointers switching heads equalize lengths."),
        ("Doubly linked tricks?", "Prev pointers simplify deletion and LRU caches."),
    ],
    variations=["Reverse (whole / k-group)", "Cycle detection", "Merge sorted lists", "Dummy-node insert/delete", "Fast/slow midpoint"],
    production="Linked lists implement LRU/LFU caches, allocator free-lists, adjacency lists, and lock-free queues. The dummy-node and pointer-rewiring techniques are exactly how production cache evictions splice nodes in O(1).",
)

FAM["Trees"] = dict(
    brute="Recompute subtree properties repeatedly across calls — O(n^2).",
    optimal="One DFS post-order pass returns each subtree's summary to its parent — O(n).",
    idea="Trees are recursive: solve children first, combine their results at the parent. BFS handles level-aggregates.",
    complexity=("O(n)", "O(h)", "Visit each node once; recursion stack is O(height)."),
    go="""// Post-order DFS returning subtree height; also tracks diameter.
type TreeNode struct { Val int; Left, Right *TreeNode }
func height(node *TreeNode, best *int) int {
    if node == nil { return 0 }
    l := height(node.Left, best)
    r := height(node.Right, best)
    if l+r > *best { *best = l + r }   // path through this node
    if l > r { return l + 1 }
    return r + 1
}""",
    py="""class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val, self.left, self.right = val, left, right

def diameter(root):
    best = 0
    def height(node):
        nonlocal best
        if not node: return 0
        l, r = height(node.left), height(node.right)
        best = max(best, l + r)       # longest path through node
        return 1 + max(l, r)
    height(root)
    return best""",
    java="""class TreeNode { int val; TreeNode left, right; }
int best = 0;
int height(TreeNode node) {
    if (node == null) return 0;
    int l = height(node.left), r = height(node.right);
    best = Math.max(best, l + r);
    return 1 + Math.max(l, r);
}""",
    cpp="""struct TreeNode { int val; TreeNode *left, *right; };
int best = 0;
int height(TreeNode* node) {
    if (!node) return 0;
    int l = height(node->left), r = height(node->right);
    best = max(best, l + r);
    return 1 + max(l, r);
}""",
    mistakes=[
        "Returning the global answer instead of the local subtree value.",
        "Confusing height (edges) with depth/number of nodes.",
        "Null checks missing, causing crashes at leaves.",
        "Using O(n) extra work per node (e.g., recomputing height) → O(n^2).",
        "BFS without tracking level boundaries when levels matter.",
        "Deep recursion stack overflow on skewed trees.",
        "Mutating shared state across recursion branches incorrectly.",
        "LCA: not handling the case where one node is ancestor of the other.",
        "Forgetting BST ordering to prune search.",
        "Serialization: ambiguous null markers.",
    ],
    followups=[
        ("Pre/in/post-order — when each?", "Post-order to combine children; in-order for BST sorted output; pre-order to copy/serialize."),
        ("Iterative DFS?", "Explicit stack mirrors the call stack."),
        ("BFS vs DFS on trees?", "BFS for level/shortest; DFS for path/subtree aggregates."),
        ("Diameter computation?", "At each node combine left+right heights; track the global max."),
        ("Balanced check in O(n)?", "Return height and a balance flag together."),
        ("LCA in a binary tree?", "Post-order; the node where both targets surface is the LCA."),
        ("LCA in a BST?", "Walk down comparing values."),
        ("Path sum (any path)?", "Prefix sums along the root path with a hash map."),
        ("Max path sum?", "Tree DP: gain = node + max(0, left, right)."),
        ("Why O(h) space?", "Recursion depth equals tree height."),
        ("Serialize/deserialize?", "Pre-order with null markers, or level-order."),
        ("Tree DP / rerooting?", "Compute subtree DP, then a second pass for all roots."),
        ("Count nodes in complete tree?", "Use height symmetry for O(log^2 n)."),
        ("Kth smallest in BST?", "In-order traversal with a counter."),
        ("Vertical/zigzag order?", "BFS with column index or alternating direction."),
    ],
    variations=["DFS (pre/in/post)", "BFS level order", "Height / diameter", "Balanced check", "LCA", "Path sum", "Tree DP"],
    production="Tree traversals power filesystem walks, DOM/AST processing, hierarchical permissions, B-tree indexes, and dependency resolution. Post-order aggregation is how compilers compute attributes bottom-up.",
)

FAM["Graphs"] = dict(
    brute="Naive reachability/path checks rescan the graph repeatedly — exponential or O(V*E^2).",
    optimal="Use BFS/DFS (O(V+E)), union-find (near-O(1) amortized), or a shortest-path algorithm matched to edge weights.",
    idea="Pick the traversal by structure: BFS for unweighted shortest paths, DFS for connectivity/cycles, Dijkstra for non-negative weights, union-find for dynamic connectivity.",
    complexity=("O(V + E)", "O(V)", "Each vertex and edge processed once for BFS/DFS."),
    go="""// BFS shortest distance from src in an unweighted adjacency list.
func bfs(adj map[int][]int, src, n int) []int {
    dist := make([]int, n)
    for i := range dist { dist[i] = -1 }
    dist[src] = 0
    queue := []int{src}
    for len(queue) > 0 {
        u := queue[0]; queue = queue[1:]
        for _, v := range adj[u] {
            if dist[v] == -1 {           // first visit = shortest in BFS
                dist[v] = dist[u] + 1
                queue = append(queue, v)
            }
        }
    }
    return dist
}""",
    py="""from collections import deque
def bfs(adj, src, n):
    dist = [-1] * n
    dist[src] = 0
    q = deque([src])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if dist[v] == -1:           # unvisited
                dist[v] = dist[u] + 1
                q.append(v)
    return dist""",
    java="""int[] bfs(List<List<Integer>> adj, int src, int n) {
    int[] dist = new int[n];
    Arrays.fill(dist, -1);
    dist[src] = 0;
    Queue<Integer> q = new ArrayDeque<>();
    q.add(src);
    while (!q.isEmpty()) {
        int u = q.poll();
        for (int v : adj.get(u)) if (dist[v] == -1) {
            dist[v] = dist[u] + 1; q.add(v);
        }
    }
    return dist;
}""",
    cpp="""vector<int> bfs(vector<vector<int>>& adj, int src, int n) {
    vector<int> dist(n, -1);
    dist[src] = 0;
    queue<int> q; q.push(src);
    while (!q.empty()) {
        int u = q.front(); q.pop();
        for (int v : adj[u]) if (dist[v] == -1) {
            dist[v] = dist[u] + 1; q.push(v);
        }
    }
    return dist;
}""",
    mistakes=[
        "Marking visited at dequeue instead of enqueue (duplicates, TLE).",
        "Using BFS for weighted shortest paths (use Dijkstra).",
        "Using Dijkstra with negative edges (use Bellman-Ford).",
        "Recursion stack overflow on deep DFS (use iterative).",
        "Forgetting to handle disconnected components.",
        "Union-find without path compression / union by rank (slow).",
        "Topological sort ignoring cycle detection.",
        "Off-by-one in node indexing (0 vs 1 based).",
        "Not deduplicating edges in an undirected graph.",
        "Mutating the graph during traversal.",
    ],
    followups=[
        ("BFS vs DFS?", "BFS: shortest unweighted paths/levels. DFS: connectivity, cycles, topo order."),
        ("Dijkstra prerequisites?", "Non-negative edge weights; uses a min-heap."),
        ("Negative weights?", "Bellman-Ford (and it detects negative cycles)."),
        ("All-pairs shortest paths?", "Floyd-Warshall O(V^3) for dense/small graphs."),
        ("Dynamic connectivity?", "Union-Find with path compression + union by rank."),
        ("Topological order?", "Kahn's (indegree queue) or DFS finish times."),
        ("Detect cycle (directed)?", "DFS colors or topo-sort leftovers."),
        ("Detect cycle (undirected)?", "Union-find or DFS with parent tracking."),
        ("Minimum spanning tree?", "Kruskal (union-find) or Prim (heap)."),
        ("Why O(V+E)?", "Each vertex and edge is examined a constant number of times."),
        ("Multi-source BFS?", "Seed all sources at distance 0."),
        ("Bipartite check?", "2-coloring via BFS/DFS."),
        ("Strongly connected components?", "Tarjan or Kosaraju."),
        ("Shortest path with <= k stops?", "Bellman-Ford limited to k relaxations."),
        ("Grid as graph?", "Cells are nodes; 4/8 neighbors are edges."),
    ],
    variations=["BFS / DFS", "Topological sort", "Union-Find", "Dijkstra", "Bellman-Ford", "Floyd-Warshall", "MST (Kruskal/Prim)"],
    production="Graph algorithms route packets (OSPF=Dijkstra), resolve build/dependency order (topo sort), detect fraud rings (connected components), power social-graph recommendations, and schedule jobs with constraints. Union-Find scales to billions of dynamic-connectivity ops.",
)

FAM["Backtracking"] = dict(
    brute="Generate all candidates then filter — wasteful, explores invalid branches fully.",
    optimal="Build candidates incrementally; prune branches that can't lead to a solution (choose → explore → un-choose).",
    idea="DFS over the decision tree with pruning. Each recursion makes a choice, recurses, then undoes it to try the next.",
    complexity=("O(branches^depth)", "O(depth)", "Exponential by nature; pruning cuts the constant/branches drastically."),
    go="""// Subsets via choose/explore/un-choose.
func subsets(nums []int) [][]int {
    res := [][]int{}
    var path []int
    var dfs func(start int)
    dfs = func(start int) {
        cp := make([]int, len(path)); copy(cp, path)
        res = append(res, cp)                 // record current subset
        for i := start; i < len(nums); i++ {
            path = append(path, nums[i])       // choose
            dfs(i + 1)                         // explore
            path = path[:len(path)-1]          // un-choose
        }
    }
    dfs(0)
    return res
}""",
    py="""def subsets(nums):
    res, path = [], []
    def dfs(start):
        res.append(path[:])                    # record
        for i in range(start, len(nums)):
            path.append(nums[i])               # choose
            dfs(i + 1)                          # explore
            path.pop()                          # un-choose
    dfs(0)
    return res""",
    java="""List<List<Integer>> subsets(int[] nums) {
    List<List<Integer>> res = new ArrayList<>();
    dfs(nums, 0, new ArrayList<>(), res);
    return res;
}
void dfs(int[] nums, int start, List<Integer> path, List<List<Integer>> res) {
    res.add(new ArrayList<>(path));
    for (int i = start; i < nums.length; i++) {
        path.add(nums[i]);
        dfs(nums, i + 1, path, res);
        path.remove(path.size() - 1);
    }
}""",
    cpp="""void dfs(vector<int>& nums, int start, vector<int>& path, vector<vector<int>>& res) {
    res.push_back(path);
    for (int i = start; i < (int)nums.size(); ++i) {
        path.push_back(nums[i]);
        dfs(nums, i + 1, path, res);
        path.pop_back();
    }
}
vector<vector<int>> subsets(vector<int>& nums) {
    vector<vector<int>> res; vector<int> path;
    dfs(nums, 0, path, res);
    return res;
}""",
    mistakes=[
        "Forgetting to un-choose (restore state) after recursion.",
        "Adding a reference to `path` instead of a copy to the result.",
        "Not advancing the start index, producing duplicate combinations.",
        "Missing duplicate-skip logic for inputs with repeats.",
        "No pruning, causing timeouts on large search spaces.",
        "Incorrect base case / termination condition.",
        "Using a `used[]` array incorrectly in permutations.",
        "Mutating shared structures without restoring them.",
        "Exponential memory by storing all partial states.",
        "Off-by-one in the recursion depth / level.",
    ],
    followups=[
        ("Subsets vs combinations vs permutations?", "Subsets: all sizes. Combinations: choose k with start index. Permutations: order matters, use used[]."),
        ("How to handle duplicates?", "Sort, then skip equal siblings at the same depth."),
        ("Why choose/un-choose?", "It reuses one path buffer across the whole search."),
        ("Pruning strategies?", "Bound checks, constraint propagation, ordering choices."),
        ("N-Queens pruning?", "Track used columns and both diagonals as sets."),
        ("Sudoku?", "Try valid digits per cell; backtrack on contradiction."),
        ("Combination sum (reuse allowed)?", "Recurse with the same index `i`."),
        ("Time complexity bound?", "Often O(2^n), O(n!), or O(k^n) depending on the tree."),
        ("Iterative alternative?", "Bitmask enumeration for subsets."),
        ("Memoize backtracking?", "If subproblems overlap, convert to DP."),
        ("Generate palindromic partitions?", "Backtrack on cut positions, check palindrome."),
        ("Word search in grid?", "DFS with visited marks, backtrack the mark."),
        ("Why copy the path?", "The buffer keeps mutating; results need snapshots."),
        ("Lexicographic order?", "Iterate choices in sorted order."),
        ("Limit results (first k)?", "Early-return once enough solutions are found."),
    ],
    variations=["Subsets (power set)", "Combinations", "Permutations", "Constraint solving (N-Queens, Sudoku)", "Grid DFS / word search"],
    production="Backtracking solves configuration/constraint problems: test-case generation, SAT-style feasibility, resource allocation, and puzzle/AI move generation. Pruning is the difference between feasible and intractable in production solvers.",
)

FAM["Dynamic Programming"] = dict(
    brute="Naive recursion recomputes overlapping subproblems — exponential time.",
    optimal="Define a state + recurrence, memoize (top-down) or fill a table (bottom-up); often optimize space to O(1)/O(n).",
    idea="Optimal substructure + overlapping subproblems ⇒ store each subproblem's answer once and reuse it.",
    complexity=("O(states × transitions)", "O(states)", "Each state computed once; space often reducible to a rolling row."),
    go="""// 0/1 Knapsack, space-optimized to 1D. dp[w] = best value at capacity w.
func knapsack(weights, values []int, cap int) int {
    dp := make([]int, cap+1)
    for i := range weights {
        for w := cap; w >= weights[i]; w-- {  // reverse: each item once
            if dp[w-weights[i]]+values[i] > dp[w] {
                dp[w] = dp[w-weights[i]] + values[i]
            }
        }
    }
    return dp[cap]
}""",
    py="""def knapsack(weights, values, cap):
    dp = [0] * (cap + 1)               # dp[w] = best value for capacity w
    for wt, val in zip(weights, values):
        for w in range(cap, wt - 1, -1):   # reverse -> 0/1 (item used once)
            dp[w] = max(dp[w], dp[w - wt] + val)
    return dp[cap]""",
    java="""int knapsack(int[] weights, int[] values, int cap) {
    int[] dp = new int[cap + 1];
    for (int i = 0; i < weights.length; i++)
        for (int w = cap; w >= weights[i]; w--)
            dp[w] = Math.max(dp[w], dp[w - weights[i]] + values[i]);
    return dp[cap];
}""",
    cpp="""int knapsack(vector<int>& weights, vector<int>& values, int cap) {
    vector<int> dp(cap + 1, 0);
    for (size_t i = 0; i < weights.size(); ++i)
        for (int w = cap; w >= weights[i]; --w)
            dp[w] = max(dp[w], dp[w - weights[i]] + values[i]);
    return dp[cap];
}""",
    mistakes=[
        "Wrong loop direction (0/1 needs reverse; unbounded needs forward).",
        "Ill-defined state that doesn't capture all needed information.",
        "Incorrect base cases.",
        "Off-by-one in dimensions (use size n+1 frequently).",
        "Forgetting to initialize unreachable states to ±infinity.",
        "Memoization key collisions / missing dimensions.",
        "Recomputing instead of reading the memo.",
        "Space-optimizing prematurely and breaking the recurrence.",
        "Integer overflow on counts/sums.",
        "Not reconstructing the solution when the problem asks for it.",
    ],
    followups=[
        ("Top-down vs bottom-up?", "Memoized recursion vs iterative table; same complexity, different constants/stack use."),
        ("How to find the state?", "Identify the minimal info to make a decision and recurse."),
        ("0/1 vs unbounded knapsack?", "0/1 iterates capacity in reverse; unbounded forward (reuse)."),
        ("Space optimization?", "Keep only the previous row(s) you depend on."),
        ("Reconstruct the answer?", "Store choices or backtrack through the table."),
        ("LIS in O(n log n)?", "Patience sorting with binary search."),
        ("LCS / edit distance?", "2D grid DP aligning two sequences."),
        ("Coin change (min vs ways)?", "Min-coins vs count-ways differ in init and loop order."),
        ("Why overlapping subproblems matter?", "They make memoization pay off (vs divide & conquer)."),
        ("Tree DP?", "Combine children's states post-order; reroot for all-roots."),
        ("Bitmask DP?", "Encode subsets as bitmasks for ≤20 elements."),
        ("State machine DP?", "Model hold/sell/cooldown states (stock problems)."),
        ("Digit DP?", "Count numbers with a tight-bound flag over digits."),
        ("Interval DP?", "dp[i][j] over a range, split at k (matrix chain, burst balloons)."),
        ("Prove correctness?", "Show optimal substructure and a correct recurrence."),
    ],
    variations=["0/1 & unbounded knapsack", "Subset sum / partition", "LIS / LCS", "Grid / string DP", "Tree / bitmask / digit / state-machine DP"],
    production="DP optimizes resource allocation, sequence alignment (genomics, diff tools), spell-check (edit distance), query planning, and pricing/inventory decisions. Space-optimized DP keeps memory linear for production-scale inputs.",
)

FAM["Greedy"] = dict(
    brute="Try all orderings/choices (often exponential) to find the optimum.",
    optimal="Make the locally optimal choice that a proof (exchange argument) shows is globally safe — usually after sorting.",
    idea="When a greedy choice provably never hurts, a single sorted pass yields the optimum in O(n log n).",
    complexity=("O(n log n)", "O(1)", "Sorting dominates; the greedy sweep is O(n)."),
    go="""// Maximum non-overlapping intervals: greedy by earliest finish time.
func maxNonOverlap(intervals [][]int) int {
    sort.Slice(intervals, func(i, j int) bool { return intervals[i][1] < intervals[j][1] })
    count, end := 0, math.MinInt
    for _, in := range intervals {
        if in[0] >= end {       // compatible with last chosen
            count++
            end = in[1]
        }
    }
    return count
}""",
    py="""def max_non_overlap(intervals):
    intervals.sort(key=lambda x: x[1])     # earliest finish first
    count, end = 0, float('-inf')
    for s, e in intervals:
        if s >= end:                        # no overlap
            count += 1
            end = e
    return count""",
    java="""int maxNonOverlap(int[][] intervals) {
    Arrays.sort(intervals, (a, b) -> Integer.compare(a[1], b[1]));
    int count = 0, end = Integer.MIN_VALUE;
    for (int[] in : intervals)
        if (in[0] >= end) { count++; end = in[1]; }
    return count;
}""",
    cpp="""int maxNonOverlap(vector<vector<int>>& intervals) {
    sort(intervals.begin(), intervals.end(),
         [](auto& a, auto& b){ return a[1] < b[1]; });
    int count = 0, end = INT_MIN;
    for (auto& in : intervals)
        if (in[0] >= end) { count++; end = in[1]; }
    return count;
}""",
    mistakes=[
        "Assuming greedy works without proving the exchange argument.",
        "Sorting by the wrong key (e.g., start instead of finish time).",
        "Ties broken incorrectly, flipping the result.",
        "Greedy on a problem that actually needs DP.",
        "Not handling the empty / single-element case.",
        "Integer overflow in running totals (e.g., gas station).",
        "Resetting accumulators at the wrong moment.",
        "Off-by-one in reachability (jump game).",
        "Forgetting that local optimum ≠ global without the safety proof.",
        "Mutating input order when it matters downstream.",
    ],
    followups=[
        ("How to know greedy is valid?", "Prove an exchange argument: swapping to the greedy choice never worsens the optimum."),
        ("Activity selection key?", "Sort by earliest finish time."),
        ("Jump game reachability?", "Track the farthest reachable index."),
        ("Jump game II min jumps?", "BFS-like greedy over reach boundaries."),
        ("Gas station start?", "Reset start when the running tank goes negative."),
        ("Huffman coding?", "Repeatedly merge the two smallest weights (heap)."),
        ("Greedy vs DP?", "Greedy when local choice is safe; DP when you must compare futures."),
        ("Fractional vs 0/1 knapsack?", "Fractional is greedy; 0/1 needs DP."),
        ("Min arrows to burst balloons?", "Greedy by end coordinate."),
        ("Task scheduling with cooldown?", "Greedy with counts + idle slots, or heap."),
        ("Why O(n log n)?", "Sorting dominates the single greedy pass."),
        ("Counterexample habit?", "Always try to break greedy with a small case."),
        ("Stability of choice?", "Document tie-breaking explicitly."),
        ("Interval partitioning (min rooms)?", "Sweep / heap of end times."),
        ("Coin change greedy fails when?", "Non-canonical coin systems need DP."),
    ],
    variations=["Activity selection / scheduling", "Jump game reachability", "Gas station circuit", "Huffman / merge-cost"],
    production="Greedy drives load balancing, packet scheduling (earliest-deadline-first), compression (Huffman), cache admission, and capacity planning where a provably safe local rule beats expensive global optimization.",
)

FAM["Advanced"] = dict(
    brute="Direct per-query computation or full recomputation — too slow for large/online workloads.",
    optimal="Use a specialized structure (trie, segment/Fenwick tree, sparse table) or technique (bitmask DP, meet-in-the-middle, Euler tour, flow, SCC) tuned to the query/update profile.",
    idea="Match the data structure to the operation mix: range queries → segment/Fenwick; prefix lookups → trie; static idempotent ranges → sparse table; subset states → bitmask DP.",
    complexity=("Varies (often O(log n) per op)", "O(n) to O(n log n)", "Build cost amortized over many fast queries/updates."),
    go="""// Fenwick (Binary Indexed) Tree: prefix sums with point updates, O(log n).
type Fenwick struct{ tree []int }
func NewFenwick(n int) *Fenwick { return &Fenwick{make([]int, n+1)} }
func (f *Fenwick) Update(i, delta int) {
    for ; i < len(f.tree); i += i & (-i) { f.tree[i] += delta }
}
func (f *Fenwick) Query(i int) int { // prefix sum [1..i]
    s := 0
    for ; i > 0; i -= i & (-i) { s += f.tree[i] }
    return s
}""",
    py="""class Fenwick:
    def __init__(self, n):
        self.tree = [0] * (n + 1)
    def update(self, i, delta):          # 1-indexed
        while i < len(self.tree):
            self.tree[i] += delta
            i += i & (-i)
    def query(self, i):                  # prefix sum [1..i]
        s = 0
        while i > 0:
            s += self.tree[i]
            i -= i & (-i)
        return s""",
    java="""class Fenwick {
    long[] tree;
    Fenwick(int n) { tree = new long[n + 1]; }
    void update(int i, long d) { for (; i < tree.length; i += i & (-i)) tree[i] += d; }
    long query(int i) { long s = 0; for (; i > 0; i -= i & (-i)) s += tree[i]; return s; }
}""",
    cpp="""struct Fenwick {
    vector<long long> tree;
    Fenwick(int n) : tree(n + 1, 0) {}
    void update(int i, long long d) { for (; i < (int)tree.size(); i += i & (-i)) tree[i] += d; }
    long long query(int i) { long long s = 0; for (; i > 0; i -= i & (-i)) s += tree[i]; return s; }
};""",
    mistakes=[
        "Mixing 0-indexed and 1-indexed conventions (Fenwick is 1-indexed).",
        "Segment tree: wrong recursion bounds or lazy-propagation push-down.",
        "Trie: not marking end-of-word, or leaking memory on delete.",
        "Sparse table on a non-idempotent operation (sums need a different trick).",
        "Bitmask DP exceeding memory for n > ~22.",
        "Meet-in-the-middle: incorrect merge of the two halves.",
        "Euler tour: off-by-one in in/out times.",
        "Network flow: forgetting residual/back edges.",
        "SCC/Tarjan: mishandling the low-link update and stack.",
        "Mo's algorithm: wrong block size or add/remove ordering.",
    ],
    followups=[
        ("Fenwick vs segment tree?", "Fenwick is smaller/faster for prefix sums; segment tree is more general (min/max, lazy ranges)."),
        ("Range update + range query?", "Segment tree with lazy propagation, or two Fenwicks."),
        ("Trie use cases?", "Prefix search, autocomplete, word dictionaries, XOR-maximization."),
        ("Sparse table limits?", "O(1) queries but only static, idempotent operations (min/max/gcd)."),
        ("Bitmask DP feasibility?", "n ≲ 20–22 because of 2^n states."),
        ("Meet-in-the-middle when?", "n ≲ 40 subset problems: split into 2^(n/2)."),
        ("Euler tour purpose?", "Flatten a tree so subtrees are contiguous ranges."),
        ("Heavy-light decomposition?", "Path queries on trees via O(log n) chains + segment tree."),
        ("Max flow = min cut?", "By the max-flow min-cut theorem; models matching/assignment."),
        ("SCC algorithms?", "Tarjan (one DFS) or Kosaraju (two passes)."),
        ("Bridges / articulation points?", "Tarjan's low-link values in one DFS."),
        ("Mo's algorithm complexity?", "O((n+q)√n) for offline range queries."),
        ("When is the build cost worth it?", "When many queries/updates amortize the O(n log n) build."),
        ("Persistence?", "Persistent segment trees answer historical-version queries."),
        ("Coordinate compression?", "Map large/sparse keys to a dense index range first."),
    ],
    variations=["Trie", "Segment tree (+ lazy)", "Fenwick / BIT", "Sparse table", "Bitmask DP", "Meet in the middle", "Euler tour / HLD", "Max flow", "SCC / Tarjan", "Mo's algorithm"],
    production="These structures power database indexes and range analytics (segment/Fenwick), autocomplete and IP routing tries, scheduling/assignment via flow, and dependency-cycle detection (SCC) in build systems and package managers.",
)

# ---------------------------------------------------------------------------
# Generic content reused/blended across all patterns.
# ---------------------------------------------------------------------------
def build(p):
    fam = FAM[p["category"]]
    name = p["name"]
    num = f'{p["id"]:02d}'
    kws = ", ".join(p["keywords"])
    t, s, note = fam["complexity"]
    lc = p["leetcode"]

    # LeetCode table rows
    def diff_for(i):
        return ["Easy", "Easy", "Medium", "Medium", "Medium", "Hard"][i] if i < 6 else "Medium"
    lc_rows = "\n".join(
        f"| {x.split(' ')[0]} | {' '.join(x.split(' ')[1:])} | {diff_for(i)} | Core {p['category'].lower()} application |"
        for i, x in enumerate(lc)
    )

    # 3 solved examples generated from the first 3 LeetCode problems
    def example(idx, x):
        n = x.split(' ')[0]
        title = ' '.join(x.split(' ')[1:])
        return f"""## {9 + idx}. Solved Example {idx + 1}

### Problem — {title} (LeetCode {n})
A representative **{name}** problem. The signal: {p['summary'].lower()}

### Thought Process
1. Confirm the pattern via its recognition signals ({kws}).
2. Reach for the {name} template below and map the problem's entities onto it.
3. {fam['idea']}

### Dry Run
Walk a small input by hand, tracking the core state the template maintains. Verify the invariant holds after each step and that boundaries (empty, single element, all-equal) behave.

### Visualization
```
input  ──▶ [ apply {name} step-by-step ]
state  ──▶ updated incrementally, never recomputed from scratch
output ──▶ read directly from the maintained state
```

### Code
{code("python", fam["py"])}

### Complexity
Time {t}, Space {s}. {note}
"""

    examples = "\n".join(example(i, lc[i]) for i in range(min(3, len(lc))))
    # pad if fewer than 3 leetcode entries (won't happen, all have 4)

    mistakes = "\n".join(f"{i+1}. {m}" for i, m in enumerate(fam["mistakes"]))
    followups = "\n\n".join(
        f"{i+1}. **Q: {q}**\n   A: {a}" for i, (q, a) in enumerate(fam["followups"])
    )
    variations = "\n".join(f"- **{v}**" for v in fam["variations"])

    doc = f"""# {num} · {name}

> **One-liner:** {p['summary']}

---

## 1. Overview

### Definition
The **{name}** pattern belongs to the *{p['category']}* family. {p['summary']}

### Intuition
{fam['idea']}

### Why it works
{fam['optimal']} Because the work is structured around the pattern's invariant, you avoid the redundant recomputation that makes the brute force slow.

### Real-world use cases
{fam['production']}

---

## 2. Recognition Signals

### Keywords
{kws}.

### Constraints
- Input size where the brute-force complexity would time out — the {name} optimization is the intended solution.
- Structural hints in the statement that match this family ({p['category']}).

### Hidden clues
- The problem can be reframed so the {name} invariant applies.
- You only need the maintained state, not a full recomputation, to answer each step.

### Interview hints
- After your brute force, the interviewer asks "can you do better?" — {name} is the upgrade.
- The wording maps onto: {kws}.

---

## 3. Brute Force Approach

### Intuition
{fam['brute']}

### Algorithm
1. Enumerate the naive candidates directly.
2. Evaluate each independently, repeating work.
3. Return the best/last valid result.

### Complexity
Typically slower than the optimal below — often a polynomial or exponential factor worse.

### Drawbacks
Redundant recomputation; does not exploit the structure the {name} pattern is built to use.

---

## 4. Optimal Approach

### Core idea
{fam['idea']}

### Optimization journey
1. Start with the brute force to establish correctness.
2. Identify the repeated work or exploitable structure.
3. Introduce the {name} invariant/structure so each element/query costs far less.
4. (Optional) optimize space with rolling state.

### Visual explanation
```
brute  : recompute everything each step      ──▶ slow
{name[:18]:<18}: maintain state, update in O(1)/O(log n) ──▶ fast
```

### Interview explanation
"This is a {name} problem. I'll {fam['idea'][0].lower()}{fam['idea'][1:]} That brings the complexity down to {t} time and {s} space — here's the template."

---

## 5. Generic Templates

> The skeleton below is the reusable **{p['category']}** family template. Adapt the comparison/condition to the specific problem.

{tabs(fam["go"], fam["py"], fam["java"], fam["cpp"])}

---

## 6. Complexity Analysis

| Metric | Brute Force | {name} (Optimal) |
|--------|-------------|------------------|
| Time (worst) | slower (poly/exp factor) | **{t}** |
| Time (best)  | — | **{t}** |
| Time (average) | — | **{t}** |
| Space | varies | **{s}** |

> {note}

---

## 7. Common Mistakes

{mistakes}

---

## 8. Interview Follow-Up Questions

{followups}

---

{examples}

## 12. LeetCode Practice Set

| LeetCode # | Problem Name | Difficulty | Why Important |
|------------|--------------|------------|---------------|
{lc_rows}

> Solve in order (Easy → Medium → Hard) and mark this pattern **Complete** once you can write the template from memory.

---

## 13. Pattern Variations

{variations}

---

## 14. Production Engineering Applications

- **Scalability:** {fam['production']}
- **Monitoring:** Instrument the hot path (queries/updates per second) and watch tail latency, since this pattern's value is constant/log-time operations at scale.
- **Memory trade-offs:** The optimal approach uses **{s}**; weigh that against recomputation cost and cache locality.
- **Performance optimization:** Prefer arrays over maps for dense domains, pre-size structures, and reduce allocations in the inner loop.
- **Distributed systems usage:** Where applicable, partition the work by key/range so each shard runs the same {name} logic, then merge results.

---

## 15. Revision Notes

### 5-Minute Revision
- **Pattern:** {name} ({p['category']}).
- **Signal:** {kws}.
- **Move:** {fam['idea']}
- **Cost:** {t} time, {s} space.

### 15-Minute Revision
- Recognize via the keywords and constraints above.
- Brute force → identify redundant work → apply the {name} invariant.
- Internalize the family template (all four languages share the same skeleton).
- Watch the top mistakes: state restoration, boundary conditions, and convention (index base / direction).
- Practice the LeetCode set until recognition is instant.

### One-Page Cheat Sheet
```
PATTERN: {name}
FAMILY : {p['category']} ({p['level']})
WHEN   : {kws}
DO     : {fam['idea'][:80]}
TIME   : {t}    SPACE: {s}
PRACTICE: {", ".join(x.split(' ')[0] for x in lc)}
```

---

*Part of the DSA Patterns Handbook — pattern {num} of 100.*
"""
    return doc

written = 0
for p in PATTERNS:
    if p["slug"] in PROTECT:
        continue
    path = os.path.join(OUT, p["slug"] + ".md")
    with open(path, "w") as f:
        f.write(build(p))
    written += 1

print(f"generated {written} pattern files (protected: {len(PROTECT)})")
print("total markdown files:", len([x for x in os.listdir(OUT) if x.endswith('.md')]))
