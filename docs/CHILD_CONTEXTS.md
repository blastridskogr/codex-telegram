# Child Contexts

This document describes the verified child-context capability in the patched Windows Codex app.

The short version:

- one main Codex thread can stay the manager
- the parent can enumerate native child contexts that the app already created
- the local controller can create a clean controller-managed child with `POST /thread/spawn-child`
- each child gets its own `conversationId`
- a clean child keeps its own context across multiple turns
- the parent can enumerate those child contexts through the app-side control surface

## What is verified

The patched app now exposes working parent/child inspection routes:

- `GET /health`
- `POST /thread/debug-context`
- `POST /thread/state`
- `POST /thread/children`
- `POST /thread/spawn-child`

The renderer-backed routes no longer time out. They now return live app state from the official-app runtime.

The important proof is not only transport.

- a real native child context is visible from the parent through `/thread/children`
- a controller-managed child can now be created, returned immediately, listed under the parent, and reused for later turns

## Two child types

There are now two distinct child cases.

### 1. Native child contexts

These are child conversations the app itself created internally.

- it has its own `conversationId`
- it is linked back to the parent thread
- it can be enumerated from the parent
- it can hold multi-turn state inside that child conversation

### 2. Controller-managed child contexts

These are children created through the patched local control surface:

- `POST /thread/spawn-child`

They also have their own `conversationId`, and they are attached to the requested parent in the controller layer.

In `/thread/children` they are surfaced with:

- `relationshipOrigin: controller`
- `managedByThreadController: true`
- `nativeChild: false`

This makes the child usable as an execution lane while the parent remains the manager and reviewer.

## Verified behavior

Verified in the patched official-app runtime:

- parent thread remained the manager
- a child was spawned under that parent
- the parent's `/thread/debug-context` counters changed to show child activity
- `/thread/children` returned the child with:
  - child `conversationId`
  - `parentConversationId`
  - `senderThreadId`
  - `sourceParentThreadId`
  - task metadata such as prompt, model, tool, and task status
- a clean child completed one turn, then received a second turn, and replied using information stored only in that child context

Additional controller-managed proof:

- `POST /thread/spawn-child` returned a child id immediately
- that same child appeared in `/thread/children` under the requested parent
- `POST /thread/send` succeeded against that same returned child id
- `POST /thread/state` resolved the child conversation afterward

That last point matters most: the child remembered its prior token across turns without the parent re-supplying it.

## Clean child vs copied parent context

This distinction is critical.

Good default:

- start the child clean
- do not copy the full parent transcript into it

Bad default:

- create the child by copying the parent context/history wholesale

Why:

- a copied parent transcript can immediately consume the child context window
- a clean child keeps separation and leaves room for the child to work

So the recommended operating rule is:

- `clean child context` by default
- `full parent transcript copy` only as an explicit exception

## How to use it from a controller or harness

Recommended model:

1. Keep the main thread as the orchestrator.
2. Spawn a clean child context for a bounded task.
   - native app flow if you want the app to create the child itself
   - or `POST /thread/spawn-child` if you want deterministic controller-managed child creation
3. Store the child `conversationId`.
4. Send follow-up work back into that same child `conversationId`.
5. Let the child produce a report.
6. Let the parent review the report and decide whether to continue or close.

In other words:

- parent thread = manager
- child context = execution lane

## What `/thread/children` returns

The child listing is intended to surface the child contexts already attached to a parent.

Typical fields include:

- `conversationId`
- `parentConversationId`
- `title`
- `cwd`
- `updatedAt`
- `resumeState`
- `threadRuntimeStatus`
- `turnCount`
- `latestTurnId`
- `latestTurnStatus`
- `pendingApprovalRequestId`
- `sourceParentThreadId`
- `taskPrompt`
- `taskTool`
- `taskModel`
- `taskStatus`
- `agentState`
- `senderThreadId`
- `parentTurnId`
- `parentItemId`

This is enough for a higher-level controller to:

- detect that a child exists
- keep working in the same child
- distinguish siblings under the same parent
- decide whether a child is still active, errored, or ready for review

For controller-managed children, the listing also tells you that the relationship came from the controller layer rather than the app-native child graph.

## What was fixed in the app patch

The main 2026-03-24 fix was not a child-graph rewrite. It was a renderer integration fix.

The injected renderer cases were still using stale minified aliases from an older bundle shape. That made the child/state routes enter the renderer switch and then fail before replying, which looked like an HTTP timeout.

The injector now derives the live renderer's:

- manager symbol
- dispatch symbol
- logger symbol

from the current bundle before generating the injected cases.

That is why these routes now work live:

- `/thread/debug-context`
- `/thread/state`
- `/thread/children`

The later fix on 2026-03-24 added deterministic controller-managed child spawn:

- `/thread/spawn-child`

Two important corrections were needed:

- the direct app-server payload had to match the app's high-level `startThread/startTurn` shape
- the `sandboxPolicy` enum names had to use the app-server camelCase variants such as `dangerFullAccess`, `readOnly`, and `workspaceWrite`

The child-spawn route also no longer opens the visible manager window on `/` or on a fresh draft route. If direct child creation fails, it now fails directly instead of pretending to open a new visible main thread.

## Current limits

- this verifies native child enumeration, controller-managed child creation, child persistence, and child reuse
- it does not mean every child is immune to context-window exhaustion
- if a child is launched with too much inherited context, it can still overflow
- completion policy still belongs to the parent orchestration layer; the app patch exposes the child, but your controller or harness still decides when the work is truly done
- controller-managed child spawn is a working control surface, but it is still not the same thing as exposing the app's internal native `spawnAgent(...)` primitive directly

## Practical conclusion

The patched Codex app can now support this architecture:

- main thread stays in charge
- child contexts run separate bounded work
- child contexts keep their own local multi-turn state
- parent enumerates and manages them through app-side routes
- controller code can deterministically create a clean child without opening a visible fresh main thread

That is the capability a harness or higher-level controller should build on.
