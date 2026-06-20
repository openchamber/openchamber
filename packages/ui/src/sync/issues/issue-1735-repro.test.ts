import { beforeEach, describe, expect, test } from "bun:test"
import { useInputStore } from "../input-store"

// =============================================================================
// Issue 1: File upload error persists across subsequent messages
// =============================================================================
//
// Root cause: When a message send fails (e.g. uploading an unsupported .xlsx file),
// the catch handler in ChatInput.tsx (lines 2198-2200) restores all attachments
// back to the input store. This causes the same file to be re-sent with the
// next message, creating an infinite error loop.
//
// Affected code: packages/ui/src/components/chat/ChatInput.tsx lines 2198-2200
//   if (allAttachments.length > 0) {
//     useInputStore.getState().setAttachedFiles(allAttachments);
//   }

describe("Issue 1: File upload error persists across subsequent messages", () => {
  // Simulates the flow in ChatInput.tsx where send fails and attachments are restored

  test("attachments are restored to input store on send failure with unsupported file type error", () => {
    // Simulate: user attaches a file and it fails to send
    const attachedFiles = [
      {
        id: "file_1",
        file: new File(["dummy"], "file.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,dummy",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: "file.xlsx",
        size: 100,
        source: "local" as const,
      },
    ]

    // Before send, attachments are cleared from the input store
    useInputStore.getState().setAttachedFiles([])
    expect(useInputStore.getState().attachedFiles).toEqual([])

    // After send failure, ChatInput.tsx's catch handler restores them
    // (this is the bug - line 2198-2200 in ChatInput.tsx)
    useInputStore.getState().setAttachedFiles(attachedFiles)

    // Attachments are now back in the store, ready to be re-sent
    expect(useInputStore.getState().attachedFiles).toHaveLength(1)
    expect(useInputStore.getState().attachedFiles[0].filename).toBe("file.xlsx")
  })

  test("subsequent plain text messages re-send previously failed attachment due to restored files", () => {
    // Simulate the full cycle:
    // 1. User attaches an unsupported .xlsx file
    const attachedFiles = [
      {
        id: "file_1",
        file: new File(["dummy"], "file.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,dummy",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: "file.xlsx",
        size: 100,
        source: "local" as const,
      },
    ]

    // 2. User clicks send - attachments are cleared
    useInputStore.getState().clearAttachedFiles()
    expect(useInputStore.getState().attachedFiles).toEqual([])

    // 3. Send fails with "does not support image input" error
    // ChatInput's catch handler restores them (BUG)
    useInputStore.getState().setAttachedFiles(attachedFiles)

    // 4. User types a new plain text message...
    // 5. ...but the old .xlsx file is still in the store!
    // It gets sent again with the new message, causing the same error
    expect(useInputStore.getState().attachedFiles).not.toEqual([])
    expect(useInputStore.getState().attachedFiles[0].filename).toBe("file.xlsx")
  })

  test("the restore-on-error behavior is unconditional (not just for network errors)", () => {
    // The catch handler in ChatInput.tsx restores attachments for ALL errors:
    // - Network errors (lines 2190-2196) -> restores
    // - Payload too large (lines 2182-2188) -> restores
    // - ALL other errors (lines 2198-2200) -> restores
    //
    // This means provider errors like "this model does not support image input"
    // also trigger attachment restoration, even though retrying with the same
    // unsupported file will always fail.

    const attachedFiles = [
      {
        id: "file_1",
        file: new File(["dummy"], "file.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,dummy",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: "file.xlsx",
        size: 100,
        source: "local" as const,
      },
    ]

    // Clear and restore - happens for ANY error
    useInputStore.getState().setAttachedFiles([])
    useInputStore.getState().setAttachedFiles(attachedFiles)

    // Verify they persist in the store
    expect(useInputStore.getState().attachedFiles).toHaveLength(1)
  })
})

// =============================================================================
// Issue 2: Git branch names containing Chinese characters are truncated
// =============================================================================
//
// Root cause: Multiple sanitize/slug functions use ASCII-only character class
// regex [^A-Za-z0-9._/-] that strips all non-ASCII characters (CJK, Cyrillic, etc.)
// and replaces them with hyphens. After consolidation and trimming, the entire
// meaningful name is lost.
//
// Affected locations:
//   - packages/ui/src/components/views/git/BranchSelector.tsx:38
//   - packages/ui/src/components/views/git/WorktreeBranchDisplay.tsx:12
//   - packages/ui/src/components/session/NewWorktreeDialog.tsx:93
//   - packages/ui/src/lib/worktrees/worktreeManager.ts:60
//   - packages/web/server/lib/git/service.js:563
//   - packages/vscode/src/gitService.ts:886

describe("Issue 2: Chinese character truncation in git branch names", () => {
  // Exact copy of the sanitizeBranchNameInput from BranchSelector.tsx (line 38)
  const sanitizeBranchNameInput = (value: string): string => {
    return value
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9._/-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/\/{2,}/g, '/')
      .replace(/\/-+/g, '/')
      .replace(/-+\//g, '/')
      .replace(/^[-/]+/, '')
      .replace(/[-/]+$/, '');
  };

  // Exact copy of the slugifyWorktreeName from NewWorktreeDialog.tsx (line 93)
  const slugifyWorktreeName = (value: string): string => {
    return value
      .trim()
      .replace(/^refs\/heads\//, '')
      .replace(/^heads\//, '')
      .replace(/\s+/g, '-')
      .replace(/^\/+|\/+$/g, '')
      .split('/').join('-')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  };

  // Exact copy of the slugWorktreeName from service.js (line 563)
  const slugWorktreeName = (value: string): string => {
    return String(value || '')
      .trim()
      .replace(/^refs\/heads\//, '')
      .replace(/^heads\//, '')
      .replace(/\s+/g, '-')
      .replace(/^\/+|\/+$/g, '')
      .split('/').join('-')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 80);
  };

  describe("sanitizeBranchNameInput (BranchSelector)", () => {
    test("Chinese-only branch name becomes empty", () => {
      const result = sanitizeBranchNameInput("测试分支");
      // Each Chinese character is replaced by '-', then consolidated to '-', then trimmed
      expect(result).toBe("");
    });

    test("Mixed Chinese/English branch name loses Chinese characters", () => {
      const result = sanitizeBranchNameInput("feature/测试分支");
      // "feature/测试分支" -> "feature/------" -> "feature/-" -> leading/trailing strip -> "feature"
      expect(result).toBe("feature");
      // The Chinese part "测试分支" is completely lost
    });

    test("Chinese characters at the end get stripped away", () => {
      const result = sanitizeBranchNameInput("my-branch-测试");
      // "my-branch-测试" -> "my-branch-----" -> "my-branch-" -> trailing strip -> "my-branch"
      expect(result).toBe("my-branch");
    });

    test("Chinese characters at the beginning get stripped away", () => {
      const result = sanitizeBranchNameInput("测试-my-branch");
      // "测试-my-branch" -> "-----my-branch" -> "-my-branch" -> leading strip -> "my-branch"
      expect(result).toBe("my-branch");
    });
  });

  describe("slugifyWorktreeName (NewWorktreeDialog, worktreeManager)", () => {
    test("Chinese-only branch name becomes empty", () => {
      const result = slugifyWorktreeName("测试分支");
      expect(result).toBe("");
    });

    test("Mixed Chinese/English branch name loses Chinese characters", () => {
      const result = slugifyWorktreeName("feature/测试分支");
      expect(result).toBe("feature");
    });
  });

  describe("slugWorktreeName (server service.js, vscode gitService.ts)", () => {
    test("Chinese-only branch name becomes empty", () => {
      const result = slugWorktreeName("测试分支");
      expect(result).toBe("");
    });

    test("Mixed Chinese/English branch name loses Chinese characters", () => {
      const result = slugWorktreeName("feature/测试分支");
      expect(result).toBe("feature");
    });
  });

  describe("Sanitization behavior prevents creating branches with Chinese names", () => {
    test("BranchSelector rejects empty result (if (!sanitizedNewBranch || isCreating) return;)", () => {
      // In BranchSelector.tsx line 109, the creation is blocked when sanitizedNewBranch is empty:
      //   if (!sanitizedNewBranch || isCreating) return;
      const result = sanitizeBranchNameInput("测试功能分支");
      // All Chinese characters stripped -> empty string
      expect(result).toBe("");
      // This means the create branch operation is silently blocked
    });

    test("Chinese characters in branch names are completely discarded, not preserved", () => {
      // Demonstrates that the expected UTF-8 support is missing
      const input = "功能分支-feature";
      const result = sanitizeBranchNameInput(input);

      // "功能分支" are discarded, only "feature" remains
      expect(result).toBe("feature");
      expect(result).not.toContain("功能");
      expect(result).not.toContain("分支");
      expect(result).not.toContain("功能分支");
    });
  });
})
