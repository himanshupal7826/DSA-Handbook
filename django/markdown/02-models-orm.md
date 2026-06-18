# 02 · Models & the ORM

> **In one line:** Define schema as Python classes; query without raw SQL.

---

## 1. Overview

Django **models** are Python classes that map to database tables. The **ORM** translates Python queries (`Model.objects.filter(...)`) into SQL and returns model instances. Relationships (`ForeignKey`, `ManyToMany`, `OneToOne`) model associations.

## 2. Key Concepts

- Each model field maps to a column with a type and constraints.
- QuerySets are lazy — evaluated only when iterated/sliced.
- Relationships: ForeignKey (M:1), ManyToManyField, OneToOneField.
- Managers (objects) are the query entry point; add custom managers.
- `null` (DB) vs `blank` (validation) are different.

## 3. Syntax & Code

```python
from django.db import models
class Author(models.Model):
    name = models.CharField(max_length=100)
class Book(models.Model):
    title = models.CharField(max_length=200)
    author = models.ForeignKey(Author, on_delete=models.CASCADE, related_name='books')
    published = models.DateField(db_index=True)

# query
recent = Book.objects.filter(published__year=2026).order_by('-published')
```

## 4. Worked Example

**Traversing relationships**

Follow related objects with double-underscore lookups:

```python
Book.objects.filter(author__name='Ann')
author.books.all()  # reverse via related_name
```

## 5. Best Practices

- ✅ Set on_delete explicitly for ForeignKeys.
- ✅ Add db_index to columns you filter/sort on.
- ✅ Use related_name for readable reverse access.
- ✅ Keep model methods for row-level behavior; managers for table-level.
- ✅ Use NUMERIC/DecimalField for money.

## 6. Common Pitfalls

1. ⚠️ Confusing null (DB) with blank (form validation).
2. ⚠️ Forgetting on_delete (required) → error.
3. ⚠️ Evaluating a QuerySet repeatedly (re-hitting the DB).
4. ⚠️ Storing money as FloatField.
5. ⚠️ Editing a migration's model without making a new migration.
6. ⚠️ CharField without max_length.

## 7. Interview Questions

1. **Q: What is a QuerySet and why lazy?**
   A: A query representation evaluated only when needed (iteration/len/slice), enabling chaining and fewer DB hits.

2. **Q: ForeignKey on_delete options?**
   A: CASCADE, PROTECT, SET_NULL, SET_DEFAULT, DO_NOTHING — define referential behavior on delete.

3. **Q: null vs blank?**
   A: null controls DB NULL; blank controls form/validation emptiness.

4. **Q: How to traverse relations in queries?**
   A: Double-underscore lookups: filter(author__name=...).

5. **Q: How does the ORM map to SQL?**
   A: Each model = table, field = column, QuerySet = SELECT; the ORM compiles and executes it.

6. **Q: What are managers?**
   A: Table-level query interfaces (default objects); customize for reusable queries.

7. **Q: ManyToMany under the hood?**
   A: A junction table; Django manages it (or use through= for extra fields).

8. **Q: How to add a DB index?**
   A: db_index=True on a field, or Meta.indexes for composite indexes.

## 8. Practice

- [ ] Model Author/Book with a ForeignKey + related_name.
- [ ] Query books by author name via lookups.
- [ ] Add a composite index in Meta.

## 9. Quick Revision

Models map classes→tables; the ORM returns instances from lazy QuerySets. Set on_delete, index filtered columns, use related_name, mind null vs blank.

**References:** Django ORM docs

---

*Django Handbook — topic 02.*
