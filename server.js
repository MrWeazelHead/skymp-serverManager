const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3847;

// ═══════ Paths ═══════
const SERVER_DIR = path.resolve(__dirname, '..', 'dist', 'server');
const SETTINGS_FILE = path.join(SERVER_DIR, 'server-settings.json');
const GAMEMODE_FILE = path.join(SERVER_DIR, 'gamemode.js');
const WORLD_DIR = path.join(SERVER_DIR, 'world');
const PANEL_DATA = path.join(__dirname, 'panel-data');
const BACKUPS_DIR = path.join(PANEL_DATA, 'backups');
const PROFILES_DIR = path.join(PANEL_DATA, 'profiles');
const ACTIVITY_FILE = path.join(PANEL_DATA, 'activity.json');
const PANEL_CONFIG_FILE = path.join(PANEL_DATA, 'panel-config.json');
const NOTES_FILE = path.join(PANEL_DATA, 'notes.json');
const UPTIME_HISTORY_FILE = path.join(PANEL_DATA, 'uptime-history.json');

[PANEL_DATA, BACKUPS_DIR, PROFILES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ═══════ State ═══════
let serverProcess = null;
let serverRunning = false;
let serverLogs = [];
const MAX_LOG_LINES = 5000;
let serverStartTime = null;
let crashCount = 0;
let lastCrashTime = null;
let totalStartCount = 0;
let perfHistory = [];
const MAX_PERF_POINTS = 360;
let perfInterval = null;
let panelConfig = loadPanelConfig();
let scheduledRestartTimer = null;
let activityLog = loadActivityLog();
const MAX_ACTIVITY = 500;
let uptimeHistory = loadUptimeHistory();
let bookmarkedLogs = [];
let connectedPlayers = [];

// ═══════ Helpers ═══════
function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e) {}
  return fallback;
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8'); }

function loadPanelConfig() { return loadJSON(PANEL_CONFIG_FILE, { 
  autoRestart: false, 
  autoRestartMaxRetries: 3, 
  autoRestartDelayMs: 5000, 
  scheduledRestart: { enabled: false, intervalHours: 6 },
  autoBackup: { enabled: false, intervalHours: 24 },
  backupRetention: 10,
  resourceAlerts: { cpuThreshold: 90, memThreshold: 90, enabled: false } 
}); }
function savePanelConfig() { saveJSON(PANEL_CONFIG_FILE, panelConfig); }
function loadActivityLog() { return loadJSON(ACTIVITY_FILE, []); }
function saveActivityLog() { saveJSON(ACTIVITY_FILE, activityLog.slice(-MAX_ACTIVITY)); }
function loadUptimeHistory() { return loadJSON(UPTIME_HISTORY_FILE, []); }
function saveUptimeHistory() { saveJSON(UPTIME_HISTORY_FILE, uptimeHistory.slice(-100)); }

function logActivity(action, details='', type='info') {
  const entry = { timestamp: new Date().toISOString(), action, details, type };
  activityLog.push(entry);
  if (activityLog.length > MAX_ACTIVITY) activityLog = activityLog.slice(-MAX_ACTIVITY);
  saveActivityLog();
  broadcast({ event:'activity', data:entry });
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(msg); });
}

function addLog(text, type='stdout') {
  const entry = { timestamp:new Date().toISOString(), text:text.toString().replace(/\r?\n$/,''), type };
  serverLogs.push(entry);
  if (serverLogs.length > MAX_LOG_LINES) serverLogs = serverLogs.slice(-MAX_LOG_LINES);
  broadcast({ event:'log', data:entry });
}

function getSettings() { return loadJSON(SETTINGS_FILE, {}); }

function getDirSize(p) {
  let s=0; try { if(!fs.existsSync(p)) return 0; fs.readdirSync(p,{withFileTypes:true}).forEach(f=>{
    const fp=path.join(p,f.name); s+=f.isDirectory()?getDirSize(fp):fs.statSync(fp).size;
  }); } catch(e){} return s;
}

function countFiles(p) {
  let c=0; try { if(!fs.existsSync(p)) return 0; fs.readdirSync(p,{withFileTypes:true}).forEach(f=>{
    c+=f.isDirectory()?countFiles(path.join(p,f.name)):1;
  }); } catch(e){} return c;
}

function collectPerf() {
  const cpus = os.cpus();
  const cpuUsage = cpus.reduce((a,cpu)=>{ const t=Object.values(cpu.times).reduce((x,y)=>x+y,0); return a+((t-cpu.times.idle)/t)*100; },0)/cpus.length;
  const totalMem=os.totalmem(), freeMem=os.freemem(), usedMem=totalMem-freeMem;
  let serverMem=0;
  if(serverRunning && serverProcess?.pid) {
    try {
      const out=execSync(`tasklist /fi "PID eq ${serverProcess.pid}" /fo CSV /nh`,{encoding:'utf-8',timeout:3000});
      const m=out.match(/"(\d[\d,]+)\sK"/); if(m) serverMem=parseInt(m[1].replace(/,/g,''))*1024;
    } catch(e){}
  }
  const point={timestamp:Date.now(),cpuPercent:Math.round(cpuUsage*10)/10,memUsed:usedMem,memTotal:totalMem,memPercent:Math.round((usedMem/totalMem)*1000)/10,serverMem,serverRunning};
  perfHistory.push(point);
  if(perfHistory.length>MAX_PERF_POINTS) perfHistory=perfHistory.slice(-MAX_PERF_POINTS);
  broadcast({event:'perf',data:point});

  // Resource alerts
  if(panelConfig.resourceAlerts?.enabled) {
    if(point.cpuPercent > (panelConfig.resourceAlerts.cpuThreshold||90)) {
      broadcast({event:'alert',data:{type:'cpu',value:point.cpuPercent,threshold:panelConfig.resourceAlerts.cpuThreshold}});
    }
    if(point.memPercent > (panelConfig.resourceAlerts.memThreshold||90)) {
      broadcast({event:'alert',data:{type:'mem',value:point.memPercent,threshold:panelConfig.resourceAlerts.memThreshold}});
    }
  }
}

perfInterval = setInterval(collectPerf, 5000);
collectPerf();

// ═══════ Server Process ═══════
function startServerProcess(reason='manual') {
  if(serverRunning) return null;
  const script=path.join(SERVER_DIR,'dist_back','skymp5-server.js');
  if(!fs.existsSync(script)) return {error:'Server script not found: '+script};

  serverProcess=spawn('node',[script],{cwd:SERVER_DIR,env:{...process.env},stdio:['pipe','pipe','pipe']});
  serverRunning=true; serverStartTime=Date.now(); totalStartCount++;
  if(reason==='manual') serverLogs=[];

  addLog(`Server starting... (${reason})`,'system');
  addLog(`  PID: ${serverProcess.pid}`,'system');

  serverProcess.stdout.on('data',d=>d.toString().split('\n').filter(l=>l.trim()).forEach(l=>{
    addLog(l,'stdout');
    handlePlayerLog(l);
  }));
  serverProcess.stderr.on('data',d=>d.toString().split('\n').filter(l=>l.trim()).forEach(l=>addLog(l,'stderr')));

  serverProcess.on('close',code=>{
    const was=serverRunning; serverRunning=false;
    const duration=serverStartTime?Math.floor((Date.now()-serverStartTime)/1000):0;
    addLog(`Server stopped (exit code: ${code})`,'system');

    // Record uptime history
    uptimeHistory.push({start:serverStartTime?new Date(serverStartTime).toISOString():null,duration,exitCode:code,reason});
    saveUptimeHistory();

    const pid=serverProcess?.pid; serverProcess=null; serverStartTime=null;
    broadcast({event:'status',data:{running:false}});

    if(was && code!==0 && code!==null) {
      crashCount++; lastCrashTime=new Date().toISOString();
      logActivity('Server Crashed',`Exit code: ${code}, PID: ${pid}, Crashes: ${crashCount}`,'error');
      if(panelConfig.autoRestart && crashCount<=panelConfig.autoRestartMaxRetries) {
        const delay=panelConfig.autoRestartDelayMs||5000;
        addLog(`Auto-restart in ${delay/1000}s (attempt ${crashCount}/${panelConfig.autoRestartMaxRetries})...`,'system');
        logActivity('Auto-Restart Scheduled',`Attempt ${crashCount}/${panelConfig.autoRestartMaxRetries}`,'warning');
        setTimeout(()=>{ if(!serverRunning){ const r=startServerProcess('auto-restart'); if(r?.error) addLog('✖ '+r.error,'error'); }},delay);
      } else if(panelConfig.autoRestart) {
        addLog('Auto-restart limit reached.','error');
        logActivity('Auto-Restart Exhausted',`Max retries: ${panelConfig.autoRestartMaxRetries}`,'error');
      }
    } else if(was) { logActivity('Server Stopped',`Exit code: ${code}, Uptime: ${duration}s`,'info'); }
    connectedPlayers = [];
    broadcast({event:'players', data:[]});
  });

  serverProcess.on('error',err=>{
    serverRunning=false; addLog('✖ '+err.message,'error'); serverProcess=null; serverStartTime=null;
    broadcast({event:'status',data:{running:false}}); logActivity('Server Error',err.message,'error');
  });

  broadcast({event:'status',data:{running:true}});
  return {success:true,pid:serverProcess.pid};
}

function handlePlayerLog(line) {
  // Pattern: [ID] Name connected/joined/left/disconnected
  // SkyMP typical: "Player [0] Joshua connected" 
  const joinMatch = line.match(/Player\s+\[(\d+)\]\s+(.*?)\s+(?:connected|joined)/i);
  if (joinMatch) {
    const id = joinMatch[1], name = joinMatch[2];
    if (!connectedPlayers.find(p => p.id === id)) {
      const p = { id, name, joinTime: new Date().toISOString(), ping: 0 };
      connectedPlayers.push(p);
      logActivity('Player Joined', name, 'success');
      broadcast({ event: 'players', data: connectedPlayers });
    }
  }
  const leaveMatch = line.match(/Player\s+\[(\d+)\]\s+(.*?)\s+(?:disconnected|left)/i);
  if (leaveMatch) {
    const id = leaveMatch[1];
    const idx = connectedPlayers.findIndex(p => p.id === id);
    if (idx !== -1) {
      const name = connectedPlayers[idx].name;
      connectedPlayers.splice(idx, 1);
      logActivity('Player Left', name, 'info');
      broadcast({ event: 'players', data: connectedPlayers });
    }
  }
}

// ═══════ Automation Loop ═══════
let lastRestartCheck = Date.now();
let lastBackupCheck = Date.now();

setInterval(async () => {
  // Scheduled Restart
  if(panelConfig.scheduledRestart?.enabled){
    const h = panelConfig.scheduledRestart.intervalHours || 6;
    if(Date.now() - lastRestartCheck > h * 3600000){
      lastRestartCheck = Date.now();
      if(serverRunning){ 
        addLog(`SkyMP: Triggering scheduled restart (Interval: ${h}h)...`,'system'); 
        logActivity('Scheduled Restart','','info');
        await stopServerInternal();
        startServerProcess('scheduled');
      }
    }
  }
  // Auto Backup
  if(panelConfig.autoBackup?.enabled){
    const h = panelConfig.autoBackup.intervalHours || 24;
    if(Date.now() - lastBackupCheck > h * 3600000){
      lastBackupCheck = Date.now();
      addLog('SkyMP: Triggering auto-backup...','system');
      triggerAutoBackup();
    }
  }
}, 60000);

function setupScheduledRestart() {
  lastRestartCheck = Date.now();
}

async function stopServerInternal() {
  if(!serverRunning || !serverProcess) return;
  const kill=spawn('taskkill',['/pid',serverProcess.pid.toString(),'/f','/t']);
  await new Promise(r=>kill.on('close',r));
  serverRunning=false; serverProcess=null; serverStartTime=null; 
  broadcast({event:'status',data:{running:false}});
  await new Promise(r=>setTimeout(r,2000));
}

function triggerAutoBackup() {
  try {
    const id=`backup_auto_${Date.now()}`; const bd=path.join(BACKUPS_DIR,id); fs.mkdirSync(bd,{recursive:true});
    const meta={name:`Auto Backup ${new Date().toLocaleDateString()}`,createdAt:new Date().toISOString(),contents:['settings','gamemode','world']};
    if(fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE,path.join(bd,'server-settings.json'));
    if(fs.existsSync(GAMEMODE_FILE)) fs.copyFileSync(GAMEMODE_FILE,path.join(bd,'gamemode.js'));
    const cf=path.join(WORLD_DIR,'changeForms'); if(fs.existsSync(cf)){ const wb=path.join(bd,'changeForms'); fs.mkdirSync(wb,{recursive:true}); fs.readdirSync(cf).forEach(f=>fs.copyFileSync(path.join(cf,f),path.join(wb,f))); }
    meta.totalSize=getDirSize(bd); saveJSON(path.join(BACKUPS_DIR,`${id}.json`),meta);
    cleanupOldBackups();
    logActivity('Auto-Backup Created','','success');
  } catch(e) { console.error('[Panel] Auto-backup failed:', e); }
}
setupScheduledRestart();

// ═══════ Middleware ═══════
app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname,'public')));

// ═══════ API ═══════

// Status
app.get('/api/status',(req,res)=>{
  const uptime=serverRunning&&serverStartTime?Math.floor((Date.now()-serverStartTime)/1000):0;
  const s=getSettings();
  res.json({running:serverRunning,uptime,pid:serverProcess?.pid||null,serverName:s.name||'My Server',
    port:s.port||7777,maxPlayers:s.maxPlayers||0,offlineMode:s.offlineMode??true,npcEnabled:s.npcEnabled??false,
    logCount:serverLogs.length,crashCount,lastCrashTime,totalStartCount,
    worldSize:getDirSize(WORLD_DIR),worldFiles:countFiles(path.join(WORLD_DIR,'changeForms')),
    panelUptime:Math.floor(process.uptime()),
    system:{platform:os.platform(),arch:os.arch(),hostname:os.hostname(),nodeVersion:process.version,
      cpuModel:os.cpus()[0]?.model||'Unknown',cpuCores:os.cpus().length,totalMemory:os.totalmem(),freeMemory:os.freemem()}
  });
});

// Logs
app.get('/api/logs',(req,res)=>{
  let logs=serverLogs;
  const type=req.query.type; if(type) logs=logs.filter(l=>l.type===type);
  const filter=req.query.filter; if(filter) { const lf=filter.toLowerCase(); logs=logs.filter(l=>l.text.toLowerCase().includes(lf)); }
  res.json(logs.slice(-(Math.min(parseInt(req.query.count)||500,MAX_LOG_LINES))));
});

app.get('/api/logs/export',(req,res)=>{
  const text=serverLogs.map(l=>`[${new Date(l.timestamp).toLocaleString()}] [${l.type.toUpperCase()}] ${l.text}`).join('\n');
  res.setHeader('Content-Type','text/plain');
  res.setHeader('Content-Disposition',`attachment; filename=skymp-logs-${Date.now()}.txt`);
  res.send(text);
});

// Bookmarked logs
app.get('/api/logs/bookmarks',(req,res)=>res.json(bookmarkedLogs));
app.post('/api/logs/bookmarks',(req,res)=>{
  bookmarkedLogs.push({...req.body,id:Date.now()});
  if(bookmarkedLogs.length>100) bookmarkedLogs=bookmarkedLogs.slice(-100);
  res.json({success:true});
});
app.delete('/api/logs/bookmarks/:id',(req,res)=>{
  bookmarkedLogs=bookmarkedLogs.filter(b=>b.id!==parseInt(req.params.id));
  res.json({success:true});
});

// Plugins API
app.get('/api/plugins', (req, res) => {
  const scriptsDir = path.resolve(__dirname, '..', 'dist', 'server', 'data', 'scripts');
  if (!fs.existsSync(scriptsDir)) return res.json([]);
  
  try {
    const files = fs.readdirSync(scriptsDir);
    const plugins = files.filter(f => f.endsWith('.pex') || f.endsWith('.js')).map(f => ({
      name: f,
      type: f.endsWith('.pex') ? 'Papyrus' : 'Script',
      active: true // Always true for now if present in directory
    }));
    res.json(plugins);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read plugins' });
  }
});

app.post('/api/plugins/add', (req, res) => {
  const { target, filename, content } = req.body;
  if (!target || !filename || !content) return res.status(400).json({ error: 'Missing parameters' });
  
  try {
    let targetDir;
    if (target === 'server') {
      targetDir = path.resolve(__dirname, '..', 'dist', 'server', 'data', 'scripts');
    } else if (target === 'client') {
      targetDir = path.resolve(__dirname, '..', 'dist', 'client', 'Data', 'Platform', 'Plugins');
    } else {
      return res.status(400).json({ error: 'Invalid target' });
    }
    
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    const filePath = path.join(targetDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    
    logActivity('Plugin Added', `${filename} added to ${target}`, 'info');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write plugin: ' + err.message });
  }
});

// Players API
app.get('/api/players', (req, res) => res.json(connectedPlayers));
app.post('/api/players/:id/kick', (req, res) => {
  if(!serverRunning || !serverProcess) return res.status(400).json({error:'Server not running'});
  const cmd = `kick ${req.params.id}`;
  serverProcess.stdin.write(cmd + '\n');
  addLog(`Moderation: ${cmd}`, 'command');
  res.json({ success: true });
});
app.post('/api/players/:id/ban', (req, res) => {
  if(!serverRunning || !serverProcess) return res.status(400).json({error:'Server not running'});
  const cmd = `ban ${req.params.id}`;
  serverProcess.stdin.write(cmd + '\n');
  addLog(`Moderation: ${cmd}`, 'command');
  res.json({ success: true });
});
app.post('/api/players/:id/set-value', (req, res) => {
  if(!serverRunning || !serverProcess) return res.status(400).json({error:'Server not running'});
  const { key, value } = req.body;
  const cmd = `setvalue ${req.params.id} ${key} ${value}`;
  serverProcess.stdin.write(cmd + '\n');
  addLog(`Moderation: ${cmd}`, 'command');
  res.json({ success: true });
});

// Controls
app.post('/api/start',(req,res)=>{
  if(serverRunning) return res.status(400).json({error:'Server already running'});
  crashCount=0; const r=startServerProcess('manual');
  if(r?.error) return res.status(500).json(r);
  logActivity('Server Started',`PID: ${r.pid}`,'success'); res.json(r);
});

app.post('/api/stop',(req,res)=>{
  if(!serverRunning||!serverProcess) return res.status(400).json({error:'Server not running'});
  addLog('Stopping server...','system'); logActivity('Server Stop Requested','','info');
  const kill=spawn('taskkill',['/pid',serverProcess.pid.toString(),'/f','/t']);
  kill.on('close',()=>{ serverRunning=false; serverProcess=null; serverStartTime=null; broadcast({event:'status',data:{running:false}}); });
  res.json({success:true});
});

app.post('/api/restart',async(req,res)=>{
  logActivity('Server Restart Requested','','warning');
  if(serverRunning&&serverProcess) {
    addLog('Restarting server...','system');
    const kill=spawn('taskkill',['/pid',serverProcess.pid.toString(),'/f','/t']);
    await new Promise(r=>kill.on('close',r));
    serverRunning=false; serverProcess=null; serverStartTime=null;
    await new Promise(r=>setTimeout(r,1500));
  }
  crashCount=0; const r=startServerProcess('manual-restart');
  if(r?.error) return res.status(500).json(r);
  logActivity('Server Restarted',`PID: ${r.pid}`,'success'); res.json(r);
});

// Command
app.post('/api/command',(req,res)=>{
  if(!serverRunning||!serverProcess) return res.status(400).json({error:'Server not running'});
  const {command}=req.body; if(!command) return res.status(400).json({error:'No command'});
  serverProcess.stdin.write(command+'\n'); addLog(`Command: ${command}`,'command');
  logActivity('Command Sent',command,'info'); res.json({success:true});
});

// Settings
app.get('/api/settings',(req,res)=>{ try { res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf-8'))); } catch(e){ res.status(500).json({error:e.message}); }});
app.put('/api/settings',(req,res)=>{ try { fs.writeFileSync(SETTINGS_FILE,JSON.stringify(req.body,null,2),'utf-8'); logActivity('Settings Updated','','success'); res.json({success:true}); } catch(e){ res.status(500).json({error:e.message}); }});

// Raw settings
app.get('/api/settings/raw',(req,res)=>{ try { res.json({content:fs.readFileSync(SETTINGS_FILE,'utf-8')}); } catch(e){ res.status(500).json({error:e.message}); }});
app.put('/api/settings/raw',(req,res)=>{ try { JSON.parse(req.body.content); fs.writeFileSync(SETTINGS_FILE,req.body.content,'utf-8'); logActivity('Settings Updated (Raw)','','success'); res.json({success:true}); } catch(e){ res.status(400).json({error:'Invalid JSON: '+e.message}); }});

// Gamemode
app.get('/api/gamemode',(req,res)=>{ try { const c=fs.existsSync(GAMEMODE_FILE)?fs.readFileSync(GAMEMODE_FILE,'utf-8'):''; const s=fs.existsSync(GAMEMODE_FILE)?fs.statSync(GAMEMODE_FILE):null; res.json({content:c,size:s?.size||0,modified:s?.mtime.toISOString()||null}); } catch(e){ res.status(500).json({error:e.message}); }});
app.put('/api/gamemode',(req,res)=>{ try { fs.writeFileSync(GAMEMODE_FILE,req.body.content,'utf-8'); logActivity('Gamemode Saved',`${Buffer.byteLength(req.body.content)} bytes`,'success'); res.json({success:true}); } catch(e){ res.status(500).json({error:e.message}); }});

// Files
app.get('/api/files',(req,res)=>{
  try {
    const info={worldData:[],dataScripts:[],serverFiles:[]};
    const cfDir=path.join(WORLD_DIR,'changeForms');
    if(fs.existsSync(cfDir)) info.worldData=fs.readdirSync(cfDir).map(f=>{const s=fs.statSync(path.join(cfDir,f)); return {name:f,size:s.size,modified:s.mtime.toISOString()};});
    const scDir=path.join(SERVER_DIR,'data','scripts');
    if(fs.existsSync(scDir)) info.dataScripts=fs.readdirSync(scDir).map(f=>{const s=fs.statSync(path.join(scDir,f)); return {name:f,size:s.size,modified:s.mtime.toISOString()};});
    if(fs.existsSync(SERVER_DIR)) info.serverFiles=fs.readdirSync(SERVER_DIR).filter(f=>!fs.statSync(path.join(SERVER_DIR,f)).isDirectory()).map(f=>{const s=fs.statSync(path.join(SERVER_DIR,f)); return {name:f,size:s.size,modified:s.mtime.toISOString()};});
    res.json(info);
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/world/reset',(req,res)=>{
  if(serverRunning) return res.status(400).json({error:'Stop the server first'});
  try {
    const cfDir=path.join(WORLD_DIR,'changeForms'); let n=0;
    if(fs.existsSync(cfDir)){ const f=fs.readdirSync(cfDir); n=f.length; f.forEach(x=>fs.unlinkSync(path.join(cfDir,x))); }
    logActivity('World Reset',`${n} files removed`,'warning');
    res.json({success:true,message:`${n} files removed`});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Performance
app.get('/api/perf',(req,res)=>res.json(perfHistory.slice(-(Math.min(parseInt(req.query.count)||60,MAX_PERF_POINTS)))));

// Activity
app.get('/api/activity',(req,res)=>res.json(activityLog.slice(-(Math.min(parseInt(req.query.count)||50,MAX_ACTIVITY))).reverse()));
app.delete('/api/activity',(req,res)=>{ activityLog=[]; saveActivityLog(); res.json({success:true}); });

// Uptime history
app.get('/api/uptime-history',(req,res)=>res.json(uptimeHistory.slice(-50).reverse()));

// Backups
app.get('/api/backups',(req,res)=>{
  try {
    if(!fs.existsSync(BACKUPS_DIR)) return res.json([]);
    res.json(fs.readdirSync(BACKUPS_DIR).filter(f=>f.endsWith('.json')).map(f=>{ try { return {id:f.replace('.json',''),...JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR,f),'utf-8'))}; } catch(e){ return null; }}).filter(Boolean).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)));
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/backups',(req,res)=>{
  try {
    const {name,includeWorld,includeSettings,includeGamemode}=req.body;
    const id=`backup_${Date.now()}`; const bd=path.join(BACKUPS_DIR,id); fs.mkdirSync(bd,{recursive:true});
    const meta={name:name||`Backup ${new Date().toLocaleString()}`,createdAt:new Date().toISOString(),contents:[]};
    if(includeSettings!==false && fs.existsSync(SETTINGS_FILE)){ fs.copyFileSync(SETTINGS_FILE,path.join(bd,'server-settings.json')); meta.contents.push('settings'); }
    if(includeGamemode!==false && fs.existsSync(GAMEMODE_FILE)){ fs.copyFileSync(GAMEMODE_FILE,path.join(bd,'gamemode.js')); meta.contents.push('gamemode'); }
    if(includeWorld!==false){ const cf=path.join(WORLD_DIR,'changeForms'); if(fs.existsSync(cf)){ const wb=path.join(bd,'changeForms'); fs.mkdirSync(wb,{recursive:true}); const fl=fs.readdirSync(cf); fl.forEach(f=>fs.copyFileSync(path.join(cf,f),path.join(wb,f))); meta.contents.push(`world (${fl.length} files)`); meta.worldFileCount=fl.length; }}
    meta.totalSize=getDirSize(bd); saveJSON(path.join(BACKUPS_DIR,`${id}.json`),meta);
    cleanupOldBackups();
    logActivity('Backup Created',`"${meta.name}"`,'success'); res.json({success:true,id,...meta});
  } catch(e){ res.status(500).json({error:e.message}); }
});

function cleanupOldBackups() {
  try {
    const retention = panelConfig.backupRetention || 10;
    if (!fs.existsSync(BACKUPS_DIR)) return;
    const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.json')).map(f => {
      const p = path.join(BACKUPS_DIR, f);
      return { file: f, path: p, time: fs.statSync(p).mtime.getTime() };
    }).sort((a, b) => b.time - a.time);

    if (files.length > retention) {
      const toRemove = files.slice(retention);
      toRemove.forEach(f => {
        const id = f.file.replace('.json', '');
        const bd = path.join(BACKUPS_DIR, id);
        if (fs.existsSync(bd)) fs.rmSync(bd, { recursive: true, force: true });
        if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
        console.log(`[Panel] Retention: Removed old backup ${id}`);
      });
    }
  } catch (e) { console.error('[Panel] Cleanup failed:', e); }
}

app.post('/api/backups/:id/restore',(req,res)=>{
  if(serverRunning) return res.status(400).json({error:'Stop server first'});
  try {
    const bd=path.join(BACKUPS_DIR,req.params.id); const mf=path.join(BACKUPS_DIR,`${req.params.id}.json`);
    if(!fs.existsSync(mf)) return res.status(404).json({error:'Not found'});
    const meta=JSON.parse(fs.readFileSync(mf,'utf-8')); const restored=[];
    if(req.body.restoreSettings!==false){ const s=path.join(bd,'server-settings.json'); if(fs.existsSync(s)){fs.copyFileSync(s,SETTINGS_FILE);restored.push('settings');}}
    if(req.body.restoreGamemode!==false){ const s=path.join(bd,'gamemode.js'); if(fs.existsSync(s)){fs.copyFileSync(s,GAMEMODE_FILE);restored.push('gamemode');}}
    if(req.body.restoreWorld!==false){ const s=path.join(bd,'changeForms'); if(fs.existsSync(s)){const d=path.join(WORLD_DIR,'changeForms');if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});fs.readdirSync(d).forEach(f=>fs.unlinkSync(path.join(d,f)));fs.readdirSync(s).forEach(f=>fs.copyFileSync(path.join(s,f),path.join(d,f)));restored.push('world');}}
    logActivity('Backup Restored',`"${meta.name}" — ${restored.join(', ')}`,'success'); res.json({success:true,restored});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.delete('/api/backups/:id',(req,res)=>{
  try {
    const bd=path.join(BACKUPS_DIR,req.params.id); const mf=path.join(BACKUPS_DIR,`${req.params.id}.json`);
    if(fs.existsSync(bd)) fs.rmSync(bd,{recursive:true,force:true});
    if(fs.existsSync(mf)) fs.unlinkSync(mf);
    logActivity('Backup Deleted',req.params.id,'info'); res.json({success:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Profiles
app.get('/api/profiles',(req,res)=>{
  try {
    if(!fs.existsSync(PROFILES_DIR)) return res.json([]);
    res.json(fs.readdirSync(PROFILES_DIR).filter(f=>f.endsWith('.json')).map(f=>{ try { return {id:f.replace('.json',''),...JSON.parse(fs.readFileSync(path.join(PROFILES_DIR,f),'utf-8'))}; } catch(e){return null;}}).filter(Boolean).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)));
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/profiles',(req,res)=>{ try { const id=`profile_${Date.now()}`; const p={name:req.body.name||'Unnamed',createdAt:new Date().toISOString(),settings:getSettings()}; saveJSON(path.join(PROFILES_DIR,`${id}.json`),p); logActivity('Profile Created',`"${p.name}"`,'success'); res.json({success:true,id,...p}); } catch(e){ res.status(500).json({error:e.message}); }});
app.post('/api/profiles/:id/load',(req,res)=>{ try { const fp=path.join(PROFILES_DIR,`${req.params.id}.json`); if(!fs.existsSync(fp)) return res.status(404).json({error:'Not found'}); const p=JSON.parse(fs.readFileSync(fp,'utf-8')); fs.writeFileSync(SETTINGS_FILE,JSON.stringify(p.settings,null,2),'utf-8'); logActivity('Profile Loaded',`"${p.name}"`,'success'); res.json({success:true,settings:p.settings}); } catch(e){ res.status(500).json({error:e.message}); }});
app.delete('/api/profiles/:id',(req,res)=>{ try { const fp=path.join(PROFILES_DIR,`${req.params.id}.json`); if(fs.existsSync(fp))fs.unlinkSync(fp); logActivity('Profile Deleted',req.params.id,'info'); res.json({success:true}); } catch(e){ res.status(500).json({error:e.message}); }});

// Panel config
app.get('/api/panel-config',(req,res)=>res.json(panelConfig));
app.put('/api/panel-config',(req,res)=>{ panelConfig={...panelConfig,...req.body}; savePanelConfig(); setupScheduledRestart(); logActivity('Panel Config Updated','','info'); res.json({success:true,config:panelConfig}); });

// Notes
app.get('/api/notes',(req,res)=>res.json(loadJSON(NOTES_FILE,{notes:[]})));
app.put('/api/notes',(req,res)=>{ saveJSON(NOTES_FILE,req.body); res.json({success:true}); });

// System
app.get('/api/system',(req,res)=>{
  const cpus=os.cpus();
  const nets=os.networkInterfaces(); const ips=[];
  for(const [name,addrs] of Object.entries(nets)) for(const a of addrs) if(a.family==='IPv4'&&!a.internal) ips.push({name,address:a.address});
  res.json({platform:os.platform(),arch:os.arch(),release:os.release(),hostname:os.hostname(),nodeVersion:process.version,
    cpuModel:cpus[0]?.model||'?',cpuCores:cpus.length,cpuSpeed:cpus[0]?.speed||0,totalMemory:os.totalmem(),freeMemory:os.freemem(),
    uptime:os.uptime(),panelUptime:Math.floor(process.uptime()),panelMemory:process.memoryUsage(),
    serverDir:SERVER_DIR,settingsFile:SETTINGS_FILE,worldDir:WORLD_DIR,
    worldSize:getDirSize(WORLD_DIR),backupsSize:getDirSize(BACKUPS_DIR),networkInterfaces:ips});
});

// WebSocket
wss.on('connection',ws=>{
  ws.send(JSON.stringify({event:'init',data:{running:serverRunning,logs:serverLogs.slice(-200)}}));
});

// Start
server.listen(PORT,()=>{
  console.log('');
  console.log('  ⚔═══════════════════════════════════════════════⚔');
  console.log('  ║                SkyMP Panel                    ║');
  console.log('  ⚔═══════════════════════════════════════════════⚔');
  console.log(`  ║  🏰  http://localhost:${PORT}                      ║`);
  console.log(`  ║  📁  Server: dist/server                        ║`);
  console.log(`  ║  🖥️   ${os.cpus().length} cores · ${(os.totalmem()/1073741824).toFixed(1)}GB · ${os.platform()}              ║`);
  console.log('  ⚔═══════════════════════════════════════════════⚔');
  console.log('');
  logActivity('Panel Started',`http://localhost:${PORT}`,'info');
});
