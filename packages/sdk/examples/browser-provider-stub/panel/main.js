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
`;function Ve(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(p)=>{let d=p.target===e?r:p.target;if(!(d instanceof Element))return;if(!d.hasAttribute("data-oc-scrolling"))d.setAttribute("data-oc-scrolling","");let E=s.get(d);if(E!==void 0)clearTimeout(E);s.set(d,setTimeout(()=>{s.delete(d),d.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var ko=`(${Ve.toString()})(document);`;var Xe=128,qe=65536;var fe=128;var _e=65536;var Vt=/^[a-z][a-z0-9-]{0,39}$/;var Dt=(e)=>Object(e)===e&&!Array.isArray(e),$e=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Ft=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Bt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Xt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Dt(s)||!Vt.test(s.id)||!Ft(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!$e(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!$e(s,["kind","id","label","value","options","disabled"]))return!1;if(!Bt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let p=new Set;for(let d of s.options){if(!Dt(d)||!$e(d,["value","label"])||!Bt(d.value)||!Ft(d.label)||p.has(d.value))return!1;p.add(d.value)}if(!p.has(s.value))return!1}return!0};var qt=["turn-finished","turn-failed","permission-asked","question-asked"];var ir=new Set(qt);var Te=20000000,ye=256;var We=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,$t=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var Wt=/^[A-Za-z0-9_-]{1,80}$/;var jt=["left","right","top","bottom"];var zt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let p=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let d of p)if(!zt(d,r+1,s))return!1;return!0},je=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(je);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(je)}return String(e)===e||Number.isFinite(e)},ze=(e)=>{try{if(String(e.id)!==e.id||!Wt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!jt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!zt(e.data)||!je(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var Jt=["file","directory","other","missing"],Je=(e)=>Boolean(e&&"sessionId"in e),Ye=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Yt=/^[0-9a-f]{7,64}$/i,Qe=(e)=>Yt.test(e),he=500,be=32000,Qt=16000,Zt=128,eo=200,to=2000,oo=16000,ro=80,so=200,no=16000;var io=2000;var Ze=20000,xe=1024,Re=2000000;var ve=64000,Oe=8000,et=4000;var tt=960000;var ao=999,lo=1e4,ue=500,uo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],co=["stopped","starting","ready","failed"],Io=new Set(uo),po=(e)=>Io.has(e),So=(e)=>e&&po(e)?e:"HOST_REJECTED",Y=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(Y);if(Object(e)===e)return Object.values(e).every(Y);return!1},go=(e)=>Y(e)&&JSON.stringify(e).length<=no,Kt=(e)=>e?.trim().slice(0,so)??"",Q=(e)=>{let r=e.id.trim().slice(0,Zt),s=e.title.trim().slice(0,eo),p=e.url.trim().slice(0,to),d=e.text?.trim().slice(0,oo),E=e.author?.trim().slice(0,ro),C=e.kind==="pull"?"pull":"issue",_={providerId:e.providerId.trim(),id:r,title:s||r,url:p,kind:C};if(d)_.text=d;if(E)_.author=E;if(C==="pull"){let A=Kt(e.branches?.head),M=Kt(e.branches?.base);if(A&&M)_.branches={head:A,base:M}}if(go(e.data))_.data=e.data;return _},ot=(e)=>{let r=Q(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},rt=(e)=>{let r={text:e.text.trim().slice(0,Qt)};if(e.send)r.send=!0;return r},st=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(ao,Math.max(0,Math.round(e)))},nt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(lo,Math.max(0,Math.ceil(e)))};var Z=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var Ce=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>io)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Po=new Set(co),it=(e)=>Boolean(e&&"status"in e&&Po.has(String(e.status))&&!("body"in e)),Ae=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),at=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),lt=(e)=>Boolean(e&&"written"in e&&e.written===!0),ut=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Mo=new Set(Jt),ct=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Mo.has(String(e.kind))&&Number.isFinite(e.size)),pt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),wo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Uo=(e)=>Object(e)===e?e:null,Ke=(e)=>String(e)===e&&e.length>0,No=(e)=>{if(!Ke(e.id))return null;if(e.ok===!0){let r={channel:S,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ke(e.error))return{channel:S,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:So(Ke(e.code)?e.code:void 0)};return null},dt=(e)=>{let r=Uo(e);if(!r||r.channel!==S||r.v!==g)return null;if(r.type==="result")return No(r);if(!wo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var Eo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Lo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class a extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var mo=()=>Promise.reject(new a("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),ke=()=>Promise.reject(new a("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Ge=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new a("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},c=(e)=>(e.value+=1,`oc-${e.value}`),St=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new a("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),p=e.requestTimeoutMs??Ze,d=new Set,E=new Set,C=new Set,_=new Set,A=new Set,M=new Set,V=new Set,ce=new Set,pe=new Set,j=new Set,Ne=[],re=null,se=null,de=new Set,Se=new Set,ne=null,ie=null,Le=!1,z=new Map,K=new Map,J=new Map,H=!1,u={value:0},l=null,D=null,ae=!1,le=!1,Ct=null,At=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},kt=()=>{if(H||r.parent===r||j.size===0||l?.features?.lateGenerateResults!==!0)return;w({channel:S,v:g,type:"generate-late-listen"})},h=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Gt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=dt(t.data);if(!o)return;if(o.type==="workspace"){let i=K.get(o.payload.subscriptionId);if(i)h([i],o.payload.snapshot);return}if(o.type==="shells"){let i=J.get(o.payload.subscriptionId);if(i)h([i],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,D=At(o.payload.session),h(d,o.payload),h(E,o.payload.directory),h(C,o.payload.session),D)h(_,D);h(A,o.payload.connection),h(M,o.payload.settings),h(V,o.payload.item),kt();return}if(o.type==="generate-late"){if(j.size===0)Ne.push(o.payload);else h(j,o.payload);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};h(E,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=At(o.payload.session);h(C,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,h(_,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};h(A,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};h(M,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};h(V,o.payload.item);return}if(o.type==="status-control-event"){h(ce,o.payload);return}if(o.type==="popover-closed"){h(pe,o.payload);return}if(o.type==="action"){let i=(m)=>{if(!H)w({channel:S,v:g,type:"action-result",id:o.id,payload:m})},f=se;if(!f){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>f(o.payload)).then(()=>i({ok:!0}),(m)=>{let v=(m instanceof Error?m.message:String(m)).trim();i({ok:!1,error:(v||"Action failed.").slice(0,ue)})});return}if(o.type==="file-open"){let i=o.payload;if(ie&&$t(ie,i))return;ie=i,h(de,o.payload);return}if(o.type==="file-saved"){h(Se,o.payload.version);return}if(o.type==="file-snapshot"){let i=(v)=>{if(!H)w({channel:S,v:g,type:"file-snapshot-result",id:o.id,payload:v})},f=(v)=>i({error:(v.trim()||"Could not read the edited file.").slice(0,ue)}),m=ne;if(!m){f("This extension does not edit files.");return}Promise.resolve().then(()=>m(o.payload.purpose)).then((v)=>{if(We(v)>Te){f(`The file is over ${Te} ${"bytes"in v?"bytes":"characters"}.`);return}if(v.version.length>ye){f(`The snapshot version is over ${ye} characters.`);return}i({snapshot:"bytes"in v?{bytes:v.bytes,version:v.version}:{content:v.content,version:v.version}})},(v)=>f(v instanceof Error?v.message:String(v)));return}if(o.type==="resolve"){let i=(m)=>{w({channel:S,v:g,type:"resolve-result",id:o.id,payload:m})},f=re;if(!f){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>f(o.payload)).then((m)=>i({item:m?Q(m):null}),(m)=>{let v=(m instanceof Error?m.message:String(m)).trim();i({error:(v||"Command failed.").slice(0,ue)})});return}let n=z.get(o.id);if(!n)return;if(clearTimeout(n.timer),z.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new a(o.code,o.error))};r.addEventListener("message",Gt),w({channel:S,v:g,type:"hello"});let I=(t,o=p)=>{if(H||r.parent===r)return Promise.reject(new a("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let f=setTimeout(()=>{z.delete(t.id),i(new a("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:n,reject:i,timer:f}),w(t)})},x=(t)=>I(t).then(()=>{return}),R={channel:S,v:g},He=(t)=>{if(!H&&r.parent!==r)w(t)},It=()=>He({...R,type:"file-save"}),Pt=(t)=>{if(!Eo(t)||!Lo(t))return;t.preventDefault(),It()},Mt=(t)=>{if(!Eo(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),Lt(l.popover.id,"escape").catch(()=>{return})},ge=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=ae||le;if(Ct===o)return;Ct=o,Ht(t.id,o).catch(()=>{return})},Ee=()=>{if(l?.surface!=="popover"||ae)return;ae=!0,ge()},wt=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!ae)return;ae=!1,ge()},Ut=()=>{if(l?.surface!=="popover"||le)return;le=!0,ge()},Nt=()=>{if(l?.surface!=="popover"||!le)return;le=!1,ge()},N=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new a("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},De=async(t)=>{if(t.kind!=="projects")N(t.projectId);let o=await I({...R,type:"workspace-read",id:c(u),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new a("HOST_REJECTED","Host did not return workspace data.");return o},Fe=async(t,o)=>{if(t.kind!=="projects")N(t.projectId);let n=c(u);K.set(n,o);try{await x({...R,type:"workspace-subscribe",id:c(u),payload:{subscriptionId:n,query:t}})}catch(i){if(K.delete(n),!H)w({...R,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:n}});throw i}return()=>{if(!K.delete(n)||H)return;w({...R,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:n}})}},Ao=async(t,o)=>{if(t.kind==="session")N(t.sessionId);if(t.kind==="project")N(t.projectId);let n=c(u);J.set(n,o);try{await x({...R,type:"shells-subscribe",id:c(u),payload:{subscriptionId:n,scope:t}})}catch(i){if(J.delete(n),!H)w({...R,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:n}});throw i}return()=>{if(!J.delete(n)||H)return;w({...R,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:n}})}},me=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Xe))throw new a("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!Y(t.value))throw new a("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>qe)throw new a("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new a("UNSUPPORTED","This host does not support device storage.");let o=await I({...R,type:"storage",id:c(u),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new a("HOST_REJECTED","Host did not return storage data.");return o},Lt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...R,type:"popover-close",id:c(u),payload:o?{id:t,reason:o}:{id:t}}),Ht=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...R,type:"popover-anchor",id:c(u),payload:{id:t,active:o}});return r.addEventListener("keydown",Mt,!0),r.addEventListener("pointerover",Ee),r.addEventListener("pointermove",Ee),r.addEventListener("pointerout",wt),r.addEventListener("focus",Ut),r.addEventListener("blur",Nt),{onAction:(t)=>(se=t,()=>{if(se===t)se=null}),listProjects:async()=>{let t=await De({kind:"projects"});if(t.kind!=="projects")throw new a("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await De({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new a("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await De({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new a("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Fe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Fe({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Fe({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Ao(t,o),readShellOutput:async(t,o)=>{N(t,fe);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new a("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>_e))throw new a("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${_e}.`);let m=await I({...R,type:"shell-output",id:c(u),payload:{shellId:t,cursor:n,tailBytes:i}});if(!m||typeof m.output!=="string"||!Number.isFinite(m.cursor))throw new a("HOST_REJECTED","Host did not return shell output.");return m},stopShell:async(t)=>{if(N(t,fe),(await I({...R,type:"shell-stop",id:c(u),payload:{shellId:t}}))?.stopped!==!0)throw new a("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{N(t),await x({...R,type:"open-session",id:c(u),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Ge(o),i={op:"get",key:t};if(n)i.scope=n;let f=await me(i);return f.op==="get"&&f.found?f.value:void 0},set:async(t,o,n)=>{let i=Ge(n),f={op:"set",key:t,value:o};if(i)f.scope=i;await me(f)},delete:async(t,o)=>{let n=Ge(o),i={op:"delete",key:t};if(n)i.scope=n;await me(i)},keys:async(t)=>{let o=Ge(t),n={op:"keys"};if(o)n.scope=o;let i=await me(n);if(i.op!=="keys")throw new a("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(d.add(t),l)t(l);return()=>{d.delete(t)}},onDirectory:(t)=>{if(E.add(t),l)t(l.directory);return()=>{E.delete(t)}},onSession:(t)=>{if(C.add(t),l)t(l.session);return()=>{C.delete(t)}},onSessionLifecycle:(t)=>{if(_.add(t),D)t(D);return()=>{_.delete(t)}},onConnection:(t)=>{if(A.add(t),l)t(l.connection);return()=>{A.delete(t)}},onSettings:(t)=>{if(M.add(t),l)t(l.settings);return()=>{M.delete(t)}},onItem:(t)=>{if(V.add(t),l)t(l.item);return()=>{V.delete(t)}},onStatusControl:(t)=>(ce.add(t),()=>{ce.delete(t)}),onPopoverClosed:(t)=>(pe.add(t),()=>{pe.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support status controls."));if(!Xt(t))return Promise.reject(new a("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...R,type:"status-controls",id:c(u),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support popovers."));if(!ze(t))return Promise.reject(new a("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...R,type:"popover-open",id:c(u),payload:t})},closePopover:Lt,setPopoverAnchorActive:Ht,onResolve:(t)=>(re=t,()=>{if(re===t)re=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>he)return Promise.reject(new a("HOST_REJECTED",`Toast message must contain 1 to ${he} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>be))return Promise.reject(new a("HOST_REJECTED",`Toast copy text must contain 1 to ${be} characters.`));return x({channel:S,v:g,type:"toast",id:c(u),payload:{...t,message:o}})},openUrl:(t)=>x({channel:S,v:g,type:"open-url",id:c(u),payload:{url:t}}),openCommit:(t)=>Qe(t)?x({channel:S,v:g,type:"open-commit",id:c(u),payload:{sha:t}}):Promise.reject(new a("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>x({channel:S,v:g,type:"open-surface",id:c(u),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:S,v:g,type:"clipboard-write",id:c(u),payload:{text:t}}),compose:(t)=>x({channel:S,v:g,type:"compose",id:c(u),payload:t}),attach:(t)=>x({channel:S,v:g,type:"attach",id:c(u),payload:Q(t)}),startSession:async(t)=>{if(t.projectId!==void 0)N(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")N(o.directory);else{if(o.name!==void 0)N(o.name,200);if(o.baseBranch!==void 0)N(o.baseBranch,200)}let n=await I({channel:S,v:g,type:"start-session",id:c(u),payload:ot(t)},e.requestTimeoutMs??180000);if(!Je(n))throw new a("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>I({channel:S,v:g,type:"prompt",id:c(u),payload:rt(t)}).then((o)=>{if(!Ye(o))throw new a("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:S,v:g,type:"session-link",id:c(u),payload:Q(t)}),close:()=>x({channel:S,v:g,type:"close",id:c(u)}),oauthStart:()=>x({channel:S,v:g,type:"oauth-start",id:c(u)}),oauthDisconnect:()=>x({channel:S,v:g,type:"oauth-disconnect",id:c(u)}),request:(t)=>(Ce(t.path)?I({channel:S,v:g,type:"request",id:c(u),payload:t}):mo()).then((o)=>{if(!Ae(o))throw new a("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ce(t.path)?I({channel:S,v:g,type:"service-request",id:c(u),payload:t}):mo()).then((o)=>{if(!Ae(o))throw new a("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>I({channel:S,v:g,type:"service-status",id:c(u)}).then((t)=>{if(!it(t))throw new a("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Z(t)?I({channel:S,v:g,type:"file-read",id:c(u),payload:{path:t}}):ke()).then((o)=>{if(!at(o))throw new a("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Z(t))return ke();if(o.length>Re)return Promise.reject(new a("FILE_TOO_LARGE",`Content is over ${Re} characters.`));return I({channel:S,v:g,type:"file-write",id:c(u),payload:{path:t,content:o}}).then((n)=>{if(!lt(n))throw new a("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(Z(t)?I({channel:S,v:g,type:"file-list",id:c(u),payload:{path:t}}):ke()).then((o)=>{if(!ut(o))throw new a("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Z(t)?I({channel:S,v:g,type:"file-stat",id:c(u),payload:{path:t}}):ke()).then((o)=>{if(!ct(o))throw new a("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>ve)return Promise.reject(new a("HOST_REJECTED",`Prompt must be 1 to ${ve} characters.`));if(n!==void 0&&(n.length===0||n.length>Oe))return Promise.reject(new a("HOST_REJECTED",`System prompt must be 1 to ${Oe} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(et,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new a("HOST_REJECTED","maxOutputTokens must be a number."));let f={prompt:o};if(n!==void 0)f.system=n;if(i!==void 0)f.maxOutputTokens=i;return I({channel:S,v:g,type:"generate",id:c(u),payload:f},e.requestTimeoutMs??tt).then((m)=>{if(!pt(m))throw new a("HOST_REJECTED","Host did not return generated text.");return m})},onLateGenerateResult:(t)=>{j.add(t);for(let o of Ne.splice(0))h([t],o);return kt(),()=>{j.delete(t)}},setBadge:(t)=>x({channel:S,v:g,type:"badge",id:c(u),payload:{count:st(t)}}),setHeight:(t)=>x({channel:S,v:g,type:"resize",id:c(u),payload:{height:nt(t)}}),onFileOpen:(t)=>{if(de.add(t),!Le)Le=!0,r.addEventListener("keydown",Pt,!0);if(ie)t(ie);return()=>{de.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(Se.add(t),()=>{Se.delete(t)}),reportFileChange:(t)=>He({...R,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:It,reportFileUnsupported:()=>He({...R,type:"file-unsupported"}),dispose:()=>{for(let t of K.keys())w({...R,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:t}});K.clear();for(let t of J.keys())w({...R,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:t}});if(J.clear(),H=!0,re=null,se=null,ne=null,de.clear(),Se.clear(),Le)r.removeEventListener("keydown",Pt,!0);r.removeEventListener("message",Gt),r.removeEventListener("keydown",Mt,!0),r.removeEventListener("pointerover",Ee),r.removeEventListener("pointermove",Ee),r.removeEventListener("pointerout",wt),r.removeEventListener("focus",Ut),r.removeEventListener("blur",Nt);for(let t of z.values())clearTimeout(t.timer),t.reject(new a("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),d.clear(),E.clear(),C.clear(),_.clear(),A.clear(),M.clear(),V.clear(),ce.clear(),pe.clear(),j.clear(),Ne.length=0}}};var fo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var yr=new Set(fo);var _o=["none","agent","user"];var br=new Set(_o);var Ho=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Do=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],To=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,p]of Ho)r.style.setProperty(s,e.tokens[p]);for(let[s,p,d]of Do){let E=e.tokens[d]??"";r.style.setProperty(s,E),r.style.setProperty(p,E)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},gt=(e,r)=>{if(To(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Fo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${Fo[e]}, ${r}))`,B=y("surface-background","transparent"),Pe=y("surface-elevated","transparent"),ee=y("surface-elevated-foreground","inherit"),L=y("surface-foreground","inherit"),T=y("surface-muted-foreground","gray"),Bo=y("surface-muted","transparent"),X=y("interactive-border","currentColor"),P=y("interactive-hover","transparent"),W=y("interactive-active","transparent"),Et=y("interactive-selection","transparent"),mt=y("interactive-selection-foreground","inherit"),F=y("primary","currentColor"),ft=y("primary-text","inherit"),_t=y("error-text","inherit"),Vo=y("font-sans","inherit"),Tt=y("font-mono","monospace"),xo=y("radius","9px"),yt=`calc(${xo} - 2px)`,yo=`calc(${xo} - 4px)`,O=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,ho=`background-image: linear-gradient(${P}, ${P});`,ht=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,bt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",bo="box-shadow: var(--oc-sdk-lit);",xt=`inset 0 0.5px 0 0 ${O(L,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,Xo=`
:root {
  --oc-sdk-edge: ${O(L,16)};
  --oc-sdk-field-bg: ${Pe};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${O(L,14)};
  --oc-sdk-field-bg: ${O(B,50,Pe)};
  --oc-sdk-raised-bg: ${Pe};
  --oc-sdk-field-lift: ${xt};
  --oc-sdk-raised-lift: ${xt};
  --oc-sdk-lit: ${xt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ie=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},qo=`
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
`,Ro=`${Xo}
.oc-sdk { color: ${L}; font-family: ${Vo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${ho} }
.oc-sdk-mono { font-family: ${Tt}; }
.oc-sdk-muted { color: ${T}; }
${Ie("success")}${Ie("warning")}${Ie("error")}${Ie("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${ft}; }

.oc-sdk-btn { border-radius: ${yt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${yo}; }
.oc-sdk-btn[data-variant="default"] { color: ${ft}; background: ${O(F,10,B)}; border-color: ${O(F,12)}; ${bo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${O(F,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${O(F,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Bo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${ee}; ${bt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${W}, ${W}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${P}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${W}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${_t}; background: ${O("var(--oc-sdk-tone)",7,B)}; border-color: ${O("var(--oc-sdk-tone)",12)}; ${bo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${O("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${O("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${T}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${_t}; }
.oc-sdk-input { border-radius: ${yt}; background: var(--oc-sdk-field-bg); color: ${ee}; ${ht("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${T}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${ht(O(L,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${ht(y("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Tt}; }

.oc-sdk-search-icon { color: ${T}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${yo}; color: ${T}; }
.oc-sdk-search-clear:hover { background: ${P}; color: ${L}; }

.oc-sdk-trigger { border-radius: ${yt}; background: var(--oc-sdk-raised-bg); color: ${ee}; ${bt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${W}, ${W}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${T}; }
.oc-sdk-trigger-chevron { color: ${T}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${ee}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Pe}; background-clip: padding-box; color: ${ee}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${P}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Et}; color: ${mt}; }
.oc-sdk-option-check { color: ${L}; }
.oc-sdk-option[data-destructive="true"] { color: ${_t}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${O(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${T}; }
.oc-sdk-popup-empty { color: ${T}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${X}; border-radius: 4px; color: ${L}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${O(L,60,X)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${X}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${ho} }
.oc-sdk-check-desc { color: ${T}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${O(L,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${T}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${L}; }
.oc-sdk-tab[aria-selected="true"] { color: ${mt}; background: ${Et}; border-color: ${X}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${ee}; background: var(--oc-sdk-raised-bg); ${bt} }
.oc-sdk-tab-count { color: ${T}; }

.oc-sdk-badge { border-radius: 9999px; background: ${P}; color: ${T}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${O("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${P}; }
.oc-sdk-row[aria-selected="true"] { background: ${Et}; color: ${mt}; }
.oc-sdk-row-lead { font-family: ${Tt}; color: ${T}; }
.oc-sdk-row-sub { color: ${T}; }
.oc-sdk-row-meta { color: ${T}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${T}; }

.oc-sdk-empty-body { color: ${T}; }

.oc-sdk-spinner { color: ${T}; }
.oc-sdk-spinner-ring { border-color: ${X}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${O("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${T}; }

.oc-sdk-separator { color: ${T}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${O(X,40)}; }

.oc-sdk-progress-label { color: ${T}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${X}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }

.oc-sdk-text a { color: ${ft}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${O(X,60)}; }
`,k=`
${Be}
${qo}
${Ro}`;var vo="oc-sdk-ui-style";var G=(e)=>{let r=document.getElementById(vo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ve(document);let s=document.createElement("style");s.id=vo,s.textContent=e,document.head.appendChild(s)},b=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},q=(e)=>{let r=b("button",e);return r.type="button",r},U=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s},te=(e,r,s)=>{if(s===void 0||s===null||s==="")e.removeAttribute(r);else if(e.getAttribute(r)!==s)e.setAttribute(r,s)};var $o=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},oe=(e,r)=>{G(k);let s=r,p=q("oc-sdk oc-sdk-btn"),d=$o(),E=document.createElement("span");p.append(E),e.append(p);let C=()=>{if(p.dataset.variant=s.variant??"default",p.dataset.size=s.size??"default",p.disabled=Boolean(s.disabled)||Boolean(s.loading),p.dataset.loading=s.loading?"true":"false",p.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&d.parentNode!==p)p.prepend(d);else if(!s.loading&&d.parentNode===p)d.remove();U(E,s.label)},_=()=>{if(s.disabled||s.loading)return;s.onClick()};return p.addEventListener("click",_),C(),{update:(A)=>{s={...s,...A},C()},dispose:()=>{p.removeEventListener("click",_),p.remove()}}};var Rt=(e,r)=>{G(k);let s=r,p=b("label","oc-sdk oc-sdk-field"),d=b("span","oc-sdk-field-label"),E=s.multiline?b("textarea","oc-sdk-input"):b("input","oc-sdk-input"),C=b("span","oc-sdk-field-note");p.append(d,E,C),e.append(p);let _=()=>{if(U(d,s.label),d.hidden=!s.label,E instanceof HTMLInputElement)E.type=s.password?"password":"text";else E.rows=s.rows??3;if(E.value!==s.value)E.value=s.value;E.disabled=Boolean(s.disabled),te(E,"placeholder",s.placeholder),E.dataset.mono=s.mono?"true":"false";let M=Boolean(s.error);p.dataset.invalid=M?"true":"false",E.setAttribute("aria-invalid",M?"true":"false");let V=s.error??s.helper??"";U(C,V),C.hidden=V===""},A=()=>{s.onChange(E.value)};return E.addEventListener("input",A),_(),{update:(M)=>{s={...s,...M},_()},dispose:()=>{E.removeEventListener("input",A),p.remove()}}};var Ot=St(),Co=document.querySelector("#root");if(!Co)throw Error("Missing root");var Oo=!1;Ot.onReady((e)=>{if(gt(e,document.documentElement),Oo)return;Oo=!0;let r=document.createElement("div");r.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",Co.append(r);let s="",p=document.createElement("div");p.style.flex="1",r.append(p);let d=Rt(p,{value:s,placeholder:"https://example.com",mono:!0,onChange:(_)=>{s=_,d.update({value:_})}}),E=oe(r,{label:"Go",size:"sm",onClick:()=>{if(!s.trim())return;E.update({loading:!0}),Ot.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:s.trim()})}).then(()=>C()).finally(()=>E.update({loading:!1}))}}),C=async()=>{try{let _=await Ot.serviceRequest({method:"GET",path:"/state"}),A=JSON.parse(_.body);if(String(A.url)===A.url&&A.url!==s)s=A.url==="about:blank"?"":A.url,d.update({value:s})}catch{}};C(),setInterval(()=>{C()},2000)});})();
