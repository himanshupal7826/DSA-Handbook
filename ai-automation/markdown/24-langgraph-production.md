# 24 · LangGraph in Production: Checkpoints & Human-in-the-Loop

> **In one line:** Give a LangGraph graph a **checkpointer** and every super-step is saved under a **thread id**, so runs survive crashes, conversations continue across requests, a node can **pause for a human** with `interrupt()` and resume days later in another process, and you can **rewind and fork** any run. Swap SQLite for Postgres, wrap it in an API, and your agent is a durable service.

> **Versions used:** Python 3.13 · langgraph 1.2 · langgraph-checkpoint 4.3 · langgraph-checkpoint-sqlite 3.1 · langgraph-checkpoint-postgres 3.2 · psycopg 3.3 · langchain 1.5 (middleware example) · fastapi 0.16x · **Fast-moving:** checkpointer packages have their own major versions and table migrations; durability modes, node timeouts and `version="v2"` outputs are recent; the hosted offering was renamed from LangGraph Platform to **LangSmith Deployment** and its CLI and pricing change often. Pin everything and run `setup()` migrations deliberately.

---

## 1. Overview

> **Builds on:** [Ch 23 · LangGraph: State, Nodes & Edges](topic.html?p=23-langgraph-fundamentals) (graphs, reducers, `Command`), [Ch 22 · Agent Memory](topic.html?p=22-agent-memory-mem0) (threads vs long-term stores), [Ch 21 · Agent Patterns](topic.html?p=21-agent-patterns) (approval gates, stop reasons) and [Ch 04 · Function Calling](topic.html?p=04-function-calling) (side-effect tools need confirmation and idempotency).

The Ch 23 graphs live in RAM. If the process dies halfway through, the run is gone. If a refund needs a manager's approval, the only option is to block a thread with `input()`. If a user comes back tomorrow, the conversation has to be re-sent by the client. None of that is acceptable in production.

One argument to `compile()` fixes all of it: `checkpointer=`. With a checkpointer, LangGraph saves a **checkpoint** (the full state plus what runs next) after every super-step, keyed by `thread_id`. Everything in this chapter builds on that:

```mermaid
sequenceDiagram
    participant C as Client (UI, n8n, Slack)
    participant API as Your API (FastAPI)
    participant G as Compiled graph
    participant DB as Checkpointer (Postgres)
    participant H as Human approver
    C->>API: POST /refunds (order 881)
    API->>G: invoke(input, thread_id=refund-881)
    G->>DB: checkpoint after each super-step
    G-->>API: __interrupt__ {amount: 240, allowed: approve/reject/edit}
    API-->>C: 201 status=pending_approval
    Note over G,DB: process can exit, deploy, crash. State is in the DB.
    H->>API: POST /refunds/881/decision {edit, amount: 200}
    API->>G: invoke(Command(resume=...), thread_id=refund-881)
    G->>DB: load latest checkpoint, re-run the paused node with the answer
    G-->>API: status=paid
```

**Human-in-the-loop** (HITL) is where most real automations need agents to stop: sending money, emailing customers, deleting data, publishing. The theory of oversight is in [AI Engineering · Responsible AI](../ai-engineering/topic.html?p=44-responsible-ai-alignment); here you build approvals that survive restarts.

---

## 2. Key Concepts

- **Checkpointer**: a storage backend that saves graph state after every super-step: `InMemorySaver` (tests), `SqliteSaver` (single box), `PostgresSaver` (production), plus community savers (Redis, MongoDB…).
- **Checkpoint**: a snapshot of state values + channel versions + the `next` nodes + metadata (`step`, `source`, `writes`). Each has a `checkpoint_id`; they form a chain per thread.
- **Thread**: `config={"configurable": {"thread_id": "..."}}`. A thread is one conversation, one ticket, one refund: the unit of persistence. Pick ids from your domain (`refund-<order_id>`) so retries map to the same thread.
- **`get_state(config)`** returns a `StateSnapshot` (`values`, `next`, `tasks`, `config`, `metadata`); **`get_state_history(config)`** iterates all checkpoints, newest first.
- **`interrupt(payload)`**: called inside a node, it saves the checkpoint and stops the run, returning the payload to the caller as `result["__interrupt__"]`. Resuming with `invoke(Command(resume=value), config)` **re-runs that node from its beginning**, and this time `interrupt()` returns `value`.
- **Static breakpoints**: `compile(interrupt_before=["tools"])` / `interrupt_after=[...]` pause at node boundaries; handy for debugging, but `interrupt()` is the tool for approvals.
- **Time travel**: invoke with a past checkpoint's config to **replay** from there; `update_state(config, values)` writes a new checkpoint (a **fork**) and you continue from it.
- **Pending writes**: if one node in a super-step fails, the successful nodes' writes are kept, so a resume doesn't redo them.
- **Durability mode**: `durability="exit" | "async" | "sync"` on `invoke`/`stream`: persist only at the end, in the background while the next step runs (the default), or synchronously before each next step.
- **Store vs checkpointer**: the checkpointer is per-thread short-term state; the **store** (`InMemoryStore`, `SqliteStore`, `PostgresStore`) is cross-thread long-term memory (Ch 22).

> **Analogy:** a checkpointer is the save-game system of a video game. Every level completed is saved to a slot (thread). You can quit and continue later, reload an old save to try a different path (time travel), and the game can pause at a door until a friend enters the code (interrupt).

How checkpoints, interrupts and forks line up on one thread:

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="aa24a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker></defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="#1e293b">Thread "refund-881": one checkpoint per super-step</text>
  <line x1="40" y1="110" x2="840" y2="110" stroke="#94a3b8" stroke-width="2"/>
  <circle cx="80" cy="110" r="16" fill="#dbeafe" stroke="#2563eb"/><text x="80" y="114" text-anchor="middle" fill="#1e293b">-1</text>
  <text x="80" y="80" text-anchor="middle" fill="#334155">input</text>
  <circle cx="200" cy="110" r="16" fill="#dbeafe" stroke="#2563eb"/><text x="200" y="114" text-anchor="middle" fill="#1e293b">0</text>
  <text x="200" y="80" text-anchor="middle" fill="#334155">next: assess</text>
  <circle cx="320" cy="110" r="16" fill="#dbeafe" stroke="#2563eb"/><text x="320" y="114" text-anchor="middle" fill="#1e293b">1</text>
  <text x="320" y="80" text-anchor="middle" fill="#334155">next: approval</text>
  <rect x="380" y="86" width="170" height="48" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="465" y="106" text-anchor="middle" font-weight="700" fill="#1e293b">interrupt() → PAUSED</text>
  <text x="465" y="122" text-anchor="middle" fill="#334155">process may exit; hours pass</text>
  <line x1="336" y1="110" x2="378" y2="110" stroke="#334155" stroke-width="1.5" marker-end="url(#aa24a)"/>
  <line x1="552" y1="110" x2="608" y2="110" stroke="#334155" stroke-width="1.5" marker-end="url(#aa24a)"/>
  <text x="580" y="100" text-anchor="middle" fill="#334155">resume</text>
  <circle cx="630" cy="110" r="16" fill="#dcfce7" stroke="#16a34a"/><text x="630" y="114" text-anchor="middle" fill="#1e293b">2</text>
  <text x="630" y="80" text-anchor="middle" fill="#334155">next: payout</text>
  <circle cx="760" cy="110" r="16" fill="#dcfce7" stroke="#16a34a"/><text x="760" y="114" text-anchor="middle" fill="#1e293b">3</text>
  <text x="760" y="80" text-anchor="middle" fill="#334155">next: () done</text>
  <text x="465" y="160" text-anchor="middle" fill="#334155">Command(resume={"action": "edit", "amount": 200}) re-runs the approval node from its first line</text>
  <path d="M320,128 C320,200 360,220 420,232" fill="none" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#aa24a)"/>
  <rect x="422" y="214" width="200" height="40" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="522" y="231" text-anchor="middle" font-weight="700" fill="#1e293b">fork: update_state(cp1, …)</text>
  <text x="522" y="246" text-anchor="middle" fill="#334155">new branch, same thread</text>
  <line x1="624" y1="234" x2="690" y2="234" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#aa24a)"/>
  <circle cx="710" cy="234" r="16" fill="#ede9fe" stroke="#7c3aed"/><text x="710" y="238" text-anchor="middle" fill="#1e293b">2'</text>
  <rect x="40" y="272" width="800" height="48" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="54" y="292" fill="#1e293b" font-weight="700">Rules that keep this safe</text>
  <text x="54" y="309" fill="#334155">side effects AFTER interrupt() or in their own node · idempotency key per thread · same thread_id for retries · never reorder interrupt() calls inside a node</text>
</svg>
```

### The re-run rule

The single most important production fact: **on resume, the interrupted node runs again from the top.** Code before `interrupt()` executes twice (once before the pause, once on resume). So:

- Put side effects (emails, payments, DB writes) **after** the `interrupt()` call, or better, in a **separate node** after the approval node.
- Make side-effect nodes **idempotent** with a key derived from the thread id, because retries and replays happen.
- If a node calls `interrupt()` several times, resume values are matched **by order**; don't make the number or order of interrupts depend on something that can change between runs.

---

## 3. Setup

```bash
pip install "langgraph>=1.2,<2" "langgraph-checkpoint-sqlite>=3,<4" "python-dotenv>=1"
pip install "langgraph-checkpoint-postgres>=3,<4" "psycopg[binary,pool]>=3.2"   # production checkpointer
pip install "fastapi>=0.115" "uvicorn[standard]" httpx                            # the mini-project API
pip install "langchain>=1.5,<2"                                                   # optional: HITL middleware
# local Postgres for production-like testing:
docker run -d --name lg-postgres -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:17
```

```bash
# .env.example
CHECKPOINT_DB=refunds.db                              # SQLite file for local runs
DATABASE_URL=                                         # e.g. postgresql://postgres:dev@localhost:5432/postgres
LANGGRAPH_AES_KEY=                                    # optional: 16/24/32-byte key to encrypt checkpoints at rest
LANGSMITH_TRACING=false                               # true + LANGSMITH_API_KEY for traces (Ch 40)
# Managed option: LangSmith Deployment (paid; formerly LangGraph Platform) runs graphs with built-in persistence
```

Copy `fakes.py` from [Ch 23 Setup](topic.html?p=23-langgraph-fundamentals) for the offline examples. The graphs here are deterministic or scripted so every output below is real; swap in `llm.get_chat_model()` from Ch 23 for live runs.

---

## 4. Code Examples

### Example 1: Threads that persist across processes

The client sends only the *new* message; the checkpointer holds the history. Run the script three times.

```python
# threads_demo.py — a checkpointer gives every thread_id its own persistent state; run this twice
import sqlite3
import sys

from langchain_core.messages import AIMessage
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, MessagesState, StateGraph


def reply(state: MessagesState) -> dict:
    n_user = sum(m.type == "human" for m in state["messages"])
    return {"messages": [AIMessage(f"Noted. That's message #{n_user} in this thread.")]}


def build(checkpointer):
    return (StateGraph(MessagesState).add_node("reply", reply)
            .add_edge(START, "reply").add_edge("reply", END).compile(checkpointer=checkpointer))


if __name__ == "__main__":
    thread = sys.argv[1] if len(sys.argv) > 1 else "customer-42"
    with sqlite3.connect("threads.db", check_same_thread=False) as conn:
        graph = build(SqliteSaver(conn))
        cfg = {"configurable": {"thread_id": thread}}
        out = graph.invoke({"messages": [("user", "hello again")]}, cfg)   # only the NEW message is sent
        print(thread, "->", out["messages"][-1].content)
        snap = graph.get_state(cfg)
        print("   messages stored:", len(snap.values["messages"]), "| checkpoint:", snap.config["configurable"]["checkpoint_id"][:13])
```

Output (real: `python threads_demo.py customer-42` twice, then `customer-7`):

```text
customer-42 -> Noted. That's message #1 in this thread.
   messages stored: 2 | checkpoint: 1f1dea52-dc29
customer-42 -> Noted. That's message #2 in this thread.
   messages stored: 4 | checkpoint: 1f1dea52-decc
customer-7 -> Noted. That's message #1 in this thread.
   messages stored: 2 | checkpoint: 1f1dea52-e185
```

Three processes, one SQLite file, two independent threads. Note that `add_messages` appended the new input to the stored history: inputs go through reducers (Ch 23). For a chat agent this is exactly the short-term memory of Ch 22, with no code of your own; you still need trimming or summarising once threads get long.

> **Gotcha:** `SqliteSaver` is fine for a single process or a low-traffic box. For several workers, web servers or anything concurrent, use Postgres. For async apps use `AsyncSqliteSaver` / `AsyncPostgresSaver` (`.aio` modules) with `ainvoke`/`astream`.

### Example 2: Pause for approval, resume in another process

`interrupt()` hands a JSON-serialisable payload to whoever called the graph and stops. The answer comes back through `Command(resume=...)`.

```python
# approval_graph.py — pause for a human with interrupt(), resume with Command(resume=...)
import json
import sqlite3
import sys
from typing import Literal, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

SENT: list[str] = []      # stand-in for the payments API


class RefundState(TypedDict):
    customer: str
    amount: float
    reason: str
    decision: str
    note: str


def assess(state: RefundState) -> dict:
    print("  assess ran")
    return {"note": f"{state['customer']} asks {state['amount']:.2f} EUR: {state['reason']}"}


def human_approval(state: RefundState) -> Command[Literal["pay", "notify_rejected"]]:
    print("  human_approval ran (it re-runs from the top on resume!)")
    answer = interrupt({"question": "Approve this refund?", "note": state["note"],
                        "options": ["approve", "reject", "edit"]})
    if answer["action"] == "approve":
        return Command(goto="pay", update={"decision": "approved"})
    if answer["action"] == "edit":
        return Command(goto="pay", update={"decision": "approved (edited)", "amount": float(answer["amount"])})
    return Command(goto="notify_rejected", update={"decision": f"rejected: {answer.get('why', '')}"})


def pay(state: RefundState) -> dict:
    SENT.append(f"refund {state['amount']:.2f} to {state['customer']}")
    return {}


def notify_rejected(state: RefundState) -> dict:
    return {}


def build(checkpointer):
    b = StateGraph(RefundState)
    b.add_node("assess", assess)
    b.add_node("human_approval", human_approval)
    b.add_node("pay", pay)
    b.add_node("notify_rejected", notify_rejected)
    b.add_edge(START, "assess")
    b.add_edge("assess", "human_approval")
    b.add_edge("pay", END)
    b.add_edge("notify_rejected", END)
    return b.compile(checkpointer=checkpointer)


if __name__ == "__main__":
    # python approval_graph.py start            -> runs until the interrupt, then the process exits
    # python approval_graph.py resume '{"action": "edit", "amount": 150}'   -> a NEW process resumes it
    conn = sqlite3.connect("checkpoints.db", check_same_thread=False)
    graph = build(SqliteSaver(conn))
    cfg = {"configurable": {"thread_id": "refund-1001"}}

    if sys.argv[1] == "start":
        out = graph.invoke({"customer": "Contoso", "amount": 180.0, "reason": "double charge"}, cfg)
        print("paused with:", out["__interrupt__"][0].value)
        print("next node:", graph.get_state(cfg).next)
    else:
        out = graph.invoke(Command(resume=json.loads(sys.argv[2])), cfg)
        print("decision:", out["decision"], "| amount:", out["amount"], "| sent:", SENT)
        print("next node:", graph.get_state(cfg).next)
```

Output (real, two separate processes):

```text
$ python approval_graph.py start
  assess ran
  human_approval ran (it re-runs from the top on resume!)
paused with: {'question': 'Approve this refund?', 'note': 'Contoso asks 180.00 EUR: double charge', 'options': ['approve', 'reject', 'edit']}
next node: ('human_approval',)

$ python approval_graph.py resume '{"action": "edit", "amount": 150}'
  human_approval ran (it re-runs from the top on resume!)
decision: approved (edited) | amount: 150.0 | sent: ['refund 150.00 to Contoso']
next node: ()
```

Two things to notice. `human_approval` printed twice, once per process: that is the re-run rule, and why the node contains no side effects. And `assess` did *not* run again: completed nodes are never repeated on resume. The payout happens in `pay`, its own node, after the decision.

### Example 3: Approving, editing or rejecting an agent's tool calls

For a tool-calling agent, put an approval node between the model and the tools. It only fires when a risky tool is requested; the human can **approve**, **edit** the arguments (the edited `AIMessage` keeps its id, so `add_messages` replaces it), or **reject** (tool messages tell the model what happened, so it can recover).

```python
# gated_agent.py — a tool-calling agent where risky tool calls wait for human approval
from typing import Literal

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from langgraph.types import Command, interrupt

OUTBOX: list[dict] = []
RISKY = {"send_email"}


@tool
def lookup_customer(email: str) -> dict:
    """Look up a customer by email."""
    return {"email": email, "name": "Dana", "plan": "pro", "open_invoices": 1}


@tool
def send_email(to: str, subject: str, body: str) -> str:
    """Send an email to a customer."""
    OUTBOX.append({"to": to, "subject": subject})
    return "sent"


TOOLS = [lookup_customer, send_email]


def build(model, checkpointer):
    bound = model.bind_tools(TOOLS)

    def agent(state: MessagesState) -> dict:
        return {"messages": [bound.invoke(state["messages"])]}

    def route(state: MessagesState) -> Literal["approval", "tools", "__end__"]:
        last = state["messages"][-1]
        if not isinstance(last, AIMessage) or not last.tool_calls:
            return END
        return "approval" if any(c["name"] in RISKY for c in last.tool_calls) else "tools"

    def approval(state: MessagesState) -> Command[Literal["tools", "agent"]]:
        last = state["messages"][-1]
        risky = [c for c in last.tool_calls if c["name"] in RISKY]
        decision = interrupt({"tool_calls": risky})          # {"type": "approve" | "edit" | "reject", ...}
        if decision["type"] == "approve":
            return Command(goto="tools")
        if decision["type"] == "edit":                        # same message id => add_messages REPLACES it
            calls = [{**c, "args": {**c["args"], **decision["args"]}} if c["name"] in RISKY else c
                     for c in last.tool_calls]
            return Command(goto="tools", update={"messages": [AIMessage(last.content, tool_calls=calls, id=last.id)]})
        # reject: answer every tool call with an error so the model can recover
        msgs = [ToolMessage(f"Rejected by reviewer: {decision.get('why', 'no reason')}", tool_call_id=c["id"])
                for c in last.tool_calls]
        return Command(goto="agent", update={"messages": msgs})

    b = StateGraph(MessagesState)
    b.add_node("agent", agent)
    b.add_node("approval", approval)
    b.add_node("tools", ToolNode(TOOLS))
    b.add_edge(START, "agent")
    b.add_conditional_edges("agent", route)
    b.add_edge("tools", "agent")
    return b.compile(checkpointer=checkpointer)


if __name__ == "__main__":
    from fakes import call, script
    model = script(call("lookup_customer", email="dana@example.com"),
                   call("send_email", 1, to="dana@example.com", subject="Your invoice", body="Hi Dana, ..."),
                   "Email sent to Dana with the corrected subject.")
    graph = build(model, InMemorySaver())
    cfg = {"configurable": {"thread_id": "support-55"}}

    out = graph.invoke({"messages": [("user", "Remind dana@example.com about her invoice")]}, cfg)
    pending = out["__interrupt__"][0].value["tool_calls"][0]
    print("waiting for approval:", pending["name"], pending["args"]["subject"])

    out = graph.invoke(Command(resume={"type": "edit", "args": {"subject": "Friendly reminder: invoice"}}), cfg)
    print("outbox:", OUTBOX)
    print("final:", out["messages"][-1].content)
```

Output (real, scripted model):

```text
waiting for approval: send_email Your invoice
outbox: [{'to': 'dana@example.com', 'subject': 'Friendly reminder: invoice'}]
final: Email sent to Dana with the corrected subject.
```

A reject (`{"type": "reject", "why": "wrong customer"}`) leaves `OUTBOX` empty and the model receives `"Rejected by reviewer: wrong customer"` as each tool's result. Every tool call in the `AIMessage` must get a `ToolMessage` before the next model call, which is why the reject branch answers all of them.

If you build agents with `create_agent` (Ch 23, Example 6), the same gate is a middleware:

```python
# hitl_middleware.py — the same approval gate as a one-liner on create_agent (langchain 1.x)
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from fakes import call, script
from gated_agent import OUTBOX, TOOLS

if __name__ == "__main__":
    model = script(call("send_email", to="dana@example.com", subject="Invoice", body="Hi Dana"), "Sent.")
    agent = create_agent(model, TOOLS, system_prompt="You help the support team.",
                         middleware=[HumanInTheLoopMiddleware(interrupt_on={"send_email": True,
                                                                            "lookup_customer": False})],
                         checkpointer=InMemorySaver())
    cfg = {"configurable": {"thread_id": "mw-1"}}
    out = agent.invoke({"messages": [{"role": "user", "content": "Email Dana about her invoice"}]}, cfg)
    req = out["__interrupt__"][0].value
    print([a["name"] for a in req["action_requests"]], req["review_configs"][0]["allowed_decisions"])
    out = agent.invoke(Command(resume={"decisions": [{"type": "approve"}]}), cfg)
    print(out["messages"][-1].content, OUTBOX)
```

Output (real, scripted model):

```text
['send_email'] ['approve', 'edit', 'reject', 'respond']
Sent. [{'to': 'dana@example.com', 'subject': 'Invoice'}]
```

The middleware's resume format is `{"decisions": [...]}` with one decision per pending action (`approve`, `edit` with `edited_action`, `reject` with `message`, `respond`). Use it when it fits; write your own node when approval needs custom rules (amount thresholds, four-eyes, role checks).

### Example 4: Time travel, replay and fork

Every checkpoint is addressable. Replay from one to debug; fork from one to try a different path without losing the original.

```python
# time_travel.py — inspect history, replay from a past checkpoint, fork with update_state
import operator
from typing import Annotated, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph


class S(TypedDict):
    topic: str
    outline: str
    draft: str
    log: Annotated[list[str], operator.add]


def outline(s: S) -> dict:
    return {"outline": f"1. why {s['topic']} 2. how 3. next steps", "log": ["outline"]}


def write(s: S) -> dict:
    return {"draft": f"Post about {s['topic']} following: {s['outline']}", "log": ["write"]}


graph = (StateGraph(S).add_node("outline", outline).add_node("write", write)
         .add_edge(START, "outline").add_edge("outline", "write").add_edge("write", END)
         .compile(checkpointer=InMemorySaver()))

if __name__ == "__main__":
    cfg = {"configurable": {"thread_id": "post-7"}}
    graph.invoke({"topic": "durable agents", "log": []}, cfg)

    history = list(graph.get_state_history(cfg))           # newest first
    for snap in history:
        print(f"step={snap.metadata['step']:>2} next={snap.next!s:<14} log={snap.values.get('log')}")

    # 1) Replay: re-run everything AFTER the checkpoint where "write" was next
    before_write = next(s for s in history if s.next == ("write",))
    replayed = graph.invoke(None, before_write.config)
    print("replay log:", replayed["log"])

    # 2) Fork: change the past (edit the outline) and continue from there
    fork_cfg = graph.update_state(before_write.config, {"outline": "1. the one-line pitch"})
    forked = graph.invoke(None, fork_cfg)
    print("fork draft:", forked["draft"])
    print("checkpoints in thread:", len(list(graph.get_state_history(cfg))))
```

Output (real):

```text
step= 2 next=()             log=['outline', 'write']
step= 1 next=('write',)     log=['outline']
step= 0 next=('outline',)   log=[]
step=-1 next=('__start__',) log=[]
replay log: ['outline', 'write']
fork draft: Post about durable agents following: 1. the one-line pitch
checkpoints in thread: 8
```

Replay re-executes the nodes after the chosen checkpoint (so LLM nodes may answer differently, and side effects run again: idempotency matters here too). Forking writes a new checkpoint whose parent is the old one; the thread now holds both branches, and `get_state(cfg)` follows the newest. In support tooling this becomes "edit what the agent decided at step 3 and continue", which is far cheaper than restarting a 20-step run.

### Example 5: Retries, failures and resume-after-crash

Transient errors get a `RetryPolicy` on the node. Hard failures stop the run, but everything up to the last completed super-step is saved, and `invoke(None, config)` continues from there. Side effects use an idempotency key derived from the thread.

```python
# durable_steps.py — retries for transient errors, resume-after-failure, idempotent side effects
from typing import TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import RetryPolicy

CALLS = {"enrich": 0}
CRM_DOWN = True
TICKETS: dict[str, dict] = {}          # stand-in for a ticketing API that accepts an idempotency key


class Lead(TypedDict):
    email: str
    company: str
    ticket_id: str


def enrich(s: Lead) -> dict:
    CALLS["enrich"] += 1
    if CALLS["enrich"] < 3:
        raise ConnectionError("enrichment API timeout")   # transient: retried by the RetryPolicy
    return {"company": "Acme GmbH"}


def create_ticket(s: Lead, config: RunnableConfig) -> dict:
    key = f"{config['configurable']['thread_id']}:create_ticket"      # same thread => same key on every retry
    TICKETS.setdefault(key, {"email": s["email"], "company": s["company"]})  # upsert, never a duplicate
    return {"ticket_id": key}


def sync_crm(s: Lead) -> dict:
    if CRM_DOWN:
        raise RuntimeError("CRM returned 503")              # not retried here: the run fails
    return {}


graph = (StateGraph(Lead)
         .add_node("enrich", enrich, retry_policy=RetryPolicy(max_attempts=4, initial_interval=0.05,
                                                              retry_on=ConnectionError))
         .add_node("create_ticket", create_ticket)
         .add_node("sync_crm", sync_crm)
         .add_edge(START, "enrich").add_edge("enrich", "create_ticket")
         .add_edge("create_ticket", "sync_crm").add_edge("sync_crm", END)
         .compile(checkpointer=InMemorySaver()))

if __name__ == "__main__":
    cfg = {"configurable": {"thread_id": "lead-311"}}
    try:
        graph.invoke({"email": "jo@acme.de"}, cfg, durability="sync")    # persist before each next step
    except RuntimeError as e:
        snap = graph.get_state(cfg)
        print(f"failed: {e} | enrich attempts: {CALLS['enrich']} | next: {snap.next}")
        print("saved so far:", snap.values)

    CRM_DOWN = False                                     # the CRM comes back; resume the SAME thread
    out = graph.invoke(None, cfg)                        # None = continue from the last checkpoint
    print("resumed:", out, "| enrich attempts:", CALLS["enrich"], "| tickets:", len(TICKETS))
```

Output (real):

```text
failed: CRM returned 503 | enrich attempts: 3 | next: ('sync_crm',)
saved so far: {'email': 'jo@acme.de', 'company': 'Acme GmbH', 'ticket_id': 'lead-311:create_ticket'}
resumed: {'email': 'jo@acme.de', 'company': 'Acme GmbH', 'ticket_id': 'lead-311:create_ticket'} | enrich attempts: 3 | tickets: 1
```

The retry policy absorbed two timeouts. After the CRM failure, resume ran **only** `sync_crm`: no third enrichment call, no duplicate ticket. Pair this with a scheduler or queue (Ch 36) that finds threads whose `next` isn't empty and are older than N minutes, and resumes them. `durability="sync"` costs a little latency per step for the strongest guarantee; the default `"async"` is right for most graphs; `"exit"` only persists at the end (fastest, but a crash loses the run).

### Example 6: Postgres and stores in production

Same graph, different saver. `setup()` creates and migrates the tables (run it at deploy time or once at startup). Use a connection pool for web apps, with `autocommit=True` and `row_factory=dict_row` as the saver requires.

```python
# pg_setup.py — PostgresSaver + PostgresStore with a shared pool (needs a running Postgres)
import os

from dotenv import load_dotenv
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.store.postgres import PostgresStore
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from refund_graph import build

if __name__ == "__main__":
    load_dotenv()
    kwargs = {"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}
    with ConnectionPool(os.environ["DATABASE_URL"], max_size=10, open=True, kwargs=kwargs) as pool:
        saver, store = PostgresSaver(pool), PostgresStore(pool)
        saver.setup()                         # checkpoint tables + migrations (idempotent)
        store.setup()                         # long-term memory tables (Ch 22)
        graph = build(saver)                  # pass store=store to compile() if nodes use runtime.store
        cfg = {"configurable": {"thread_id": "refund-PG1"}}
        out = graph.invoke({"order_id": "PG1", "customer": "Dana", "amount": 12.0, "reason": "late"}, cfg)
        print(out["status"], "| checkpoints:", len(list(graph.get_state_history(cfg))))
```

This one needs a database, so it wasn't run for this chapter; the imports and signatures were checked against langgraph-checkpoint-postgres 3.2. Expect `paid | checkpoints: 4`, matching the SQLite version. `PostgresSaver.from_conn_string(url)` is a context manager for scripts; `AsyncPostgresSaver` is the async twin.

**Operating checkpoints:** they grow with every super-step (full state per checkpoint for most channels). Plan for it: keep large blobs (documents, images) out of state and store references instead; delete finished threads you no longer need (`checkpointer.delete_thread(thread_id)`); and set retention per your privacy policy, because checkpoints contain every message and tool result (Ch 44). To encrypt state at rest, compile with a serializer from `EncryptedSerializer.from_pycryptodome_aes()` (reads `LANGGRAPH_AES_KEY`, needs `pycryptodome`).

**Deployment options:**

- **Your own API** (the mini project): FastAPI + Postgres checkpointer, containerised with Docker ([Ch 39](topic.html?p=39-deploy-docker-cicd)). Full control, you run it.
- **LangSmith Deployment** (formerly LangGraph Platform; paid, with self-hosted and cloud options): you point a `langgraph.json` at your compiled graph and get an API with threads, runs, a task queue, cron, streaming, and the LangGraph Studio debugger. Local dev server: `pip install "langgraph-cli[inmem]"` then `langgraph dev`.

```json
{
  "dependencies": ["."],
  "graphs": {"refunds": "./refund_graph.py:graph"},
  "env": ".env"
}
```

The managed server supplies its own checkpointer, so the module should expose a graph compiled *without* one (e.g. `graph = build(None)`). Check the current docs for pricing and the CLI; both change frequently.

---

## 5. Real-World Use Case

**Company:** a 200-person e-commerce business processing ~6,000 refund and return requests a month from email, chat and an n8n webhook. **Policy:** refunds under €50 are automatic; above that, or on any chargeback, a finance team member must approve. **Before:** the agent emailed finance and waited in a polling loop. Deploys killed pending runs, approvals arrived for runs that no longer existed, and twice a retry paid a refund two times.

```mermaid
flowchart TD
    IN["Request via n8n webhook / chat"] --> API["Refund API: POST /refunds"]
    API --> G["LangGraph: assess (rules + LLM fraud note)"]
    G -->|"under 50 EUR, low risk"| PAY["payout node (idempotency key = thread)"]
    G -->|"high risk"| INT["approval node: interrupt()"]
    INT --> SL["Slack card with approve / edit / reject"]
    SL -->|"button click"| RES["POST /refunds/id/decision"]
    RES --> INT
    INT -->|"approve or edit"| PAY
    INT -->|"reject"| REJ["reject node: customer email draft"]
    PAY --> DB[("Postgres: checkpoints + audit")]
    REJ --> DB
    CRON["Every 15 min: stale threads"] -->|"next not empty, older than 1h"| RES2["resume or remind approver"]
```

**Numbers:** ~78% of requests auto-complete in under 3 seconds. The other ~22% (≈1,300 a month) wait a median 40 minutes for a human; while they wait, no process is running, just a few rows in Postgres. Deploys and crashes no longer lose anything: a cron job resumes threads with work pending. Duplicate payouts went to zero because the payout node uses `refund:<thread_id>` as the payment provider's idempotency key. The checkpoint table grows ~2 GB a month; a nightly job deletes completed threads after 90 days (finance keeps its own audit log). Infra cost is one small Postgres instance and two API containers. Model cost depends on the fraud-note model; compute it as requests × tokens × price from your provider's pricing page, or run it on a local model.

---

## 6. Mini Project: A Refund Approval Service (1–2 hours)

**Goal:** a FastAPI service where refunds above a threshold pause for a named human, survive restarts, can't be paid twice, and can't be approved twice. SQLite locally, Postgres by setting `DATABASE_URL`.

```text
refund-service/
├── .env
├── refund_graph.py
├── app.py
├── test_app.py
├── Dockerfile
└── docker-compose.yml
```

**Step 1: the graph.** Rules decide the route; the approval node only asks; the payout node is idempotent.

```python
# refund_graph.py — the refund workflow: policy check -> (auto | human approval) -> idempotent payout
from typing import Literal, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

AUTO_APPROVE_LIMIT = 50.0
PAYOUTS: dict[str, float] = {}          # stand-in for the payments API (idempotency key -> amount)


class Refund(TypedDict, total=False):
    order_id: str
    customer: str
    amount: float
    reason: str
    risk: str
    status: str                          # pending_approval | paid | rejected
    reviewer: str
    note: str


def assess(s: Refund) -> dict:
    risky = s["amount"] > AUTO_APPROVE_LIMIT or "chargeback" in s.get("reason", "").lower()
    return {"risk": "high" if risky else "low"}


def route(s: Refund) -> Literal["approval", "payout"]:
    return "approval" if s["risk"] == "high" else "payout"


def approval(s: Refund) -> Command[Literal["payout", "reject"]]:
    # Everything before interrupt() re-runs on resume, so keep this node free of side effects.
    d = interrupt({"order_id": s["order_id"], "customer": s["customer"], "amount": s["amount"],
                   "reason": s["reason"], "allowed": ["approve", "reject", "edit"]})
    who = d.get("reviewer", "unknown")
    if d["action"] == "approve":
        return Command(goto="payout", update={"reviewer": who})
    if d["action"] == "edit":
        return Command(goto="payout", update={"reviewer": who, "amount": float(d["amount"]),
                                              "note": f"amount edited by {who}"})
    return Command(goto="reject", update={"reviewer": who, "note": d.get("note", "")})


def payout(s: Refund, config: RunnableConfig) -> dict:
    key = f"refund:{config['configurable']['thread_id']}"     # idempotency key: one payout per thread
    PAYOUTS.setdefault(key, s["amount"])                       # real API: pass key as Idempotency-Key header
    return {"status": "paid"}


def reject(s: Refund) -> dict:
    return {"status": "rejected"}


def build(checkpointer):
    b = StateGraph(Refund)
    for name, fn in [("assess", assess), ("approval", approval), ("payout", payout), ("reject", reject)]:
        b.add_node(name, fn)
    b.add_edge(START, "assess")
    b.add_conditional_edges("assess", route)
    b.add_edge("payout", END)
    b.add_edge("reject", END)
    return b.compile(checkpointer=checkpointer)
```

**Step 2: the API.** Thread id = `refund-<order_id>`, so a client retrying `POST /refunds` can't start a second run. `snapshot.tasks[*].interrupts` tells you what a paused thread is waiting for.

```python
# app.py — FastAPI service: start refunds, list what waits for approval, resume with a decision
import os
import sqlite3
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command
from pydantic import BaseModel

from refund_graph import build


def make_checkpointer():
    """SQLite locally; Postgres in production (same graph code, different saver)."""
    url = os.getenv("DATABASE_URL", "")
    if url.startswith("postgres"):
        from langgraph.checkpoint.postgres import PostgresSaver
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool
        pool = ConnectionPool(url, max_size=10, open=True, kwargs={"autocommit": True, "prepare_threshold": 0,
                                                         "row_factory": dict_row})
        saver = PostgresSaver(pool)
        saver.setup()                       # creates/migrates checkpoint tables; idempotent
        return saver, pool.close
    conn = sqlite3.connect(os.getenv("CHECKPOINT_DB", "refunds.db"), check_same_thread=False)
    return SqliteSaver(conn), conn.close


@asynccontextmanager
async def lifespan(app: FastAPI):
    saver, close = make_checkpointer()
    app.state.graph = build(saver)
    yield
    close()


app = FastAPI(title="Refund approvals", lifespan=lifespan)


class RefundIn(BaseModel):
    order_id: str
    customer: str
    amount: float
    reason: str


class Decision(BaseModel):
    action: str                     # approve | reject | edit
    reviewer: str
    amount: float | None = None
    note: str = ""


def _cfg(order_id: str) -> dict:
    return {"configurable": {"thread_id": f"refund-{order_id}"}}


def _view(order_id: str) -> dict:
    snap = app.state.graph.get_state(_cfg(order_id))
    if not snap.values:
        raise HTTPException(404, "unknown refund")
    pending = [i.value for t in snap.tasks for i in t.interrupts]
    status = "pending_approval" if pending else snap.values.get("status", "running")
    return {"order_id": order_id, "status": status, "state": snap.values, "pending": pending}


@app.post("/refunds", status_code=201)
def start_refund(r: RefundIn) -> dict:
    graph, cfg = app.state.graph, _cfg(r.order_id)
    if graph.get_state(cfg).values:                          # idempotent start: same order => same thread
        return _view(r.order_id)
    graph.invoke(r.model_dump(), cfg)
    return _view(r.order_id)


@app.get("/refunds/{order_id}")
def get_refund(order_id: str) -> dict:
    return _view(order_id)


@app.post("/refunds/{order_id}/decision")
def decide(order_id: str, d: Decision) -> dict:
    if _view(order_id)["status"] != "pending_approval":
        raise HTTPException(409, "nothing to approve")
    app.state.graph.invoke(Command(resume=d.model_dump()), _cfg(order_id))
    return _view(order_id)
```

**Step 3: the end-to-end test,** including a simulated restart between the request and the approval.

```python
# test_app.py — end-to-end with FastAPI's TestClient, including a "server restart" mid-approval
import os
import pathlib

os.environ["CHECKPOINT_DB"] = "test_refunds.db"
pathlib.Path("test_refunds.db").unlink(missing_ok=True)

from fastapi.testclient import TestClient  # noqa: E402

import refund_graph  # noqa: E402
from app import app  # noqa: E402

if __name__ == "__main__":
    with TestClient(app) as c:
        small = c.post("/refunds", json={"order_id": "A1", "customer": "Dana", "amount": 19.0, "reason": "late"})
        print("small :", small.json()["status"])
        big = c.post("/refunds", json={"order_id": "B2", "customer": "Raj", "amount": 240.0, "reason": "broken"})
        print("big   :", big.json()["status"], "| asks:", big.json()["pending"][0]["allowed"])
        again = c.post("/refunds", json={"order_id": "B2", "customer": "Raj", "amount": 240.0, "reason": "broken"})
        print("retry :", again.json()["status"], "(same thread, no second run)")

    # the process "restarts": a brand-new app lifespan, same SQLite file
    with TestClient(app) as c:
        print("after restart:", c.get("/refunds/B2").json()["status"])
        done = c.post("/refunds/B2/decision", json={"action": "edit", "reviewer": "maria", "amount": 200})
        print("decided:", done.json()["status"], done.json()["state"]["amount"], done.json()["state"]["note"])
        print("second decision:", c.post("/refunds/B2/decision", json={"action": "approve", "reviewer": "x"}).status_code)
    print("payouts:", refund_graph.PAYOUTS)
```

Output (real):

```text
small : paid
big   : pending_approval | asks: ['approve', 'reject', 'edit']
retry : pending_approval (same thread, no second run)
after restart: pending_approval
decided: paid 200.0 amount edited by maria
second decision: 409
payouts: {'refund:refund-A1': 19.0, 'refund:refund-B2': 200.0}
```

**Step 4: containerise with Postgres.** A minimal Dockerfile and compose file ([Ch 39](topic.html?p=39-deploy-docker-cicd) covers CI and secrets):

```dockerfile
FROM python:3.13-slim
WORKDIR /app
RUN pip install --no-cache-dir "langgraph>=1.2,<2" "langgraph-checkpoint-sqlite>=3,<4" \
    "langgraph-checkpoint-postgres>=3,<4" "psycopg[binary,pool]>=3.2" "fastapi>=0.115" "uvicorn[standard]"
COPY refund_graph.py app.py ./
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
```

The compose file wires the API to Postgres; secrets come from `.env`, never from the file itself:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
  api:
    build: .
    environment:
      DATABASE_URL: postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres
    ports: ["8000:8000"]
    depends_on:
      db:
        condition: service_healthy
volumes:
  pgdata: {}
```

Run `python test_app.py` first, then `docker compose up --build` and drive it with `curl -X POST localhost:8000/refunds -H 'content-type: application/json' -d '{"order_id":"B9","customer":"Raj","amount":240,"reason":"broken"}'`. Restart the `api` container, then post a decision: it still resumes.

**Done when:**
- [ ] Small refunds are paid immediately; large ones return `pending_approval` with the approval payload.
- [ ] A pending refund survives an API restart (test and Docker).
- [ ] Repeating `POST /refunds` or `POST /decision` never pays twice (`PAYOUTS` / 409).
- [ ] The service runs against Postgres by setting `DATABASE_URL` only.

**Stretch goals:** add `GET /refunds?status=pending_approval` by keeping an index table updated at start and decision time; post the approval payload to Slack with buttons that call `/decision` ([Ch 31](topic.html?p=31-chat-bots)); restrict who may approve amounts over €500 (check `reviewer` against a role table before resuming); add a nightly job that calls `delete_thread` for refunds finished more than 90 days ago.

---

## 7. Comparison Table

**Checkpointers**

| Saver | Package | Concurrency | Use when |
|---|---|---|---|
| `InMemorySaver` | langgraph (built in) | one process, lost on exit | tests, notebooks |
| `SqliteSaver` / `AsyncSqliteSaver` | langgraph-checkpoint-sqlite | one process / low write rate | local dev, single-box tools, CLIs |
| `PostgresSaver` / `AsyncPostgresSaver` | langgraph-checkpoint-postgres | many workers | production APIs, workers, anything multi-replica |
| Community savers (Redis, MongoDB, …) | third-party | varies | you already run that database; check maintenance status |
| LangSmith Deployment (managed) | hosted (paid) | managed | you'd rather not run persistence, queues and Studio yourself |

**Human-in-the-loop options**

| Mechanism | Pauses where | Resume with | Use when |
|---|---|---|---|
| `interrupt()` inside a node | any line of any node | `Command(resume=value)` | approvals, edits, asking the user a question mid-run |
| `interrupt_before` / `interrupt_after` | node boundaries (compile or invoke) | `invoke(None, config)` (after optional `update_state`) | debugging, stepping through a graph |
| `HumanInTheLoopMiddleware` | before chosen tools in `create_agent` | `Command(resume={"decisions": [...]})` | standard tool approval with no custom graph |
| Hand-rolled Ch 21 `approve` callback | inside your loop, blocking | function return value | CLI tools, no persistence needed |
| n8n "Wait" / approval nodes | workflow step | webhook / form | low-code flows around the agent (Ch 09) |

**Durable execution, more broadly:** if your workflow is mostly non-LLM steps spanning days (orders, onboarding), a general workflow engine such as Temporal, Prefect or Airflow ([Ch 37](topic.html?p=37-workflow-orchestrators)) may fit better, calling LangGraph for the agentic parts.

---

## 8. Common Mistakes & Best Practices

**Mistake 1: side effects before `interrupt()`.** The email is sent, the node pauses, resume re-runs the node, and the email is sent again. *Fix:* side effects after the interrupt or in their own node, with idempotency keys.

```python
# before: sends twice (once before the pause, once on resume)
def approve_and_send(state):
    send_email(state["draft"])
    if interrupt({"ok?": state["draft"]}) == "yes": ...
# after: ask first; a separate node does the side effect
def approve(state):
    return {"approved": interrupt({"ok?": state["draft"]}) == "yes"}
```

**Mistake 2: random thread ids.** `uuid4()` per HTTP request means a client retry starts a second run (and a second payout). *Fix:* derive thread ids from domain ids (`refund-<order_id>`, `ticket-<id>`), and check `get_state` before starting.

**Mistake 3: forgetting the checkpointer when resuming.** In langgraph 1.2 a graph compiled without a checkpointer still returns `__interrupt__`, but nothing was saved, so there is nothing to resume; a resume on a graph built with a different saver finds nothing either. *Fix:* one factory builds the graph with the configured saver everywhere (API, workers, scripts).

**Mistake 4: `InMemorySaver` or SQLite behind several workers.** Each worker sees a different (or locked) store and approvals vanish. *Fix:* Postgres for anything with more than one process.

**Mistake 5: wrapping `interrupt()` in a broad `try/except`.** `interrupt()` works by raising a special exception (`GraphInterrupt`); `except Exception` swallows it and the graph never pauses. *Fix:* don't catch around `interrupt()`, or re-raise `GraphInterrupt`.

**Mistake 6: putting huge or secret data in state.** Every super-step checkpoints it, forever. *Fix:* store references (S3 keys, row ids) in state; never store API keys; encrypt checkpoints if they hold personal data, and delete threads per your retention policy.

**Mistake 7: approvals without identity and audit.** "Someone clicked approve." *Fix:* require the reviewer's identity in the resume payload, authorise it in the API (not in the graph), and keep it in state so it's checkpointed with the decision.

**Mistake 8: no plan for stuck threads.** Interrupted threads wait forever if the Slack message is missed. *Fix:* a scheduled job lists threads whose `next` is non-empty past an SLA, reminds or escalates, and optionally auto-rejects.

**Best-practice checklist**
- [ ] Postgres checkpointer in production; `setup()` run deliberately at deploy.
- [ ] Thread ids derived from domain ids; starts and decisions are idempotent.
- [ ] Interrupting nodes have no side effects; side-effect nodes use idempotency keys.
- [ ] Resume payloads include who decided; the API authorises them.
- [ ] Node retry policies for transient errors; a resume job for failed or stale threads.
- [ ] State holds references, not blobs or secrets; retention and deletion policy for threads.
- [ ] Time travel used for debugging and support "edit and continue", with side effects in mind.

---

## 9. Exercises

1. **Pending list.** Add `GET /refunds?status=pending_approval` to the mini project without scanning every thread: maintain a small `refund_index` table updated on start and on decision. Include the age of each pending request.
2. **Four-eyes rule.** Refunds over €500 need two different approvers. Implement it with two `interrupt()` calls in one node (mind the ordering rule) or two approval nodes, and test that the same reviewer can't approve twice.
3. **Stale-thread sweeper.** Write a script that, for every known thread, reads `get_state` and resumes threads that failed (non-empty `next`, no pending interrupt) and reminds approvers for interrupts older than one hour.
4. **Edit and continue.** For the Example 3 agent, after a run finishes, use `get_state_history` to find the checkpoint before `send_email`, `update_state` the tool-call arguments, and continue from the fork. Confirm the original branch is still in history.
5. **Async service.** Port `app.py` to `async def` endpoints with `AsyncSqliteSaver` (or `AsyncPostgresSaver`) and `ainvoke`, and stream progress to the client with Server-Sent Events using `astream(stream_mode="updates")`.

### Self-check questions

**Q: What does a checkpointer save, and when?**
A: After every super-step it saves a checkpoint for the thread: the state values, channel versions, which nodes run next, and metadata such as step number and writes. It also stores pending writes from nodes that completed in a super-step where another node failed. This is what enables multi-turn threads, resume after failure, interrupts and time travel.

**Q: What is a thread, and how should you choose thread ids?**
A: A thread is the unit of persistence: the chain of checkpoints for one conversation or one business process, selected with `config["configurable"]["thread_id"]`. Derive thread ids from domain identifiers (order, ticket, user session) so retries and later requests reach the same thread; random ids per request break idempotency and make resuming impossible.

**Q: How does `interrupt()` work, and how do you resume?**
A: Called inside a node, `interrupt(payload)` saves the checkpoint and stops the run, returning the payload to the caller under `__interrupt__`. You resume by invoking the graph with `Command(resume=value)` on the same thread; the interrupted node re-runs from its beginning and this time `interrupt()` returns `value`.

**Q: What's the difference between replaying and forking a past checkpoint?**
A: Replaying invokes the graph with a past checkpoint's config (and `None` as input), re-executing the nodes after that point. Forking first calls `update_state` on the past checkpoint, which writes a new checkpoint with modified values as a branch, then continues from it. Both keep the original history; both re-run nodes, so LLM output may differ and side effects need idempotency.

**Q: Why must nodes that call `interrupt()` avoid side effects, and how do you design around it? (Senior)**
A: On resume the whole node re-executes from the first line, so anything before `interrupt()` runs twice, and replays and retries can run it again. Keep interrupting nodes pure: they only gather a decision. Put side effects in a later node, make them idempotent with a key derived from the thread id (passed to the external API as an idempotency key), and keep the number and order of `interrupt()` calls in a node deterministic because resume values are matched by position.

**Q: Your refund agent ran fine on a laptop but in production approvals sometimes "disappear". What would you check? (Senior)**
A: Whether every replica uses the same durable checkpointer (an in-memory or per-container SQLite saver loses or splits threads), whether thread ids are deterministic rather than generated per request, whether any code wraps `interrupt()` in a broad `except` that swallows the interrupt, whether the resume call uses the same graph definition and thread id, and whether a deploy changed node names or the order of interrupts so the saved checkpoint no longer matches. Then add a stale-thread report so pending interrupts are visible.

**Q: When would you choose LangSmith Deployment over running your own FastAPI + Postgres service? (Senior)**
A: When you want threads, runs, a background task queue, cron, streaming endpoints, double-texting handling and the Studio debugger without building and operating them, and the cost and data-residency terms work for you. Run your own when you need full control over infrastructure and data, already operate Postgres and APIs well, have simple endpoints, or need to embed the graph in an existing service. The graph code is the same either way.

---

## 10. Summary & Official Docs

- `compile(checkpointer=...)` saves a **checkpoint per super-step** under a **thread id**; that one change gives multi-turn threads, crash recovery, interrupts and time travel.
- **InMemory** for tests, **SQLite** for one box, **Postgres** (with a pool and `setup()`) for production.
- `interrupt(payload)` pauses; `Command(resume=value)` continues; the interrupted node **re-runs from the top**.
- Keep side effects out of interrupting nodes; give side-effect nodes **idempotency keys** from the thread id.
- `get_state` / `get_state_history` / `update_state` let you inspect, replay and fork any run.
- `RetryPolicy` handles transient errors; `invoke(None, config)` resumes after hard failures; choose a `durability` mode.
- Checkpoints contain everything: keep blobs and secrets out, encrypt if needed, and delete threads on a schedule.
- Ship as your own FastAPI + Postgres service, or on LangSmith Deployment with `langgraph.json`.

| Task | API |
|---|---|
| Persist a thread | `compile(checkpointer=PostgresSaver(pool))` + `{"configurable": {"thread_id": ...}}` |
| Ask a human | `answer = interrupt({...})` in a node |
| Resume | `graph.invoke(Command(resume=answer), cfg)` |
| What is it waiting for? | `graph.get_state(cfg).tasks[i].interrupts` / `.next` |
| Continue after a crash | `graph.invoke(None, cfg)` |
| Rewind and change | `update_state(past_cfg, values)` then `invoke(None, new_cfg)` |

**Official docs**
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- Interrupts (human-in-the-loop): https://docs.langchain.com/oss/python/langgraph/interrupts
- Durable execution: https://docs.langchain.com/oss/python/langgraph/durable-execution
- Time travel: https://docs.langchain.com/oss/python/langgraph/use-time-travel
- Human-in-the-loop middleware: https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- LangSmith Deployment: https://docs.langchain.com/langsmith/deployments

**Next:** [Ch 25 · CrewAI: Roles, Tasks & Crews](topic.html?p=25-crewai): a higher-level, role-based way to build multi-agent teams, and an honest comparison with the graphs you just built.

---

*AI Automation with Python Handbook — chapter 24.*
