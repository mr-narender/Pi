import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createNativeFixture, nativeSpawnPlan } from '../helpers/nativeFixture';

const exec = promisify(execFile);

test('native fixture uses private roots, a strict environment and a validated JS entry', async () => {
  const originalCanary = process.env.CANARY_SECRET;
  process.env.CANARY_SECRET = 'fixture-inherited-canary';
  const fixture = await createNativeFixture();
  try {
    assert.equal((await stat(fixture.root)).mode & 0o777, 0o700);
    const plan = await nativeSpawnPlan(fixture);
    assert.equal(plan.command, process.execPath);
    assert.ok(plan.args.includes('--permission'));
    assert.ok(plan.args.includes('--no-extensions'));
    assert.ok(plan.args.includes('--no-context-files'));
    assert.ok(plan.args.some((arg) => arg.endsWith('/dist/bundle/cli.js')));
    for (const key of [
      'OPENAI_API_KEY',
      'AWS_PROFILE',
      'GITHUB_TOKEN',
      'NODE_OPTIONS',
      'HTTP_PROXY',
      'PI_AGENT_DIR',
      'CANARY_SECRET',
    ]) {
      assert.equal(plan.env[key], undefined);
    }
    assert.equal(plan.env.HOME, fixture.home);
    assert.equal(plan.env.PI_CODING_AGENT_DIR, fixture.agentDir);
    await assert.rejects(nativeSpawnPlan(fixture, ['--api-key', 'unsafe']));
    await assert.rejects(nativeSpawnPlan(fixture, ['-e', '/outside/extension.js']));
    const linkedSettings = await fixture.linkSettings('global');
    assert.equal(await realpath(fixture.globalSettings), linkedSettings);
    assert.ok(linkedSettings.startsWith(fixture.root + '/'));
    assert.equal(
      JSON.parse(await readFile(linkedSettings, 'utf8')).defaultProvider,
      'fixture-alpha'
    );
    assert.equal(fixture.requests, 0);
  } finally {
    await fixture.dispose();
    if (originalCanary === undefined) delete process.env.CANARY_SECRET;
    else process.env.CANARY_SECRET = originalCanary;
  }
});

test('synthetic child denies egress before DNS and permits only its owned HTTP fixture', async (t) => {
  const fixture = await createNativeFixture();
  try {
    const plan = await nativeSpawnPlan(fixture);
    const sdkRoot = plan.args
      .find((arg) => arg.endsWith('/dist/bundle/cli.js'))!
      .replace('/dist/bundle/cli.js', '');
    const script = `
      const assert = require('node:assert/strict');
      const net = require('node:net');
      const tls = require('node:tls');
      const http = require('node:http');
      const https = require('node:https');
      const dns = require('node:dns');
      const dgram = require('node:dgram');
      (async () => {
        for (const url of ['http://example.invalid/?secret=CANARY', 'http://169.254.169.254', 'http://127.0.0.1:1234', 'http://[::1]:1234', 'http://2130706433:1234', 'http://localhost:${fixture.port}', 'https://127.0.0.1:${fixture.port}']) {
          await assert.rejects(fetch(url), /FIXTURE_NETWORK_DENIED/);
        }
        for (const f of [() => net.connect(80, 'example.invalid'), () => net.connect({path:'/tmp/private.sock'}), () => net.connect({host:'::ffff:127.0.0.1',port:${fixture.port}}), () => tls.connect(${fixture.port}, '127.0.0.1'), () => http.get('http://example.invalid'), () => https.get('https://example.invalid'), () => dns.lookup('example.invalid'), () => new dns.Resolver().resolve4('example.invalid'), () => new tls.TLSSocket().connect(${fixture.port}, '127.0.0.1'), () => dgram.createSocket('udp4').send('x', 53, 'example.invalid')]) {
          assert.throws(f, /FIXTURE_NETWORK_DENIED/);
        }
        await assert.rejects(new dns.promises.Resolver().resolve4('example.invalid'), /FIXTURE_NETWORK_DENIED/);
        await assert.rejects(dns.promises.lookup('example.invalid'), /FIXTURE_NETWORK_DENIED/);
        assert.throws(() => require('node:child_process').spawn('curl', ['https://example.invalid']), /permission|Access/i);
        assert.throws(() => require('node:fs').readFileSync('/etc/passwd'), /Access/i);
        assert.throws(() => require('node:fs').writeFileSync('/outside-fixture-canary', 'dummy'), /Access/i);
        assert.throws(() => new (require('node:worker_threads').Worker)('0', {eval:true}), /Access/i);
        const undici = require(${JSON.stringify(sdkRoot + '/node_modules/undici')});
        await assert.rejects(undici.request('http://example.invalid/?secret=CANARY'), /FIXTURE_NETWORK_DENIED/);
        assert.equal(process.env.CANARY_SECRET, undefined);
        const reply = await fetch('http://127.0.0.1:${fixture.port}/v1/chat/completions', {method:'POST'});
        assert.equal(reply.status, 200);
        console.log('PROBE_PASS');
      })().catch(() => { process.exitCode = 1; });
    `;
    const { stdout } = await exec(plan.command, [...fixture.nodeArgs, '-e', script], {
      cwd: fixture.cwd,
      env: plan.env,
    });
    assert.match(stdout, /PROBE_PASS/);
    assert.equal(fixture.requests, 1);
    const log = await readFile(fixture.networkLog, 'utf8');
    const attempts = log.split('\n').filter(Boolean);
    assert.ok(attempts.length >= 20);
    assert.doesNotMatch(log, /CANARY|secret=|\/private\.sock/);
    for (const attempt of attempts)
      assert.deepEqual(Object.keys(JSON.parse(attempt)), ['kind', 'host', 'port']);
    t.diagnostic(
      `locally denied attempts=${attempts.length}; owned HTTP requests=${fixture.requests}`
    );
  } finally {
    await fixture.dispose();
  }
});
