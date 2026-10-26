(()=>{var S="openchamber.sdk",g=1;var Be=`
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
`;function Xe(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(p)=>{let d=p.target===e?r:p.target;if(!(d instanceof Element))return;if(!d.hasAttribute("data-oc-scrolling"))d.setAttribute("data-oc-scrolling","");let E=s.get(d);if(E!==void 0)clearTimeout(E);s.set(d,setTimeout(()=>{s.delete(d),d.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Ao=`(${Xe.toString()})(document);`;var Ve=128,$e=65536;var fe=128;var he=65536;var Bt=/^[a-z][a-z0-9-]{0,39}$/;var Ht=(e)=>Object(e)===e&&!Array.isArray(e),qe=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Dt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Ft=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Xt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Ht(s)||!Bt.test(s.id)||!Dt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!qe(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!qe(s,["kind","id","label","value","options","disabled"]))return!1;if(!Ft(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let p=new Set;for(let d of s.options){if(!Ht(d)||!qe(d,["value","label"])||!Ft(d.value)||!Dt(d.label)||p.has(d.value))return!1;p.add(d.value)}if(!p.has(s.value))return!1}return!0};var _e=20000000,ye=256;var We=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Vt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var $t=/^[A-Za-z0-9_-]{1,80}$/;var qt=["left","right","top","bottom"];var Wt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let p=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let d of p)if(!Wt(d,r+1,s))return!1;return!0},je=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(je);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(je)}return String(e)===e||Number.isFinite(e)},ze=(e)=>{try{if(String(e.id)!==e.id||!$t.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!qt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Wt(e.data)||!je(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var zt=["file","directory","other","missing"],Je=(e)=>Boolean(e&&"sessionId"in e),Ye=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Kt=/^[0-9a-f]{7,64}$/i,Qe=(e)=>Kt.test(e),Te=500,be=32000,Jt=16000,Yt=128,Qt=200,Zt=2000,eo=16000,to=80,oo=200,ro=16000;var so=2000;var Ze=20000,xe=1024,Re=2000000;var ve=64000,Oe=8000,et=4000;var tt=960000;var no=999,io=1e4,ce=500,ao=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],lo=["stopped","starting","ready","failed"],Go=new Set(ao),co=(e)=>Go.has(e),uo=(e)=>e&&co(e)?e:"HOST_REJECTED",Y=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(Y);if(Object(e)===e)return Object.values(e).every(Y);return!1},po=(e)=>Y(e)&&JSON.stringify(e).length<=ro,jt=(e)=>e?.trim().slice(0,oo)??"",Q=(e)=>{let r=e.id.trim().slice(0,Yt),s=e.title.trim().slice(0,Qt),p=e.url.trim().slice(0,Zt),d=e.text?.trim().slice(0,eo),E=e.author?.trim().slice(0,to),C=e.kind==="pull"?"pull":"issue",h={providerId:e.providerId.trim(),id:r,title:s||r,url:p,kind:C};if(d)h.text=d;if(E)h.author=E;if(C==="pull"){let A=jt(e.branches?.head),I=jt(e.branches?.base);if(A&&I)h.branches={head:A,base:I}}if(po(e.data))h.data=e.data;return h},ot=(e)=>{let r=Q(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},rt=(e)=>{let r={text:e.text.trim().slice(0,Jt)};if(e.send)r.send=!0;return r},st=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(no,Math.max(0,Math.round(e)))},nt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(io,Math.max(0,Math.ceil(e)))};var Z=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var Ce=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>so)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Po=new Set(lo),it=(e)=>Boolean(e&&"status"in e&&Po.has(String(e.status))&&!("body"in e)),Ae=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),at=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),lt=(e)=>Boolean(e&&"written"in e&&e.written===!0),ct=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Mo=new Set(zt),ut=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Mo.has(String(e.kind))&&Number.isFinite(e.size)),pt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Io=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),wo=(e)=>Object(e)===e?e:null,Ke=(e)=>String(e)===e&&e.length>0,Uo=(e)=>{if(!Ke(e.id))return null;if(e.ok===!0){let r={channel:S,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ke(e.error))return{channel:S,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:uo(Ke(e.code)?e.code:void 0)};return null},dt=(e)=>{let r=wo(e);if(!r||r.channel!==S||r.v!==g)return null;if(r.type==="result")return Uo(r);if(!Io.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var So=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Lo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class a extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var go=()=>Promise.reject(new a("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),ke=()=>Promise.reject(new a("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Ge=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new a("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},u=(e)=>(e.value+=1,`oc-${e.value}`),St=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new a("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),p=e.requestTimeoutMs??Ze,d=new Set,E=new Set,C=new Set,h=new Set,A=new Set,I=new Set,X=new Set,ue=new Set,pe=new Set,j=new Set,Le=[],re=null,se=null,de=new Set,Se=new Set,ne=null,ie=null,Ne=!1,z=new Map,K=new Map,J=new Map,H=!1,c={value:0},l=null,D=null,ae=!1,le=!1,Ot=null,Ct=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},At=()=>{if(H||r.parent===r||j.size===0||l?.features?.lateGenerateResults!==!0)return;w({channel:S,v:g,type:"generate-late-listen"})},T=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},kt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=dt(t.data);if(!o)return;if(o.type==="workspace"){let i=K.get(o.payload.subscriptionId);if(i)T([i],o.payload.snapshot);return}if(o.type==="shells"){let i=J.get(o.payload.subscriptionId);if(i)T([i],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,D=Ct(o.payload.session),T(d,o.payload),T(E,o.payload.directory),T(C,o.payload.session),D)T(h,D);T(A,o.payload.connection),T(I,o.payload.settings),T(X,o.payload.item),At();return}if(o.type==="generate-late"){if(j.size===0)Le.push(o.payload);else T(j,o.payload);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};T(E,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=Ct(o.payload.session);T(C,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,T(h,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};T(A,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};T(I,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};T(X,o.payload.item);return}if(o.type==="status-control-event"){T(ue,o.payload);return}if(o.type==="popover-closed"){T(pe,o.payload);return}if(o.type==="action"){let i=(m)=>{if(!H)w({channel:S,v:g,type:"action-result",id:o.id,payload:m})},f=se;if(!f){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>f(o.payload)).then(()=>i({ok:!0}),(m)=>{let O=(m instanceof Error?m.message:String(m)).trim();i({ok:!1,error:(O||"Action failed.").slice(0,ce)})});return}if(o.type==="file-open"){let i=o.payload;if(ie&&Vt(ie,i))return;ie=i,T(de,o.payload);return}if(o.type==="file-saved"){T(Se,o.payload.version);return}if(o.type==="file-snapshot"){let i=(O)=>{if(!H)w({channel:S,v:g,type:"file-snapshot-result",id:o.id,payload:O})},f=(O)=>i({error:(O.trim()||"Could not read the edited file.").slice(0,ce)}),m=ne;if(!m){f("This extension does not edit files.");return}Promise.resolve().then(()=>m(o.payload.purpose)).then((O)=>{if(We(O)>_e){f(`The file is over ${_e} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>ye){f(`The snapshot version is over ${ye} characters.`);return}i({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>f(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let i=(m)=>{w({channel:S,v:g,type:"resolve-result",id:o.id,payload:m})},f=re;if(!f){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>f(o.payload)).then((m)=>i({item:m?Q(m):null}),(m)=>{let O=(m instanceof Error?m.message:String(m)).trim();i({error:(O||"Command failed.").slice(0,ce)})});return}let n=z.get(o.id);if(!n)return;if(clearTimeout(n.timer),z.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new a(o.code,o.error))};r.addEventListener("message",kt),w({channel:S,v:g,type:"hello"});let P=(t,o=p)=>{if(H||r.parent===r)return Promise.reject(new a("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let f=setTimeout(()=>{z.delete(t.id),i(new a("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:n,reject:i,timer:f}),w(t)})},R=(t)=>P(t).then(()=>{return}),v={channel:S,v:g},He=(t)=>{if(!H&&r.parent!==r)w(t)},Gt=()=>He({...v,type:"file-save"}),Pt=(t)=>{if(!So(t)||!Lo(t))return;t.preventDefault(),Gt()},Mt=(t)=>{if(!So(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),Lt(l.popover.id,"escape").catch(()=>{return})},ge=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=ae||le;if(Ot===o)return;Ot=o,Nt(t.id,o).catch(()=>{return})},Ee=()=>{if(l?.surface!=="popover"||ae)return;ae=!0,ge()},It=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!ae)return;ae=!1,ge()},wt=()=>{if(l?.surface!=="popover"||le)return;le=!0,ge()},Ut=()=>{if(l?.surface!=="popover"||!le)return;le=!1,ge()},N=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new a("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},De=async(t)=>{if(t.kind!=="projects")N(t.projectId);let o=await P({...v,type:"workspace-read",id:u(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new a("HOST_REJECTED","Host did not return workspace data.");return o},Fe=async(t,o)=>{if(t.kind!=="projects")N(t.projectId);let n=u(c);K.set(n,o);try{await R({...v,type:"workspace-subscribe",id:u(c),payload:{subscriptionId:n,query:t}})}catch(i){if(K.delete(n),!H)w({...v,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:n}});throw i}return()=>{if(!K.delete(n)||H)return;w({...v,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:n}})}},Co=async(t,o)=>{if(t.kind==="session")N(t.sessionId);if(t.kind==="project")N(t.projectId);let n=u(c);J.set(n,o);try{await R({...v,type:"shells-subscribe",id:u(c),payload:{subscriptionId:n,scope:t}})}catch(i){if(J.delete(n),!H)w({...v,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:n}});throw i}return()=>{if(!J.delete(n)||H)return;w({...v,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:n}})}},me=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ve))throw new a("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!Y(t.value))throw new a("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>$e)throw new a("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new a("UNSUPPORTED","This host does not support device storage.");let o=await P({...v,type:"storage",id:u(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new a("HOST_REJECTED","Host did not return storage data.");return o},Lt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):R({...v,type:"popover-close",id:u(c),payload:o?{id:t,reason:o}:{id:t}}),Nt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):R({...v,type:"popover-anchor",id:u(c),payload:{id:t,active:o}});return r.addEventListener("keydown",Mt,!0),r.addEventListener("pointerover",Ee),r.addEventListener("pointermove",Ee),r.addEventListener("pointerout",It),r.addEventListener("focus",wt),r.addEventListener("blur",Ut),{onAction:(t)=>(se=t,()=>{if(se===t)se=null}),listProjects:async()=>{let t=await De({kind:"projects"});if(t.kind!=="projects")throw new a("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await De({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new a("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await De({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new a("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Fe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Fe({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Fe({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Co(t,o),readShellOutput:async(t,o)=>{N(t,fe);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new a("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>he))throw new a("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${he}.`);let m=await P({...v,type:"shell-output",id:u(c),payload:{shellId:t,cursor:n,tailBytes:i}});if(!m||typeof m.output!=="string"||!Number.isFinite(m.cursor))throw new a("HOST_REJECTED","Host did not return shell output.");return m},stopShell:async(t)=>{if(N(t,fe),(await P({...v,type:"shell-stop",id:u(c),payload:{shellId:t}}))?.stopped!==!0)throw new a("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{N(t),await R({...v,type:"open-session",id:u(c),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Ge(o),i={op:"get",key:t};if(n)i.scope=n;let f=await me(i);return f.op==="get"&&f.found?f.value:void 0},set:async(t,o,n)=>{let i=Ge(n),f={op:"set",key:t,value:o};if(i)f.scope=i;await me(f)},delete:async(t,o)=>{let n=Ge(o),i={op:"delete",key:t};if(n)i.scope=n;await me(i)},keys:async(t)=>{let o=Ge(t),n={op:"keys"};if(o)n.scope=o;let i=await me(n);if(i.op!=="keys")throw new a("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(d.add(t),l)t(l);return()=>{d.delete(t)}},onDirectory:(t)=>{if(E.add(t),l)t(l.directory);return()=>{E.delete(t)}},onSession:(t)=>{if(C.add(t),l)t(l.session);return()=>{C.delete(t)}},onSessionLifecycle:(t)=>{if(h.add(t),D)t(D);return()=>{h.delete(t)}},onConnection:(t)=>{if(A.add(t),l)t(l.connection);return()=>{A.delete(t)}},onSettings:(t)=>{if(I.add(t),l)t(l.settings);return()=>{I.delete(t)}},onItem:(t)=>{if(X.add(t),l)t(l.item);return()=>{X.delete(t)}},onStatusControl:(t)=>(ue.add(t),()=>{ue.delete(t)}),onPopoverClosed:(t)=>(pe.add(t),()=>{pe.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support status controls."));if(!Xt(t))return Promise.reject(new a("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return R({...v,type:"status-controls",id:u(c),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support popovers."));if(!ze(t))return Promise.reject(new a("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return R({...v,type:"popover-open",id:u(c),payload:t})},closePopover:Lt,setPopoverAnchorActive:Nt,onResolve:(t)=>(re=t,()=>{if(re===t)re=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Te)return Promise.reject(new a("HOST_REJECTED",`Toast message must contain 1 to ${Te} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>be))return Promise.reject(new a("HOST_REJECTED",`Toast copy text must contain 1 to ${be} characters.`));return R({channel:S,v:g,type:"toast",id:u(c),payload:{...t,message:o}})},openUrl:(t)=>R({channel:S,v:g,type:"open-url",id:u(c),payload:{url:t}}),openCommit:(t)=>Qe(t)?R({channel:S,v:g,type:"open-commit",id:u(c),payload:{sha:t}}):Promise.reject(new a("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>R({channel:S,v:g,type:"open-surface",id:u(c),payload:{surfaceId:t}}),writeClipboard:(t)=>R({channel:S,v:g,type:"clipboard-write",id:u(c),payload:{text:t}}),compose:(t)=>R({channel:S,v:g,type:"compose",id:u(c),payload:t}),attach:(t)=>R({channel:S,v:g,type:"attach",id:u(c),payload:Q(t)}),startSession:async(t)=>{if(t.projectId!==void 0)N(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")N(o.directory);else{if(o.name!==void 0)N(o.name,200);if(o.baseBranch!==void 0)N(o.baseBranch,200)}let n=await P({channel:S,v:g,type:"start-session",id:u(c),payload:ot(t)},e.requestTimeoutMs??180000);if(!Je(n))throw new a("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>P({channel:S,v:g,type:"prompt",id:u(c),payload:rt(t)}).then((o)=>{if(!Ye(o))throw new a("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>R({channel:S,v:g,type:"session-link",id:u(c),payload:Q(t)}),close:()=>R({channel:S,v:g,type:"close",id:u(c)}),oauthStart:()=>R({channel:S,v:g,type:"oauth-start",id:u(c)}),oauthDisconnect:()=>R({channel:S,v:g,type:"oauth-disconnect",id:u(c)}),request:(t)=>(Ce(t.path)?P({channel:S,v:g,type:"request",id:u(c),payload:t}):go()).then((o)=>{if(!Ae(o))throw new a("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ce(t.path)?P({channel:S,v:g,type:"service-request",id:u(c),payload:t}):go()).then((o)=>{if(!Ae(o))throw new a("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:S,v:g,type:"service-status",id:u(c)}).then((t)=>{if(!it(t))throw new a("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Z(t)?P({channel:S,v:g,type:"file-read",id:u(c),payload:{path:t}}):ke()).then((o)=>{if(!at(o))throw new a("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Z(t))return ke();if(o.length>Re)return Promise.reject(new a("FILE_TOO_LARGE",`Content is over ${Re} characters.`));return P({channel:S,v:g,type:"file-write",id:u(c),payload:{path:t,content:o}}).then((n)=>{if(!lt(n))throw new a("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(Z(t)?P({channel:S,v:g,type:"file-list",id:u(c),payload:{path:t}}):ke()).then((o)=>{if(!ct(o))throw new a("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Z(t)?P({channel:S,v:g,type:"file-stat",id:u(c),payload:{path:t}}):ke()).then((o)=>{if(!ut(o))throw new a("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>ve)return Promise.reject(new a("HOST_REJECTED",`Prompt must be 1 to ${ve} characters.`));if(n!==void 0&&(n.length===0||n.length>Oe))return Promise.reject(new a("HOST_REJECTED",`System prompt must be 1 to ${Oe} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(et,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new a("HOST_REJECTED","maxOutputTokens must be a number."));let f={prompt:o};if(n!==void 0)f.system=n;if(i!==void 0)f.maxOutputTokens=i;return P({channel:S,v:g,type:"generate",id:u(c),payload:f},e.requestTimeoutMs??tt).then((m)=>{if(!pt(m))throw new a("HOST_REJECTED","Host did not return generated text.");return m})},onLateGenerateResult:(t)=>{j.add(t);for(let o of Le.splice(0))T([t],o);return At(),()=>{j.delete(t)}},setBadge:(t)=>R({channel:S,v:g,type:"badge",id:u(c),payload:{count:st(t)}}),setHeight:(t)=>R({channel:S,v:g,type:"resize",id:u(c),payload:{height:nt(t)}}),onFileOpen:(t)=>{if(de.add(t),!Ne)Ne=!0,r.addEventListener("keydown",Pt,!0);if(ie)t(ie);return()=>{de.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(Se.add(t),()=>{Se.delete(t)}),reportFileChange:(t)=>He({...v,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Gt,reportFileUnsupported:()=>He({...v,type:"file-unsupported"}),dispose:()=>{for(let t of K.keys())w({...v,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:t}});K.clear();for(let t of J.keys())w({...v,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:t}});if(J.clear(),H=!0,re=null,se=null,ne=null,de.clear(),Se.clear(),Ne)r.removeEventListener("keydown",Pt,!0);r.removeEventListener("message",kt),r.removeEventListener("keydown",Mt,!0),r.removeEventListener("pointerover",Ee),r.removeEventListener("pointermove",Ee),r.removeEventListener("pointerout",It),r.removeEventListener("focus",wt),r.removeEventListener("blur",Ut);for(let t of z.values())clearTimeout(t.timer),t.reject(new a("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),d.clear(),E.clear(),C.clear(),h.clear(),A.clear(),I.clear(),X.clear(),ue.clear(),pe.clear(),j.clear(),Le.length=0}}};var Eo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var fr=new Set(Eo);var mo=["none","agent","user"];var _r=new Set(mo);var No=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Ho=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],fo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,p]of No)r.style.setProperty(s,e.tokens[p]);for(let[s,p,d]of Ho){let E=e.tokens[d]??"";r.style.setProperty(s,E),r.style.setProperty(p,E)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},gt=(e,r)=>{if(fo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Do={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${Do[e]}, ${r}))`,B=y("surface-background","transparent"),Me=y("surface-elevated","transparent"),ee=y("surface-elevated-foreground","inherit"),L=y("surface-foreground","inherit"),_=y("surface-muted-foreground","gray"),Fo=y("surface-muted","transparent"),V=y("interactive-border","currentColor"),M=y("interactive-hover","transparent"),W=y("interactive-active","transparent"),Et=y("interactive-selection","transparent"),mt=y("interactive-selection-foreground","inherit"),F=y("primary","currentColor"),ft=y("primary-text","inherit"),ht=y("error-text","inherit"),Bo=y("font-sans","inherit"),_t=y("font-mono","monospace"),bo=y("radius","9px"),yt=`calc(${bo} - 2px)`,ho=`calc(${bo} - 4px)`,b=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,_o=`background-image: linear-gradient(${M}, ${M});`,Tt=(e)=>`box-shadow: inset 0 0 0 1px ${e}, var(--oc-sdk-field-lift);`,bt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",yo="box-shadow: var(--oc-sdk-lit);",To=`inset 0 1px 0 0 ${b(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2)`,Xo=`
:root {
  --oc-sdk-edge: ${b(L,10)};
  --oc-sdk-field-bg: ${Me};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 2px 0 rgb(0 0 0 / 0.06);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.45), 0 1px 2px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.1);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.8), inset 0 0 0 1px rgb(0 0 0 / 0.04), 0 1px 2px -0.5px rgb(0 0 0 / 0.08), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.08);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${b(L,6)};
  --oc-sdk-field-bg: ${b(B,50,Me)};
  --oc-sdk-raised-bg: ${Me};
  --oc-sdk-field-lift: ${To};
  --oc-sdk-raised-lift: ${To};
  --oc-sdk-lit: inset 0 1px 0 0 ${b(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.36);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 1px 1px -0.5px rgb(0 0 0 / 0.22), 0 3px 3px -1.5px rgb(0 0 0 / 0.2), 0 6px 6px -3px rgb(0 0 0 / 0.16);
}`,Pe=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},Vo=`
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

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,xo=`${Xo}
.oc-sdk { color: ${L}; font-family: ${Bo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${_o} }
.oc-sdk-mono { font-family: ${_t}; }
.oc-sdk-muted { color: ${_}; }
${Pe("success")}${Pe("warning")}${Pe("error")}${Pe("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${ft}; }

.oc-sdk-btn { border-radius: ${yt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${ho}; }
.oc-sdk-btn[data-variant="default"] { color: ${ft}; background: ${b(F,10,B)}; border-color: ${b(F,12)}; ${yo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${b(F,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${b(F,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Fo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${ee}; ${bt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${W}, ${W}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${M}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${W}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${ht}; background: ${b("var(--oc-sdk-tone)",7,B)}; border-color: ${b("var(--oc-sdk-tone)",12)}; ${yo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${b("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${b("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${_}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${ht}; }
.oc-sdk-input { border-radius: ${yt}; background: var(--oc-sdk-field-bg); color: ${ee}; ${Tt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${_}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Tt(b(L,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Tt(y("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${_t}; }

.oc-sdk-search-icon { color: ${_}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${ho}; color: ${_}; }
.oc-sdk-search-clear:hover { background: ${M}; color: ${L}; }

.oc-sdk-trigger { border-radius: ${yt}; background: var(--oc-sdk-raised-bg); color: ${ee}; ${bt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${_}; }
.oc-sdk-trigger-chevron { color: ${_}; }
/* The app's dropdown light: lit top, hairline rings and a layered shadow. Its outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${ee}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Me}; background-clip: padding-box; color: ${ee}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${M}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Et}; color: ${mt}; }
.oc-sdk-option-check { color: ${L}; }
.oc-sdk-option[data-destructive="true"] { color: ${ht}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${b(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${_}; }
.oc-sdk-popup-empty { color: ${_}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${V}; border-radius: 4px; color: ${L}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${b(L,60,V)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${V}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${_o} }
.oc-sdk-check-desc { color: ${_}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${b(L,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${_}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${L}; }
.oc-sdk-tab[aria-selected="true"] { color: ${mt}; background: ${Et}; border-color: ${V}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${ee}; background: var(--oc-sdk-raised-bg); ${bt} }
.oc-sdk-tab-count { color: ${_}; }

.oc-sdk-badge { border-radius: 9999px; background: ${M}; color: ${_}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${b("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${Et}; color: ${mt}; }
.oc-sdk-row-lead { font-family: ${_t}; color: ${_}; }
.oc-sdk-row-sub { color: ${_}; }
.oc-sdk-row-meta { color: ${_}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${_}; }

.oc-sdk-empty-body { color: ${_}; }

.oc-sdk-spinner { color: ${_}; }
.oc-sdk-spinner-ring { border-color: ${V}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${b("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${_}; }

.oc-sdk-separator { color: ${_}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${b(V,40)}; }

.oc-sdk-progress-label { color: ${_}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${V}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }

.oc-sdk-text a { color: ${ft}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${b(V,60)}; }
`,k=`
${Be}
${Vo}
${xo}`;var Ro="oc-sdk-ui-style";var G=(e)=>{let r=document.getElementById(Ro);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Xe(document);let s=document.createElement("style");s.id=Ro,s.textContent=e,document.head.appendChild(s)},x=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},q=(e)=>{let r=x("button",e);return r.type="button",r},U=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s},te=(e,r,s)=>{if(s===void 0||s===null||s==="")e.removeAttribute(r);else if(e.getAttribute(r)!==s)e.setAttribute(r,s)};var $o=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},oe=(e,r)=>{G(k);let s=r,p=q("oc-sdk oc-sdk-btn"),d=$o(),E=document.createElement("span");p.append(E),e.append(p);let C=()=>{if(p.dataset.variant=s.variant??"default",p.dataset.size=s.size??"default",p.disabled=Boolean(s.disabled)||Boolean(s.loading),p.dataset.loading=s.loading?"true":"false",p.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&d.parentNode!==p)p.prepend(d);else if(!s.loading&&d.parentNode===p)d.remove();U(E,s.label)},h=()=>{if(s.disabled||s.loading)return;s.onClick()};return p.addEventListener("click",h),C(),{update:(A)=>{s={...s,...A},C()},dispose:()=>{p.removeEventListener("click",h),p.remove()}}};var xt=(e,r)=>{G(k);let s=r,p=x("label","oc-sdk oc-sdk-field"),d=x("span","oc-sdk-field-label"),E=s.multiline?x("textarea","oc-sdk-input"):x("input","oc-sdk-input"),C=x("span","oc-sdk-field-note");p.append(d,E,C),e.append(p);let h=()=>{if(U(d,s.label),d.hidden=!s.label,E instanceof HTMLInputElement)E.type=s.password?"password":"text";else E.rows=s.rows??3;if(E.value!==s.value)E.value=s.value;E.disabled=Boolean(s.disabled),te(E,"placeholder",s.placeholder),E.dataset.mono=s.mono?"true":"false";let I=Boolean(s.error);p.dataset.invalid=I?"true":"false",E.setAttribute("aria-invalid",I?"true":"false");let X=s.error??s.helper??"";U(C,X),C.hidden=X===""},A=()=>{s.onChange(E.value)};return E.addEventListener("input",A),h(),{update:(I)=>{s={...s,...I},h()},dispose:()=>{E.removeEventListener("input",A),p.remove()}}};var vt=St(),Oo=document.querySelector("#root");if(!Oo)throw Error("Missing root");var vo=!1;vt.onReady((e)=>{if(gt(e,document.documentElement),vo)return;vo=!0;let r=document.createElement("div");r.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",Oo.append(r);let s="",p=document.createElement("div");p.style.flex="1",r.append(p);let d=xt(p,{value:s,placeholder:"https://example.com",mono:!0,onChange:(h)=>{s=h,d.update({value:h})}}),E=oe(r,{label:"Go",size:"sm",onClick:()=>{if(!s.trim())return;E.update({loading:!0}),vt.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:s.trim()})}).then(()=>C()).finally(()=>E.update({loading:!1}))}}),C=async()=>{try{let h=await vt.serviceRequest({method:"GET",path:"/state"}),A=JSON.parse(h.body);if(String(A.url)===A.url&&A.url!==s)s=A.url==="about:blank"?"":A.url,d.update({value:s})}catch{}};C(),setInterval(()=>{C()},2000)});})();
