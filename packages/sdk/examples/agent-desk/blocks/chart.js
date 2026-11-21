(()=>{var E="openchamber.sdk",g=1;var Qe=`
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
`;function Ye(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let n=new WeakMap;e.addEventListener("scroll",(S)=>{let c=S.target===e?r:S.target;if(!(c instanceof Element))return;if(!c.hasAttribute("data-oc-scrolling"))c.setAttribute("data-oc-scrolling","");let _=n.get(c);if(_!==void 0)clearTimeout(_);n.set(c,setTimeout(()=>{n.delete(c),c.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Wo=`(${Ye.toString()})(document);`;var Ze=128,et=65536;var ve=128;var Ae=65536;var tt=8000,ot=192000,rt=120000;var Jt=(e)=>{let r=[],n=0,S=0;return{push:(c)=>{r.push(c),S+=c.length;while(S-n>e&&r.length>1){let _=r.shift();S-=_?.length??0,n=0}},pull:(c)=>{let _=0;while(_<c.length&&r.length>0){let x=r[0],A=Math.min(c.length-_,x.length-n);if(c.set(x.subarray(n,n+A),_),_+=A,n+=A,n>=x.length)r.shift(),S-=x.length,n=0}c.fill(0,_)},clear:()=>{r.length=0,n=0,S=0},get size(){return S-n}}};var eo=/^[a-z][a-z0-9-]{0,39}$/;var Qt=(e)=>Object(e)===e&&!Array.isArray(e),st=(e,r)=>Object.keys(e).every((n)=>r.includes(n)),Yt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Zt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,to=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let n of e){if(!Qt(n)||!eo.test(n.id)||!Yt(n.label))return!1;if(n.disabled!==void 0&&n.disabled!==!0&&n.disabled!==!1)return!1;if(r.has(n.id))return!1;if(r.add(n.id),n.kind==="button"){if(!st(n,["kind","id","label","disabled"]))return!1;continue}if(n.kind!=="select"||!st(n,["kind","id","label","value","options","disabled"]))return!1;if(!Zt(n.value)||!Array.isArray(n.options)||n.options.length<1||n.options.length>16)return!1;let S=new Set;for(let c of n.options){if(!Qt(c)||!st(c,["value","label"])||!Zt(c.value)||!Yt(c.label)||S.has(c.value))return!1;S.add(c.value)}if(!S.has(n.value))return!1}return!0};var oo=["{id}","{segment}","{segments+}"];var hr=new Set(oo);var ro=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var yr=new Set(ro);var Oe=20000000,xe=256;var nt=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,so=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let n=0;n<e.bytes.byteLength;n+=1)if(e.bytes[n]!==r.bytes[n])return!1;return!0};var no=/^[A-Za-z0-9_-]{1,80}$/;var io=["left","right","top","bottom"];var ao=(e,r=0,n={remaining:16000})=>{if(--n.remaining<0||r>=32)return!1;if(e===null)return!0;let S=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let c of S)if(!ao(c,r+1,n))return!1;return!0},it=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(it);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(it)}return String(e)===e||Number.isFinite(e)},at=(e)=>{try{if(String(e.id)!==e.id||!no.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!io.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!ao(e.data)||!it(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var lo=/^[0-9a-f]{7,64}$/i,uo=(e)=>lo.test(e),lt=255,co=(e,r,n)=>({openCommit:(S)=>uo(S)?e({channel:E,v:g,type:"open-commit",id:r(),payload:{sha:S}}):n("Commit id must be 7 to 64 hex characters."),openWalkthrough:({base:S})=>{let c=S.trim();if(!c||c.length>lt)return n(`Base must contain 1 to ${lt} characters.`);return e({channel:E,v:g,type:"open-walkthrough",id:r(),payload:{base:c}})}});var ct=2000;var So=["file","directory","other","missing"],pt=(e)=>Boolean(e&&"sessionId"in e),dt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Ce=500,ke=32000,Eo=16000,go=128,_o=200,To=2000,mo=16000,Ro=80,ho=200,fo=16000;var yo=2000;var St=20000,Ie=1024,Pe=2000000;var Me=64000,Ge=8000,Et=4000;var gt=960000;var bo=999,vo=1e4,Se=500,Ao=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],Oo=["stopped","starting","ready","failed"],$o=new Set(Ao),xo=(e)=>$o.has(e),Co=(e)=>e&&xo(e)?e:"HOST_REJECTED",te=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(te);if(Object(e)===e)return Object.values(e).every(te);return!1},ko=(e)=>te(e)&&JSON.stringify(e).length<=fo,po=(e)=>e?.trim().slice(0,ho)??"",oe=(e)=>{let r=e.id.trim().slice(0,go),n=e.title.trim().slice(0,_o),S=e.url.trim().slice(0,To),c=e.text?.trim().slice(0,mo),_=e.author?.trim().slice(0,Ro),x=e.kind==="pull"?"pull":"issue",A={providerId:e.providerId.trim(),id:r,title:n||r,url:S,kind:x};if(c)A.text=c;if(_)A.author=_;if(x==="pull"){let M=po(e.branches?.head),X=po(e.branches?.base);if(M&&X)A.branches={head:M,base:X}}if(ko(e.data))A.data=e.data;return A},_t=(e)=>{let r=oe(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},Tt=(e)=>{let r={text:e.text.trim().slice(0,Eo)};if(e.send)r.send=!0;return r},mt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(bo,Math.max(0,Math.round(e)))},Rt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(vo,Math.max(0,Math.ceil(e)))};var re=(e)=>e.length>0&&e.length<=Ie&&!e.includes("\x00")&&!e.includes("\\");var Ue=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>yo)return!1;return!e.split("/").some((n)=>n==="."||n==="..")},qo=new Set(Oo),ht=(e)=>Boolean(e&&"status"in e&&qo.has(String(e.status))&&!("body"in e)),we=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),ft=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),yt=(e)=>Boolean(e&&"written"in e&&e.written===!0),bt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Ko=new Set(So),vt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Ko.has(String(e.kind))&&Number.isFinite(e.size)),At=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),jo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late","microphone-audio","microphone-ended"]),zo=(e)=>Object(e)===e?e:null,ut=(e)=>String(e)===e&&e.length>0,Jo=(e)=>{if(!ut(e.id))return null;if(e.ok===!0){let r={channel:E,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&ut(e.error))return{channel:E,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:Co(ut(e.code)?e.code:void 0)};return null},Ot=(e)=>{let r=zo(e);if(!r||r.channel!==E||r.v!==g)return null;if(r.type==="result")return Jo(r);if(!jo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var Io=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Qo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class l extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Po=()=>Promise.reject(new l("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ne=()=>Promise.reject(new l("BAD_PATH",`File path must be 1 to ${Ie} characters without NUL or backslash.`)),Le=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new l("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},d=(e)=>(e.value+=1,`oc-${e.value}`),xt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new l("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let n=e.acceptSource??((t)=>t===r.parent),S=e.requestTimeoutMs??St,c=new Set,_=new Set,x=new Set,A=new Set,M=new Set,X=new Set,ie=new Set,ge=new Set,_e=new Set,Te=new Set,me=new Set,J=new Set,$e=[],ae=null,le=null,Re=new Set,he=new Set,ue=null,ce=null,qe=!1,Q=new Map,Y=new Map,Z=new Map,D=!1,p={value:0},u=null,F=null,pe=!1,de=!1,Dt=null,w=null,Ht=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},G=(t)=>{r.parent.postMessage(t,"*")},Bt=()=>{if(D||r.parent===r||J.size===0||u?.features?.lateGenerateResults!==!0)return;G({channel:E,v:g,type:"generate-late-listen"})},R=(t,o)=>{for(let a of t)try{a(o)}catch(i){console.error(i)}},Ft=(t)=>{if(!(t instanceof MessageEvent))return;if(!n(t.source))return;let o=Ot(t.data);if(!o)return;if(o.type==="workspace"){let i=Y.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="shells"){let i=Z.get(o.payload.subscriptionId);if(i)R([i],o.payload.snapshot);return}if(o.type==="microphone-audio"){w?.queue.push(o.payload.samples);return}if(o.type==="microphone-ended"){let i=w;if(!i)return;w=null,i.release(),R(i.endedListeners,o.payload.reason);return}if(o.type==="ready"){if(u=o.payload,F=Ht(o.payload.session),R(c,o.payload),R(_,o.payload.directory),R(x,o.payload.session),F)R(A,F);if(R(M,o.payload.connection),R(X,o.payload.settings),R(ie,o.payload.item),o.payload.block)R(ge,o.payload.block);Bt();return}if(o.type==="service-event"){R(_e,o.payload);return}if(o.type==="generate-late"){if(J.size===0)$e.push(o.payload);else R(J,o.payload);return}if(o.type==="directory"){if(u)u={...u,directory:o.payload.directory};R(_,o.payload.directory);return}if(o.type==="session"){if(u)u={...u,session:o.payload.session};if(!o.payload.session)F=null;else if(F?.sessionId!==o.payload.session.id)F=Ht(o.payload.session);R(x,o.payload.session);return}if(o.type==="session-lifecycle"){F=o.payload,R(A,o.payload);return}if(o.type==="connection"){if(u)u={...u,connection:o.payload.connection};R(M,o.payload.connection);return}if(o.type==="settings"){if(u)u={...u,settings:o.payload.settings};R(X,o.payload.settings);return}if(o.type==="item"){if(u)u={...u,item:o.payload.item};R(ie,o.payload.item);return}if(o.type==="status-control-event"){R(Te,o.payload);return}if(o.type==="popover-closed"){R(me,o.payload);return}if(o.type==="action"){let i=(m)=>{if(!D)G({channel:E,v:g,type:"action-result",id:o.id,payload:m})},T=le;if(!T){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>T(o.payload)).then(()=>i({ok:!0}),(m)=>{let h=(m instanceof Error?m.message:String(m)).trim();i({ok:!1,error:(h||"Action failed.").slice(0,Se)})});return}if(o.type==="file-open"){let i=o.payload;if(ce&&so(ce,i))return;ce=i,R(Re,o.payload);return}if(o.type==="file-saved"){R(he,o.payload.version);return}if(o.type==="file-snapshot"){let i=(h)=>{if(!D)G({channel:E,v:g,type:"file-snapshot-result",id:o.id,payload:h})},T=(h)=>i({error:(h.trim()||"Could not read the edited file.").slice(0,Se)}),m=ue;if(!m){T("This extension does not edit files.");return}Promise.resolve().then(()=>m(o.payload.purpose)).then((h)=>{if(nt(h)>Oe){T(`The file is over ${Oe} ${"bytes"in h?"bytes":"characters"}.`);return}if(h.version.length>xe){T(`The snapshot version is over ${xe} characters.`);return}i({snapshot:"bytes"in h?{bytes:h.bytes,version:h.version}:{content:h.content,version:h.version}})},(h)=>T(h instanceof Error?h.message:String(h)));return}if(o.type==="resolve"){let i=(m)=>{G({channel:E,v:g,type:"resolve-result",id:o.id,payload:m})},T=ae;if(!T){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>T(o.payload)).then((m)=>i({item:m?oe(m):null}),(m)=>{let h=(m instanceof Error?m.message:String(m)).trim();i({error:(h||"Command failed.").slice(0,Se)})});return}let a=Q.get(o.id);if(!a)return;if(clearTimeout(a.timer),Q.delete(o.id),o.ok){a.resolve(o.payload);return}a.reject(new l(o.code,o.error))};r.addEventListener("message",Ft),G({channel:E,v:g,type:"hello"});let C=(t,o=S)=>{if(D||r.parent===r)return Promise.reject(new l("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((a,i)=>{let T=setTimeout(()=>{Q.delete(t.id),i(new l("HOST_TIMEOUT","Host did not answer in time."))},o);Q.set(t.id,{resolve:a,reject:i,timer:T}),G(t)})},O=(t)=>C(t).then(()=>{return}),y={channel:E,v:g},Ke=(t)=>{if(!D&&r.parent!==r)G(t)},Vt=()=>Ke({...y,type:"file-save"}),je=()=>{if(!D&&r.parent!==r)G({...y,type:"microphone-close",id:d(p)})},Fo=async()=>{if(w)throw new l("HOST_REJECTED","The microphone is already open in this frame.");if(u?.features?.microphone!==!0)throw new l("UNSUPPORTED","This OpenChamber cannot share the microphone with extensions.");let t=globalThis.AudioContext;if(typeof t!=="function")throw new l("UNSUPPORTED","This frame has no Web Audio.");let o=new t;if(o.sampleRate<tt||o.sampleRate>ot)throw o.close().catch(()=>{return}),new l("UNSUPPORTED",`Audio at ${o.sampleRate} Hz is not supported.`);let a=o.state==="suspended"?o.resume().catch(()=>{return}):void 0,i=Jt(Math.round(o.sampleRate/4)),T=o.createScriptProcessor(1024,1,1);T.onaudioprocess=(L)=>i.pull(L.outputBuffer.getChannelData(0));let m=o.createMediaStreamDestination();T.connect(m);let h=new Set,ee={queue:i,endedListeners:h,release:()=>{T.onaudioprocess=null,T.disconnect(),i.clear();for(let L of m.stream.getTracks())L.stop();o.close().catch(()=>{return})}};w=ee;try{let L=await C({...y,type:"microphone-open",id:d(p),payload:{sampleRate:o.sampleRate}},rt);if(!L||!("opened"in L)||L.opened!==!0)throw new l("HOST_REJECTED","Host did not open the microphone.");if(await a,w!==ee)throw new l("DISCONNECTED","The microphone closed while it was opening.")}catch(L){if(w===ee)w=null;throw ee.release(),je(),L}return{stream:m.stream,close:()=>{if(w!==ee)return;w=null,ee.release(),je()},onEnded:(L)=>(h.add(L),()=>{h.delete(L)})}},Wt=(t)=>{if(!Io(t)||!Qo(t))return;t.preventDefault(),Vt()},Xt=(t)=>{if(!Io(t)||t.key!=="Escape"||u?.surface!=="popover"||!u.popover)return;t.preventDefault(),jt(u.popover.id,"escape").catch(()=>{return})},fe=()=>{let t=u?.surface==="popover"?u.popover:void 0;if(!t)return;let o=pe||de;if(Dt===o)return;Dt=o,zt(t.id,o).catch(()=>{return})},ye=()=>{if(u?.surface!=="popover"||pe)return;pe=!0,fe()},$t=(t)=>{if(u?.surface!=="popover"||t.relatedTarget!==null||!pe)return;pe=!1,fe()},qt=()=>{if(u?.surface!=="popover"||de)return;de=!0,fe()},Kt=()=>{if(u?.surface!=="popover"||!de)return;de=!1,fe()},H=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new l("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},ze=async(t)=>{if(t.kind!=="projects")H(t.projectId);let o=await C({...y,type:"workspace-read",id:d(p),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new l("HOST_REJECTED","Host did not return workspace data.");return o},Je=async(t,o)=>{if(t.kind!=="projects")H(t.projectId);let a=d(p);Y.set(a,o);try{await O({...y,type:"workspace-subscribe",id:d(p),payload:{subscriptionId:a,query:t}})}catch(i){if(Y.delete(a),!D)G({...y,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:a}});throw i}return()=>{if(!Y.delete(a)||D)return;G({...y,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:a}})}},Vo=async(t,o)=>{if(t.kind==="session")H(t.sessionId);if(t.kind==="project")H(t.projectId);let a=d(p);Z.set(a,o);try{await O({...y,type:"shells-subscribe",id:d(p),payload:{subscriptionId:a,scope:t}})}catch(i){if(Z.delete(a),!D)G({...y,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:a}});throw i}return()=>{if(!Z.delete(a)||D)return;G({...y,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:a}})}},be=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ze))throw new l("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!te(t.value))throw new l("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>et)throw new l("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&u?.features?.deviceStorage!==!0)throw new l("UNSUPPORTED","This host does not support device storage.");let o=await C({...y,type:"storage",id:d(p),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new l("HOST_REJECTED","Host did not return storage data.");return o},jt=(t,o)=>u?.features?.popovers!==!0&&!(u?.surface==="popover"&&u.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):O({...y,type:"popover-close",id:d(p),payload:o?{id:t,reason:o}:{id:t}}),zt=(t,o)=>u?.features?.popovers!==!0&&!(u?.surface==="popover"&&u.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):O({...y,type:"popover-anchor",id:d(p),payload:{id:t,active:o}});return r.addEventListener("keydown",Xt,!0),r.addEventListener("pointerover",ye),r.addEventListener("pointermove",ye),r.addEventListener("pointerout",$t),r.addEventListener("focus",qt),r.addEventListener("blur",Kt),{onAction:(t)=>(le=t,()=>{if(le===t)le=null}),listProjects:async()=>{let t=await ze({kind:"projects"});if(t.kind!=="projects")throw new l("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await ze({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new l("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await ze({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new l("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Je({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Je({kind:"worktrees",projectId:t},(a)=>{if(a.kind==="worktrees")o(a)}),onSessions:(t,o)=>Je({kind:"sessions",projectId:t},(a)=>{if(a.kind==="sessions")o(a)}),onRunningShells:(t,o)=>Vo(t,o),readShellOutput:async(t,o)=>{H(t,ve);let a=o?.cursor;if(a!==void 0&&(!Number.isInteger(a)||a<0))throw new l("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>Ae))throw new l("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${Ae}.`);let m=await C({...y,type:"shell-output",id:d(p),payload:{shellId:t,cursor:a,tailBytes:i}});if(!m||typeof m.output!=="string"||!Number.isFinite(m.cursor))throw new l("HOST_REJECTED","Host did not return shell output.");return m},stopShell:async(t)=>{if(H(t,ve),(await C({...y,type:"shell-stop",id:d(p),payload:{shellId:t}}))?.stopped!==!0)throw new l("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{H(t),await O({...y,type:"open-session",id:d(p),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let a=Le(o),i={op:"get",key:t};if(a)i.scope=a;let T=await be(i);return T.op==="get"&&T.found?T.value:void 0},set:async(t,o,a)=>{let i=Le(a),T={op:"set",key:t,value:o};if(i)T.scope=i;await be(T)},delete:async(t,o)=>{let a=Le(o),i={op:"delete",key:t};if(a)i.scope=a;await be(i)},keys:async(t)=>{let o=Le(t),a={op:"keys"};if(o)a.scope=o;let i=await be(a);if(i.op!=="keys")throw new l("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(c.add(t),u)t(u);return()=>{c.delete(t)}},onDirectory:(t)=>{if(_.add(t),u)t(u.directory);return()=>{_.delete(t)}},onSession:(t)=>{if(x.add(t),u)t(u.session);return()=>{x.delete(t)}},onSessionLifecycle:(t)=>{if(A.add(t),F)t(F);return()=>{A.delete(t)}},onConnection:(t)=>{if(M.add(t),u)t(u.connection);return()=>{M.delete(t)}},onSettings:(t)=>{if(X.add(t),u)t(u.settings);return()=>{X.delete(t)}},onItem:(t)=>{if(ie.add(t),u)t(u.item);return()=>{ie.delete(t)}},onBlock:(t)=>{if(ge.add(t),u?.block)t(u.block);return()=>{ge.delete(t)}},onServiceEvent:(t)=>(_e.add(t),()=>{_e.delete(t)}),onStatusControl:(t)=>(Te.add(t),()=>{Te.delete(t)}),onPopoverClosed:(t)=>(me.add(t),()=>{me.delete(t)}),setStatusControls:(t)=>{if(u?.features?.statusControls!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support status controls."));if(!to(t))return Promise.reject(new l("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return O({...y,type:"status-controls",id:d(p),payload:{controls:t}})},openPopover:(t)=>{if(u?.features?.popovers!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support popovers."));if(!at(t))return Promise.reject(new l("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return O({...y,type:"popover-open",id:d(p),payload:t})},closePopover:jt,setPopoverAnchorActive:zt,onResolve:(t)=>(ae=t,()=>{if(ae===t)ae=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Ce)return Promise.reject(new l("HOST_REJECTED",`Toast message must contain 1 to ${Ce} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>ke))return Promise.reject(new l("HOST_REJECTED",`Toast copy text must contain 1 to ${ke} characters.`));return O({channel:E,v:g,type:"toast",id:d(p),payload:{...t,message:o}})},openUrl:(t)=>O({channel:E,v:g,type:"open-url",id:d(p),payload:{url:t}}),...co(O,()=>d(p),(t)=>Promise.reject(new l("HOST_REJECTED",t))),answerBlock:(t)=>O({channel:E,v:g,type:"block-answer",id:d(p),payload:{text:t.trim().slice(0,ct)}}),openSurface:(t)=>O({channel:E,v:g,type:"open-surface",id:d(p),payload:{surfaceId:t}}),writeClipboard:(t)=>O({channel:E,v:g,type:"clipboard-write",id:d(p),payload:{text:t}}),compose:(t)=>O({channel:E,v:g,type:"compose",id:d(p),payload:t}),attach:(t)=>O({channel:E,v:g,type:"attach",id:d(p),payload:oe(t)}),startSession:async(t)=>{if(t.projectId!==void 0)H(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")H(o.directory);else{if(o.name!==void 0)H(o.name,200);if(o.baseBranch!==void 0)H(o.baseBranch,200)}let a=await C({channel:E,v:g,type:"start-session",id:d(p),payload:_t(t)},e.requestTimeoutMs??180000);if(!pt(a))throw new l("HOST_REJECTED","Host did not return a session.");return a},prompt:(t)=>C({channel:E,v:g,type:"prompt",id:d(p),payload:Tt(t)}).then((o)=>{if(!dt(o))throw new l("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>O({channel:E,v:g,type:"session-link",id:d(p),payload:oe(t)}),close:()=>O({channel:E,v:g,type:"close",id:d(p)}),oauthStart:()=>O({channel:E,v:g,type:"oauth-start",id:d(p)}),oauthDisconnect:()=>O({channel:E,v:g,type:"oauth-disconnect",id:d(p)}),request:(t)=>(Ue(t.path)?C({channel:E,v:g,type:"request",id:d(p),payload:t}):Po()).then((o)=>{if(!we(o))throw new l("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ue(t.path)?C({channel:E,v:g,type:"service-request",id:d(p),payload:t}):Po()).then((o)=>{if(!we(o))throw new l("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>C({channel:E,v:g,type:"service-status",id:d(p)}).then((t)=>{if(!ht(t))throw new l("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(re(t)?C({channel:E,v:g,type:"file-read",id:d(p),payload:{path:t}}):Ne()).then((o)=>{if(!ft(o))throw new l("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!re(t))return Ne();if(o.length>Pe)return Promise.reject(new l("FILE_TOO_LARGE",`Content is over ${Pe} characters.`));return C({channel:E,v:g,type:"file-write",id:d(p),payload:{path:t,content:o}}).then((a)=>{if(!yt(a))throw new l("HOST_REJECTED","Host did not confirm the write.");return a})},listDir:(t)=>(re(t)?C({channel:E,v:g,type:"file-list",id:d(p),payload:{path:t}}):Ne()).then((o)=>{if(!bt(o))throw new l("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(re(t)?C({channel:E,v:g,type:"file-stat",id:d(p),payload:{path:t}}):Ne()).then((o)=>{if(!vt(o))throw new l("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),a=t.system?.trim();if(o.length===0||o.length>Me)return Promise.reject(new l("HOST_REJECTED",`Prompt must be 1 to ${Me} characters.`));if(a!==void 0&&(a.length===0||a.length>Ge))return Promise.reject(new l("HOST_REJECTED",`System prompt must be 1 to ${Ge} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(Et,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new l("HOST_REJECTED","maxOutputTokens must be a number."));let T={prompt:o};if(a!==void 0)T.system=a;if(i!==void 0)T.maxOutputTokens=i;return C({channel:E,v:g,type:"generate",id:d(p),payload:T},e.requestTimeoutMs??gt).then((m)=>{if(!At(m))throw new l("HOST_REJECTED","Host did not return generated text.");return m})},onLateGenerateResult:(t)=>{J.add(t);for(let o of $e.splice(0))R([t],o);return Bt(),()=>{J.delete(t)}},openMicrophone:Fo,setBadge:(t)=>O({channel:E,v:g,type:"badge",id:d(p),payload:{count:mt(t)}}),setHeight:(t)=>O({channel:E,v:g,type:"resize",id:d(p),payload:{height:Rt(t)}}),onFileOpen:(t)=>{if(Re.add(t),!qe)qe=!0,r.addEventListener("keydown",Wt,!0);if(ce)t(ce);return()=>{Re.delete(t)}},onFileSnapshot:(t)=>(ue=t,()=>{if(ue===t)ue=null}),onFileSaved:(t)=>(he.add(t),()=>{he.delete(t)}),reportFileChange:(t)=>Ke({...y,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Vt,reportFileUnsupported:()=>Ke({...y,type:"file-unsupported"}),dispose:()=>{for(let t of Y.keys())G({...y,type:"workspace-unsubscribe",id:d(p),payload:{subscriptionId:t}});Y.clear();for(let t of Z.keys())G({...y,type:"shells-unsubscribe",id:d(p),payload:{subscriptionId:t}});if(Z.clear(),w)je(),w.release(),w=null;if(D=!0,ae=null,le=null,ue=null,Re.clear(),he.clear(),qe)r.removeEventListener("keydown",Wt,!0);r.removeEventListener("message",Ft),r.removeEventListener("keydown",Xt,!0),r.removeEventListener("pointerover",ye),r.removeEventListener("pointermove",ye),r.removeEventListener("pointerout",$t),r.removeEventListener("focus",qt),r.removeEventListener("blur",Kt);for(let t of Q.values())clearTimeout(t.timer),t.reject(new l("HOST_UNAVAILABLE","Host client was disposed."));Q.clear(),c.clear(),_.clear(),x.clear(),A.clear(),M.clear(),X.clear(),ie.clear(),ge.clear(),_e.clear(),Te.clear(),me.clear(),J.clear(),$e.length=0}}};var Mo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Vr=new Set(Mo);var Go=["none","agent","user"];var Xr=new Set(Go);var Yo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Zo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Uo=(e,r)=>{r.style.colorScheme=e.mode;for(let[n,S]of Yo)r.style.setProperty(n,e.tokens[S]);for(let[n,S,c]of Zo){let _=e.tokens[c]??"";r.style.setProperty(n,_),r.style.setProperty(S,_)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},Ct=(e,r)=>{if(Uo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var er={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},f=(e,r)=>`var(--${e}, var(--oc-${er[e]}, ${r}))`,W=f("surface-background","transparent"),He=f("surface-elevated","transparent"),se=f("surface-elevated-foreground","inherit"),N=f("surface-foreground","inherit"),b=f("surface-muted-foreground","gray"),tr=f("surface-muted","transparent"),K=f("interactive-border","currentColor"),U=f("interactive-hover","transparent"),j=f("interactive-active","transparent"),kt=f("interactive-selection","transparent"),It=f("interactive-selection-foreground","inherit"),V=f("primary","currentColor"),Pt=f("primary-text","inherit"),Mt=f("error-text","inherit"),or=f("font-sans","inherit"),Gt=f("font-mono","monospace"),Do=f("radius","9px"),Ut=`calc(${Do} - 2px)`,wo=`calc(${Do} - 4px)`,v=(e,r,n="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${n})`,No=`background-image: linear-gradient(${U}, ${U});`,wt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Nt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Lo="box-shadow: var(--oc-sdk-lit);",Lt=`inset 0 0.5px 0 0 ${v(N,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,rr=`
:root {
  --oc-sdk-edge: ${v(N,16)};
  --oc-sdk-field-bg: ${He};
  --oc-sdk-raised-bg: ${W};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${v(N,14)};
  --oc-sdk-field-bg: ${v(W,50,He)};
  --oc-sdk-raised-bg: ${He};
  --oc-sdk-field-lift: ${Lt};
  --oc-sdk-raised-lift: ${Lt};
  --oc-sdk-lit: ${Lt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,De=(e)=>{let r=f(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${f(`${e}-text`,"inherit")}; }`},s=(e)=>`calc(${e}rem / 14)`,sr=`
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

/* Under a finger the controls reach the app's touch sizes: rows and options 44px like its sheets, every other
   control at least 36px. Inputs keep 16px text, below which iOS zooms the page on focus. */
@media (pointer: coarse) {
  .oc-sdk-btn, .oc-sdk-input { height: ${s(40)}; }
  .oc-sdk-btn[data-size="sm"], .oc-sdk-btn[data-size="xs"], .oc-sdk-trigger, .oc-sdk-tab, .oc-sdk-popup-search .oc-sdk-input { height: ${s(36)}; }
  .oc-sdk-input, .oc-sdk-popup-search .oc-sdk-input { font-size: max(16px, 0.875rem); }
  .oc-sdk-search-clear { width: ${s(36)}; height: ${s(36)}; right: 0; }
  .oc-sdk-row, .oc-sdk-option { min-height: ${s(44)}; }
  .oc-sdk-check { min-height: ${s(36)}; padding: ${s(8)} 0; }
}
`,Ho=`${rr}
.oc-sdk { color: ${N}; font-family: ${or}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${No} }
.oc-sdk-mono { font-family: ${Gt}; }
.oc-sdk-muted { color: ${b}; }
${De("success")}${De("warning")}${De("error")}${De("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${V}; --oc-sdk-tone-text: ${Pt}; }

.oc-sdk-btn { border-radius: ${Ut}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${wo}; }
.oc-sdk-btn[data-variant="default"] { color: ${Pt}; background: ${v(V,10,W)}; border-color: ${v(V,12)}; ${Lo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${v(V,16,W)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${v(V,22,W)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${tr}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${se}; ${Nt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${U}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${f("status-error","red")}; color: ${Mt}; background: ${v("var(--oc-sdk-tone)",7,W)}; border-color: ${v("var(--oc-sdk-tone)",12)}; ${Lo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${v("var(--oc-sdk-tone)",9,W)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${v("var(--oc-sdk-tone)",11,W)}; box-shadow: none; }

.oc-sdk-field-note { color: ${b}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Mt}; }
.oc-sdk-input { border-radius: ${Ut}; background: var(--oc-sdk-field-bg); color: ${se}; ${wt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${b}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${wt(v(N,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${wt(f("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Gt}; }

.oc-sdk-search-icon { color: ${b}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${V}; }
.oc-sdk-search-clear { border-radius: ${wo}; color: ${b}; }
.oc-sdk-search-clear:hover { background: ${U}; color: ${N}; }

.oc-sdk-trigger { border-radius: ${Ut}; background: var(--oc-sdk-raised-bg); color: ${se}; ${Nt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${b}; }
.oc-sdk-trigger-chevron { color: ${b}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${se}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${He}; background-clip: padding-box; color: ${se}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${U}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${kt}; color: ${It}; }
.oc-sdk-option-check { color: ${N}; }
.oc-sdk-option[data-destructive="true"] { color: ${Mt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${v(f("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${b}; }
.oc-sdk-popup-empty { color: ${b}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${K}; border-radius: 4px; color: ${N}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${v(N,60,K)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${K}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${W}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${V}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${No} }
.oc-sdk-check-desc { color: ${b}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${v(N,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${b}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${N}; }
.oc-sdk-tab[aria-selected="true"] { color: ${It}; background: ${kt}; border-color: ${K}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${se}; background: var(--oc-sdk-raised-bg); ${Nt} }
.oc-sdk-tab-count { color: ${b}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${v(N,6)}; color: ${b}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${v("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${U}; }
.oc-sdk-row[aria-selected="true"] { background: ${kt}; color: ${It}; }
.oc-sdk-row-lead { font-family: ${Gt}; color: ${b}; }
.oc-sdk-row-sub { color: ${b}; }
.oc-sdk-row-meta { color: ${b}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${b}; }

.oc-sdk-empty-body { color: ${b}; }

.oc-sdk-spinner { color: ${b}; }
.oc-sdk-spinner-ring { border-color: ${K}; border-top-color: ${V}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${v("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${b}; }

.oc-sdk-separator { color: ${b}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${v(K,40)}; }

.oc-sdk-progress-label { color: ${b}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${v(N,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${V}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${f("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${f("success-text","inherit")}; }

.oc-sdk-text a { color: ${Pt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${v(K,60)}; }
`,k=`
${Qe}
${sr}
${Ho}`;var Bo="oc-sdk-ui-style";var I=(e)=>{let r=document.getElementById(Bo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ye(document);let n=document.createElement("style");n.id=Bo,n.textContent=e,document.head.appendChild(n)},P=(e,r)=>{let n=document.createElement(e);if(r)n.className=r;return n},q=(e)=>{let r=P("button",e);return r.type="button",r},B=(e,r)=>{let n=r??"";if(e.textContent!==n)e.textContent=n};var nr=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},ne=(e,r)=>{I(k);let n=r,S=q("oc-sdk oc-sdk-btn"),c=nr(),_=document.createElement("span");S.append(_),e.append(S);let x=()=>{if(S.dataset.variant=n.variant??"default",S.dataset.size=n.size??"default",S.disabled=Boolean(n.disabled)||Boolean(n.loading),S.dataset.loading=n.loading?"true":"false",S.setAttribute("aria-busy",n.loading?"true":"false"),n.loading&&c.parentNode!==S)S.prepend(c);else if(!n.loading&&c.parentNode===S)c.remove();B(_,n.label)},A=()=>{if(n.disabled||n.loading)return;n.onClick()};return S.addEventListener("click",A),x(),{update:(M)=>{n={...n,...M},x()},dispose:()=>{S.removeEventListener("click",A),S.remove()}}};var Xe=xt(),z=document.querySelector("#root");if(!z)throw Error("DeskChart: missing root");z.style.padding="12px";Xe.onReady((e)=>Ct(e,document.documentElement));Xe.onBlock(({args:e,answered:r})=>{let n=(e.values??"").split(",").map(Number).filter(Number.isFinite),S=Math.max(1,...n);z.replaceChildren();let c=document.createElement("div");c.textContent=e.title??"",c.style.font="600 13px var(--oc-font, system-ui)";let _=document.createElement("div");_.style.cssText="display:flex;align-items:flex-end;gap:6px;height:96px;margin-top:8px";for(let A of n){let M=document.createElement("div");M.style.cssText=`flex:1;height:${A/S*100}%;background:currentColor;opacity:.6;border-radius:3px 3px 0 0`,M.title=String(A),_.append(M)}z.append(c,_);let x=document.createElement("div");x.style.marginTop="10px",z.append(x),ne(x,{label:r??"Explain this",variant:"outline",size:"sm",disabled:r!==null,onClick:()=>{Xe.answerBlock("Explain this chart")}})});new ResizeObserver(()=>{Xe.setHeight(Math.ceil(z.getBoundingClientRect().height))}).observe(z);})();
