(()=>{var p="openchamber.sdk",d=1;var qe=`
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
`;function Bt(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let l=new WeakMap;e.addEventListener("scroll",(y)=>{let S=y.target===e?r:y.target;if(!(S instanceof Element))return;if(!S.hasAttribute("data-oc-scrolling"))S.setAttribute("data-oc-scrolling","");let v=l.get(S);if(v!==void 0)clearTimeout(v);l.set(S,setTimeout(()=>{l.delete(S),S.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var ko=`(${Bt.toString()})(document);`;var We=128,$e=65536;var me=128;var fe=65536;var qt=/^[a-z][a-z0-9-]{0,39}$/;var Ft=(e)=>Object(e)===e&&!Array.isArray(e),Ke=(e,r)=>Object.keys(e).every((l)=>r.includes(l)),Vt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Xt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Wt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let l of e){if(!Ft(l)||!qt.test(l.id)||!Vt(l.label))return!1;if(l.disabled!==void 0&&l.disabled!==!0&&l.disabled!==!1)return!1;if(r.has(l.id))return!1;if(r.add(l.id),l.kind==="button"){if(!Ke(l,["kind","id","label","disabled"]))return!1;continue}if(l.kind!=="select"||!Ke(l,["kind","id","label","value","options","disabled"]))return!1;if(!Xt(l.value)||!Array.isArray(l.options)||l.options.length<1||l.options.length>16)return!1;let y=new Set;for(let S of l.options){if(!Ft(S)||!Ke(S,["value","label"])||!Xt(S.value)||!Vt(S.label)||y.has(S.value))return!1;y.add(S.value)}if(!y.has(l.value))return!1}return!0};var $t=["{id}","{segment}","{segments+}"];var sr=new Set($t);var Kt=["turn-finished","turn-failed","permission-asked","question-asked","turn-started","session-created","session-archived","session-deleted"];var ir=new Set(Kt);var ye=20000000,Re=256;var je=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,jt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let l=0;l<e.bytes.byteLength;l+=1)if(e.bytes[l]!==r.bytes[l])return!1;return!0};var zt=/^[A-Za-z0-9_-]{1,80}$/;var Jt=["left","right","top","bottom"];var Qt=(e,r=0,l={remaining:16000})=>{if(--l.remaining<0||r>=32)return!1;if(e===null)return!0;let y=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let S of y)if(!Qt(S,r+1,l))return!1;return!0},ze=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(ze);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(ze)}return String(e)===e||Number.isFinite(e)},Je=(e)=>{try{if(String(e.id)!==e.id||!zt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Jt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Qt(e.data)||!ze(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var Zt=["file","directory","other","missing"],Ye=(e)=>Boolean(e&&"sessionId"in e),Ze=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var eo=/^[0-9a-f]{7,64}$/i,et=(e)=>eo.test(e),he=500,be=32000,to=16000,oo=128,ro=200,so=2000,no=16000,io=80,ao=200,lo=16000;var uo=2000;var tt=20000,ve=1024,xe=2000000;var Oe=64000,Ae=8000,ot=4000;var rt=960000;var co=999,po=1e4,ae=500,So=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],Eo=["stopped","starting","ready","failed"],Po=new Set(So),go=(e)=>Po.has(e),_o=(e)=>e&&go(e)?e:"HOST_REJECTED",z=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(z);if(Object(e)===e)return Object.values(e).every(z);return!1},To=(e)=>z(e)&&JSON.stringify(e).length<=lo,Yt=(e)=>e?.trim().slice(0,ao)??"",J=(e)=>{let r=e.id.trim().slice(0,oo),l=e.title.trim().slice(0,ro),y=e.url.trim().slice(0,so),S=e.text?.trim().slice(0,no),v=e.author?.trim().slice(0,io),M=e.kind==="pull"?"pull":"issue",G={providerId:e.providerId.trim(),id:r,title:l||r,url:y,kind:M};if(S)G.text=S;if(v)G.author=v;if(M==="pull"){let B=Yt(e.branches?.head),F=Yt(e.branches?.base);if(B&&F)G.branches={head:B,base:F}}if(To(e.data))G.data=e.data;return G},st=(e)=>{let r=J(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},nt=(e)=>{let r={text:e.text.trim().slice(0,to)};if(e.send)r.send=!0;return r},it=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(co,Math.max(0,Math.round(e)))},at=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(po,Math.max(0,Math.ceil(e)))};var Q=(e)=>e.length>0&&e.length<=ve&&!e.includes("\x00")&&!e.includes("\\");var Ce=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>uo)return!1;return!e.split("/").some((l)=>l==="."||l==="..")},Mo=new Set(Eo),lt=(e)=>Boolean(e&&"status"in e&&Mo.has(String(e.status))&&!("body"in e)),ke=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),ut=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),ct=(e)=>Boolean(e&&"written"in e&&e.written===!0),pt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Go=new Set(Zt),dt=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Go.has(String(e.kind))&&Number.isFinite(e.size)),St=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Uo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","service-event","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),wo=(e)=>Object(e)===e?e:null,Qe=(e)=>String(e)===e&&e.length>0,No=(e)=>{if(!Qe(e.id))return null;if(e.ok===!0){let r={channel:p,v:d,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Qe(e.error))return{channel:p,v:d,type:"result",id:e.id,ok:!1,error:e.error,code:_o(Qe(e.code)?e.code:void 0)};return null},Et=(e)=>{let r=wo(e);if(!r||r.channel!==p||r.v!==d)return null;if(r.type==="result")return No(r);if(!Uo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var mo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Lo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class a extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var fo=()=>Promise.reject(new a("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ie=()=>Promise.reject(new a("BAD_PATH",`File path must be 1 to ${ve} characters without NUL or backslash.`)),Pe=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new a("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},c=(e)=>(e.value+=1,`oc-${e.value}`),gt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new a("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let l=e.acceptSource??((t)=>t===r.parent),y=e.requestTimeoutMs??tt,S=new Set,v=new Set,M=new Set,G=new Set,B=new Set,F=new Set,ee=new Set,ue=new Set,ce=new Set,pe=new Set,de=new Set,q=new Set,He=[],te=null,oe=null,Se=new Set,Ee=new Set,re=null,se=null,Be=!1,W=new Map,K=new Map,j=new Map,w=!1,u={value:0},i=null,N=null,ne=!1,ie=!1,Ct=null,kt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},I=(t)=>{r.parent.postMessage(t,"*")},It=()=>{if(w||r.parent===r||q.size===0||i?.features?.lateGenerateResults!==!0)return;I({channel:p,v:d,type:"generate-late-listen"})},T=(t,o)=>{for(let s of t)try{s(o)}catch(n){console.error(n)}},Pt=(t)=>{if(!(t instanceof MessageEvent))return;if(!l(t.source))return;let o=Et(t.data);if(!o)return;if(o.type==="workspace"){let n=K.get(o.payload.subscriptionId);if(n)T([n],o.payload.snapshot);return}if(o.type==="shells"){let n=j.get(o.payload.subscriptionId);if(n)T([n],o.payload.snapshot);return}if(o.type==="ready"){if(i=o.payload,N=kt(o.payload.session),T(S,o.payload),T(v,o.payload.directory),T(M,o.payload.session),N)T(G,N);if(T(B,o.payload.connection),T(F,o.payload.settings),T(ee,o.payload.item),o.payload.block)T(ue,o.payload.block);It();return}if(o.type==="service-event"){T(ce,o.payload);return}if(o.type==="generate-late"){if(q.size===0)He.push(o.payload);else T(q,o.payload);return}if(o.type==="directory"){if(i)i={...i,directory:o.payload.directory};T(v,o.payload.directory);return}if(o.type==="session"){if(i)i={...i,session:o.payload.session};if(!o.payload.session)N=null;else if(N?.sessionId!==o.payload.session.id)N=kt(o.payload.session);T(M,o.payload.session);return}if(o.type==="session-lifecycle"){N=o.payload,T(G,o.payload);return}if(o.type==="connection"){if(i)i={...i,connection:o.payload.connection};T(B,o.payload.connection);return}if(o.type==="settings"){if(i)i={...i,settings:o.payload.settings};T(F,o.payload.settings);return}if(o.type==="item"){if(i)i={...i,item:o.payload.item};T(ee,o.payload.item);return}if(o.type==="status-control-event"){T(pe,o.payload);return}if(o.type==="popover-closed"){T(de,o.payload);return}if(o.type==="action"){let n=(E)=>{if(!w)I({channel:p,v:d,type:"action-result",id:o.id,payload:E})},g=oe;if(!g){n({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>g(o.payload)).then(()=>n({ok:!0}),(E)=>{let b=(E instanceof Error?E.message:String(E)).trim();n({ok:!1,error:(b||"Action failed.").slice(0,ae)})});return}if(o.type==="file-open"){let n=o.payload;if(se&&jt(se,n))return;se=n,T(Se,o.payload);return}if(o.type==="file-saved"){T(Ee,o.payload.version);return}if(o.type==="file-snapshot"){let n=(b)=>{if(!w)I({channel:p,v:d,type:"file-snapshot-result",id:o.id,payload:b})},g=(b)=>n({error:(b.trim()||"Could not read the edited file.").slice(0,ae)}),E=re;if(!E){g("This extension does not edit files.");return}Promise.resolve().then(()=>E(o.payload.purpose)).then((b)=>{if(je(b)>ye){g(`The file is over ${ye} ${"bytes"in b?"bytes":"characters"}.`);return}if(b.version.length>Re){g(`The snapshot version is over ${Re} characters.`);return}n({snapshot:"bytes"in b?{bytes:b.bytes,version:b.version}:{content:b.content,version:b.version}})},(b)=>g(b instanceof Error?b.message:String(b)));return}if(o.type==="resolve"){let n=(E)=>{I({channel:p,v:d,type:"resolve-result",id:o.id,payload:E})},g=te;if(!g){n({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>g(o.payload)).then((E)=>n({item:E?J(E):null}),(E)=>{let b=(E instanceof Error?E.message:String(E)).trim();n({error:(b||"Command failed.").slice(0,ae)})});return}let s=W.get(o.id);if(!s)return;if(clearTimeout(s.timer),W.delete(o.id),o.ok){s.resolve(o.payload);return}s.reject(new a(o.code,o.error))};r.addEventListener("message",Pt),I({channel:p,v:d,type:"hello"});let x=(t,o=y)=>{if(w||r.parent===r)return Promise.reject(new a("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((s,n)=>{let g=setTimeout(()=>{W.delete(t.id),n(new a("HOST_TIMEOUT","Host did not answer in time."))},o);W.set(t.id,{resolve:s,reject:n,timer:g}),I(t)})},R=(t)=>x(t).then(()=>{return}),h={channel:p,v:d},Fe=(t)=>{if(!w&&r.parent!==r)I(t)},Mt=()=>Fe({...h,type:"file-save"}),Gt=(t)=>{if(!mo(t)||!Lo(t))return;t.preventDefault(),Mt()},Ut=(t)=>{if(!mo(t)||t.key!=="Escape"||i?.surface!=="popover"||!i.popover)return;t.preventDefault(),Dt(i.popover.id,"escape").catch(()=>{return})},ge=()=>{let t=i?.surface==="popover"?i.popover:void 0;if(!t)return;let o=ne||ie;if(Ct===o)return;Ct=o,Ht(t.id,o).catch(()=>{return})},_e=()=>{if(i?.surface!=="popover"||ne)return;ne=!0,ge()},wt=(t)=>{if(i?.surface!=="popover"||t.relatedTarget!==null||!ne)return;ne=!1,ge()},Nt=()=>{if(i?.surface!=="popover"||ie)return;ie=!0,ge()},Lt=()=>{if(i?.surface!=="popover"||!ie)return;ie=!1,ge()},U=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new a("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Ve=async(t)=>{if(t.kind!=="projects")U(t.projectId);let o=await x({...h,type:"workspace-read",id:c(u),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new a("HOST_REJECTED","Host did not return workspace data.");return o},Xe=async(t,o)=>{if(t.kind!=="projects")U(t.projectId);let s=c(u);K.set(s,o);try{await R({...h,type:"workspace-subscribe",id:c(u),payload:{subscriptionId:s,query:t}})}catch(n){if(K.delete(s),!w)I({...h,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:s}});throw n}return()=>{if(!K.delete(s)||w)return;I({...h,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:s}})}},Co=async(t,o)=>{if(t.kind==="session")U(t.sessionId);if(t.kind==="project")U(t.projectId);let s=c(u);j.set(s,o);try{await R({...h,type:"shells-subscribe",id:c(u),payload:{subscriptionId:s,scope:t}})}catch(n){if(j.delete(s),!w)I({...h,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:s}});throw n}return()=>{if(!j.delete(s)||w)return;I({...h,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:s}})}},Te=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>We))throw new a("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!z(t.value))throw new a("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>$e)throw new a("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&i?.features?.deviceStorage!==!0)throw new a("UNSUPPORTED","This host does not support device storage.");let o=await x({...h,type:"storage",id:c(u),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new a("HOST_REJECTED","Host did not return storage data.");return o},Dt=(t,o)=>i?.features?.popovers!==!0&&!(i?.surface==="popover"&&i.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):R({...h,type:"popover-close",id:c(u),payload:o?{id:t,reason:o}:{id:t}}),Ht=(t,o)=>i?.features?.popovers!==!0&&!(i?.surface==="popover"&&i.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):R({...h,type:"popover-anchor",id:c(u),payload:{id:t,active:o}});return r.addEventListener("keydown",Ut,!0),r.addEventListener("pointerover",_e),r.addEventListener("pointermove",_e),r.addEventListener("pointerout",wt),r.addEventListener("focus",Nt),r.addEventListener("blur",Lt),{onAction:(t)=>(oe=t,()=>{if(oe===t)oe=null}),listProjects:async()=>{let t=await Ve({kind:"projects"});if(t.kind!=="projects")throw new a("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Ve({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new a("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Ve({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new a("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Xe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Xe({kind:"worktrees",projectId:t},(s)=>{if(s.kind==="worktrees")o(s)}),onSessions:(t,o)=>Xe({kind:"sessions",projectId:t},(s)=>{if(s.kind==="sessions")o(s)}),onRunningShells:(t,o)=>Co(t,o),readShellOutput:async(t,o)=>{U(t,me);let s=o?.cursor;if(s!==void 0&&(!Number.isInteger(s)||s<0))throw new a("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let n=o?.tailBytes;if(n!==void 0&&(!Number.isInteger(n)||n<1||n>fe))throw new a("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${fe}.`);let E=await x({...h,type:"shell-output",id:c(u),payload:{shellId:t,cursor:s,tailBytes:n}});if(!E||typeof E.output!=="string"||!Number.isFinite(E.cursor))throw new a("HOST_REJECTED","Host did not return shell output.");return E},stopShell:async(t)=>{if(U(t,me),(await x({...h,type:"shell-stop",id:c(u),payload:{shellId:t}}))?.stopped!==!0)throw new a("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{U(t),await R({...h,type:"open-session",id:c(u),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let s=Pe(o),n={op:"get",key:t};if(s)n.scope=s;let g=await Te(n);return g.op==="get"&&g.found?g.value:void 0},set:async(t,o,s)=>{let n=Pe(s),g={op:"set",key:t,value:o};if(n)g.scope=n;await Te(g)},delete:async(t,o)=>{let s=Pe(o),n={op:"delete",key:t};if(s)n.scope=s;await Te(n)},keys:async(t)=>{let o=Pe(t),s={op:"keys"};if(o)s.scope=o;let n=await Te(s);if(n.op!=="keys")throw new a("HOST_REJECTED","Expected storage keys.");return n.keys}},onReady:(t)=>{if(S.add(t),i)t(i);return()=>{S.delete(t)}},onDirectory:(t)=>{if(v.add(t),i)t(i.directory);return()=>{v.delete(t)}},onSession:(t)=>{if(M.add(t),i)t(i.session);return()=>{M.delete(t)}},onSessionLifecycle:(t)=>{if(G.add(t),N)t(N);return()=>{G.delete(t)}},onConnection:(t)=>{if(B.add(t),i)t(i.connection);return()=>{B.delete(t)}},onSettings:(t)=>{if(F.add(t),i)t(i.settings);return()=>{F.delete(t)}},onItem:(t)=>{if(ee.add(t),i)t(i.item);return()=>{ee.delete(t)}},onBlock:(t)=>{if(ue.add(t),i?.block)t(i.block);return()=>{ue.delete(t)}},onServiceEvent:(t)=>(ce.add(t),()=>{ce.delete(t)}),onStatusControl:(t)=>(pe.add(t),()=>{pe.delete(t)}),onPopoverClosed:(t)=>(de.add(t),()=>{de.delete(t)}),setStatusControls:(t)=>{if(i?.features?.statusControls!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support status controls."));if(!Wt(t))return Promise.reject(new a("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return R({...h,type:"status-controls",id:c(u),payload:{controls:t}})},openPopover:(t)=>{if(i?.features?.popovers!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support popovers."));if(!Je(t))return Promise.reject(new a("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return R({...h,type:"popover-open",id:c(u),payload:t})},closePopover:Dt,setPopoverAnchorActive:Ht,onResolve:(t)=>(te=t,()=>{if(te===t)te=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>he)return Promise.reject(new a("HOST_REJECTED",`Toast message must contain 1 to ${he} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>be))return Promise.reject(new a("HOST_REJECTED",`Toast copy text must contain 1 to ${be} characters.`));return R({channel:p,v:d,type:"toast",id:c(u),payload:{...t,message:o}})},openUrl:(t)=>R({channel:p,v:d,type:"open-url",id:c(u),payload:{url:t}}),openCommit:(t)=>et(t)?R({channel:p,v:d,type:"open-commit",id:c(u),payload:{sha:t}}):Promise.reject(new a("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>R({channel:p,v:d,type:"open-surface",id:c(u),payload:{surfaceId:t}}),writeClipboard:(t)=>R({channel:p,v:d,type:"clipboard-write",id:c(u),payload:{text:t}}),compose:(t)=>R({channel:p,v:d,type:"compose",id:c(u),payload:t}),attach:(t)=>R({channel:p,v:d,type:"attach",id:c(u),payload:J(t)}),startSession:async(t)=>{if(t.projectId!==void 0)U(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")U(o.directory);else{if(o.name!==void 0)U(o.name,200);if(o.baseBranch!==void 0)U(o.baseBranch,200)}let s=await x({channel:p,v:d,type:"start-session",id:c(u),payload:st(t)},e.requestTimeoutMs??180000);if(!Ye(s))throw new a("HOST_REJECTED","Host did not return a session.");return s},prompt:(t)=>x({channel:p,v:d,type:"prompt",id:c(u),payload:nt(t)}).then((o)=>{if(!Ze(o))throw new a("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>R({channel:p,v:d,type:"session-link",id:c(u),payload:J(t)}),close:()=>R({channel:p,v:d,type:"close",id:c(u)}),oauthStart:()=>R({channel:p,v:d,type:"oauth-start",id:c(u)}),oauthDisconnect:()=>R({channel:p,v:d,type:"oauth-disconnect",id:c(u)}),request:(t)=>(Ce(t.path)?x({channel:p,v:d,type:"request",id:c(u),payload:t}):fo()).then((o)=>{if(!ke(o))throw new a("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ce(t.path)?x({channel:p,v:d,type:"service-request",id:c(u),payload:t}):fo()).then((o)=>{if(!ke(o))throw new a("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>x({channel:p,v:d,type:"service-status",id:c(u)}).then((t)=>{if(!lt(t))throw new a("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Q(t)?x({channel:p,v:d,type:"file-read",id:c(u),payload:{path:t}}):Ie()).then((o)=>{if(!ut(o))throw new a("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Q(t))return Ie();if(o.length>xe)return Promise.reject(new a("FILE_TOO_LARGE",`Content is over ${xe} characters.`));return x({channel:p,v:d,type:"file-write",id:c(u),payload:{path:t,content:o}}).then((s)=>{if(!ct(s))throw new a("HOST_REJECTED","Host did not confirm the write.");return s})},listDir:(t)=>(Q(t)?x({channel:p,v:d,type:"file-list",id:c(u),payload:{path:t}}):Ie()).then((o)=>{if(!pt(o))throw new a("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Q(t)?x({channel:p,v:d,type:"file-stat",id:c(u),payload:{path:t}}):Ie()).then((o)=>{if(!dt(o))throw new a("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),s=t.system?.trim();if(o.length===0||o.length>Oe)return Promise.reject(new a("HOST_REJECTED",`Prompt must be 1 to ${Oe} characters.`));if(s!==void 0&&(s.length===0||s.length>Ae))return Promise.reject(new a("HOST_REJECTED",`System prompt must be 1 to ${Ae} characters.`));let n=t.maxOutputTokens===void 0?void 0:Math.min(ot,Math.max(1,Math.floor(t.maxOutputTokens)));if(n!==void 0&&!Number.isFinite(n))return Promise.reject(new a("HOST_REJECTED","maxOutputTokens must be a number."));let g={prompt:o};if(s!==void 0)g.system=s;if(n!==void 0)g.maxOutputTokens=n;return x({channel:p,v:d,type:"generate",id:c(u),payload:g},e.requestTimeoutMs??rt).then((E)=>{if(!St(E))throw new a("HOST_REJECTED","Host did not return generated text.");return E})},onLateGenerateResult:(t)=>{q.add(t);for(let o of He.splice(0))T([t],o);return It(),()=>{q.delete(t)}},setBadge:(t)=>R({channel:p,v:d,type:"badge",id:c(u),payload:{count:it(t)}}),setHeight:(t)=>R({channel:p,v:d,type:"resize",id:c(u),payload:{height:at(t)}}),onFileOpen:(t)=>{if(Se.add(t),!Be)Be=!0,r.addEventListener("keydown",Gt,!0);if(se)t(se);return()=>{Se.delete(t)}},onFileSnapshot:(t)=>(re=t,()=>{if(re===t)re=null}),onFileSaved:(t)=>(Ee.add(t),()=>{Ee.delete(t)}),reportFileChange:(t)=>Fe({...h,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Mt,reportFileUnsupported:()=>Fe({...h,type:"file-unsupported"}),dispose:()=>{for(let t of K.keys())I({...h,type:"workspace-unsubscribe",id:c(u),payload:{subscriptionId:t}});K.clear();for(let t of j.keys())I({...h,type:"shells-unsubscribe",id:c(u),payload:{subscriptionId:t}});if(j.clear(),w=!0,te=null,oe=null,re=null,Se.clear(),Ee.clear(),Be)r.removeEventListener("keydown",Gt,!0);r.removeEventListener("message",Pt),r.removeEventListener("keydown",Ut,!0),r.removeEventListener("pointerover",_e),r.removeEventListener("pointermove",_e),r.removeEventListener("pointerout",wt),r.removeEventListener("focus",Nt),r.removeEventListener("blur",Lt);for(let t of W.values())clearTimeout(t.timer),t.reject(new a("HOST_UNAVAILABLE","Host client was disposed."));W.clear(),S.clear(),v.clear(),M.clear(),G.clear(),B.clear(),F.clear(),ee.clear(),ue.clear(),ce.clear(),pe.clear(),de.clear(),q.clear(),He.length=0}}};var yo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Rr=new Set(yo);var Ro=["none","agent","user"];var br=new Set(Ro);var Do=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Ho=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],ho=(e,r)=>{r.style.colorScheme=e.mode;for(let[l,y]of Do)r.style.setProperty(l,e.tokens[y]);for(let[l,y,S]of Ho){let v=e.tokens[S]??"";r.style.setProperty(l,v),r.style.setProperty(y,v)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},_t=(e,r)=>{if(ho(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Bo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},_=(e,r)=>`var(--${e}, var(--oc-${Bo[e]}, ${r}))`,D=_("surface-background","transparent"),Ge=_("surface-elevated","transparent"),Y=_("surface-elevated-foreground","inherit"),P=_("surface-foreground","inherit"),m=_("surface-muted-foreground","gray"),Fo=_("surface-muted","transparent"),V=_("interactive-border","currentColor"),A=_("interactive-hover","transparent"),X=_("interactive-active","transparent"),Tt=_("interactive-selection","transparent"),mt=_("interactive-selection-foreground","inherit"),L=_("primary","currentColor"),ft=_("primary-text","inherit"),yt=_("error-text","inherit"),Vo=_("font-sans","inherit"),Rt=_("font-mono","monospace"),Oo=_("radius","9px"),ht=`calc(${Oo} - 2px)`,bo=`calc(${Oo} - 4px)`,f=(e,r,l="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${l})`,vo=`background-image: linear-gradient(${A}, ${A});`,bt=(e,r="0.5px")=>`box-shadow: inset 0 0 0 ${r} ${e}, var(--oc-sdk-field-lift);`,vt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",xo="box-shadow: var(--oc-sdk-lit);",xt=`inset 0 0.5px 0 0 ${f(P,8)}, 0 1px 2px 0 rgb(0 0 0 / 0.4)`,Xo=`
:root {
  --oc-sdk-edge: ${f(P,16)};
  --oc-sdk-field-bg: ${Ge};
  --oc-sdk-raised-bg: ${D};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 1.5px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.2), 0 1px 1.5px 0 rgb(0 0 0 / 0.1);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.14);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.7), 0 1px 2px -0.5px rgb(0 0 0 / 0.06), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.06);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${f(P,14)};
  --oc-sdk-field-bg: ${f(D,50,Ge)};
  --oc-sdk-raised-bg: ${Ge};
  --oc-sdk-field-lift: ${xt};
  --oc-sdk-raised-lift: ${xt};
  --oc-sdk-lit: ${xt};
  --oc-sdk-float-edge: rgb(0 0 0 / 0.55);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.04), inset 0 0 0 0.5px rgb(255 255 255 / 0.08), 0 8px 16px 0 rgb(0 0 0 / 0.25), 0 4px 8px 0 rgb(0 0 0 / 0.25);
}`,Me=(e)=>{let r=_(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${_(`${e}-text`,"inherit")}; }`},qo=`
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
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
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
.oc-sdk-progress-value { display: inline-flex; align-items: center; gap: 2px; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { font-weight: 600; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,Ao=`${Xo}
.oc-sdk { color: ${P}; font-family: ${Vo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${vo} }
.oc-sdk-mono { font-family: ${Rt}; }
.oc-sdk-muted { color: ${m}; }
${Me("success")}${Me("warning")}${Me("error")}${Me("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${L}; --oc-sdk-tone-text: ${ft}; }

.oc-sdk-btn { border-radius: ${ht}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${bo}; }
.oc-sdk-btn[data-variant="default"] { color: ${ft}; background: ${f(L,10,D)}; border-color: ${f(L,12)}; ${xo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${f(L,16,D)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${f(L,22,D)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Fo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${A}, ${A}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${X}, ${X}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${Y}; ${vt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${A}, ${A}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${X}, ${X}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${A}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${X}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${_("status-error","red")}; color: ${yt}; background: ${f("var(--oc-sdk-tone)",7,D)}; border-color: ${f("var(--oc-sdk-tone)",12)}; ${xo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${f("var(--oc-sdk-tone)",9,D)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${f("var(--oc-sdk-tone)",11,D)}; box-shadow: none; }

.oc-sdk-field-note { color: ${m}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${yt}; }
.oc-sdk-input { border-radius: ${ht}; background: var(--oc-sdk-field-bg); color: ${Y}; ${bt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${m}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${A}, ${A}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${bt(f(P,26),"1px")} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${bt(_("status-error","red"),"1px")} }
.oc-sdk-input[data-mono="true"] { font-family: ${Rt}; }

.oc-sdk-search-icon { color: ${m}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${L}; }
.oc-sdk-search-clear { border-radius: ${bo}; color: ${m}; }
.oc-sdk-search-clear:hover { background: ${A}; color: ${P}; }

.oc-sdk-trigger { border-radius: ${ht}; background: var(--oc-sdk-raised-bg); color: ${Y}; ${vt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${A}, ${A}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${X}, ${X}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${m}; }
.oc-sdk-trigger-chevron { color: ${m}; }
/* The app's floating level: the glass edge (a hairline ring and a lit top line, dark outside and light inside in dark themes) over soft shadows. The outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${Y}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Ge}; background-clip: padding-box; color: ${Y}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${A}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Tt}; color: ${mt}; }
.oc-sdk-option-check { color: ${P}; }
.oc-sdk-option[data-destructive="true"] { color: ${yt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${f(_("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${m}; }
.oc-sdk-popup-empty { color: ${m}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${V}; border-radius: 4px; color: ${P}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${f(P,60,V)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${V}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${D}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${L}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${vo} }
.oc-sdk-check-desc { color: ${m}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${f(P,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${m}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${P}; }
.oc-sdk-tab[aria-selected="true"] { color: ${mt}; background: ${Tt}; border-color: ${V}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${Y}; background: var(--oc-sdk-raised-bg); ${vt} }
.oc-sdk-tab-count { color: ${m}; }

/* The app's neutral badge: a step of the text colour, the same in every theme. */
.oc-sdk-badge { border-radius: 9999px; background: ${f(P,6)}; color: ${m}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${f("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${A}; }
.oc-sdk-row[aria-selected="true"] { background: ${Tt}; color: ${mt}; }
.oc-sdk-row-lead { font-family: ${Rt}; color: ${m}; }
.oc-sdk-row-sub { color: ${m}; }
.oc-sdk-row-meta { color: ${m}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${m}; }

.oc-sdk-empty-body { color: ${m}; }

.oc-sdk-spinner { color: ${m}; }
.oc-sdk-spinner-ring { border-color: ${V}; border-top-color: ${L}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${f("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${m}; }

.oc-sdk-separator { color: ${m}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${f(V,40)}; }

.oc-sdk-progress-label { color: ${m}; }
/* The app's progress: a groove a step of the text colour, green once done. Older bundles mark done only through aria-valuenow. */
.oc-sdk-progress-track { border-radius: 9999px; background: ${f(P,6)}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${L}); }
.oc-sdk-progress-track[aria-valuenow="100"] > .oc-sdk-progress-fill:not([data-tone]) { background: ${_("status-success","currentColor")}; }
.oc-sdk-progress[data-done="true"] .oc-sdk-progress-value { color: ${_("success-text","inherit")}; }

.oc-sdk-text a { color: ${ft}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${f(V,60)}; }
`,O=`
${qe}
${qo}
${Ao}`;var At=gt(),De=document.querySelector("#root");if(!De)throw Error("DeskChart: missing root");At.onReady((e)=>_t(e,document.documentElement));At.onBlock(({args:e})=>{let r=(e.values??"").split(",").map(Number).filter(Number.isFinite),l=Math.max(1,...r);De.replaceChildren();let y=document.createElement("div");y.textContent=e.title??"",y.style.font="600 13px var(--oc-font, system-ui)";let S=document.createElement("div");S.style.cssText="display:flex;align-items:flex-end;gap:6px;height:96px;margin-top:8px";for(let v of r){let M=document.createElement("div");M.style.cssText=`flex:1;height:${v/l*100}%;background:currentColor;opacity:.6;border-radius:3px 3px 0 0`,M.title=String(v),S.append(M)}De.append(y,S),At.setHeight(De.getBoundingClientRect().height+16)});})();
