import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createNativeFixture, nativeSpawnPlan, nativeSdkHostPlan } from '../helpers/nativeFixture';

test('settings native storage: retained startup overrides, global-only getters, parse guard and private revision', async () => {
  const fixture = await createNativeFixture('scopes');
  try {
    await nativeSdkHostPlan(fixture, 'dedicated', 'project');
    const plan = await nativeSpawnPlan(fixture);
    const root = plan.args
      .find((v) => v.endsWith('/dist/bundle/cli.js'))!
      .replace('/dist/bundle/cli.js', '');
    const source = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs'); const path = require('node:path');
      const {pathToFileURL} = require('node:url');
      (async () => {
        const {SettingsManager} = await import(pathToFileURL(${JSON.stringify(root + '/dist/index.js')}).href);
        const {createPreferenceOperations} = await import(pathToFileURL(${JSON.stringify(fixture.root + '/preferences.mjs')}).href);
        const cwd=process.cwd(), agentDir=process.env.PI_CODING_AGENT_DIR;
        const globalPath=path.join(agentDir,'settings.json'), projectPath=path.join(cwd,'.pi','settings.json');
        fs.writeFileSync(globalPath,JSON.stringify({cacheWarming:'off',transport:'sse',images:{unknown:'keep'},warnings:{private:'keep'}}));
        fs.writeFileSync(projectPath,JSON.stringify({transport:'auto',cacheWarming:'idle',defaultProjectTrust:'always'}));
        const active=SettingsManager.create(cwd,agentDir,{projectTrusted:true});
        active.applyOverrides({transport:'websocket'});
        const session={settingsManager:active,sessionManager:{},sessionId:'owned',modelRuntime:{getAvailableSnapshot:()=>[]},agent:{transport:'websocket'},isIdle:true};
        const fresh=()=>SettingsManager.create(cwd,agentDir,{projectTrusted:true});
        const ops=createPreferenceOperations(()=>session,fresh,{overrides:{transport:'websocket'}});
        let snapshot=ops.read();
        assert.equal(snapshot.rows.find(r=>r.key==='transport').source,'startup');
        assert.equal(snapshot.rows.find(r=>r.key==='transport').effective,'websocket');
        assert.equal(snapshot.rows.find(r=>r.key==='cacheWarming').effective,'off');
        assert.equal(snapshot.rows.find(r=>r.key==='defaultProjectTrust').effective,'ask');
        snapshot=await ops.save({type:'save_preference',key:'blockImages',value:true,expectedRevision:snapshot.revision,confirmGlobal:true});
        assert.equal(active.getTransport(),'websocket','unrelated native save must not discard captured startup overrides');
        assert.equal(snapshot.rows.find(r=>r.key==='transport').global,'sse');
        assert.equal(snapshot.rows.find(r=>r.key==='transport').project,'auto');
        assert.deepEqual(JSON.parse(fs.readFileSync(globalPath,'utf8')).images,{unknown:'keep',blockImages:true});
        const bytes=fs.readFileSync(globalPath,'utf8');
        const guarded=createPreferenceOperations(()=>session,fresh,{initialSettingsError:true});
        assert.throws(()=>guarded.read(),/READ_FAILED/);
        await assert.rejects(guarded.save({type:'save_preference',key:'blockImages',value:false,expectedRevision:snapshot.revision,confirmGlobal:true}),/READ_FAILED/);
        assert.equal(fs.readFileSync(globalPath,'utf8'),bytes);
        for(const value of [NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(ops.save({type:'save_preference',key:'httpIdleTimeoutMs',value,expectedRevision:snapshot.revision,confirmGlobal:true}),/INVALID/);
        console.log('PREFERENCES_PROVENANCE_PASS');
      })().catch(e=>{console.error(e);process.exitCode=1;});
    `;
    const { stdout } = await promisify(execFile)(
      plan.command,
      [...fixture.nodeArgs, '-e', source],
      { cwd: fixture.cwd, env: plan.env }
    );
    assert.match(stdout, /PREFERENCES_PROVENANCE_PASS/);
    assert.equal(fixture.requests, 0);
    assert.equal(await readFile(fixture.networkLog, 'utf8'), '');
  } finally {
    await fixture.dispose();
  }
});
