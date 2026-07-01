# 69 - Structured Logging

Structured logging is a technique where log messages are output in a structured format, such as JSON, rather than as plain, unstructured text. This allows log aggregation systems (like ELK stack, Grafana Loki, etc.) to easily parse, index, and query logs based on specific fields.

## Why Use Structured Logging?

1.  **Queryability:** Instead of searching for a string like `"User ID 123 failed login"`, you can query for `level: "error" AND user_id: 123`.
2.  **Consistency:** It enforces a consistent schema across all log entries, making parsing reliable.
3.  **Machine Readability:** It is inherently designed for consumption by machines.

## Implementing Structured Logging in Go

While Go's standard `log` package produces unstructured output, external libraries are used to achieve structured logging. The most popular choices include `zap`, `zerolog`, and `logrus`.

### Example using Zerolog

`zerolog` is known for its high performance and minimal overhead.

**Installation:**