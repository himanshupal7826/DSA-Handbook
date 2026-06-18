# 07 · Selection: loc, iloc & Filtering

> **In one line:** Select by label (loc), position (iloc), and boolean masks.

---

## 1. Overview

Pandas offers explicit selection: **.loc** (label-based), **.iloc** (integer position), and **boolean masks** for filtering rows by condition. Using these correctly avoids the chained-indexing pitfalls that cause subtle bugs.

## 2. Key Concepts

- .loc[rows, cols] selects by labels (inclusive ranges).
- .iloc[rows, cols] selects by integer position.
- Boolean mask: df[df['age'] > 30].
- Combine conditions with & / | and parentheses.
- .query() offers a string expression alternative.

## 3. Syntax & Code

```python
df.loc[df['city'] == 'NYC', ['name', 'age']]
df.iloc[0:2, :]                 # first two rows by position
df[(df['age'] > 25) & (df['city'] == 'NYC')]
```

## 4. Worked Example

**Assign to a filtered subset**

Use .loc to set values safely:

```python
df.loc[df['age'] < 18, 'minor'] = True
```

## 5. Best Practices

- ✅ Use .loc/.iloc explicitly; avoid chained indexing.
- ✅ Wrap mask conditions in parentheses with & / |.
- ✅ Use .loc for label-based assignment.
- ✅ Prefer .query() for readable complex filters.
- ✅ Reset the index after heavy filtering if needed.

## 6. Common Pitfalls

1. ⚠️ Chained indexing (df[...][...] = ) causing SettingWithCopyWarning.
2. ⚠️ Using and/or instead of & / | on masks.
3. ⚠️ Off-by-one: .loc label ranges are inclusive, .iloc exclusive.
4. ⚠️ Mixing label and position selection.
5. ⚠️ Forgetting parentheses around conditions.
6. ⚠️ Assuming filtered frames are independent copies.

## 7. Interview Questions

1. **Q: .loc vs .iloc?**
   A: loc selects by label (ranges inclusive); iloc by integer position (exclusive end).

2. **Q: How to filter rows?**
   A: Boolean mask: df[df.col > x], combine with & / | and parentheses.

3. **Q: Why avoid chained indexing?**
   A: It may operate on a copy, so assignments silently don't persist (SettingWithCopyWarning).

4. **Q: How to assign to a subset safely?**
   A: Use df.loc[mask, col] = value.

5. **Q: and/or vs & / |?**
   A: Use element-wise & / | with parentheses; Python and/or don't vectorize.

6. **Q: What does .query() do?**
   A: Filters with a string expression, often more readable.

7. **Q: Are loc ranges inclusive?**
   A: Yes for label-based loc; iloc end is exclusive.

8. **Q: How to get a guaranteed copy?**
   A: Call .copy() on the selection.

## 8. Practice

- [ ] Select rows by condition and specific columns with .loc.
- [ ] Filter with a compound mask.
- [ ] Fix a SettingWithCopyWarning using .loc.

## 9. Quick Revision

.loc=label (inclusive), .iloc=position (exclusive), masks=filter (& / | + parens). Assign via .loc; avoid chained indexing; .query() for readability; .copy() to detach.

**References:** Indexing and selecting

---

*NumPy & Pandas Handbook — topic 07.*
