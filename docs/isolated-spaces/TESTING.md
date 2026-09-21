# Isolated spaces: testing

Read [DESIGN.md](DESIGN.md) first. The stage table in [STAGES.md](STAGES.md) says which checks belong to which stage.

## Real clusters are off limits

A developer's kubeconfig often contains real clusters, and the one used for this work does. No test, script, or manual check may touch a cluster it did not create. Every test names its own context and namespace explicitly and refuses to run against any other. Product code passes an explicit context and namespace on every `kubectl` call and creates nothing in a cluster until the user picks it.

## Evidence rule

Each checklist line ends as "passed, with evidence" or "blocked, with the reason". There is no "skipped". Evidence is command output, a screenshot, or a test run, from the pull request's final commit.

## Test layers

1. **Logic without a runtime.** Grant rules, domain and address matching, the clean-apply decision, label parsing. Fast unit tests that run everywhere.
2. **Contract suite for places.** One scenario set run against every place implementation. Written in stage 1 and then fixed.
3. **Full path on real Docker.** Create a space, code arrives, a scripted fake agent makes a change, apply, delete. A script stands in for the model, so the test is cheap and stable.
4. **Escape tests.** One test per promised restriction, run from inside the space as the attacker. The goal is "the agent cannot", never "it works". They run against every place.
5. **Manual checklist.** Journey steps 0 to 9, clicked through on each platform.

## Escape tests

From inside a space, each attempt must fail:

- Reach the internet directly, past the gatekeeper, by IP and by name.
- Resolve DNS without the gatekeeper.
- Reach a domain outside the allowlist through the gatekeeper.
- Reach the host's services, the local network, link-local and cloud metadata addresses, in allowlist mode and in open mode. Include DNS rebinding and IPv6-mapped forms.
- Find the model key or any "uses without seeing" secret in env, files, process lists, or container metadata.
- Find the bait secret from the repository's ignored `.env`.
- Reach the container runtime socket or gain privileges.
- Write outside the permitted paths on the read-only filesystem.
- Change, replace, or remount the tools volume that holds the programs the space runs.
- Find the token of the server inside the space in container metadata.
- Reach the server inside the space from the space's network.
- Reach the gatekeeper's control channel or another space's gatekeeper.
- Issue itself a grant, or forge a grant request through the server inside the space.
- Make the host run something through apply: git hooks, tags, refs outside the quarantine namespace.
- Make a file from the space render as a page under the app's origin, or set a cookie on it.
- See the user's OpenChamber cookies or tokens in any forwarded request.
- Claim, in its session list or events, a directory outside its own root, another space's directory, or a session id that exists on the host.
- Hang the result fetch forever or fill the host's disk with it. The host's timeout and size cap must end both, and the process left inside the space must be cleaned up.
- Get tree paths such as `.git/hooks/x`, `.GIT`, `..`, or `a/../../x` past the host's object checks, or write through a symlink or into `.git/` when applied as a patch.
- Reach `auth.openai.com`, in either network mode.
- Have a request without the space prefix, but with a space directory, run on the host.

On a place that cannot restrict the network, the probe must report that and the allowlist mode must be unavailable.

## Manual platforms

| Platform | Checked by hand |
|---|---|
| Mac desktop | Docker Desktop, Colima, Apple container, kind cluster, SSH place |
| Windows desktop | Docker Desktop |
| Linux desktop | Native Docker |
| Web | Full path on a server with Docker |
| Mobile | Quick look: group visible, session opens, actions present |

## Resources

The development Mac used so far has macOS 26, Colima with the docker CLI, kind, kubectl, and Apple `container` 1.1.

Needed before the stage that uses them:

- Apple `container` upgraded to 1.4 or newer. Version 1.1 cannot attach a container to two networks.
- Docker Desktop on the Mac, because most users run it.
- Two kind clusters: one whose network policies are enforced and one where they are ignored. The first proves the restriction, the second proves the probe says "cannot restrict".
- A Linux machine with Docker Engine 28 or newer, reachable over SSH. A local Lima VM for automated runs, and a real Debian machine for manual runs and for the Linux desktop pass.
- A Windows machine with Docker Desktop, reachable over SSH. A small one on purpose: a space must come up on a weak machine.
- An API-key model provider and an OpenAI browser login for the login stages.
- Disposable test secrets: a private GitHub repository with a token scoped to it, a private npm package with a token, a Copilot account for the live Copilot check.
- A bait repository with an ignored `.env` holding a fake secret, a file with the executable bit, and a small dev server.
