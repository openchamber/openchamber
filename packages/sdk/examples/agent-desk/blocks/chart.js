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
`;function Ze(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let n=new WeakMap;e.addEventListener("scroll",(p)=>{let c=p.target===e?r:p.target;if(!(c instanceof Element))return;if(!c.hasAttribute("data-oc-scrolling"))c.setAttribute("data-oc-scrolling","");let _=n.get(c);if(_!==void 0)clearTimeout(_);n.set(c,setTimeout(()=>{n.delete(c),c.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Xo=`(${Ze.toString()})(document);`;var et=128,tt=65536;var ve=128;var Ae=65536;var ot=8000,rt=192000,st=120000;var Qt=(e)=>{let r=[],n=0,p=0;return{push:(c)=>{r.push(c),p+=c.length;while(p-n>e&&r.length>1){let _=r.shift();p-=_?.length??0,n=0}},pull:(c)=>{let _=0;while(_<c.length&&r.length>0){let b=r[0],T=Math.min(c.length-_,b.length-n);if(c.set(b.subarray(n,n+T),_),_+=T,n+=T,n>=b.length)r.shift(),p-=b.length,n=0}c.fill(0,_)},clear:()=>{r.length=0,n=0,p=0},get size(){return p-n}}};var to=/^[a-z][a-z0-9-]{0,39}$/;var Yt=(e)=>Object(e)===e&&!Array.isArray(e),nt=(e,r)=>Object.keys(e).every((n)=>r.includes(n)),Zt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,eo=(e)=>String(e)===e&&e.length>=1&&e.length<=80,oo=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let n of e){if(!Yt(n)||!to.test(n.id)||!Zt(n.label))return!1;if(n.disabled!==void 0&&n.disabled!==!0&&n.disabled!==!1)return!1;if(r.has(n.id))return!1;if(r.add(n.id),n.kind==="button"){if(!nt(n,["kind","id","label","disabled"]))return!1;continue}if(n.kind!=="select"||!nt(n,["kind","id","label","value","options","disabled"]))return!1;if(!eo(n.value)||!Array.isArray(n.options)||n.options.length<1||n.options.length>16)return!1;let p=new Set;for(let c of n.options){if(!Yt(c)||!nt(c,["value","label"])||!eo(c.value)||!Zt(c.label)||p.has(c.value))return!1;p.add(c.value)}if(!p.has(n.value))return!1}return!0};var ro=["{id}","{segment}","{segments+}"];var yr=new Set(ro);var so=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var Or=new Set(so);var Oe=20000000,xe=256;var it=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,no=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let n=0;n<e.bytes.byteLength;n+=1)if(e.bytes[n]!==r.bytes[n])return!1;return!0};var io=/^[A-Za-z0-9_-]{1,80}$/;var ao=["left","right","top","bottom"];var lo=(e,r=0,n={remaining:16000})=>{if(--n.remaining<0||r>=32)return!1;if(e===null)return!0;let p=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let c of p)if(!lo(c,r+1,n))return!1;return!0},at=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(at);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(at)}return String(e)===e||Number.isFinite(e)},lt=(e)=>{try{if(String(e.id)!==e.id||!io.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!ao.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!lo(e.data)||!at(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var uo=/^[0-9a-f]{7,64}$/i,co=(e)=>uo.test(e),ut=255,po=(e,r,n)=>({openCommit:(p)=>co(p)?e({channel:E,v:g,type:"open-commit",id:r(),payload:{sha:p}}):n("Commit id must be 7 to 64 hex characters."),openWalkthrough:({base:p})=>{let c=p.trim();if(!c||c.length>ut)return n(`Base must contain 1 to ${ut} characters.`);return e({channel:E,v:g,type:"open-walkthrough",id:r(),payload:{base:c}})}});var pt=2000;var Eo=["file","directory","other","missing"],dt=(e)=>Boolean(e&&"sessionId"in e),St=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Ce=500,ke=32000,go=16000,_o=128,To=200,Ie=2000,mo=16000,Ro=80,fo=200,ho=16000;var yo=2000;var Et=20000,Pe=1024,Me=2000000;var Ge=64000,Ue=8000,gt=4000;var _t=960000;var bo=999,vo=1e4,Se=500,Ao=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],Oo=["stopped","starting","ready","failed"],Ko=new Set(Ao),xo=(e)=>Ko.has(e),Co=(e)=>e&&xo(e)?e:"HOST_REJECTED",oe=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(oe);if(Object(e)===e)return Object.values(e).every(oe);return!1},ko=(e)=>oe(e)&&JSON.stringify(e).length<=ho,So=(e)=>e?.trim().slice(0,fo)??"",K=(e)=>{let r=e.id.trim().slice(0,_o),n=e.title.trim().slice(0,To),p=e.url.trim().slice(0,Ie),c=e.text?.trim().slice(0,mo),_=e.author?.trim().slice(0,Ro),b=e.kind==="pull"?"pull":"issue",T={providerId:e.providerId.trim(),id:r,title:n||r,url:p,kind:b};if(c)T.text=c;if(_)T.author=_;if(b==="pull"){let C=So(e.branches?.head),D=So(e.branches?.base);if(C&&D)T.branches={head:C,base:D}}if(ko(e.data))T.data=e.data;return T},Tt=(e)=>{let r=K(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},mt=(e)=>{let r={text:e.text.trim().slice(0,go)};if(e.send)r.send=!0;return r},Rt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(bo,Math.max(0,Math.round(e)))},ft=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(vo,Math.max(0,Math.ceil(e)))};var re=(e)=>e.length>0&&e.length<=Pe&&!e.includes("\x00")&&!e.includes("\\");var we=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>yo)return!1;return!e.split("/").some((n)=>n==="."||n==="..")},jo=new Set(Oo),ht=(e)=>Boolean(e&&"status"in e&&jo.has(String(e.status))&&!("body"in e)),Ne=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),yt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),bt=(e)=>Boolean(e&&"written"in e&&e.written===!0),vt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),zo=new Set(Eo),At=(e)=>Boolean(e&&"kind"in e&&"size"in e&&zo.has(String(e.kind))&&Number.isFinite(e.size)),Ot=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Jo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late","microphone-audio","microphone-ended"]),Qo=(e)=>Object(e)===e?e:null,ct=(e)=>String(e)===e&&e.length>0,Yo=(e)=>{if(!ct(e.id))return null;if(e.ok===!0){let r={channel:E,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&ct(e.error))return{channel:E,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:Co(ct(e.code)?e.code:void 0)};return null},xt=(e)=>{let r=Qo(e);if(!r||r.channel!==E||r.v!==g)return null;if(r.type==="result")return Yo(r);if(!Jo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var Io=(e,r,n,p)=>{let c={channel:E,v:g},_=(T)=>T!==void 0&&(!T.trim()||T.length>1024),b=()=>n("UNSUPPORTED","This OpenChamber cannot target a session or remove a link.");return{sessionLink:(T)=>{if(_(T.sessionId))return n("HOST_REJECTED","Identity must contain 1 to 1024 characters.");if(T.sessionId!==void 0&&!p())return b();return e({...c,type:"session-link",id:r(),payload:{...K(T),sessionId:T.sessionId}})},sessionUnlink:({url:T,sessionId:C})=>{if(_(C))return n("HOST_REJECTED","Identity must contain 1 to 1024 characters.");if(!p())return b();let D=T.trim().slice(0,Ie);if(!D)return n("BAD_PATH","A link URL is required.");return e({...c,type:"session-unlink",id:r(),payload:{url:D,sessionId:C}})}}};var Po=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Zo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class l extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Mo=()=>Promise.reject(new l("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Le=()=>Promise.reject(new l("BAD_PATH",`File path must be 1 to ${Pe} characters without NUL or backslash.`)),De=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new l("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},S=(e)=>(e.value+=1,`oc-${e.value}`),Ct=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new l("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let n=e.acceptSource??((t)=>t===r.parent),p=e.requestTimeoutMs??Et,c=new Set,_=new Set,b=new Set,T=new Set,C=new Set,D=new Set,ie=new Set,ge=new Set,_e=new Set,Te=new Set,me=new Set,Q=new Set,qe=[],ae=null,le=null,Re=new Set,fe=new Set,ue=null,ce=null,Ke=!1,Y=new Map,Z=new Map,ee=new Map,H=!1,d={value:0},u=null,V=null,pe=!1,de=!1,Ht=null,w=null,Bt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},G=(t)=>{r.parent.postMessage(t,"*")},Ft=()=>{if(H||r.parent===r||Q.size===0||u?.features?.lateGenerateResults!==!0)return;G({channel:E,v:g,type:"generate-late-listen"})},f=(t,o)=>{for(let a of t)try{a(o)}catch(i){console.error(i)}},Vt=(t)=>{if(!(t instanceof MessageEvent))return;if(!n(t.source))return;let o=xt(t.data);if(!o)return;if(o.type==="workspace"){let i=Z.get(o.payload.subscriptionId);if(i)f([i],o.payload.snapshot);return}if(o.type==="shells"){let i=ee.get(o.payload.subscriptionId);if(i)f([i],o.payload.snapshot);return}if(o.type==="microphone-audio"){w?.queue.push(o.payload.samples);return}if(o.type==="microphone-ended"){let i=w;if(!i)return;w=null,i.release(),f(i.endedListeners,o.payload.reason);return}if(o.type==="ready"){if(u=o.payload,V=Bt(o.payload.session),f(c,o.payload),f(_,o.payload.directory),f(b,o.payload.session),V)f(T,V);if(f(C,o.payload.connection),f(D,o.payload.settings),f(ie,o.payload.item),o.payload.block)f(ge,o.payload.block);Ft();return}if(o.type==="service-event"){f(_e,o.payload);return}if(o.type==="generate-late"){if(Q.size===0)qe.push(o.payload);else f(Q,o.payload);return}if(o.type==="directory"){if(u)u={...u,directory:o.payload.directory};f(_,o.payload.directory);return}if(o.type==="session"){if(u)u={...u,session:o.payload.session};if(!o.payload.session)V=null;else if(V?.sessionId!==o.payload.session.id)V=Bt(o.payload.session);f(b,o.payload.session);return}if(o.type==="session-lifecycle"){V=o.payload,f(T,o.payload);return}if(o.type==="connection"){if(u)u={...u,connection:o.payload.connection};f(C,o.payload.connection);return}if(o.type==="settings"){if(u)u={...u,settings:o.payload.settings};f(D,o.payload.settings);return}if(o.type==="item"){if(u)u={...u,item:o.payload.item};f(ie,o.payload.item);return}if(o.type==="status-control-event"){f(Te,o.payload);return}if(o.type==="popover-closed"){f(me,o.payload);return}if(o.type==="action"){let i=(R)=>{if(!H)G({channel:E,v:g,type:"action-result",id:o.id,payload:R})},m=le;if(!m){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>m(o.payload)).then(()=>i({ok:!0}),(R)=>{let h=(R instanceof Error?R.message:String(R)).trim();i({ok:!1,error:(h||"Action failed.").slice(0,Se)})});return}if(o.type==="file-open"){let i=o.payload;if(ce&&no(ce,i))return;ce=i,f(Re,o.payload);return}if(o.type==="file-saved"){f(fe,o.payload.version);return}if(o.type==="file-snapshot"){let i=(h)=>{if(!H)G({channel:E,v:g,type:"file-snapshot-result",id:o.id,payload:h})},m=(h)=>i({error:(h.trim()||"Could not read the edited file.").slice(0,Se)}),R=ue;if(!R){m("This extension does not edit files.");return}Promise.resolve().then(()=>R(o.payload.purpose)).then((h)=>{if(it(h)>Oe){m(`The file is over ${Oe} ${"bytes"in h?"bytes":"characters"}.`);return}if(h.version.length>xe){m(`The snapshot version is over ${xe} characters.`);return}i({snapshot:"bytes"in h?{bytes:h.bytes,version:h.version}:{content:h.content,version:h.version}})},(h)=>m(h instanceof Error?h.message:String(h)));return}if(o.type==="resolve"){let i=(R)=>{G({channel:E,v:g,type:"resolve-result",id:o.id,payload:R})},m=ae;if(!m){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>m(o.payload)).then((R)=>i({item:R?K(R):null}),(R)=>{let h=(R instanceof Error?R.message:String(R)).trim();i({error:(h||"Command failed.").slice(0,Se)})});return}let a=Y.get(o.id);if(!a)return;if(clearTimeout(a.timer),Y.delete(o.id),o.ok){a.resolve(o.payload);return}a.reject(new l(o.code,o.error))};r.addEventListener("message",Vt),G({channel:E,v:g,type:"hello"});let k=(t,o=p)=>{if(H||r.parent===r)return Promise.reject(new l("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((a,i)=>{let m=setTimeout(()=>{Y.delete(t.id),i(new l("HOST_TIMEOUT","Host did not answer in time."))},o);Y.set(t.id,{resolve:a,reject:i,timer:m}),G(t)})},x=(t)=>k(t).then(()=>{return}),v={channel:E,v:g},je=(t)=>{if(!H&&r.parent!==r)G(t)},Wt=()=>je({...v,type:"file-save"}),ze=()=>{if(!H&&r.parent!==r)G({...v,type:"microphone-close",id:S(d)})},Vo=async()=>{if(w)throw new l("HOST_REJECTED","The microphone is already open in this frame.");if(u?.features?.microphone!==!0)throw new l("UNSUPPORTED","This OpenChamber cannot share the microphone with extensions.");let t=globalThis.AudioContext;if(typeof t!=="function")throw new l("UNSUPPORTED","This frame has no Web Audio.");let o=new t;if(o.sampleRate<ot||o.sampleRate>rt)throw o.close().catch(()=>{return}),new l("UNSUPPORTED",`Audio at ${o.sampleRate} Hz is not supported.`);let a=o.state==="suspended"?o.resume().catch(()=>{return}):void 0,i=Qt(Math.round(o.sampleRate/4)),m=o.createScriptProcessor(1024,1,1);m.onaudioprocess=(L)=>i.pull(L.outputBuffer.getChannelData(0));let R=o.createMediaStreamDestination();m.connect(R);let h=new Set,te={queue:i,endedListeners:h,release:()=>{m.onaudioprocess=null,m.disconnect(),i.clear();for(let L of R.stream.getTracks())L.stop();o.close().catch(()=>{return})}};w=te;try{let L=await k({...v,type:"microphone-open",id:S(d),payload:{sampleRate:o.sampleRate}},st);if(!L||!("opened"in L)||L.opened!==!0)throw new l("HOST_REJECTED","Host did not open the microphone.");if(await a,w!==te)throw new l("DISCONNECTED","The microphone closed while it was opening.")}catch(L){if(w===te)w=null;throw te.release(),ze(),L}return{stream:R.stream,close:()=>{if(w!==te)return;w=null,te.release(),ze()},onEnded:(L)=>(h.add(L),()=>{h.delete(L)})}},Xt=(t)=>{if(!Po(t)||!Zo(t))return;t.preventDefault(),Wt()},$t=(t)=>{if(!Po(t)||t.key!=="Escape"||u?.surface!=="popover"||!u.popover)return;t.preventDefault(),zt(u.popover.id,"escape").catch(()=>{return})},he=()=>{let t=u?.surface==="popover"?u.popover:void 0;if(!t)return;let o=pe||de;if(Ht===o)return;Ht=o,Jt(t.id,o).catch(()=>{return})},ye=()=>{if(u?.surface!=="popover"||pe)return;pe=!0,he()},qt=(t)=>{if(u?.surface!=="popover"||t.relatedTarget!==null||!pe)return;pe=!1,he()},Kt=()=>{if(u?.surface!=="popover"||de)return;de=!0,he()},jt=()=>{if(u?.surface!=="popover"||!de)return;de=!1,he()},B=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new l("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Je=async(t)=>{if(t.kind!=="projects")B(t.projectId);let o=await k({...v,type:"workspace-read",id:S(d),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new l("HOST_REJECTED","Host did not return workspace data.");return o},Qe=async(t,o)=>{if(t.kind!=="projects")B(t.projectId);let a=S(d);Z.set(a,o);try{await x({...v,type:"workspace-subscribe",id:S(d),payload:{subscriptionId:a,query:t}})}catch(i){if(Z.delete(a),!H)G({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:a}});throw i}return()=>{if(!Z.delete(a)||H)return;G({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:a}})}},Wo=async(t,o)=>{if(t.kind==="session")B(t.sessionId);if(t.kind==="project")B(t.projectId);let a=S(d);ee.set(a,o);try{await x({...v,type:"shells-subscribe",id:S(d),payload:{subscriptionId:a,scope:t}})}catch(i){if(ee.delete(a),!H)G({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:a}});throw i}return()=>{if(!ee.delete(a)||H)return;G({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:a}})}},be=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>et))throw new l("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!oe(t.value))throw new l("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>tt)throw new l("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&u?.features?.deviceStorage!==!0)throw new l("UNSUPPORTED","This host does not support device storage.");let o=await k({...v,type:"storage",id:S(d),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new l("HOST_REJECTED","Host did not return storage data.");return o},zt=(t,o)=>u?.features?.popovers!==!0&&!(u?.surface==="popover"&&u.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-close",id:S(d),payload:o?{id:t,reason:o}:{id:t}}),Jt=(t,o)=>u?.features?.popovers!==!0&&!(u?.surface==="popover"&&u.popover?.id===t)?Promise.reject(new l("UNSUPPORTED","This host does not support popovers.")):x({...v,type:"popover-anchor",id:S(d),payload:{id:t,active:o}});return r.addEventListener("keydown",$t,!0),r.addEventListener("pointerover",ye),r.addEventListener("pointermove",ye),r.addEventListener("pointerout",qt),r.addEventListener("focus",Kt),r.addEventListener("blur",jt),{onAction:(t)=>(le=t,()=>{if(le===t)le=null}),listProjects:async()=>{let t=await Je({kind:"projects"});if(t.kind!=="projects")throw new l("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Je({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new l("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Je({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new l("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Qe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Qe({kind:"worktrees",projectId:t},(a)=>{if(a.kind==="worktrees")o(a)}),onSessions:(t,o)=>Qe({kind:"sessions",projectId:t},(a)=>{if(a.kind==="sessions")o(a)}),onRunningShells:(t,o)=>Wo(t,o),readShellOutput:async(t,o)=>{B(t,ve);let a=o?.cursor;if(a!==void 0&&(!Number.isInteger(a)||a<0))throw new l("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>Ae))throw new l("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${Ae}.`);let R=await k({...v,type:"shell-output",id:S(d),payload:{shellId:t,cursor:a,tailBytes:i}});if(!R||typeof R.output!=="string"||!Number.isFinite(R.cursor))throw new l("HOST_REJECTED","Host did not return shell output.");return R},stopShell:async(t)=>{if(B(t,ve),(await k({...v,type:"shell-stop",id:S(d),payload:{shellId:t}}))?.stopped!==!0)throw new l("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{B(t),await x({...v,type:"open-session",id:S(d),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let a=De(o),i={op:"get",key:t};if(a)i.scope=a;let m=await be(i);return m.op==="get"&&m.found?m.value:void 0},set:async(t,o,a)=>{let i=De(a),m={op:"set",key:t,value:o};if(i)m.scope=i;await be(m)},delete:async(t,o)=>{let a=De(o),i={op:"delete",key:t};if(a)i.scope=a;await be(i)},keys:async(t)=>{let o=De(t),a={op:"keys"};if(o)a.scope=o;let i=await be(a);if(i.op!=="keys")throw new l("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(c.add(t),u)t(u);return()=>{c.delete(t)}},onDirectory:(t)=>{if(_.add(t),u)t(u.directory);return()=>{_.delete(t)}},onSession:(t)=>{if(b.add(t),u)t(u.session);return()=>{b.delete(t)}},onSessionLifecycle:(t)=>{if(T.add(t),V)t(V);return()=>{T.delete(t)}},onConnection:(t)=>{if(C.add(t),u)t(u.connection);return()=>{C.delete(t)}},onSettings:(t)=>{if(D.add(t),u)t(u.settings);return()=>{D.delete(t)}},onItem:(t)=>{if(ie.add(t),u)t(u.item);return()=>{ie.delete(t)}},onBlock:(t)=>{if(ge.add(t),u?.block)t(u.block);return()=>{ge.delete(t)}},onServiceEvent:(t)=>(_e.add(t),()=>{_e.delete(t)}),onStatusControl:(t)=>(Te.add(t),()=>{Te.delete(t)}),onPopoverClosed:(t)=>(me.add(t),()=>{me.delete(t)}),setStatusControls:(t)=>{if(u?.features?.statusControls!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support status controls."));if(!oo(t))return Promise.reject(new l("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...v,type:"status-controls",id:S(d),payload:{controls:t}})},openPopover:(t)=>{if(u?.features?.popovers!==!0)return Promise.reject(new l("UNSUPPORTED","This host does not support popovers."));if(!lt(t))return Promise.reject(new l("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...v,type:"popover-open",id:S(d),payload:t})},closePopover:zt,setPopoverAnchorActive:Jt,onResolve:(t)=>(ae=t,()=>{if(ae===t)ae=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Ce)return Promise.reject(new l("HOST_REJECTED",`Toast message must contain 1 to ${Ce} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>ke))return Promise.reject(new l("HOST_REJECTED",`Toast copy text must contain 1 to ${ke} characters.`));return x({channel:E,v:g,type:"toast",id:S(d),payload:{...t,message:o}})},openUrl:(t)=>x({channel:E,v:g,type:"open-url",id:S(d),payload:{url:t}}),...po(x,()=>S(d),(t)=>Promise.reject(new l("HOST_REJECTED",t))),answerBlock:(t)=>x({channel:E,v:g,type:"block-answer",id:S(d),payload:{text:t.trim().slice(0,pt)}}),openSurface:(t)=>x({channel:E,v:g,type:"open-surface",id:S(d),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:E,v:g,type:"clipboard-write",id:S(d),payload:{text:t}}),compose:(t)=>x({channel:E,v:g,type:"compose",id:S(d),payload:t}),attach:(t)=>x({channel:E,v:g,type:"attach",id:S(d),payload:K(t)}),startSession:async(t)=>{if(t.projectId!==void 0)B(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")B(o.directory);else{if(o.name!==void 0)B(o.name,200);if(o.baseBranch!==void 0)B(o.baseBranch,200)}let a=await k({channel:E,v:g,type:"start-session",id:S(d),payload:Tt(t)},e.requestTimeoutMs??180000);if(!dt(a))throw new l("HOST_REJECTED","Host did not return a session.");return a},prompt:(t)=>k({channel:E,v:g,type:"prompt",id:S(d),payload:mt(t)}).then((o)=>{if(!St(o))throw new l("HOST_REJECTED","Host did not return a prompt result.");return o}),...Io(x,()=>S(d),(t,o)=>Promise.reject(new l(t,o)),()=>u?.features?.sessionLinks===!0),close:()=>x({channel:E,v:g,type:"close",id:S(d)}),oauthStart:()=>x({channel:E,v:g,type:"oauth-start",id:S(d)}),oauthDisconnect:()=>x({channel:E,v:g,type:"oauth-disconnect",id:S(d)}),request:(t)=>(we(t.path)?k({channel:E,v:g,type:"request",id:S(d),payload:t}):Mo()).then((o)=>{if(!Ne(o))throw new l("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(we(t.path)?k({channel:E,v:g,type:"service-request",id:S(d),payload:t}):Mo()).then((o)=>{if(!Ne(o))throw new l("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>k({channel:E,v:g,type:"service-status",id:S(d)}).then((t)=>{if(!ht(t))throw new l("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(re(t)?k({channel:E,v:g,type:"file-read",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!yt(o))throw new l("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!re(t))return Le();if(o.length>Me)return Promise.reject(new l("FILE_TOO_LARGE",`Content is over ${Me} characters.`));return k({channel:E,v:g,type:"file-write",id:S(d),payload:{path:t,content:o}}).then((a)=>{if(!bt(a))throw new l("HOST_REJECTED","Host did not confirm the write.");return a})},listDir:(t)=>(re(t)?k({channel:E,v:g,type:"file-list",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!vt(o))throw new l("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(re(t)?k({channel:E,v:g,type:"file-stat",id:S(d),payload:{path:t}}):Le()).then((o)=>{if(!At(o))throw new l("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),a=t.system?.trim();if(o.length===0||o.length>Ge)return Promise.reject(new l("HOST_REJECTED",`Prompt must be 1 to ${Ge} characters.`));if(a!==void 0&&(a.length===0||a.length>Ue))return Promise.reject(new l("HOST_REJECTED",`System prompt must be 1 to ${Ue} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(gt,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new l("HOST_REJECTED","maxOutputTokens must be a number."));let m={prompt:o};if(a!==void 0)m.system=a;if(i!==void 0)m.maxOutputTokens=i;return k({channel:E,v:g,type:"generate",id:S(d),payload:m},e.requestTimeoutMs??_t).then((R)=>{if(!Ot(R))throw new l("HOST_REJECTED","Host did not return generated text.");return R})},onLateGenerateResult:(t)=>{Q.add(t);for(let o of qe.splice(0))f([t],o);return Ft(),()=>{Q.delete(t)}},openMicrophone:Vo,setBadge:(t)=>x({channel:E,v:g,type:"badge",id:S(d),payload:{count:Rt(t)}}),setHeight:(t)=>x({channel:E,v:g,type:"resize",id:S(d),payload:{height:ft(t)}}),onFileOpen:(t)=>{if(Re.add(t),!Ke)Ke=!0,r.addEventListener("keydown",Xt,!0);if(ce)t(ce);return()=>{Re.delete(t)}},onFileSnapshot:(t)=>(ue=t,()=>{if(ue===t)ue=null}),onFileSaved:(t)=>(fe.add(t),()=>{fe.delete(t)}),reportFileChange:(t)=>je({...v,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Wt,reportFileUnsupported:()=>je({...v,type:"file-unsupported"}),dispose:()=>{for(let t of Z.keys())G({...v,type:"workspace-unsubscribe",id:S(d),payload:{subscriptionId:t}});Z.clear();for(let t of ee.keys())G({...v,type:"shells-unsubscribe",id:S(d),payload:{subscriptionId:t}});if(ee.clear(),w)ze(),w.release(),w=null;if(H=!0,ae=null,le=null,ue=null,Re.clear(),fe.clear(),Ke)r.removeEventListener("keydown",Xt,!0);r.removeEventListener("message",Vt),r.removeEventListener("keydown",$t,!0),r.removeEventListener("pointerover",ye),r.removeEventListener("pointermove",ye),r.removeEventListener("pointerout",qt),r.removeEventListener("focus",Kt),r.removeEventListener("blur",jt);for(let t of Y.values())clearTimeout(t.timer),t.reject(new l("HOST_UNAVAILABLE","Host client was disposed."));Y.clear(),c.clear(),_.clear(),b.clear(),T.clear(),C.clear(),D.clear(),ie.clear(),ge.clear(),_e.clear(),Te.clear(),me.clear(),Q.clear(),qe.length=0}}};var Go=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Jr=new Set(Go);var Uo=["none","agent","user"];var Yr=new Set(Uo);var er=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],tr=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],wo=(e,r)=>{r.style.colorScheme=e.mode;for(let[n,p]of er)r.style.setProperty(n,e.tokens[p]);for(let[n,p,c]of tr){let _=e.tokens[c]??"";r.style.setProperty(n,_),r.style.setProperty(p,_)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},kt=(e,r)=>{if(wo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var or={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},y=(e,r)=>`var(--${e}, var(--oc-${or[e]}, ${r}))`,X=y("surface-background","transparent"),Be=y("surface-elevated","transparent"),se=y("surface-elevated-foreground","inherit"),N=y("surface-foreground","inherit"),A=y("surface-muted-foreground","gray"),rr=y("surface-muted","transparent"),j=y("interactive-border","currentColor"),U=y("interactive-hover","transparent"),z=y("interactive-active","transparent"),It=y("interactive-selection","transparent"),Pt=y("interactive-selection-foreground","inherit"),W=y("primary","currentColor"),Mt=y("primary-text","inherit"),Gt=y("error-text","inherit"),sr=y("font-sans","inherit"),Ut=y("font-mono","monospace"),Ho=y("radius","9px"),wt=`calc(${Ho} - 2px)`,No=`calc(${Ho} - 4px)`,O=(e,r,n="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${n})`,Lo=`background-image: linear-gradient(${U}, ${U});`,Nt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,Lt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Do="box-shadow: var(--oc-sdk-lit);",Dt=`inset 0 0.5px 0 0 ${O(N,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,nr=`
:root {
  --oc-sdk-edge: ${O(N,16)};
  --oc-sdk-field-bg: ${Be};
  --oc-sdk-raised-bg: ${X};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${O(N,14)};
  --oc-sdk-field-bg: ${O(X,50,Be)};
  --oc-sdk-raised-bg: ${Be};
  --oc-sdk-field-lift: ${Dt};
  --oc-sdk-raised-lift: ${Dt};
  --oc-sdk-lit: ${Dt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,He=(e)=>{let r=y(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${y(`${e}-text`,"inherit")}; }`},s=(e)=>`calc(${e}rem / 14)`,ir=`
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
`,Bo=`${nr}
.oc-sdk { color: ${N}; font-family: ${sr}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${Lo} }
.oc-sdk-mono { font-family: ${Ut}; }
.oc-sdk-muted { color: ${A}; }
${He("success")}${He("warning")}${He("error")}${He("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${W}; --oc-sdk-tone-text: ${Mt}; }

.oc-sdk-btn { border-radius: ${wt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${No}; }
.oc-sdk-btn[data-variant="default"] { color: ${Mt}; background: ${O(W,10,X)}; border-color: ${O(W,12)}; ${Do} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${O(W,16,X)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${O(W,22,X)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${rr}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${z}, ${z}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${se}; ${Lt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${z}, ${z}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${U}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${z}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${y("status-error","red")}; color: ${Gt}; background: ${O("var(--oc-sdk-tone)",7,X)}; border-color: ${O("var(--oc-sdk-tone)",12)}; ${Do} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${O("var(--oc-sdk-tone)",9,X)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${O("var(--oc-sdk-tone)",11,X)}; box-shadow: none; }

.oc-sdk-field-note { color: ${A}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Gt}; }
.oc-sdk-input { border-radius: ${wt}; background: var(--oc-sdk-field-bg); color: ${se}; ${Nt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${A}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${Nt(O(N,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${Nt(y("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Ut}; }

.oc-sdk-search-icon { color: ${A}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${W}; }
.oc-sdk-search-clear { border-radius: ${No}; color: ${A}; }
.oc-sdk-search-clear:hover { background: ${U}; color: ${N}; }

.oc-sdk-trigger { border-radius: ${wt}; background: var(--oc-sdk-raised-bg); color: ${se}; ${Lt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${U}, ${U}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${z}, ${z}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${A}; }
.oc-sdk-trigger-chevron { color: ${A}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${se}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Be}; background-clip: padding-box; color: ${se}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${U}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${It}; color: ${Pt}; }
.oc-sdk-option-check { color: ${N}; }
.oc-sdk-option[data-destructive="true"] { color: ${Gt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${O(y("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${A}; }
.oc-sdk-popup-empty { color: ${A}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${j}; border-radius: 4px; color: ${N}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${O(N,60,j)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${j}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${X}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${W}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Lo} }
.oc-sdk-check-desc { color: ${A}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${O(N,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${A}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${N}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Pt}; background: ${It}; border-color: ${j}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${se}; background: var(--oc-sdk-raised-bg); ${Lt} }
.oc-sdk-tab-count { color: ${A}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${O(N,6)}; color: ${A}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${O("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${U}; }
.oc-sdk-row[aria-selected="true"] { background: ${It}; color: ${Pt}; }
.oc-sdk-row-lead { font-family: ${Ut}; color: ${A}; }
.oc-sdk-row-sub { color: ${A}; }
.oc-sdk-row-meta { color: ${A}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${A}; }

.oc-sdk-empty-body { color: ${A}; }

.oc-sdk-spinner { color: ${A}; }
.oc-sdk-spinner-ring { border-color: ${j}; border-top-color: ${W}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${O("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${A}; }

.oc-sdk-separator { color: ${A}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${O(j,40)}; }

.oc-sdk-progress-label { color: ${A}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${O(N,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${W}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${y("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${y("success-text","inherit")}; }

.oc-sdk-text a { color: ${Mt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${O(j,60)}; }
`,I=`
${Ye}
${ir}
${Bo}`;var Fo="oc-sdk-ui-style";var P=(e)=>{let r=document.getElementById(Fo);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ze(document);let n=document.createElement("style");n.id=Fo,n.textContent=e,document.head.appendChild(n)},M=(e,r)=>{let n=document.createElement(e);if(r)n.className=r;return n},q=(e)=>{let r=M("button",e);return r.type="button",r},F=(e,r)=>{let n=r??"";if(e.textContent!==n)e.textContent=n};var ar=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},ne=(e,r)=>{P(I);let n=r,p=q("oc-sdk oc-sdk-btn"),c=ar(),_=document.createElement("span");p.append(_),e.append(p);let b=()=>{if(p.dataset.variant=n.variant??"default",p.dataset.size=n.size??"default",p.disabled=Boolean(n.disabled)||Boolean(n.loading),p.dataset.loading=n.loading?"true":"false",p.setAttribute("aria-busy",n.loading?"true":"false"),n.loading&&c.parentNode!==p)p.prepend(c);else if(!n.loading&&c.parentNode===p)c.remove();F(_,n.label)},T=()=>{if(n.disabled||n.loading)return;n.onClick()};return p.addEventListener("click",T),b(),{update:(C)=>{n={...n,...C},b()},dispose:()=>{p.removeEventListener("click",T),p.remove()}}};var $e=Ct(),J=document.querySelector("#root");if(!J)throw Error("DeskChart: missing root");J.style.padding="12px";$e.onReady((e)=>kt(e,document.documentElement));$e.onBlock(({args:e,answered:r})=>{let n=(e.values??"").split(",").map(Number).filter(Number.isFinite),p=Math.max(1,...n);J.replaceChildren();let c=document.createElement("div");c.textContent=e.title??"",c.style.font="600 13px var(--oc-font, system-ui)";let _=document.createElement("div");_.style.cssText="display:flex;align-items:flex-end;gap:6px;height:96px;margin-top:8px";for(let T of n){let C=document.createElement("div");C.style.cssText=`flex:1;height:${T/p*100}%;background:currentColor;opacity:.6;border-radius:3px 3px 0 0`,C.title=String(T),_.append(C)}J.append(c,_);let b=document.createElement("div");b.style.marginTop="10px",J.append(b),ne(b,{label:r??"Explain this",variant:"outline",size:"sm",disabled:r!==null,onClick:()=>{$e.answerBlock("Explain this chart")}})});new ResizeObserver(()=>{$e.setHeight(Math.ceil(J.getBoundingClientRect().height))}).observe(J);})();
