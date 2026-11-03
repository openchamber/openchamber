(()=>{var S="openchamber.sdk",g=1;var Ve=`
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
`;function Xe(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(p)=>{let d=p.target===e?r:p.target;if(!(d instanceof Element))return;if(!d.hasAttribute("data-oc-scrolling"))d.setAttribute("data-oc-scrolling","");let E=s.get(d);if(E!==void 0)clearTimeout(E);s.set(d,setTimeout(()=>{s.delete(d),d.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Po=`(${Xe.toString()})(document);`;var qe=128,$e=65536;var Te=128;var _e=65536;var Vt=/^[a-z][a-z0-9-]{0,39}$/;var Ht=(e)=>Object(e)===e&&!Array.isArray(e),We=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Ft=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Bt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Xt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Ht(s)||!Vt.test(s.id)||!Ft(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!We(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!We(s,["kind","id","label","value","options","disabled"]))return!1;if(!Bt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let p=new Set;for(let d of s.options){if(!Ht(d)||!We(d,["value","label"])||!Bt(d.value)||!Ft(d.label)||p.has(d.value))return!1;p.add(d.value)}if(!p.has(s.value))return!1}return!0};var qt=["{id}","{segment}","{segments+}"];var ir=new Set(qt);var $t=["turn-finished","turn-failed","permission-asked","question-asked"];var lr=new Set($t);var fe=20000000,ye=256;var je=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Wt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var jt=/^[A-Za-z0-9_-]{1,80}$/;var Kt=["left","right","top","bottom"];var zt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let p=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let d of p)if(!zt(d,r+1,s))return!1;return!0},Ke=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Ke);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Ke)}return String(e)===e||Number.isFinite(e)},ze=(e)=>{try{if(String(e.id)!==e.id||!jt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Kt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!zt(e.data)||!Ke(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var Yt=["file","directory","other","missing"],Ye=(e)=>Boolean(e&&"sessionId"in e),Qe=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Qt=/^[0-9a-f]{7,64}$/i,Ze=(e)=>Qt.test(e),he=500,be=32000,Zt=16000,eo=128,to=200,oo=2000,ro=16000,so=80,no=200,io=16000;var ao=2000;var et=20000,Re=1024,xe=2000000;var ve=64000,Oe=8000,tt=4000;var ot=960000;var lo=999,co=1e4,ce=500,uo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],po=["stopped","starting","ready","failed"],Go=new Set(uo),So=(e)=>Go.has(e),go=(e)=>e&&So(e)?e:"HOST_REJECTED",Q=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(Q);if(Object(e)===e)return Object.values(e).every(Q);return!1},Eo=(e)=>Q(e)&&JSON.stringify(e).length<=io,Jt=(e)=>e?.trim().slice(0,no)??"",Z=(e)=>{let r=e.id.trim().slice(0,eo),s=e.title.trim().slice(0,to),p=e.url.trim().slice(0,oo),d=e.text?.trim().slice(0,ro),E=e.author?.trim().slice(0,so),k=e.kind==="pull"?"pull":"issue",f={providerId:e.providerId.trim(),id:r,title:s||r,url:p,kind:k};if(d)f.text=d;if(E)f.author=E;if(k==="pull"){let A=Jt(e.branches?.head),M=Jt(e.branches?.base);if(A&&M)f.branches={head:A,base:M}}if(Eo(e.data))f.data=e.data;return f},rt=(e)=>{let r=Z(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},st=(e)=>{let r={text:e.text.trim().slice(0,Zt)};if(e.send)r.send=!0;return r},nt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(lo,Math.max(0,Math.round(e)))},it=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(co,Math.max(0,Math.ceil(e)))};var ee=(e)=>e.length>0&&e.length<=Re&&!e.includes("\x00")&&!e.includes("\\");var ke=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>ao)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Mo=new Set(po),at=(e)=>Boolean(e&&"status"in e&&Mo.has(String(e.status))&&!("body"in e)),Ae=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),lt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),ct=(e)=>Boolean(e&&"written"in e&&e.written===!0),ut=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),wo=new Set(Yt),pt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&wo.has(String(e.kind))&&Number.isFinite(e.size)),dt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Uo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),No=(e)=>Object(e)===e?e:null,Je=(e)=>String(e)===e&&e.length>0,Lo=(e)=>{if(!Je(e.id))return null;if(e.ok===!0){let r={channel:S,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Je(e.error))return{channel:S,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:go(Je(e.code)?e.code:void 0)};return null},St=(e)=>{let r=No(e);if(!r||r.channel!==S||r.v!==g)return null;if(r.type==="result")return Lo(r);if(!Uo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var mo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Do=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class a extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var To=()=>Promise.reject(new a("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ce=()=>Promise.reject(new a("BAD_PATH",`File path must be 1 to ${Re} characters without NUL or backslash.`)),Pe=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new a("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},u=(e)=>(e.value+=1,`oc-${e.value}`),gt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new a("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),p=e.requestTimeoutMs??et,d=new Set,E=new Set,k=new Set,f=new Set,A=new Set,M=new Set,V=new Set,ue=new Set,pe=new Set,K=new Set,Le=[],re=null,se=null,de=new Set,Se=new Set,ne=null,ie=null,De=!1,z=new Map,J=new Map,Y=new Map,D=!1,c={value:0},l=null,H=null,ae=!1,le=!1,kt=null,At=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},Ct=()=>{if(D||r.parent===r||K.size===0||l?.features?.lateGenerateResults!==!0)return;w({channel:S,v:g,type:"generate-late-listen"})},b=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Pt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=St(t.data);if(!o)return;if(o.type==="workspace"){let i=J.get(o.payload.subscriptionId);if(i)b([i],o.payload.snapshot);return}if(o.type==="shells"){let i=Y.get(o.payload.subscriptionId);if(i)b([i],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,H=At(o.payload.session),b(d,o.payload),b(E,o.payload.directory),b(k,o.payload.session),H)b(f,H);b(A,o.payload.connection),b(M,o.payload.settings),b(V,o.payload.item),Ct();return}if(o.type==="generate-late"){if(K.size===0)Le.push(o.payload);else b(K,o.payload);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};b(E,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)H=null;else if(H?.sessionId!==o.payload.session.id)H=At(o.payload.session);b(k,o.payload.session);return}if(o.type==="session-lifecycle"){H=o.payload,b(f,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};b(A,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};b(M,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};b(V,o.payload.item);return}if(o.type==="status-control-event"){b(ue,o.payload);return}if(o.type==="popover-closed"){b(pe,o.payload);return}if(o.type==="action"){let i=(m)=>{if(!D)w({channel:S,v:g,type:"action-result",id:o.id,payload:m})},T=se;if(!T){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>T(o.payload)).then(()=>i({ok:!0}),(m)=>{let O=(m instanceof Error?m.message:String(m)).trim();i({ok:!1,error:(O||"Action failed.").slice(0,ce)})});return}if(o.type==="file-open"){let i=o.payload;if(ie&&Wt(ie,i))return;ie=i,b(de,o.payload);return}if(o.type==="file-saved"){b(Se,o.payload.version);return}if(o.type==="file-snapshot"){let i=(O)=>{if(!D)w({channel:S,v:g,type:"file-snapshot-result",id:o.id,payload:O})},T=(O)=>i({error:(O.trim()||"Could not read the edited file.").slice(0,ce)}),m=ne;if(!m){T("This extension does not edit files.");return}Promise.resolve().then(()=>m(o.payload.purpose)).then((O)=>{if(je(O)>fe){T(`The file is over ${fe} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>ye){T(`The snapshot version is over ${ye} characters.`);return}i({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>T(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let i=(m)=>{w({channel:S,v:g,type:"resolve-result",id:o.id,payload:m})},T=re;if(!T){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>T(o.payload)).then((m)=>i({item:m?Z(m):null}),(m)=>{let O=(m instanceof Error?m.message:String(m)).trim();i({error:(O||"Command failed.").slice(0,ce)})});return}let n=z.get(o.id);if(!n)return;if(clearTimeout(n.timer),z.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new a(o.code,o.error))};r.addEventListener("message",Pt),w({channel:S,v:g,type:"hello"});let I=(t,o=p)=>{if(D||r.parent===r)return Promise.reject(new a("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let T=setTimeout(()=>{z.delete(t.id),i(new a("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:n,reject:i,timer:T}),w(t)})},x=(t)=>I(t).then(()=>{return}),v={channel:S,v:g},He=(t)=>{if(!D&&r.parent!==r)w(t)},It=()=>He({...v,type:"file-save"}),Gt=(t)=>{if(!mo(t)||!Do(t))return;t.preventDefault(),It()},Mt=(t)=>{if(!mo(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),Lt(l.popover.id,"escape").catch(()=>{return})},ge=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=ae||le;if(kt===o)return;kt=o,Dt(t.id,o).catch(()=>{return})},Ee=()=>{if(l?.surface!=="popover"||ae)return;ae=!0,ge()},wt=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!ae)return;ae=!1,ge()},Ut=()=>{if(l?.surface!=="popover"||le)return;le=!0,ge()},Nt=()=>{if(l?.surface!=="popover"||!le)return;le=!1,ge()},L=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new a("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Fe=async(t)=>{if(t.kind!=="projects")L(t.projectId);let o=await I({...v,type:"workspace-read",id:u(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new a("HOST_REJECTED","Host did not return workspace data.");return o},Be=async(t,o)=>{if(t.kind!=="projects")L(t.projectId);let n=u(c);J.set(n,o);try{await x({...v,type:"workspace-subscribe",id:u(c),payload:{subscriptionId:n,query:t}})}catch(i){if(J.delete(n),!D)w({...v,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:n}});throw i}return()=>{if(!J.delete(n)||D)return;w({...v,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:n}})}},Co=async(t,o)=>{if(t.kind==="session")L(t.sessionId);if(t.kind==="project")L(t.projectId);let n=u(c);Y.set(n,o);try{await x({...v,type:"shells-subscribe",id:u(c),payload:{subscriptionId:n,scope:t}})}catch(i){if(Y.delete(n),!D)w({...v,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:n}});throw i}return()=>{if(!Y.delete(n)||D)return;w({...v,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:n}})}},me=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>qe))throw new a("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!Q(t.value))throw new a("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>$e)throw new a("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new a("UNSUPPORTED","This host does not support device storage.");let o=await I({...v,type:"storage",id:u(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new a("HOST_REJECTED","Host did not return storage data.");return o},Lt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-close",id:u(c),payload:o?{id:t,reason:o}:{id:t}}),Dt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-anchor",id:u(c),payload:{id:t,active:o}});return r.addEventListener("keydown",Mt,!0),r.addEventListener("pointerover",Ee),r.addEventListener("pointermove",Ee),r.addEventListener("pointerout",wt),r.addEventListener("focus",Ut),r.addEventListener("blur",Nt),{onAction:(t)=>(se=t,()=>{if(se===t)se=null}),listProjects:async()=>{let t=await Fe({kind:"projects"});if(t.kind!=="projects")throw new a("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Fe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new a("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Fe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new a("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Be({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Be({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Be({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Co(t,o),readShellOutput:async(t,o)=>{L(t,Te);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new a("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>_e))throw new a("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${_e}.`);let m=await I({...v,type:"shell-output",id:u(c),payload:{shellId:t,cursor:n,tailBytes:i}});if(!m||typeof m.output!=="string"||!Number.isFinite(m.cursor))throw new a("HOST_REJECTED","Host did not return shell output.");return m},stopShell:async(t)=>{if(L(t,Te),(await I({...v,type:"shell-stop",id:u(c),payload:{shellId:t}}))?.stopped!==!0)throw new a("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{L(t),await x({...v,type:"open-session",id:u(c),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Pe(o),i={op:"get",key:t};if(n)i.scope=n;let T=await me(i);return T.op==="get"&&T.found?T.value:void 0},set:async(t,o,n)=>{let i=Pe(n),T={op:"set",key:t,value:o};if(i)T.scope=i;await me(T)},delete:async(t,o)=>{let n=Pe(o),i={op:"delete",key:t};if(n)i.scope=n;await me(i)},keys:async(t)=>{let o=Pe(t),n={op:"keys"};if(o)n.scope=o;let i=await me(n);if(i.op!=="keys")throw new a("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(d.add(t),l)t(l);return()=>{d.delete(t)}},onDirectory:(t)=>{if(E.add(t),l)t(l.directory);return()=>{E.delete(t)}},onSession:(t)=>{if(k.add(t),l)t(l.session);return()=>{k.delete(t)}},onSessionLifecycle:(t)=>{if(f.add(t),H)t(H);return()=>{f.delete(t)}},onConnection:(t)=>{if(A.add(t),l)t(l.connection);return()=>{A.delete(t)}},onSettings:(t)=>{if(M.add(t),l)t(l.settings);return()=>{M.delete(t)}},onItem:(t)=>{if(V.add(t),l)t(l.item);return()=>{V.delete(t)}},onStatusControl:(t)=>(ue.add(t),()=>{ue.delete(t)}),onPopoverClosed:(t)=>(pe.add(t),()=>{pe.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support status controls."));if(!Xt(t))return Promise.reject(new a("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...v,type:"status-controls",id:u(c),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support popovers."));if(!ze(t))return Promise.reject(new a("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...v,type:"popover-open",id:u(c),payload:t})},closePopover:Lt,setPopoverAnchorActive:Dt,onResolve:(t)=>(re=t,()=>{if(re===t)re=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>he)return Promise.reject(new a("HOST_REJECTED",`Toast message must contain 1 to ${he} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>be))return Promise.reject(new a("HOST_REJECTED",`Toast copy text must contain 1 to ${be} characters.`));return x({channel:S,v:g,type:"toast",id:u(c),payload:{...t,message:o}})},openUrl:(t)=>x({channel:S,v:g,type:"open-url",id:u(c),payload:{url:t}}),openCommit:(t)=>Ze(t)?x({channel:S,v:g,type:"open-commit",id:u(c),payload:{sha:t}}):Promise.reject(new a("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>x({channel:S,v:g,type:"open-surface",id:u(c),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:S,v:g,type:"clipboard-write",id:u(c),payload:{text:t}}),compose:(t)=>x({channel:S,v:g,type:"compose",id:u(c),payload:t}),attach:(t)=>x({channel:S,v:g,type:"attach",id:u(c),payload:Z(t)}),startSession:async(t)=>{if(t.projectId!==void 0)L(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")L(o.directory);else{if(o.name!==void 0)L(o.name,200);if(o.baseBranch!==void 0)L(o.baseBranch,200)}let n=await I({channel:S,v:g,type:"start-session",id:u(c),payload:rt(t)},e.requestTimeoutMs??180000);if(!Ye(n))throw new a("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>I({channel:S,v:g,type:"prompt",id:u(c),payload:st(t)}).then((o)=>{if(!Qe(o))throw new a("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:S,v:g,type:"session-link",id:u(c),payload:Z(t)}),close:()=>x({channel:S,v:g,type:"close",id:u(c)}),oauthStart:()=>x({channel:S,v:g,type:"oauth-start",id:u(c)}),oauthDisconnect:()=>x({channel:S,v:g,type:"oauth-disconnect",id:u(c)}),request:(t)=>(ke(t.path)?I({channel:S,v:g,type:"request",id:u(c),payload:t}):To()).then((o)=>{if(!Ae(o))throw new a("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(ke(t.path)?I({channel:S,v:g,type:"service-request",id:u(c),payload:t}):To()).then((o)=>{if(!Ae(o))throw new a("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>I({channel:S,v:g,type:"service-status",id:u(c)}).then((t)=>{if(!at(t))throw new a("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(ee(t)?I({channel:S,v:g,type:"file-read",id:u(c),payload:{path:t}}):Ce()).then((o)=>{if(!lt(o))throw new a("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!ee(t))return Ce();if(o.length>xe)return Promise.reject(new a("FILE_TOO_LARGE",`Content is over ${xe} characters.`));return I({channel:S,v:g,type:"file-write",id:u(c),payload:{path:t,content:o}}).then((n)=>{if(!ct(n))throw new a("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(ee(t)?I({channel:S,v:g,type:"file-list",id:u(c),payload:{path:t}}):Ce()).then((o)=>{if(!ut(o))throw new a("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(ee(t)?I({channel:S,v:g,type:"file-stat",id:u(c),payload:{path:t}}):Ce()).then((o)=>{if(!pt(o))throw new a("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>ve)return Promise.reject(new a("HOST_REJECTED",`Prompt must be 1 to ${ve} characters.`));if(n!==void 0&&(n.length===0||n.length>Oe))return Promise.reject(new a("HOST_REJECTED",`System prompt must be 1 to ${Oe} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(tt,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new a("HOST_REJECTED","maxOutputTokens must be a number."));let T={prompt:o};if(n!==void 0)T.system=n;if(i!==void 0)T.maxOutputTokens=i;return I({channel:S,v:g,type:"generate",id:u(c),payload:T},e.requestTimeoutMs??ot).then((m)=>{if(!dt(m))throw new a("HOST_REJECTED","Host did not return generated text.");return m})},onLateGenerateResult:(t)=>{K.add(t);for(let o of Le.splice(0))b([t],o);return Ct(),()=>{K.delete(t)}},setBadge:(t)=>x({channel:S,v:g,type:"badge",id:u(c),payload:{count:nt(t)}}),setHeight:(t)=>x({channel:S,v:g,type:"resize",id:u(c),payload:{height:it(t)}}),onFileOpen:(t)=>{if(de.add(t),!De)De=!0,r.addEventListener("keydown",Gt,!0);if(ie)t(ie);return()=>{de.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(Se.add(t),()=>{Se.delete(t)}),reportFileChange:(t)=>He({...v,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:It,reportFileUnsupported:()=>He({...v,type:"file-unsupported"}),dispose:()=>{for(let t of J.keys())w({...v,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:t}});J.clear();for(let t of Y.keys())w({...v,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:t}});if(Y.clear(),D=!0,re=null,se=null,ne=null,de.clear(),Se.clear(),De)r.removeEventListener("keydown",Gt,!0);r.removeEventListener("message",Pt),r.removeEventListener("keydown",Mt,!0),r.removeEventListener("pointerover",Ee),r.removeEventListener("pointermove",Ee),r.removeEventListener("pointerout",wt),r.removeEventListener("focus",Ut),r.removeEventListener("blur",Nt);for(let t of z.values())clearTimeout(t.timer),t.reject(new a("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),d.clear(),E.clear(),k.clear(),f.clear(),A.clear(),M.clear(),V.clear(),ue.clear(),pe.clear(),K.clear(),Le.length=0}}};var _o=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var br=new Set(_o);var fo=["none","agent","user"];var xr=new Set(fo);var Ho=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Fo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],yo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,p]of Ho)r.style.setProperty(s,e.tokens[p]);for(let[s,p,d]of Fo){let E=e.tokens[d]??"";r.style.setProperty(s,E),r.style.setProperty(p,E)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},Et=(e,r)=>{if(yo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Bo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},_=(e,r)=>`var(--${e}, var(--oc-${Bo[e]}, ${r}))`,B=_("surface-background","transparent"),Ge=_("surface-elevated","transparent"),te=_("surface-elevated-foreground","inherit"),U=_("surface-foreground","inherit"),y=_("surface-muted-foreground","gray"),Vo=_("surface-muted","transparent"),q=_("interactive-border","currentColor"),G=_("interactive-hover","transparent"),W=_("interactive-active","transparent"),mt=_("interactive-selection","transparent"),Tt=_("interactive-selection-foreground","inherit"),F=_("primary","currentColor"),_t=_("primary-text","inherit"),ft=_("error-text","inherit"),Xo=_("font-sans","inherit"),yt=_("font-mono","monospace"),xo=_("radius","9px"),ht=`calc(${xo} - 2px)`,ho=`calc(${xo} - 4px)`,h=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,bo=`background-image: linear-gradient(${G}, ${G});`,bt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Rt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Ro="box-shadow: var(--oc-sdk-lit);",xt=`inset 0 0.5px 0 0 ${h(U,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,qo=`
:root {
  --oc-sdk-edge: ${h(U,16)};
  --oc-sdk-field-bg: ${Ge};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${h(U,14)};
  --oc-sdk-field-bg: ${h(B,50,Ge)};
  --oc-sdk-raised-bg: ${Ge};
  --oc-sdk-field-lift: ${xt};
  --oc-sdk-raised-lift: ${xt};
  --oc-sdk-lit: ${xt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ie=(e)=>{let r=_(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${_(`${e}-text`,"inherit")}; }`},$o=`
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
`,vo=`${qo}
.oc-sdk { color: ${U}; font-family: ${Xo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${bo} }
.oc-sdk-mono { font-family: ${yt}; }
.oc-sdk-muted { color: ${y}; }
${Ie("success")}${Ie("warning")}${Ie("error")}${Ie("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${_t}; }

.oc-sdk-btn { border-radius: ${ht}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${ho}; }
.oc-sdk-btn[data-variant="default"] { color: ${_t}; background: ${h(F,10,B)}; border-color: ${h(F,12)}; ${Ro} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${h(F,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${h(F,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Vo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${te}; ${Rt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${W}, ${W}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${G}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${W}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${_("status-error","red")}; color: ${ft}; background: ${h("var(--oc-sdk-tone)",7,B)}; border-color: ${h("var(--oc-sdk-tone)",12)}; ${Ro} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${h("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${h("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${y}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${ft}; }
.oc-sdk-input { border-radius: ${ht}; background: var(--oc-sdk-field-bg); color: ${te}; ${bt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${y}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${bt(h(U,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${bt(_("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${yt}; }

.oc-sdk-search-icon { color: ${y}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${ho}; color: ${y}; }
.oc-sdk-search-clear:hover { background: ${G}; color: ${U}; }

.oc-sdk-trigger { border-radius: ${ht}; background: var(--oc-sdk-raised-bg); color: ${te}; ${Rt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${y}; }
.oc-sdk-trigger-chevron { color: ${y}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${te}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Ge}; background-clip: padding-box; color: ${te}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${G}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${mt}; color: ${Tt}; }
.oc-sdk-option-check { color: ${U}; }
.oc-sdk-option[data-destructive="true"] { color: ${ft}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${h(_("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${y}; }
.oc-sdk-popup-empty { color: ${y}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${q}; border-radius: 4px; color: ${U}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${h(U,60,q)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${q}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${bo} }
.oc-sdk-check-desc { color: ${y}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${h(U,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${y}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${U}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Tt}; background: ${mt}; border-color: ${q}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${te}; background: var(--oc-sdk-raised-bg); ${Rt} }
.oc-sdk-tab-count { color: ${y}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${h(U,6)}; color: ${y}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${h("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${G}; }
.oc-sdk-row[aria-selected="true"] { background: ${mt}; color: ${Tt}; }
.oc-sdk-row-lead { font-family: ${yt}; color: ${y}; }
.oc-sdk-row-sub { color: ${y}; }
.oc-sdk-row-meta { color: ${y}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${y}; }

.oc-sdk-empty-body { color: ${y}; }

.oc-sdk-spinner { color: ${y}; }
.oc-sdk-spinner-ring { border-color: ${q}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${h("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${y}; }

.oc-sdk-separator { color: ${y}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${h(q,40)}; }

.oc-sdk-progress-label { color: ${y}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${h(U,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${_("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${_("success-text","inherit")}; }

.oc-sdk-text a { color: ${_t}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${h(q,60)}; }
`,C=`
${Ve}
${$o}
${vo}`;var Oo="oc-sdk-ui-style";var P=(e)=>{let r=document.getElementById(Oo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Xe(document);let s=document.createElement("style");s.id=Oo,s.textContent=e,document.head.appendChild(s)},R=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},X=(e)=>{let r=R("button",e);return r.type="button",r},N=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s},j=(e,r,s)=>{if(s===void 0||s===null||s==="")e.removeAttribute(r);else if(e.getAttribute(r)!==s)e.setAttribute(r,s)};var Wo=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},oe=(e,r)=>{P(C);let s=r,p=X("oc-sdk oc-sdk-btn"),d=Wo(),E=document.createElement("span");p.append(E),e.append(p);let k=()=>{if(p.dataset.variant=s.variant??"default",p.dataset.size=s.size??"default",p.disabled=Boolean(s.disabled)||Boolean(s.loading),p.dataset.loading=s.loading?"true":"false",p.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&d.parentNode!==p)p.prepend(d);else if(!s.loading&&d.parentNode===p)d.remove();N(E,s.label)},f=()=>{if(s.disabled||s.loading)return;s.onClick()};return p.addEventListener("click",f),k(),{update:(A)=>{s={...s,...A},k()},dispose:()=>{p.removeEventListener("click",f),p.remove()}}};var vt=(e,r)=>{P(C);let s=r,p=R("label","oc-sdk oc-sdk-field"),d=R("span","oc-sdk-field-label"),E=s.multiline?R("textarea","oc-sdk-input"):R("input","oc-sdk-input"),k=R("span","oc-sdk-field-note");p.append(d,E,k),e.append(p);let f=()=>{if(N(d,s.label),d.hidden=!s.label,E instanceof HTMLInputElement)E.type=s.password?"password":"text";else E.rows=s.rows??3;if(E.value!==s.value)E.value=s.value;E.disabled=Boolean(s.disabled),j(E,"placeholder",s.placeholder),E.dataset.mono=s.mono?"true":"false";let M=Boolean(s.error);p.dataset.invalid=M?"true":"false",E.setAttribute("aria-invalid",M?"true":"false");let V=s.error??s.helper??"";N(k,V),k.hidden=V===""},A=()=>{s.onChange(E.value)};return E.addEventListener("input",A),f(),{update:(M)=>{s={...s,...M},f()},dispose:()=>{E.removeEventListener("input",A),p.remove()}}};var Ot=gt(),Ao=document.querySelector("#root");if(!Ao)throw Error("Missing root");var ko=!1;Ot.onReady((e)=>{if(Et(e,document.documentElement),ko)return;ko=!0;let r=document.createElement("div");r.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",Ao.append(r);let s="",p=document.createElement("div");p.style.flex="1",r.append(p);let d=vt(p,{value:s,placeholder:"https://example.com",mono:!0,onChange:(f)=>{s=f,d.update({value:f})}}),E=oe(r,{label:"Go",size:"sm",onClick:()=>{if(!s.trim())return;E.update({loading:!0}),Ot.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:s.trim()})}).then(()=>k()).finally(()=>E.update({loading:!1}))}}),k=async()=>{try{let f=await Ot.serviceRequest({method:"GET",path:"/state"}),A=JSON.parse(f.body);if(String(A.url)===A.url&&A.url!==s)s=A.url==="about:blank"?"":A.url,d.update({value:s})}catch{}};k(),setInterval(()=>{k()},2000)});})();
