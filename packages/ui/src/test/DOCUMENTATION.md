# UI test setup

## Ownership

This folder owns the Bun preload and fixtures shared by UI tests. The UI test
command runs each test file in a separate process.

## Invariants

- A test using `startInlineDiffFixturePool` unmounts its React root, terminates
  its worker pools, and then cleans up happy-dom and restores the globals.

## Decisions

### Why fixtures terminate Pierre's pools before restoring the DOM

Pierre's pools live beyond a React root and use animation frames even after the
root unmounts. The fixture uses the same hook as the inline diff viewer to wait
for its real pool before drawing the scenario. This keeps the provider's lazy
imports from creating a pool after teardown and lets the test stop the pool
while the browser globals still exist.
