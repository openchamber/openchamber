(()=>{var g="openchamber.sdk",m=1;var Ne=`
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
`;function Be(e){let s=e.documentElement;if(s.hasAttribute("data-oc-scrollbar-activity"))return;s.setAttribute("data-oc-scrollbar-activity","");let r=new WeakMap;e.addEventListener("scroll",(u)=>{let d=u.target===e?s:u.target;if(!(d instanceof Element))return;if(!d.hasAttribute("data-oc-scrolling"))d.setAttribute("data-oc-scrolling","");let S=r.get(d);if(S!==void 0)clearTimeout(S);r.set(d,setTimeout(()=>{r.delete(d),d.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var To=`(${Be.toString()})(document);`;var De=128,Xe=65536;var Ee=128;var fe=65536;var Lt=/^[a-z][a-z0-9-]{0,39}$/;var Mt=(e)=>Object(e)===e&&!Array.isArray(e),$e=(e,s)=>Object.keys(e).every((r)=>s.includes(r)),It=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Ut=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Ht=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let s=new Set;for(let r of e){if(!Mt(r)||!Lt.test(r.id)||!It(r.label))return!1;if(r.disabled!==void 0&&r.disabled!==!0&&r.disabled!==!1)return!1;if(s.has(r.id))return!1;if(s.add(r.id),r.kind==="button"){if(!$e(r,["kind","id","label","disabled"]))return!1;continue}if(r.kind!=="select"||!$e(r,["kind","id","label","value","options","disabled"]))return!1;if(!Ut(r.value)||!Array.isArray(r.options)||r.options.length<1||r.options.length>16)return!1;let u=new Set;for(let d of r.options){if(!Mt(d)||!$e(d,["value","label"])||!Ut(d.value)||!It(d.label)||u.has(d.value))return!1;u.add(d.value)}if(!u.has(r.value))return!1}return!0};var ye=20000000,he=256;var Ve=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Ft=(e,s)=>{if(e.path!==s.path||e.readOnly!==s.readOnly)return!1;if(e.encoding==="text"||s.encoding==="text")return e.encoding==="text"&&s.encoding==="text"&&e.content===s.content;if(e.bytes.byteLength!==s.bytes.byteLength)return!1;for(let r=0;r<e.bytes.byteLength;r+=1)if(e.bytes[r]!==s.bytes[r])return!1;return!0};var Nt=/^[A-Za-z0-9_-]{1,80}$/;var Bt=["left","right","top","bottom"];var Dt=(e,s=0,r={remaining:16000})=>{if(--r.remaining<0||s>=32)return!1;if(e===null)return!0;let u=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let d of u)if(!Dt(d,s+1,r))return!1;return!0},We=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((s)=>/^(0|[1-9]\d*)$/.test(s)&&Number(s)<e.length)&&e.every(We);if(Object(e)===e){let s=Object.getPrototypeOf(e);return(s===null||s===Object.prototype)&&Object.values(e).every(We)}return String(e)===e||Number.isFinite(e)},qe=(e)=>{try{if(String(e.id)!==e.id||!Nt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Bt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Dt(e.data)||!We(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var $t=["file","directory","other","missing"],je=(e)=>Boolean(e&&"sessionId"in e),Ke=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Vt=/^[0-9a-f]{7,64}$/i,Je=(e)=>Vt.test(e),be=500,xe=32000,Wt=16000,qt=128,zt=200,jt=2000,Kt=16000,Jt=80,Yt=200,Qt=16000;var Zt=2000;var Ye=20000,Te=1024,_e=2000000;var ve=64000,Ae=8000,Qe=4000;var Ze=90000;var eo=999,to=1e4,ae=500,oo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],so=["stopped","starting","ready","failed"],_o=new Set(oo),ro=(e)=>_o.has(e),no=(e)=>e&&ro(e)?e:"HOST_REJECTED",J=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(J);if(Object(e)===e)return Object.values(e).every(J);return!1},io=(e)=>J(e)&&JSON.stringify(e).length<=Qt,Xt=(e)=>e?.trim().slice(0,Yt)??"",Y=(e)=>{let s=e.id.trim().slice(0,qt),r=e.title.trim().slice(0,zt),u=e.url.trim().slice(0,jt),d=e.text?.trim().slice(0,Kt),S=e.author?.trim().slice(0,Jt),A=e.kind==="pull"?"pull":"issue",h={providerId:e.providerId.trim(),id:s,title:r||s,url:u,kind:A};if(d)h.text=d;if(S)h.author=S;if(A==="pull"){let k=Xt(e.branches?.head),w=Xt(e.branches?.base);if(k&&w)h.branches={head:k,base:w}}if(io(e.data))h.data=e.data;return h},et=(e)=>{let s=Y(e);if(e.projectId)s.projectId=e.projectId;if(e.navigation)s.navigation=e.navigation;if(e.worktree)s.worktree=e.worktree;return s},tt=(e)=>{let s={text:e.text.trim().slice(0,Wt)};if(e.send)s.send=!0;return s},ot=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(eo,Math.max(0,Math.round(e)))},st=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(to,Math.max(0,Math.ceil(e)))};var Q=(e)=>e.length>0&&e.length<=Te&&!e.includes("\x00")&&!e.includes("\\");var ke=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>Zt)return!1;return!e.split("/").some((r)=>r==="."||r==="..")},vo=new Set(so),rt=(e)=>Boolean(e&&"status"in e&&vo.has(String(e.status))&&!("body"in e)),Re=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),nt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),it=(e)=>Boolean(e&&"written"in e&&e.written===!0),at=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Ao=new Set($t),lt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Ao.has(String(e.kind))&&Number.isFinite(e.size)),ct=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),ko=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved"]),Ro=(e)=>Object(e)===e?e:null,ze=(e)=>String(e)===e&&e.length>0,Go=(e)=>{if(!ze(e.id))return null;if(e.ok===!0){let s={channel:g,v:m,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)s.payload=e.payload;return s}if(e.ok===!1&&ze(e.error))return{channel:g,v:m,type:"result",id:e.id,ok:!1,error:e.error,code:no(ze(e.code)?e.code:void 0)};return null},pt=(e)=>{let s=Ro(e);if(!s||s.channel!==g||s.v!==m)return null;if(s.type==="result")return Go(s);if(!ko.has(String(s.type))||Object(s.payload)!==s.payload)return null;return s};var ao=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Co=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class a extends Error{code;constructor(e,s){super(s);this.name="HostRequestError",this.code=e}}var lo=()=>Promise.reject(new a("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ge=()=>Promise.reject(new a("BAD_PATH",`File path must be 1 to ${Te} characters without NUL or backslash.`)),Ce=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new a("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},p=(e)=>(e.value+=1,`oc-${e.value}`),ut=(e={})=>{let s=e.target??("window"in globalThis?window:null);if(!s)throw new a("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let r=e.acceptSource??((t)=>t===s.parent),u=e.requestTimeoutMs??Ye,d=new Set,S=new Set,A=new Set,h=new Set,k=new Set,w=new Set,D=new Set,ce=new Set,pe=new Set,te=null,oe=null,ue=new Set,de=new Set,se=null,re=null,Ue=!1,z=new Map,j=new Map,K=new Map,F=!1,c={value:0},l=null,N=null,ne=!1,ie=!1,Tt=null,_t=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},U=(t)=>{s.parent.postMessage(t,"*")},R=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},vt=(t)=>{if(!(t instanceof MessageEvent))return;if(!r(t.source))return;let o=pt(t.data);if(!o)return;if(o.type==="workspace"){let i=j.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="shells"){let i=K.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,N=_t(o.payload.session),R(d,o.payload),R(S,o.payload.directory),R(A,o.payload.session),N)R(h,N);R(k,o.payload.connection),R(w,o.payload.settings),R(D,o.payload.item);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};R(S,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)N=null;else if(N?.sessionId!==o.payload.session.id)N=_t(o.payload.session);R(A,o.payload.session);return}if(o.type==="session-lifecycle"){N=o.payload,R(h,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};R(k,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};R(w,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};R(D,o.payload.item);return}if(o.type==="status-control-event"){R(ce,o.payload);return}if(o.type==="popover-closed"){R(pe,o.payload);return}if(o.type==="action"){let i=(E)=>{if(!F)U({channel:g,v:m,type:"action-result",id:o.id,payload:E})},f=oe;if(!f){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>f(o.payload)).then(()=>i({ok:!0}),(E)=>{let v=(E instanceof Error?E.message:String(E)).trim();i({ok:!1,error:(v||"Action failed.").slice(0,ae)})});return}if(o.type==="file-open"){let i=o.payload;if(re&&Ft(re,i))return;re=i,R(ue,o.payload);return}if(o.type==="file-saved"){R(de,o.payload.version);return}if(o.type==="file-snapshot"){let i=(v)=>{if(!F)U({channel:g,v:m,type:"file-snapshot-result",id:o.id,payload:v})},f=(v)=>i({error:(v.trim()||"Could not read the edited file.").slice(0,ae)}),E=se;if(!E){f("This extension does not edit files.");return}Promise.resolve().then(()=>E(o.payload.purpose)).then((v)=>{if(Ve(v)>ye){f(`The file is over ${ye} ${"bytes"in v?"bytes":"characters"}.`);return}if(v.version.length>he){f(`The snapshot version is over ${he} characters.`);return}i({snapshot:"bytes"in v?{bytes:v.bytes,version:v.version}:{content:v.content,version:v.version}})},(v)=>f(v instanceof Error?v.message:String(v)));return}if(o.type==="resolve"){let i=(E)=>{U({channel:g,v:m,type:"resolve-result",id:o.id,payload:E})},f=te;if(!f){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>f(o.payload)).then((E)=>i({item:E?Y(E):null}),(E)=>{let v=(E instanceof Error?E.message:String(E)).trim();i({error:(v||"Command failed.").slice(0,ae)})});return}let n=z.get(o.id);if(!n)return;if(clearTimeout(n.timer),z.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new a(o.code,o.error))};s.addEventListener("message",vt),U({channel:g,v:m,type:"hello"});let P=(t,o=u)=>{if(F||s.parent===s)return Promise.reject(new a("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let f=setTimeout(()=>{z.delete(t.id),i(new a("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:n,reject:i,timer:f}),U(t)})},T=(t)=>P(t).then(()=>{return}),_={channel:g,v:m},Le=(t)=>{if(!F&&s.parent!==s)U(t)},At=()=>Le({..._,type:"file-save"}),kt=(t)=>{if(!ao(t)||!Co(t))return;t.preventDefault(),At()},Rt=(t)=>{if(!ao(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),Pt(l.popover.id,"escape").catch(()=>{return})},Se=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=ne||ie;if(Tt===o)return;Tt=o,wt(t.id,o).catch(()=>{return})},ge=()=>{if(l?.surface!=="popover"||ne)return;ne=!0,Se()},Gt=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!ne)return;ne=!1,Se()},Ct=()=>{if(l?.surface!=="popover"||ie)return;ie=!0,Se()},Ot=()=>{if(l?.surface!=="popover"||!ie)return;ie=!1,Se()},H=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new a("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},He=async(t)=>{if(t.kind!=="projects")H(t.projectId);let o=await P({..._,type:"workspace-read",id:p(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new a("HOST_REJECTED","Host did not return workspace data.");return o},Fe=async(t,o)=>{if(t.kind!=="projects")H(t.projectId);let n=p(c);j.set(n,o);try{await T({..._,type:"workspace-subscribe",id:p(c),payload:{subscriptionId:n,query:t}})}catch(i){if(j.delete(n),!F)U({..._,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:n}});throw i}return()=>{if(!j.delete(n)||F)return;U({..._,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:n}})}},xo=async(t,o)=>{if(t.kind==="session")H(t.sessionId);if(t.kind==="project")H(t.projectId);let n=p(c);K.set(n,o);try{await T({..._,type:"shells-subscribe",id:p(c),payload:{subscriptionId:n,scope:t}})}catch(i){if(K.delete(n),!F)U({..._,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:n}});throw i}return()=>{if(!K.delete(n)||F)return;U({..._,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:n}})}},me=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>De))throw new a("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!J(t.value))throw new a("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Xe)throw new a("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new a("UNSUPPORTED","This host does not support device storage.");let o=await P({..._,type:"storage",id:p(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new a("HOST_REJECTED","Host did not return storage data.");return o},Pt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):T({..._,type:"popover-close",id:p(c),payload:o?{id:t,reason:o}:{id:t}}),wt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):T({..._,type:"popover-anchor",id:p(c),payload:{id:t,active:o}});return s.addEventListener("keydown",Rt,!0),s.addEventListener("pointerover",ge),s.addEventListener("pointermove",ge),s.addEventListener("pointerout",Gt),s.addEventListener("focus",Ct),s.addEventListener("blur",Ot),{onAction:(t)=>(oe=t,()=>{if(oe===t)oe=null}),listProjects:async()=>{let t=await He({kind:"projects"});if(t.kind!=="projects")throw new a("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await He({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new a("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await He({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new a("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Fe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Fe({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Fe({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>xo(t,o),readShellOutput:async(t,o)=>{H(t,Ee);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new a("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>fe))throw new a("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${fe}.`);let E=await P({..._,type:"shell-output",id:p(c),payload:{shellId:t,cursor:n,tailBytes:i}});if(!E||typeof E.output!=="string"||!Number.isFinite(E.cursor))throw new a("HOST_REJECTED","Host did not return shell output.");return E},stopShell:async(t)=>{if(H(t,Ee),(await P({..._,type:"shell-stop",id:p(c),payload:{shellId:t}}))?.stopped!==!0)throw new a("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{H(t),await T({..._,type:"open-session",id:p(c),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Ce(o),i={op:"get",key:t};if(n)i.scope=n;let f=await me(i);return f.op==="get"&&f.found?f.value:void 0},set:async(t,o,n)=>{let i=Ce(n),f={op:"set",key:t,value:o};if(i)f.scope=i;await me(f)},delete:async(t,o)=>{let n=Ce(o),i={op:"delete",key:t};if(n)i.scope=n;await me(i)},keys:async(t)=>{let o=Ce(t),n={op:"keys"};if(o)n.scope=o;let i=await me(n);if(i.op!=="keys")throw new a("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(d.add(t),l)t(l);return()=>{d.delete(t)}},onDirectory:(t)=>{if(S.add(t),l)t(l.directory);return()=>{S.delete(t)}},onSession:(t)=>{if(A.add(t),l)t(l.session);return()=>{A.delete(t)}},onSessionLifecycle:(t)=>{if(h.add(t),N)t(N);return()=>{h.delete(t)}},onConnection:(t)=>{if(k.add(t),l)t(l.connection);return()=>{k.delete(t)}},onSettings:(t)=>{if(w.add(t),l)t(l.settings);return()=>{w.delete(t)}},onItem:(t)=>{if(D.add(t),l)t(l.item);return()=>{D.delete(t)}},onStatusControl:(t)=>(ce.add(t),()=>{ce.delete(t)}),onPopoverClosed:(t)=>(pe.add(t),()=>{pe.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support status controls."));if(!Ht(t))return Promise.reject(new a("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return T({..._,type:"status-controls",id:p(c),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support popovers."));if(!qe(t))return Promise.reject(new a("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return T({..._,type:"popover-open",id:p(c),payload:t})},closePopover:Pt,setPopoverAnchorActive:wt,onResolve:(t)=>(te=t,()=>{if(te===t)te=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>be)return Promise.reject(new a("HOST_REJECTED",`Toast message must contain 1 to ${be} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>xe))return Promise.reject(new a("HOST_REJECTED",`Toast copy text must contain 1 to ${xe} characters.`));return T({channel:g,v:m,type:"toast",id:p(c),payload:{...t,message:o}})},openUrl:(t)=>T({channel:g,v:m,type:"open-url",id:p(c),payload:{url:t}}),openCommit:(t)=>Je(t)?T({channel:g,v:m,type:"open-commit",id:p(c),payload:{sha:t}}):Promise.reject(new a("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>T({channel:g,v:m,type:"open-surface",id:p(c),payload:{surfaceId:t}}),writeClipboard:(t)=>T({channel:g,v:m,type:"clipboard-write",id:p(c),payload:{text:t}}),compose:(t)=>T({channel:g,v:m,type:"compose",id:p(c),payload:t}),attach:(t)=>T({channel:g,v:m,type:"attach",id:p(c),payload:Y(t)}),startSession:async(t)=>{if(t.projectId!==void 0)H(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")H(o.directory);else{if(o.name!==void 0)H(o.name,200);if(o.baseBranch!==void 0)H(o.baseBranch,200)}let n=await P({channel:g,v:m,type:"start-session",id:p(c),payload:et(t)},e.requestTimeoutMs??180000);if(!je(n))throw new a("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>P({channel:g,v:m,type:"prompt",id:p(c),payload:tt(t)}).then((o)=>{if(!Ke(o))throw new a("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>T({channel:g,v:m,type:"session-link",id:p(c),payload:Y(t)}),close:()=>T({channel:g,v:m,type:"close",id:p(c)}),oauthStart:()=>T({channel:g,v:m,type:"oauth-start",id:p(c)}),oauthDisconnect:()=>T({channel:g,v:m,type:"oauth-disconnect",id:p(c)}),request:(t)=>(ke(t.path)?P({channel:g,v:m,type:"request",id:p(c),payload:t}):lo()).then((o)=>{if(!Re(o))throw new a("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(ke(t.path)?P({channel:g,v:m,type:"service-request",id:p(c),payload:t}):lo()).then((o)=>{if(!Re(o))throw new a("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:g,v:m,type:"service-status",id:p(c)}).then((t)=>{if(!rt(t))throw new a("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Q(t)?P({channel:g,v:m,type:"file-read",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!nt(o))throw new a("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Q(t))return Ge();if(o.length>_e)return Promise.reject(new a("FILE_TOO_LARGE",`Content is over ${_e} characters.`));return P({channel:g,v:m,type:"file-write",id:p(c),payload:{path:t,content:o}}).then((n)=>{if(!it(n))throw new a("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(Q(t)?P({channel:g,v:m,type:"file-list",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!at(o))throw new a("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Q(t)?P({channel:g,v:m,type:"file-stat",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!lt(o))throw new a("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>ve)return Promise.reject(new a("HOST_REJECTED",`Prompt must be 1 to ${ve} characters.`));if(n!==void 0&&(n.length===0||n.length>Ae))return Promise.reject(new a("HOST_REJECTED",`System prompt must be 1 to ${Ae} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(Qe,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new a("HOST_REJECTED","maxOutputTokens must be a number."));let f={prompt:o};if(n!==void 0)f.system=n;if(i!==void 0)f.maxOutputTokens=i;return P({channel:g,v:m,type:"generate",id:p(c),payload:f},e.requestTimeoutMs??Ze).then((E)=>{if(!ct(E))throw new a("HOST_REJECTED","Host did not return generated text.");return E})},setBadge:(t)=>T({channel:g,v:m,type:"badge",id:p(c),payload:{count:ot(t)}}),setHeight:(t)=>T({channel:g,v:m,type:"resize",id:p(c),payload:{height:st(t)}}),onFileOpen:(t)=>{if(ue.add(t),!Ue)Ue=!0,s.addEventListener("keydown",kt,!0);if(re)t(re);return()=>{ue.delete(t)}},onFileSnapshot:(t)=>(se=t,()=>{if(se===t)se=null}),onFileSaved:(t)=>(de.add(t),()=>{de.delete(t)}),reportFileChange:(t)=>Le({..._,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:At,reportFileUnsupported:()=>Le({..._,type:"file-unsupported"}),dispose:()=>{for(let t of j.keys())U({..._,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:t}});j.clear();for(let t of K.keys())U({..._,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:t}});if(K.clear(),F=!0,te=null,oe=null,se=null,ue.clear(),de.clear(),Ue)s.removeEventListener("keydown",kt,!0);s.removeEventListener("message",vt),s.removeEventListener("keydown",Rt,!0),s.removeEventListener("pointerover",ge),s.removeEventListener("pointermove",ge),s.removeEventListener("pointerout",Gt),s.removeEventListener("focus",Ct),s.removeEventListener("blur",Ot);for(let t of z.values())clearTimeout(t.timer),t.reject(new a("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),d.clear(),S.clear(),A.clear(),h.clear(),k.clear(),w.clear(),D.clear(),ce.clear(),pe.clear()}}};var co=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var as=new Set(co);var po=["none","agent","user"];var cs=new Set(po);var Oo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Po=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],uo=(e,s)=>{s.style.colorScheme=e.mode;for(let[r,u]of Oo)s.style.setProperty(r,e.tokens[u]);for(let[r,u,d]of Po){let S=e.tokens[d]??"";s.style.setProperty(r,S),s.style.setProperty(u,S)}s.style.setProperty("font-family",e.tokens.font),s.style.setProperty("font-size","0.875rem"),s.style.setProperty("line-height","1.45"),s.style.setProperty("color",e.tokens.foreground)},dt=(e,s)=>{if(uo(e.theme,s),s.dataset)s.dataset.ocSurface=e.surface,s.dataset.ocTheme=e.theme.mode};var wo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,s)=>`var(--${e}, var(--oc-${wo[e]}, ${s}))`,W=y("surface-background","transparent"),Oe=y("surface-elevated","transparent"),le=y("surface-elevated-foreground","inherit"),X=y("surface-foreground","inherit"),b=y("surface-muted-foreground","gray"),Mo=y("surface-muted","transparent"),L=y("interactive-border","currentColor"),M=y("interactive-hover","transparent"),q=y("interactive-active","transparent"),St=y("interactive-selection","transparent"),gt=y("interactive-selection-foreground","inherit"),mo=y("interactive-focus-ring","currentColor"),B=y("primary","currentColor"),mt=y("primary-text","inherit"),Et=y("error-text","inherit"),Io=y("font-sans","inherit"),ft=y("font-mono","monospace"),Eo=y("radius","9px"),yt=`calc(${Eo} - 2px)`,So=`calc(${Eo} - 4px)`,G=(e,s,r="transparent")=>`color-mix(in srgb, ${e} ${s}%, ${r})`,go=`box-shadow: 0 0 0 2px ${mo};`,Pe=(e)=>{let s=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${s}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},Uo=`
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
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
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
`,fo=`
.oc-sdk { color: ${X}; font-family: ${Io}; }
.oc-sdk :focus-visible { outline: none; ${go} }
.oc-sdk-mono { font-family: ${ft}; }
.oc-sdk-muted { color: ${b}; }
${Pe("success")}${Pe("warning")}${Pe("error")}${Pe("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${B}; --oc-sdk-tone-text: ${mt}; }

.oc-sdk-btn { border-radius: ${yt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${So}; }
.oc-sdk-btn[data-variant="default"] { color: ${mt}; background: ${G(B,10,W)}; border-color: ${G(B,12)}; }
.oc-sdk-btn[data-variant="default"]:hover { background: ${G(B,16,W)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${G(B,22,W)}; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Mo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${q}, ${q}); }
.oc-sdk-btn[data-variant="outline"] { background: ${Oe}; color: ${le}; border-color: ${L}; }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${q}, ${q}); }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${M}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${q}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${Et}; background: ${G("var(--oc-sdk-tone)",7,W)}; border-color: ${G("var(--oc-sdk-tone)",12)}; }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${G("var(--oc-sdk-tone)",9,W)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${G("var(--oc-sdk-tone)",11,W)}; }

.oc-sdk-field-note { color: ${b}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Et}; }
.oc-sdk-input { border-radius: ${yt}; background: ${Oe}; color: ${le}; box-shadow: inset 0 0 0 1px ${G(L,60)}; transition: background 150ms ease-out, box-shadow 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${b}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { box-shadow: inset 0 0 0 2px ${mo}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input { box-shadow: inset 0 0 0 1px ${y("status-error","red")}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { box-shadow: inset 0 0 0 2px ${y("status-error","red")}; }
.oc-sdk-input[data-mono="true"] { font-family: ${ft}; }

.oc-sdk-search-icon { color: ${b}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${B}; }
.oc-sdk-search-clear { border-radius: ${So}; color: ${b}; }
.oc-sdk-search-clear:hover { background: ${M}; color: ${X}; }

.oc-sdk-trigger { border-color: ${L}; border-radius: ${yt}; background: ${Oe}; color: ${le}; transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${q}, ${q}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${b}; }
.oc-sdk-trigger-chevron { color: ${b}; }
.oc-sdk-popup { --surface-foreground: ${le}; border-color: ${G(L,60)}; border-radius: 12px; background: ${Oe}; color: ${le}; box-shadow: 0 8px 24px ${G(X,12)}; }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${M}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${St}; color: ${gt}; }
.oc-sdk-option-check { color: ${X}; }
.oc-sdk-option[data-destructive="true"] { color: ${Et}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${G(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${b}; }
.oc-sdk-popup-empty { color: ${b}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${L}; border-radius: 4px; color: ${X}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${G(X,60,L)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${L}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${W}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${B}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${go} }
.oc-sdk-check-desc { color: ${b}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${G(X,4)}; }
.oc-sdk-tab { border-radius: 8px; color: ${b}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${X}; }
.oc-sdk-tab[aria-selected="true"] { color: ${gt}; background: ${St}; border-color: ${L}; }
.oc-sdk-tab-count { color: ${b}; }

.oc-sdk-badge { border-radius: 9999px; background: ${M}; color: ${b}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${G("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${St}; color: ${gt}; }
.oc-sdk-row-lead { font-family: ${ft}; color: ${b}; }
.oc-sdk-row-sub { color: ${b}; }
.oc-sdk-row-meta { color: ${b}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${b}; }

.oc-sdk-empty-body { color: ${b}; }

.oc-sdk-spinner { color: ${b}; }
.oc-sdk-spinner-ring { border-color: ${L}; border-top-color: ${B}; border-radius: 9999px; }

.oc-sdk-banner { border-color: ${G("var(--oc-sdk-tone)",40)}; border-radius: 8px; background: ${G("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${b}; }

.oc-sdk-separator { color: ${b}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${G(L,40)}; }

.oc-sdk-progress-label { color: ${b}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${L}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${B}); }

.oc-sdk-text a { color: ${mt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${G(L,60)}; }
`,C=`
${Ne}
${Uo}
${fo}`;var yo="oc-sdk-ui-style";var O=(e)=>{let s=document.getElementById(yo);if(s instanceof HTMLStyleElement){if(s.textContent!==e)s.textContent=e;return}Be(document);let r=document.createElement("style");r.id=yo,r.textContent=e,document.head.appendChild(r)},x=(e,s)=>{let r=document.createElement(e);if(s)r.className=s;return r},V=(e)=>{let s=x("button",e);return s.type="button",s},I=(e,s)=>{let r=s??"";if(e.textContent!==r)e.textContent=r},Z=(e,s,r)=>{if(r===void 0||r===null||r==="")e.removeAttribute(s);else if(e.getAttribute(s)!==r)e.setAttribute(s,r)};var Lo=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},ee=(e,s)=>{O(C);let r=s,u=V("oc-sdk oc-sdk-btn"),d=Lo(),S=document.createElement("span");u.append(S),e.append(u);let A=()=>{if(u.dataset.variant=r.variant??"default",u.dataset.size=r.size??"default",u.disabled=Boolean(r.disabled)||Boolean(r.loading),u.dataset.loading=r.loading?"true":"false",u.setAttribute("aria-busy",r.loading?"true":"false"),r.loading&&d.parentNode!==u)u.prepend(d);else if(!r.loading&&d.parentNode===u)d.remove();I(S,r.label)},h=()=>{if(r.disabled||r.loading)return;r.onClick()};return u.addEventListener("click",h),A(),{update:(k)=>{r={...r,...k},A()},dispose:()=>{u.removeEventListener("click",h),u.remove()}}};var ht=(e,s)=>{O(C);let r=s,u=x("label","oc-sdk oc-sdk-field"),d=x("span","oc-sdk-field-label"),S=r.multiline?x("textarea","oc-sdk-input"):x("input","oc-sdk-input"),A=x("span","oc-sdk-field-note");u.append(d,S,A),e.append(u);let h=()=>{if(I(d,r.label),d.hidden=!r.label,S instanceof HTMLInputElement)S.type=r.password?"password":"text";else S.rows=r.rows??3;if(S.value!==r.value)S.value=r.value;S.disabled=Boolean(r.disabled),Z(S,"placeholder",r.placeholder),S.dataset.mono=r.mono?"true":"false";let w=Boolean(r.error);u.dataset.invalid=w?"true":"false",S.setAttribute("aria-invalid",w?"true":"false");let D=r.error??r.helper??"";I(A,D),A.hidden=D===""},k=()=>{r.onChange(S.value)};return S.addEventListener("input",k),h(),{update:(w)=>{r={...r,...w},h()},dispose:()=>{S.removeEventListener("input",k),u.remove()}}};var xt=ut(),bo=document.querySelector("#root");if(!bo)throw Error("Missing root");var ho=!1;xt.onReady((e)=>{if(dt(e,document.documentElement),ho)return;ho=!0;let s=document.createElement("div");s.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",bo.append(s);let r="",u=document.createElement("div");u.style.flex="1",s.append(u);let d=ht(u,{value:r,placeholder:"https://example.com",mono:!0,onChange:(h)=>{r=h,d.update({value:h})}}),S=ee(s,{label:"Go",size:"sm",onClick:()=>{if(!r.trim())return;S.update({loading:!0}),xt.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:r.trim()})}).then(()=>A()).finally(()=>S.update({loading:!1}))}}),A=async()=>{try{let h=await xt.serviceRequest({method:"GET",path:"/state"}),k=JSON.parse(h.body);if(String(k.url)===k.url&&k.url!==r)r=k.url==="about:blank"?"":k.url,d.update({value:r})}catch{}};A(),setInterval(()=>{A()},2000)});})();
