# 04 · Views: Function & Class-Based

> **In one line:** Handle requests with FBVs or reusable generic CBVs.

---

## 1. Overview

Views turn requests into responses. **Function-based views (FBVs)** are explicit; **class-based views (CBVs)** provide reuse through generic views (ListView, DetailView, CreateView) and mixins. Choose based on how much standard CRUD you can reuse.

## 2. Key Concepts

- FBV: a function taking request → response; branch on request.method.
- CBV: methods like get()/post(); generic views handle CRUD.
- Mixins add cross-cutting behavior (LoginRequiredMixin).
- get_queryset/get_context_data customize generic views.
- URLconf points to View.as_view().

## 3. Syntax & Code

```python
from django.views.generic import ListView
class BookList(ListView):
    model = Book
    paginate_by = 20
    def get_queryset(self):
        return Book.objects.select_related('author').order_by('-published')
```

## 4. Worked Example

**FBV equivalent**

The explicit version:

```python
def book_list(request):
    books = Book.objects.select_related('author')[:20]
    return render(request, 'books.html', {'books': books})
```

## 5. Best Practices

- ✅ Use generic CBVs for standard CRUD; FBVs for custom flows.
- ✅ Override get_queryset/get_context_data instead of duplicating logic.
- ✅ Apply LoginRequiredMixin/permission mixins for access control.
- ✅ Keep views thin; delegate to services/forms.
- ✅ Paginate large lists.

## 6. Common Pitfalls

1. ⚠️ Reinventing CRUD when a generic view exists.
2. ⚠️ Overusing deep mixin chains that obscure flow.
3. ⚠️ Forgetting as_view() in URLconf.
4. ⚠️ Heavy logic in get()/post() instead of services.
5. ⚠️ Not handling both GET and POST in FBVs.
6. ⚠️ Mixin ordering (MRO) surprises.

## 7. Interview Questions

1. **Q: FBV vs CBV?**
   A: FBVs are explicit and simple; CBVs enable reuse via generic views and mixins for standard patterns.

2. **Q: How do generic views save code?**
   A: They implement common CRUD (List/Detail/Create/Update/Delete) you customize via hooks.

3. **Q: What are mixins?**
   A: Reusable behavior classes (e.g., LoginRequiredMixin) composed into CBVs.

4. **Q: Where do you customize a ListView's query?**
   A: Override get_queryset().

5. **Q: How is a CBV wired to a URL?**
   A: Via ClassName.as_view() in urlpatterns.

6. **Q: How to require login on a CBV?**
   A: Add LoginRequiredMixin (first) to the class.

7. **Q: get_context_data use?**
   A: Add extra template context in CBVs.

8. **Q: When avoid CBVs?**
   A: Highly custom, non-CRUD logic where explicit FBVs are clearer.

## 8. Practice

- [ ] Convert an FBV list to a ListView with pagination.
- [ ] Add LoginRequiredMixin to a CreateView.
- [ ] Override get_context_data to add stats.

## 9. Quick Revision

Views = request→response. FBVs explicit; CBVs reuse via generic views + mixins (override get_queryset/context). Wire CBVs with as_view(); keep views thin.

**References:** Class-based views docs

---

*Django Handbook — topic 04.*
