(()=>{var E="openchamber.sdk",g=1;var Je=`
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
`;function Qe(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(a)=>{let c=a.target===e?r:a.target;if(!(c instanceof Element))return;if(!c.hasAttribute("data-oc-scrolling"))c.setAttribute("data-oc-scrolling","");let m=s.get(c);if(m!==void 0)clearTimeout(m);s.set(c,setTimeout(()=>{s.delete(c),c.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var jo=`(${Qe.toString()})(document);`;var Ye=128,Ze=65536;var ve=128;var Ae=65536;var et=8000,tt=192000,ot=120000;var Yt=(e)=>{let r=[],s=0,a=0;return{push:(c)=>{r.push(c),a+=c.length;while(a-s>e&&r.length>1){let m=r.shift();a-=m?.length??0,s=0}},pull:(c)=>{let m=0;while(m<c.length&&r.length>0){let T=r[0],_=Math.min(c.length-m,T.length-s);if(c.set(T.subarray(s,s+_),m),m+=_,s+=_,s>=T.length)r.shift(),a-=T.length,s=0}c.fill(0,m)},clear:()=>{r.length=0,s=0,a=0},get size(){return a-s}}};var oo=/^[a-z][a-z0-9-]{0,39}$/;var Zt=(e)=>Object(e)===e&&!Array.isArray(e),rt=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),eo=(e)=>String(e)===e&&e.length>=1&&e.length<=60,to=(e)=>String(e)===e&&e.length>=1&&e.length<=80,ro=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Zt(s)||!oo.test(s.id)||!eo(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!rt(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!rt(s,["kind","id","label","value","options","disabled"]))return!1;if(!to(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let a=new Set;for(let c of s.options){if(!Zt(c)||!rt(c,["value","label"])||!to(c.value)||!eo(c.label)||a.has(c.value))return!1;a.add(c.value)}if(!a.has(s.value))return!1}return!0};var so=["{id}","{segment}","{segments+}"];var xr=new Set(so);var no=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var kr=new Set(no);var Oe=20000000,xe=256;var st=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,io=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var ao=/^[A-Za-z0-9_-]{1,80}$/;var lo=["left","right","top","bottom"];var uo=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let a=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let c of a)if(!uo(c,r+1,s))return!1;return!0},nt=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(nt);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(nt)}return String(e)===e||Number.isFinite(e)},it=(e)=>{try{if(String(e.id)!==e.id||!ao.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!lo.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!uo(e.data)||!nt(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var co=/^[0-9a-f]{7,64}$/i,po=(e)=>co.test(e),at=255,So=(e,r,s)=>({openCommit:(a)=>po(a)?e({channel:E,v:g,type:"open-commit",id:r(),payload:{sha:a}}):s("Commit id must be 7 to 64 hex characters."),openWalkthrough:({base:a})=>{let c=a.trim();if(!c||c.length>at)return s(`Base must contain 1 to ${at} characters.`);return e({channel:E,v:g,type:"open-walkthrough",id:r(),payload:{base:c}})}});var ut=2000;var go=["file","directory","other","missing"],ct=(e)=>Boolean(e&&"sessionId"in e),pt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Ce=500,ke=32000,_o=16000,To=128,mo=200,Ro=2000,fo=16000,ho=80,yo=200,bo=16000;var vo=2000;var dt=20000,Ie=1024,Pe=2000000;var Me=64000,Ge=8000,St=4000;var Et=960000;var Ao=999,Oo=1e4,Se=500,xo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],Co=["stopped","starting","ready","failed"],Jo=new Set(xo),ko=(e)=>Jo.has(e),Io=(e)=>e&&ko(e)?e:"HOST_REJECTED",ee=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ee);if(Object(e)===e)return Object.values(e).every(ee);return!1},Po=(e)=>ee(e)&&JSON.stringify(e).length<=bo,Eo=(e)=>e?.trim().slice(0,yo)??"",te=(e)=>{let r=e.id.trim().slice(0,To),s=e.title.trim().slice(0,mo),a=e.url.trim().slice(0,Ro),c=e.text?.trim().slice(0,fo),m=e.author?.trim().slice(0,ho),T=e.kind==="pull"?"pull":"issue",_={providerId:e.providerId.trim(),id:r,title:s||r,url:a,kind:T};if(c)_.text=c;if(m)_.author=m;if(T==="pull"){let F=Eo(e.branches?.head),X=Eo(e.branches?.base);if(F&&X)_.branches={head:F,base:X}}if(Po(e.data))_.data=e.data;return _},gt=(e)=>{let r=te(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},_t=(e)=>{let r={text:e.text.trim().slice(0,_o)};if(e.send)r.send=!0;return r},Tt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(Ao,Math.max(0,Math.round(e)))},mt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Oo,Math.max(0,Math.ceil(e)))};var oe=(e)=>e.length>0&&e.length<=Ie&&!e.includes("\x00")&&!e.includes("\\");var Ue=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>vo)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Qo=new Set(Co),Rt=(e)=>Boolean(e&&"status"in e&&Qo.has(String(e.status))&&!("body"in e)),we=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),ft=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),ht=(e)=>Boolean(e&&"written"in e&&e.written===!0),yt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Yo=new Set(go),bt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Yo.has(String(e.kind))&&Number.isFinite(e.size)),vt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Zo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late","microphone-audio","microphone-ended"]),er=(e)=>Object(e)===e?e:null,lt=(e)=>String(e)===e&&e.length>0,tr=(e)=>{if(!lt(e.id))return null;if(e.ok===!0){let r={channel:E,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&lt(e.error))return{channel:E,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:Io(lt(e.code)?e.code:void 0)};return null},At=(e)=>{let r=er(e);if(!r||r.channel!==E||r.v!==g)return null;if(r.type==="result")return tr(r);if(!Zo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var Mo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),or=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class u extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Go=()=>Promise.reject(new u("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ne=()=>Promise.reject(new u("BAD_PATH",`File path must be 1 to ${Ie} characters without NUL or backslash.`)),Le=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new u("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},S=(e)=>(e.value+=1,`oc-${e.value}`),Ot=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new u("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),a=e.requestTimeoutMs??dt,c=new Set,m=new Set,T=new Set,_=new Set,F=new Set,X=new Set,ie=new Set,ge=new Set,_e=new Set,Te=new Set,me=new Set,z=new Set,Xe=[],ae=null,le=null,Re=new Set,fe=new Set,ue=null,ce=null,$e=!1,J=new Map,Q=new Map,Y=new Map,L=!1,d={value:0},p=null,B=null,pe=!1,de=!1,Ft=null,U=null,Bt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},M=(t)=>{r.parent.postMessage(t,"*")},Vt=()=>{if(L||r.parent===r||z.size===0||p?.features?.lateGenerateResults!==!0)return;M({channel:E,v:g,type:"generate-late-listen"})},h=(t,o)=>{for(let l of t)try{l(o)}catch(i){console.error(i)}},Wt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=At(t.data);if(!o)return;if(o.type==="workspace"){let i=Q.get(o.payload.subscriptionId);if(i)h([i],o.payload.snapshot);return}if(o.type==="shells"){let i=Y.get(o.payload.subscriptionId);if(i)h([i],o.payload.snapshot);return}if(o.type==="microphone-audio"){U?.queue.push(o.payload.samples);return}if(o.type==="microphone-ended"){let i=U;if(!i)return;U=null,i.release(),h(i.endedListeners,o.payload.reason);return}if(o.type==="ready"){if(p=o.payload,B=Bt(o.payload.session),h(c,o.payload),h(m,o.payload.directory),h(T,o.payload.session),B)h(_,B);if(h(F,o.payload.connection),h(X,o.payload.settings),h(ie,o.payload.item),o.payload.block)h(ge,o.payload.block);Vt();return}if(o.type==="service-event"){h(_e,o.payload);return}if(o.type==="generate-late"){if(z.size===0)Xe.push(o.payload);else h(z,o.payload);return}if(o.type==="directory"){if(p)p={...p,directory:o.payload.directory};h(m,o.payload.directory);return}if(o.type==="session"){if(p)p={...p,session:o.payload.session};if(!o.payload.session)B=null;else if(B?.sessionId!==o.payload.session.id)B=Bt(o.payload.session);h(T,o.payload.session);return}if(o.type==="session-lifecycle"){B=o.payload,h(_,o.payload);return}if(o.type==="connection"){if(p)p={...p,connection:o.payload.connection};h(F,o.payload.connection);return}if(o.type==="settings"){if(p)p={...p,settings:o.payload.settings};h(X,o.payload.settings);return}if(o.type==="item"){if(p)p={...p,item:o.payload.item};h(ie,o.payload.item);return}if(o.type==="status-control-event"){h(Te,o.payload);return}if(o.type==="popover-closed"){h(me,o.payload);return}if(o.type==="action"){let i=(f)=>{if(!L)M({channel:E,v:g,type:"action-result",id:o.id,payload:f})},R=le;if(!R){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>R(o.payload)).then(()=>i({ok:!0}),(f)=>{let y=(f instanceof Error?f.message:String(f)).trim();i({ok:!1,error:(y||"Action failed.").slice(0,Se)})});return}if(o.type==="file-open"){let i=o.payload;if(ce&&io(ce,i))return;ce=i,h(Re,o.payload);return}if(o.type==="file-saved"){h(fe,o.payload.version);return}if(o.type==="file-snapshot"){let i=(y)=>{if(!L)M({channel:E,v:g,type:"file-snapshot-result",id:o.id,payload:y})},R=(y)=>i({error:(y.trim()||"Could not read the edited file.").slice(0,Se)}),f=ue;if(!f){R("This extension does not edit files.");return}Promise.resolve().then(()=>f(o.payload.purpose)).then((y)=>{if(st(y)>Oe){R(`The file is over ${Oe} ${"bytes"in y?"bytes":"characters"}.`);return}if(y.version.length>xe){R(`The snapshot version is over ${xe} characters.`);return}i({snapshot:"bytes"in y?{bytes:y.bytes,version:y.version}:{content:y.content,version:y.version}})},(y)=>R(y instanceof Error?y.message:String(y)));return}if(o.type==="resolve"){let i=(f)=>{M({channel:E,v:g,type:"resolve-result",id:o.id,payload:f})},R=ae;if(!R){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>R(o.payload)).then((f)=>i({item:f?te(f):null}),(f)=>{let y=(f instanceof Error?f.message:String(f)).trim();i({error:(y||"Command failed.").slice(0,Se)})});return}let l=J.get(o.id);if(!l)return;if(clearTimeout(l.timer),J.delete(o.id),o.ok){l.resolve(o.payload);return}l.reject(new u(o.code,o.error))};r.addEventListener("message",Wt),M({channel:E,v:g,type:"hello"});let P=(t,o=a)=>{if(L||r.parent===r)return Promise.reject(new u("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((l,i)=>{let R=setTimeout(()=>{J.delete(t.id),i(new u("HOST_TIMEOUT","Host did not answer in time."))},o);J.set(t.id,{resolve:l,reject:i,timer:R}),M(t)})},x=(t)=>P(t).then(()=>{return}),v={channel:E,v:g},qe=(t)=>{if(!L&&r.parent!==r)M(t)},Xt=()=>qe({...v,type:"file-save"}),Ke=()=>{if(!L&&r.parent!==r)M({...v,type:"microphone-close",id:S(d)})},qo=async()=>{if(U)throw new u("HOST_REJECTED","The microphone is already open in this frame.");if(p?.features?.microphone!==!0)throw new u("UNSUPPORTED","This OpenChamber cannot share the microphone with extensions.");let t=globalThis.AudioContext;if(typeof t!=="function")throw new u("UNSUPPORTED","This frame has no Web Audio.");let o=new t;if(o.sampleRate<et||o.sampleRate>tt)throw o.close().catch(()=>{return}),new u("UNSUPPORTED",`Audio at ${o.sampleRate} Hz is not supported.`);let l=o.state==="suspended"?o.resume().catch(()=>{return}):void 0,i=Yt(Math.round(o.sampleRate/4)),R=o.createScriptProcessor(1024,1,1);R.onaudioprocess=(N)=>i.pull(N.outputBuffer.getChannelData(0));let f=o.createMediaStreamDestination();R.connect(f);let y=new Set,Z={queue:i,endedListeners:y,release:()=>{R.onaudioprocess=null,R.disconnect(),i.clear();for(let N of f.stream.getTracks())N.stop();o.close().catch(()=>{return})}};U=Z;try{let N=await P({...v,type:"microphone-open",id:S(d),payload:{sampleRate:o.sampleRate}},ot);if(!N||!("opened"in N)||N.opened!==!0)throw new u("HOST_REJECTED","Host did not open the microphone.");if(await l,U!==Z)throw new u("DISCONNECTED","The microphone closed while it was opening.")}catch(N){if(U===Z)U=null;throw Z.release(),Ke(),N}return{stream:f.stream,close:()=>{if(U!==Z)return;U=null,Z.release(),Ke()},onEnded:(N)=>(y.add(N),()=>{y.delete(N)})}},$t=(t)=>{if(!Mo(t)||!or(t))return;t.preventDefault(),Xt()},qt=(t)=>{if(!Mo(t)||t.key!=="Escape"||p?.surface!=="popover"||!p.popover)return;t.preventDefault(),Jt(p.popover.id,"escape").catch(()=>{return})},he=()=>{let t=p?.surface==="popover"?p.popover:void 0;if(!t)return;let o=pe||de;if(Ft===o)return;Ft=o,Qt(t.id,o).catch(()=>{return})},ye=()=>{if(p?.surface!=="popover"||pe)return;pe=!0,he()},Kt=(t)=>{if(p?.surface!=="popover"||t.relatedTarget!==null||!pe)return;pe=!1,he()},jt=()=>{if(p?.surface!=="popover"||de)return;de=!0,he()},zt=()=>{if(p?.surface!=="popover"||!de)return;de=!1,he()},D=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new u("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},je=async(t)=>{if(t.kind!=="projects")D(t.projectId);let o=await P({...v,type:"workspace-read",id:S(d),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new u("HOST_REJECTED","Host did not return workspace data.");return o},ze=async(t,o)=>{if(t.kind!=="projects")D(t.projectId);let l=S(d);Q.set(l,o);try{await x({...v,type:"workspace-subscribe",id:S(d),payload:{subscriptionId:l,query:t}})}catch(i){if(Q.delete(l),!L)M({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:l}});throw i}return()=>{if(!Q.delete(l)||L)return;M({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:l}})}},Ko=async(t,o)=>{if(t.kind==="session")D(t.sessionId);if(t.kind==="project")D(t.projectId);let l=S(d);Y.set(l,o);try{await x({...v,type:"shells-subscribe",id:S(d),payload:{subscriptionId:l,scope:t}})}catch(i){if(Y.delete(l),!L)M({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:l}});throw i}return()=>{if(!Y.delete(l)||L)return;M({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:l}})}},be=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ye))throw new u("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ee(t.value))throw new u("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Ze)throw new u("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&p?.features?.deviceStorage!==!0)throw new u("UNSUPPORTED","This host does not support device storage.");let o=await P({...v,type:"storage",id:S(d),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new u("HOST_REJECTED","Host did not return storage data.");return o},Jt=(t,o)=>p?.features?.popovers!==!0&&!(p?.surface==="popover"&&p.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-close",id:S(d),payload:o?{id:t,reason:o}:{id:t}}),Qt=(t,o)=>p?.features?.popovers!==!0&&!(p?.surface==="popover"&&p.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-anchor",id:S(d),payload:{id:t,active:o}});return r.addEventListener("keydown",qt,!0),r.addEventListener("pointerover",ye),r.addEventListener("pointermove",ye),r.addEventListener("pointerout",Kt),r.addEventListener("focus",jt),r.addEventListener("blur",zt),{onAction:(t)=>(le=t,()=>{if(le===t)le=null}),listProjects:async()=>{let t=await je({kind:"projects"});if(t.kind!=="projects")throw new u("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await je({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new u("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await je({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new u("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>ze({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>ze({kind:"worktrees",projectId:t},(l)=>{if(l.kind==="worktrees")o(l)}),onSessions:(t,o)=>ze({kind:"sessions",projectId:t},(l)=>{if(l.kind==="sessions")o(l)}),onRunningShells:(t,o)=>Ko(t,o),readShellOutput:async(t,o)=>{D(t,ve);let l=o?.cursor;if(l!==void 0&&(!Number.isInteger(l)||l<0))throw new u("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>Ae))throw new u("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${Ae}.`);let f=await P({...v,type:"shell-output",id:S(d),payload:{shellId:t,cursor:l,tailBytes:i}});if(!f||typeof f.output!=="string"||!Number.isFinite(f.cursor))throw new u("HOST_REJECTED","Host did not return shell output.");return f},stopShell:async(t)=>{if(D(t,ve),(await P({...v,type:"shell-stop",id:S(d),payload:{shellId:t}}))?.stopped!==!0)throw new u("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{D(t),await x({...v,type:"open-session",id:S(d),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let l=Le(o),i={op:"get",key:t};if(l)i.scope=l;let R=await be(i);return R.op==="get"&&R.found?R.value:void 0},set:async(t,o,l)=>{let i=Le(l),R={op:"set",key:t,value:o};if(i)R.scope=i;await be(R)},delete:async(t,o)=>{let l=Le(o),i={op:"delete",key:t};if(l)i.scope=l;await be(i)},keys:async(t)=>{let o=Le(t),l={op:"keys"};if(o)l.scope=o;let i=await be(l);if(i.op!=="keys")throw new u("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(c.add(t),p)t(p);return()=>{c.delete(t)}},onDirectory:(t)=>{if(m.add(t),p)t(p.directory);return()=>{m.delete(t)}},onSession:(t)=>{if(T.add(t),p)t(p.session);return()=>{T.delete(t)}},onSessionLifecycle:(t)=>{if(_.add(t),B)t(B);return()=>{_.delete(t)}},onConnection:(t)=>{if(F.add(t),p)t(p.connection);return()=>{F.delete(t)}},onSettings:(t)=>{if(X.add(t),p)t(p.settings);return()=>{X.delete(t)}},onItem:(t)=>{if(ie.add(t),p)t(p.item);return()=>{ie.delete(t)}},onBlock:(t)=>{if(ge.add(t),p?.block)t(p.block);return()=>{ge.delete(t)}},onServiceEvent:(t)=>(_e.add(t),()=>{_e.delete(t)}),onStatusControl:(t)=>(Te.add(t),()=>{Te.delete(t)}),onPopoverClosed:(t)=>(me.add(t),()=>{me.delete(t)}),setStatusControls:(t)=>{if(p?.features?.statusControls!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support status controls."));if(!ro(t))return Promise.reject(new u("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...v,type:"status-controls",id:S(d),payload:{controls:t}})},openPopover:(t)=>{if(p?.features?.popovers!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support popovers."));if(!it(t))return Promise.reject(new u("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...v,type:"popover-open",id:S(d),payload:t})},closePopover:Jt,setPopoverAnchorActive:Qt,onResolve:(t)=>(ae=t,()=>{if(ae===t)ae=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Ce)return Promise.reject(new u("HOST_REJECTED",`Toast message must contain 1 to ${Ce} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>ke))return Promise.reject(new u("HOST_REJECTED",`Toast copy text must contain 1 to ${ke} characters.`));return x({channel:E,v:g,type:"toast",id:S(d),payload:{...t,message:o}})},openUrl:(t)=>x({channel:E,v:g,type:"open-url",id:S(d),payload:{url:t}}),...So(x,()=>S(d),(t)=>Promise.reject(new u("HOST_REJECTED",t))),answerBlock:(t)=>x({channel:E,v:g,type:"block-answer",id:S(d),payload:{text:t.trim().slice(0,ut)}}),openSurface:(t)=>x({channel:E,v:g,type:"open-surface",id:S(d),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:E,v:g,type:"clipboard-write",id:S(d),payload:{text:t}}),compose:(t)=>x({channel:E,v:g,type:"compose",id:S(d),payload:t}),attach:(t)=>x({channel:E,v:g,type:"attach",id:S(d),payload:te(t)}),startSession:async(t)=>{if(t.projectId!==void 0)D(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")D(o.directory);else{if(o.name!==void 0)D(o.name,200);if(o.baseBranch!==void 0)D(o.baseBranch,200)}let l=await P({channel:E,v:g,type:"start-session",id:S(d),payload:gt(t)},e.requestTimeoutMs??180000);if(!ct(l))throw new u("HOST_REJECTED","Host did not return a session.");return l},prompt:(t)=>P({channel:E,v:g,type:"prompt",id:S(d),payload:_t(t)}).then((o)=>{if(!pt(o))throw new u("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:E,v:g,type:"session-link",id:S(d),payload:te(t)}),close:()=>x({channel:E,v:g,type:"close",id:S(d)}),oauthStart:()=>x({channel:E,v:g,type:"oauth-start",id:S(d)}),oauthDisconnect:()=>x({channel:E,v:g,type:"oauth-disconnect",id:S(d)}),request:(t)=>(Ue(t.path)?P({channel:E,v:g,type:"request",id:S(d),payload:t}):Go()).then((o)=>{if(!we(o))throw new u("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ue(t.path)?P({channel:E,v:g,type:"service-request",id:S(d),payload:t}):Go()).then((o)=>{if(!we(o))throw new u("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:E,v:g,type:"service-status",id:S(d)}).then((t)=>{if(!Rt(t))throw new u("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(oe(t)?P({channel:E,v:g,type:"file-read",id:S(d),payload:{path:t}}):Ne()).then((o)=>{if(!ft(o))throw new u("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!oe(t))return Ne();if(o.length>Pe)return Promise.reject(new u("FILE_TOO_LARGE",`Content is over ${Pe} characters.`));return P({channel:E,v:g,type:"file-write",id:S(d),payload:{path:t,content:o}}).then((l)=>{if(!ht(l))throw new u("HOST_REJECTED","Host did not confirm the write.");return l})},listDir:(t)=>(oe(t)?P({channel:E,v:g,type:"file-list",id:S(d),payload:{path:t}}):Ne()).then((o)=>{if(!yt(o))throw new u("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(oe(t)?P({channel:E,v:g,type:"file-stat",id:S(d),payload:{path:t}}):Ne()).then((o)=>{if(!bt(o))throw new u("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),l=t.system?.trim();if(o.length===0||o.length>Me)return Promise.reject(new u("HOST_REJECTED",`Prompt must be 1 to ${Me} characters.`));if(l!==void 0&&(l.length===0||l.length>Ge))return Promise.reject(new u("HOST_REJECTED",`System prompt must be 1 to ${Ge} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(St,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new u("HOST_REJECTED","maxOutputTokens must be a number."));let R={prompt:o};if(l!==void 0)R.system=l;if(i!==void 0)R.maxOutputTokens=i;return P({channel:E,v:g,type:"generate",id:S(d),payload:R},e.requestTimeoutMs??Et).then((f)=>{if(!vt(f))throw new u("HOST_REJECTED","Host did not return generated text.");return f})},onLateGenerateResult:(t)=>{z.add(t);for(let o of Xe.splice(0))h([t],o);return Vt(),()=>{z.delete(t)}},openMicrophone:qo,setBadge:(t)=>x({channel:E,v:g,type:"badge",id:S(d),payload:{count:Tt(t)}}),setHeight:(t)=>x({channel:E,v:g,type:"resize",id:S(d),payload:{height:mt(t)}}),onFileOpen:(t)=>{if(Re.add(t),!$e)$e=!0,r.addEventListener("keydown",$t,!0);if(ce)t(ce);return()=>{Re.delete(t)}},onFileSnapshot:(t)=>(ue=t,()=>{if(ue===t)ue=null}),onFileSaved:(t)=>(fe.add(t),()=>{fe.delete(t)}),reportFileChange:(t)=>qe({...v,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Xt,reportFileUnsupported:()=>qe({...v,type:"file-unsupported"}),dispose:()=>{for(let t of Q.keys())M({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:t}});Q.clear();for(let t of Y.keys())M({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:t}});if(Y.clear(),U)Ke(),U.release(),U=null;if(L=!0,ae=null,le=null,ue=null,Re.clear(),fe.clear(),$e)r.removeEventListener("keydown",$t,!0);r.removeEventListener("message",Wt),r.removeEventListener("keydown",qt,!0),r.removeEventListener("pointerover",ye),r.removeEventListener("pointermove",ye),r.removeEventListener("pointerout",Kt),r.removeEventListener("focus",jt),r.removeEventListener("blur",zt);for(let t of J.values())clearTimeout(t.timer),t.reject(new u("HOST_UNAVAILABLE","Host client was disposed."));J.clear(),c.clear(),m.clear(),T.clear(),_.clear(),F.clear(),X.clear(),ie.clear(),ge.clear(),_e.clear(),Te.clear(),me.clear(),z.clear(),Xe.length=0}}};var Uo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var zr=new Set(Uo);var wo=["none","agent","user"];var Qr=new Set(wo);var rr=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],sr=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],No=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,a]of rr)r.style.setProperty(s,e.tokens[a]);for(let[s,a,c]of sr){let m=e.tokens[c]??"";r.style.setProperty(s,m),r.style.setProperty(a,m)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},xt=(e,r)=>{if(No(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var nr={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},b=(e,r)=>`var(--${e}, var(--oc-${nr[e]}, ${r}))`,W=b("surface-background","transparent"),He=b("surface-elevated","transparent"),re=b("surface-elevated-foreground","inherit"),w=b("surface-foreground","inherit"),A=b("surface-muted-foreground","gray"),ir=b("surface-muted","transparent"),K=b("interactive-border","currentColor"),G=b("interactive-hover","transparent"),j=b("interactive-active","transparent"),Ct=b("interactive-selection","transparent"),kt=b("interactive-selection-foreground","inherit"),V=b("primary","currentColor"),It=b("primary-text","inherit"),Pt=b("error-text","inherit"),ar=b("font-sans","inherit"),Mt=b("font-mono","monospace"),Fo=b("radius","9px"),Gt=`calc(${Fo} - 2px)`,Lo=`calc(${Fo} - 4px)`,O=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,Do=`background-image: linear-gradient(${G}, ${G});`,Ut=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,wt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Ho="box-shadow: var(--oc-sdk-lit);",Nt=`inset 0 0.5px 0 0 ${O(w,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,lr=`
:root {
  --oc-sdk-edge: ${O(w,16)};
  --oc-sdk-field-bg: ${He};
  --oc-sdk-raised-bg: ${W};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${O(w,14)};
  --oc-sdk-field-bg: ${O(W,50,He)};
  --oc-sdk-raised-bg: ${He};
  --oc-sdk-field-lift: ${Nt};
  --oc-sdk-raised-lift: ${Nt};
  --oc-sdk-lit: ${Nt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,De=(e)=>{let r=b(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${b(`${e}-text`,"inherit")}; }`},n=(e)=>`calc(${e}rem / 14)`,ur=`
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

/* Under a finger the controls reach the app's touch sizes: rows and options 44px like its sheets, every other
   control at least 36px. Inputs keep 16px text, below which iOS zooms the page on focus. */
@media (pointer: coarse) {
  .oc-sdk-btn, .oc-sdk-input { height: ${n(40)}; }
  .oc-sdk-btn[data-size="sm"], .oc-sdk-btn[data-size="xs"], .oc-sdk-trigger, .oc-sdk-tab, .oc-sdk-popup-search .oc-sdk-input { height: ${n(36)}; }
  .oc-sdk-input, .oc-sdk-popup-search .oc-sdk-input { font-size: max(16px, 0.875rem); }
  .oc-sdk-search-clear { width: ${n(36)}; height: ${n(36)}; right: 0; }
  .oc-sdk-row, .oc-sdk-option { min-height: ${n(44)}; }
  .oc-sdk-check { min-height: ${n(36)}; padding: ${n(8)} 0; }
}
`,Bo=`${lr}
.oc-sdk { color: ${w}; font-family: ${ar}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Do} }
.oc-sdk-mono { font-family: ${Mt}; }
.oc-sdk-muted { color: ${A}; }
${De("success")}${De("warning")}${De("error")}${De("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${V}; --oc-sdk-tone-text: ${It}; }

.oc-sdk-btn { border-radius: ${Gt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Lo}; }
.oc-sdk-btn[data-variant="default"] { color: ${It}; background: ${O(V,10,W)}; border-color: ${O(V,12)}; ${Ho} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${O(V,16,W)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${O(V,22,W)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${ir}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${re}; ${wt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${G}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${b("status-error","red")}; color: ${Pt}; background: ${O("var(--oc-sdk-tone)",7,W)}; border-color: ${O("var(--oc-sdk-tone)",12)}; ${Ho} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${O("var(--oc-sdk-tone)",9,W)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${O("var(--oc-sdk-tone)",11,W)}; box-shadow: none; }

.oc-sdk-field-note { color: ${A}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Pt}; }
.oc-sdk-input { border-radius: ${Gt}; background: var(--oc-sdk-field-bg); color: ${re}; ${Ut("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${A}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Ut(O(w,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Ut(b("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Mt}; }

.oc-sdk-search-icon { color: ${A}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${V}; }
.oc-sdk-search-clear { border-radius: ${Lo}; color: ${A}; }
.oc-sdk-search-clear:hover { background: ${G}; color: ${w}; }

.oc-sdk-trigger { border-radius: ${Gt}; background: var(--oc-sdk-raised-bg); color: ${re}; ${wt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${G}, ${G}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${A}; }
.oc-sdk-trigger-chevron { color: ${A}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${re}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${He}; background-clip: padding-box; color: ${re}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${G}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Ct}; color: ${kt}; }
.oc-sdk-option-check { color: ${w}; }
.oc-sdk-option[data-destructive="true"] { color: ${Pt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${O(b("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${A}; }
.oc-sdk-popup-empty { color: ${A}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${K}; border-radius: 4px; color: ${w}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${O(w,60,K)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${K}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${W}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${V}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Do} }
.oc-sdk-check-desc { color: ${A}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${O(w,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${A}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${w}; }
.oc-sdk-tab[aria-selected="true"] { color: ${kt}; background: ${Ct}; border-color: ${K}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${re}; background: var(--oc-sdk-raised-bg); ${wt} }
.oc-sdk-tab-count { color: ${A}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${O(w,6)}; color: ${A}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${O("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${G}; }
.oc-sdk-row[aria-selected="true"] { background: ${Ct}; color: ${kt}; }
.oc-sdk-row-lead { font-family: ${Mt}; color: ${A}; }
.oc-sdk-row-sub { color: ${A}; }
.oc-sdk-row-meta { color: ${A}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${A}; }

.oc-sdk-empty-body { color: ${A}; }

.oc-sdk-spinner { color: ${A}; }
.oc-sdk-spinner-ring { border-color: ${K}; border-top-color: ${V}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${O("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${A}; }

.oc-sdk-separator { color: ${A}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${O(K,40)}; }

.oc-sdk-progress-label { color: ${A}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${O(w,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${V}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${b("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${b("success-text","inherit")}; }

.oc-sdk-text a { color: ${It}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${O(K,60)}; }
`,k=`
${Je}
${ur}
${Bo}`;var Vo="oc-sdk-ui-style",se=(e)=>{while(e.firstChild)e.removeChild(e.firstChild)},I=(e)=>{let r=document.getElementById(Vo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Qe(document);let s=document.createElement("style");s.id=Vo,s.textContent=e,document.head.appendChild(s)},C=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},q=(e)=>{let r=C("button",e);return r.type="button",r},H=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var cr=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},ne=(e,r)=>{I(k);let s=r,a=q("oc-sdk oc-sdk-btn"),c=cr(),m=document.createElement("span");a.append(m),e.append(a);let T=()=>{if(a.dataset.variant=s.variant??"default",a.dataset.size=s.size??"default",a.disabled=Boolean(s.disabled)||Boolean(s.loading),a.dataset.loading=s.loading?"true":"false",a.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&c.parentNode!==a)a.prepend(c);else if(!s.loading&&c.parentNode===a)c.remove();H(m,s.label)},_=()=>{if(s.disabled||s.loading)return;s.onClick()};return a.addEventListener("click",_),T(),{update:(F)=>{s={...s,...F},T()},dispose:()=>{a.removeEventListener("click",_),a.remove()}}};var gr=/(!?)\[([^[\]]*)\]\((https?:\/\/[^()\s]+)\)/g,_r=(e)=>{try{let r=new URL(e);return r.protocol==="http:"||r.protocol==="https:"}catch{return!1}},Wo=(e)=>{let r=[],s=0;for(let a of e.matchAll(gr)){let c=a.index??0;if(c>s)r.push({kind:"text",text:e.slice(s,c)});let m=a[1]??"",T=(a[2]??"").trim(),_=a[3]??"";if(!_r(_))r.push({kind:"text",text:a[0]});else if(m==="!")r.push({kind:"image",src:_,alt:T});else r.push({kind:"link",href:_,label:T||_});s=c+a[0].length}if(s<e.length)r.push({kind:"text",text:e.slice(s)});return r},Lt=(e,r)=>{I(k);let s=r,a=C("div","oc-sdk oc-sdk-text");e.append(a);let c=(T)=>{if(!(T.target instanceof HTMLAnchorElement)||!s.onOpenUrl)return;T.preventDefault(),s.onOpenUrl(T.target.href)},m=()=>{se(a);for(let T of Wo(s.text))if(T.kind==="text")a.append(document.createTextNode(T.text));else if(T.kind==="link"){let _=C("a");_.href=T.href,_.rel="noopener noreferrer",_.target="_blank",_.textContent=T.label,a.append(_)}else{let _=C("img");_.src=T.src,_.alt=T.alt,_.loading="lazy",_.referrerPolicy="no-referrer",a.append(_)}};return a.addEventListener("click",c),m(),{update:(T)=>{s={...s,...T},m()},dispose:()=>{a.removeEventListener("click",c),a.remove()}}};var Dt=Ot(),We=document.querySelector("#root");if(!We)throw Error("Agent Desk: missing root");var $o=document.createElement("div"),Ht=(e)=>{let r=document.createElement("div");r.textContent=e,$o.prepend(r)},Xo=!1;Dt.onReady((e)=>{if(xt(e,document.documentElement),Xo)return;Xo=!0,Lt(We,{text:"Agent Desk"}),ne(We,{label:"Start a session",onClick:()=>{Dt.serviceRequest({method:"POST",path:"/start",body:JSON.stringify({directory:e.directory})}).then((r)=>Ht(r.body)).catch(()=>Ht("The service did not answer."))}}),We.append($o)});Dt.onServiceEvent(({topic:e,data:r})=>Ht(`${e}: ${JSON.stringify(r)}`));})();
