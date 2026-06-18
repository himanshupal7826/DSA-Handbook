# 10 · Missing Data & Cleaning

> **In one line:** Detect, drop, fill, and impute NaNs cleanly.

---

## 1. Overview

Real data has gaps. Pandas represents missing values as **NaN/NA**; clean them by detecting (`isna`), dropping (`dropna`), or filling/imputing (`fillna`, interpolation, group means). The right strategy depends on why data is missing.

## 2. Key Concepts

- isna/notna detect missing values.
- dropna removes rows/cols with NaN (configurable thresholds).
- fillna with constants, ffill/bfill, or computed values.
- Group-wise imputation: fill with group mean/median.
- Nullable dtypes (Int64, boolean) preserve NA in integers.

## 3. Syntax & Code

```python
df['age'] = df['age'].fillna(df['age'].median())
df = df.dropna(subset=['email'])           # require email
df['price'] = df['price'].ffill()          # carry last value forward
```

## 4. Worked Example

**Group-wise imputation**

Fill missing with the group's mean:

```python
df['age'] = df['age'].fillna(df.groupby('city')['age'].transform('mean'))
```

## 5. Best Practices

- ✅ Understand *why* values are missing before imputing.
- ✅ Use median/group stats for robust imputation.
- ✅ Drop only when missingness is small/uninformative.
- ✅ Use nullable dtypes to keep NA in integer columns.
- ✅ Document cleaning steps for reproducibility.

## 6. Common Pitfalls

1. ⚠️ Blindly dropping rows and losing signal.
2. ⚠️ Filling with 0/mean when it biases analysis.
3. ⚠️ NaN != NaN comparisons (use isna).
4. ⚠️ ffill/bfill leaking future/past inappropriately.
5. ⚠️ Integer columns becoming float due to NaN.
6. ⚠️ Imputing before train/test split (data leakage).

## 7. Interview Questions

1. **Q: How are missing values represented?**
   A: As NaN (float NA) or pandas NA in nullable dtypes.

2. **Q: How to detect missing values?**
   A: isna()/notna() (and .sum() to count per column).

3. **Q: Strategies to handle NaN?**
   A: Drop, fill with constants, ffill/bfill, or impute with statistics/models.

4. **Q: Why median over mean for imputation?**
   A: Median is robust to outliers/skew.

5. **Q: Why do int columns become float?**
   A: Classic NaN requires float; use nullable Int64 to keep integers.

6. **Q: Risk of imputing before split?**
   A: Data leakage — fit imputation on train only.

7. **Q: Group-wise imputation?**
   A: fillna with groupby(...).transform('mean'/'median').

8. **Q: ffill vs bfill caution?**
   A: They can leak temporally; ensure it's valid for the data.

## 8. Practice

- [ ] Count missing values per column.
- [ ] Impute a numeric column with its median.
- [ ] Do group-wise mean imputation.

## 9. Quick Revision

Missing = NaN/NA: detect (isna), drop (dropna), fill/impute (fillna, ffill/bfill, group stats). Prefer median/group imputation, understand the cause, use nullable dtypes, avoid leakage.

**References:** Working with missing data

---

*NumPy & Pandas Handbook — topic 10.*
