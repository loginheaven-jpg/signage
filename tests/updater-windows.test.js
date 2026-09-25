const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTool } = require('../client/updater');
const { sha256, validateManifest } = require('../client/updater');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-windows-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('signage-windows-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return root;
}
async function zip(root, entries) {
  const input = path.join(root, 'entries.json'), script = path.join(root, 'make.ps1'), archive = path.join(root, 'test.zip');
  fs.writeFileSync(input, JSON.stringify(entries));
  fs.writeFileSync(script, `param($InputFile,$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archive=[IO.Compression.ZipFile]::Open($OutputFile,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach($item in (Get-Content -LiteralPath $InputFile -Encoding UTF8 -Raw | ConvertFrom-Json)) {
    $entry=$archive.CreateEntry($item.name)
    $writer=New-Object IO.StreamWriter($entry.Open())
    $writer.Write($item.body)
    $writer.Dispose()
  }
} finally { $archive.Dispose() }
`);
  await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, input, archive]);
  return archive;
}
const extractScript = path.join(__dirname, '../client/extract.ps1');
test('real Windows ZIP extraction supports Korean paths and rejects traversal and case collisions', { timeout: 20000 }, async t => {
  for (const [name, entries, valid] of [
    ['normal', [{ name: 'assets/사용 설명.txt', body: 'hello' }], true],
    ['traversal', [{ name: '../escaped.txt', body: 'bad' }], false],
    ['case-collision', [{ name: 'Main.js', body: 'one' }, { name: 'main.js', body: 'two' }], false],
    ['drive', [{ name: 'C:/escaped.txt', body: 'bad' }], false]
  ]) {
    const root = fixture(t), archive = await zip(root, entries), destination = path.join(root, '한글 설치 폴더');
    const extraction = runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', extractScript,
      '-Archive', archive, '-Destination', destination]);
    if (valid) {
      await extraction;
      assert.equal(fs.readFileSync(path.join(destination, 'assets/사용 설명.txt'), 'utf8'), 'hello');
    } else await assert.rejects(extraction, /failed/, name);
    assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
  }
});

test('Windows bootstrap mutex prevents duplicate starts without changing the real Startup folder', { timeout: 15000 }, async t => {
  const root = fixture(t), installation = path.join(root, '한글 설치 폴더');
  fs.mkdirSync(installation);
  fs.copyFileSync(path.join(__dirname, '../client/bootstrap.ps1'), path.join(installation, 'bootstrap.ps1'));
  fs.writeFileSync(path.join(installation, 'updater.js'), `
    const fs = require('fs'), path = require('path');
    const root = process.argv[process.argv.indexOf('--root') + 1];
    fs.appendFileSync(path.join(root, 'started.txt'), 'started\\n');
    setTimeout(() => process.exit(0), 3000);
  `);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(installation, 'bootstrap.ps1'), '-NoStartupRegistration'];
  const first = runTool('powershell.exe', args, { timeout: 10000 });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(installation, 'started.txt')); i++) await new Promise(r => setTimeout(r, 100));
  await runTool('powershell.exe', args, { timeout: 10000 });
  await first;
  assert.equal(fs.readFileSync(path.join(installation, 'started.txt'), 'utf8'), 'started\n');
});

test('published manifest matches the ZIP and the install bundle has every bootstrap dependency', { timeout: 15000 }, async t => {
  const root = fixture(t);
  const publicDir = path.resolve(__dirname, '../host/public');
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(publicDir, 'updates/client.json'))), 'https://signage.yebom.org');
  const archive = path.join(publicDir, new URL(manifest.url).pathname);
  const bytes = fs.readFileSync(archive);
  assert.equal(sha256(bytes), manifest.sha256);
  assert.equal(bytes.length, manifest.size);
  assert.equal(sha256(fs.readFileSync(path.join(publicDir, 'downloads/signage-client.zip'))), manifest.sha256);
  const destination = path.join(root, 'bundle');
  await runTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', extractScript,
    '-Archive', archive, '-Destination', destination]);
  for (const file of ['start.bat', 'bootstrap.ps1', 'updater.js', 'extract.ps1', 'runtime.json', 'package-lock.json', 'supervisor-health.js', 'main.js', 'preload.js']) {
    assert.deepEqual(fs.readFileSync(path.join(destination, file)), fs.readFileSync(path.join(__dirname, '../client', file)));
  }
  for (const file of ['config.json', 'cache', 'node_modules', '.signage']) assert.equal(fs.existsSync(path.join(destination, file)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'package.json'))).version, manifest.version);
});
