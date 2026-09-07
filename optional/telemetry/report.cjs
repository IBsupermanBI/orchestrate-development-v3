'use strict';
const {fs,path,read,hash,keys,redact}=require('./lib.cjs');
function union(intervals,gap=0) { const out=[]; for(const [a,b] of intervals.filter(([a,b])=>Number.isFinite(a)&&b>=a).sort((x,y)=>x[0]-y[0])) { const last=out.at(-1); if(last&&a<=last[1]+gap) last[1]=Math.max(last[1],b); else out.push([a,b]); } return out; }
const duration=xs=>xs.reduce((n,[a,b])=>n+(b-a)/1000,0);
function load(files) { const seen=new Set(), rows=[]; for(const file of files) for(const line of fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)) { if(!line.trim()) continue; let r; try { r=JSON.parse(line); } catch { continue; } const id=r.event_id||hash(r); if(seen.has(id)) continue; seen.add(id); rows.push({...r,event_id:id,project_name:r.project_name||r.project||'unknown',project_key:r.project_key||hash(process.platform==='win32'?String(r.project_root||r.cwd||r.project||'unknown').replace(/\\/g,'/').toLowerCase():String(r.project_root||r.cwd||r.project||'unknown')).slice(0,24),observed_model:r.observed_model||r.effective_model||r.model||null,workflow:r.workflow||'unknown',usage_additive:r.schema_version===3&&r.usage_additive===true,usage_scope:r.usage_scope||'unknown',usage_kind:r.usage_kind||'unknown'}); } return rows; }
function price(r,card) { const u=r.token_usage; const rate=card?.rates?.filter(x=>x.model===r.observed_model&&x.effective_from<=(r.date||r.recorded_at||'').slice(0,10)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0]; if(!rate||!u||[u.input_tokens,u.cached_input_tokens,u.output_tokens,rate.input_rate,rate.cached_rate,rate.output_rate].some(x=>!Number.isFinite(x))||u.cached_input_tokens>u.input_tokens) return null; return ((u.input_tokens-u.cached_input_tokens)*rate.input_rate+u.cached_input_tokens*rate.cached_rate+u.output_tokens*rate.output_rate)/(card.tokens_per_unit||1e6); }
function build(rows,options={}) {
 rows=rows.filter(r=>(!options.project||[r.project_key,r.project_name,r.project_alias].includes(options.project))&&(!options.client||r.client_alias===options.client)&&(!options.workflow||r.workflow===options.workflow)&&(!options.model||r.observed_model===options.model));
 const from=options.from?Date.parse(options.from+'T00:00:00Z'):-Infinity,to=options.to?Date.parse(options.to+'T00:00:00Z')+86400000:Infinity;
 const groups=new Map(), starts=new Map(), intervals=new Map(), sessions=new Map(), usageRows=new Map();
 rows.sort((a,b)=>String(a.recorded_at).localeCompare(String(b.recorded_at)));
 for(const r of rows) {
  const key=[r.project_key,r.session_id,r.agent_id||'root',r.spark_call_id||r.call_id||r.turn_id||'unknown'].join('|');
  if(r.event==='turn_started'||r.event==='subagent_started') starts.set(key,r.started_at||r.recorded_at);
  if(r.event==='session_ended'&&r.started_at&&r.ended_at) sessions.set(r.session_id,[r.started_at,r.ended_at]);
  if(['turn_completed','turn_interrupted','subagent_completed'].includes(r.event)) {
   const b=Date.parse(r.ended_at||r.recorded_at), wall=r.turn_wall_clock??r.subagent_wall_clock??r.wall_clock_seconds;
   const a=Date.parse(r.started_at||starts.get(key)||'')||(Number.isFinite(wall)?b-wall*1000:NaN);
   const identity=r.agent_id?[r.project_key,r.session_id,r.agent_id,'child'].join('|'):key;
   if(Number.isFinite(a)&&b>=a) { const old=intervals.get(identity); intervals.set(identity,{r,a:old?Math.min(a,old.a):a,b:old?Math.max(b,old.b):b}); }
  }
  if(r.token_usage) { const k=[key,r.usage_scope,r.usage_kind].join('|'); usageRows.set(k,r); }
 }
 function group(r,date) { const k=r.project_key+'|'+date; if(!groups.has(k)) groups.set(k,{date,project_key:r.project_key,project:r.project_name,client:r.client_alias||null,billing_code:r.billing_code||null,intervals:[],child_intervals:[],tasks:[],models:[],workflows:[],orchestration_versions:[],usage_by_scope:{},estimated_credit_equivalent_by_scope:{},unpriced_usage_records:0,unadditive_usage_records:0,breakdown:{}}); return groups.get(k); }
 for(const {r,a,b} of intervals.values()) {
  let left=Math.max(a,from), end=Math.min(b,to); while(left<end) { const date=new Date(left).toISOString().slice(0,10), right=Math.min(end,Date.parse(date+'T00:00:00Z')+86400000), g=group(r,date); (r.agent_id?g.child_intervals:g.intervals).push([left,right]);
   const cls={IMPLEMENTATION:'PRODUCTIVE_IMPLEMENTATION',INVESTIGATION:'PRODUCTIVE_INVESTIGATION',REVIEW:'ASSURANCE',PLAN_REVIEW:'ASSURANCE',VALIDATION:'VALIDATION',REPAIR:'REWORK',COORDINATION:'COORDINATION_OVERHEAD',ORCHESTRATION:'COORDINATION_OVERHEAD'}[r.interaction_class]||(/GOAL_BOUND|AWAITING_EXECUTE/.test(r.interaction_class||'')?'COORDINATION_OVERHEAD':'UNKNOWN');
   g.breakdown[cls]=(g.breakdown[cls]||0)+(right-left)/1000; left=right;
  }
 }
 for(const r of rows) {
  const when=Date.parse(r.recorded_at||r.date); if(!(when>=from&&when<to)) continue;
  const g=group(r,new Date(when).toISOString().slice(0,10));
  for(const [key,v] of [['models',r.observed_model],['workflows',r.workflow],['orchestration_versions',r.orchestration_version]]) if(v&&!g[key].includes(v)) g[key].push(v);
  const summary=redact(r.result_summary||r.summary||r.request_excerpt||r.request,600); if(summary&&!g.tasks.includes(summary)) g.tasks.push(summary);
 }
 for(const r of usageRows.values()) {
  const when=Date.parse(r.recorded_at||r.date); if(!(when>=from&&when<to)) continue; const g=group(r,new Date(when).toISOString().slice(0,10));
  if(!r.usage_additive||!['turn_delta','session_delta','adapter_delta'].includes(r.usage_kind)) { g.unadditive_usage_records++; continue; }
  const scope=r.usage_scope; const u=g.usage_by_scope[scope] ||= Object.fromEntries(keys.map(k=>[k,0])); for(const k of keys) { if(r.token_usage[k]==null||u[k]==null) u[k]=null; else u[k]+=r.token_usage[k]; }
  const cost=price(r,options.rateCard); if(cost===null) g.unpriced_usage_records++; else g.estimated_credit_equivalent_by_scope[scope]=(g.estimated_credit_equivalent_by_scope[scope]||0)+cost;
 }
 const output=[...groups.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.project.localeCompare(b.project));
 const projectIntervals=new Map();
 for(const g of output) { const merged=union(g.intervals); const p=projectIntervals.get(g.project_key)||[]; p.push(...merged); projectIntervals.set(g.project_key,p);
  g.project_elapsed_gross=duration(g.intervals); g.project_elapsed_union=duration(merged); g.engaged_time_estimate=duration(union(g.intervals,(options.gapMinutes??5)*60000)); g.subagent_compute_elapsed=duration(g.child_intervals);
  g.parallel_overlap=g.project_elapsed_gross-g.project_elapsed_union;
  g.billable_candidate=(options.billing?.billable_projects||[]).includes(g.project_key)?g[options.billing.basis||'engaged_time_estimate']:null;
  g.timeline=merged.map(([a,b])=>({start:new Date(a).toISOString(),end:new Date(b).toISOString()})); delete g.intervals; delete g.child_intervals;
 }
 const mergedProjects=[...projectIntervals.values()].map(xs=>union(xs)), all=mergedProjects.flat();
 return {schema_version:3,time_unit:'seconds',timezone:'UTC',usage_note:'Scopes remain separate; unknown/cumulative usage excluded from additive totals. Credits are estimates, not account charges. Breakdown includes agent compute and is not human time.',global_elapsed_union:duration(union(all)),cross_project_overlap:mergedProjects.reduce((n,x)=>n+duration(x),0)-duration(union(all)),session_intervals:[...sessions].map(([session_id,[start,end]])=>({session_id,start,end})),rows:output};
}
function csv(report) { const fields=['date','project','project_key','client','billing_code','project_elapsed_gross','project_elapsed_union','engaged_time_estimate','parallel_overlap','subagent_compute_elapsed','billable_candidate','models','workflows','tasks','usage_by_scope','estimated_credit_equivalent_by_scope','unpriced_usage_records','unadditive_usage_records','breakdown']; const cell=v=>{let s=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??''); if(/^[=+@-]/.test(s)) s="'"+s; return '"'+s.replace(/"/g,'""')+'"';}; return fields.join(',')+'\n'+report.rows.map(r=>fields.map(k=>cell(r[k])).join(',')).join('\n')+'\n'; }
function markdown(r) { const esc=s=>String(s).replace(/\|/g,'\\|').replace(/\n/g,' '); return '# Codex timesheet\n\nUTC; seconds. Engaged time is an estimate.\n\nGlobal union: '+r.global_elapsed_union+'; cross-project overlap: '+r.cross_project_overlap+'.\n\n| Date | Project | Codex elapsed | Engaged estimate | Agent compute | Models | Tasks |\n| --- | --- | ---: | ---: | ---: | --- | --- |\n'+r.rows.map(x=>`| ${x.date} | ${esc(x.project)} | ${x.project_elapsed_union} | ${x.engaged_time_estimate} | ${x.subagent_compute_elapsed} | ${esc(x.models.join(', '))} | ${esc(x.tasks.join('; '))} |`).join('\n')+'\n\n'+r.rows.map(x=>'## '+esc(x.date+' '+x.project)+'\n\n```json\n'+JSON.stringify({timeline:x.timeline,overlap:x.parallel_overlap,tokens:x.usage_by_scope,estimated_credits:x.estimated_credit_equivalent_by_scope,breakdown:x.breakdown,orchestration_versions:x.orchestration_versions},null,2)+'\n```').join('\n\n'); }
if(require.main===module) { const args=process.argv.slice(2), opt={},files=[]; for(let i=0;i<args.length;i++) { if(args[i].startsWith('--')) opt[args[i].slice(2)]=args[++i]; else files.push(args[i]); } if(!files.length) throw Error('Provide one or more JSONL paths'); const report=build(load(files),{...opt,gapMinutes:Number(opt.gap||5),rateCard:read(opt.rates||path.join(__dirname,'rate-card.json')),billing:read(opt.billing||path.join(__dirname,'billing-policy.json'))}); const output=opt.out||'timesheet-report'; fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true}); fs.writeFileSync(output+'.json',JSON.stringify(report,null,2)+'\n'); fs.writeFileSync(output+'.csv','\uFEFF'+csv(report)); fs.writeFileSync(output+'.md',markdown(report)); console.log(output+'.{json,csv,md}'); }
module.exports={union,duration,load,build,price,csv,markdown};
