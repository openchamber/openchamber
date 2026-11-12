(()=>{var d="openchamber.sdk",S=1;var qe=`
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
`;function Vt(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let l=new WeakMap;e.addEventListener("scroll",(v)=>{let E=v.target===e?r:v.target;if(!(E instanceof Element))return;if(!E.hasAttribute("data-oc-scrolling"))E.setAttribute("data-oc-scrolling","");let A=l.get(E);if(A!==void 0)clearTimeout(A);l.set(E,setTimeout(()=>{l.delete(E),E.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Po=`(${Vt.toString()})(document);`;var Ke=128,je=65536;var fe=128;var ye=65536;var qt=/^[a-z][a-z0-9-]{0,39}$/;var Wt=(e)=>Object(e)===e&&!Array.isArray(e),ze=(e,r)=>Object.keys(e).every((l)=>r.includes(l)),Xt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,$t=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Kt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let l of e){if(!Wt(l)||!qt.test(l.id)||!Xt(l.label))return!1;if(l.disabled!==void 0&&l.disabled!==!0&&l.disabled!==!1)return!1;if(r.has(l.id))return!1;if(r.add(l.id),l.kind==="button"){if(!ze(l,["kind","id","label","disabled"]))return!1;continue}if(l.kind!=="select"||!ze(l,["kind","id","label","value","options","disabled"]))return!1;if(!$t(l.value)||!Array.isArray(l.options)||l.options.length<1||l.options.length>16)return!1;let v=new Set;for(let E of l.options){if(!Wt(E)||!ze(E,["value","label"])||!$t(E.value)||!Xt(E.label)||v.has(E.value))return!1;v.add(E.value)}if(!v.has(l.value))return!1}return!0};var jt=["{id}","{segment}","{segments+}"];var ir=new Set(jt);var zt=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var lr=new Set(zt);var he=20000000,be=256;var Je=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Jt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let l=0;l<e.bytes.byteLength;l+=1)if(e.bytes[l]!==r.bytes[l])return!1;return!0};var Qt=/^[A-Za-z0-9_-]{1,80}$/;var Yt=["left","right","top","bottom"];var Zt=(e,r=0,l={remaining:16000})=>{if(--l.remaining<0||r>=32)return!1;if(e===null)return!0;let v=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let E of v)if(!Zt(E,r+1,l))return!1;return!0},Qe=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Qe);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Qe)}return String(e)===e||Number.isFinite(e)},Ye=(e)=>{try{if(String(e.id)!==e.id||!Qt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Yt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Zt(e.data)||!Qe(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var et=2000;var to=["file","directory","other","missing"],tt=(e)=>Boolean(e&&"sessionId"in e),ot=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var oo=/^[0-9a-f]{7,64}$/i,rt=(e)=>oo.test(e),ve=500,Ae=32000,ro=16000,so=128,no=200,io=2000,ao=16000,lo=80,uo=200,co=16000;var po=2000;var st=20000,xe=1024,Oe=2000000;var Ce=64000,ke=8000,nt=4000;var it=960000;var So=999,Eo=1e4,ue=500,go=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],_o=["stopped","starting","ready","failed"],Mo=new Set(go),To=(e)=>Mo.has(e),mo=(e)=>e&&To(e)?e:"HOST_REJECTED",J=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(J);if(Object(e)===e)return Object.values(e).every(J);return!1},Ro=(e)=>J(e)&&JSON.stringify(e).length<=co,eo=(e)=>e?.trim().slice(0,uo)??"",Q=(e)=>{let r=e.id.trim().slice(0,so),l=e.title.trim().slice(0,no),v=e.url.trim().slice(0,io),E=e.text?.trim().slice(0,ao),A=e.author?.trim().slice(0,lo),G=e.kind==="pull"?"pull":"issue",C={providerId:e.providerId.trim(),id:r,title:l||r,url:v,kind:G};if(E)C.text=E;if(A)C.author=A;if(G==="pull"){let w=eo(e.branches?.head),V=eo(e.branches?.base);if(w&&V)C.branches={head:w,base:V}}if(Ro(e.data))C.data=e.data;return C},at=(e)=>{let r=Q(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},lt=(e)=>{let r={text:e.text.trim().slice(0,ro)};if(e.send)r.send=!0;return r},ut=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(So,Math.max(0,Math.round(e)))},ct=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Eo,Math.max(0,Math.ceil(e)))};var Y=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var Ie=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>po)return!1;return!e.split("/").some((l)=>l==="."||l==="..")},Uo=new Set(_o),pt=(e)=>Boolean(e&&"status"in e&&Uo.has(String(e.status))&&!("body"in e)),Pe=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),dt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),St=(e)=>Boolean(e&&"written"in e&&e.written===!0),Et=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),wo=new Set(to),gt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&wo.has(String(e.kind))&&Number.isFinite(e.size)),_t=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),No=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Lo=(e)=>Object(e)===e?e:null,Ze=(e)=>String(e)===e&&e.length>0,Do=(e)=>{if(!Ze(e.id))return null;if(e.ok===!0){let r={channel:d,v:S,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ze(e.error))return{channel:d,v:S,type:"result",id:e.id,ok:!1,error:e.error,code:mo(Ze(e.code)?e.code:void 0)};return null},Tt=(e)=>{let r=Lo(e);if(!r||r.channel!==d||r.v!==S)return null;if(r.type==="result")return Do(r);if(!No.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var fo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Ho=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class u extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var yo=()=>Promise.reject(new u("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ge=()=>Promise.reject(new u("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Me=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new u("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},p=(e)=>(e.value+=1,`oc-${e.value}`),mt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new u("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let l=e.acceptSource??((t)=>t===r.parent),v=e.requestTimeoutMs??st,E=new Set,A=new Set,G=new Set,C=new Set,w=new Set,V=new Set,oe=new Set,pe=new Set,de=new Set,Se=new Set,Ee=new Set,q=new Set,Fe=[],re=null,se=null,ge=new Set,_e=new Set,ne=null,ie=null,Ve=!1,K=new Map,j=new Map,z=new Map,L=!1,c={value:0},a=null,D=null,ae=!1,le=!1,It=null,Pt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},M=(t)=>{r.parent.postMessage(t,"*")},Gt=()=>{if(L||r.parent===r||q.size===0||a?.features?.lateGenerateResults!==!0)return;M({channel:d,v:S,type:"generate-late-listen"})},m=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Mt=(t)=>{if(!(t instanceof MessageEvent))return;if(!l(t.source))return;let o=Tt(t.data);if(!o)return;if(o.type==="workspace"){let i=j.get(o.payload.subscriptionId);if(i)m([i],o.payload.snapshot);return}if(o.type==="shells"){let i=z.get(o.payload.subscriptionId);if(i)m([i],o.payload.snapshot);return}if(o.type==="ready"){if(a=o.payload,D=Pt(o.payload.session),m(E,o.payload),m(A,o.payload.directory),m(G,o.payload.session),D)m(C,D);if(m(w,o.payload.connection),m(V,o.payload.settings),m(oe,o.payload.item),o.payload.block)m(pe,o.payload.block);Gt();return}if(o.type==="service-event"){m(de,o.payload);return}if(o.type==="generate-late"){if(q.size===0)Fe.push(o.payload);else m(q,o.payload);return}if(o.type==="directory"){if(a)a={...a,directory:o.payload.directory};m(A,o.payload.directory);return}if(o.type==="session"){if(a)a={...a,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=Pt(o.payload.session);m(G,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,m(C,o.payload);return}if(o.type==="connection"){if(a)a={...a,connection:o.payload.connection};m(w,o.payload.connection);return}if(o.type==="settings"){if(a)a={...a,settings:o.payload.settings};m(V,o.payload.settings);return}if(o.type==="item"){if(a)a={...a,item:o.payload.item};m(oe,o.payload.item);return}if(o.type==="status-control-event"){m(Se,o.payload);return}if(o.type==="popover-closed"){m(Ee,o.payload);return}if(o.type==="action"){let i=(g)=>{if(!L)M({channel:d,v:S,type:"action-result",id:o.id,payload:g})},_=se;if(!_){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>_(o.payload)).then(()=>i({ok:!0}),(g)=>{let b=(g instanceof Error?g.message:String(g)).trim();i({ok:!1,error:(b||"Action failed.").slice(0,ue)})});return}if(o.type==="file-open"){let i=o.payload;if(ie&&Jt(ie,i))return;ie=i,m(ge,o.payload);return}if(o.type==="file-saved"){m(_e,o.payload.version);return}if(o.type==="file-snapshot"){let i=(b)=>{if(!L)M({channel:d,v:S,type:"file-snapshot-result",id:o.id,payload:b})},_=(b)=>i({error:(b.trim()||"Could not read the edited file.").slice(0,ue)}),g=ne;if(!g){_("This extension does not edit files.");return}Promise.resolve().then(()=>g(o.payload.purpose)).then((b)=>{if(Je(b)>he){_(`The file is over ${he} ${"bytes"in b?"bytes":"characters"}.`);return}if(b.version.length>be){_(`The snapshot version is over ${be} characters.`);return}i({snapshot:"bytes"in b?{bytes:b.bytes,version:b.version}:{content:b.content,version:b.version}})},(b)=>_(b instanceof Error?b.message:String(b)));return}if(o.type==="resolve"){let i=(g)=>{M({channel:d,v:S,type:"resolve-result",id:o.id,payload:g})},_=re;if(!_){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>_(o.payload)).then((g)=>i({item:g?Q(g):null}),(g)=>{let b=(g instanceof Error?g.message:String(g)).trim();i({error:(b||"Command failed.").slice(0,ue)})});return}let n=K.get(o.id);if(!n)return;if(clearTimeout(n.timer),K.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new u(o.code,o.error))};r.addEventListener("message",Mt),M({channel:d,v:S,type:"hello"});let x=(t,o=v)=>{if(L||r.parent===r)return Promise.reject(new u("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let _=setTimeout(()=>{K.delete(t.id),i(new u("HOST_TIMEOUT","Host did not answer in time."))},o);K.set(t.id,{resolve:n,reject:i,timer:_}),M(t)})},y=(t)=>x(t).then(()=>{return}),h={channel:d,v:S},We=(t)=>{if(!L&&r.parent!==r)M(t)},Ut=()=>We({...h,type:"file-save"}),wt=(t)=>{if(!fo(t)||!Ho(t))return;t.preventDefault(),Ut()},Nt=(t)=>{if(!fo(t)||t.key!=="Escape"||a?.surface!=="popover"||!a.popover)return;t.preventDefault(),Bt(a.popover.id,"escape").catch(()=>{return})},Te=()=>{let t=a?.surface==="popover"?a.popover:void 0;if(!t)return;let o=ae||le;if(It===o)return;It=o,Ft(t.id,o).catch(()=>{return})},me=()=>{if(a?.surface!=="popover"||ae)return;ae=!0,Te()},Lt=(t)=>{if(a?.surface!=="popover"||t.relatedTarget!==null||!ae)return;ae=!1,Te()},Dt=()=>{if(a?.surface!=="popover"||le)return;le=!0,Te()},Ht=()=>{if(a?.surface!=="popover"||!le)return;le=!1,Te()},N=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new u("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Xe=async(t)=>{if(t.kind!=="projects")N(t.projectId);let o=await x({...h,type:"workspace-read",id:p(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new u("HOST_REJECTED","Host did not return workspace data.");return o},$e=async(t,o)=>{if(t.kind!=="projects")N(t.projectId);let n=p(c);j.set(n,o);try{await y({...h,type:"workspace-subscribe",id:p(c),payload:{subscriptionId:n,query:t}})}catch(i){if(j.delete(n),!L)M({...h,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:n}});throw i}return()=>{if(!j.delete(n)||L)return;M({...h,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:n}})}},Io=async(t,o)=>{if(t.kind==="session")N(t.sessionId);if(t.kind==="project")N(t.projectId);let n=p(c);z.set(n,o);try{await y({...h,type:"shells-subscribe",id:p(c),payload:{subscriptionId:n,scope:t}})}catch(i){if(z.delete(n),!L)M({...h,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:n}});throw i}return()=>{if(!z.delete(n)||L)return;M({...h,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:n}})}},Re=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ke))throw new u("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!J(t.value))throw new u("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>je)throw new u("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&a?.features?.deviceStorage!==!0)throw new u("UNSUPPORTED","This host does not support device storage.");let o=await x({...h,type:"storage",id:p(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new u("HOST_REJECTED","Host did not return storage data.");return o},Bt=(t,o)=>a?.features?.popovers!==!0&&!(a?.surface==="popover"&&a.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):y({...h,type:"popover-close",id:p(c),payload:o?{id:t,reason:o}:{id:t}}),Ft=(t,o)=>a?.features?.popovers!==!0&&!(a?.surface==="popover"&&a.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):y({...h,type:"popover-anchor",id:p(c),payload:{id:t,active:o}});return r.addEventListener("keydown",Nt,!0),r.addEventListener("pointerover",me),r.addEventListener("pointermove",me),r.addEventListener("pointerout",Lt),r.addEventListener("focus",Dt),r.addEventListener("blur",Ht),{onAction:(t)=>(se=t,()=>{if(se===t)se=null}),listProjects:async()=>{let t=await Xe({kind:"projects"});if(t.kind!=="projects")throw new u("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Xe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new u("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Xe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new u("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>$e({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>$e({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>$e({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Io(t,o),readShellOutput:async(t,o)=>{N(t,fe);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new u("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>ye))throw new u("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${ye}.`);let g=await x({...h,type:"shell-output",id:p(c),payload:{shellId:t,cursor:n,tailBytes:i}});if(!g||typeof g.output!=="string"||!Number.isFinite(g.cursor))throw new u("HOST_REJECTED","Host did not return shell output.");return g},stopShell:async(t)=>{if(N(t,fe),(await x({...h,type:"shell-stop",id:p(c),payload:{shellId:t}}))?.stopped!==!0)throw new u("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{N(t),await y({...h,type:"open-session",id:p(c),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Me(o),i={op:"get",key:t};if(n)i.scope=n;let _=await Re(i);return _.op==="get"&&_.found?_.value:void 0},set:async(t,o,n)=>{let i=Me(n),_={op:"set",key:t,value:o};if(i)_.scope=i;await Re(_)},delete:async(t,o)=>{let n=Me(o),i={op:"delete",key:t};if(n)i.scope=n;await Re(i)},keys:async(t)=>{let o=Me(t),n={op:"keys"};if(o)n.scope=o;let i=await Re(n);if(i.op!=="keys")throw new u("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(E.add(t),a)t(a);return()=>{E.delete(t)}},onDirectory:(t)=>{if(A.add(t),a)t(a.directory);return()=>{A.delete(t)}},onSession:(t)=>{if(G.add(t),a)t(a.session);return()=>{G.delete(t)}},onSessionLifecycle:(t)=>{if(C.add(t),D)t(D);return()=>{C.delete(t)}},onConnection:(t)=>{if(w.add(t),a)t(a.connection);return()=>{w.delete(t)}},onSettings:(t)=>{if(V.add(t),a)t(a.settings);return()=>{V.delete(t)}},onItem:(t)=>{if(oe.add(t),a)t(a.item);return()=>{oe.delete(t)}},onBlock:(t)=>{if(pe.add(t),a?.block)t(a.block);return()=>{pe.delete(t)}},onServiceEvent:(t)=>(de.add(t),()=>{de.delete(t)}),onStatusControl:(t)=>(Se.add(t),()=>{Se.delete(t)}),onPopoverClosed:(t)=>(Ee.add(t),()=>{Ee.delete(t)}),setStatusControls:(t)=>{if(a?.features?.statusControls!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support status controls."));if(!Kt(t))return Promise.reject(new u("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return y({...h,type:"status-controls",id:p(c),payload:{controls:t}})},openPopover:(t)=>{if(a?.features?.popovers!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support popovers."));if(!Ye(t))return Promise.reject(new u("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return y({...h,type:"popover-open",id:p(c),payload:t})},closePopover:Bt,setPopoverAnchorActive:Ft,onResolve:(t)=>(re=t,()=>{if(re===t)re=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>ve)return Promise.reject(new u("HOST_REJECTED",`Toast message must contain 1 to ${ve} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Ae))return Promise.reject(new u("HOST_REJECTED",`Toast copy text must contain 1 to ${Ae} characters.`));return y({channel:d,v:S,type:"toast",id:p(c),payload:{...t,message:o}})},openUrl:(t)=>y({channel:d,v:S,type:"open-url",id:p(c),payload:{url:t}}),openCommit:(t)=>rt(t)?y({channel:d,v:S,type:"open-commit",id:p(c),payload:{sha:t}}):Promise.reject(new u("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>y({channel:d,v:S,type:"block-answer",id:p(c),payload:{text:t.trim().slice(0,et)}}),openSurface:(t)=>y({channel:d,v:S,type:"open-surface",id:p(c),payload:{surfaceId:t}}),writeClipboard:(t)=>y({channel:d,v:S,type:"clipboard-write",id:p(c),payload:{text:t}}),compose:(t)=>y({channel:d,v:S,type:"compose",id:p(c),payload:t}),attach:(t)=>y({channel:d,v:S,type:"attach",id:p(c),payload:Q(t)}),startSession:async(t)=>{if(t.projectId!==void 0)N(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")N(o.directory);else{if(o.name!==void 0)N(o.name,200);if(o.baseBranch!==void 0)N(o.baseBranch,200)}let n=await x({channel:d,v:S,type:"start-session",id:p(c),payload:at(t)},e.requestTimeoutMs??180000);if(!tt(n))throw new u("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>x({channel:d,v:S,type:"prompt",id:p(c),payload:lt(t)}).then((o)=>{if(!ot(o))throw new u("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>y({channel:d,v:S,type:"session-link",id:p(c),payload:Q(t)}),close:()=>y({channel:d,v:S,type:"close",id:p(c)}),oauthStart:()=>y({channel:d,v:S,type:"oauth-start",id:p(c)}),oauthDisconnect:()=>y({channel:d,v:S,type:"oauth-disconnect",id:p(c)}),request:(t)=>(Ie(t.path)?x({channel:d,v:S,type:"request",id:p(c),payload:t}):yo()).then((o)=>{if(!Pe(o))throw new u("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ie(t.path)?x({channel:d,v:S,type:"service-request",id:p(c),payload:t}):yo()).then((o)=>{if(!Pe(o))throw new u("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>x({channel:d,v:S,type:"service-status",id:p(c)}).then((t)=>{if(!pt(t))throw new u("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Y(t)?x({channel:d,v:S,type:"file-read",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!dt(o))throw new u("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Y(t))return Ge();if(o.length>Oe)return Promise.reject(new u("FILE_TOO_LARGE",`Content is over ${Oe} characters.`));return x({channel:d,v:S,type:"file-write",id:p(c),payload:{path:t,content:o}}).then((n)=>{if(!St(n))throw new u("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(Y(t)?x({channel:d,v:S,type:"file-list",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!Et(o))throw new u("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Y(t)?x({channel:d,v:S,type:"file-stat",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!gt(o))throw new u("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>Ce)return Promise.reject(new u("HOST_REJECTED",`Prompt must be 1 to ${Ce} characters.`));if(n!==void 0&&(n.length===0||n.length>ke))return Promise.reject(new u("HOST_REJECTED",`System prompt must be 1 to ${ke} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(nt,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new u("HOST_REJECTED","maxOutputTokens must be a number."));let _={prompt:o};if(n!==void 0)_.system=n;if(i!==void 0)_.maxOutputTokens=i;return x({channel:d,v:S,type:"generate",id:p(c),payload:_},e.requestTimeoutMs??it).then((g)=>{if(!_t(g))throw new u("HOST_REJECTED","Host did not return generated text.");return g})},onLateGenerateResult:(t)=>{q.add(t);for(let o of Fe.splice(0))m([t],o);return Gt(),()=>{q.delete(t)}},setBadge:(t)=>y({channel:d,v:S,type:"badge",id:p(c),payload:{count:ut(t)}}),setHeight:(t)=>y({channel:d,v:S,type:"resize",id:p(c),payload:{height:ct(t)}}),onFileOpen:(t)=>{if(ge.add(t),!Ve)Ve=!0,r.addEventListener("keydown",wt,!0);if(ie)t(ie);return()=>{ge.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(_e.add(t),()=>{_e.delete(t)}),reportFileChange:(t)=>We({...h,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Ut,reportFileUnsupported:()=>We({...h,type:"file-unsupported"}),dispose:()=>{for(let t of j.keys())M({...h,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:t}});j.clear();for(let t of z.keys())M({...h,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:t}});if(z.clear(),L=!0,re=null,se=null,ne=null,ge.clear(),_e.clear(),Ve)r.removeEventListener("keydown",wt,!0);r.removeEventListener("message",Mt),r.removeEventListener("keydown",Nt,!0),r.removeEventListener("pointerover",me),r.removeEventListener("pointermove",me),r.removeEventListener("pointerout",Lt),r.removeEventListener("focus",Dt),r.removeEventListener("blur",Ht);for(let t of K.values())clearTimeout(t.timer),t.reject(new u("HOST_UNAVAILABLE","Host client was disposed."));K.clear(),E.clear(),A.clear(),G.clear(),C.clear(),w.clear(),V.clear(),oe.clear(),pe.clear(),de.clear(),Se.clear(),Ee.clear(),q.clear(),Fe.length=0}}};var ho=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var vr=new Set(ho);var bo=["none","agent","user"];var xr=new Set(bo);var Bo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Fo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],vo=(e,r)=>{r.style.colorScheme=e.mode;for(let[l,v]of Bo)r.style.setProperty(l,e.tokens[v]);for(let[l,v,E]of Fo){let A=e.tokens[E]??"";r.style.setProperty(l,A),r.style.setProperty(v,A)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},Rt=(e,r)=>{if(vo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Vo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},T=(e,r)=>`var(--${e}, var(--oc-${Vo[e]}, ${r}))`,B=T("surface-background","transparent"),we=T("surface-elevated","transparent"),Z=T("surface-elevated-foreground","inherit"),U=T("surface-foreground","inherit"),R=T("surface-muted-foreground","gray"),Wo=T("surface-muted","transparent"),W=T("interactive-border","currentColor"),k=T("interactive-hover","transparent"),X=T("interactive-active","transparent"),ft=T("interactive-selection","transparent"),yt=T("interactive-selection-foreground","inherit"),H=T("primary","currentColor"),ht=T("primary-text","inherit"),bt=T("error-text","inherit"),Xo=T("font-sans","inherit"),vt=T("font-mono","monospace"),Co=T("radius","9px"),At=`calc(${Co} - 2px)`,Ao=`calc(${Co} - 4px)`,f=(e,r,l="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${l})`,xo=`background-image: linear-gradient(${k}, ${k});`,xt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Ot="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Oo="box-shadow: var(--oc-sdk-lit);",Ct=`inset 0 0.5px 0 0 ${f(U,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,$o=`
:root {
  --oc-sdk-edge: ${f(U,16)};
  --oc-sdk-field-bg: ${we};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${f(U,14)};
  --oc-sdk-field-bg: ${f(B,50,we)};
  --oc-sdk-raised-bg: ${we};
  --oc-sdk-field-lift: ${Ct};
  --oc-sdk-raised-lift: ${Ct};
  --oc-sdk-lit: ${Ct};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ue=(e)=>{let r=T(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${T(`${e}-text`,"inherit")}; }`},s=(e)=>`calc(${e}rem / 14)`,qo=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: ${s(8)}; height: ${s(32)}; padding: 0 ${s(12)}; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: ${s(6)}; height: ${s(28)}; padding: 0 ${s(10)}; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: ${s(4)}; height: ${s(24)}; padding: 0 ${s(8)}; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: ${s(14)}; height: ${s(14)}; }

.oc-sdk-field { display: flex; flex-direction: column; gap: ${s(4)}; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: ${s(32)}; padding: 0 ${s(10)}; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: ${s(8)} ${s(10)}; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: ${s(34)}; padding-right: ${s(34)}; }
.oc-sdk-search-icon { position: absolute; left: ${s(11)}; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: ${s(6)}; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: ${s(24)}; height: ${s(24)}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: ${s(4)}; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: ${s(6)}; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: ${s(28)}; padding: 0 ${s(10)}; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: ${s(2)}; min-width: ${s(160)}; max-width: calc(100vw - ${s(16)}); max-height: min(${s(320)}, calc(100vh - ${s(16)})); overflow: auto; padding: ${s(4)}; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: ${s(2)} ${s(2)} ${s(4)}; }
.oc-sdk-popup-search .oc-sdk-input { height: ${s(28)}; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: ${s(8)}; width: 100%; padding: ${s(6)} ${s(8)}; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: ${s(14)}; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: ${s(8)}; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: ${s(8)}; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: ${s(14)}; height: ${s(14)}; margin-top: ${s(3)}; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: ${s(36)}; height: ${s(20)}; --oc-sdk-thumb-travel: ${s(16)}; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: ${s(2)}; left: ${s(2)}; width: ${s(16)}; height: ${s(16)}; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: ${s(2)}; padding: ${s(2)}; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: ${s(6)}; height: ${s(28)}; padding: 0 ${s(10)}; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: ${s(1)} ${s(6)}; font-size: ${s(11)}; font-weight: 500; line-height: ${s(16)}; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: ${s(8)}; width: 100%; padding: ${s(6)} ${s(8)}; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: ${s(64)}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: ${s(16)} ${s(8)}; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${s(4)}; padding: ${s(40)} ${s(16)}; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: ${s(12)}; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: ${s(8)}; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: ${s(16)}; height: ${s(16)}; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: ${s(12)}; height: ${s(12)}; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: ${s(12)}; padding: ${s(8)} ${s(12)}; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: ${s(2)}; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: ${s(8)}; width: 100%; margin: ${s(8)} 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: ${s(4)} 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: ${s(4)}; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: ${s(6)}; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }
.oc-sdk-progress-value { display: inline-flex; align-items: center; gap: ${s(2)}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { font-weight: 600; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: ${s(8)} 0; }
`,ko=`${$o}
.oc-sdk { color: ${U}; font-family: ${Xo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${xo} }
.oc-sdk-mono { font-family: ${vt}; }
.oc-sdk-muted { color: ${R}; }
${Ue("success")}${Ue("warning")}${Ue("error")}${Ue("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${H}; --oc-sdk-tone-text: ${ht}; }

.oc-sdk-btn { border-radius: ${At}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Ao}; }
.oc-sdk-btn[data-variant="default"] { color: ${ht}; background: ${f(H,10,B)}; border-color: ${f(H,12)}; ${Oo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${f(H,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${f(H,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Wo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${k}, ${k}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${X}, ${X}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${Z}; ${Ot} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${k}, ${k}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${X}, ${X}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${k}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${X}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${T("status-error","red")}; color: ${bt}; background: ${f("var(--oc-sdk-tone)",7,B)}; border-color: ${f("var(--oc-sdk-tone)",12)}; ${Oo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${f("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${f("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${R}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${bt}; }
.oc-sdk-input { border-radius: ${At}; background: var(--oc-sdk-field-bg); color: ${Z}; ${xt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${R}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${k}, ${k}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${xt(f(U,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${xt(T("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${vt}; }

.oc-sdk-search-icon { color: ${R}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${H}; }
.oc-sdk-search-clear { border-radius: ${Ao}; color: ${R}; }
.oc-sdk-search-clear:hover { background: ${k}; color: ${U}; }

.oc-sdk-trigger { border-radius: ${At}; background: var(--oc-sdk-raised-bg); color: ${Z}; ${Ot} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${k}, ${k}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${X}, ${X}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${R}; }
.oc-sdk-trigger-chevron { color: ${R}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${Z}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${we}; background-clip: padding-box; color: ${Z}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${k}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${ft}; color: ${yt}; }
.oc-sdk-option-check { color: ${U}; }
.oc-sdk-option[data-destructive="true"] { color: ${bt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${f(T("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${R}; }
.oc-sdk-popup-empty { color: ${R}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${W}; border-radius: 4px; color: ${U}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${f(U,60,W)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${W}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${H}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${xo} }
.oc-sdk-check-desc { color: ${R}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${f(U,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${R}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${U}; }
.oc-sdk-tab[aria-selected="true"] { color: ${yt}; background: ${ft}; border-color: ${W}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${Z}; background: var(--oc-sdk-raised-bg); ${Ot} }
.oc-sdk-tab-count { color: ${R}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${f(U,6)}; color: ${R}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${f("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${k}; }
.oc-sdk-row[aria-selected="true"] { background: ${ft}; color: ${yt}; }
.oc-sdk-row-lead { font-family: ${vt}; color: ${R}; }
.oc-sdk-row-sub { color: ${R}; }
.oc-sdk-row-meta { color: ${R}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${R}; }

.oc-sdk-empty-body { color: ${R}; }

.oc-sdk-spinner { color: ${R}; }
.oc-sdk-spinner-ring { border-color: ${W}; border-top-color: ${H}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${f("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${R}; }

.oc-sdk-separator { color: ${R}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${f(W,40)}; }

.oc-sdk-progress-label { color: ${R}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${f(U,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${H}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${T("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${T("success-text","inherit")}; }

.oc-sdk-text a { color: ${ht}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${f(W,60)}; }
`,O=`
${qe}
${qo}
${ko}`;var Be=mt(),te=document.querySelector("#root");if(!te)throw Error("DeskChart: missing root");te.style.padding="12px";Be.onReady((e)=>Rt(e,document.documentElement));Be.onBlock(({args:e,answered:r})=>{let l=(e.values??"").split(",").map(Number).filter(Number.isFinite),v=Math.max(1,...l);te.replaceChildren();let E=document.createElement("div");E.textContent=e.title??"",E.style.font="600 13px var(--oc-font, system-ui)";let A=document.createElement("div");A.style.cssText="display:flex;align-items:flex-end;gap:6px;height:96px;margin-top:8px";for(let C of l){let w=document.createElement("div");w.style.cssText=`flex:1;height:${C/v*100}%;background:currentColor;opacity:.6;border-radius:3px 3px 0 0`,w.title=String(C),A.append(w)}let G=document.createElement("button");G.textContent=r??"Explain this",G.disabled=r!==null,G.addEventListener("click",()=>{Be.answerBlock("Explain this chart")}),te.append(E,A,G)});new ResizeObserver(()=>{Be.setHeight(Math.ceil(te.getBoundingClientRect().height))}).observe(te);})();
