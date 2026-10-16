(()=>{var D="openchamber.sdk",W=1;var lS=`
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
`;function aS(S){let _=S.documentElement;if(_.hasAttribute("data-oc-scrollbar-activity"))return;_.setAttribute("data-oc-scrollbar-activity","");let M=new WeakMap;S.addEventListener("scroll",(A)=>{let O=A.target===S?_:A.target;if(!(O instanceof Element))return;if(!O.hasAttribute("data-oc-scrolling"))O.setAttribute("data-oc-scrolling","");let F=M.get(O);if(F!==void 0)clearTimeout(F);M.set(O,setTimeout(()=>{M.delete(O),O.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var bT=`(${aS.toString()})(document);`;var oS=128,nS=65536;var ZS=128;var zS=65536;var aG=/^[a-z][a-z0-9-]{0,39}$/;var vG=(S)=>Object(S)===S&&!Array.isArray(S),rS=(S,_)=>Object.keys(S).every((M)=>_.includes(M)),pG=(S)=>String(S)===S&&S.length>=1&&S.length<=60,lG=(S)=>String(S)===S&&S.length>=1&&S.length<=80,oG=(S)=>{if(!Array.isArray(S)||S.length>4)return!1;let _=new Set;for(let M of S){if(!vG(M)||!aG.test(M.id)||!pG(M.label))return!1;if(M.disabled!==void 0&&M.disabled!==!0&&M.disabled!==!1)return!1;if(_.has(M.id))return!1;if(_.add(M.id),M.kind==="button"){if(!rS(M,["kind","id","label","disabled"]))return!1;continue}if(M.kind!=="select"||!rS(M,["kind","id","label","value","options","disabled"]))return!1;if(!lG(M.value)||!Array.isArray(M.options)||M.options.length<1||M.options.length>16)return!1;let A=new Set;for(let O of M.options){if(!vG(O)||!rS(O,["value","label"])||!lG(O.value)||!pG(O.label)||A.has(O.value))return!1;A.add(O.value)}if(!A.has(M.value))return!1}return!0};var VS=20000000,JS=256;var iS=(S)=>("bytes"in S)?S.bytes.byteLength:S.content.length,nG=(S,_)=>{if(S.path!==_.path||S.readOnly!==_.readOnly)return!1;if(S.encoding==="text"||_.encoding==="text")return S.encoding==="text"&&_.encoding==="text"&&S.content===_.content;if(S.bytes.byteLength!==_.bytes.byteLength)return!1;for(let M=0;M<S.bytes.byteLength;M+=1)if(S.bytes[M]!==_.bytes[M])return!1;return!0},jS=(S)=>{let _=S,M=S;return{observe:(A)=>{let O=A!==M;return M=A,{edited:O,dirty:A!==_}},markSaved:(A)=>{return _=A,M!==A}}};var rG=/^[A-Za-z0-9_-]{1,80}$/;var iG=["left","right","top","bottom"];var sG=(S,_=0,M={remaining:16000})=>{if(--M.remaining<0||_>=32)return!1;if(S===null)return!0;let A=Array.isArray(S)?S:Object(S)===S?Object.values(S):[];for(let O of A)if(!sG(O,_+1,M))return!1;return!0},sS=(S)=>{if(S===null||S===!0||S===!1)return!0;if(Array.isArray(S))return Object.keys(S).every((_)=>/^(0|[1-9]\d*)$/.test(_)&&Number(_)<S.length)&&S.every(sS);if(Object(S)===S){let _=Object.getPrototypeOf(S);return(_===null||_===Object.prototype)&&Object.values(S).every(sS)}return String(S)===S||Number.isFinite(S)},tS=(S)=>{try{if(String(S.id)!==S.id||!rG.test(S.id)||!Number.isFinite(S.anchor.x)||Math.abs(S.anchor.x)>1e5||!Number.isFinite(S.anchor.y)||Math.abs(S.anchor.y)>1e5||!Number.isFinite(S.anchor.width)||!Number.isFinite(S.anchor.height)||S.anchor.width<=0||S.anchor.height<=0||S.anchor.width>1e5||S.anchor.height>1e5||!Number.isInteger(S.width)||S.width<160||S.width>640||!Number.isInteger(S.height)||S.height<48||S.height>480||S.side!==void 0&&!iG.includes(S.side)||S.focus!==void 0&&S.focus!==!0&&S.focus!==!1||!sG(S.data)||!sS(S.data))return!1;return JSON.stringify(S.data).length<=16000}catch{return!1}};var eG=["file","directory","other","missing"],SG=(S)=>Boolean(S&&"sessionId"in S),GG=(S)=>Boolean(S&&"sent"in S&&!("sessionId"in S));var ST=/^[0-9a-f]{7,64}$/i,TG=(S)=>ST.test(S),RS=500,fS=32000,GT=16000,TT=128,_T=200,MT=2000,UT=16000,ET=80,AT=200,XT=16000;var OT=2000;var _G=20000,KS=1024,LS=2000000;var IS=64000,HS=8000,MG=4000;var UG=960000;var PT=999,CT=1e4,PS=500,BT=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],DT=["stopped","starting","ready","failed"],xT=new Set(BT),WT=(S)=>xT.has(S),FT=(S)=>S&&WT(S)?S:"HOST_REJECTED",t=(S)=>{if(S===void 0)return!1;if(S===null||S===!0||S===!1)return!0;if(String(S)===S)return!0;if(Number(S)===S)return Number.isFinite(S);if(Array.isArray(S))return S.every(t);if(Object(S)===S)return Object.values(S).every(t);return!1},$T=(S)=>t(S)&&JSON.stringify(S).length<=XT,tG=(S)=>S?.trim().slice(0,AT)??"",e=(S)=>{let _=S.id.trim().slice(0,TT),M=S.title.trim().slice(0,_T),A=S.url.trim().slice(0,MT),O=S.text?.trim().slice(0,UT),F=S.author?.trim().slice(0,ET),Q=S.kind==="pull"?"pull":"issue",$={providerId:S.providerId.trim(),id:_,title:M||_,url:A,kind:Q};if(O)$.text=O;if(F)$.author=F;if(Q==="pull"){let I=tG(S.branches?.head),b=tG(S.branches?.base);if(I&&b)$.branches={head:I,base:b}}if($T(S.data))$.data=S.data;return $},EG=(S)=>{let _=e(S);if(S.projectId)_.projectId=S.projectId;if(S.navigation)_.navigation=S.navigation;if(S.worktree)_.worktree=S.worktree;return _},AG=(S)=>{let _={text:S.text.trim().slice(0,GT)};if(S.send)_.send=!0;return _},XG=(S)=>{if(S===null||!Number.isFinite(S))return null;return Math.min(PT,Math.max(0,Math.round(S)))},OG=(S)=>{if(!Number.isFinite(S))return 0;return Math.min(CT,Math.max(0,Math.ceil(S)))};var SS=(S)=>S.length>0&&S.length<=KS&&!S.includes("\x00")&&!S.includes("\\");var NS=(S)=>{if(!S.startsWith("/")||S.includes("\x00")||S.includes("\\")||S.includes("://"))return!1;if(S.length>OT)return!1;return!S.split("/").some((M)=>M==="."||M==="..")},qT=new Set(DT),PG=(S)=>Boolean(S&&"status"in S&&qT.has(String(S.status))&&!("body"in S)),kS=(S)=>Boolean(S&&"status"in S&&"body"in S&&Number.isInteger(S.status)),CG=(S)=>Boolean(S&&"content"in S&&String(S.content)===S.content),BG=(S)=>Boolean(S&&"written"in S&&S.written===!0),DG=(S)=>Boolean(S&&"entries"in S&&Array.isArray(S.entries)),yT=new Set(eG),WG=(S)=>Boolean(S&&"kind"in S&&"size"in S&&yT.has(String(S.kind))&&Number.isFinite(S.size)),FG=(S)=>Boolean(S&&"text"in S&&String(S.text)===S.text&&!("status"in S)),gT=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved"]),hT=(S)=>Object(S)===S?S:null,eS=(S)=>String(S)===S&&S.length>0,mT=(S)=>{if(!eS(S.id))return null;if(S.ok===!0){let _={channel:D,v:W,type:"result",id:S.id,ok:!0};if(Object(S.payload)===S.payload)_.payload=S.payload;return _}if(S.ok===!1&&eS(S.error))return{channel:D,v:W,type:"result",id:S.id,ok:!1,error:S.error,code:FT(eS(S.code)?S.code:void 0)};return null},$G=(S)=>{let _=hT(S);if(!_||_.channel!==D||_.v!==W)return null;if(_.type==="result")return mT(_);if(!gT.has(String(_.type))||Object(_.payload)!==_.payload)return null;return _};var YT=(S)=>("key"in S)&&("metaKey"in S)&&("ctrlKey"in S),cT=(S)=>(S.metaKey||S.ctrlKey)&&!S.altKey&&!S.shiftKey&&S.key.toLowerCase()==="s";class X extends Error{code;constructor(S,_){super(_);this.name="HostRequestError",this.code=S}}var QT=()=>Promise.reject(new X("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),wS=()=>Promise.reject(new X("BAD_PATH",`File path must be 1 to ${KS} characters without NUL or backslash.`)),bS=(S)=>{if(S===void 0)return;if(Object(S)!==S||Array.isArray(S)||S.scope!==void 0&&S.scope!=="instance"&&S.scope!=="device")throw new X("HOST_REJECTED",'Storage scope must be "instance" or "device".');return S.scope==="device"?"device":void 0},B=(S)=>{return S.value+=1,`oc-${S.value}`},YG=(S={})=>{let _=S.target??("window"in globalThis?window:null);if(!_)throw new X("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let M=S.acceptSource??((G)=>G===_.parent),A=S.requestTimeoutMs??_G,O=new Set,F=new Set,Q=new Set,$=new Set,I=new Set,b=new Set,_S=new Set,BS=new Set,DS=new Set,MS=null,US=null,WS=new Set,FS=new Set,ES=null,AS=null,dS=!1,r=new Map,i=new Map,s=new Map,h=!1,C={value:0},P=null,m=null,XS=!1,OS=!1,wG=null,bG=(G)=>{if(!G)return null;return{sessionId:G.id,phase:G.busy?"started":"completed"}},q=(G)=>{_.parent.postMessage(G,"*")},L=(G,T)=>{for(let U of G)try{U(T)}catch(E){console.error(E)}},xG=(G)=>{if(!(G instanceof MessageEvent))return;if(!M(G.source))return;let T=$G(G.data);if(!T)return;if(T.type==="workspace"){let E=i.get(T.payload.subscriptionId);if(E)L([E],T.payload.snapshot);return}if(T.type==="shells"){let E=s.get(T.payload.subscriptionId);if(E)L([E],T.payload.snapshot);return}if(T.type==="ready"){if(P=T.payload,m=bG(T.payload.session),L(O,T.payload),L(F,T.payload.directory),L(Q,T.payload.session),m)L($,m);L(I,T.payload.connection),L(b,T.payload.settings),L(_S,T.payload.item);return}if(T.type==="directory"){if(P)P={...P,directory:T.payload.directory};L(F,T.payload.directory);return}if(T.type==="session"){if(P)P={...P,session:T.payload.session};if(!T.payload.session)m=null;else if(m?.sessionId!==T.payload.session.id)m=bG(T.payload.session);L(Q,T.payload.session);return}if(T.type==="session-lifecycle"){m=T.payload,L($,T.payload);return}if(T.type==="connection"){if(P)P={...P,connection:T.payload.connection};L(I,T.payload.connection);return}if(T.type==="settings"){if(P)P={...P,settings:T.payload.settings};L(b,T.payload.settings);return}if(T.type==="item"){if(P)P={...P,item:T.payload.item};L(_S,T.payload.item);return}if(T.type==="status-control-event"){L(BS,T.payload);return}if(T.type==="popover-closed"){L(DS,T.payload);return}if(T.type==="action"){let E=(Y)=>{if(!h)q({channel:D,v:W,type:"action-result",id:T.id,payload:Y})},Z=US;if(!Z){E({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>Z(T.payload)).then(()=>E({ok:!0}),(Y)=>{let f=(Y instanceof Error?Y.message:String(Y)).trim();E({ok:!1,error:(f||"Action failed.").slice(0,PS)})});return}if(T.type==="file-open"){let E=T.payload;if(AS&&nG(AS,E))return;AS=E,L(WS,T.payload);return}if(T.type==="file-saved"){L(FS,T.payload.version);return}if(T.type==="file-snapshot"){let E=(f)=>{if(!h)q({channel:D,v:W,type:"file-snapshot-result",id:T.id,payload:f})},Z=(f)=>E({error:(f.trim()||"Could not read the edited file.").slice(0,PS)}),Y=ES;if(!Y){Z("This extension does not edit files.");return}Promise.resolve().then(()=>Y(T.payload.purpose)).then((f)=>{if(iS(f)>VS){Z(`The file is over ${VS} ${"bytes"in f?"bytes":"characters"}.`);return}if(f.version.length>JS){Z(`The snapshot version is over ${JS} characters.`);return}E({snapshot:"bytes"in f?{bytes:f.bytes,version:f.version}:{content:f.content,version:f.version}})},(f)=>Z(f instanceof Error?f.message:String(f)));return}if(T.type==="resolve"){let E=(Y)=>{q({channel:D,v:W,type:"resolve-result",id:T.id,payload:Y})},Z=MS;if(!Z){E({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>Z(T.payload)).then((Y)=>E({item:Y?e(Y):null}),(Y)=>{let f=(Y instanceof Error?Y.message:String(Y)).trim();E({error:(f||"Command failed.").slice(0,PS)})});return}let U=r.get(T.id);if(!U)return;if(clearTimeout(U.timer),r.delete(T.id),T.ok){U.resolve(T.payload);return}U.reject(new X(T.code,T.error))};_.addEventListener("message",xG),q({channel:D,v:W,type:"hello"});let k=(G,T=A)=>{if(h||_.parent===_)return Promise.reject(new X("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((U,E)=>{let Z=setTimeout(()=>{r.delete(G.id),E(new X("HOST_TIMEOUT","Host did not answer in time."))},T);r.set(G.id,{resolve:U,reject:E,timer:Z}),q(G)})},j=(G)=>k(G).then(()=>{return}),R={channel:D,v:W},uS=(G)=>{if(!h&&_.parent!==_)q(G)},qG=()=>uS({...R,type:"file-save"}),yG=(G)=>{if(!YT(G)||!cT(G))return;G.preventDefault(),qG()},gG=(G)=>{if(!YT(G)||G.key!=="Escape"||P?.surface!=="popover"||!P.popover)return;G.preventDefault(),dG(P.popover.id,"escape").catch(()=>{return})},$S=()=>{let G=P?.surface==="popover"?P.popover:void 0;if(!G)return;let T=XS||OS;if(wG===T)return;wG=T,uG(G.id,T).catch(()=>{return})},YS=()=>{if(P?.surface!=="popover"||XS)return;XS=!0,$S()},hG=(G)=>{if(P?.surface!=="popover"||G.relatedTarget!==null||!XS)return;XS=!1,$S()},mG=()=>{if(P?.surface!=="popover"||OS)return;OS=!0,$S()},cG=()=>{if(P?.surface!=="popover"||!OS)return;OS=!1,$S()},g=(G,T=1024)=>{if(!G.trim()||G.length>T)throw new X("HOST_REJECTED",`Identity must contain 1 to ${T} characters.`)},vS=async(G)=>{if(G.kind!=="projects")g(G.projectId);let T=await k({...R,type:"workspace-read",id:B(C),payload:G});if(!T||!("kind"in T)||!("state"in T)||T.kind!==G.kind)throw new X("HOST_REJECTED","Host did not return workspace data.");return T},pS=async(G,T)=>{if(G.kind!=="projects")g(G.projectId);let U=B(C);i.set(U,T);try{await j({...R,type:"workspace-subscribe",id:B(C),payload:{subscriptionId:U,query:G}})}catch(E){if(i.delete(U),!h)q({...R,type:"workspace-unsubscribe",id:B(C),payload:{subscriptionId:U}});throw E}return()=>{if(!i.delete(U)||h)return;q({...R,type:"workspace-unsubscribe",id:B(C),payload:{subscriptionId:U}})}},wT=async(G,T)=>{if(G.kind==="session")g(G.sessionId);if(G.kind==="project")g(G.projectId);let U=B(C);s.set(U,T);try{await j({...R,type:"shells-subscribe",id:B(C),payload:{subscriptionId:U,scope:G}})}catch(E){if(s.delete(U),!h)q({...R,type:"shells-unsubscribe",id:B(C),payload:{subscriptionId:U}});throw E}return()=>{if(!s.delete(U)||h)return;q({...R,type:"shells-unsubscribe",id:B(C),payload:{subscriptionId:U}})}},QS=async(G)=>{if("key"in G&&(G.key.length===0||G.key.length>oS))throw new X("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(G.op==="set"&&!t(G.value))throw new X("HOST_REJECTED","Storage values must be JSON.");if(G.op==="set"&&new TextEncoder().encode(JSON.stringify(G.value)).length>nS)throw new X("HOST_REJECTED","Storage value exceeds 64 KiB.");if(G.scope==="device"&&P?.features?.deviceStorage!==!0)throw new X("UNSUPPORTED","This host does not support device storage.");let T=await k({...R,type:"storage",id:B(C),payload:G});if(!T||!("storage"in T)||T.op!==G.op)throw new X("HOST_REJECTED","Host did not return storage data.");return T},dG=(G,T)=>P?.features?.popovers!==!0&&!(P?.surface==="popover"&&P.popover?.id===G)?Promise.reject(new X("UNSUPPORTED","This host does not support popovers.")):j({...R,type:"popover-close",id:B(C),payload:T?{id:G,reason:T}:{id:G}}),uG=(G,T)=>P?.features?.popovers!==!0&&!(P?.surface==="popover"&&P.popover?.id===G)?Promise.reject(new X("UNSUPPORTED","This host does not support popovers.")):j({...R,type:"popover-anchor",id:B(C),payload:{id:G,active:T}});return _.addEventListener("keydown",gG,!0),_.addEventListener("pointerover",YS),_.addEventListener("pointermove",YS),_.addEventListener("pointerout",hG),_.addEventListener("focus",mG),_.addEventListener("blur",cG),{onAction:(G)=>{return US=G,()=>{if(US===G)US=null}},listProjects:async()=>{let G=await vS({kind:"projects"});if(G.kind!=="projects")throw new X("HOST_REJECTED","Expected projects.");return G},listWorktrees:async(G)=>{let T=await vS({kind:"worktrees",projectId:G});if(T.kind!=="worktrees")throw new X("HOST_REJECTED","Expected worktrees.");return T},listSessions:async(G)=>{let T=await vS({kind:"sessions",projectId:G});if(T.kind!=="sessions")throw new X("HOST_REJECTED","Expected sessions.");return T},onProjects:(G)=>pS({kind:"projects"},(T)=>{if(T.kind==="projects")G(T)}),onWorktrees:(G,T)=>pS({kind:"worktrees",projectId:G},(U)=>{if(U.kind==="worktrees")T(U)}),onSessions:(G,T)=>pS({kind:"sessions",projectId:G},(U)=>{if(U.kind==="sessions")T(U)}),onRunningShells:(G,T)=>wT(G,T),readShellOutput:async(G,T)=>{g(G,ZS);let U=T?.cursor;if(U!==void 0&&(!Number.isInteger(U)||U<0))throw new X("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let E=T?.tailBytes;if(E!==void 0&&(!Number.isInteger(E)||E<1||E>zS))throw new X("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${zS}.`);let Y=await k({...R,type:"shell-output",id:B(C),payload:{shellId:G,cursor:U,tailBytes:E}});if(!Y||typeof Y.output!=="string"||!Number.isFinite(Y.cursor))throw new X("HOST_REJECTED","Host did not return shell output.");return Y},stopShell:async(G)=>{if(g(G,ZS),(await k({...R,type:"shell-stop",id:B(C),payload:{shellId:G}}))?.stopped!==!0)throw new X("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(G)=>{g(G),await j({...R,type:"open-session",id:B(C),payload:{sessionId:G}})},storage:{get:async(G,T)=>{let U=bS(T),E={op:"get",key:G};if(U)E.scope=U;let Z=await QS(E);return Z.op==="get"&&Z.found?Z.value:void 0},set:async(G,T,U)=>{let E=bS(U),Z={op:"set",key:G,value:T};if(E)Z.scope=E;await QS(Z)},delete:async(G,T)=>{let U=bS(T),E={op:"delete",key:G};if(U)E.scope=U;await QS(E)},keys:async(G)=>{let T=bS(G),U={op:"keys"};if(T)U.scope=T;let E=await QS(U);if(E.op!=="keys")throw new X("HOST_REJECTED","Expected storage keys.");return E.keys}},onReady:(G)=>{if(O.add(G),P)G(P);return()=>{O.delete(G)}},onDirectory:(G)=>{if(F.add(G),P)G(P.directory);return()=>{F.delete(G)}},onSession:(G)=>{if(Q.add(G),P)G(P.session);return()=>{Q.delete(G)}},onSessionLifecycle:(G)=>{if($.add(G),m)G(m);return()=>{$.delete(G)}},onConnection:(G)=>{if(I.add(G),P)G(P.connection);return()=>{I.delete(G)}},onSettings:(G)=>{if(b.add(G),P)G(P.settings);return()=>{b.delete(G)}},onItem:(G)=>{if(_S.add(G),P)G(P.item);return()=>{_S.delete(G)}},onStatusControl:(G)=>{return BS.add(G),()=>{BS.delete(G)}},onPopoverClosed:(G)=>{return DS.add(G),()=>{DS.delete(G)}},setStatusControls:(G)=>{if(P?.features?.statusControls!==!0)return Promise.reject(new X("UNSUPPORTED","This host does not support status controls."));if(!oG(G))return Promise.reject(new X("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return j({...R,type:"status-controls",id:B(C),payload:{controls:G}})},openPopover:(G)=>{if(P?.features?.popovers!==!0)return Promise.reject(new X("UNSUPPORTED","This host does not support popovers."));if(!tS(G))return Promise.reject(new X("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return j({...R,type:"popover-open",id:B(C),payload:G})},closePopover:dG,setPopoverAnchorActive:uG,onResolve:(G)=>{return MS=G,()=>{if(MS===G)MS=null}},toast:(G)=>{let T=G.message.trim();if(!T||T.length>RS)return Promise.reject(new X("HOST_REJECTED",`Toast message must contain 1 to ${RS} characters.`));if(G.copy&&G.copy!==!0&&(!G.copy.text.length||G.copy.text.length>fS))return Promise.reject(new X("HOST_REJECTED",`Toast copy text must contain 1 to ${fS} characters.`));return j({channel:D,v:W,type:"toast",id:B(C),payload:{...G,message:T}})},openUrl:(G)=>j({channel:D,v:W,type:"open-url",id:B(C),payload:{url:G}}),openCommit:(G)=>TG(G)?j({channel:D,v:W,type:"open-commit",id:B(C),payload:{sha:G}}):Promise.reject(new X("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(G)=>j({channel:D,v:W,type:"open-surface",id:B(C),payload:{surfaceId:G}}),writeClipboard:(G)=>j({channel:D,v:W,type:"clipboard-write",id:B(C),payload:{text:G}}),compose:(G)=>j({channel:D,v:W,type:"compose",id:B(C),payload:G}),attach:(G)=>j({channel:D,v:W,type:"attach",id:B(C),payload:e(G)}),startSession:async(G)=>{if(G.projectId!==void 0)g(G.projectId);let T=G.worktree;if(T&&T!==!0)if(T.kind==="existing")g(T.directory);else{if(T.name!==void 0)g(T.name,200);if(T.baseBranch!==void 0)g(T.baseBranch,200)}let U=await k({channel:D,v:W,type:"start-session",id:B(C),payload:EG(G)},S.requestTimeoutMs??180000);if(!SG(U))throw new X("HOST_REJECTED","Host did not return a session.");return U},prompt:(G)=>k({channel:D,v:W,type:"prompt",id:B(C),payload:AG(G)}).then((T)=>{if(!GG(T))throw new X("HOST_REJECTED","Host did not return a prompt result.");return T}),sessionLink:(G)=>j({channel:D,v:W,type:"session-link",id:B(C),payload:e(G)}),close:()=>j({channel:D,v:W,type:"close",id:B(C)}),oauthStart:()=>j({channel:D,v:W,type:"oauth-start",id:B(C)}),oauthDisconnect:()=>j({channel:D,v:W,type:"oauth-disconnect",id:B(C)}),request:(G)=>(NS(G.path)?k({channel:D,v:W,type:"request",id:B(C),payload:G}):QT()).then((T)=>{if(!kS(T))throw new X("HOST_REJECTED","Host request result was empty.");return T}),serviceRequest:(G)=>(NS(G.path)?k({channel:D,v:W,type:"service-request",id:B(C),payload:G}):QT()).then((T)=>{if(!kS(T))throw new X("HOST_REJECTED","Host service request result was empty.");return T}),serviceStatus:()=>k({channel:D,v:W,type:"service-status",id:B(C)}).then((G)=>{if(!PG(G))throw new X("HOST_REJECTED","Host did not return service status.");return G}),readFile:(G)=>(SS(G)?k({channel:D,v:W,type:"file-read",id:B(C),payload:{path:G}}):wS()).then((T)=>{if(!CG(T))throw new X("HOST_REJECTED","Host did not return file content.");return T}),writeFile:(G,T)=>{if(!SS(G))return wS();if(T.length>LS)return Promise.reject(new X("FILE_TOO_LARGE",`Content is over ${LS} characters.`));return k({channel:D,v:W,type:"file-write",id:B(C),payload:{path:G,content:T}}).then((U)=>{if(!BG(U))throw new X("HOST_REJECTED","Host did not confirm the write.");return U})},listDir:(G)=>(SS(G)?k({channel:D,v:W,type:"file-list",id:B(C),payload:{path:G}}):wS()).then((T)=>{if(!DG(T))throw new X("HOST_REJECTED","Host did not return directory entries.");return T}),stat:(G)=>(SS(G)?k({channel:D,v:W,type:"file-stat",id:B(C),payload:{path:G}}):wS()).then((T)=>{if(!WG(T))throw new X("HOST_REJECTED","Host did not return file status.");return T}),generate:(G)=>{let T=G.prompt.trim(),U=G.system?.trim();if(T.length===0||T.length>IS)return Promise.reject(new X("HOST_REJECTED",`Prompt must be 1 to ${IS} characters.`));if(U!==void 0&&(U.length===0||U.length>HS))return Promise.reject(new X("HOST_REJECTED",`System prompt must be 1 to ${HS} characters.`));let E=G.maxOutputTokens===void 0?void 0:Math.min(MG,Math.max(1,Math.floor(G.maxOutputTokens)));if(E!==void 0&&!Number.isFinite(E))return Promise.reject(new X("HOST_REJECTED","maxOutputTokens must be a number."));let Z={prompt:T};if(U!==void 0)Z.system=U;if(E!==void 0)Z.maxOutputTokens=E;return k({channel:D,v:W,type:"generate",id:B(C),payload:Z},S.requestTimeoutMs??UG).then((Y)=>{if(!FG(Y))throw new X("HOST_REJECTED","Host did not return generated text.");return Y})},setBadge:(G)=>j({channel:D,v:W,type:"badge",id:B(C),payload:{count:XG(G)}}),setHeight:(G)=>j({channel:D,v:W,type:"resize",id:B(C),payload:{height:OG(G)}}),onFileOpen:(G)=>{if(WS.add(G),!dS)dS=!0,_.addEventListener("keydown",yG,!0);if(AS)G(AS);return()=>{WS.delete(G)}},onFileSnapshot:(G)=>{return ES=G,()=>{if(ES===G)ES=null}},onFileSaved:(G)=>{return FS.add(G),()=>{FS.delete(G)}},reportFileChange:(G)=>uS({...R,type:"file-change",payload:{dirty:G.dirty,edited:G.edited}}),requestFileSave:qG,reportFileUnsupported:()=>uS({...R,type:"file-unsupported"}),dispose:()=>{for(let G of i.keys())q({...R,type:"workspace-unsubscribe",id:B(C),payload:{subscriptionId:G}});i.clear();for(let G of s.keys())q({...R,type:"shells-unsubscribe",id:B(C),payload:{subscriptionId:G}});if(s.clear(),h=!0,MS=null,US=null,ES=null,WS.clear(),FS.clear(),dS)_.removeEventListener("keydown",yG,!0);_.removeEventListener("message",xG),_.removeEventListener("keydown",gG,!0),_.removeEventListener("pointerover",YS),_.removeEventListener("pointermove",YS),_.removeEventListener("pointerout",hG),_.removeEventListener("focus",mG),_.removeEventListener("blur",cG);for(let G of r.values())clearTimeout(G.timer),G.reject(new X("HOST_UNAVAILABLE","Host client was disposed."));r.clear(),O.clear(),F.clear(),Q.clear(),$.clear(),I.clear(),b.clear(),_S.clear(),BS.clear(),DS.clear()}}};var ZT=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize"];var Z_=new Set(ZT);var zT=["none","agent","user"];var V_=new Set(zT);var dT=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],uT=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],VT=(S,_)=>{_.style.colorScheme=S.mode;for(let[M,A]of dT)_.style.setProperty(M,S.tokens[A]);for(let[M,A,O]of uT){let F=S.tokens[O]??"";_.style.setProperty(M,F),_.style.setProperty(A,F)}_.style.setProperty("font-family",S.tokens.font),_.style.setProperty("font-size","0.875rem"),_.style.setProperty("line-height","1.45"),_.style.setProperty("color",S.tokens.foreground)},QG=(S,_)=>{if(VT(S.theme,_),_.dataset)_.dataset.ocSurface=S.surface,_.dataset.ocTheme=S.theme.mode};var vT={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},J=(S,_)=>`var(--${S}, var(--oc-${vT[S]}, ${_}))`,l=J("surface-background","transparent"),CS=J("surface-elevated","transparent"),GS=J("surface-elevated-foreground","inherit"),y=J("surface-foreground","inherit"),z=J("surface-muted-foreground","gray"),pT=J("surface-muted","transparent"),c=J("interactive-border","currentColor"),w=J("interactive-hover","transparent"),a=J("interactive-active","transparent"),ZG=J("interactive-selection","transparent"),zG=J("interactive-selection-foreground","inherit"),d=J("primary","currentColor"),VG=J("primary-text","inherit"),JG=J("error-text","inherit"),lT=J("font-sans","inherit"),jG=J("font-mono","monospace"),fT=J("radius","9px"),RG=`calc(${fT} - 2px)`,JT=`calc(${fT} - 4px)`,V=(S,_,M="transparent")=>`color-mix(in srgb, ${S} ${_}%, ${M})`,jT=`background-image: linear-gradient(${w}, ${w});`,fG=(S)=>`box-shadow: inset 0 0 0 1px ${S}, inset 0 1px 2px 0 rgb(0 0 0 / 0.05);`,KG=`box-shadow: inset 0 0 0 1px ${V(y,10)}, 0 1px 2px 0 rgb(0 0 0 / 0.12);`,RT="box-shadow: inset 0 1px 0 0 rgb(255 255 255 / 0.12), 0 1px 2px 0 rgb(0 0 0 / 0.14);",xS=(S)=>{let _=J(`status-${S}`,"currentColor");return`
.oc-sdk[data-tone="${S}"], .oc-sdk [data-tone="${S}"] { --oc-sdk-tone: ${_}; --oc-sdk-tone-text: ${J(`${S}-text`,"inherit")}; }`},aT=`
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

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,KT=`
.oc-sdk { color: ${y}; font-family: ${lT}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${jT} }
.oc-sdk-mono { font-family: ${jG}; }
.oc-sdk-muted { color: ${z}; }
${xS("success")}${xS("warning")}${xS("error")}${xS("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${d}; --oc-sdk-tone-text: ${VG}; }

.oc-sdk-btn { border-radius: ${RG}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${JT}; }
.oc-sdk-btn[data-variant="default"] { color: ${VG}; background: ${V(d,10,l)}; border-color: ${V(d,12)}; ${RT} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${V(d,16,l)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${V(d,22,l)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${pT}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${a}, ${a}); }
.oc-sdk-btn[data-variant="outline"] { background: ${CS}; color: ${GS}; border-color: transparent; ${KG} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${a}, ${a}); box-shadow: inset 0 0 0 1px ${V(y,10)}; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${w}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${a}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${J("status-error","red")}; color: ${JG}; background: ${V("var(--oc-sdk-tone)",7,l)}; border-color: ${V("var(--oc-sdk-tone)",12)}; ${RT} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${V("var(--oc-sdk-tone)",9,l)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${V("var(--oc-sdk-tone)",11,l)}; box-shadow: none; }

.oc-sdk-field-note { color: ${z}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${JG}; }
.oc-sdk-input { border-radius: ${RG}; background: ${CS}; color: ${GS}; ${fG(V(y,10))} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${z}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${fG(V(y,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${fG(J("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${jG}; }

.oc-sdk-search-icon { color: ${z}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${d}; }
.oc-sdk-search-clear { border-radius: ${JT}; color: ${z}; }
.oc-sdk-search-clear:hover { background: ${w}; color: ${y}; }

.oc-sdk-trigger { border-color: transparent; border-radius: ${RG}; background: ${CS}; color: ${GS}; ${KG} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${a}, ${a}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${z}; }
.oc-sdk-trigger-chevron { color: ${z}; }
.oc-sdk-popup { --surface-foreground: ${GS}; border-color: ${V(c,60)}; border-radius: 12px; background: ${CS}; color: ${GS}; box-shadow: 0 8px 24px ${V(y,12)}; }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${w}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${ZG}; color: ${zG}; }
.oc-sdk-option-check { color: ${y}; }
.oc-sdk-option[data-destructive="true"] { color: ${JG}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${V(J("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${z}; }
.oc-sdk-popup-empty { color: ${z}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${c}; border-radius: 4px; color: ${y}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${V(y,60,c)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${c}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${l}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${d}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${jT} }
.oc-sdk-check-desc { color: ${z}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${V(y,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${z}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${y}; }
.oc-sdk-tab[aria-selected="true"] { color: ${zG}; background: ${ZG}; border-color: ${c}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${GS}; background: ${CS}; border-color: transparent; ${KG} }
.oc-sdk-tab-count { color: ${z}; }

.oc-sdk-badge { border-radius: 9999px; background: ${w}; color: ${z}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${V("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${w}; }
.oc-sdk-row[aria-selected="true"] { background: ${ZG}; color: ${zG}; }
.oc-sdk-row-lead { font-family: ${jG}; color: ${z}; }
.oc-sdk-row-sub { color: ${z}; }
.oc-sdk-row-meta { color: ${z}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${z}; }

.oc-sdk-empty-body { color: ${z}; }

.oc-sdk-spinner { color: ${z}; }
.oc-sdk-spinner-ring { border-color: ${c}; border-top-color: ${d}; border-radius: 9999px; }

.oc-sdk-banner { border-color: ${V("var(--oc-sdk-tone)",40)}; border-radius: 8px; background: ${V("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${z}; }

.oc-sdk-separator { color: ${z}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${V(c,40)}; }

.oc-sdk-progress-label { color: ${z}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${c}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${d}); }

.oc-sdk-text a { color: ${VG}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${V(c,60)}; }
`,H=`
${lS}
${aT}
${KT}`;var LT="oc-sdk-ui-style";var N=(S)=>{let _=document.getElementById(LT);if(_ instanceof HTMLStyleElement){if(_.textContent!==S)_.textContent=S;return}aS(document);let M=document.createElement("style");M.id=LT,M.textContent=S,document.head.appendChild(M)},K=(S,_)=>{let M=document.createElement(S);if(_)M.className=_;return M},u=(S)=>{let _=K("button",S);return _.type="button",_},x=(S,_)=>{let M=_??"";if(S.textContent!==M)S.textContent=M};var oT=()=>{let S=document.createElement("span");return S.className="oc-sdk-spinner-ring",S.setAttribute("aria-hidden","true"),S},v=(S,_)=>{N(H);let M=_,A=u("oc-sdk oc-sdk-btn"),O=oT(),F=document.createElement("span");A.append(F),S.append(A);let Q=()=>{if(A.dataset.variant=M.variant??"default",A.dataset.size=M.size??"default",A.disabled=Boolean(M.disabled)||Boolean(M.loading),A.dataset.loading=M.loading?"true":"false",A.setAttribute("aria-busy",M.loading?"true":"false"),M.loading&&O.parentNode!==A)A.prepend(O);else if(!M.loading&&O.parentNode===A)O.remove();x(F,M.label)},$=()=>{if(M.disabled||M.loading)return;M.onClick()};return A.addEventListener("click",$),Q(),{update:(I)=>{M={...M,...I},Q()},dispose:()=>{A.removeEventListener("click",$),A.remove()}}};var IG=(S,_)=>{N(H);let M=_,A=K("div","oc-sdk oc-sdk-empty"),O=K("h2","oc-sdk-empty-title"),F=K("p","oc-sdk-empty-body"),Q=K("div","oc-sdk-empty-action");A.append(O,F,Q),S.append(A);let $=null,I=()=>{if(x(O,M.title),x(F,M.body),F.hidden=!M.body,Q.hidden=!M.action,!M.action){$?.dispose(),$=null;return}let b={label:M.action.label,onClick:M.action.onClick};if($)$.update(b);else $=v(Q,{...b,variant:"outline",size:"sm"})};return I(),{update:(b)=>{M={...M,...b},I()},dispose:()=>{$?.dispose(),$=null,A.remove()}}};var tT=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,IT=(S)=>S.split(`
`).map((_)=>{let M=tT.exec(_);return M?{kind:"item",prefix:M[1]??"- ",done:M[2]!==" ",text:M[3]??""}:{kind:"text",text:_}}),HT=(S)=>S.map((_)=>_.kind==="text"?_.text:`${_.prefix}[${_.done?"x":" "}] ${_.text}`).join(`
`),mS=(S)=>{let _=2166136261;for(let M=0;M<S.length;M+=1)_^=S.charCodeAt(M),_=Math.imul(_,16777619);return`${S.length}:${(_>>>0).toString(16)}`},NT=(S,_)=>{let M=-1,A="- ";S.forEach(($,I)=>{if($.kind!=="item")return;M=I,A=$.prefix});let O={kind:"item",prefix:A,done:!1,text:_};if(M>=0)return[...S.slice(0,M+1),O,...S.slice(M+1)];return[...S.at(-1)?.kind==="text"&&S.at(-1)?.text===""?S.slice(0,-1):[...S],O,{kind:"text",text:""}]};var n=YG(),o=document.querySelector("#root");if(!o)throw Error("Missing root");var kT=document.createElement("style");kT.textContent=`
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
`;document.head.append(kT);n.onReady((S)=>QG(S,document.documentElement));var p=[],TS=!1,NG=jS(null),kG=()=>HT(p),cS=()=>{n.reportFileChange(NG.observe(mS(kG())))},HG=()=>{if(o.replaceChildren(),!p.some((_)=>_.kind==="item")&&TS){IG(o,{title:"No items",body:"This checklist is empty."});return}if(p.forEach((_,M)=>{if(_.kind==="text"){let Q=document.createElement("p");Q.className="note",Q.textContent=_.text,o.append(Q);return}let A=document.createElement("div");A.className=_.done?"item done":"item";let O=document.createElement("input");O.type="checkbox",O.checked=_.done,O.disabled=TS,O.addEventListener("change",()=>{_.done=O.checked,A.className=_.done?"item done":"item",cS()});let F=document.createElement("input");if(F.type="text",F.value=_.text,F.readOnly=TS,F.setAttribute("aria-label","Item"),F.addEventListener("input",()=>{_.text=F.value,cS()}),A.append(O,F),!TS){let Q=document.createElement("span");Q.className="remove",v(Q,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{p=p.filter(($,I)=>I!==M),cS(),HG()}}),A.append(Q)}o.append(A)}),TS)return;let S=document.createElement("div");S.className="actions",v(S,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{p=NT(p,""),cS(),HG();let _=o.querySelectorAll('.item input[type="text"]');_.item(_.length-1)?.focus()}}),o.append(S)};n.onFileOpen((S)=>{if(S.encoding!=="text"){n.reportFileUnsupported();return}p=IT(S.content),TS=S.readOnly,NG=jS(mS(kG())),HG()});n.onFileSnapshot(()=>{let S=kG();return{content:S,version:mS(S)}});n.onFileSaved((S)=>{n.reportFileChange({dirty:NG.markSaved(S),edited:!1})});})();
