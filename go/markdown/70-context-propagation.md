# 70. Context Propagation

Context propagation is a fundamental pattern in modern, concurrent, and distributed systems. In Go, the `context` package provides a mechanism to carry deadlines, cancellation signals, and request-scoped values across API boundaries and between goroutines.

This chapter focuses on how to correctly implement and propagate context throughout a chain of function calls, ensuring that operations can be gracefully stopped or timed out if necessary.

## 70.1. The Core Concept of `context.Context`

A `context.Context` is an interface that carries deadlines, cancellation signals, and request-scoped values across API boundaries and between goroutines.

### 70.1.1. Creating Contexts

The `context` package provides several functions to create different types of contexts:

*   **`context.Background()`**: The root context. It is never canceled and has no value. It is typically used as the starting point for a context tree.
*   **`context.TODO()`**: A placeholder for a context that needs to be implemented later. It should be used when you are unsure which context to use.
*   **`context.WithCancel(parent Context)`**: Returns a copy of the parent context, along with a `cancel` function. Calling `cancel()` signals all goroutines listening to this context to stop.
*   **`context.WithDeadline(parent Context, d time.Time)`**: Returns a copy of the parent context that is automatically canceled at the specified time `d`.
*   **`context.WithTimeout(parent Context, timeout time.Duration)`**: Returns a copy of the parent context that is automatically canceled after the specified `timeout`.

### 70.1.2. Context Propagation in Functions

To propagate context, functions must accept a `context.Context` as their first argument.

**Example: Basic Context Usage**
