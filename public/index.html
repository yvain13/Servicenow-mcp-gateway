<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ServiceNow MCP Gateway</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --canopy:#1B5E3F;--canopy-deep:#143F2C;--canopy-bright:#2E8B57;
    --canopy-soft:#E4EFE6;--canopy-line:#CBE0CF;--oat:#F7F4ED;
    --paper:#FFFFFF;--ink:#16201A;--ink-soft:#516056;--ink-faint:#8A988E;
    --line:#E6E1D6;--warn:#B7791F;--amber-soft:#FBF1DC;
    --radius:14px;--radius-sm:9px;
    --shadow:0 1px 2px rgba(20,40,28,.04),0 10px 30px -18px rgba(20,40,28,.25);
    --mono:'IBM Plex Mono',monospace;--sans:'IBM Plex Sans',sans-serif;
    --display:'Bricolage Grotesque',sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--sans);background:var(--oat);color:var(--ink);-webkit-font-smoothing:antialiased;
    background-image:radial-gradient(circle at 1px 1px,rgba(27,94,63,.05) 1px,transparent 0);background-size:26px 26px}
  .app{display:grid;grid-template-columns:264px 1fr;min-height:100vh}

  /* Sidebar */
  .sidebar{background:var(--canopy-deep);color:#DCEBE0;padding:22px 16px;display:flex;flex-direction:column;gap:22px;position:sticky;top:0;height:100vh}
  .brand{display:flex;align-items:center;gap:11px;padding:0 6px}
  .logo{width:34px;height:34px;border-radius:9px;flex-shrink:0;background:linear-gradient(140deg,var(--canopy-bright),var(--canopy));display:grid;place-items:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
  .logo svg{width:19px;height:19px}
  .brand h1{font-family:var(--display);font-size:15px;font-weight:700;line-height:1.1;color:#fff;letter-spacing:-.01em}
  .brand span{font-size:10.5px;color:#8FB89C;letter-spacing:.04em;text-transform:uppercase}
  .nav-label{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#6E9B7C;padding:0 8px;margin-bottom:8px;font-weight:600}
  .server-list{display:flex;flex-direction:column;gap:3px;flex:1;overflow:auto}
  .srv{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;cursor:pointer;font-size:13px;color:#C2D8C8;transition:.16s;border:1px solid transparent}
  .srv:hover{background:rgba(255,255,255,.05)}
  .srv.active{background:var(--canopy);color:#fff;border-color:rgba(255,255,255,.12)}
  .srv .dot{width:7px;height:7px;border-radius:50%;background:#5BD08C;flex-shrink:0;box-shadow:0 0 0 3px rgba(91,208,140,.18)}
  .srv .dot.off{background:#6E7D72;box-shadow:none}
  .srv .meta{margin-left:auto;font-family:var(--mono);font-size:10.5px;color:#7FA88D}
  .srv.active .meta{color:#B7D8C2}
  .new-srv{display:flex;align-items:center;justify-content:center;gap:8px;padding:11px;border-radius:9px;border:1px dashed #3C6650;color:#A9CDB6;background:transparent;font-family:var(--sans);font-size:12.5px;font-weight:600;cursor:pointer;width:100%;transition:.16s}
  .new-srv:hover{border-color:var(--canopy-bright);color:#fff;background:rgba(46,139,87,.12)}
  .conn{margin-top:auto;background:rgba(0,0,0,.18);border-radius:11px;padding:13px;border:1px solid rgba(255,255,255,.06);cursor:pointer}
  .conn .row{display:flex;align-items:center;gap:9px;font-size:12px;color:#CFE2D5}
  .conn .ic{width:24px;height:24px;border-radius:7px;background:rgba(91,208,140,.16);display:grid;place-items:center;flex-shrink:0}
  .conn .ic svg{width:13px;height:13px}
  .conn .inst{font-family:var(--mono);font-size:11px;color:#fff;margin-top:6px;display:block;word-break:break-all}
  .conn .stat{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;margin-top:7px;font-weight:600}
  .conn .stat.ok{color:#5BD08C}.conn .stat.ok::before{content:"";width:6px;height:6px;border-radius:50%;background:#5BD08C}
  .conn .stat.err{color:#F87171}
  .yt{margin-top:10px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:11px 13px;text-decoration:none;color:inherit;display:block;transition:.16s}
  .yt:hover{background:rgba(255,0,0,.08);border-color:rgba(255,80,80,.35)}
  .yt .yt-row{display:flex;align-items:center;gap:9px}
  .yt .yt-ic{width:24px;height:24px;border-radius:6px;background:#FF0033;display:grid;place-items:center;flex-shrink:0}
  .yt .yt-ic svg{width:14px;height:14px;fill:#fff}
  .yt .yt-handle{font-family:var(--mono);font-size:12px;color:#fff;font-weight:600}
  .yt .yt-tag{display:block;font-size:10.5px;color:#A9CDB6;margin-top:6px;line-height:1.4}

  /* Main */
  .main{padding:30px 40px;max-width:1080px}
  .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:16px;text-align:center}
  .empty-state h2{font-family:var(--display);font-size:22px;font-weight:700}
  .empty-state p{color:var(--ink-soft);font-size:13.5px;max-width:380px;line-height:1.6}
  .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:26px}
  .crumb{font-size:11.5px;color:var(--ink-faint);font-family:var(--mono);margin-bottom:10px;letter-spacing:.02em}
  .crumb b{color:var(--canopy)}
  .title-row{display:flex;align-items:center;gap:13px}
  .main h2{font-family:var(--display);font-size:27px;font-weight:700;letter-spacing:-.02em}
  .pill{font-size:11px;font-weight:600;padding:4px 11px;border-radius:30px;display:inline-flex;align-items:center;gap:6px}
  .pill.run{background:var(--canopy-soft);color:var(--canopy);border:1px solid var(--canopy-line)}
  .pill.run::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--canopy-bright);animation:pulse 2s infinite}
  .pill.stopped{background:var(--oat);color:var(--ink-faint);border:1px solid var(--line)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .sub{color:var(--ink-soft);font-size:13.5px;margin-top:9px;max-width:560px;line-height:1.55}
  .btn{font-family:var(--sans);font-size:13px;font-weight:600;cursor:pointer;padding:10px 16px;border-radius:9px;border:1px solid transparent;display:inline-flex;align-items:center;gap:8px;transition:.16s}
  .btn svg{width:15px;height:15px}
  .btn-primary{background:var(--canopy);color:#fff;box-shadow:var(--shadow)}
  .btn-primary:hover{background:var(--canopy-deep)}
  .btn-ghost{background:var(--paper);color:var(--ink);border-color:var(--line)}
  .btn-ghost:hover{border-color:var(--canopy-line);color:var(--canopy)}
  .btn-danger{background:#FEE2E2;color:#B91C1C;border-color:#FECACA}
  .btn-danger:hover{background:#FECACA}
  .btn-sm{padding:7px 12px;font-size:12px}
  .url-card{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;margin-bottom:24px;box-shadow:var(--shadow)}
  .url-card .label{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint);font-weight:600;margin-bottom:9px}
  .url-line{display:flex;align-items:center;gap:12px}
  .url{flex:1;font-family:var(--mono);font-size:13.5px;color:var(--canopy-deep);background:var(--canopy-soft);border:1px solid var(--canopy-line);border-radius:9px;padding:11px 14px;display:flex;align-items:center;gap:9px;overflow:hidden}
  .url svg{width:14px;height:14px;flex-shrink:0;opacity:.7}
  .copy-btn{cursor:pointer;color:var(--canopy);background:none;border:none;display:flex;align-items:center;gap:6px;font-family:var(--sans);font-size:12px;font-weight:600;padding:8px 12px;border-radius:8px;transition:.16s}
  .copy-btn:hover{background:var(--canopy-soft)}
  .stat-grid{display:flex;gap:30px;margin-top:16px;padding-top:15px;border-top:1px solid var(--line)}
  .stat-grid div span{display:block;font-size:11px;color:var(--ink-faint);margin-bottom:3px}
  .stat-grid div b{font-family:var(--mono);font-size:14px;color:var(--ink);font-weight:600}
  .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
  .section-head h3{font-family:var(--display);font-size:17px;font-weight:700}
  .section-head .count{font-family:var(--mono);font-size:12px;color:var(--ink-faint);margin-left:9px;font-weight:400}
  .tools{display:flex;flex-direction:column;gap:12px}
  .tool{background:var(--paper);border:1px solid var(--line);border-radius:var(--radius);padding:17px 19px;transition:.16s}
  .tool:hover{border-color:var(--canopy-line);box-shadow:var(--shadow)}
  .tool-top{display:flex;align-items:center;gap:11px}
  .verb{font-family:var(--mono);font-size:10.5px;font-weight:600;padding:3px 8px;border-radius:6px;letter-spacing:.03em}
  .verb.GET{background:#E4EFE6;color:#1B5E3F}.verb.POST{background:#E2ECF7;color:#2155A3}
  .verb.PATCH{background:#FBF1DC;color:#9C6A12}.verb.DELETE{background:#F7E4E4;color:#A33636}
  .tool-name{font-family:var(--mono);font-size:14px;font-weight:600;color:var(--ink)}
  .tool-kind{margin-left:auto;font-size:11px;color:var(--ink-faint);background:var(--oat);padding:4px 10px;border-radius:20px;border:1px solid var(--line)}
  .tool-actions{margin-left:8px;display:flex;gap:6px}
  .tool-del{border:none;background:none;color:var(--ink-faint);cursor:pointer;font-size:13px;padding:3px 7px;border-radius:6px;transition:.16s}
  .tool-del:hover{background:#FEE2E2;color:#B91C1C}
  .tool-edit{border:none;background:none;color:var(--ink-faint);cursor:pointer;padding:3px 6px;border-radius:6px;transition:.16s;display:inline-flex;align-items:center}
  .tool-edit svg{width:13px;height:13px}
  .tool-edit:hover{background:var(--canopy-soft);color:var(--canopy)}
  .tool-desc{font-size:13px;color:var(--ink-soft);margin:10px 0 13px;line-height:1.5}
  .endpoint{font-family:var(--mono);font-size:11.5px;color:var(--ink-faint);background:var(--oat);border:1px solid var(--line);border-radius:7px;padding:7px 11px;margin-bottom:11px;display:block;word-break:break-all}
  .params{display:flex;flex-wrap:wrap;gap:7px}
  .param{font-family:var(--mono);font-size:11px;background:var(--canopy-soft);color:var(--canopy-deep);border:1px solid var(--canopy-line);padding:3px 9px;border-radius:6px;display:inline-flex;align-items:center;gap:5px}
  .param .req{color:#C0392B;font-weight:700}.param.opt{background:var(--oat);color:var(--ink-soft);border-color:var(--line)}
  .no-tools{text-align:center;padding:40px;color:var(--ink-faint);font-size:13.5px}

  /* Modal */
  .scrim{position:fixed;inset:0;background:rgba(20,40,28,.42);backdrop-filter:blur(3px);display:none;align-items:flex-start;justify-content:center;padding:48px 20px;overflow:auto;z-index:50}
  .scrim.show{display:flex}
  .modal{background:var(--paper);border-radius:18px;width:100%;max-width:560px;box-shadow:0 30px 70px -20px rgba(20,40,28,.5);animation:rise .22s ease}
  @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
  .modal-head{padding:22px 26px 0;display:flex;align-items:flex-start;justify-content:space-between}
  .modal-head h3{font-family:var(--display);font-size:19px;font-weight:700}
  .modal-head p{font-size:12.5px;color:var(--ink-soft);margin-top:5px}
  .x{cursor:pointer;border:none;background:var(--oat);width:30px;height:30px;border-radius:8px;color:var(--ink-soft);font-size:16px;display:grid;place-items:center}
  .modal-body{padding:20px 26px 4px}
  .field{margin-bottom:16px}
  .field label{display:block;font-size:12px;font-weight:600;color:var(--ink);margin-bottom:7px}
  .field label .hint{font-weight:400;color:var(--ink-faint);font-size:11px;margin-left:6px}
  .field input,.field textarea,.field select{width:100%;font-family:var(--sans);font-size:13px;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:var(--oat);transition:.16s}
  .field input:focus,.field textarea:focus,.field select:focus{outline:none;border-color:var(--canopy-bright);background:#fff;box-shadow:0 0 0 3px rgba(46,139,87,.13)}
  .field input.mono{font-family:var(--mono);font-size:12.5px}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .gen-url{background:var(--canopy-soft);border:1px solid var(--canopy-line);border-radius:9px;padding:11px 13px;font-family:var(--mono);font-size:12.5px;color:var(--canopy-deep);display:flex;align-items:center;gap:8px}
  .gen-url svg{width:14px;height:14px}
  .pbuild{border:1px solid var(--line);border-radius:11px;overflow:hidden;margin-bottom:6px}
  .pbuild-head{display:grid;grid-template-columns:.95fr 1fr .6fr .7fr .5fr 24px;gap:9px;padding:9px 13px;background:var(--oat);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);font-weight:600;border-bottom:1px solid var(--line)}
  .prow{display:grid;grid-template-columns:.95fr 1fr .6fr .7fr .5fr 24px;gap:9px;padding:9px 13px;align-items:center;border-bottom:1px solid var(--line)}
  .prow:last-child{border-bottom:none}
  .prow input,.prow select{background:#fff;border:1px solid var(--line);border-radius:7px;padding:7px 9px;font-size:12px;font-family:var(--mono);width:100%}
  .prow .chk{display:grid;place-items:center}
  .prow .chk input{width:16px;height:16px;accent-color:var(--canopy)}
  .prow .rm{border:none;background:none;color:var(--ink-faint);cursor:pointer;font-size:15px}
  .add-param{margin-top:10px;color:var(--canopy);font-size:12px;font-weight:600;background:none;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
  .modal-foot{padding:18px 26px 24px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line);margin-top:8px}
  .seg{display:inline-flex;background:var(--oat);border:1px solid var(--line);border-radius:9px;padding:3px;gap:3px}
  .seg button{border:none;background:none;font-family:var(--sans);font-size:12px;font-weight:600;color:var(--ink-soft);padding:7px 13px;border-radius:7px;cursor:pointer}
  .seg button.on{background:#fff;color:var(--canopy);box-shadow:var(--shadow)}
  .note{font-size:11.5px;color:var(--warn);background:var(--amber-soft);border:1px solid #F0DCB4;border-radius:9px;padding:10px 13px;display:flex;gap:8px;margin-bottom:4px}
  .note svg{width:15px;height:15px;flex-shrink:0;margin-top:1px}
  .err-msg{font-size:12px;color:#B91C1C;background:#FEE2E2;border:1px solid #FECACA;border-radius:8px;padding:9px 12px;margin-top:10px;display:none}
  .err-msg.show{display:block}
  .toast{position:fixed;bottom:28px;right:28px;background:var(--canopy-deep);color:#fff;font-size:13px;font-weight:600;padding:12px 18px;border-radius:11px;box-shadow:var(--shadow);opacity:0;transition:.3s;z-index:100;pointer-events:none}
  .toast.show{opacity:1}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z"/><path d="M9 12l2 2 4-4"/></svg>
      </div>
      <div><h1>MCP Gateway</h1><span>ServiceNow · Local</span></div>
    </div>

    <div style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div class="nav-label">MCP Servers</div>
      <div class="server-list" id="serverList"></div>
      <button class="new-srv" onclick="openModal('srvModal')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        New MCP Server
      </button>
    </div>

    <div class="conn" onclick="openModal('connModal')">
      <div class="row">
        <div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="#5BD08C" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20"/></svg></div>
        <div id="connLabel">Instance</div>
      </div>
      <span class="inst" id="connUrl">Not connected — click to configure</span>
      <span class="stat" id="connStat"></span>
    </div>

    <a class="yt" href="https://www.youtube.com/@AIbyTusharM" target="_blank" rel="noopener noreferrer">
      <div class="yt-row">
        <div class="yt-ic"><svg viewBox="0 0 24 24"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4l6.3 3.6z"/></svg></div>
        <span class="yt-handle">@AIbyTusharM</span>
      </div>
      <span class="yt-tag">Subscribe for more such tools, learning and walkthroughs</span>
    </a>
  </aside>

  <main class="main" id="mainArea">
    <div class="empty-state" id="emptyState">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#CBE0CF" stroke-width="1.5" stroke-linecap="round"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z"/></svg>
      <h2>No server selected</h2>
      <p>Create a new MCP server in the sidebar, or select an existing one to manage its tools.</p>
      <button class="btn btn-primary" onclick="openModal('srvModal')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        New MCP Server
      </button>
    </div>
    <div id="serverDetail" style="display:none"></div>
  </main>
</div>

<!-- Connect Instance Modal -->
<div class="scrim" id="connModal">
  <div class="modal">
    <div class="modal-head">
      <div><h3>Connect Instance</h3><p>Credentials are held in memory only — never written to disk.</p></div>
      <button class="x" onclick="closeModal('connModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="field"><label>Instance URL</label><input id="ci_url" class="mono" placeholder="https://dev00000.service-now.com"></div>
      <div class="two">
        <div class="field"><label>Username</label><input id="ci_user" placeholder="admin"></div>
        <div class="field"><label>Password</label><input id="ci_pass" type="password" placeholder="••••••••"></div>
      </div>
      <div class="err-msg" id="connErr"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost btn-sm" onclick="testConn()">Test connection</button>
      <button class="btn btn-ghost" onclick="closeModal('connModal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveConn()">Save &amp; Connect</button>
    </div>
  </div>
</div>

<!-- Create Server Modal -->
<div class="scrim" id="srvModal">
  <div class="modal">
    <div class="modal-head">
      <div><h3>Create MCP Server</h3><p>The gateway boots it immediately and hands you a URL.</p></div>
      <button class="x" onclick="closeModal('srvModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="field"><label>Server name <span class="hint">lowercase, no spaces</span></label><input id="sv_name" class="mono" placeholder="incident-ops"></div>
      <div class="field"><label>Description <span class="hint">shown to the MCP client</span></label><textarea id="sv_desc" rows="2" placeholder="What this server is for..."></textarea></div>
      <div class="field"><label>Port</label><input id="sv_port" class="mono" type="number" value="7801" min="1024" max="65535"></div>
      <div class="field">
        <label>Generated URL</label>
        <div class="gen-url" id="sv_previewUrl">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>
          <span id="sv_urlText">http://localhost:7801/mcp</span>
        </div>
      </div>
      <div class="err-msg" id="srvErr"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal('srvModal')">Cancel</button>
      <button class="btn btn-primary" onclick="createServer()">Create &amp; Start</button>
    </div>
  </div>
</div>

<!-- Add Tool Modal -->
<div class="scrim" id="toolModal">
  <div class="modal" style="max-width:660px">
    <div class="modal-head">
      <div><h3 id="toolModalTitle">Add Tool</h3><p>Wrap a ServiceNow API as a tool. These fields become the schema the model sees.</p></div>
      <button class="x" onclick="closeModal('toolModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>API type</label>
        <div class="seg" id="apiTypeSeg">
          <button class="on" data-val="table" onclick="segClick(this,'apiTypeSeg')">Table API</button>
          <button data-val="scripted" onclick="segClick(this,'apiTypeSeg')">Scripted REST</button>
        </div>
      </div>
      <div class="two">
        <div class="field"><label>Tool name <span class="hint">what the model calls</span></label><input id="tl_name" class="mono" placeholder="search_incidents"></div>
        <div class="field"><label>Method</label>
          <select id="tl_method"><option>GET</option><option>POST</option><option>PATCH</option><option>DELETE</option></select></div>
      </div>
      <div class="field"><label>Description <span class="hint">tell the model when to use it</span></label>
        <textarea id="tl_desc" rows="2" placeholder="Query the security incident table and return matching records."></textarea></div>
      <div class="field"><label>Endpoint <span class="hint">use {name} for path params, e.g. /api/now/table/incident/{sys_id}</span></label><input id="tl_endpoint" class="mono" placeholder="/api/now/table/sn_si_incident"></div>
      <div class="field">
        <label style="margin-bottom:9px">Parameters <span class="hint">inputs the model is allowed to pass</span></label>
        <div class="pbuild">
          <div class="pbuild-head"><div>Name</div><div>Description</div><div>Type</div><div>Send as</div><div>Required</div><div></div></div>
          <div id="paramRows"></div>
        </div>
        <button class="add-param" onclick="addParamRow()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          Add parameter
        </button>
      </div>
      <div class="note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>
        Credentials come from the connected instance — never put auth tokens in a tool definition.
      </div>
      <div class="err-msg" id="toolErr"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost btn-sm" onclick="testTool()">Test against instance</button>
      <button class="btn btn-ghost" onclick="closeModal('toolModal')">Cancel</button>
      <button class="btn btn-primary" id="toolModalSubmit" onclick="saveTool()">Save Tool</button>
    </div>
  </div>
</div>

<!-- Config Snippet Modal -->
<div class="scrim" id="snippetModal">
  <div class="modal">
    <div class="modal-head">
      <div><h3>Config Snippet</h3><p>Paste this into your Claude Desktop or Claude Code config.</p></div>
      <button class="x" onclick="closeModal('snippetModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>Claude Desktop — <code>claude_desktop_config.json</code></label>
        <textarea id="snippetText" rows="10" style="font-family:var(--mono);font-size:12px" readonly></textarea>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeModal('snippetModal')">Close</button>
      <button class="btn btn-primary" onclick="copySnippet()">Copy</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const API = '/api';
let servers = [];
let activeId = null;
let activeServer = null;

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function boot() {
  await loadInstance();
  await loadServers();
}

async function loadInstance() {
  const d = await api('GET', '/instance');
  if (d.url) {
    document.getElementById('connLabel').textContent = 'Instance connected';
    document.getElementById('connUrl').textContent = d.url.replace('https://','');
    document.getElementById('connStat').className = 'stat ok';
    document.getElementById('connStat').textContent = `Basic auth · ${d.username}`;
    document.getElementById('ci_url').value = d.url;
    document.getElementById('ci_user').value = d.username;
  }
}

async function loadServers() {
  servers = await api('GET', '/servers') || [];
  renderSidebar();
  if (activeId) {
    const s = servers.find(x => x.id === activeId);
    if (s) selectServer(s);
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  const el = document.getElementById('serverList');
  if (!servers.length) { el.innerHTML = '<div style="text-align:center;padding:16px;color:#6E9B7C;font-size:12px">No servers yet</div>'; return; }
  el.innerHTML = servers.map(s => `
    <div class="srv${s.id===activeId?' active':''}" onclick="selectServer(${JSON.stringify(s).replace(/"/g,'&quot;')})">
      <span class="dot${s.running?'':' off'}"></span>
      ${esc(s.name)}
      <span class="meta">:${s.port}</span>
    </div>`).join('');
}

async function selectServer(s) {
  activeId = s.id;
  activeServer = s;
  renderSidebar();
  await renderDetail(s);
}

async function renderDetail(s) {
  document.getElementById('emptyState').style.display = 'none';
  const detail = document.getElementById('serverDetail');
  detail.style.display = 'block';
  const tools = await api('GET', `/servers/${s.id}/tools`) || [];

  detail.innerHTML = `
    <div class="topbar">
      <div>
        <div class="crumb">servers / <b>${esc(s.name)}</b></div>
        <div class="title-row">
          <h2>${esc(s.name)}</h2>
          <span class="pill ${s.running?'run':'stopped'}">${s.running?'running':'stopped'}</span>
        </div>
        <p class="sub">${esc(s.description || 'No description.')}</p>
      </div>
      <div style="display:flex;gap:10px;flex-shrink:0">
        ${s.running
          ? `<button class="btn btn-ghost" onclick="stopServer('${s.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop</button>`
          : `<button class="btn btn-ghost" onclick="startServer('${s.id}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>Start</button>`}
        <button class="btn btn-danger btn-sm" onclick="deleteServer('${s.id}')">Delete</button>
        <button class="btn btn-primary" onclick="openAddTool()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          Add Tool
        </button>
      </div>
    </div>

    <div class="url-card">
      <div class="label">MCP Endpoint URL</div>
      <div class="url-line">
        <div class="url">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>
          ${esc(s.endpointUrl)}
        </div>
        <button class="copy-btn" onclick="copyText('${esc(s.endpointUrl)}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>Copy
        </button>
        <button class="copy-btn" onclick="showSnippet('${s.id}')">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>Config snippet
        </button>
      </div>
      <div class="stat-grid">
        <div><span>Transport</span><b>Streamable HTTP</b></div>
        <div><span>Tools</span><b>${tools.length}</b></div>
      </div>
    </div>

    <div class="section-head">
      <h3>Tools <span class="count">${tools.length} attached</span></h3>
    </div>
    <div class="tools" id="toolList">
      ${tools.length ? tools.map(t => renderTool(t, s.id)).join('') : '<div class="no-tools">No tools yet — add one to get started.</div>'}
    </div>`;
}

function renderTool(t, serverId) {
  const reqParams = t.parameters.filter(p => p.required);
  const optParams = t.parameters.filter(p => !p.required);
  return `<div class="tool">
    <div class="tool-top">
      <span class="verb ${t.method}">${esc(t.method)}</span>
      <span class="tool-name">${esc(t.name)}</span>
      <span class="tool-kind">${t.apiType === 'table' ? 'Table API' : 'Scripted REST'}</span>
      <div class="tool-actions">
        <button class="tool-edit" onclick="openEditTool('${serverId}','${t.id}')" title="Edit tool">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4z"/></svg>
        </button>
        <button class="tool-del" onclick="deleteTool('${serverId}','${t.id}')" title="Delete tool">&times;</button>
      </div>
    </div>
    <p class="tool-desc">${esc(t.description || '')}</p>
    <code class="endpoint">${esc(t.endpoint)}</code>
    <div class="params">
      ${reqParams.map(p => `<span class="param">${esc(p.name)}<span class="req">*</span></span>`).join('')}
      ${optParams.map(p => `<span class="param opt">${esc(p.name)}</span>`).join('')}
    </div>
  </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function startServer(id) {
  await api('POST', `/servers/${id}/start`);
  await loadServers();
  if (activeServer?.id === id) renderDetail({...activeServer, running:true, endpointUrl:`http://localhost:${activeServer.port}/mcp`});
}

async function stopServer(id) {
  await api('POST', `/servers/${id}/stop`);
  await loadServers();
  if (activeServer?.id === id) renderDetail({...activeServer, running:false});
}

async function deleteServer(id) {
  if (!confirm('Delete this server and all its tools?')) return;
  await api('DELETE', `/servers/${id}`);
  activeId = null; activeServer = null;
  document.getElementById('serverDetail').style.display = 'none';
  document.getElementById('emptyState').style.display = 'flex';
  await loadServers();
}

async function deleteTool(serverId, toolId) {
  if (!confirm('Delete this tool?')) return;
  await api('DELETE', `/servers/${serverId}/tools/${toolId}`);
  const s = servers.find(x => x.id === serverId);
  if (s) renderDetail(s);
}

// ── Connect ───────────────────────────────────────────────────────────────────
async function testConn() {
  const body = {url:v('ci_url'),username:v('ci_user'),password:v('ci_pass')};
  if (!body.url || !body.username || !body.password) { showErr('connErr','Fill all fields'); return; }
  const r = await api('POST', '/instance/test', body);
  if (r.ok) { showErr('connErr',''); toast('Connection successful'); }
  else showErr('connErr', r.error || 'Connection failed');
}

async function saveConn() {
  const body = {url:v('ci_url'),username:v('ci_user'),password:v('ci_pass')};
  if (!body.url || !body.username || !body.password) { showErr('connErr','Fill all fields'); return; }
  const r = await api('PUT', '/instance', body);
  if (r.ok) { closeModal('connModal'); await loadInstance(); toast('Instance connected'); }
  else showErr('connErr', r.error || 'Failed');
}

// ── Create Server ─────────────────────────────────────────────────────────────
async function createServer() {
  const body = {name:v('sv_name'),description:v('sv_desc'),port:Number(v('sv_port'))};
  if (!body.name || !body.port) { showErr('srvErr','Name and port are required'); return; }
  const s = await api('POST', '/servers', body);
  if (s.error) { showErr('srvErr', s.error); return; }
  closeModal('srvModal');
  clearId('sv_name'); clearId('sv_desc');
  await loadServers();
  selectServer(s);
  toast(`Server "${s.name}" started`);
}

// ── Add / Edit Tool ───────────────────────────────────────────────────────────
let editingToolId = null;

function openAddTool() {
  editingToolId = null;
  document.getElementById('toolModalTitle').textContent = 'Add Tool';
  document.getElementById('toolModalSubmit').textContent = 'Save Tool';
  document.getElementById('paramRows').innerHTML = '';
  document.getElementById('tl_name').value='';
  document.getElementById('tl_desc').value='';
  document.getElementById('tl_endpoint').value='';
  document.getElementById('tl_method').value='GET';
  document.querySelector('#apiTypeSeg button').click();
  showErr('toolErr','');
  openModal('toolModal');
}

function openEditTool(serverId, toolId) {
  const s = servers.find(x => x.id === serverId);
  const t = s?.tools.find(x => x.id === toolId);
  if (!t) return;
  editingToolId = toolId;
  document.getElementById('toolModalTitle').textContent = 'Edit Tool';
  document.getElementById('toolModalSubmit').textContent = 'Save Changes';
  document.getElementById('tl_name').value = t.name || '';
  document.getElementById('tl_desc').value = t.description || '';
  document.getElementById('tl_endpoint').value = t.endpoint || '';
  document.getElementById('tl_method').value = t.method || 'GET';
  // API type segmented control
  document.querySelectorAll('#apiTypeSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.val === (t.apiType || 'table'));
  });
  // Params
  document.getElementById('paramRows').innerHTML = '';
  (t.parameters || []).forEach(p => addParamRow(p.name, p.description, p.type, p.in || 'auto', !!p.required));
  showErr('toolErr','');
  openModal('toolModal');
}

async function saveTool() {
  if (!activeId) return;
  const params = collectParams();
  const body = {
    name: v('tl_name'), description: v('tl_desc'),
    method: v('tl_method'), endpoint: v('tl_endpoint'),
    apiType: document.querySelector('#apiTypeSeg button.on')?.dataset.val || 'table',
    parameters: params
  };
  if (!body.name || !body.endpoint) { showErr('toolErr','Name and endpoint are required'); return; }
  const isEdit = !!editingToolId;
  const t = isEdit
    ? await api('PUT', `/servers/${activeId}/tools/${editingToolId}`, body)
    : await api('POST', `/servers/${activeId}/tools`, body);
  if (t.error) { showErr('toolErr', t.error); return; }
  closeModal('toolModal');
  await loadServers();
  const s = servers.find(x => x.id === activeId);
  if (s) renderDetail(s);
  toast(isEdit ? `Tool "${t.name}" updated` : `Tool "${t.name}" added`);
}

async function testTool() {
  if (!activeId) { showErr('toolErr','Select a server first'); return; }
  const params = collectParams();
  const body = {};
  params.filter(p=>p.required).forEach(p => body[p.name] = p.type === 'number' ? 0 : p.type === 'boolean' ? false : '');
  const r = await api('POST', `/servers/test-adhoc`, { // will 404 gracefully — placeholder
    name: v('tl_name'), endpoint: v('tl_endpoint'),
    method: v('tl_method'), apiType: document.querySelector('#apiTypeSeg button.on')?.dataset.val || 'table',
    description: v('tl_desc'), parameters: params
  });
  if (r) toast('See console for raw response');
}

function addParamRow(name='', desc='', type='string', loc='auto', req=false) {
  const row = document.createElement('div');
  row.className = 'prow';
  const opt = (val, label) => `<option value="${val}"${loc===val?' selected':''}>${label}</option>`;
  row.innerHTML = `
    <input value="${esc(name)}" placeholder="param_name">
    <input value="${esc(desc)}" placeholder="Description">
    <select><option${type==='string'?' selected':''}>string</option><option${type==='number'?' selected':''}>number</option><option${type==='boolean'?' selected':''}>boolean</option></select>
    <select>${opt('auto','Auto')}${opt('body','Body')}${opt('query','Query')}${opt('path','Path')}</select>
    <div class="chk"><input type="checkbox"${req?' checked':''}></div>
    <button class="rm" onclick="this.closest('.prow').remove()">&times;</button>`;
  document.getElementById('paramRows').appendChild(row);
}

function collectParams() {
  return [...document.querySelectorAll('#paramRows .prow')].map(row => {
    const inputs = row.querySelectorAll('input,select');
    const p = { name: inputs[0].value, description: inputs[1].value, type: inputs[2].value, required: inputs[4].checked };
    const loc = inputs[3].value;
    if (loc !== 'auto') p.in = loc;
    return p;
  });
}

// ── Config Snippet ────────────────────────────────────────────────────────────
async function showSnippet(serverId) {
  const r = await api('GET', `/servers/${serverId}/config-snippet`);
  document.getElementById('snippetText').value = r.json || '';
  openModal('snippetModal');
}

function copySnippet() {
  navigator.clipboard.writeText(document.getElementById('snippetText').value);
  toast('Copied to clipboard');
}

// ── Port preview ──────────────────────────────────────────────────────────────
document.getElementById('sv_port').addEventListener('input', function() {
  document.getElementById('sv_urlText').textContent = `http://localhost:${this.value}/mcp`;
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  try {
    const r = await fetch(API + path, {
      method, headers:{'Content-Type':'application/json'},
      body: body ? JSON.stringify(body) : undefined
    });
    return await r.json();
  } catch(e) { console.error(e); return {}; }
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function v(id) { return document.getElementById(id).value.trim(); }
function clearId(id) { document.getElementById(id).value = ''; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showErr(id, msg) { const el=document.getElementById(id); el.textContent=msg; el.className='err-msg'+(msg?' show':''); }
function segClick(btn, segId) {
  document.querySelectorAll(`#${segId} button`).forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}
function copyText(text) { navigator.clipboard.writeText(text); toast('Copied'); }
function toast(msg) {
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'),2200);
}

document.querySelectorAll('.scrim').forEach(s=>s.addEventListener('click',e=>{if(e.target===s)s.classList.remove('show')}));

boot();
</script>
</body>
</html>
