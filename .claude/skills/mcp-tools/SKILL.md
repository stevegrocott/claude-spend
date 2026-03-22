---
name: mcp-tools
description: Use when you need framework documentation, structured code navigation, or are unsure which exploration tool to use. Reference for available MCP tools and when to prefer each.
---

# MCP Tools Reference

## When to Use This Skill

Before exploring a codebase or looking up framework documentation, check which MCP tools are available and use the most efficient one.

## Available Tools

### Context7 — Framework & Library Documentation

**Use when:** You need API docs, usage patterns, or configuration reference for a framework or library.

**Workflow:**
1. `context7.resolve_library_id` — find the library by name
2. `context7.get_library_docs` — retrieve relevant documentation

**Prefer over web search** for framework APIs. Faster, more targeted, fewer tokens.

### Serena — Structured Code Navigation

**Use when:** You need to understand code structure — class hierarchies, method signatures, call graphs, file relationships.

**Prefer over Grep/Glob** when you need structural understanding, not just text matching.

### Grep / Glob — Text Search & File Discovery

**Use when:** You need to find text patterns across files or discover files by name/path.

## Decision Matrix

| Need | First choice | Fallback |
|---|---|---|
| Framework/library API docs | Context7 | Web search |
| Library usage patterns | Context7 | Web search |
| Class/method/call structure | Serena | Grep + manual reading |
| Text search across files | Grep | — |
| File discovery by name/path | Glob | — |
| Current events / release notes | Web search | — |

## Critical: Fully Qualified Tool Names

Always use the MCP server prefix to avoid "tool not found" errors:

- `context7.resolve_library_id` — not `resolve_library_id`
- `context7.get_library_docs` — not `get_library_docs`

## When Tools Are Not Available

If a tool call fails with "tool not found", fall back to the next option in the decision matrix. Do not retry the same tool. Note in your output that the MCP tool was unavailable.
