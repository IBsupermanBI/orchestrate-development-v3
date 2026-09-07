'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), cp=require('node:child_process');
const {fs,path,read,write}=require('../lib.cjs');
const {install}=require('../install.cjs');
const {build}=require('../report.cjs');
const scratch=path.join(__dirname,'..','.scratch'); fs.mkdirSync(scratch,{recursive:true});
const tmp=fs.mkdtempSync(path.join(scratch,'install-'));

test('dry-run, install, idempotence and removal preserve unrelated hooks, profiles and data',()=>{
 const home=path.join(tmp,'home');
 install({home}); assert(!fs.existsSync(home));
 const foreign={matcher:'.*',hooks:[{type:'command',command:'python astra-effort-guard.py'}]};
 write(path.join(home,'hooks.json'),{hooks:{PreToolUse:[foreign]}});
 fs.mkdirSync(path.join(home,'agents'),{recursive:true}); fs.writeFileSync(path.join(home,'agents','custom.toml'),'keep profile');
 const first=install({home,apply:true}), saved=read(first.config);
 assert.deepEqual(saved.hooks.PreToolUse,[foreign]);
 assert.equal(Object.values(saved.hooks).flatMap(g=>g.flatMap(x=>x.hooks)).filter(h=>h.command.includes('telemetry.cjs')).length,8);
 assert(!fs.existsSync(path.join(first.destination,'guard.cjs')));
 assert(!fs.existsSync(path.join(first.destination,'ledger.cjs')));
 assert.equal(fs.readFileSync(path.join(home,'agents/custom.toml'),'utf8'),'keep profile');
 fs.writeFileSync(path.join(first.destination,'rate-card.json'),'{"custom":true}');
 install({home,apply:true}); assert.deepEqual(read(first.config),saved);
 assert.deepEqual(read(path.join(first.destination,'rate-card.json')),{custom:true});
 const history=path.join(home,'timesheets','events.jsonl'); fs.mkdirSync(path.dirname(history),{recursive:true}); fs.writeFileSync(history,'history');
 install({home,remove:true}); assert.deepEqual(read(first.config),saved);
 install({home,remove:true,apply:true});
 assert.deepEqual(read(first.config).hooks.PreToolUse,[foreign]);
 assert.equal(Object.values(read(first.config).hooks).flatMap(g=>g.flatMap(x=>x.hooks)).length,1);
 assert.equal(fs.readFileSync(history,'utf8'),'history');
 assert(fs.existsSync(path.join(first.destination,'telemetry.cjs')));
 assert(fs.existsSync(path.join(first.backup,'hooks.json')));
});

test('conflicting telemetry registration aborts before files change',()=>{
 const home=path.join(tmp,'conflict'), command='node "'+path.join(home,'hooks','codex-hooks','telemetry.cjs')+'"';
 const value={hooks:{Stop:[{hooks:[{command,timeout:3},{command,timeout:8}]}]}};
 write(path.join(home,'hooks.json'),value);
 assert.throws(()=>install({home,apply:true}),/Conflicting/);
 assert.deepEqual(read(path.join(home,'hooks.json')),value);
 assert(!fs.existsSync(path.join(home,'hooks')));
});

test('malformed input and write failures remain fail-open',()=>{
 for(const input of ['{',JSON.stringify({hook_event_name:'Stop',session_id:'s',cwd:tmp})]) {
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,'..','telemetry.cjs')],{input,encoding:'utf8',env:{...process.env,CODEX_TIMESHEET_PATH:path.join(__filename,'events.jsonl')}});
  assert.equal(result.status,0); assert.deepEqual(JSON.parse(result.stdout),{});
 }
});

test('installed collector records time locally and honors text opt-out',()=>{
 const home=path.join(tmp,'live');const plan=install({home,apply:true});
 for(const [hook_event_name,timestamp] of [['UserPromptSubmit','2026-09-01T10:00:00Z'],['Stop','2026-09-01T10:02:00Z']]) {
  const result=cp.spawnSync(process.execPath,[path.join(plan.destination,'telemetry.cjs')],{input:JSON.stringify({hook_event_name,timestamp,session_id:'s',turn_id:'t',cwd:tmp,prompt:'private text',last_assistant_message:'private answer'}),encoding:'utf8',env:{...process.env,CODEX_HOME:home,CODEX_TIMESHEET_PATH:path.join(home,'events.jsonl'),CODEX_TIMESHEET_CAPTURE_TEXT:'0'}});
  assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),{});
 }
 const rows=fs.readFileSync(path.join(home,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows[1].turn_wall_clock,120);assert.equal(rows[0].request_excerpt,null);assert.equal(rows[1].result_summary,null);
 assert.equal(build(rows).global_elapsed_union,120);
});

test('unknown install options cannot silently enable a different mode',()=>{
 const result=cp.spawnSync(process.execPath,[path.join(__dirname,'..','install.cjs'),'--project',tmp],{encoding:'utf8'});
 assert.notEqual(result.status,0);
});
