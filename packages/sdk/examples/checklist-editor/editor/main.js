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
`;function Ze(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(l)=>{let p=l.target===e?r:l.target;if(!(p instanceof Element))return;if(!p.hasAttribute("data-oc-scrolling"))p.setAttribute("data-oc-scrolling","");let _=s.get(p);if(_!==void 0)clearTimeout(_);s.set(p,setTimeout(()=>{s.delete(p),p.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var $o=`(${Ze.toString()})(document);`;var et=128,tt=65536;var ve=128;var xe=65536;var to=/^[a-z][a-z0-9-]{0,39}$/;var Yt=(e)=>Object(e)===e&&!Array.isArray(e),ot=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Zt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,eo=(e)=>String(e)===e&&e.length>=1&&e.length<=80,oo=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Yt(s)||!to.test(s.id)||!Zt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!ot(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!ot(s,["kind","id","label","value","options","disabled"]))return!1;if(!eo(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let l=new Set;for(let p of s.options){if(!Yt(p)||!ot(p,["value","label"])||!eo(p.value)||!Zt(p.label)||l.has(p.value))return!1;l.add(p.value)}if(!l.has(s.value))return!1}return!0};var ro=["{id}","{segment}","{segments+}"];var hr=new Set(ro);var so=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var vr=new Set(so);var Ae=20000000,Oe=256;var rt=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,no=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0},Ce=(e)=>{let r=e,s=e;return{observe:(l)=>{let p=l!==s;return s=l,{edited:p,dirty:l!==r}},markSaved:(l)=>(r=l,s!==l)}};var io=/^[A-Za-z0-9_-]{1,80}$/;var ao=["left","right","top","bottom"];var lo=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let l=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let p of l)if(!lo(p,r+1,s))return!1;return!0},st=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(st);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(st)}return String(e)===e||Number.isFinite(e)},nt=(e)=>{try{if(String(e.id)!==e.id||!io.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!ao.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!lo(e.data)||!st(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var at=2000;var co=["file","directory","other","missing"],lt=(e)=>Boolean(e&&"sessionId"in e),ut=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var po=/^[0-9a-f]{7,64}$/i,ct=(e)=>po.test(e),ke=500,Ie=32000,So=16000,Eo=128,go=200,_o=2000,To=16000,mo=80,Ro=200,fo=16000;var yo=2000;var pt=20000,Pe=1024,Ge=2000000;var Me=64000,Ue=8000,dt=4000;var St=960000;var ho=999,bo=1e4,Se=500,vo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],xo=["stopped","starting","ready","failed"],Ko=new Set(vo),Ao=(e)=>Ko.has(e),Oo=(e)=>e&&Ao(e)?e:"HOST_REJECTED",te=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(te);if(Object(e)===e)return Object.values(e).every(te);return!1},Co=(e)=>te(e)&&JSON.stringify(e).length<=fo,uo=(e)=>e?.trim().slice(0,Ro)??"",oe=(e)=>{let r=e.id.trim().slice(0,Eo),s=e.title.trim().slice(0,go),l=e.url.trim().slice(0,_o),p=e.text?.trim().slice(0,To),_=e.author?.trim().slice(0,mo),R=e.kind==="pull"?"pull":"issue",T={providerId:e.providerId.trim(),id:r,title:s||r,url:l,kind:R};if(p)T.text=p;if(_)T.author=_;if(R==="pull"){let k=uo(e.branches?.head),U=uo(e.branches?.base);if(k&&U)T.branches={head:k,base:U}}if(Co(e.data))T.data=e.data;return T},Et=(e)=>{let r=oe(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},gt=(e)=>{let r={text:e.text.trim().slice(0,So)};if(e.send)r.send=!0;return r},_t=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(ho,Math.max(0,Math.round(e)))},Tt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(bo,Math.max(0,Math.ceil(e)))};var re=(e)=>e.length>0&&e.length<=Pe&&!e.includes("\x00")&&!e.includes("\\");var we=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>yo)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},jo=new Set(xo),mt=(e)=>Boolean(e&&"status"in e&&jo.has(String(e.status))&&!("body"in e)),Ne=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),Rt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),ft=(e)=>Boolean(e&&"written"in e&&e.written===!0),yt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),zo=new Set(co),ht=(e)=>Boolean(e&&"kind"in e&&"size"in e&&zo.has(String(e.kind))&&Number.isFinite(e.size)),bt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Jo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Qo=(e)=>Object(e)===e?e:null,it=(e)=>String(e)===e&&e.length>0,Yo=(e)=>{if(!it(e.id))return null;if(e.ok===!0){let r={channel:E,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&it(e.error))return{channel:E,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:Oo(it(e.code)?e.code:void 0)};return null},vt=(e)=>{let r=Qo(e);if(!r||r.channel!==E||r.v!==g)return null;if(r.type==="result")return Yo(r);if(!Jo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var ko=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Zo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class c extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Io=()=>Promise.reject(new c("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Le=()=>Promise.reject(new c("BAD_PATH",`File path must be 1 to ${Pe} characters without NUL or backslash.`)),De=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new c("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},S=(e)=>(e.value+=1,`oc-${e.value}`),xt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new c("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),l=e.requestTimeoutMs??pt,p=new Set,_=new Set,R=new Set,T=new Set,k=new Set,U=new Set,ie=new Set,ge=new Set,_e=new Set,Te=new Set,me=new Set,Q=new Set,Ke=[],ae=null,le=null,Re=new Set,fe=new Set,ue=null,ce=null,je=!1,Y=new Map,Z=new Map,ee=new Map,H=!1,d={value:0},u=null,F=null,pe=!1,de=!1,Ft=null,Bt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},Vt=()=>{if(H||r.parent===r||Q.size===0||u?.features?.lateGenerateResults!==!0)return;w({channel:E,v:g,type:"generate-late-listen"})},h=(t,o)=>{for(let i of t)try{i(o)}catch(a){console.error(a)}},Wt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=vt(t.data);if(!o)return;if(o.type==="workspace"){let a=Z.get(o.payload.subscriptionId);if(a)h([a],o.payload.snapshot);return}if(o.type==="shells"){let a=ee.get(o.payload.subscriptionId);if(a)h([a],o.payload.snapshot);return}if(o.type==="ready"){if(u=o.payload,F=Bt(o.payload.session),h(p,o.payload),h(_,o.payload.directory),h(R,o.payload.session),F)h(T,F);if(h(k,o.payload.connection),h(U,o.payload.settings),h(ie,o.payload.item),o.payload.block)h(ge,o.payload.block);Vt();return}if(o.type==="service-event"){h(_e,o.payload);return}if(o.type==="generate-late"){if(Q.size===0)Ke.push(o.payload);else h(Q,o.payload);return}if(o.type==="directory"){if(u)u={...u,directory:o.payload.directory};h(_,o.payload.directory);return}if(o.type==="session"){if(u)u={...u,session:o.payload.session};if(!o.payload.session)F=null;else if(F?.sessionId!==o.payload.session.id)F=Bt(o.payload.session);h(R,o.payload.session);return}if(o.type==="session-lifecycle"){F=o.payload,h(T,o.payload);return}if(o.type==="connection"){if(u)u={...u,connection:o.payload.connection};h(k,o.payload.connection);return}if(o.type==="settings"){if(u)u={...u,settings:o.payload.settings};h(U,o.payload.settings);return}if(o.type==="item"){if(u)u={...u,item:o.payload.item};h(ie,o.payload.item);return}if(o.type==="status-control-event"){h(Te,o.payload);return}if(o.type==="popover-closed"){h(me,o.payload);return}if(o.type==="action"){let a=(m)=>{if(!H)w({channel:E,v:g,type:"action-result",id:o.id,payload:m})},f=le;if(!f){a({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>f(o.payload)).then(()=>a({ok:!0}),(m)=>{let O=(m instanceof Error?m.message:String(m)).trim();a({ok:!1,error:(O||"Action failed.").slice(0,Se)})});return}if(o.type==="file-open"){let a=o.payload;if(ce&&no(ce,a))return;ce=a,h(Re,o.payload);return}if(o.type==="file-saved"){h(fe,o.payload.version);return}if(o.type==="file-snapshot"){let a=(O)=>{if(!H)w({channel:E,v:g,type:"file-snapshot-result",id:o.id,payload:O})},f=(O)=>a({error:(O.trim()||"Could not read the edited file.").slice(0,Se)}),m=ue;if(!m){f("This extension does not edit files.");return}Promise.resolve().then(()=>m(o.payload.purpose)).then((O)=>{if(rt(O)>Ae){f(`The file is over ${Ae} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>Oe){f(`The snapshot version is over ${Oe} characters.`);return}a({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>f(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let a=(m)=>{w({channel:E,v:g,type:"resolve-result",id:o.id,payload:m})},f=ae;if(!f){a({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>f(o.payload)).then((m)=>a({item:m?oe(m):null}),(m)=>{let O=(m instanceof Error?m.message:String(m)).trim();a({error:(O||"Command failed.").slice(0,Se)})});return}let i=Y.get(o.id);if(!i)return;if(clearTimeout(i.timer),Y.delete(o.id),o.ok){i.resolve(o.payload);return}i.reject(new c(o.code,o.error))};r.addEventListener("message",Wt),w({channel:E,v:g,type:"hello"});let G=(t,o=l)=>{if(H||r.parent===r)return Promise.reject(new c("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((i,a)=>{let f=setTimeout(()=>{Y.delete(t.id),a(new c("HOST_TIMEOUT","Host did not answer in time."))},o);Y.set(t.id,{resolve:i,reject:a,timer:f}),w(t)})},x=(t)=>G(t).then(()=>{return}),A={channel:E,v:g},ze=(t)=>{if(!H&&r.parent!==r)w(t)},Xt=()=>ze({...A,type:"file-save"}),$t=(t)=>{if(!ko(t)||!Zo(t))return;t.preventDefault(),Xt()},qt=(t)=>{if(!ko(t)||t.key!=="Escape"||u?.surface!=="popover"||!u.popover)return;t.preventDefault(),Jt(u.popover.id,"escape").catch(()=>{return})},ye=()=>{let t=u?.surface==="popover"?u.popover:void 0;if(!t)return;let o=pe||de;if(Ft===o)return;Ft=o,Qt(t.id,o).catch(()=>{return})},he=()=>{if(u?.surface!=="popover"||pe)return;pe=!0,ye()},Kt=(t)=>{if(u?.surface!=="popover"||t.relatedTarget!==null||!pe)return;pe=!1,ye()},jt=()=>{if(u?.surface!=="popover"||de)return;de=!0,ye()},zt=()=>{if(u?.surface!=="popover"||!de)return;de=!1,ye()},D=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new c("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Je=async(t)=>{if(t.kind!=="projects")D(t.projectId);let o=await G({...A,type:"workspace-read",id:S(d),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new c("HOST_REJECTED","Host did not return workspace data.");return o},Qe=async(t,o)=>{if(t.kind!=="projects")D(t.projectId);let i=S(d);Z.set(i,o);try{await x({...A,type:"workspace-subscribe",id:S(d),payload:{subscriptionId:i,query:t}})}catch(a){if(Z.delete(i),!H)w({...A,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:i}});throw a}return()=>{if(!Z.delete(i)||H)return;w({...A,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:i}})}},Xo=async(t,o)=>{if(t.kind==="session")D(t.sessionId);if(t.kind==="project")D(t.projectId);let i=S(d);ee.set(i,o);try{await x({...A,type:"shells-subscribe",id:S(d),payload:{subscriptionId:i,scope:t}})}catch(a){if(ee.delete(i),!H)w({...A,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:i}});throw a}return()=>{if(!ee.delete(i)||H)return;w({...A,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:i}})}},be=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>et))throw new c("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!te(t.value))throw new c("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>tt)throw new c("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&u?.features?.deviceStorage!==!0)throw new c("UNSUPPORTED","This host does not support device storage.");let o=await G({...A,type:"storage",id:S(d),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new c("HOST_REJECTED","Host did not return storage data.");return o},Jt=(t,o)=>u?.features?.popovers!==!0&&!(u?.surface==="popover"&&u.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):x({...A,type:"popover-close",id:S(d),payload:o?{id:t,reason:o}:{id:t}}),Qt=(t,o)=>u?.features?.popovers!==!0&&!(u?.surface==="popover"&&u.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):x({...A,type:"popover-anchor",id:S(d),payload:{id:t,active:o}});return r.addEventListener("keydown",qt,!0),r.addEventListener("pointerover",he),r.addEventListener("pointermove",he),r.addEventListener("pointerout",Kt),r.addEventListener("focus",jt),r.addEventListener("blur",zt),{onAction:(t)=>(le=t,()=>{if(le===t)le=null}),listProjects:async()=>{let t=await Je({kind:"projects"});if(t.kind!=="projects")throw new c("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Je({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new c("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Je({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new c("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Qe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Qe({kind:"worktrees",projectId:t},(i)=>{if(i.kind==="worktrees")o(i)}),onSessions:(t,o)=>Qe({kind:"sessions",projectId:t},(i)=>{if(i.kind==="sessions")o(i)}),onRunningShells:(t,o)=>Xo(t,o),readShellOutput:async(t,o)=>{D(t,ve);let i=o?.cursor;if(i!==void 0&&(!Number.isInteger(i)||i<0))throw new c("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let a=o?.tailBytes;if(a!==void 0&&(!Number.isInteger(a)||a<1||a>xe))throw new c("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${xe}.`);let m=await G({...A,type:"shell-output",id:S(d),payload:{shellId:t,cursor:i,tailBytes:a}});if(!m||typeof m.output!=="string"||!Number.isFinite(m.cursor))throw new c("HOST_REJECTED","Host did not return shell output.");return m},stopShell:async(t)=>{if(D(t,ve),(await G({...A,type:"shell-stop",id:S(d),payload:{shellId:t}}))?.stopped!==!0)throw new c("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{D(t),await x({...A,type:"open-session",id:S(d),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let i=De(o),a={op:"get",key:t};if(i)a.scope=i;let f=await be(a);return f.op==="get"&&f.found?f.value:void 0},set:async(t,o,i)=>{let a=De(i),f={op:"set",key:t,value:o};if(a)f.scope=a;await be(f)},delete:async(t,o)=>{let i=De(o),a={op:"delete",key:t};if(i)a.scope=i;await be(a)},keys:async(t)=>{let o=De(t),i={op:"keys"};if(o)i.scope=o;let a=await be(i);if(a.op!=="keys")throw new c("HOST_REJECTED","Expected storage keys.");return a.keys}},onReady:(t)=>{if(p.add(t),u)t(u);return()=>{p.delete(t)}},onDirectory:(t)=>{if(_.add(t),u)t(u.directory);return()=>{_.delete(t)}},onSession:(t)=>{if(R.add(t),u)t(u.session);return()=>{R.delete(t)}},onSessionLifecycle:(t)=>{if(T.add(t),F)t(F);return()=>{T.delete(t)}},onConnection:(t)=>{if(k.add(t),u)t(u.connection);return()=>{k.delete(t)}},onSettings:(t)=>{if(U.add(t),u)t(u.settings);return()=>{U.delete(t)}},onItem:(t)=>{if(ie.add(t),u)t(u.item);return()=>{ie.delete(t)}},onBlock:(t)=>{if(ge.add(t),u?.block)t(u.block);return()=>{ge.delete(t)}},onServiceEvent:(t)=>(_e.add(t),()=>{_e.delete(t)}),onStatusControl:(t)=>(Te.add(t),()=>{Te.delete(t)}),onPopoverClosed:(t)=>(me.add(t),()=>{me.delete(t)}),setStatusControls:(t)=>{if(u?.features?.statusControls!==!0)return Promise.reject(new c("UNSUPPORTED","This host does not support status controls."));if(!oo(t))return Promise.reject(new c("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...A,type:"status-controls",id:S(d),payload:{controls:t}})},openPopover:(t)=>{if(u?.features?.popovers!==!0)return Promise.reject(new c("UNSUPPORTED","This host does not support popovers."));if(!nt(t))return Promise.reject(new c("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...A,type:"popover-open",id:S(d),payload:t})},closePopover:Jt,setPopoverAnchorActive:Qt,onResolve:(t)=>(ae=t,()=>{if(ae===t)ae=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>ke)return Promise.reject(new c("HOST_REJECTED",`Toast message must contain 1 to ${ke} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Ie))return Promise.reject(new c("HOST_REJECTED",`Toast copy text must contain 1 to ${Ie} characters.`));return x({channel:E,v:g,type:"toast",id:S(d),payload:{...t,message:o}})},openUrl:(t)=>x({channel:E,v:g,type:"open-url",id:S(d),payload:{url:t}}),openCommit:(t)=>ct(t)?x({channel:E,v:g,type:"open-commit",id:S(d),payload:{sha:t}}):Promise.reject(new c("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>x({channel:E,v:g,type:"block-answer",id:S(d),payload:{text:t.trim().slice(0,at)}}),openSurface:(t)=>x({channel:E,v:g,type:"open-surface",id:S(d),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:E,v:g,type:"clipboard-write",id:S(d),payload:{text:t}}),compose:(t)=>x({channel:E,v:g,type:"compose",id:S(d),payload:t}),attach:(t)=>x({channel:E,v:g,type:"attach",id:S(d),payload:oe(t)}),startSession:async(t)=>{if(t.projectId!==void 0)D(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")D(o.directory);else{if(o.name!==void 0)D(o.name,200);if(o.baseBranch!==void 0)D(o.baseBranch,200)}let i=await G({channel:E,v:g,type:"start-session",id:S(d),payload:Et(t)},e.requestTimeoutMs??180000);if(!lt(i))throw new c("HOST_REJECTED","Host did not return a session.");return i},prompt:(t)=>G({channel:E,v:g,type:"prompt",id:S(d),payload:gt(t)}).then((o)=>{if(!ut(o))throw new c("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:E,v:g,type:"session-link",id:S(d),payload:oe(t)}),close:()=>x({channel:E,v:g,type:"close",id:S(d)}),oauthStart:()=>x({channel:E,v:g,type:"oauth-start",id:S(d)}),oauthDisconnect:()=>x({channel:E,v:g,type:"oauth-disconnect",id:S(d)}),request:(t)=>(we(t.path)?G({channel:E,v:g,type:"request",id:S(d),payload:t}):Io()).then((o)=>{if(!Ne(o))throw new c("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(we(t.path)?G({channel:E,v:g,type:"service-request",id:S(d),payload:t}):Io()).then((o)=>{if(!Ne(o))throw new c("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>G({channel:E,v:g,type:"service-status",id:S(d)}).then((t)=>{if(!mt(t))throw new c("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(re(t)?G({channel:E,v:g,type:"file-read",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!Rt(o))throw new c("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!re(t))return Le();if(o.length>Ge)return Promise.reject(new c("FILE_TOO_LARGE",`Content is over ${Ge} characters.`));return G({channel:E,v:g,type:"file-write",id:S(d),payload:{path:t,content:o}}).then((i)=>{if(!ft(i))throw new c("HOST_REJECTED","Host did not confirm the write.");return i})},listDir:(t)=>(re(t)?G({channel:E,v:g,type:"file-list",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!yt(o))throw new c("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(re(t)?G({channel:E,v:g,type:"file-stat",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!ht(o))throw new c("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),i=t.system?.trim();if(o.length===0||o.length>Me)return Promise.reject(new c("HOST_REJECTED",`Prompt must be 1 to ${Me} characters.`));if(i!==void 0&&(i.length===0||i.length>Ue))return Promise.reject(new c("HOST_REJECTED",`System prompt must be 1 to ${Ue} characters.`));let a=t.maxOutputTokens===void 0?void 0:Math.min(dt,Math.max(1,Math.floor(t.maxOutputTokens)));if(a!==void 0&&!Number.isFinite(a))return Promise.reject(new c("HOST_REJECTED","maxOutputTokens must be a number."));let f={prompt:o};if(i!==void 0)f.system=i;if(a!==void 0)f.maxOutputTokens=a;return G({channel:E,v:g,type:"generate",id:S(d),payload:f},e.requestTimeoutMs??St).then((m)=>{if(!bt(m))throw new c("HOST_REJECTED","Host did not return generated text.");return m})},onLateGenerateResult:(t)=>{Q.add(t);for(let o of Ke.splice(0))h([t],o);return Vt(),()=>{Q.delete(t)}},setBadge:(t)=>x({channel:E,v:g,type:"badge",id:S(d),payload:{count:_t(t)}}),setHeight:(t)=>x({channel:E,v:g,type:"resize",id:S(d),payload:{height:Tt(t)}}),onFileOpen:(t)=>{if(Re.add(t),!je)je=!0,r.addEventListener("keydown",$t,!0);if(ce)t(ce);return()=>{Re.delete(t)}},onFileSnapshot:(t)=>(ue=t,()=>{if(ue===t)ue=null}),onFileSaved:(t)=>(fe.add(t),()=>{fe.delete(t)}),reportFileChange:(t)=>ze({...A,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Xt,reportFileUnsupported:()=>ze({...A,type:"file-unsupported"}),dispose:()=>{for(let t of Z.keys())w({...A,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:t}});Z.clear();for(let t of ee.keys())w({...A,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:t}});if(ee.clear(),H=!0,ae=null,le=null,ue=null,Re.clear(),fe.clear(),je)r.removeEventListener("keydown",$t,!0);r.removeEventListener("message",Wt),r.removeEventListener("keydown",qt,!0),r.removeEventListener("pointerover",he),r.removeEventListener("pointermove",he),r.removeEventListener("pointerout",Kt),r.removeEventListener("focus",jt),r.removeEventListener("blur",zt);for(let t of Y.values())clearTimeout(t.timer),t.reject(new c("HOST_UNAVAILABLE","Host client was disposed."));Y.clear(),p.clear(),_.clear(),R.clear(),T.clear(),k.clear(),U.clear(),ie.clear(),ge.clear(),_e.clear(),Te.clear(),me.clear(),Q.clear(),Ke.length=0}}};var Po=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Fr=new Set(Po);var Go=["none","agent","user"];var Vr=new Set(Go);var er=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],tr=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Mo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,l]of er)r.style.setProperty(s,e.tokens[l]);for(let[s,l,p]of tr){let _=e.tokens[p]??"";r.style.setProperty(s,_),r.style.setProperty(l,_)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},At=(e,r)=>{if(Mo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var or={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${or[e]}, ${r}))`,V=y("surface-background","transparent"),Fe=y("surface-elevated","transparent"),se=y("surface-elevated-foreground","inherit"),N=y("surface-foreground","inherit"),b=y("surface-muted-foreground","gray"),rr=y("surface-muted","transparent"),K=y("interactive-border","currentColor"),M=y("interactive-hover","transparent"),j=y("interactive-active","transparent"),Ot=y("interactive-selection","transparent"),Ct=y("interactive-selection-foreground","inherit"),B=y("primary","currentColor"),kt=y("primary-text","inherit"),It=y("error-text","inherit"),sr=y("font-sans","inherit"),Pt=y("font-mono","monospace"),Lo=y("radius","9px"),Gt=`calc(${Lo} - 2px)`,Uo=`calc(${Lo} - 4px)`,v=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,wo=`background-image: linear-gradient(${M}, ${M});`,Mt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Ut="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",No="box-shadow: var(--oc-sdk-lit);",wt=`inset 0 0.5px 0 0 ${v(N,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,nr=`
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
}`,He=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},n=(e)=>`calc(${e}rem / 14)`,ir=`
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
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${It}; background: ${v("var(--oc-sdk-tone)",7,V)}; border-color: ${v("var(--oc-sdk-tone)",12)}; ${No} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${v("var(--oc-sdk-tone)",9,V)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${v("var(--oc-sdk-tone)",11,V)}; box-shadow: none; }

.oc-sdk-field-note { color: ${b}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${It}; }
.oc-sdk-input { border-radius: ${Gt}; background: var(--oc-sdk-field-bg); color: ${se}; ${Mt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${b}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Mt(v(N,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Mt(y("status-error","red"),"1px")} }
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
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Ot}; color: ${Ct}; }
.oc-sdk-option-check { color: ${N}; }
.oc-sdk-option[data-destructive="true"] { color: ${It}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${v(y("status-error","red"),10)}; }
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
.oc-sdk-tab[aria-selected="true"] { color: ${Ct}; background: ${Ot}; border-color: ${K}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${se}; background: var(--oc-sdk-raised-bg); ${Ut} }
.oc-sdk-tab-count { color: ${b}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${v(N,6)}; color: ${b}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${v("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${Ot}; color: ${Ct}; }
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
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${y("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${y("success-text","inherit")}; }

.oc-sdk-text a { color: ${kt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${v(K,60)}; }
`,I=`
${Ye}
${ir}
${Do}`;var Ho="oc-sdk-ui-style";var P=(e)=>{let r=document.getElementById(Ho);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ze(document);let s=document.createElement("style");s.id=Ho,s.textContent=e,document.head.appendChild(s)},C=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},W=(e)=>{let r=C("button",e);return r.type="button",r},L=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var ar=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},X=(e,r)=>{P(I);let s=r,l=W("oc-sdk oc-sdk-btn"),p=ar(),_=document.createElement("span");l.append(_),e.append(l);let R=()=>{if(l.dataset.variant=s.variant??"default",l.dataset.size=s.size??"default",l.disabled=Boolean(s.disabled)||Boolean(s.loading),l.dataset.loading=s.loading?"true":"false",l.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&p.parentNode!==l)l.prepend(p);else if(!s.loading&&p.parentNode===l)p.remove();L(_,s.label)},T=()=>{if(s.disabled||s.loading)return;s.onClick()};return l.addEventListener("click",T),R(),{update:(k)=>{s={...s,...k},R()},dispose:()=>{l.removeEventListener("click",T),l.remove()}}};var Nt=(e,r)=>{P(I);let s=r,l=C("div","oc-sdk oc-sdk-empty"),p=C("h2","oc-sdk-empty-title"),_=C("p","oc-sdk-empty-body"),R=C("div","oc-sdk-empty-action");l.append(p,_,R),e.append(l);let T=null,k=()=>{if(L(p,s.title),L(_,s.body),_.hidden=!s.body,R.hidden=!s.action,!s.action){T?.dispose(),T=null;return}let U={label:s.action.label,onClick:s.action.onClick};if(T)T.update(U);else T=X(R,{...U,variant:"outline",size:"sm"})};return k(),{update:(U)=>{s={...s,...U},k()},dispose:()=>{T?.dispose(),T=null,l.remove()}}};var dr=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,Fo=(e)=>e.split(`
`).map((r)=>{let s=dr.exec(r);return s?{kind:"item",prefix:s[1]??"- ",done:s[2]!==" ",text:s[3]??""}:{kind:"text",text:r}}),Bo=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),$e=(e)=>{let r=2166136261;for(let s=0;s<e.length;s+=1)r^=e.charCodeAt(s),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},Vo=(e,r)=>{let s=-1,l="- ";e.forEach((T,k)=>{if(T.kind!=="item")return;s=k,l=T.prefix});let p={kind:"item",prefix:l,done:!1,text:r};if(s>=0)return[...e.slice(0,s+1),p,...e.slice(s+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],p,{kind:"text",text:""}]};var J=xt(),z=document.querySelector("#root");if(!z)throw Error("Missing root");var Wo=document.createElement("style");Wo.textContent=`
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
`;document.head.append(Wo);J.onReady((e)=>At(e,document.documentElement));var q=[],ne=!1,Dt=Ce(null),Ht=()=>Bo(q),qe=()=>{J.reportFileChange(Dt.observe($e(Ht())))},Lt=()=>{if(z.replaceChildren(),!q.some((r)=>r.kind==="item")&&ne){Nt(z,{title:"No items",body:"This checklist is empty."});return}if(q.forEach((r,s)=>{if(r.kind==="text"){let R=document.createElement("p");R.className="note",R.textContent=r.text,z.append(R);return}let l=document.createElement("div");l.className=r.done?"item done":"item";let p=document.createElement("input");p.type="checkbox",p.checked=r.done,p.disabled=ne,p.addEventListener("change",()=>{r.done=p.checked,l.className=r.done?"item done":"item",qe()});let _=document.createElement("input");if(_.type="text",_.value=r.text,_.readOnly=ne,_.setAttribute("aria-label","Item"),_.addEventListener("input",()=>{r.text=_.value,qe()}),l.append(p,_),!ne){let R=document.createElement("span");R.className="remove",X(R,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{q=q.filter((T,k)=>k!==s),qe(),Lt()}}),l.append(R)}z.append(l)}),ne)return;let e=document.createElement("div");e.className="actions",X(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{q=Vo(q,""),qe(),Lt();let r=z.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),z.append(e)};J.onFileOpen((e)=>{if(e.encoding!=="text"){J.reportFileUnsupported();return}q=Fo(e.content),ne=e.readOnly,Dt=Ce($e(Ht())),Lt()});J.onFileSnapshot(()=>{let e=Ht();return{content:e,version:$e(e)}});J.onFileSaved((e)=>{J.reportFileChange({dirty:Dt.markSaved(e),edited:!1})});})();
