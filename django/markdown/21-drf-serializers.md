# 21 · DRF Serializers

> **In one line:** A serializer is the single, declarative boundary between untrusted JSON and your models — it converts in both directions, validates in a fixed and knowable order, and decides which fields can be written; mastering that order, `ModelSerializer`'s generated fields, nested writes and N+1 traps is most of what "knowing DRF" means in an interview.

---

## 1. Overview

> **Builds on:** [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) (the same validation pipeline idea), [Ch 08 · Models & Fields](topic.html?p=08-models-fields), [Ch 09 · Relationships](topic.html?p=09-relationships), [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization).

Every JSON API has to do the same three jobs on every request: turn a model instance (or a queryset of them) into JSON-safe primitives, turn incoming JSON back into Python values, and refuse anything that is malformed, out of range, or not allowed to be written by this client. The naive way is to do it by hand in the view: `json.loads(request.body)`, pick keys out of a dict, `int()` a few of them, write `if not data.get("title"): return JsonResponse({...}, status=400)`, and then build the response with a dict comprehension over `Book.objects.all()`.

That approach fails in predictable ways. Validation logic gets copy-pasted between the create view and the update view and drifts apart. Error formats differ endpoint by endpoint, so the frontend team writes a parser per screen. Someone adds `is_staff` to the model and the "update profile" endpoint happily writes it because it did `for k, v in data.items(): setattr(user, k, v)` — a **mass-assignment** vulnerability (OWASP API3). The list endpoint touches `book.author.name` in a loop and fires one query per row. And nothing is self-documenting, so there is no schema.

Django already solved the form version of this problem with `Form`/`ModelForm` ([Ch 06](topic.html?p=06-forms-validation)). Django REST Framework's **serializers** are the API equivalent, deliberately modelled on forms: declare fields, call `is_valid()`, read `validated_data`, call `save()`. A `ModelSerializer` is to `Serializer` what `ModelForm` is to `Form` — it introspects the model to generate fields, validators and default `create()`/`update()` implementations.

The difference from forms is that serializers are *bidirectional* and *nestable*. They render output (`to_representation`) as well as parse input (`to_internal_value`), and a serializer is itself a field, so you can nest them to represent relationships. That power is also where most production bugs come from: nested serializers that cause N+1 queries, nested writes that DRF refuses to do for you, and `SerializerMethodField`s that quietly hit the database once per object.

> **Why this matters:** In DRF interviews, "walk me through what happens when you call `is_valid()`" and "how do you write a nested serializer that can create children" are near-certain questions. They test whether you understand the framework or just copied a tutorial.

## 2. Core Concepts

- **`Serializer`** — a declarative class of fields with `to_representation` (instance → primitives) and `to_internal_value` (primitives → validated Python). *Why it matters:* it is the one place input is trusted, so every write must go through one.
- **`ModelSerializer`** — a `Serializer` that generates fields from `Meta.model` + `Meta.fields`, adds model-derived validators (`UniqueValidator`, `UniqueTogetherValidator`), and implements `create()`/`update()`. *Why:* removes boilerplate, but generated behaviour must be inspected (`print(repr(MySerializer()))`).
- **`initial_data` / `validated_data` / `data` / `errors`** — the raw input, the cleaned dict after `is_valid()`, the rendered output, and the error dict. *Why:* accessing them in the wrong order raises assertions DRF deliberately added.
- **Field-level validation** — `validate_<field_name>(self, value)` methods plus `validators=[...]` on a field. *Why:* runs per field, errors keyed by field name.
- **Object-level validation** — `validate(self, attrs)` for cross-field rules. *Why:* runs only after all fields individually passed.
- **Validators** — reusable callables (`UniqueValidator`, `UniqueTogetherValidator`, custom callables or classes with `requires_context = True`). *Why:* they can be attached to fields or `Meta.validators`.
- **`read_only` / `write_only` / `read_only_fields` / `extra_kwargs`** — control the direction a field participates in. *Why:* this is your mass-assignment defence.
- **`source`** — where a field reads from: `source="author.name"`, `source="get_status_display"`, `source="*"` (the whole object). *Why:* reshapes output without new methods.
- **`SerializerMethodField`** — read-only field computed by `get_<name>(self, obj)`. *Why:* flexible, but the most common source of hidden N+1 queries.
- **Relational fields** — `PrimaryKeyRelatedField`, `SlugRelatedField`, `StringRelatedField`, `HyperlinkedRelatedField`, or a nested serializer. *Why:* each has a different query cost and write story.
- **`ListSerializer`** — what you actually get when you pass `many=True`; it wraps a `child` serializer. *Why:* bulk update/create customisation goes on it via `Meta.list_serializer_class`.
- **`partial=True`** — skip "required" checks for absent fields (PATCH). *Why:* object-level `validate()` still runs, with only the provided keys in `attrs`.
- **`context`** — a dict (usually `{"request": ..., "view": ..., "format": ...}`) passed by generic views. *Why:* hyperlinked fields and `CurrentUserDefault` need `request`.
- **`HiddenField` + `CurrentUserDefault`** — inject server-side values (owner) that the client cannot set. *Why:* clean way to satisfy unique-together validators involving the user.

## 3. Theory & Principles

### Serializers are fields, fields are serializers

In DRF's design, `Serializer` subclasses `BaseSerializer`, which subclasses `Field`. A serializer declared with `SerializerMetaclass` collects its declared fields into `_declared_fields` (just as Django's `ModelBase` collects model fields). When you access `serializer.fields`, DRF calls `get_fields()` — for a plain `Serializer` that is a deep copy of the declared fields; for `ModelSerializer` it also runs `build_field()` for every name in `Meta.fields`, using `serializer_field_mapping` (e.g. `models.CharField → serializers.CharField`, `models.ForeignKey → PrimaryKeyRelatedField`) and `get_extra_kwargs()` to apply `max_length`, `required`, `allow_null`, `validators` and your `extra_kwargs`. Each field is then **bound** to the parent (`field.bind(field_name, parent)`), which is how a field knows its name, its `source_attrs`, and its root's `context`.

Because a serializer is a field, nesting is just composition: `author = AuthorSerializer()` on `BookSerializer` means "to represent `book.author`, call `AuthorSerializer.to_representation(book.author)`".

### The validation pipeline — the exact order

`is_valid()` calls `self.run_validation(self.initial_data)` and stores the result in `_validated_data` (or the caught `ValidationError.detail` in `_errors`). `Serializer.run_validation` does:

1. **`validate_empty_values(data)`** — handles `None` / empty for the serializer itself.
2. **`to_internal_value(data)`** — for every writable field, in declaration order:
   1. `primitive = field.get_value(data)` (reads the key, honours `partial` and HTML form quirks),
   2. `value = field.run_validation(primitive)` → the field's own `to_internal_value()` (type coercion: `"42"` → `42`) then `field.run_validators(value)` (`max_length`, `UniqueValidator`, your `validators=[...]`),
   3. if the serializer has `validate_<field_name>`, `value = validate_<field_name>(value)`.
   Errors are *collected* across all fields, then raised together as one `ValidationError({field: [...]})`.
3. **`run_validators(value)`** — serializer-level validators from `Meta.validators` (e.g. `UniqueTogetherValidator`).
4. **`validate(attrs)`** — your object-level hook; its return value becomes `validated_data`.

Consequence: if any field fails in step 2, steps 3 and 4 never run. So `validate()` can safely assume every field is individually valid — and you will not see cross-field errors until field errors are fixed.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj21a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj21b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">serializer.is_valid(): the validation pipeline</text>
  <rect x="20" y="50" width="120" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="80" y="72" text-anchor="middle" fill="#1e293b">initial_data</text>
  <text x="80" y="88" text-anchor="middle" fill="#334155" font-size="9">request.data (dict)</text>
  <path d="M140,75 L170,75" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21a)"/>
  <rect x="172" y="40" width="330" height="140" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="337" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">1. to_internal_value(data): per field, in order</text>
  <rect x="186" y="70" width="96" height="44" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="234" y="88" text-anchor="middle" fill="#1e293b" font-size="10">field.get_value</text>
  <text x="234" y="103" text-anchor="middle" fill="#334155" font-size="9">read key / partial</text>
  <path d="M282,92 L292,92" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21a)"/>
  <rect x="294" y="70" width="96" height="44" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="342" y="88" text-anchor="middle" fill="#1e293b" font-size="10">run_validation</text>
  <text x="342" y="103" text-anchor="middle" fill="#334155" font-size="9">coerce + validators</text>
  <path d="M390,92 L400,92" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21a)"/>
  <rect x="402" y="70" width="92" height="44" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="448" y="88" text-anchor="middle" fill="#1e293b" font-size="10">validate_x()</text>
  <text x="448" y="103" text-anchor="middle" fill="#334155" font-size="9">your field hook</text>
  <text x="337" y="140" text-anchor="middle" fill="#334155" font-size="10">errors from ALL fields are collected,</text>
  <text x="337" y="156" text-anchor="middle" fill="#334155" font-size="10">then raised together as {field: [msgs]}</text>
  <path d="M502,110 L532,110" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21a)"/>
  <rect x="534" y="80" width="150" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="609" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">2. run_validators</text>
  <text x="609" y="120" text-anchor="middle" fill="#334155" font-size="9">Meta.validators</text>
  <text x="609" y="133" text-anchor="middle" fill="#334155" font-size="9">UniqueTogetherValidator</text>
  <path d="M684,110 L714,110" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21a)"/>
  <rect x="716" y="80" width="146" height="60" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="789" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">3. validate(attrs)</text>
  <text x="789" y="120" text-anchor="middle" fill="#334155" font-size="9">cross-field rules</text>
  <text x="789" y="133" text-anchor="middle" fill="#334155" font-size="9">returns validated_data</text>
  <path d="M337,180 L337,226" stroke="#dc2626" stroke-width="2" marker-end="url(#dj21b)"/>
  <path d="M609,140 L609,226" stroke="#dc2626" stroke-width="2" marker-end="url(#dj21b)"/>
  <path d="M789,140 L789,226" stroke="#dc2626" stroke-width="2" marker-end="url(#dj21b)"/>
  <rect x="200" y="228" width="660" height="40" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="530" y="246" text-anchor="middle" fill="#1e293b">ValidationError at any stage: stop, store in serializer.errors, is_valid() returns False</text>
  <text x="530" y="261" text-anchor="middle" fill="#334155" font-size="9">raise_exception=True re-raises it; the view's exception handler turns it into HTTP 400</text>
  <rect x="20" y="284" width="840" height="34" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="305" text-anchor="middle" fill="#1e293b">Not in the pipeline: Model.clean() and Model.full_clean(). ModelSerializer only runs field-level and unique validators.</text>
</svg>
```

### What `ModelSerializer` does and does not validate

`ModelSerializer` copies model field constraints into serializer field arguments: `max_length`, `max_digits`/`decimal_places`, `choices`, `null → allow_null`, `blank → allow_blank`, `default`/`blank → required=False`, model field `validators`, and `unique=True → UniqueValidator(queryset=Model.objects.all())`. From `Meta.unique_together` (and, in recent DRF releases, simple `UniqueConstraint`s) it builds `UniqueTogetherValidator`s. What it does **not** do is call `Model.clean()` or `full_clean()`. This was a deliberate DRF 3 decision: validation lives in the serializer, explicitly. If your invariants live in `Model.clean()`, either duplicate them into `validate()` or call `full_clean()` yourself (and translate `django.core.exceptions.ValidationError` into DRF's).

Unique validators are also **not race-free**: `UniqueValidator` does a `SELECT ... WHERE email = %s` before the insert. Two concurrent requests both pass and one hits `IntegrityError` at the database. The database constraint is the real guarantee; the validator only provides a nice error message in the common case.

### Saving: `save()` dispatches to `create()` or `update()`

`serializer.save(**kwargs)` asserts `is_valid()` was called and there are no errors, merges `kwargs` into `validated_data` (this is how `serializer.save(owner=request.user)` works), then calls `self.update(self.instance, validated_data)` if an instance was passed to the constructor, else `self.create(validated_data)`. It stores the result in `self.instance`. `ModelSerializer.create()` pops many-to-many fields, does `Model._default_manager.create(**validated_data)`, then sets the M2M relations. If `validated_data` contains a nested dict/list from a nested serializer, `create()` raises an assertion — DRF refuses to guess how to write nested objects (`raise_errors_on_nested_writes`).

### Representation: `to_representation`

On `serializer.data`, DRF calls `to_representation(instance)`: for each readable field, `attribute = field.get_attribute(instance)` (walks `source_attrs`, e.g. `instance.author.name` — which triggers the FK descriptor and potentially a query), then `field.to_representation(attribute)`. Results are collected into a `ReturnDict` (or `ReturnList` for `many=True`) that remembers its serializer for the browsable API. This is the phase where N+1 queries happen, because attribute access on unprefetched relations goes to the database per object.

## 4. Architecture & Workflow

### The two directions

The same class runs two opposite pipelines; keep them separate in your head, because their costs live in different places.

```svg
<svg viewBox="0 0 880 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj21c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="dj21d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Serializer: deserialize (write path) vs serialize (read path)</text>
  <text x="440" y="48" text-anchor="middle" fill="#16a34a" font-weight="bold">WRITE: POST / PUT / PATCH</text>
  <rect x="20" y="60" width="130" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="85" y="82" text-anchor="middle" fill="#1e293b">JSON body</text>
  <text x="85" y="98" text-anchor="middle" fill="#334155" font-size="9">parsed by JSONParser</text>
  <path d="M150,85 L190,85" stroke="#16a34a" stroke-width="2" marker-end="url(#dj21c)"/>
  <rect x="192" y="60" width="150" height="50" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="267" y="82" text-anchor="middle" fill="#1e293b">is_valid()</text>
  <text x="267" y="98" text-anchor="middle" fill="#334155" font-size="9">to_internal_value + validate</text>
  <path d="M342,85 L382,85" stroke="#16a34a" stroke-width="2" marker-end="url(#dj21c)"/>
  <rect x="384" y="60" width="140" height="50" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="454" y="82" text-anchor="middle" fill="#1e293b">validated_data</text>
  <text x="454" y="98" text-anchor="middle" fill="#334155" font-size="9">Python values, safe</text>
  <path d="M524,85 L564,85" stroke="#16a34a" stroke-width="2" marker-end="url(#dj21c)"/>
  <rect x="566" y="60" width="140" height="50" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="636" y="82" text-anchor="middle" fill="#1e293b">save(**kwargs)</text>
  <text x="636" y="98" text-anchor="middle" fill="#334155" font-size="9">create() or update()</text>
  <path d="M706,85 L746,85" stroke="#16a34a" stroke-width="2" marker-end="url(#dj21c)"/>
  <rect x="748" y="60" width="112" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="804" y="82" text-anchor="middle" fill="#1e293b">Model row</text>
  <text x="804" y="98" text-anchor="middle" fill="#334155" font-size="9">INSERT / UPDATE</text>
  <text x="440" y="160" text-anchor="middle" fill="#2563eb" font-weight="bold">READ: GET (and the response after a write)</text>
  <rect x="748" y="172" width="112" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="804" y="194" text-anchor="middle" fill="#1e293b">instance / qs</text>
  <text x="804" y="210" text-anchor="middle" fill="#334155" font-size="9">prefetched!</text>
  <path d="M748,197 L708,197" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21d)"/>
  <rect x="526" y="172" width="180" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="616" y="194" text-anchor="middle" fill="#1e293b">field.get_attribute(obj)</text>
  <text x="616" y="210" text-anchor="middle" fill="#334155" font-size="9">walks source: obj.author.name</text>
  <path d="M526,197 L486,197" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21d)"/>
  <rect x="306" y="172" width="178" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="395" y="194" text-anchor="middle" fill="#1e293b">field.to_representation</text>
  <text x="395" y="210" text-anchor="middle" fill="#334155" font-size="9">date to ISO string, Decimal...</text>
  <path d="M306,197 L266,197" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21d)"/>
  <rect x="116" y="172" width="148" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="190" y="194" text-anchor="middle" fill="#1e293b">serializer.data</text>
  <text x="190" y="210" text-anchor="middle" fill="#334155" font-size="9">ReturnDict / ReturnList</text>
  <path d="M116,197 L76,197" stroke="#2563eb" stroke-width="2" marker-end="url(#dj21d)"/>
  <rect x="10" y="172" width="64" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="42" y="201" text-anchor="middle" fill="#1e293b">JSON</text>
  <rect x="20" y="240" width="840" height="46" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="259" text-anchor="middle" fill="#1e293b">Read path cost = 1 query for the queryset + (per row x per unprefetched relation or SerializerMethodField query)</text>
  <text x="440" y="276" text-anchor="middle" fill="#334155" font-size="10">fix in the VIEW: get_queryset().select_related(...).prefetch_related(...), not inside the serializer</text>
</svg>
```

### Who calls what in a generic view

```text
CreateAPIView.post(request)
  └─ CreateModelMixin.create()
       serializer = self.get_serializer(data=request.data)     # context = {request, view, format}
       serializer.is_valid(raise_exception=True)               # → 400 via exception handler
       self.perform_create(serializer)                         # → serializer.save()  (override to pass owner=)
       headers = self.get_success_headers(serializer.data)
       return Response(serializer.data, status=201)            # read path runs on the saved instance

UpdateAPIView.patch(request, pk)
  └─ UpdateModelMixin.partial_update() → update(partial=True)
       instance = self.get_object()                            # object permissions checked here
       serializer = self.get_serializer(instance, data=request.data, partial=True)
       serializer.is_valid(raise_exception=True)
       self.perform_update(serializer)                         # → serializer.save() → update(instance, data)
```

Views are covered in [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers); for now the important part is that the view owns the queryset (and therefore query optimisation) and the serializer owns shape and validation.

## 5. Implementation

### Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "djangorestframework>=3.15"
django-admin startproject config . && python manage.py startapp library
```

```python
# library/models.py
from django.conf import settings
from django.db import models


class Author(models.Model):
    name = models.CharField(max_length=120)
    email = models.EmailField(unique=True)


class Tag(models.Model):
    name = models.SlugField(unique=True)


class Book(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft"
        PUBLISHED = "published"

    title = models.CharField(max_length=200)
    author = models.ForeignKey(Author, on_delete=models.PROTECT, related_name="books")
    tags = models.ManyToManyField(Tag, blank=True, related_name="books")
    price = models.DecimalField(max_digits=8, decimal_places=2)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    published_on = models.DateField(null=True, blank=True)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["author", "title"], name="uniq_author_title"),
        ]
```

### Simple example: a plain `Serializer`

```python
# library/serializers.py
from rest_framework import serializers


class ContactSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    email = serializers.EmailField()
    message = serializers.CharField(min_length=10)
    urgent = serializers.BooleanField(default=False)

    def validate_name(self, value):                 # field-level hook
        return value.strip().title()

    def validate(self, attrs):                      # object-level hook
        if attrs["urgent"] and "refund" not in attrs["message"].lower():
            raise serializers.ValidationError("Urgent is reserved for refund requests.")
        return attrs
```

Running it in a shell shows the error format and the ordering:

```python
>>> s = ContactSerializer(data={"name": "  ada lovelace ", "email": "not-an-email", "message": "hi"})
>>> s.is_valid()
False
>>> s.errors
{'email': [ErrorDetail(string='Enter a valid email address.', code='invalid')],
 'message': [ErrorDetail(string='Ensure this field has at least 10 characters.', code='min_length')]}
>>> # validate() did NOT run — field errors short-circuit it
>>> s = ContactSerializer(data={"name": " ada ", "email": "a@b.co", "message": "please refund me", "urgent": True})
>>> s.is_valid(), s.validated_data
(True, {'name': 'Ada', 'email': 'a@b.co', 'message': 'please refund me', 'urgent': True})
```

Non-field errors from `validate()` appear under the key `non_field_errors` (configurable with `NON_FIELD_ERRORS_KEY`). Raise `ValidationError({"field": "msg"})` from `validate()` to attach a cross-field error to a specific field instead.

### `ModelSerializer` and inspecting what it generated

```python
class TagSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ["id", "name"]


class BookSerializer(serializers.ModelSerializer):
    owner = serializers.HiddenField(default=serializers.CurrentUserDefault())
    author_name = serializers.CharField(source="author.name", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = Book
        fields = ["id", "title", "author", "author_name", "tags", "price",
                  "status", "status_label", "published_on", "owner"]
        read_only_fields = ["status"]          # status changes via a dedicated action only
        extra_kwargs = {"price": {"min_value": 0}}

    def validate(self, attrs):
        # On PATCH, attrs only has submitted keys — fall back to the instance.
        status = attrs.get("status", getattr(self.instance, "status", None))
        published_on = attrs.get("published_on", getattr(self.instance, "published_on", None))
        if status == Book.Status.PUBLISHED and published_on is None:
            raise serializers.ValidationError({"published_on": "Required when published."})
        return attrs
```

Always print the generated serializer once; it is the fastest way to see what DRF inferred:

```text
>>> print(repr(BookSerializer()))
BookSerializer():
    id = IntegerField(label='ID', read_only=True)
    title = CharField(max_length=200)
    author = PrimaryKeyRelatedField(queryset=Author.objects.all())
    author_name = CharField(read_only=True, source='author.name')
    tags = PrimaryKeyRelatedField(allow_empty=False, many=True, queryset=Tag.objects.all(), required=False)
    price = DecimalField(decimal_places=2, max_digits=8, min_value=0)
    status = ChoiceField(choices=[('draft', 'Draft'), ('published', 'Published')], read_only=True)
    ...
    owner = HiddenField(default=CurrentUserDefault())
    class Meta:
        validators = [<UniqueTogetherValidator(queryset=Book.objects.all(), fields=('author', 'title'))>]
```

Note the `UniqueTogetherValidator` derived from the constraint (exact output varies a little by DRF version). It requires every field it names to be present in input, which is why `HiddenField` is the idiomatic way to include `owner` in such a validator: the client cannot send it, but the validator still sees it.

> **Gotcha:** `fields = "__all__"` silently exposes every new column you add later — including `is_internal`, `cost_price`, or `password`. Prefer an explicit list. DRF requires you to set `fields` or `exclude`; it raises an `ImproperlyConfigured` otherwise.

### Validators: field, reusable, and context-aware

```python
from rest_framework.validators import UniqueValidator


def no_profanity(value):
    if "darn" in value.lower():
        raise serializers.ValidationError("Keep it clean.")


class NotInPast:
    requires_context = True                     # receives the field as 2nd arg

    def __call__(self, value, serializer_field):
        from django.utils import timezone
        if value and value < timezone.localdate():
            raise serializers.ValidationError("Date cannot be in the past.")


class AuthorSerializer(serializers.ModelSerializer):
    email = serializers.EmailField(
        validators=[UniqueValidator(queryset=Author.objects.all(), lookup="iexact")]
    )
    name = serializers.CharField(max_length=120, validators=[no_profanity])

    class Meta:
        model = Author
        fields = ["id", "name", "email"]
```

Declaring `email` explicitly replaces the auto-generated field, so you must restate `UniqueValidator` yourself — a frequent source of "why did uniqueness stop being validated?" bugs.

### Real-world example: writable nested serializer with an order and line items

The interview classic: "accept an order with its line items in one POST, and update them in a PUT." DRF will not do this automatically; you override `create()` and `update()` and wrap them in a transaction ([Ch 14 · Transactions](topic.html?p=14-transactions-concurrency)).

```python
# shop/models.py
class Order(models.Model):
    customer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    note = models.CharField(max_length=200, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)


class OrderItem(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    sku = models.CharField(max_length=40)
    quantity = models.PositiveIntegerField()
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["order", "sku"], name="uniq_order_sku")]
```

```python
# shop/serializers.py
from django.db import transaction
from rest_framework import serializers

from .models import Order, OrderItem


class OrderItemSerializer(serializers.ModelSerializer):
    id = serializers.IntegerField(required=False)          # writable so updates can match rows

    class Meta:
        model = OrderItem
        fields = ["id", "sku", "quantity", "unit_price"]
        extra_kwargs = {"quantity": {"min_value": 1}}


class OrderSerializer(serializers.ModelSerializer):
    customer = serializers.HiddenField(default=serializers.CurrentUserDefault())
    items = OrderItemSerializer(many=True)
    total = serializers.SerializerMethodField()

    class Meta:
        model = Order
        fields = ["id", "customer", "note", "items", "total", "created_at"]
        read_only_fields = ["created_at"]

    def get_total(self, obj):
        # Uses the prefetched items — no extra query if the view prefetched them.
        return str(sum(i.quantity * i.unit_price for i in obj.items.all()))

    def validate_items(self, items):
        if not items:
            raise serializers.ValidationError("An order needs at least one item.")
        skus = [i["sku"] for i in items]
        if len(skus) != len(set(skus)):
            raise serializers.ValidationError("Duplicate SKU in items.")
        return items

    @transaction.atomic
    def create(self, validated_data):
        items = validated_data.pop("items")
        order = Order.objects.create(**validated_data)
        OrderItem.objects.bulk_create(
            [OrderItem(order=order, **{k: v for k, v in item.items() if k != "id"}) for item in items]
        )
        return order

    @transaction.atomic
    def update(self, instance, validated_data):
        items = validated_data.pop("items", None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if items is not None:                                # PATCH without items: leave them alone
            existing = {i.id: i for i in instance.items.all()}
            keep_ids = []
            for item in items:
                item_id = item.pop("id", None)
                if item_id is not None:
                    if item_id not in existing:              # never let a client touch another order's row
                        raise serializers.ValidationError({"items": f"Unknown item id {item_id}."})
                    row = existing[item_id]
                    for attr, value in item.items():
                        setattr(row, attr, value)
                    row.save()
                    keep_ids.append(item_id)
                else:
                    keep_ids.append(OrderItem.objects.create(order=instance, **item).id)
            instance.items.exclude(id__in=keep_ids).delete()  # PUT semantics: replace the set
        return instance
```

The SQL a create produces (PostgreSQL) is exactly three statements inside one transaction:

```sql
BEGIN;
INSERT INTO "shop_order" ("customer_id", "note", "created_at") VALUES (7, 'gift', '2026-10-25T10:00:00Z') RETURNING "id";
INSERT INTO "shop_orderitem" ("order_id", "sku", "quantity", "unit_price")
  VALUES (42, 'BK-1', 2, 19.99), (42, 'BK-2', 1, 5.00) RETURNING "id";
COMMIT;
```

But the 201 response renders `serializer.data` on the new instance: `items` and `get_total` each do `order.items.all()`, i.e. **two** extra SELECTs (no prefetch cache on a freshly created object). That is fine for one object. On the list endpoint it would be per row — so the view must prefetch:

```python
class OrderViewSet(viewsets.ModelViewSet):
    serializer_class = OrderSerializer

    def get_queryset(self):
        return (Order.objects.filter(customer=self.request.user)
                .prefetch_related("items")
                .order_by("-created_at"))
```

```sql
SELECT ... FROM "shop_order" WHERE "shop_order"."customer_id" = 7 ORDER BY "created_at" DESC LIMIT 20;
SELECT ... FROM "shop_orderitem" WHERE "shop_orderitem"."order_id" IN (42, 41, 40, ...);
```

Two queries for any page size instead of 1 + 2N.

### Read and write with different shapes

A common pattern: accept a PK on write, return a nested object on read.

```python
class BookReadSerializer(serializers.ModelSerializer):
    author = AuthorSerializer(read_only=True)
    tags = serializers.SlugRelatedField(slug_field="name", many=True, read_only=True)

    class Meta:
        model = Book
        fields = ["id", "title", "author", "tags", "price"]


class BookWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Book
        fields = ["title", "author", "tags", "price"]

    def to_representation(self, instance):
        # respond with the rich shape after a write
        return BookReadSerializer(instance, context=self.context).data
```

Alternatively override `get_serializer_class()` in the viewset by `self.action`. Overriding `to_representation` is also how you rename keys, drop `None` values or add envelope data:

```python
    def to_representation(self, instance):
        data = super().to_representation(instance)
        return {k: v for k, v in data.items() if v is not None}
```

### Bulk writes with `ListSerializer`

```python
class BulkTagListSerializer(serializers.ListSerializer):
    def create(self, validated_data):
        return Tag.objects.bulk_create([Tag(**item) for item in validated_data])


class BulkTagSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ["id", "name"]
        list_serializer_class = BulkTagListSerializer

# view: s = BulkTagSerializer(data=request.data, many=True); s.is_valid(raise_exception=True); s.save()
```

Without this, `ListSerializer.create` calls `child.create()` once per item — one INSERT each. Note that `UniqueValidator` on `name` still runs one SELECT per item during validation.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Pros | Cons | Use when |
|---|---|---|---|
| `Serializer` | Explicit, not tied to a model, full control | You write every field and `create/update` | Input that is not a model (login, search, RPC-ish actions) |
| `ModelSerializer` | Little code, validators from model, default create/update | Hidden behaviour, `__all__` leaks, no `Model.clean()` | CRUD on a model |
| `HyperlinkedModelSerializer` | HATEOAS-style URLs | Needs `request` in context, URL reversing cost | Public, browsable APIs |
| Nested read serializer | One round-trip for client | N+1 unless prefetched; bigger payloads | Detail views, small lists |
| PK / Slug related field | Cheap, simple writes | Client needs a second call for details | Write paths, large lists |
| `SerializerMethodField` | Arbitrary computed output | Read-only; per-object code, query traps | Derived values from prefetched data or annotations |
| Writable nested (custom create/update) | One atomic request for aggregate | You own matching, deletes, permissions | Aggregates (order + items) |
| Separate endpoints for children | Simple, RESTful, cacheable | More requests, partial states | Independently managed children |

### When to use
- Use `ModelSerializer` for straightforward model CRUD, with an explicit `fields` list and `read_only_fields`.
- Use a plain `Serializer` for actions and inputs that do not map onto one model (password change, checkout request, filters).
- Use separate read/write serializers when input and output shapes legitimately differ.

### When NOT to use
- Not for hot, read-only endpoints returning thousands of rows where serializer overhead dominates — use `.values()` plus a lightweight dict build, or annotate in SQL and use a thin serializer.
- Not as a place to fetch data: queries belong in the view's `get_queryset()`.
- Not for business workflows with side effects (sending emails, charging cards) hidden in `create()` — put those in a service function the serializer or view calls explicitly, dispatched with `transaction.on_commit`.

## 7. Common Mistakes & Best Practices

**1. `fields = "__all__"` on write serializers.** What people do: it's quick. Why it hurts: mass assignment — a new `is_verified` column becomes client-writable the day it ships. Instead: explicit `fields`, `read_only_fields`, and a test that asserts the field list.

**2. Expecting `Model.clean()` to run.** Your invariant in `clean()` is bypassed by the API. Instead: put rules in `validate()` (or a model method both call), and keep a DB `CheckConstraint` as the backstop.

**3. Forgetting `partial` in `validate()`.** On PATCH, `attrs["status"]` raises `KeyError`. Instead: `attrs.get("status", getattr(self.instance, "status", None))`.

**4. Querying inside `SerializerMethodField`.**

```python
# before: 1 query per book
def get_review_count(self, obj):
    return obj.reviews.count()

# after: annotate in the view, read the attribute
# view: Book.objects.annotate(review_count=Count("reviews"))
review_count = serializers.IntegerField(read_only=True)
```

**5. Nesting serializers without prefetching.** The serializer cannot prefetch for you; the view must `select_related` (FK/O2O) and `prefetch_related` (reverse FK/M2M). Assert with `assertNumQueries` in tests.

**6. Calling `.save()` after accessing `.data`.** DRF raises an assertion; if you need the output, call `save()` first, then read `.data`.

**7. Passing `request.data` straight to `Model.objects.create(**request.data)`.** That is the naive approach the serializer exists to prevent. Always go through `validated_data`.

**8. Re-declaring a field and losing its validator.** Explicit `email = serializers.EmailField()` drops the generated `UniqueValidator`. Restate it, or tweak via `extra_kwargs` instead of redeclaring.

**9. Trusting nested `id`s on update.** Matching child rows by client-supplied `id` without scoping to the parent lets a client modify another user's rows. Always resolve ids against `instance.items`.

**Best practices:** keep serializers thin and declarative; one serializer per direction when shapes differ; push heavy logic to services; use `HiddenField(default=CurrentUserDefault())` or `serializer.save(owner=...)` for server-set fields; use `raise_exception=True` everywhere; write a query-count test for every list endpoint.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: list endpoint gets slower as data grows.** Symptom: p95 latency of `/api/books/` climbs from 80 ms to 2 s. Root cause: `AuthorSerializer` nested plus `tags` — `1 + 2N` queries per page. Fix: `select_related("author").prefetch_related("tags")` in `get_queryset`, and a regression test:

```python
def test_book_list_query_count(self):
    BookFactory.create_batch(30)
    with self.assertNumQueries(3):   # COUNT for pagination, books+authors JOIN, tags prefetch
        self.client.get("/api/books/")
```

**Pitfall: write validation does N queries.** `tags = PrimaryKeyRelatedField(many=True, queryset=Tag.objects.all())` validates each pk with its own `queryset.get(pk=...)`. A POST with 500 tag ids is 500 SELECTs. Fix: accept a `ListField(child=IntegerField())`, then one `Tag.objects.filter(pk__in=ids)` and compare counts in `validate_tags`.

**Pitfall: `IntegrityError` → 500 despite `UniqueValidator`.** Two concurrent sign-ups pass the SELECT check. Fix: keep the DB constraint, catch `IntegrityError` in `perform_create` and raise `ValidationError`, or rely on a custom exception handler mapping it to 409/400.

**Pitfall: CPU-bound serialization.** DRF serializers are pure Python and do per-field work for each object; serializing tens of thousands of objects is CPU-heavy. Symptoms: high CPU on API pods with low DB time in your APM. Fixes: paginate ([Ch 24](topic.html?p=24-drf-pagination-filtering-versioning)); for internal exports use `.values()`/`.values_list()` and stream; cache rendered payloads ([Ch 29 · Caching](topic.html?p=29-caching)); avoid `HyperlinkedRelatedField` on large lists (a `reverse()` per link).

**Pitfall: huge `DecimalField` strings vs floats.** DRF renders `DecimalField` as a string by default (`COERCE_DECIMAL_TO_STRING=True`) to avoid precision loss — frontends that expect a number break. Decide once, document in the schema.

**Debugging toolkit.**
- `print(repr(MySerializer()))` — see generated fields and validators.
- `serializer.errors` in a shell with real payloads; `ErrorDetail.code` for machine-readable codes.
- `django-debug-toolbar` on the browsable API, or `from django.db import connection; len(connection.queries)` with `DEBUG=True`.
- Sentry or logs for `AssertionError` from nested writes — usually a missing `create()` override.

**Scaling notes.** The serializer is rarely the bottleneck until queries are fixed; once they are, look at payload size (sparse fieldsets via a `fields` query param, or a dynamic-fields serializer) and at caching. Keep response shapes stable — changing a serializer is changing a public contract ([REST API · Backward Compatibility](../rest-api/topic.html?p=32-backward-compatibility-deprecation)).

## 9. Interview Questions

**Q: What is the difference between `Serializer` and `ModelSerializer`?**
A: Both are bidirectional converters with the same validation pipeline. `Serializer` requires you to declare every field and implement `create()`/`update()` yourself. `ModelSerializer` introspects `Meta.model` to generate fields with matching types and constraints (`max_length`, `choices`, `allow_null`), adds `UniqueValidator`/`UniqueTogetherValidator` from model uniqueness, and provides default `create()`/`update()` that handle M2M fields. It is the `ModelForm` analogue. It does not call `Model.clean()`, and it refuses nested writes by default.

**Q: Walk me through what happens when you call `serializer.is_valid()`?**
A: It runs `run_validation(initial_data)`. First `to_internal_value` iterates writable fields: each field reads its value, coerces it via its own `to_internal_value`, runs its validators, then the serializer's `validate_<field>` method runs if defined. Errors from all fields are collected and raised together. Then serializer-level `Meta.validators` run (e.g. `UniqueTogetherValidator`), then `validate(attrs)`. The result is stored as `validated_data`; on failure, `errors` is populated and `is_valid()` returns False (or raises with `raise_exception=True`, which views turn into a 400).

**Q: Does `validate()` run if a field fails validation?**
A: No. Field errors are raised from `to_internal_value` before serializer-level validators and `validate()` execute. That is useful — `validate()` can assume each field is individually valid — but it also means clients see cross-field errors only after fixing field errors. If you need both reported at once, do the cross-field check in a field validator with access to `self.initial_data`, though that is rarely worth it.

**Q: Does `ModelSerializer` call the model's `clean()` method?**
A: No. DRF 3 moved away from that deliberately; validation is the serializer's job and `Model.clean()`/`full_clean()` are not called. It does use the model field validators and uniqueness. If you rely on `clean()`, call `instance.full_clean()` in `validate()` (on a temp instance) and convert `django.core.exceptions.ValidationError` to `serializers.ValidationError`, or move the rule into a shared function.

**Q: How do you write a nested serializer that can create related objects?**
A: Declare the child serializer (`items = ItemSerializer(many=True)`), then override `create()` to pop `items` from `validated_data`, create the parent, and create the children with the parent FK — ideally with `bulk_create` and inside `transaction.atomic()`. For `update()` you must decide semantics: replace the whole set, upsert by id, or reject children on update. Default `ModelSerializer.create()` raises an assertion for nested data precisely because these choices are domain-specific. Scope any child ids to the parent to avoid touching other users' rows.

**Q: What is `SerializerMethodField` and what is the risk?**
A: It is a read-only field whose value is returned by `get_<name>(self, obj)`. It is handy for derived values, but it runs once per object, so any query inside it (`obj.reviews.count()`) becomes an N+1. Prefer annotating in the view's queryset and exposing the annotation as a plain read-only field, or compute from prefetched data (`obj.items.all()` hitting the prefetch cache).

**Q: How do you make a field read-only or write-only?**
A: `read_only=True` / `write_only=True` on a declared field, or `Meta.read_only_fields = [...]` and `extra_kwargs = {"password": {"write_only": True}}` for generated fields. Read-only fields are ignored on input (silently, not an error), write-only fields are omitted from output. `read_only_fields` does not apply to fields you declare explicitly — you must pass `read_only=True` on them. This is how you prevent mass assignment of fields like `is_staff` or `owner`.

**Q: How do you set the current user as the owner when creating an object?**
A: Either `serializer.save(owner=self.request.user)` in the view's `perform_create`, which merges into `validated_data`, or `owner = serializers.HiddenField(default=serializers.CurrentUserDefault())` on the serializer. `HiddenField` is preferable when `owner` participates in a `UniqueTogetherValidator`, because the validator needs the value present during validation, while `save(owner=...)` only adds it afterwards. Both require `request` in the serializer context (generic views supply it).

**Q: What does `partial=True` change?**
A: Required fields that are absent from the input are not errors, and only submitted keys appear in `validated_data`. Field validators still run on submitted fields, and `validate()` still runs — so it must handle missing keys by falling back to `self.instance`. Generic views set it for PATCH via `partial_update`.

**Q: How do serializers relate to the N+1 problem, and where should you fix it?**
A: Rendering walks `source` attributes on each object, so nested serializers, `source="author.name"` and related fields trigger a lazy-load query per row unless the data is already loaded. The serializer cannot fix this; the view must `select_related` forward FKs and `prefetch_related` reverse FKs/M2M (with `Prefetch` objects for filtered relations). Lock it in with `assertNumQueries`. Some teams add a `setup_eager_loading` classmethod on the serializer that the view calls, keeping the knowledge next to the fields.

**Q: Your unique email validator passes but you still get `IntegrityError` in production. Why, and how do you fix it? (Senior)**
A: `UniqueValidator` is a check-then-act SELECT before INSERT, so two concurrent requests both see "no row" and both insert; the database unique index rejects the second. That is a race, not a bug in DRF. The constraint must stay as the source of truth. Handle the `IntegrityError` (in `perform_create` or a custom exception handler) and translate it into a 400/409 with the same error shape; optionally normalise emails (lowercase) before both the check and the insert, and use a case-insensitive unique constraint (`UniqueConstraint(Lower("email"), ...)`) so the validator and DB agree.

**Q: How would you design serializers for an aggregate like Order + OrderItems that supports create, full replace and partial update? (Senior)**
A: Use a writable nested `items` serializer with an optional writable `id`. In `create()`, pop items, create the order, `bulk_create` items, all inside `transaction.atomic()`. In `update()`, apply scalar fields, then if `items` is present: load existing items scoped to the order, update matched ids, create new ones, delete missing ones (PUT semantics), and reject unknown ids. Validate invariants (non-empty, unique SKU, stock availability) in `validate_items`/`validate`, and keep DB constraints as backstops. Push side effects (stock reservation events, emails) to `transaction.on_commit`. If business rules grow, move the write into a service function and keep the serializer as an input validator only.

**Q: A list endpoint serializing 5,000 objects spends most of its time in Python, not the DB. What do you do? (Senior)**
A: First confirm with profiling (py-spy, APM spans) that time is in `to_representation`. Then reduce the work: paginate, trim fields (sparse fieldsets), avoid hyperlinked fields and `SerializerMethodField`s that compute per object, move computation into SQL annotations. For read-only bulk endpoints, bypass `ModelSerializer` with `.values(...)` and a hand-built dict or a minimal `Serializer` with plain fields; cache the rendered response keyed by a version/updated_at; and consider streaming exports via a background job instead of a request. Measure each step; serializer overhead is per-field-per-object, so fewer fields times fewer objects is the lever.

**Q: How do you implement bulk create or bulk update with DRF? (Senior)**
A: Pass `many=True`, which yields a `ListSerializer`. Its default `create()` loops `child.create()` (one INSERT each) and it has no default `update()` because matching instances to items is ambiguous. Set `Meta.list_serializer_class` to a subclass that implements `create()` with `bulk_create` and `update()` by mapping ids to instances and using `bulk_update` with explicit fields. Watch validation cost too — per-item `UniqueValidator` and `PrimaryKeyRelatedField` each query — and validate in bulk in `validate()` instead. Remember `bulk_create`/`bulk_update` skip `save()` and signals.

**Q: When would you override `to_representation` versus `to_internal_value`?**
A: Override `to_representation` to change output shape globally for that serializer: renaming keys, removing nulls, embedding a richer read serializer after a write, adding computed envelopes. Override `to_internal_value` to accept an input format that does not match fields one-to-one — e.g. accepting a legacy flat payload and reshaping it before validation — calling `super()` with the normalised dict. Keep both small; heavy logic there is hard to test and invisible in the schema.

## 10. Quick Revision & Cheat Sheet

| Thing | Remember |
|---|---|
| Validation order | field `to_internal_value` → field validators → `validate_<f>` → `Meta.validators` → `validate()` |
| Short-circuit | any field error ⇒ `validate()` does not run |
| `save()` | asserts valid; `save(**kw)` merges into `validated_data`; `create` vs `update` by `instance` |
| ModelSerializer | generates fields + unique validators; no `Model.clean()`; nested writes need overrides |
| `read_only_fields` | only affects generated fields, not declared ones |
| `partial=True` | absent fields OK; `validate()` still runs |
| `SerializerMethodField` | read-only; per-object; N+1 risk |
| N+1 fix | in the view's `get_queryset` (`select_related`/`prefetch_related`) |
| Bulk | `many=True` → `ListSerializer`; customise via `list_serializer_class` |
| Server-set fields | `HiddenField(default=CurrentUserDefault())` or `save(owner=...)` |

- Never `fields = "__all__"` on a write serializer.
- `validated_data` is the only trusted input.
- Errors are a dict keyed by field; `non_field_errors` for `validate()`.
- Unique validators are not race-free; the DB constraint is the guarantee.
- `.data` before `.save()` is an assertion error.
- Decimal renders as a string by default.
- Explicitly declared fields lose auto-generated validators.
- Wrap nested writes in `transaction.atomic()`.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "djangorestframework>=3.15" django-debug-toolbar
```

1. **Validation order probe.** Write a serializer whose field validator, `validate_x`, `Meta.validators` and `validate()` each `print()` their name. Submit valid and invalid payloads and record which hooks run.
2. **Inspect generation.** Create the `Book` model above and `print(repr(BookSerializer()))`. Change `null`, `blank`, `default` and `unique` on fields and observe how `required`, `allow_null` and validators change.
3. **N+1 hunt.** Build a `BookViewSet` with a nested `AuthorSerializer` and a `SerializerMethodField` counting reviews. Seed 50 books, count queries, then fix with `select_related` + `annotate` and assert with `assertNumQueries`.
4. **Nested write.** Implement the `OrderSerializer` create/update and test: create with 3 items, PUT replacing items, PATCH changing only `note`, and PATCH with another order's item id (must 400).
5. **Concurrency.** Run two threads posting the same author email with a `UniqueValidator`; reproduce the `IntegrityError`, then handle it and return a 400.

**Mini project — "Bookshelf API".** Models: Author, Book, Tag, Review. Requirements: explicit field lists; read/write serializer split for Book; writable nested Review creation under a book; `average_rating` via annotation; bulk tag creation via `list_serializer_class`; every list endpoint has a query-count test; an OpenAPI schema generated later in [Ch 24](topic.html?p=24-drf-pagination-filtering-versioning).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) · [Ch 09 · Relationships](topic.html?p=09-relationships) · [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) · [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) · [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 24 · DRF Pagination, Filtering, Versioning & Docs](topic.html?p=24-drf-pagination-filtering-versioning) · [Ch 38 · Interview: DRF, Security & Scale](topic.html?p=38-interview-drf-advanced)

**Other handbooks:** [REST API · Payload Design & JSON](../rest-api/topic.html?p=08-payload-design-json) · [REST API · Validation & Input Sanitization](../rest-api/topic.html?p=17-validation-input-sanitization) · [REST API · Error Handling & Problem Details](../rest-api/topic.html?p=16-error-handling-problem-details) · [REST API · PUT, PATCH & JSON Patch](../rest-api/topic.html?p=14-put-patch-json-patch)

- **Serializers (API Guide)** — Django REST framework · *Beginner–Intermediate* · the canonical reference for fields, validation and nested writes. <https://www.django-rest-framework.org/api-guide/serializers/>
- **Serializer fields** — Django REST framework · *Intermediate* · every field type, `source`, `read_only`/`write_only` semantics. <https://www.django-rest-framework.org/api-guide/fields/>
- **Validators** — Django REST framework · *Intermediate* · Unique validators, `requires_context`, and their limitations. <https://www.django-rest-framework.org/api-guide/validators/>
- **Serializer relations** — Django REST framework · *Intermediate* · related fields and nested relationships. <https://www.django-rest-framework.org/api-guide/relations/>
- **DRF Tutorial 1: Serialization** — Django REST framework · *Beginner* · builds a Serializer then a ModelSerializer step by step. <https://www.django-rest-framework.org/tutorial/1-serialization/>
- **DRF source code** — encode/django-rest-framework on GitHub · *Advanced* · `serializers.py` and `fields.py` are readable and answer most "what really happens" questions. <https://github.com/encode/django-rest-framework>
- **Django ModelForms** — Django docs · *Beginner* · the conceptual ancestor of ModelSerializer. <https://docs.djangoproject.com/en/5.2/topics/forms/modelforms/>

---

*Django Handbook — chapter 21.*
