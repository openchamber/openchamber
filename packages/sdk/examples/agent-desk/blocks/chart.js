(()=>{var g="openchamber.sdk",_=1;var je=`
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
`;function ze(e){let o=e.documentElement;if(o.hasAttribute("data-oc-scrollbar-activity"))return;o.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(i)=>{let u=i.target===e?o:i.target;if(!(u instanceof Element))return;if(!u.hasAttribute("data-oc-scrolling"))u.setAttribute("data-oc-scrolling","");let c=s.get(u);if(c!==void 0)clearTimeout(c);s.set(u,setTimeout(()=>{s.delete(u),u.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Kr=`(${ze.toString()})(document);`;var Je=128,Qe=65536;var he=128;var be=65536;class a extends Error{code;constructor(e,o){super(o);this.name="HostRequestError",this.code=e}}var Yt=8000,Zt=192000,er=120000;var jr=(e)=>{let o=[],s=0,i=0;return{push:(u)=>{o.push(u),i+=u.length;while(i-s>e&&o.length>1){let c=o.shift();i-=c?.length??0,s=0}},pull:(u)=>{let c=0;while(c<u.length&&o.length>0){let A=o[0],h=Math.min(u.length-c,A.length-s);if(u.set(A.subarray(s,s+h),c),c+=h,s+=h,s>=A.length)o.shift(),i-=A.length,s=0}u.fill(0,c)},clear:()=>{o.length=0,s=0,i=0},get size(){return i-s}}},tr=({isEnabled:e,envelope:o,nextId:s,send:i,postClose:u})=>{let c=null;return{open:async()=>{if(c)throw new a("HOST_REJECTED","The microphone is already open in this frame.");if(!e())throw new a("UNSUPPORTED","This OpenChamber cannot share the microphone with extensions.");let w=globalThis.AudioContext;if(!(w instanceof Function))throw new a("UNSUPPORTED","This frame has no Web Audio.");let O=new w;if(O.sampleRate<Yt||O.sampleRate>Zt)throw O.close().catch(()=>{return}),new a("UNSUPPORTED",`Audio at ${O.sampleRate} Hz is not supported.`);let J=O.state==="suspended"?O.resume().catch(()=>{return}):void 0,V=jr(Math.round(O.sampleRate/4)),q=O.createScriptProcessor(1024,1,1);q.onaudioprocess=(k)=>V.pull(k.outputBuffer.getChannelData(0));let Q=O.createMediaStreamDestination();q.connect(Q);let X=new Set,W={queue:V,endedListeners:X,release:()=>{q.onaudioprocess=null,q.disconnect(),V.clear();for(let k of Q.stream.getTracks())k.stop();O.close().catch(()=>{return})}};c=W;try{let k=await i({...o,type:"microphone-open",id:s(),payload:{sampleRate:O.sampleRate}},er);if(!k||!("opened"in k)||k.opened!==!0)throw new a("HOST_REJECTED","Host did not open the microphone.");if(await J,c!==W)throw new a("DISCONNECTED","The microphone closed while it was opening.")}catch(k){if(c===W)c=null;throw W.release(),u(),k}return{stream:Q.stream,close:()=>{if(c!==W)return;c=null,W.release(),u()},onEnded:(k)=>(X.add(k),()=>{X.delete(k)})}},handleMessage:(w)=>{if(w.type==="microphone-audio"){c?.queue.push(w.payload.samples);return}let O=c;if(!O)return;c=null,O.release();for(let J of O.endedListeners)try{J(w.payload.reason)}catch(V){console.error(V)}},release:()=>{if(!c)return;u(),c.release(),c=null}}};var nr=/^[a-z][a-z0-9-]{0,39}$/;var rr=(e)=>Object(e)===e&&!Array.isArray(e),Ye=(e,o)=>Object.keys(e).every((s)=>o.includes(s)),or=(e)=>String(e)===e&&e.length>=1&&e.length<=60,sr=(e)=>String(e)===e&&e.length>=1&&e.length<=80,ir=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let o=new Set;for(let s of e){if(!rr(s)||!nr.test(s.id)||!or(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(o.has(s.id))return!1;if(o.add(s.id),s.kind==="button"){if(!Ye(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!Ye(s,["kind","id","label","value","options","disabled"]))return!1;if(!sr(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let i=new Set;for(let u of s.options){if(!rr(u)||!Ye(u,["value","label"])||!sr(u.value)||!or(u.label)||i.has(u.value))return!1;i.add(u.value)}if(!i.has(s.value))return!1}return!0};var ar=["{id}","{segment}","{segments+}"];var Go=new Set(ar);var ur=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var No=new Set(ur);var ve=20000000,Ae=256;var Ze=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,lr=(e,o)=>{if(e.path!==o.path||e.readOnly!==o.readOnly)return!1;if(e.encoding==="text"||o.encoding==="text")return e.encoding==="text"&&o.encoding==="text"&&e.content===o.content;if(e.bytes.byteLength!==o.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==o.bytes[s])return!1;return!0};var cr=/^[A-Za-z0-9_-]{1,80}$/;var pr=["left","right","top","bottom"];var dr=(e,o=0,s={remaining:16000})=>{if(--s.remaining<0||o>=32)return!1;if(e===null)return!0;let i=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let u of i)if(!dr(u,o+1,s))return!1;return!0},et=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((o)=>/^(0|[1-9]\d*)$/.test(o)&&Number(o)<e.length)&&e.every(et);if(Object(e)===e){let o=Object.getPrototypeOf(e);return(o===null||o===Object.prototype)&&Object.values(e).every(et)}return String(e)===e||Number.isFinite(e)},tt=(e)=>{try{if(String(e.id)!==e.id||!cr.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!pr.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!dr(e.data)||!et(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var Sr=/^[0-9a-f]{7,64}$/i,Er=(e)=>Sr.test(e),rt=255,gr=(e,o,s)=>({openCommit:(i)=>Er(i)?e({channel:g,v:_,type:"open-commit",id:o(),payload:{sha:i}}):s("Commit id must be 7 to 64 hex characters."),openWalkthrough:({base:i})=>{let u=i.trim();if(!u||u.length>rt)return s(`Base must contain 1 to ${rt} characters.`);return e({channel:g,v:_,type:"open-walkthrough",id:o(),payload:{base:u}})}});var st=2000;var Tr=["file","directory","other","missing"],nt=(e)=>Boolean(e&&"sessionId"in e),it=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Oe=500,xe=32000,mr=16000,Rr=128,fr=200,yr=2000,hr=16000,br=80,vr=200,Ar=16000;var Or=2000;var at=20000,Ce=1024,ke=2000000;var Ie=64000,Pe=8000,ut=4000;var lt=960000;var xr=999,Cr=1e4,ge=500,ct=128,pt=512,dt=2048,St=32,Et=128,kr=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],Ir=["stopped","starting","ready","failed"],Qr=new Set(kr),Pr=(e)=>Qr.has(e),Gr=(e)=>e&&Pr(e)?e:"HOST_REJECTED",ne=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ne);if(Object(e)===e)return Object.values(e).every(ne);return!1},Mr=(e)=>ne(e)&&JSON.stringify(e).length<=Ar,_r=(e)=>e?.trim().slice(0,vr)??"",ie=(e)=>{let o=e.id.trim().slice(0,Rr),s=e.title.trim().slice(0,fr),i=e.url.trim().slice(0,yr),u=e.text?.trim().slice(0,hr),c=e.author?.trim().slice(0,br),A=e.kind==="pull"?"pull":"issue",h={providerId:e.providerId.trim(),id:o,title:s||o,url:i,kind:A};if(u)h.text=u;if(c)h.author=c;if(A==="pull"){let U=_r(e.branches?.head),w=_r(e.branches?.base);if(U&&w)h.branches={head:U,base:w}}if(Mr(e.data))h.data=e.data;return h},gt=(e)=>{let o=ie(e);if(e.projectId)o.projectId=e.projectId;if(e.navigation)o.navigation=e.navigation;if(e.worktree)o.worktree=e.worktree;return o},_t=(e)=>{let o={text:e.text.trim().slice(0,mr)};if(e.send)o.send=!0;return o},Tt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(xr,Math.max(0,Math.round(e)))},mt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Cr,Math.max(0,Math.ceil(e)))};var ae=(e)=>e.length>0&&e.length<=Ce&&!e.includes("\x00")&&!e.includes("\\");var Ge=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>Or)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Yr=new Set(Ir),Rt=(e)=>Boolean(e&&"status"in e&&Yr.has(String(e.status))&&!("body"in e)),Me=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),ft=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),yt=(e)=>Boolean(e&&"written"in e&&e.written===!0),ht=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Zr=new Set(Tr),bt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Zr.has(String(e.kind))&&Number.isFinite(e.size)),vt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),eo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late","microphone-audio","microphone-ended"]),to=(e)=>Object(e)===e?e:null,ot=(e)=>String(e)===e&&e.length>0,ro=(e)=>{if(!ot(e.id))return null;if(e.ok===!0){let o={channel:g,v:_,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)o.payload=e.payload;return o}if(e.ok===!1&&ot(e.error))return{channel:g,v:_,type:"result",id:e.id,ok:!1,error:e.error,code:Gr(ot(e.code)?e.code:void 0)};return null},At=(e)=>{let o=to(e);if(!o||o.channel!==g||o.v!==_)return null;if(o.type==="result")return ro(o);if(!eo.has(String(o.type))||Object(o.payload)!==o.payload)return null;return o};var oo=(e)=>e==="any"||e==="me"||e==="created",so=(e)=>e==="all"||e==="none"||e==="urgent"||e==="high"||e==="medium"||e==="low",xt=(e,o,s)=>{let i=e.trim();if(!i||i.length>o)throw new a("HOST_REJECTED",`${s} must contain 1 to ${o} characters.`);return i},Ot=(e,o,s)=>e===void 0?void 0:xt(e,o,s),no=(e)=>{let o={},s=Ot(e.query,pt,"Query");if(s!==void 0)o.query=s;let i=Ot(e.cursor,dt,"Cursor");if(i!==void 0)o.cursor=i;let u=Ot(e.state,St,"State filter");if(u!==void 0)o.state=u;if(e.people!==void 0){if(!oo(e.people))throw new a("HOST_REJECTED",`Unknown people filter: ${String(e.people)}`);o.people=e.people}if(e.priority!==void 0){if(!so(e.priority))throw new a("HOST_REJECTED",`Unknown priority filter: ${String(e.priority)}`);o.priority=e.priority}if(e.containerId===null)o.containerId=null;else if(e.containerId!==void 0)o.containerId=xt(e.containerId,Et,"Container id");return o},Ur=(e,o)=>{if(!e||Object(e)!==e)return!1;if(!("op"in e)||!("result"in e))return!1;let s=e.op;if(s!=="list"&&s!=="get"&&s!=="filters")return!1;if(o!==void 0&&s!==o)return!1;let i=e.result;if(!i||Object(i)!==i)return!1;if(s==="filters")return"stateFilters"in i&&Array.isArray(i.stateFilters);if(!("connected"in i))return!1;if(i.connected===!1)return!0;return s==="list"?"items"in i&&Array.isArray(i.items):("item"in i)},Ct=({envelope:e,nextId:o,send:s})=>{let i=async(u)=>{let c=await s({...e,type:"tracker",id:o(),payload:u});if(!Ur(c,u.op))throw new a("HOST_REJECTED","Host did not return tracker data.");return c};return{list:async(u={})=>{let c=await i({op:"list",options:no(u)});if(c.op!=="list")throw new a("HOST_REJECTED","Host did not return tracker items.");return c.result},get:async(u)=>{let c=await i({op:"get",id:xt(u,ct,"Item id")});if(c.op!=="get")throw new a("HOST_REJECTED","Host did not return the tracker item.");return c.result},filters:async()=>{let u=await i({op:"filters"});if(u.op!=="filters")throw new a("HOST_REJECTED","Host did not return tracker filters.");return u.result}}};var wr=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),io=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s",Nr=()=>Promise.reject(new a("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ue=()=>Promise.reject(new a("BAD_PATH",`File path must be 1 to ${Ce} characters without NUL or backslash.`)),we=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new a("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},E=(e)=>(e.value+=1,`oc-${e.value}`),kt=(e={})=>{let o=e.target??("window"in globalThis?window:null);if(!o)throw new a("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===o.parent),i=e.requestTimeoutMs??at,u=new Set,c=new Set,A=new Set,h=new Set,U=new Set,w=new Set,O=new Set,J=new Set,V=new Set,q=new Set,Q=new Set,X=new Set,W=[],k=null,ce=null,Te=new Set,me=new Set,pe=null,de=null,Xe=!1,re=new Map,oe=new Map,se=new Map,D=!1,S={value:0},d=null,K=null,Se=!1,Ee=!1,Ft=null,Bt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},N=(t)=>{o.parent.postMessage(t,"*")},Vt=()=>{if(D||o.parent===o||X.size===0||d?.features?.lateGenerateResults!==!0)return;N({channel:g,v:_,type:"generate-late-listen"})},f=(t,r)=>{for(let l of t)try{l(r)}catch(p){console.error(p)}},Xt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let r=At(t.data);if(!r)return;if(r.type==="workspace"){let p=oe.get(r.payload.subscriptionId);if(p)f([p],r.payload.snapshot);return}if(r.type==="shells"){let p=se.get(r.payload.subscriptionId);if(p)f([p],r.payload.snapshot);return}if(r.type==="microphone-audio"||r.type==="microphone-ended"){qe.handleMessage(r);return}if(r.type==="ready"){if(d=r.payload,K=Bt(r.payload.session),f(u,r.payload),f(c,r.payload.directory),f(A,r.payload.session),K)f(h,K);if(f(U,r.payload.connection),f(w,r.payload.settings),f(O,r.payload.item),r.payload.block)f(J,r.payload.block);Vt();return}if(r.type==="service-event"){f(V,r.payload);return}if(r.type==="generate-late"){if(X.size===0)W.push(r.payload);else f(X,r.payload);return}if(r.type==="directory"){if(d)d={...d,directory:r.payload.directory};f(c,r.payload.directory);return}if(r.type==="session"){if(d)d={...d,session:r.payload.session};if(!r.payload.session)K=null;else if(K?.sessionId!==r.payload.session.id)K=Bt(r.payload.session);f(A,r.payload.session);return}if(r.type==="session-lifecycle"){K=r.payload,f(h,r.payload);return}if(r.type==="connection"){if(d)d={...d,connection:r.payload.connection};f(U,r.payload.connection);return}if(r.type==="settings"){if(d)d={...d,settings:r.payload.settings};f(w,r.payload.settings);return}if(r.type==="item"){if(d)d={...d,item:r.payload.item};f(O,r.payload.item);return}if(r.type==="status-control-event"){f(q,r.payload);return}if(r.type==="popover-closed"){f(Q,r.payload);return}if(r.type==="action"){let p=(T)=>{if(!D)N({channel:g,v:_,type:"action-result",id:r.id,payload:T})},m=ce;if(!m){p({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>m(r.payload)).then(()=>p({ok:!0}),(T)=>{let C=(T instanceof Error?T.message:String(T)).trim();p({ok:!1,error:(C||"Action failed.").slice(0,ge)})});return}if(r.type==="file-open"){let p=r.payload;if(de&&lr(de,p))return;de=p,f(Te,r.payload);return}if(r.type==="file-saved"){f(me,r.payload.version);return}if(r.type==="file-snapshot"){let p=(C)=>{if(!D)N({channel:g,v:_,type:"file-snapshot-result",id:r.id,payload:C})},m=(C)=>p({error:(C.trim()||"Could not read the edited file.").slice(0,ge)}),T=pe;if(!T){m("This extension does not edit files.");return}Promise.resolve().then(()=>T(r.payload.purpose)).then((C)=>{if(Ze(C)>ve){m(`The file is over ${ve} ${"bytes"in C?"bytes":"characters"}.`);return}if(C.version.length>Ae){m(`The snapshot version is over ${Ae} characters.`);return}p({snapshot:"bytes"in C?{bytes:C.bytes,version:C.version}:{content:C.content,version:C.version}})},(C)=>m(C instanceof Error?C.message:String(C)));return}if(r.type==="resolve"){let p=(T)=>{N({channel:g,v:_,type:"resolve-result",id:r.id,payload:T})},m=k;if(!m){p({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>m(r.payload)).then((T)=>p({item:T?ie(T):null}),(T)=>{let C=(T instanceof Error?T.message:String(T)).trim();p({error:(C||"Command failed.").slice(0,ge)})});return}let l=re.get(r.id);if(!l)return;if(clearTimeout(l.timer),re.delete(r.id),r.ok){l.resolve(r.payload);return}l.reject(new a(r.code,r.error))};o.addEventListener("message",Xt),N({channel:g,v:_,type:"hello"});let I=(t,r=i)=>{if(D||o.parent===o)return Promise.reject(new a("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((l,p)=>{let m=setTimeout(()=>{re.delete(t.id),p(new a("HOST_TIMEOUT","Host did not answer in time."))},r);re.set(t.id,{resolve:l,reject:p,timer:m}),N(t)})},x=(t)=>I(t).then(()=>{return}),y={channel:g,v:_},We=(t)=>{if(!D&&o.parent!==o)N(t)},Wt=()=>We({...y,type:"file-save"}),qe=tr({isEnabled:()=>d?.features?.microphone===!0,envelope:y,nextId:()=>E(S),send:I,postClose:()=>{if(!D&&o.parent!==o)N({...y,type:"microphone-close",id:E(S)})}}),qt=(t)=>{if(!wr(t)||!io(t))return;t.preventDefault(),Wt()},$t=(t)=>{if(!wr(t)||t.key!=="Escape"||d?.surface!=="popover"||!d.popover)return;t.preventDefault(),Jt(d.popover.id,"escape").catch(()=>{return})},Re=()=>{let t=d?.surface==="popover"?d.popover:void 0;if(!t)return;let r=Se||Ee;if(Ft===r)return;Ft=r,Qt(t.id,r).catch(()=>{return})},fe=()=>{if(d?.surface!=="popover"||Se)return;Se=!0,Re()},Kt=(t)=>{if(d?.surface!=="popover"||t.relatedTarget!==null||!Se)return;Se=!1,Re()},jt=()=>{if(d?.surface!=="popover"||Ee)return;Ee=!0,Re()},zt=()=>{if(d?.surface!=="popover"||!Ee)return;Ee=!1,Re()},F=(t,r=1024)=>{if(!t.trim()||t.length>r)throw new a("HOST_REJECTED",`Identity must contain 1 to ${r} characters.`)},$e=async(t)=>{if(t.kind!=="projects")F(t.projectId);let r=await I({...y,type:"workspace-read",id:E(S),payload:t});if(!r||!("kind"in r)||!("state"in r)||r.kind!==t.kind)throw new a("HOST_REJECTED","Host did not return workspace data.");return r},Ke=async(t,r)=>{if(t.kind!=="projects")F(t.projectId);let l=E(S);oe.set(l,r);try{await x({...y,type:"workspace-subscribe",id:E(S),payload:{subscriptionId:l,query:t}})}catch(p){if(oe.delete(l),!D)N({...y,type:"workspace-unsubscribe",id:E(S),payload:{subscriptionId:l}});throw p}return()=>{if(!oe.delete(l)||D)return;N({...y,type:"workspace-unsubscribe",id:E(S),payload:{subscriptionId:l}})}},$r=async(t,r)=>{if(t.kind==="session")F(t.sessionId);if(t.kind==="project")F(t.projectId);let l=E(S);se.set(l,r);try{await x({...y,type:"shells-subscribe",id:E(S),payload:{subscriptionId:l,scope:t}})}catch(p){if(se.delete(l),!D)N({...y,type:"shells-unsubscribe",id:E(S),payload:{subscriptionId:l}});throw p}return()=>{if(!se.delete(l)||D)return;N({...y,type:"shells-unsubscribe",id:E(S),payload:{subscriptionId:l}})}},ye=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Je))throw new a("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ne(t.value))throw new a("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Qe)throw new a("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&d?.features?.deviceStorage!==!0)throw new a("UNSUPPORTED","This host does not support device storage.");let r=await I({...y,type:"storage",id:E(S),payload:t});if(!r||!("storage"in r)||r.op!==t.op)throw new a("HOST_REJECTED","Host did not return storage data.");return r},Jt=(t,r)=>d?.features?.popovers!==!0&&!(d?.surface==="popover"&&d.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...y,type:"popover-close",id:E(S),payload:r?{id:t,reason:r}:{id:t}}),Qt=(t,r)=>d?.features?.popovers!==!0&&!(d?.surface==="popover"&&d.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...y,type:"popover-anchor",id:E(S),payload:{id:t,active:r}});return o.addEventListener("keydown",$t,!0),o.addEventListener("pointerover",fe),o.addEventListener("pointermove",fe),o.addEventListener("pointerout",Kt),o.addEventListener("focus",jt),o.addEventListener("blur",zt),{onAction:(t)=>(ce=t,()=>{if(ce===t)ce=null}),listProjects:async()=>{let t=await $e({kind:"projects"});if(t.kind!=="projects")throw new a("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let r=await $e({kind:"worktrees",projectId:t});if(r.kind!=="worktrees")throw new a("HOST_REJECTED","Expected worktrees.");return r},listSessions:async(t)=>{let r=await $e({kind:"sessions",projectId:t});if(r.kind!=="sessions")throw new a("HOST_REJECTED","Expected sessions.");return r},onProjects:(t)=>Ke({kind:"projects"},(r)=>{if(r.kind==="projects")t(r)}),onWorktrees:(t,r)=>Ke({kind:"worktrees",projectId:t},(l)=>{if(l.kind==="worktrees")r(l)}),onSessions:(t,r)=>Ke({kind:"sessions",projectId:t},(l)=>{if(l.kind==="sessions")r(l)}),onRunningShells:(t,r)=>$r(t,r),readShellOutput:async(t,r)=>{F(t,he);let l=r?.cursor;if(l!==void 0&&(!Number.isInteger(l)||l<0))throw new a("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let p=r?.tailBytes;if(p!==void 0&&(!Number.isInteger(p)||p<1||p>be))throw new a("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${be}.`);let T=await I({...y,type:"shell-output",id:E(S),payload:{shellId:t,cursor:l,tailBytes:p}});if(!T||typeof T.output!=="string"||!Number.isFinite(T.cursor))throw new a("HOST_REJECTED","Host did not return shell output.");return T},stopShell:async(t)=>{if(F(t,he),(await I({...y,type:"shell-stop",id:E(S),payload:{shellId:t}}))?.stopped!==!0)throw new a("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{F(t),await x({...y,type:"open-session",id:E(S),payload:{sessionId:t}})},storage:{get:async(t,r)=>{let l=we(r),p={op:"get",key:t};if(l)p.scope=l;let m=await ye(p);return m.op==="get"&&m.found?m.value:void 0},set:async(t,r,l)=>{let p=we(l),m={op:"set",key:t,value:r};if(p)m.scope=p;await ye(m)},delete:async(t,r)=>{let l=we(r),p={op:"delete",key:t};if(l)p.scope=l;await ye(p)},keys:async(t)=>{let r=we(t),l={op:"keys"};if(r)l.scope=r;let p=await ye(l);if(p.op!=="keys")throw new a("HOST_REJECTED","Expected storage keys.");return p.keys}},onReady:(t)=>{if(u.add(t),d)t(d);return()=>{u.delete(t)}},onDirectory:(t)=>{if(c.add(t),d)t(d.directory);return()=>{c.delete(t)}},onSession:(t)=>{if(A.add(t),d)t(d.session);return()=>{A.delete(t)}},onSessionLifecycle:(t)=>{if(h.add(t),K)t(K);return()=>{h.delete(t)}},onConnection:(t)=>{if(U.add(t),d)t(d.connection);return()=>{U.delete(t)}},onSettings:(t)=>{if(w.add(t),d)t(d.settings);return()=>{w.delete(t)}},onItem:(t)=>{if(O.add(t),d)t(d.item);return()=>{O.delete(t)}},onBlock:(t)=>{if(J.add(t),d?.block)t(d.block);return()=>{J.delete(t)}},onServiceEvent:(t)=>(V.add(t),()=>{V.delete(t)}),onStatusControl:(t)=>(q.add(t),()=>{q.delete(t)}),onPopoverClosed:(t)=>(Q.add(t),()=>{Q.delete(t)}),setStatusControls:(t)=>{if(d?.features?.statusControls!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support status controls."));if(!ir(t))return Promise.reject(new a("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...y,type:"status-controls",id:E(S),payload:{controls:t}})},openPopover:(t)=>{if(d?.features?.popovers!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support popovers."));if(!tt(t))return Promise.reject(new a("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...y,type:"popover-open",id:E(S),payload:t})},closePopover:Jt,setPopoverAnchorActive:Qt,onResolve:(t)=>(k=t,()=>{if(k===t)k=null}),toast:(t)=>{let r=t.message.trim();if(!r||r.length>Oe)return Promise.reject(new a("HOST_REJECTED",`Toast message must contain 1 to ${Oe} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>xe))return Promise.reject(new a("HOST_REJECTED",`Toast copy text must contain 1 to ${xe} characters.`));return x({channel:g,v:_,type:"toast",id:E(S),payload:{...t,message:r}})},openUrl:(t)=>x({channel:g,v:_,type:"open-url",id:E(S),payload:{url:t}}),...gr(x,()=>E(S),(t)=>Promise.reject(new a("HOST_REJECTED",t))),answerBlock:(t)=>x({channel:g,v:_,type:"block-answer",id:E(S),payload:{text:t.trim().slice(0,st)}}),openSurface:(t)=>x({channel:g,v:_,type:"open-surface",id:E(S),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:g,v:_,type:"clipboard-write",id:E(S),payload:{text:t}}),compose:(t)=>x({channel:g,v:_,type:"compose",id:E(S),payload:t}),attach:(t)=>x({channel:g,v:_,type:"attach",id:E(S),payload:ie(t)}),startSession:async(t)=>{if(t.projectId!==void 0)F(t.projectId);let r=t.worktree;if(r&&r!==!0)if(r.kind==="existing")F(r.directory);else{if(r.name!==void 0)F(r.name,200);if(r.baseBranch!==void 0)F(r.baseBranch,200)}let l=await I({channel:g,v:_,type:"start-session",id:E(S),payload:gt(t)},e.requestTimeoutMs??180000);if(!nt(l))throw new a("HOST_REJECTED","Host did not return a session.");return l},prompt:(t)=>I({channel:g,v:_,type:"prompt",id:E(S),payload:_t(t)}).then((r)=>{if(!it(r))throw new a("HOST_REJECTED","Host did not return a prompt result.");return r}),sessionLink:(t)=>x({channel:g,v:_,type:"session-link",id:E(S),payload:ie(t)}),close:()=>x({channel:g,v:_,type:"close",id:E(S)}),oauthStart:()=>x({channel:g,v:_,type:"oauth-start",id:E(S)}),oauthDisconnect:()=>x({channel:g,v:_,type:"oauth-disconnect",id:E(S)}),request:(t)=>(Ge(t.path)?I({channel:g,v:_,type:"request",id:E(S),payload:t}):Nr()).then((r)=>{if(!Me(r))throw new a("HOST_REJECTED","Host request result was empty.");return r}),serviceRequest:(t)=>(Ge(t.path)?I({channel:g,v:_,type:"service-request",id:E(S),payload:t}):Nr()).then((r)=>{if(!Me(r))throw new a("HOST_REJECTED","Host service request result was empty.");return r}),serviceStatus:()=>I({channel:g,v:_,type:"service-status",id:E(S)}).then((t)=>{if(!Rt(t))throw new a("HOST_REJECTED","Host did not return service status.");return t}),tracker:Ct({envelope:y,nextId:()=>E(S),send:I}),readFile:(t)=>(ae(t)?I({channel:g,v:_,type:"file-read",id:E(S),payload:{path:t}}):Ue()).then((r)=>{if(!ft(r))throw new a("HOST_REJECTED","Host did not return file content.");return r}),writeFile:(t,r)=>{if(!ae(t))return Ue();if(r.length>ke)return Promise.reject(new a("FILE_TOO_LARGE",`Content is over ${ke} characters.`));return I({channel:g,v:_,type:"file-write",id:E(S),payload:{path:t,content:r}}).then((l)=>{if(!yt(l))throw new a("HOST_REJECTED","Host did not confirm the write.");return l})},listDir:(t)=>(ae(t)?I({channel:g,v:_,type:"file-list",id:E(S),payload:{path:t}}):Ue()).then((r)=>{if(!ht(r))throw new a("HOST_REJECTED","Host did not return directory entries.");return r}),stat:(t)=>(ae(t)?I({channel:g,v:_,type:"file-stat",id:E(S),payload:{path:t}}):Ue()).then((r)=>{if(!bt(r))throw new a("HOST_REJECTED","Host did not return file status.");return r}),generate:(t)=>{let r=t.prompt.trim(),l=t.system?.trim();if(r.length===0||r.length>Ie)return Promise.reject(new a("HOST_REJECTED",`Prompt must be 1 to ${Ie} characters.`));if(l!==void 0&&(l.length===0||l.length>Pe))return Promise.reject(new a("HOST_REJECTED",`System prompt must be 1 to ${Pe} characters.`));let p=t.maxOutputTokens===void 0?void 0:Math.min(ut,Math.max(1,Math.floor(t.maxOutputTokens)));if(p!==void 0&&!Number.isFinite(p))return Promise.reject(new a("HOST_REJECTED","maxOutputTokens must be a number."));let m={prompt:r};if(l!==void 0)m.system=l;if(p!==void 0)m.maxOutputTokens=p;return I({channel:g,v:_,type:"generate",id:E(S),payload:m},e.requestTimeoutMs??lt).then((T)=>{if(!vt(T))throw new a("HOST_REJECTED","Host did not return generated text.");return T})},onLateGenerateResult:(t)=>{X.add(t);for(let r of W.splice(0))f([t],r);return Vt(),()=>{X.delete(t)}},openMicrophone:qe.open,setBadge:(t)=>x({channel:g,v:_,type:"badge",id:E(S),payload:{count:Tt(t)}}),setHeight:(t)=>x({channel:g,v:_,type:"resize",id:E(S),payload:{height:mt(t)}}),onFileOpen:(t)=>{if(Te.add(t),!Xe)Xe=!0,o.addEventListener("keydown",qt,!0);if(de)t(de);return()=>{Te.delete(t)}},onFileSnapshot:(t)=>(pe=t,()=>{if(pe===t)pe=null}),onFileSaved:(t)=>(me.add(t),()=>{me.delete(t)}),reportFileChange:(t)=>We({...y,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Wt,reportFileUnsupported:()=>We({...y,type:"file-unsupported"}),dispose:()=>{for(let t of oe.keys())N({...y,type:"workspace-unsubscribe",id:E(S),payload:{subscriptionId:t}});oe.clear();for(let t of se.keys())N({...y,type:"shells-unsubscribe",id:E(S),payload:{subscriptionId:t}});if(se.clear(),qe.release(),D=!0,k=null,ce=null,pe=null,Te.clear(),me.clear(),Xe)o.removeEventListener("keydown",qt,!0);o.removeEventListener("message",Xt),o.removeEventListener("keydown",$t,!0),o.removeEventListener("pointerover",fe),o.removeEventListener("pointermove",fe),o.removeEventListener("pointerout",Kt),o.removeEventListener("focus",jt),o.removeEventListener("blur",zt);for(let t of re.values())clearTimeout(t.timer),t.reject(new a("HOST_UNAVAILABLE","Host client was disposed."));re.clear(),u.clear(),c.clear(),A.clear(),h.clear(),U.clear(),w.clear(),O.clear(),J.clear(),V.clear(),q.clear(),Q.clear(),X.clear(),W.length=0}}};var Lr=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var cs=new Set(Lr);var Hr=["none","agent","user"];var ds=new Set(Hr);var ao=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],uo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Dr=(e,o)=>{o.style.colorScheme=e.mode;for(let[s,i]of ao)o.style.setProperty(s,e.tokens[i]);for(let[s,i,u]of uo){let c=e.tokens[u]??"";o.style.setProperty(s,c),o.style.setProperty(i,c)}o.style.setProperty("font-family",e.tokens.font),o.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),o.style.setProperty("line-height","1.45"),o.style.setProperty("color",e.tokens.foreground)},It=(e,o)=>{if(Dr(e.theme,o),o.dataset)o.dataset.ocSurface=e.surface,o.dataset.ocTheme=e.theme.mode};var lo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},R=(e,o)=>`var(--${e}, var(--oc-${lo[e]}, ${o}))`,z=R("surface-background","transparent"),Le=R("surface-elevated","transparent"),ue=R("surface-elevated-foreground","inherit"),H=R("surface-foreground","inherit"),b=R("surface-muted-foreground","gray"),co=R("surface-muted","transparent"),Z=R("interactive-border","currentColor"),L=R("interactive-hover","transparent"),ee=R("interactive-active","transparent"),Pt=R("interactive-selection","transparent"),Gt=R("interactive-selection-foreground","inherit"),j=R("primary","currentColor"),Mt=R("primary-text","inherit"),Ut=R("error-text","inherit"),po=R("font-sans","inherit"),wt=R("font-mono","monospace"),Xr=R("radius","9px"),Nt=`calc(${Xr} - 2px)`,Fr=`calc(${Xr} - 4px)`,v=(e,o,s="transparent")=>`color-mix(in srgb, ${e} ${o}%, ${s})`,Br=`background-image: linear-gradient(${L}, ${L});`,Lt=(e,o="0.5px")=>`box-shadow: inset 0 0 0 ${o} ${e}, var(--oc-sdk-field-lift);`,Ht="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Vr="box-shadow: var(--oc-sdk-lit);",Dt=`inset 0 0.5px 0 0 ${v(H,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,So=`
:root {
  --oc-sdk-edge: ${v(H,16)};
  --oc-sdk-field-bg: ${Le};
  --oc-sdk-raised-bg: ${z};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${v(H,14)};
  --oc-sdk-field-bg: ${v(z,50,Le)};
  --oc-sdk-raised-bg: ${Le};
  --oc-sdk-field-lift: ${Dt};
  --oc-sdk-raised-lift: ${Dt};
  --oc-sdk-lit: ${Dt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ne=(e)=>{let o=R(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${o}; --oc-sdk-tone-text: ${R(`${e}-text`,"inherit")}; }`},n=(e)=>`calc(${e}rem / 14)`,Eo=`
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
`,Wr=`${So}
.oc-sdk { color: ${H}; font-family: ${po}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Br} }
.oc-sdk-mono { font-family: ${wt}; }
.oc-sdk-muted { color: ${b}; }
${Ne("success")}${Ne("warning")}${Ne("error")}${Ne("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${j}; --oc-sdk-tone-text: ${Mt}; }

.oc-sdk-btn { border-radius: ${Nt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Fr}; }
.oc-sdk-btn[data-variant="default"] { color: ${Mt}; background: ${v(j,10,z)}; border-color: ${v(j,12)}; ${Vr} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${v(j,16,z)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${v(j,22,z)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${co}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${ee}, ${ee}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${ue}; ${Ht} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${ee}, ${ee}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${L}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${ee}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${R("status-error","red")}; color: ${Ut}; background: ${v("var(--oc-sdk-tone)",7,z)}; border-color: ${v("var(--oc-sdk-tone)",12)}; ${Vr} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${v("var(--oc-sdk-tone)",9,z)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${v("var(--oc-sdk-tone)",11,z)}; box-shadow: none; }

.oc-sdk-field-note { color: ${b}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Ut}; }
.oc-sdk-input { border-radius: ${Nt}; background: var(--oc-sdk-field-bg); color: ${ue}; ${Lt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${b}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Lt(v(H,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Lt(R("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${wt}; }

.oc-sdk-search-icon { color: ${b}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${j}; }
.oc-sdk-search-clear { border-radius: ${Fr}; color: ${b}; }
.oc-sdk-search-clear:hover { background: ${L}; color: ${H}; }

.oc-sdk-trigger { border-radius: ${Nt}; background: var(--oc-sdk-raised-bg); color: ${ue}; ${Ht} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${ee}, ${ee}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${b}; }
.oc-sdk-trigger-chevron { color: ${b}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${ue}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Le}; background-clip: padding-box; color: ${ue}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${L}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Pt}; color: ${Gt}; }
.oc-sdk-option-check { color: ${H}; }
.oc-sdk-option[data-destructive="true"] { color: ${Ut}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${v(R("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${b}; }
.oc-sdk-popup-empty { color: ${b}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${Z}; border-radius: 4px; color: ${H}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${v(H,60,Z)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${Z}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${z}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${j}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Br} }
.oc-sdk-check-desc { color: ${b}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${v(H,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${b}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${H}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Gt}; background: ${Pt}; border-color: ${Z}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${ue}; background: var(--oc-sdk-raised-bg); ${Ht} }
.oc-sdk-tab-count { color: ${b}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${v(H,6)}; color: ${b}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${v("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${L}; }
.oc-sdk-row[aria-selected="true"] { background: ${Pt}; color: ${Gt}; }
.oc-sdk-row-lead { font-family: ${wt}; color: ${b}; }
.oc-sdk-row-sub { color: ${b}; }
.oc-sdk-row-meta { color: ${b}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${b}; }

.oc-sdk-empty-body { color: ${b}; }

.oc-sdk-spinner { color: ${b}; }
.oc-sdk-spinner-ring { border-color: ${Z}; border-top-color: ${j}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${v("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${b}; }

.oc-sdk-separator { color: ${b}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${v(Z,40)}; }

.oc-sdk-progress-label { color: ${b}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${v(H,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${j}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${R("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${R("success-text","inherit")}; }

.oc-sdk-text a { color: ${Mt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${v(Z,60)}; }
`,P=`
${je}
${Eo}
${Wr}`;var qr="oc-sdk-ui-style";var G=(e)=>{let o=document.getElementById(qr);if(o instanceof HTMLStyleElement){if(o.textContent!==e)o.textContent=e;return}ze(document);let s=document.createElement("style");s.id=qr,s.textContent=e,document.head.appendChild(s)},M=(e,o)=>{let s=document.createElement(e);if(o)s.className=o;return s},Y=(e)=>{let o=M("button",e);return o.type="button",o},B=(e,o)=>{let s=o??"";if(e.textContent!==s)e.textContent=s};var go=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},le=(e,o)=>{G(P);let s=o,i=Y("oc-sdk oc-sdk-btn"),u=go(),c=document.createElement("span");i.append(c),e.append(i);let A=()=>{if(i.dataset.variant=s.variant??"default",i.dataset.size=s.size??"default",i.disabled=Boolean(s.disabled)||Boolean(s.loading),i.dataset.loading=s.loading?"true":"false",i.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&u.parentNode!==i)i.prepend(u);else if(!s.loading&&u.parentNode===i)u.remove();B(c,s.label)},h=()=>{if(s.disabled||s.loading)return;s.onClick()};return i.addEventListener("click",h),A(),{update:(U)=>{s={...s,...U},A()},dispose:()=>{i.removeEventListener("click",h),i.remove()}}};var Ve=kt(),te=document.querySelector("#root");if(!te)throw Error("DeskChart: missing root");te.style.padding="12px";Ve.onReady((e)=>It(e,document.documentElement));Ve.onBlock(({args:e,answered:o})=>{let s=(e.values??"").split(",").map(Number).filter(Number.isFinite),i=Math.max(1,...s);te.replaceChildren();let u=document.createElement("div");u.textContent=e.title??"",u.style.font="600 13px var(--oc-font, system-ui)";let c=document.createElement("div");c.style.cssText="display:flex;align-items:flex-end;gap:6px;height:96px;margin-top:8px";for(let h of s){let U=document.createElement("div");U.style.cssText=`flex:1;height:${h/i*100}%;background:currentColor;opacity:.6;border-radius:3px 3px 0 0`,U.title=String(h),c.append(U)}te.append(u,c);let A=document.createElement("div");A.style.marginTop="10px",te.append(A),le(A,{label:o??"Explain this",variant:"outline",size:"sm",disabled:o!==null,onClick:()=>{Ve.answerBlock("Explain this chart")}})});new ResizeObserver(()=>{Ve.setHeight(Math.ceil(te.getBoundingClientRect().height))}).observe(te);})();
