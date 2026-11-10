(()=>{var E="openchamber.sdk",g=1;var Ye=`
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
`;function Ze(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(l)=>{let p=l.target===e?r:l.target;if(!(p instanceof Element))return;if(!p.hasAttribute("data-oc-scrolling"))p.setAttribute("data-oc-scrolling","");let _=s.get(p);if(_!==void 0)clearTimeout(_);s.set(p,setTimeout(()=>{s.delete(p),p.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var qo=`(${Ze.toString()})(document);`;var et=128,tt=65536;var ve=128;var xe=65536;var to=/^[a-z][a-z0-9-]{0,39}$/;var Yt=(e)=>Object(e)===e&&!Array.isArray(e),ot=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Zt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,eo=(e)=>String(e)===e&&e.length>=1&&e.length<=80,oo=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Yt(s)||!to.test(s.id)||!Zt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!ot(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!ot(s,["kind","id","label","value","options","disabled"]))return!1;if(!eo(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let l=new Set;for(let p of s.options){if(!Yt(p)||!ot(p,["value","label"])||!eo(p.value)||!Zt(p.label)||l.has(p.value))return!1;l.add(p.value)}if(!l.has(s.value))return!1}return!0};var ro=["{id}","{segment}","{segments+}"];var hr=new Set(ro);var so=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var vr=new Set(so);var Oe=20000000,Ae=256;var rt=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,no=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0},Ce=(e)=>{let r=e,s=e;return{observe:(l)=>{let p=l!==s;return s=l,{edited:p,dirty:l!==r}},markSaved:(l)=>(r=l,s!==l)}};var io=/^[A-Za-z0-9_-]{1,80}$/;var ao=["left","right","top","bottom"];var lo=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let l=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let p of l)if(!lo(p,r+1,s))return!1;return!0},st=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(st);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(st)}return String(e)===e||Number.isFinite(e)},nt=(e)=>{try{if(String(e.id)!==e.id||!io.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!ao.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!lo(e.data)||!st(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var at=2000;var uo=["file","directory","other","missing"],lt=(e)=>Boolean(e&&"sessionId"in e),ct=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var po=/^[0-9a-f]{7,64}$/i,ut=(e)=>po.test(e),ke=500,Ie=32000,So=16000,Eo=128,go=200,_o=2000,mo=16000,To=80,fo=200,yo=16000;var Ro=2000;var pt=20000,Pe=1024,Ge=2000000;var Me=64000,Ue=8000,dt=4000;var St=960000;var ho=999,bo=1e4,Se=500,vo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],xo=["stopped","starting","ready","failed"],Ko=new Set(vo),Oo=(e)=>Ko.has(e),Ao=(e)=>e&&Oo(e)?e:"HOST_REJECTED",te=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(te);if(Object(e)===e)return Object.values(e).every(te);return!1},Co=(e)=>te(e)&&JSON.stringify(e).length<=yo,co=(e)=>e?.trim().slice(0,fo)??"",oe=(e)=>{let r=e.id.trim().slice(0,Eo),s=e.title.trim().slice(0,go),l=e.url.trim().slice(0,_o),p=e.text?.trim().slice(0,mo),_=e.author?.trim().slice(0,To),f=e.kind==="pull"?"pull":"issue",m={providerId:e.providerId.trim(),id:r,title:s||r,url:l,kind:f};if(p)m.text=p;if(_)m.author=_;if(f==="pull"){let k=co(e.branches?.head),U=co(e.branches?.base);if(k&&U)m.branches={head:k,base:U}}if(Co(e.data))m.data=e.data;return m},Et=(e)=>{let r=oe(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},gt=(e)=>{let r={text:e.text.trim().slice(0,So)};if(e.send)r.send=!0;return r},_t=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(ho,Math.max(0,Math.round(e)))},mt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(bo,Math.max(0,Math.ceil(e)))};var re=(e)=>e.length>0&&e.length<=Pe&&!e.includes("\x00")&&!e.includes("\\");var we=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>Ro)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},jo=new Set(xo),Tt=(e)=>Boolean(e&&"status"in e&&jo.has(String(e.status))&&!("body"in e)),Ne=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),ft=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),yt=(e)=>Boolean(e&&"written"in e&&e.written===!0),Rt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),zo=new Set(uo),ht=(e)=>Boolean(e&&"kind"in e&&"size"in e&&zo.has(String(e.kind))&&Number.isFinite(e.size)),bt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Qo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Jo=(e)=>Object(e)===e?e:null,it=(e)=>String(e)===e&&e.length>0,Yo=(e)=>{if(!it(e.id))return null;if(e.ok===!0){let r={channel:E,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&it(e.error))return{channel:E,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:Ao(it(e.code)?e.code:void 0)};return null},vt=(e)=>{let r=Jo(e);if(!r||r.channel!==E||r.v!==g)return null;if(r.type==="result")return Yo(r);if(!Qo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var ko=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Zo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class u extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Io=()=>Promise.reject(new u("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Le=()=>Promise.reject(new u("BAD_PATH",`File path must be 1 to ${Pe} characters without NUL or backslash.`)),De=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new u("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},S=(e)=>(e.value+=1,`oc-${e.value}`),xt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new u("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),l=e.requestTimeoutMs??pt,p=new Set,_=new Set,f=new Set,m=new Set,k=new Set,U=new Set,ie=new Set,ge=new Set,_e=new Set,me=new Set,Te=new Set,J=new Set,Ke=[],ae=null,le=null,fe=new Set,ye=new Set,ce=null,ue=null,je=!1,Y=new Map,Z=new Map,ee=new Map,H=!1,d={value:0},c=null,F=null,pe=!1,de=!1,Ft=null,Bt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},Vt=()=>{if(H||r.parent===r||J.size===0||c?.features?.lateGenerateResults!==!0)return;w({channel:E,v:g,type:"generate-late-listen"})},h=(t,o)=>{for(let i of t)try{i(o)}catch(a){console.error(a)}},$t=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=vt(t.data);if(!o)return;if(o.type==="workspace"){let a=Z.get(o.payload.subscriptionId);if(a)h([a],o.payload.snapshot);return}if(o.type==="shells"){let a=ee.get(o.payload.subscriptionId);if(a)h([a],o.payload.snapshot);return}if(o.type==="ready"){if(c=o.payload,F=Bt(o.payload.session),h(p,o.payload),h(_,o.payload.directory),h(f,o.payload.session),F)h(m,F);if(h(k,o.payload.connection),h(U,o.payload.settings),h(ie,o.payload.item),o.payload.block)h(ge,o.payload.block);Vt();return}if(o.type==="service-event"){h(_e,o.payload);return}if(o.type==="generate-late"){if(J.size===0)Ke.push(o.payload);else h(J,o.payload);return}if(o.type==="directory"){if(c)c={...c,directory:o.payload.directory};h(_,o.payload.directory);return}if(o.type==="session"){if(c)c={...c,session:o.payload.session};if(!o.payload.session)F=null;else if(F?.sessionId!==o.payload.session.id)F=Bt(o.payload.session);h(f,o.payload.session);return}if(o.type==="session-lifecycle"){F=o.payload,h(m,o.payload);return}if(o.type==="connection"){if(c)c={...c,connection:o.payload.connection};h(k,o.payload.connection);return}if(o.type==="settings"){if(c)c={...c,settings:o.payload.settings};h(U,o.payload.settings);return}if(o.type==="item"){if(c)c={...c,item:o.payload.item};h(ie,o.payload.item);return}if(o.type==="status-control-event"){h(me,o.payload);return}if(o.type==="popover-closed"){h(Te,o.payload);return}if(o.type==="action"){let a=(T)=>{if(!H)w({channel:E,v:g,type:"action-result",id:o.id,payload:T})},y=le;if(!y){a({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>y(o.payload)).then(()=>a({ok:!0}),(T)=>{let A=(T instanceof Error?T.message:String(T)).trim();a({ok:!1,error:(A||"Action failed.").slice(0,Se)})});return}if(o.type==="file-open"){let a=o.payload;if(ue&&no(ue,a))return;ue=a,h(fe,o.payload);return}if(o.type==="file-saved"){h(ye,o.payload.version);return}if(o.type==="file-snapshot"){let a=(A)=>{if(!H)w({channel:E,v:g,type:"file-snapshot-result",id:o.id,payload:A})},y=(A)=>a({error:(A.trim()||"Could not read the edited file.").slice(0,Se)}),T=ce;if(!T){y("This extension does not edit files.");return}Promise.resolve().then(()=>T(o.payload.purpose)).then((A)=>{if(rt(A)>Oe){y(`The file is over ${Oe} ${"bytes"in A?"bytes":"characters"}.`);return}if(A.version.length>Ae){y(`The snapshot version is over ${Ae} characters.`);return}a({snapshot:"bytes"in A?{bytes:A.bytes,version:A.version}:{content:A.content,version:A.version}})},(A)=>y(A instanceof Error?A.message:String(A)));return}if(o.type==="resolve"){let a=(T)=>{w({channel:E,v:g,type:"resolve-result",id:o.id,payload:T})},y=ae;if(!y){a({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>y(o.payload)).then((T)=>a({item:T?oe(T):null}),(T)=>{let A=(T instanceof Error?T.message:String(T)).trim();a({error:(A||"Command failed.").slice(0,Se)})});return}let i=Y.get(o.id);if(!i)return;if(clearTimeout(i.timer),Y.delete(o.id),o.ok){i.resolve(o.payload);return}i.reject(new u(o.code,o.error))};r.addEventListener("message",$t),w({channel:E,v:g,type:"hello"});let G=(t,o=l)=>{if(H||r.parent===r)return Promise.reject(new u("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((i,a)=>{let y=setTimeout(()=>{Y.delete(t.id),a(new u("HOST_TIMEOUT","Host did not answer in time."))},o);Y.set(t.id,{resolve:i,reject:a,timer:y}),w(t)})},x=(t)=>G(t).then(()=>{return}),O={channel:E,v:g},ze=(t)=>{if(!H&&r.parent!==r)w(t)},Xt=()=>ze({...O,type:"file-save"}),qt=(t)=>{if(!ko(t)||!Zo(t))return;t.preventDefault(),Xt()},Wt=(t)=>{if(!ko(t)||t.key!=="Escape"||c?.surface!=="popover"||!c.popover)return;t.preventDefault(),Qt(c.popover.id,"escape").catch(()=>{return})},Re=()=>{let t=c?.surface==="popover"?c.popover:void 0;if(!t)return;let o=pe||de;if(Ft===o)return;Ft=o,Jt(t.id,o).catch(()=>{return})},he=()=>{if(c?.surface!=="popover"||pe)return;pe=!0,Re()},Kt=(t)=>{if(c?.surface!=="popover"||t.relatedTarget!==null||!pe)return;pe=!1,Re()},jt=()=>{if(c?.surface!=="popover"||de)return;de=!0,Re()},zt=()=>{if(c?.surface!=="popover"||!de)return;de=!1,Re()},D=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new u("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Qe=async(t)=>{if(t.kind!=="projects")D(t.projectId);let o=await G({...O,type:"workspace-read",id:S(d),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new u("HOST_REJECTED","Host did not return workspace data.");return o},Je=async(t,o)=>{if(t.kind!=="projects")D(t.projectId);let i=S(d);Z.set(i,o);try{await x({...O,type:"workspace-subscribe",id:S(d),payload:{subscriptionId:i,query:t}})}catch(a){if(Z.delete(i),!H)w({...O,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:i}});throw a}return()=>{if(!Z.delete(i)||H)return;w({...O,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:i}})}},Xo=async(t,o)=>{if(t.kind==="session")D(t.sessionId);if(t.kind==="project")D(t.projectId);let i=S(d);ee.set(i,o);try{await x({...O,type:"shells-subscribe",id:S(d),payload:{subscriptionId:i,scope:t}})}catch(a){if(ee.delete(i),!H)w({...O,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:i}});throw a}return()=>{if(!ee.delete(i)||H)return;w({...O,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:i}})}},be=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>et))throw new u("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!te(t.value))throw new u("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>tt)throw new u("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&c?.features?.deviceStorage!==!0)throw new u("UNSUPPORTED","This host does not support device storage.");let o=await G({...O,type:"storage",id:S(d),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new u("HOST_REJECTED","Host did not return storage data.");return o},Qt=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):x({...O,type:"popover-close",id:S(d),payload:o?{id:t,reason:o}:{id:t}}),Jt=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):x({...O,type:"popover-anchor",id:S(d),payload:{id:t,active:o}});return r.addEventListener("keydown",Wt,!0),r.addEventListener("pointerover",he),r.addEventListener("pointermove",he),r.addEventListener("pointerout",Kt),r.addEventListener("focus",jt),r.addEventListener("blur",zt),{onAction:(t)=>(le=t,()=>{if(le===t)le=null}),listProjects:async()=>{let t=await Qe({kind:"projects"});if(t.kind!=="projects")throw new u("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Qe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new u("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Qe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new u("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Je({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Je({kind:"worktrees",projectId:t},(i)=>{if(i.kind==="worktrees")o(i)}),onSessions:(t,o)=>Je({kind:"sessions",projectId:t},(i)=>{if(i.kind==="sessions")o(i)}),onRunningShells:(t,o)=>Xo(t,o),readShellOutput:async(t,o)=>{D(t,ve);let i=o?.cursor;if(i!==void 0&&(!Number.isInteger(i)||i<0))throw new u("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let a=o?.tailBytes;if(a!==void 0&&(!Number.isInteger(a)||a<1||a>xe))throw new u("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${xe}.`);let T=await G({...O,type:"shell-output",id:S(d),payload:{shellId:t,cursor:i,tailBytes:a}});if(!T||typeof T.output!=="string"||!Number.isFinite(T.cursor))throw new u("HOST_REJECTED","Host did not return shell output.");return T},stopShell:async(t)=>{if(D(t,ve),(await G({...O,type:"shell-stop",id:S(d),payload:{shellId:t}}))?.stopped!==!0)throw new u("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{D(t),await x({...O,type:"open-session",id:S(d),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let i=De(o),a={op:"get",key:t};if(i)a.scope=i;let y=await be(a);return y.op==="get"&&y.found?y.value:void 0},set:async(t,o,i)=>{let a=De(i),y={op:"set",key:t,value:o};if(a)y.scope=a;await be(y)},delete:async(t,o)=>{let i=De(o),a={op:"delete",key:t};if(i)a.scope=i;await be(a)},keys:async(t)=>{let o=De(t),i={op:"keys"};if(o)i.scope=o;let a=await be(i);if(a.op!=="keys")throw new u("HOST_REJECTED","Expected storage keys.");return a.keys}},onReady:(t)=>{if(p.add(t),c)t(c);return()=>{p.delete(t)}},onDirectory:(t)=>{if(_.add(t),c)t(c.directory);return()=>{_.delete(t)}},onSession:(t)=>{if(f.add(t),c)t(c.session);return()=>{f.delete(t)}},onSessionLifecycle:(t)=>{if(m.add(t),F)t(F);return()=>{m.delete(t)}},onConnection:(t)=>{if(k.add(t),c)t(c.connection);return()=>{k.delete(t)}},onSettings:(t)=>{if(U.add(t),c)t(c.settings);return()=>{U.delete(t)}},onItem:(t)=>{if(ie.add(t),c)t(c.item);return()=>{ie.delete(t)}},onBlock:(t)=>{if(ge.add(t),c?.block)t(c.block);return()=>{ge.delete(t)}},onServiceEvent:(t)=>(_e.add(t),()=>{_e.delete(t)}),onStatusControl:(t)=>(me.add(t),()=>{me.delete(t)}),onPopoverClosed:(t)=>(Te.add(t),()=>{Te.delete(t)}),setStatusControls:(t)=>{if(c?.features?.statusControls!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support status controls."));if(!oo(t))return Promise.reject(new u("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...O,type:"status-controls",id:S(d),payload:{controls:t}})},openPopover:(t)=>{if(c?.features?.popovers!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support popovers."));if(!nt(t))return Promise.reject(new u("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...O,type:"popover-open",id:S(d),payload:t})},closePopover:Qt,setPopoverAnchorActive:Jt,onResolve:(t)=>(ae=t,()=>{if(ae===t)ae=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>ke)return Promise.reject(new u("HOST_REJECTED",`Toast message must contain 1 to ${ke} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Ie))return Promise.reject(new u("HOST_REJECTED",`Toast copy text must contain 1 to ${Ie} characters.`));return x({channel:E,v:g,type:"toast",id:S(d),payload:{...t,message:o}})},openUrl:(t)=>x({channel:E,v:g,type:"open-url",id:S(d),payload:{url:t}}),openCommit:(t)=>ut(t)?x({channel:E,v:g,type:"open-commit",id:S(d),payload:{sha:t}}):Promise.reject(new u("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>x({channel:E,v:g,type:"block-answer",id:S(d),payload:{text:t.trim().slice(0,at)}}),openSurface:(t)=>x({channel:E,v:g,type:"open-surface",id:S(d),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:E,v:g,type:"clipboard-write",id:S(d),payload:{text:t}}),compose:(t)=>x({channel:E,v:g,type:"compose",id:S(d),payload:t}),attach:(t)=>x({channel:E,v:g,type:"attach",id:S(d),payload:oe(t)}),startSession:async(t)=>{if(t.projectId!==void 0)D(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")D(o.directory);else{if(o.name!==void 0)D(o.name,200);if(o.baseBranch!==void 0)D(o.baseBranch,200)}let i=await G({channel:E,v:g,type:"start-session",id:S(d),payload:Et(t)},e.requestTimeoutMs??180000);if(!lt(i))throw new u("HOST_REJECTED","Host did not return a session.");return i},prompt:(t)=>G({channel:E,v:g,type:"prompt",id:S(d),payload:gt(t)}).then((o)=>{if(!ct(o))throw new u("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:E,v:g,type:"session-link",id:S(d),payload:oe(t)}),close:()=>x({channel:E,v:g,type:"close",id:S(d)}),oauthStart:()=>x({channel:E,v:g,type:"oauth-start",id:S(d)}),oauthDisconnect:()=>x({channel:E,v:g,type:"oauth-disconnect",id:S(d)}),request:(t)=>(we(t.path)?G({channel:E,v:g,type:"request",id:S(d),payload:t}):Io()).then((o)=>{if(!Ne(o))throw new u("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(we(t.path)?G({channel:E,v:g,type:"service-request",id:S(d),payload:t}):Io()).then((o)=>{if(!Ne(o))throw new u("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>G({channel:E,v:g,type:"service-status",id:S(d)}).then((t)=>{if(!Tt(t))throw new u("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(re(t)?G({channel:E,v:g,type:"file-read",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!ft(o))throw new u("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!re(t))return Le();if(o.length>Ge)return Promise.reject(new u("FILE_TOO_LARGE",`Content is over ${Ge} characters.`));return G({channel:E,v:g,type:"file-write",id:S(d),payload:{path:t,content:o}}).then((i)=>{if(!yt(i))throw new u("HOST_REJECTED","Host did not confirm the write.");return i})},listDir:(t)=>(re(t)?G({channel:E,v:g,type:"file-list",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!Rt(o))throw new u("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(re(t)?G({channel:E,v:g,type:"file-stat",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!ht(o))throw new u("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),i=t.system?.trim();if(o.length===0||o.length>Me)return Promise.reject(new u("HOST_REJECTED",`Prompt must be 1 to ${Me} characters.`));if(i!==void 0&&(i.length===0||i.length>Ue))return Promise.reject(new u("HOST_REJECTED",`System prompt must be 1 to ${Ue} characters.`));let a=t.maxOutputTokens===void 0?void 0:Math.min(dt,Math.max(1,Math.floor(t.maxOutputTokens)));if(a!==void 0&&!Number.isFinite(a))return Promise.reject(new u("HOST_REJECTED","maxOutputTokens must be a number."));let y={prompt:o};if(i!==void 0)y.system=i;if(a!==void 0)y.maxOutputTokens=a;return G({channel:E,v:g,type:"generate",id:S(d),payload:y},e.requestTimeoutMs??St).then((T)=>{if(!bt(T))throw new u("HOST_REJECTED","Host did not return generated text.");return T})},onLateGenerateResult:(t)=>{J.add(t);for(let o of Ke.splice(0))h([t],o);return Vt(),()=>{J.delete(t)}},setBadge:(t)=>x({channel:E,v:g,type:"badge",id:S(d),payload:{count:_t(t)}}),setHeight:(t)=>x({channel:E,v:g,type:"resize",id:S(d),payload:{height:mt(t)}}),onFileOpen:(t)=>{if(fe.add(t),!je)je=!0,r.addEventListener("keydown",qt,!0);if(ue)t(ue);return()=>{fe.delete(t)}},onFileSnapshot:(t)=>(ce=t,()=>{if(ce===t)ce=null}),onFileSaved:(t)=>(ye.add(t),()=>{ye.delete(t)}),reportFileChange:(t)=>ze({...O,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Xt,reportFileUnsupported:()=>ze({...O,type:"file-unsupported"}),dispose:()=>{for(let t of Z.keys())w({...O,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:t}});Z.clear();for(let t of ee.keys())w({...O,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:t}});if(ee.clear(),H=!0,ae=null,le=null,ce=null,fe.clear(),ye.clear(),je)r.removeEventListener("keydown",qt,!0);r.removeEventListener("message",$t),r.removeEventListener("keydown",Wt,!0),r.removeEventListener("pointerover",he),r.removeEventListener("pointermove",he),r.removeEventListener("pointerout",Kt),r.removeEventListener("focus",jt),r.removeEventListener("blur",zt);for(let t of Y.values())clearTimeout(t.timer),t.reject(new u("HOST_UNAVAILABLE","Host client was disposed."));Y.clear(),p.clear(),_.clear(),f.clear(),m.clear(),k.clear(),U.clear(),ie.clear(),ge.clear(),_e.clear(),me.clear(),Te.clear(),J.clear(),Ke.length=0}}};var Po=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Hr=new Set(Po);var Go=["none","agent","user"];var Br=new Set(Go);var er=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],tr=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Mo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,l]of er)r.style.setProperty(s,e.tokens[l]);for(let[s,l,p]of tr){let _=e.tokens[p]??"";r.style.setProperty(s,_),r.style.setProperty(l,_)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},Ot=(e,r)=>{if(Mo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var or={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},R=(e,r)=>`var(--${e}, var(--oc-${or[e]}, ${r}))`,V=R("surface-background","transparent"),Fe=R("surface-elevated","transparent"),se=R("surface-elevated-foreground","inherit"),N=R("surface-foreground","inherit"),b=R("surface-muted-foreground","gray"),rr=R("surface-muted","transparent"),K=R("interactive-border","currentColor"),M=R("interactive-hover","transparent"),j=R("interactive-active","transparent"),At=R("interactive-selection","transparent"),Ct=R("interactive-selection-foreground","inherit"),B=R("primary","currentColor"),kt=R("primary-text","inherit"),It=R("error-text","inherit"),sr=R("font-sans","inherit"),Pt=R("font-mono","monospace"),Lo=R("radius","9px"),Gt=`calc(${Lo} - 2px)`,Uo=`calc(${Lo} - 4px)`,v=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,wo=`background-image: linear-gradient(${M}, ${M});`,Mt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Ut="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",No="box-shadow: var(--oc-sdk-lit);",wt=`inset 0 0.5px 0 0 ${v(N,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,nr=`
:root {
  --oc-sdk-edge: ${v(N,16)};
  --oc-sdk-field-bg: ${Fe};
  --oc-sdk-raised-bg: ${V};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${v(N,14)};
  --oc-sdk-field-bg: ${v(V,50,Fe)};
  --oc-sdk-raised-bg: ${Fe};
  --oc-sdk-field-lift: ${wt};
  --oc-sdk-raised-lift: ${wt};
  --oc-sdk-lit: ${wt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,He=(e)=>{let r=R(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${R(`${e}-text`,"inherit")}; }`},n=(e)=>`calc(${e}rem / 14)`,ir=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: ${n(8)}; height: ${n(32)}; padding: 0 ${n(12)}; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: ${n(6)}; height: ${n(28)}; padding: 0 ${n(10)}; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: ${n(4)}; height: ${n(24)}; padding: 0 ${n(8)}; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: ${n(14)}; height: ${n(14)}; }

.oc-sdk-field { display: flex; flex-direction: column; gap: ${n(4)}; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: ${n(32)}; padding: 0 ${n(10)}; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: ${n(8)} ${n(10)}; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: ${n(34)}; padding-right: ${n(34)}; }
.oc-sdk-search-icon { position: absolute; left: ${n(11)}; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: ${n(6)}; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: ${n(24)}; height: ${n(24)}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: ${n(4)}; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: ${n(6)}; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: ${n(28)}; padding: 0 ${n(10)}; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: ${n(2)}; min-width: ${n(160)}; max-width: calc(100vw - ${n(16)}); max-height: min(${n(320)}, calc(100vh - ${n(16)})); overflow: auto; padding: ${n(4)}; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: ${n(2)} ${n(2)} ${n(4)}; }
.oc-sdk-popup-search .oc-sdk-input { height: ${n(28)}; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: ${n(8)}; width: 100%; padding: ${n(6)} ${n(8)}; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: ${n(14)}; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: ${n(8)}; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: ${n(8)}; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: ${n(14)}; height: ${n(14)}; margin-top: ${n(3)}; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: ${n(36)}; height: ${n(20)}; --oc-sdk-thumb-travel: ${n(16)}; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: ${n(2)}; left: ${n(2)}; width: ${n(16)}; height: ${n(16)}; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: ${n(2)}; padding: ${n(2)}; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: ${n(6)}; height: ${n(28)}; padding: 0 ${n(10)}; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: ${n(1)} ${n(6)}; font-size: ${n(11)}; font-weight: 500; line-height: ${n(16)}; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: ${n(8)}; width: 100%; padding: ${n(6)} ${n(8)}; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: ${n(64)}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: ${n(16)} ${n(8)}; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${n(4)}; padding: ${n(40)} ${n(16)}; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: ${n(12)}; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: ${n(8)}; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: ${n(16)}; height: ${n(16)}; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: ${n(12)}; height: ${n(12)}; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: ${n(12)}; padding: ${n(8)} ${n(12)}; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: ${n(2)}; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: ${n(8)}; width: 100%; margin: ${n(8)} 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: ${n(4)} 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: ${n(4)}; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: ${n(6)}; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }
.oc-sdk-progress-value { display: inline-flex; align-items: center; gap: ${n(2)}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { font-weight: 600; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: ${n(8)} 0; }
`,Do=`${nr}
.oc-sdk { color: ${N}; font-family: ${sr}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${wo} }
.oc-sdk-mono { font-family: ${Pt}; }
.oc-sdk-muted { color: ${b}; }
${He("success")}${He("warning")}${He("error")}${He("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${B}; --oc-sdk-tone-text: ${kt}; }

.oc-sdk-btn { border-radius: ${Gt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Uo}; }
.oc-sdk-btn[data-variant="default"] { color: ${kt}; background: ${v(B,10,V)}; border-color: ${v(B,12)}; ${No} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${v(B,16,V)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${v(B,22,V)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${rr}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${se}; ${Ut} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${M}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${R("status-error","red")}; color: ${It}; background: ${v("var(--oc-sdk-tone)",7,V)}; border-color: ${v("var(--oc-sdk-tone)",12)}; ${No} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${v("var(--oc-sdk-tone)",9,V)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${v("var(--oc-sdk-tone)",11,V)}; box-shadow: none; }

.oc-sdk-field-note { color: ${b}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${It}; }
.oc-sdk-input { border-radius: ${Gt}; background: var(--oc-sdk-field-bg); color: ${se}; ${Mt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${b}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Mt(v(N,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Mt(R("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Pt}; }

.oc-sdk-search-icon { color: ${b}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${B}; }
.oc-sdk-search-clear { border-radius: ${Uo}; color: ${b}; }
.oc-sdk-search-clear:hover { background: ${M}; color: ${N}; }

.oc-sdk-trigger { border-radius: ${Gt}; background: var(--oc-sdk-raised-bg); color: ${se}; ${Ut} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${b}; }
.oc-sdk-trigger-chevron { color: ${b}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${se}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Fe}; background-clip: padding-box; color: ${se}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${M}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${At}; color: ${Ct}; }
.oc-sdk-option-check { color: ${N}; }
.oc-sdk-option[data-destructive="true"] { color: ${It}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${v(R("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${b}; }
.oc-sdk-popup-empty { color: ${b}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${K}; border-radius: 4px; color: ${N}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${v(N,60,K)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${K}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${V}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${B}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${wo} }
.oc-sdk-check-desc { color: ${b}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${v(N,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${b}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${N}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Ct}; background: ${At}; border-color: ${K}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${se}; background: var(--oc-sdk-raised-bg); ${Ut} }
.oc-sdk-tab-count { color: ${b}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${v(N,6)}; color: ${b}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${v("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${At}; color: ${Ct}; }
.oc-sdk-row-lead { font-family: ${Pt}; color: ${b}; }
.oc-sdk-row-sub { color: ${b}; }
.oc-sdk-row-meta { color: ${b}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${b}; }

.oc-sdk-empty-body { color: ${b}; }

.oc-sdk-spinner { color: ${b}; }
.oc-sdk-spinner-ring { border-color: ${K}; border-top-color: ${B}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${v("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${b}; }

.oc-sdk-separator { color: ${b}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${v(K,40)}; }

.oc-sdk-progress-label { color: ${b}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${v(N,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${B}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${R("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${R("success-text","inherit")}; }

.oc-sdk-text a { color: ${kt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${v(K,60)}; }
`,I=`
${Ye}
${ir}
${Do}`;var Ho="oc-sdk-ui-style";var P=(e)=>{let r=document.getElementById(Ho);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ze(document);let s=document.createElement("style");s.id=Ho,s.textContent=e,document.head.appendChild(s)},C=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},X=(e)=>{let r=C("button",e);return r.type="button",r},L=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var ar=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},q=(e,r)=>{P(I);let s=r,l=X("oc-sdk oc-sdk-btn"),p=ar(),_=document.createElement("span");l.append(_),e.append(l);let f=()=>{if(l.dataset.variant=s.variant??"default",l.dataset.size=s.size??"default",l.disabled=Boolean(s.disabled)||Boolean(s.loading),l.dataset.loading=s.loading?"true":"false",l.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&p.parentNode!==l)l.prepend(p);else if(!s.loading&&p.parentNode===l)p.remove();L(_,s.label)},m=()=>{if(s.disabled||s.loading)return;s.onClick()};return l.addEventListener("click",m),f(),{update:(k)=>{s={...s,...k},f()},dispose:()=>{l.removeEventListener("click",m),l.remove()}}};var Nt=(e,r)=>{P(I);let s=r,l=C("div","oc-sdk oc-sdk-empty"),p=C("h2","oc-sdk-empty-title"),_=C("p","oc-sdk-empty-body"),f=C("div","oc-sdk-empty-action");l.append(p,_,f),e.append(l);let m=null,k=()=>{if(L(p,s.title),L(_,s.body),_.hidden=!s.body,f.hidden=!s.action,!s.action){m?.dispose(),m=null;return}let U={label:s.action.label,onClick:s.action.onClick};if(m)m.update(U);else m=q(f,{...U,variant:"outline",size:"sm"})};return k(),{update:(U)=>{s={...s,...U},k()},dispose:()=>{m?.dispose(),m=null,l.remove()}}};var dr=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,Fo=(e)=>e.split(`
`).map((r)=>{let s=dr.exec(r);return s?{kind:"item",prefix:s[1]??"- ",done:s[2]!==" ",text:s[3]??""}:{kind:"text",text:r}}),Bo=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),qe=(e)=>{let r=2166136261;for(let s=0;s<e.length;s+=1)r^=e.charCodeAt(s),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},Vo=(e,r)=>{let s=-1,l="- ";e.forEach((m,k)=>{if(m.kind!=="item")return;s=k,l=m.prefix});let p={kind:"item",prefix:l,done:!1,text:r};if(s>=0)return[...e.slice(0,s+1),p,...e.slice(s+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],p,{kind:"text",text:""}]};var Q=xt(),z=document.querySelector("#root");if(!z)throw Error("Missing root");var $o=document.createElement("style");$o.textContent=`
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
`;document.head.append($o);Q.onReady((e)=>Ot(e,document.documentElement));var W=[],ne=!1,Dt=Ce(null),Ht=()=>Bo(W),We=()=>{Q.reportFileChange(Dt.observe(qe(Ht())))},Lt=()=>{if(z.replaceChildren(),!W.some((r)=>r.kind==="item")&&ne){Nt(z,{title:"No items",body:"This checklist is empty."});return}if(W.forEach((r,s)=>{if(r.kind==="text"){let f=document.createElement("p");f.className="note",f.textContent=r.text,z.append(f);return}let l=document.createElement("div");l.className=r.done?"item done":"item";let p=document.createElement("input");p.type="checkbox",p.checked=r.done,p.disabled=ne,p.addEventListener("change",()=>{r.done=p.checked,l.className=r.done?"item done":"item",We()});let _=document.createElement("input");if(_.type="text",_.value=r.text,_.readOnly=ne,_.setAttribute("aria-label","Item"),_.addEventListener("input",()=>{r.text=_.value,We()}),l.append(p,_),!ne){let f=document.createElement("span");f.className="remove",q(f,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{W=W.filter((m,k)=>k!==s),We(),Lt()}}),l.append(f)}z.append(l)}),ne)return;let e=document.createElement("div");e.className="actions",q(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{W=Vo(W,""),We(),Lt();let r=z.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),z.append(e)};Q.onFileOpen((e)=>{if(e.encoding!=="text"){Q.reportFileUnsupported();return}W=Fo(e.content),ne=e.readOnly,Dt=Ce(qe(Ht())),Lt()});Q.onFileSnapshot(()=>{let e=Ht();return{content:e,version:qe(e)}});Q.onFileSaved((e)=>{Q.reportFileChange({dirty:Dt.markSaved(e),edited:!1})});})();
