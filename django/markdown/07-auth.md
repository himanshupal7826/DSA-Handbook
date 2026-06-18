# 07 · Authentication & Authorization

> **In one line:** Users, sessions, permissions, and access control.

---

## 1. Overview

Django ships a full auth system: a `User` model, session-based login, password hashing, permissions, and groups. **Authentication** verifies identity; **authorization** checks what a user may do (permissions, `@login_required`, mixins).

## 2. Key Concepts

- authenticate() + login() establish a session.
- Permissions are per-model (add/change/delete/view) + custom.
- Groups bundle permissions for roles.
- Decorators/mixins enforce access (@login_required, PermissionRequiredMixin).
- Use a custom user model from the start if you may extend it.

## 3. Syntax & Code

```python
from django.contrib.auth import authenticate, login
def sign_in(request):
    user = authenticate(request, username=u, password=p)
    if user is not None:
        login(request, user)   # sets the session cookie
```

## 4. Worked Example

**Protect a view**

Require login and a permission:

```python
from django.contrib.auth.decorators import login_required, permission_required
@login_required
@permission_required('books.add_book', raise_exception=True)
def create_book(request): ...
```

## 5. Best Practices

- ✅ Define a custom user model before the first migration.
- ✅ Never store plaintext passwords (Django hashes them).
- ✅ Use groups for role-based access.
- ✅ Enforce permissions server-side, not just in the UI.
- ✅ Use HTTPS + secure/HttpOnly cookies in production.

## 6. Common Pitfalls

1. ⚠️ Switching to a custom user model after migrations (painful).
2. ⚠️ Authorization checks only in templates, not views.
3. ⚠️ Storing secrets/passwords insecurely.
4. ⚠️ Confusing authentication with authorization.
5. ⚠️ Forgetting raise_exception → silent redirects.
6. ⚠️ Long-lived sessions without expiry/rotation.

## 7. Interview Questions

1. **Q: Authentication vs authorization?**
   A: Authentication verifies who you are; authorization decides what you may do.

2. **Q: How does Django manage login?**
   A: authenticate() validates credentials, login() stores the user id in a signed session cookie.

3. **Q: How are passwords stored?**
   A: Hashed with a strong algorithm (PBKDF2/Argon2) and salt — never plaintext.

4. **Q: What are permissions and groups?**
   A: Per-model action permissions; groups bundle permissions to model roles.

5. **Q: Why a custom user model early?**
   A: Changing AUTH_USER_MODEL after migrations is very disruptive.

6. **Q: How to protect views?**
   A: @login_required / LoginRequiredMixin and permission decorators/mixins.

7. **Q: Session vs token auth?**
   A: Sessions for server-rendered apps; tokens/JWT for stateless APIs (often via DRF).

8. **Q: Where must authorization be enforced?**
   A: On the server in views/serializers — clients can be bypassed.

## 8. Practice

- [ ] Implement login/logout with sessions.
- [ ] Restrict a view to a permission.
- [ ] Create a custom user model with an extra field.

## 9. Quick Revision

Auth = identity (authenticate/login, hashed passwords); authz = permissions/groups enforced server-side via decorators/mixins. Use a custom user model from day one; HTTPS + secure cookies in prod.

**References:** Django auth docs

---

*Django Handbook — topic 07.*
