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
`;function We(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(d)=>{let S=d.target===e?r:d.target;if(!(S instanceof Element))return;if(!S.hasAttribute("data-oc-scrolling"))S.setAttribute("data-oc-scrolling","");let _=s.get(S);if(_!==void 0)clearTimeout(_);s.set(S,setTimeout(()=>{s.delete(S),S.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Uo=`(${We.toString()})(document);`;var Ke=128,je=65536;var ye=128;var Re=65536;var Wt=/^[a-z][a-z0-9-]{0,39}$/;var $t=(e)=>Object(e)===e&&!Array.isArray(e),ze=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Xt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,qt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Kt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!$t(s)||!Wt.test(s.id)||!Xt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!ze(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!ze(s,["kind","id","label","value","options","disabled"]))return!1;if(!qt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let d=new Set;for(let S of s.options){if(!$t(S)||!ze(S,["value","label"])||!qt(S.value)||!Xt(S.label)||d.has(S.value))return!1;d.add(S.value)}if(!d.has(s.value))return!1}return!0};var jt=["{id}","{segment}","{segments+}"];var cr=new Set(jt);var zt=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var dr=new Set(zt);var he=20000000,be=256;var Je=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Jt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var Qt=/^[A-Za-z0-9_-]{1,80}$/;var Yt=["left","right","top","bottom"];var Zt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let d=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let S of d)if(!Zt(S,r+1,s))return!1;return!0},Qe=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Qe);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Qe)}return String(e)===e||Number.isFinite(e)},Ye=(e)=>{try{if(String(e.id)!==e.id||!Qt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Yt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Zt(e.data)||!Qe(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var et=2000;var to=["file","directory","other","missing"],tt=(e)=>Boolean(e&&"sessionId"in e),ot=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var oo=/^[0-9a-f]{7,64}$/i,rt=(e)=>oo.test(e),ve=500,Oe=32000,ro=16000,so=128,no=200,io=2000,ao=16000,lo=80,uo=200,co=16000;var po=2000;var st=20000,xe=1024,Ae=2000000;var Ce=64000,ke=8000,nt=4000;var it=960000;var So=999,Eo=1e4,ce=500,go=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],_o=["stopped","starting","ready","failed"],No=new Set(go),To=(e)=>No.has(e),mo=(e)=>e&&To(e)?e:"HOST_REJECTED",Z=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(Z);if(Object(e)===e)return Object.values(e).every(Z);return!1},fo=(e)=>Z(e)&&JSON.stringify(e).length<=co,eo=(e)=>e?.trim().slice(0,uo)??"",ee=(e)=>{let r=e.id.trim().slice(0,so),s=e.title.trim().slice(0,no),d=e.url.trim().slice(0,io),S=e.text?.trim().slice(0,ao),_=e.author?.trim().slice(0,lo),C=e.kind==="pull"?"pull":"issue",R={providerId:e.providerId.trim(),id:r,title:s||r,url:d,kind:C};if(S)R.text=S;if(_)R.author=_;if(C==="pull"){let k=eo(e.branches?.head),U=eo(e.branches?.base);if(k&&U)R.branches={head:k,base:U}}if(fo(e.data))R.data=e.data;return R},at=(e)=>{let r=ee(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},lt=(e)=>{let r={text:e.text.trim().slice(0,ro)};if(e.send)r.send=!0;return r},ut=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(So,Math.max(0,Math.round(e)))},ct=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Eo,Math.max(0,Math.ceil(e)))};var te=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var Ie=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>po)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Lo=new Set(_o),pt=(e)=>Boolean(e&&"status"in e&&Lo.has(String(e.status))&&!("body"in e)),Pe=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),dt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),St=(e)=>Boolean(e&&"written"in e&&e.written===!0),Et=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Do=new Set(to),gt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Do.has(String(e.kind))&&Number.isFinite(e.size)),_t=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Ho=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Bo=(e)=>Object(e)===e?e:null,Ze=(e)=>String(e)===e&&e.length>0,Fo=(e)=>{if(!Ze(e.id))return null;if(e.ok===!0){let r={channel:E,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ze(e.error))return{channel:E,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:mo(Ze(e.code)?e.code:void 0)};return null},Tt=(e)=>{let r=Bo(e);if(!r||r.channel!==E||r.v!==g)return null;if(r.type==="result")return Fo(r);if(!Ho.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var yo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Vo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class u extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var Ro=()=>Promise.reject(new u("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ge=()=>Promise.reject(new u("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Me=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new u("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},p=(e)=>(e.value+=1,`oc-${e.value}`),mt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new u("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),d=e.requestTimeoutMs??st,S=new Set,_=new Set,C=new Set,R=new Set,k=new Set,U=new Set,X=new Set,pe=new Set,de=new Set,Se=new Set,Ee=new Set,z=new Set,Be=[],se=null,ne=null,ge=new Set,_e=new Set,ie=null,ae=null,Fe=!1,J=new Map,Q=new Map,Y=new Map,H=!1,c={value:0},l=null,B=null,le=!1,ue=!1,Pt=null,Gt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},w=(t)=>{r.parent.postMessage(t,"*")},Mt=()=>{if(H||r.parent===r||z.size===0||l?.features?.lateGenerateResults!==!0)return;w({channel:E,v:g,type:"generate-late-listen"})},y=(t,o)=>{for(let i of t)try{i(o)}catch(a){console.error(a)}},Ut=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=Tt(t.data);if(!o)return;if(o.type==="workspace"){let a=Q.get(o.payload.subscriptionId);if(a)y([a],o.payload.snapshot);return}if(o.type==="shells"){let a=Y.get(o.payload.subscriptionId);if(a)y([a],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,B=Gt(o.payload.session),y(S,o.payload),y(_,o.payload.directory),y(C,o.payload.session),B)y(R,B);if(y(k,o.payload.connection),y(U,o.payload.settings),y(X,o.payload.item),o.payload.block)y(pe,o.payload.block);Mt();return}if(o.type==="service-event"){y(de,o.payload);return}if(o.type==="generate-late"){if(z.size===0)Be.push(o.payload);else y(z,o.payload);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};y(_,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)B=null;else if(B?.sessionId!==o.payload.session.id)B=Gt(o.payload.session);y(C,o.payload.session);return}if(o.type==="session-lifecycle"){B=o.payload,y(R,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};y(k,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};y(U,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};y(X,o.payload.item);return}if(o.type==="status-control-event"){y(Se,o.payload);return}if(o.type==="popover-closed"){y(Ee,o.payload);return}if(o.type==="action"){let a=(T)=>{if(!H)w({channel:E,v:g,type:"action-result",id:o.id,payload:T})},m=ne;if(!m){a({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>m(o.payload)).then(()=>a({ok:!0}),(T)=>{let A=(T instanceof Error?T.message:String(T)).trim();a({ok:!1,error:(A||"Action failed.").slice(0,ce)})});return}if(o.type==="file-open"){let a=o.payload;if(ae&&Jt(ae,a))return;ae=a,y(ge,o.payload);return}if(o.type==="file-saved"){y(_e,o.payload.version);return}if(o.type==="file-snapshot"){let a=(A)=>{if(!H)w({channel:E,v:g,type:"file-snapshot-result",id:o.id,payload:A})},m=(A)=>a({error:(A.trim()||"Could not read the edited file.").slice(0,ce)}),T=ie;if(!T){m("This extension does not edit files.");return}Promise.resolve().then(()=>T(o.payload.purpose)).then((A)=>{if(Je(A)>he){m(`The file is over ${he} ${"bytes"in A?"bytes":"characters"}.`);return}if(A.version.length>be){m(`The snapshot version is over ${be} characters.`);return}a({snapshot:"bytes"in A?{bytes:A.bytes,version:A.version}:{content:A.content,version:A.version}})},(A)=>m(A instanceof Error?A.message:String(A)));return}if(o.type==="resolve"){let a=(T)=>{w({channel:E,v:g,type:"resolve-result",id:o.id,payload:T})},m=se;if(!m){a({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>m(o.payload)).then((T)=>a({item:T?ee(T):null}),(T)=>{let A=(T instanceof Error?T.message:String(T)).trim();a({error:(A||"Command failed.").slice(0,ce)})});return}let i=J.get(o.id);if(!i)return;if(clearTimeout(i.timer),J.delete(o.id),o.ok){i.resolve(o.payload);return}i.reject(new u(o.code,o.error))};r.addEventListener("message",Ut),w({channel:E,v:g,type:"hello"});let G=(t,o=d)=>{if(H||r.parent===r)return Promise.reject(new u("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((i,a)=>{let m=setTimeout(()=>{J.delete(t.id),a(new u("HOST_TIMEOUT","Host did not answer in time."))},o);J.set(t.id,{resolve:i,reject:a,timer:m}),w(t)})},v=(t)=>G(t).then(()=>{return}),x={channel:E,v:g},Ve=(t)=>{if(!H&&r.parent!==r)w(t)},wt=()=>Ve({...x,type:"file-save"}),Nt=(t)=>{if(!yo(t)||!Vo(t))return;t.preventDefault(),wt()},Lt=(t)=>{if(!yo(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),Ft(l.popover.id,"escape").catch(()=>{return})},Te=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=le||ue;if(Pt===o)return;Pt=o,Vt(t.id,o).catch(()=>{return})},me=()=>{if(l?.surface!=="popover"||le)return;le=!0,Te()},Dt=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!le)return;le=!1,Te()},Ht=()=>{if(l?.surface!=="popover"||ue)return;ue=!0,Te()},Bt=()=>{if(l?.surface!=="popover"||!ue)return;ue=!1,Te()},D=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new u("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},$e=async(t)=>{if(t.kind!=="projects")D(t.projectId);let o=await G({...x,type:"workspace-read",id:p(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new u("HOST_REJECTED","Host did not return workspace data.");return o},Xe=async(t,o)=>{if(t.kind!=="projects")D(t.projectId);let i=p(c);Q.set(i,o);try{await v({...x,type:"workspace-subscribe",id:p(c),payload:{subscriptionId:i,query:t}})}catch(a){if(Q.delete(i),!H)w({...x,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:i}});throw a}return()=>{if(!Q.delete(i)||H)return;w({...x,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:i}})}},Mo=async(t,o)=>{if(t.kind==="session")D(t.sessionId);if(t.kind==="project")D(t.projectId);let i=p(c);Y.set(i,o);try{await v({...x,type:"shells-subscribe",id:p(c),payload:{subscriptionId:i,scope:t}})}catch(a){if(Y.delete(i),!H)w({...x,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:i}});throw a}return()=>{if(!Y.delete(i)||H)return;w({...x,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:i}})}},fe=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ke))throw new u("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!Z(t.value))throw new u("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>je)throw new u("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new u("UNSUPPORTED","This host does not support device storage.");let o=await G({...x,type:"storage",id:p(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new u("HOST_REJECTED","Host did not return storage data.");return o},Ft=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):v({...x,type:"popover-close",id:p(c),payload:o?{id:t,reason:o}:{id:t}}),Vt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new u("UNSUPPORTED","This host does not support popovers.")):v({...x,type:"popover-anchor",id:p(c),payload:{id:t,active:o}});return r.addEventListener("keydown",Lt,!0),r.addEventListener("pointerover",me),r.addEventListener("pointermove",me),r.addEventListener("pointerout",Dt),r.addEventListener("focus",Ht),r.addEventListener("blur",Bt),{onAction:(t)=>(ne=t,()=>{if(ne===t)ne=null}),listProjects:async()=>{let t=await $e({kind:"projects"});if(t.kind!=="projects")throw new u("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await $e({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new u("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await $e({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new u("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Xe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Xe({kind:"worktrees",projectId:t},(i)=>{if(i.kind==="worktrees")o(i)}),onSessions:(t,o)=>Xe({kind:"sessions",projectId:t},(i)=>{if(i.kind==="sessions")o(i)}),onRunningShells:(t,o)=>Mo(t,o),readShellOutput:async(t,o)=>{D(t,ye);let i=o?.cursor;if(i!==void 0&&(!Number.isInteger(i)||i<0))throw new u("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let a=o?.tailBytes;if(a!==void 0&&(!Number.isInteger(a)||a<1||a>Re))throw new u("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${Re}.`);let T=await G({...x,type:"shell-output",id:p(c),payload:{shellId:t,cursor:i,tailBytes:a}});if(!T||typeof T.output!=="string"||!Number.isFinite(T.cursor))throw new u("HOST_REJECTED","Host did not return shell output.");return T},stopShell:async(t)=>{if(D(t,ye),(await G({...x,type:"shell-stop",id:p(c),payload:{shellId:t}}))?.stopped!==!0)throw new u("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{D(t),await v({...x,type:"open-session",id:p(c),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let i=Me(o),a={op:"get",key:t};if(i)a.scope=i;let m=await fe(a);return m.op==="get"&&m.found?m.value:void 0},set:async(t,o,i)=>{let a=Me(i),m={op:"set",key:t,value:o};if(a)m.scope=a;await fe(m)},delete:async(t,o)=>{let i=Me(o),a={op:"delete",key:t};if(i)a.scope=i;await fe(a)},keys:async(t)=>{let o=Me(t),i={op:"keys"};if(o)i.scope=o;let a=await fe(i);if(a.op!=="keys")throw new u("HOST_REJECTED","Expected storage keys.");return a.keys}},onReady:(t)=>{if(S.add(t),l)t(l);return()=>{S.delete(t)}},onDirectory:(t)=>{if(_.add(t),l)t(l.directory);return()=>{_.delete(t)}},onSession:(t)=>{if(C.add(t),l)t(l.session);return()=>{C.delete(t)}},onSessionLifecycle:(t)=>{if(R.add(t),B)t(B);return()=>{R.delete(t)}},onConnection:(t)=>{if(k.add(t),l)t(l.connection);return()=>{k.delete(t)}},onSettings:(t)=>{if(U.add(t),l)t(l.settings);return()=>{U.delete(t)}},onItem:(t)=>{if(X.add(t),l)t(l.item);return()=>{X.delete(t)}},onBlock:(t)=>{if(pe.add(t),l?.block)t(l.block);return()=>{pe.delete(t)}},onServiceEvent:(t)=>(de.add(t),()=>{de.delete(t)}),onStatusControl:(t)=>(Se.add(t),()=>{Se.delete(t)}),onPopoverClosed:(t)=>(Ee.add(t),()=>{Ee.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support status controls."));if(!Kt(t))return Promise.reject(new u("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return v({...x,type:"status-controls",id:p(c),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new u("UNSUPPORTED","This host does not support popovers."));if(!Ye(t))return Promise.reject(new u("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return v({...x,type:"popover-open",id:p(c),payload:t})},closePopover:Ft,setPopoverAnchorActive:Vt,onResolve:(t)=>(se=t,()=>{if(se===t)se=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>ve)return Promise.reject(new u("HOST_REJECTED",`Toast message must contain 1 to ${ve} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Oe))return Promise.reject(new u("HOST_REJECTED",`Toast copy text must contain 1 to ${Oe} characters.`));return v({channel:E,v:g,type:"toast",id:p(c),payload:{...t,message:o}})},openUrl:(t)=>v({channel:E,v:g,type:"open-url",id:p(c),payload:{url:t}}),openCommit:(t)=>rt(t)?v({channel:E,v:g,type:"open-commit",id:p(c),payload:{sha:t}}):Promise.reject(new u("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),answerBlock:(t)=>v({channel:E,v:g,type:"block-answer",id:p(c),payload:{text:t.trim().slice(0,et)}}),openSurface:(t)=>v({channel:E,v:g,type:"open-surface",id:p(c),payload:{surfaceId:t}}),writeClipboard:(t)=>v({channel:E,v:g,type:"clipboard-write",id:p(c),payload:{text:t}}),compose:(t)=>v({channel:E,v:g,type:"compose",id:p(c),payload:t}),attach:(t)=>v({channel:E,v:g,type:"attach",id:p(c),payload:ee(t)}),startSession:async(t)=>{if(t.projectId!==void 0)D(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")D(o.directory);else{if(o.name!==void 0)D(o.name,200);if(o.baseBranch!==void 0)D(o.baseBranch,200)}let i=await G({channel:E,v:g,type:"start-session",id:p(c),payload:at(t)},e.requestTimeoutMs??180000);if(!tt(i))throw new u("HOST_REJECTED","Host did not return a session.");return i},prompt:(t)=>G({channel:E,v:g,type:"prompt",id:p(c),payload:lt(t)}).then((o)=>{if(!ot(o))throw new u("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>v({channel:E,v:g,type:"session-link",id:p(c),payload:ee(t)}),close:()=>v({channel:E,v:g,type:"close",id:p(c)}),oauthStart:()=>v({channel:E,v:g,type:"oauth-start",id:p(c)}),oauthDisconnect:()=>v({channel:E,v:g,type:"oauth-disconnect",id:p(c)}),request:(t)=>(Ie(t.path)?G({channel:E,v:g,type:"request",id:p(c),payload:t}):Ro()).then((o)=>{if(!Pe(o))throw new u("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ie(t.path)?G({channel:E,v:g,type:"service-request",id:p(c),payload:t}):Ro()).then((o)=>{if(!Pe(o))throw new u("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>G({channel:E,v:g,type:"service-status",id:p(c)}).then((t)=>{if(!pt(t))throw new u("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(te(t)?G({channel:E,v:g,type:"file-read",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!dt(o))throw new u("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!te(t))return Ge();if(o.length>Ae)return Promise.reject(new u("FILE_TOO_LARGE",`Content is over ${Ae} characters.`));return G({channel:E,v:g,type:"file-write",id:p(c),payload:{path:t,content:o}}).then((i)=>{if(!St(i))throw new u("HOST_REJECTED","Host did not confirm the write.");return i})},listDir:(t)=>(te(t)?G({channel:E,v:g,type:"file-list",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!Et(o))throw new u("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(te(t)?G({channel:E,v:g,type:"file-stat",id:p(c),payload:{path:t}}):Ge()).then((o)=>{if(!gt(o))throw new u("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),i=t.system?.trim();if(o.length===0||o.length>Ce)return Promise.reject(new u("HOST_REJECTED",`Prompt must be 1 to ${Ce} characters.`));if(i!==void 0&&(i.length===0||i.length>ke))return Promise.reject(new u("HOST_REJECTED",`System prompt must be 1 to ${ke} characters.`));let a=t.maxOutputTokens===void 0?void 0:Math.min(nt,Math.max(1,Math.floor(t.maxOutputTokens)));if(a!==void 0&&!Number.isFinite(a))return Promise.reject(new u("HOST_REJECTED","maxOutputTokens must be a number."));let m={prompt:o};if(i!==void 0)m.system=i;if(a!==void 0)m.maxOutputTokens=a;return G({channel:E,v:g,type:"generate",id:p(c),payload:m},e.requestTimeoutMs??it).then((T)=>{if(!_t(T))throw new u("HOST_REJECTED","Host did not return generated text.");return T})},onLateGenerateResult:(t)=>{z.add(t);for(let o of Be.splice(0))y([t],o);return Mt(),()=>{z.delete(t)}},setBadge:(t)=>v({channel:E,v:g,type:"badge",id:p(c),payload:{count:ut(t)}}),setHeight:(t)=>v({channel:E,v:g,type:"resize",id:p(c),payload:{height:ct(t)}}),onFileOpen:(t)=>{if(ge.add(t),!Fe)Fe=!0,r.addEventListener("keydown",Nt,!0);if(ae)t(ae);return()=>{ge.delete(t)}},onFileSnapshot:(t)=>(ie=t,()=>{if(ie===t)ie=null}),onFileSaved:(t)=>(_e.add(t),()=>{_e.delete(t)}),reportFileChange:(t)=>Ve({...x,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:wt,reportFileUnsupported:()=>Ve({...x,type:"file-unsupported"}),dispose:()=>{for(let t of Q.keys())w({...x,type:"workspace-unsubscribe",id:p(c),payload:{subscriptionId:t}});Q.clear();for(let t of Y.keys())w({...x,type:"shells-unsubscribe",id:p(c),payload:{subscriptionId:t}});if(Y.clear(),H=!0,se=null,ne=null,ie=null,ge.clear(),_e.clear(),Fe)r.removeEventListener("keydown",Nt,!0);r.removeEventListener("message",Ut),r.removeEventListener("keydown",Lt,!0),r.removeEventListener("pointerover",me),r.removeEventListener("pointermove",me),r.removeEventListener("pointerout",Dt),r.removeEventListener("focus",Ht),r.removeEventListener("blur",Bt);for(let t of J.values())clearTimeout(t.timer),t.reject(new u("HOST_UNAVAILABLE","Host client was disposed."));J.clear(),S.clear(),_.clear(),C.clear(),R.clear(),k.clear(),U.clear(),X.clear(),pe.clear(),de.clear(),Se.clear(),Ee.clear(),z.clear(),Be.length=0}}};var ho=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Ar=new Set(ho);var bo=["none","agent","user"];var kr=new Set(bo);var $o=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Xo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],vo=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,d]of $o)r.style.setProperty(s,e.tokens[d]);for(let[s,d,S]of Xo){let _=e.tokens[S]??"";r.style.setProperty(s,_),r.style.setProperty(d,_)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size",e.tokens.fontSize??"0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},ft=(e,r)=>{if(vo(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var qo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},f=(e,r)=>`var(--${e}, var(--oc-${qo[e]}, ${r}))`,V=f("surface-background","transparent"),we=f("surface-elevated","transparent"),oe=f("surface-elevated-foreground","inherit"),N=f("surface-foreground","inherit"),h=f("surface-muted-foreground","gray"),Wo=f("surface-muted","transparent"),W=f("interactive-border","currentColor"),M=f("interactive-hover","transparent"),K=f("interactive-active","transparent"),yt=f("interactive-selection","transparent"),Rt=f("interactive-selection-foreground","inherit"),F=f("primary","currentColor"),ht=f("primary-text","inherit"),bt=f("error-text","inherit"),Ko=f("font-sans","inherit"),vt=f("font-mono","monospace"),Co=f("radius","9px"),Ot=`calc(${Co} - 2px)`,Oo=`calc(${Co} - 4px)`,b=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,xo=`background-image: linear-gradient(${M}, ${M});`,xt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,At="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Ao="box-shadow: var(--oc-sdk-lit);",Ct=`inset 0 0.5px 0 0 ${b(N,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,jo=`
:root {
  --oc-sdk-edge: ${b(N,16)};
  --oc-sdk-field-bg: ${we};
  --oc-sdk-raised-bg: ${V};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${b(N,14)};
  --oc-sdk-field-bg: ${b(V,50,we)};
  --oc-sdk-raised-bg: ${we};
  --oc-sdk-field-lift: ${Ct};
  --oc-sdk-raised-lift: ${Ct};
  --oc-sdk-lit: ${Ct};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Ue=(e)=>{let r=f(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${f(`${e}-text`,"inherit")}; }`},n=(e)=>`calc(${e}rem / 14)`,zo=`
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
`,ko=`${jo}
.oc-sdk { color: ${N}; font-family: ${Ko}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${xo} }
.oc-sdk-mono { font-family: ${vt}; }
.oc-sdk-muted { color: ${h}; }
${Ue("success")}${Ue("warning")}${Ue("error")}${Ue("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${ht}; }

.oc-sdk-btn { border-radius: ${Ot}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Oo}; }
.oc-sdk-btn[data-variant="default"] { color: ${ht}; background: ${b(F,10,V)}; border-color: ${b(F,12)}; ${Ao} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${b(F,16,V)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${b(F,22,V)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Wo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${K}, ${K}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${oe}; ${At} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${K}, ${K}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${M}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${K}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${f("status-error","red")}; color: ${bt}; background: ${b("var(--oc-sdk-tone)",7,V)}; border-color: ${b("var(--oc-sdk-tone)",12)}; ${Ao} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${b("var(--oc-sdk-tone)",9,V)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${b("var(--oc-sdk-tone)",11,V)}; box-shadow: none; }

.oc-sdk-field-note { color: ${h}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${bt}; }
.oc-sdk-input { border-radius: ${Ot}; background: var(--oc-sdk-field-bg); color: ${oe}; ${xt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${h}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${xt(b(N,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${xt(f("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${vt}; }

.oc-sdk-search-icon { color: ${h}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${Oo}; color: ${h}; }
.oc-sdk-search-clear:hover { background: ${M}; color: ${N}; }

.oc-sdk-trigger { border-radius: ${Ot}; background: var(--oc-sdk-raised-bg); color: ${oe}; ${At} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${K}, ${K}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${h}; }
.oc-sdk-trigger-chevron { color: ${h}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${oe}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${we}; background-clip: padding-box; color: ${oe}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${M}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${yt}; color: ${Rt}; }
.oc-sdk-option-check { color: ${N}; }
.oc-sdk-option[data-destructive="true"] { color: ${bt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${b(f("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${h}; }
.oc-sdk-popup-empty { color: ${h}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${W}; border-radius: 4px; color: ${N}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${b(N,60,W)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${W}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${V}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(var(--oc-sdk-thumb-travel, 16px)); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${xo} }
.oc-sdk-check-desc { color: ${h}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${b(N,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${h}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${N}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Rt}; background: ${yt}; border-color: ${W}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${oe}; background: var(--oc-sdk-raised-bg); ${At} }
.oc-sdk-tab-count { color: ${h}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${b(N,6)}; color: ${h}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${b("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${yt}; color: ${Rt}; }
.oc-sdk-row-lead { font-family: ${vt}; color: ${h}; }
.oc-sdk-row-sub { color: ${h}; }
.oc-sdk-row-meta { color: ${h}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${h}; }

.oc-sdk-empty-body { color: ${h}; }

.oc-sdk-spinner { color: ${h}; }
.oc-sdk-spinner-ring { border-color: ${W}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${b("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${h}; }

.oc-sdk-separator { color: ${h}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${b(W,40)}; }

.oc-sdk-progress-label { color: ${h}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${b(N,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${f("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${f("success-text","inherit")}; }

.oc-sdk-text a { color: ${ht}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${b(W,60)}; }
`,I=`
${qe}
${zo}
${ko}`;var Io="oc-sdk-ui-style";var P=(e)=>{let r=document.getElementById(Io);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}We(document);let s=document.createElement("style");s.id=Io,s.textContent=e,document.head.appendChild(s)},O=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},q=(e)=>{let r=O("button",e);return r.type="button",r},L=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s},j=(e,r,s)=>{if(s===void 0||s===null||s==="")e.removeAttribute(r);else if(e.getAttribute(r)!==s)e.setAttribute(r,s)};var Jo=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},re=(e,r)=>{P(I);let s=r,d=q("oc-sdk oc-sdk-btn"),S=Jo(),_=document.createElement("span");d.append(_),e.append(d);let C=()=>{if(d.dataset.variant=s.variant??"default",d.dataset.size=s.size??"default",d.disabled=Boolean(s.disabled)||Boolean(s.loading),d.dataset.loading=s.loading?"true":"false",d.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&S.parentNode!==d)d.prepend(S);else if(!s.loading&&S.parentNode===d)S.remove();L(_,s.label)},R=()=>{if(s.disabled||s.loading)return;s.onClick()};return d.addEventListener("click",R),C(),{update:(k)=>{s={...s,...k},C()},dispose:()=>{d.removeEventListener("click",R),d.remove()}}};var kt=(e,r)=>{P(I);let s=r,d=O("label","oc-sdk oc-sdk-field"),S=O("span","oc-sdk-field-label"),_=s.multiline?O("textarea","oc-sdk-input"):O("input","oc-sdk-input"),C=O("span","oc-sdk-field-note");d.append(S,_,C),e.append(d);let R=()=>{if(L(S,s.label),S.hidden=!s.label,_ instanceof HTMLInputElement)_.type=s.password?"password":"text";else _.rows=s.rows??3;if(_.value!==s.value)_.value=s.value;_.disabled=Boolean(s.disabled),j(_,"placeholder",s.placeholder),_.dataset.mono=s.mono?"true":"false";let U=Boolean(s.error);d.dataset.invalid=U?"true":"false",_.setAttribute("aria-invalid",U?"true":"false");let X=s.error??s.helper??"";L(C,X),C.hidden=X===""},k=()=>{s.onChange(_.value)};return _.addEventListener("input",k),R(),{update:(U)=>{s={...s,...U},R()},dispose:()=>{_.removeEventListener("input",k),d.remove()}}};var It=mt(),Go=document.querySelector("#root");if(!Go)throw Error("Missing root");var Po=!1;It.onReady((e)=>{if(ft(e,document.documentElement),Po)return;Po=!0;let r=document.createElement("div");r.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",Go.append(r);let s="",d=document.createElement("div");d.style.flex="1",r.append(d);let S=kt(d,{value:s,placeholder:"https://example.com",mono:!0,onChange:(R)=>{s=R,S.update({value:R})}}),_=re(r,{label:"Go",size:"sm",onClick:()=>{if(!s.trim())return;_.update({loading:!0}),It.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:s.trim()})}).then(()=>C()).finally(()=>_.update({loading:!1}))}}),C=async()=>{try{let R=await It.serviceRequest({method:"GET",path:"/state"}),k=JSON.parse(R.body);if(String(k.url)===k.url&&k.url!==s)s=k.url==="about:blank"?"":k.url,S.update({value:s})}catch{}};C(),setInterval(()=>{C()},2000)});})();
