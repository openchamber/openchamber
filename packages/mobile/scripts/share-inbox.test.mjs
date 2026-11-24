import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';

// The share inbox and the extension's strings are Foundation only, so they run on the Mac
// as they run on the phone. Provider reading and the plugin bridge need a device run.

const run = async (body) => {
  const scratch = await mkdtemp(new URL('../.share-inbox-test-', import.meta.url));
  try {
    const sources = await Promise.all(['ShareInbox.swift', 'ShareStrings.swift'].map((file) => (
      readFile(new URL(`../ios/App/OpenChamberShare/${file}`, import.meta.url), 'utf8')
    )));
    const child = spawn('/usr/bin/swift', ['-module-cache-path', scratch, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (data) => { errors += data; });
    const finished = once(child, 'close');
    child.stdin.end(`${sources.join('\n')}
import Foundation
let root = URL(fileURLWithPath: "${scratch}").appendingPathComponent("inbox")
let inbox = ShareInbox(root: root)
func check(_ condition: Bool, _ message: String, line: Int = #line) {
    if !condition { FileHandle.standardError.write("line \\(line): \\(message)\\n".data(using: .utf8)!); exit(1) }
}
${body}
exit(0)
`);
    const [code] = await finished;
    assert.equal(code, 0, errors);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

const darwin = { skip: process.platform !== 'darwin', timeout: 180_000 };

test('files are admitted against the Android limits, in order', darwin, () => run(`
check(ShareBudget.admits(index: 7), "the eighth file is read")
check(!ShareBudget.admits(index: 8), "the ninth file is refused unread")
var budget = ShareBudget()
let mb: Int64 = 1024 * 1024
check(budget.admit(size: 0) == .unreadable, "an empty file is named")
check(budget.admit(size: 10 * mb + 1) == .tooLarge, "over 10 MB is too large")
check(budget.admit(size: 10 * mb) == nil, "exactly 10 MB fits")
check(budget.admit(size: 10 * mb) == nil, "20 MB so far")
check(budget.admit(size: 10 * mb) == nil, "30 MB so far")
check(budget.admit(size: 3 * mb) == .batchLimit, "past 32 MB the file is refused")
check(budget.admit(size: 2 * mb) == nil, "a smaller file after it still fits")
check(budget.acceptedBytes == 32 * mb, "refused files cost nothing")
`));

test('a share is invisible until committed, round-trips, and is gone once removed', darwin, () => run(`
let source = root.deletingLastPathComponent().appendingPathComponent("source.pdf")
try! Data([1, 2, 3, 250]).write(to: source)
let draft = try! inbox.begin()
let staged = try! draft.stage(copying: source)
let late = try! draft.stage(copying: source)
try! draft.adopt(staged: staged, name: "report.pdf", mimeType: "application/pdf")
check(inbox.pendingIds().isEmpty, "a share being written is not handed out")
try! draft.commit(text: "see this", rejected: [.init(name: "big.zip", reason: .tooLarge)])
check(inbox.pendingIds() == [draft.id], "the committed share is pending")
let stored = inbox.load(id: draft.id)!
check(stored.manifest == ShareManifest(
    text: "see this",
    files: [.init(name: "report.pdf", mimeType: "application/pdf", stored: "0")],
    rejected: [.init(name: "big.zip", reason: .tooLarge)]), "the manifest round-trips")
check((try? Data(contentsOf: stored.directory.appendingPathComponent("0"))) == Data([1, 2, 3, 250]), "the bytes are unchanged")
check((try? FileManager.default.contentsOfDirectory(atPath: stored.directory.path))?.sorted() == ["0", ShareInbox.manifestName], "a copy staged but never adopted stays out of the share")
check(inbox.load(id: draft.id) != nil, "reading a share does not consume it")
check(inbox.remove(id: draft.id), "removing reports success")
check(inbox.pendingIds().isEmpty, "an accepted share is deleted")
let old = root.deletingLastPathComponent().appendingPathComponent("old.pdf")
try! Data([7]).write(to: old)
try! FileManager.default.setAttributes([.creationDate: Date(timeIntervalSince1970: 0)], ofItemAtPath: old.path)
let fresh = try! draft.stage(copying: old)
inbox.sweepAbandoned(olderThan: 600)
check(FileManager.default.fileExists(atPath: fresh.path), "a fresh copy of an old file is not swept")
inbox.sweepAbandoned(olderThan: 600, now: Date().addingTimeInterval(3600))
check(!FileManager.default.fileExists(atPath: late.path), "a late staged copy is swept")
`));

test('shares go oldest first, the tapped one last', darwin, () => run(`
var ids: [String] = []
for second in [100.0, 200.0, 300.0] {
    let draft = try! inbox.begin(now: Date(timeIntervalSince1970: second))
    try! draft.commit(text: "share", rejected: [])
    ids.append(draft.id)
}
check(inbox.pendingIds() == ids, "ids sort by creation time")
check(inbox.nextId(focus: nil) == ids[0], "oldest first")
check(inbox.nextId(focus: ids[0]) == ids[1], "the tapped share waits for the others")
check(inbox.nextId(focus: nil, excluding: [ids[0]]) == ids[1], "a share already done with is skipped")
inbox.remove(id: ids[1]); inbox.remove(id: ids[2])
check(inbox.nextId(focus: ids[0]) == ids[0], "and comes once it is the only one")
check(String(format: "%015lld-", Int64(1)) < ShareInbox.makeId(), "the id is zero-padded")
`));

test('an unreadable share is dropped instead of blocking the ones behind it', darwin, () => run(`
let broken = try! inbox.begin(now: Date(timeIntervalSince1970: 1))
try! broken.commit(text: "x", rejected: [])
try! Data("{".utf8).write(to: root.appendingPathComponent(broken.id).appendingPathComponent(ShareInbox.manifestName))
let good = try! inbox.begin(now: Date(timeIntervalSince1970: 2))
try! good.commit(text: "y", rejected: [])
check(inbox.load(id: broken.id) == nil, "a broken manifest is not handed out")
check(inbox.nextId(focus: nil) == good.id, "the next share is reachable")
`));

test('remove only deletes a share, and abandoned writes are swept', darwin, () => run(`
let kept = try! inbox.begin(now: Date(timeIntervalSince1970: 1))
try! kept.commit(text: "kept", rejected: [])
let marker = root.deletingLastPathComponent().appendingPathComponent("outside")
try! Data().write(to: marker)
check(!inbox.remove(id: "../outside"), "a path is not an id")
check(!inbox.remove(id: "."), "nor is the inbox itself")
check(!inbox.remove(id: ""), "nor is an empty id")
check(FileManager.default.fileExists(atPath: marker.path), "an id cannot leave the inbox")
check(inbox.pendingIds() == [kept.id], "the inbox is untouched")
let abandoned = try! inbox.begin()
inbox.sweepAbandoned(olderThan: 600)
check(FileManager.default.fileExists(atPath: abandoned.directory.path), "a write in progress is kept")
inbox.sweepAbandoned(olderThan: 600, now: Date().addingTimeInterval(3600))
check(!FileManager.default.fileExists(atPath: abandoned.directory.path), "an abandoned write is removed")
check(inbox.pendingIds() == [kept.id], "a committed share is never swept")
`));

test('the extension speaks the phone language, falling back to English', darwin, () => run(`
let languages = ["en", "ar", "de", "es", "fr", "he", "ja", "ko", "nl", "pl", "pt-BR", "tr", "uk", "zh-Hans", "zh-Hant"]
check(Set(ShareStrings.table.keys) == Set(languages), "one entry per app language")
check(ShareStrings.forPreferredLanguages(["uk-UA"]).openDraft == ShareStrings.table["uk"]!.openDraft, "Ukrainian")
check(ShareStrings.forPreferredLanguages(["zh-Hant-TW"]).openDraft == ShareStrings.table["zh-Hant"]!.openDraft, "Traditional Chinese")
check(ShareStrings.forPreferredLanguages(["zh-Hans-CN"]).openDraft == ShareStrings.table["zh-Hans"]!.openDraft, "Simplified Chinese")
check(ShareStrings.forPreferredLanguages(["pt-BR"]).openDraft == ShareStrings.table["pt-BR"]!.openDraft, "Brazilian Portuguese")
check(ShareStrings.forPreferredLanguages(["sv-SE"]).openDraft == ShareStrings.table["en"]!.openDraft, "English otherwise")
for (language, strings) in ShareStrings.table {
    for line in [strings.openDraft, strings.nothingTaken, strings.savedTitle, strings.savedMessage, strings.failedTitle, strings.failedMessage, strings.ok] {
        check(!line.isEmpty && line.count <= 80, "\\(language) has a short line for every message")
    }
}
`));
