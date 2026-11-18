import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createNoticeDriver } from './notices-test-support.js';

const root = await fs.mkdtemp('/tmp/opencode/bot-notices-driver-');
const driver = await createNoticeDriver(root);
try {
  const receipt = await driver.notices.deliver(driver.request);
  const duplicate = await driver.notices.deliver(driver.request);
  assert.equal(receipt.itemId, duplicate.itemId);
  assert.equal(driver.runtime.sessionSnapshot(driver.sessionId).items.length, 1);
  driver.runtime.stop(); await driver.runtime.flush();
  const restored = driver.create();
  assert.equal((await restored.notices.deliver(driver.request)).itemId, receipt.itemId);
  driver.state.active = {}; driver.state.loseResponse = true;
  const failed = driver.nextSettled(); restored.runtime.start(); await failed;
  restored.runtime.stop(); await restored.runtime.flush();
  const retry = driver.create();
  const sent = driver.nextSent();
  await retry.notices.deliver(driver.request); retry.runtime.start(); await sent;
  retry.runtime.stop(); await retry.runtime.flush();
  const afterReceiptLoss = driver.create();
  const resent = driver.nextSent();
  await afterReceiptLoss.notices.deliver(driver.request); await resent;
  assert.equal(driver.state.messages.size, 1);
  const message = driver.state.messages.get(receipt.messageId);
  assert.equal(message.sessionId, driver.sessionId);
  assert.equal(message.metadata.kind, 'bot');
  assert.equal(message.resume, true);
  assert.equal(message.delivery, 'steer');
  assert.equal(driver.state.switches.length, 0);
  console.log(JSON.stringify({ persisted: true, concurrentAndRestartDedupe: true, lostResponseAndReceiptDedupe: true,
    itemId: receipt.itemId, messageId: receipt.messageId, sessionId: message.sessionId,
    transport: 'controlled loopback HTTP inference server; no live OpenCode or Docker isolation proved' }, null, 2));
} finally { await driver.close(); await fs.rm(root, { recursive: true, force: true }); }
