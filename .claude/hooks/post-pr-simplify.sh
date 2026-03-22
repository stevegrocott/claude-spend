#!/usr/bin/env bash
#
# PostToolUse hook: Trigger code simplifier after PR creation
#
# After a PR is successfully created, prompts Claude to run the
# code-simplifier agent against the changed files.

# Debug log setup
debug_log="$HOME/.cache/claude-hooks/post-pr-simplify.log"
mkdir -p "$(dirname "$debug_log")"

# Read JSON input from stdin
if [[ -t 0 ]]; then
    printf '\n=== %s ===\nstdin is a terminal (no input)\n' "$(date)" >> "$debug_log"
    exit 0
fi

input=$(cat)

# Debug: log received input
printf '\n=== %s ===\ninput length: %d\n%s\n' "$(date)" "${#input}" "$input" >> "$debug_log"

# Extract tool name, command, and response
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty')
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

# Try multiple paths for the response - Bash tool response structure may vary
stdout=$(printf '%s' "$input" | jq -r '.tool_response.stdout // .tool_response // empty')

# Only process Bash tool calls
if [[ "$tool_name" != 'Bash' ]]; then
    exit 0
fi

# Only process PR/MR creation commands
if [[ "$command" != *'create-mr.sh'* ]] && [[ "$command" != *'gh pr create'* ]] && [[ "$command" != *'glab mr create'* ]]; then
    exit 0
fi

# Debug: log extracted values
printf 'tool_name=%s command=%s stdout=%s\n' "$tool_name" "$command" "$stdout" >> "$debug_log"

# Check if the PR/MR was created successfully (look for URL in output)
if [[ "$stdout" != *'github.com'* ]] && [[ "$stdout" != *'gitlab.com'* ]] && [[ "$stdout" != *'merge_request'* ]]; then
    printf 'No PR/MR URL found in response, exiting\n' >> "$debug_log"
    exit 0
fi

printf 'PR/MR URL found, triggering simplifier\n' >> "$debug_log"

# Get the list of changed files for context
changed_files=$(git diff --name-only main...HEAD 2>/dev/null | head -20 | tr '\n' ',')
changed_files=${changed_files%,}

# Build the reason message
reason="PR/MR created successfully. Now run the code-simplifier agent to review and simplify the code in this PR/MR. Changed files: ${changed_files}. Use the Task tool with subagent_type='code-simplifier' to simplify the changed code. After simplification, commit any changes and push to update the PR/MR."

# Output JSON to prompt Claude to run the simplifier
printf '%s\n' "$reason" | jq -Rs '{decision: "block", reason: .}'
