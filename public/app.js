/* ═══════════════════════════════════════════
   SkyMP Panel v3.0 Client
   Advanced management interface for SkyMP
   ═══════════════════════════════════════════ */

let ws=null, reconnectInterval=null, currentSettings={}, panelConfig={};
let uptimeInterval=null, serverUptime=0, isServerRunning=false;
let perfData=[], allLogElements=[], notesData=[];

const TAB_ORDER=['dashboard','players','console','performance','settings','plugins','gamemode','profiles','backups','files','notes','wiki','activity','uptime','system'];
let allPlayers = [];

document.addEventListener('DOMContentLoaded',()=>{
  initTabs(); initConsoleInput(); initEditorLineNumbers(); initKeyboardShortcuts(); initLogFilter();
  initTheme(); connectWebSocket(); fetchStatus(); loadSettings(); loadPanelConfig(); loadGamemode();
  loadFiles(); loadActivity(); loadProfiles(); loadBackups(); loadSystemInfo();
  loadPerfHistory(); loadNotes(); loadUptimeHistory(); loadPlugins(); loadPlayers(); updateClock();
  setInterval(fetchStatus,5000); setInterval(updateClock,1000); setInterval(loadPerfHistory,30000);
  renderSampleScripts();
});

function updateClock(){const el=document.getElementById('header-time');if(el){el.textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}}

// ═══════ WebSocket ═══════
function connectWebSocket(){
  const proto=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(`${proto}//${location.host}`);
  ws.onopen=()=>{if(reconnectInterval){clearInterval(reconnectInterval);reconnectInterval=null;}};
  ws.onmessage=e=>{
    const msg=JSON.parse(e.data);
    switch(msg.event){
      case 'init': updateRunningState(msg.data.running); if(msg.data.logs) msg.data.logs.forEach(x=>appendLogLine(x)); break;
      case 'log': appendLogLine(msg.data); break;
      case 'status': updateRunningState(msg.data.running); break;
      case 'perf': handlePerfPoint(msg.data); break;
      case 'activity': prependActivityItem(msg.data,document.getElementById('dash-activity-feed'),8); prependActivityItemFull(msg.data,document.getElementById('activity-list')); break;
       case 'alert': handleResourceAlert(msg.data); break;
      case 'players': allPlayers = msg.data; renderPlayers(); renderDashboardPlayers(); break;
    }
  };
  ws.onclose=()=>{if(!reconnectInterval)reconnectInterval=setInterval(connectWebSocket,3000);};
  ws.onerror=()=>ws.close();
}

// ═══════ Handbook Logic ═══════
function switchHandbookChapter(id) {
  document.querySelectorAll('.handbook-chapter').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.handbook-nav-btn').forEach(b => b.classList.remove('active'));
  
  const target = document.getElementById('hb-' + id);
  if (target) target.classList.add('active');
  
  // Find button by onclick attribute (simple hack for this panel)
  document.querySelectorAll('.handbook-nav-btn').forEach(b => {
    if (b.getAttribute('onclick').includes(id)) b.classList.add('active');
  });
}

function toggleAddonPath(path) {
  document.getElementById('path-addon-manual').style.display = path === 'manual' ? 'block' : 'none';
  document.getElementById('path-addon-source').style.display = path === 'source' ? 'block' : 'none';
  
  document.getElementById('btn-addon-manual').classList.toggle('active', path === 'manual');
  document.getElementById('btn-addon-source').classList.toggle('active', path === 'source');
}

function toggleUpdatePath(path) {
  document.getElementById('path-update-manual').style.display = path === 'manual' ? 'block' : 'none';
  document.getElementById('path-update-git').style.display = path === 'git' ? 'block' : 'none';
  
  document.getElementById('btn-update-manual').classList.toggle('active', path === 'manual');
  document.getElementById('btn-update-git').classList.toggle('active', path === 'git');
}

function handleResourceAlert(data){
  if(data.type==='cpu') showToast(`CPU Usage at ${data.value}% (threshold: ${data.threshold}%)`,'warning');
  if(data.type==='mem') showToast(`Memory Usage at ${data.value}% (threshold: ${data.threshold}%)`,'warning');
}

// ═══════ Tabs ═══════
function initTabs(){document.querySelectorAll('.sidebar-tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));}
function switchTab(name){
  document.querySelectorAll('.sidebar-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(p=>p.classList.remove('active'));
  const tab=document.querySelector(`.sidebar-tab[data-tab="${name}"]`);
  const panel=document.getElementById(`panel-${name}`);
  if(tab)tab.classList.add('active');
  if(panel){panel.classList.add('active');panel.style.animation='none';panel.offsetHeight;panel.style.animation='';}
  if(name==='settings'){loadSettings();loadPanelConfig();} if(name==='gamemode')loadGamemode();
  if(name==='files')loadFiles(); if(name==='activity')loadActivity(); if(name==='profiles')loadProfiles();
  if(name==='backups')loadBackups(); if(name==='system')loadSystemInfo(); if(name==='notes')loadNotes();
  if(name==='plugins')loadPlugins();
  if(name==='players')loadPlayers();
  if(name==='performance'){loadPerfHistory();drawCharts();} if(name==='uptime')loadUptimeHistory();
}

// ═══════ Keyboard ═══════
function initKeyboardShortcuts(){
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT'){
      if(e.ctrlKey&&e.key==='s'){e.preventDefault();const a=document.querySelector('.tab-content.active');if(a.id==='panel-gamemode')saveGamemode();else if(a.id==='panel-settings')saveAllSettings();else if(a.id==='panel-notes')saveNotes();}return;}
    if(!e.ctrlKey&&!e.altKey&&e.key>='1'&&e.key<='9'){const i=parseInt(e.key)-1;if(TAB_ORDER[i])switchTab(TAB_ORDER[i]);return;}
    if(e.key==='0'){switchTab('system');return;}
    if(e.key==='?'){const h=document.getElementById('keyboard-hint');h.style.display=h.style.display==='none'?'flex':'none';return;}
    if(e.key==='Escape'){document.getElementById('keyboard-hint').style.display='none';return;}
    if(e.ctrlKey){if(e.key==='s'){e.preventDefault();saveAllSettings();}if(e.key==='Enter'){e.preventDefault();isServerRunning?stopServer():startServer();}if(e.key==='r'&&!e.shiftKey){e.preventDefault();if(isServerRunning)restartServer();}}
  });
}

// ═══════ Status ═══════
async function fetchStatus(){
  try{
    const r=await fetch('/api/status');const d=await r.json();
    updateRunningState(d.running); serverUptime=d.uptime||0;
    setText('server-name-display',d.serverName||'My Server');
    setText('stat-port',d.port||'7777'); setText('stat-maxplayers',d.maxPlayers||'0');
    setText('stat-mode',d.offlineMode?'Offline':'Online'); setText('stat-pid',d.pid||'—');
    setText('stat-world',(d.worldFiles||0)+' files'); setText('stat-starts',d.totalStartCount||'0');
    // Connection info
    setText('conn-port',d.port||'7777');
    const connSt=document.getElementById('conn-status');
    if(connSt){connSt.textContent=d.running?'Active':'Dormant';connSt.className=d.running?'conn-online':'conn-offline';}
    // Crash badge
    const badge=document.getElementById('crash-badge');
    if(d.crashCount>0){badge.style.display='inline';badge.textContent=d.crashCount+' ☠';}else{badge.style.display='none';}
    // Perf stats
    if(d.system){setText('ps-cpu',d.system.cpuModel);setText('ps-cores',d.system.cpuCores);setText('ps-ram',formatBytes(d.system.totalMemory));setText('ps-free-ram',formatBytes(d.system.freeMemory));setText('ps-os-uptime',formatDuration(d.system.uptime||0));setText('ps-panel-uptime',formatDuration(d.panelUptime||0));setText('ss-status',d.running?'⚔ Active':'☠ Dormant');setText('ss-pid',d.pid||'—');setText('ss-uptime',d.running?formatDuration(d.uptime):'—');setText('ss-starts',d.totalStartCount||0);setText('ss-crashes',d.crashCount||0);}
    updateUptime();
  }catch(e){}
}

function updateRunningState(running){
  isServerRunning=running;
  const dot=document.getElementById('status-dot'),text=document.getElementById('status-text');
  const label=document.getElementById('status-label'),ring=document.getElementById('ring-progress');
  const icon=document.getElementById('status-icon');
  if(running){
    dot.classList.add('online');text.textContent='Running';label.textContent='Server is active';label.style.color='var(--stamina)';
    ring.classList.add('active');icon.classList.add('active');icon.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
    document.getElementById('btn-start').disabled=true;document.getElementById('btn-stop').disabled=false;document.getElementById('btn-restart').disabled=false;
    if(!uptimeInterval)uptimeInterval=setInterval(()=>{serverUptime++;updateUptime();},1000);
  }else{
    dot.classList.remove('online');text.textContent='Stopped';label.textContent='Server is offline';label.style.color='var(--text-secondary)';
    ring.classList.remove('active');icon.classList.remove('active');icon.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    document.getElementById('btn-start').disabled=false;document.getElementById('btn-stop').disabled=true;document.getElementById('btn-restart').disabled=true;
    serverUptime=0;if(uptimeInterval){clearInterval(uptimeInterval);uptimeInterval=null;}setText('uptime-display','--:--:--');
  }
}
function updateUptime(){if(isServerRunning)setText('uptime-display',formatTime(serverUptime));}

// ═══════ Controls ═══════
async function startServer(){try{document.getElementById('btn-start').disabled=true;const r=await fetch('/api/start',{method:'POST'});const d=await r.json();if(d.error){showToast(d.error,'error');document.getElementById('btn-start').disabled=false;}else showToast('Server started (PID: '+d.pid+')','success');}catch(e){showToast('Failed to start server','error');document.getElementById('btn-start').disabled=false;}}
async function stopServer(){try{document.getElementById('btn-stop').disabled=true;const r=await fetch('/api/stop',{method:'POST'});const d=await r.json();if(d.error){showToast(d.error,'error');document.getElementById('btn-stop').disabled=false;}else showToast('Server stopped','info');}catch(e){showToast('Failed to stop server','error');document.getElementById('btn-stop').disabled=false;}}
async function restartServer(){try{document.getElementById('btn-restart').disabled=true;showToast('Restarting server...','warning');const r=await fetch('/api/restart',{method:'POST'});const d=await r.json();if(d.error)showToast(d.error,'error');else showToast('Server restarted (PID: '+d.pid+')','success');}catch(e){showToast('Restart failed','error');}}

// ═══════ Quick Commands ═══════
async function sendQuickCommand(cmd){
  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    const d = await r.json();
    if (d.error) showToast(d.error, 'error');
    else showToast(`Executed: ${cmd}`, 'success');
  } catch (e) {
    showToast('Failed to execute shortcut', 'error');
  }
}

// ═══════ Console ═══════
function appendLogLine(entry){
  const output=document.getElementById('console-output'),preview=document.getElementById('console-preview');
  output.querySelector('.console-empty')?.remove(); preview.querySelector('.console-empty')?.remove();
  const line=createLogElement(entry);output.appendChild(line);allLogElements.push(line);applyFilterToLine(line,entry);
  if(document.getElementById('autoscroll-toggle')?.checked)output.scrollTop=output.scrollHeight;
  const pLine=createLogElement(entry,true);preview.appendChild(pLine);
  while(preview.children.length>20)preview.removeChild(preview.firstChild);preview.scrollTop=preview.scrollHeight;
  while(allLogElements.length>3000){allLogElements.shift().remove();}
}
function createLogElement(entry,compact=false){
  const line=document.createElement('div');line.className=`log-line ${entry.type}`;line.dataset.type=entry.type;line.dataset.text=entry.text.toLowerCase();
  if(!compact){const ts=document.createElement('span');ts.className='log-timestamp';ts.textContent=new Date(entry.timestamp).toLocaleTimeString();line.appendChild(ts);}
  const text=document.createElement('span');text.className='log-text';text.textContent=entry.text;line.appendChild(text);return line;
}
function initLogFilter(){
  const fi=document.getElementById('log-filter'),ts=document.getElementById('log-type-filter');
  const apply=()=>{const f=fi.value.toLowerCase(),t=ts.value;allLogElements.forEach(el=>{el.classList.toggle('hidden',!((!t||el.dataset.type===t)&&(!f||el.dataset.text.includes(f))));});};
  fi.addEventListener('input',apply);ts.addEventListener('change',apply);
}
function applyFilterToLine(el,entry){const f=document.getElementById('log-filter').value.toLowerCase(),t=document.getElementById('log-type-filter').value;el.classList.toggle('hidden',!((!t||entry.type===t)&&(!f||entry.text.toLowerCase().includes(f))));}
function clearLogs(){document.getElementById('console-output').innerHTML='<div class="console-empty">Console cleared.</div>';allLogElements=[];}
function exportLogs(){window.open('/api/logs/export','_blank');showToast('Exporting logs...','info');}
function initConsoleInput(){document.getElementById('console-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();sendCommand();}});}
async function sendCommand(){const input=document.getElementById('console-input'),cmd=input.value.trim();if(!cmd)return;try{const r=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:cmd})});const d=await r.json();if(d.error)showToast(d.error,'error');}catch(e){showToast('Spell failed','error');}input.value='';input.focus();}

// ═══════ Performance ═══════
async function loadPerfHistory(){try{const r=await fetch('/api/perf?count=120');perfData=await r.json();drawCharts();}catch(e){}}
function handlePerfPoint(p){
  perfData.push(p);if(perfData.length>120)perfData=perfData.slice(-120);
  document.getElementById('mini-cpu-fill').style.width=p.cpuPercent+'%';setText('mini-cpu-val',p.cpuPercent+'%');
  document.getElementById('mini-mem-fill').style.width=p.memPercent+'%';setText('mini-mem-val',p.memPercent+'%');
  const sp=p.memTotal>0?Math.min((p.serverMem/p.memTotal)*100,100):0;
  document.getElementById('mini-srv-fill').style.width=(p.serverMem>0?Math.max(sp,1):0)+'%';
  setText('mini-srv-val',p.serverMem>0?formatBytes(p.serverMem):'—');
  setText('perf-cpu-current',p.cpuPercent+'%');setText('perf-mem-current',p.memPercent+'%');
  setText('perf-srv-current',p.serverMem>0?formatBytes(p.serverMem):'—');setText('ss-mem',p.serverMem>0?formatBytes(p.serverMem):'—');
  if(document.getElementById('panel-performance').classList.contains('active'))drawCharts();
}
function drawCharts(){
  if(!perfData.length)return;
  drawChart('chart-cpu',perfData.map(p=>p.cpuPercent),100,'#c0392b','rgba(192,57,43,0.1)');
  drawChart('chart-mem',perfData.map(p=>p.memPercent),100,'#2964c0','rgba(41,100,192,0.1)');
  const sv=perfData.map(p=>p.serverMem/1048576);drawChart('chart-srv',sv,Math.max(...sv,100),'#27ae60','rgba(39,174,96,0.1)');
}
function drawChart(id,data,maxVal,color,fill){
  const c=document.getElementById(id);if(!c)return;const ctx=c.getContext('2d');const dpr=window.devicePixelRatio||1;const rect=c.getBoundingClientRect();
  c.width=rect.width*dpr;c.height=rect.height*dpr;ctx.scale(dpr,dpr);const w=rect.width,h=rect.height;ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='rgba(200,170,110,0.05)';ctx.lineWidth=1;for(let i=0;i<5;i++){const y=(h/4)*i;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  if(data.length<2)return;const step=w/(data.length-1);
  ctx.beginPath();ctx.moveTo(0,h);data.forEach((v,i)=>{ctx.lineTo(i*step,h-(Math.min(v,maxVal)/maxVal)*(h-10));});ctx.lineTo(w,h);ctx.closePath();ctx.fillStyle=fill;ctx.fill();
  ctx.beginPath();data.forEach((v,i)=>{const x=i*step,y=h-(Math.min(v,maxVal)/maxVal)*(h-10);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.stroke();
  const last=data[data.length-1],lx=(data.length-1)*step,ly=h-(Math.min(last,maxVal)/maxVal)*(h-10);
  ctx.beginPath();ctx.arc(lx,ly,3.5,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  ctx.beginPath();ctx.arc(lx,ly,6,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=1;ctx.globalAlpha=0.3;ctx.stroke();ctx.globalAlpha=1;
}

// ═══════ Settings ═══════
async function loadSettings(){try{const r=await fetch('/api/settings');const s=await r.json();if(s.error)return;currentSettings=s;document.getElementById('setting-name').value=s.name||'';document.getElementById('setting-port').value=s.port||7777;document.getElementById('setting-maxplayers').value=s.maxPlayers||100;document.getElementById('setting-offline').checked=s.offlineMode??true;document.getElementById('setting-npc').checked=s.npcEnabled??false;document.getElementById('setting-master').value=s.master||'';document.getElementById('setting-datadir').value=s.dataDir||'data';renderLoadOrderEditor(s.loadOrder||[]);renderDashboardLoadOrder(s.loadOrder||[]);}catch(e){}}
async function loadPanelConfig(){try{const r=await fetch('/api/panel-config');panelConfig=await r.json();document.getElementById('panel-autorestart').checked=panelConfig.autoRestart||false;document.getElementById('panel-maxretries').value=panelConfig.autoRestartMaxRetries||3;document.getElementById('panel-scheduledrestart').checked=panelConfig.scheduledRestart?.enabled||false;document.getElementById('panel-restartinterval').value=panelConfig.scheduledRestart?.intervalHours||6;document.getElementById('panel-autobackup').checked=panelConfig.autoBackup?.enabled||false;document.getElementById('panel-backupinterval').value=panelConfig.autoBackup?.intervalHours||24;document.getElementById('panel-backupretention').value=panelConfig.backupRetention||10;document.getElementById('panel-alerts-enabled').checked=panelConfig.resourceAlerts?.enabled||false;}catch(e){}}

function renderLoadOrderEditor(lo){const c=document.getElementById('loadorder-editor');c.innerHTML='';lo.forEach(p=>{const d=document.createElement('div');d.className='loadorder-edit-item';d.innerHTML=`<input type="text" value="${escapeHtml(p)}" class="loadorder-path-input"><button class="btn-remove" onclick="this.parentElement.remove()">×</button>`;c.appendChild(d);});}
function renderDashboardLoadOrder(lo){const l=document.getElementById('loadorder-list');if(!lo.length){l.innerHTML='<div class="empty-state-sm">No scrolls in the load order</div>';return;}l.innerHTML=lo.map((p,i)=>`<div class="loadorder-item"><span class="loadorder-index">${i}</span><span class="loadorder-name" title="${escapeHtml(p)}">${escapeHtml(p.split(/[/\\]/).pop())}</span></div>`).join('');}
function addLoadOrderEntry(){const c=document.getElementById('loadorder-editor');const d=document.createElement('div');d.className='loadorder-edit-item';d.innerHTML=`<input type="text" value="" class="loadorder-path-input" placeholder="Path to scroll (.esm/.esp)..."><button class="btn-remove" onclick="this.parentElement.remove()">×</button>`;c.appendChild(d);}

async function saveAllSettings(){
  try{
    const lo=[];document.querySelectorAll('.loadorder-path-input').forEach(i=>{const v=i.value.trim();if(v)lo.push(v);});
    const s={name:document.getElementById('setting-name').value,port:parseInt(document.getElementById('setting-port').value)||7777,maxPlayers:parseInt(document.getElementById('setting-maxplayers').value)||100,offlineMode:document.getElementById('setting-offline').checked,npcEnabled:document.getElementById('setting-npc').checked,npcSettings:currentSettings.npcSettings||{},master:document.getElementById('setting-master').value,dataDir:document.getElementById('setting-datadir').value||'data',loadOrder:lo};
    const r1=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)});const d1=await r1.json();if(d1.error){showToast(d1.error,'error');return;}
    const pc={autoRestart:document.getElementById('panel-autorestart').checked,autoRestartMaxRetries:parseInt(document.getElementById('panel-maxretries').value)||3,autoRestartDelayMs:5000,scheduledRestart:{enabled:document.getElementById('panel-scheduledrestart').checked,intervalHours:parseInt(document.getElementById('panel-restartinterval').value)||6},autoBackup:{enabled:document.getElementById('panel-autobackup').checked,intervalHours:parseInt(document.getElementById('panel-backupinterval').value)||24},backupRetention:parseInt(document.getElementById('panel-backupretention').value)||10,resourceAlerts:{enabled:document.getElementById('panel-alerts-enabled').checked,cpuThreshold:90,memThreshold:90}};
    await fetch('/api/panel-config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(pc)});
    showToast('Settings saved successfully. Restart required.','success');fetchStatus();
  }catch(e){showToast('Failed to save settings','error');}
}

// Raw JSON editor
function toggleRawEditor(){
  const fv=document.getElementById('settings-form-view'),rv=document.getElementById('settings-raw-view');
  const btn=document.getElementById('btn-toggle-raw');
  if(rv.style.display==='none'){rv.style.display='block';fv.style.display='none';btn.textContent='📋 Form View';loadRawSettings();}
  else{rv.style.display='none';fv.style.display='block';btn.textContent='📝 Raw JSON';loadSettings();}
}
async function loadRawSettings(){try{const r=await fetch('/api/settings/raw');const d=await r.json();document.getElementById('raw-settings-editor').value=d.content||'';updateRawLineNumbers();}catch(e){}}
async function saveRawSettings(){try{const c=document.getElementById('raw-settings-editor').value;const r=await fetch('/api/settings/raw',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:c})});const d=await r.json();if(d.error)showToast(d.error,'error');else{showToast('Raw settings saved!','success');loadSettings();}}catch(e){showToast('Invalid JSON content','error');}}
function updateRawLineNumbers(){const e=document.getElementById('raw-settings-editor'),n=document.getElementById('raw-line-numbers');if(!e||!n)return;const lines=e.value.split('\n').length;let h='';for(let i=1;i<=Math.max(lines,15);i++)h+=i+'\n';n.textContent=h;}

// ═══════ Gamemode ═══════
async function loadGamemode(){try{const r=await fetch('/api/gamemode');const d=await r.json();if(d.error)return;document.getElementById('gamemode-editor').value=d.content||'';setText('editor-lines','Lines: '+(d.content||'').split('\n').length);setText('editor-size','Size: '+formatBytes(d.size||0));if(d.modified)setText('editor-meta','Last inscribed: '+new Date(d.modified).toLocaleString());updateLineNumbers();}catch(e){}}
async function saveGamemode(){try{const c=document.getElementById('gamemode-editor').value;const r=await fetch('/api/gamemode',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:c})});const d=await r.json();if(d.error)showToast(d.error,'error');else{showToast('Gamemode saved!','success');setText('editor-meta','Last saved: '+new Date().toLocaleString());}}catch(e){showToast('Failed to save gamemode','error');}}
function initEditorLineNumbers(){const e=document.getElementById('gamemode-editor');e.addEventListener('input',updateLineNumbers);e.addEventListener('scroll',()=>{document.getElementById('line-numbers').scrollTop=e.scrollTop;});e.addEventListener('keydown',ev=>{if(ev.key==='Tab'){ev.preventDefault();const s=e.selectionStart,end=e.selectionEnd;e.value=e.value.substring(0,s)+'  '+e.value.substring(end);e.selectionStart=e.selectionEnd=s+2;updateLineNumbers();}});
  // Also wire raw editor
  const re=document.getElementById('raw-settings-editor');if(re){re.addEventListener('input',updateRawLineNumbers);re.addEventListener('scroll',()=>{const rn=document.getElementById('raw-line-numbers');if(rn)rn.scrollTop=re.scrollTop;});}
  updateLineNumbers();}
function updateLineNumbers(){const e=document.getElementById('gamemode-editor');const lines=e.value.split('\n').length;let h='';for(let i=1;i<=Math.max(lines,25);i++)h+=i+'\n';document.getElementById('line-numbers').textContent=h;setText('editor-lines','Lines: '+lines);}

// ═══════ Profiles ═══════
async function loadProfiles(){try{const r=await fetch('/api/profiles');const ps=await r.json();const l=document.getElementById('profiles-list');if(!ps.length){l.innerHTML='<div class="empty-state"><div class="empty-icon">📜</div><p>No profiles found</p></div>';return;}l.innerHTML=ps.map(p=>`<div class="profile-card"><div class="profile-info"><h4>${escapeHtml(p.name)}</h4><p>${new Date(p.createdAt).toLocaleString()} · Port ${p.settings?.port||'?'} · ${p.settings?.maxPlayers||'?'} players</p></div><div class="profile-actions"><button class="btn btn-sm btn-primary" onclick="loadProfile('${p.id}')">Load</button><button class="btn btn-sm btn-danger" onclick="deleteProfile('${p.id}')">Delete</button></div></div>`).join('');}catch(e){}}
async function createProfile(){const n=document.getElementById('profile-name-input').value.trim();if(!n){showToast('Enter profile name','warning');return;}try{const r=await fetch('/api/profiles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});const d=await r.json();if(d.error)showToast(d.error,'error');else{showToast(`Profile "${n}" saved`,'success');document.getElementById('profile-name-input').value='';loadProfiles();}}catch(e){showToast('Save failed','error');}}
async function loadProfile(id){if(!confirm('Load this profile? Current settings will be overwritten.'))return;try{const r=await fetch(`/api/profiles/${id}/load`,{method:'POST'});const d=await r.json();if(d.error)showToast(d.error,'error');else{showToast('Profile loaded!','success');loadSettings();}}catch(e){showToast('Load failed','error');}}
async function deleteProfile(id){if(!confirm('Delete this profile?'))return;try{await fetch(`/api/profiles/${id}`,{method:'DELETE'});showToast('Profile deleted','info');loadProfiles();}catch(e){}}

// ═══════ Backups ═══════
async function loadBackups(){try{const r=await fetch('/api/backups');const bs=await r.json();const l=document.getElementById('backups-list');if(!bs.length){l.innerHTML='<div class="empty-state"><div class="empty-icon">🛡</div><p>No backups found</p></div>';return;}l.innerHTML=bs.map(b=>`<div class="backup-card"><div class="backup-info"><h4>${escapeHtml(b.name)}</h4><p>${new Date(b.createdAt).toLocaleString()} · ${formatBytes(b.totalSize||0)}</p><div class="backup-tags">${(b.contents||[]).map(c=>`<span class="backup-tag">${escapeHtml(c)}</span>`).join('')}</div></div><div class="backup-actions"><button class="btn btn-sm btn-primary" onclick="restoreBackup('${b.id}')">Restore</button><button class="btn btn-sm btn-danger" onclick="deleteBackup('${b.id}')">Delete</button></div></div>`).join('');}catch(e){}}
async function createBackup(){const n=document.getElementById('backup-name-input').value.trim()||'Backup '+new Date().toLocaleString();try{showToast('Creating backup...','info');const r=await fetch('/api/backups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,includeSettings:document.getElementById('backup-inc-settings').checked,includeGamemode:document.getElementById('backup-inc-gamemode').checked,includeWorld:document.getElementById('backup-inc-world').checked})});const d=await r.json();if(d.error)showToast(d.error,'error');else{showToast(`Backup "${n}" created (${formatBytes(d.totalSize||0)})`,'success');document.getElementById('backup-name-input').value='';loadBackups();}}catch(e){showToast('Backup failed','error');}}
async function restoreBackup(id){if(!confirm('⚠ Restore this backup?\nCurrent data will be overwritten. Stop server first!'))return;try{const r=await fetch(`/api/backups/${id}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});const d=await r.json();if(d.error)showToast(d.error,'error');else{showToast(`Restored: ${d.restored.join(', ')}`,'success');loadSettings();loadGamemode();loadFiles();}}catch(e){showToast('Restoration failed','error');}}
async function deleteBackup(id){if(!confirm('Destroy this backup?'))return;try{await fetch(`/api/backups/${id}`,{method:'DELETE'});showToast('Backup destroyed','info');loadBackups();}catch(e){}}

// ═══════ Files ═══════
async function loadFiles(){try{const r=await fetch('/api/files');const d=await r.json();if(d.error)return;renderFileList('world-files',d.worldData,'No world data');renderFileList('script-files',d.dataScripts,'No scripts');renderFileList('server-root-files',d.serverFiles,'No files');}catch(e){}}
function renderFileList(id,files,msg){const el=document.getElementById(id);if(!files?.length){el.innerHTML=`<div class="empty-state-sm">${msg}</div>`;return;}el.innerHTML=files.map(f=>`<div class="file-item"><span class="file-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span><div class="file-item-meta"><span class="file-item-size">${formatBytes(f.size)}</span>${f.modified?`<span class="file-item-date">${new Date(f.modified).toLocaleDateString()}</span>`:''}</div></div>`).join('');}
async function resetWorld(){if(!confirm('⚠ Reset all world data?\nThis cannot be undone. Stop the server first!'))return;try{const r=await fetch('/api/world/reset',{method:'POST'});const d=await r.json();if(d.error)showToast(d.error,'error');else{showToast(d.message||'World reset successful','success');loadFiles();fetchStatus();}}catch(e){showToast('Reset failed','error');}}

// ═══════ Plugins ═══════
async function loadPlugins(){
  try {
    const r = await fetch('/api/plugins');
    const ps = await r.json();
    const l = document.getElementById('plugin-list');
    if (!ps.length) {
      l.innerHTML = '<div class="empty-state"><div class="empty-icon">⚔</div><p>No plugins found</p><p style="font-size:0.8rem;color:var(--text-muted);">Place .pex or .js files in data/scripts</p></div>';
      return;
    }
    l.innerHTML = ps.map(p => `
      <div class="plugin-card ${p.active ? 'active' : ''}">
        <div class="plugin-icon">${p.type === 'Papyrus' ? '📜' : '⚔'}</div>
        <div class="plugin-info">
          <h4>${escapeHtml(p.name)}</h4>
          <p>${p.type} Module</p>
        </div>
      </div>
    `).join('');
  } catch (e) {}
}

// ═══════ Player Management ═══════
async function loadPlayers() {
  try {
    const r = await fetch('/api/players');
    allPlayers = await r.json();
    renderPlayers();
    renderDashboardPlayers();
  } catch (e) {}
}
function renderPlayers() {
  const tbody = document.getElementById('player-table-body');
  const search = document.getElementById('player-search').value.toLowerCase();
  const filtered = allPlayers.filter(p => p.name.toLowerCase().includes(search) || p.id.includes(search));
  
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-table">${allPlayers.length ? 'No players matching search' : 'No players connected'}</td></tr>`;
    return;
  }
  
  tbody.innerHTML = filtered.map(p => `
    <tr>
      <td><span class="badge-id">${p.id}</span></td>
      <td><strong>${escapeHtml(p.name)}</strong></td>
      <td>${new Date(p.joinTime).toLocaleTimeString()}</td>
      <td><span class="ping-text">${p.ping || 0}ms</span></td>
      <td class="actions-col">
        <button class="btn btn-sm btn-outline" onclick="setPlayerValuePrompt('${p.id}')">⚙ Set Value</button>
        <button class="btn btn-sm btn-restart" onclick="kickPlayer('${p.id}')">👢 Kick</button>
        <button class="btn btn-sm btn-stop" onclick="banPlayer('${p.id}')">🚫 Ban</button>
      </td>
    </tr>
  `).join('');
}
function renderDashboardPlayers() {
  const el = document.getElementById('dash-player-list');
  if (!allPlayers.length) {
    el.innerHTML = '<div class="empty-state-sm">No players connected</div>';
    return;
  }
  el.innerHTML = allPlayers.slice(0, 5).map(p => `
    <div class="player-item-mini">
      <div><span class="name">${escapeHtml(p.name)}</span><span class="id">#${p.id}</span></div>
      <span class="time">${timeAgo(p.joinTime)}</span>
    </div>
  `).join('');
}
function filterPlayers() { renderPlayers(); }

async function kickPlayer(id) {
  if (!confirm(`Kick player ${id}?`)) return;
  try {
    const r = await fetch(`/api/players/${id}/kick`, { method: 'POST' });
    const d = await r.json();
    if (d.error) showToast(d.error, 'error');
    else showToast(`Kicked player ${id}`, 'success');
  } catch (e) { showToast('Action failed', 'error'); }
}
async function banPlayer(id) {
  if (!confirm(`Ban player ${id}?`)) return;
  try {
    const r = await fetch(`/api/players/${id}/ban`, { method: 'POST' });
    const d = await r.json();
    if (d.error) showToast(d.error, 'error');
    else showToast(`Banned player ${id}`, 'success');
  } catch (e) { showToast('Action failed', 'error'); }
}
async function setPlayerValuePrompt(id) {
  const key = prompt('Enter value key (e.g. health, level, gold):', 'health');
  if (!key) return;
  const val = prompt(`Enter new value for ${key}:`, '100');
  if (val === null) return;
  try {
    const r = await fetch(`/api/players/${id}/set-value`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: val })
    });
    const d = await r.json();
    if (d.error) showToast(d.error, 'error');
    else showToast(`Set ${key} to ${val} for player ${id}`, 'success');
  } catch (e) { showToast('Action failed', 'error'); }
}

// ═══════ Atmosphere ═══════
function initTheme(){
  const saved = localStorage.getItem('skymp-theme') || 'default';
  setTheme(saved);
}
function setTheme(theme){
  document.body.dataset.theme = theme === 'default' ? '' : theme;
  localStorage.setItem('skymp-theme', theme);
  // Update UI buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  if(theme !== 'default') showToast(`Atmosphere shifted to ${theme.charAt(0).toUpperCase() + theme.slice(1)}`,'info');
}

// ═══════ Notes ═══════
async function loadNotes(){try{const r=await fetch('/api/notes');const d=await r.json();notesData=d.notes||[];renderNotes();}catch(e){}}
function renderNotes(){
  const l=document.getElementById('notes-list');
  if(!notesData.length){l.innerHTML='<div class="empty-state"><div class="empty-icon">🪶</div><p>No notes found</p><p style="font-size:0.82rem;color:var(--text-muted);">Add notes to keep track of server changes</p></div>';return;}
  l.innerHTML=notesData.map((n,i)=>`<div class="note-card"><div class="note-header"><input type="text" class="note-title" value="${escapeHtml(n.title||'')}" placeholder="Note title..." data-idx="${i}"><span class="note-timestamp">${n.timestamp?new Date(n.timestamp).toLocaleDateString():''}</span></div><textarea class="note-body" data-idx="${i}" placeholder="Enter note content...">${escapeHtml(n.body||'')}</textarea><button class="note-delete" onclick="deleteNote(${i})" title="Delete">×</button></div>`).join('');
}
function addNote(){notesData.unshift({title:'',body:'',timestamp:new Date().toISOString()});renderNotes();}
function deleteNote(i){notesData.splice(i,1);renderNotes();}
async function saveNotes(){
  // Collect from DOM
  document.querySelectorAll('.note-title').forEach(el=>{const i=parseInt(el.dataset.idx);if(notesData[i])notesData[i].title=el.value;});
  document.querySelectorAll('.note-body').forEach(el=>{const i=parseInt(el.dataset.idx);if(notesData[i])notesData[i].body=el.value;});
  try{await fetch('/api/notes',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({notes:notesData})});showToast('Notes saved!','success');}catch(e){showToast('Failed to save notes','error');}
}

// ═══════ Activity ═══════
async function loadActivity(){try{const r=await fetch('/api/activity?count=50');const items=await r.json();const df=document.getElementById('dash-activity-feed');if(!items.length){df.innerHTML='<div class="empty-state-sm">No activity recorded</div>';}else{df.innerHTML=items.slice(0,8).map(a=>activityItemHTML(a)).join('');}const fl=document.getElementById('activity-list');if(!items.length){fl.innerHTML='<div class="empty-state"><div class="empty-icon">📜</div><p>No activity records found</p></div>';}else{fl.innerHTML=items.map(a=>activityItemFullHTML(a)).join('');}}catch(e){}}
function activityItemHTML(a){return `<div class="activity-item"><div class="activity-dot ${a.type}"></div><div class="activity-body"><div class="activity-action">${escapeHtml(a.action)}</div>${a.details?`<div class="activity-details">${escapeHtml(a.details)}</div>`:''}</div><div class="activity-time">${timeAgo(a.timestamp)}</div></div>`;}
function activityItemFullHTML(a){return `<div class="activity-item-full"><div class="activity-dot ${a.type}"></div><div class="activity-body"><div class="activity-action">${escapeHtml(a.action)}</div>${a.details?`<div class="activity-details">${escapeHtml(a.details)}</div>`:''}</div><div class="activity-time">${new Date(a.timestamp).toLocaleString()}</div></div>`;}
function prependActivityItem(a,c,max){if(!c)return;c.querySelector('.empty-state-sm')?.remove();c.querySelector('.empty-state')?.remove();c.insertAdjacentHTML('afterbegin',activityItemHTML(a));while(c.children.length>max)c.removeChild(c.lastChild);}
function prependActivityItemFull(a,c){if(!c)return;c.querySelector('.empty-state')?.remove();c.insertAdjacentHTML('afterbegin',activityItemFullHTML(a));}
async function clearActivity(){if(!confirm('Clear all activity history?'))return;try{await fetch('/api/activity',{method:'DELETE'});showToast('Activity history cleared','info');loadActivity();}catch(e){}}

// ═══════ Uptime History ═══════
async function loadUptimeHistory(){
  try{const r=await fetch('/api/uptime-history');const items=await r.json();
    const l=document.getElementById('uptime-list');
    if(!items.length){l.innerHTML='<div class="empty-state"><div class="empty-icon">📊</div><p>No sessions recorded yet</p></div>';return;}
    l.innerHTML=items.map(s=>{
      const icon=s.exitCode===0||s.exitCode===null?'🟢':'🔴';
      const start=s.start?new Date(s.start).toLocaleString():'Unknown';
      return `<div class="uptime-card"><div class="uptime-icon">${icon}</div><div class="uptime-info"><strong>${formatDuration(s.duration||0)}</strong><br><span>${start} · ${s.reason||'manual'}</span></div><div class="uptime-meta">Exit: ${s.exitCode??'—'}</div></div>`;
    }).join('');
  }catch(e){}
}

// ═══════ System ═══════
async function loadSystemInfo(){try{const r=await fetch('/api/system');const s=await r.json();setSystemRows('sys-host',[['Hostname',s.hostname],['Platform',s.platform],['Architecture',s.arch],['Release',s.release]]);setSystemRows('sys-hw',[['CPU',s.cpuModel],['Cores',s.cpuCores],['Speed',s.cpuSpeed+' MHz'],['Total RAM',formatBytes(s.totalMemory)],['Free RAM',formatBytes(s.freeMemory)]]);setSystemRows('sys-paths',[['Server',s.serverDir],['Settings',s.settingsFile],['World',s.worldDir]]);const nets=(s.networkInterfaces||[]).map(n=>[n.name,n.address]);setSystemRows('sys-network',nets.length?nets:[['Status','No external interfaces']]);setSystemRows('sys-storage',[['World',formatBytes(s.worldSize||0)],['Backups',formatBytes(s.backupsSize||0)]]);setSystemRows('sys-runtime',[['Node.js',s.nodeVersion],['OS Uptime',formatDuration(s.uptime||0)],['Panel Uptime',formatDuration(s.panelUptime||0)],['Heap',formatBytes(s.panelMemory?.heapUsed||0)],['RSS',formatBytes(s.panelMemory?.rss||0)]]);}catch(e){}}
function setSystemRows(id,rows){const el=document.getElementById(id);if(!el)return;el.innerHTML=rows.map(([l,v])=>`<div class="system-row"><span class="sys-label">${escapeHtml(String(l))}</span><span class="sys-value">${escapeHtml(String(v||'—'))}</span></div>`).join('');}

// ═══════ Connection ═══════
function copyConnectionInfo(){const addr=document.getElementById('conn-address').textContent+':'+document.getElementById('conn-port').textContent;navigator.clipboard?.writeText(addr);showToast('Address copied: '+addr,'success');}

// ═══════ Toast ═══════
function showToast(msg,type='info'){const c=document.getElementById('toast-container');const t=document.createElement('div');t.className=`toast ${type}`;const icons={success:'✓',error:'✖',warning:'⚠',info:'ℹ'};t.innerHTML=`<span>${icons[type]||'ℹ'}</span> ${escapeHtml(msg)}`;c.appendChild(t);setTimeout(()=>{t.classList.add('removing');setTimeout(()=>t.remove(),300);},4000);}

// ═══════ Utils ═══════
function escapeHtml(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function formatBytes(b){if(!b)return'0 B';const k=1024,s=['B','KB','MB','GB'];const i=Math.floor(Math.log(b)/Math.log(k));return parseFloat((b/Math.pow(k,i)).toFixed(1))+' '+s[i];}
function formatTime(s){return Math.floor(s/3600).toString().padStart(2,'0')+':'+Math.floor((s%3600)/60).toString().padStart(2,'0')+':'+(s%60).toString().padStart(2,'0');}
function formatDuration(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);if(d>0)return d+'d '+h+'h '+m+'m';if(h>0)return h+'h '+m+'m';return m+'m';}
function timeAgo(ts){const s=Math.floor((Date.now()-new Date(ts).getTime())/1000);if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function setText(id,v){const el=document.getElementById(id);if(el)el.textContent=v;}

// ═══════ Addons & Tools ═══════
function downloadLauncher() {
  const ip = document.getElementById('launcher-ip-input').value.trim() || '127.0.0.1';
  
  const batContent = `@echo off
echo ==============================================
echo SkyMP Auto-Connect Launcher
echo Target IP: ${ip}
echo ==============================================
echo Installing override plugin...

if not exist "Data\\Platform\\Plugins" mkdir "Data\\Platform\\Plugins"
echo const sp = require('skyrimPlatform'); sp.once('update', () =^> { sp.storage["serverAddress"] = { hostName: '${ip}', port: 7777 }; }); > "Data\\Platform\\Plugins\\_skyMP_autoconnect.js"

echo Launching Game...
start "" "skse64_loader.exe" -waitfortesting
exit`;

  const blob = new Blob([batContent], { type: 'application/bat' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Play_SkyMP_${ip.replace(/[^a-zA-Z0-9.-]/g, '_')}.bat`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Launcher generated for ${ip}. Place in Skyrim folder.`, 'success');
}

const SAMPLE_SCRIPTS = [
  {
    id: 'welcome',
    title: '👋 Welcome Message (Server)',
    target: 'server',
    filename: 'sample_welcome.js',
    desc: 'Sends a global notification every time a player joins the world.',
    content: `/* global mp */
mp.on('connect', (userId) => {
    const actorId = mp.getUserActor(userId);
    const name = mp.getActorName(actorId);
    mp.executeJavaScriptOnChakra(\`
        const sp = require('skyrimPlatform');
        sp.Debug.notification("\${name} joined the server!");
    \`);
});`
  },
  {
    id: 'speed',
    title: '⚡ Player Speed Override (Server)',
    target: 'server',
    filename: 'sample_speed.js',
    desc: 'Grants a 30% speed boost buff to players upon connection.',
    content: `/* global mp */
mp.on('connect', (userId) => {
    const actorId = mp.getUserActor(userId);
    mp.executeJavaScriptOnChakra(\`
        const sp = require('skyrimPlatform');
        const actor = sp.Actor.from(sp.Game.getFormEx(\${actorId}));
        if (actor) {
            actor.setActorValue("SpeedMult", 130);
        }
    \`);
});`
  },
  {
    id: 'regen',
    title: '❤️ Health Regeneration (Server)',
    target: 'server',
    filename: 'sample_regen.js',
    desc: 'Periodically restores target health over time using internal loops.',
    content: `/* global mp */
setInterval(() => {
    mp.executeJavaScriptOnChakra(\`
        const sp = require('skyrimPlatform');
        const p = sp.Game.getPlayer();
        if (p && p.getActorValue("Health") < p.getBaseActorValue("Health")) {
            p.restoreActorValue("Health", 5.0);
        }
    \`);
}, 5000);`
  },
  {
    id: 'autoconnect',
    title: '🤖 Auto-Connect Enforcer (Client)',
    target: 'client',
    filename: '_force_autoconnect.js',
    desc: 'Installs a client-sided mod that overrides sp.storage.serverAddress so the game always connects to localhost.',
    content: `// Forces the client UI to immediately use localhost
const sp = require("skyrimPlatform");
sp.once("update", () => {
    sp.storage["serverAddress"] = { hostName: "127.0.0.1", port: 7777 };
});`
  },
  {
    id: 'income',
    title: '💰 Passive Income Sandbox (Server)',
    target: 'server',
    filename: 'sample_income.js',
    desc: 'Gives players passive gold every 60 seconds.',
    content: `/* global mp */
setInterval(() => {
    mp.executeJavaScriptOnChakra(\`
        const sp = require('skyrimPlatform');
        const p = sp.Game.getPlayer();
        if (p) p.addItem(sp.Game.getFormEx(0xF), 10, false);
    \`);
}, 60000);`
  },
  {
    id: 'weather',
    title: '🌩️ Clear Weather Loop (Server)',
    target: 'server',
    filename: 'sample_weather.js',
    desc: 'Forces the weather to remain clear ("SkyrimClear") via Chakra API.',
    content: `/* global mp */
mp.on('connect', (userId) => {
    mp.executeJavaScriptOnChakra(\`
        const sp = require('skyrimPlatform');
        const w = sp.Weather.from(sp.Game.getFormEx(0x81A));
        if (w) w.forceActive(true);
    \`);
});`
  },
  {
    id: 'killfeed',
    title: '☠️ Kill Feed Logs (Server)',
    target: 'server',
    filename: 'sample_killfeed.js',
    desc: 'Hooks death state to print combat logs and alert the server.',
    content: `/* global mp */
mp.executeJavaScriptOnChakra(\`
    const sp = require('skyrimPlatform');
    sp.on('update', () => {
        const p = sp.Game.getPlayer();
        if (p && p.isDead()) {
            sp.Debug.notification("A player was killed!");
        }
    });
\`);`
  },
  {
    id: 'startergear',
    title: '🛡️ Spawn Starter Gear (Server)',
    target: 'server',
    filename: 'sample_startergear.js',
    desc: 'Gives an Iron Sword and Armor to new players.',
    content: `/* global mp */
mp.on('connect', (userId) => {
    const actorId = mp.getUserActor(userId);
    mp.executeJavaScriptOnChakra(\`
        const sp = require('skyrimPlatform');
        const actor = sp.Actor.from(sp.Game.getFormEx(\${actorId}));
        if (actor) {
            actor.addItem(sp.Game.getFormEx(0x12EB7), 1, false);
            actor.addItem(sp.Game.getFormEx(0x12E49), 1, false);
        }
    \`);
});`
  },
  {
    id: 'pvp',
    title: '⚔️ Global PvP Enable (Server)',
    target: 'server',
    filename: 'sample_pvpenable.js',
    desc: 'Disables safe zones and removes essential limits to allow combat.',
    content: `/* global mp */
mp.executeJavaScriptOnChakra(\`
    const sp = require('skyrimPlatform');
    const p = sp.Game.getPlayer();
    if (p) p.getActorBase().setEssential(false);
    sp.Debug.notification("Global PvP is now ENABLED.");
\`);`
  },
  {
    id: 'chatbox',
    title: '🌐 Simple Chat Broadcast (Server)',
    target: 'server',
    filename: 'sample_chatbroadcast.js',
    desc: 'Listens for custom chat packets and broadcasts them to all connected clients natively.',
    content: `/* global mp */
// Listens for 'chatMsg' custom packets and broadcasts them
mp.on('customPacket', (userId, contentString) => {
    try {
        const content = JSON.parse(contentString);
        if (content.customPacketType === 'chatMsg') {
            const actorId = mp.getUserActor(userId);
            const name = mp.getActorName(actorId);
            
            // Broadcast to all clients (assuming Max Players = 64)
            for (let id = 1; id <= 64; id++) {
                if (mp.isConnected(id)) {
                    mp.sendCustomPacket(id, JSON.stringify({
                        customPacketType: 'chatMsg',
                        sender: name,
                        text: content.message
                    }));
                }
            }
            console.log(\`[Chat] \${name}: \${content.message}\`);
        }
    } catch (err) { }
});`
  },
  {
    id: 'commands',
    title: '💻 Chat Command Parser (Server)',
    target: 'server',
    filename: 'sample_commands.js',
    desc: 'Parses incoming chat messages for /commands like /heal or /tp.',
    content: `/* global mp */
mp.on('customPacket', (userId, contentString) => {
    try {
        const content = JSON.parse(contentString);
        if (content.customPacketType === 'chatMsg' && content.message.startsWith('/')) {
            const actorId = mp.getUserActor(userId);
            const args = content.message.substring(1).split(' ');
            const cmd = args[0].toLowerCase();

            if (cmd === 'heal') {
                mp.executeJavaScriptOnChakra(\`
                    const sp = require('skyrimPlatform');
                    const actor = sp.Actor.from(sp.Game.getFormEx(\${actorId}));
                    if (actor) actor.restoreActorValue("Health", 9999);
                \`);
                console.log(\`[Cmd] Healed user \${userId}\`);
            } 
            else if (cmd === 'tp' && args[1] === 'whiterun') {
                mp.executeJavaScriptOnChakra(\`
                    const sp = require('skyrimPlatform');
                    const actor = sp.Actor.from(sp.Game.getFormEx(\${actorId}));
                    const dest = sp.ObjectReference.from(sp.Game.getFormEx(0x000B9DF5)); // Whiterun Center Marker
                    if (actor && dest) actor.moveTo(dest, 0, 0, 0, true);
                \`);
            }
        }
    } catch (err) { }
});`
  },
  {
    id: 'worldboss',
    title: '🧙‍♂️ Dynamic World Boss Spawner (Server)',
    target: 'server',
    filename: 'sample_worldboss.js',
    desc: 'Periodically spawns a Giant boss using Skyrim Engine Native calls in the background.',
    content: `/* global mp */
// Spawns a Giant near Whiterun
function spawnWorldBoss() {
    const giantFormId = 0x00023BBE;
    const pos = [30000, -10000, 5000]; // XYZ coords
    const angleZ = 0;
    const worldspace = 0x0000003C; // Tamriel
    
    // Natively creates a fully synchronized NPC for players!
    const bossActorId = mp.createActor(giantFormId, pos, angleZ, worldspace);
    console.log(\`[Event] World Boss spawned! Actor ID: \${bossActorId}\`);
}

// Spawn one 30 seconds after server starts
setTimeout(spawnWorldBoss, 30000);`
  }
];

function renderSampleScripts() {
  const container = document.getElementById('script-gallery-container');
  if (!container) return;
  
  container.innerHTML = SAMPLE_SCRIPTS.map(s => `
    <div class="script-sample-card" style="margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,0.2);">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h4 style="cursor: pointer; user-select: none; display: flex; align-items: center; gap: 8px; margin: 0; color: var(--gold);" onclick="toggleScriptPreview('${s.id}')">
          <span id="preview-icon-${s.id}" style="font-size: 0.8rem; opacity: 0.7;">▶</span> ${s.title}
        </h4>
        <button class="btn btn-sm btn-outline" onclick="injectSampleScript('${s.id}')">Add Script</button>
      </div>
      <p style="color: var(--text-muted); font-size: 0.82rem; margin-top: 5px; margin-bottom: 0;">${s.desc}</p>
      <div id="preview-code-${s.id}" style="display: none; margin-top: 10px;">
        <pre style="background: rgba(0,0,0,0.4); padding: 10px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); font-size: 0.8rem; overflow-x: auto; color: #a9b7c6; margin: 0;"><code>${escapeHtml(s.content)}</code></pre>
      </div>
    </div>
  `).join('');
}

function toggleScriptPreview(id) {
  const codeDiv = document.getElementById('preview-code-' + id);
  const icon = document.getElementById('preview-icon-' + id);
  if (!codeDiv) return;
  if (codeDiv.style.display === 'none') {
    codeDiv.style.display = 'block';
    icon.textContent = '▼';
  } else {
    codeDiv.style.display = 'none';
    icon.textContent = '▶';
  }
}

async function injectSampleScript(id) {
  const s = SAMPLE_SCRIPTS.find(x => x.id === id);
  if (!s) return;
  
  try {
    const r = await fetch('/api/plugins/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: s.target, filename: s.filename, content: s.content })
    });
    
    const d = await r.json();
    if (d.error) {
      showToast(d.error, 'error');
    } else {
      showToast(`Injected ${s.filename}!`, 'success');
      loadPlugins(); // Refresh list
    }
  } catch (e) {
    showToast('Failed to insert script', 'error');
  }
}
