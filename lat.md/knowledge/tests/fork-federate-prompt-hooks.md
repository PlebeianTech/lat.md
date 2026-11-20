---
lat:
  require-code-mention: true
---

# Fork Federate Prompt Hooks

Tests in [[tests/fork-federate-prompt-hooks.test.ts]] for the user prompt that [[cli#hook#UserPromptSubmit]] and the Antigravity PreInvocation hook pass to [[src/knowledge/index.ts#federateTags]]. Each test arranges a tagged document, a fake external store with two hits, and a local decision model. The Claude Code tests run the built CLI.

## Each prompt hook sends the prompt to the decision model

With `LAT_FEDERATION_RERANK_URL` set, each hook sends the prompt text to the decision model for every federated hit, and the hook output omits the hit the model scores low.

## Without the variable the hooks keep every hit

Without `LAT_FEDERATION_RERANK_URL`, the decision model receives no request and the hook output holds every hit.
