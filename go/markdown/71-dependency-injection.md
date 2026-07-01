# 71. Dependency Injection

Dependency Injection (DI) is a design pattern that implements the Inversion of Control (IoC) principle. Instead of a component creating its dependencies (e.g., database connections, loggers, external service clients) internally, those dependencies are "injected" into the component from an external source.

This pattern promotes loose coupling, making code easier to test, maintain, and refactor.

## 71.1. Why Use Dependency Injection?

The primary benefits of DI include:

1.  **Testability**: You can easily substitute real dependencies (like a live database) with mock or fake implementations during unit testing.
2.  **Flexibility**: It allows you to change implementations (e.g., switch from PostgreSQL to MySQL) without modifying the consuming code, as long as the interface remains the same.
3.  **Maintainability**: Components become less coupled to concrete implementations, leading to a more modular design.

## 71.2. Types of Dependency Injection

There are several ways to inject dependencies into a Go struct or function.

### 71.2.1. Constructor Injection (Recommended)

This is the most common and preferred method. Dependencies are provided when the object is created (i.e., in the constructor function). This ensures the object is never in an invalid state (i.e., without its required dependencies).

**Example: Constructor Injection**