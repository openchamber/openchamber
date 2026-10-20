import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('both native plugins implement the name registered by the shared adapter', () => {
  const adapter = source('../../ui/src/lib/nativeScreenAwake.ts');
  const name = adapter.match(/registerPlugin<ScreenAwakePlugin>\('([^']+)'\)/)?.[1];
  assert.ok(name);
  assert.ok(source('../android/app/src/main/java/com/openchamber/app/ScreenAwakePlugin.java').includes(`@CapacitorPlugin(name = "${name}")`));
  assert.ok(source('../ios/App/App/ScreenAwake.swift').includes(`public let jsName = "${name}"`));
});

test('Android registers the local display plugin before bridge startup without lock-screen privileges', () => {
  const activity = source('../android/app/src/main/java/com/openchamber/app/MainActivity.java');
  const registration = activity.indexOf('registerPlugin(ScreenAwakePlugin.class)');
  assert.ok(registration >= 0 && registration < activity.indexOf('super.onCreate(savedInstanceState)'));
  const plugin = source('../android/app/src/main/java/com/openchamber/app/ScreenAwakePlugin.java');
  assert.match(plugin, /FLAG_KEEP_SCREEN_ON/);
  assert.doesNotMatch(plugin, /WAKE_LOCK|FLAG_TURN_SCREEN_ON|FLAG_SHOW_WHEN_LOCKED|setTurnScreenOn|PowerManager/);
});

test('iOS registers the local display plugin and includes its source in the app target', () => {
  assert.match(source('../ios/App/App/AppDelegate.swift'), /registerPluginInstance\(ScreenAwakePlugin\(\)\)/);
  const project = source('../ios/App/App.xcodeproj/project.pbxproj');
  const buildID = project.match(/(\w+) \/\* ScreenAwake\.swift in Sources \*\/ = \{isa = PBXBuildFile;/)?.[1];
  assert.ok(buildID);
  const sourcePhases = project.match(/isa = PBXSourcesBuildPhase;[\s\S]*?\};/g) ?? [];
  assert.equal(sourcePhases.filter((phase) => phase.includes(`${buildID} /* ScreenAwake.swift in Sources */`)).length, 1);
  assert.match(project, /path = ScreenAwake\.swift;/);
});
