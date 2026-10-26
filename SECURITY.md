# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenChamber, please report it responsibly.

**Email:** [security@openchamber.dev](mailto:security@openchamber.dev)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Potential impact

I'll acknowledge receipt within 48 hours and aim to provide a fix or mitigation as quickly as possible.

**Please do not open public GitHub issues for security vulnerabilities.**

## Scope

OpenChamber handles sensitive context including:
- UI authentication (password-protected sessions, JWT tokens)
- Cloudflare tunnel access (remote connectivity)
- Terminal access (PTY sessions)
- Git credentials and SSH keys
- File system operations

Security reports related to any of these areas are especially appreciated.

## Threat model

Signing in to OpenChamber gives you the same access as the user running it: a terminal, an agent with a shell, and file access anywhere that user can read or write. Checks inside a signed-in session, such as the workspace limits on file routes or how symlinks resolve, keep the interface predictable. They are not a security boundary, and bypassing them is not a vulnerability.

What I treat as a vulnerability:
- reaching any of that without signing in: authentication bypass, exposure on the network, tunnel, relay or pairing flaws, requests from other websites acting with your session;
- content you didn't write acting on your behalf: a repository, web page, agent output, HTML preview or third-party extension that runs code, reads files or credentials, or escapes its sandbox;
- credentials or conversation content leaving the machine somewhere you didn't send them.

## Supported Versions

Security fixes are applied to the latest release. There is no LTS or backport policy at this time.
