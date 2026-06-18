# 08 · Security: CSRF, XSS, SQLi

> **In one line:** Django's built-in protections and how to keep them on.

---

## 1. Overview

Django defends against common web attacks by default: **CSRF** tokens on unsafe methods, **XSS** via template auto-escaping, and **SQL injection** via the parameterized ORM. The risks come from bypassing these defaults (raw SQL, mark_safe, disabled middleware).

## 2. Key Concepts

- CSRF middleware + {% csrf_token %} protect state-changing requests.
- Templates auto-escape variables, preventing reflected XSS.
- The ORM parameterizes queries; raw SQL must use params.
- Security settings: SECURE_SSL_REDIRECT, HSTS, secure cookies.
- Never trust client input; validate with forms/serializers.

## 3. Syntax & Code

```python
# Safe raw SQL — parameters, never string formatting
Book.objects.raw('SELECT * FROM books_book WHERE title = %s', [title])
# UNSAFE: f"... WHERE title = '{title}'"  -> SQL injection
```

## 4. Worked Example

**Don't disable escaping blindly**

mark_safe / |safe reintroduce XSS if the content isn't sanitized:

```python
# Only mark_safe content you fully control/sanitize
from django.utils.html import escape
safe = escape(user_input)
```

## 5. Best Practices

- ✅ Keep CSRF, security middleware, and auto-escaping enabled.
- ✅ Parameterize any raw SQL.
- ✅ Set HTTPS, HSTS, secure & HttpOnly cookies in prod.
- ✅ Validate/sanitize all input via forms/serializers.
- ✅ Keep Django and dependencies patched.

## 6. Common Pitfalls

1. ⚠️ Disabling CSRF on POST endpoints.
2. ⚠️ Using |safe/mark_safe on untrusted content (XSS).
3. ⚠️ Building SQL with f-strings/% formatting (SQLi).
4. ⚠️ DEBUG=True in production (leaks internals).
5. ⚠️ Wildcard ALLOWED_HOSTS.
6. ⚠️ Storing secrets in code/repo.

## 7. Interview Questions

1. **Q: How does Django prevent CSRF?**
   A: A per-session token required on unsafe (POST/PUT/DELETE) requests, checked by middleware.

2. **Q: How is XSS mitigated?**
   A: Templates auto-escape variables; you opt out only with mark_safe/|safe on trusted content.

3. **Q: How does the ORM stop SQL injection?**
   A: It parameterizes queries; values are bound, never concatenated into SQL.

4. **Q: Risks of DEBUG=True in prod?**
   A: Detailed error pages leak settings, stack traces, and SQL — a serious info disclosure.

5. **Q: What does ALLOWED_HOSTS do?**
   A: Restricts which Host headers are served, preventing host-header attacks.

6. **Q: How to write safe raw SQL?**
   A: Use parameter placeholders (%s) with a params list, never string interpolation.

7. **Q: Key production security settings?**
   A: HTTPS redirect, HSTS, SECURE/HttpOnly/SameSite cookies, restricted ALLOWED_HOSTS.

8. **Q: How to store secrets?**
   A: Environment variables / secret managers, not in the repo.

## 8. Practice

- [ ] Add {% csrf_token %} to a form and test protection.
- [ ] Rewrite an f-string SQL query to parameterized.
- [ ] Configure prod security settings (HSTS, secure cookies).

## 9. Quick Revision

Django defaults guard CSRF (tokens), XSS (auto-escape), SQLi (parameterized ORM). Keep them on; parameterize raw SQL; HTTPS/HSTS/secure cookies; DEBUG=False; restrict ALLOWED_HOSTS; secrets in env.

**References:** Security in Django

---

*Django Handbook — topic 08.*
