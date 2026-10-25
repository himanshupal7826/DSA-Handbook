# 06 · Forms, ModelForms & Validation

> **In one line:** A Django form is a validation pipeline with a rendering layer on top: untrusted strings go in, typed and checked `cleaned_data` comes out, and every step (`to_python` → `validate` → validators → `clean_<field>` → `clean` → model validation) has a precise order you must know to put each rule in the right place.

---

## 1. Overview

> **Builds on:** [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses) (where `request.POST` and `request.FILES` come from) and [Ch 05 · Django Template Language](topic.html?p=05-templates) (how forms render and autoescape).

Every web application eventually accepts input from people it does not trust. The browser sends you a `QueryDict` of **strings** — `"42"`, `"2026-10-25"`, `"on"`, `""` — and your code wants an `int`, a `date`, a `bool` and a decision about whether "empty" is allowed. In between sit a dozen jobs: converting types, rejecting nonsense, enforcing business rules that span several fields, showing errors next to the right input, re-filling the form so the user does not retype everything, and protecting against people who post fields you never rendered.

The naive approach is to do this by hand in the view:

```python
def signup(request):
    if request.method == "POST":
        age = int(request.POST["age"])          # ValueError on "abc", KeyError if missing
        email = request.POST.get("email", "")
        if "@" not in email:
            return HttpResponse("bad email")    # where does this error show? which field?
        User.objects.create(email=email, age=age)
```

It crashes on bad input (a 500 instead of a friendly error), mixes parsing with business rules, cannot re-render the form with the user's values, and has to be rewritten for every view. Worse, the rules live in one view — the API endpoint, the admin and the management command all re-implement (or forget) them.

Django's **forms framework** solves this with three ideas. A **Form class** declares fields declaratively, like a model. Each **Field** knows how to turn a string into a Python value and how to validate it. And a fixed, documented **validation pipeline** runs when you call `is_valid()`, collecting *all* errors (not just the first) into `form.errors`, keyed by field. A **ModelForm** goes further and derives the fields from a model, then runs the model's own validation (`full_clean()`, uniqueness, constraints) before you save. The same Form object renders itself to HTML, carries the user's submitted values back into the inputs, and escapes everything.

> **Why this matters:** "Where do I put this validation rule?" is the single most common forms question in interviews and code review. The answer depends on the pipeline order: single-value type checks go in the Field or a validator, rules about one field go in `clean_<field>()`, cross-field rules go in `clean()`, and invariants that must hold *everywhere* (admin, API, shell) belong on the model. This chapter makes that order second nature.

## 2. Core Concepts

- **`Form`** — a class whose class attributes are `Field` instances; the metaclass `DeclarativeFieldsMetaclass` collects them into `base_fields`, and each instance deep-copies them into `self.fields`. *Why it matters:* you can mutate `self.fields` per instance (e.g. limit a queryset to the current user) without affecting other requests.
- **Bound vs unbound form** — a form is **bound** if you passed `data` (and optionally `files`), even an empty dict; otherwise it is **unbound** and only renders `initial`. *Why it matters:* only bound forms validate; `is_valid()` on an unbound form is always `False` with no errors.
- **`Field`** — converts and validates one value: `forms.CharField`, `IntegerField`, `EmailField`, `DateField`, `ChoiceField`, `ModelChoiceField`, `FileField`, `ImageField`… *Why it matters:* the field, not your view, owns type conversion.
- **`Widget`** — the HTML representation of a field (`TextInput`, `Select`, `CheckboxInput`, `ClearableFileInput`) and the code that reads its value back out of the POST data (`value_from_datadict`). *Why it matters:* field = *what* the data is; widget = *how* it is displayed and extracted.
- **`cleaned_data`** — the dict of validated, typed values. Exists only after validation; contains only fields that passed. *Why it matters:* never read `request.POST` after a form validated it — read `cleaned_data`.
- **`form.errors`** — an `ErrorDict` mapping field name → `ErrorList`; cross-field errors live under `NON_FIELD_ERRORS` (`"__all__"`) and are returned by `form.non_field_errors()`. *Why it matters:* this is what the template shows and what tests assert on.
- **`ValidationError`** — the exception every validation step raises; carries `message`, `code` and `params`. *Why it matters:* using `code=` lets callers (and tests, and `error_messages`) identify errors without parsing English.
- **Validator** — a callable that takes a value and raises `ValidationError` (`MinValueValidator`, `RegexValidator`, `FileExtensionValidator`, or your own function). *Why it matters:* validators are reusable across form fields **and** model fields.
- **`clean_<fieldname>()`** — a form method for single-field rules that need form context (the current user, other DB lookups). Must **return** the cleaned value.
- **`clean()`** — the form-wide hook for rules involving several fields; runs even if some fields failed.
- **`ModelForm`** — a form generated from a model via `class Meta: model = ...; fields = [...]`; its `save()` creates or updates `self.instance`.
- **`initial`** — values shown on an unbound form (and used to compute `has_changed()`); *not* a default that is applied on submit.
- **Formset** — a collection of the same form repeated N times, coordinated by a hidden **management form** (`TOTAL_FORMS`, `INITIAL_FORMS`, `MIN_NUM_FORMS`, `MAX_NUM_FORMS`).
- **Inline formset** — a model formset bound to a parent object through a ForeignKey (order + order lines).
- **`request.FILES`** — uploaded files, populated only when the form is `enctype="multipart/form-data"` and the method is POST.

## 3. Theory & Principles

### The validation pipeline, step by step

Calling `form.is_valid()` checks `self.is_bound and not self.errors`. Accessing `self.errors` triggers `full_clean()` the first time (the result is cached on the instance). `Form.full_clean()` does three things, in order:

1. **`_clean_fields()`** — for each field in declaration order:
   1. Read the raw value through the widget: `field.widget.value_from_datadict(data, files, prefixed_name)` (disabled fields use their initial value instead — the browser value is ignored, which is why `disabled=True` is a safe way to show read-only data).
   2. `value = field.clean(value)`, which is itself three steps:
      - **`to_python(value)`** — convert the string to the Python type (`"42"` → `42`); raises `ValidationError(code="invalid")` if it cannot.
      - **`validate(value)`** — field-intrinsic checks that are not validators, chiefly `required` (raises `code="required"` for empty values) and, for `ChoiceField`, "is this one of the choices".
      - **`run_validators(value)`** — runs every validator in `field.validators` (including those implied by `max_length`, `min_value`…), **collecting all their errors** rather than stopping at the first.
   3. Store `cleaned_data[name] = value`.
   4. If the form defines **`clean_<name>()`**, call it; its **return value** replaces `cleaned_data[name]`.
   5. Any `ValidationError` in steps 2–4 goes to `self.add_error(name, e)`, which also **removes** the name from `cleaned_data`.
2. **`_clean_form()`** — call **`self.clean()`**. If it returns a dict, that becomes `cleaned_data` (returning `None` keeps the existing one). A `ValidationError` raised here becomes a non-field error.
3. **`_post_clean()`** — a hook that does nothing on `Form` but is where **`ModelForm`** builds the instance and runs **model validation**.

Two consequences fall straight out of that order. First, `clean_<field>()` only runs if the field's own `clean()` succeeded, so inside it `self.cleaned_data[name]` is guaranteed to exist and be typed. Second, `clean()` runs **even if fields failed**, so inside it you must use `self.cleaned_data.get("x")` — a failed field is simply absent.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj06a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj06b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">form.is_valid() &#8594; full_clean(): the exact order</text>
  <rect x="20" y="44" width="120" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="80" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">raw POST string</text>
  <text x="80" y="80" text-anchor="middle" fill="#334155" font-size="10">"42" / "" / "abc"</text>
  <path d="M142,69 L170,69" stroke="#2563eb" stroke-width="2" marker-end="url(#dj06a)"/>
  <rect x="172" y="36" width="520" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="432" y="54" text-anchor="middle" fill="#1e40af" font-weight="bold">1. _clean_fields() &#8212; per field, in declaration order</text>
  <rect x="186" y="64" width="110" height="46" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="241" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">widget</text>
  <text x="241" y="98" text-anchor="middle" fill="#334155" font-size="9">value_from_datadict</text>
  <path d="M298,87 L312,87" stroke="#2563eb" stroke-width="2" marker-end="url(#dj06a)"/>
  <rect x="314" y="64" width="100" height="46" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="364" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">to_python()</text>
  <text x="364" y="98" text-anchor="middle" fill="#334155" font-size="9">"42" &#8594; 42</text>
  <path d="M416,87 L430,87" stroke="#2563eb" stroke-width="2" marker-end="url(#dj06a)"/>
  <rect x="432" y="64" width="100" height="46" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="482" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">validate()</text>
  <text x="482" y="98" text-anchor="middle" fill="#334155" font-size="9">required, choices</text>
  <path d="M534,87 L548,87" stroke="#2563eb" stroke-width="2" marker-end="url(#dj06a)"/>
  <rect x="550" y="64" width="128" height="46" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="614" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">run_validators()</text>
  <text x="614" y="98" text-anchor="middle" fill="#334155" font-size="9">collects ALL errors</text>
  <text x="432" y="128" text-anchor="middle" fill="#1e40af" font-size="10">field.clean(value) = to_python &#8594; validate &#8594; run_validators &#8594; cleaned_data[name]</text>
  <rect x="314" y="138" width="364" height="38" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="496" y="154" text-anchor="middle" fill="#14532d" font-weight="bold">clean_&lt;name&gt;() &#8212; only if field.clean passed</text>
  <text x="496" y="168" text-anchor="middle" fill="#166534" font-size="9">must RETURN the value; it replaces cleaned_data[name]</text>
  <path d="M432,188 L432,212" stroke="#2563eb" stroke-width="2" marker-end="url(#dj06a)"/>
  <rect x="172" y="214" width="520" height="56" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="432" y="236" text-anchor="middle" fill="#92400e" font-weight="bold">2. _clean_form() &#8594; form.clean()</text>
  <text x="432" y="254" text-anchor="middle" fill="#b45309" font-size="10">cross-field rules; ALWAYS runs; failed fields are absent &#8594; use cleaned_data.get()</text>
  <path d="M432,272 L432,296" stroke="#2563eb" stroke-width="2" marker-end="url(#dj06a)"/>
  <rect x="172" y="298" width="520" height="66" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="432" y="320" text-anchor="middle" fill="#5b21b6" font-weight="bold">3. _post_clean() &#8212; ModelForm only</text>
  <text x="432" y="338" text-anchor="middle" fill="#6d28d9" font-size="10">construct_instance() &#8594; instance.full_clean(exclude=...)</text>
  <text x="432" y="354" text-anchor="middle" fill="#6d28d9" font-size="10">model field validators, Model.clean(), unique checks, Meta.constraints</text>
  <rect x="712" y="120" width="150" height="120" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="787" y="142" text-anchor="middle" fill="#991b1b" font-weight="bold">ValidationError</text>
  <text x="787" y="162" text-anchor="middle" fill="#7f1d1d" font-size="10">add_error(name, e)</text>
  <text x="787" y="180" text-anchor="middle" fill="#7f1d1d" font-size="10">removes name from</text>
  <text x="787" y="194" text-anchor="middle" fill="#7f1d1d" font-size="10">cleaned_data</text>
  <text x="787" y="214" text-anchor="middle" fill="#7f1d1d" font-size="10">clean() errors &#8594;</text>
  <text x="787" y="228" text-anchor="middle" fill="#7f1d1d" font-size="10">"__all__"</text>
  <path d="M694,110 L710,130" stroke="#dc2626" stroke-width="2" marker-end="url(#dj06b)"/>
  <path d="M694,242 L710,232" stroke="#dc2626" stroke-width="2" marker-end="url(#dj06b)"/>
  <rect x="20" y="384" width="842" height="34" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="441" y="405" text-anchor="middle" fill="#334155" font-size="11">is_valid() = is_bound and not errors &#183; errors computed once and cached &#183; every step runs; you get ALL errors, not the first</text>
</svg>
```

### How Django implements it internally

- `django.forms.forms.BaseForm.errors` is a property: `if self._errors is None: self.full_clean()`. That is why calling `is_valid()` twice is cheap, and why mutating `data` after validation does nothing.
- `Field.clean()` lives in `django/forms/fields.py`; `run_validators` loops over validators, catches each `ValidationError`, extends a list, and raises one combined error at the end. That is the "collect all errors" behaviour.
- **Empty values**: each field has `empty_values` (by default `(None, "", [], (), {})`). `validate()` raises `required` if the value is in that set, and `run_validators` *skips* validators for empty values — so a `MinLengthValidator` never fires on an optional empty field.
- `CharField.to_python` strips whitespace (`strip=True` by default) and returns `empty_value` (`""` by default) for empty input — so `"   "` becomes `""` and fails `required`.
- In Django 5.x, `_clean_fields` iterates `self._bound_items()` and reads each value through `BoundField` (`bf.data` or `bf.initial` for disabled fields).

### Where a rule belongs

| Rule | Put it in | Why |
|---|---|---|
| "Must be an integer 1–100" | Field options (`IntegerField(min_value=1, max_value=100)`) | Built-in, gives proper HTML attributes too |
| "Must match our SKU format" (reusable) | A validator function | Shareable with model fields and DRF |
| "Username must not be taken" | `clean_username()` (or model `unique=True`) | Needs a DB lookup; tied to one field |
| "End date after start date" | `Form.clean()` | Involves two fields |
| "Coupon valid for *this* user" | `clean_coupon()` with user injected in `__init__` | Needs request context |
| "Order total never negative, anywhere" | Model `clean()` + `CheckConstraint` | Must hold for admin, API, shell — not just this form |

## 4. Architecture & Workflow

### The request cycle around a form

A form view handles two requests. On **GET** you build an **unbound** form (optionally with `initial`) and render it. On **POST** you build a **bound** form from `request.POST`/`request.FILES` and call `is_valid()`. If it fails, you **re-render the same bound form** — it carries the user's values and the errors back into the HTML. If it passes, you act on `cleaned_data` and **redirect** (Post/Redirect/Get), so that refreshing the result page does not resubmit the POST.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj06c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj06d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="dj06e" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One form, two requests: GET renders, POST validates, success redirects (PRG)</text>
  <rect x="20" y="50" width="110" height="290" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="75" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Browser</text>
  <rect x="380" y="50" width="200" height="290" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="480" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">View</text>
  <path d="M132,96 L376,96" stroke="#334155" stroke-width="2" marker-end="url(#dj06c)"/>
  <text x="250" y="90" text-anchor="middle" fill="#334155">GET /signup/</text>
  <rect x="396" y="84" width="168" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="480" y="103" text-anchor="middle" fill="#1e293b">SignupForm() &#8212; UNBOUND</text>
  <path d="M376,128 L134,128" stroke="#334155" stroke-width="2" marker-end="url(#dj06c)"/>
  <text x="250" y="122" text-anchor="middle" fill="#334155">200 HTML (initial values)</text>
  <path d="M132,170 L376,170" stroke="#334155" stroke-width="2" marker-end="url(#dj06c)"/>
  <text x="250" y="164" text-anchor="middle" fill="#334155">POST + csrf token</text>
  <rect x="396" y="156" width="168" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="480" y="174" text-anchor="middle" fill="#1e293b">SignupForm(request.POST)</text>
  <text x="480" y="190" text-anchor="middle" fill="#5b21b6" font-size="10">BOUND &#8594; is_valid()</text>
  <path d="M566,178 L640,140" stroke="#dc2626" stroke-width="2" marker-end="url(#dj06e)"/>
  <rect x="642" y="110" width="220" height="60" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="752" y="132" text-anchor="middle" fill="#991b1b" font-weight="bold">invalid</text>
  <text x="752" y="148" text-anchor="middle" fill="#7f1d1d" font-size="10">re-render SAME bound form</text>
  <text x="752" y="162" text-anchor="middle" fill="#7f1d1d" font-size="10">200 (or 422/400 for APIs) + errors</text>
  <path d="M566,190 L640,240" stroke="#16a34a" stroke-width="2" marker-end="url(#dj06d)"/>
  <rect x="642" y="214" width="220" height="60" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="752" y="236" text-anchor="middle" fill="#14532d" font-weight="bold">valid</text>
  <text x="752" y="252" text-anchor="middle" fill="#166534" font-size="10">use cleaned_data / form.save()</text>
  <text x="752" y="266" text-anchor="middle" fill="#166534" font-size="10">then redirect()</text>
  <path d="M376,296 L134,296" stroke="#16a34a" stroke-width="2" marker-end="url(#dj06d)"/>
  <text x="250" y="290" text-anchor="middle" fill="#166534">302 Location: /welcome/</text>
  <path d="M132,324 L376,324" stroke="#334155" stroke-width="2" marker-end="url(#dj06c)"/>
  <text x="250" y="318" text-anchor="middle" fill="#334155">GET /welcome/ (refresh is safe)</text>
</svg>
```

### Components and who owns what

```text
Form class ─┬─ base_fields (class-level, built by DeclarativeFieldsMetaclass)
            └─ instance: fields (deep copy) ── BoundField per field (form["email"])
                                     │                 ├── value(), errors, label_tag()
Field ─── to_python / validate / validators            └── widget.render(name, value, attrs)
Widget ── value_from_datadict(data, files, name)  ← reads the POST
          render() via form renderer (templates: django/forms/widgets/*.html)
ModelForm ── ModelFormMetaclass → fields_for_model(model, fields, exclude, widgets...)
          └─ _post_clean → construct_instance → instance.full_clean → validate_unique
```

Rendering is template-based (since 4.0, via `FORM_RENDERER`). In **Django 5.0+** the default form template is the div-based one (`{{ form }}` equals `{{ form.as_div }}`), and `{{ form.email.as_field_group }}` renders label, help text, errors and widget for one field — handy for custom layouts without hand-writing every `<label>`.

## 5. Implementation

### Simple example: a contact form

```python
# contact/forms.py
from django import forms
from django.core.exceptions import ValidationError


class ContactForm(forms.Form):
    name = forms.CharField(max_length=100)
    email = forms.EmailField()
    subject = forms.ChoiceField(choices=[("sales", "Sales"), ("support", "Support")])
    message = forms.CharField(widget=forms.Textarea, min_length=20)
    cc_myself = forms.BooleanField(required=False)

    def clean_name(self):
        name = self.cleaned_data["name"]          # guaranteed present and stripped
        if name.lower() == "admin":
            raise ValidationError("That name is reserved.", code="reserved")
        return name.title()                        # MUST return the value

    def clean(self):
        cleaned = super().clean()
        subject, message = cleaned.get("subject"), cleaned.get("message")  # .get(): may be absent
        if subject == "sales" and message and "price" not in message.lower():
            self.add_error("message", "Sales enquiries should mention pricing.")
        return cleaned
```

```python
# contact/views.py
from django.shortcuts import redirect, render
from .forms import ContactForm


def contact(request):
    if request.method == "POST":
        form = ContactForm(request.POST)
        if form.is_valid():
            send_contact_email(**form.cleaned_data)    # typed values, never request.POST
            return redirect("contact-thanks")          # PRG
    else:
        form = ContactForm(initial={"subject": "support"})
    return render(request, "contact/form.html", {"form": form})
```

```html
<!-- contact/templates/contact/form.html -->
<form method="post" novalidate>
  {% csrf_token %}
  {{ form.non_field_errors }}
  {{ form.name.as_field_group }}
  {{ form.email.as_field_group }}
  {{ form.subject.as_field_group }}
  {{ form.message.as_field_group }}
  {{ form.cc_myself.as_field_group }}
  <button type="submit">Send</button>
</form>
```

Try it in the shell to see the pipeline in action:

```python
>>> f = ContactForm({"name": "admin", "email": "nope", "subject": "x", "message": "short"})
>>> f.is_bound, f.is_valid()
(True, False)
>>> f.errors.as_data()
```

```text
{'name': [ValidationError(['That name is reserved.'])],
 'email': [ValidationError(['Enter a valid email address.'])],
 'subject': [ValidationError(['Select a valid choice. x is not one of the available choices.'])],
 'message': [ValidationError(['Ensure this value has at least 20 characters (it has 5).'])]}
```

Every field failed independently and all four errors were collected. `clean()` still ran, found nothing in `cleaned_data` for `subject`/`message`, and added nothing.

### Reusable validators

```python
# core/validators.py
import re
from django.core.exceptions import ValidationError
from django.utils.deconstruct import deconstructible

SKU_RE = re.compile(r"^[A-Z]{3}-\d{4}$")


def validate_sku(value):
    if not SKU_RE.match(value):
        raise ValidationError("%(value)s is not a valid SKU (AAA-9999).",
                              code="invalid_sku", params={"value": value})


@deconstructible   # required if a model field uses it, so migrations can serialize it
class MaxFileSizeValidator:
    def __init__(self, max_bytes):
        self.max_bytes = max_bytes

    def __call__(self, f):
        if f.size > self.max_bytes:
            raise ValidationError("File too large (max %(max)s bytes).",
                                  code="file_too_large", params={"max": self.max_bytes})

    def __eq__(self, other):
        return isinstance(other, MaxFileSizeValidator) and self.max_bytes == other.max_bytes
```

The same `validate_sku` can sit on `models.CharField(validators=[validate_sku])` and on a form field — and because ModelForm runs model validation, you get it in forms, the admin and DRF `ModelSerializer` for free.

### Real-world example: a ModelForm with request context, files and an inline formset

The scenario: a seller creates a `Product` with an image and several `Variant` rows (size/colour/stock) on one page. The category dropdown must only show the seller's own categories, the SKU must be unique per seller, and the whole thing saves atomically.

```python
# catalog/models.py
from django.conf import settings
from django.core.validators import FileExtensionValidator, MinValueValidator
from django.db import models
from core.validators import validate_sku, MaxFileSizeValidator


class Category(models.Model):
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    name = models.CharField(max_length=80)


class Product(models.Model):
    seller = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    category = models.ForeignKey(Category, on_delete=models.PROTECT)
    sku = models.CharField(max_length=8, validators=[validate_sku])
    title = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=10, decimal_places=2,
                                validators=[MinValueValidator(0)])
    sale_price = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    image = models.ImageField(
        upload_to="products/%Y/%m/", blank=True,
        validators=[FileExtensionValidator(["jpg", "jpeg", "png", "webp"]),
                    MaxFileSizeValidator(5 * 1024 * 1024)],
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["seller", "sku"], name="uniq_seller_sku"),
        ]

    def clean(self):
        # Model-level invariant: holds for forms, admin, and full_clean() callers.
        if self.sale_price is not None and self.sale_price >= self.price:
            from django.core.exceptions import ValidationError
            raise ValidationError({"sale_price": "Sale price must be below the price."})


class Variant(models.Model):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="variants")
    size = models.CharField(max_length=10)
    colour = models.CharField(max_length=30)
    stock = models.PositiveIntegerField(default=0)
```

```python
# catalog/forms.py
from django import forms
from django.forms import inlineformset_factory, BaseInlineFormSet
from .models import Category, Product, Variant


class ProductForm(forms.ModelForm):
    class Meta:
        model = Product
        fields = ["category", "sku", "title", "price", "sale_price", "image"]  # explicit allow-list
        widgets = {"title": forms.TextInput(attrs={"placeholder": "e.g. Linen shirt"})}
        error_messages = {"sku": {"invalid_sku": "Use the format ABC-1234."}}

    def __init__(self, *args, user, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user
        # Restrict choices per request; also VALIDATES (a forged id fails "invalid_choice").
        self.fields["category"].queryset = Category.objects.filter(owner=user)
        # 'seller' is not a form field, so set it before _post_clean so the
        # (seller, sku) UniqueConstraint can be validated against the right seller.
        self.instance.seller = user


class BaseVariantFormSet(BaseInlineFormSet):
    def clean(self):
        super().clean()
        seen = set()
        for form in self.forms:
            if not form.cleaned_data or form.cleaned_data.get("DELETE"):
                continue
            key = (form.cleaned_data["size"], form.cleaned_data["colour"])
            if key in seen:
                raise forms.ValidationError("Each size/colour combination must be unique.")
            seen.add(key)


VariantFormSet = inlineformset_factory(
    Product, Variant, formset=BaseVariantFormSet,
    fields=["size", "colour", "stock"], extra=2, can_delete=True,
    min_num=1, validate_min=True, max_num=50, validate_max=True,
)
```

> **Gotcha:** constraint and unique validation in ModelForm skips any field that is not in the form. Because `seller` is excluded, Django cannot know which seller to check against unless you set `self.instance.seller` *before* validation runs. If you only set it after `form.save(commit=False)`, the duplicate slips through validation and you get an `IntegrityError` (a 500) at `save()` time instead of a friendly form error.

```python
# catalog/views.py
from django.contrib.auth.decorators import login_required
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render
from .forms import ProductForm, VariantFormSet
from .models import Product


@login_required
def product_edit(request, pk=None):
    product = get_object_or_404(Product, pk=pk, seller=request.user) if pk else Product()
    if request.method == "POST":
        form = ProductForm(request.POST, request.FILES, instance=product, user=request.user)
        formset = VariantFormSet(request.POST, instance=product, prefix="variants")
        if form.is_valid() and formset.is_valid():      # evaluate BOTH so both show errors
            with transaction.atomic():
                product = form.save()                    # instance.seller already set
                formset.instance = product
                formset.save()
            return redirect("product-detail", pk=product.pk)
    else:
        form = ProductForm(instance=product, user=request.user)
        formset = VariantFormSet(instance=product, prefix="variants")
    return render(request, "catalog/product_form.html", {"form": form, "formset": formset})
```

> **Gotcha:** `form.is_valid() and formset.is_valid()` short-circuits — if the form is invalid, the formset never validates and its errors do not show on the first round trip. Some teams write `all([form.is_valid(), formset.is_valid()])` so both always run.

```html
<!-- catalog/templates/catalog/product_form.html -->
<form method="post" enctype="multipart/form-data">
  {% csrf_token %}
  {{ form }}
  {{ formset.management_form }}
  {{ formset.non_form_errors }}
  <table>
    {% for f in formset %}
      <tr>{% for field in f.visible_fields %}<td>{{ field }} {{ field.errors }}</td>{% endfor %}
          {% for hidden in f.hidden_fields %}{{ hidden }}{% endfor %}</tr>
    {% endfor %}
  </table>
  <button>Save</button>
</form>
```

The SQL issued by a successful create (PostgreSQL, two variants) shows the work ModelForm validation does before anything is written:

```sql
-- ModelChoiceField validation: the submitted category id must be in the restricted queryset
SELECT "catalog_category"."id", "catalog_category"."owner_id", "catalog_category"."name"
FROM "catalog_category"
WHERE ("catalog_category"."owner_id" = 7 AND "catalog_category"."id" = 3) LIMIT 21;

-- UniqueConstraint(seller, sku) validated by Model.validate_constraints()
SELECT 1 AS "a" FROM "catalog_product"
WHERE ("catalog_product"."seller_id" = 7 AND "catalog_product"."sku" = 'SHI-0042') LIMIT 1;

-- then, inside transaction.atomic()
INSERT INTO "catalog_product" ("seller_id", "category_id", "sku", "title", "price", "sale_price", "image")
VALUES (7, 3, 'SHI-0042', 'Linen shirt', 49.00, NULL, 'products/2026/10/shirt.webp') RETURNING "catalog_product"."id";
INSERT INTO "catalog_variant" ("product_id", "size", "colour", "stock") VALUES (51, 'M', 'white', 10) RETURNING "catalog_variant"."id";
INSERT INTO "catalog_variant" ("product_id", "size", "colour", "stock") VALUES (51, 'L', 'white', 4) RETURNING "catalog_variant"."id";
```

Note the validation-time uniqueness check is a **separate SELECT** — a race between two concurrent submissions can still pass both checks, so the database `UniqueConstraint` remains the real guarantee. Catch `IntegrityError` at save time if you expect contention (see [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency)).

### `save(commit=False)` and many-to-many

```python
form = ArticleForm(request.POST)
if form.is_valid():
    article = form.save(commit=False)   # instance built, NOT saved; M2M not saved
    article.author = request.user
    article.save()
    form.save_m2m()                      # required: tags can only be set once article has a pk
```

Forgetting `save_m2m()` after `commit=False` is a classic silent bug — the article saves, its tags vanish.

### File uploads in brief

Uploaded files only appear in `request.FILES` if the form has `enctype="multipart/form-data"` and you pass `request.FILES` to the form. Files up to `FILE_UPLOAD_MAX_MEMORY_SIZE` (2.5 MB by default) are held in memory (`InMemoryUploadedFile`); larger ones stream to a temp file (`TemporaryUploadedFile`). `ImageField` uses Pillow to verify the content is a real image; `FileField` only checks a file was sent. **Never trust `uploaded.content_type` or the filename** — both come from the client. Storage, `MEDIA_ROOT`, S3 and serving are covered in [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files).

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Strengths | Weaknesses | Best for |
|---|---|---|---|
| Plain `Form` | Total control of fields; not tied to a model | You map fields to models yourself | Search, contact, login, multi-model wizards |
| `ModelForm` | Fields, widgets, model validation, unique/constraint checks and `save()` for free | Couples UI to schema; mass-assignment risk with `__all__` | CRUD on one model |
| Formsets / inline formsets | Many rows in one submit with add/delete | Management-form fiddliness; heavy on large N; JS needed to add rows | Order lines, variants, addresses |
| DRF serializers | JSON, nested data, content negotiation | Separate from forms; does not run `Model.clean()` | APIs ([Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers)) |
| Client-only validation (HTML5/JS) | Instant feedback | Trivially bypassed | UX only — always validate server-side too |
| Model-level validation + DB constraints | One source of truth for every entry point | `save()` does not call `full_clean()` automatically | Invariants that must always hold |

### When to use
- Any server-rendered HTML input — forms give you escaping, CSRF integration, error display and value re-population.
- ModelForm for straightforward create/edit of one model, with an explicit `fields` list.
- Plain `Form` as a **validation object** even outside HTML: management commands, CSV imports, webhook payloads — `MyForm(data=row).is_valid()` is a perfectly good validator.

### When NOT to use
- JSON APIs — use DRF serializers (or Pydantic/ninja schemas); forms do not handle nested JSON well.
- Highly dynamic SPA UIs where the server only returns JSON.
- Enormous editable grids (thousands of rows) — formsets render and validate every row; use a bulk-edit API or CSV import.

## 7. Common Mistakes & Best Practices

**1. `fields = "__all__"` (or `exclude`) on a ModelForm.** It feels convenient, but any field you later add to the model — `is_staff`, `balance`, `approved` — becomes user-editable instantly. An attacker just adds `&is_staff=on` to the POST. *Instead:* an explicit `fields = [...]` allow-list. Django requires you to choose `fields` or `exclude` precisely because of this.

**2. Forgetting to return from `clean_<field>()`.**

```python
# Wrong: cleaned_data["email"] becomes None
def clean_email(self):
    email = self.cleaned_data["email"].lower()
    if User.objects.filter(email=email).exists():
        raise ValidationError("Taken.")

# Right
def clean_email(self):
    email = self.cleaned_data["email"].lower()
    if User.objects.filter(email__iexact=email).exists():
        raise ValidationError("Taken.", code="duplicate")
    return email
```

**3. Indexing `cleaned_data["x"]` in `clean()`.** If `x` failed its own validation it is not in `cleaned_data`, and you get a `KeyError` — a 500 on bad input. *Instead:* `cleaned_data.get("x")`, and only compare when both values are present.

**4. Overriding `ModelForm.clean()` without `super().clean()`.** `BaseModelForm.clean()` sets the flag that makes `_post_clean` run unique validation. Skip it and duplicates reach the database as `IntegrityError`. Always start with `cleaned = super().clean()`.

**5. `Form(request.POST or None)`.** A POST with zero fields (e.g. all checkboxes unticked) gives an empty, falsy `QueryDict`, so the form is unbound and the submission is silently ignored. *Instead:* branch on `request.method == "POST"`.

**6. Re-rendering a fresh form on error.** Writing `form = MyForm()` in the invalid branch throws away the user's input and the errors. Re-render the bound form.

**7. Not redirecting after success.** Rendering a template on a successful POST means F5 re-submits — duplicate orders, double emails. Use PRG.

**8. Business invariants only in the form.** The admin, the API, a Celery task or `shell` will all bypass them. Put invariants in `Model.clean()` **and** back them with constraints; let forms add UX-specific rules on top.

**9. Calling `Model.save()` and assuming validation ran.** `save()` never calls `full_clean()`. If you build instances outside forms, call `obj.full_clean()` explicitly (see [Ch 08 · Models & Fields](topic.html?p=08-models-fields)).

**10. Mutating `self.fields` at class level or sharing querysets.** Changing `ProductForm.base_fields["category"].queryset` affects every future request. Do per-request changes in `__init__` on `self.fields`.

**Best practices:** pass request-scoped context (user, tenant) as explicit keyword arguments to `__init__`; give every `ValidationError` a `code`; use `error_messages` for wording; use `disabled=True` for read-only fields (the posted value is ignored); add `novalidate` during development so you test server-side errors, not the browser's.

## 8. Production: Pitfalls, Debugging & Scaling

**N+1 queries from ModelChoiceField rendering.** A form with a `ModelChoiceField` whose labels use `__str__` that touches a relation (`f"{self.city.name} — {self.name}"`) runs one query per option. Symptom: a "slow edit page" with hundreds of queries in debug-toolbar. Fix: `self.fields["store"].queryset = Store.objects.select_related("city")`, or a custom `label_from_instance`. In formsets, each form gets its own copy of the field, so the choices query runs **once per form** — 50 rows means 50 identical queries. Fix: compute the choices once and assign them to each form's field, or switch to a lightweight `ChoiceField`.

**Huge dropdowns.** A `ModelChoiceField` over 200 000 customers renders a multi-megabyte `<select>` and runs a full-table query on every page load. Use an autocomplete widget backed by an endpoint (the admin's `autocomplete_fields` does exactly this; see [Ch 07 · The Django Admin](topic.html?p=07-django-admin)).

**Uniqueness races.** Two users submit the same username in the same second; both pass `clean_username()`'s `exists()` check; one insert raises `IntegrityError`. Root cause: check-then-act across two statements. Fix: keep the DB constraint, wrap the save in `try/except IntegrityError` and convert to `form.add_error("username", ...)`.

**Upload limits and DoS.** `DATA_UPLOAD_MAX_MEMORY_SIZE` (2.5 MB, excludes file data) and `DATA_UPLOAD_MAX_NUMBER_FIELDS` (1000) raise `RequestDataTooBig`/`TooManyFieldsSent` (a 400) when exceeded; Django 4.2 added `DATA_UPLOAD_MAX_NUMBER_FILES`. Large file bodies are bounded by your reverse proxy (`client_max_body_size` in Nginx) — set it, or a 2 GB upload ties up a worker. Symptom of a too-small proxy limit: users see a bare Nginx 413 page, not your form error.

**Formset tampering.** The management form is client-controlled. Setting `TOTAL_FORMS=100000` used to be a memory DoS; Django caps it with `absolute_max` (defaults derived from `max_num`). Missing or tampered management data now produces a non-form error rather than an exception (since 3.2).

**Debugging validation.** In a shell or test: `form.is_valid(); form.errors.as_json()`; `form.errors.as_data()` shows the `ValidationError` objects with their codes; `form.cleaned_data` shows what survived. In views, log `form.errors.get_json_data()` on invalid submits to spot fields users systematically get wrong. In tests, prefer `self.assertFormError(form, "email", "Taken.")` (5.x signature takes the form instance) or check `form.has_error("email", code="duplicate")`.

**Scaling notes.** Form instantiation deep-copies all fields — cheap for normal forms but measurable for giant dynamic forms rendered per row. Template-based widget rendering costs a template lookup per widget; the cached template loader (on by default when `DEBUG=False`) keeps this fast.

## 9. Interview Questions

**Q: What is the difference between a bound and an unbound form?**
A: A form is bound when you pass it data (`MyForm(request.POST)`), even an empty dict, and unbound when you do not (`MyForm()` or `MyForm(initial=...)`). Only bound forms can be validated; `is_valid()` on an unbound form returns `False` without errors. Unbound forms render `initial` values; bound forms render the submitted values so the user does not lose input. You check with `form.is_bound`. The typical view creates an unbound form on GET and a bound one on POST.

**Q: Walk me through what happens when you call form.is_valid().**
A: `is_valid()` returns `is_bound and not self.errors`; accessing `errors` runs `full_clean()` once and caches the result. `full_clean()` calls `_clean_fields()`, which for each field reads the raw value via the widget and calls `field.clean()` — `to_python()`, then `validate()`, then `run_validators()` — then calls `clean_<field>()` if defined. Next `_clean_form()` calls `form.clean()` for cross-field logic. Finally `_post_clean()` runs, which for a ModelForm builds the instance and calls `instance.full_clean()` plus unique and constraint validation. Every error is collected into `form.errors` rather than stopping at the first.

**Q: Where do you put validation that involves two fields, and what must you be careful about?**
A: In `Form.clean()`, because it runs after all fields have been individually cleaned. Be careful that it runs even when some fields failed, so those fields are missing from `cleaned_data` — use `.get()` and guard against `None`. Call `super().clean()` first, especially in a ModelForm where it enables unique validation. To attach the error to a specific field rather than the form, use `self.add_error("end_date", "...")` instead of raising. Return `cleaned_data` (or `None`, which keeps it).

**Q: What is the difference between clean_<field>() and a validator?**
A: A validator is a stand-alone callable that receives just the value and raises `ValidationError`; it is reusable across form fields, model fields and DRF. `clean_<field>()` is a form method with access to `self` — the other cleaned values that came before it, request context injected in `__init__`, the instance — and it can *transform* the value because its return value replaces `cleaned_data[field]`. Validators run inside `field.clean()`; `clean_<field>()` runs after it, and only if it succeeded. Use validators for pure value rules and `clean_<field>` for contextual ones.

**Q: Does Model.save() run validation? Does a ModelForm?**
A: `Model.save()` does not call `full_clean()`; it writes whatever you give it, and only database constraints stop bad data. A ModelForm does run model validation: in `_post_clean()` it calls `instance.full_clean(exclude=...)`, which runs model field validators, `Model.clean()`, and then unique and constraint checks. Fields not on the form are excluded from that validation. So if you create objects in code outside forms and want model rules enforced, you must call `full_clean()` yourself.

**Q: Why is fields = "__all__" on a ModelForm risky?**
A: It is a mass-assignment vulnerability waiting to happen. Every model field becomes editable through the form, including ones added later like `is_staff`, `price` or `owner`, and an attacker only needs to add the field to the POST body — they do not need it to be rendered. Django refuses to build a ModelForm with neither `fields` nor `exclude` precisely to force this decision. An explicit allow-list makes schema changes safe by default. `exclude` has the same problem as `__all__` because new fields are included automatically.

**Q: What does form.save(commit=False) do and when do you need save_m2m()?**
A: `commit=False` builds the model instance from `cleaned_data` but does not save it, so you can set fields that are not in the form (owner, tenant) before calling `instance.save()`. Many-to-many data cannot be saved until the instance has a primary key, so with `commit=False` Django attaches a `save_m2m()` method to the form for you to call after saving the instance. Forgetting it silently drops tags or groups. With `commit=True` (the default) Django saves the instance and the M2M data in one go.

**Q: How do you limit a ModelChoiceField to the current user's objects, and does that also protect against forged IDs?**
A: Pass the user into the form's `__init__` and set `self.fields["category"].queryset = Category.objects.filter(owner=user)`. Yes, it also protects: `ModelChoiceField.to_python` looks the submitted pk up in that queryset, so a forged id for someone else's category fails with `invalid_choice`. That lookup is the `SELECT ... WHERE owner_id = ... AND id = ...` you see in the query log. Do the assignment per instance — modifying `base_fields` would leak across requests.

**Q: What are formsets and what is the management form?**
A: A formset manages a list of identical forms submitted together, created with `formset_factory`, `modelformset_factory` or `inlineformset_factory` (for children of a parent via FK). The management form is a set of hidden inputs — `TOTAL_FORMS`, `INITIAL_FORMS`, `MIN_NUM_FORMS`, `MAX_NUM_FORMS` — that tells Django how many forms to read back from the POST. You must render `{{ formset.management_form }}`; without it you get a "ManagementForm data is missing or has been tampered with" error. Options like `extra`, `can_delete`, `min_num`/`validate_min` and `max_num`/`validate_max` control behaviour, and `formset.clean()` is the hook for rules across rows.

**Q: Why might file uploads silently not arrive in your form?**
A: The two usual causes are a missing `enctype="multipart/form-data"` on the `<form>` element and forgetting to pass `request.FILES` as the second argument to the form. Without the enctype the browser sends only filenames as text, and `request.FILES` is empty. Uploads also require POST. Beyond that, size limits at the proxy (Nginx 413) or Django's upload settings can reject the request before your view runs.

**Q: A user reports a 500 error when two people register the same username at the same moment, even though you check uniqueness in clean_username(). Why, and how do you fix it? (Senior)**
A: The check and the insert are two separate statements, so two concurrent requests can both run the `exists()` query before either inserts — classic check-then-act race. The second insert hits the database unique constraint and raises `IntegrityError`, which nothing catches. The form-level check is still valuable for the common case's UX, but the database constraint is the real guarantee. Fix: keep `unique=True`/`UniqueConstraint`, and wrap the save in `try: with transaction.atomic(): form.save() except IntegrityError: form.add_error("username", "Taken.")`, then re-render. The inner `atomic()` matters so the failed insert does not poison an outer transaction such as `ATOMIC_REQUESTS`.

**Q: How would you design validation so the same business rules apply to an HTML form, the admin, a DRF API and a CSV import? (Senior)**
A: Push invariants down to the lowest common layer. Pure value rules become reusable validators attached to model fields; multi-field invariants go in `Model.clean()`; and anything that must never be violated is also a `UniqueConstraint`/`CheckConstraint` in the database. ModelForms and the admin get this automatically via `full_clean()`. DRF `ModelSerializer` runs field validators and unique validators but not `Model.clean()`, so either call `full_clean()` in the serializer's `validate()`/`create()` or move logic into a service function that every entry point calls. The CSV import should use a form or call `full_clean()` per row. Form-specific concerns — password confirmation, captcha — stay in the form.

**Q: An edit page with a 30-row inline formset is slow and debug-toolbar shows 600 queries. What is going on and how do you fix it? (Senior)**
A: Each form in a formset gets its own deep copy of every field, so a `ModelChoiceField` runs its choices query once per row, and if option labels touch related objects you multiply again by the number of options. Initial data for model formsets can also lazily load related objects per row. Fixes: give the formset a queryset with `select_related`/`prefetch_related`; evaluate choices once (e.g. build a list of `(pk, label)` and assign `field.choices` in the formset's `get_form_kwargs`/`_construct_form`), or use `ModelChoiceField` with an `iterator` override; use autocomplete widgets for large choice sets. Then lock it in with `assertNumQueries` in a test.

**Q: What are the main pitfalls when accepting user file uploads in production? (Senior)**
A: Never trust the client-supplied filename or `content_type`; validate the extension with `FileExtensionValidator`, verify content (Pillow for images, `python-magic` for others) and enforce size limits both in Django and at the proxy. Store uploads outside your code directory, ideally on object storage, with generated names to avoid path tricks and overwrites. Serve user content from a separate domain or with `Content-Disposition: attachment` so an uploaded HTML/SVG file cannot run script on your origin. Large files should stream to temporary files (Django does this above `FILE_UPLOAD_MAX_MEMORY_SIZE`) or go direct-to-S3 via presigned URLs so web workers are not tied up. Scan for malware asynchronously if users download each other's files.

**Q: What is the difference between initial and a model field default?**
A: `initial` is purely a display value for an unbound form; if the user clears the input and submits, `initial` is not applied — the field is empty. It is also used to compute `has_changed()`. A model `default` is applied when a model instance is created without that value, and a ModelForm uses it to pre-fill the unbound form. If you need a value applied server-side regardless of what was posted, set it in `clean_<field>`, `save(commit=False)` or make the field `disabled`.

## 10. Quick Revision & Cheat Sheet

| Step | Method | Runs when | Typical use |
|---|---|---|---|
| Read value | `widget.value_from_datadict` | Always | Extracting from POST/FILES |
| Convert | `field.to_python` | Always | `"42"` → `42` |
| Field checks | `field.validate` | Always | `required`, valid choice |
| Validators | `field.run_validators` | Value not empty | Length, range, regex, custom |
| Field hook | `clean_<name>()` | Field passed | Context-aware single-field rule; must return |
| Form hook | `clean()` | Always | Cross-field rules; use `.get()` |
| Model | `_post_clean` → `full_clean` | ModelForm only | Model validators, `Model.clean`, unique, constraints |

- `is_valid()` = `is_bound and not errors`; errors computed once, cached.
- All errors are collected; nothing short-circuits except per-field (`clean_<x>` skipped if `x` failed).
- `cleaned_data` is the only thing to read after validation.
- `add_error(field, msg)` removes the field from `cleaned_data`; `None` field = non-field error.
- `Model.save()` never validates; ModelForm does via `full_clean()`.
- Explicit `fields = [...]` on every ModelForm.
- `commit=False` → `instance.save()` → `form.save_m2m()`.
- Uploads need `enctype="multipart/form-data"` **and** `request.FILES`.
- PRG: redirect after a successful POST.
- Validation-time unique checks race; the DB constraint is the guarantee.

## 11. Hands-On Exercises

Set up a throwaway project:

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" pillow
django-admin startproject formlab . && python manage.py startapp shop
```

1. **Trace the pipeline.** Write a form with a field that has a validator, a `clean_<field>`, and a `clean()`, each printing a line. Submit valid and invalid data in the shell and confirm the order, including that `clean()` runs when a field fails but `clean_<field>` does not.
2. **Mass assignment.** Build a `ProfileForm` with `fields="__all__"` on a model that has `is_verified`. POST `is_verified=on` with `curl` and see it saved. Switch to an allow-list and repeat.
3. **Race the unique check.** Add `clean_username()` with an `exists()` check, then use two threads (or `TransactionTestCase` with two connections) to submit the same name. Observe the `IntegrityError`; add the `try/except` and convert it to a form error.
4. **Inline formset.** Implement the Product + Variant page from §5 with `can_delete`. Add JavaScript (or extra rows) to submit five variants; tamper with `TOTAL_FORMS` and observe the non-form error.
5. **Uploads.** Accept an avatar with `ImageField`; try uploading a text file renamed to `.png` and see Pillow reject it. Add a 1 MB size validator.
6. **Query count.** Render a 20-row model formset with a `ModelChoiceField` and count queries with `assertNumQueries`; then reduce it.

**Mini project — "Event registration":** an `Event` with capacity, a `RegistrationForm` (name, email, ticket type, dietary notes, optional file for a student ID). Rules: email unique per event (constraint + friendly error), student tickets require the file (cross-field), registration closes when capacity is reached (check in `clean()`, enforce with `select_for_update` at save). Add an inline formset for "additional guests" (max 3) and tests for every validation path.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses) · [Ch 05 · Django Template Language](topic.html?p=05-templates) · [Ch 07 · The Django Admin](topic.html?p=07-django-admin) · [Ch 08 · Models & Fields](topic.html?p=08-models-fields) (`full_clean`, `null` vs `blank`) · [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) · [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views) (`FormView`, `CreateView.form_valid`) · [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files) · [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers) · [Ch 28 · Security](topic.html?p=28-security) (CSRF, XSS)

**Other handbooks:** [REST API · Validation & Input Sanitization](../rest-api/topic.html?p=17-validation-input-sanitization) · [REST API · Error Handling & Problem Details](../rest-api/topic.html?p=16-error-handling-problem-details) · [SQL · Keys & Constraints](../sql/topic.html?p=29-keys-constraints)

- **Working with forms** — Django docs · *Beginner* · the official walkthrough of forms, views and templates. <https://docs.djangoproject.com/en/5.2/topics/forms/>
- **Form and field validation** — Django docs · *Intermediate* · the authoritative description of the cleaning order used in this chapter. <https://docs.djangoproject.com/en/5.2/ref/forms/validation/>
- **Creating forms from models** — Django docs · *Intermediate* · ModelForm, `save()`, `commit=False` and model formsets. <https://docs.djangoproject.com/en/5.2/topics/forms/modelforms/>
- **Formsets** — Django docs · *Intermediate* · management form, `extra`, `can_delete`, `min_num`/`max_num`. <https://docs.djangoproject.com/en/5.2/topics/forms/formsets/>
- **File Uploads** — Django docs · *Intermediate* · upload handlers, memory vs temp files and limits. <https://docs.djangoproject.com/en/5.2/topics/http/file-uploads/>
- **Validators** — Django docs · *Beginner* · built-in validators and writing your own. <https://docs.djangoproject.com/en/5.2/ref/validators/>
- **django-crispy-forms** — GitHub · *Intermediate* · the most popular layout helper when hand-written templates get repetitive. <https://github.com/django-crispy-forms/django-crispy-forms>

---

*Django Handbook — chapter 06.*
