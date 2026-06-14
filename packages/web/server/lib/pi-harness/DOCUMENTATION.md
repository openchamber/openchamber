# Pi-Harness Adapter Module

## Purpose

Server-side compatibility layer that enables OpenChamber's existing UI to work
with Pi-Harness as the backend agent runtime. Active only when
`OPENCHAMBER_BACKEND_RUNTIME=pi-harness`.

## SDK Route Contract (Milestone 0 Discovery)

The `@opencode-ai/sdk/v2` OpencodeClient wraps Session2 (v1) APIs that consume
these HTTP routes. The adapter must respond to the following routes:

### Session API (Session2 class)

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| session.list           | GET    | `/session`                       |
| session.create         | POST   | `/session`                       |
| session.status         | GET    | `/session/status`                |
| session.get            | GET    | `/session/{sessionID}`           |
| session.delete         | DELETE | `/session/{sessionID}`           |
| session.update         | PATCH  | `/session/{sessionID}`           |
| session.messages       | GET    | `/session/{sessionID}/message`   |
| session.prompt         | POST   | `/session/{sessionID}/message`   |
| session.promptAsync    | POST   | `/session/{sessionID}/prompt_async` |
| session.abort          | POST   | `/session/{sessionID}/abort`     |
| session.command        | POST   | `/session/{sessionID}/command`   |
| session.shell          | POST   | `/session/{sessionID}/shell`     |
| session.revert         | POST   | `/session/{sessionID}/revert`    |
| session.fork           | POST   | `/session/{sessionID}/fork`      |
| session.summarize      | POST   | `/session/{sessionID}/summarize` |
| session.todo           | GET    | `/session/{sessionID}/todo`      |
| session.children       | GET    | `/session/{sessionID}/children`  |
| session.diff           | GET    | `/session/{sessionID}/diff`      |
| session.init           | POST   | `/session/{sessionID}/init`      |
| session.share          | POST   | `/session/{sessionID}/share`     |
| session.unshare        | DELETE | `/session/{sessionID}/share`     |
| session.unrevert       | POST   | `/session/{sessionID}/unrevert`  |

### Path API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| path.get               | GET    | `/path`                          |

### Project API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| project.list           | GET    | `/project`                       |
| project.current        | GET    | `/project/current`               |
| project.directories    | GET    | `/project/{projectID}/directories` |

### Provider API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| provider.list          | GET    | `/provider`                      |
| provider.auth          | GET    | `/provider/auth`                 |

### Config API (directory-scoped)

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| config.get             | GET    | `/config`                        |
| config.update          | PATCH  | `/config`                        |
| config.providers       | GET    | `/config/providers`              |

### Global API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| global.config.get      | GET    | `/global/config`                 |
| global.event           | GET    | `/global/event` (SSE)            |
| global.health          | GET    | `/global/health`                 |
| global.dispose         | POST   | `/global/dispose`                |

### Event API (directory-scoped SSE)

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| event.subscribe        | GET    | `/event` (SSE)                   |

### App API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| app.agents             | GET    | `/agent`                         |
| app.skills             | GET    | `/skill`                         |

### Command API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| command.list           | GET    | `/command`                       |

### Question API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| question.list          | GET    | `/question`                      |
| question.reply         | POST   | `/question/{requestID}/reply`    |
| question.reject        | POST   | `/question/{requestID}/reject`   |

### Permission API

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| permission.list        | GET    | `/permission`                    |
| permission.reply       | POST   | `/permission/{requestID}/reply`  |

### Other APIs (in bootstrap)

| SDK call               | Method | URL                              |
|------------------------|--------|----------------------------------|
| mcp.status             | GET    | `/mcp`                           |
| lsp.status             | GET    | `/lsp`                           |
| vcs.get                | GET    | `/vcs`                           |

## POC routes

The adapter registers handlers for these routes. All other routes return
empty/stable synthetic responses sufficient for the UI to boot without error.

Sub-POC routes (return empty [] or {}):
- session.command, session.shell, session.revert, session.fork,
  session.summarize, session.todo, session.children, session.diff,
  session.init, session.share, session.update, question.*, permission.*,
  mcp.status, lsp.status, vcs.get, app.skills, command.list
