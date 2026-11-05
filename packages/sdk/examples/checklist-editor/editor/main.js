(()=>{var S="openchamber.sdk",E=1;var Qe=`
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
`;function Ye(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(a)=>{let u=a.target===e?r:a.target;if(!(u instanceof Element))return;if(!u.hasAttribute("data-oc-scrolling"))u.setAttribute("data-oc-scrolling","");let g=s.get(u);if(g!==void 0)clearTimeout(g);s.set(u,setTimeout(()=>{s.delete(u),u.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var qo=`(${Ye.toString()})(document);`;var Ze=128,et=65536;var be=128;var ve=65536;var eo=/^[a-z][a-z0-9-]{0,39}$/;var Qt=(e)=>Object(e)===e&&!Array.isArray(e),tt=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Yt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Zt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,to=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Qt(s)||!eo.test(s.id)||!Yt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!tt(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!tt(s,["kind","id","label","value","options","disabled"]))return!1;if(!Zt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let a=new Set;for(let u of s.options){if(!Qt(u)||!tt(u,["value","label"])||!Zt(u.value)||!Yt(u.label)||a.has(u.value))return!1;a.add(u.value)}if(!a.has(s.value))return!1}return!0};var oo=["{id}","{segment}","{segments+}"];var Rr=new Set(oo);var ro=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var br=new Set(ro);var xe=20000000,Oe=256;var ot=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,so=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0},Ae=(e)=>{let r=e,s=e;return{observe:(a)=>{let u=a!==s;return s=a,{edited:u,dirty:a!==r}},markSaved:(a)=>(r=a,s!==a)}};var no=/^[A-Za-z0-9_-]{1,80}$/;var io=["left","right","top","bottom"];var ao=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let a=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let u of a)if(!ao(u,r+1,s))return!1;return!0},rt=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(rt);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(rt)}return String(e)===e||Number.isFinite(e)},st=(e)=>{try{if(String(e.id)!==e.id||!no.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!io.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!ao(e.data)||!rt(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var it=2000;var co=["file","directory","other","missing"],at=(e)=>Boolean(e&&"sessionId"in e),lt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var uo=/^[0-9a-f]{7,64}$/i,ct=(e)=>uo.test(e),Ce=500,ke=32000,po=16000,So=128,Eo=200,go=2000,_o=16000,To=80,mo=200,fo=16000;var yo=2000;var ut=20000,Ie=1024,Pe=2000000;var Me=64000,Ge=8000,pt=4000;var dt=960000;var Ro=999,ho=1e4,de=500,bo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],vo=["stopped","starting","ready","failed"],$o=new Set(bo),xo=(e)=>$o.has(e),Oo=(e)=>e&&xo(e)?e:"HOST_REJECTED",ee=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ee);if(Object(e)===e)return Object.values(e).every(ee);return!1},Ao=(e)=>ee(e)&&JSON.stringify(e).length<=fo,lo=(e)=>e?.trim().slice(0,mo)??"",te=(e)=>{let r=e.id.trim().slice(0,So),s=e.title.trim().slice(0,Eo),a=e.url.trim().slice(0,go),u=e.text?.trim().slice(0,_o),g=e.author?.trim().slice(0,To),m=e.kind==="pull"?"pull":"issue",_={providerId:e.providerId.trim(),id:r,title:s||r,url:a,kind:m};if(u)_.text=u;if(g)_.author=g;if(m==="pull"){let C=lo(e.branches?.head),G=lo(e.branches?.base);if(C&&G)_.branches={head:C,base:G}}if(Ao(e.data))_.data=e.data;return _},St=(e)=>{let r=te(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},Et=(e)=>{let r={text:e.text.trim().slice(0,po)};if(e.send)r.send=!0;return r},gt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(Ro,Math.max(0,Math.round(e)))},_t=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(ho,Math.max(0,Math.ceil(e)))};var oe=(e)=>e.length>0&&e.length<=Ie&&!e.includes("\x00")&&!e.includes("\\");var Ue=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>yo)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Ko=new Set(vo),Tt=(e)=>Boolean(e&&"status"in e&&Ko.has(String(e.status))&&!("body"in e)),we=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),mt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),ft=(e)=>Boolean(e&&"written"in e&&e.written===!0),yt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),jo=new Set(co),Rt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&jo.has(String(e.kind))&&Number.isFinite(e.size)),ht=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),zo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Jo=(e)=>Object(e)===e?e:null,nt=(e)=>String(e)===e&&e.length>0,Qo=(e)=>{if(!nt(e.id))return null;if(e.ok===!0){let r={channel:S,v:E,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&nt(e.error))return{channel:S,v:E,type:"result",id:e.id,ok:!1,error:e.error,code:Oo(nt(e.code)?e.code:void 0)};return null},bt=(e)=>{let r=Jo(e);if(!r||r.channel!==S||r.v!==E)return null;if(r.type==="result")return Qo(r);if(!zo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var Co=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Yo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class c extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var ko=()=>Promise.reject(new c("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ne=()=>Promise.reject(new c("BAD_PATH",`File path must be 1 to ${Ie} characters without NUL or backslash.`)),Le=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new c("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},d=(e)=>(e.value+=1,`oc-${e.value}`),vt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new c("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),a=e.requestTimeoutMs??ut,u=new Set,g=new Set,m=new Set,_=new Set,C=new Set,G=new Set,ne=new Set,Ee=new Set,ge=new Set,_e=new Set,Te=new Set,J=new Set,$e=[],ie=null,ae=null,me=new Set,fe=new Set,le=null,ce=null,Ke=!1,Q=new Map,Y=new Map,Z=new Map,D=!1,p={value:0},l=null,H=null,ue=!1,pe=!1,Ht=null,Bt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},U=(t)=>{r.parent.postMessage(t,"*")},Ft=()=>{if(D||r.parent===r||J.size===0||l?.features?.lateGenerateResults!==!0)return;U({channel:S,v:E,type:"generate-late-listen"})},R=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Vt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=bt(t.data);if(!o)return;if(o.type==="workspace"){let i=Y.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="shells"){let i=Z.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,H=Bt(o.payload.session),R(u,o.payload),R(g,o.payload.directory),R(m,o.payload.session),H)R(_,H);if(R(C,o.payload.connection),R(G,o.payload.settings),R(ne,o.payload.item),o.payload.block)R(Ee,o.payload.block);Ft();return}if(o.type==="service-event"){R(ge,o.payload);return}if(o.type==="generate-late"){if(J.size===0)$e.push(o.payload);else R(J,o.payload);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};R(g,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)H=null;else if(H?.sessionId!==o.payload.session.id)H=Bt(o.payload.session);R(m,o.payload.session);return}if(o.type==="session-lifecycle"){H=o.payload,R(_,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};R(C,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};R(G,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};R(ne,o.payload.item);return}if(o.type==="status-control-event"){R(_e,o.payload);return}if(o.type==="popover-closed"){R(Te,o.payload);return}if(o.type==="action"){let i=(T)=>{if(!D)U({channel:S,v:E,type:"action-result",id:o.id,payload:T})},f=ae;if(!f){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>f(o.payload)).then(()=>i({ok:!0}),(T)=>{let O=(T instanceof Error?T.message:String(T)).trim();i({ok:!1,error:(O||"Action failed.").slice(0,de)})});return}if(o.type==="file-open"){let i=o.payload;if(ce&&so(ce,i))return;ce=i,R(me,o.payload);return}if(o.type==="file-saved"){R(fe,o.payload.version);return}if(o.type==="file-snapshot"){let i=(O)=>{if(!D)U({channel:S,v:E,type:"file-snapshot-result",id:o.id,payload:O})},f=(O)=>i({error:(O.trim()||"Could not read the edited file.").slice(0,de)}),T=le;if(!T){f("This extension does not edit files.");return}Promise.resolve().then(()=>T(o.payload.purpose)).then((O)=>{if(ot(O)>xe){f(`The file is over ${xe} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>Oe){f(`The snapshot version is over ${Oe} characters.`);return}i({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>f(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let i=(T)=>{U({channel:S,v:E,type:"resolve-result",id:o.id,payload:T})},f=ie;if(!f){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>f(o.payload)).then((T)=>i({item:T?te(T):null}),(T)=>{let O=(T instanceof Error?T.message:String(T)).trim();i({error:(O||"Command failed.").slice(0,de)})});return}let n=Q.get(o.id);if(!n)return;if(clearTimeout(n.timer),Q.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new c(o.code,o.error))};r.addEventListener("message",Vt),U({channel:S,v:E,type:"hello"});let P=(t,o=a)=>{if(D||r.parent===r)return Promise.reject(new c("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let f=setTimeout(()=>{Q.delete(t.id),i(new c("HOST_TIMEOUT","Host did not answer in time."))},o);Q.set(t.id,{resolve:n,reject:i,timer:f}),U(t)})},v=(t)=>P(t).then(()=>{return}),x={channel:S,v:E},je=(t)=>{if(!D&&r.parent!==r)U(t)},Xt=()=>je({...x,type:"file-save"}),qt=(t)=>{if(!Co(t)||!Yo(t))return;t.preventDefault(),Xt()},Wt=(t)=>{if(!Co(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),zt(l.popover.id,"escape").catch(()=>{return})},ye=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=ue||pe;if(Ht===o)return;Ht=o,Jt(t.id,o).catch(()=>{return})},Re=()=>{if(l?.surface!=="popover"||ue)return;ue=!0,ye()},$t=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!ue)return;ue=!1,ye()},Kt=()=>{if(l?.surface!=="popover"||pe)return;pe=!0,ye()},jt=()=>{if(l?.surface!=="popover"||!pe)return;pe=!1,ye()},L=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new c("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},ze=async(t)=>{if(t.kind!=="projects")L(t.projectId);let o=await P({...x,type:"workspace-read",id:d(p),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new c("HOST_REJECTED","Host did not return workspace data.");return o},Je=async(t,o)=>{if(t.kind!=="projects")L(t.projectId);let n=d(p);Y.set(n,o);try{await v({...x,type:"workspace-subscribe",id:d(p),payload:{subscriptionId:n,query:t}})}catch(i){if(Y.delete(n),!D)U({...x,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:n}});throw i}return()=>{if(!Y.delete(n)||D)return;U({...x,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:n}})}},Xo=async(t,o)=>{if(t.kind==="session")L(t.sessionId);if(t.kind==="project")L(t.projectId);let n=d(p);Z.set(n,o);try{await v({...x,type:"shells-subscribe",id:d(p),payload:{subscriptionId:n,scope:t}})}catch(i){if(Z.delete(n),!D)U({...x,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:n}});throw i}return()=>{if(!Z.delete(n)||D)return;U({...x,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:n}})}},he=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ze))throw new c("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ee(t.value))throw new c("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>et)throw new c("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new c("UNSUPPORTED","This host does not support device storage.");let o=await P({...x,type:"storage",id:d(p),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new c("HOST_REJECTED","Host did not return storage data.");return o},zt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):v({...x,type:"popover-close",id:d(p),payload:o?{id:t,reason:o}:{id:t}}),Jt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):v({...x,type:"popover-anchor",id:d(p),payload:{id:t,active:o}});return r.addEventListener("keydown",Wt,!0),r.addEventListener("pointerover",Re),r.addEventListener("pointermove",Re),r.addEventListener("pointerout",$t),r.addEventListener("focus",Kt),r.addEventListener("blur",jt),{onAction:(t)=>(ae=t,()=>{if(ae===t)ae=null}),listProjects:async()=>{let t=await ze({kind:"projects"});if(t.kind!=="projects")throw new c("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await ze({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new c("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await ze({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new c("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Je({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Je({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Je({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Xo(t,o),readShellOutput:async(t,o)=>{L(t,be);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new c("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>ve))throw new c("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${ve}.`);let T=await P({...x,type:"shell-output",id:d(p),payload:{shellId:t,cursor:n,tailBytes:i}});if(!T||typeof T.output!=="string"||!Number.isFinite(T.cursor))throw new c("HOST_REJECTED","Host did not return shell output.");return T},stopShell:async(t)=>{if(L(t,be),(await P({...x,type:"shell-stop",id:d(p),payload:{shellId:t}}))?.stopped!==!0)throw new c("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{L(t),await v({...x,type:"open-session",id:d(p),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Le(o),i={op:"get",key:t};if(n)i.scope=n;let f=await he(i);return f.op==="get"&&f.found?f.value:void 0},set:async(t,o,n)=>{let i=Le(n),f={op:"set",key:t,value:o};if(i)f.scope=i;await he(f)},delete:async(t,o)=>{let n=Le(o),i={op:"delete",key:t};if(n)i.scope=n;await he(i)},keys:async(t)=>{let o=Le(t),n={op:"keys"};if(o)n.scope=o;let i=await he(n);if(i.op!=="keys")throw new c("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(u.add(t),l)t(l);return()=>{u.delete(t)}},onDirectory:(t)=>{if(g.add(t),l)t(l.directory);return()=>{g.delete(t)}},onSession:(t)=>{if(m.add(t),l)t(l.session);return()=>{m.delete(t)}},onSessionLifecycle:(t)=>{if(_.add(t),H)t(H);return()=>{_.delete(t)}},onConnection:(t)=>{if(C.add(t),l)t(l.connection);return()=>{C.delete(t)}},onSettings:(t)=>{if(G.add(t),l)t(l.settings);return()=>{G.delete(t)}},onItem:(t)=>{if(ne.add(t),l)t(l.item);return()=>{ne.delete(t)}},onBlock:(t)=>{if(Ee.add(t),l?.block)t(l.block);return()=>{Ee.delete(t)}},onServiceEvent:(t)=>(ge.add(t),()=>{ge.delete(t)}),onStatusControl:(t)=>(_e.add(t),()=>{_e.delete(t)}),onPopoverClosed:(t)=>(Te.add(t),()=>{Te.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new c("UNSUPPORTED","This host does not support status controls."));if(!to(t))return Promise.reject(new c("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return v({...x,type:"status-controls",id:d(p),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new c("UNSUPPORTED","This host does not support popovers."));if(!st(t))return Promise.reject(new c("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return v({...x,type:"popover-open",id:d(p),payload:t})},closePopover:zt,setPopoverAnchorActive:Jt,onResolve:(t)=>(ie=t,()=>{if(ie===t)ie=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Ce)return Promise.reject(new c("HOST_REJECTED",`Toast message must contain 1 to ${Ce} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>ke))return Promise.reject(new c("HOST_REJECTED",`Toast copy text must contain 1 to ${ke} characters.`));return v({channel:S,v:E,type:"toast",id:d(p),payload:{...t,message:o}})},openUrl:(t)=>v({channel:S,v:E,type:"open-url",id:d(p),payload:{url:t}}),openCommit:(t)=>ct(t)?v({channel:S,v:E,type:"open-commit",id:d(p),payload:{sha:t}}):Promise.reject(new c("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>v({channel:S,v:E,type:"block-answer",id:d(p),payload:{text:t.trim().slice(0,it)}}),openSurface:(t)=>v({channel:S,v:E,type:"open-surface",id:d(p),payload:{surfaceId:t}}),writeClipboard:(t)=>v({channel:S,v:E,type:"clipboard-write",id:d(p),payload:{text:t}}),compose:(t)=>v({channel:S,v:E,type:"compose",id:d(p),payload:t}),attach:(t)=>v({channel:S,v:E,type:"attach",id:d(p),payload:te(t)}),startSession:async(t)=>{if(t.projectId!==void 0)L(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")L(o.directory);else{if(o.name!==void 0)L(o.name,200);if(o.baseBranch!==void 0)L(o.baseBranch,200)}let n=await P({channel:S,v:E,type:"start-session",id:d(p),payload:St(t)},e.requestTimeoutMs??180000);if(!at(n))throw new c("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>P({channel:S,v:E,type:"prompt",id:d(p),payload:Et(t)}).then((o)=>{if(!lt(o))throw new c("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>v({channel:S,v:E,type:"session-link",id:d(p),payload:te(t)}),close:()=>v({channel:S,v:E,type:"close",id:d(p)}),oauthStart:()=>v({channel:S,v:E,type:"oauth-start",id:d(p)}),oauthDisconnect:()=>v({channel:S,v:E,type:"oauth-disconnect",id:d(p)}),request:(t)=>(Ue(t.path)?P({channel:S,v:E,type:"request",id:d(p),payload:t}):ko()).then((o)=>{if(!we(o))throw new c("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ue(t.path)?P({channel:S,v:E,type:"service-request",id:d(p),payload:t}):ko()).then((o)=>{if(!we(o))throw new c("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:S,v:E,type:"service-status",id:d(p)}).then((t)=>{if(!Tt(t))throw new c("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(oe(t)?P({channel:S,v:E,type:"file-read",id:d(p),payload:{path:t}}):Ne()).then((o)=>{if(!mt(o))throw new c("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!oe(t))return Ne();if(o.length>Pe)return Promise.reject(new c("FILE_TOO_LARGE",`Content is over ${Pe} characters.`));return P({channel:S,v:E,type:"file-write",id:d(p),payload:{path:t,content:o}}).then((n)=>{if(!ft(n))throw new c("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(oe(t)?P({channel:S,v:E,type:"file-list",id:d(p),payload:{path:t}}):Ne()).then((o)=>{if(!yt(o))throw new c("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(oe(t)?P({channel:S,v:E,type:"file-stat",id:d(p),payload:{path:t}}):Ne()).then((o)=>{if(!Rt(o))throw new c("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>Me)return Promise.reject(new c("HOST_REJECTED",`Prompt must be 1 to ${Me} characters.`));if(n!==void 0&&(n.length===0||n.length>Ge))return Promise.reject(new c("HOST_REJECTED",`System prompt must be 1 to ${Ge} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(pt,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new c("HOST_REJECTED","maxOutputTokens must be a number."));let f={prompt:o};if(n!==void 0)f.system=n;if(i!==void 0)f.maxOutputTokens=i;return P({channel:S,v:E,type:"generate",id:d(p),payload:f},e.requestTimeoutMs??dt).then((T)=>{if(!ht(T))throw new c("HOST_REJECTED","Host did not return generated text.");return T})},onLateGenerateResult:(t)=>{J.add(t);for(let o of $e.splice(0))R([t],o);return Ft(),()=>{J.delete(t)}},setBadge:(t)=>v({channel:S,v:E,type:"badge",id:d(p),payload:{count:gt(t)}}),setHeight:(t)=>v({channel:S,v:E,type:"resize",id:d(p),payload:{height:_t(t)}}),onFileOpen:(t)=>{if(me.add(t),!Ke)Ke=!0,r.addEventListener("keydown",qt,!0);if(ce)t(ce);return()=>{me.delete(t)}},onFileSnapshot:(t)=>(le=t,()=>{if(le===t)le=null}),onFileSaved:(t)=>(fe.add(t),()=>{fe.delete(t)}),reportFileChange:(t)=>je({...x,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Xt,reportFileUnsupported:()=>je({...x,type:"file-unsupported"}),dispose:()=>{for(let t of Y.keys())U({...x,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:t}});Y.clear();for(let t of Z.keys())U({...x,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:t}});if(Z.clear(),D=!0,ie=null,ae=null,le=null,me.clear(),fe.clear(),Ke)r.removeEventListener("keydown",qt,!0);r.removeEventListener("message",Vt),r.removeEventListener("keydown",Wt,!0),r.removeEventListener("pointerover",Re),r.removeEventListener("pointermove",Re),r.removeEventListener("pointerout",$t),r.removeEventListener("focus",Kt),r.removeEventListener("blur",jt);for(let t of Q.values())clearTimeout(t.timer),t.reject(new c("HOST_UNAVAILABLE","Host client was disposed."));Q.clear(),u.clear(),g.clear(),m.clear(),_.clear(),C.clear(),G.clear(),ne.clear(),Ee.clear(),ge.clear(),_e.clear(),Te.clear(),J.clear(),$e.length=0}}};var Io=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Dr=new Set(Io);var Po=["none","agent","user"];var Br=new Set(Po);var Zo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],er=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Mo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,a]of Zo)r.style.setProperty(s,e.tokens[a]);for(let[s,a,u]of er){let g=e.tokens[u]??"";r.style.setProperty(s,g),r.style.setProperty(a,g)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},xt=(e,r)=>{if(Mo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var tr={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${tr[e]}, ${r}))`,F=y("surface-background","transparent"),He=y("surface-elevated","transparent"),re=y("surface-elevated-foreground","inherit"),w=y("surface-foreground","inherit"),h=y("surface-muted-foreground","gray"),or=y("surface-muted","transparent"),W=y("interactive-border","currentColor"),M=y("interactive-hover","transparent"),K=y("interactive-active","transparent"),Ot=y("interactive-selection","transparent"),At=y("interactive-selection-foreground","inherit"),B=y("primary","currentColor"),Ct=y("primary-text","inherit"),kt=y("error-text","inherit"),rr=y("font-sans","inherit"),It=y("font-mono","monospace"),No=y("radius","9px"),Pt=`calc(${No} - 2px)`,Go=`calc(${No} - 4px)`,b=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,Uo=`background-image: linear-gradient(${M}, ${M});`,Mt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Gt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",wo="box-shadow: var(--oc-sdk-lit);",Ut=`inset 0 0.5px 0 0 ${b(w,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,sr=`
:root {
  --oc-sdk-edge: ${b(w,16)};
  --oc-sdk-field-bg: ${He};
  --oc-sdk-raised-bg: ${F};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${b(w,14)};
  --oc-sdk-field-bg: ${b(F,50,He)};
  --oc-sdk-raised-bg: ${He};
  --oc-sdk-field-lift: ${Ut};
  --oc-sdk-raised-lift: ${Ut};
  --oc-sdk-lit: ${Ut};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,De=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},nr=`
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
`,Lo=`${sr}
.oc-sdk { color: ${w}; font-family: ${rr}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Uo} }
.oc-sdk-mono { font-family: ${It}; }
.oc-sdk-muted { color: ${h}; }
${De("success")}${De("warning")}${De("error")}${De("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${B}; --oc-sdk-tone-text: ${Ct}; }

.oc-sdk-btn { border-radius: ${Pt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Go}; }
.oc-sdk-btn[data-variant="default"] { color: ${Ct}; background: ${b(B,10,F)}; border-color: ${b(B,12)}; ${wo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${b(B,16,F)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${b(B,22,F)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${or}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${K}, ${K}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${re}; ${Gt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${K}, ${K}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${M}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${K}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${kt}; background: ${b("var(--oc-sdk-tone)",7,F)}; border-color: ${b("var(--oc-sdk-tone)",12)}; ${wo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${b("var(--oc-sdk-tone)",9,F)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${b("var(--oc-sdk-tone)",11,F)}; box-shadow: none; }

.oc-sdk-field-note { color: ${h}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${kt}; }
.oc-sdk-input { border-radius: ${Pt}; background: var(--oc-sdk-field-bg); color: ${re}; ${Mt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${h}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Mt(b(w,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Mt(y("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${It}; }

.oc-sdk-search-icon { color: ${h}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${B}; }
.oc-sdk-search-clear { border-radius: ${Go}; color: ${h}; }
.oc-sdk-search-clear:hover { background: ${M}; color: ${w}; }

.oc-sdk-trigger { border-radius: ${Pt}; background: var(--oc-sdk-raised-bg); color: ${re}; ${Gt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${K}, ${K}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${h}; }
.oc-sdk-trigger-chevron { color: ${h}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${re}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${He}; background-clip: padding-box; color: ${re}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${M}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Ot}; color: ${At}; }
.oc-sdk-option-check { color: ${w}; }
.oc-sdk-option[data-destructive="true"] { color: ${kt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${b(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${h}; }
.oc-sdk-popup-empty { color: ${h}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${W}; border-radius: 4px; color: ${w}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${b(w,60,W)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${W}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${F}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${B}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Uo} }
.oc-sdk-check-desc { color: ${h}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${b(w,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${h}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${w}; }
.oc-sdk-tab[aria-selected="true"] { color: ${At}; background: ${Ot}; border-color: ${W}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${re}; background: var(--oc-sdk-raised-bg); ${Gt} }
.oc-sdk-tab-count { color: ${h}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${b(w,6)}; color: ${h}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${b("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${Ot}; color: ${At}; }
.oc-sdk-row-lead { font-family: ${It}; color: ${h}; }
.oc-sdk-row-sub { color: ${h}; }
.oc-sdk-row-meta { color: ${h}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${h}; }

.oc-sdk-empty-body { color: ${h}; }

.oc-sdk-spinner { color: ${h}; }
.oc-sdk-spinner-ring { border-color: ${W}; border-top-color: ${B}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${b("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${h}; }

.oc-sdk-separator { color: ${h}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${b(W,40)}; }

.oc-sdk-progress-label { color: ${h}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${b(w,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${B}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${y("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${y("success-text","inherit")}; }

.oc-sdk-text a { color: ${Ct}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${b(W,60)}; }
`,k=`
${Qe}
${nr}
${Lo}`;var Do="oc-sdk-ui-style";var I=(e)=>{let r=document.getElementById(Do);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ye(document);let s=document.createElement("style");s.id=Do,s.textContent=e,document.head.appendChild(s)},A=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},V=(e)=>{let r=A("button",e);return r.type="button",r},N=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var ir=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},X=(e,r)=>{I(k);let s=r,a=V("oc-sdk oc-sdk-btn"),u=ir(),g=document.createElement("span");a.append(g),e.append(a);let m=()=>{if(a.dataset.variant=s.variant??"default",a.dataset.size=s.size??"default",a.disabled=Boolean(s.disabled)||Boolean(s.loading),a.dataset.loading=s.loading?"true":"false",a.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&u.parentNode!==a)a.prepend(u);else if(!s.loading&&u.parentNode===a)u.remove();N(g,s.label)},_=()=>{if(s.disabled||s.loading)return;s.onClick()};return a.addEventListener("click",_),m(),{update:(C)=>{s={...s,...C},m()},dispose:()=>{a.removeEventListener("click",_),a.remove()}}};var wt=(e,r)=>{I(k);let s=r,a=A("div","oc-sdk oc-sdk-empty"),u=A("h2","oc-sdk-empty-title"),g=A("p","oc-sdk-empty-body"),m=A("div","oc-sdk-empty-action");a.append(u,g,m),e.append(a);let _=null,C=()=>{if(N(u,s.title),N(g,s.body),g.hidden=!s.body,m.hidden=!s.action,!s.action){_?.dispose(),_=null;return}let G={label:s.action.label,onClick:s.action.onClick};if(_)_.update(G);else _=X(m,{...G,variant:"outline",size:"sm"})};return C(),{update:(G)=>{s={...s,...G},C()},dispose:()=>{_?.dispose(),_=null,a.remove()}}};var pr=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,Ho=(e)=>e.split(`
`).map((r)=>{let s=pr.exec(r);return s?{kind:"item",prefix:s[1]??"- ",done:s[2]!==" ",text:s[3]??""}:{kind:"text",text:r}}),Bo=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),qe=(e)=>{let r=2166136261;for(let s=0;s<e.length;s+=1)r^=e.charCodeAt(s),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},Fo=(e,r)=>{let s=-1,a="- ";e.forEach((_,C)=>{if(_.kind!=="item")return;s=C,a=_.prefix});let u={kind:"item",prefix:a,done:!1,text:r};if(s>=0)return[...e.slice(0,s+1),u,...e.slice(s+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],u,{kind:"text",text:""}]};var z=vt(),j=document.querySelector("#root");if(!j)throw Error("Missing root");var Vo=document.createElement("style");Vo.textContent=`
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
`;document.head.append(Vo);z.onReady((e)=>xt(e,document.documentElement));var q=[],se=!1,Lt=Ae(null),Dt=()=>Bo(q),We=()=>{z.reportFileChange(Lt.observe(qe(Dt())))},Nt=()=>{if(j.replaceChildren(),!q.some((r)=>r.kind==="item")&&se){wt(j,{title:"No items",body:"This checklist is empty."});return}if(q.forEach((r,s)=>{if(r.kind==="text"){let m=document.createElement("p");m.className="note",m.textContent=r.text,j.append(m);return}let a=document.createElement("div");a.className=r.done?"item done":"item";let u=document.createElement("input");u.type="checkbox",u.checked=r.done,u.disabled=se,u.addEventListener("change",()=>{r.done=u.checked,a.className=r.done?"item done":"item",We()});let g=document.createElement("input");if(g.type="text",g.value=r.text,g.readOnly=se,g.setAttribute("aria-label","Item"),g.addEventListener("input",()=>{r.text=g.value,We()}),a.append(u,g),!se){let m=document.createElement("span");m.className="remove",X(m,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{q=q.filter((_,C)=>C!==s),We(),Nt()}}),a.append(m)}j.append(a)}),se)return;let e=document.createElement("div");e.className="actions",X(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{q=Fo(q,""),We(),Nt();let r=j.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),j.append(e)};z.onFileOpen((e)=>{if(e.encoding!=="text"){z.reportFileUnsupported();return}q=Ho(e.content),se=e.readOnly,Lt=Ae(qe(Dt())),Nt()});z.onFileSnapshot(()=>{let e=Dt();return{content:e,version:qe(e)}});z.onFileSaved((e)=>{z.reportFileChange({dirty:Lt.markSaved(e),edited:!1})});})();
