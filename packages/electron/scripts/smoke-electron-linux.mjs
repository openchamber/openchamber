import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(electronRoot, '..', '..');

const runSmoke = (scriptName) => {
  const result = spawnSync(process.execPath, [path.join(scriptDir, scriptName)], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error([
      `${scriptName} failed with exit ${result.status}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join('\n'));
  }
  return { scriptName, stdout: result.stdout.trim() };
};

const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, 'utf8'));

const assertElectronBuilderLinuxConfig = async () => {
  const packageJson = await readJson(path.join(electronRoot, 'package.json'));
  assert(packageJson.name === '@openchamber/electron', 'Electron package name should remain scoped');
  assert(packageJson.license === 'MIT', 'Electron package should carry MIT license metadata for Linux packages');
  assert(packageJson.homepage === 'https://github.com/openchamber/openchamber', 'Electron package should carry homepage metadata for deb packaging');

  const build = packageJson.build || {};
  assert(build.artifactName === '${productName}-${version}-${arch}.${ext}', 'artifactName should remain version/arch stable');
  assert(build.directories?.output === 'dist', 'Electron Builder output should remain packages/electron/dist');
  assert(Array.isArray(build.files) && build.files.includes('dist-bundle/main.mjs') && build.files.includes('preload.mjs'), 'packaged app should include bundled main and preload');
  assert(build.extraResources?.some((entry) => entry?.from === 'resources/web-dist' && entry?.to === 'web-dist'), 'packaged Linux app should stage web-dist as an extra resource');

  const linuxTargets = build.linux?.target || [];
  assert(Array.isArray(linuxTargets), 'build.linux.target should be an array');
  assert(linuxTargets.join('|') === 'AppImage|deb', `Linux targets should remain AppImage|deb, got ${linuxTargets.join('|')}`);
  assert(build.linux?.category === 'Development', 'Linux category should remain Development');
  assert(build.linux?.executableName === 'openchamber', 'Linux executableName should remain openchamber');
  assert(build.linux?.desktop?.entry?.Name === 'OpenChamber', 'Linux desktop entry Name should remain OpenChamber');
  assert(build.linux?.desktop?.entry?.StartupWMClass === 'OpenChamber', 'Linux StartupWMClass should remain OpenChamber');
  assert(build.linux?.desktop?.entry?.StartupNotify === 'true', 'Linux StartupNotify should remain true');

  assert(build.deb?.packageName === 'openchamber', 'deb packageName should remain openchamber');
  assert(build.deb?.packageCategory === 'devel', 'deb packageCategory should remain devel');
  assert(build.deb?.priority === 'optional', 'deb priority should remain optional');
};

const assertBundleConfig = async () => {
  const bundleScript = await fs.readFile(path.join(scriptDir, 'bundle-main.mjs'), 'utf8');
  for (const helper of ['path-open-utils.mjs', 'linux-app-discovery.mjs', 'electron-lifecycle-utils.mjs']) {
    assert(!bundleScript.includes(`'../${helper}'`) && !bundleScript.includes(`'./${helper}'`), `bundle config should not externalize ${helper}`);
    assert(!new RegExp(`external:[\\s\\S]*${helper.replace('.', '\\.')}`).test(bundleScript), `bundle external list should not include ${helper}`);
  }
};

const assertArchPackageConfig = async () => {
  const archDir = path.join(electronRoot, 'pkg', 'arch');
  const [pkgbuild, srcinfo, readme, gitignore] = await Promise.all([
    fs.readFile(path.join(archDir, 'PKGBUILD'), 'utf8'),
    fs.readFile(path.join(archDir, '.SRCINFO'), 'utf8'),
    fs.readFile(path.join(archDir, 'README.md'), 'utf8'),
    fs.readFile(path.join(archDir, '.gitignore'), 'utf8'),
  ]);

  assert(pkgbuild.includes('pkgname=openchamber-electron'), 'PKGBUILD should keep openchamber-electron package name');
  assert(pkgbuild.includes("source=()"), 'PKGBUILD should remain local-only with no remote source');
  assert(pkgbuild.includes("license=('MIT')"), 'PKGBUILD should declare MIT license');
  assert(pkgbuild.includes("conflicts=('openchamber')"), 'PKGBUILD should keep openchamber conflict for /usr/bin/openchamber');
  assert(pkgbuild.includes('Exec=/opt/OpenChamber/openchamber %U'), 'PKGBUILD desktop entry should keep package executable and URL placeholder');
  assert(pkgbuild.includes('continue'), 'PKGBUILD should skip optional icon sizes that electron-builder did not emit');
  for (const dependency of ['gtk3', 'libnotify', 'nss', 'libxss', 'libxtst', 'xdg-utils']) {
    assert(pkgbuild.includes(`'${dependency}'`), `PKGBUILD should include ${dependency} runtime dependency`);
    assert(srcinfo.includes(`depends = ${dependency}`), `.SRCINFO should include ${dependency} runtime dependency`);
  }

  assert(srcinfo.includes('pkgbase = openchamber-electron'), '.SRCINFO should keep openchamber-electron pkgbase');
  assert(srcinfo.includes('pkgname = openchamber-electron'), '.SRCINFO should keep openchamber-electron pkgname');
  assert(srcinfo.includes('license = MIT'), '.SRCINFO should keep MIT license');
  assert(srcinfo.includes('arch = x86_64'), '.SRCINFO should keep x86_64 architecture');
  assert(srcinfo.includes('conflicts = openchamber'), '.SRCINFO should keep openchamber conflict');

  assert(readme.includes('bun run electron:build'), 'Arch README should document Electron build prerequisite');
  assert(readme.includes('packages/electron/dist/linux-unpacked/openchamber'), 'Arch README should document local linux-unpacked artifact prerequisite');
  assert(gitignore.includes('!PKGBUILD') && gitignore.includes('!.SRCINFO') && gitignore.includes('!README.md'), 'Arch .gitignore should keep packaging metadata tracked');

  const forbiddenPattern = /\b(curl|wget|git clone|pacman|paru|yay|makepkg -i|--install)\b|source=\('https?:|source=\('git/i;
  assert(!forbiddenPattern.test(pkgbuild), 'PKGBUILD should not fetch remote sources or install packages');
  assert(!/packages\/desktop/.test(`${pkgbuild}\n${readme}\n${srcinfo}`), 'Arch packaging should not reference packages/desktop');
};

const smokeResults = [
  runSmoke('smoke-path-open-utils.mjs'),
  runSmoke('smoke-linux-app-discovery.mjs'),
  runSmoke('smoke-electron-lifecycle-utils.mjs'),
];
await assertElectronBuilderLinuxConfig();
await assertBundleConfig();
await assertArchPackageConfig();

console.log(JSON.stringify({
  ok: true,
  smokeScripts: smokeResults.map((result) => result.scriptName),
  packageChecks: ['electron-builder-linux', 'bundle-main-local-helpers', 'arch-pkgbuild-srcinfo'],
}, null, 2));
