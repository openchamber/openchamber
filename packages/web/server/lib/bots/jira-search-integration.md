# Jira search integration

The source contract accepts arbitrary user JQL. It has no Jira project setting. `createBotSources.jira` now sends the selected identity and revision, `operation: 'jira.search'`, `target: {}`, and the original `input.jql`, including any `ORDER BY`. It validates issue keys and admits results from multiple projects. Candidate URLs use the site of the selected identity. Item writes keep the existing issue-key-derived target.

The service boundary implements these rules:

1. In `services.js`, parse the `jira.search` target as a strict empty object, resolve its selected Jira identity, and call `searchJiraIssues(credential, rawInput)`. Remove the project-key dependency from this read branch only. Write targets remain unchanged.
2. In `services/jira.js`, change `searchJiraIssues` to accept `(credential, input)`. Send `parsed.data.jql` verbatim to `/rest/api/3/search/jql`. Remove the `project = "..." AND (...)` rewrite and the returned-results filter against a configured project. Keep provider payload validation, pagination, and any key/project self-consistency checks.
3. The credential resolver may use an explicit read-only search resource marker when `target.projectKey` is absent. It must not use a guessed project key. Normal Jira write target parsing and enterprise destination checks still require the admitted issue's project.
4. Add a real HTTP-adapter regression with `assignee = currentUser() ORDER BY updated DESC`, return issues from 2 projects, and assert that the upstream query string contains that exact JQL. Preserve selected identity/revision, cursor handling and authorization failure behavior.

`sources.test.js` covers the source request and multi-project candidate contract.
`services.test.js` drives the production service against a controlled HTTP upstream
with ordered JQL, multiple projects, selected credentials and pagination. These
checks do not establish live Jira authorization. Read failures remain errors.
