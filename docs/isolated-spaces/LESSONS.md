# Isolated spaces: lessons and researched facts

Background for [DESIGN.md](DESIGN.md). Everything here was read from code, pull requests, and upstream sources by research agents on 2026-09-19. Nothing was run live. Re-check a fact before building on it, because upstream moves fast.

## The earlier attempt

Draft pull request #2393 ("secure workspace orchestration") with the companion repository `openchamber/opencode-container-workspace`. It stalled. Use that repository as a parts bin only. Do not read it for architecture or UI.

Why it stalled:

- Size. 201 files, about 20,000 lines, 100 commits, five packages, plus a separate repository. The review bot refused it and no human reviewed it.
- A certification treadmill. Every merge invalidated live evidence across a platform matrix that needed physical machines.
- It depended on OpenCode's unfinished workspaces feature: sync, the session link, version lockstep.
- UX: a long settings form, password prompts in the wrong places, errors that named symptoms, results that vanished on refresh.

What it did that this design reverses:

- The agent received the host's whole `auth.json`, refresh tokens included, as a file and an env variable. Refreshed tokens never returned to the host, so with rotating refresh tokens it would have broken the host login.
- The code snapshot ignored `.gitignore`, so `.env` files rode in.
- Code travelled as a tar archive without `.git`: size caps, double hashing, lost executable bits from Windows, GNU and BSD tar differences, and no way to bring later host changes in.
- State lived in four places. An interrupted create left a pod holding volumes and blocked every later clean-up. Discovery needed a local state file, so a missing file made real containers invisible.
- Gateway policy and ids travelled as env variables, visible in `inspect`, and a policy change needed a restart.
- Kubernetes network policies were accepted but not enforced on some clusters, so isolation was reported falsely until a probe existed.
- Provider auth widened the allowlist with wildcards such as `*.googleapis.com`. The preset's `*.githubusercontent.com` is a similar upload path.
- One image per release with OpenCode pinned inside. Version skew between image, plugin, and host was a standing release blocker.
- Its preset lacked `chatgpt.com` and `auth.openai.com`, so OpenAI browser login could not have worked there, and no live OAuth run was recorded.

Parts worth lifting from `origin/main` of that repository, with a fresh review:

- The network policy enforcement probe and the RBAC listing. Largest saving.
- The egress policy core: domain and CIDR matching, the forbidden address list with IPv6-mapped handling, rebinding protection. Add NAT64 `64:ff9b::/96`, idle timeouts, a connection cap, and live reload. `CONNECT` was untested.
- Docker hardening flags, the inspect-based verification (`hardenedContainer`, `exactNetworks`), and the not-found matching. Add a memory limit for the gatekeeper.
- Windows handling: tar to stdout, `taskkill /T /F` on timeout, `windowsHide`, `icacls` by SID with absolute System32 paths. One `kubectl auth can-i --list` instead of many calls.
- The preset domain list and the provider-to-domain map as data. The label scheme. The Kubernetes securityContext and NetworkPolicy builders.
- No test there runs from inside a container as an attacker. Escape tests are new work.

Measured there: a Kubernetes create took 80 to 120 seconds with a 1.3 GB image pull. Apple container's first pull exceeded a 300 second timeout.

## OpenCode workspaces

An experimental routing and sync layer, not a sandbox. Behind `OPENCODE_EXPERIMENTAL_WORKSPACES`, every route under `/experimental/`, no documentation, 94 commits of churn since February 2026. A plugin can register an adaptor whose target is a remote OpenCode server; the controller then proxies requests, re-emits events, and replays session data locally. It does nothing for process isolation, egress, credentials scoping, or apply and discard, and `create` hands the adaptor every stored credential.

Decision: stay independent. It covers only OpenCode's API, while files, git, terminal, and preview belong to OpenChamber and need our own forwarding anyway. Keep "merge sessions and events" a replaceable piece so it could move onto workspaces if they stabilise. We do not use the `workspace` parameter, so the two do not conflict.

## Provider logins

- OpenChamber users log in both ways. The Usage page tracks quotas for browser-login providers and for key providers.
- OpenAI browser login: OpenCode's Codex plugin refreshes only when the stored token has expired, hard-codes the ChatGPT endpoint, and shapes requests differently when the auth type is `oauth`. So a base URL plus a dummy key does not work, and a record with a real short access token and no usable refresh token does. Access tokens last about an hour. Refresh tokens rotate, so two refreshers log each other out. The allowlist needs `chatgpt.com`.
- Copilot: one long-lived GitHub token sent directly, no refresh, no conflict. The gatekeeper could hold it later.
- Claude Pro/Max: OpenCode removed this login in 1.3.0 because Anthropic prohibits it. API keys only.
- API-key providers: `options.apiKey` and `options.baseURL` in the provider config, with no stored auth entry, skip the auth plugin. That is the window path.
- Suspected and unverified on `main`: `packages/web/server/lib/small-model/call.js` refreshes the same OpenAI token separately from OpenCode without locking. Tracked as its own task.

## Apple container

As of 1.4.1 (2026-09-09), no longer pre-1.0. On macOS 26 it supports user networks, `network create --internal` (host-only), several networks per container, and `--network none`. That is enough for a space on an internal network behind a dual-homed gatekeeper, and its maintainers suggest the same layout. DNS does not resolve on host-only networks, so the gatekeeper must resolve for the space.

Open gaps upstream: a space on an internal network still reaches host services bound to all interfaces through the gateway address (issue 1320), and with `net.inet.ip.forwarding=1` on the host an internal network passes outbound TCP (issue 2062, fix in open pull request 2072). So the place check refuses the allowlist mode when forwarding is on, probes a raw address from the space, and tells the user about the host-services gap.

Recorded workarounds from the earlier attempt: volumes come up root-owned and need a chown step, single-file bind mounts fail, temp directories must sit outside the system temp, and there is no `no-new-privileges` equivalent.

## The existing server

- One OpenCode upstream per server process, held in a mutable singleton that about two dozen runtimes receive as a function. This is why the dispatcher forwards whole requests in front of the existing code.
- `validateDirectoryPath` stats every directory before an OpenChamber-owned route acts. A space path does not exist on the host, so space requests must be forwarded before that gate. Leave the gate as it is.
- Events already carry a directory. One shared reader serves all clients today, with a fixed reconnect delay and one replay buffer. A space's connection needs its own state and buffer.
- The Windows branch of the session list in `proxy.js` already merges several upstream lists. It is the precedent for the merged list.
- `/api/sessions/status` derives from the server's event stream, so space events must reach the same watcher.
- Dev server detection and the raw TCP dev tunnel already live on the server and work in the web runtime.
- No pattern exists for this server calling another OpenChamber server with credentials. The relay rules forbid the host injecting credentials on the relay path and forbid trusting loopback as authentication.
- SSH remote instances are Electron-only by rule and by storage. The SSH place avoids them by letting the docker CLI use the system `ssh`.
- The "connect another device" funnel in `RemoteInstancesPage.tsx` is the UX pattern for the places funnel: a configure phase and a result phase, with option cards gated by probed availability.

## Docker's internal network and the host

Checked live on 2026-09-19.

- On Engine 29 (Colima), a space on a plain `--internal` bridge connected to a listener on the Docker host through the bridge gateway. With `--opt com.docker.network.bridge.gateway_mode_ipv4=isolated` the bridge gets no host address and the connection fails.
- Debian 13 ships Docker 26.1.5 as `docker.io`. That engine accepts the isolated option without an error, stores it in the network's options, and still assigns a gateway. Only the checker rule "IPAM has no gateway" catches it. On that machine (amd64, native Linux, driven from the Mac with `DOCKER_HOST=ssh://`) `create` failed closed and the rollback left no container, network, or volume.
- So Linux users on a distribution's Docker package will be told to install Docker Engine 28 or newer. The place check must say that in plain words.
- After that machine was upgraded to Docker Engine 29.8.1, the whole contract suite and all escape tests passed against it, including the host listener test. That is native Linux on amd64, where the Docker host is the user's own machine. The run took 66 seconds over SSH, against 5 seconds locally, because every docker call opens its own SSH connection.
- Docker Desktop on Windows (Engine 29.6.2, with the module running on the Windows host): the isolated network has no gateway, the injected `host.docker.internal` and `gateway.docker.internal` names do not resolve from a space, and neither the WSL VM nor Windows loopback is reachable. An ordinary container there reaches both. A plain internal network reaches services in the WSL VM through its gateway, the same hole as on Linux. Over SSH, `docker pull` fails because Docker Desktop's credential helper cannot run in an SSH logon session. That belongs to the SSH session, not to the product.
- On an isolated network Docker gives the first container the `.1` address. A probe of `.1` from inside a space talks to the space itself and proves nothing about the host.
