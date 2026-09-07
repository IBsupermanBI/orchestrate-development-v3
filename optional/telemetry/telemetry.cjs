'use strict';
const {fs,path,hash,read,lock,write,root,ledgerPath,profiles,classes,redact,usage,keys}=require('./lib.cjs');
const os=require('node:os'), crypto=require('node:crypto');
const launches=['Agent','spawn_agent','create_thread','fork_thread'];
const tracked=[...launches,'apply_patch','close_agent','archive_agent','set_thread_archived'];
function launchResult(value) {
 if(typeof value==='string') {try{return launchResult(JSON.parse(value));}catch{return {};}}
 if(!value||typeof value!=='object'||value.isError||value.success===false) return {};
 if(value.agent_id||value.threadId||value.id) return value;
 if(value.structuredContent) return launchResult(value.structuredContent);
 for(const c of value.content||[]) {if(c.type==='text') {const r=launchResult(c.text);if(r.agent_id||r.threadId||r.id)return r;}}
 return {};
}
const events={SessionStart:'session_started',SessionEnd:'session_ended',UserPromptSubmit:'turn_started',Stop:'turn_completed',Interrupt:'turn_interrupted',SubagentStart:'subagent_started',SubagentStop:'subagent_completed',PostToolUse:'tool_lifecycle'};
function transcript(file, turn, child) {
 if(!file||!fs.existsSync(file)) return null;
 // Diagnostics only, never lifecycle authority. Bound IO to keep hooks responsive.
 if(fs.statSync(file).size>16*1024*1024) return null;
 let current, previous=null, baseline=null, final=null, seen=false;
 for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
  let r; try { r=JSON.parse(line); } catch { continue; }
  const p=r.payload; if(r.type!=='event_msg'||!p) continue;
  if(p.type==='task_started') { current=p.turn_id; if(current===turn) { baseline=previous; seen=true; } }
  if(p.type==='token_count'&&p.info?.total_token_usage) { previous=usage(p.info.total_token_usage); if(child||current===turn) final=previous; }
 }
 if(!final) return null;
 if(child) return {token_usage:final,usage_kind:'cumulative_snapshot',usage_additive:false};
 if(!seen||!baseline||keys.some(k=>final[k]!=null&&baseline[k]!=null&&final[k]<baseline[k])) return {token_usage:final,usage_kind:'cumulative_snapshot',usage_additive:false};
 return {token_usage:Object.fromEntries(keys.map(k=>[k,final[k]==null||baseline[k]==null?null:final[k]-baseline[k]])),usage_kind:'turn_delta',usage_additive:true};
}
function collect(input) {
 const event=input.hook_event_name; if(!events[event]) return;
 const tool=String(input.tool_name||'').split(/__|\./).pop();
 if(event==='PostToolUse'&&!tracked.includes(tool)) return;
 const at=input.timestamp?new Date(input.timestamp).toISOString():new Date().toISOString();
 const cwd=path.resolve(input.cwd||process.cwd()), git=root(cwd), normalized=(git||cwd).replace(/\\/g,'/');
 const home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
 const file=process.env.CODEX_TIMESHEET_PATH?path.resolve(process.env.CODEX_TIMESHEET_PATH):path.join(home,'timesheets','events-'+at.slice(0,7)+'.jsonl');
 const stateFile=path.join(path.dirname(file),'.state',hash(String(input.session_id||'unknown'))+'.json');
 return lock(stateFile,()=>{
  const state=read(stateFile,{turns:{},agents:{},workflow:'direct'});
  state.agent_metadata ||= {};
  const args=input.tool_input||{};
  const launched=event==='PostToolUse'&&launches.includes(tool)?launchResult(input.tool_response):{};
  const launchedId=launched.agent_id||launched.threadId||launched.id||null;
  if(launchedId) {const old=state.agent_metadata[launchedId]||{}; state.agent_metadata[launchedId]={...old,profile:args.agent_type||args.profile||old.profile||null,requested_model:args.model||null,requested_effort:args.reasoning_effort||args.model_reasoning_effort||args.thinking||null,interaction_class:classes.includes(args.interaction_class)?args.interaction_class:old.interaction_class||null,creation_tool:tool,parent_agent_id:input.agent_id||null};}
  const saved=state.agent_metadata[input.agent_id]||{};
  const refs=event==='UserPromptSubmit'?[...new Set((String(input.prompt||'').match(/\$[A-Za-z][A-Za-z0-9_-]*/g)||[]).map(s=>s.slice(1)))]:[];
  const version=refs.includes('orchestrate-development-v3')?3:refs.includes('orchestrate-development')?2:null;
  const turn=input.turn_id||state.turn_id||null;
  if(version) Object.assign(state,{workflow:version===3?'orchestrate-development-v3':'orchestrate-development',orchestration_version:version,activation_at:at,activation_turn_id:turn});
  let ledger=null; try { ledger=read(ledgerPath(cwd,input.session_id)); } catch { /* optional enrichment cannot disable telemetry */ }
  if(ledger?.active&&ledger.orchestration_version===3) Object.assign(state,{workflow:'orchestrate-development-v3',orchestration_version:3,activation_at:ledger.activation_at||ledger.created_at,activation_turn_id:ledger.activation_turn_id||null});
  const task=ledger?.tasks?.[input.agent_id]||{}, goal=task.goals?.[task.active_goal_id]||{};
  const profile=input.agent_type||input.profile||saved.profile||task.profile||null, config=profiles[profile]||null;
  const observed=input.model||null, effort=input.observed_effort||null;
  if(input.agent_id) state.agent_metadata[input.agent_id]={...saved,profile};
  const binding=config?(observed&&observed!==config[0]||effort&&effort!==config[1]?'MISMATCH':observed&&effort?'VERIFIED':'CONFIG_PINNED'):'UNVERIFIED';
  let metadata={}; try { metadata=read(path.join(git||cwd,'.codex','timesheet.json'),{})||{}; } catch {}
  const record={schema_version:3,event_id:input.event_id?hash([input.session_id,event,input.event_id]):crypto.randomUUID(),event:events[event],recorded_at:at,date:at.slice(0,10),
   project_key:hash(process.platform==='win32'?normalized.toLowerCase():normalized).slice(0,24),project_name:path.basename(git||cwd),project_root:git,cwd,scope_type:git?'git':'workspace',
   session_id:input.session_id||null,root_session_id:input.session_id||null,turn_id:turn,agent_id:input.agent_id||null,profile,
   created_agent_id:launchedId,creation_tool:saved.creation_tool||null,parent_agent_id:input.parent_agent_id||saved.parent_agent_id||null,requested_model:saved.requested_model||null,requested_effort:saved.requested_effort||null,profile_known:!!profiles[profile],
   observed_model:observed,model:observed,configured_model:config?.[0]||null,configured_effort:config?.[1]||null,observed_effort:effort,binding_state:binding,
   workflow:state.workflow,orchestration_active:!!state.orchestration_version,orchestration_version:state.orchestration_version||null,activation_at:state.activation_at||null,activation_turn_id:state.activation_turn_id||null,skill_refs:refs,
   interaction_class:classes.includes(goal.interaction_class||task.interaction_class||input.interaction_class||saved.interaction_class)?goal.interaction_class||task.interaction_class||input.interaction_class||saved.interaction_class:config?.[2]||'OTHER',
   usage_scope:input.agent_id?'subagent_session':'host_turn',usage_source:'unknown',usage_kind:'unknown',usage_additive:false,token_usage:null,
   request_excerpt:event==='UserPromptSubmit'?redact(input.prompt):null,result_summary:['Stop','SubagentStop'].includes(event)?redact(input.last_assistant_message,1000):null};
  for(const k of ['project_alias','client_alias','billing_code','billable_default']) record[k]=typeof metadata[k]==='boolean'?metadata[k]:redact(metadata[k],120);
  for(const k of ['stage_id','goal_id','route','lifetime','goal_outcome','focused_validation','stage_validation','review_required','review_reason','review_outcome','first_artifact_at','spark_call_id','spark_outcome']) record[k]=redact(goal[k]??task[k]??ledger?.[k],240);
  if(event==='SessionStart') { state.session_started_at ||= at; record.started_at=state.session_started_at; record.source=input.source||null; }
  if(event==='SessionEnd') { record.started_at=state.session_started_at||null; record.ended_at=at; }
  if(event==='UserPromptSubmit') { state.turn_id=turn||crypto.randomUUID(); record.turn_id=state.turn_id; state.turns[state.turn_id] ||= at; record.started_at=state.turns[state.turn_id]; }
  if(event==='SubagentStart') { state.agents[input.agent_id] ||= at; record.started_at=state.agents[input.agent_id]; }
  if(['Stop','Interrupt','SubagentStop'].includes(event)) {
   record.started_at=event==='SubagentStop'?state.agents[input.agent_id]||null:state.turns[turn]||null; record.ended_at=at;
   const seconds=record.started_at?Math.max(0,(Date.parse(at)-Date.parse(record.started_at))/1000):null;
   record[event==='SubagentStop'?'subagent_wall_clock':'turn_wall_clock']=seconds;
   let metrics=null;
   if(input.token_usage) metrics={token_usage:usage(input.token_usage),usage_kind:input.usage_kind||'cumulative_snapshot',usage_additive:input.usage_additive===true&&['turn_delta','session_delta','adapter_delta'].includes(input.usage_kind)};
   else try { metrics=transcript(input.agent_id?input.agent_transcript_path:input.transcript_path,turn,!!input.agent_id); } catch {}
   if(metrics) Object.assign(record,metrics,{usage_source:input.token_usage?'hook':'transcript_delta'});
   // Child snapshots never silently become additive to parent totals.
   if(input.agent_id&&record.usage_kind==='cumulative_snapshot') record.usage_additive=false;
  }
  if(event==='PostToolUse') record.tool_name=tool;
  lock(file,()=>fs.appendFileSync(file,JSON.stringify(record)+'\n','utf8')); write(stateFile,state); return record;
 });
}
if(require.main===module) { try { collect(JSON.parse(fs.readFileSync(0,'utf8'))); } catch(e) { process.stderr.write('Codex telemetry: '+e.name+' (collection skipped)\n'); } process.stdout.write('{}'); }
module.exports={collect,transcript};
