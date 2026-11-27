(()=>{var g="openchamber.sdk",_=1;var Ze=`
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
`;function et(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(i)=>{let a=i.target===e?r:i.target;if(!(a instanceof Element))return;if(!a.hasAttribute("data-oc-scrolling"))a.setAttribute("data-oc-scrolling","");let l=s.get(a);if(l!==void 0)clearTimeout(l);s.set(a,setTimeout(()=>{s.delete(a),a.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var io=`(${et.toString()})(document);`;var tt=128,rt=65536;var Ae=128;var xe=65536;class u extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var ar=8000,ur=192000,lr=120000;var ao=(e)=>{let r=[],s=0,i=0;return{push:(a)=>{r.push(a),i+=a.length;while(i-s>e&&r.length>1){let l=r.shift();i-=l?.length??0,s=0}},pull:(a)=>{let l=0;while(l<a.length&&r.length>0){let m=r[0],T=Math.min(a.length-l,m.length-s);if(a.set(m.subarray(s,s+T),l),l+=T,s+=T,s>=m.length)r.shift(),i-=m.length,s=0}a.fill(0,l)},clear:()=>{r.length=0,s=0,i=0},get size(){return i-s}}},cr=({isEnabled:e,envelope:r,nextId:s,send:i,postClose:a})=>{let l=null;return{open:async()=>{if(l)throw new u("HOST_REJECTED","The microphone is already open in this frame.");if(!e())throw new u("UNSUPPORTED","This OpenChamber cannot share the microphone with extensions.");let C=globalThis.AudioContext;if(!(C instanceof Function))throw new u("UNSUPPORTED","This frame has no Web Audio.");let x=new C;if(x.sampleRate<ar||x.sampleRate>ur)throw x.close().catch(()=>{return}),new u("UNSUPPORTED",`Audio at ${x.sampleRate} Hz is not supported.`);let J=x.state==="suspended"?x.resume().catch(()=>{return}):void 0,V=ao(Math.round(x.sampleRate/4)),q=x.createScriptProcessor(1024,1,1);q.onaudioprocess=(G)=>V.pull(G.outputBuffer.getChannelData(0));let Q=x.createMediaStreamDestination();q.connect(Q);let X=new Set,W={queue:V,endedListeners:X,release:()=>{q.onaudioprocess=null,q.disconnect(),V.clear();for(let G of Q.stream.getTracks())G.stop();x.close().catch(()=>{return})}};l=W;try{let G=await i({...r,type:"microphone-open",id:s(),payload:{sampleRate:x.sampleRate}},lr);if(!G||!("opened"in G)||G.opened!==!0)throw new u("HOST_REJECTED","Host did not open the microphone.");if(await J,l!==W)throw new u("DISCONNECTED","The microphone closed while it was opening.")}catch(G){if(l===W)l=null;throw W.release(),a(),G}return{stream:Q.stream,close:()=>{if(l!==W)return;l=null,W.release(),a()},onEnded:(G)=>(X.add(G),()=>{X.delete(G)})}},handleMessage:(C)=>{if(C.type==="microphone-audio"){l?.queue.push(C.payload.samples);return}let x=l;if(!x)return;l=null,x.release();for(let J of x.endedListeners)try{J(C.payload.reason)}catch(V){console.error(V)}},release:()=>{if(!l)return;a(),l.release(),l=null}}};var Er=/^[a-z][a-z0-9-]{0,39}$/;var pr=(e)=>Object(e)===e&&!Array.isArray(e),ot=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),dr=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Sr=(e)=>String(e)===e&&e.length>=1&&e.length<=80,gr=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!pr(s)||!Er.test(s.id)||!dr(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!ot(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!ot(s,["kind","id","label","value","options","disabled"]))return!1;if(!Sr(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let i=new Set;for(let a of s.options){if(!pr(a)||!ot(a,["value","label"])||!Sr(a.value)||!dr(a.label)||i.has(a.value))return!1;i.add(a.value)}if(!i.has(s.value))return!1}return!0};var _r=["{id}","{segment}","{segments+}"];var $o=new Set(_r);var Tr=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var Jo=new Set(Tr);var Oe=20000000,Ce=256;var st=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,mr=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0},ke=(e)=>{let r=e,s=e;return{observe:(i)=>{let a=i!==s;return s=i,{edited:a,dirty:i!==r}},markSaved:(i)=>(r=i,s!==i)}};var Rr=/^[A-Za-z0-9_-]{1,80}$/;var fr=["left","right","top","bottom"];var yr=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let i=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let a of i)if(!yr(a,r+1,s))return!1;return!0},nt=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(nt);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(nt)}return String(e)===e||Number.isFinite(e)},it=(e)=>{try{if(String(e.id)!==e.id||!Rr.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!fr.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!yr(e.data)||!nt(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var hr=/^[0-9a-f]{7,64}$/i,br=(e)=>hr.test(e),at=255,vr=(e,r,s)=>({openCommit:(i)=>br(i)?e({channel:g,v:_,type:"open-commit",id:r(),payload:{sha:i}}):s("Commit id must be 7 to 64 hex characters."),openWalkthrough:({base:i})=>{let a=i.trim();if(!a||a.length>at)return s(`Base must contain 1 to ${at} characters.`);return e({channel:g,v:_,type:"open-walkthrough",id:r(),payload:{base:a}})}});var lt=2000;var xr=["file","directory","other","missing"],ct=(e)=>Boolean(e&&"sessionId"in e),pt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Ie=500,Pe=32000,Or=16000,Cr=128,kr=200,Ir=2000,Pr=16000,Gr=80,Mr=200,Ur=16000;var wr=2000;var dt=20000,Ge=1024,Me=2000000;var Ue=64000,we=8000,St=4000;var Et=960000;var Nr=999,Lr=1e4,me=500,gt=128,_t=512,Tt=2048,mt=32,Rt=128,Hr=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],Dr=["stopped","starting","ready","failed"],co=new Set(Hr),Fr=(e)=>co.has(e),Br=(e)=>e&&Fr(e)?e:"HOST_REJECTED",ue=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ue);if(Object(e)===e)return Object.values(e).every(ue);return!1},Vr=(e)=>ue(e)&&JSON.stringify(e).length<=Ur,Ar=(e)=>e?.trim().slice(0,Mr)??"",le=(e)=>{let r=e.id.trim().slice(0,Cr),s=e.title.trim().slice(0,kr),i=e.url.trim().slice(0,Ir),a=e.text?.trim().slice(0,Pr),l=e.author?.trim().slice(0,Gr),m=e.kind==="pull"?"pull":"issue",T={providerId:e.providerId.trim(),id:r,title:s||r,url:i,kind:m};if(a)T.text=a;if(l)T.author=l;if(m==="pull"){let P=Ar(e.branches?.head),C=Ar(e.branches?.base);if(P&&C)T.branches={head:P,base:C}}if(Vr(e.data))T.data=e.data;return T},ft=(e)=>{let r=le(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},yt=(e)=>{let r={text:e.text.trim().slice(0,Or)};if(e.send)r.send=!0;return r},ht=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(Nr,Math.max(0,Math.round(e)))},bt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Lr,Math.max(0,Math.ceil(e)))};var ce=(e)=>e.length>0&&e.length<=Ge&&!e.includes("\x00")&&!e.includes("\\");var Ne=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>wr)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},po=new Set(Dr),vt=(e)=>Boolean(e&&"status"in e&&po.has(String(e.status))&&!("body"in e)),Le=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),At=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),xt=(e)=>Boolean(e&&"written"in e&&e.written===!0),Ot=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),So=new Set(xr),Ct=(e)=>Boolean(e&&"kind"in e&&"size"in e&&So.has(String(e.kind))&&Number.isFinite(e.size)),kt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Eo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late","microphone-audio","microphone-ended"]),go=(e)=>Object(e)===e?e:null,ut=(e)=>String(e)===e&&e.length>0,_o=(e)=>{if(!ut(e.id))return null;if(e.ok===!0){let r={channel:g,v:_,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&ut(e.error))return{channel:g,v:_,type:"result",id:e.id,ok:!1,error:e.error,code:Br(ut(e.code)?e.code:void 0)};return null},It=(e)=>{let r=go(e);if(!r||r.channel!==g||r.v!==_)return null;if(r.type==="result")return _o(r);if(!Eo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var To=(e)=>e==="any"||e==="me"||e==="created",mo=(e)=>e==="all"||e==="none"||e==="urgent"||e==="high"||e==="medium"||e==="low",Gt=(e,r,s)=>{let i=e.trim();if(!i||i.length>r)throw new u("HOST_REJECTED",`${s} must contain 1 to ${r} characters.`);return i},Pt=(e,r,s)=>e===void 0?void 0:Gt(e,r,s),Ro=(e)=>{let r={},s=Pt(e.query,_t,"Query");if(s!==void 0)r.query=s;let i=Pt(e.cursor,Tt,"Cursor");if(i!==void 0)r.cursor=i;let a=Pt(e.state,mt,"State filter");if(a!==void 0)r.state=a;if(e.people!==void 0){if(!To(e.people))throw new u("HOST_REJECTED",`Unknown people filter: ${String(e.people)}`);r.people=e.people}if(e.priority!==void 0){if(!mo(e.priority))throw new u("HOST_REJECTED",`Unknown priority filter: ${String(e.priority)}`);r.priority=e.priority}if(e.containerId===null)r.containerId=null;else if(e.containerId!==void 0)r.containerId=Gt(e.containerId,Rt,"Container id");return r},Xr=(e,r)=>{if(!e||Object(e)!==e)return!1;if(!("op"in e)||!("result"in e))return!1;let s=e.op;if(s!=="list"&&s!=="get"&&s!=="filters")return!1;if(r!==void 0&&s!==r)return!1;let i=e.result;if(!i||Object(i)!==i)return!1;if(s==="filters")return"stateFilters"in i&&Array.isArray(i.stateFilters);if(!("connected"in i))return!1;if(i.connected===!1)return!0;return s==="list"?"items"in i&&Array.isArray(i.items):("item"in i)},Mt=({envelope:e,nextId:r,send:s})=>{let i=async(a)=>{let l=await s({...e,type:"tracker",id:r(),payload:a});if(!Xr(l,a.op))throw new u("HOST_REJECTED","Host did not return tracker data.");return l};return{list:async(a={})=>{let l=await i({op:"list",options:Ro(a)});if(l.op!=="list")throw new u("HOST_REJECTED","Host did not return tracker items.");return l.result},get:async(a)=>{let l=await i({op:"get",id:Gt(a,gt,"Item id")});if(l.op!=="get")throw new u("HOST_REJECTED","Host did not return the tracker item.");return l.result},filters:async()=>{let a=await i({op:"filters"});if(a.op!=="filters")throw new u("HOST_REJECTED","Host did not return tracker filters.");return a.result}}};var Wr=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),fo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s",qr=()=>Promise.reject(new u("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),He=()=>Promise.reject(new u("BAD_PATH",`File path must be 1 to ${Ge} characters without NUL or backslash.`)),De=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new u("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},E=(e)=>(e.value+=1,`oc-${e.value}`),Ut=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new u("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),i=e.requestTimeoutMs??dt,a=new Set,l=new Set,m=new Set,T=new Set,P=new Set,C=new Set,x=new Set,J=new Set,V=new Set,q=new Set,Q=new Set,X=new Set,W=[],G=null,Se=null,fe=new Set,ye=new Set,Ee=null,ge=null,je=!1,ne=new Map,ie=new Map,ae=new Map,F=!1,S={value:0},d=null,K=null,_e=!1,Te=!1,zt=null,Jt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},N=(t)=>{r.parent.postMessage(t,"*")},Qt=()=>{if(F||r.parent===r||X.size===0||d?.features?.lateGenerateResults!==!0)return;N({channel:g,v:_,type:"generate-late-listen"})},h=(t,o)=>{for(let c of t)try{c(o)}catch(p){console.error(p)}},Yt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=It(t.data);if(!o)return;if(o.type==="workspace"){let p=ie.get(o.payload.subscriptionId);if(p)h([p],o.payload.snapshot);return}if(o.type==="shells"){let p=ae.get(o.payload.subscriptionId);if(p)h([p],o.payload.snapshot);return}if(o.type==="microphone-audio"||o.type==="microphone-ended"){Je.handleMessage(o);return}if(o.type==="ready"){if(d=o.payload,K=Jt(o.payload.session),h(a,o.payload),h(l,o.payload.directory),h(m,o.payload.session),K)h(T,K);if(h(P,o.payload.connection),h(C,o.payload.settings),h(x,o.payload.item),o.payload.block)h(J,o.payload.block);Qt();return}if(o.type==="service-event"){h(V,o.payload);return}if(o.type==="generate-late"){if(X.size===0)W.push(o.payload);else h(X,o.payload);return}if(o.type==="directory"){if(d)d={...d,directory:o.payload.directory};h(l,o.payload.directory);return}if(o.type==="session"){if(d)d={...d,session:o.payload.session};if(!o.payload.session)K=null;else if(K?.sessionId!==o.payload.session.id)K=Jt(o.payload.session);h(m,o.payload.session);return}if(o.type==="session-lifecycle"){K=o.payload,h(T,o.payload);return}if(o.type==="connection"){if(d)d={...d,connection:o.payload.connection};h(P,o.payload.connection);return}if(o.type==="settings"){if(d)d={...d,settings:o.payload.settings};h(C,o.payload.settings);return}if(o.type==="item"){if(d)d={...d,item:o.payload.item};h(x,o.payload.item);return}if(o.type==="status-control-event"){h(q,o.payload);return}if(o.type==="popover-closed"){h(Q,o.payload);return}if(o.type==="action"){let p=(R)=>{if(!F)N({channel:g,v:_,type:"action-result",id:o.id,payload:R})},f=Se;if(!f){p({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>f(o.payload)).then(()=>p({ok:!0}),(R)=>{let k=(R instanceof Error?R.message:String(R)).trim();p({ok:!1,error:(k||"Action failed.").slice(0,me)})});return}if(o.type==="file-open"){let p=o.payload;if(ge&&mr(ge,p))return;ge=p,h(fe,o.payload);return}if(o.type==="file-saved"){h(ye,o.payload.version);return}if(o.type==="file-snapshot"){let p=(k)=>{if(!F)N({channel:g,v:_,type:"file-snapshot-result",id:o.id,payload:k})},f=(k)=>p({error:(k.trim()||"Could not read the edited file.").slice(0,me)}),R=Ee;if(!R){f("This extension does not edit files.");return}Promise.resolve().then(()=>R(o.payload.purpose)).then((k)=>{if(st(k)>Oe){f(`The file is over ${Oe} ${"bytes"in k?"bytes":"characters"}.`);return}if(k.version.length>Ce){f(`The snapshot version is over ${Ce} characters.`);return}p({snapshot:"bytes"in k?{bytes:k.bytes,version:k.version}:{content:k.content,version:k.version}})},(k)=>f(k instanceof Error?k.message:String(k)));return}if(o.type==="resolve"){let p=(R)=>{N({channel:g,v:_,type:"resolve-result",id:o.id,payload:R})},f=G;if(!f){p({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>f(o.payload)).then((R)=>p({item:R?le(R):null}),(R)=>{let k=(R instanceof Error?R.message:String(R)).trim();p({error:(k||"Command failed.").slice(0,me)})});return}let c=ne.get(o.id);if(!c)return;if(clearTimeout(c.timer),ne.delete(o.id),o.ok){c.resolve(o.payload);return}c.reject(new u(o.code,o.error))};r.addEventListener("message",Yt),N({channel:g,v:_,type:"hello"});let M=(t,o=i)=>{if(F||r.parent===r)return Promise.reject(new u("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((c,p)=>{let f=setTimeout(()=>{ne.delete(t.id),p(new u("HOST_TIMEOUT","Host did not answer in time."))},o);ne.set(t.id,{resolve:c,reject:p,timer:f}),N(t)})},O=(t)=>M(t).then(()=>{return}),b={channel:g,v:_},ze=(t)=>{if(!F&&r.parent!==r)N(t)},Zt=()=>ze({...b,type:"file-save"}),Je=cr({isEnabled:()=>d?.features?.microphone===!0,envelope:b,nextId:()=>E(S),send:M,postClose:()=>{if(!F&&r.parent!==r)N({...b,type:"microphone-close",id:E(S)})}}),er=(t)=>{if(!Wr(t)||!fo(t))return;t.preventDefault(),Zt()},tr=(t)=>{if(!Wr(t)||t.key!=="Escape"||d?.surface!=="popover"||!d.popover)return;t.preventDefault(),nr(d.popover.id,"escape").catch(()=>{return})},he=()=>{let t=d?.surface==="popover"?d.popover:void 0;if(!t)return;let o=_e||Te;if(zt===o)return;zt=o,ir(t.id,o).catch(()=>{return})},be=()=>{if(d?.surface!=="popover"||_e)return;_e=!0,he()},rr=(t)=>{if(d?.surface!=="popover"||t.relatedTarget!==null||!_e)return;_e=!1,he()},or=()=>{if(d?.surface!=="popover"||Te)return;Te=!0,he()},sr=()=>{if(d?.surface!=="popover"||!Te)return;Te=!1,he()},B=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new u("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Qe=async(t)=>{if(t.kind!=="projects")B(t.projectId);let o=await M({...b,type:"workspace-read",id:E(S),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new u("HOST_REJECTED","Host did not return workspace data.");return o},Ye=async(t,o)=>{if(t.kind!=="projects")B(t.projectId);let c=E(S);ie.set(c,o);try{await O({...b,type:"workspace-subscribe",id:E(S),payload:{subscriptionId:c,query:t}})}catch(p){if(ie.delete(c),!F)N({...b,type:"workspace-unsubscribe",id:E(S),payload:{subscriptionId:c}});throw p}return()=>{if(!ie.delete(c)||F)return;N({...b,type:"workspace-unsubscribe",id:E(S),payload:{subscriptionId:c}})}},no=async(t,o)=>{if(t.kind==="session")B(t.sessionId);if(t.kind==="project")B(t.projectId);let c=E(S);ae.set(c,o);try{await O({...b,type:"shells-subscribe",id:E(S),payload:{subscriptionId:c,scope:t}})}catch(p){if(ae.delete(c),!F)N({...b,type:"shells-unsubscribe",id:E(S),payload:{subscriptionId:c}});throw p}return()=>{if(!ae.delete(c)||F)return;N({...b,type:"shells-unsubscribe",id:E(S),payload:{subscriptionId:c}})}},ve=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>tt))throw new u("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ue(t.value))throw new u("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>rt)throw new u("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&d?.features?.deviceStorage!==!0)throw new u("UNSUPPORTED","This host does not support device storage.");let o=await M({...b,type:"storage",id:E(S),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new u("HOST_REJECTED","Host did not return storage data.");return o},nr=(t,o)=>d?.features?.popovers!==!0&&!(d?.surface==="popover"&&d.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):O({...b,type:"popover-close",id:E(S),payload:o?{id:t,reason:o}:{id:t}}),ir=(t,o)=>d?.features?.popovers!==!0&&!(d?.surface==="popover"&&d.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):O({...b,type:"popover-anchor",id:E(S),payload:{id:t,active:o}});return r.addEventListener("keydown",tr,!0),r.addEventListener("pointerover",be),r.addEventListener("pointermove",be),r.addEventListener("pointerout",rr),r.addEventListener("focus",or),r.addEventListener("blur",sr),{onAction:(t)=>(Se=t,()=>{if(Se===t)Se=null}),listProjects:async()=>{let t=await Qe({kind:"projects"});if(t.kind!=="projects")throw new u("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Qe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new u("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Qe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new u("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Ye({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Ye({kind:"worktrees",projectId:t},(c)=>{if(c.kind==="worktrees")o(c)}),onSessions:(t,o)=>Ye({kind:"sessions",projectId:t},(c)=>{if(c.kind==="sessions")o(c)}),onRunningShells:(t,o)=>no(t,o),readShellOutput:async(t,o)=>{B(t,Ae);let c=o?.cursor;if(c!==void 0&&(!Number.isInteger(c)||c<0))throw new u("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let p=o?.tailBytes;if(p!==void 0&&(!Number.isInteger(p)||p<1||p>xe))throw new u("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${xe}.`);let R=await M({...b,type:"shell-output",id:E(S),payload:{shellId:t,cursor:c,tailBytes:p}});if(!R||typeof R.output!=="string"||!Number.isFinite(R.cursor))throw new u("HOST_REJECTED","Host did not return shell output.");return R},stopShell:async(t)=>{if(B(t,Ae),(await M({...b,type:"shell-stop",id:E(S),payload:{shellId:t}}))?.stopped!==!0)throw new u("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{B(t),await O({...b,type:"open-session",id:E(S),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let c=De(o),p={op:"get",key:t};if(c)p.scope=c;let f=await ve(p);return f.op==="get"&&f.found?f.value:void 0},set:async(t,o,c)=>{let p=De(c),f={op:"set",key:t,value:o};if(p)f.scope=p;await ve(f)},delete:async(t,o)=>{let c=De(o),p={op:"delete",key:t};if(c)p.scope=c;await ve(p)},keys:async(t)=>{let o=De(t),c={op:"keys"};if(o)c.scope=o;let p=await ve(c);if(p.op!=="keys")throw new u("HOST_REJECTED","Expected storage keys.");return p.keys}},onReady:(t)=>{if(a.add(t),d)t(d);return()=>{a.delete(t)}},onDirectory:(t)=>{if(l.add(t),d)t(d.directory);return()=>{l.delete(t)}},onSession:(t)=>{if(m.add(t),d)t(d.session);return()=>{m.delete(t)}},onSessionLifecycle:(t)=>{if(T.add(t),K)t(K);return()=>{T.delete(t)}},onConnection:(t)=>{if(P.add(t),d)t(d.connection);return()=>{P.delete(t)}},onSettings:(t)=>{if(C.add(t),d)t(d.settings);return()=>{C.delete(t)}},onItem:(t)=>{if(x.add(t),d)t(d.item);return()=>{x.delete(t)}},onBlock:(t)=>{if(J.add(t),d?.block)t(d.block);return()=>{J.delete(t)}},onServiceEvent:(t)=>(V.add(t),()=>{V.delete(t)}),onStatusControl:(t)=>(q.add(t),()=>{q.delete(t)}),onPopoverClosed:(t)=>(Q.add(t),()=>{Q.delete(t)}),setStatusControls:(t)=>{if(d?.features?.statusControls!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support status controls."));if(!gr(t))return Promise.reject(new u("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return O({...b,type:"status-controls",id:E(S),payload:{controls:t}})},openPopover:(t)=>{if(d?.features?.popovers!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support popovers."));if(!it(t))return Promise.reject(new u("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return O({...b,type:"popover-open",id:E(S),payload:t})},closePopover:nr,setPopoverAnchorActive:ir,onResolve:(t)=>(G=t,()=>{if(G===t)G=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Ie)return Promise.reject(new u("HOST_REJECTED",`Toast message must contain 1 to ${Ie} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Pe))return Promise.reject(new u("HOST_REJECTED",`Toast copy text must contain 1 to ${Pe} characters.`));return O({channel:g,v:_,type:"toast",id:E(S),payload:{...t,message:o}})},openUrl:(t)=>O({channel:g,v:_,type:"open-url",id:E(S),payload:{url:t}}),...vr(O,()=>E(S),(t)=>Promise.reject(new u("HOST_REJECTED",t))),answerBlock:(t)=>O({channel:g,v:_,type:"block-answer",id:E(S),payload:{text:t.trim().slice(0,lt)}}),openSurface:(t)=>O({channel:g,v:_,type:"open-surface",id:E(S),payload:{surfaceId:t}}),writeClipboard:(t)=>O({channel:g,v:_,type:"clipboard-write",id:E(S),payload:{text:t}}),compose:(t)=>O({channel:g,v:_,type:"compose",id:E(S),payload:t}),attach:(t)=>O({channel:g,v:_,type:"attach",id:E(S),payload:le(t)}),startSession:async(t)=>{if(t.projectId!==void 0)B(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")B(o.directory);else{if(o.name!==void 0)B(o.name,200);if(o.baseBranch!==void 0)B(o.baseBranch,200)}let c=await M({channel:g,v:_,type:"start-session",id:E(S),payload:ft(t)},e.requestTimeoutMs??180000);if(!ct(c))throw new u("HOST_REJECTED","Host did not return a session.");return c},prompt:(t)=>M({channel:g,v:_,type:"prompt",id:E(S),payload:yt(t)}).then((o)=>{if(!pt(o))throw new u("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>O({channel:g,v:_,type:"session-link",id:E(S),payload:le(t)}),close:()=>O({channel:g,v:_,type:"close",id:E(S)}),oauthStart:()=>O({channel:g,v:_,type:"oauth-start",id:E(S)}),oauthDisconnect:()=>O({channel:g,v:_,type:"oauth-disconnect",id:E(S)}),request:(t)=>(Ne(t.path)?M({channel:g,v:_,type:"request",id:E(S),payload:t}):qr()).then((o)=>{if(!Le(o))throw new u("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ne(t.path)?M({channel:g,v:_,type:"service-request",id:E(S),payload:t}):qr()).then((o)=>{if(!Le(o))throw new u("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>M({channel:g,v:_,type:"service-status",id:E(S)}).then((t)=>{if(!vt(t))throw new u("HOST_REJECTED","Host did not return service status.");return t}),tracker:Mt({envelope:b,nextId:()=>E(S),send:M}),readFile:(t)=>(ce(t)?M({channel:g,v:_,type:"file-read",id:E(S),payload:{path:t}}):He()).then((o)=>{if(!At(o))throw new u("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!ce(t))return He();if(o.length>Me)return Promise.reject(new u("FILE_TOO_LARGE",`Content is over ${Me} characters.`));return M({channel:g,v:_,type:"file-write",id:E(S),payload:{path:t,content:o}}).then((c)=>{if(!xt(c))throw new u("HOST_REJECTED","Host did not confirm the write.");return c})},listDir:(t)=>(ce(t)?M({channel:g,v:_,type:"file-list",id:E(S),payload:{path:t}}):He()).then((o)=>{if(!Ot(o))throw new u("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(ce(t)?M({channel:g,v:_,type:"file-stat",id:E(S),payload:{path:t}}):He()).then((o)=>{if(!Ct(o))throw new u("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),c=t.system?.trim();if(o.length===0||o.length>Ue)return Promise.reject(new u("HOST_REJECTED",`Prompt must be 1 to ${Ue} characters.`));if(c!==void 0&&(c.length===0||c.length>we))return Promise.reject(new u("HOST_REJECTED",`System prompt must be 1 to ${we} characters.`));let p=t.maxOutputTokens===void 0?void 0:Math.min(St,Math.max(1,Math.floor(t.maxOutputTokens)));if(p!==void 0&&!Number.isFinite(p))return Promise.reject(new u("HOST_REJECTED","maxOutputTokens must be a number."));let f={prompt:o};if(c!==void 0)f.system=c;if(p!==void 0)f.maxOutputTokens=p;return M({channel:g,v:_,type:"generate",id:E(S),payload:f},e.requestTimeoutMs??Et).then((R)=>{if(!kt(R))throw new u("HOST_REJECTED","Host did not return generated text.");return R})},onLateGenerateResult:(t)=>{X.add(t);for(let o of W.splice(0))h([t],o);return Qt(),()=>{X.delete(t)}},openMicrophone:Je.open,setBadge:(t)=>O({channel:g,v:_,type:"badge",id:E(S),payload:{count:ht(t)}}),setHeight:(t)=>O({channel:g,v:_,type:"resize",id:E(S),payload:{height:bt(t)}}),onFileOpen:(t)=>{if(fe.add(t),!je)je=!0,r.addEventListener("keydown",er,!0);if(ge)t(ge);return()=>{fe.delete(t)}},onFileSnapshot:(t)=>(Ee=t,()=>{if(Ee===t)Ee=null}),onFileSaved:(t)=>(ye.add(t),()=>{ye.delete(t)}),reportFileChange:(t)=>ze({...b,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Zt,reportFileUnsupported:()=>ze({...b,type:"file-unsupported"}),dispose:()=>{for(let t of ie.keys())N({...b,type:"workspace-unsubscribe",id:E(S),payload:{subscriptionId:t}});ie.clear();for(let t of ae.keys())N({...b,type:"shells-unsubscribe",id:E(S),payload:{subscriptionId:t}});if(ae.clear(),Je.release(),F=!0,G=null,Se=null,Ee=null,fe.clear(),ye.clear(),je)r.removeEventListener("keydown",er,!0);r.removeEventListener("message",Yt),r.removeEventListener("keydown",tr,!0),r.removeEventListener("pointerover",be),r.removeEventListener("pointermove",be),r.removeEventListener("pointerout",rr),r.removeEventListener("focus",or),r.removeEventListener("blur",sr);for(let t of ne.values())clearTimeout(t.timer),t.reject(new u("HOST_UNAVAILABLE","Host client was disposed."));ne.clear(),a.clear(),l.clear(),m.clear(),T.clear(),P.clear(),C.clear(),x.clear(),J.clear(),V.clear(),q.clear(),Q.clear(),X.clear(),W.length=0}}};var $r=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var vs=new Set($r);var Kr=["none","agent","user"];var xs=new Set(Kr);var yo=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],ho=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],jr=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,i]of yo)r.style.setProperty(s,e.tokens[i]);for(let[s,i,a]of ho){let l=e.tokens[a]??"";r.style.setProperty(s,l),r.style.setProperty(i,l)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},wt=(e,r)=>{if(jr(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var bo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${bo[e]}, ${r}))`,z=y("surface-background","transparent"),Be=y("surface-elevated","transparent"),pe=y("surface-elevated-foreground","inherit"),H=y("surface-foreground","inherit"),v=y("surface-muted-foreground","gray"),vo=y("surface-muted","transparent"),te=y("interactive-border","currentColor"),L=y("interactive-hover","transparent"),re=y("interactive-active","transparent"),Nt=y("interactive-selection","transparent"),Lt=y("interactive-selection-foreground","inherit"),j=y("primary","currentColor"),Ht=y("primary-text","inherit"),Dt=y("error-text","inherit"),Ao=y("font-sans","inherit"),Ft=y("font-mono","monospace"),Yr=y("radius","9px"),Bt=`calc(${Yr} - 2px)`,zr=`calc(${Yr} - 4px)`,A=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,Jr=`background-image: linear-gradient(${L}, ${L});`,Vt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Xt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Qr="box-shadow: var(--oc-sdk-lit);",Wt=`inset 0 0.5px 0 0 ${A(H,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,xo=`
:root {
  --oc-sdk-edge: ${A(H,16)};
  --oc-sdk-field-bg: ${Be};
  --oc-sdk-raised-bg: ${z};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${A(H,14)};
  --oc-sdk-field-bg: ${A(z,50,Be)};
  --oc-sdk-raised-bg: ${Be};
  --oc-sdk-field-lift: ${Wt};
  --oc-sdk-raised-lift: ${Wt};
  --oc-sdk-lit: ${Wt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Fe=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},n=(e)=>`calc(${e}rem / 14)`,Oo=`
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
`,Zr=`${xo}
.oc-sdk { color: ${H}; font-family: ${Ao}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Jr} }
.oc-sdk-mono { font-family: ${Ft}; }
.oc-sdk-muted { color: ${v}; }
${Fe("success")}${Fe("warning")}${Fe("error")}${Fe("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${j}; --oc-sdk-tone-text: ${Ht}; }

.oc-sdk-btn { border-radius: ${Bt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${zr}; }
.oc-sdk-btn[data-variant="default"] { color: ${Ht}; background: ${A(j,10,z)}; border-color: ${A(j,12)}; ${Qr} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${A(j,16,z)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${A(j,22,z)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${vo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${re}, ${re}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${pe}; ${Xt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${re}, ${re}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${L}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${re}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${Dt}; background: ${A("var(--oc-sdk-tone)",7,z)}; border-color: ${A("var(--oc-sdk-tone)",12)}; ${Qr} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${A("var(--oc-sdk-tone)",9,z)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${A("var(--oc-sdk-tone)",11,z)}; box-shadow: none; }

.oc-sdk-field-note { color: ${v}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Dt}; }
.oc-sdk-input { border-radius: ${Bt}; background: var(--oc-sdk-field-bg); color: ${pe}; ${Vt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${v}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Vt(A(H,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Vt(y("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Ft}; }

.oc-sdk-search-icon { color: ${v}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${j}; }
.oc-sdk-search-clear { border-radius: ${zr}; color: ${v}; }
.oc-sdk-search-clear:hover { background: ${L}; color: ${H}; }

.oc-sdk-trigger { border-radius: ${Bt}; background: var(--oc-sdk-raised-bg); color: ${pe}; ${Xt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${L}, ${L}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${re}, ${re}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${v}; }
.oc-sdk-trigger-chevron { color: ${v}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${pe}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Be}; background-clip: padding-box; color: ${pe}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${L}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Nt}; color: ${Lt}; }
.oc-sdk-option-check { color: ${H}; }
.oc-sdk-option[data-destructive="true"] { color: ${Dt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${A(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${v}; }
.oc-sdk-popup-empty { color: ${v}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${te}; border-radius: 4px; color: ${H}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${A(H,60,te)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${te}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${z}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${j}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Jr} }
.oc-sdk-check-desc { color: ${v}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${A(H,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${v}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${H}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Lt}; background: ${Nt}; border-color: ${te}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${pe}; background: var(--oc-sdk-raised-bg); ${Xt} }
.oc-sdk-tab-count { color: ${v}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${A(H,6)}; color: ${v}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${A("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${L}; }
.oc-sdk-row[aria-selected="true"] { background: ${Nt}; color: ${Lt}; }
.oc-sdk-row-lead { font-family: ${Ft}; color: ${v}; }
.oc-sdk-row-sub { color: ${v}; }
.oc-sdk-row-meta { color: ${v}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${v}; }

.oc-sdk-empty-body { color: ${v}; }

.oc-sdk-spinner { color: ${v}; }
.oc-sdk-spinner-ring { border-color: ${te}; border-top-color: ${j}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${A("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${v}; }

.oc-sdk-separator { color: ${v}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${A(te,40)}; }

.oc-sdk-progress-label { color: ${v}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${A(H,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${j}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${y("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${y("success-text","inherit")}; }

.oc-sdk-text a { color: ${Ht}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${A(te,60)}; }
`,U=`
${Ze}
${Oo}
${Zr}`;var eo="oc-sdk-ui-style";var w=(e)=>{let r=document.getElementById(eo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}et(document);let s=document.createElement("style");s.id=eo,s.textContent=e,document.head.appendChild(s)},I=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},Y=(e)=>{let r=I("button",e);return r.type="button",r},D=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var Co=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},Z=(e,r)=>{w(U);let s=r,i=Y("oc-sdk oc-sdk-btn"),a=Co(),l=document.createElement("span");i.append(l),e.append(i);let m=()=>{if(i.dataset.variant=s.variant??"default",i.dataset.size=s.size??"default",i.disabled=Boolean(s.disabled)||Boolean(s.loading),i.dataset.loading=s.loading?"true":"false",i.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&a.parentNode!==i)i.prepend(a);else if(!s.loading&&a.parentNode===i)a.remove();D(l,s.label)},T=()=>{if(s.disabled||s.loading)return;s.onClick()};return i.addEventListener("click",T),m(),{update:(P)=>{s={...s,...P},m()},dispose:()=>{i.removeEventListener("click",T),i.remove()}}};var qt=(e,r)=>{w(U);let s=r,i=I("div","oc-sdk oc-sdk-empty"),a=I("h2","oc-sdk-empty-title"),l=I("p","oc-sdk-empty-body"),m=I("div","oc-sdk-empty-action");i.append(a,l,m),e.append(i);let T=null,P=()=>{if(D(a,s.title),D(l,s.body),l.hidden=!s.body,m.hidden=!s.action,!s.action){T?.dispose(),T=null;return}let C={label:s.action.label,onClick:s.action.onClick};if(T)T.update(C);else T=Z(m,{...C,variant:"outline",size:"sm"})};return P(),{update:(C)=>{s={...s,...C},P()},dispose:()=>{T?.dispose(),T=null,i.remove()}}};var Mo=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,to=(e)=>e.split(`
`).map((r)=>{let s=Mo.exec(r);return s?{kind:"item",prefix:s[1]??"- ",done:s[2]!==" ",text:s[3]??""}:{kind:"text",text:r}}),ro=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),$e=(e)=>{let r=2166136261;for(let s=0;s<e.length;s+=1)r^=e.charCodeAt(s),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},oo=(e,r)=>{let s=-1,i="- ";e.forEach((T,P)=>{if(T.kind!=="item")return;s=P,i=T.prefix});let a={kind:"item",prefix:i,done:!1,text:r};if(s>=0)return[...e.slice(0,s+1),a,...e.slice(s+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],a,{kind:"text",text:""}]};var se=Ut(),oe=document.querySelector("#root");if(!oe)throw Error("Missing root");var so=document.createElement("style");so.textContent=`
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
`;document.head.append(so);se.onReady((e)=>wt(e,document.documentElement));var ee=[],de=!1,Kt=ke(null),jt=()=>ro(ee),Ke=()=>{se.reportFileChange(Kt.observe($e(jt())))},$t=()=>{if(oe.replaceChildren(),!ee.some((r)=>r.kind==="item")&&de){qt(oe,{title:"No items",body:"This checklist is empty."});return}if(ee.forEach((r,s)=>{if(r.kind==="text"){let m=document.createElement("p");m.className="note",m.textContent=r.text,oe.append(m);return}let i=document.createElement("div");i.className=r.done?"item done":"item";let a=document.createElement("input");a.type="checkbox",a.checked=r.done,a.disabled=de,a.addEventListener("change",()=>{r.done=a.checked,i.className=r.done?"item done":"item",Ke()});let l=document.createElement("input");if(l.type="text",l.value=r.text,l.readOnly=de,l.setAttribute("aria-label","Item"),l.addEventListener("input",()=>{r.text=l.value,Ke()}),i.append(a,l),!de){let m=document.createElement("span");m.className="remove",Z(m,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{ee=ee.filter((T,P)=>P!==s),Ke(),$t()}}),i.append(m)}oe.append(i)}),de)return;let e=document.createElement("div");e.className="actions",Z(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{ee=oo(ee,""),Ke(),$t();let r=oe.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),oe.append(e)};se.onFileOpen((e)=>{if(e.encoding!=="text"){se.reportFileUnsupported();return}ee=to(e.content),de=e.readOnly,Kt=ke($e(jt())),$t()});se.onFileSnapshot(()=>{let e=jt();return{content:e,version:$e(e)}});se.onFileSaved((e)=>{se.reportFileChange({dirty:Kt.markSaved(e),edited:!1})});})();
