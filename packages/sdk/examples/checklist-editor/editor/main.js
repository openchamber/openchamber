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
`;function Qe(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let n=new WeakMap;e.addEventListener("scroll",(a)=>{let u=a.target===e?r:a.target;if(!(u instanceof Element))return;if(!u.hasAttribute("data-oc-scrolling"))u.setAttribute("data-oc-scrolling","");let E=n.get(u);if(E!==void 0)clearTimeout(E);n.set(u,setTimeout(()=>{n.delete(u),u.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Bo=`(${Qe.toString()})(document);`;var Je=128,Ye=65536;var he=128;var be=65536;var Jt=/^[a-z][a-z0-9-]{0,39}$/;var Kt=(e)=>Object(e)===e&&!Array.isArray(e),Ze=(e,r)=>Object.keys(e).every((n)=>r.includes(n)),zt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Qt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Yt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let n of e){if(!Kt(n)||!Jt.test(n.id)||!zt(n.label))return!1;if(n.disabled!==void 0&&n.disabled!==!0&&n.disabled!==!1)return!1;if(r.has(n.id))return!1;if(r.add(n.id),n.kind==="button"){if(!Ze(n,["kind","id","label","disabled"]))return!1;continue}if(n.kind!=="select"||!Ze(n,["kind","id","label","value","options","disabled"]))return!1;if(!Qt(n.value)||!Array.isArray(n.options)||n.options.length<1||n.options.length>16)return!1;let a=new Set;for(let u of n.options){if(!Kt(u)||!Ze(u,["value","label"])||!Qt(u.value)||!zt(u.label)||a.has(u.value))return!1;a.add(u.value)}if(!a.has(n.value))return!1}return!0};var Zt=["{id}","{segment}","{segments+}"];var _r=new Set(Zt);var eo=["turn-finished","turn-failed","permission-asked","question-asked"];var yr=new Set(eo);var Re=20000000,xe=256;var et=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,to=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let n=0;n<e.bytes.byteLength;n+=1)if(e.bytes[n]!==r.bytes[n])return!1;return!0},ve=(e)=>{let r=e,n=e;return{observe:(a)=>{let u=a!==n;return n=a,{edited:u,dirty:a!==r}},markSaved:(a)=>(r=a,n!==a)}};var oo=/^[A-Za-z0-9_-]{1,80}$/;var ro=["left","right","top","bottom"];var no=(e,r=0,n={remaining:16000})=>{if(--n.remaining<0||r>=32)return!1;if(e===null)return!0;let a=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let u of a)if(!no(u,r+1,n))return!1;return!0},tt=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(tt);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(tt)}return String(e)===e||Number.isFinite(e)},ot=(e)=>{try{if(String(e.id)!==e.id||!oo.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!ro.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!no(e.data)||!tt(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var io=["file","directory","other","missing"],nt=(e)=>Boolean(e&&"sessionId"in e),st=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var ao=/^[0-9a-f]{7,64}$/i,it=(e)=>ao.test(e),Oe=500,Ae=32000,lo=16000,co=128,uo=200,po=2000,So=16000,go=80,Eo=200,mo=16000;var To=2000;var at=20000,ke=1024,Ce=2000000;var Pe=64000,Ie=8000,lt=4000;var ct=960000;var _o=999,fo=1e4,de=500,yo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],ho=["stopped","starting","ready","failed"],Xo=new Set(yo),bo=(e)=>Xo.has(e),Ro=(e)=>e&&bo(e)?e:"HOST_REJECTED",ee=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ee);if(Object(e)===e)return Object.values(e).every(ee);return!1},xo=(e)=>ee(e)&&JSON.stringify(e).length<=mo,so=(e)=>e?.trim().slice(0,Eo)??"",te=(e)=>{let r=e.id.trim().slice(0,co),n=e.title.trim().slice(0,uo),a=e.url.trim().slice(0,po),u=e.text?.trim().slice(0,So),E=e.author?.trim().slice(0,go),_=e.kind==="pull"?"pull":"issue",m={providerId:e.providerId.trim(),id:r,title:n||r,url:a,kind:_};if(u)m.text=u;if(E)m.author=E;if(_==="pull"){let k=so(e.branches?.head),M=so(e.branches?.base);if(k&&M)m.branches={head:k,base:M}}if(xo(e.data))m.data=e.data;return m},ut=(e)=>{let r=te(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},pt=(e)=>{let r={text:e.text.trim().slice(0,lo)};if(e.send)r.send=!0;return r},dt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(_o,Math.max(0,Math.round(e)))},St=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(fo,Math.max(0,Math.ceil(e)))};var oe=(e)=>e.length>0&&e.length<=ke&&!e.includes("\x00")&&!e.includes("\\");var Ge=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>To)return!1;return!e.split("/").some((n)=>n==="."||n==="..")},qo=new Set(ho),gt=(e)=>Boolean(e&&"status"in e&&qo.has(String(e.status))&&!("body"in e)),Me=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),Et=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),mt=(e)=>Boolean(e&&"written"in e&&e.written===!0),Tt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Wo=new Set(io),_t=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Wo.has(String(e.kind))&&Number.isFinite(e.size)),ft=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),$o=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),jo=(e)=>Object(e)===e?e:null,rt=(e)=>String(e)===e&&e.length>0,Ko=(e)=>{if(!rt(e.id))return null;if(e.ok===!0){let r={channel:S,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&rt(e.error))return{channel:S,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:Ro(rt(e.code)?e.code:void 0)};return null},yt=(e)=>{let r=jo(e);if(!r||r.channel!==S||r.v!==g)return null;if(r.type==="result")return Ko(r);if(!$o.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var vo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),zo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class l extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Oo=()=>Promise.reject(new l("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),we=()=>Promise.reject(new l("BAD_PATH",`File path must be 1 to ${ke} characters without NUL or backslash.`)),Ue=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new l("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},d=(e)=>(e.value+=1,`oc-${e.value}`),ht=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new l("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let n=e.acceptSource??((t)=>t===r.parent),a=e.requestTimeoutMs??at,u=new Set,E=new Set,_=new Set,m=new Set,k=new Set,M=new Set,se=new Set,ge=new Set,Ee=new Set,Q=new Set,qe=[],ie=null,ae=null,me=new Set,Te=new Set,le=null,ce=null,We=!1,J=new Map,Y=new Map,Z=new Map,D=!1,p={value:0},c=null,H=null,ue=!1,pe=!1,Nt=null,Lt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},Dt=()=>{if(D||r.parent===r||Q.size===0||c?.features?.lateGenerateResults!==!0)return;w({channel:S,v:g,type:"generate-late-listen"})},R=(t,o)=>{for(let s of t)try{s(o)}catch(i){console.error(i)}},Ht=(t)=>{if(!(t instanceof MessageEvent))return;if(!n(t.source))return;let o=yt(t.data);if(!o)return;if(o.type==="workspace"){let i=Y.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="shells"){let i=Z.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="ready"){if(c=o.payload,H=Lt(o.payload.session),R(u,o.payload),R(E,o.payload.directory),R(_,o.payload.session),H)R(m,H);R(k,o.payload.connection),R(M,o.payload.settings),R(se,o.payload.item),Dt();return}if(o.type==="generate-late"){if(Q.size===0)qe.push(o.payload);else R(Q,o.payload);return}if(o.type==="directory"){if(c)c={...c,directory:o.payload.directory};R(E,o.payload.directory);return}if(o.type==="session"){if(c)c={...c,session:o.payload.session};if(!o.payload.session)H=null;else if(H?.sessionId!==o.payload.session.id)H=Lt(o.payload.session);R(_,o.payload.session);return}if(o.type==="session-lifecycle"){H=o.payload,R(m,o.payload);return}if(o.type==="connection"){if(c)c={...c,connection:o.payload.connection};R(k,o.payload.connection);return}if(o.type==="settings"){if(c)c={...c,settings:o.payload.settings};R(M,o.payload.settings);return}if(o.type==="item"){if(c)c={...c,item:o.payload.item};R(se,o.payload.item);return}if(o.type==="status-control-event"){R(ge,o.payload);return}if(o.type==="popover-closed"){R(Ee,o.payload);return}if(o.type==="action"){let i=(T)=>{if(!D)w({channel:S,v:g,type:"action-result",id:o.id,payload:T})},f=ae;if(!f){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>f(o.payload)).then(()=>i({ok:!0}),(T)=>{let O=(T instanceof Error?T.message:String(T)).trim();i({ok:!1,error:(O||"Action failed.").slice(0,de)})});return}if(o.type==="file-open"){let i=o.payload;if(ce&&to(ce,i))return;ce=i,R(me,o.payload);return}if(o.type==="file-saved"){R(Te,o.payload.version);return}if(o.type==="file-snapshot"){let i=(O)=>{if(!D)w({channel:S,v:g,type:"file-snapshot-result",id:o.id,payload:O})},f=(O)=>i({error:(O.trim()||"Could not read the edited file.").slice(0,de)}),T=le;if(!T){f("This extension does not edit files.");return}Promise.resolve().then(()=>T(o.payload.purpose)).then((O)=>{if(et(O)>Re){f(`The file is over ${Re} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>xe){f(`The snapshot version is over ${xe} characters.`);return}i({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>f(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let i=(T)=>{w({channel:S,v:g,type:"resolve-result",id:o.id,payload:T})},f=ie;if(!f){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>f(o.payload)).then((T)=>i({item:T?te(T):null}),(T)=>{let O=(T instanceof Error?T.message:String(T)).trim();i({error:(O||"Command failed.").slice(0,de)})});return}let s=J.get(o.id);if(!s)return;if(clearTimeout(s.timer),J.delete(o.id),o.ok){s.resolve(o.payload);return}s.reject(new l(o.code,o.error))};r.addEventListener("message",Ht),w({channel:S,v:g,type:"hello"});let I=(t,o=a)=>{if(D||r.parent===r)return Promise.reject(new l("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((s,i)=>{let f=setTimeout(()=>{J.delete(t.id),i(new l("HOST_TIMEOUT","Host did not answer in time."))},o);J.set(t.id,{resolve:s,reject:i,timer:f}),w(t)})},x=(t)=>I(t).then(()=>{return}),v={channel:S,v:g},$e=(t)=>{if(!D&&r.parent!==r)w(t)},Ft=()=>$e({...v,type:"file-save"}),Bt=(t)=>{if(!vo(t)||!zo(t))return;t.preventDefault(),Ft()},Vt=(t)=>{if(!vo(t)||t.key!=="Escape"||c?.surface!=="popover"||!c.popover)return;t.preventDefault(),$t(c.popover.id,"escape").catch(()=>{return})},_e=()=>{let t=c?.surface==="popover"?c.popover:void 0;if(!t)return;let o=ue||pe;if(Nt===o)return;Nt=o,jt(t.id,o).catch(()=>{return})},fe=()=>{if(c?.surface!=="popover"||ue)return;ue=!0,_e()},Xt=(t)=>{if(c?.surface!=="popover"||t.relatedTarget!==null||!ue)return;ue=!1,_e()},qt=()=>{if(c?.surface!=="popover"||pe)return;pe=!0,_e()},Wt=()=>{if(c?.surface!=="popover"||!pe)return;pe=!1,_e()},L=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new l("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},je=async(t)=>{if(t.kind!=="projects")L(t.projectId);let o=await I({...v,type:"workspace-read",id:d(p),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new l("HOST_REJECTED","Host did not return workspace data.");return o},Ke=async(t,o)=>{if(t.kind!=="projects")L(t.projectId);let s=d(p);Y.set(s,o);try{await x({...v,type:"workspace-subscribe",id:d(p),payload:{subscriptionId:s,query:t}})}catch(i){if(Y.delete(s),!D)w({...v,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:s}});throw i}return()=>{if(!Y.delete(s)||D)return;w({...v,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:s}})}},Fo=async(t,o)=>{if(t.kind==="session")L(t.sessionId);if(t.kind==="project")L(t.projectId);let s=d(p);Z.set(s,o);try{await x({...v,type:"shells-subscribe",id:d(p),payload:{subscriptionId:s,scope:t}})}catch(i){if(Z.delete(s),!D)w({...v,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:s}});throw i}return()=>{if(!Z.delete(s)||D)return;w({...v,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:s}})}},ye=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Je))throw new l("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ee(t.value))throw new l("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Ye)throw new l("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&c?.features?.deviceStorage!==!0)throw new l("UNSUPPORTED","This host does not support device storage.");let o=await I({...v,type:"storage",id:d(p),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new l("HOST_REJECTED","Host did not return storage data.");return o},$t=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-close",id:d(p),payload:o?{id:t,reason:o}:{id:t}}),jt=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-anchor",id:d(p),payload:{id:t,active:o}});return r.addEventListener("keydown",Vt,!0),r.addEventListener("pointerover",fe),r.addEventListener("pointermove",fe),r.addEventListener("pointerout",Xt),r.addEventListener("focus",qt),r.addEventListener("blur",Wt),{onAction:(t)=>(ae=t,()=>{if(ae===t)ae=null}),listProjects:async()=>{let t=await je({kind:"projects"});if(t.kind!=="projects")throw new l("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await je({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new l("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await je({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new l("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Ke({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Ke({kind:"worktrees",projectId:t},(s)=>{if(s.kind==="worktrees")o(s)}),onSessions:(t,o)=>Ke({kind:"sessions",projectId:t},(s)=>{if(s.kind==="sessions")o(s)}),onRunningShells:(t,o)=>Fo(t,o),readShellOutput:async(t,o)=>{L(t,he);let s=o?.cursor;if(s!==void 0&&(!Number.isInteger(s)||s<0))throw new l("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>be))throw new l("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${be}.`);let T=await I({...v,type:"shell-output",id:d(p),payload:{shellId:t,cursor:s,tailBytes:i}});if(!T||typeof T.output!=="string"||!Number.isFinite(T.cursor))throw new l("HOST_REJECTED","Host did not return shell output.");return T},stopShell:async(t)=>{if(L(t,he),(await I({...v,type:"shell-stop",id:d(p),payload:{shellId:t}}))?.stopped!==!0)throw new l("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{L(t),await x({...v,type:"open-session",id:d(p),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let s=Ue(o),i={op:"get",key:t};if(s)i.scope=s;let f=await ye(i);return f.op==="get"&&f.found?f.value:void 0},set:async(t,o,s)=>{let i=Ue(s),f={op:"set",key:t,value:o};if(i)f.scope=i;await ye(f)},delete:async(t,o)=>{let s=Ue(o),i={op:"delete",key:t};if(s)i.scope=s;await ye(i)},keys:async(t)=>{let o=Ue(t),s={op:"keys"};if(o)s.scope=o;let i=await ye(s);if(i.op!=="keys")throw new l("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(u.add(t),c)t(c);return()=>{u.delete(t)}},onDirectory:(t)=>{if(E.add(t),c)t(c.directory);return()=>{E.delete(t)}},onSession:(t)=>{if(_.add(t),c)t(c.session);return()=>{_.delete(t)}},onSessionLifecycle:(t)=>{if(m.add(t),H)t(H);return()=>{m.delete(t)}},onConnection:(t)=>{if(k.add(t),c)t(c.connection);return()=>{k.delete(t)}},onSettings:(t)=>{if(M.add(t),c)t(c.settings);return()=>{M.delete(t)}},onItem:(t)=>{if(se.add(t),c)t(c.item);return()=>{se.delete(t)}},onStatusControl:(t)=>(ge.add(t),()=>{ge.delete(t)}),onPopoverClosed:(t)=>(Ee.add(t),()=>{Ee.delete(t)}),setStatusControls:(t)=>{if(c?.features?.statusControls!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support status controls."));if(!Yt(t))return Promise.reject(new l("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...v,type:"status-controls",id:d(p),payload:{controls:t}})},openPopover:(t)=>{if(c?.features?.popovers!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support popovers."));if(!ot(t))return Promise.reject(new l("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...v,type:"popover-open",id:d(p),payload:t})},closePopover:$t,setPopoverAnchorActive:jt,onResolve:(t)=>(ie=t,()=>{if(ie===t)ie=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Oe)return Promise.reject(new l("HOST_REJECTED",`Toast message must contain 1 to ${Oe} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Ae))return Promise.reject(new l("HOST_REJECTED",`Toast copy text must contain 1 to ${Ae} characters.`));return x({channel:S,v:g,type:"toast",id:d(p),payload:{...t,message:o}})},openUrl:(t)=>x({channel:S,v:g,type:"open-url",id:d(p),payload:{url:t}}),openCommit:(t)=>it(t)?x({channel:S,v:g,type:"open-commit",id:d(p),payload:{sha:t}}):Promise.reject(new l("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>x({channel:S,v:g,type:"open-surface",id:d(p),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:S,v:g,type:"clipboard-write",id:d(p),payload:{text:t}}),compose:(t)=>x({channel:S,v:g,type:"compose",id:d(p),payload:t}),attach:(t)=>x({channel:S,v:g,type:"attach",id:d(p),payload:te(t)}),startSession:async(t)=>{if(t.projectId!==void 0)L(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")L(o.directory);else{if(o.name!==void 0)L(o.name,200);if(o.baseBranch!==void 0)L(o.baseBranch,200)}let s=await I({channel:S,v:g,type:"start-session",id:d(p),payload:ut(t)},e.requestTimeoutMs??180000);if(!nt(s))throw new l("HOST_REJECTED","Host did not return a session.");return s},prompt:(t)=>I({channel:S,v:g,type:"prompt",id:d(p),payload:pt(t)}).then((o)=>{if(!st(o))throw new l("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:S,v:g,type:"session-link",id:d(p),payload:te(t)}),close:()=>x({channel:S,v:g,type:"close",id:d(p)}),oauthStart:()=>x({channel:S,v:g,type:"oauth-start",id:d(p)}),oauthDisconnect:()=>x({channel:S,v:g,type:"oauth-disconnect",id:d(p)}),request:(t)=>(Ge(t.path)?I({channel:S,v:g,type:"request",id:d(p),payload:t}):Oo()).then((o)=>{if(!Me(o))throw new l("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ge(t.path)?I({channel:S,v:g,type:"service-request",id:d(p),payload:t}):Oo()).then((o)=>{if(!Me(o))throw new l("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>I({channel:S,v:g,type:"service-status",id:d(p)}).then((t)=>{if(!gt(t))throw new l("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(oe(t)?I({channel:S,v:g,type:"file-read",id:d(p),payload:{path:t}}):we()).then((o)=>{if(!Et(o))throw new l("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!oe(t))return we();if(o.length>Ce)return Promise.reject(new l("FILE_TOO_LARGE",`Content is over ${Ce} characters.`));return I({channel:S,v:g,type:"file-write",id:d(p),payload:{path:t,content:o}}).then((s)=>{if(!mt(s))throw new l("HOST_REJECTED","Host did not confirm the write.");return s})},listDir:(t)=>(oe(t)?I({channel:S,v:g,type:"file-list",id:d(p),payload:{path:t}}):we()).then((o)=>{if(!Tt(o))throw new l("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(oe(t)?I({channel:S,v:g,type:"file-stat",id:d(p),payload:{path:t}}):we()).then((o)=>{if(!_t(o))throw new l("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),s=t.system?.trim();if(o.length===0||o.length>Pe)return Promise.reject(new l("HOST_REJECTED",`Prompt must be 1 to ${Pe} characters.`));if(s!==void 0&&(s.length===0||s.length>Ie))return Promise.reject(new l("HOST_REJECTED",`System prompt must be 1 to ${Ie} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(lt,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new l("HOST_REJECTED","maxOutputTokens must be a number."));let f={prompt:o};if(s!==void 0)f.system=s;if(i!==void 0)f.maxOutputTokens=i;return I({channel:S,v:g,type:"generate",id:d(p),payload:f},e.requestTimeoutMs??ct).then((T)=>{if(!ft(T))throw new l("HOST_REJECTED","Host did not return generated text.");return T})},onLateGenerateResult:(t)=>{Q.add(t);for(let o of qe.splice(0))R([t],o);return Dt(),()=>{Q.delete(t)}},setBadge:(t)=>x({channel:S,v:g,type:"badge",id:d(p),payload:{count:dt(t)}}),setHeight:(t)=>x({channel:S,v:g,type:"resize",id:d(p),payload:{height:St(t)}}),onFileOpen:(t)=>{if(me.add(t),!We)We=!0,r.addEventListener("keydown",Bt,!0);if(ce)t(ce);return()=>{me.delete(t)}},onFileSnapshot:(t)=>(le=t,()=>{if(le===t)le=null}),onFileSaved:(t)=>(Te.add(t),()=>{Te.delete(t)}),reportFileChange:(t)=>$e({...v,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Ft,reportFileUnsupported:()=>$e({...v,type:"file-unsupported"}),dispose:()=>{for(let t of Y.keys())w({...v,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:t}});Y.clear();for(let t of Z.keys())w({...v,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:t}});if(Z.clear(),D=!0,ie=null,ae=null,le=null,me.clear(),Te.clear(),We)r.removeEventListener("keydown",Bt,!0);r.removeEventListener("message",Ht),r.removeEventListener("keydown",Vt,!0),r.removeEventListener("pointerover",fe),r.removeEventListener("pointermove",fe),r.removeEventListener("pointerout",Xt),r.removeEventListener("focus",qt),r.removeEventListener("blur",Wt);for(let t of J.values())clearTimeout(t.timer),t.reject(new l("HOST_UNAVAILABLE","Host client was disposed."));J.clear(),u.clear(),E.clear(),_.clear(),m.clear(),k.clear(),M.clear(),se.clear(),ge.clear(),Ee.clear(),Q.clear(),qe.length=0}}};var Ao=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var wr=new Set(Ao);var ko=["none","agent","user"];var Nr=new Set(ko);var Qo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Jo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Co=(e,r)=>{r.style.colorScheme=e.mode;for(let[n,a]of Qo)r.style.setProperty(n,e.tokens[a]);for(let[n,a,u]of Jo){let E=e.tokens[u]??"";r.style.setProperty(n,E),r.style.setProperty(a,E)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},bt=(e,r)=>{if(Co(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Yo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${Yo[e]}, ${r}))`,B=y("surface-background","transparent"),Le=y("surface-elevated","transparent"),re=y("surface-elevated-foreground","inherit"),U=y("surface-foreground","inherit"),h=y("surface-muted-foreground","gray"),Zo=y("surface-muted","transparent"),W=y("interactive-border","currentColor"),G=y("interactive-hover","transparent"),j=y("interactive-active","transparent"),Rt=y("interactive-selection","transparent"),xt=y("interactive-selection-foreground","inherit"),F=y("primary","currentColor"),vt=y("primary-text","inherit"),Ot=y("error-text","inherit"),er=y("font-sans","inherit"),At=y("font-mono","monospace"),Mo=y("radius","9px"),kt=`calc(${Mo} - 2px)`,Po=`calc(${Mo} - 4px)`,b=(e,r,n="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${n})`,Io=`background-image: linear-gradient(${G}, ${G});`,Ct=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Pt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Go="box-shadow: var(--oc-sdk-lit);",It=`inset 0 0.5px 0 0 ${b(U,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,tr=`
:root {
  --oc-sdk-edge: ${b(U,16)};
  --oc-sdk-field-bg: ${Le};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${b(U,14)};
  --oc-sdk-field-bg: ${b(B,50,Le)};
  --oc-sdk-raised-bg: ${Le};
  --oc-sdk-field-lift: ${It};
  --oc-sdk-raised-lift: ${It};
  --oc-sdk-lit: ${It};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ne=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},or=`
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
`,wo=`${tr}
.oc-sdk { color: ${U}; font-family: ${er}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Io} }
.oc-sdk-mono { font-family: ${At}; }
.oc-sdk-muted { color: ${h}; }
${Ne("success")}${Ne("warning")}${Ne("error")}${Ne("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${vt}; }

.oc-sdk-btn { border-radius: ${kt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Po}; }
.oc-sdk-btn[data-variant="default"] { color: ${vt}; background: ${b(F,10,B)}; border-color: ${b(F,12)}; ${Go} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${b(F,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${b(F,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Zo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${re}; ${Pt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${G}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${Ot}; background: ${b("var(--oc-sdk-tone)",7,B)}; border-color: ${b("var(--oc-sdk-tone)",12)}; ${Go} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${b("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${b("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${h}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Ot}; }
.oc-sdk-input { border-radius: ${kt}; background: var(--oc-sdk-field-bg); color: ${re}; ${Ct("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${h}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Ct(b(U,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Ct(y("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${At}; }

.oc-sdk-search-icon { color: ${h}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${Po}; color: ${h}; }
.oc-sdk-search-clear:hover { background: ${G}; color: ${U}; }

.oc-sdk-trigger { border-radius: ${kt}; background: var(--oc-sdk-raised-bg); color: ${re}; ${Pt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${h}; }
.oc-sdk-trigger-chevron { color: ${h}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${re}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Le}; background-clip: padding-box; color: ${re}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${G}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Rt}; color: ${xt}; }
.oc-sdk-option-check { color: ${U}; }
.oc-sdk-option[data-destructive="true"] { color: ${Ot}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${b(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${h}; }
.oc-sdk-popup-empty { color: ${h}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${W}; border-radius: 4px; color: ${U}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${b(U,60,W)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${W}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Io} }
.oc-sdk-check-desc { color: ${h}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${b(U,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${h}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${U}; }
.oc-sdk-tab[aria-selected="true"] { color: ${xt}; background: ${Rt}; border-color: ${W}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${re}; background: var(--oc-sdk-raised-bg); ${Pt} }
.oc-sdk-tab-count { color: ${h}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${b(U,6)}; color: ${h}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${b("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${G}; }
.oc-sdk-row[aria-selected="true"] { background: ${Rt}; color: ${xt}; }
.oc-sdk-row-lead { font-family: ${At}; color: ${h}; }
.oc-sdk-row-sub { color: ${h}; }
.oc-sdk-row-meta { color: ${h}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${h}; }

.oc-sdk-empty-body { color: ${h}; }

.oc-sdk-spinner { color: ${h}; }
.oc-sdk-spinner-ring { border-color: ${W}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${b("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${h}; }

.oc-sdk-separator { color: ${h}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${b(W,40)}; }

.oc-sdk-progress-label { color: ${h}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${b(U,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${y("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${y("success-text","inherit")}; }

.oc-sdk-text a { color: ${vt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${b(W,60)}; }
`,C=`
${ze}
${or}
${wo}`;var Uo="oc-sdk-ui-style";var P=(e)=>{let r=document.getElementById(Uo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Qe(document);let n=document.createElement("style");n.id=Uo,n.textContent=e,document.head.appendChild(n)},A=(e,r)=>{let n=document.createElement(e);if(r)n.className=r;return n},V=(e)=>{let r=A("button",e);return r.type="button",r},N=(e,r)=>{let n=r??"";if(e.textContent!==n)e.textContent=n};var rr=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},X=(e,r)=>{P(C);let n=r,a=V("oc-sdk oc-sdk-btn"),u=rr(),E=document.createElement("span");a.append(E),e.append(a);let _=()=>{if(a.dataset.variant=n.variant??"default",a.dataset.size=n.size??"default",a.disabled=Boolean(n.disabled)||Boolean(n.loading),a.dataset.loading=n.loading?"true":"false",a.setAttribute("aria-busy",n.loading?"true":"false"),n.loading&&u.parentNode!==a)a.prepend(u);else if(!n.loading&&u.parentNode===a)u.remove();N(E,n.label)},m=()=>{if(n.disabled||n.loading)return;n.onClick()};return a.addEventListener("click",m),_(),{update:(k)=>{n={...n,...k},_()},dispose:()=>{a.removeEventListener("click",m),a.remove()}}};var Gt=(e,r)=>{P(C);let n=r,a=A("div","oc-sdk oc-sdk-empty"),u=A("h2","oc-sdk-empty-title"),E=A("p","oc-sdk-empty-body"),_=A("div","oc-sdk-empty-action");a.append(u,E,_),e.append(a);let m=null,k=()=>{if(N(u,n.title),N(E,n.body),E.hidden=!n.body,_.hidden=!n.action,!n.action){m?.dispose(),m=null;return}let M={label:n.action.label,onClick:n.action.onClick};if(m)m.update(M);else m=X(_,{...M,variant:"outline",size:"sm"})};return k(),{update:(M)=>{n={...n,...M},k()},dispose:()=>{m?.dispose(),m=null,a.remove()}}};var lr=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,No=(e)=>e.split(`
`).map((r)=>{let n=lr.exec(r);return n?{kind:"item",prefix:n[1]??"- ",done:n[2]!==" ",text:n[3]??""}:{kind:"text",text:r}}),Lo=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),Ve=(e)=>{let r=2166136261;for(let n=0;n<e.length;n+=1)r^=e.charCodeAt(n),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},Do=(e,r)=>{let n=-1,a="- ";e.forEach((m,k)=>{if(m.kind!=="item")return;n=k,a=m.prefix});let u={kind:"item",prefix:a,done:!1,text:r};if(n>=0)return[...e.slice(0,n+1),u,...e.slice(n+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],u,{kind:"text",text:""}]};var z=ht(),K=document.querySelector("#root");if(!K)throw Error("Missing root");var Ho=document.createElement("style");Ho.textContent=`
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
`;document.head.append(Ho);z.onReady((e)=>bt(e,document.documentElement));var q=[],ne=!1,wt=ve(null),Ut=()=>Lo(q),Xe=()=>{z.reportFileChange(wt.observe(Ve(Ut())))},Mt=()=>{if(K.replaceChildren(),!q.some((r)=>r.kind==="item")&&ne){Gt(K,{title:"No items",body:"This checklist is empty."});return}if(q.forEach((r,n)=>{if(r.kind==="text"){let _=document.createElement("p");_.className="note",_.textContent=r.text,K.append(_);return}let a=document.createElement("div");a.className=r.done?"item done":"item";let u=document.createElement("input");u.type="checkbox",u.checked=r.done,u.disabled=ne,u.addEventListener("change",()=>{r.done=u.checked,a.className=r.done?"item done":"item",Xe()});let E=document.createElement("input");if(E.type="text",E.value=r.text,E.readOnly=ne,E.setAttribute("aria-label","Item"),E.addEventListener("input",()=>{r.text=E.value,Xe()}),a.append(u,E),!ne){let _=document.createElement("span");_.className="remove",X(_,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{q=q.filter((m,k)=>k!==n),Xe(),Mt()}}),a.append(_)}K.append(a)}),ne)return;let e=document.createElement("div");e.className="actions",X(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{q=Do(q,""),Xe(),Mt();let r=K.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),K.append(e)};z.onFileOpen((e)=>{if(e.encoding!=="text"){z.reportFileUnsupported();return}q=No(e.content),ne=e.readOnly,wt=ve(Ve(Ut())),Mt()});z.onFileSnapshot(()=>{let e=Ut();return{content:e,version:Ve(e)}});z.onFileSaved((e)=>{z.reportFileChange({dirty:wt.markSaved(e),edited:!1})});})();
