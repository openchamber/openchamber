(()=>{var S="openchamber.sdk",E=1;var qe=`
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [data-oc-scrolling] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [data-oc-scrolling] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [data-oc-scrolling]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [data-oc-scrolling] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;function We(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(p)=>{let d=p.target===e?r:p.target;if(!(d instanceof Element))return;if(!d.hasAttribute("data-oc-scrolling"))d.setAttribute("data-oc-scrolling","");let g=s.get(d);if(g!==void 0)clearTimeout(g);s.set(d,setTimeout(()=>{s.delete(d),d.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Mo=`(${We.toString()})(document);`;var $e=128,Ke=65536;var fe=128;var ye=65536;var Wt=/^[a-z][a-z0-9-]{0,39}$/;var Vt=(e)=>Object(e)===e&&!Array.isArray(e),je=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Xt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,qt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,$t=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Vt(s)||!Wt.test(s.id)||!Xt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!je(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!je(s,["kind","id","label","value","options","disabled"]))return!1;if(!qt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let p=new Set;for(let d of s.options){if(!Vt(d)||!je(d,["value","label"])||!qt(d.value)||!Xt(d.label)||p.has(d.value))return!1;p.add(d.value)}if(!p.has(s.value))return!1}return!0};var Kt=["{id}","{segment}","{segments+}"];var ur=new Set(Kt);var jt=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var pr=new Set(jt);var Re=20000000,he=256;var ze=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,zt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var Jt=/^[A-Za-z0-9_-]{1,80}$/;var Qt=["left","right","top","bottom"];var Yt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let p=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let d of p)if(!Yt(d,r+1,s))return!1;return!0},Je=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Je);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Je)}return String(e)===e||Number.isFinite(e)},Qe=(e)=>{try{if(String(e.id)!==e.id||!Jt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Qt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Yt(e.data)||!Je(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var Ze=2000;var eo=["file","directory","other","missing"],et=(e)=>Boolean(e&&"sessionId"in e),tt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var to=/^[0-9a-f]{7,64}$/i,ot=(e)=>to.test(e),be=500,ve=32000,oo=16000,ro=128,so=200,no=2000,io=16000,ao=80,lo=200,uo=16000;var co=2000;var rt=20000,xe=1024,Oe=2000000;var Ae=64000,Ce=8000,st=4000;var nt=960000;var po=999,So=1e4,ue=500,Eo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],go=["stopped","starting","ready","failed"],Uo=new Set(Eo),_o=(e)=>Uo.has(e),To=(e)=>e&&_o(e)?e:"HOST_REJECTED",Y=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(Y);if(Object(e)===e)return Object.values(e).every(Y);return!1},mo=(e)=>Y(e)&&JSON.stringify(e).length<=uo,Zt=(e)=>e?.trim().slice(0,lo)??"",Z=(e)=>{let r=e.id.trim().slice(0,ro),s=e.title.trim().slice(0,so),p=e.url.trim().slice(0,no),d=e.text?.trim().slice(0,io),g=e.author?.trim().slice(0,ao),A=e.kind==="pull"?"pull":"issue",y={providerId:e.providerId.trim(),id:r,title:s||r,url:p,kind:A};if(d)y.text=d;if(g)y.author=g;if(A==="pull"){let C=Zt(e.branches?.head),M=Zt(e.branches?.base);if(C&&M)y.branches={head:C,base:M}}if(mo(e.data))y.data=e.data;return y},it=(e)=>{let r=Z(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},at=(e)=>{let r={text:e.text.trim().slice(0,oo)};if(e.send)r.send=!0;return r},lt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(po,Math.max(0,Math.round(e)))},ut=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(So,Math.max(0,Math.ceil(e)))};var ee=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var ke=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>co)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},No=new Set(go),ct=(e)=>Boolean(e&&"status"in e&&No.has(String(e.status))&&!("body"in e)),Ie=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),pt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),dt=(e)=>Boolean(e&&"written"in e&&e.written===!0),St=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Lo=new Set(eo),Et=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Lo.has(String(e.kind))&&Number.isFinite(e.size)),gt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Do=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Ho=(e)=>Object(e)===e?e:null,Ye=(e)=>String(e)===e&&e.length>0,Bo=(e)=>{if(!Ye(e.id))return null;if(e.ok===!0){let r={channel:S,v:E,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ye(e.error))return{channel:S,v:E,type:"result",id:e.id,ok:!1,error:e.error,code:To(Ye(e.code)?e.code:void 0)};return null},_t=(e)=>{let r=Ho(e);if(!r||r.channel!==S||r.v!==E)return null;if(r.type==="result")return Bo(r);if(!Do.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var fo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Fo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class l extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var yo=()=>Promise.reject(new l("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Pe=()=>Promise.reject(new l("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Ge=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new l("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},c=(e)=>(e.value+=1,`oc-${e.value}`),Tt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new l("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),p=e.requestTimeoutMs??rt,d=new Set,g=new Set,A=new Set,y=new Set,C=new Set,M=new Set,V=new Set,ce=new Set,pe=new Set,de=new Set,Se=new Set,j=new Set,He=[],re=null,se=null,Ee=new Set,ge=new Set,ne=null,ie=null,Be=!1,z=new Map,J=new Map,Q=new Map,D=!1,u={value:0},a=null,H=null,ae=!1,le=!1,It=null,Pt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},Gt=()=>{if(D||r.parent===r||j.size===0||a?.features?.lateGenerateResults!==!0)return;w({channel:S,v:E,type:"generate-late-listen"})},f=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Mt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=_t(t.data);if(!o)return;if(o.type==="workspace"){let i=J.get(o.payload.subscriptionId);if(i)f([i],o.payload.snapshot);return}if(o.type==="shells"){let i=Q.get(o.payload.subscriptionId);if(i)f([i],o.payload.snapshot);return}if(o.type==="ready"){if(a=o.payload,H=Pt(o.payload.session),f(d,o.payload),f(g,o.payload.directory),f(A,o.payload.session),H)f(y,H);if(f(C,o.payload.connection),f(M,o.payload.settings),f(V,o.payload.item),o.payload.block)f(ce,o.payload.block);Gt();return}if(o.type==="service-event"){f(pe,o.payload);return}if(o.type==="generate-late"){if(j.size===0)He.push(o.payload);else f(j,o.payload);return}if(o.type==="directory"){if(a)a={...a,directory:o.payload.directory};f(g,o.payload.directory);return}if(o.type==="session"){if(a)a={...a,session:o.payload.session};if(!o.payload.session)H=null;else if(H?.sessionId!==o.payload.session.id)H=Pt(o.payload.session);f(A,o.payload.session);return}if(o.type==="session-lifecycle"){H=o.payload,f(y,o.payload);return}if(o.type==="connection"){if(a)a={...a,connection:o.payload.connection};f(C,o.payload.connection);return}if(o.type==="settings"){if(a)a={...a,settings:o.payload.settings};f(M,o.payload.settings);return}if(o.type==="item"){if(a)a={...a,item:o.payload.item};f(V,o.payload.item);return}if(o.type==="status-control-event"){f(de,o.payload);return}if(o.type==="popover-closed"){f(Se,o.payload);return}if(o.type==="action"){let i=(_)=>{if(!D)w({channel:S,v:E,type:"action-result",id:o.id,payload:_})},T=se;if(!T){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>T(o.payload)).then(()=>i({ok:!0}),(_)=>{let O=(_ instanceof Error?_.message:String(_)).trim();i({ok:!1,error:(O||"Action failed.").slice(0,ue)})});return}if(o.type==="file-open"){let i=o.payload;if(ie&&zt(ie,i))return;ie=i,f(Ee,o.payload);return}if(o.type==="file-saved"){f(ge,o.payload.version);return}if(o.type==="file-snapshot"){let i=(O)=>{if(!D)w({channel:S,v:E,type:"file-snapshot-result",id:o.id,payload:O})},T=(O)=>i({error:(O.trim()||"Could not read the edited file.").slice(0,ue)}),_=ne;if(!_){T("This extension does not edit files.");return}Promise.resolve().then(()=>_(o.payload.purpose)).then((O)=>{if(ze(O)>Re){T(`The file is over ${Re} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>he){T(`The snapshot version is over ${he} characters.`);return}i({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>T(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let i=(_)=>{w({channel:S,v:E,type:"resolve-result",id:o.id,payload:_})},T=re;if(!T){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>T(o.payload)).then((_)=>i({item:_?Z(_):null}),(_)=>{let O=(_ instanceof Error?_.message:String(_)).trim();i({error:(O||"Command failed.").slice(0,ue)})});return}let n=z.get(o.id);if(!n)return;if(clearTimeout(n.timer),z.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new l(o.code,o.error))};r.addEventListener("message",Mt),w({channel:S,v:E,type:"hello"});let P=(t,o=p)=>{if(D||r.parent===r)return Promise.reject(new l("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let T=setTimeout(()=>{z.delete(t.id),i(new l("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:n,reject:i,timer:T}),w(t)})},b=(t)=>P(t).then(()=>{return}),x={channel:S,v:E},Fe=(t)=>{if(!D&&r.parent!==r)w(t)},wt=()=>Fe({...x,type:"file-save"}),Ut=(t)=>{if(!fo(t)||!Fo(t))return;t.preventDefault(),wt()},Nt=(t)=>{if(!fo(t)||t.key!=="Escape"||a?.surface!=="popover"||!a.popover)return;t.preventDefault(),Bt(a.popover.id,"escape").catch(()=>{return})},_e=()=>{let t=a?.surface==="popover"?a.popover:void 0;if(!t)return;let o=ae||le;if(It===o)return;It=o,Ft(t.id,o).catch(()=>{return})},Te=()=>{if(a?.surface!=="popover"||ae)return;ae=!0,_e()},Lt=(t)=>{if(a?.surface!=="popover"||t.relatedTarget!==null||!ae)return;ae=!1,_e()},Dt=()=>{if(a?.surface!=="popover"||le)return;le=!0,_e()},Ht=()=>{if(a?.surface!=="popover"||!le)return;le=!1,_e()},L=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new l("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Ve=async(t)=>{if(t.kind!=="projects")L(t.projectId);let o=await P({...x,type:"workspace-read",id:c(u),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new l("HOST_REJECTED","Host did not return workspace data.");return o},Xe=async(t,o)=>{if(t.kind!=="projects")L(t.projectId);let n=c(u);J.set(n,o);try{await b({...x,type:"workspace-subscribe",id:c(u),payload:{subscriptionId:n,query:t}})}catch(i){if(J.delete(n),!D)w({...x,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:n}});throw i}return()=>{if(!J.delete(n)||D)return;w({...x,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:n}})}},Go=async(t,o)=>{if(t.kind==="session")L(t.sessionId);if(t.kind==="project")L(t.projectId);let n=c(u);Q.set(n,o);try{await b({...x,type:"shells-subscribe",id:c(u),payload:{subscriptionId:n,scope:t}})}catch(i){if(Q.delete(n),!D)w({...x,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:n}});throw i}return()=>{if(!Q.delete(n)||D)return;w({...x,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:n}})}},me=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>$e))throw new l("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!Y(t.value))throw new l("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Ke)throw new l("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&a?.features?.deviceStorage!==!0)throw new l("UNSUPPORTED","This host does not support device storage.");let o=await P({...x,type:"storage",id:c(u),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new l("HOST_REJECTED","Host did not return storage data.");return o},Bt=(t,o)=>a?.features?.popovers!==!0&&!(a?.surface==="popover"&&a.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):b({...x,type:"popover-close",id:c(u),payload:o?{id:t,reason:o}:{id:t}}),Ft=(t,o)=>a?.features?.popovers!==!0&&!(a?.surface==="popover"&&a.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):b({...x,type:"popover-anchor",id:c(u),payload:{id:t,active:o}});return r.addEventListener("keydown",Nt,!0),r.addEventListener("pointerover",Te),r.addEventListener("pointermove",Te),r.addEventListener("pointerout",Lt),r.addEventListener("focus",Dt),r.addEventListener("blur",Ht),{onAction:(t)=>(se=t,()=>{if(se===t)se=null}),listProjects:async()=>{let t=await Ve({kind:"projects"});if(t.kind!=="projects")throw new l("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Ve({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new l("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Ve({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new l("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Xe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Xe({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Xe({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Go(t,o),readShellOutput:async(t,o)=>{L(t,fe);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new l("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>ye))throw new l("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${ye}.`);let _=await P({...x,type:"shell-output",id:c(u),payload:{shellId:t,cursor:n,tailBytes:i}});if(!_||typeof _.output!=="string"||!Number.isFinite(_.cursor))throw new l("HOST_REJECTED","Host did not return shell output.");return _},stopShell:async(t)=>{if(L(t,fe),(await P({...x,type:"shell-stop",id:c(u),payload:{shellId:t}}))?.stopped!==!0)throw new l("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{L(t),await b({...x,type:"open-session",id:c(u),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Ge(o),i={op:"get",key:t};if(n)i.scope=n;let T=await me(i);return T.op==="get"&&T.found?T.value:void 0},set:async(t,o,n)=>{let i=Ge(n),T={op:"set",key:t,value:o};if(i)T.scope=i;await me(T)},delete:async(t,o)=>{let n=Ge(o),i={op:"delete",key:t};if(n)i.scope=n;await me(i)},keys:async(t)=>{let o=Ge(t),n={op:"keys"};if(o)n.scope=o;let i=await me(n);if(i.op!=="keys")throw new l("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(d.add(t),a)t(a);return()=>{d.delete(t)}},onDirectory:(t)=>{if(g.add(t),a)t(a.directory);return()=>{g.delete(t)}},onSession:(t)=>{if(A.add(t),a)t(a.session);return()=>{A.delete(t)}},onSessionLifecycle:(t)=>{if(y.add(t),H)t(H);return()=>{y.delete(t)}},onConnection:(t)=>{if(C.add(t),a)t(a.connection);return()=>{C.delete(t)}},onSettings:(t)=>{if(M.add(t),a)t(a.settings);return()=>{M.delete(t)}},onItem:(t)=>{if(V.add(t),a)t(a.item);return()=>{V.delete(t)}},onBlock:(t)=>{if(ce.add(t),a?.block)t(a.block);return()=>{ce.delete(t)}},onServiceEvent:(t)=>(pe.add(t),()=>{pe.delete(t)}),onStatusControl:(t)=>(de.add(t),()=>{de.delete(t)}),onPopoverClosed:(t)=>(Se.add(t),()=>{Se.delete(t)}),setStatusControls:(t)=>{if(a?.features?.statusControls!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support status controls."));if(!$t(t))return Promise.reject(new l("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return b({...x,type:"status-controls",id:c(u),payload:{controls:t}})},openPopover:(t)=>{if(a?.features?.popovers!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support popovers."));if(!Qe(t))return Promise.reject(new l("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return b({...x,type:"popover-open",id:c(u),payload:t})},closePopover:Bt,setPopoverAnchorActive:Ft,onResolve:(t)=>(re=t,()=>{if(re===t)re=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>be)return Promise.reject(new l("HOST_REJECTED",`Toast message must contain 1 to ${be} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>ve))return Promise.reject(new l("HOST_REJECTED",`Toast copy text must contain 1 to ${ve} characters.`));return b({channel:S,v:E,type:"toast",id:c(u),payload:{...t,message:o}})},openUrl:(t)=>b({channel:S,v:E,type:"open-url",id:c(u),payload:{url:t}}),openCommit:(t)=>ot(t)?b({channel:S,v:E,type:"open-commit",id:c(u),payload:{sha:t}}):Promise.reject(new l("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>b({channel:S,v:E,type:"block-answer",id:c(u),payload:{text:t.trim().slice(0,Ze)}}),openSurface:(t)=>b({channel:S,v:E,type:"open-surface",id:c(u),payload:{surfaceId:t}}),writeClipboard:(t)=>b({channel:S,v:E,type:"clipboard-write",id:c(u),payload:{text:t}}),compose:(t)=>b({channel:S,v:E,type:"compose",id:c(u),payload:t}),attach:(t)=>b({channel:S,v:E,type:"attach",id:c(u),payload:Z(t)}),startSession:async(t)=>{if(t.projectId!==void 0)L(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")L(o.directory);else{if(o.name!==void 0)L(o.name,200);if(o.baseBranch!==void 0)L(o.baseBranch,200)}let n=await P({channel:S,v:E,type:"start-session",id:c(u),payload:it(t)},e.requestTimeoutMs??180000);if(!et(n))throw new l("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>P({channel:S,v:E,type:"prompt",id:c(u),payload:at(t)}).then((o)=>{if(!tt(o))throw new l("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>b({channel:S,v:E,type:"session-link",id:c(u),payload:Z(t)}),close:()=>b({channel:S,v:E,type:"close",id:c(u)}),oauthStart:()=>b({channel:S,v:E,type:"oauth-start",id:c(u)}),oauthDisconnect:()=>b({channel:S,v:E,type:"oauth-disconnect",id:c(u)}),request:(t)=>(ke(t.path)?P({channel:S,v:E,type:"request",id:c(u),payload:t}):yo()).then((o)=>{if(!Ie(o))throw new l("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(ke(t.path)?P({channel:S,v:E,type:"service-request",id:c(u),payload:t}):yo()).then((o)=>{if(!Ie(o))throw new l("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:S,v:E,type:"service-status",id:c(u)}).then((t)=>{if(!ct(t))throw new l("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(ee(t)?P({channel:S,v:E,type:"file-read",id:c(u),payload:{path:t}}):Pe()).then((o)=>{if(!pt(o))throw new l("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!ee(t))return Pe();if(o.length>Oe)return Promise.reject(new l("FILE_TOO_LARGE",`Content is over ${Oe} characters.`));return P({channel:S,v:E,type:"file-write",id:c(u),payload:{path:t,content:o}}).then((n)=>{if(!dt(n))throw new l("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(ee(t)?P({channel:S,v:E,type:"file-list",id:c(u),payload:{path:t}}):Pe()).then((o)=>{if(!St(o))throw new l("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(ee(t)?P({channel:S,v:E,type:"file-stat",id:c(u),payload:{path:t}}):Pe()).then((o)=>{if(!Et(o))throw new l("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>Ae)return Promise.reject(new l("HOST_REJECTED",`Prompt must be 1 to ${Ae} characters.`));if(n!==void 0&&(n.length===0||n.length>Ce))return Promise.reject(new l("HOST_REJECTED",`System prompt must be 1 to ${Ce} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(st,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new l("HOST_REJECTED","maxOutputTokens must be a number."));let T={prompt:o};if(n!==void 0)T.system=n;if(i!==void 0)T.maxOutputTokens=i;return P({channel:S,v:E,type:"generate",id:c(u),payload:T},e.requestTimeoutMs??nt).then((_)=>{if(!gt(_))throw new l("HOST_REJECTED","Host did not return generated text.");return _})},onLateGenerateResult:(t)=>{j.add(t);for(let o of He.splice(0))f([t],o);return Gt(),()=>{j.delete(t)}},setBadge:(t)=>b({channel:S,v:E,type:"badge",id:c(u),payload:{count:lt(t)}}),setHeight:(t)=>b({channel:S,v:E,type:"resize",id:c(u),payload:{height:ut(t)}}),onFileOpen:(t)=>{if(Ee.add(t),!Be)Be=!0,r.addEventListener("keydown",Ut,!0);if(ie)t(ie);return()=>{Ee.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(ge.add(t),()=>{ge.delete(t)}),reportFileChange:(t)=>Fe({...x,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:wt,reportFileUnsupported:()=>Fe({...x,type:"file-unsupported"}),dispose:()=>{for(let t of J.keys())w({...x,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:t}});J.clear();for(let t of Q.keys())w({...x,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:t}});if(Q.clear(),D=!0,re=null,se=null,ne=null,Ee.clear(),ge.clear(),Be)r.removeEventListener("keydown",Ut,!0);r.removeEventListener("message",Mt),r.removeEventListener("keydown",Nt,!0),r.removeEventListener("pointerover",Te),r.removeEventListener("pointermove",Te),r.removeEventListener("pointerout",Lt),r.removeEventListener("focus",Dt),r.removeEventListener("blur",Ht);for(let t of z.values())clearTimeout(t.timer),t.reject(new l("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),d.clear(),g.clear(),A.clear(),y.clear(),C.clear(),M.clear(),V.clear(),ce.clear(),pe.clear(),de.clear(),Se.clear(),j.clear(),He.length=0}}};var Ro=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Or=new Set(Ro);var ho=["none","agent","user"];var Cr=new Set(ho);var Vo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Xo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],bo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,p]of Vo)r.style.setProperty(s,e.tokens[p]);for(let[s,p,d]of Xo){let g=e.tokens[d]??"";r.style.setProperty(s,g),r.style.setProperty(p,g)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},mt=(e,r)=>{if(bo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var qo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},m=(e,r)=>`var(--${e}, var(--oc-${qo[e]}, ${r}))`,F=m("surface-background","transparent"),we=m("surface-elevated","transparent"),te=m("surface-elevated-foreground","inherit"),U=m("surface-foreground","inherit"),R=m("surface-muted-foreground","gray"),Wo=m("surface-muted","transparent"),q=m("interactive-border","currentColor"),G=m("interactive-hover","transparent"),W=m("interactive-active","transparent"),ft=m("interactive-selection","transparent"),yt=m("interactive-selection-foreground","inherit"),B=m("primary","currentColor"),Rt=m("primary-text","inherit"),ht=m("error-text","inherit"),$o=m("font-sans","inherit"),bt=m("font-mono","monospace"),Ao=m("radius","9px"),vt=`calc(${Ao} - 2px)`,vo=`calc(${Ao} - 4px)`,h=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,xo=`background-image: linear-gradient(${G}, ${G});`,xt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Ot="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Oo="box-shadow: var(--oc-sdk-lit);",At=`inset 0 0.5px 0 0 ${h(U,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,Ko=`
:root {
  --oc-sdk-edge: ${h(U,16)};
  --oc-sdk-field-bg: ${we};
  --oc-sdk-raised-bg: ${F};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${h(U,14)};
  --oc-sdk-field-bg: ${h(F,50,we)};
  --oc-sdk-raised-bg: ${we};
  --oc-sdk-field-lift: ${At};
  --oc-sdk-raised-lift: ${At};
  --oc-sdk-lit: ${At};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Me=(e)=>{let r=m(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${m(`${e}-text`,"inherit")}; }`},jo=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: 6px; height: 28px; padding: 0 10px; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: 4px; height: 24px; padding: 0 8px; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: 14px; height: 14px; }

.oc-sdk-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: 8px 10px; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: 34px; padding-right: 34px; }
.oc-sdk-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 24px; height: 24px; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 2px; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(320px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: 2px 2px 4px; }
.oc-sdk-popup-search .oc-sdk-input { height: 28px; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: 14px; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: 8px; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: 36px; height: 20px; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: 2px; padding: 2px; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: 1px 6px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: 16px 8px; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: 12px; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: 16px; height: 16px; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: 12px; height: 12px; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: 8px; width: 100%; margin: 8px 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: 4px 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: 6px; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }
.oc-sdk-progress-value { display: inline-flex; align-items: center; gap: 2px; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { font-weight: 600; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,Co=`${Ko}
.oc-sdk { color: ${U}; font-family: ${$o}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${xo} }
.oc-sdk-mono { font-family: ${bt}; }
.oc-sdk-muted { color: ${R}; }
${Me("success")}${Me("warning")}${Me("error")}${Me("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${B}; --oc-sdk-tone-text: ${Rt}; }

.oc-sdk-btn { border-radius: ${vt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${vo}; }
.oc-sdk-btn[data-variant="default"] { color: ${Rt}; background: ${h(B,10,F)}; border-color: ${h(B,12)}; ${Oo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${h(B,16,F)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${h(B,22,F)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Wo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${te}; ${Ot} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${W}, ${W}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${G}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${W}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${m("status-error","red")}; color: ${ht}; background: ${h("var(--oc-sdk-tone)",7,F)}; border-color: ${h("var(--oc-sdk-tone)",12)}; ${Oo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${h("var(--oc-sdk-tone)",9,F)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${h("var(--oc-sdk-tone)",11,F)}; box-shadow: none; }

.oc-sdk-field-note { color: ${R}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${ht}; }
.oc-sdk-input { border-radius: ${vt}; background: var(--oc-sdk-field-bg); color: ${te}; ${xt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${R}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${xt(h(U,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${xt(m("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${bt}; }

.oc-sdk-search-icon { color: ${R}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${B}; }
.oc-sdk-search-clear { border-radius: ${vo}; color: ${R}; }
.oc-sdk-search-clear:hover { background: ${G}; color: ${U}; }

.oc-sdk-trigger { border-radius: ${vt}; background: var(--oc-sdk-raised-bg); color: ${te}; ${Ot} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${R}; }
.oc-sdk-trigger-chevron { color: ${R}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${te}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${we}; background-clip: padding-box; color: ${te}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${G}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${ft}; color: ${yt}; }
.oc-sdk-option-check { color: ${U}; }
.oc-sdk-option[data-destructive="true"] { color: ${ht}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${h(m("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${R}; }
.oc-sdk-popup-empty { color: ${R}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${q}; border-radius: 4px; color: ${U}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${h(U,60,q)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${q}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${F}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${B}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${xo} }
.oc-sdk-check-desc { color: ${R}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${h(U,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${R}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${U}; }
.oc-sdk-tab[aria-selected="true"] { color: ${yt}; background: ${ft}; border-color: ${q}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${te}; background: var(--oc-sdk-raised-bg); ${Ot} }
.oc-sdk-tab-count { color: ${R}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${h(U,6)}; color: ${R}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${h("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${G}; }
.oc-sdk-row[aria-selected="true"] { background: ${ft}; color: ${yt}; }
.oc-sdk-row-lead { font-family: ${bt}; color: ${R}; }
.oc-sdk-row-sub { color: ${R}; }
.oc-sdk-row-meta { color: ${R}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${R}; }

.oc-sdk-empty-body { color: ${R}; }

.oc-sdk-spinner { color: ${R}; }
.oc-sdk-spinner-ring { border-color: ${q}; border-top-color: ${B}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${h("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${R}; }

.oc-sdk-separator { color: ${R}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${h(q,40)}; }

.oc-sdk-progress-label { color: ${R}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${h(U,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${B}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${m("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${m("success-text","inherit")}; }

.oc-sdk-text a { color: ${Rt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${h(q,60)}; }
`,k=`
${qe}
${jo}
${Co}`;var ko="oc-sdk-ui-style";var I=(e)=>{let r=document.getElementById(ko);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}We(document);let s=document.createElement("style");s.id=ko,s.textContent=e,document.head.appendChild(s)},v=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},X=(e)=>{let r=v("button",e);return r.type="button",r},N=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s},K=(e,r,s)=>{if(s===void 0||s===null||s==="")e.removeAttribute(r);else if(e.getAttribute(r)!==s)e.setAttribute(r,s)};var zo=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},oe=(e,r)=>{I(k);let s=r,p=X("oc-sdk oc-sdk-btn"),d=zo(),g=document.createElement("span");p.append(g),e.append(p);let A=()=>{if(p.dataset.variant=s.variant??"default",p.dataset.size=s.size??"default",p.disabled=Boolean(s.disabled)||Boolean(s.loading),p.dataset.loading=s.loading?"true":"false",p.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&d.parentNode!==p)p.prepend(d);else if(!s.loading&&d.parentNode===p)d.remove();N(g,s.label)},y=()=>{if(s.disabled||s.loading)return;s.onClick()};return p.addEventListener("click",y),A(),{update:(C)=>{s={...s,...C},A()},dispose:()=>{p.removeEventListener("click",y),p.remove()}}};var Ct=(e,r)=>{I(k);let s=r,p=v("label","oc-sdk oc-sdk-field"),d=v("span","oc-sdk-field-label"),g=s.multiline?v("textarea","oc-sdk-input"):v("input","oc-sdk-input"),A=v("span","oc-sdk-field-note");p.append(d,g,A),e.append(p);let y=()=>{if(N(d,s.label),d.hidden=!s.label,g instanceof HTMLInputElement)g.type=s.password?"password":"text";else g.rows=s.rows??3;if(g.value!==s.value)g.value=s.value;g.disabled=Boolean(s.disabled),K(g,"placeholder",s.placeholder),g.dataset.mono=s.mono?"true":"false";let M=Boolean(s.error);p.dataset.invalid=M?"true":"false",g.setAttribute("aria-invalid",M?"true":"false");let V=s.error??s.helper??"";N(A,V),A.hidden=V===""},C=()=>{s.onChange(g.value)};return g.addEventListener("input",C),y(),{update:(M)=>{s={...s,...M},y()},dispose:()=>{g.removeEventListener("input",C),p.remove()}}};var kt=Tt(),Po=document.querySelector("#root");if(!Po)throw Error("Missing root");var Io=!1;kt.onReady((e)=>{if(mt(e,document.documentElement),Io)return;Io=!0;let r=document.createElement("div");r.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",Po.append(r);let s="",p=document.createElement("div");p.style.flex="1",r.append(p);let d=Ct(p,{value:s,placeholder:"https://example.com",mono:!0,onChange:(y)=>{s=y,d.update({value:y})}}),g=oe(r,{label:"Go",size:"sm",onClick:()=>{if(!s.trim())return;g.update({loading:!0}),kt.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:s.trim()})}).then(()=>A()).finally(()=>g.update({loading:!1}))}}),A=async()=>{try{let y=await kt.serviceRequest({method:"GET",path:"/state"}),C=JSON.parse(y.body);if(String(C.url)===C.url&&C.url!==s)s=C.url==="about:blank"?"":C.url,d.update({value:s})}catch{}};A(),setInterval(()=>{A()},2000)});})();
