# Publishing a security advisory

The agent drafts and publishes OpenChamber's GitHub security advisories (GHSA) through the REST API; the maintainer does not use the web form. Requesting a CVE and publishing each need the maintainer's explicit go; drafting does not.

1. **Draft.** `gh api -X POST repos/openchamber/openchamber/security-advisories --input advisory.json`, with `summary`, `description`, `severity` (or `cvss_vector_string`), `credits` (`[{"login": "<reporter>", "type": "finder"}]`) and `vulnerabilities`: `[{"package": {"ecosystem": "npm", "name": "@openchamber/web"}, "vulnerable_version_range": "< X.Y.Z", "patched_versions": "X.Y.Z"}]`.
2. **Request a CVE**, before publishing: `gh api -X POST repos/openchamber/openchamber/security-advisories/<GHSA-id>/cve`.
3. **Publish**: `gh api -X PATCH repos/openchamber/openchamber/security-advisories/<GHSA-id> -f state=published`.

The repository enforces `.github/VULNERABILITY_REPORT.yml` on advisories: the description needs a `### ` section for each required field of that form, under its exact label (`What does the attacker start with?`, `Where does it reproduce?`, `OpenChamber version`, `Summary`, `Proof of concept`, `Impact`), or the API answers HTTP 422. Patches and Workarounds sections can follow.

**The patched version is found by commit subject, not hash.** Rebasing `bohdan/dev` onto `main` gives fix commits new hashes, so find the first release carrying the fix with `git log --oneline --grep='<fix subject>' <tag>` against release tags rather than `git tag --contains <sha>`.
