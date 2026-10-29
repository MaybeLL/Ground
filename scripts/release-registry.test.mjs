import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { guardLatest, checkReadback, release } from './release-registry.mjs';
const manifest = { name: '@grounds-review/grounds', version: '0.2.38', publishConfig: { registry: 'https://registry.test' } };
test('stable promotion compares numeric components and prevents the observed late old release', () => {
  guardLatest('0.2.38', '0.2.37');
  guardLatest('0.2.38', '0.2.38');
  guardLatest('0.2.100', '0.2.99');
  assert.throws(() => guardLatest('0.2.37', '0.2.38'), /rollback/);
  assert.throws(() => guardLatest('0.2.38-beta.1', '0.2.37'), /Stable/);
  assert.throws(() => guardLatest('0.2.38', undefined), /Stable/);
});
test('version existence alone cannot pass promotion readback', () => {
  const pkg = { version: '0.2.38', dist: { integrity: 'sha512-ok' } };
  assert.throws(() => checkReadback(manifest, { latest: '0.2.37' }, pkg), /incomplete/);
  assert.throws(() => checkReadback(manifest, { latest: '0.2.38' }, pkg, 'sha512-other'), /integrity/);
  assert.throws(() => checkReadback(manifest, { latest: '0.2.38' }, {version:'0.2.38'}), /integrity/);
  checkReadback(manifest, {latest:'0.2.38'}, pkg, 'sha512-ok');
});
async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(),'release-registry-test-'));
  const tarball = join(root,'package.tgz');writeFileSync(tarball,'fixture bytes');
  const integrity = 'sha512-'+createHash('sha512').update('fixture bytes').digest('base64');
  const calls=[];
  const run = (command,args) => {
    calls.push([command,...args]);
    if(command==='tar')return JSON.stringify(manifest);
    if(args[0]==='publish')return '';
    assert.ok(args.includes('--prefer-online'));
    assert.ok(args.includes('--registry=https://registry.test'));
    assert.ok(args.some(a=>a.startsWith('--cache=')));
    return JSON.stringify(args.includes('dist-tags')?{latest:'0.2.38'}:{version:'0.2.38',dist:{integrity}});
  };
  try {await fn({tarball,integrity,calls,run});}finally{rmSync(root,{recursive:true,force:true});}
}
test('verified tarball is published once with explicit latest then checked by tag and integrity', async()=>fixture(async x=>{
  await release({mode:'publish',manifest,tarball:x.tarball,run:x.run});
  const publish=x.calls.filter(c=>c[1]==='publish');assert.equal(publish.length,1);assert.ok(publish[0].includes('--tag=latest'));
  assert.equal(x.calls.at(-1)[3],'dist-tags');
}));
test('mismatched tarball identity refuses all npm side effects', async()=>fixture(async x=>{
  await assert.rejects(release({mode:'publish',manifest,tarball:x.tarball,run:(c,a)=>c==='tar'?JSON.stringify({...manifest,version:'0.2.37'}):x.run(c,a)}),/Tarball/);
  assert.equal(x.calls.length,0);
}));
test('readback retries reads only and never silently repairs or republishes', async()=>fixture(async x=>{
  let tags=0, waits=0;
  const run=(c,a)=>{
    if(a.includes('dist-tags') && ++tags>1) {x.calls.push([c,...a]);return JSON.stringify({latest:'0.2.37'});}
    return x.run(c,a);
  };
  await assert.rejects(release({mode:'publish',manifest,tarball:x.tarball,run,sleep:async()=>{waits++;}}),/Do not re-publish/);
  assert.equal(x.calls.filter(c=>c[1]==='publish').length,1);assert.equal(waits,2);assert.equal(tags,4);
}));
test('registry failure and newer latest both block publication', async()=>fixture(async x=>{
  for(const result of ['network','newer']){
    await assert.rejects(release({mode:'publish',manifest,tarball:x.tarball,run:(c,a)=>{
      if(a.includes('dist-tags')){if(result==='network')throw new Error('network');return JSON.stringify({latest:'0.2.39'});}
      return x.run(c,a);
    }}));
  }
  assert.equal(x.calls.filter(c=>c[1]==='publish').length,0);
}));
test('transient tag propagation can converge without publishing in verify mode',async()=>{
  let count=0;
  await release({mode:'verify',manifest,sleep:async()=>{},run:(c,a)=>{
    assert.equal(a[0],'view');
    return JSON.stringify(a.includes('dist-tags')?{latest:++count===1?'0.2.37':'0.2.38'}:{version:'0.2.38',dist:{integrity:'sha512-ok'}});
  }});assert.equal(count,2);
});
