'use strict';
const {fs,path,read,write}=require('./lib.cjs');
const os=require('node:os');
const runtime=['lib.cjs','telemetry.cjs','report.cjs','rate-card.json','billing-policy.json','LICENSE'];
const events=['SessionStart','SessionEnd','UserPromptSubmit','Stop','Interrupt','SubagentStart','SubagentStop','PostToolUse'];

function install({home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),apply=false,remove=false}={}) {
 const base=path.resolve(home), destination=path.join(base,'hooks','codex-hooks'), file=path.join(base,'hooks.json');
 const config=read(file,{hooks:{}}); config.hooks ||= {};
 const command='node "'+path.join(destination,'telemetry.cjs')+'"';
 const legacy='node "'+path.join(base,'hooks','timesheet.js')+'"';
 const owned=h=>h.command===command||h.commandWindows===command;
 for(const [event,groups] of Object.entries(config.hooks)) {
  if(!Array.isArray(groups)) throw Error('Invalid hook groups: '+event);
  const existing=groups.flatMap(g=>g.hooks||[]).filter(owned);
  if(new Set(existing.map(h=>JSON.stringify(h))).size>1||existing.some(h=>h.command&&h.command!==command||h.commandWindows&&h.commandWindows!==command)) throw Error('Conflicting telemetry registrations: '+event);
  for(const group of groups) group.hooks=(group.hooks||[]).filter(h=>!owned(h)&&(remove||h.command!==legacy&&h.commandWindows!==legacy));
  config.hooks[event]=groups.filter(g=>g.hooks.length);
 }
 if(!remove) for(const event of events) {
  const group={hooks:[{type:'command',command,commandWindows:command,timeout:3}]};
  if(event==='PostToolUse') group.matcher='(^|.*[_.])(Agent|spawn_agent|create_thread|fork_thread|apply_patch|close_agent|archive_agent|set_thread_archived)$';
  (config.hooks[event] ||= []).push(group);
 }
 if(!remove) for(const name of runtime) if(!fs.statSync(path.join(__dirname,name)).isFile()) throw Error('Missing runtime: '+name);
 const plan={mode:apply?'apply':'dry-run',action:remove?'unregister telemetry':'install global telemetry',destination,config:file,events:remove?[]:events,profiles_changed:false,guards_changed:false,trust:'Review updated definitions in /hooks; trust hashes are not modified'};
 if(apply) {
  const backup=path.join(base,'hooks','backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid);
  fs.mkdirSync(backup,{recursive:true});
  if(fs.existsSync(file)) fs.copyFileSync(file,path.join(backup,'hooks.json'));
  if(!remove) {
   fs.mkdirSync(destination,{recursive:true});
   for(const name of runtime) {
    const target=path.join(destination,name);
    if(fs.existsSync(target)) {
     fs.copyFileSync(target,path.join(backup,name));
     if(name.endsWith('.json')) continue; // Preserve operator rates and billing policy.
    }
    fs.copyFileSync(path.join(__dirname,name),target);
   }
  }
  write(file,config); plan.backup=backup;
 }
 return plan;
}
if(require.main===module) {
 const args=process.argv.slice(2); let home,apply=false,remove=false;
 for(let n=0;n<args.length;n++) {
  if(args[n]==='--apply') apply=true;
  else if(args[n]==='--remove') remove=true;
  else if(args[n]==='--home'&&args[n+1]&&!args[n+1].startsWith('--')) home=args[++n];
  else throw Error('Usage: node install.cjs [--home PATH] [--apply] [--remove]');
 }
 console.log(JSON.stringify(install({home,apply,remove}),null,2));
}
module.exports={install};
