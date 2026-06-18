# 01 · Django Architecture (MVT)

> **In one line:** Request flow through URLs, views, models, and templates.

---

## 1. Overview

Django uses the **Model-View-Template (MVT)** pattern. A request hits the URL dispatcher, which routes to a **view**; the view talks to **models** (the ORM) and renders a **template** or returns JSON. Settings, apps, and middleware wrap the whole cycle.

## 2. Key Concepts

- URLconf maps URL patterns to view callables.
- Views contain request-handling logic (function- or class-based).
- Models define the schema and ORM access.
- Templates render HTML; DRF/JsonResponse return APIs.
- Middleware processes every request/response (auth, sessions, CSRF).

## 3. Syntax & Code

```python
# urls.py
from django.urls import path
from . import views
urlpatterns = [path('books/<int:pk>/', views.book_detail, name='book')]

# views.py
from django.shortcuts import get_object_or_404, render
from .models import Book
def book_detail(request, pk):
    book = get_object_or_404(Book, pk=pk)
    return render(request, 'book.html', {'book': book})
```

## 4. Worked Example

**The request lifecycle**

Request → middleware → URL resolver → view → model/template → middleware → response. Each app is a reusable package registered in INSTALLED_APPS.

```python
# settings.py
INSTALLED_APPS = ['django.contrib.admin', 'books', 'rest_framework']
```

## 5. Best Practices

- ✅ Keep views thin; push logic into models/services.
- ✅ Use named URL patterns and `reverse()` instead of hardcoded paths.
- ✅ Split settings per environment (base/dev/prod).
- ✅ Organize code into small, focused apps.
- ✅ Use get_object_or_404 for clean 404 handling.

## 6. Common Pitfalls

1. ⚠️ Business logic crammed into views ('fat views').
2. ⚠️ Hardcoding URLs instead of using names.
3. ⚠️ Committing secrets in settings.py.
4. ⚠️ Forgetting to register apps in INSTALLED_APPS.
5. ⚠️ Misordered middleware breaking auth/CSRF.
6. ⚠️ Mixing API and template concerns in one view.

## 7. Interview Questions

1. **Q: What is MVT?**
   A: Model-View-Template: models = data, views = logic, templates = presentation; URLconf routes requests.

2. **Q: How does a request flow through Django?**
   A: Through middleware, the URL resolver, the view (which uses models/templates), and back out through middleware.

3. **Q: Function vs class-based views?**
   A: FBVs are explicit and simple; CBVs offer reuse via mixins and generic views.

4. **Q: What is middleware?**
   A: Hooks that process every request/response globally (sessions, auth, CSRF, gzip).

5. **Q: Why split settings?**
   A: To keep secrets out of code and vary config (DB, debug, hosts) per environment.

6. **Q: What is an 'app' in Django?**
   A: A self-contained, reusable module (models/views/urls) registered in INSTALLED_APPS.

7. **Q: How to avoid hardcoded URLs?**
   A: Name patterns and use reverse()/{% url %}.

8. **Q: Where does CSRF protection live?**
   A: In middleware + template token for unsafe methods.

## 8. Practice

- [ ] Wire a URL → view → template for a detail page.
- [ ] Use reverse() to build a URL by name.
- [ ] Split settings into base/dev/prod.

## 9. Quick Revision

MVT: URLconf → view → model/template, wrapped by middleware. Keep views thin, name URLs, split settings, organize into apps.

**References:** Django docs: overview

---

*Django Handbook — topic 01.*
