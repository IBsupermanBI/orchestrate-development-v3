'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fs,path}=require('../lib.cjs'),{collect,transcript,capture}=require('../telemetry.cjs'),{build,load}=require('../report.cjs');
const tmp=path.join(__dirname,'..','.scratch','v4-'+process.pid);fs.mkdirSync(tmp,{recursive:true});
process.env.CODEX_TIMESHEET_PATH=path.join(tmp,'events.jsonl');
const event=(hook_event_name,at,extra={})=>({hook_event_name,timestamp:'2026-09-07T12:'+at+'Z',session_id:'v4',cwd:tmp,turn_id:'root-turn',...extra});
test('requests, steering, explicit metadata and native children correlate without a guard',()=>{
 const request=collect(event('UserPromptSubmit','00:00',{prompt:'Make the preflight useful'}));assert.equal(request.goal_source,'request');assert(request.goal_id);
 assert.equal(collect(event('UserPromptSubmit','00:01',{prompt:'Also handle large scopes'})).goal_id,request.goal_id);
 collect(event('PostToolUse','00:02',{tool_name:'spawn_agent',tool_input:{},tool_response:{agent_id:'child'}}));
 const child=collect(event('UserPromptSubmit','00:03',{agent_id:'child',turn_id:'child-turn',prompt:'Implement the fix'}));assert.equal(child.parent_goal_id,request.goal_id);assert.notEqual(child.goal_id,request.goal_id);
 const completed=collect(event('SubagentStop','00:04',{agent_id:'child',turn_id:'child-turn',last_assistant_message:'Done'}));assert.equal(completed.goal_id,child.goal_id);assert.equal(completed.goal_outcome,null);assert.equal(completed.response_status,'completed');
 collect(event('GoalUpdate','00:05',{goal_id:'G1',objective:'Validate the fix',stage_id:'S1'}));
 assert.equal(collect(event('Stop','00:06')).goal_id,'G1');
 const next=collect(event('UserPromptSubmit','00:07',{turn_id:'next',prompt:'Now commit'}));assert.notEqual(next.goal_id,'G1');
});
test('actor-local turn fallback and repeated child runs exclude idle gaps',()=>{
 collect(event('UserPromptSubmit','01:00',{session_id:'timing',turn_id:'parent'}));
 collect(event('SubagentStart','01:01',{session_id:'timing',agent_id:'worker',turn_id:'one'}));
 collect(event('UserPromptSubmit','01:02',{session_id:'timing',agent_id:'worker',turn_id:'one'}));
 assert.equal(collect(event('SubagentStop','01:12',{session_id:'timing',agent_id:'worker',turn_id:'one'})).subagent_wall_clock,10);
 collect(event('UserPromptSubmit','02:00',{session_id:'timing',agent_id:'worker',turn_id:'two'}));
 collect(event('UserPromptSubmit','02:01',{session_id:'timing',agent_id:'worker',turn_id:'two'}));
 assert.equal(collect(event('SubagentStop','02:10',{session_id:'timing',agent_id:'worker',turn_id:'two'})).subagent_wall_clock,10);
 const root=collect(event('Stop','02:11',{session_id:'timing',turn_id:undefined}));assert.equal(root.turn_id,'parent');assert.equal(root.turn_wall_clock,71);
 const report=build(load([process.env.CODEX_TIMESHEET_PATH]).filter(r=>r.session_id==='timing'));assert.equal(report.rows[0].subagent_compute_elapsed,20);
});
test('large transcripts retain usage as an unpriced snapshot with bounded reads',()=>{
 const file=path.join(tmp,'large.jsonl'),fd=fs.openSync(file,'w');fs.writeSync(fd,' '.repeat(17*1024*1024)+'\n');
 const token_usage={input_tokens:100,cached_input_tokens:50,output_tokens:20};
 fs.writeSync(fd,JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:token_usage}}})+'\n');fs.closeSync(fd);
 const result=transcript(file,'long-turn',false);assert.equal(result.token_usage.input_tokens,100);assert.equal(result.usage_additive,false);assert.equal(result.usage_model,null);assert.equal(result.usage_source,'transcript_tail_snapshot');
});
test('text capture preserves both ends, marks truncation and respects opt-out',()=>{
 const r=capture('FIRST '+'x'.repeat(3000)+' LAST token=secret-value');assert(r.truncated);assert(r.text.startsWith('FIRST'));assert(r.text.includes('LAST'));assert(!r.text.includes('secret-value'));
 process.env.CODEX_TIMESHEET_CAPTURE_TEXT='0';try{assert.deepEqual(capture('private'),{text:null,truncated:null});}finally{delete process.env.CODEX_TIMESHEET_CAPTURE_TEXT;}
});
test('schema four additive usage survives the standalone loader',()=>{
 collect(event('Stop','03:00',{session_id:'usage',token_usage:{input_tokens:100,cached_input_tokens:20,output_tokens:5},usage_kind:'turn_delta',usage_additive:true}));
 const rows=load([process.env.CODEX_TIMESHEET_PATH]).filter(r=>r.session_id==='usage');assert.equal(rows[0].usage_additive,true);assert.equal(build(rows).rows[0].usage_by_scope.host_turn.input_tokens,100);
});
