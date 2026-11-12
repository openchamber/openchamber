(()=>{var E="openchamber.sdk",g=1;var qe=`
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
`;function Ke(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let n=new WeakMap;e.addEventListener("scroll",(c)=>{let S=c.target===e?r:c.target;if(!(S instanceof Element))return;if(!S.hasAttribute("data-oc-scrolling"))S.setAttribute("data-oc-scrolling","");let h=n.get(S);if(h!==void 0)clearTimeout(h);n.set(S,setTimeout(()=>{n.delete(S),S.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Lo=`(${Ke.toString()})(document);`;var je=128,ze=65536;var ye=128;var he=65536;var jt=/^[a-z][a-z0-9-]{0,39}$/;var $t=(e)=>Object(e)===e&&!Array.isArray(e),Je=(e,r)=>Object.keys(e).every((n)=>r.includes(n)),qt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Kt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,zt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let n of e){if(!$t(n)||!jt.test(n.id)||!qt(n.label))return!1;if(n.disabled!==void 0&&n.disabled!==!0&&n.disabled!==!1)return!1;if(r.has(n.id))return!1;if(r.add(n.id),n.kind==="button"){if(!Je(n,["kind","id","label","disabled"]))return!1;continue}if(n.kind!=="select"||!Je(n,["kind","id","label","value","options","disabled"]))return!1;if(!Kt(n.value)||!Array.isArray(n.options)||n.options.length<1||n.options.length>16)return!1;let c=new Set;for(let S of n.options){if(!$t(S)||!Je(S,["value","label"])||!Kt(S.value)||!qt(S.label)||c.has(S.value))return!1;c.add(S.value)}if(!c.has(n.value))return!1}return!0};var Jt=["{id}","{segment}","{segments+}"];var gr=new Set(Jt);var Qt=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var Tr=new Set(Qt);var be=20000000,ve=256;var Qe=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Yt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let n=0;n<e.bytes.byteLength;n+=1)if(e.bytes[n]!==r.bytes[n])return!1;return!0};var Zt=/^[A-Za-z0-9_-]{1,80}$/;var eo=["left","right","top","bottom"];var to=(e,r=0,n={remaining:16000})=>{if(--n.remaining<0||r>=32)return!1;if(e===null)return!0;let c=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let S of c)if(!to(S,r+1,n))return!1;return!0},Ye=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Ye);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Ye)}return String(e)===e||Number.isFinite(e)},Ze=(e)=>{try{if(String(e.id)!==e.id||!Zt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!eo.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!to(e.data)||!Ye(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var tt=2000;var ro=["file","directory","other","missing"],ot=(e)=>Boolean(e&&"sessionId"in e),rt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var so=/^[0-9a-f]{7,64}$/i,st=(e)=>so.test(e),Ae=500,Oe=32000,no=16000,io=128,ao=200,lo=2000,uo=16000,co=80,po=200,So=16000;var Eo=2000;var nt=20000,xe=1024,Ce=2000000;var ke=64000,Ie=8000,it=4000;var at=960000;var go=999,_o=1e4,ce=500,To=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],mo=["stopped","starting","ready","failed"],Ho=new Set(To),Ro=(e)=>Ho.has(e),fo=(e)=>e&&Ro(e)?e:"HOST_REJECTED",Q=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(Q);if(Object(e)===e)return Object.values(e).every(Q);return!1},yo=(e)=>Q(e)&&JSON.stringify(e).length<=So,oo=(e)=>e?.trim().slice(0,po)??"",Y=(e)=>{let r=e.id.trim().slice(0,io),n=e.title.trim().slice(0,ao),c=e.url.trim().slice(0,lo),S=e.text?.trim().slice(0,uo),h=e.author?.trim().slice(0,co),T=e.kind==="pull"?"pull":"issue",_={providerId:e.providerId.trim(),id:r,title:n||r,url:c,kind:T};if(S)_.text=S;if(h)_.author=h;if(T==="pull"){let L=oo(e.branches?.head),V=oo(e.branches?.base);if(L&&V)_.branches={head:L,base:V}}if(yo(e.data))_.data=e.data;return _},lt=(e)=>{let r=Y(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},ut=(e)=>{let r={text:e.text.trim().slice(0,no)};if(e.send)r.send=!0;return r},ct=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(go,Math.max(0,Math.round(e)))},pt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(_o,Math.max(0,Math.ceil(e)))};var Z=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var Pe=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>Eo)return!1;return!e.split("/").some((n)=>n==="."||n==="..")},Bo=new Set(mo),dt=(e)=>Boolean(e&&"status"in e&&Bo.has(String(e.status))&&!("body"in e)),Ge=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),St=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),Et=(e)=>Boolean(e&&"written"in e&&e.written===!0),gt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Fo=new Set(ro),_t=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Fo.has(String(e.kind))&&Number.isFinite(e.size)),Tt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Vo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Wo=(e)=>Object(e)===e?e:null,et=(e)=>String(e)===e&&e.length>0,Xo=(e)=>{if(!et(e.id))return null;if(e.ok===!0){let r={channel:E,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&et(e.error))return{channel:E,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:fo(et(e.code)?e.code:void 0)};return null},mt=(e)=>{let r=Wo(e);if(!r||r.channel!==E||r.v!==g)return null;if(r.type==="result")return Xo(r);if(!Vo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var ho=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),$o=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class u extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var bo=()=>Promise.reject(new u("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Me=()=>Promise.reject(new u("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Ue=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new u("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},d=(e)=>(e.value+=1,`oc-${e.value}`),Rt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new u("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let n=e.acceptSource??((t)=>t===r.parent),c=e.requestTimeoutMs??nt,S=new Set,h=new Set,T=new Set,_=new Set,L=new Set,V=new Set,re=new Set,de=new Set,Se=new Set,Ee=new Set,ge=new Set,K=new Set,Fe=[],se=null,ne=null,_e=new Set,Te=new Set,ie=null,ae=null,Ve=!1,j=new Map,z=new Map,J=new Map,D=!1,p={value:0},l=null,H=null,le=!1,ue=!1,Mt=null,Ut=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},M=(t)=>{r.parent.postMessage(t,"*")},wt=()=>{if(D||r.parent===r||K.size===0||l?.features?.lateGenerateResults!==!0)return;M({channel:E,v:g,type:"generate-late-listen"})},y=(t,o)=>{for(let i of t)try{i(o)}catch(a){console.error(a)}},Nt=(t)=>{if(!(t instanceof MessageEvent))return;if(!n(t.source))return;let o=mt(t.data);if(!o)return;if(o.type==="workspace"){let a=z.get(o.payload.subscriptionId);if(a)y([a],o.payload.snapshot);return}if(o.type==="shells"){let a=J.get(o.payload.subscriptionId);if(a)y([a],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,H=Ut(o.payload.session),y(S,o.payload),y(h,o.payload.directory),y(T,o.payload.session),H)y(_,H);if(y(L,o.payload.connection),y(V,o.payload.settings),y(re,o.payload.item),o.payload.block)y(de,o.payload.block);wt();return}if(o.type==="service-event"){y(Se,o.payload);return}if(o.type==="generate-late"){if(K.size===0)Fe.push(o.payload);else y(K,o.payload);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};y(h,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)H=null;else if(H?.sessionId!==o.payload.session.id)H=Ut(o.payload.session);y(T,o.payload.session);return}if(o.type==="session-lifecycle"){H=o.payload,y(_,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};y(L,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};y(V,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};y(re,o.payload.item);return}if(o.type==="status-control-event"){y(Ee,o.payload);return}if(o.type==="popover-closed"){y(ge,o.payload);return}if(o.type==="action"){let a=(m)=>{if(!D)M({channel:E,v:g,type:"action-result",id:o.id,payload:m})},R=ne;if(!R){a({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>R(o.payload)).then(()=>a({ok:!0}),(m)=>{let x=(m instanceof Error?m.message:String(m)).trim();a({ok:!1,error:(x||"Action failed.").slice(0,ce)})});return}if(o.type==="file-open"){let a=o.payload;if(ae&&Yt(ae,a))return;ae=a,y(_e,o.payload);return}if(o.type==="file-saved"){y(Te,o.payload.version);return}if(o.type==="file-snapshot"){let a=(x)=>{if(!D)M({channel:E,v:g,type:"file-snapshot-result",id:o.id,payload:x})},R=(x)=>a({error:(x.trim()||"Could not read the edited file.").slice(0,ce)}),m=ie;if(!m){R("This extension does not edit files.");return}Promise.resolve().then(()=>m(o.payload.purpose)).then((x)=>{if(Qe(x)>be){R(`The file is over ${be} ${"bytes"in x?"bytes":"characters"}.`);return}if(x.version.length>ve){R(`The snapshot version is over ${ve} characters.`);return}a({snapshot:"bytes"in x?{bytes:x.bytes,version:x.version}:{content:x.content,version:x.version}})},(x)=>R(x instanceof Error?x.message:String(x)));return}if(o.type==="resolve"){let a=(m)=>{M({channel:E,v:g,type:"resolve-result",id:o.id,payload:m})},R=se;if(!R){a({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>R(o.payload)).then((m)=>a({item:m?Y(m):null}),(m)=>{let x=(m instanceof Error?m.message:String(m)).trim();a({error:(x||"Command failed.").slice(0,ce)})});return}let i=j.get(o.id);if(!i)return;if(clearTimeout(i.timer),j.delete(o.id),o.ok){i.resolve(o.payload);return}i.reject(new u(o.code,o.error))};r.addEventListener("message",Nt),M({channel:E,v:g,type:"hello"});let P=(t,o=c)=>{if(D||r.parent===r)return Promise.reject(new u("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((i,a)=>{let R=setTimeout(()=>{j.delete(t.id),a(new u("HOST_TIMEOUT","Host did not answer in time."))},o);j.set(t.id,{resolve:i,reject:a,timer:R}),M(t)})},A=(t)=>P(t).then(()=>{return}),O={channel:E,v:g},We=(t)=>{if(!D&&r.parent!==r)M(t)},Lt=()=>We({...O,type:"file-save"}),Dt=(t)=>{if(!ho(t)||!$o(t))return;t.preventDefault(),Lt()},Ht=(t)=>{if(!ho(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),Wt(l.popover.id,"escape").catch(()=>{return})},me=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=le||ue;if(Mt===o)return;Mt=o,Xt(t.id,o).catch(()=>{return})},Re=()=>{if(l?.surface!=="popover"||le)return;le=!0,me()},Bt=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!le)return;le=!1,me()},Ft=()=>{if(l?.surface!=="popover"||ue)return;ue=!0,me()},Vt=()=>{if(l?.surface!=="popover"||!ue)return;ue=!1,me()},w=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new u("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Xe=async(t)=>{if(t.kind!=="projects")w(t.projectId);let o=await P({...O,type:"workspace-read",id:d(p),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new u("HOST_REJECTED","Host did not return workspace data.");return o},$e=async(t,o)=>{if(t.kind!=="projects")w(t.projectId);let i=d(p);z.set(i,o);try{await A({...O,type:"workspace-subscribe",id:d(p),payload:{subscriptionId:i,query:t}})}catch(a){if(z.delete(i),!D)M({...O,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:i}});throw a}return()=>{if(!z.delete(i)||D)return;M({...O,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:i}})}},No=async(t,o)=>{if(t.kind==="session")w(t.sessionId);if(t.kind==="project")w(t.projectId);let i=d(p);J.set(i,o);try{await A({...O,type:"shells-subscribe",id:d(p),payload:{subscriptionId:i,scope:t}})}catch(a){if(J.delete(i),!D)M({...O,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:i}});throw a}return()=>{if(!J.delete(i)||D)return;M({...O,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:i}})}},fe=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>je))throw new u("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!Q(t.value))throw new u("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>ze)throw new u("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new u("UNSUPPORTED","This host does not support device storage.");let o=await P({...O,type:"storage",id:d(p),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new u("HOST_REJECTED","Host did not return storage data.");return o},Wt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):A({...O,type:"popover-close",id:d(p),payload:o?{id:t,reason:o}:{id:t}}),Xt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):A({...O,type:"popover-anchor",id:d(p),payload:{id:t,active:o}});return r.addEventListener("keydown",Ht,!0),r.addEventListener("pointerover",Re),r.addEventListener("pointermove",Re),r.addEventListener("pointerout",Bt),r.addEventListener("focus",Ft),r.addEventListener("blur",Vt),{onAction:(t)=>(ne=t,()=>{if(ne===t)ne=null}),listProjects:async()=>{let t=await Xe({kind:"projects"});if(t.kind!=="projects")throw new u("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Xe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new u("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Xe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new u("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>$e({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>$e({kind:"worktrees",projectId:t},(i)=>{if(i.kind==="worktrees")o(i)}),onSessions:(t,o)=>$e({kind:"sessions",projectId:t},(i)=>{if(i.kind==="sessions")o(i)}),onRunningShells:(t,o)=>No(t,o),readShellOutput:async(t,o)=>{w(t,ye);let i=o?.cursor;if(i!==void 0&&(!Number.isInteger(i)||i<0))throw new u("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let a=o?.tailBytes;if(a!==void 0&&(!Number.isInteger(a)||a<1||a>he))throw new u("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${he}.`);let m=await P({...O,type:"shell-output",id:d(p),payload:{shellId:t,cursor:i,tailBytes:a}});if(!m||typeof m.output!=="string"||!Number.isFinite(m.cursor))throw new u("HOST_REJECTED","Host did not return shell output.");return m},stopShell:async(t)=>{if(w(t,ye),(await P({...O,type:"shell-stop",id:d(p),payload:{shellId:t}}))?.stopped!==!0)throw new u("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{w(t),await A({...O,type:"open-session",id:d(p),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let i=Ue(o),a={op:"get",key:t};if(i)a.scope=i;let R=await fe(a);return R.op==="get"&&R.found?R.value:void 0},set:async(t,o,i)=>{let a=Ue(i),R={op:"set",key:t,value:o};if(a)R.scope=a;await fe(R)},delete:async(t,o)=>{let i=Ue(o),a={op:"delete",key:t};if(i)a.scope=i;await fe(a)},keys:async(t)=>{let o=Ue(t),i={op:"keys"};if(o)i.scope=o;let a=await fe(i);if(a.op!=="keys")throw new u("HOST_REJECTED","Expected storage keys.");return a.keys}},onReady:(t)=>{if(S.add(t),l)t(l);return()=>{S.delete(t)}},onDirectory:(t)=>{if(h.add(t),l)t(l.directory);return()=>{h.delete(t)}},onSession:(t)=>{if(T.add(t),l)t(l.session);return()=>{T.delete(t)}},onSessionLifecycle:(t)=>{if(_.add(t),H)t(H);return()=>{_.delete(t)}},onConnection:(t)=>{if(L.add(t),l)t(l.connection);return()=>{L.delete(t)}},onSettings:(t)=>{if(V.add(t),l)t(l.settings);return()=>{V.delete(t)}},onItem:(t)=>{if(re.add(t),l)t(l.item);return()=>{re.delete(t)}},onBlock:(t)=>{if(de.add(t),l?.block)t(l.block);return()=>{de.delete(t)}},onServiceEvent:(t)=>(Se.add(t),()=>{Se.delete(t)}),onStatusControl:(t)=>(Ee.add(t),()=>{Ee.delete(t)}),onPopoverClosed:(t)=>(ge.add(t),()=>{ge.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support status controls."));if(!zt(t))return Promise.reject(new u("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return A({...O,type:"status-controls",id:d(p),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support popovers."));if(!Ze(t))return Promise.reject(new u("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return A({...O,type:"popover-open",id:d(p),payload:t})},closePopover:Wt,setPopoverAnchorActive:Xt,onResolve:(t)=>(se=t,()=>{if(se===t)se=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Ae)return Promise.reject(new u("HOST_REJECTED",`Toast message must contain 1 to ${Ae} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Oe))return Promise.reject(new u("HOST_REJECTED",`Toast copy text must contain 1 to ${Oe} characters.`));return A({channel:E,v:g,type:"toast",id:d(p),payload:{...t,message:o}})},openUrl:(t)=>A({channel:E,v:g,type:"open-url",id:d(p),payload:{url:t}}),openCommit:(t)=>st(t)?A({channel:E,v:g,type:"open-commit",id:d(p),payload:{sha:t}}):Promise.reject(new u("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>A({channel:E,v:g,type:"block-answer",id:d(p),payload:{text:t.trim().slice(0,tt)}}),openSurface:(t)=>A({channel:E,v:g,type:"open-surface",id:d(p),payload:{surfaceId:t}}),writeClipboard:(t)=>A({channel:E,v:g,type:"clipboard-write",id:d(p),payload:{text:t}}),compose:(t)=>A({channel:E,v:g,type:"compose",id:d(p),payload:t}),attach:(t)=>A({channel:E,v:g,type:"attach",id:d(p),payload:Y(t)}),startSession:async(t)=>{if(t.projectId!==void 0)w(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")w(o.directory);else{if(o.name!==void 0)w(o.name,200);if(o.baseBranch!==void 0)w(o.baseBranch,200)}let i=await P({channel:E,v:g,type:"start-session",id:d(p),payload:lt(t)},e.requestTimeoutMs??180000);if(!ot(i))throw new u("HOST_REJECTED","Host did not return a session.");return i},prompt:(t)=>P({channel:E,v:g,type:"prompt",id:d(p),payload:ut(t)}).then((o)=>{if(!rt(o))throw new u("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>A({channel:E,v:g,type:"session-link",id:d(p),payload:Y(t)}),close:()=>A({channel:E,v:g,type:"close",id:d(p)}),oauthStart:()=>A({channel:E,v:g,type:"oauth-start",id:d(p)}),oauthDisconnect:()=>A({channel:E,v:g,type:"oauth-disconnect",id:d(p)}),request:(t)=>(Pe(t.path)?P({channel:E,v:g,type:"request",id:d(p),payload:t}):bo()).then((o)=>{if(!Ge(o))throw new u("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Pe(t.path)?P({channel:E,v:g,type:"service-request",id:d(p),payload:t}):bo()).then((o)=>{if(!Ge(o))throw new u("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:E,v:g,type:"service-status",id:d(p)}).then((t)=>{if(!dt(t))throw new u("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Z(t)?P({channel:E,v:g,type:"file-read",id:d(p),payload:{path:t}}):Me()).then((o)=>{if(!St(o))throw new u("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Z(t))return Me();if(o.length>Ce)return Promise.reject(new u("FILE_TOO_LARGE",`Content is over ${Ce} characters.`));return P({channel:E,v:g,type:"file-write",id:d(p),payload:{path:t,content:o}}).then((i)=>{if(!Et(i))throw new u("HOST_REJECTED","Host did not confirm the write.");return i})},listDir:(t)=>(Z(t)?P({channel:E,v:g,type:"file-list",id:d(p),payload:{path:t}}):Me()).then((o)=>{if(!gt(o))throw new u("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Z(t)?P({channel:E,v:g,type:"file-stat",id:d(p),payload:{path:t}}):Me()).then((o)=>{if(!_t(o))throw new u("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),i=t.system?.trim();if(o.length===0||o.length>ke)return Promise.reject(new u("HOST_REJECTED",`Prompt must be 1 to ${ke} characters.`));if(i!==void 0&&(i.length===0||i.length>Ie))return Promise.reject(new u("HOST_REJECTED",`System prompt must be 1 to ${Ie} characters.`));let a=t.maxOutputTokens===void 0?void 0:Math.min(it,Math.max(1,Math.floor(t.maxOutputTokens)));if(a!==void 0&&!Number.isFinite(a))return Promise.reject(new u("HOST_REJECTED","maxOutputTokens must be a number."));let R={prompt:o};if(i!==void 0)R.system=i;if(a!==void 0)R.maxOutputTokens=a;return P({channel:E,v:g,type:"generate",id:d(p),payload:R},e.requestTimeoutMs??at).then((m)=>{if(!Tt(m))throw new u("HOST_REJECTED","Host did not return generated text.");return m})},onLateGenerateResult:(t)=>{K.add(t);for(let o of Fe.splice(0))y([t],o);return wt(),()=>{K.delete(t)}},setBadge:(t)=>A({channel:E,v:g,type:"badge",id:d(p),payload:{count:ct(t)}}),setHeight:(t)=>A({channel:E,v:g,type:"resize",id:d(p),payload:{height:pt(t)}}),onFileOpen:(t)=>{if(_e.add(t),!Ve)Ve=!0,r.addEventListener("keydown",Dt,!0);if(ae)t(ae);return()=>{_e.delete(t)}},onFileSnapshot:(t)=>(ie=t,()=>{if(ie===t)ie=null}),onFileSaved:(t)=>(Te.add(t),()=>{Te.delete(t)}),reportFileChange:(t)=>We({...O,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Lt,reportFileUnsupported:()=>We({...O,type:"file-unsupported"}),dispose:()=>{for(let t of z.keys())M({...O,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:t}});z.clear();for(let t of J.keys())M({...O,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:t}});if(J.clear(),D=!0,se=null,ne=null,ie=null,_e.clear(),Te.clear(),Ve)r.removeEventListener("keydown",Dt,!0);r.removeEventListener("message",Nt),r.removeEventListener("keydown",Ht,!0),r.removeEventListener("pointerover",Re),r.removeEventListener("pointermove",Re),r.removeEventListener("pointerout",Bt),r.removeEventListener("focus",Ft),r.removeEventListener("blur",Vt);for(let t of j.values())clearTimeout(t.timer),t.reject(new u("HOST_UNAVAILABLE","Host client was disposed."));j.clear(),S.clear(),h.clear(),T.clear(),_.clear(),L.clear(),V.clear(),re.clear(),de.clear(),Se.clear(),Ee.clear(),ge.clear(),K.clear(),Fe.length=0}}};var vo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Mr=new Set(vo);var Ao=["none","agent","user"];var wr=new Set(Ao);var qo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Ko=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Oo=(e,r)=>{r.style.colorScheme=e.mode;for(let[n,c]of qo)r.style.setProperty(n,e.tokens[c]);for(let[n,c,S]of Ko){let h=e.tokens[S]??"";r.style.setProperty(n,h),r.style.setProperty(c,h)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},ft=(e,r)=>{if(Oo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var jo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},f=(e,r)=>`var(--${e}, var(--oc-${jo[e]}, ${r}))`,F=f("surface-background","transparent"),Ne=f("surface-elevated","transparent"),ee=f("surface-elevated-foreground","inherit"),U=f("surface-foreground","inherit"),b=f("surface-muted-foreground","gray"),zo=f("surface-muted","transparent"),X=f("interactive-border","currentColor"),G=f("interactive-hover","transparent"),q=f("interactive-active","transparent"),yt=f("interactive-selection","transparent"),ht=f("interactive-selection-foreground","inherit"),B=f("primary","currentColor"),bt=f("primary-text","inherit"),vt=f("error-text","inherit"),Jo=f("font-sans","inherit"),At=f("font-mono","monospace"),Io=f("radius","9px"),Ot=`calc(${Io} - 2px)`,xo=`calc(${Io} - 4px)`,v=(e,r,n="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${n})`,Co=`background-image: linear-gradient(${G}, ${G});`,xt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Ct="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",ko="box-shadow: var(--oc-sdk-lit);",kt=`inset 0 0.5px 0 0 ${v(U,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,Qo=`
:root {
  --oc-sdk-edge: ${v(U,16)};
  --oc-sdk-field-bg: ${Ne};
  --oc-sdk-raised-bg: ${F};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${v(U,14)};
  --oc-sdk-field-bg: ${v(F,50,Ne)};
  --oc-sdk-raised-bg: ${Ne};
  --oc-sdk-field-lift: ${kt};
  --oc-sdk-raised-lift: ${kt};
  --oc-sdk-lit: ${kt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,we=(e)=>{let r=f(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${f(`${e}-text`,"inherit")}; }`},s=(e)=>`calc(${e}rem / 14)`,Yo=`
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
`,Po=`${Qo}
.oc-sdk { color: ${U}; font-family: ${Jo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Co} }
.oc-sdk-mono { font-family: ${At}; }
.oc-sdk-muted { color: ${b}; }
${we("success")}${we("warning")}${we("error")}${we("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${B}; --oc-sdk-tone-text: ${bt}; }

.oc-sdk-btn { border-radius: ${Ot}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${xo}; }
.oc-sdk-btn[data-variant="default"] { color: ${bt}; background: ${v(B,10,F)}; border-color: ${v(B,12)}; ${ko} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${v(B,16,F)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${v(B,22,F)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${zo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${q}, ${q}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${ee}; ${Ct} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${q}, ${q}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${G}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${q}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${f("status-error","red")}; color: ${vt}; background: ${v("var(--oc-sdk-tone)",7,F)}; border-color: ${v("var(--oc-sdk-tone)",12)}; ${ko} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${v("var(--oc-sdk-tone)",9,F)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${v("var(--oc-sdk-tone)",11,F)}; box-shadow: none; }

.oc-sdk-field-note { color: ${b}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${vt}; }
.oc-sdk-input { border-radius: ${Ot}; background: var(--oc-sdk-field-bg); color: ${ee}; ${xt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${b}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${xt(v(U,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${xt(f("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${At}; }

.oc-sdk-search-icon { color: ${b}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${B}; }
.oc-sdk-search-clear { border-radius: ${xo}; color: ${b}; }
.oc-sdk-search-clear:hover { background: ${G}; color: ${U}; }

.oc-sdk-trigger { border-radius: ${Ot}; background: var(--oc-sdk-raised-bg); color: ${ee}; ${Ct} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${q}, ${q}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${b}; }
.oc-sdk-trigger-chevron { color: ${b}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${ee}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Ne}; background-clip: padding-box; color: ${ee}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${G}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${yt}; color: ${ht}; }
.oc-sdk-option-check { color: ${U}; }
.oc-sdk-option[data-destructive="true"] { color: ${vt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${v(f("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${b}; }
.oc-sdk-popup-empty { color: ${b}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${X}; border-radius: 4px; color: ${U}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${v(U,60,X)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${X}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${F}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${B}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Co} }
.oc-sdk-check-desc { color: ${b}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${v(U,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${b}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${U}; }
.oc-sdk-tab[aria-selected="true"] { color: ${ht}; background: ${yt}; border-color: ${X}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${ee}; background: var(--oc-sdk-raised-bg); ${Ct} }
.oc-sdk-tab-count { color: ${b}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${v(U,6)}; color: ${b}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${v("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${G}; }
.oc-sdk-row[aria-selected="true"] { background: ${yt}; color: ${ht}; }
.oc-sdk-row-lead { font-family: ${At}; color: ${b}; }
.oc-sdk-row-sub { color: ${b}; }
.oc-sdk-row-meta { color: ${b}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${b}; }

.oc-sdk-empty-body { color: ${b}; }

.oc-sdk-spinner { color: ${b}; }
.oc-sdk-spinner-ring { border-color: ${X}; border-top-color: ${B}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${v("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${b}; }

.oc-sdk-separator { color: ${b}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${v(X,40)}; }

.oc-sdk-progress-label { color: ${b}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${v(U,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${B}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${f("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${f("success-text","inherit")}; }

.oc-sdk-text a { color: ${bt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${v(X,60)}; }
`,k=`
${qe}
${Yo}
${Po}`;var Go="oc-sdk-ui-style",te=(e)=>{while(e.firstChild)e.removeChild(e.firstChild)},I=(e)=>{let r=document.getElementById(Go);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ke(document);let n=document.createElement("style");n.id=Go,n.textContent=e,document.head.appendChild(n)},C=(e,r)=>{let n=document.createElement(e);if(r)n.className=r;return n},W=(e)=>{let r=C("button",e);return r.type="button",r},N=(e,r)=>{let n=r??"";if(e.textContent!==n)e.textContent=n};var Zo=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},oe=(e,r)=>{I(k);let n=r,c=W("oc-sdk oc-sdk-btn"),S=Zo(),h=document.createElement("span");c.append(h),e.append(c);let T=()=>{if(c.dataset.variant=n.variant??"default",c.dataset.size=n.size??"default",c.disabled=Boolean(n.disabled)||Boolean(n.loading),c.dataset.loading=n.loading?"true":"false",c.setAttribute("aria-busy",n.loading?"true":"false"),n.loading&&S.parentNode!==c)c.prepend(S);else if(!n.loading&&S.parentNode===c)S.remove();N(h,n.label)},_=()=>{if(n.disabled||n.loading)return;n.onClick()};return c.addEventListener("click",_),T(),{update:(L)=>{n={...n,...L},T()},dispose:()=>{c.removeEventListener("click",_),c.remove()}}};var sr=/(!?)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,nr=(e)=>{try{let r=new URL(e);return r.protocol==="http:"||r.protocol==="https:"}catch{return!1}},Mo=(e)=>{let r=[],n=0;for(let c of e.matchAll(sr)){let S=c.index??0;if(S>n)r.push({kind:"text",text:e.slice(n,S)});let h=c[1]??"",T=(c[2]??"").trim(),_=c[3]??"";if(!nr(_))r.push({kind:"text",text:c[0]});else if(h==="!")r.push({kind:"image",src:_,alt:T});else r.push({kind:"link",href:_,label:T||_});n=S+c[0].length}if(n<e.length)r.push({kind:"text",text:e.slice(n)});return r},It=(e,r)=>{I(k);let n=r,c=C("div","oc-sdk oc-sdk-text");e.append(c);let S=(T)=>{if(!(T.target instanceof HTMLAnchorElement)||!n.onOpenUrl)return;T.preventDefault(),n.onOpenUrl(T.target.href)},h=()=>{te(c);for(let T of Mo(n.text))if(T.kind==="text")c.append(document.createTextNode(T.text));else if(T.kind==="link"){let _=C("a");_.href=T.href,_.rel="noopener noreferrer",_.target="_blank",_.textContent=T.label,c.append(_)}else{let _=C("img");_.src=T.src,_.alt=T.alt,_.loading="lazy",_.referrerPolicy="no-referrer",c.append(_)}};return c.addEventListener("click",S),h(),{update:(T)=>{n={...n,...T},h()},dispose:()=>{c.removeEventListener("click",S),c.remove()}}};var Pt=Rt(),Be=document.querySelector("#root");if(!Be)throw Error("Agent Desk: missing root");var wo=document.createElement("div"),Gt=(e)=>{let r=document.createElement("div");r.textContent=e,wo.prepend(r)},Uo=!1;Pt.onReady((e)=>{if(ft(e,document.documentElement),Uo)return;Uo=!0,It(Be,{text:"Agent Desk"}),oe(Be,{label:"Start a session",onClick:()=>{Pt.serviceRequest({method:"POST",path:"/start",body:JSON.stringify({directory:e.directory})}).then((r)=>Gt(r.body)).catch(()=>Gt("The service did not answer."))}}),Be.append(wo)});Pt.onServiceEvent(({topic:e,data:r})=>Gt(`${e}: ${JSON.stringify(r)}`));})();
