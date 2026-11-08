(()=>{var p="openchamber.sdk",d=1;var We=`
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
`;function Ft(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let a=new WeakMap;e.addEventListener("scroll",(b)=>{let S=b.target===e?r:b.target;if(!(S instanceof Element))return;if(!S.hasAttribute("data-oc-scrolling"))S.setAttribute("data-oc-scrolling","");let v=a.get(S);if(v!==void 0)clearTimeout(v);a.set(S,setTimeout(()=>{a.delete(S),S.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Io=`(${Ft.toString()})(document);`;var $e=128,Ke=65536;var fe=128;var Re=65536;var Wt=/^[a-z][a-z0-9-]{0,39}$/;var Vt=(e)=>Object(e)===e&&!Array.isArray(e),je=(e,r)=>Object.keys(e).every((a)=>r.includes(a)),Xt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,qt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,$t=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let a of e){if(!Vt(a)||!Wt.test(a.id)||!Xt(a.label))return!1;if(a.disabled!==void 0&&a.disabled!==!0&&a.disabled!==!1)return!1;if(r.has(a.id))return!1;if(r.add(a.id),a.kind==="button"){if(!je(a,["kind","id","label","disabled"]))return!1;continue}if(a.kind!=="select"||!je(a,["kind","id","label","value","options","disabled"]))return!1;if(!qt(a.value)||!Array.isArray(a.options)||a.options.length<1||a.options.length>16)return!1;let b=new Set;for(let S of a.options){if(!Vt(S)||!je(S,["value","label"])||!qt(S.value)||!Xt(S.label)||b.has(S.value))return!1;b.add(S.value)}if(!b.has(a.value))return!1}return!0};var Kt=["{id}","{segment}","{segments+}"];var nr=new Set(Kt);var jt=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var ar=new Set(jt);var ye=20000000,he=256;var ze=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,zt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let a=0;a<e.bytes.byteLength;a+=1)if(e.bytes[a]!==r.bytes[a])return!1;return!0};var Qt=/^[A-Za-z0-9_-]{1,80}$/;var Jt=["left","right","top","bottom"];var Yt=(e,r=0,a={remaining:16000})=>{if(--a.remaining<0||r>=32)return!1;if(e===null)return!0;let b=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let S of b)if(!Yt(S,r+1,a))return!1;return!0},Qe=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Qe);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Qe)}return String(e)===e||Number.isFinite(e)},Je=(e)=>{try{if(String(e.id)!==e.id||!Qt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Jt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Yt(e.data)||!Qe(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var Ze=2000;var eo=["file","directory","other","missing"],et=(e)=>Boolean(e&&"sessionId"in e),tt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var to=/^[0-9a-f]{7,64}$/i,ot=(e)=>to.test(e),be=500,ve=32000,oo=16000,ro=128,so=200,no=2000,io=16000,ao=80,lo=200,uo=16000;var co=2000;var rt=20000,xe=1024,Oe=2000000;var Ae=64000,Ce=8000,st=4000;var nt=960000;var po=999,So=1e4,le=500,Eo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],go=["stopped","starting","ready","failed"],Go=new Set(Eo),_o=(e)=>Go.has(e),To=(e)=>e&&_o(e)?e:"HOST_REJECTED",z=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(z);if(Object(e)===e)return Object.values(e).every(z);return!1},mo=(e)=>z(e)&&JSON.stringify(e).length<=uo,Zt=(e)=>e?.trim().slice(0,lo)??"",Q=(e)=>{let r=e.id.trim().slice(0,ro),a=e.title.trim().slice(0,so),b=e.url.trim().slice(0,no),S=e.text?.trim().slice(0,io),v=e.author?.trim().slice(0,ao),P=e.kind==="pull"?"pull":"issue",A={providerId:e.providerId.trim(),id:r,title:a||r,url:b,kind:P};if(S)A.text=S;if(v)A.author=v;if(P==="pull"){let U=Zt(e.branches?.head),F=Zt(e.branches?.base);if(U&&F)A.branches={head:U,base:F}}if(mo(e.data))A.data=e.data;return A},it=(e)=>{let r=Q(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},at=(e)=>{let r={text:e.text.trim().slice(0,oo)};if(e.send)r.send=!0;return r},lt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(po,Math.max(0,Math.round(e)))},ut=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(So,Math.max(0,Math.ceil(e)))};var J=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var ke=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>co)return!1;return!e.split("/").some((a)=>a==="."||a==="..")},Mo=new Set(go),ct=(e)=>Boolean(e&&"status"in e&&Mo.has(String(e.status))&&!("body"in e)),Ie=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),pt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),dt=(e)=>Boolean(e&&"written"in e&&e.written===!0),St=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Uo=new Set(eo),Et=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Uo.has(String(e.kind))&&Number.isFinite(e.size)),gt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),wo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),No=(e)=>Object(e)===e?e:null,Ye=(e)=>String(e)===e&&e.length>0,Lo=(e)=>{if(!Ye(e.id))return null;if(e.ok===!0){let r={channel:p,v:d,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ye(e.error))return{channel:p,v:d,type:"result",id:e.id,ok:!1,error:e.error,code:To(Ye(e.code)?e.code:void 0)};return null},_t=(e)=>{let r=No(e);if(!r||r.channel!==p||r.v!==d)return null;if(r.type==="result")return Lo(r);if(!wo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var fo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Do=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class l extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Ro=()=>Promise.reject(new l("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Pe=()=>Promise.reject(new l("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Ge=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new l("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},c=(e)=>(e.value+=1,`oc-${e.value}`),Tt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new l("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let a=e.acceptSource??((t)=>t===r.parent),b=e.requestTimeoutMs??rt,S=new Set,v=new Set,P=new Set,A=new Set,U=new Set,F=new Set,te=new Set,ce=new Set,pe=new Set,de=new Set,Se=new Set,q=new Set,Be=[],oe=null,re=null,Ee=new Set,ge=new Set,se=null,ne=null,Fe=!1,W=new Map,K=new Map,j=new Map,N=!1,u={value:0},i=null,L=null,ie=!1,ae=!1,kt=null,It=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},G=(t)=>{r.parent.postMessage(t,"*")},Pt=()=>{if(N||r.parent===r||q.size===0||i?.features?.lateGenerateResults!==!0)return;G({channel:p,v:d,type:"generate-late-listen"})},T=(t,o)=>{for(let s of t)try{s(o)}catch(n){console.error(n)}},Gt=(t)=>{if(!(t instanceof MessageEvent))return;if(!a(t.source))return;let o=_t(t.data);if(!o)return;if(o.type==="workspace"){let n=K.get(o.payload.subscriptionId);if(n)T([n],o.payload.snapshot);return}if(o.type==="shells"){let n=j.get(o.payload.subscriptionId);if(n)T([n],o.payload.snapshot);return}if(o.type==="ready"){if(i=o.payload,L=It(o.payload.session),T(S,o.payload),T(v,o.payload.directory),T(P,o.payload.session),L)T(A,L);if(T(U,o.payload.connection),T(F,o.payload.settings),T(te,o.payload.item),o.payload.block)T(ce,o.payload.block);Pt();return}if(o.type==="service-event"){T(pe,o.payload);return}if(o.type==="generate-late"){if(q.size===0)Be.push(o.payload);else T(q,o.payload);return}if(o.type==="directory"){if(i)i={...i,directory:o.payload.directory};T(v,o.payload.directory);return}if(o.type==="session"){if(i)i={...i,session:o.payload.session};if(!o.payload.session)L=null;else if(L?.sessionId!==o.payload.session.id)L=It(o.payload.session);T(P,o.payload.session);return}if(o.type==="session-lifecycle"){L=o.payload,T(A,o.payload);return}if(o.type==="connection"){if(i)i={...i,connection:o.payload.connection};T(U,o.payload.connection);return}if(o.type==="settings"){if(i)i={...i,settings:o.payload.settings};T(F,o.payload.settings);return}if(o.type==="item"){if(i)i={...i,item:o.payload.item};T(te,o.payload.item);return}if(o.type==="status-control-event"){T(de,o.payload);return}if(o.type==="popover-closed"){T(Se,o.payload);return}if(o.type==="action"){let n=(E)=>{if(!N)G({channel:p,v:d,type:"action-result",id:o.id,payload:E})},g=re;if(!g){n({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>g(o.payload)).then(()=>n({ok:!0}),(E)=>{let h=(E instanceof Error?E.message:String(E)).trim();n({ok:!1,error:(h||"Action failed.").slice(0,le)})});return}if(o.type==="file-open"){let n=o.payload;if(ne&&zt(ne,n))return;ne=n,T(Ee,o.payload);return}if(o.type==="file-saved"){T(ge,o.payload.version);return}if(o.type==="file-snapshot"){let n=(h)=>{if(!N)G({channel:p,v:d,type:"file-snapshot-result",id:o.id,payload:h})},g=(h)=>n({error:(h.trim()||"Could not read the edited file.").slice(0,le)}),E=se;if(!E){g("This extension does not edit files.");return}Promise.resolve().then(()=>E(o.payload.purpose)).then((h)=>{if(ze(h)>ye){g(`The file is over ${ye} ${"bytes"in h?"bytes":"characters"}.`);return}if(h.version.length>he){g(`The snapshot version is over ${he} characters.`);return}n({snapshot:"bytes"in h?{bytes:h.bytes,version:h.version}:{content:h.content,version:h.version}})},(h)=>g(h instanceof Error?h.message:String(h)));return}if(o.type==="resolve"){let n=(E)=>{G({channel:p,v:d,type:"resolve-result",id:o.id,payload:E})},g=oe;if(!g){n({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>g(o.payload)).then((E)=>n({item:E?Q(E):null}),(E)=>{let h=(E instanceof Error?E.message:String(E)).trim();n({error:(h||"Command failed.").slice(0,le)})});return}let s=W.get(o.id);if(!s)return;if(clearTimeout(s.timer),W.delete(o.id),o.ok){s.resolve(o.payload);return}s.reject(new l(o.code,o.error))};r.addEventListener("message",Gt),G({channel:p,v:d,type:"hello"});let x=(t,o=b)=>{if(N||r.parent===r)return Promise.reject(new l("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((s,n)=>{let g=setTimeout(()=>{W.delete(t.id),n(new l("HOST_TIMEOUT","Host did not answer in time."))},o);W.set(t.id,{resolve:s,reject:n,timer:g}),G(t)})},R=(t)=>x(t).then(()=>{return}),y={channel:p,v:d},Ve=(t)=>{if(!N&&r.parent!==r)G(t)},Mt=()=>Ve({...y,type:"file-save"}),Ut=(t)=>{if(!fo(t)||!Do(t))return;t.preventDefault(),Mt()},wt=(t)=>{if(!fo(t)||t.key!=="Escape"||i?.surface!=="popover"||!i.popover)return;t.preventDefault(),Ht(i.popover.id,"escape").catch(()=>{return})},_e=()=>{let t=i?.surface==="popover"?i.popover:void 0;if(!t)return;let o=ie||ae;if(kt===o)return;kt=o,Bt(t.id,o).catch(()=>{return})},Te=()=>{if(i?.surface!=="popover"||ie)return;ie=!0,_e()},Nt=(t)=>{if(i?.surface!=="popover"||t.relatedTarget!==null||!ie)return;ie=!1,_e()},Lt=()=>{if(i?.surface!=="popover"||ae)return;ae=!0,_e()},Dt=()=>{if(i?.surface!=="popover"||!ae)return;ae=!1,_e()},w=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new l("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Xe=async(t)=>{if(t.kind!=="projects")w(t.projectId);let o=await x({...y,type:"workspace-read",id:c(u),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new l("HOST_REJECTED","Host did not return workspace data.");return o},qe=async(t,o)=>{if(t.kind!=="projects")w(t.projectId);let s=c(u);K.set(s,o);try{await R({...y,type:"workspace-subscribe",id:c(u),payload:{subscriptionId:s,query:t}})}catch(n){if(K.delete(s),!N)G({...y,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:s}});throw n}return()=>{if(!K.delete(s)||N)return;G({...y,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:s}})}},ko=async(t,o)=>{if(t.kind==="session")w(t.sessionId);if(t.kind==="project")w(t.projectId);let s=c(u);j.set(s,o);try{await R({...y,type:"shells-subscribe",id:c(u),payload:{subscriptionId:s,scope:t}})}catch(n){if(j.delete(s),!N)G({...y,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:s}});throw n}return()=>{if(!j.delete(s)||N)return;G({...y,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:s}})}},me=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>$e))throw new l("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!z(t.value))throw new l("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Ke)throw new l("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&i?.features?.deviceStorage!==!0)throw new l("UNSUPPORTED","This host does not support device storage.");let o=await x({...y,type:"storage",id:c(u),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new l("HOST_REJECTED","Host did not return storage data.");return o},Ht=(t,o)=>i?.features?.popovers!==!0&&!(i?.surface==="popover"&&i.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):R({...y,type:"popover-close",id:c(u),payload:o?{id:t,reason:o}:{id:t}}),Bt=(t,o)=>i?.features?.popovers!==!0&&!(i?.surface==="popover"&&i.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):R({...y,type:"popover-anchor",id:c(u),payload:{id:t,active:o}});return r.addEventListener("keydown",wt,!0),r.addEventListener("pointerover",Te),r.addEventListener("pointermove",Te),r.addEventListener("pointerout",Nt),r.addEventListener("focus",Lt),r.addEventListener("blur",Dt),{onAction:(t)=>(re=t,()=>{if(re===t)re=null}),listProjects:async()=>{let t=await Xe({kind:"projects"});if(t.kind!=="projects")throw new l("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Xe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new l("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Xe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new l("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>qe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>qe({kind:"worktrees",projectId:t},(s)=>{if(s.kind==="worktrees")o(s)}),onSessions:(t,o)=>qe({kind:"sessions",projectId:t},(s)=>{if(s.kind==="sessions")o(s)}),onRunningShells:(t,o)=>ko(t,o),readShellOutput:async(t,o)=>{w(t,fe);let s=o?.cursor;if(s!==void 0&&(!Number.isInteger(s)||s<0))throw new l("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let n=o?.tailBytes;if(n!==void 0&&(!Number.isInteger(n)||n<1||n>Re))throw new l("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${Re}.`);let E=await x({...y,type:"shell-output",id:c(u),payload:{shellId:t,cursor:s,tailBytes:n}});if(!E||typeof E.output!=="string"||!Number.isFinite(E.cursor))throw new l("HOST_REJECTED","Host did not return shell output.");return E},stopShell:async(t)=>{if(w(t,fe),(await x({...y,type:"shell-stop",id:c(u),payload:{shellId:t}}))?.stopped!==!0)throw new l("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{w(t),await R({...y,type:"open-session",id:c(u),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let s=Ge(o),n={op:"get",key:t};if(s)n.scope=s;let g=await me(n);return g.op==="get"&&g.found?g.value:void 0},set:async(t,o,s)=>{let n=Ge(s),g={op:"set",key:t,value:o};if(n)g.scope=n;await me(g)},delete:async(t,o)=>{let s=Ge(o),n={op:"delete",key:t};if(s)n.scope=s;await me(n)},keys:async(t)=>{let o=Ge(t),s={op:"keys"};if(o)s.scope=o;let n=await me(s);if(n.op!=="keys")throw new l("HOST_REJECTED","Expected storage keys.");return n.keys}},onReady:(t)=>{if(S.add(t),i)t(i);return()=>{S.delete(t)}},onDirectory:(t)=>{if(v.add(t),i)t(i.directory);return()=>{v.delete(t)}},onSession:(t)=>{if(P.add(t),i)t(i.session);return()=>{P.delete(t)}},onSessionLifecycle:(t)=>{if(A.add(t),L)t(L);return()=>{A.delete(t)}},onConnection:(t)=>{if(U.add(t),i)t(i.connection);return()=>{U.delete(t)}},onSettings:(t)=>{if(F.add(t),i)t(i.settings);return()=>{F.delete(t)}},onItem:(t)=>{if(te.add(t),i)t(i.item);return()=>{te.delete(t)}},onBlock:(t)=>{if(ce.add(t),i?.block)t(i.block);return()=>{ce.delete(t)}},onServiceEvent:(t)=>(pe.add(t),()=>{pe.delete(t)}),onStatusControl:(t)=>(de.add(t),()=>{de.delete(t)}),onPopoverClosed:(t)=>(Se.add(t),()=>{Se.delete(t)}),setStatusControls:(t)=>{if(i?.features?.statusControls!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support status controls."));if(!$t(t))return Promise.reject(new l("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return R({...y,type:"status-controls",id:c(u),payload:{controls:t}})},openPopover:(t)=>{if(i?.features?.popovers!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support popovers."));if(!Je(t))return Promise.reject(new l("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return R({...y,type:"popover-open",id:c(u),payload:t})},closePopover:Ht,setPopoverAnchorActive:Bt,onResolve:(t)=>(oe=t,()=>{if(oe===t)oe=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>be)return Promise.reject(new l("HOST_REJECTED",`Toast message must contain 1 to ${be} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>ve))return Promise.reject(new l("HOST_REJECTED",`Toast copy text must contain 1 to ${ve} characters.`));return R({channel:p,v:d,type:"toast",id:c(u),payload:{...t,message:o}})},openUrl:(t)=>R({channel:p,v:d,type:"open-url",id:c(u),payload:{url:t}}),openCommit:(t)=>ot(t)?R({channel:p,v:d,type:"open-commit",id:c(u),payload:{sha:t}}):Promise.reject(new l("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>R({channel:p,v:d,type:"block-answer",id:c(u),payload:{text:t.trim().slice(0,Ze)}}),openSurface:(t)=>R({channel:p,v:d,type:"open-surface",id:c(u),payload:{surfaceId:t}}),writeClipboard:(t)=>R({channel:p,v:d,type:"clipboard-write",id:c(u),payload:{text:t}}),compose:(t)=>R({channel:p,v:d,type:"compose",id:c(u),payload:t}),attach:(t)=>R({channel:p,v:d,type:"attach",id:c(u),payload:Q(t)}),startSession:async(t)=>{if(t.projectId!==void 0)w(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")w(o.directory);else{if(o.name!==void 0)w(o.name,200);if(o.baseBranch!==void 0)w(o.baseBranch,200)}let s=await x({channel:p,v:d,type:"start-session",id:c(u),payload:it(t)},e.requestTimeoutMs??180000);if(!et(s))throw new l("HOST_REJECTED","Host did not return a session.");return s},prompt:(t)=>x({channel:p,v:d,type:"prompt",id:c(u),payload:at(t)}).then((o)=>{if(!tt(o))throw new l("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>R({channel:p,v:d,type:"session-link",id:c(u),payload:Q(t)}),close:()=>R({channel:p,v:d,type:"close",id:c(u)}),oauthStart:()=>R({channel:p,v:d,type:"oauth-start",id:c(u)}),oauthDisconnect:()=>R({channel:p,v:d,type:"oauth-disconnect",id:c(u)}),request:(t)=>(ke(t.path)?x({channel:p,v:d,type:"request",id:c(u),payload:t}):Ro()).then((o)=>{if(!Ie(o))throw new l("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(ke(t.path)?x({channel:p,v:d,type:"service-request",id:c(u),payload:t}):Ro()).then((o)=>{if(!Ie(o))throw new l("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>x({channel:p,v:d,type:"service-status",id:c(u)}).then((t)=>{if(!ct(t))throw new l("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(J(t)?x({channel:p,v:d,type:"file-read",id:c(u),payload:{path:t}}):Pe()).then((o)=>{if(!pt(o))throw new l("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!J(t))return Pe();if(o.length>Oe)return Promise.reject(new l("FILE_TOO_LARGE",`Content is over ${Oe} characters.`));return x({channel:p,v:d,type:"file-write",id:c(u),payload:{path:t,content:o}}).then((s)=>{if(!dt(s))throw new l("HOST_REJECTED","Host did not confirm the write.");return s})},listDir:(t)=>(J(t)?x({channel:p,v:d,type:"file-list",id:c(u),payload:{path:t}}):Pe()).then((o)=>{if(!St(o))throw new l("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(J(t)?x({channel:p,v:d,type:"file-stat",id:c(u),payload:{path:t}}):Pe()).then((o)=>{if(!Et(o))throw new l("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),s=t.system?.trim();if(o.length===0||o.length>Ae)return Promise.reject(new l("HOST_REJECTED",`Prompt must be 1 to ${Ae} characters.`));if(s!==void 0&&(s.length===0||s.length>Ce))return Promise.reject(new l("HOST_REJECTED",`System prompt must be 1 to ${Ce} characters.`));let n=t.maxOutputTokens===void 0?void 0:Math.min(st,Math.max(1,Math.floor(t.maxOutputTokens)));if(n!==void 0&&!Number.isFinite(n))return Promise.reject(new l("HOST_REJECTED","maxOutputTokens must be a number."));let g={prompt:o};if(s!==void 0)g.system=s;if(n!==void 0)g.maxOutputTokens=n;return x({channel:p,v:d,type:"generate",id:c(u),payload:g},e.requestTimeoutMs??nt).then((E)=>{if(!gt(E))throw new l("HOST_REJECTED","Host did not return generated text.");return E})},onLateGenerateResult:(t)=>{q.add(t);for(let o of Be.splice(0))T([t],o);return Pt(),()=>{q.delete(t)}},setBadge:(t)=>R({channel:p,v:d,type:"badge",id:c(u),payload:{count:lt(t)}}),setHeight:(t)=>R({channel:p,v:d,type:"resize",id:c(u),payload:{height:ut(t)}}),onFileOpen:(t)=>{if(Ee.add(t),!Fe)Fe=!0,r.addEventListener("keydown",Ut,!0);if(ne)t(ne);return()=>{Ee.delete(t)}},onFileSnapshot:(t)=>(se=t,()=>{if(se===t)se=null}),onFileSaved:(t)=>(ge.add(t),()=>{ge.delete(t)}),reportFileChange:(t)=>Ve({...y,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Mt,reportFileUnsupported:()=>Ve({...y,type:"file-unsupported"}),dispose:()=>{for(let t of K.keys())G({...y,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:t}});K.clear();for(let t of j.keys())G({...y,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:t}});if(j.clear(),N=!0,oe=null,re=null,se=null,Ee.clear(),ge.clear(),Fe)r.removeEventListener("keydown",Ut,!0);r.removeEventListener("message",Gt),r.removeEventListener("keydown",wt,!0),r.removeEventListener("pointerover",Te),r.removeEventListener("pointermove",Te),r.removeEventListener("pointerout",Nt),r.removeEventListener("focus",Lt),r.removeEventListener("blur",Dt);for(let t of W.values())clearTimeout(t.timer),t.reject(new l("HOST_UNAVAILABLE","Host client was disposed."));W.clear(),S.clear(),v.clear(),P.clear(),A.clear(),U.clear(),F.clear(),te.clear(),ce.clear(),pe.clear(),de.clear(),Se.clear(),q.clear(),Be.length=0}}};var yo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var hr=new Set(yo);var ho=["none","agent","user"];var vr=new Set(ho);var Ho=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Bo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],bo=(e,r)=>{r.style.colorScheme=e.mode;for(let[a,b]of Ho)r.style.setProperty(a,e.tokens[b]);for(let[a,b,S]of Bo){let v=e.tokens[S]??"";r.style.setProperty(a,v),r.style.setProperty(b,v)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},mt=(e,r)=>{if(bo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Fo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},_=(e,r)=>`var(--${e}, var(--oc-${Fo[e]}, ${r}))`,H=_("surface-background","transparent"),Ue=_("surface-elevated","transparent"),Y=_("surface-elevated-foreground","inherit"),M=_("surface-foreground","inherit"),m=_("surface-muted-foreground","gray"),Vo=_("surface-muted","transparent"),V=_("interactive-border","currentColor"),C=_("interactive-hover","transparent"),X=_("interactive-active","transparent"),ft=_("interactive-selection","transparent"),Rt=_("interactive-selection-foreground","inherit"),D=_("primary","currentColor"),yt=_("primary-text","inherit"),ht=_("error-text","inherit"),Xo=_("font-sans","inherit"),bt=_("font-mono","monospace"),Ao=_("radius","9px"),vt=`calc(${Ao} - 2px)`,vo=`calc(${Ao} - 4px)`,f=(e,r,a="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${a})`,xo=`background-image: linear-gradient(${C}, ${C});`,xt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Ot="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Oo="box-shadow: var(--oc-sdk-lit);",At=`inset 0 0.5px 0 0 ${f(M,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,qo=`
:root {
  --oc-sdk-edge: ${f(M,16)};
  --oc-sdk-field-bg: ${Ue};
  --oc-sdk-raised-bg: ${H};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${f(M,14)};
  --oc-sdk-field-bg: ${f(H,50,Ue)};
  --oc-sdk-raised-bg: ${Ue};
  --oc-sdk-field-lift: ${At};
  --oc-sdk-raised-lift: ${At};
  --oc-sdk-lit: ${At};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Me=(e)=>{let r=_(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${_(`${e}-text`,"inherit")}; }`},Wo=`
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
`,Co=`${qo}
.oc-sdk { color: ${M}; font-family: ${Xo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${xo} }
.oc-sdk-mono { font-family: ${bt}; }
.oc-sdk-muted { color: ${m}; }
${Me("success")}${Me("warning")}${Me("error")}${Me("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${D}; --oc-sdk-tone-text: ${yt}; }

.oc-sdk-btn { border-radius: ${vt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${vo}; }
.oc-sdk-btn[data-variant="default"] { color: ${yt}; background: ${f(D,10,H)}; border-color: ${f(D,12)}; ${Oo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${f(D,16,H)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${f(D,22,H)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Vo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${C}, ${C}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${X}, ${X}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${Y}; ${Ot} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${C}, ${C}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${X}, ${X}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${C}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${X}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${_("status-error","red")}; color: ${ht}; background: ${f("var(--oc-sdk-tone)",7,H)}; border-color: ${f("var(--oc-sdk-tone)",12)}; ${Oo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${f("var(--oc-sdk-tone)",9,H)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${f("var(--oc-sdk-tone)",11,H)}; box-shadow: none; }

.oc-sdk-field-note { color: ${m}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${ht}; }
.oc-sdk-input { border-radius: ${vt}; background: var(--oc-sdk-field-bg); color: ${Y}; ${xt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${m}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${C}, ${C}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${xt(f(M,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${xt(_("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${bt}; }

.oc-sdk-search-icon { color: ${m}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${D}; }
.oc-sdk-search-clear { border-radius: ${vo}; color: ${m}; }
.oc-sdk-search-clear:hover { background: ${C}; color: ${M}; }

.oc-sdk-trigger { border-radius: ${vt}; background: var(--oc-sdk-raised-bg); color: ${Y}; ${Ot} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${C}, ${C}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${X}, ${X}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${m}; }
.oc-sdk-trigger-chevron { color: ${m}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${Y}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Ue}; background-clip: padding-box; color: ${Y}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${C}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${ft}; color: ${Rt}; }
.oc-sdk-option-check { color: ${M}; }
.oc-sdk-option[data-destructive="true"] { color: ${ht}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${f(_("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${m}; }
.oc-sdk-popup-empty { color: ${m}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${V}; border-radius: 4px; color: ${M}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${f(M,60,V)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${V}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${H}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${D}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${xo} }
.oc-sdk-check-desc { color: ${m}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${f(M,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${m}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${M}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Rt}; background: ${ft}; border-color: ${V}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${Y}; background: var(--oc-sdk-raised-bg); ${Ot} }
.oc-sdk-tab-count { color: ${m}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${f(M,6)}; color: ${m}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${f("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${C}; }
.oc-sdk-row[aria-selected="true"] { background: ${ft}; color: ${Rt}; }
.oc-sdk-row-lead { font-family: ${bt}; color: ${m}; }
.oc-sdk-row-sub { color: ${m}; }
.oc-sdk-row-meta { color: ${m}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${m}; }

.oc-sdk-empty-body { color: ${m}; }

.oc-sdk-spinner { color: ${m}; }
.oc-sdk-spinner-ring { border-color: ${V}; border-top-color: ${D}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${f("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${m}; }

.oc-sdk-separator { color: ${m}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${f(V,40)}; }

.oc-sdk-progress-label { color: ${m}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${f(M,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${D}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${_("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${_("success-text","inherit")}; }

.oc-sdk-text a { color: ${yt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${f(V,60)}; }
`,O=`
${We}
${Wo}
${Co}`;var He=Tt(),ee=document.querySelector("#root");if(!ee)throw Error("DeskChart: missing root");ee.style.padding="12px";He.onReady((e)=>mt(e,document.documentElement));He.onBlock(({args:e,answered:r})=>{let a=(e.values??"").split(",").map(Number).filter(Number.isFinite),b=Math.max(1,...a);ee.replaceChildren();let S=document.createElement("div");S.textContent=e.title??"",S.style.font="600 13px var(--oc-font, system-ui)";let v=document.createElement("div");v.style.cssText="display:flex;align-items:flex-end;gap:6px;height:96px;margin-top:8px";for(let A of a){let U=document.createElement("div");U.style.cssText=`flex:1;height:${A/b*100}%;background:currentColor;opacity:.6;border-radius:3px 3px 0 0`,U.title=String(A),v.append(U)}let P=document.createElement("button");P.textContent=r??"Explain this",P.disabled=r!==null,P.addEventListener("click",()=>{He.answerBlock("Explain this chart")}),ee.append(S,v,P)});new ResizeObserver(()=>{He.setHeight(Math.ceil(ee.getBoundingClientRect().height))}).observe(ee);})();
