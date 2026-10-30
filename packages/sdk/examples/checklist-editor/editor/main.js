(()=>{var S="openchamber.sdk",g=1;var ze=`
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
`;function Ke(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(a)=>{let u=a.target===e?r:a.target;if(!(u instanceof Element))return;if(!u.hasAttribute("data-oc-scrolling"))u.setAttribute("data-oc-scrolling","");let E=s.get(u);if(E!==void 0)clearTimeout(E);s.set(u,setTimeout(()=>{s.delete(u),u.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Fo=`(${Ke.toString()})(document);`;var Je=128,Ye=65536;var he=128;var ye=65536;var Yt=/^[a-z][a-z0-9-]{0,39}$/;var zt=(e)=>Object(e)===e&&!Array.isArray(e),Qe=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Kt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Jt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Qt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!zt(s)||!Yt.test(s.id)||!Kt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!Qe(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!Qe(s,["kind","id","label","value","options","disabled"]))return!1;if(!Jt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let a=new Set;for(let u of s.options){if(!zt(u)||!Qe(u,["value","label"])||!Jt(u.value)||!Kt(u.label)||a.has(u.value))return!1;a.add(u.value)}if(!a.has(s.value))return!1}return!0};var Zt=["turn-finished","turn-failed","permission-asked","question-asked"];var _r=new Set(Zt);var be=20000000,xe=256;var Ze=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,eo=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0},ve=(e)=>{let r=e,s=e;return{observe:(a)=>{let u=a!==s;return s=a,{edited:u,dirty:a!==r}},markSaved:(a)=>(r=a,s!==a)}};var to=/^[A-Za-z0-9_-]{1,80}$/;var oo=["left","right","top","bottom"];var ro=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let a=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let u of a)if(!ro(u,r+1,s))return!1;return!0},et=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(et);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(et)}return String(e)===e||Number.isFinite(e)},tt=(e)=>{try{if(String(e.id)!==e.id||!to.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!oo.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!ro(e.data)||!et(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var no=["file","directory","other","missing"],rt=(e)=>Boolean(e&&"sessionId"in e),st=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var io=/^[0-9a-f]{7,64}$/i,nt=(e)=>io.test(e),Re=500,Oe=32000,ao=16000,lo=128,co=200,uo=2000,po=16000,So=80,go=200,Eo=16000;var mo=2000;var it=20000,Ce=1024,Ae=2000000;var ke=64000,Ge=8000,at=4000;var lt=960000;var fo=999,_o=1e4,de=500,To=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],ho=["stopped","starting","ready","failed"],Vo=new Set(To),yo=(e)=>Vo.has(e),bo=(e)=>e&&yo(e)?e:"HOST_REJECTED",ee=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ee);if(Object(e)===e)return Object.values(e).every(ee);return!1},xo=(e)=>ee(e)&&JSON.stringify(e).length<=Eo,so=(e)=>e?.trim().slice(0,go)??"",te=(e)=>{let r=e.id.trim().slice(0,lo),s=e.title.trim().slice(0,co),a=e.url.trim().slice(0,uo),u=e.text?.trim().slice(0,po),E=e.author?.trim().slice(0,So),_=e.kind==="pull"?"pull":"issue",m={providerId:e.providerId.trim(),id:r,title:s||r,url:a,kind:_};if(u)m.text=u;if(E)m.author=E;if(_==="pull"){let A=so(e.branches?.head),M=so(e.branches?.base);if(A&&M)m.branches={head:A,base:M}}if(xo(e.data))m.data=e.data;return m},ct=(e)=>{let r=te(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},ut=(e)=>{let r={text:e.text.trim().slice(0,ao)};if(e.send)r.send=!0;return r},pt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(fo,Math.max(0,Math.round(e)))},dt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(_o,Math.max(0,Math.ceil(e)))};var oe=(e)=>e.length>0&&e.length<=Ce&&!e.includes("\x00")&&!e.includes("\\");var Ie=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>mo)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Xo=new Set(ho),St=(e)=>Boolean(e&&"status"in e&&Xo.has(String(e.status))&&!("body"in e)),Pe=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),gt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),Et=(e)=>Boolean(e&&"written"in e&&e.written===!0),mt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),$o=new Set(no),ft=(e)=>Boolean(e&&"kind"in e&&"size"in e&&$o.has(String(e.kind))&&Number.isFinite(e.size)),_t=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),qo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Wo=(e)=>Object(e)===e?e:null,ot=(e)=>String(e)===e&&e.length>0,jo=(e)=>{if(!ot(e.id))return null;if(e.ok===!0){let r={channel:S,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&ot(e.error))return{channel:S,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:bo(ot(e.code)?e.code:void 0)};return null},Tt=(e)=>{let r=Wo(e);if(!r||r.channel!==S||r.v!==g)return null;if(r.type==="result")return jo(r);if(!qo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var vo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),zo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class l extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Ro=()=>Promise.reject(new l("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Me=()=>Promise.reject(new l("BAD_PATH",`File path must be 1 to ${Ce} characters without NUL or backslash.`)),we=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new l("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},d=(e)=>(e.value+=1,`oc-${e.value}`),ht=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new l("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),a=e.requestTimeoutMs??it,u=new Set,E=new Set,_=new Set,m=new Set,A=new Set,M=new Set,ne=new Set,Se=new Set,ge=new Set,J=new Set,Xe=[],ie=null,ae=null,Ee=new Set,me=new Set,le=null,ce=null,$e=!1,Y=new Map,Q=new Map,Z=new Map,H=!1,p={value:0},c=null,D=null,ue=!1,pe=!1,Nt=null,Lt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},Ht=()=>{if(H||r.parent===r||J.size===0||c?.features?.lateGenerateResults!==!0)return;w({channel:S,v:g,type:"generate-late-listen"})},b=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Dt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=Tt(t.data);if(!o)return;if(o.type==="workspace"){let i=Q.get(o.payload.subscriptionId);if(i)b([i],o.payload.snapshot);return}if(o.type==="shells"){let i=Z.get(o.payload.subscriptionId);if(i)b([i],o.payload.snapshot);return}if(o.type==="ready"){if(c=o.payload,D=Lt(o.payload.session),b(u,o.payload),b(E,o.payload.directory),b(_,o.payload.session),D)b(m,D);b(A,o.payload.connection),b(M,o.payload.settings),b(ne,o.payload.item),Ht();return}if(o.type==="generate-late"){if(J.size===0)Xe.push(o.payload);else b(J,o.payload);return}if(o.type==="directory"){if(c)c={...c,directory:o.payload.directory};b(E,o.payload.directory);return}if(o.type==="session"){if(c)c={...c,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=Lt(o.payload.session);b(_,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,b(m,o.payload);return}if(o.type==="connection"){if(c)c={...c,connection:o.payload.connection};b(A,o.payload.connection);return}if(o.type==="settings"){if(c)c={...c,settings:o.payload.settings};b(M,o.payload.settings);return}if(o.type==="item"){if(c)c={...c,item:o.payload.item};b(ne,o.payload.item);return}if(o.type==="status-control-event"){b(Se,o.payload);return}if(o.type==="popover-closed"){b(ge,o.payload);return}if(o.type==="action"){let i=(f)=>{if(!H)w({channel:S,v:g,type:"action-result",id:o.id,payload:f})},T=ae;if(!T){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>T(o.payload)).then(()=>i({ok:!0}),(f)=>{let R=(f instanceof Error?f.message:String(f)).trim();i({ok:!1,error:(R||"Action failed.").slice(0,de)})});return}if(o.type==="file-open"){let i=o.payload;if(ce&&eo(ce,i))return;ce=i,b(Ee,o.payload);return}if(o.type==="file-saved"){b(me,o.payload.version);return}if(o.type==="file-snapshot"){let i=(R)=>{if(!H)w({channel:S,v:g,type:"file-snapshot-result",id:o.id,payload:R})},T=(R)=>i({error:(R.trim()||"Could not read the edited file.").slice(0,de)}),f=le;if(!f){T("This extension does not edit files.");return}Promise.resolve().then(()=>f(o.payload.purpose)).then((R)=>{if(Ze(R)>be){T(`The file is over ${be} ${"bytes"in R?"bytes":"characters"}.`);return}if(R.version.length>xe){T(`The snapshot version is over ${xe} characters.`);return}i({snapshot:"bytes"in R?{bytes:R.bytes,version:R.version}:{content:R.content,version:R.version}})},(R)=>T(R instanceof Error?R.message:String(R)));return}if(o.type==="resolve"){let i=(f)=>{w({channel:S,v:g,type:"resolve-result",id:o.id,payload:f})},T=ie;if(!T){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>T(o.payload)).then((f)=>i({item:f?te(f):null}),(f)=>{let R=(f instanceof Error?f.message:String(f)).trim();i({error:(R||"Command failed.").slice(0,de)})});return}let n=Y.get(o.id);if(!n)return;if(clearTimeout(n.timer),Y.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new l(o.code,o.error))};r.addEventListener("message",Dt),w({channel:S,v:g,type:"hello"});let I=(t,o=a)=>{if(H||r.parent===r)return Promise.reject(new l("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let T=setTimeout(()=>{Y.delete(t.id),i(new l("HOST_TIMEOUT","Host did not answer in time."))},o);Y.set(t.id,{resolve:n,reject:i,timer:T}),w(t)})},x=(t)=>I(t).then(()=>{return}),v={channel:S,v:g},qe=(t)=>{if(!H&&r.parent!==r)w(t)},Ft=()=>qe({...v,type:"file-save"}),Bt=(t)=>{if(!vo(t)||!zo(t))return;t.preventDefault(),Ft()},Vt=(t)=>{if(!vo(t)||t.key!=="Escape"||c?.surface!=="popover"||!c.popover)return;t.preventDefault(),Wt(c.popover.id,"escape").catch(()=>{return})},fe=()=>{let t=c?.surface==="popover"?c.popover:void 0;if(!t)return;let o=ue||pe;if(Nt===o)return;Nt=o,jt(t.id,o).catch(()=>{return})},_e=()=>{if(c?.surface!=="popover"||ue)return;ue=!0,fe()},Xt=(t)=>{if(c?.surface!=="popover"||t.relatedTarget!==null||!ue)return;ue=!1,fe()},$t=()=>{if(c?.surface!=="popover"||pe)return;pe=!0,fe()},qt=()=>{if(c?.surface!=="popover"||!pe)return;pe=!1,fe()},N=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new l("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},We=async(t)=>{if(t.kind!=="projects")N(t.projectId);let o=await I({...v,type:"workspace-read",id:d(p),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new l("HOST_REJECTED","Host did not return workspace data.");return o},je=async(t,o)=>{if(t.kind!=="projects")N(t.projectId);let n=d(p);Q.set(n,o);try{await x({...v,type:"workspace-subscribe",id:d(p),payload:{subscriptionId:n,query:t}})}catch(i){if(Q.delete(n),!H)w({...v,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:n}});throw i}return()=>{if(!Q.delete(n)||H)return;w({...v,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:n}})}},Do=async(t,o)=>{if(t.kind==="session")N(t.sessionId);if(t.kind==="project")N(t.projectId);let n=d(p);Z.set(n,o);try{await x({...v,type:"shells-subscribe",id:d(p),payload:{subscriptionId:n,scope:t}})}catch(i){if(Z.delete(n),!H)w({...v,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:n}});throw i}return()=>{if(!Z.delete(n)||H)return;w({...v,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:n}})}},Te=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Je))throw new l("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ee(t.value))throw new l("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Ye)throw new l("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&c?.features?.deviceStorage!==!0)throw new l("UNSUPPORTED","This host does not support device storage.");let o=await I({...v,type:"storage",id:d(p),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new l("HOST_REJECTED","Host did not return storage data.");return o},Wt=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-close",id:d(p),payload:o?{id:t,reason:o}:{id:t}}),jt=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-anchor",id:d(p),payload:{id:t,active:o}});return r.addEventListener("keydown",Vt,!0),r.addEventListener("pointerover",_e),r.addEventListener("pointermove",_e),r.addEventListener("pointerout",Xt),r.addEventListener("focus",$t),r.addEventListener("blur",qt),{onAction:(t)=>(ae=t,()=>{if(ae===t)ae=null}),listProjects:async()=>{let t=await We({kind:"projects"});if(t.kind!=="projects")throw new l("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await We({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new l("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await We({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new l("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>je({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>je({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>je({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Do(t,o),readShellOutput:async(t,o)=>{N(t,he);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new l("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>ye))throw new l("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${ye}.`);let f=await I({...v,type:"shell-output",id:d(p),payload:{shellId:t,cursor:n,tailBytes:i}});if(!f||typeof f.output!=="string"||!Number.isFinite(f.cursor))throw new l("HOST_REJECTED","Host did not return shell output.");return f},stopShell:async(t)=>{if(N(t,he),(await I({...v,type:"shell-stop",id:d(p),payload:{shellId:t}}))?.stopped!==!0)throw new l("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{N(t),await x({...v,type:"open-session",id:d(p),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=we(o),i={op:"get",key:t};if(n)i.scope=n;let T=await Te(i);return T.op==="get"&&T.found?T.value:void 0},set:async(t,o,n)=>{let i=we(n),T={op:"set",key:t,value:o};if(i)T.scope=i;await Te(T)},delete:async(t,o)=>{let n=we(o),i={op:"delete",key:t};if(n)i.scope=n;await Te(i)},keys:async(t)=>{let o=we(t),n={op:"keys"};if(o)n.scope=o;let i=await Te(n);if(i.op!=="keys")throw new l("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(u.add(t),c)t(c);return()=>{u.delete(t)}},onDirectory:(t)=>{if(E.add(t),c)t(c.directory);return()=>{E.delete(t)}},onSession:(t)=>{if(_.add(t),c)t(c.session);return()=>{_.delete(t)}},onSessionLifecycle:(t)=>{if(m.add(t),D)t(D);return()=>{m.delete(t)}},onConnection:(t)=>{if(A.add(t),c)t(c.connection);return()=>{A.delete(t)}},onSettings:(t)=>{if(M.add(t),c)t(c.settings);return()=>{M.delete(t)}},onItem:(t)=>{if(ne.add(t),c)t(c.item);return()=>{ne.delete(t)}},onStatusControl:(t)=>(Se.add(t),()=>{Se.delete(t)}),onPopoverClosed:(t)=>(ge.add(t),()=>{ge.delete(t)}),setStatusControls:(t)=>{if(c?.features?.statusControls!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support status controls."));if(!Qt(t))return Promise.reject(new l("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...v,type:"status-controls",id:d(p),payload:{controls:t}})},openPopover:(t)=>{if(c?.features?.popovers!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support popovers."));if(!tt(t))return Promise.reject(new l("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...v,type:"popover-open",id:d(p),payload:t})},closePopover:Wt,setPopoverAnchorActive:jt,onResolve:(t)=>(ie=t,()=>{if(ie===t)ie=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Re)return Promise.reject(new l("HOST_REJECTED",`Toast message must contain 1 to ${Re} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Oe))return Promise.reject(new l("HOST_REJECTED",`Toast copy text must contain 1 to ${Oe} characters.`));return x({channel:S,v:g,type:"toast",id:d(p),payload:{...t,message:o}})},openUrl:(t)=>x({channel:S,v:g,type:"open-url",id:d(p),payload:{url:t}}),openCommit:(t)=>nt(t)?x({channel:S,v:g,type:"open-commit",id:d(p),payload:{sha:t}}):Promise.reject(new l("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>x({channel:S,v:g,type:"open-surface",id:d(p),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:S,v:g,type:"clipboard-write",id:d(p),payload:{text:t}}),compose:(t)=>x({channel:S,v:g,type:"compose",id:d(p),payload:t}),attach:(t)=>x({channel:S,v:g,type:"attach",id:d(p),payload:te(t)}),startSession:async(t)=>{if(t.projectId!==void 0)N(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")N(o.directory);else{if(o.name!==void 0)N(o.name,200);if(o.baseBranch!==void 0)N(o.baseBranch,200)}let n=await I({channel:S,v:g,type:"start-session",id:d(p),payload:ct(t)},e.requestTimeoutMs??180000);if(!rt(n))throw new l("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>I({channel:S,v:g,type:"prompt",id:d(p),payload:ut(t)}).then((o)=>{if(!st(o))throw new l("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:S,v:g,type:"session-link",id:d(p),payload:te(t)}),close:()=>x({channel:S,v:g,type:"close",id:d(p)}),oauthStart:()=>x({channel:S,v:g,type:"oauth-start",id:d(p)}),oauthDisconnect:()=>x({channel:S,v:g,type:"oauth-disconnect",id:d(p)}),request:(t)=>(Ie(t.path)?I({channel:S,v:g,type:"request",id:d(p),payload:t}):Ro()).then((o)=>{if(!Pe(o))throw new l("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ie(t.path)?I({channel:S,v:g,type:"service-request",id:d(p),payload:t}):Ro()).then((o)=>{if(!Pe(o))throw new l("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>I({channel:S,v:g,type:"service-status",id:d(p)}).then((t)=>{if(!St(t))throw new l("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(oe(t)?I({channel:S,v:g,type:"file-read",id:d(p),payload:{path:t}}):Me()).then((o)=>{if(!gt(o))throw new l("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!oe(t))return Me();if(o.length>Ae)return Promise.reject(new l("FILE_TOO_LARGE",`Content is over ${Ae} characters.`));return I({channel:S,v:g,type:"file-write",id:d(p),payload:{path:t,content:o}}).then((n)=>{if(!Et(n))throw new l("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(oe(t)?I({channel:S,v:g,type:"file-list",id:d(p),payload:{path:t}}):Me()).then((o)=>{if(!mt(o))throw new l("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(oe(t)?I({channel:S,v:g,type:"file-stat",id:d(p),payload:{path:t}}):Me()).then((o)=>{if(!ft(o))throw new l("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>ke)return Promise.reject(new l("HOST_REJECTED",`Prompt must be 1 to ${ke} characters.`));if(n!==void 0&&(n.length===0||n.length>Ge))return Promise.reject(new l("HOST_REJECTED",`System prompt must be 1 to ${Ge} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(at,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new l("HOST_REJECTED","maxOutputTokens must be a number."));let T={prompt:o};if(n!==void 0)T.system=n;if(i!==void 0)T.maxOutputTokens=i;return I({channel:S,v:g,type:"generate",id:d(p),payload:T},e.requestTimeoutMs??lt).then((f)=>{if(!_t(f))throw new l("HOST_REJECTED","Host did not return generated text.");return f})},onLateGenerateResult:(t)=>{J.add(t);for(let o of Xe.splice(0))b([t],o);return Ht(),()=>{J.delete(t)}},setBadge:(t)=>x({channel:S,v:g,type:"badge",id:d(p),payload:{count:pt(t)}}),setHeight:(t)=>x({channel:S,v:g,type:"resize",id:d(p),payload:{height:dt(t)}}),onFileOpen:(t)=>{if(Ee.add(t),!$e)$e=!0,r.addEventListener("keydown",Bt,!0);if(ce)t(ce);return()=>{Ee.delete(t)}},onFileSnapshot:(t)=>(le=t,()=>{if(le===t)le=null}),onFileSaved:(t)=>(me.add(t),()=>{me.delete(t)}),reportFileChange:(t)=>qe({...v,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Ft,reportFileUnsupported:()=>qe({...v,type:"file-unsupported"}),dispose:()=>{for(let t of Q.keys())w({...v,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:t}});Q.clear();for(let t of Z.keys())w({...v,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:t}});if(Z.clear(),H=!0,ie=null,ae=null,le=null,Ee.clear(),me.clear(),$e)r.removeEventListener("keydown",Bt,!0);r.removeEventListener("message",Dt),r.removeEventListener("keydown",Vt,!0),r.removeEventListener("pointerover",_e),r.removeEventListener("pointermove",_e),r.removeEventListener("pointerout",Xt),r.removeEventListener("focus",$t),r.removeEventListener("blur",qt);for(let t of Y.values())clearTimeout(t.timer),t.reject(new l("HOST_UNAVAILABLE","Host client was disposed."));Y.clear(),u.clear(),E.clear(),_.clear(),m.clear(),A.clear(),M.clear(),ne.clear(),Se.clear(),ge.clear(),J.clear(),Xe.length=0}}};var Oo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Pr=new Set(Oo);var Co=["none","agent","user"];var wr=new Set(Co);var Ko=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Jo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Ao=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,a]of Ko)r.style.setProperty(s,e.tokens[a]);for(let[s,a,u]of Jo){let E=e.tokens[u]??"";r.style.setProperty(s,E),r.style.setProperty(a,E)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},yt=(e,r)=>{if(Ao(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Yo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${Yo[e]}, ${r}))`,B=y("surface-background","transparent"),Ne=y("surface-elevated","transparent"),re=y("surface-elevated-foreground","inherit"),L=y("surface-foreground","inherit"),h=y("surface-muted-foreground","gray"),Qo=y("surface-muted","transparent"),V=y("interactive-border","currentColor"),P=y("interactive-hover","transparent"),j=y("interactive-active","transparent"),bt=y("interactive-selection","transparent"),xt=y("interactive-selection-foreground","inherit"),F=y("primary","currentColor"),vt=y("primary-text","inherit"),Rt=y("error-text","inherit"),Zo=y("font-sans","inherit"),Ot=y("font-mono","monospace"),Po=y("radius","9px"),Ct=`calc(${Po} - 2px)`,ko=`calc(${Po} - 4px)`,O=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,Go=`background-image: linear-gradient(${P}, ${P});`,At=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,kt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Io="box-shadow: var(--oc-sdk-lit);",Gt=`inset 0 0.5px 0 0 ${O(L,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,er=`
:root {
  --oc-sdk-edge: ${O(L,16)};
  --oc-sdk-field-bg: ${Ne};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${O(L,14)};
  --oc-sdk-field-bg: ${O(B,50,Ne)};
  --oc-sdk-raised-bg: ${Ne};
  --oc-sdk-field-lift: ${Gt};
  --oc-sdk-raised-lift: ${Gt};
  --oc-sdk-lit: ${Gt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ue=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},tr=`
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
`,Mo=`${er}
.oc-sdk { color: ${L}; font-family: ${Zo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Go} }
.oc-sdk-mono { font-family: ${Ot}; }
.oc-sdk-muted { color: ${h}; }
${Ue("success")}${Ue("warning")}${Ue("error")}${Ue("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${vt}; }

.oc-sdk-btn { border-radius: ${Ct}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${ko}; }
.oc-sdk-btn[data-variant="default"] { color: ${vt}; background: ${O(F,10,B)}; border-color: ${O(F,12)}; ${Io} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${O(F,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${O(F,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Qo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${re}; ${kt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${P}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${Rt}; background: ${O("var(--oc-sdk-tone)",7,B)}; border-color: ${O("var(--oc-sdk-tone)",12)}; ${Io} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${O("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${O("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${h}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Rt}; }
.oc-sdk-input { border-radius: ${Ct}; background: var(--oc-sdk-field-bg); color: ${re}; ${At("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${h}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${At(O(L,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${At(y("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Ot}; }

.oc-sdk-search-icon { color: ${h}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${ko}; color: ${h}; }
.oc-sdk-search-clear:hover { background: ${P}; color: ${L}; }

.oc-sdk-trigger { border-radius: ${Ct}; background: var(--oc-sdk-raised-bg); color: ${re}; ${kt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${h}; }
.oc-sdk-trigger-chevron { color: ${h}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${re}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Ne}; background-clip: padding-box; color: ${re}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${P}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${bt}; color: ${xt}; }
.oc-sdk-option-check { color: ${L}; }
.oc-sdk-option[data-destructive="true"] { color: ${Rt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${O(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${h}; }
.oc-sdk-popup-empty { color: ${h}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${V}; border-radius: 4px; color: ${L}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${O(L,60,V)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${V}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Go} }
.oc-sdk-check-desc { color: ${h}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${O(L,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${h}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${L}; }
.oc-sdk-tab[aria-selected="true"] { color: ${xt}; background: ${bt}; border-color: ${V}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${re}; background: var(--oc-sdk-raised-bg); ${kt} }
.oc-sdk-tab-count { color: ${h}; }

.oc-sdk-badge { border-radius: 9999px; background: ${P}; color: ${h}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${O("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${P}; }
.oc-sdk-row[aria-selected="true"] { background: ${bt}; color: ${xt}; }
.oc-sdk-row-lead { font-family: ${Ot}; color: ${h}; }
.oc-sdk-row-sub { color: ${h}; }
.oc-sdk-row-meta { color: ${h}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${h}; }

.oc-sdk-empty-body { color: ${h}; }

.oc-sdk-spinner { color: ${h}; }
.oc-sdk-spinner-ring { border-color: ${V}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${O("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${h}; }

.oc-sdk-separator { color: ${h}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${O(V,40)}; }

.oc-sdk-progress-label { color: ${h}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${V}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }

.oc-sdk-text a { color: ${vt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${O(V,60)}; }
`,k=`
${ze}
${tr}
${Mo}`;var wo="oc-sdk-ui-style";var G=(e)=>{let r=document.getElementById(wo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ke(document);let s=document.createElement("style");s.id=wo,s.textContent=e,document.head.appendChild(s)},C=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},X=(e)=>{let r=C("button",e);return r.type="button",r},U=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var or=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},q=(e,r)=>{G(k);let s=r,a=X("oc-sdk oc-sdk-btn"),u=or(),E=document.createElement("span");a.append(E),e.append(a);let _=()=>{if(a.dataset.variant=s.variant??"default",a.dataset.size=s.size??"default",a.disabled=Boolean(s.disabled)||Boolean(s.loading),a.dataset.loading=s.loading?"true":"false",a.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&u.parentNode!==a)a.prepend(u);else if(!s.loading&&u.parentNode===a)u.remove();U(E,s.label)},m=()=>{if(s.disabled||s.loading)return;s.onClick()};return a.addEventListener("click",m),_(),{update:(A)=>{s={...s,...A},_()},dispose:()=>{a.removeEventListener("click",m),a.remove()}}};var Pt=(e,r)=>{G(k);let s=r,a=C("div","oc-sdk oc-sdk-empty"),u=C("h2","oc-sdk-empty-title"),E=C("p","oc-sdk-empty-body"),_=C("div","oc-sdk-empty-action");a.append(u,E,_),e.append(a);let m=null,A=()=>{if(U(u,s.title),U(E,s.body),E.hidden=!s.body,_.hidden=!s.action,!s.action){m?.dispose(),m=null;return}let M={label:s.action.label,onClick:s.action.onClick};if(m)m.update(M);else m=q(_,{...M,variant:"outline",size:"sm"})};return A(),{update:(M)=>{s={...s,...M},A()},dispose:()=>{m?.dispose(),m=null,a.remove()}}};var ar=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,Uo=(e)=>e.split(`
`).map((r)=>{let s=ar.exec(r);return s?{kind:"item",prefix:s[1]??"- ",done:s[2]!==" ",text:s[3]??""}:{kind:"text",text:r}}),No=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),Be=(e)=>{let r=2166136261;for(let s=0;s<e.length;s+=1)r^=e.charCodeAt(s),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},Lo=(e,r)=>{let s=-1,a="- ";e.forEach((m,A)=>{if(m.kind!=="item")return;s=A,a=m.prefix});let u={kind:"item",prefix:a,done:!1,text:r};if(s>=0)return[...e.slice(0,s+1),u,...e.slice(s+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],u,{kind:"text",text:""}]};var K=ht(),z=document.querySelector("#root");if(!z)throw Error("Missing root");var Ho=document.createElement("style");Ho.textContent=`
  html, body { margin: 0; height: 100%; background: var(--oc-bg); color: var(--oc-fg); font-family: var(--oc-font); font-size: 13px; }
  #root { box-sizing: border-box; height: 100%; overflow: auto; padding: 16px 20px; }
  .note { margin: 2px 0; color: var(--oc-muted); white-space: pre-wrap; min-height: 1em; }
  .item { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
  .item input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--oc-primary); }
  .item input[type="text"] { flex: 1; min-width: 0; border: 1px solid transparent; border-radius: var(--oc-radius); padding: 4px 6px;
    background: transparent; color: inherit; font: inherit; }
  .item input[type="text"]:hover { border-color: var(--oc-border); }
  .item input[type="text"]:focus { outline: none; border-color: var(--oc-focus); background: var(--oc-elevated); }
  .item.done input[type="text"] { color: var(--oc-muted); text-decoration: line-through; }
  .item .remove { visibility: hidden; }
  .item:hover .remove, .item:focus-within .remove { visibility: visible; }
  .actions { margin-top: 12px; }
`;document.head.append(Ho);K.onReady((e)=>yt(e,document.documentElement));var W=[],se=!1,wt=ve(null),Ut=()=>No(W),Ve=()=>{K.reportFileChange(wt.observe(Be(Ut())))},Mt=()=>{if(z.replaceChildren(),!W.some((r)=>r.kind==="item")&&se){Pt(z,{title:"No items",body:"This checklist is empty."});return}if(W.forEach((r,s)=>{if(r.kind==="text"){let _=document.createElement("p");_.className="note",_.textContent=r.text,z.append(_);return}let a=document.createElement("div");a.className=r.done?"item done":"item";let u=document.createElement("input");u.type="checkbox",u.checked=r.done,u.disabled=se,u.addEventListener("change",()=>{r.done=u.checked,a.className=r.done?"item done":"item",Ve()});let E=document.createElement("input");if(E.type="text",E.value=r.text,E.readOnly=se,E.setAttribute("aria-label","Item"),E.addEventListener("input",()=>{r.text=E.value,Ve()}),a.append(u,E),!se){let _=document.createElement("span");_.className="remove",q(_,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{W=W.filter((m,A)=>A!==s),Ve(),Mt()}}),a.append(_)}z.append(a)}),se)return;let e=document.createElement("div");e.className="actions",q(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{W=Lo(W,""),Ve(),Mt();let r=z.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),z.append(e)};K.onFileOpen((e)=>{if(e.encoding!=="text"){K.reportFileUnsupported();return}W=Uo(e.content),se=e.readOnly,wt=ve(Be(Ut())),Mt()});K.onFileSnapshot(()=>{let e=Ut();return{content:e,version:Be(e)}});K.onFileSaved((e)=>{K.reportFileChange({dirty:wt.markSaved(e),edited:!1})});})();
