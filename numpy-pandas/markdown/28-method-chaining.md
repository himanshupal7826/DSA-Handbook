# 28 · Method Chaining & Pipelines

> **In one line:** Express a transformation as one top-to-bottom flow of pandas methods — `assign`/`loc`/`pipe` linked without naming a dozen intermediate frames — so the code reads like the analysis it performs.

---

## 1. Overview

A pandas script often grows into a swamp of throwaway variables: `df2 = df[...]`, `df3 = df2.assign(...)`, `df4 = df3.groupby(...)`. Each name is a place to leak a bug (did you mutate `df2` or `df`?), and the *order of operations* — the actual analysis — is buried under bookkeeping. **Method chaining** replaces that with a single expression where each method returns a new DataFrame that the next method consumes.

You reach for chaining when a transformation is a **pipeline**: filter → derive columns → group → aggregate → sort → select. Written as a chain, the code reads like a recipe, top to bottom, with no intermediate names to track and no ambiguity about which frame is "current."

Chaining also sidesteps two classic pandas hazards. Because each step returns a *fresh* object rather than mutating in place, you rarely trigger the **`SettingWithCopyWarning`**, and you never accidentally reuse a half-transformed frame. The whole computation is one referentially-transparent expression.

The trade-off is debuggability: you can't `print` between steps of a chain as easily. Seniors manage this with `.pipe`, judicious chain-breaks, and small logging taps. The real skill is knowing **when to chain and when to stop**.

## 2. Core Concepts

- **Return-a-new-frame methods** — `assign`, `query`, `loc`/`filter`, `rename`, `sort_values`, `groupby().agg`, `merge`, `pipe` all return a new object, so they compose. In-place ops (`df.x = ...`, `inplace=True`) break the chain.
- **`assign`** — adds/overwrites columns and returns a new frame. Accepts **lambdas** (`col=lambda d: d.a + d.b`) so a new column can reference the *current* state of the chain, including columns created earlier in the same `assign`.
- **`pipe`** — inserts an arbitrary function into the chain: `df.pipe(my_func, arg)`. The escape hatch for logic pandas has no method for, while keeping the flow readable.
- **`query`** — string-based row filtering (`df.query("region == 'US' and spend > 100")`) that reads cleanly inside a chain, versus bracket boolean masks. Reference locals with `@var`.
- **`loc` in a chain** — `.loc[lambda d: d.x > 0]` uses a callable so the mask is computed against the *current* frame, not a pre-chain variable.
- **Copy-on-Write (CoW)** — pandas 3.0's default; every chain step behaves as if it returns an independent copy, which makes chaining safe and kills most `SettingWithCopy` warnings.
- **Referential transparency** — a chain is one expression with no side effects; run it twice, get the same result. Easier to reason about and test.
- **The parenthesis wrap** — wrap the whole chain in `( ... )` so you can put each method on its own line without backslashes.
- **Break the chain deliberately** — when a step is expensive, reused, or needs inspection, assign it a *meaningful* name. Chaining is a tool, not a religion.

## 3. Syntax & Examples

```python
import pandas as pd

# The swamp: intermediate variables, easy to misuse
tmp = df[df["region"] == "US"]
tmp = tmp.assign(margin=tmp["revenue"] - tmp["cost"])
grouped = tmp.groupby("product")["margin"].sum()
result = grouped.sort_values(ascending=False).head(5)
```

```python
# The chain: one expression, wrapped in parens, one method per line
result = (
    df
    .query("region == 'US'")
    .assign(margin=lambda d: d["revenue"] - d["cost"])
    .groupby("product", as_index=False)["margin"].sum()
    .sort_values("margin", ascending=False)
    .head(5)
)
```

```python
# assign can reference columns it just created (evaluated left to right)
out = (
    df
    .assign(
        gross=lambda d: d.price * d.qty,
        net=lambda d: d.gross * (1 - d.discount),   # uses gross from above
        net_pct=lambda d: d.net / d.gross,
    )
)

# loc / query with a callable = mask against the CURRENT frame
big = (
    df
    .assign(total=lambda d: d.price * d.qty)
    .loc[lambda d: d.total > 1000]        # 'total' exists only inside the chain
)
```

## 4. Worked Example

**Task:** from raw sales rows, keep completed orders, derive `revenue`, total revenue per category, and return the top 3 categories — as one chain.

```python
import pandas as pd

sales = pd.DataFrame({
    "order":    [1, 2, 3, 4, 5, 6],
    "category": ["A", "B", "A", "C", "B", "A"],
    "status":   ["done", "done", "cancelled", "done", "done", "done"],
    "price":    [10, 20, 15, 40, 25, 30],
    "qty":      [3, 1, 2, 1, 4, 2],
})

report = (
    sales
    .query("status == 'done'")
    .assign(revenue=lambda d: d["price"] * d["qty"])
    .groupby("category", as_index=False)["revenue"].sum()
    .sort_values("revenue", ascending=False)
    .head(3)
    .reset_index(drop=True)
)
print(report)
```

Input (rows surviving the `status == 'done'` filter — order 3 is dropped):

| order | category | status | price | qty | revenue |
|------:|----------|--------|------:|----:|--------:|
| 1     | A        | done   | 10    | 3   | 30      |
| 2     | B        | done   | 20    | 1   | 20      |
| 4     | C        | done   | 40    | 1   | 40      |
| 5     | B        | done   | 25    | 4   | 100     |
| 6     | A        | done   | 30    | 2   | 60      |

Output:

| category | revenue |
|----------|--------:|
| B        | 120     |
| A        | 90      |
| C        | 40      |

The entire analysis — filter, derive, aggregate, rank — is one readable expression with zero intermediate variables and no mutation of `sales`.

## 5. Under the Hood

Each chained method returns a **new object**, and the next method is called on that object. There is no shared mutable state between steps — the chain is a straight data-flow pipeline. Under **Copy-on-Write** (default in pandas 3.0), even steps that *look* like they might view-alias the original are guaranteed to behave as independent copies, so a chain can never accidentally write back into `df`.

```svg
<svg viewBox="0 0 720 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="c28" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>

  <rect x="20" y="90" width="110" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="114" text-anchor="middle" fill="#1e293b">df</text>
  <text x="75" y="132" text-anchor="middle" fill="#64748b" font-size="11">6 rows</text>

  <rect x="165" y="90" width="110" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="220" y="112" text-anchor="middle" fill="#1e293b" font-size="12">.query</text>
  <text x="220" y="130" text-anchor="middle" fill="#64748b" font-size="11">status==done</text>

  <rect x="310" y="90" width="110" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="365" y="112" text-anchor="middle" fill="#1e293b" font-size="12">.assign</text>
  <text x="365" y="130" text-anchor="middle" fill="#64748b" font-size="11">+ revenue</text>

  <rect x="455" y="90" width="110" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="510" y="112" text-anchor="middle" fill="#1e293b" font-size="12">.groupby.sum</text>
  <text x="510" y="130" text-anchor="middle" fill="#64748b" font-size="11">per category</text>

  <rect x="600" y="90" width="100" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="650" y="112" text-anchor="middle" fill="#1e293b" font-size="12">.sort.head</text>
  <text x="650" y="130" text-anchor="middle" fill="#64748b" font-size="11">top 3</text>

  <line x1="130" y1="118" x2="163" y2="118" stroke="#475569" marker-end="url(#c28)"/>
  <line x1="275" y1="118" x2="308" y2="118" stroke="#475569" marker-end="url(#c28)"/>
  <line x1="420" y1="118" x2="453" y2="118" stroke="#475569" marker-end="url(#c28)"/>
  <line x1="565" y1="118" x2="598" y2="118" stroke="#475569" marker-end="url(#c28)"/>

  <text x="360" y="40" text-anchor="middle" fill="#1e293b" font-weight="bold">Each step returns a NEW frame — no shared mutable state</text>
  <text x="360" y="60" text-anchor="middle" fill="#64748b" font-size="11">under Copy-on-Write, the original df is never touched</text>

  <text x="360" y="188" text-anchor="middle" fill="#d97706" font-weight="bold" font-size="12">Break here if a stage is reused / expensive / needs inspection</text>
  <line x1="365" y1="150" x2="365" y2="174" stroke="#d97706" stroke-dasharray="4 3" marker-end="url(#c28)"/>
  <text x="360" y="222" text-anchor="middle" fill="#64748b" font-size="11">stage = ( df.query(...).assign(...) );  then reuse `stage`</text>
</svg>
```

The `assign(col=lambda d: ...)` form is what makes chains self-contained: the lambda receives the *current* frame as `d`, so a new column can reference columns created earlier **in the same chain** without a separate variable. Passing a bare expression instead of a lambda would bind to the pre-chain `df` and miss those columns — the lambda defers evaluation to chain time.

## 6. Variations & Trade-offs

| Style | Intermediates | `SettingWithCopy` risk | Debuggability | Reads as |
|-------|---------------|------------------------|---------------|----------|
| Intermediate variables | many | higher (view/copy ambiguity) | easy (print each) | bookkeeping |
| Method chain | none | very low (fresh frames) | harder (opaque middle) | the analysis |
| `pipe` steps | none | very low | good (named funcs, testable) | a pipeline of verbs |
| `inplace=True` mutation | zero-copy myth | n/a (mutates) | error-prone | discouraged |

**Trade-offs.** Chaining wins on readability and safety but hides intermediate state — mitigate with `.pipe` for named, testable steps and by breaking the chain when a stage is expensive or reused. `inplace=True` rarely saves memory (pandas usually copies anyway) and forfeits chaining; prefer reassignment. For very long or reused logic, factor stages into small functions and compose them with `.pipe` — you get both readability and unit-testable pieces.

## 7. Production / Performance Notes

- **Chaining has no runtime penalty.** Each method would allocate a new frame anyway; chaining just skips naming them. It's a readability choice, not a speed cost.
- **`.pipe` for custom, testable steps.** `df.pipe(add_features).pipe(filter_active).pipe(score)` reads like a pipeline and each function is unit-testable in isolation — the pattern for production ETL.
- **Insert debug taps without breaking the chain.** Keep a small `tap()` helper that logs `df.shape`/`df.columns` and returns `d` unchanged, then `.pipe(tap)` anywhere you want visibility.
- **Break the chain when a stage is reused.** If two outputs share the first four steps, compute that prefix once into a named frame — recomputing it in two chains wastes work.
- **Avoid `inplace=True`.** It's being deprecated in many methods, blocks chaining, and (contrary to intuition) usually doesn't avoid a copy. Reassign instead.
- **Copy-on-Write (pandas 3.0) makes chains cheap and safe.** Copies are lazy — data is only duplicated when actually written — so the "new frame per step" model rarely duplicates buffers needlessly.
- **Keep chains to a screen.** Beyond ~7–8 steps, readability inverts; factor into `.pipe`d functions with names that describe intent.

## 8. Common Mistakes

1. ⚠️ **`assign` with a bare expression instead of a lambda.** `assign(x=df.a + df.b)` binds to the pre-chain `df`, missing columns made earlier in the chain. → Use `assign(x=lambda d: d.a + d.b)`.
2. ⚠️ **Chained assignment `df[m]["col"] = v`.** Two `__getitem__`/`__setitem__` calls; the write may hit a temporary and silently no-op (the classic `SettingWithCopyWarning`). → Use `.loc[mask, "col"] = v` or `assign` in a chain.
3. ⚠️ **`inplace=True` inside a chain.** In-place methods return `None`, so the next method calls on `None` → `AttributeError`. → Drop `inplace`; reassign or chain.
4. ⚠️ **Forgetting the outer parentheses.** Line-per-method needs `( ... )` or trailing backslashes; without them Python ends the statement early. → Wrap the whole chain in parens.
5. ⚠️ **One monster chain you can't debug.** A 15-step chain that fails in the middle is opaque. → Break into named `.pipe` stages or intermediate frames at logical boundaries.
6. ⚠️ **Reusing a shared prefix by re-chaining it twice.** Recomputes the same filter/derive work. → Materialize the shared prefix once into a named frame.
7. ⚠️ **`query` referencing Python vars without `@`.** `query("x > threshold")` looks for a *column* `threshold`. → Use `query("x > @threshold")` to reference a local.

## 9. Interview Questions

**Q: What is method chaining in pandas and why use it?**
A: It's expressing a transformation as one linked sequence of methods, each returning a new DataFrame consumed by the next, so you avoid naming intermediate frames. Benefits: the code reads top-to-bottom like the analysis, there's no ambiguity about which frame is current, and because each step returns a fresh object it sidesteps most `SettingWithCopy` issues and accidental mutation.

**Q: Why does `assign` take a lambda, and when does it matter?**
A: A lambda `col=lambda d: ...` receives the *current* frame at chain time, so the new column can reference columns created earlier in the same chain. A bare expression is evaluated immediately against the pre-chain frame and can't see those in-chain columns — it also breaks referential transparency if `df` is later reassigned.

**Q: What does `.pipe` do and when do you prefer it over more methods?**
A: `.pipe(func, *args)` passes the current frame to an arbitrary function and returns its result, letting you insert custom logic without leaving the chain. Prefer it when pandas has no built-in method for the step, or when you want named, independently unit-testable stages — e.g. `df.pipe(clean).pipe(featurize).pipe(score)`.

**Q: How does chaining help avoid `SettingWithCopyWarning`?**
A: The warning arises from chained indexing assignment on an object that may be a view or a copy. Chaining uses methods that each return a new, independent frame (and under Copy-on-Write always behave as copies), so you assign via `assign`/`loc` on well-defined objects instead of writing through an ambiguous intermediate.

**Q: When should you NOT chain — when do you break the chain?**
A: Break it when a stage is expensive and reused (materialize it once), when you need to inspect/log intermediate state, when the chain exceeds roughly a screenful and readability inverts, or when a stage deserves a descriptive name for clarity. Chaining is a readability tool, not a mandate.

**Q: Does method chaining make pandas slower?**
A: No. Those methods each allocate a new frame whether or not you name the result, so chaining adds no work — it only removes the intermediate variable names. Any performance difference comes from *what* operations you do, not from chaining them.

**Q: Why avoid `inplace=True`?**
A: It returns `None` (so it can't be chained and causes `AttributeError` mid-chain), it's being deprecated across many methods, and it usually doesn't even avoid a copy internally — so the supposed memory benefit is largely a myth. Reassigning the result is clearer and composable.

**Q: (Senior) How does Copy-on-Write change the chaining story in pandas 3.0?**
A: CoW makes every operation behave as if it returns an independent copy, but copies are lazy — the underlying data is only duplicated when a write actually occurs. This eliminates view/copy ambiguity (killing most `SettingWithCopy` warnings), makes chains provably side-effect-free, and keeps them cheap because unmodified buffers are shared until mutated.

**Q: (Senior) How do you debug a long chain without dismantling it?**
A: Insert a `tap` via `.pipe(lambda d: (log(d.shape, d.columns), d)[1])` that logs and returns the frame unchanged, use `.pipe` to name stages so failures point at a function, or temporarily split the chain at a boundary into a named frame. In notebooks you can also comment out the tail and evaluate the prefix.

**Q: (Senior) How do you filter rows inside a chain against a column that only exists mid-chain?**
A: Use a callable in `loc` or `query`: `.loc[lambda d: d.total > 1000]` or `.query("total > 1000")` after the `assign` that creates `total`. The callable is evaluated against the current frame, so it sees in-chain columns; a pre-chain boolean mask would not.

## 10. Practice

- [ ] Rewrite a 4-variable transformation (filter → derive → group → sort) as a single parenthesized chain and diff the readability.
- [ ] Build a chain where one `assign` creates `gross`, then `net` that references `gross` — confirm ordering works.
- [ ] Extract three chain stages into functions and recompose them with `.pipe`; add a unit test for one stage.
- [ ] Add a `tap()` helper that logs `df.shape` and returns the frame, and insert it twice into a chain via `.pipe`.
- [ ] Reproduce a `SettingWithCopyWarning` with chained indexing, then fix it with `.loc`/`assign` inside a chain.

## 11. Cheat Sheet

> [!TIP]
> **Chaining = one flow, no throwaway names.** Wrap in `( ... )`, one method per line: `.query()` → `.assign(col=lambda d: ...)` → `.groupby().agg()` → `.sort_values()` → `.head()`. Use **lambdas** in `assign`/`loc`/`query` so steps see columns made earlier in the chain (`.loc[lambda d: d.total>0]`). Drop into `.pipe(func, *args)` for custom, testable stages. **Avoid** `inplace=True` (returns `None`, breaks chains, no real memory win) and chained-index assignment (`df[m]["c"]=v` → use `.loc[m,"c"]=v`). Copy-on-Write makes chains safe and cheap. Break the chain when a stage is reused, expensive, or needs a name — chaining is a tool, not a rule.

**References:** pandas User Guide — "Copy-on-Write" & "Indexing", pandas API `DataFrame.assign`/`DataFrame.pipe`/`DataFrame.query`, Tom Augspurger "Modern Pandas: Method Chaining", Matt Harrison "Effective Pandas"

---
*NumPy & Pandas Handbook — topic 28.*
