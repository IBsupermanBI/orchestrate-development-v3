'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {build,markdown,transcriptFallback}=require('../scripts/timesheet.cjs');
const e=(event,second,extra={})=>({event,recorded_at:`2026-09-07T12:00:${second}Z`,project_root:'/project',session_id:'s',turn_id:'t',...extra});
const opt={project:'/project',now:Date.parse('2026-09-08')};
test('request goals retain unknown outcome; text requires opt-in; coverage is explicit',()=>{
 const rows=[e('turn_started','00',{goal_id:'request-1',goal_source:'request',request_excerpt:'Private request'}),e('turn_completed','10',{goal_id:'request-1',goal_source:'request',result_summary:'Done'})];
 const r=build(rows,opt);assert.equal(r.goals[0].outcome,null);assert.equal(r.goals[0].active_union_seconds,10);assert.equal(r.coverage.completed_without_usage,1);assert(!JSON.stringify(r).includes('Private request'));assert(!markdown(r).includes('Private request'));
 assert(markdown(build(rows,{...opt,includeText:true})).includes('Private request'));
});
test('steering does not reset time and parallel agent compute is separate from union',()=>{
 const rows=[e('turn_started','00'),e('turn_started','05'),e('turn_started','03',{agent_id:'a',turn_id:'a'}),e('subagent_completed','13',{agent_id:'a',turn_id:'a'}),e('turn_completed','10')];
 const r=build(rows,opt);assert.equal(r.active_union_seconds,13);assert.equal(r.agent_compute_seconds,20);assert.equal(r.blocks.length,2);
});
test('latest snapshot replaces earlier model snapshot and never adds to delta credits',()=>{
 const u={input_tokens:1000000,cached_input_tokens:200000,output_tokens:100000};
 const common={token_usage:u,usage_scope:'subagent_session',usage_kind:'cumulative_snapshot',usage_additive:false};
 const rows=[e('usage_snapshot','00',{...common,observed_model:'gpt-5.6-luna'}),e('usage_snapshot','10',{...common,observed_model:'gpt-6-astra',usage_model:null})];
 const r=build(rows,opt);assert.equal(r.usage.length,1);assert.equal(r.usage[0].tokens.input_tokens,1000000);assert.equal(r.usage[0].estimated_credits,null);assert.equal(r.credits_by_model_and_scope.length,0);
});
test('fallback rejects wrong transcript identity and does not duplicate native completions',()=>{
 const tmp=path.join(__dirname,'..','.scratch','fallback-'+process.pid);fs.mkdirSync(path.join(tmp,'sessions'),{recursive:true});
 const file=path.join(tmp,'sessions','rollout-a.jsonl');
 const contents=id=>[{type:'session_meta',payload:{id,cwd:'/project'}},{type:'event_msg',timestamp:'2026-09-07T12:00:00Z',payload:{type:'task_started',turn_id:'at'}},{type:'event_msg',timestamp:'2026-09-07T12:00:10Z',payload:{type:'task_complete',turn_id:'at'}}].map(JSON.stringify).join('\n');
 const rows=[e('subagent_completed','10',{agent_id:'a',turn_id:'at',started_at:'2026-09-07T12:00:00Z'})];
 fs.writeFileSync(file,contents('wrong'));assert.equal(transcriptFallback(rows,tmp,'s').rows.length,1);
 fs.writeFileSync(file,contents('a'));assert.equal(transcriptFallback(rows,tmp,'s').rows.length,1);
});
test('goal credits use only in-period deltas and keep snapshots unallocated',()=>{
 const u={input_tokens:1000000,cached_input_tokens:200000,output_tokens:100000};
 const common={goal_id:'G1',goal_source:'explicit',observed_model:'gpt-5.6-luna',usage_scope:'host_turn',token_usage:u,usage_additive:true,usage_kind:'turn_delta'};
 const rows=[e('turn_completed','00',{...common,turn_id:'old'}),e('turn_completed','10',{...common,turn_id:'new'}),e('usage_snapshot','11',{...common,turn_id:'snapshot',usage_additive:false,usage_kind:'cumulative_snapshot'})];
 const r=build(rows,{...opt,from:'2026-09-07T12:00:05Z'});assert.equal(r.goals[0].additive_usage[0].tokens.input_tokens,1000000);assert.equal(r.goals[0].additive_usage[0].estimated_credits,7.1);assert.equal(r.goals[0].unallocated_usage_snapshots,1);
});
test('fallback fills a later usage gap despite earlier recorded usage',()=>{
 const tmp=path.join(__dirname,'..','.scratch','late-usage-'+process.pid);fs.mkdirSync(path.join(tmp,'sessions'),{recursive:true});
 const usage={input_tokens:100,cached_input_tokens:20,output_tokens:5};
 fs.writeFileSync(path.join(tmp,'sessions','rollout-s.jsonl'),[{type:'session_meta',payload:{id:'s',cwd:'/project'}},{type:'turn_context',payload:{model:'gpt-5.6-luna'}},{type:'event_msg',timestamp:'2026-09-07T12:00:10Z',payload:{type:'token_count',info:{total_token_usage:usage}}}].map(JSON.stringify).join('\n'));
 const r=transcriptFallback([e('turn_completed','00',{token_usage:{input_tokens:10}})],tmp,'s');assert.equal(r.rows.length,2);assert.equal(r.rows[1].token_usage.input_tokens,100);assert.equal(r.rows[1].usage_additive,false);
});
