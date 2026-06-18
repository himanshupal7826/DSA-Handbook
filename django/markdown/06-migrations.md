# 06 · Migrations

> **In one line:** Version-control your schema with auto-generated migrations.

---

## 1. Overview

Migrations are version-controlled, ordered changes to the database schema generated from model edits. `makemigrations` creates them; `migrate` applies them. **Data migrations** transform existing rows alongside schema changes.

## 2. Key Concepts

- makemigrations diffs models → migration files; migrate applies them.
- Migrations form a dependency graph across apps.
- Data migrations use RunPython for transforms.
- Reversible migrations support rollback.
- Squashing collapses many migrations into one.

## 3. Syntax & Code

```bash
python manage.py makemigrations books
python manage.py migrate
python manage.py sqlmigrate books 0002   # preview SQL
```

## 4. Worked Example

**Data migration**

Backfill a column with RunPython:

```python
from django.db import migrations
def set_slug(apps, schema_editor):
    Book = apps.get_model('books', 'Book')
    for b in Book.objects.all():
        b.slug = b.title.lower().replace(' ', '-'); b.save()
class Migration(migrations.Migration):
    dependencies = [('books', '0001_initial')]
    operations = [migrations.RunPython(set_slug, migrations.RunPython.noop)]
```

## 5. Best Practices

- ✅ Commit migrations with the model changes that created them.
- ✅ Use apps.get_model in data migrations (historical models).
- ✅ Make migrations reversible where possible.
- ✅ Test migrations on a copy of prod data.
- ✅ Add columns as nullable/with default for zero-downtime.

## 6. Common Pitfalls

1. ⚠️ Editing applied migrations instead of creating new ones.
2. ⚠️ Importing real models (not historical) in data migrations.
3. ⚠️ Non-nullable column without a default on a populated table.
4. ⚠️ Merge conflicts from parallel migrations (use makemigrations --merge).
5. ⚠️ Long-locking schema changes on big tables.
6. ⚠️ Forgetting to run migrate in deploys.

## 7. Interview Questions

1. **Q: What problem do migrations solve?**
   A: Versioned, repeatable, ordered schema evolution synced with model code.

2. **Q: makemigrations vs migrate?**
   A: makemigrations generates migration files from model diffs; migrate applies pending ones to the DB.

3. **Q: What is a data migration?**
   A: A migration that transforms existing data via RunPython, often alongside schema changes.

4. **Q: Why use apps.get_model in data migrations?**
   A: To get the historical model state at that migration point, not the current code.

5. **Q: How to add a NOT NULL column safely?**
   A: Add it nullable or with a default, backfill, then enforce NOT NULL.

6. **Q: How to resolve migration conflicts?**
   A: makemigrations --merge or reorder dependencies.

7. **Q: Are migrations reversible?**
   A: If operations define reverse logic; some (like data transforms) need an explicit reverse.

8. **Q: What does squashing do?**
   A: Combines a long migration history into fewer files for speed.

## 8. Practice

- [ ] Add a field and generate/apply a migration.
- [ ] Write a RunPython data migration to backfill.
- [ ] Preview a migration's SQL with sqlmigrate.

## 9. Quick Revision

Migrations = versioned schema changes (makemigrations→migrate). Use historical models in data migrations, keep them reversible, add columns safely (nullable/default) for zero downtime.

**References:** Migrations docs

---

*Django Handbook — topic 06.*
