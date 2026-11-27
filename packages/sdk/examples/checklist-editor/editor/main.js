(()=>{var _="openchamber.sdk",T=1;var rt=`
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
`;function st(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(i)=>{let a=i.target===e?r:i.target;if(!(a instanceof Element))return;if(!a.hasAttribute("data-oc-scrolling"))a.setAttribute("data-oc-scrolling","");let E=s.get(a);if(E!==void 0)clearTimeout(E);s.set(a,setTimeout(()=>{s.delete(a),a.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var rr=`(${st.toString()})(document);`;var nt=128,it=65536;var xe=128;var Ce=65536;var at=8000,lt=192000,ut=120000;var io=(e)=>{let r=[],s=0,i=0;return{push:(a)=>{r.push(a),i+=a.length;while(i-s>e&&r.length>1){let E=r.shift();i-=E?.length??0,s=0}},pull:(a)=>{let E=0;while(E<a.length&&r.length>0){let m=r[0],g=Math.min(a.length-E,m.length-s);if(a.set(m.subarray(s,s+g),E),E+=g,s+=g,s>=m.length)r.shift(),i-=m.length,s=0}a.fill(0,E)},clear:()=>{r.length=0,s=0,i=0},get size(){return i-s}}};var co=/^[a-z][a-z0-9-]{0,39}$/;var ao=(e)=>Object(e)===e&&!Array.isArray(e),ct=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),lo=(e)=>String(e)===e&&e.length>=1&&e.length<=60,uo=(e)=>String(e)===e&&e.length>=1&&e.length<=80,po=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!ao(s)||!co.test(s.id)||!lo(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!ct(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!ct(s,["kind","id","label","value","options","disabled"]))return!1;if(!uo(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let i=new Set;for(let a of s.options){if(!ao(a)||!ct(a,["value","label"])||!uo(a.value)||!lo(a.label)||i.has(a.value))return!1;i.add(a.value)}if(!i.has(s.value))return!1}return!0};var So=["{id}","{segment}","{segments+}"];var Nr=new Set(So);var Eo=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var Fr=new Set(Eo);var ke=20000000,Ie=256;var pt=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,go=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0},Pe=(e)=>{let r=e,s=e;return{observe:(i)=>{let a=i!==s;return s=i,{edited:a,dirty:i!==r}},markSaved:(i)=>(r=i,s!==i)}};var _o=/^[A-Za-z0-9_-]{1,80}$/;var To=["left","right","top","bottom"];var mo=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let i=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let a of i)if(!mo(a,r+1,s))return!1;return!0},dt=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(dt);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(dt)}return String(e)===e||Number.isFinite(e)},St=(e)=>{try{if(String(e.id)!==e.id||!_o.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!To.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!mo(e.data)||!dt(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var Ro=/^[0-9a-f]{7,64}$/i,ho=(e)=>Ro.test(e),Et=255,fo=(e,r,s)=>({openCommit:(i)=>ho(i)?e({channel:_,v:T,type:"open-commit",id:r(),payload:{sha:i}}):s("Commit id must be 7 to 64 hex characters."),openWalkthrough:({base:i})=>{let a=i.trim();if(!a||a.length>Et)return s(`Base must contain 1 to ${Et} characters.`);return e({channel:_,v:T,type:"open-walkthrough",id:r(),payload:{base:a}})}});var _t=2000;var bo=["file","directory","other","missing"],Tt=(e)=>Boolean(e&&"sessionId"in e),mt=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Me=500,Ge=32000,vo=16000,Ao=128,Oo=200,Ue=2000,xo=16000,Co=80,ko=200,Io=16000;var Po=2000;var Rt=20000,we=1024,Ne=2000000;var Le=64000,De=8000,ht=4000;var ft=960000;var Mo=999,Go=1e4,_e=500,Uo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],wo=["stopped","starting","ready","failed"],ir=new Set(Uo),No=(e)=>ir.has(e),Lo=(e)=>e&&No(e)?e:"HOST_REJECTED",ne=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ne);if(Object(e)===e)return Object.values(e).every(ne);return!1},Do=(e)=>ne(e)&&JSON.stringify(e).length<=Io,yo=(e)=>e?.trim().slice(0,ko)??"",z=(e)=>{let r=e.id.trim().slice(0,Ao),s=e.title.trim().slice(0,Oo),i=e.url.trim().slice(0,Ue),a=e.text?.trim().slice(0,xo),E=e.author?.trim().slice(0,Co),m=e.kind==="pull"?"pull":"issue",g={providerId:e.providerId.trim(),id:r,title:s||r,url:i,kind:m};if(a)g.text=a;if(E)g.author=E;if(m==="pull"){let C=yo(e.branches?.head),M=yo(e.branches?.base);if(C&&M)g.branches={head:C,base:M}}if(Do(e.data))g.data=e.data;return g},yt=(e)=>{let r=z(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},bt=(e)=>{let r={text:e.text.trim().slice(0,vo)};if(e.send)r.send=!0;return r},vt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(Mo,Math.max(0,Math.round(e)))},At=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Go,Math.max(0,Math.ceil(e)))};var ie=(e)=>e.length>0&&e.length<=we&&!e.includes("\x00")&&!e.includes("\\");var He=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>Po)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},ar=new Set(wo),Ot=(e)=>Boolean(e&&"status"in e&&ar.has(String(e.status))&&!("body"in e)),Fe=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),xt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),Ct=(e)=>Boolean(e&&"written"in e&&e.written===!0),kt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),lr=new Set(bo),It=(e)=>Boolean(e&&"kind"in e&&"size"in e&&lr.has(String(e.kind))&&Number.isFinite(e.size)),Pt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),ur=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late","microphone-audio","microphone-ended"]),cr=(e)=>Object(e)===e?e:null,gt=(e)=>String(e)===e&&e.length>0,pr=(e)=>{if(!gt(e.id))return null;if(e.ok===!0){let r={channel:_,v:T,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&gt(e.error))return{channel:_,v:T,type:"result",id:e.id,ok:!1,error:e.error,code:Lo(gt(e.code)?e.code:void 0)};return null},Mt=(e)=>{let r=cr(e);if(!r||r.channel!==_||r.v!==T)return null;if(r.type==="result")return pr(r);if(!ur.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var Ho=(e,r,s,i)=>{let a={channel:_,v:T},E=(g)=>g!==void 0&&(!g.trim()||g.length>1024),m=()=>s("UNSUPPORTED","This OpenChamber cannot target a session or remove a link.");return{sessionLink:(g)=>{if(E(g.sessionId))return s("HOST_REJECTED","Identity must contain 1 to 1024 characters.");if(g.sessionId!==void 0&&!i())return m();return e({...a,type:"session-link",id:r(),payload:{...z(g),sessionId:g.sessionId}})},sessionUnlink:({url:g,sessionId:C})=>{if(E(C))return s("HOST_REJECTED","Identity must contain 1 to 1024 characters.");if(!i())return m();let M=g.trim().slice(0,Ue);if(!M)return s("BAD_PATH","A link URL is required.");return e({...a,type:"session-unlink",id:r(),payload:{url:M,sessionId:C}})}}};var Fo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),dr=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class c extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Bo=()=>Promise.reject(new c("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Be=()=>Promise.reject(new c("BAD_PATH",`File path must be 1 to ${we} characters without NUL or backslash.`)),Ve=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new c("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},S=(e)=>(e.value+=1,`oc-${e.value}`),Gt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new c("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),i=e.requestTimeoutMs??Rt,a=new Set,E=new Set,m=new Set,g=new Set,C=new Set,M=new Set,ue=new Set,me=new Set,Re=new Set,he=new Set,fe=new Set,ee=new Set,Qe=[],ce=null,pe=null,ye=new Set,be=new Set,de=null,Se=null,Ye=!1,te=new Map,oe=new Map,re=new Map,F=!1,d={value:0},p=null,V=null,Ee=!1,ge=!1,jt=null,N=null,zt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},U=(t)=>{r.parent.postMessage(t,"*")},Jt=()=>{if(F||r.parent===r||ee.size===0||p?.features?.lateGenerateResults!==!0)return;U({channel:_,v:T,type:"generate-late-listen"})},f=(t,o)=>{for(let u of t)try{u(o)}catch(l){console.error(l)}},Qt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=Mt(t.data);if(!o)return;if(o.type==="workspace"){let l=oe.get(o.payload.subscriptionId);if(l)f([l],o.payload.snapshot);return}if(o.type==="shells"){let l=re.get(o.payload.subscriptionId);if(l)f([l],o.payload.snapshot);return}if(o.type==="microphone-audio"){N?.queue.push(o.payload.samples);return}if(o.type==="microphone-ended"){let l=N;if(!l)return;N=null,l.release(),f(l.endedListeners,o.payload.reason);return}if(o.type==="ready"){if(p=o.payload,V=zt(o.payload.session),f(a,o.payload),f(E,o.payload.directory),f(m,o.payload.session),V)f(g,V);if(f(C,o.payload.connection),f(M,o.payload.settings),f(ue,o.payload.item),o.payload.block)f(me,o.payload.block);Jt();return}if(o.type==="service-event"){f(Re,o.payload);return}if(o.type==="generate-late"){if(ee.size===0)Qe.push(o.payload);else f(ee,o.payload);return}if(o.type==="directory"){if(p)p={...p,directory:o.payload.directory};f(E,o.payload.directory);return}if(o.type==="session"){if(p)p={...p,session:o.payload.session};if(!o.payload.session)V=null;else if(V?.sessionId!==o.payload.session.id)V=zt(o.payload.session);f(m,o.payload.session);return}if(o.type==="session-lifecycle"){V=o.payload,f(g,o.payload);return}if(o.type==="connection"){if(p)p={...p,connection:o.payload.connection};f(C,o.payload.connection);return}if(o.type==="settings"){if(p)p={...p,settings:o.payload.settings};f(M,o.payload.settings);return}if(o.type==="item"){if(p)p={...p,item:o.payload.item};f(ue,o.payload.item);return}if(o.type==="status-control-event"){f(he,o.payload);return}if(o.type==="popover-closed"){f(fe,o.payload);return}if(o.type==="action"){let l=(h)=>{if(!F)U({channel:_,v:T,type:"action-result",id:o.id,payload:h})},R=pe;if(!R){l({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>R(o.payload)).then(()=>l({ok:!0}),(h)=>{let y=(h instanceof Error?h.message:String(h)).trim();l({ok:!1,error:(y||"Action failed.").slice(0,_e)})});return}if(o.type==="file-open"){let l=o.payload;if(Se&&go(Se,l))return;Se=l,f(ye,o.payload);return}if(o.type==="file-saved"){f(be,o.payload.version);return}if(o.type==="file-snapshot"){let l=(y)=>{if(!F)U({channel:_,v:T,type:"file-snapshot-result",id:o.id,payload:y})},R=(y)=>l({error:(y.trim()||"Could not read the edited file.").slice(0,_e)}),h=de;if(!h){R("This extension does not edit files.");return}Promise.resolve().then(()=>h(o.payload.purpose)).then((y)=>{if(pt(y)>ke){R(`The file is over ${ke} ${"bytes"in y?"bytes":"characters"}.`);return}if(y.version.length>Ie){R(`The snapshot version is over ${Ie} characters.`);return}l({snapshot:"bytes"in y?{bytes:y.bytes,version:y.version}:{content:y.content,version:y.version}})},(y)=>R(y instanceof Error?y.message:String(y)));return}if(o.type==="resolve"){let l=(h)=>{U({channel:_,v:T,type:"resolve-result",id:o.id,payload:h})},R=ce;if(!R){l({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>R(o.payload)).then((h)=>l({item:h?z(h):null}),(h)=>{let y=(h instanceof Error?h.message:String(h)).trim();l({error:(y||"Command failed.").slice(0,_e)})});return}let u=te.get(o.id);if(!u)return;if(clearTimeout(u.timer),te.delete(o.id),o.ok){u.resolve(o.payload);return}u.reject(new c(o.code,o.error))};r.addEventListener("message",Qt),U({channel:_,v:T,type:"hello"});let G=(t,o=i)=>{if(F||r.parent===r)return Promise.reject(new c("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((u,l)=>{let R=setTimeout(()=>{te.delete(t.id),l(new c("HOST_TIMEOUT","Host did not answer in time."))},o);te.set(t.id,{resolve:u,reject:l,timer:R}),U(t)})},x=(t)=>G(t).then(()=>{return}),v={channel:_,v:T},Ze=(t)=>{if(!F&&r.parent!==r)U(t)},Yt=()=>Ze({...v,type:"file-save"}),et=()=>{if(!F&&r.parent!==r)U({...v,type:"microphone-close",id:S(d)})},tr=async()=>{if(N)throw new c("HOST_REJECTED","The microphone is already open in this frame.");if(p?.features?.microphone!==!0)throw new c("UNSUPPORTED","This OpenChamber cannot share the microphone with extensions.");let t=globalThis.AudioContext;if(typeof t!=="function")throw new c("UNSUPPORTED","This frame has no Web Audio.");let o=new t;if(o.sampleRate<at||o.sampleRate>lt)throw o.close().catch(()=>{return}),new c("UNSUPPORTED",`Audio at ${o.sampleRate} Hz is not supported.`);let u=o.state==="suspended"?o.resume().catch(()=>{return}):void 0,l=io(Math.round(o.sampleRate/4)),R=o.createScriptProcessor(1024,1,1);R.onaudioprocess=(H)=>l.pull(H.outputBuffer.getChannelData(0));let h=o.createMediaStreamDestination();R.connect(h);let y=new Set,se={queue:l,endedListeners:y,release:()=>{R.onaudioprocess=null,R.disconnect(),l.clear();for(let H of h.stream.getTracks())H.stop();o.close().catch(()=>{return})}};N=se;try{let H=await G({...v,type:"microphone-open",id:S(d),payload:{sampleRate:o.sampleRate}},ut);if(!H||!("opened"in H)||H.opened!==!0)throw new c("HOST_REJECTED","Host did not open the microphone.");if(await u,N!==se)throw new c("DISCONNECTED","The microphone closed while it was opening.")}catch(H){if(N===se)N=null;throw se.release(),et(),H}return{stream:h.stream,close:()=>{if(N!==se)return;N=null,se.release(),et()},onEnded:(H)=>(y.add(H),()=>{y.delete(H)})}},Zt=(t)=>{if(!Fo(t)||!dr(t))return;t.preventDefault(),Yt()},eo=(t)=>{if(!Fo(t)||t.key!=="Escape"||p?.surface!=="popover"||!p.popover)return;t.preventDefault(),so(p.popover.id,"escape").catch(()=>{return})},ve=()=>{let t=p?.surface==="popover"?p.popover:void 0;if(!t)return;let o=Ee||ge;if(jt===o)return;jt=o,no(t.id,o).catch(()=>{return})},Ae=()=>{if(p?.surface!=="popover"||Ee)return;Ee=!0,ve()},to=(t)=>{if(p?.surface!=="popover"||t.relatedTarget!==null||!Ee)return;Ee=!1,ve()},oo=()=>{if(p?.surface!=="popover"||ge)return;ge=!0,ve()},ro=()=>{if(p?.surface!=="popover"||!ge)return;ge=!1,ve()},B=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new c("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},tt=async(t)=>{if(t.kind!=="projects")B(t.projectId);let o=await G({...v,type:"workspace-read",id:S(d),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new c("HOST_REJECTED","Host did not return workspace data.");return o},ot=async(t,o)=>{if(t.kind!=="projects")B(t.projectId);let u=S(d);oe.set(u,o);try{await x({...v,type:"workspace-subscribe",id:S(d),payload:{subscriptionId:u,query:t}})}catch(l){if(oe.delete(u),!F)U({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:u}});throw l}return()=>{if(!oe.delete(u)||F)return;U({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:u}})}},or=async(t,o)=>{if(t.kind==="session")B(t.sessionId);if(t.kind==="project")B(t.projectId);let u=S(d);re.set(u,o);try{await x({...v,type:"shells-subscribe",id:S(d),payload:{subscriptionId:u,scope:t}})}catch(l){if(re.delete(u),!F)U({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:u}});throw l}return()=>{if(!re.delete(u)||F)return;U({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:u}})}},Oe=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>nt))throw new c("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ne(t.value))throw new c("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>it)throw new c("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&p?.features?.deviceStorage!==!0)throw new c("UNSUPPORTED","This host does not support device storage.");let o=await G({...v,type:"storage",id:S(d),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new c("HOST_REJECTED","Host did not return storage data.");return o},so=(t,o)=>p?.features?.popovers!==!0&&!(p?.surface==="popover"&&p.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-close",id:S(d),payload:o?{id:t,reason:o}:{id:t}}),no=(t,o)=>p?.features?.popovers!==!0&&!(p?.surface==="popover"&&p.popover?.id===t)?Promise.reject(new c("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-anchor",id:S(d),payload:{id:t,active:o}});return r.addEventListener("keydown",eo,!0),r.addEventListener("pointerover",Ae),r.addEventListener("pointermove",Ae),r.addEventListener("pointerout",to),r.addEventListener("focus",oo),r.addEventListener("blur",ro),{onAction:(t)=>(pe=t,()=>{if(pe===t)pe=null}),listProjects:async()=>{let t=await tt({kind:"projects"});if(t.kind!=="projects")throw new c("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await tt({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new c("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await tt({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new c("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>ot({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>ot({kind:"worktrees",projectId:t},(u)=>{if(u.kind==="worktrees")o(u)}),onSessions:(t,o)=>ot({kind:"sessions",projectId:t},(u)=>{if(u.kind==="sessions")o(u)}),onRunningShells:(t,o)=>or(t,o),readShellOutput:async(t,o)=>{B(t,xe);let u=o?.cursor;if(u!==void 0&&(!Number.isInteger(u)||u<0))throw new c("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let l=o?.tailBytes;if(l!==void 0&&(!Number.isInteger(l)||l<1||l>Ce))throw new c("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${Ce}.`);let h=await G({...v,type:"shell-output",id:S(d),payload:{shellId:t,cursor:u,tailBytes:l}});if(!h||typeof h.output!=="string"||!Number.isFinite(h.cursor))throw new c("HOST_REJECTED","Host did not return shell output.");return h},stopShell:async(t)=>{if(B(t,xe),(await G({...v,type:"shell-stop",id:S(d),payload:{shellId:t}}))?.stopped!==!0)throw new c("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{B(t),await x({...v,type:"open-session",id:S(d),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let u=Ve(o),l={op:"get",key:t};if(u)l.scope=u;let R=await Oe(l);return R.op==="get"&&R.found?R.value:void 0},set:async(t,o,u)=>{let l=Ve(u),R={op:"set",key:t,value:o};if(l)R.scope=l;await Oe(R)},delete:async(t,o)=>{let u=Ve(o),l={op:"delete",key:t};if(u)l.scope=u;await Oe(l)},keys:async(t)=>{let o=Ve(t),u={op:"keys"};if(o)u.scope=o;let l=await Oe(u);if(l.op!=="keys")throw new c("HOST_REJECTED","Expected storage keys.");return l.keys}},onReady:(t)=>{if(a.add(t),p)t(p);return()=>{a.delete(t)}},onDirectory:(t)=>{if(E.add(t),p)t(p.directory);return()=>{E.delete(t)}},onSession:(t)=>{if(m.add(t),p)t(p.session);return()=>{m.delete(t)}},onSessionLifecycle:(t)=>{if(g.add(t),V)t(V);return()=>{g.delete(t)}},onConnection:(t)=>{if(C.add(t),p)t(p.connection);return()=>{C.delete(t)}},onSettings:(t)=>{if(M.add(t),p)t(p.settings);return()=>{M.delete(t)}},onItem:(t)=>{if(ue.add(t),p)t(p.item);return()=>{ue.delete(t)}},onBlock:(t)=>{if(me.add(t),p?.block)t(p.block);return()=>{me.delete(t)}},onServiceEvent:(t)=>(Re.add(t),()=>{Re.delete(t)}),onStatusControl:(t)=>(he.add(t),()=>{he.delete(t)}),onPopoverClosed:(t)=>(fe.add(t),()=>{fe.delete(t)}),setStatusControls:(t)=>{if(p?.features?.statusControls!==!0)return Promise.reject(new c("UNSUPPORTED","This host does not support status controls."));if(!po(t))return Promise.reject(new c("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...v,type:"status-controls",id:S(d),payload:{controls:t}})},openPopover:(t)=>{if(p?.features?.popovers!==!0)return Promise.reject(new c("UNSUPPORTED","This host does not support popovers."));if(!St(t))return Promise.reject(new c("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...v,type:"popover-open",id:S(d),payload:t})},closePopover:so,setPopoverAnchorActive:no,onResolve:(t)=>(ce=t,()=>{if(ce===t)ce=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Me)return Promise.reject(new c("HOST_REJECTED",`Toast message must contain 1 to ${Me} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Ge))return Promise.reject(new c("HOST_REJECTED",`Toast copy text must contain 1 to ${Ge} characters.`));return x({channel:_,v:T,type:"toast",id:S(d),payload:{...t,message:o}})},openUrl:(t)=>x({channel:_,v:T,type:"open-url",id:S(d),payload:{url:t}}),...fo(x,()=>S(d),(t)=>Promise.reject(new c("HOST_REJECTED",t))),answerBlock:(t)=>x({channel:_,v:T,type:"block-answer",id:S(d),payload:{text:t.trim().slice(0,_t)}}),openSurface:(t)=>x({channel:_,v:T,type:"open-surface",id:S(d),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:_,v:T,type:"clipboard-write",id:S(d),payload:{text:t}}),compose:(t)=>x({channel:_,v:T,type:"compose",id:S(d),payload:t}),attach:(t)=>x({channel:_,v:T,type:"attach",id:S(d),payload:z(t)}),startSession:async(t)=>{if(t.projectId!==void 0)B(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")B(o.directory);else{if(o.name!==void 0)B(o.name,200);if(o.baseBranch!==void 0)B(o.baseBranch,200)}let u=await G({channel:_,v:T,type:"start-session",id:S(d),payload:yt(t)},e.requestTimeoutMs??180000);if(!Tt(u))throw new c("HOST_REJECTED","Host did not return a session.");return u},prompt:(t)=>G({channel:_,v:T,type:"prompt",id:S(d),payload:bt(t)}).then((o)=>{if(!mt(o))throw new c("HOST_REJECTED","Host did not return a prompt result.");return o}),...Ho(x,()=>S(d),(t,o)=>Promise.reject(new c(t,o)),()=>p?.features?.sessionLinks===!0),close:()=>x({channel:_,v:T,type:"close",id:S(d)}),oauthStart:()=>x({channel:_,v:T,type:"oauth-start",id:S(d)}),oauthDisconnect:()=>x({channel:_,v:T,type:"oauth-disconnect",id:S(d)}),request:(t)=>(He(t.path)?G({channel:_,v:T,type:"request",id:S(d),payload:t}):Bo()).then((o)=>{if(!Fe(o))throw new c("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(He(t.path)?G({channel:_,v:T,type:"service-request",id:S(d),payload:t}):Bo()).then((o)=>{if(!Fe(o))throw new c("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>G({channel:_,v:T,type:"service-status",id:S(d)}).then((t)=>{if(!Ot(t))throw new c("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(ie(t)?G({channel:_,v:T,type:"file-read",id:S(d),payload:{path:t}}):Be()).then((o)=>{if(!xt(o))throw new c("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!ie(t))return Be();if(o.length>Ne)return Promise.reject(new c("FILE_TOO_LARGE",`Content is over ${Ne} characters.`));return G({channel:_,v:T,type:"file-write",id:S(d),payload:{path:t,content:o}}).then((u)=>{if(!Ct(u))throw new c("HOST_REJECTED","Host did not confirm the write.");return u})},listDir:(t)=>(ie(t)?G({channel:_,v:T,type:"file-list",id:S(d),payload:{path:t}}):Be()).then((o)=>{if(!kt(o))throw new c("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(ie(t)?G({channel:_,v:T,type:"file-stat",id:S(d),payload:{path:t}}):Be()).then((o)=>{if(!It(o))throw new c("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),u=t.system?.trim();if(o.length===0||o.length>Le)return Promise.reject(new c("HOST_REJECTED",`Prompt must be 1 to ${Le} characters.`));if(u!==void 0&&(u.length===0||u.length>De))return Promise.reject(new c("HOST_REJECTED",`System prompt must be 1 to ${De} characters.`));let l=t.maxOutputTokens===void 0?void 0:Math.min(ht,Math.max(1,Math.floor(t.maxOutputTokens)));if(l!==void 0&&!Number.isFinite(l))return Promise.reject(new c("HOST_REJECTED","maxOutputTokens must be a number."));let R={prompt:o};if(u!==void 0)R.system=u;if(l!==void 0)R.maxOutputTokens=l;return G({channel:_,v:T,type:"generate",id:S(d),payload:R},e.requestTimeoutMs??ft).then((h)=>{if(!Pt(h))throw new c("HOST_REJECTED","Host did not return generated text.");return h})},onLateGenerateResult:(t)=>{ee.add(t);for(let o of Qe.splice(0))f([t],o);return Jt(),()=>{ee.delete(t)}},openMicrophone:tr,setBadge:(t)=>x({channel:_,v:T,type:"badge",id:S(d),payload:{count:vt(t)}}),setHeight:(t)=>x({channel:_,v:T,type:"resize",id:S(d),payload:{height:At(t)}}),onFileOpen:(t)=>{if(ye.add(t),!Ye)Ye=!0,r.addEventListener("keydown",Zt,!0);if(Se)t(Se);return()=>{ye.delete(t)}},onFileSnapshot:(t)=>(de=t,()=>{if(de===t)de=null}),onFileSaved:(t)=>(be.add(t),()=>{be.delete(t)}),reportFileChange:(t)=>Ze({...v,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Yt,reportFileUnsupported:()=>Ze({...v,type:"file-unsupported"}),dispose:()=>{for(let t of oe.keys())U({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:t}});oe.clear();for(let t of re.keys())U({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:t}});if(re.clear(),N)et(),N.release(),N=null;if(F=!0,ce=null,pe=null,de=null,ye.clear(),be.clear(),Ye)r.removeEventListener("keydown",Zt,!0);r.removeEventListener("message",Qt),r.removeEventListener("keydown",eo,!0),r.removeEventListener("pointerover",Ae),r.removeEventListener("pointermove",Ae),r.removeEventListener("pointerout",to),r.removeEventListener("focus",oo),r.removeEventListener("blur",ro);for(let t of te.values())clearTimeout(t.timer),t.reject(new c("HOST_UNAVAILABLE","Host client was disposed."));te.clear(),a.clear(),E.clear(),m.clear(),g.clear(),C.clear(),M.clear(),ue.clear(),me.clear(),Re.clear(),he.clear(),fe.clear(),ee.clear(),Qe.length=0}}};var Vo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var cs=new Set(Vo);var Wo=["none","agent","user"];var ds=new Set(Wo);var Sr=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Er=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Xo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,i]of Sr)r.style.setProperty(s,e.tokens[i]);for(let[s,i,a]of Er){let E=e.tokens[a]??"";r.style.setProperty(s,E),r.style.setProperty(i,E)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},Ut=(e,r)=>{if(Xo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var gr={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},b=(e,r)=>`var(--${e}, var(--oc-${gr[e]}, ${r}))`,X=b("surface-background","transparent"),Xe=b("surface-elevated","transparent"),ae=b("surface-elevated-foreground","inherit"),L=b("surface-foreground","inherit"),A=b("surface-muted-foreground","gray"),_r=b("surface-muted","transparent"),J=b("interactive-border","currentColor"),w=b("interactive-hover","transparent"),Q=b("interactive-active","transparent"),wt=b("interactive-selection","transparent"),Nt=b("interactive-selection-foreground","inherit"),W=b("primary","currentColor"),Lt=b("primary-text","inherit"),Dt=b("error-text","inherit"),Tr=b("font-sans","inherit"),Ht=b("font-mono","monospace"),jo=b("radius","9px"),Ft=`calc(${jo} - 2px)`,$o=`calc(${jo} - 4px)`,O=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,qo=`background-image: linear-gradient(${w}, ${w});`,Bt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Vt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Ko="box-shadow: var(--oc-sdk-lit);",Wt=`inset 0 0.5px 0 0 ${O(L,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,mr=`
:root {
  --oc-sdk-edge: ${O(L,16)};
  --oc-sdk-field-bg: ${Xe};
  --oc-sdk-raised-bg: ${X};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${O(L,14)};
  --oc-sdk-field-bg: ${O(X,50,Xe)};
  --oc-sdk-raised-bg: ${Xe};
  --oc-sdk-field-lift: ${Wt};
  --oc-sdk-raised-lift: ${Wt};
  --oc-sdk-lit: ${Wt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,We=(e)=>{let r=b(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${b(`${e}-text`,"inherit")}; }`},n=(e)=>`calc(${e}rem / 14)`,Rr=`
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
`,zo=`${mr}
.oc-sdk { color: ${L}; font-family: ${Tr}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${qo} }
.oc-sdk-mono { font-family: ${Ht}; }
.oc-sdk-muted { color: ${A}; }
${We("success")}${We("warning")}${We("error")}${We("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${W}; --oc-sdk-tone-text: ${Lt}; }

.oc-sdk-btn { border-radius: ${Ft}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${$o}; }
.oc-sdk-btn[data-variant="default"] { color: ${Lt}; background: ${O(W,10,X)}; border-color: ${O(W,12)}; ${Ko} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${O(W,16,X)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${O(W,22,X)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${_r}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${Q}, ${Q}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${ae}; ${Vt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${Q}, ${Q}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${w}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${Q}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${b("status-error","red")}; color: ${Dt}; background: ${O("var(--oc-sdk-tone)",7,X)}; border-color: ${O("var(--oc-sdk-tone)",12)}; ${Ko} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${O("var(--oc-sdk-tone)",9,X)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${O("var(--oc-sdk-tone)",11,X)}; box-shadow: none; }

.oc-sdk-field-note { color: ${A}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Dt}; }
.oc-sdk-input { border-radius: ${Ft}; background: var(--oc-sdk-field-bg); color: ${ae}; ${Bt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${A}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Bt(O(L,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Bt(b("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Ht}; }

.oc-sdk-search-icon { color: ${A}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${W}; }
.oc-sdk-search-clear { border-radius: ${$o}; color: ${A}; }
.oc-sdk-search-clear:hover { background: ${w}; color: ${L}; }

.oc-sdk-trigger { border-radius: ${Ft}; background: var(--oc-sdk-raised-bg); color: ${ae}; ${Vt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${Q}, ${Q}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${A}; }
.oc-sdk-trigger-chevron { color: ${A}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${ae}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Xe}; background-clip: padding-box; color: ${ae}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${w}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${wt}; color: ${Nt}; }
.oc-sdk-option-check { color: ${L}; }
.oc-sdk-option[data-destructive="true"] { color: ${Dt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${O(b("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${A}; }
.oc-sdk-popup-empty { color: ${A}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${J}; border-radius: 4px; color: ${L}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${O(L,60,J)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${J}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${X}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${W}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${qo} }
.oc-sdk-check-desc { color: ${A}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${O(L,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${A}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${L}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Nt}; background: ${wt}; border-color: ${J}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${ae}; background: var(--oc-sdk-raised-bg); ${Vt} }
.oc-sdk-tab-count { color: ${A}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${O(L,6)}; color: ${A}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${O("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${w}; }
.oc-sdk-row[aria-selected="true"] { background: ${wt}; color: ${Nt}; }
.oc-sdk-row-lead { font-family: ${Ht}; color: ${A}; }
.oc-sdk-row-sub { color: ${A}; }
.oc-sdk-row-meta { color: ${A}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${A}; }

.oc-sdk-empty-body { color: ${A}; }

.oc-sdk-spinner { color: ${A}; }
.oc-sdk-spinner-ring { border-color: ${J}; border-top-color: ${W}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${O("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${A}; }

.oc-sdk-separator { color: ${A}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${O(J,40)}; }

.oc-sdk-progress-label { color: ${A}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${O(L,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${W}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${b("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${b("success-text","inherit")}; }

.oc-sdk-text a { color: ${Lt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${O(J,60)}; }
`,I=`
${rt}
${Rr}
${zo}`;var Jo="oc-sdk-ui-style";var P=(e)=>{let r=document.getElementById(Jo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}st(document);let s=document.createElement("style");s.id=Jo,s.textContent=e,document.head.appendChild(s)},k=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},q=(e)=>{let r=k("button",e);return r.type="button",r},D=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var hr=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},K=(e,r)=>{P(I);let s=r,i=q("oc-sdk oc-sdk-btn"),a=hr(),E=document.createElement("span");i.append(E),e.append(i);let m=()=>{if(i.dataset.variant=s.variant??"default",i.dataset.size=s.size??"default",i.disabled=Boolean(s.disabled)||Boolean(s.loading),i.dataset.loading=s.loading?"true":"false",i.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&a.parentNode!==i)i.prepend(a);else if(!s.loading&&a.parentNode===i)a.remove();D(E,s.label)},g=()=>{if(s.disabled||s.loading)return;s.onClick()};return i.addEventListener("click",g),m(),{update:(C)=>{s={...s,...C},m()},dispose:()=>{i.removeEventListener("click",g),i.remove()}}};var Xt=(e,r)=>{P(I);let s=r,i=k("div","oc-sdk oc-sdk-empty"),a=k("h2","oc-sdk-empty-title"),E=k("p","oc-sdk-empty-body"),m=k("div","oc-sdk-empty-action");i.append(a,E,m),e.append(i);let g=null,C=()=>{if(D(a,s.title),D(E,s.body),E.hidden=!s.body,m.hidden=!s.action,!s.action){g?.dispose(),g=null;return}let M={label:s.action.label,onClick:s.action.onClick};if(g)g.update(M);else g=K(m,{...M,variant:"outline",size:"sm"})};return C(),{update:(M)=>{s={...s,...M},C()},dispose:()=>{g?.dispose(),g=null,i.remove()}}};var Ar=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,Qo=(e)=>e.split(`
`).map((r)=>{let s=Ar.exec(r);return s?{kind:"item",prefix:s[1]??"- ",done:s[2]!==" ",text:s[3]??""}:{kind:"text",text:r}}),Yo=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),ze=(e)=>{let r=2166136261;for(let s=0;s<e.length;s+=1)r^=e.charCodeAt(s),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},Zo=(e,r)=>{let s=-1,i="- ";e.forEach((g,C)=>{if(g.kind!=="item")return;s=C,i=g.prefix});let a={kind:"item",prefix:i,done:!1,text:r};if(s>=0)return[...e.slice(0,s+1),a,...e.slice(s+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],a,{kind:"text",text:""}]};var Z=Gt(),Y=document.querySelector("#root");if(!Y)throw Error("Missing root");var er=document.createElement("style");er.textContent=`
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
`;document.head.append(er);Z.onReady((e)=>Ut(e,document.documentElement));var j=[],le=!1,qt=Pe(null),Kt=()=>Yo(j),Je=()=>{Z.reportFileChange(qt.observe(ze(Kt())))},$t=()=>{if(Y.replaceChildren(),!j.some((r)=>r.kind==="item")&&le){Xt(Y,{title:"No items",body:"This checklist is empty."});return}if(j.forEach((r,s)=>{if(r.kind==="text"){let m=document.createElement("p");m.className="note",m.textContent=r.text,Y.append(m);return}let i=document.createElement("div");i.className=r.done?"item done":"item";let a=document.createElement("input");a.type="checkbox",a.checked=r.done,a.disabled=le,a.addEventListener("change",()=>{r.done=a.checked,i.className=r.done?"item done":"item",Je()});let E=document.createElement("input");if(E.type="text",E.value=r.text,E.readOnly=le,E.setAttribute("aria-label","Item"),E.addEventListener("input",()=>{r.text=E.value,Je()}),i.append(a,E),!le){let m=document.createElement("span");m.className="remove",K(m,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{j=j.filter((g,C)=>C!==s),Je(),$t()}}),i.append(m)}Y.append(i)}),le)return;let e=document.createElement("div");e.className="actions",K(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{j=Zo(j,""),Je(),$t();let r=Y.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),Y.append(e)};Z.onFileOpen((e)=>{if(e.encoding!=="text"){Z.reportFileUnsupported();return}j=Qo(e.content),le=e.readOnly,qt=Pe(ze(Kt())),$t()});Z.onFileSnapshot(()=>{let e=Kt();return{content:e,version:ze(e)}});Z.onFileSaved((e)=>{Z.reportFileChange({dirty:qt.markSaved(e),edited:!1})});})();
