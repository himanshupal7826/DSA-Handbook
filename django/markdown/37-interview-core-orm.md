# 37 · Most-Asked Django Interview Questions: Core & ORM

> **In one line:** The Django core and ORM questions interviewers actually ask, from "MVT vs MVC" to "why is this count wrong?", with answers that start from the reason and end with the production pitfall, so you can show depth instead of reciting definitions.

---

## 1. Overview

> **Builds on:** every concept chapter from [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) to [Ch 19 · Signals](topic.html?p=19-signals). This chapter is a question bank. Each answer is short on purpose and links the chapter that teaches the topic in depth.

Django interviews follow a predictable path, and most of the time goes on two areas: the **request pipeline** (how a request becomes a response) and the **ORM** (how Python turns into SQL, and how that SQL goes wrong). This chapter covers both. [Ch 38 · Most-Asked Django Interview Questions: DRF, Security & Scale](topic.html?p=38-interview-drf-advanced) covers DRF, security, async, Celery and scaling. [Ch 39 · ORM Coding Round: Query Challenges](topic.html?p=39-orm-coding-challenges) is the live-coding round. [Ch 40 · Django Design Rounds: Building Real Systems](topic.html?p=40-design-rounds) is the system-design round.

### How a Django interview is structured

| Stage | Length | What happens | What they are really testing |
|---|---|---|---|
| Recruiter / screening | 15–30 min | Rapid-fire basics: MVT, project vs app, `null` vs `blank`, `get` vs `filter` | Have you actually built something with Django? |
| Technical deep-dive | 45–60 min | One topic at a time, then "why?" follow-ups: QuerySet laziness, N+1, transactions, migrations | Do you know the mechanism, or only the API? |
| Live coding | 45–60 min | Write models plus QuerySets, sometimes a view or serializer; "what SQL does this run?" | Can you get the right result with a small, fixed number of queries? |
| Design | 45–60 min | "Design checkout / multi-tenant SaaS / notifications in Django" | Data modelling, concurrency, async work, scaling path |
| Behavioural / incident | 30 min | "Tell me about a production bug you fixed" | Debugging method, ownership, judgement |

### What each level is expected to know

- **Junior (0–2 years):** the request lifecycle at a high level, models and fields, basic QuerySets, forms, templates, the admin, running migrations. You should be able to say what happens and roughly why.
- **Mid (2–5 years):** QuerySet laziness and caching, N+1 and `select_related`/`prefetch_related`, `F()` and `Q()`, aggregation, `atomic()`, migration conflicts, custom managers, CBV internals, signals and their pitfalls. You should be able to say which SQL runs and how many queries.
- **Senior (5+ years):** the internals (`ModelBase`, `sql.Query`, the compiler, descriptors), concurrency (`select_for_update`, lock ordering, optimistic locking, `on_commit`), zero-downtime migrations on large tables, constraints as invariants, query plans and indexes, admin and ORM at tens of millions of rows. You should be able to explain the trade-off, how it fails, and how you would prove it.

> **Interview tip:** Interviewers rarely care about the first answer. They care about the second and third "why?". Every answer below is built so that you can keep going when the follow-up comes.

## 2. Core Concepts

The topic map below lists what this chapter covers, which chapter teaches each area, and how often the topic comes up in interviews.

| Area | Typical questions | Home chapter | Frequency |
|---|---|---|---|
| Architecture & lifecycle | MVT vs MVC, what happens on a request, WSGI vs ASGI | [Ch 01](topic.html?p=01-architecture-request-lifecycle) | Very high |
| Projects, apps, settings | project vs app, `INSTALLED_APPS`, `AppConfig.ready()` | [Ch 02](topic.html?p=02-projects-apps-settings) | High |
| URLs | `path` vs `re_path`, `reverse`, namespaces, ordering | [Ch 03](topic.html?p=03-urls-routing) | Medium |
| Views | FBV vs CBV, `HttpRequest`, `JsonResponse`, `as_view()` | [Ch 04](topic.html?p=04-views-requests-responses), [Ch 17](topic.html?p=17-class-based-views) | High |
| Templates | inheritance, autoescape, context processors, custom tags | [Ch 05](topic.html?p=05-templates) | Medium |
| Forms | validation order, `clean()` vs `clean_<field>()`, `commit=False` | [Ch 06](topic.html?p=06-forms-validation) | High |
| Admin | customisation, performance on big tables | [Ch 07](topic.html?p=07-django-admin) | Medium |
| Models & fields | `null` vs `blank`, choices, `Meta`, `auto_now` | [Ch 08](topic.html?p=08-models-fields) | Very high |
| Relationships | `on_delete`, `related_name`, `through` | [Ch 09](topic.html?p=09-relationships) | Very high |
| QuerySets | laziness, caching, `Q`/`F`, `get` vs `filter`, `exists` vs `count` | [Ch 10](topic.html?p=10-querysets-lookups) | Very high |
| Migrations | how they work, conflicts, data migrations, zero downtime | [Ch 11](topic.html?p=11-migrations) | High |
| Aggregation | `aggregate` vs `annotate`, subqueries, window functions | [Ch 12](topic.html?p=12-aggregation-annotation-subqueries) | High |
| Optimization | N+1, `select_related` vs `prefetch_related`, `only`, bulk ops | [Ch 13](topic.html?p=13-queryset-optimization) | Very high |
| Transactions | `atomic`, savepoints, `select_for_update`, races | [Ch 14](topic.html?p=14-transactions-concurrency) | Very high (mid+) |
| Managers & inheritance | custom managers, abstract vs multi-table vs proxy | [Ch 15](topic.html?p=15-managers-model-inheritance) | Medium |
| DB features | indexes, constraints, raw SQL, PostgreSQL fields | [Ch 16](topic.html?p=16-database-features-postgres) | Medium (senior) |
| Middleware | order, hooks, writing one | [Ch 18](topic.html?p=18-middleware) | High |
| Signals | when to use them, sync behaviour, pitfalls | [Ch 19](topic.html?p=19-signals) | High |
| Internals | `ModelBase`, `LazySettings`, compiler | [Ch 36](topic.html?p=36-django-internals) | Senior |

Some vocabulary that comes up in nearly every answer:

- **Lazy evaluation**: a QuerySet does not hit the database until something needs its rows. *Why it matters:* most "too many queries" bugs come from evaluating a QuerySet repeatedly or at the wrong moment.
- **Result cache**: once a QuerySet is evaluated, its rows are stored on that instance (`_result_cache`). *Why it matters:* reusing the same instance avoids a second query, while calling `.all()` or `.filter()` again creates a new QuerySet with an empty cache.
- **N+1**: one query for the list, then one more query for each row's relation. *Why it matters:* this is the most common Django performance bug, and the most common question asked about it.
- **Autocommit**: Django's default mode, in which each query commits on its own. *Why it matters:* without `atomic()`, the two writes in a "transfer" are not all-or-nothing.
- **Savepoint**: a nested `atomic()` block. *Why it matters:* an inner failure can roll back only the inner work.
- **Migration state**: the model state Django rebuilds by replaying the migration files. *Why it matters:* `makemigrations` compares your models to this state, not to the database.

## 3. Theory & Principles

### The answer framework

A strong answer to almost any Django question has five beats. Interviewers grade the later beats, because that is where the difference between junior and senior shows.

```svg
<svg viewBox="0 0 880 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj37a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">The five-beat answer: each beat earns the right to the next</text>
  <rect x="20" y="50" width="150" height="110" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="95" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">1. Direct answer</text>
  <text x="95" y="92" text-anchor="middle" fill="#334155" font-size="10">One sentence.</text>
  <text x="95" y="108" text-anchor="middle" fill="#334155" font-size="10">"select_related is a</text>
  <text x="95" y="122" text-anchor="middle" fill="#334155" font-size="10">JOIN; prefetch is a</text>
  <text x="95" y="136" text-anchor="middle" fill="#334155" font-size="10">second query."</text>
  <path d="M172,105 L192,105" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37a)"/>
  <rect x="194" y="50" width="150" height="110" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="269" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Why it exists</text>
  <text x="269" y="92" text-anchor="middle" fill="#334155" font-size="10">The problem it solves.</text>
  <text x="269" y="108" text-anchor="middle" fill="#334155" font-size="10">"Accessing book.author</text>
  <text x="269" y="122" text-anchor="middle" fill="#334155" font-size="10">in a loop runs one</text>
  <text x="269" y="136" text-anchor="middle" fill="#334155" font-size="10">query per row."</text>
  <path d="M346,105 L366,105" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37a)"/>
  <rect x="368" y="50" width="150" height="110" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="443" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">3. Mechanism</text>
  <text x="443" y="92" text-anchor="middle" fill="#334155" font-size="10">How Django does it.</text>
  <text x="443" y="108" text-anchor="middle" fill="#334155" font-size="10">"Prefetch runs WHERE</text>
  <text x="443" y="122" text-anchor="middle" fill="#334155" font-size="10">id IN (...) and joins</text>
  <text x="443" y="136" text-anchor="middle" fill="#334155" font-size="10">in Python."</text>
  <path d="M520,105 L540,105" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37a)"/>
  <rect x="542" y="50" width="150" height="110" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="617" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">4. Example</text>
  <text x="617" y="92" text-anchor="middle" fill="#334155" font-size="10">Code or SQL.</text>
  <text x="617" y="108" text-anchor="middle" fill="#334155" font-size="10">"Book list with</text>
  <text x="617" y="122" text-anchor="middle" fill="#334155" font-size="10">authors and tags:</text>
  <text x="617" y="136" text-anchor="middle" fill="#334155" font-size="10">101 queries down to 3."</text>
  <path d="M694,105 L714,105" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37a)"/>
  <rect x="716" y="50" width="150" height="110" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="791" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">5. Trade-off</text>
  <text x="791" y="92" text-anchor="middle" fill="#334155" font-size="10">Where it breaks.</text>
  <text x="791" y="108" text-anchor="middle" fill="#334155" font-size="10">"JOIN on a to-many</text>
  <text x="791" y="122" text-anchor="middle" fill="#334155" font-size="10">duplicates rows; filter()</text>
  <text x="791" y="136" text-anchor="middle" fill="#334155" font-size="10">after prefetch re-queries."</text>
  <rect x="20" y="190" width="324" height="44" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="182" y="210" text-anchor="middle" fill="#1e293b" font-weight="bold">Junior stops here</text>
  <text x="182" y="226" text-anchor="middle" fill="#334155" font-size="10">Correct, but sounds like the docs.</text>
  <rect x="368" y="190" width="498" height="44" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="617" y="210" text-anchor="middle" fill="#1e293b" font-weight="bold">Senior signal lives here</text>
  <text x="617" y="226" text-anchor="middle" fill="#334155" font-size="10">Internals, numbers (query counts), and a production failure you have seen.</text>
  <text x="440" y="270" text-anchor="middle" fill="#334155" font-size="11">Aim for 30–90 seconds. Then stop and let them choose the follow-up. Do not lecture.</text>
</svg>
```

Three principles behind the framework:

1. **Lead with the answer, not the history.** "It depends" is only acceptable when you immediately say *on what*.
2. **Talk in queries and SQL.** For any ORM question, the most convincing evidence you can give is "this runs N queries, and this is the SQL". The interviewer can check it, and it shows you have actually looked at what your ORM does.
3. **Name a failure mode.** Every Django feature has a well-known way of going wrong in production: the prefetch that gets re-queried, the signal that fires on `save()` but not on `update()`, `locmem` caches that are not shared between workers. Mentioning one is the quickest way to show experience.

### How to handle "I don't know"

Say what you *do* know and reason towards the answer out loud: "I haven't used `RESTRICT`, but I know `PROTECT` blocks any delete that would orphan rows, so I'd expect `RESTRICT` to be a softer version. I believe it allows the delete when the referenced object is itself being removed by a CASCADE in the same operation." Interviewers score your reasoning. A confident wrong answer costs you more than an honest, reasoned guess.

## 4. Architecture & Workflow

### The request-lifecycle whiteboard (redraw this in the interview)

"What happens when a request hits Django?" is the most-asked Django question there is. Practise drawing this diagram in about 60 seconds.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj37b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj37c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">One request through Django: the whiteboard version</text>
  <rect x="16" y="60" width="90" height="50" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="61" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">Client</text>
  <text x="61" y="98" text-anchor="middle" fill="#334155" font-size="9">GET /books/7/</text>
  <path d="M108,85 L128,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37b)"/>
  <rect x="130" y="60" width="110" height="50" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="185" y="80" text-anchor="middle" fill="#1e293b" font-weight="bold">Nginx + Gunicorn</text>
  <text x="185" y="96" text-anchor="middle" fill="#334155" font-size="9">or Uvicorn (ASGI)</text>
  <path d="M242,85 L262,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37b)"/>
  <rect x="264" y="60" width="130" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="329" y="80" text-anchor="middle" fill="#1e293b" font-weight="bold">WSGIHandler</text>
  <text x="329" y="96" text-anchor="middle" fill="#334155" font-size="9">builds HttpRequest</text>
  <path d="M396,85 L416,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37b)"/>
  <rect x="418" y="46" width="200" height="200" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="518" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Middleware onion</text>
  <rect x="434" y="76" width="168" height="22" rx="4" fill="#ffffff" stroke="#7c3aed"/>
  <text x="518" y="91" text-anchor="middle" fill="#334155" font-size="9">SecurityMiddleware</text>
  <rect x="434" y="102" width="168" height="22" rx="4" fill="#ffffff" stroke="#7c3aed"/>
  <text x="518" y="117" text-anchor="middle" fill="#334155" font-size="9">SessionMiddleware</text>
  <rect x="434" y="128" width="168" height="22" rx="4" fill="#ffffff" stroke="#7c3aed"/>
  <text x="518" y="143" text-anchor="middle" fill="#334155" font-size="9">CommonMiddleware</text>
  <rect x="434" y="154" width="168" height="22" rx="4" fill="#ffffff" stroke="#7c3aed"/>
  <text x="518" y="169" text-anchor="middle" fill="#334155" font-size="9">CsrfViewMiddleware</text>
  <rect x="434" y="180" width="168" height="22" rx="4" fill="#ffffff" stroke="#7c3aed"/>
  <text x="518" y="195" text-anchor="middle" fill="#334155" font-size="9">AuthenticationMiddleware</text>
  <text x="518" y="222" text-anchor="middle" fill="#334155" font-size="9">request: top to bottom</text>
  <text x="518" y="236" text-anchor="middle" fill="#334155" font-size="9">response: bottom to top</text>
  <path d="M620,85 L650,85" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37b)"/>
  <rect x="652" y="60" width="212" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="758" y="80" text-anchor="middle" fill="#1e293b" font-weight="bold">URL resolver</text>
  <text x="758" y="96" text-anchor="middle" fill="#334155" font-size="9">ROOT_URLCONF, in order, first match</text>
  <path d="M758,112 L758,138" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37b)"/>
  <rect x="652" y="140" width="212" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="758" y="160" text-anchor="middle" fill="#1e293b" font-weight="bold">process_view, then the view</text>
  <text x="758" y="176" text-anchor="middle" fill="#334155" font-size="9">FBV, or CBV via as_view() and dispatch()</text>
  <path d="M758,192 L758,218" stroke="#2563eb" stroke-width="2" marker-end="url(#dj37b)"/>
  <rect x="652" y="220" width="100" height="50" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="702" y="240" text-anchor="middle" fill="#1e293b" font-weight="bold">ORM</text>
  <text x="702" y="256" text-anchor="middle" fill="#334155" font-size="9">QuerySet to SQL</text>
  <rect x="764" y="220" width="100" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="814" y="240" text-anchor="middle" fill="#1e293b" font-weight="bold">Template</text>
  <text x="814" y="256" text-anchor="middle" fill="#334155" font-size="9">render to HTML</text>
  <path d="M702,272 L702,300" stroke="#16a34a" stroke-width="2" marker-end="url(#dj37c)"/>
  <rect x="652" y="302" width="100" height="40" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="702" y="326" text-anchor="middle" fill="#1e293b" font-weight="bold">PostgreSQL</text>
  <path d="M760,350 L520,350 L520,250" stroke="#16a34a" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#dj37c)"/>
  <text x="640" y="366" text-anchor="middle" fill="#166534" font-size="10">HttpResponse back out through middleware (bottom to top), then to the server</text>
  <rect x="16" y="150" width="380" height="120" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="206" y="172" text-anchor="middle" fill="#1e293b" font-weight="bold">Talking points that score</text>
  <text x="30" y="194" fill="#334155" font-size="10">Middleware chain is built once, by BaseHandler.load_middleware()</text>
  <text x="30" y="212" fill="#334155" font-size="10">A middleware that returns a response short-circuits the inner layers</text>
  <text x="30" y="230" fill="#334155" font-size="10">No URL match raises Http404 (technical 404 page when DEBUG)</text>
  <text x="30" y="248" fill="#334155" font-size="10">request.user is lazy; the session is saved only if modified</text>
</svg>
```

### The ORM evaluation pipeline (redraw for "when does a QuerySet hit the DB?")

The second diagram interviewers like to see explains why chaining methods costs nothing and evaluating costs a query.

```svg
<svg viewBox="0 0 880 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj37d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">QuerySet: build lazily, evaluate once, cache on the instance</text>
  <rect x="20" y="50" width="200" height="80" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="120" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Chain (no SQL)</text>
  <text x="120" y="92" text-anchor="middle" fill="#334155" font-size="10">filter(), exclude(), order_by()</text>
  <text x="120" y="108" text-anchor="middle" fill="#334155" font-size="10">each clones and mutates sql.Query</text>
  <path d="M222,90 L250,90" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj37d)"/>
  <rect x="252" y="50" width="190" height="80" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="347" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Evaluation trigger</text>
  <text x="347" y="92" text-anchor="middle" fill="#334155" font-size="10">iterate, list(), len(), bool()</text>
  <text x="347" y="108" text-anchor="middle" fill="#334155" font-size="10">repr(), pickling, step slicing</text>
  <path d="M444,90 L472,90" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj37d)"/>
  <rect x="474" y="50" width="190" height="80" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="569" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">_fetch_all()</text>
  <text x="569" y="92" text-anchor="middle" fill="#334155" font-size="10">get_compiler(using)</text>
  <text x="569" y="108" text-anchor="middle" fill="#334155" font-size="10">as_sql(), execute_sql()</text>
  <path d="M666,90 L694,90" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj37d)"/>
  <rect x="696" y="50" width="168" height="80" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="780" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">ModelIterable</text>
  <text x="780" y="92" text-anchor="middle" fill="#334155" font-size="10">rows become instances</text>
  <text x="780" y="108" text-anchor="middle" fill="#334155" font-size="10">stored in _result_cache</text>
  <rect x="20" y="160" width="410" height="96" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="225" y="182" text-anchor="middle" fill="#1e293b" font-weight="bold">Reuses the cache (no new query)</text>
  <text x="36" y="204" fill="#334155" font-size="10">qs = Book.objects.all(); list(qs); list(qs)</text>
  <text x="36" y="222" fill="#334155" font-size="10">len(qs) after evaluation; qs.count() after evaluation</text>
  <text x="36" y="240" fill="#334155" font-size="10">qs[0] after the QuerySet is evaluated</text>
  <rect x="450" y="160" width="414" height="96" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="657" y="182" text-anchor="middle" fill="#1e293b" font-weight="bold">New query every time</text>
  <text x="466" y="204" fill="#334155" font-size="10">qs.all(), qs.filter(...): a new QuerySet with an empty cache</text>
  <text x="466" y="222" fill="#334155" font-size="10">qs[0] on an unevaluated QuerySet: LIMIT 1 each time</text>
  <text x="466" y="240" fill="#334155" font-size="10">qs.exists() / qs.count() before evaluation: separate SQL</text>
</svg>
```

### A 45-minute technical round, minute by minute

```text
00–05  Warm-up: "Tell me about a Django project you shipped." (They are choosing topics to dig into.)
05–20  Request pipeline: lifecycle, middleware, CBV vs FBV, forms.
20–40  ORM deep-dive: laziness, N+1, aggregation, transactions; "what SQL does this run?"
40–45  Your questions. (Ask about their Django version, DB size, how they deploy migrations.)
```

Before the interview, choose two production stories you can reuse: one about performance (an N+1 or a missing index) and one about correctness (a race condition or a migration that locked a table). Most follow-ups lead to one of them.

## 5. Implementation

This is the question bank. Every answer gives the reasoning first and links the chapter that teaches the topic in depth. Read each answer aloud, then try to defend it against a "why?".

### 5.1 Django basics & architecture

**Q: What is MVT, and how does it differ from MVC?**
A: MVT stands for Model, View, Template. The **model** holds the data and business rules. The **view** is a Python callable that takes a request and returns a response, so it does what an MVC *controller* does. The **template** is the presentation layer, which MVC calls the *view*. The piece that does the dispatching, which MVC also attributes to the controller, is Django itself: the URLconf maps a URL to a view. The only real difference is naming. If you say "the Django view is the controller", most interviewers will be happy. See [Ch 01 · Architecture & Lifecycle](topic.html?p=01-architecture-request-lifecycle).

**Q: Walk me through what happens when a request hits a Django application.**
A: The web server (Gunicorn or Uvicorn) calls Django's entry point, `WSGIHandler` or `ASGIHandler`. Both subclass `BaseHandler`, which built the middleware chain once at startup with `load_middleware()`. The handler creates an `HttpRequest` and passes it through the middleware request phase from top to bottom. The URL resolver then tries the patterns in `ROOT_URLCONF` in order and uses the first match; if nothing matches, it raises `Http404`. Next, `process_view` hooks run and the view is called. The view usually queries the ORM and renders a template. The `HttpResponse` then travels back out through the middleware from bottom to top, and the server sends it to the client. If any middleware returns a response early, for example CSRF rejecting a POST, the inner layers and the view never run. See [Ch 01](topic.html?p=01-architecture-request-lifecycle) and [Ch 18 · Middleware](topic.html?p=18-middleware).

**Q: What is the difference between a project and an app?**
A: A **project** is the deployable unit: settings, the root URLconf, and the WSGI/ASGI entry points. An **app** is a reusable Python package with one area of responsibility, such as models, views, templates and migrations for `orders` or `billing`. A project is a collection of apps listed in `INSTALLED_APPS`. Apps let you split a codebase by domain, and they are also how Django discovers models, migrations, templates, admin modules and management commands. Interviewers often follow up with "how do you split apps?" A good answer is: by bounded context, keeping relationships between apps few and pointing in one direction. See [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings).

**Q: What is `AppConfig.ready()` used for?**
A: `ready()` runs once, after the app registry is fully populated, meaning all models are imported. It is the right place to register signal receivers (`from . import signals`), run system-check registrations, or do any start-up wiring that needs models. Do not run database queries in it. It runs in every process, including `migrate` and `collectstatic`, and the tables may not exist yet. Also bear in mind that it can run more than once in tests, which is one reason receivers use `dispatch_uid`. See [Ch 02](topic.html?p=02-projects-apps-settings).

**Q: How does `django.conf.settings` work, and why can't you change settings at runtime?**
A: `settings` is a `LazySettings` object, a `LazyObject` that imports the module named in `DJANGO_SETTINGS_MODULE` the first time any attribute is read. It is a process-wide global that many components read once and cache, such as the middleware chain, database connections and template engines. Changing a value at runtime is therefore unreliable, and it does not work across processes anyway. In tests, use `override_settings`, which also sends `setting_changed` so that caches are reset. In production, settings come from environment variables at start-up. See [Ch 36 · Django Internals](topic.html?p=36-django-internals).

**Q: How do you structure settings for development, staging and production?**
A: There are two common patterns. One is a `settings/` package with `base.py`, plus `dev.py` and `prod.py` that each do `from .base import *` and override values. The other is a single settings file driven entirely by environment variables, using `django-environ` or `os.environ`, which follows 12-factor. Either way, secrets such as `SECRET_KEY` and database URLs never go into git, `DEBUG` defaults to False, and `manage.py check --deploy` runs in CI. Most senior engineers prefer the environment-variable approach because the same image is promoted unchanged from staging to production. See [Ch 02](topic.html?p=02-projects-apps-settings).

**Q: What does `manage.py` do, and how do you write a custom management command?**
A: `manage.py` sets `DJANGO_SETTINGS_MODULE` and calls `execute_from_command_line`, which runs `django.setup()` and dispatches to the command. To add your own, create `yourapp/management/commands/<name>.py` with a `Command(BaseCommand)` class that implements `add_arguments()` and `handle()`. Commands are what you use for cron jobs, backfills and one-off maintenance. Make them idempotent and process work in batches so they are safe to re-run. See [Ch 02](topic.html?p=02-projects-apps-settings).

### 5.2 URLs & views

**Q: What is the difference between `path()` and `re_path()`?**
A: `path()` uses simple route strings with **converters** such as `<int:pk>` and `<slug:slug>`. The converter does the matching and also converts the type, so the view receives an `int`. `re_path()` takes a regular expression, and every captured value arrives as a `str`. Use `path()` by default. When you need a pattern `path()` cannot express, a custom converter (a class with `regex`, `to_python` and `to_url`) is usually cleaner than `re_path()`, and it also works with `reverse()`. See [Ch 03 · URL Routing](topic.html?p=03-urls-routing).

**Q: Why use `reverse()` and URL names instead of hard-coded URLs?**
A: A URL name separates *what* you link to from *where* it lives. With `reverse("orders:detail", kwargs={"pk": 7})` or `{% url %}` in templates, you can change the route string without breaking any links. Namespaces (`app_name` in the app's `urls.py`, plus `include()`) prevent name clashes between apps, for example two apps that both have a URL named `detail`. Some follow-ups: `reverse_lazy` is for places that are evaluated at import time, such as `success_url` on a CBV, and URL patterns are matched in order with the first match winning. See [Ch 03](topic.html?p=03-urls-routing).

**Q: FBV vs CBV: which do you prefer, and why?**
A: Function-based views are explicit and easy to read top to bottom. They are good for one-off endpoints and for logic that does not fit the generic CRUD shape. Class-based views give you reuse through inheritance and mixins. The generic views (`ListView`, `UpdateView`) remove boilerplate for standard CRUD, but the behaviour is spread across the MRO, so it is harder to see what actually runs. A balanced answer is: CBVs for standard CRUD and shared behaviour such as a tenant-scoping mixin, FBVs when the flow is unusual. In DRF, the same trade-off applies between `APIView` and viewsets. See [Ch 04 · Views](topic.html?p=04-views-requests-responses) and [Ch 17 · Class-Based Views](topic.html?p=17-class-based-views).

**Q: What does `as_view()` actually do?**
A: `as_view()` is a classmethod that returns a plain function. URLconf needs a callable, and it cannot hold an instance shared across requests. On each request, that function creates a **new instance** of the class, calls `setup()` (which sets `self.request`, `self.args` and `self.kwargs`), and then calls `dispatch()`. `dispatch()` looks up the handler named after the HTTP method (`get`, `post` and so on), or returns `http_method_not_allowed` if there is none. Because each request gets a fresh instance, it is safe to store per-request state on `self`. Keyword arguments passed to `as_view(template_name=...)` override class attributes. See [Ch 17](topic.html?p=17-class-based-views).

**Q: In a CBV, why do mixins go on the left?**
A: Python resolves methods left to right along the MRO. A mixin such as `LoginRequiredMixin` overrides `dispatch()` and must run before the base view's `dispatch()`. Putting it first, `class OrderList(LoginRequiredMixin, ListView)`, means its `dispatch()` runs first and calls `super()`. Put it on the right and the base view handles the request before the login check runs, so it does nothing. This question is a check that you understand `super()` and the MRO, not only Django.

**Q: What is the difference between `HttpResponse`, `JsonResponse`, `StreamingHttpResponse` and `FileResponse`?**
A: `HttpResponse` holds a body in memory. `JsonResponse` serialises a dict with `DjangoJSONEncoder` and sets the content type. You need `safe=False` to pass a list, a guard that dates from old JSON-hijacking attacks. `StreamingHttpResponse` takes an iterator and sends chunks as they are produced, which suits large CSV exports. Middleware that reads `.content` cannot work with it, and under WSGI it ties up a worker for the whole stream. `FileResponse` is a streaming response tuned for file objects and can use `wsgi.file_wrapper`. See [Ch 04](topic.html?p=04-views-requests-responses).

**Q: What are `request.GET`, `request.POST`, `request.body` and `request.META`?**
A: `GET` and `POST` are `QueryDict` objects. They are immutable and multi-valued, so use `getlist()` for repeated keys. `POST` is only populated for form-encoded and multipart bodies; a JSON body is not parsed into it, so read `request.body` and call `json.loads`. `request.FILES` holds uploads for multipart forms. `META` holds WSGI environ values such as `REMOTE_ADDR` and `HTTP_*` headers. The cleaner modern API for headers is `request.headers`, which is case-insensitive. A common gotcha: behind a proxy, `REMOTE_ADDR` is the proxy's IP. See [Ch 04](topic.html?p=04-views-requests-responses).

### 5.3 Templates & forms

**Q: How does template inheritance work?**
A: A base template defines `{% block %}` regions. A child template starts with `{% extends "base.html" %}` and overrides only the blocks it needs. `{{ block.super }}` adds to the parent's content instead of replacing it. `{% include %}` is a different thing: it composes a fragment rather than inheriting a layout. The engine looks up templates through the configured loaders: `DIRS` first, then each app's `templates/` folder in `INSTALLED_APPS` order. That is why namespacing app templates (`orders/templates/orders/list.html`) matters. See [Ch 05 · Templates](topic.html?p=05-templates).

**Q: How does Django protect templates against XSS, and when does that protection fail?**
A: Autoescaping is on by default and escapes `< > ' " &` in every variable. It stops being applied when you use `|safe`, `mark_safe()` or `{% autoescape off %}`. It is also not enough in some contexts: inside `<script>` blocks, in unquoted attributes, and in `href="{{ url }}"` where the value could be `javascript:...`. To get data into JavaScript safely, use `{{ data|json_script:"id" }}`. See [Ch 05](topic.html?p=05-templates) and [Ch 28 · Security](topic.html?p=28-security).

**Q: What is a context processor?**
A: A context processor is a function that takes the request and returns a dict that is merged into the context of every template rendered with a `RequestContext` (which is what `render()` uses). Built-in examples add `request`, `user`, `perms` and `messages`. They run on *every* render, so a context processor that queries the database adds that query to every page. Keep them cheap, or make them lazy. See [Ch 05](topic.html?p=05-templates).

**Q: Explain the form validation order.**
A: `form.is_valid()` triggers `full_clean()`. For each field, `field.clean()` runs `to_python()` (convert the type), then `validate()` (field-level rules such as required), then `run_validators()`. Next, the form's `clean_<fieldname>()` runs, if defined, and must return the cleaned value. After all fields are processed, `Form.clean()` runs for checks across fields. In a ModelForm, `_post_clean()` then builds the instance and calls `instance.full_clean()`, which covers model field validation, `Model.clean()` and unique checks. Errors collect in `form.errors`, and `cleaned_data` holds only the fields that passed. See [Ch 06 · Forms & Validation](topic.html?p=06-forms-validation).

**Q: When do you use `clean_<field>()` versus `clean()`?**
A: Use `clean_<field>()` for a rule about one field, such as "the username must not be reserved". It runs after that field's own validation, so its value is already in `cleaned_data`. Use `clean()` for rules that involve several fields, such as "end date after start date". In `clean()`, any field that failed validation is missing from `cleaned_data`, so use `.get()`, and attach errors to fields with `self.add_error("end", ...)`. Raising `ValidationError` from `clean()` creates a non-field error.

**Q: What does `form.save(commit=False)` do, and what is the catch?**
A: It builds the model instance from the cleaned data without saving it, so you can set extra fields such as `obj.owner = request.user` before calling `obj.save()`. The catch is many-to-many data: an M2M row cannot be written until the instance has a primary key, so Django attaches a `save_m2m()` method to the form. You must call `form.save_m2m()` after `obj.save()`. If you forget, the M2M selections are silently lost. See [Ch 06](topic.html?p=06-forms-validation).

### 5.4 Models & fields

**Q: What is the difference between `null=True` and `blank=True`?**
A: `null` works at the **database** level: the column allows NULL. `blank` works at the **validation** level: forms and `full_clean()` accept an empty value. They are independent, and the common combinations are `null=True, blank=True` for an optional FK, date or number, and `blank=True` alone for an optional `CharField`. Avoid `null=True` on `CharField` and `TextField`, because then both NULL and `""` mean "empty", and every query has to check both. The exception is a unique optional string, where NULL is needed because many NULLs do not conflict but many `""` values do. See [Ch 08 · Models & Fields](topic.html?p=08-models-fields).

**Q: How do you define choices, and what does `get_FOO_display()` do?**
A: Modern Django uses enumeration types:

```python
class Order(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PAID = "paid", "Paid"
        SHIPPED = "shipped", "Shipped"

    status = models.CharField(max_length=16, choices=Status, default=Status.PENDING)
```

The database stores the value (`"paid"`). `order.get_status_display()` returns the human label. Choices are validated only by `full_clean()` and forms, not by the database. If you need the database to enforce them, add a `CheckConstraint`. Since Django 5.0 you can pass the enum class directly to `choices=` without `.choices`.

**Q: What is the difference between `auto_now` and `auto_now_add`?**
A: `auto_now_add=True` sets the value once, on creation. `auto_now=True` sets it on every `save()`. Both make the field non-editable in forms. The gotcha is that they are applied in the field's `pre_save()`, so `QuerySet.update()` does **not** touch an `auto_now` field. If you bulk-update rows, set `updated_at=timezone.now()` yourself. Another gotcha: `save(update_fields=[...])` only writes `updated_at` if it is in the list. A frequent alternative is `default=timezone.now` (pass the callable, do not call it), which still lets you set the value explicitly.

**Q: What are the most important `Meta` options?**
A: `ordering` sets the default sort, and it costs a sort on every query, so use it carefully. `indexes` and `constraints` hold `Index`, `UniqueConstraint` and `CheckConstraint`; these are preferred over `unique_together` and `index_together`, and `index_together` has been removed. `db_table`, `verbose_name` and `verbose_name_plural` do what their names say. `abstract = True` and `proxy = True` control inheritance. `get_latest_by` and `default_related_name` are less common. `permissions` adds custom permissions. A senior answer mentions that `Meta.ordering` is not applied to `GROUP BY` queries (since 3.1), and that a default ordering on a huge table can turn a cheap query into a sort. See [Ch 08](topic.html?p=08-models-fields).

**Q: What primary key type does Django use, and what is `DEFAULT_AUTO_FIELD`?**
A: Since 3.2, new projects set `DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"`, a 64-bit auto-increment. Older projects used `AutoField`, which is 32-bit and can run out at about 2.1 billion rows. Moving a large existing table from int to bigint is a slow rewrite, which is why the default changed. UUID primary keys (`UUIDField(primary_key=True, default=uuid.uuid4)`) hide row counts and allow ids to be generated offline. The cost is larger indexes, and random UUIDv4 values give poor insert locality. Time-ordered UUIDs (v7) fix that.

**Q: What happens when you call `model.save()`? (Senior)**
A: Django sends `pre_save`. It calls each field's `pre_save()`, which is where `auto_now` gets applied, then decides between INSERT and UPDATE. If the instance is new (`_state.adding`) and the pk has a default, it INSERTs directly. Otherwise, when a pk is set, it tries an UPDATE first, and if no rows were affected it INSERTs. The UPDATE writes **every** field unless you pass `update_fields`. After that it sets `_state.adding = False` and sends `post_save` with `created`. It does **not** call `full_clean()`, so model validation is skipped unless you call it yourself. Saving every column causes lost updates when two processes save the same row: the last full save overwrites the other's change. That is why `update_fields` and `F()` matter. See [Ch 08](topic.html?p=08-models-fields) and [Ch 36](topic.html?p=36-django-internals).

**Q: Why doesn't `save()` call `full_clean()`?**
A: For backward compatibility and performance, and because validation belongs at the input boundary: forms, serializers and admin. Saving internal data you already trust should not pay for validation queries such as unique checks. The consequence is that invariants which must *always* hold belong in the database, as `UniqueConstraint` or `CheckConstraint`, not only in `clean()`. Some teams call `full_clean()` in an overridden `save()`, but that does nothing for `update()` or `bulk_create()`. Since Django 4.1, `full_clean()` also validates `Meta.constraints`.

### 5.5 Relationships

**Q: Explain the `on_delete` options.**
A: `CASCADE` deletes the dependent rows. `PROTECT` raises `ProtectedError` and blocks the delete. `RESTRICT` (3.1+) blocks the delete too, *unless* the referenced object is also being deleted through a CASCADE path in the same operation. `SET_NULL` needs `null=True`. `SET_DEFAULT` and `SET(value_or_callable)` replace the reference. `DO_NOTHING` leaves the integrity problem to the database, which will raise a foreign-key error unless you have defined DB-level behaviour. The key point that impresses interviewers: Django **emulates** these in Python with its deletion `Collector`. The foreign-key constraint Django creates has no `ON DELETE CASCADE`, so raw SQL deletes do not cascade, and a CASCADE over large child tables loads and deletes those children through Python (with batching and fast-delete where it can). See [Ch 09 · Relationships](topic.html?p=09-relationships).

**Q: What is `related_name`, and what is `related_query_name`?**
A: `related_name` is the reverse accessor on the target model. With `author = ForeignKey(Author, related_name="books", ...)`, you write `author.books.all()` instead of `author.book_set.all()`. `related_query_name` is the name used in reverse lookups such as `Author.objects.filter(books__title=...)`; it defaults to `related_name` if that is set. You must set `related_name` when a model has two FKs to the same target, such as `sender` and `recipient` both pointing at User, or the reverse names clash. `related_name="+"` disables the reverse relation. See [Ch 09](topic.html?p=09-relationships).

**Q: When do you need a `through` model on a ManyToManyField?**
A: When the relationship itself has data: when a student enrolled, their grade, a membership role. You define an explicit model with two FKs and point the M2M at it with `through=`. Since Django 2.2, `.add()`, `.create()` and `.set()` work with through models, and you pass extra fields with `through_defaults={...}`. Add a `UniqueConstraint` on the two FKs, because an explicit through table does not get uniqueness automatically. Many teams start with an explicit through model from the beginning, because converting an auto-created M2M later needs `SeparateDatabaseAndState`. See [Ch 09](topic.html?p=09-relationships).

**Q: ForeignKey vs OneToOneField: what's the difference?**
A: A `OneToOneField` is a `ForeignKey(unique=True)` whose reverse side returns a single object (`user.profile`) instead of a manager. If the related row does not exist, the reverse access raises `RelatedObjectDoesNotExist`. It is used for profile tables, for splitting rarely-used columns into a separate table, and implicitly by multi-table inheritance. `select_related` works in both directions for O2O, and forward only for FK.

**Q: What is a GenericForeignKey, and why are seniors wary of it?**
A: It uses the `contenttypes` framework to point at *any* model, with a `content_type` FK plus an `object_id`. It suits comments or tags that attach to many models. The costs: there is no real foreign-key constraint, so orphan rows appear; you cannot JOIN or `filter()` through it; and `select_related` does not work, although `prefetch_related` does (and Django 5.0 adds `GenericPrefetch` for querysets per content type). Often a better design is separate nullable FKs with a `CheckConstraint` that exactly one is set, or one table per target. See [Ch 09](topic.html?p=09-relationships).

### 5.6 QuerySets

**Q: What does it mean that QuerySets are lazy, and when are they evaluated?**
A: Building a QuerySet (`filter`, `exclude`, `order_by`, `annotate`) only builds an internal `sql.Query`, and no database call is made. It is evaluated when something needs rows: iteration, `list()`, `len()`, `bool()` or `if qs:`, `repr()` (the shell does this), pickling, or slicing with a step. Slicing without a step on an unevaluated QuerySet returns a new QuerySet with LIMIT/OFFSET, and negative indexes are not supported. Some methods always run a query immediately: `get()`, `count()`, `exists()`, `aggregate()`, `first()` and `last()`. Laziness lets you compose queries across function calls without any cost until the end. See [Ch 10 · QuerySets, Lookups, Q & F](topic.html?p=10-querysets-lookups).

**Q: How does QuerySet caching work?**
A: The first evaluation stores the instances in that QuerySet's `_result_cache`, and iterating the *same* object again reuses them. Any method that returns a new QuerySet (`.all()`, `.filter()`) starts with an empty cache. Indexing or slicing an *unevaluated* QuerySet does not fill the cache; it runs a LIMIT query each time. `count()` and `exists()` reuse the cache only if the QuerySet has already been evaluated.

```python
qs = Book.objects.filter(published=True)
for b in qs: ...       # query 1, fills qs._result_cache
for b in qs: ...       # no query
qs.all()[0]            # new QuerySet: query 2 (LIMIT 1)
```

**Q: What is the difference between `get()` and `filter()`?**
A: `filter()` returns a lazy QuerySet of zero or more rows and never raises for "not found". `get()` runs immediately and returns exactly one instance. It raises `Model.DoesNotExist` if there are none and `MultipleObjectsReturned` if there are several. Internally it adds a small LIMIT so it can detect duplicates without fetching everything. Use `get()` when exactly one row must exist (often through `get_object_or_404`), and `filter().first()` when "zero or one" is fine. Calling `get()` on a non-unique column is a latent bug: it works until a duplicate appears.

**Q: `exists()` vs `count()` vs `len()`: when do you use each?**
A: `exists()` runs `SELECT 1 ... LIMIT 1`, the cheapest way to ask "is there at least one?". `count()` runs `SELECT COUNT(*)`, which you need for the number itself, and which can be slow on big PostgreSQL tables because of MVCC. `len(qs)` fetches and builds every row, so use it only if you are going to use the rows anyway. In that case it is the best choice, because the later loop reuses the cache. The pattern to avoid is `if qs.count() > 0:` followed by a loop, which runs two queries; either `if qs.exists()` alone, or evaluate once and check the list.

**Q: What are Q objects for?**
A: Keyword arguments to `filter()` are combined with AND. `Q` objects let you build OR (`|`), NOT (`~`) and nested boolean logic, and you can build them dynamically, for example by folding a list of search terms with `|`. `filter(Q(a=1) | Q(b=2), c=3)` means `(a=1 OR b=2) AND c=3`, and positional `Q` arguments must come before keyword arguments. `~Q()` with multi-valued relations can produce subqueries that surprise people, so check the SQL. See [Ch 10](topic.html?p=10-querysets-lookups).

**Q: What are F expressions, and why do they matter for concurrency?**
A: `F("field")` refers to a column's value *inside the database* rather than a Python value. `Product.objects.filter(pk=1).update(stock=F("stock") - 1)` produces `UPDATE ... SET stock = stock - 1`, which is atomic, with no read-modify-write race. They also allow comparisons between fields (`filter(sold__gt=F("stock"))`) and arithmetic in annotations. Gotcha: after `obj.stock = F("stock") - 1; obj.save()`, the attribute still holds the expression, so call `obj.refresh_from_db()` before you read it, and do not save twice or the decrement happens twice. See [Ch 10](topic.html?p=10-querysets-lookups) and [Ch 14](topic.html?p=14-transactions-concurrency).

**Q: What is the difference between `values()`, `values_list()` and `only()`?**
A: `values()` returns dicts and `values_list()` returns tuples (`flat=True` for a single column, `named=True` for namedtuples). Neither builds model instances, so they are faster and use less memory, but you lose model methods and relation descriptors. `only()` and `defer()` still return model instances with some columns not loaded. If you then access a deferred field, Django runs **one query per instance** to load it, which is an N+1 you have created yourself. Use `values_list` for exports and IDs, and `only()` when you need instances but the table has heavy columns. See [Ch 13](topic.html?p=13-queryset-optimization).

**Q: How do lookups across relationships work, and what is the trap with multi-valued relations?**
A: Double underscores follow relationships: `Book.objects.filter(author__country="IN")` becomes a JOIN. For multi-valued relations, `filter(a, b)` in **one** call means both conditions must match the *same* related row. Chained `filter(a).filter(b)` allows *different* related rows. For example, "authors with a book published in 2024 that is also a bestseller" needs a single `filter(books__year=2024, books__bestseller=True)`, while chaining the two finds authors with any 2024 book and any bestseller. JOINs on to-many relations can also duplicate parent rows, so `.distinct()` may be needed.

**Q: What does `get_or_create()` do, and is it race-safe? (Senior)**
A: It tries `get(**lookup)`, and on `DoesNotExist` it creates the row with the lookup plus `defaults` inside an atomic block. On an `IntegrityError` it retries the `get()`. That retry only protects you if the lookup fields have a **unique constraint**. Without one, two concurrent requests can both miss and both insert, and you end up with duplicates and later `MultipleObjectsReturned`. So the honest answer is "race-safe only with a DB uniqueness guarantee". `update_or_create()` has the same requirement, and it takes a row lock with `select_for_update()` on the get path. Since 5.0, `create_defaults` lets the create use different values from the update. See [Ch 14](topic.html?p=14-transactions-concurrency).

### 5.7 Aggregation & annotation

**Q: What is the difference between `aggregate()` and `annotate()`?**
A: `aggregate()` summarises the whole QuerySet into a single dict, such as `{"total": 1234}`. It ends the chain and runs immediately. `annotate()` adds a computed value to **each** row, and with an aggregate function inside, it adds `GROUP BY`. For example, `Author.objects.annotate(n=Count("books"))` gives each author an `n`. `values("country").annotate(n=Count("id"))` groups by country. The position of `values()` relative to `annotate()` changes the meaning: before `annotate()` it sets the GROUP BY columns, after it only selects columns. See [Ch 12 · Aggregation, Annotation & Subqueries](topic.html?p=12-aggregation-annotation-subqueries).

**Q: Why does combining two `Count` annotations give wrong numbers? (Senior)**
A: Each to-many annotation adds a JOIN, and two JOINs on different to-many relations multiply rows together. An author with 3 books and 4 awards produces 12 joined rows, so `Count("books")` and `Count("awards")` both come out as 12. `Count(..., distinct=True)` fixes counts. It does **not** fix `Sum`, because duplicated rows inflate the sum. The robust fix is a correlated subquery for each relation:

```python
from django.db.models import OuterRef, Subquery, Count, IntegerField
from django.db.models.functions import Coalesce

books = (Book.objects.filter(author=OuterRef("pk"))
         .values("author").annotate(c=Count("id")).values("c"))
Author.objects.annotate(n_books=Coalesce(Subquery(books, output_field=IntegerField()), 0))
```

Interviewers love this one because it separates people who read the SQL from people who don't.

**Q: How do you filter on an aggregate, the equivalent of `HAVING`?**
A: Call `filter()` after the `annotate()` that defines the alias: `Author.objects.annotate(n=Count("books")).filter(n__gt=5)` becomes `HAVING COUNT(...) > 5`. A `filter()` *before* the annotate is a `WHERE`, which restricts the rows that get counted. To count only some related rows, use the `filter=` argument: `Count("books", filter=Q(books__year=2024))`, which compiles to `COUNT(...) FILTER (WHERE ...)` on PostgreSQL.

**Q: When do you use `Subquery`/`OuterRef` and `Exists`?**
A: Use `Subquery` when you need one value from a related table per row, such as "latest order date per customer" or "price of the newest variant", without a JOIN that multiplies rows. Use `Exists` for "has any related row that matches". It is usually faster than `filter(...).distinct()` because PostgreSQL can turn it into a semi-join. Since 3.0, an `Exists` expression can go straight into `filter()`. Use `OuterRef("pk")` to refer to the outer query's row. See [Ch 12](topic.html?p=12-aggregation-annotation-subqueries).

**Q: How would you get the top 3 books per author with the ORM?**
A: Use a window function. Annotate `rank=Window(RowNumber(), partition_by=F("author"), order_by=F("sales").desc())` and filter `rank__lte=3`. Since Django 4.2, filtering on a window annotation is supported: Django wraps the query in an outer SELECT for you. On older versions, use a raw query or a `Subquery` with a `[:3]` slice and `pk__in`. This is the classic "top-N per group" problem, also covered in [SQL · Top N Per Group](../sql/topic.html?p=34-problem-top-n-per-group) and [Ch 39](topic.html?p=39-orm-coding-challenges).

### 5.8 N+1 & optimization

**Q: What is the N+1 query problem, and how do you detect it?**
A: You load N objects with one query and then touch a relation on each one inside a loop or template (`{{ book.author.name }}`), which runs N more queries. It is invisible in development with ten rows and serious in production with ten thousand. To detect it: django-debug-toolbar's SQL panel (look for "similar/duplicate queries"), `connection.queries` with `DEBUG=True`, `assertNumQueries` in tests, `nplusone` or `django-zeal` in development, and APM traces in production that show the same SELECT repeated. See [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization).

**Q: What is the difference between `select_related` and `prefetch_related`?**
A: `select_related` follows **single-valued** relations (forward FK, OneToOne in either direction) with a SQL **JOIN**, so everything comes back in one query. `prefetch_related` handles **multi-valued** relations (M2M, reverse FK, GenericForeignKey) with **a separate query per relation**, `WHERE fk IN (...)`, and joins the results in Python, attaching them to each object's cache. A JOIN for to-many would duplicate the parent rows, which is why prefetch exists. Rule of thumb: "one" relation, use `select_related`; "many" relation, use `prefetch_related`; and you can combine them, as in `prefetch_related(Prefetch("books", queryset=Book.objects.select_related("publisher")))`.

```sql
-- select_related("author")
SELECT book.*, author.* FROM book INNER JOIN author ON book.author_id = author.id;
-- prefetch_related("tags")
SELECT * FROM book;
SELECT tag.*, book_tags.book_id FROM tag INNER JOIN book_tags ON ... WHERE book_tags.book_id IN (1, 2, 3, ...);
```

**Q: Why does my prefetch not work? I added `prefetch_related` but the queries are still there.**
A: The usual cause is calling a QuerySet method on the prefetched manager in the loop, such as `author.books.filter(published=True)` or `.order_by()`. The prefetch cache only answers `.all()`, so anything else is a new query. The fix is to push that condition into a `Prefetch` object, ideally with `to_attr`:

```python
authors = Author.objects.prefetch_related(
    Prefetch("books", queryset=Book.objects.filter(published=True).order_by("-year"),
             to_attr="published_books"))
for a in authors:
    a.published_books   # a plain list, no query
```

Other causes: the prefetch is applied to a different QuerySet object than the one you iterate, or a serializer accesses a field you did not prefetch.

**Q: When is `select_related` the wrong choice?**
A: When the JOIN is wide or deep and you do not need most of the columns, because you transfer far more data than necessary. When the joined table is huge and the join gets a bad plan. And it simply cannot be used on to-many relations. Calling `select_related()` with no arguments follows every non-null FK, which is rarely what you want. For a list page that shows only `author.name`, `select_related("author").only("title", "author__name")` keeps the payload small.

**Q: How do `bulk_create`, `bulk_update` and `update()` differ from calling `save()` in a loop?**
A: `save()` in a loop is one query per object plus signals. `bulk_create(objs, batch_size=...)` does a multi-row INSERT, `bulk_update(objs, ["field"])` does a `CASE WHEN` UPDATE, and `QuerySet.update()` runs a single UPDATE statement. All three **skip `save()`** and the `pre_save`/`post_save` signals, so any logic that lives in `save()` or a receiver does not run, and `auto_now` is not applied by `update()`. `bulk_create` sets PKs on PostgreSQL and supports `update_conflicts=True` (an upsert, 4.1+) and `ignore_conflicts=True`. A good answer mentions batching for memory, and that `bulk_update` is slower than people expect on very large sets. See [Ch 13](topic.html?p=13-queryset-optimization).

**Q: How do you process ten million rows without running out of memory? (Senior)**
A: Do not let the result cache hold them all. `qs.iterator(chunk_size=2000)` streams rows. On PostgreSQL it uses a server-side cursor, and it bypasses the result cache. `prefetch_related` works with `iterator()` only when you give a `chunk_size` (4.1+). Combine it with `values_list` or `only()` to shrink each row. For batch *updates*, iterate by primary-key ranges (keyset: `pk__gt=last_pk` ordered by pk, limited to a batch) so each batch is a short transaction, and avoid OFFSET pagination, which gets slower as the offset grows. Behind PgBouncer in transaction mode, server-side cursors break, so set `DISABLE_SERVER_SIDE_CURSORS=True`, and then key-range batching is the safe approach. See [Ch 13](topic.html?p=13-queryset-optimization) and [Ch 34](topic.html?p=34-scaling-databases).

**Q: How do you see the SQL a QuerySet will run?**
A: `print(qs.query)` shows an approximation: parameters are interpolated without proper quoting, so it is not always valid SQL. `qs.explain(analyze=True)` on PostgreSQL shows the real plan. `connection.queries` lists executed SQL when `DEBUG=True`. `sqlmigrate` shows migration SQL. For tests, `CaptureQueriesContext` or `assertNumQueries`. In production, `pg_stat_statements` and the slow-query log are where you actually find the problem.

### 5.9 Transactions & concurrency

**Q: How does Django handle transactions by default?**
A: Django runs in **autocommit** mode: each query commits as soon as it runs, unless you are inside `transaction.atomic()`. `atomic()` opens a transaction and commits on a normal exit or rolls back on an exception. Nested `atomic()` blocks create **savepoints**, so an inner failure rolls back only to the savepoint. `ATOMIC_REQUESTS = True` wraps every view in a transaction. It is easy, but it holds a transaction open for the whole request, including slow external calls. Most teams prefer explicit `atomic()` around the critical section. See [Ch 14 · Transactions & Concurrency](topic.html?p=14-transactions-concurrency).

**Q: What happens if you catch a database error inside an `atomic()` block?**
A: On PostgreSQL, a failed statement puts the transaction into an aborted state, and Django marks the block as needing rollback. Any further query in the same block raises `TransactionManagementError`. The correct pattern is to wrap the statement that might fail in its own nested `atomic()`, so the failure rolls back only that savepoint and the outer transaction stays usable:

```python
with transaction.atomic():
    order.save()
    try:
        with transaction.atomic():       # savepoint
            Coupon.objects.create(code=code, order=order)
    except IntegrityError:
        pass                              # outer transaction is still valid
```

**Q: What is `transaction.on_commit()`, and why is it important?**
A: It registers a callback that runs only after the outermost transaction commits successfully. If the transaction rolls back, the callback is discarded. The classic case is enqueueing a Celery task or sending an email. If you call `task.delay(order.id)` inside the transaction, the worker can pick it up before the commit and fail to find the row, or the transaction can roll back after the email has gone. `transaction.on_commit(lambda: send_receipt.delay(order.id))` closes that gap. In tests, `TestCase` never really commits, so use `captureOnCommitCallbacks(execute=True)`. See [Ch 14](topic.html?p=14-transactions-concurrency) and [Ch 31](topic.html?p=31-celery-background-tasks).

**Q: How do you prevent two requests from overselling the last item in stock? (Senior)**
A: There are three tools, depending on the logic. (1) A conditional atomic update when the rule fits in SQL: `Product.objects.filter(pk=pid, stock__gte=qty).update(stock=F("stock") - qty)`, and if it returns 0 rows, the item is sold out. This is a single statement with no explicit lock. (2) Pessimistic locking when you must read, decide in Python, then write: inside `atomic()`, `select_for_update()` locks the row until commit, so the second request waits. (3) A `CheckConstraint(condition=Q(stock__gte=0))` as the last line of defence. Lock rows in a consistent order (sort the ids) to avoid deadlocks, and keep network calls out of the locked section. See [Ch 14](topic.html?p=14-transactions-concurrency) and [Ch 40](topic.html?p=40-design-rounds).

**Q: What are the options of `select_for_update()`?**
A: It must run inside `atomic()`, or Django raises `TransactionManagementError`. `nowait=True` raises `DatabaseError` immediately if the row is locked instead of waiting. `skip_locked=True` skips locked rows, which is ideal for job queues where workers take different rows. `of=("self",)` restricts locking to certain tables when you use `select_related`. `no_key=True` (PostgreSQL) takes `FOR NO KEY UPDATE`, a weaker lock that does not block inserts of rows that reference this one. The QuerySet is evaluated lazily, so the lock is taken when it is evaluated, not when it is built.

**Q: Optimistic vs pessimistic locking in Django?**
A: Pessimistic locking (`select_for_update`) blocks other writers while you hold the lock. It is simple and correct but reduces throughput, and it can deadlock. Optimistic locking adds a `version` field and updates conditionally: `Doc.objects.filter(pk=pk, version=v).update(body=new, version=F("version") + 1)`. If 0 rows are updated, someone else won, and you re-read or return a 409 conflict to the client. Use optimistic locking when conflicts are rare and transactions are long, such as edits made through a UI. Use pessimistic locking when conflicts are common and the critical section is short, such as inventory or balances. See [REST API · Optimistic Locking](../rest-api/topic.html?p=28-concurrency-optimistic-locking).

**Q: What isolation level does Django use on PostgreSQL, and why does it matter?**
A: Django uses READ COMMITTED, the PostgreSQL default. Each statement sees data committed before that statement started, so two SELECTs in the same transaction can see different data, and read-check-write logic races unless you lock or use conditional updates. You can set `OPTIONS: {"isolation_level": ...}` to REPEATABLE READ or SERIALIZABLE. Those raise serialization failures that your code must catch and **retry**, which Django does not do for you. See [SQL · Isolation Levels](../sql/topic.html?p=26-isolation-levels).

### 5.10 Migrations

**Q: How do migrations work internally?**
A: `makemigrations` replays the existing migration files to build a **project state** in memory, compares it with your current models (the autodetector), and writes operations such as `AddField` and `AlterField` for the differences. It never looks at the database. `migrate` reads the `django_migrations` table to see what has been applied, builds the dependency graph, and runs each unapplied migration's operations as SQL. On PostgreSQL each migration runs in a transaction by default. Because the state comes from the files, editing an applied migration or deleting migrations creates drift between files and database. See [Ch 11 · Migrations](topic.html?p=11-migrations).

**Q: How do you write a data migration correctly?**
A: Use `migrations.RunPython(forwards, backwards)`, and inside the functions get models with `apps.get_model("app", "Model")`, the **historical** model, never a direct import. A directly imported model reflects today's code, which may have fields that do not exist yet at that point in the history, so the migration breaks later. Historical models also have no custom methods and use only managers marked `use_in_migrations`. Process large tables in batches, provide a reverse function (or `RunPython.noop`), and for large backfills consider a management command that runs outside the deploy's migration transaction.

**Q: Two developers created migrations `0005_a` and `0005_b` on different branches. What do you do?**
A: Both depend on `0004`, so the graph has two leaf nodes, and `migrate` refuses to run with a "conflicting migrations" error. Run `makemigrations --merge`, which creates a merge migration that depends on both. That is fine when the two touch unrelated fields. If they conflict, for example both alter the same field, resolve it by hand, or rebase one branch and regenerate its migration. CI should run `makemigrations --check --dry-run` to catch missing migrations.

**Q: What do `--fake` and `--fake-initial` do, and when are they appropriate?**
A: `--fake` records a migration as applied without running its SQL. It is for repairing state after you made a change by hand, and it is dangerous otherwise. `--fake-initial` skips an initial migration if all of its tables already exist, which helps when adopting Django on an existing database. Related commands: `showmigrations` (status), `sqlmigrate app 0007` (see the SQL; do this before running anything risky in production), `migrate app 0006` (roll back to 0006), `migrate app zero` (unapply everything), and `squashmigrations` (collapse a long history).

**Q: How do you add a NOT NULL column to a 100-million-row table without downtime? (Senior)**
A: Do it in expand-and-contract steps. (1) Add the column as nullable, or with `db_default` (5.0+), which PostgreSQL 11+ can add without rewriting the table. (2) Deploy code that writes the new column. (3) Backfill in batches with a management command, with short transactions and throttling. (4) Add the NOT NULL constraint. On PostgreSQL you can first add a `CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT`, which takes a weaker lock, then set NOT NULL. Create indexes with `AddIndexConcurrently` in a migration with `atomic = False`. Set `lock_timeout` so a migration that is stuck waiting for a lock does not queue up all other traffic behind it. Never rename a column in place while old code is running: add the new column, dual-write, switch reads, then drop the old one. See [Ch 11](topic.html?p=11-migrations) and [Database Design · Schema Evolution](../database-design/topic.html?p=27-schema-evolution).

**Q: What is `SeparateDatabaseAndState` used for? (Senior)**
A: It lets you change Django's migration *state* and the *database* separately. It is used when the two must diverge temporarily, or when the database already matches. Examples: moving a model to another app without dropping and recreating the table (state operations delete and create the model, database operations do nothing or rename), converting an auto-created M2M to an explicit `through` model, or adopting a table created by hand. It is powerful and easy to get wrong, so always check the result with `sqlmigrate` and a fresh `migrate` on an empty database.

### 5.11 Managers & model inheritance

**Q: What is a manager, and how do you write a custom one?**
A: A manager is the interface for table-level queries; `objects` is the default. Put reusable query logic in a custom **QuerySet** and expose it with `QuerySet.as_manager()` or `Manager.from_queryset()`. That way the methods can be chained: `Order.objects.paid().recent()`. Writing a `Manager` subclass alone only gives you methods that run first, at the start of the chain. Overriding `get_queryset()` in a manager changes its base set, for example to exclude soft-deleted rows. See [Ch 15 · Managers & Inheritance](topic.html?p=15-managers-model-inheritance).

```python
class OrderQuerySet(models.QuerySet):
    def paid(self):
        return self.filter(status=Order.Status.PAID)
    def for_user(self, user):
        return self.filter(customer=user)

class Order(models.Model):
    objects = OrderQuerySet.as_manager()
```

**Q: What is the danger of overriding the default manager to filter rows, for example for soft delete?**
A: The first manager defined on a model becomes `_default_manager`. Django uses it in places such as `dumpdata`, admin and some generic code. Related-object access uses `_base_manager`, which is a plain `Manager` and does *not* apply your filter. So if `objects` hides deleted rows, `order.customer` can still return a soft-deleted customer, and uniqueness still covers deleted rows. Safer: keep `objects` unfiltered, add `active = ActiveManager()` explicitly, or make the soft-delete visible everywhere with partial unique constraints (`UniqueConstraint(..., condition=Q(deleted_at__isnull=True))`).

**Q: Compare abstract base classes, multi-table inheritance and proxy models.**
A: An **abstract** base (`Meta.abstract = True`) creates no table and copies its fields into each child's table. This is the usual choice for shared columns such as timestamps. **Multi-table** inheritance creates a table for the parent and for each child, linked by an implicit `OneToOneField` (`parent_link`). Every child query joins to the parent, and every save writes two tables, so it gets expensive and is rarely the right design. **Proxy** models (`Meta.proxy = True`) share the parent's table and change only Python behaviour: managers, methods, admin, ordering. They are useful for showing filtered views in the admin. See [Ch 15](topic.html?p=15-managers-model-inheritance).

**Q: When would you actually choose multi-table inheritance? (Senior)**
A: Rarely. It fits when you genuinely need to query across all subtypes through the parent table with shared FKs pointing at it, for example a `Payment` parent that a refund FK references, with `CardPayment` and `BankPayment` children that each have very different columns. The costs are a JOIN on every child query, a downcasting problem (from a `Payment` you cannot easily get the concrete subclass without `django-polymorphic` or a type column), and two-table writes. Alternatives: a single table with nullable type-specific columns plus a `CheckConstraint` per type, a JSONField for the variable part, or separate tables with a GFK or a union view. Say which one you would pick and why.

### 5.12 Signals

**Q: What are Django signals, and are they asynchronous?**
A: Signals are an in-process observer pattern: senders call `signal.send()`, and every connected receiver runs. They are **synchronous**. Receivers run in the same thread and the same database transaction as the sender, before `save()` returns. A slow receiver slows the request, and an exception in a receiver propagates up to the sender and can roll back its transaction (`send_robust` catches exceptions). Register receivers in `AppConfig.ready()`, and use `dispatch_uid` to avoid connecting the same receiver twice. Async support (`asend`) arrived in 5.0, but it still does not make them background tasks. See [Ch 19 · Signals](topic.html?p=19-signals).

**Q: When should you use signals, and when should you avoid them?**
A: Use them for **decoupling** when the sender cannot know about the receiver: reacting to a third-party app's model (creating a `Profile` when `User` is created), or invalidating a cache on save. Avoid them for your own business logic. They hide control flow (someone reading `order.save()` has no idea it sends email), they do not fire for `update()`, `bulk_create()` or raw SQL, and they make ordering and transactions hard to reason about. Prefer an explicit service function (`place_order()`) that does the work and calls `on_commit` for side effects.

**Q: Which ORM operations do *not* send `post_save`?**
A: `QuerySet.update()`, `bulk_create()`, `bulk_update()`, raw SQL, and fixture loading with `raw=True` (the receivers get `raw=True` and should usually skip). `QuerySet.delete()` *does* send `pre_delete` and `post_delete` for each collected object, unless Django can fast-delete because no signals or cascades are involved. `m2m_changed` fires for `.add()`, `.remove()`, `.clear()` and `.set()`, not `post_save`. That is why a receiver on M2M data needs `m2m_changed` with `action="post_add"`.

### 5.13 Admin

**Q: How do you customise the Django admin?**
A: Use `ModelAdmin` options: `list_display`, `list_filter`, `search_fields`, `readonly_fields`, `fieldsets`, `inlines` (Tabular or Stacked), `actions` for bulk operations, `prepopulated_fields`, and `get_queryset()` for row-level scoping. You can override `save_model()`, `has_change_permission()` and similar hooks, as well as templates. Remember that the admin is an internal tool for trusted staff. It is not a customer-facing CRUD builder, and access should be locked down (2FA, a non-obvious URL, network restrictions). See [Ch 07 · The Django Admin](topic.html?p=07-django-admin).

**Q: The admin change list for a 50-million-row table takes 30 seconds. How do you fix it? (Senior)**
A: Work through the usual causes. (1) The paginator's `COUNT(*)`: use a custom paginator that estimates the count, or set `show_full_result_count = False`. (2) N+1 from `list_display` showing FKs: set `list_select_related`. (3) FK dropdowns on the change form that load millions of options: `raw_id_fields` or `autocomplete_fields`. (4) `search_fields` with `icontains` across joins: limit the fields, use `^` (startswith) prefixes, or add trigram indexes. (5) `list_filter` on high-cardinality fields builds large lists. (6) Ordering on an unindexed column. Profile with the debug toolbar, which works in the admin. See [Ch 07](topic.html?p=07-django-admin).

**Q: What is the difference between `list_select_related` and overriding `get_queryset`?**
A: `list_select_related` is a shortcut that applies `select_related` to the change list only. `get_queryset()` is the general hook: you can add `prefetch_related`, annotations (so a column like "order count" comes from one query instead of one per row), and permission filtering (`qs.filter(tenant=request.user.tenant)`). Annotations in `get_queryset` combined with a method in `list_display` that sets `ordering` make computed columns sortable.

### 5.14 Middleware (core pipeline)

**Q: How do you write a custom middleware?**
A: Write a factory that receives `get_response` once at start-up and returns a callable that receives each request:

```python
import time, logging
log = logging.getLogger(__name__)

class TimingMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response          # runs once per process

    def __call__(self, request):
        start = time.perf_counter()               # request phase
        response = self.get_response(request)     # inner layers + view
        response["Server-Timing"] = f"app;dur={(time.perf_counter()-start)*1000:.1f}"
        return response                           # response phase
```

Optional hooks are `process_view`, `process_exception` and `process_template_response`. Add it to `MIDDLEWARE`; its position decides what it can see. See [Ch 18 · Middleware](topic.html?p=18-middleware).

**Q: Why does middleware order matter? Give an example.**
A: Request handling runs top to bottom and responses run bottom to top, and each middleware depends on what has run before it. `AuthenticationMiddleware` reads the session, so it must come after `SessionMiddleware`. `SecurityMiddleware` goes first so that HTTPS redirects happen before any work is done. Per-site caching needs `UpdateCacheMiddleware` first and `FetchFromCacheMiddleware` last. If your middleware needs `request.user`, it must come after `AuthenticationMiddleware`.

## 6. Advantages, Disadvantages & Trade-offs

The same question gets graded differently at each level. Use this table to aim your answer.

| Topic | Junior answer (passes screening) | Mid answer (passes technical) | Senior answer (gets the offer) |
|---|---|---|---|
| Request lifecycle | URL to view to template | Middleware order, `as_view()`, `dispatch()` | `BaseHandler.load_middleware`, short-circuiting, WSGI vs ASGI and sync/async adaptation |
| `null` vs `blank` | DB vs form | No `null` on strings; the unique-string exception | Constraints as invariants; `full_clean()` is not called by `save()` |
| QuerySets | "They're lazy" | Triggers for evaluation, result cache, `.all()` clones | `sql.Query`, compiler, `_fetch_all`, iterator and server-side cursors |
| N+1 | "Use select_related" | `select_related` vs `prefetch_related`, `Prefetch(to_attr)` | Detecting it in CI with `assertNumQueries`, JOIN explosion vs IN-list size, plan analysis |
| Aggregation | `Count`, `Sum` | `annotate` vs `aggregate`, the `values()` position | JOIN multiplication; Subquery fix; window functions |
| Transactions | "Use atomic" | Savepoints, `on_commit`, `select_for_update` | Lock ordering, isolation and retries, optimistic vs pessimistic choice |
| Migrations | `makemigrations` / `migrate` | Conflicts, `RunPython` with `apps.get_model` | Zero-downtime expand/contract, lock timeouts, concurrent indexes |
| Signals | "Run code on save" | Synchronous; registered in `ready()` | Why to avoid them for domain logic; `on_commit`; bypass paths |

### When to use this chapter

- Use it the week before an interview: read a section, cover the answers, answer aloud, then compare.
- Use it after reading the concept chapters, as a self-test of whether you can *explain* the material and not only recognise it.
- Use it to prepare interviewers: the follow-ups in §8 and §9 make good probing questions.

### When NOT to use this chapter

- Don't use it as a first introduction. Each answer is compressed, and the linked chapter is where you actually learn the topic.
- Don't memorise answers word for word. Interviewers notice recited answers and immediately ask an unusual follow-up. Learn the mechanism instead.
- For DRF, security, async, Celery and scaling, go to [Ch 38](topic.html?p=38-interview-drf-advanced).

## 7. Common Mistakes & Best Practices

These are the mistakes candidates make when *answering*, as opposed to when coding.

- **Reciting the docs without the why.** "`select_related` follows foreign keys" is true and earns nothing. Add *why* (to avoid N+1 queries), *how* (a JOIN) and *when not* (to-many relations, wide joins).
- **Saying "Django handles it" for concurrency.** It does not. Django runs in autocommit with no locking. If you claim `save()` is safe under concurrency, expect a follow-up that shows the lost update.
- **Mixing up `select_related` and `prefetch_related`.** Use the memory aid "select = SQL JOIN = single object; prefetch = Python join = plural".
- **Forgetting that bulk operations bypass `save()` and signals.** This is the follow-up interviewers ask most often to "you put the logic in `save()`" or "you used a `post_save` signal".
- **Claiming `null=True` on a CharField is fine.** It shows you have not dealt with data that has both NULL and `""`.
- **Not giving query counts.** "That's 1 + N queries, with `prefetch_related` it's 2" is concrete and checkable. "It's faster" is neither.
- **Talking for five minutes.** Stop after about 90 seconds. Let the interviewer steer, because they have a rubric and you are using up their time.
- **Bluffing about internals.** "I believe `get()` adds a LIMIT so it can detect multiple rows. I'd confirm with `qs.query`" is better than inventing a class name.
- **Ignoring the version.** Mention it when it matters: native connection pooling in 5.1, `db_default` in 5.0, filtering on window functions in 4.2, async ORM methods in 4.1. Staying current is a real signal.

Best practice for any ORM question: say the SQL. Before and after, compare:

```text
Weak:   "I'd optimize it with select_related."
Strong: "Right now that's 1 query for orders + 1 per order for customer, so 51 for a page of 50.
         select_related('customer') makes it one JOIN. Items are reverse FK, so prefetch_related('items')
         adds one IN query: 2 queries total, and I'd pin that with assertNumQueries(2)."
```

## 8. Production: Pitfalls, Debugging & Scaling

### Tricky and gotcha questions

These questions are designed to catch candidates who know the API but not how it behaves. Each one is a real production bug in disguise.

**Q: `if queryset:` versus `if queryset.exists():` — which is better?**
A: It depends on what comes next. `if queryset:` evaluates the *whole* QuerySet and fills the cache, which is wasteful if you only wanted to know whether it is empty, but ideal if you then loop over it, because the loop reuses the cache. `exists()` is a cheap `LIMIT 1` query, but a following loop runs a second, full query. Choose based on whether you will use the rows.

**Q: Why does `Book.objects.all()[0]` inside a loop run a query every iteration?**
A: Indexing an *unevaluated* QuerySet compiles to `LIMIT 1 OFFSET n` and runs immediately without filling the result cache. Each `qs[0]` is a new query. Evaluate first (`books = list(qs)`) and index the list, or use `first()` once outside the loop.

**Q: A colleague overrode `save()` to update `slug`, but some rows have empty slugs. Why?**
A: Those rows were written by a path that skips `save()`: `QuerySet.update()`, `bulk_create()`, `bulk_update()`, a data migration using historical models (which have no custom `save()`), raw SQL, or a fixture load. If the slug must always exist, make the column non-blank at the DB level with a `CheckConstraint`, and set it in every write path. Better still, generate it in one service function.

**Q: Why does `Author.objects.annotate(n=Count("books")).order_by("name")` return each author several times when you add `.values("name", "books__title")`?**
A: `values()` *after* `annotate()` selects columns, and including a to-many path (`books__title`) adds a JOIN and makes each book a separate row. Every combination of author and book becomes its own row, and the GROUP BY now includes the book title. Decide what you want: either one row per author (drop the to-many column), or a flat list of rows (drop the annotation).

**Q: You set `CONN_MAX_AGE` and now see "server closed the connection unexpectedly" errors. Why?**
A: With persistent connections, Django reuses a connection across requests, and something in between (PgBouncer, a load balancer, the database's idle timeout) has closed it in the meantime. Set `CONN_HEALTH_CHECKS = True` (4.1+) so Django checks the connection before reuse, keep `CONN_MAX_AGE` below the proxy's idle timeout, or use the native pool (5.1+) or PgBouncer. See [Ch 34](topic.html?p=34-scaling-databases).

**Q: You prefetched `items`, so why does `order.items.filter(shipped=True).count()` in a template still run a query per order?**
A: The prefetch stores an evaluated QuerySet for `order.items.all()`. A plain `order.items.count()` or `.exists()` is answered from that cache, because `count()` on an evaluated QuerySet returns `len(_result_cache)`. Adding `.filter()`, `.exclude()` or `.order_by()` creates a new QuerySet with no cache, so you get one `COUNT(*)` per order, which is an N+1. Fix it by annotating in the main query (`annotate(n_shipped=Count("items", filter=Q(items__shipped=True)))`), or with `Prefetch("items", queryset=Item.objects.filter(shipped=True), to_attr="shipped_items")` and `len()`. Verify with the debug toolbar rather than assuming.

**Q: Why does `Model.objects.filter(created__date=today)` miss rows or not use your index?**
A: With `USE_TZ=True`, the `__date` lookup converts the timestamp to the current time zone before taking the date. The SQL wraps the column in a function, so a plain B-tree index on `created` cannot be used, and the result depends on the active time zone. Filter on a range instead: `created__gte=start_of_day, created__lt=start_of_next_day`, both aware datetimes. That is index-friendly and has explicit time-zone handling.

**Q: Why is `exclude(tags__name="x")` slower and different from what you expected?**
A: `exclude()` across a multi-valued relation means "has no tag named x", and Django compiles it to a `NOT IN` / `NOT EXISTS` subquery, not to `tags.name != 'x'` on a JOIN. That is usually the semantics you want, but it surprises people who expected the JOIN version (which would wrongly keep rows that have both "x" and another tag). Use `~Exists(...)` explicitly when you want control over the plan.

### Debugging toolkit to mention in interviews

| Symptom | First tool | What you are looking for |
|---|---|---|
| Slow page | django-debug-toolbar SQL panel | Duplicate queries (N+1), slow single queries |
| Slow query | `qs.explain(analyze=True)` | Seq scan on a big table, a sort spilling to disk, bad row estimates |
| Query regression | `assertNumQueries` in tests | A count that crept up in a PR |
| Production hot spots | `pg_stat_statements`, APM (Sentry, Datadog) | Highest total time, not only highest mean |
| Lock waits | `pg_locks` / `pg_stat_activity` | Long-running transactions holding row locks |
| Migration risk | `sqlmigrate`, a `lock_timeout` setting | Table rewrites, ACCESS EXCLUSIVE locks |

> **Production story:** A team added `ordering = ["-created"]` to `Meta` on a 40M-row events table "for the admin". Every `Event.objects.filter(user=u)[:20]` began sorting on `created`, and there was no `(user, created)` index, so p95 went from 8 ms to 900 ms. The fix was a composite index and removing the default ordering. Mention this when someone asks about `Meta.ordering`.

### Scaling notes for ORM-heavy answers

- Count queries per request and per page, and set a budget enforced in CI.
- A big IN list from `prefetch_related` (tens of thousands of ids) can be slower than a JOIN. Paginate first.
- `count()` on huge PostgreSQL tables is a sequential scan. Use estimates (`pg_class.reltuples`) or cursor pagination.
- Heavy reporting queries belong on a replica (`.using("replica")`) or in a warehouse. See [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases).

## 9. Interview Questions

These are the hardest follow-ups, the ones that come third or fourth in a chain. Each one is tagged Senior.

**Q: Trace `list(Book.objects.filter(author__name="Ann").select_related("author")[:10])` from Python to model instances. (Senior)**
A: `Book.objects` is a manager that returns a `QuerySet` wrapping a `sql.Query`. `filter()` clones the QuerySet and adds a `WhereNode` with a lookup resolved through `_meta` (the JOIN to author is created by `setup_joins`). `select_related` sets `query.select_related`, and the slice sets `low_mark` and `high_mark`. Nothing has run yet. `list()` calls `__iter__`, then `_fetch_all()`, which runs `ModelIterable`. That calls `query.get_compiler(using=db)`, and `SQLCompiler.as_sql()` builds the SQL and params (`SELECT ... INNER JOIN author ... WHERE author.name = %s LIMIT 10`). `execute_sql()` sends it through the DB-API cursor. For each row, `ModelIterable` builds a `Book` with `from_db()` and fills the related `Author` instance into the field cache. Results go into `_result_cache`. Being able to name the compiler and `from_db` shows you have read the source. See [Ch 36 · Internals](topic.html?p=36-django-internals).

**Q: How does `prefetch_related` work internally, and what are its limits? (Senior)**
A: After the main QuerySet is evaluated, `prefetch_related_objects()` walks the lookups. For each one it asks the relation descriptor for a `get_prefetch_queryset(s)` (for example, `ReverseManyToOneDescriptor` returns `Book.objects.filter(author__in=instances)`). It runs that one query, groups the results by the join key in Python, and stores them in each instance's `_prefetched_objects_cache` (or as a list on `to_attr`). Nested lookups (`books__tags`) repeat this one level down. Limits: a large IN list; the cache is answered only for `.all()`; memory use is proportional to all the related rows; and a `Prefetch` queryset with slicing was only supported from 4.2 (using a window function).

**Q: Two concurrent transfers between the same two accounts deadlock. Explain and fix. (Senior)**
A: Transfer A locks account 1 then requests 2, while transfer B locks 2 then requests 1. Each waits for the other, and PostgreSQL detects the cycle and aborts one with a deadlock error. The fix is to lock in a **consistent order**: `Account.objects.select_for_update().filter(pk__in=sorted([a, b])).order_by("pk")`, evaluated in one statement inside `atomic()`. Then the debit and credit use `F()` updates. Also keep transactions short with no network calls inside, and retry the aborted transaction, since deadlock aborts are safe to retry. See [Ch 14](topic.html?p=14-transactions-concurrency).

**Q: A `post_save` receiver sends an email, and users sometimes get emails for orders that don't exist. Why? (Senior)**
A: `post_save` fires inside the transaction, before the commit. If the outer transaction later rolls back (a payment failure, or `ATOMIC_REQUESTS` with an exception afterwards), the email has already gone out for a row that never existed. If the receiver enqueues a Celery task instead, the worker may run before the commit and find nothing. Fix: `transaction.on_commit(lambda: send_email.delay(order.pk))` inside the receiver or, better, in an explicit service function. For at-least-once delivery across crashes, use an outbox table written in the same transaction. See [Ch 19](topic.html?p=19-signals) and [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

**Q: How do you enforce "a user can have only one active subscription" reliably? (Senior)**
A: Not with an `exists()` check followed by `create()`, which races. Use a partial unique constraint: `UniqueConstraint(fields=["user"], condition=Q(status="active"), name="one_active_sub_per_user")`. The database rejects the second active row atomically. In code, catch `IntegrityError` (inside a nested `atomic`) and return a clean error. Since 4.1, `full_clean()` validates constraints too, so forms show a friendly message. The general principle: invariants live in the database, and application checks only improve the error message. See [Ch 16 · Indexes, Constraints & PostgreSQL](topic.html?p=16-database-features-postgres).

**Q: A page made 3 queries yesterday and 400 today, with no change to the view. How do you find the cause? (Senior)**
A: Something outside the view changed which attributes are accessed. Likely candidates: a template or serializer that now shows a new relation (`{{ item.product.brand }}`), a model `__str__` that touches an FK (used by the admin or logs), a property that queries, a context processor, or `only()` deferring a field the template now reads. I'd reproduce it with the debug toolbar, look at the repeated SQL, which shows the table, and use the stack trace option to find the line. Then I'd fix it with `select_related`/`prefetch_related` and add `assertNumQueries` so it cannot regress silently. For PRs, the `git log` of templates, serializers and models is often faster than profiling.

**Q: How would you implement soft delete correctly? (Senior)**
A: Add a `deleted_at` field, a custom QuerySet with `alive()`/`dead()`, and a `delete()` override on the QuerySet and the model that sets `deleted_at` (and a real `hard_delete()`). Make it safe: (1) uniqueness becomes partial (`condition=Q(deleted_at__isnull=True)`); (2) related access through `_base_manager` still sees deleted rows, so decide whether that is acceptable; (3) cascades are now your responsibility; (4) indexes should be partial on alive rows; (5) for privacy compliance (GDPR), soft delete is not deletion, so you also need a purge job. Many teams use an archive table instead, because then "deleted" really means gone from the hot table.

**Q: `count()` on a 200-million-row table takes 20 seconds. What do you do? (Senior)**
A: PostgreSQL's MVCC means `COUNT(*)` must check row visibility, which is effectively a scan; an index-only scan helps only if the visibility map is current. Options: avoid exact counts (cursor pagination, "50+" UI), use the planner's estimate (`SELECT reltuples FROM pg_class WHERE relname=...`) for unfiltered totals, maintain a counter table updated with `F()` or triggers, or cache the count with a TTL. For filtered counts, a matching partial index can make it fast enough. In the admin, `show_full_result_count = False` and a custom paginator. See [Ch 13](topic.html?p=13-queryset-optimization).

**Q: Explain `select_for_update()` with `select_related` and the `of=` argument. (Senior)**
A: `select_for_update()` on a joined query locks rows in *all* joined tables by default, which can lock far more than intended. For example, locking an order also locks its customer row, and other order operations for that customer then queue up behind it. `of=("self",)` restricts the lock to the base table's rows. On PostgreSQL, rows on the nullable side of an outer join cannot be locked, so Django requires `of=` in that case. Combine with `no_key=True` when you only update non-key columns, so inserts of child rows that reference the locked row are not blocked.

**Q: How do you make a migration that renames a heavily used column with zero downtime? (Senior)**
A: Don't rename in place. Old pods running during the rollout would query the old name and fail. Use expand and contract: (1) add the new column (nullable), (2) deploy code that writes both columns and still reads the old one, (3) backfill in batches, (4) deploy code that reads the new column, (5) stop writing the old one, (6) drop it in a later release. If you only want the Python name changed, set `db_column="old_name"` on the renamed field; that is a state-only change with no database operation. See [Ch 11](topic.html?p=11-migrations).

**Q: When does the ORM stop being the right tool, and what do you use instead? (Senior)**
A: When the query needs features the ORM cannot express cleanly (recursive CTEs, complex lateral joins, vendor-specific hints), when the ORM's generated SQL gets a bad plan and you need exact control, or for bulk ETL where building model instances is the bottleneck. Step down gradually: expressions and `Func` subclasses, then `RawSQL` inside annotations, then `Model.objects.raw()` (which still maps to instances), then `connection.cursor()` with **parameters, never f-strings**. Keep raw SQL in one module with tests, so schema changes break tests and not production. See [Ch 16](topic.html?p=16-database-features-postgres).

**Q: How do you design a `Meta`/constraint set for an `OrderItem` table that will get 1 billion rows? (Senior)**
A: Start from the queries. "Items of an order" means an index on `order_id` (Django creates FK indexes automatically). "Units sold per product per day" probably goes to a reporting replica or rollup table, not to `OrderItem` directly. Constraints: `CheckConstraint(condition=Q(quantity__gt=0))` and a unique `(order, product)` if that is the business rule. A BigAutoField pk, no `Meta.ordering`, `DecimalField` for money (never float), and a `unit_price` stored on the row (a price snapshot, not a JOIN to the current price). At that scale also plan for partitioning by time, which Django does not manage, so you would use migrations with `RunSQL` or a library, and keep FKs into the partitioned table to a minimum. See [Database Design · Partitioning](../database-design/topic.html?p=11-partitioning).

**Q: How would you test that a view is free of N+1 regardless of page size? (Senior)**
A: Write the test at two sizes, so a hidden per-row query shows up as a difference. Create 2 rows and capture the query count, then create 20 and assert the count is the same. With `assertNumQueries(n)` at one size, an N+1 is only caught if the size is large enough. With pytest-django, use `django_assert_num_queries` or `django_assert_max_num_queries`. Use `setUpTestData` or factories for the data, and include the related objects the serializer or template touches.

## 10. Quick Revision & Cheat Sheet

| Question | 10-second answer |
|---|---|
| MVT vs MVC | View = controller; template = view; URLconf dispatches |
| `null` vs `blank` | DB vs validation; no `null` on strings |
| `get` vs `filter` | One object or raise vs lazy QuerySet |
| `exists` vs `count` | `LIMIT 1` vs `COUNT(*)`; `len()` if you will use the rows |
| QuerySet evaluation | iter, `list`, `len`, `bool`, `repr`, step-slice, pickle |
| `select_related` vs `prefetch_related` | JOIN for FK/O2O vs IN query for M2M/reverse FK |
| Prefetch re-query | `.filter()` on the manager defeats it; use `Prefetch(to_attr=)` |
| `F()` | DB-side value; atomic `update(stock=F("stock")-1)` |
| `Q()` | OR/NOT/dynamic filters |
| `annotate` vs `aggregate` | Per row (GROUP BY) vs one dict |
| Two `Count`s wrong | JOIN multiplication; `distinct=True` or Subquery |
| Bulk ops | Skip `save()` and signals |
| `save()` | `pre_save`, UPDATE else INSERT, writes all fields, `post_save`, no `full_clean` |
| Default transactions | Autocommit; `atomic` with savepoints |
| `on_commit` | Enqueue tasks and emails only after commit |
| Oversell | Conditional `F()` update, or `select_for_update` plus lock order |
| Data migration | `RunPython` with `apps.get_model` |
| Zero-downtime column | Expand, backfill, contract; `db_default`; concurrent indexes |
| Signals | Synchronous, same transaction, register in `ready()` |
| Inheritance | Abstract (no table), MTI (JOIN), proxy (same table) |

**Remember this**

- Say the query count and the SQL. That is the most convincing evidence you can give.
- Laziness and caching: chaining is free, evaluation runs a query, and the cache lives on that QuerySet instance.
- "One" relation, `select_related`; "many" relation, `prefetch_related`; anything other than `.all()` on a prefetched relation runs a query.
- Anything that bypasses `save()` bypasses your `save()` logic and signals.
- Correctness under concurrency comes from the database: constraints, conditional updates, row locks.
- Side effects go in `on_commit`, never inline in a transaction.
- Migrations compare models to the migration *files*, not to the database.
- Every invariant that must hold belongs in a constraint; `clean()` only gives a better error message.

## 11. Hands-On Exercises

Set up a scratch project: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" django-debug-toolbar psycopg[binary]`, then `django-admin startproject mock . && python manage.py startapp shop`.

1. **Lifecycle drill.** Without notes, draw the request-lifecycle diagram from §4 in 60 seconds. Then add a middleware that logs `request.path` in its request phase and the status code in its response phase, and confirm the order by adding a second middleware.
2. **N+1 hunt.** Create `Author`, `Book` (FK) and `Tag` (M2M), and seed 50 books. Write a template loop that shows author and tags. Read the query count from the debug toolbar, fix it with `select_related` plus `Prefetch(to_attr=...)`, and lock it in with `assertNumQueries` at two data sizes.
3. **Wrong count.** Add `Award` (FK to Author). Annotate both `Count("books")` and `Count("awards")`, show the inflated numbers, then fix them with `distinct=True` and with the `Subquery` version. Compare the SQL with `print(qs.query)`.
4. **Race it.** Write a view that decrements stock with read-modify-write and fire 50 concurrent requests (`xargs -P 20 curl`). Observe the oversell, then fix it with the conditional `F()` update, and again with `select_for_update`.
5. **Migration conflict.** On two git branches, add different fields and create a migration on each. Merge the branches, see the conflict, and resolve it with `makemigrations --merge`. Then write a `RunPython` backfill using `apps.get_model`.
6. **Signal trap.** Add a `post_save` receiver that prints. Call `save()`, `update()` and `bulk_create()`, and note which ones fire it. Then move the side effect into `on_commit` and roll back a transaction to prove it does not run.

### Mock-interview drills

- **Rapid fire (10 minutes):** a partner reads 20 random questions from §5. You get 30 seconds for each. Score 1 point for the direct answer and 1 for the why.
- **Follow-up ladder (15 minutes):** start with "select_related vs prefetch_related?" and have your partner ask "why?" four times in a row. Go on to internals, then to failure modes.
- **Whiteboard (5 minutes):** "What happens when I hit /orders/7/?" Draw it, name every component, and stop at 90 seconds.
- **Incident (10 minutes):** "Our order list p95 went from 80 ms to 2 s after Tuesday's deploy." Walk through the debugging method out loud.

### Mini project

Build a small "library" app with the models above, and write a `tests/test_interview.py` file with one test for each classic gotcha: lazy evaluation (`assertNumQueries(0)` while chaining), prefetch re-query, JOIN multiplication, bulk ops skipping signals, the `on_commit` rollback, and `get_or_create` with and without a unique constraint under threads (`TransactionTestCase`). Each test shows the behaviour as a failing assertion first, then the fix. This repository is a strong thing to talk about in an interview.

## 12. Related Topics & Free Learning Resources

**Concept chapters each answer comes from:**

- [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) — MVT, handlers, the lifecycle whiteboard.
- [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) — apps, `ready()`, settings, commands.
- [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing) — `path`, converters, `reverse`, namespaces.
- [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses) — FBVs and response classes.
- [Ch 05 · Django Template Language](topic.html?p=05-templates) — inheritance, autoescape, context processors.
- [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) — validation order, `commit=False`.
- [Ch 07 · The Django Admin](topic.html?p=07-django-admin) — customisation and performance.
- [Ch 08 · Models & Fields](topic.html?p=08-models-fields) — `null`/`blank`, choices, `Meta`, `save()`.
- [Ch 09 · Relationships](topic.html?p=09-relationships) — `on_delete`, `related_name`, `through`, GFK.
- [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) — laziness, caching, lookups.
- [Ch 11 · Migrations](topic.html?p=11-migrations) — autodetector, data migrations, zero downtime.
- [Ch 12 · Aggregation, Annotation, Subqueries & Window Functions](topic.html?p=12-aggregation-annotation-subqueries) — GROUP BY, Subquery, windows.
- [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) — select/prefetch, only/defer, bulk, iterator.
- [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) — atomic, savepoints, locks, `on_commit`.
- [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance) — managers, MTI, proxy.
- [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) — constraints as invariants, raw SQL.
- [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views) — `as_view()`, `dispatch()`, MRO.
- [Ch 18 · Middleware](topic.html?p=18-middleware) — order and hooks.
- [Ch 19 · Signals](topic.html?p=19-signals) — synchronous receivers and pitfalls.
- [Ch 34 · Scaling Django](topic.html?p=34-scaling-databases) — connections, replicas.
- [Ch 36 · Django Internals](topic.html?p=36-django-internals) — `ModelBase`, compiler, settings.
- Next rounds: [Ch 38 · DRF, Security & Scale questions](topic.html?p=38-interview-drf-advanced), [Ch 39 · ORM Coding Round](topic.html?p=39-orm-coding-challenges), [Ch 40 · Design Rounds](topic.html?p=40-design-rounds).

**Other handbooks:** [SQL · Isolation Levels](../sql/topic.html?p=26-isolation-levels), [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans), [SQL · Indexes](../sql/topic.html?p=19-indexes), [Database Design · MVCC](../database-design/topic.html?p=03-mvcc), [Database Design · Schema Evolution](../database-design/topic.html?p=27-schema-evolution), [REST API · Optimistic Locking](../rest-api/topic.html?p=28-concurrency-optimistic-locking).

**Free resources**

- **Django documentation: Making queries** — Django Project · *Beginner* · the reference for lookups, laziness, Q and F. https://docs.djangoproject.com/en/5.2/topics/db/queries/
- **Django documentation: Database access optimization** — Django Project · *Intermediate* · the official checklist behind half of the ORM questions. https://docs.djangoproject.com/en/5.2/topics/db/optimization/
- **Django documentation: QuerySet API reference** — Django Project · *Intermediate* · exactly what each method does and when it evaluates. https://docs.djangoproject.com/en/5.2/ref/models/querysets/
- **Django documentation: Database transactions** — Django Project · *Intermediate* · atomic, savepoints, `on_commit`, autocommit. https://docs.djangoproject.com/en/5.2/topics/db/transactions/
- **Django documentation: Migrations** — Django Project · *Intermediate* · how the autodetector and historical models work. https://docs.djangoproject.com/en/5.2/topics/migrations/
- **Django source code** — GitHub · *Advanced* · read `django/db/models/query.py` and `sql/compiler.py` once, and every internals question gets easier. https://github.com/django/django
- **django-debug-toolbar** — Jazzband · *Beginner* · the tool to demo when they ask how you find N+1 queries. https://github.com/jazzband/django-debug-toolbar
- **Classy Class-Based Views** — ccbv.co.uk · *Intermediate* · the MRO and method list for every generic view, the best preparation for CBV questions. https://ccbv.co.uk/

---

*Django Handbook — chapter 37.*
