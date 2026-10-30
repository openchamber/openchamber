# Worktree branch picker

## Ownership

`NewWorktreeBranchPicker` owns the searchable branch lists used by the New Worktree dialog's branch and base-branch fields. Branch discovery and caching belong to the Git runtime and store. The picker receives the complete branch list and searches it locally.

## Invariants

- Sections with fewer than 40 branches render normally. Larger sections mount only the visible rows, overscan and active options. No branch is discarded from search or selection.
- Desktop keyboard navigation reaches the complete filtered result set. Arrow keys and Ctrl+N/P share cmdk's navigation; Home and End reach the first and last results.
- The command list scrolls on desktop; the mobile sheet's content scrolls on mobile. Virtual rows account for their section's offset within that ancestor and measure wrapped branch names.
- The active desktop option, its immediate neighbours and both section endpoints stay mounted while scrolling so cmdk can navigate them and keep its active-descendant reference valid.

## Decisions

### Why virtualize rows instead of limiting discovery

Opening the original picker with 50,000 synthetic remote branches mounted 50,002 desktop options and took roughly 6 seconds in a production browser fixture with no Git or network work. Virtualization bounds that rendering work while retaining full branch discovery and local search.

### Why virtual sections retain navigation targets

cmdk navigates mounted options only. Keeping adjacent options and endpoints mounted preserves its keyboard navigation, selection and accessibility handling without a second navigation implementation. Typing and navigation stop at the command root before the outer menu's typeahead; Escape reaches the menu for dismissal.
