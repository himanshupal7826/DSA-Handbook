# 11 · Reshaping: Pivot & Melt

> **In one line:** Switch between wide and long formats.

---

## 1. Overview

Reshape between **long** (tidy) and **wide** formats: `pivot`/`pivot_table` spread a key column into columns; `melt` collapses columns into key/value rows; `stack`/`unstack` move between columns and index levels.

## 2. Key Concepts

- pivot_table aggregates (handles duplicates); pivot doesn't.
- melt: wide → long (id_vars + value_vars).
- stack/unstack move levels between index and columns.
- Tidy (long) data is best for analysis; wide for display.
- Aggfunc controls how pivot_table combines duplicates.

## 3. Syntax & Code

```python
wide = df.pivot_table(index='city', columns='year', values='sales', aggfunc='sum')
long = wide.reset_index().melt(id_vars='city', var_name='year', value_name='sales')
```

## 4. Worked Example

**Melt to tidy format**

Turn year columns into rows:

```python
tidy = df.melt(id_vars=['name'], value_vars=['2025', '2026'],
               var_name='year', value_name='amount')
```

## 5. Best Practices

- ✅ Prefer tidy (long) data for analysis/groupby/plots.
- ✅ Use pivot_table (not pivot) when duplicates exist.
- ✅ Choose an explicit aggfunc.
- ✅ Name var/value columns clearly in melt.
- ✅ reset_index after pivot to flatten.

## 6. Common Pitfalls

1. ⚠️ pivot failing on duplicate index/column pairs (use pivot_table).
2. ⚠️ Forgetting aggfunc and getting unexpected aggregation.
3. ⚠️ MultiIndex columns after pivot complicating access.
4. ⚠️ Losing columns not in id_vars during melt.
5. ⚠️ Confusing stack (cols→index) with unstack.
6. ⚠️ Wide format making row-wise analysis awkward.

## 7. Interview Questions

1. **Q: pivot vs pivot_table?**
   A: pivot_table aggregates duplicates via aggfunc; pivot errors on duplicate index/column pairs.

2. **Q: What does melt do?**
   A: Unpivots wide columns into long key/value rows (id_vars stay).

3. **Q: Wide vs long (tidy) data?**
   A: Long has one observation per row (best for analysis); wide spreads a variable across columns.

4. **Q: stack vs unstack?**
   A: stack moves columns into the index (wider→longer); unstack does the reverse.

5. **Q: Why specify aggfunc?**
   A: To define how duplicate cells combine (sum/mean/count).

6. **Q: Handling MultiIndex after pivot?**
   A: reset_index / flatten column levels for easier access.

7. **Q: When pivot fails?**
   A: Duplicate (index, column) combinations — switch to pivot_table.

8. **Q: Which format for groupby/plotting?**
   A: Long/tidy format.

## 8. Practice

- [ ] Pivot sales by city × year with sum.
- [ ] Melt year columns back to long format.
- [ ] Use stack/unstack on a small frame.

## 9. Quick Revision

Reshape wide↔long: pivot_table (aggregates dup), melt (wide→long), stack/unstack (cols↔index). Prefer tidy/long for analysis; set aggfunc; flatten MultiIndex after pivot.

**References:** Reshaping

---

*NumPy & Pandas Handbook — topic 11.*
