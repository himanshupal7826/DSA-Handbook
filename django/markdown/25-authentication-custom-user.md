# 25 · Authentication & the Custom User Model

> **In one line:** `django.contrib.auth` gives you a user model, a pluggable chain of authentication backends, salted slow password hashing that upgrades itself, and session-based login that rotates keys — and the single most consequential decision you make with it is defining a custom user model with `AUTH_USER_MODEL` *before* your first migration.

---

## 1. Overview

> **Builds on:** [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings), [Ch 08 · Models & Fields](topic.html?p=08-models-fields), [Ch 11 · Migrations](topic.html?p=11-migrations), [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance).

Every application needs to answer "who is this?" and every hand-rolled answer gets the same things wrong. Passwords stored as plain text or as unsalted `md5(password)` — cracked in seconds once a backup leaks. Login that compares strings with `==`, leaking timing information. A session ID that stays the same before and after login, so an attacker who planted it (session fixation) is now logged in as the victim. A "forgot password" link containing the user ID and nothing else. A `User` table with `username` as the identity when the product wants email login, discovered three years in.

Django's auth framework (`django.contrib.auth`) solves these once: a `User` model with a hashed `password` column, `authenticate()` that delegates to a configurable list of **backends**, `login()`/`logout()` that manage the session correctly, password validators, a password-reset flow with self-expiring tokens, and permissions/groups (covered in [Ch 26](topic.html?p=26-permissions-authorization)).

The trap is the default `User` model. It is fine — until you need email as the login identifier, a `tenant` FK, or to drop `username`. Every model in your project has an FK to the user table, and the user table's identity is baked into the very first migration of `auth`. Swapping it later means rewriting migration history across apps. The Django docs therefore say plainly: **when starting a new project, set up a custom user model, even if the default is sufficient for you.** Interviewers ask this because it separates people who have run a project for years from those who have only done tutorials.

> **Why this matters:** "AbstractUser vs AbstractBaseUser", "why set `AUTH_USER_MODEL` on day one", "how does Django store passwords" and "what does `login()` actually do" are standard Django interview questions — and the answers are also what keeps your users' credentials safe.

## 2. Core Concepts

- **`AUTH_USER_MODEL`** — `"app_label.ModelName"` of the active user model. *Why:* must be set before the first `migrate`; every FK to users depends on it.
- **`AbstractBaseUser`** — minimal base: `password`, `last_login`, `is_active`, plus `set_password`, `check_password`, `get_username`, `USERNAME_FIELD`. *Why:* full control over fields; you supply a manager.
- **`AbstractUser`** — the full default user (`username`, `first_name`, `last_name`, `email`, `is_staff`, `is_active`, `date_joined`) + `PermissionsMixin`, as an abstract class. *Why:* subclass to add fields while keeping all default behaviour.
- **`PermissionsMixin`** — `is_superuser`, `groups`, `user_permissions`, `has_perm()`. *Why:* needed with `AbstractBaseUser` if you want Django permissions and admin access.
- **`BaseUserManager`** — manager base with `normalize_email`; you implement `create_user` and `create_superuser`. *Why:* `createsuperuser` and your code call them.
- **`USERNAME_FIELD` / `REQUIRED_FIELDS` / `EMAIL_FIELD`** — identity field (must be unique), extra fields `createsuperuser` prompts for, and which field is the email. *Why:* drive auth and management commands.
- **`get_user_model()` vs `settings.AUTH_USER_MODEL`** — runtime model class vs string reference for FKs. *Why:* avoids import-time app-registry errors and hard-coding `auth.User`.
- **Password hasher** — `PASSWORD_HASHERS`; first entry hashes new passwords, the rest verify old ones. Default PBKDF2-SHA256; Argon2 recommended. *Why:* hashes upgrade transparently on next login.
- **Authentication backend** — class with `authenticate(request, **credentials)` and `get_user(user_id)`; listed in `AUTHENTICATION_BACKENDS`. *Why:* add email login, LDAP, SSO without touching views.
- **`authenticate()` / `login()` / `logout()`** — verify credentials / attach user to session (rotating the key) / flush the session. *Why:* the three calls every login flow uses.
- **`AuthenticationMiddleware`** — sets `request.user` lazily from the session. *Why:* `request.user` costs a query only when accessed.
- **Password validators** — `AUTH_PASSWORD_VALIDATORS`, run by `validate_password()`. *Why:* forms and `createsuperuser` use them; `set_password()` does not.
- **`PasswordResetTokenGenerator`** — HMAC token over user state + timestamp. *Why:* stateless, expires, and is invalidated when the password changes or the user logs in.

## 3. Theory & Principles

### The user model hierarchy

Three abstract building blocks combine into the concrete user model; which ones you inherit from decides how much you get for free and how much you must write.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj25a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">django.contrib.auth model classes (arrows point to the parent)</text>
  <rect x="40" y="44" width="250" height="96" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="165" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">AbstractBaseUser</text>
  <text x="165" y="82" text-anchor="middle" fill="#334155" font-size="10">password, last_login, is_active</text>
  <text x="165" y="98" text-anchor="middle" fill="#334155" font-size="10">set_password, check_password</text>
  <text x="165" y="114" text-anchor="middle" fill="#334155" font-size="10">USERNAME_FIELD, REQUIRED_FIELDS</text>
  <text x="165" y="130" text-anchor="middle" fill="#334155" font-size="9">get_session_auth_hash()</text>
  <rect x="590" y="44" width="250" height="96" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="715" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">PermissionsMixin</text>
  <text x="715" y="82" text-anchor="middle" fill="#334155" font-size="10">is_superuser</text>
  <text x="715" y="98" text-anchor="middle" fill="#334155" font-size="10">groups, user_permissions (M2M)</text>
  <text x="715" y="114" text-anchor="middle" fill="#334155" font-size="10">has_perm, has_perms, has_module_perms</text>
  <rect x="315" y="170" width="250" height="80" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="440" y="190" text-anchor="middle" fill="#1e293b" font-weight="bold">AbstractUser (abstract)</text>
  <text x="440" y="208" text-anchor="middle" fill="#334155" font-size="10">username, first_name, last_name, email</text>
  <text x="440" y="224" text-anchor="middle" fill="#334155" font-size="10">is_staff, date_joined, UserManager</text>
  <text x="440" y="240" text-anchor="middle" fill="#334155" font-size="9">USERNAME_FIELD = "username"</text>
  <path d="M380,170 L220,142" stroke="#334155" stroke-width="1.5" marker-end="url(#dj25a)"/>
  <path d="M500,170 L660,142" stroke="#334155" stroke-width="1.5" marker-end="url(#dj25a)"/>
  <rect x="200" y="272" width="200" height="46" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="300" y="292" text-anchor="middle" fill="#1e293b">auth.User</text>
  <text x="300" y="308" text-anchor="middle" fill="#334155" font-size="9">swappable = "AUTH_USER_MODEL"</text>
  <rect x="480" y="272" width="200" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="580" y="292" text-anchor="middle" fill="#1e293b">accounts.User(AbstractUser)</text>
  <text x="580" y="308" text-anchor="middle" fill="#334155" font-size="9">option 1: keep fields, add more</text>
  <path d="M300,272 L400,252" stroke="#334155" stroke-width="1.5" marker-end="url(#dj25a)"/>
  <path d="M580,272 L480,252" stroke="#334155" stroke-width="1.5" marker-end="url(#dj25a)"/>
  <rect x="20" y="170" width="240" height="80" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="140" y="190" text-anchor="middle" fill="#1e293b">accounts.User(AbstractBaseUser,</text>
  <text x="140" y="206" text-anchor="middle" fill="#1e293b">PermissionsMixin)</text>
  <text x="140" y="224" text-anchor="middle" fill="#334155" font-size="9">option 2: full control, email login,</text>
  <text x="140" y="238" text-anchor="middle" fill="#334155" font-size="9">own manager + fields</text>
  <path d="M120,170 L130,142" stroke="#334155" stroke-width="1.5" marker-end="url(#dj25a)"/>
  <path d="M250,190 C420,160 560,150 610,142" stroke="#334155" stroke-width="1.5" fill="none" marker-end="url(#dj25a)"/>
</svg>
```

`auth.User` declares `class Meta: swappable = "AUTH_USER_MODEL"`. When `AUTH_USER_MODEL` points elsewhere, Django marks `auth.User` as swapped out: its table is not created, and any FK declared as `settings.AUTH_USER_MODEL` (including those in `admin`, `auth.Permission` relations, and third-party apps) resolves to your model. The migration framework records a **swappable dependency** (`migrations.swappable_dependency(settings.AUTH_USER_MODEL)`), so every app with a user FK depends on whatever app defines the user model's first migration. That is why changing `AUTH_USER_MODEL` after tables exist is so hard: the initial migrations of many apps (yours and third-party) were applied against `auth_user`, and their FKs physically reference it.

### How passwords are stored and checked

`user.set_password(raw)` calls `make_password(raw)`, which uses the first hasher in `PASSWORD_HASHERS` (default `PBKDF2PasswordHasher`) with a fresh random salt and stores a string of the form:

```text
pbkdf2_sha256$<iterations>$<salt>$<base64 hash>
argon2$argon2id$v=19$m=102400,t=2,p=8$<salt>$<hash>
```

The algorithm name prefix lets Django pick the right hasher for verification. PBKDF2 runs on the order of a million SHA-256 iterations in current Django releases (the number is raised every release), which deliberately makes each guess slow. **Argon2** (`Argon2PasswordHasher`, requires `argon2-cffi`) is memory-hard and the recommended choice; `ScryptPasswordHasher` exists too. Never use `MD5PasswordHasher` outside tests (where it makes the test suite much faster).

`user.check_password(raw)` calls `hashers.check_password(raw, encoded, setter)`: it identifies the hasher from the prefix, recomputes, and compares with `constant_time_compare` to avoid timing leaks. If the password is correct **and** the stored hash uses a non-preferred algorithm or an outdated iteration count (`hasher.must_update(encoded)`), the `setter` re-hashes with the current preferred hasher and saves — so raising iterations or switching to Argon2 upgrades users transparently on their next login. `ModelBackend` also runs the hasher once for a non-existent username, so "user not found" and "wrong password" take similar time (mitigating user enumeration by timing).

`set_password()` does **not** call password validators and does **not** save; call `validate_password(raw, user)` first and `user.save()` after.

### `authenticate()`: the backend chain

`django.contrib.auth.authenticate(request=None, **credentials)` iterates `AUTHENTICATION_BACKENDS` (default `["django.contrib.auth.backends.ModelBackend"]`). For each backend whose `authenticate()` signature accepts the given credentials, it calls it: a returned user wins and gets `user.backend = "<dotted path>"`; `None` moves on; raising `PermissionDenied` stops the chain immediately. If nothing matches it sends `user_login_failed` and returns `None`. `ModelBackend.authenticate` does `UserModel._default_manager.get_by_natural_key(username)`, `user.check_password(password)`, and `user_can_authenticate(user)` (rejects `is_active=False`).

### `login()`: what actually happens

`login(request, user, backend=None)`:

1. computes `session_auth_hash = user.get_session_auth_hash()` (an HMAC of the password hash);
2. if the session already belongs to a *different* user, or the stored hash differs, `request.session.flush()`; otherwise `request.session.cycle_key()` — **a new session key either way**, which defeats session fixation;
3. stores `_auth_user_id`, `_auth_user_backend`, `_auth_user_hash` in the session;
4. sets `request.user = user`, calls `rotate_token(request)` to rotate the CSRF token;
5. sends `user_logged_in`, whose built-in receiver updates `last_login`.

On later requests, `AuthenticationMiddleware` sets `request.user = SimpleLazyObject(lambda: get_user(request))`. `get_user()` reads the user id and backend from the session, loads the user via `backend.get_user(id)`, and verifies `_auth_user_hash` against the current `get_session_auth_hash()`. Because that hash derives from the password hash, **changing a password invalidates all other sessions**; `update_session_auth_hash(request, user)` keeps the current one alive after a password change. `logout(request)` sends `user_logged_out`, flushes the session, and sets `AnonymousUser`.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj25b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj25c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">POST /login/: authenticate() then login()</text>
  <rect x="20" y="44" width="140" height="56" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="90" y="66" text-anchor="middle" fill="#1e293b">LoginView</text>
  <text x="90" y="84" text-anchor="middle" fill="#334155" font-size="9">AuthenticationForm.clean()</text>
  <path d="M160,72 L190,72" stroke="#2563eb" stroke-width="2" marker-end="url(#dj25b)"/>
  <rect x="192" y="40" width="380" height="140" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="382" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">authenticate(request, username, password)</text>
  <rect x="204" y="68" width="170" height="50" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="289" y="88" text-anchor="middle" fill="#1e293b" font-size="10">EmailBackend</text>
  <text x="289" y="104" text-anchor="middle" fill="#334155" font-size="9">returns None: try next</text>
  <rect x="390" y="68" width="170" height="50" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="475" y="88" text-anchor="middle" fill="#1e293b" font-size="10">ModelBackend</text>
  <text x="475" y="104" text-anchor="middle" fill="#334155" font-size="9">get_by_natural_key</text>
  <path d="M374,93 L388,93" stroke="#2563eb" stroke-width="2" marker-end="url(#dj25b)"/>
  <text x="382" y="140" text-anchor="middle" fill="#334155" font-size="10">check_password: constant-time compare,</text>
  <text x="382" y="156" text-anchor="middle" fill="#334155" font-size="10">rehash if hasher outdated; is_active check</text>
  <text x="382" y="172" text-anchor="middle" fill="#334155" font-size="9">sets user.backend = "dotted.path"</text>
  <path d="M572,110 L602,110" stroke="#2563eb" stroke-width="2" marker-end="url(#dj25b)"/>
  <rect x="604" y="40" width="256" height="190" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="732" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">login(request, user)</text>
  <text x="732" y="80" text-anchor="middle" fill="#334155" font-size="10">1. session.cycle_key() or flush()</text>
  <text x="732" y="96" text-anchor="middle" fill="#334155" font-size="9">new session id: no fixation</text>
  <text x="732" y="118" text-anchor="middle" fill="#334155" font-size="10">2. store _auth_user_id,</text>
  <text x="732" y="134" text-anchor="middle" fill="#334155" font-size="10">_auth_user_backend, _auth_user_hash</text>
  <text x="732" y="156" text-anchor="middle" fill="#334155" font-size="10">3. rotate_token(): new CSRF secret</text>
  <text x="732" y="178" text-anchor="middle" fill="#334155" font-size="10">4. user_logged_in signal</text>
  <text x="732" y="194" text-anchor="middle" fill="#334155" font-size="9">updates last_login</text>
  <text x="732" y="216" text-anchor="middle" fill="#334155" font-size="9">Set-Cookie: sessionid=NEW; HttpOnly</text>
  <path d="M382,180 L382,250" stroke="#dc2626" stroke-width="2" marker-end="url(#dj25c)"/>
  <rect x="192" y="252" width="380" height="44" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="382" y="270" text-anchor="middle" fill="#1e293b">all backends None: user_login_failed signal</text>
  <text x="382" y="286" text-anchor="middle" fill="#334155" font-size="9">a backend raising PermissionDenied stops the chain</text>
  <rect x="604" y="252" width="256" height="92" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="732" y="272" text-anchor="middle" fill="#1e293b" font-weight="bold">next request</text>
  <text x="732" y="290" text-anchor="middle" fill="#334155" font-size="10">AuthenticationMiddleware:</text>
  <text x="732" y="306" text-anchor="middle" fill="#334155" font-size="10">request.user = lazy get_user()</text>
  <text x="732" y="322" text-anchor="middle" fill="#334155" font-size="9">verifies _auth_user_hash vs password hash</text>
  <text x="732" y="336" text-anchor="middle" fill="#334155" font-size="9">password changed elsewhere: logged out</text>
  <path d="M732,230 L732,250" stroke="#2563eb" stroke-width="2" marker-end="url(#dj25b)"/>
</svg>
```

### Password reset tokens

`PasswordResetTokenGenerator.make_token(user)` produces `<timestamp_b36>-<hmac>` where the HMAC (keyed with `SECRET_KEY`) covers the user's pk, **password hash**, **`last_login`**, the timestamp and the email. Nothing is stored in the database. `check_token()` recomputes and checks the age against `PASSWORD_RESET_TIMEOUT` (default 3 days, in seconds). Because the password hash and `last_login` are inputs, the token is single-use in practice: once the password changes (or the user logs in), the token no longer validates. Rotating `SECRET_KEY` invalidates outstanding tokens — use `SECRET_KEY_FALLBACKS` (4.1+) during rotation.

## 4. Architecture & Workflow

### Day-one setup order

```text
1. django-admin startproject config .
2. python manage.py startapp accounts
3. accounts/models.py: class User(AbstractUser) (or AbstractBaseUser + PermissionsMixin)
4. settings.py: AUTH_USER_MODEL = "accounts.User"; add "accounts" to INSTALLED_APPS
5. python manage.py makemigrations accounts      ← accounts/0001_initial creates the user table
6. python manage.py migrate                       ← FIRST migrate, after the above
7. accounts/admin.py: register with UserAdmin (customised fieldsets)
```

If step 6 has already happened with `auth.User`, see the Senior question in §9 — it is a migration project, not a settings change.

### Where the user model is referenced

```text
models.py   owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=...)   # string, import-safe
services    User = get_user_model(); User.objects.filter(...)                     # runtime class
signals     @receiver(post_save, sender=settings.AUTH_USER_MODEL)                 # string sender works
forms       class SignUpForm(UserCreationForm): class Meta(UserCreationForm.Meta): model = get_user_model()
tests       User = get_user_model(); User.objects.create_user(...)
NEVER       from django.contrib.auth.models import User                           # breaks when swapped
```

### Login options at a glance

| Flow | Built-in piece |
|---|---|
| Username/password HTML login | `LoginView` + `AuthenticationForm` |
| Logout | `LogoutView` (POST only since Django 5.0) |
| Require login | `@login_required`, `LoginRequiredMixin`, `LoginRequiredMiddleware` + `@login_not_required` (5.1+) |
| Password change | `PasswordChangeView` (calls `update_session_auth_hash`) |
| Password reset | `PasswordResetView` → email → `PasswordResetConfirmView` |
| API login | DRF session/JWT ([Ch 23](topic.html?p=23-drf-auth-permissions-throttling)) |
| Social / SSO / MFA | django-allauth, mozilla-django-oidc, django-otp |

## 5. Implementation

### Simple example: `AbstractUser` (recommended default)

```python
# accounts/models.py
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Start here on every new project, even with no extra fields yet."""
    display_name = models.CharField(max_length=80, blank=True)
    tenant = models.ForeignKey("tenants.Tenant", null=True, blank=True, on_delete=models.PROTECT)
```

```python
# settings.py
INSTALLED_APPS = [..., "accounts"]
AUTH_USER_MODEL = "accounts.User"

PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",   # new hashes
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",   # still verifies old ones, upgrades on login
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
    "django.contrib.auth.hashers.ScryptPasswordHasher",
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LOGIN_URL = "login"
LOGIN_REDIRECT_URL = "dashboard"
```

```python
# accounts/admin.py
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin

from .models import User


@admin.register(User)
class CustomUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (("Profile", {"fields": ("display_name", "tenant")}),)
```

```bash
pip install "django~=5.2" "argon2-cffi"
python manage.py makemigrations accounts && python manage.py migrate
python manage.py createsuperuser
```

```text
>>> from django.contrib.auth import get_user_model
>>> u = get_user_model().objects.get(username="admin")
>>> u.password
'argon2$argon2id$v=19$m=102400,t=2,p=8$c2FsdHNhbHQ$Zm9vYmFyYmF6...'
>>> u.check_password("wrong"), u.check_password("correct horse battery")
(False, True)
```

### Real-world example: email login with `AbstractBaseUser`

```python
# accounts/models.py
from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create_user(self, email, password, **extra):
        if not email:
            raise ValueError("Email is required")
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra)
        user.set_password(password)          # None → unusable password (SSO-only users)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra):
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email, password=None, **extra):
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        if extra["is_staff"] is not True or extra["is_superuser"] is not True:
            raise ValueError("Superuser must have is_staff=True and is_superuser=True.")
        return self._create_user(email, password, **extra)

    def get_by_natural_key(self, email):
        return self.get(email__iexact=email)    # case-insensitive login


class User(AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=150, blank=True)
    is_staff = models.BooleanField(default=False)        # admin site access
    is_active = models.BooleanField(default=True)        # soft-disable instead of delete
    date_joined = models.DateTimeField(default=timezone.now)
    tenant = models.ForeignKey("tenants.Tenant", null=True, blank=True, on_delete=models.PROTECT)

    objects = UserManager()

    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = []                 # prompted by createsuperuser besides USERNAME_FIELD + password

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("email"), name="user_email_ci_unique"),
        ]

    def get_full_name(self):
        return self.full_name

    def get_short_name(self):
        return self.full_name.split(" ")[0] if self.full_name else self.email
```

The SQL behind a login with this model:

```sql
SELECT ... FROM "accounts_user" WHERE UPPER("accounts_user"."email"::text) = UPPER('Ann@Example.com') LIMIT 21;
-- on success, user_logged_in → update_last_login:
UPDATE "accounts_user" SET "last_login" = '2026-10-25T10:00:00+00:00' WHERE "accounts_user"."id" = 7;
```

Use a functional index matching the lookup (`Lower("email")` with `email__iexact` may need `Upper` on some versions — check `explain()`), or normalise to lowercase at write time and query `email=normalized` for a plain B-tree lookup.

> **Gotcha:** `REQUIRED_FIELDS` must not contain `USERNAME_FIELD` or `password`. And `is_active` on `AbstractBaseUser` is a class attribute `True` — declare a real field if you want to deactivate users.

### A custom authentication backend

Sometimes you keep `username` as the identifier but want users to log in with either username or email:

```python
# accounts/backends.py
from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend
from django.db.models import Q


class UsernameOrEmailBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        if username is None or password is None:
            return None
        User = get_user_model()
        try:
            user = User._default_manager.get(Q(username__iexact=username) | Q(email__iexact=username))
        except User.DoesNotExist:
            User().set_password(password)      # equalise timing with the "found" path
            return None
        except User.MultipleObjectsReturned:
            return None
        if user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None
```

```python
AUTHENTICATION_BACKENDS = [
    "accounts.backends.UsernameOrEmailBackend",
    "django.contrib.auth.backends.ModelBackend",   # keeps has_perm() from ModelBackend
]
```

Permission checks (`user.has_perm`) also iterate all backends, so subclassing `ModelBackend` keeps that behaviour.

### Login, logout and reset views

```python
# accounts/urls.py
from django.contrib.auth import views as auth_views
from django.urls import path

urlpatterns = [
    path("login/", auth_views.LoginView.as_view(redirect_authenticated_user=True), name="login"),
    path("logout/", auth_views.LogoutView.as_view(), name="logout"),        # POST only (5.0+)
    path("password-change/", auth_views.PasswordChangeView.as_view(), name="password_change"),
    path("password-reset/", auth_views.PasswordResetView.as_view(), name="password_reset"),
    path("reset/<uidb64>/<token>/", auth_views.PasswordResetConfirmView.as_view(),
         name="password_reset_confirm"),
]
# or simply: path("accounts/", include("django.contrib.auth.urls"))
```

```html
<!-- logout must be a POST form since Django 5.0 -->
<form method="post" action="{% url 'logout' %}">{% csrf_token %}<button>Log out</button></form>
```

A programmatic login, e.g. after sign-up:

```python
from django.contrib.auth import authenticate, login, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password


def signup(request):
    form = SignUpForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()                              # UserCreationForm runs validators + set_password
        login(request, user, backend="django.contrib.auth.backends.ModelBackend")  # needed with >1 backend
        return redirect("dashboard")
    return render(request, "accounts/signup.html", {"form": form})


def change_password(request):
    new = request.POST["new_password"]
    validate_password(new, user=request.user)          # set_password does NOT validate
    request.user.set_password(new)
    request.user.save(update_fields=["password"])
    update_session_auth_hash(request, request.user)   # keep this session; others are logged out
```

### Requiring login everywhere (Django 5.1+)

```python
MIDDLEWARE = [..., "django.contrib.auth.middleware.AuthenticationMiddleware",
              "django.contrib.auth.middleware.LoginRequiredMiddleware", ...]

from django.contrib.auth.decorators import login_not_required

@login_not_required
def healthcheck(request):
    return HttpResponse("ok")
```

### Extending without swapping: a profile model

```python
class Profile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile")
    avatar = models.ImageField(upload_to="avatars/", blank=True)
    timezone = models.CharField(max_length=40, default="UTC")
```

Keep authentication data on the user model and app-specific data on profiles — but note each `request.user.profile` is an extra query unless you `select_related("profile")`.

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Pros | Cons | Use when |
|---|---|---|---|
| Default `auth.User` | Zero work | Cannot change later without pain | Throwaway prototypes only |
| `AbstractUser` subclass | Keeps admin, forms, username; easy to add fields | Still has `username` (can be repurposed) | Almost every new project |
| `AbstractBaseUser` + `PermissionsMixin` | Exact fields, email login, no username | Write manager, admin forms, more code | Email/phone identity, strict schemas |
| Profile `OneToOne` | No swap needed; separates concerns | Extra join/query, sync on create | Adding data to an existing project |
| Custom backend | Any credential source (email, LDAP, SSO) | Must handle timing, is_active, perms | Alternative login identifiers |

| Hasher | Notes |
|---|---|
| PBKDF2-SHA256 (default) | Standard, no extra deps, iterations raised each release |
| Argon2id | Memory-hard, recommended; needs `argon2-cffi` |
| scrypt | Memory-hard, built in (4.0+) |
| bcrypt (`BCryptSHA256PasswordHasher`) | Needs `bcrypt`; 72-byte limit handled by SHA256 pre-hash |
| MD5 | Only for test settings, to speed tests |

### When to use
- A custom user model (`AbstractUser`) on every new project, set before the first migrate.
- `AbstractBaseUser` when the identity is email/phone and you want no username column.
- Argon2 as the first hasher in production.
- Custom backends for alternate identifiers or external identity providers.

### When NOT to use
- Don't store app-specific, frequently changing data on the user if many apps touch it — a profile can reduce contention and migrations on a hot table.
- Don't write your own password hashing or session handling.
- Don't use `AbstractBaseUser` "just because"; you take on manager, forms and admin work.

## 7. Common Mistakes & Best Practices

**1. Running `migrate` before setting `AUTH_USER_MODEL`.** The `auth_user` table and all FKs to it now exist. Set it at project creation.

**2. Importing `User` directly.**

```python
# before — breaks when the model is swapped
from django.contrib.auth.models import User
owner = models.ForeignKey(User, on_delete=models.CASCADE)

# after
from django.conf import settings
owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
```

**3. Calling `get_user_model()` at module import time in `models.py`.** It can raise `AppRegistryNotReady`/`ImproperlyConfigured`. Use the setting string for relations.

**4. `User.objects.create(password="secret")`.** Stores the raw string, which `check_password` can never match (and leaks it). Use `create_user()` or `set_password()`.

**5. Assuming `set_password()` validates or saves.** It does neither. Call `validate_password()` and `save()`.

**6. Case-sensitive email uniqueness.** `Ann@x.com` and `ann@x.com` become two accounts. Normalise and use a `Lower("email")` unique constraint.

**7. Deleting users.** Deleting cascades through orders, audit logs and more. Set `is_active=False`; `ModelBackend` will refuse login.

**8. GET logout links.** Removed in Django 5.0 — logout must be a POST (CSRF-protected), so a malicious `<img src="/logout/">` can't log users out.

**9. Leaking account existence in reset/login flows.** Show the same message for "no such user" and "wrong password"; `PasswordResetView` already responds identically whether or not the email exists.

**Best practices:** custom user from day one; reference via `settings.AUTH_USER_MODEL`/`get_user_model()`; Argon2 first; validators with a 12+ minimum length; throttle login endpoints; `is_active` instead of delete; MFA for staff (django-otp or allauth); `MD5PasswordHasher` in test settings only.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: login is slow and CPU-bound.** Symptom: `/login/` p95 of 400 ms and high CPU during morning peaks or credential-stuffing attacks. Root cause: password hashing is *designed* to be slow; an attacker trying 1,000 passwords/second costs you 1,000 hashes/second. Fix: rate-limit login per IP and per account (django-axes or a gateway), keep hashing cost (do not lower it), scale login capacity separately if needed.

**Pitfall: everyone logged out after a deploy.** Root cause: `SECRET_KEY` changed (session auth hash, signed cookies, reset tokens all depend on it), or the session backend changed. Fix: rotate with `SECRET_KEY_FALLBACKS`; never generate `SECRET_KEY` at boot.

**Pitfall: hasher upgrade causes write spike.** After switching to Argon2, every user's next login re-hashes and saves the password — a burst of UPDATEs on the user table. Usually harmless; on huge user bases, expect it and watch replication lag.

**Pitfall: mid-project swap to a custom user.** Symptom: `ValueError: Related model 'accounts.user' cannot be resolved` or `InconsistentMigrationHistory`. Root cause: changing `AUTH_USER_MODEL` after migrations ran. Fix: the documented manual path (see Senior Q below), on a staging copy first.

**Pitfall: N+1 on `request.user` relations.** Templates that touch `request.user.profile`, `request.user.tenant` on every request add queries per request. Fix: a custom `AuthenticationMiddleware`/backend `get_user()` with `select_related`, or cache what you need in the session.

**Debugging.**
- `python manage.py shell`: `from django.contrib.auth.hashers import identify_hasher; identify_hasher(u.password)`.
- Inspect a session: `Session.objects.get(pk=key).get_decoded()` shows `_auth_user_id`/`_auth_user_backend`.
- Connect to `user_login_failed` to log failed attempts (without the password) for alerting.
- `manage.py check --deploy` flags insecure session/CSRF cookie settings ([Ch 28](topic.html?p=28-security)).

**Scaling.** Store sessions in Redis (`cached_db` or `cache` engine) to remove a DB read per request ([Ch 27](topic.html?p=27-sessions-cookies)); keep the user table narrow and indexed on the login identifier; move SSO/MFA to a dedicated identity provider (OIDC) when you have many apps sharing users.

## 9. Interview Questions

**Q: Why should you create a custom user model at the start of a project?**
A: Because `AUTH_USER_MODEL` determines the table every user FK points to, and the swappable dependency is baked into the initial migrations of your apps and third-party apps. Switching after the first `migrate` requires rewriting migration history and data migrations. Creating `class User(AbstractUser): pass` on day one costs nothing and lets you add fields or change the identifier later with normal migrations. The Django docs explicitly recommend it.

**Q: What is the difference between `AbstractUser` and `AbstractBaseUser`?**
A: `AbstractUser` is the complete default user as an abstract model — username, names, email, `is_staff`, `is_active`, `date_joined`, `PermissionsMixin` and `UserManager` — so you subclass it to add fields. `AbstractBaseUser` only provides password handling, `last_login` and identity plumbing; you declare all fields, `USERNAME_FIELD`, `REQUIRED_FIELDS`, a `BaseUserManager` with `create_user`/`create_superuser`, and add `PermissionsMixin` if you want Django permissions. Use `AbstractUser` unless you need a different identity model such as email-only.

**Q: When do you use `settings.AUTH_USER_MODEL` versus `get_user_model()`?**
A: Use the `settings.AUTH_USER_MODEL` string for model relations (FK, O2O, M2M) and signal senders, because models.py is imported while the app registry is loading and the string is resolved lazily. Use `get_user_model()` at runtime — in views, services, forms, tests — to get the actual class. Never import `django.contrib.auth.models.User` directly in reusable code.

**Q: How does Django store passwords?**
A: As `algorithm$parameters$salt$hash`, e.g. `pbkdf2_sha256$<iterations>$<salt>$<hash>`, produced by the first hasher in `PASSWORD_HASHERS`. Each password gets a random salt, and the algorithm is deliberately slow (PBKDF2 with a very high iteration count, or memory-hard Argon2/scrypt) to make offline cracking expensive. Verification identifies the hasher from the prefix and uses a constant-time comparison. Plain text is never stored.

**Q: How do you migrate users to a stronger hasher like Argon2?**
A: Install `argon2-cffi` and put `Argon2PasswordHasher` first in `PASSWORD_HASHERS`, keeping the old hashers after it. New passwords use Argon2; on each successful `check_password`, Django sees the stored hash uses a non-preferred hasher (or outdated parameters) and re-hashes it with Argon2 transparently. For users who never log in, you can wrap old hashes (hash the existing hash) with a custom wrapper hasher, as the docs describe for legacy SHA1/MD5.

**Q: What does `authenticate()` do and how do authentication backends work?**
A: It iterates `AUTHENTICATION_BACKENDS`, calling each backend's `authenticate(request, **credentials)` whose signature matches. The first backend returning a user wins (Django records which via `user.backend`); `None` means try the next; raising `PermissionDenied` stops the chain. `ModelBackend` looks up by `USERNAME_FIELD`, checks the password and that `is_active` is true. It only verifies — it doesn't log in; `login()` does that.

**Q: What does `login()` do, and how does Django prevent session fixation?**
A: `login()` cycles the session key (or flushes the session if it belonged to another user), stores the user id, backend path and session auth hash in the session, rotates the CSRF token, sets `request.user`, and fires `user_logged_in`, which updates `last_login`. Cycling the key means a session ID an attacker planted before login is useless afterwards — that is the fixation defence. `logout()` flushes the session entirely.

**Q: Why does changing a password log a user out of other devices?**
A: The session stores `_auth_user_hash`, derived from the user's password hash via `get_session_auth_hash()`. On each request `get_user()` compares it with the current value; after a password change they differ, so other sessions are invalidated. To keep the current session alive call `update_session_auth_hash(request, user)`, which `PasswordChangeView` does for you.

**Q: How do password reset tokens work without being stored?**
A: `PasswordResetTokenGenerator` creates a timestamp plus an HMAC (keyed with `SECRET_KEY`) over the user's pk, password hash, last login, email and timestamp. To verify, Django recomputes it and checks the age against `PASSWORD_RESET_TIMEOUT`. Changing the password or logging in changes the inputs, so a used token stops validating — effectively single-use with no database state. Rotating `SECRET_KEY` invalidates outstanding tokens.

**Q: How do you implement email-based login?**
A: Either make email the identifier on a custom `AbstractBaseUser` (or `AbstractUser`) model with `USERNAME_FIELD = "email"` and a unique, case-insensitive email, or keep usernames and add a backend that looks users up by email. Normalise emails on write, enforce case-insensitive uniqueness with a `Lower("email")` unique constraint, make `get_by_natural_key` case-insensitive, and avoid leaking existence in error messages and reset flows.

**Q: Your project has been running on `auth.User` for two years and now needs a custom user model. How do you migrate? (Senior)**
A: Avoid if you can (a profile model may suffice). If necessary: create `accounts.User` with `db_table = "auth_user"` (and the M2M tables) so it reuses the existing table, matching `auth.User` fields exactly; create its initial migration and mark it applied with `migrate --fake` or by inserting into `django_migrations`; update `django_content_type` so the content type points at the new app/model; then switch `AUTH_USER_MODEL`, and only afterwards add new fields in normal migrations. Third-party apps' migrations reference `settings.AUTH_USER_MODEL` already, so they keep working. Rehearse on a production snapshot, freeze deploys, and keep a rollback plan — it is a migration-history surgery, not a schema change.

**Q: Design authentication for a SaaS product with email login, SSO for enterprise customers and MFA for admins. (Senior)**
A: Custom user model with email identity, case-insensitive unique, `tenant` FK, `is_active` soft-disable. Backends: `ModelBackend`-based email backend for password users; an OIDC backend (e.g. mozilla-django-oidc or allauth) for enterprise tenants, with users provisioned just-in-time and `set_unusable_password()`; a tenant flag forcing SSO so password login is refused (a backend raising `PermissionDenied`). Argon2 hashing, length-based validators, login throttling per IP and account, and `user_login_failed` alerting. MFA via django-otp/allauth required for `is_staff`, and session security (`SESSION_COOKIE_SECURE`, short admin session age). APIs use JWT or session per [Ch 23](topic.html?p=23-drf-auth-permissions-throttling) on top of the same user model.

**Q: Login requests are saturating CPU during an attack. What do you do? (Senior)**
A: Hashing is deliberately expensive, so each guess costs you CPU; the answer is to stop guesses before hashing, not to weaken the hasher. Add per-IP and per-username rate limits at the gateway and in Django (django-axes, or a Redis counter in a custom backend that raises `PermissionDenied` before `check_password`), CAPTCHA after failures, and block known-bad IP ranges at the WAF. Make sure unknown usernames still hash once (timing parity) but are rate-limited too. Scale or isolate login workers so the rest of the site is unaffected, and alert on `user_login_failed` rates.

**Q: Why does Django run the password hasher even when the user doesn't exist?**
A: To make the response time for "unknown user" similar to "wrong password". If unknown users returned instantly, an attacker could enumerate valid usernames by timing. `ModelBackend` calls `UserModel().set_password(password)` in the `DoesNotExist` branch to spend the same hashing time. Custom backends should do the same.

## 10. Quick Revision & Cheat Sheet

| Topic | Remember |
|---|---|
| Custom user | Always; set `AUTH_USER_MODEL` before first `migrate` |
| `AbstractUser` | full default fields — add more |
| `AbstractBaseUser` | password + last_login only; you add fields, manager, `PermissionsMixin` |
| `USERNAME_FIELD` | unique identifier; `REQUIRED_FIELDS` excludes it and password |
| References | FK: `settings.AUTH_USER_MODEL`; runtime: `get_user_model()` |
| Hash format | `algorithm$params$salt$hash`; first hasher hashes, others verify |
| Upgrade | automatic re-hash on successful login |
| `authenticate()` | backends in order; user wins, `None` next, `PermissionDenied` stops |
| `login()` | cycle session key, store id/backend/hash, rotate CSRF, update last_login |
| Password change | invalidates other sessions; `update_session_auth_hash` keeps current |
| Reset token | HMAC of pk + password hash + last_login + email + timestamp; `PASSWORD_RESET_TIMEOUT` 3 days |
| Logout | POST-only since 5.0 |

- `set_password()` neither validates nor saves.
- `create_user()`, never `create(password=...)`.
- Deactivate with `is_active=False`; don't delete users.
- Argon2 first in `PASSWORD_HASHERS`.
- Case-insensitive unique email with `Lower("email")`.
- `LoginRequiredMiddleware` (5.1+) for login-by-default sites.
- Rate-limit login; never weaken the hasher.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" argon2-cffi
django-admin startproject config . && python manage.py startapp accounts
```

1. **Day-one user.** Create `accounts.User(AbstractUser)`, set `AUTH_USER_MODEL`, migrate, and inspect the created tables (`\dt` in psql or `sqlmigrate accounts 0001`).
2. **Hasher upgrade.** Create a user with PBKDF2 first in `PASSWORD_HASHERS`, then put Argon2 first, log in, and watch the stored hash prefix change.
3. **Email identity.** Build the `AbstractBaseUser` email model with its manager; run `createsuperuser`; add the `Lower("email")` constraint and prove `Ann@x.com` and `ann@x.com` cannot both register.
4. **Session fixation.** Log the session key before and after `login()` in a view and confirm it changes; change the password in another browser and confirm the first session is logged out.
5. **Reset tokens.** Generate a reset token in the shell, verify it, log the user in (updating `last_login`), and verify the token now fails.

**Mini project — "Accounts service".** Email-login custom user with tenant FK; sign-up, login, POST logout, password change and reset (console email backend); Argon2; validators; a username-or-email backend; login throttling via a Redis counter that raises `PermissionDenied`; `user_login_failed` logging; `LoginRequiredMiddleware` with `@login_not_required` on public pages; tests for every flow using `get_user_model()`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 11 · Migrations](topic.html?p=11-migrations) · [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization) · [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) · [Ch 28 · Security: CSRF, XSS, SQL Injection & Hardening](topic.html?p=28-security) · [Ch 37 · Interview: Core & ORM](topic.html?p=37-interview-core-orm)

**Other handbooks:** [REST API · Authentication Basics](../rest-api/topic.html?p=18-authentication-basics) · [REST API · OAuth 2.0 & OIDC](../rest-api/topic.html?p=19-oauth2-oidc) · [REST API · OWASP API Security](../rest-api/topic.html?p=23-owasp-api-security)

- **User authentication in Django** — Django docs · *Beginner* · overview of users, login, logout and views. <https://docs.djangoproject.com/en/5.2/topics/auth/>
- **Customizing authentication in Django** — Django docs · *Intermediate* · custom user models, backends, and the "substituting a custom User model" guidance. <https://docs.djangoproject.com/en/5.2/topics/auth/customizing/>
- **Password management in Django** — Django docs · *Intermediate* · hashers, upgrading, validators, wrapping legacy hashes. <https://docs.djangoproject.com/en/5.2/topics/auth/passwords/>
- **Using the Django authentication system** — Django docs · *Beginner* · `authenticate`, `login`, decorators, built-in views. <https://docs.djangoproject.com/en/5.2/topics/auth/default/>
- **OWASP Password Storage Cheat Sheet** — OWASP · *Intermediate* · why Argon2id/scrypt/PBKDF2 and how to tune them. <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
- **django-allauth** — pennersr on GitHub · *Intermediate* · email verification, social login, MFA. <https://github.com/pennersr/django-allauth>
- **django-axes** — jazzband on GitHub · *Intermediate* · login failure tracking and lockout. <https://github.com/jazzband/django-axes>

---

*Django Handbook — chapter 25.*
