const test=require('node:test'),assert=require('node:assert/strict');
const {fs,path,profiles}=require('../lib.cjs');const {collect}=require('../telemetry.cjs');
const dir=path.join(__dirname,'..','.scratch','profile-tests-'+process.pid);fs.mkdirSync(dir,{recursive:true});process.env.CODEX_HOME=path.join(dir,'home');
const e=(name,x={})=>({hook_event_name:name,cwd:dir,session_id:'profiles',turn_id:'t',...x});
test('all review and orchestration profiles survive lifecycle without ledger',()=>{
 for(const [profile,[model,effort,cls]] of Object.entries(profiles)) {
 const id=profile;const start=collect(e('SubagentStart',{agent_id:id,agent_type:profile,model}));assert.equal(start.configured_effort,effort);assert.equal(start.observed_effort,null);
 const stop=collect(e('SubagentStop',{agent_id:id,model}));assert.equal(stop.profile,profile);assert.equal(stop.interaction_class,cls);assert.equal(stop.binding_state,'CONFIG_PINNED');
 }
});
test('native launch metadata is correlated, requested settings are never observed',()=>{
 const r=collect(e('PostToolUse',{tool_name:'collaboration.spawn_agent',tool_input:{model:'gpt-6-astra',reasoning_effort:'low',agent_type:'custom-new'},tool_response:{agent_id:'native'}}));assert.equal(r.created_agent_id,'native');
 const stop=collect(e('SubagentStop',{agent_id:'native'}));assert.equal(stop.profile,'custom-new');assert.equal(stop.requested_model,'gpt-6-astra');assert.equal(stop.requested_effort,'low');assert.equal(stop.observed_model,null);assert.equal(stop.configured_model,null);assert.equal(stop.binding_state,'UNVERIFIED');
});
test('MCP result and missing IDs are handled without guessing',()=>{
 collect(e('PostToolUse',{tool_name:'mcp__codex_app__create_thread',tool_input:{model:'gpt-5.6-sol',thinking:'medium'},tool_response:{content:[{type:'text',text:JSON.stringify({threadId:'task'})}]}}));
 assert.equal(collect(e('SubagentStart',{agent_id:'task'})).requested_effort,'medium');
 assert.equal(collect(e('PostToolUse',{tool_name:'spawn_agent',tool_input:{},tool_response:{success:false}})).created_agent_id,null);
});
test('observed mismatches remain visible',()=>{
 const r=collect(e('SubagentStart',{agent_id:'mismatch',agent_type:'v3-sol-medium-reviewer',model:'gpt-6-astra',observed_effort:'high'}));assert.equal(r.binding_state,'MISMATCH');
});
