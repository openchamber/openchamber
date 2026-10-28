# Browser/server source

## Ownership

This directory contains pure source used by both shared UI and Web server code.
It ships in the existing Web package and Docker image. It has no transport,
filesystem access, React components, or runtime credentials.

## Invariants

- OpenUI uses the official parser and evaluator. Host rules restrict root and
  actions. Component child unions do not add fatal errors beyond the upstream
  runtime; declared slots still delimit media and action traversal.
  Official diagnostics stay intact for the tool's error response.
- Default-tree traversal follows declared rendered slots. The browser selects
  initial media from those slots; unused declarations, object data, edited
  fields and restored snapshots cannot add media sources.
- Native image extraction recognizes `Image.src` and `ImageGallery.images[].src`
  only on their evaluated component nodes. The browser uses this helper.
- JavaScript is executed directly by Node and included by browser builds.
  Adjacent declarations describe the typed UI imports. Neither file is generated.

## Decisions

### Why this source lives in the Web package

The server must run after installing the published Web package without UI
workspace source or React dependencies. Shipping pure ESM through that package's
existing `files` contract supports both real consumers without a new workspace
package or a private executable-bundle build.
