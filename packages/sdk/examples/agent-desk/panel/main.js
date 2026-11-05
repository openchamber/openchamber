(()=>{var S="openchamber.sdk",E=1;var We=`
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
`;function $e(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(u)=>{let d=u.target===e?r:u.target;if(!(d instanceof Element))return;if(!d.hasAttribute("data-oc-scrolling"))d.setAttribute("data-oc-scrolling","");let R=s.get(d);if(R!==void 0)clearTimeout(R);s.set(d,setTimeout(()=>{s.delete(d),d.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var wo=`(${$e.toString()})(document);`;var Ke=128,je=65536;var ye=128;var Re=65536;var $t=/^[a-z][a-z0-9-]{0,39}$/;var Xt=(e)=>Object(e)===e&&!Array.isArray(e),ze=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),qt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Wt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Kt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Xt(s)||!$t.test(s.id)||!qt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!ze(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!ze(s,["kind","id","label","value","options","disabled"]))return!1;if(!Wt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let u=new Set;for(let d of s.options){if(!Xt(d)||!ze(d,["value","label"])||!Wt(d.value)||!qt(d.label)||u.has(d.value))return!1;u.add(d.value)}if(!u.has(s.value))return!1}return!0};var jt=["{id}","{segment}","{segments+}"];var Sr=new Set(jt);var zt=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var gr=new Set(zt);var he=20000000,be=256;var Je=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Jt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var Qt=/^[A-Za-z0-9_-]{1,80}$/;var Yt=["left","right","top","bottom"];var Zt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let u=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let d of u)if(!Zt(d,r+1,s))return!1;return!0},Qe=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Qe);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Qe)}return String(e)===e||Number.isFinite(e)},Ye=(e)=>{try{if(String(e.id)!==e.id||!Qt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Yt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Zt(e.data)||!Qe(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var to=["file","directory","other","missing"],et=(e)=>Boolean(e&&"sessionId"in e),tt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var oo=/^[0-9a-f]{7,64}$/i,ot=(e)=>oo.test(e),ve=500,xe=32000,ro=16000,so=128,no=200,io=2000,ao=16000,lo=80,uo=200,co=16000;var po=2000;var rt=20000,Oe=1024,Ae=2000000;var Ce=64000,ke=8000,st=4000;var nt=960000;var So=999,Eo=1e4,ue=500,go=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],_o=["stopped","starting","ready","failed"],Lo=new Set(go),To=(e)=>Lo.has(e),mo=(e)=>e&&To(e)?e:"HOST_REJECTED",J=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(J);if(Object(e)===e)return Object.values(e).every(J);return!1},fo=(e)=>J(e)&&JSON.stringify(e).length<=co,eo=(e)=>e?.trim().slice(0,uo)??"",Q=(e)=>{let r=e.id.trim().slice(0,so),s=e.title.trim().slice(0,no),u=e.url.trim().slice(0,io),d=e.text?.trim().slice(0,ao),R=e.author?.trim().slice(0,lo),_=e.kind==="pull"?"pull":"issue",g={providerId:e.providerId.trim(),id:r,title:s||r,url:u,kind:_};if(d)g.text=d;if(R)g.author=R;if(_==="pull"){let N=eo(e.branches?.head),F=eo(e.branches?.base);if(N&&F)g.branches={head:N,base:F}}if(fo(e.data))g.data=e.data;return g},it=(e)=>{let r=Q(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},at=(e)=>{let r={text:e.text.trim().slice(0,ro)};if(e.send)r.send=!0;return r},lt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(So,Math.max(0,Math.round(e)))},ut=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Eo,Math.max(0,Math.ceil(e)))};var Y=(e)=>e.length>0&&e.length<=Oe&&!e.includes("\x00")&&!e.includes("\\");var Ie=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>po)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Do=new Set(_o),ct=(e)=>Boolean(e&&"status"in e&&Do.has(String(e.status))&&!("body"in e)),Pe=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),pt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),dt=(e)=>Boolean(e&&"written"in e&&e.written===!0),St=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Ho=new Set(to),Et=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Ho.has(String(e.kind))&&Number.isFinite(e.size)),gt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Bo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Fo=(e)=>Object(e)===e?e:null,Ze=(e)=>String(e)===e&&e.length>0,Vo=(e)=>{if(!Ze(e.id))return null;if(e.ok===!0){let r={channel:S,v:E,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ze(e.error))return{channel:S,v:E,type:"result",id:e.id,ok:!1,error:e.error,code:mo(Ze(e.code)?e.code:void 0)};return null},_t=(e)=>{let r=Fo(e);if(!r||r.channel!==S||r.v!==E)return null;if(r.type==="result")return Vo(r);if(!Bo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var yo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Xo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class l extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Ro=()=>Promise.reject(new l("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ge=()=>Promise.reject(new l("BAD_PATH",`File path must be 1 to ${Oe} characters without NUL or backslash.`)),Me=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new l("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},p=(e)=>(e.value+=1,`oc-${e.value}`),Tt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new l("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),u=e.requestTimeoutMs??rt,d=new Set,R=new Set,_=new Set,g=new Set,N=new Set,F=new Set,oe=new Set,pe=new Set,de=new Set,Se=new Set,Ee=new Set,W=new Set,Be=[],re=null,se=null,ge=new Set,_e=new Set,ne=null,ie=null,Fe=!1,K=new Map,j=new Map,z=new Map,L=!1,c={value:0},a=null,D=null,ae=!1,le=!1,Pt=null,Gt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},G=(t)=>{r.parent.postMessage(t,"*")},Mt=()=>{if(L||r.parent===r||W.size===0||a?.features?.lateGenerateResults!==!0)return;G({channel:S,v:E,type:"generate-late-listen"})},y=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Ut=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=_t(t.data);if(!o)return;if(o.type==="workspace"){let i=j.get(o.payload.subscriptionId);if(i)y([i],o.payload.snapshot);return}if(o.type==="shells"){let i=z.get(o.payload.subscriptionId);if(i)y([i],o.payload.snapshot);return}if(o.type==="ready"){if(a=o.payload,D=Gt(o.payload.session),y(d,o.payload),y(R,o.payload.directory),y(_,o.payload.session),D)y(g,D);if(y(N,o.payload.connection),y(F,o.payload.settings),y(oe,o.payload.item),o.payload.block)y(pe,o.payload.block);Mt();return}if(o.type==="service-event"){y(de,o.payload);return}if(o.type==="generate-late"){if(W.size===0)Be.push(o.payload);else y(W,o.payload);return}if(o.type==="directory"){if(a)a={...a,directory:o.payload.directory};y(R,o.payload.directory);return}if(o.type==="session"){if(a)a={...a,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=Gt(o.payload.session);y(_,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,y(g,o.payload);return}if(o.type==="connection"){if(a)a={...a,connection:o.payload.connection};y(N,o.payload.connection);return}if(o.type==="settings"){if(a)a={...a,settings:o.payload.settings};y(F,o.payload.settings);return}if(o.type==="item"){if(a)a={...a,item:o.payload.item};y(oe,o.payload.item);return}if(o.type==="status-control-event"){y(Se,o.payload);return}if(o.type==="popover-closed"){y(Ee,o.payload);return}if(o.type==="action"){let i=(T)=>{if(!L)G({channel:S,v:E,type:"action-result",id:o.id,payload:T})},m=se;if(!m){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>m(o.payload)).then(()=>i({ok:!0}),(T)=>{let O=(T instanceof Error?T.message:String(T)).trim();i({ok:!1,error:(O||"Action failed.").slice(0,ue)})});return}if(o.type==="file-open"){let i=o.payload;if(ie&&Jt(ie,i))return;ie=i,y(ge,o.payload);return}if(o.type==="file-saved"){y(_e,o.payload.version);return}if(o.type==="file-snapshot"){let i=(O)=>{if(!L)G({channel:S,v:E,type:"file-snapshot-result",id:o.id,payload:O})},m=(O)=>i({error:(O.trim()||"Could not read the edited file.").slice(0,ue)}),T=ne;if(!T){m("This extension does not edit files.");return}Promise.resolve().then(()=>T(o.payload.purpose)).then((O)=>{if(Je(O)>he){m(`The file is over ${he} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>be){m(`The snapshot version is over ${be} characters.`);return}i({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>m(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let i=(T)=>{G({channel:S,v:E,type:"resolve-result",id:o.id,payload:T})},m=re;if(!m){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>m(o.payload)).then((T)=>i({item:T?Q(T):null}),(T)=>{let O=(T instanceof Error?T.message:String(T)).trim();i({error:(O||"Command failed.").slice(0,ue)})});return}let n=K.get(o.id);if(!n)return;if(clearTimeout(n.timer),K.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new l(o.code,o.error))};r.addEventListener("message",Ut),G({channel:S,v:E,type:"hello"});let I=(t,o=u)=>{if(L||r.parent===r)return Promise.reject(new l("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let m=setTimeout(()=>{K.delete(t.id),i(new l("HOST_TIMEOUT","Host did not answer in time."))},o);K.set(t.id,{resolve:n,reject:i,timer:m}),G(t)})},v=(t)=>I(t).then(()=>{return}),x={channel:S,v:E},Ve=(t)=>{if(!L&&r.parent!==r)G(t)},wt=()=>Ve({...x,type:"file-save"}),Nt=(t)=>{if(!yo(t)||!Xo(t))return;t.preventDefault(),wt()},Lt=(t)=>{if(!yo(t)||t.key!=="Escape"||a?.surface!=="popover"||!a.popover)return;t.preventDefault(),Ft(a.popover.id,"escape").catch(()=>{return})},Te=()=>{let t=a?.surface==="popover"?a.popover:void 0;if(!t)return;let o=ae||le;if(Pt===o)return;Pt=o,Vt(t.id,o).catch(()=>{return})},me=()=>{if(a?.surface!=="popover"||ae)return;ae=!0,Te()},Dt=(t)=>{if(a?.surface!=="popover"||t.relatedTarget!==null||!ae)return;ae=!1,Te()},Ht=()=>{if(a?.surface!=="popover"||le)return;le=!0,Te()},Bt=()=>{if(a?.surface!=="popover"||!le)return;le=!1,Te()},U=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new l("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Xe=async(t)=>{if(t.kind!=="projects")U(t.projectId);let o=await I({...x,type:"workspace-read",id:p(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new l("HOST_REJECTED","Host did not return workspace data.");return o},qe=async(t,o)=>{if(t.kind!=="projects")U(t.projectId);let n=p(c);j.set(n,o);try{await v({...x,type:"workspace-subscribe",id:p(c),payload:{subscriptionId:n,query:t}})}catch(i){if(j.delete(n),!L)G({...x,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:n}});throw i}return()=>{if(!j.delete(n)||L)return;G({...x,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:n}})}},Uo=async(t,o)=>{if(t.kind==="session")U(t.sessionId);if(t.kind==="project")U(t.projectId);let n=p(c);z.set(n,o);try{await v({...x,type:"shells-subscribe",id:p(c),payload:{subscriptionId:n,scope:t}})}catch(i){if(z.delete(n),!L)G({...x,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:n}});throw i}return()=>{if(!z.delete(n)||L)return;G({...x,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:n}})}},fe=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ke))throw new l("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!J(t.value))throw new l("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>je)throw new l("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&a?.features?.deviceStorage!==!0)throw new l("UNSUPPORTED","This host does not support device storage.");let o=await I({...x,type:"storage",id:p(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new l("HOST_REJECTED","Host did not return storage data.");return o},Ft=(t,o)=>a?.features?.popovers!==!0&&!(a?.surface==="popover"&&a.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):v({...x,type:"popover-close",id:p(c),payload:o?{id:t,reason:o}:{id:t}}),Vt=(t,o)=>a?.features?.popovers!==!0&&!(a?.surface==="popover"&&a.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):v({...x,type:"popover-anchor",id:p(c),payload:{id:t,active:o}});return r.addEventListener("keydown",Lt,!0),r.addEventListener("pointerover",me),r.addEventListener("pointermove",me),r.addEventListener("pointerout",Dt),r.addEventListener("focus",Ht),r.addEventListener("blur",Bt),{onAction:(t)=>(se=t,()=>{if(se===t)se=null}),listProjects:async()=>{let t=await Xe({kind:"projects"});if(t.kind!=="projects")throw new l("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Xe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new l("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Xe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new l("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>qe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>qe({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>qe({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Uo(t,o),readShellOutput:async(t,o)=>{U(t,ye);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new l("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>Re))throw new l("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${Re}.`);let T=await I({...x,type:"shell-output",id:p(c),payload:{shellId:t,cursor:n,tailBytes:i}});if(!T||typeof T.output!=="string"||!Number.isFinite(T.cursor))throw new l("HOST_REJECTED","Host did not return shell output.");return T},stopShell:async(t)=>{if(U(t,ye),(await I({...x,type:"shell-stop",id:p(c),payload:{shellId:t}}))?.stopped!==!0)throw new l("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{U(t),await v({...x,type:"open-session",id:p(c),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Me(o),i={op:"get",key:t};if(n)i.scope=n;let m=await fe(i);return m.op==="get"&&m.found?m.value:void 0},set:async(t,o,n)=>{let i=Me(n),m={op:"set",key:t,value:o};if(i)m.scope=i;await fe(m)},delete:async(t,o)=>{let n=Me(o),i={op:"delete",key:t};if(n)i.scope=n;await fe(i)},keys:async(t)=>{let o=Me(t),n={op:"keys"};if(o)n.scope=o;let i=await fe(n);if(i.op!=="keys")throw new l("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(d.add(t),a)t(a);return()=>{d.delete(t)}},onDirectory:(t)=>{if(R.add(t),a)t(a.directory);return()=>{R.delete(t)}},onSession:(t)=>{if(_.add(t),a)t(a.session);return()=>{_.delete(t)}},onSessionLifecycle:(t)=>{if(g.add(t),D)t(D);return()=>{g.delete(t)}},onConnection:(t)=>{if(N.add(t),a)t(a.connection);return()=>{N.delete(t)}},onSettings:(t)=>{if(F.add(t),a)t(a.settings);return()=>{F.delete(t)}},onItem:(t)=>{if(oe.add(t),a)t(a.item);return()=>{oe.delete(t)}},onBlock:(t)=>{if(pe.add(t),a?.block)t(a.block);return()=>{pe.delete(t)}},onServiceEvent:(t)=>(de.add(t),()=>{de.delete(t)}),onStatusControl:(t)=>(Se.add(t),()=>{Se.delete(t)}),onPopoverClosed:(t)=>(Ee.add(t),()=>{Ee.delete(t)}),setStatusControls:(t)=>{if(a?.features?.statusControls!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support status controls."));if(!Kt(t))return Promise.reject(new l("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return v({...x,type:"status-controls",id:p(c),payload:{controls:t}})},openPopover:(t)=>{if(a?.features?.popovers!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support popovers."));if(!Ye(t))return Promise.reject(new l("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return v({...x,type:"popover-open",id:p(c),payload:t})},closePopover:Ft,setPopoverAnchorActive:Vt,onResolve:(t)=>(re=t,()=>{if(re===t)re=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>ve)return Promise.reject(new l("HOST_REJECTED",`Toast message must contain 1 to ${ve} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>xe))return Promise.reject(new l("HOST_REJECTED",`Toast copy text must contain 1 to ${xe} characters.`));return v({channel:S,v:E,type:"toast",id:p(c),payload:{...t,message:o}})},openUrl:(t)=>v({channel:S,v:E,type:"open-url",id:p(c),payload:{url:t}}),openCommit:(t)=>ot(t)?v({channel:S,v:E,type:"open-commit",id:p(c),payload:{sha:t}}):Promise.reject(new l("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>v({channel:S,v:E,type:"open-surface",id:p(c),payload:{surfaceId:t}}),writeClipboard:(t)=>v({channel:S,v:E,type:"clipboard-write",id:p(c),payload:{text:t}}),compose:(t)=>v({channel:S,v:E,type:"compose",id:p(c),payload:t}),attach:(t)=>v({channel:S,v:E,type:"attach",id:p(c),payload:Q(t)}),startSession:async(t)=>{if(t.projectId!==void 0)U(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")U(o.directory);else{if(o.name!==void 0)U(o.name,200);if(o.baseBranch!==void 0)U(o.baseBranch,200)}let n=await I({channel:S,v:E,type:"start-session",id:p(c),payload:it(t)},e.requestTimeoutMs??180000);if(!et(n))throw new l("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>I({channel:S,v:E,type:"prompt",id:p(c),payload:at(t)}).then((o)=>{if(!tt(o))throw new l("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>v({channel:S,v:E,type:"session-link",id:p(c),payload:Q(t)}),close:()=>v({channel:S,v:E,type:"close",id:p(c)}),oauthStart:()=>v({channel:S,v:E,type:"oauth-start",id:p(c)}),oauthDisconnect:()=>v({channel:S,v:E,type:"oauth-disconnect",id:p(c)}),request:(t)=>(Ie(t.path)?I({channel:S,v:E,type:"request",id:p(c),payload:t}):Ro()).then((o)=>{if(!Pe(o))throw new l("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ie(t.path)?I({channel:S,v:E,type:"service-request",id:p(c),payload:t}):Ro()).then((o)=>{if(!Pe(o))throw new l("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>I({channel:S,v:E,type:"service-status",id:p(c)}).then((t)=>{if(!ct(t))throw new l("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Y(t)?I({channel:S,v:E,type:"file-read",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!pt(o))throw new l("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Y(t))return Ge();if(o.length>Ae)return Promise.reject(new l("FILE_TOO_LARGE",`Content is over ${Ae} characters.`));return I({channel:S,v:E,type:"file-write",id:p(c),payload:{path:t,content:o}}).then((n)=>{if(!dt(n))throw new l("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(Y(t)?I({channel:S,v:E,type:"file-list",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!St(o))throw new l("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Y(t)?I({channel:S,v:E,type:"file-stat",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!Et(o))throw new l("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>Ce)return Promise.reject(new l("HOST_REJECTED",`Prompt must be 1 to ${Ce} characters.`));if(n!==void 0&&(n.length===0||n.length>ke))return Promise.reject(new l("HOST_REJECTED",`System prompt must be 1 to ${ke} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(st,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new l("HOST_REJECTED","maxOutputTokens must be a number."));let m={prompt:o};if(n!==void 0)m.system=n;if(i!==void 0)m.maxOutputTokens=i;return I({channel:S,v:E,type:"generate",id:p(c),payload:m},e.requestTimeoutMs??nt).then((T)=>{if(!gt(T))throw new l("HOST_REJECTED","Host did not return generated text.");return T})},onLateGenerateResult:(t)=>{W.add(t);for(let o of Be.splice(0))y([t],o);return Mt(),()=>{W.delete(t)}},setBadge:(t)=>v({channel:S,v:E,type:"badge",id:p(c),payload:{count:lt(t)}}),setHeight:(t)=>v({channel:S,v:E,type:"resize",id:p(c),payload:{height:ut(t)}}),onFileOpen:(t)=>{if(ge.add(t),!Fe)Fe=!0,r.addEventListener("keydown",Nt,!0);if(ie)t(ie);return()=>{ge.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(_e.add(t),()=>{_e.delete(t)}),reportFileChange:(t)=>Ve({...x,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:wt,reportFileUnsupported:()=>Ve({...x,type:"file-unsupported"}),dispose:()=>{for(let t of j.keys())G({...x,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:t}});j.clear();for(let t of z.keys())G({...x,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:t}});if(z.clear(),L=!0,re=null,se=null,ne=null,ge.clear(),_e.clear(),Fe)r.removeEventListener("keydown",Nt,!0);r.removeEventListener("message",Ut),r.removeEventListener("keydown",Lt,!0),r.removeEventListener("pointerover",me),r.removeEventListener("pointermove",me),r.removeEventListener("pointerout",Dt),r.removeEventListener("focus",Ht),r.removeEventListener("blur",Bt);for(let t of K.values())clearTimeout(t.timer),t.reject(new l("HOST_UNAVAILABLE","Host client was disposed."));K.clear(),d.clear(),R.clear(),_.clear(),g.clear(),N.clear(),F.clear(),oe.clear(),pe.clear(),de.clear(),Se.clear(),Ee.clear(),W.clear(),Be.length=0}}};var ho=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Ir=new Set(ho);var bo=["none","agent","user"];var Gr=new Set(bo);var qo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Wo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],vo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,u]of qo)r.style.setProperty(s,e.tokens[u]);for(let[s,u,d]of Wo){let R=e.tokens[d]??"";r.style.setProperty(s,R),r.style.setProperty(u,R)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},mt=(e,r)=>{if(vo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var $o={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},f=(e,r)=>`var(--${e}, var(--oc-${$o[e]}, ${r}))`,B=f("surface-background","transparent"),we=f("surface-elevated","transparent"),Z=f("surface-elevated-foreground","inherit"),M=f("surface-foreground","inherit"),h=f("surface-muted-foreground","gray"),Ko=f("surface-muted","transparent"),X=f("interactive-border","currentColor"),P=f("interactive-hover","transparent"),q=f("interactive-active","transparent"),ft=f("interactive-selection","transparent"),yt=f("interactive-selection-foreground","inherit"),H=f("primary","currentColor"),Rt=f("primary-text","inherit"),ht=f("error-text","inherit"),jo=f("font-sans","inherit"),bt=f("font-mono","monospace"),Co=f("radius","9px"),vt=`calc(${Co} - 2px)`,xo=`calc(${Co} - 4px)`,b=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,Oo=`background-image: linear-gradient(${P}, ${P});`,xt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Ot="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Ao="box-shadow: var(--oc-sdk-lit);",At=`inset 0 0.5px 0 0 ${b(M,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,zo=`
:root {
  --oc-sdk-edge: ${b(M,16)};
  --oc-sdk-field-bg: ${we};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${b(M,14)};
  --oc-sdk-field-bg: ${b(B,50,we)};
  --oc-sdk-raised-bg: ${we};
  --oc-sdk-field-lift: ${At};
  --oc-sdk-raised-lift: ${At};
  --oc-sdk-lit: ${At};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ue=(e)=>{let r=f(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${f(`${e}-text`,"inherit")}; }`},Jo=`
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
`,ko=`${zo}
.oc-sdk { color: ${M}; font-family: ${jo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Oo} }
.oc-sdk-mono { font-family: ${bt}; }
.oc-sdk-muted { color: ${h}; }
${Ue("success")}${Ue("warning")}${Ue("error")}${Ue("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${H}; --oc-sdk-tone-text: ${Rt}; }

.oc-sdk-btn { border-radius: ${vt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${xo}; }
.oc-sdk-btn[data-variant="default"] { color: ${Rt}; background: ${b(H,10,B)}; border-color: ${b(H,12)}; ${Ao} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${b(H,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${b(H,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Ko}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${q}, ${q}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${Z}; ${Ot} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${q}, ${q}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${P}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${q}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${f("status-error","red")}; color: ${ht}; background: ${b("var(--oc-sdk-tone)",7,B)}; border-color: ${b("var(--oc-sdk-tone)",12)}; ${Ao} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${b("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${b("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${h}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${ht}; }
.oc-sdk-input { border-radius: ${vt}; background: var(--oc-sdk-field-bg); color: ${Z}; ${xt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${h}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${xt(b(M,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${xt(f("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${bt}; }

.oc-sdk-search-icon { color: ${h}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${H}; }
.oc-sdk-search-clear { border-radius: ${xo}; color: ${h}; }
.oc-sdk-search-clear:hover { background: ${P}; color: ${M}; }

.oc-sdk-trigger { border-radius: ${vt}; background: var(--oc-sdk-raised-bg); color: ${Z}; ${Ot} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${P}, ${P}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${q}, ${q}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${h}; }
.oc-sdk-trigger-chevron { color: ${h}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${Z}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${we}; background-clip: padding-box; color: ${Z}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${P}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${ft}; color: ${yt}; }
.oc-sdk-option-check { color: ${M}; }
.oc-sdk-option[data-destructive="true"] { color: ${ht}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${b(f("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${h}; }
.oc-sdk-popup-empty { color: ${h}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${X}; border-radius: 4px; color: ${M}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${b(M,60,X)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${X}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${H}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Oo} }
.oc-sdk-check-desc { color: ${h}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${b(M,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${h}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${M}; }
.oc-sdk-tab[aria-selected="true"] { color: ${yt}; background: ${ft}; border-color: ${X}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${Z}; background: var(--oc-sdk-raised-bg); ${Ot} }
.oc-sdk-tab-count { color: ${h}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${b(M,6)}; color: ${h}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${b("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${P}; }
.oc-sdk-row[aria-selected="true"] { background: ${ft}; color: ${yt}; }
.oc-sdk-row-lead { font-family: ${bt}; color: ${h}; }
.oc-sdk-row-sub { color: ${h}; }
.oc-sdk-row-meta { color: ${h}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${h}; }

.oc-sdk-empty-body { color: ${h}; }

.oc-sdk-spinner { color: ${h}; }
.oc-sdk-spinner-ring { border-color: ${X}; border-top-color: ${H}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${b("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${h}; }

.oc-sdk-separator { color: ${h}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${b(X,40)}; }

.oc-sdk-progress-label { color: ${h}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${b(M,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${H}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${f("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${f("success-text","inherit")}; }

.oc-sdk-text a { color: ${Rt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${b(X,60)}; }
`,C=`
${We}
${Jo}
${ko}`;var Io="oc-sdk-ui-style",ee=(e)=>{while(e.firstChild)e.removeChild(e.firstChild)},k=(e)=>{let r=document.getElementById(Io);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}$e(document);let s=document.createElement("style");s.id=Io,s.textContent=e,document.head.appendChild(s)},A=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},V=(e)=>{let r=A("button",e);return r.type="button",r},w=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var Qo=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},te=(e,r)=>{k(C);let s=r,u=V("oc-sdk oc-sdk-btn"),d=Qo(),R=document.createElement("span");u.append(R),e.append(u);let _=()=>{if(u.dataset.variant=s.variant??"default",u.dataset.size=s.size??"default",u.disabled=Boolean(s.disabled)||Boolean(s.loading),u.dataset.loading=s.loading?"true":"false",u.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&d.parentNode!==u)u.prepend(d);else if(!s.loading&&d.parentNode===u)d.remove();w(R,s.label)},g=()=>{if(s.disabled||s.loading)return;s.onClick()};return u.addEventListener("click",g),_(),{update:(N)=>{s={...s,...N},_()},dispose:()=>{u.removeEventListener("click",g),u.remove()}}};var or=/(!?)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,rr=(e)=>{try{let r=new URL(e);return r.protocol==="http:"||r.protocol==="https:"}catch{return!1}},Po=(e)=>{let r=[],s=0;for(let u of e.matchAll(or)){let d=u.index??0;if(d>s)r.push({kind:"text",text:e.slice(s,d)});let R=u[1]??"",_=(u[2]??"").trim(),g=u[3]??"";if(!rr(g))r.push({kind:"text",text:u[0]});else if(R==="!")r.push({kind:"image",src:g,alt:_});else r.push({kind:"link",href:g,label:_||g});s=d+u[0].length}if(s<e.length)r.push({kind:"text",text:e.slice(s)});return r},Ct=(e,r)=>{k(C);let s=r,u=A("div","oc-sdk oc-sdk-text");e.append(u);let d=(_)=>{if(!(_.target instanceof HTMLAnchorElement)||!s.onOpenUrl)return;_.preventDefault(),s.onOpenUrl(_.target.href)},R=()=>{ee(u);for(let _ of Po(s.text))if(_.kind==="text")u.append(document.createTextNode(_.text));else if(_.kind==="link"){let g=A("a");g.href=_.href,g.rel="noopener noreferrer",g.target="_blank",g.textContent=_.label,u.append(g)}else{let g=A("img");g.src=_.src,g.alt=_.alt,g.loading="lazy",g.referrerPolicy="no-referrer",u.append(g)}};return u.addEventListener("click",d),R(),{update:(_)=>{s={...s,..._},R()},dispose:()=>{u.removeEventListener("click",d),u.remove()}}};var kt=Tt(),He=document.querySelector("#root");if(!He)throw Error("Agent Desk: missing root");var Mo=document.createElement("div"),It=(e)=>{let r=document.createElement("div");r.textContent=e,Mo.prepend(r)},Go=!1;kt.onReady((e)=>{if(mt(e,document.documentElement),Go)return;Go=!0,Ct(He,{text:"Agent Desk"}),te(He,{label:"Start a session",onClick:()=>{kt.serviceRequest({method:"POST",path:"/start",body:JSON.stringify({directory:e.directory})}).then((r)=>It(r.body)).catch(()=>It("The service did not answer."))}}),He.append(Mo)});kt.onServiceEvent(({topic:e,data:r})=>It(`${e}: ${JSON.stringify(r)}`));})();
