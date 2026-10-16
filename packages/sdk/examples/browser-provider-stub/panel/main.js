(()=>{var W="openchamber.sdk",F=1;var hS=`
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
`;function mS(S){let _=S.documentElement;if(_.hasAttribute("data-oc-scrollbar-activity"))return;_.setAttribute("data-oc-scrollbar-activity","");let M=new WeakMap;S.addEventListener("scroll",(C)=>{let B=C.target===S?_:C.target;if(!(B instanceof Element))return;if(!B.hasAttribute("data-oc-scrolling"))B.setAttribute("data-oc-scrolling","");let D=M.get(B);if(D!==void 0)clearTimeout(D);M.set(B,setTimeout(()=>{M.delete(B),B.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var JT=`(${mS.toString()})(document);`;var cS=128,dS=65536;var $S=128;var YS=65536;var gG=/^[a-z][a-z0-9-]{0,39}$/;var bG=(S)=>Object(S)===S&&!Array.isArray(S),vS=(S,_)=>Object.keys(S).every((M)=>_.includes(M)),qG=(S)=>String(S)===S&&S.length>=1&&S.length<=60,yG=(S)=>String(S)===S&&S.length>=1&&S.length<=80,hG=(S)=>{if(!Array.isArray(S)||S.length>4)return!1;let _=new Set;for(let M of S){if(!bG(M)||!gG.test(M.id)||!qG(M.label))return!1;if(M.disabled!==void 0&&M.disabled!==!0&&M.disabled!==!1)return!1;if(_.has(M.id))return!1;if(_.add(M.id),M.kind==="button"){if(!vS(M,["kind","id","label","disabled"]))return!1;continue}if(M.kind!=="select"||!vS(M,["kind","id","label","value","options","disabled"]))return!1;if(!yG(M.value)||!Array.isArray(M.options)||M.options.length<1||M.options.length>16)return!1;let C=new Set;for(let B of M.options){if(!bG(B)||!vS(B,["value","label"])||!yG(B.value)||!qG(B.label)||C.has(B.value))return!1;C.add(B.value)}if(!C.has(M.value))return!1}return!0};var QS=20000000,ZS=256;var uS=(S)=>("bytes"in S)?S.bytes.byteLength:S.content.length,mG=(S,_)=>{if(S.path!==_.path||S.readOnly!==_.readOnly)return!1;if(S.encoding==="text"||_.encoding==="text")return S.encoding==="text"&&_.encoding==="text"&&S.content===_.content;if(S.bytes.byteLength!==_.bytes.byteLength)return!1;for(let M=0;M<S.bytes.byteLength;M+=1)if(S.bytes[M]!==_.bytes[M])return!1;return!0};var cG=/^[A-Za-z0-9_-]{1,80}$/;var dG=["left","right","top","bottom"];var vG=(S,_=0,M={remaining:16000})=>{if(--M.remaining<0||_>=32)return!1;if(S===null)return!0;let C=Array.isArray(S)?S:Object(S)===S?Object.values(S):[];for(let B of C)if(!vG(B,_+1,M))return!1;return!0},pS=(S)=>{if(S===null||S===!0||S===!1)return!0;if(Array.isArray(S))return Object.keys(S).every((_)=>/^(0|[1-9]\d*)$/.test(_)&&Number(_)<S.length)&&S.every(pS);if(Object(S)===S){let _=Object.getPrototypeOf(S);return(_===null||_===Object.prototype)&&Object.values(S).every(pS)}return String(S)===S||Number.isFinite(S)},lS=(S)=>{try{if(String(S.id)!==S.id||!cG.test(S.id)||!Number.isFinite(S.anchor.x)||Math.abs(S.anchor.x)>1e5||!Number.isFinite(S.anchor.y)||Math.abs(S.anchor.y)>1e5||!Number.isFinite(S.anchor.width)||!Number.isFinite(S.anchor.height)||S.anchor.width<=0||S.anchor.height<=0||S.anchor.width>1e5||S.anchor.height>1e5||!Number.isInteger(S.width)||S.width<160||S.width>640||!Number.isInteger(S.height)||S.height<48||S.height>480||S.side!==void 0&&!dG.includes(S.side)||S.focus!==void 0&&S.focus!==!0&&S.focus!==!1||!vG(S.data)||!pS(S.data))return!1;return JSON.stringify(S.data).length<=16000}catch{return!1}};var pG=["file","directory","other","missing"],nS=(S)=>Boolean(S&&"sessionId"in S),oS=(S)=>Boolean(S&&"sent"in S&&!("sessionId"in S));var lG=/^[0-9a-f]{7,64}$/i,iS=(S)=>lG.test(S),zS=500,VS=32000,aG=16000,nG=128,oG=200,iG=2000,rG=16000,sG=80,tG=200,eG=16000;var ST=2000;var rS=20000,JS=1024,jS=2000000;var RS=64000,fS=8000,sS=4000;var tS=960000;var GT=999,TT=1e4,AS=500,_T=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],MT=["stopped","starting","ready","failed"],jT=new Set(_T),UT=(S)=>jT.has(S),ET=(S)=>S&&UT(S)?S:"HOST_REJECTED",i=(S)=>{if(S===void 0)return!1;if(S===null||S===!0||S===!1)return!0;if(String(S)===S)return!0;if(Number(S)===S)return Number.isFinite(S);if(Array.isArray(S))return S.every(i);if(Object(S)===S)return Object.values(S).every(i);return!1},AT=(S)=>i(S)&&JSON.stringify(S).length<=eG,uG=(S)=>S?.trim().slice(0,tG)??"",r=(S)=>{let _=S.id.trim().slice(0,nG),M=S.title.trim().slice(0,oG),C=S.url.trim().slice(0,iG),B=S.text?.trim().slice(0,rG),D=S.author?.trim().slice(0,sG),K=S.kind==="pull"?"pull":"issue",Q={providerId:S.providerId.trim(),id:_,title:M||_,url:C,kind:K};if(B)Q.text=B;if(D)Q.author=D;if(K==="pull"){let I=uG(S.branches?.head),x=uG(S.branches?.base);if(I&&x)Q.branches={head:I,base:x}}if(AT(S.data))Q.data=S.data;return Q},eS=(S)=>{let _=r(S);if(S.projectId)_.projectId=S.projectId;if(S.navigation)_.navigation=S.navigation;if(S.worktree)_.worktree=S.worktree;return _},SG=(S)=>{let _={text:S.text.trim().slice(0,aG)};if(S.send)_.send=!0;return _},GG=(S)=>{if(S===null||!Number.isFinite(S))return null;return Math.min(GT,Math.max(0,Math.round(S)))},TG=(S)=>{if(!Number.isFinite(S))return 0;return Math.min(TT,Math.max(0,Math.ceil(S)))};var s=(S)=>S.length>0&&S.length<=JS&&!S.includes("\x00")&&!S.includes("\\");var KS=(S)=>{if(!S.startsWith("/")||S.includes("\x00")||S.includes("\\")||S.includes("://"))return!1;if(S.length>ST)return!1;return!S.split("/").some((M)=>M==="."||M==="..")},RT=new Set(MT),_G=(S)=>Boolean(S&&"status"in S&&RT.has(String(S.status))&&!("body"in S)),IS=(S)=>Boolean(S&&"status"in S&&"body"in S&&Number.isInteger(S.status)),MG=(S)=>Boolean(S&&"content"in S&&String(S.content)===S.content),UG=(S)=>Boolean(S&&"written"in S&&S.written===!0),EG=(S)=>Boolean(S&&"entries"in S&&Array.isArray(S.entries)),fT=new Set(pG),AG=(S)=>Boolean(S&&"kind"in S&&"size"in S&&fT.has(String(S.kind))&&Number.isFinite(S.size)),OG=(S)=>Boolean(S&&"text"in S&&String(S.text)===S.text&&!("status"in S)),KT=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved"]),IT=(S)=>Object(S)===S?S:null,aS=(S)=>String(S)===S&&S.length>0,LT=(S)=>{if(!aS(S.id))return null;if(S.ok===!0){let _={channel:W,v:F,type:"result",id:S.id,ok:!0};if(Object(S.payload)===S.payload)_.payload=S.payload;return _}if(S.ok===!1&&aS(S.error))return{channel:W,v:F,type:"result",id:S.id,ok:!1,error:S.error,code:ET(aS(S.code)?S.code:void 0)};return null},XG=(S)=>{let _=IT(S);if(!_||_.channel!==W||_.v!==F)return null;if(_.type==="result")return LT(_);if(!KT.has(String(_.type))||Object(_.payload)!==_.payload)return null;return _};var OT=(S)=>("key"in S)&&("metaKey"in S)&&("ctrlKey"in S),kT=(S)=>(S.metaKey||S.ctrlKey)&&!S.altKey&&!S.shiftKey&&S.key.toLowerCase()==="s";class A extends Error{code;constructor(S,_){super(_);this.name="HostRequestError",this.code=S}}var XT=()=>Promise.reject(new A("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),LS=()=>Promise.reject(new A("BAD_PATH",`File path must be 1 to ${JS} characters without NUL or backslash.`)),kS=(S)=>{if(S===void 0)return;if(Object(S)!==S||Array.isArray(S)||S.scope!==void 0&&S.scope!=="instance"&&S.scope!=="device")throw new A("HOST_REJECTED",'Storage scope must be "instance" or "device".');return S.scope==="device"?"device":void 0},P=(S)=>{return S.value+=1,`oc-${S.value}`},PG=(S={})=>{let _=S.target??("window"in globalThis?window:null);if(!_)throw new A("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let M=S.acceptSource??((G)=>G===_.parent),C=S.requestTimeoutMs??rS,B=new Set,D=new Set,K=new Set,Q=new Set,I=new Set,x=new Set,v=new Set,XS=new Set,PS=new Set,GS=null,TS=null,CS=new Set,BS=new Set,_S=null,MS=null,bS=!1,a=new Map,n=new Map,o=new Map,h=!1,X={value:0},O=null,m=null,US=!1,ES=!1,jG=null,RG=(G)=>{if(!G)return null;return{sessionId:G.id,phase:G.busy?"started":"completed"}},q=(G)=>{_.parent.postMessage(G,"*")},L=(G,T)=>{for(let U of G)try{U(T)}catch(E){console.error(E)}},fG=(G)=>{if(!(G instanceof MessageEvent))return;if(!M(G.source))return;let T=XG(G.data);if(!T)return;if(T.type==="workspace"){let E=n.get(T.payload.subscriptionId);if(E)L([E],T.payload.snapshot);return}if(T.type==="shells"){let E=o.get(T.payload.subscriptionId);if(E)L([E],T.payload.snapshot);return}if(T.type==="ready"){if(O=T.payload,m=RG(T.payload.session),L(B,T.payload),L(D,T.payload.directory),L(K,T.payload.session),m)L(Q,m);L(I,T.payload.connection),L(x,T.payload.settings),L(v,T.payload.item);return}if(T.type==="directory"){if(O)O={...O,directory:T.payload.directory};L(D,T.payload.directory);return}if(T.type==="session"){if(O)O={...O,session:T.payload.session};if(!T.payload.session)m=null;else if(m?.sessionId!==T.payload.session.id)m=RG(T.payload.session);L(K,T.payload.session);return}if(T.type==="session-lifecycle"){m=T.payload,L(Q,T.payload);return}if(T.type==="connection"){if(O)O={...O,connection:T.payload.connection};L(I,T.payload.connection);return}if(T.type==="settings"){if(O)O={...O,settings:T.payload.settings};L(x,T.payload.settings);return}if(T.type==="item"){if(O)O={...O,item:T.payload.item};L(v,T.payload.item);return}if(T.type==="status-control-event"){L(XS,T.payload);return}if(T.type==="popover-closed"){L(PS,T.payload);return}if(T.type==="action"){let E=($)=>{if(!h)q({channel:W,v:F,type:"action-result",id:T.id,payload:$})},Y=TS;if(!Y){E({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>Y(T.payload)).then(()=>E({ok:!0}),($)=>{let f=($ instanceof Error?$.message:String($)).trim();E({ok:!1,error:(f||"Action failed.").slice(0,AS)})});return}if(T.type==="file-open"){let E=T.payload;if(MS&&mG(MS,E))return;MS=E,L(CS,T.payload);return}if(T.type==="file-saved"){L(BS,T.payload.version);return}if(T.type==="file-snapshot"){let E=(f)=>{if(!h)q({channel:W,v:F,type:"file-snapshot-result",id:T.id,payload:f})},Y=(f)=>E({error:(f.trim()||"Could not read the edited file.").slice(0,AS)}),$=_S;if(!$){Y("This extension does not edit files.");return}Promise.resolve().then(()=>$(T.payload.purpose)).then((f)=>{if(uS(f)>QS){Y(`The file is over ${QS} ${"bytes"in f?"bytes":"characters"}.`);return}if(f.version.length>ZS){Y(`The snapshot version is over ${ZS} characters.`);return}E({snapshot:"bytes"in f?{bytes:f.bytes,version:f.version}:{content:f.content,version:f.version}})},(f)=>Y(f instanceof Error?f.message:String(f)));return}if(T.type==="resolve"){let E=($)=>{q({channel:W,v:F,type:"resolve-result",id:T.id,payload:$})},Y=GS;if(!Y){E({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>Y(T.payload)).then(($)=>E({item:$?r($):null}),($)=>{let f=($ instanceof Error?$.message:String($)).trim();E({error:(f||"Command failed.").slice(0,AS)})});return}let U=a.get(T.id);if(!U)return;if(clearTimeout(U.timer),a.delete(T.id),T.ok){U.resolve(T.payload);return}U.reject(new A(T.code,T.error))};_.addEventListener("message",fG),q({channel:W,v:F,type:"hello"});let N=(G,T=C)=>{if(h||_.parent===_)return Promise.reject(new A("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((U,E)=>{let Y=setTimeout(()=>{a.delete(G.id),E(new A("HOST_TIMEOUT","Host did not answer in time."))},T);a.set(G.id,{resolve:U,reject:E,timer:Y}),q(G)})},j=(G)=>N(G).then(()=>{return}),R={channel:W,v:F},qS=(G)=>{if(!h&&_.parent!==_)q(G)},KG=()=>qS({...R,type:"file-save"}),IG=(G)=>{if(!OT(G)||!kT(G))return;G.preventDefault(),KG()},LG=(G)=>{if(!OT(G)||G.key!=="Escape"||O?.surface!=="popover"||!O.popover)return;G.preventDefault(),wG(O.popover.id,"escape").catch(()=>{return})},DS=()=>{let G=O?.surface==="popover"?O.popover:void 0;if(!G)return;let T=US||ES;if(jG===T)return;jG=T,xG(G.id,T).catch(()=>{return})},WS=()=>{if(O?.surface!=="popover"||US)return;US=!0,DS()},kG=(G)=>{if(O?.surface!=="popover"||G.relatedTarget!==null||!US)return;US=!1,DS()},HG=()=>{if(O?.surface!=="popover"||ES)return;ES=!0,DS()},NG=()=>{if(O?.surface!=="popover"||!ES)return;ES=!1,DS()},g=(G,T=1024)=>{if(!G.trim()||G.length>T)throw new A("HOST_REJECTED",`Identity must contain 1 to ${T} characters.`)},yS=async(G)=>{if(G.kind!=="projects")g(G.projectId);let T=await N({...R,type:"workspace-read",id:P(X),payload:G});if(!T||!("kind"in T)||!("state"in T)||T.kind!==G.kind)throw new A("HOST_REJECTED","Host did not return workspace data.");return T},gS=async(G,T)=>{if(G.kind!=="projects")g(G.projectId);let U=P(X);n.set(U,T);try{await j({...R,type:"workspace-subscribe",id:P(X),payload:{subscriptionId:U,query:G}})}catch(E){if(n.delete(U),!h)q({...R,type:"workspace-unsubscribe",id:P(X),payload:{subscriptionId:U}});throw E}return()=>{if(!n.delete(U)||h)return;q({...R,type:"workspace-unsubscribe",id:P(X),payload:{subscriptionId:U}})}},VT=async(G,T)=>{if(G.kind==="session")g(G.sessionId);if(G.kind==="project")g(G.projectId);let U=P(X);o.set(U,T);try{await j({...R,type:"shells-subscribe",id:P(X),payload:{subscriptionId:U,scope:G}})}catch(E){if(o.delete(U),!h)q({...R,type:"shells-unsubscribe",id:P(X),payload:{subscriptionId:U}});throw E}return()=>{if(!o.delete(U)||h)return;q({...R,type:"shells-unsubscribe",id:P(X),payload:{subscriptionId:U}})}},FS=async(G)=>{if("key"in G&&(G.key.length===0||G.key.length>cS))throw new A("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(G.op==="set"&&!i(G.value))throw new A("HOST_REJECTED","Storage values must be JSON.");if(G.op==="set"&&new TextEncoder().encode(JSON.stringify(G.value)).length>dS)throw new A("HOST_REJECTED","Storage value exceeds 64 KiB.");if(G.scope==="device"&&O?.features?.deviceStorage!==!0)throw new A("UNSUPPORTED","This host does not support device storage.");let T=await N({...R,type:"storage",id:P(X),payload:G});if(!T||!("storage"in T)||T.op!==G.op)throw new A("HOST_REJECTED","Host did not return storage data.");return T},wG=(G,T)=>O?.features?.popovers!==!0&&!(O?.surface==="popover"&&O.popover?.id===G)?Promise.reject(new A("UNSUPPORTED","This host does not support popovers.")):j({...R,type:"popover-close",id:P(X),payload:T?{id:G,reason:T}:{id:G}}),xG=(G,T)=>O?.features?.popovers!==!0&&!(O?.surface==="popover"&&O.popover?.id===G)?Promise.reject(new A("UNSUPPORTED","This host does not support popovers.")):j({...R,type:"popover-anchor",id:P(X),payload:{id:G,active:T}});return _.addEventListener("keydown",LG,!0),_.addEventListener("pointerover",WS),_.addEventListener("pointermove",WS),_.addEventListener("pointerout",kG),_.addEventListener("focus",HG),_.addEventListener("blur",NG),{onAction:(G)=>{return TS=G,()=>{if(TS===G)TS=null}},listProjects:async()=>{let G=await yS({kind:"projects"});if(G.kind!=="projects")throw new A("HOST_REJECTED","Expected projects.");return G},listWorktrees:async(G)=>{let T=await yS({kind:"worktrees",projectId:G});if(T.kind!=="worktrees")throw new A("HOST_REJECTED","Expected worktrees.");return T},listSessions:async(G)=>{let T=await yS({kind:"sessions",projectId:G});if(T.kind!=="sessions")throw new A("HOST_REJECTED","Expected sessions.");return T},onProjects:(G)=>gS({kind:"projects"},(T)=>{if(T.kind==="projects")G(T)}),onWorktrees:(G,T)=>gS({kind:"worktrees",projectId:G},(U)=>{if(U.kind==="worktrees")T(U)}),onSessions:(G,T)=>gS({kind:"sessions",projectId:G},(U)=>{if(U.kind==="sessions")T(U)}),onRunningShells:(G,T)=>VT(G,T),readShellOutput:async(G,T)=>{g(G,$S);let U=T?.cursor;if(U!==void 0&&(!Number.isInteger(U)||U<0))throw new A("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let E=T?.tailBytes;if(E!==void 0&&(!Number.isInteger(E)||E<1||E>YS))throw new A("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${YS}.`);let $=await N({...R,type:"shell-output",id:P(X),payload:{shellId:G,cursor:U,tailBytes:E}});if(!$||typeof $.output!=="string"||!Number.isFinite($.cursor))throw new A("HOST_REJECTED","Host did not return shell output.");return $},stopShell:async(G)=>{if(g(G,$S),(await N({...R,type:"shell-stop",id:P(X),payload:{shellId:G}}))?.stopped!==!0)throw new A("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(G)=>{g(G),await j({...R,type:"open-session",id:P(X),payload:{sessionId:G}})},storage:{get:async(G,T)=>{let U=kS(T),E={op:"get",key:G};if(U)E.scope=U;let Y=await FS(E);return Y.op==="get"&&Y.found?Y.value:void 0},set:async(G,T,U)=>{let E=kS(U),Y={op:"set",key:G,value:T};if(E)Y.scope=E;await FS(Y)},delete:async(G,T)=>{let U=kS(T),E={op:"delete",key:G};if(U)E.scope=U;await FS(E)},keys:async(G)=>{let T=kS(G),U={op:"keys"};if(T)U.scope=T;let E=await FS(U);if(E.op!=="keys")throw new A("HOST_REJECTED","Expected storage keys.");return E.keys}},onReady:(G)=>{if(B.add(G),O)G(O);return()=>{B.delete(G)}},onDirectory:(G)=>{if(D.add(G),O)G(O.directory);return()=>{D.delete(G)}},onSession:(G)=>{if(K.add(G),O)G(O.session);return()=>{K.delete(G)}},onSessionLifecycle:(G)=>{if(Q.add(G),m)G(m);return()=>{Q.delete(G)}},onConnection:(G)=>{if(I.add(G),O)G(O.connection);return()=>{I.delete(G)}},onSettings:(G)=>{if(x.add(G),O)G(O.settings);return()=>{x.delete(G)}},onItem:(G)=>{if(v.add(G),O)G(O.item);return()=>{v.delete(G)}},onStatusControl:(G)=>{return XS.add(G),()=>{XS.delete(G)}},onPopoverClosed:(G)=>{return PS.add(G),()=>{PS.delete(G)}},setStatusControls:(G)=>{if(O?.features?.statusControls!==!0)return Promise.reject(new A("UNSUPPORTED","This host does not support status controls."));if(!hG(G))return Promise.reject(new A("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return j({...R,type:"status-controls",id:P(X),payload:{controls:G}})},openPopover:(G)=>{if(O?.features?.popovers!==!0)return Promise.reject(new A("UNSUPPORTED","This host does not support popovers."));if(!lS(G))return Promise.reject(new A("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return j({...R,type:"popover-open",id:P(X),payload:G})},closePopover:wG,setPopoverAnchorActive:xG,onResolve:(G)=>{return GS=G,()=>{if(GS===G)GS=null}},toast:(G)=>{let T=G.message.trim();if(!T||T.length>zS)return Promise.reject(new A("HOST_REJECTED",`Toast message must contain 1 to ${zS} characters.`));if(G.copy&&G.copy!==!0&&(!G.copy.text.length||G.copy.text.length>VS))return Promise.reject(new A("HOST_REJECTED",`Toast copy text must contain 1 to ${VS} characters.`));return j({channel:W,v:F,type:"toast",id:P(X),payload:{...G,message:T}})},openUrl:(G)=>j({channel:W,v:F,type:"open-url",id:P(X),payload:{url:G}}),openCommit:(G)=>iS(G)?j({channel:W,v:F,type:"open-commit",id:P(X),payload:{sha:G}}):Promise.reject(new A("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(G)=>j({channel:W,v:F,type:"open-surface",id:P(X),payload:{surfaceId:G}}),writeClipboard:(G)=>j({channel:W,v:F,type:"clipboard-write",id:P(X),payload:{text:G}}),compose:(G)=>j({channel:W,v:F,type:"compose",id:P(X),payload:G}),attach:(G)=>j({channel:W,v:F,type:"attach",id:P(X),payload:r(G)}),startSession:async(G)=>{if(G.projectId!==void 0)g(G.projectId);let T=G.worktree;if(T&&T!==!0)if(T.kind==="existing")g(T.directory);else{if(T.name!==void 0)g(T.name,200);if(T.baseBranch!==void 0)g(T.baseBranch,200)}let U=await N({channel:W,v:F,type:"start-session",id:P(X),payload:eS(G)},S.requestTimeoutMs??180000);if(!nS(U))throw new A("HOST_REJECTED","Host did not return a session.");return U},prompt:(G)=>N({channel:W,v:F,type:"prompt",id:P(X),payload:SG(G)}).then((T)=>{if(!oS(T))throw new A("HOST_REJECTED","Host did not return a prompt result.");return T}),sessionLink:(G)=>j({channel:W,v:F,type:"session-link",id:P(X),payload:r(G)}),close:()=>j({channel:W,v:F,type:"close",id:P(X)}),oauthStart:()=>j({channel:W,v:F,type:"oauth-start",id:P(X)}),oauthDisconnect:()=>j({channel:W,v:F,type:"oauth-disconnect",id:P(X)}),request:(G)=>(KS(G.path)?N({channel:W,v:F,type:"request",id:P(X),payload:G}):XT()).then((T)=>{if(!IS(T))throw new A("HOST_REJECTED","Host request result was empty.");return T}),serviceRequest:(G)=>(KS(G.path)?N({channel:W,v:F,type:"service-request",id:P(X),payload:G}):XT()).then((T)=>{if(!IS(T))throw new A("HOST_REJECTED","Host service request result was empty.");return T}),serviceStatus:()=>N({channel:W,v:F,type:"service-status",id:P(X)}).then((G)=>{if(!_G(G))throw new A("HOST_REJECTED","Host did not return service status.");return G}),readFile:(G)=>(s(G)?N({channel:W,v:F,type:"file-read",id:P(X),payload:{path:G}}):LS()).then((T)=>{if(!MG(T))throw new A("HOST_REJECTED","Host did not return file content.");return T}),writeFile:(G,T)=>{if(!s(G))return LS();if(T.length>jS)return Promise.reject(new A("FILE_TOO_LARGE",`Content is over ${jS} characters.`));return N({channel:W,v:F,type:"file-write",id:P(X),payload:{path:G,content:T}}).then((U)=>{if(!UG(U))throw new A("HOST_REJECTED","Host did not confirm the write.");return U})},listDir:(G)=>(s(G)?N({channel:W,v:F,type:"file-list",id:P(X),payload:{path:G}}):LS()).then((T)=>{if(!EG(T))throw new A("HOST_REJECTED","Host did not return directory entries.");return T}),stat:(G)=>(s(G)?N({channel:W,v:F,type:"file-stat",id:P(X),payload:{path:G}}):LS()).then((T)=>{if(!AG(T))throw new A("HOST_REJECTED","Host did not return file status.");return T}),generate:(G)=>{let T=G.prompt.trim(),U=G.system?.trim();if(T.length===0||T.length>RS)return Promise.reject(new A("HOST_REJECTED",`Prompt must be 1 to ${RS} characters.`));if(U!==void 0&&(U.length===0||U.length>fS))return Promise.reject(new A("HOST_REJECTED",`System prompt must be 1 to ${fS} characters.`));let E=G.maxOutputTokens===void 0?void 0:Math.min(sS,Math.max(1,Math.floor(G.maxOutputTokens)));if(E!==void 0&&!Number.isFinite(E))return Promise.reject(new A("HOST_REJECTED","maxOutputTokens must be a number."));let Y={prompt:T};if(U!==void 0)Y.system=U;if(E!==void 0)Y.maxOutputTokens=E;return N({channel:W,v:F,type:"generate",id:P(X),payload:Y},S.requestTimeoutMs??tS).then(($)=>{if(!OG($))throw new A("HOST_REJECTED","Host did not return generated text.");return $})},setBadge:(G)=>j({channel:W,v:F,type:"badge",id:P(X),payload:{count:GG(G)}}),setHeight:(G)=>j({channel:W,v:F,type:"resize",id:P(X),payload:{height:TG(G)}}),onFileOpen:(G)=>{if(CS.add(G),!bS)bS=!0,_.addEventListener("keydown",IG,!0);if(MS)G(MS);return()=>{CS.delete(G)}},onFileSnapshot:(G)=>{return _S=G,()=>{if(_S===G)_S=null}},onFileSaved:(G)=>{return BS.add(G),()=>{BS.delete(G)}},reportFileChange:(G)=>qS({...R,type:"file-change",payload:{dirty:G.dirty,edited:G.edited}}),requestFileSave:KG,reportFileUnsupported:()=>qS({...R,type:"file-unsupported"}),dispose:()=>{for(let G of n.keys())q({...R,type:"workspace-unsubscribe",id:P(X),payload:{subscriptionId:G}});n.clear();for(let G of o.keys())q({...R,type:"shells-unsubscribe",id:P(X),payload:{subscriptionId:G}});if(o.clear(),h=!0,GS=null,TS=null,_S=null,CS.clear(),BS.clear(),bS)_.removeEventListener("keydown",IG,!0);_.removeEventListener("message",fG),_.removeEventListener("keydown",LG,!0),_.removeEventListener("pointerover",WS),_.removeEventListener("pointermove",WS),_.removeEventListener("pointerout",kG),_.removeEventListener("focus",HG),_.removeEventListener("blur",NG);for(let G of a.values())clearTimeout(G.timer),G.reject(new A("HOST_UNAVAILABLE","Host client was disposed."));a.clear(),B.clear(),D.clear(),K.clear(),Q.clear(),I.clear(),x.clear(),v.clear(),XS.clear(),PS.clear()}}};var PT=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize"];var A_=new Set(PT);var CT=["none","agent","user"];var X_=new Set(CT);var HT=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],NT=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],BT=(S,_)=>{_.style.colorScheme=S.mode;for(let[M,C]of HT)_.style.setProperty(M,S.tokens[C]);for(let[M,C,B]of NT){let D=S.tokens[B]??"";_.style.setProperty(M,D),_.style.setProperty(C,D)}_.style.setProperty("font-family",S.tokens.font),_.style.setProperty("font-size","0.875rem"),_.style.setProperty("line-height","1.45"),_.style.setProperty("color",S.tokens.foreground)},CG=(S,_)=>{if(BT(S.theme,_),_.dataset)_.dataset.ocSurface=S.surface,_.dataset.ocTheme=S.theme.mode};var wT={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},V=(S,_)=>`var(--${S}, var(--oc-${wT[S]}, ${_}))`,p=V("surface-background","transparent"),OS=V("surface-elevated","transparent"),t=V("surface-elevated-foreground","inherit"),y=V("surface-foreground","inherit"),Z=V("surface-muted-foreground","gray"),xT=V("surface-muted","transparent"),c=V("interactive-border","currentColor"),w=V("interactive-hover","transparent"),l=V("interactive-active","transparent"),BG=V("interactive-selection","transparent"),DG=V("interactive-selection-foreground","inherit"),d=V("primary","currentColor"),WG=V("primary-text","inherit"),FG=V("error-text","inherit"),bT=V("font-sans","inherit"),$G=V("font-mono","monospace"),$T=V("radius","9px"),YG=`calc(${$T} - 2px)`,DT=`calc(${$T} - 4px)`,z=(S,_,M="transparent")=>`color-mix(in srgb, ${S} ${_}%, ${M})`,WT=`background-image: linear-gradient(${w}, ${w});`,QG=(S)=>`box-shadow: inset 0 0 0 1px ${S}, inset 0 1px 2px 0 rgb(0 0 0 / 0.05);`,ZG=`box-shadow: inset 0 0 0 1px ${z(y,10)}, 0 1px 2px 0 rgb(0 0 0 / 0.12);`,FT="box-shadow: inset 0 1px 0 0 rgb(255 255 255 / 0.12), 0 1px 2px 0 rgb(0 0 0 / 0.14);",HS=(S)=>{let _=V(`status-${S}`,"currentColor");return`
.oc-sdk[data-tone="${S}"], .oc-sdk [data-tone="${S}"] { --oc-sdk-tone: ${_}; --oc-sdk-tone-text: ${V(`${S}-text`,"inherit")}; }`},qT=`
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
`,YT=`
.oc-sdk { color: ${y}; font-family: ${bT}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${WT} }
.oc-sdk-mono { font-family: ${$G}; }
.oc-sdk-muted { color: ${Z}; }
${HS("success")}${HS("warning")}${HS("error")}${HS("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${d}; --oc-sdk-tone-text: ${WG}; }

.oc-sdk-btn { border-radius: ${YG}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${DT}; }
.oc-sdk-btn[data-variant="default"] { color: ${WG}; background: ${z(d,10,p)}; border-color: ${z(d,12)}; ${FT} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${z(d,16,p)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${z(d,22,p)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${xT}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${l}, ${l}); }
.oc-sdk-btn[data-variant="outline"] { background: ${OS}; color: ${t}; border-color: transparent; ${ZG} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${l}, ${l}); box-shadow: inset 0 0 0 1px ${z(y,10)}; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${w}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${l}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${V("status-error","red")}; color: ${FG}; background: ${z("var(--oc-sdk-tone)",7,p)}; border-color: ${z("var(--oc-sdk-tone)",12)}; ${FT} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${z("var(--oc-sdk-tone)",9,p)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${z("var(--oc-sdk-tone)",11,p)}; box-shadow: none; }

.oc-sdk-field-note { color: ${Z}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${FG}; }
.oc-sdk-input { border-radius: ${YG}; background: ${OS}; color: ${t}; ${QG(z(y,10))} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${Z}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${QG(z(y,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${QG(V("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${$G}; }

.oc-sdk-search-icon { color: ${Z}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${d}; }
.oc-sdk-search-clear { border-radius: ${DT}; color: ${Z}; }
.oc-sdk-search-clear:hover { background: ${w}; color: ${y}; }

.oc-sdk-trigger { border-color: transparent; border-radius: ${YG}; background: ${OS}; color: ${t}; ${ZG} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${w}, ${w}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${l}, ${l}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${Z}; }
.oc-sdk-trigger-chevron { color: ${Z}; }
.oc-sdk-popup { --surface-foreground: ${t}; border-color: ${z(c,60)}; border-radius: 12px; background: ${OS}; color: ${t}; box-shadow: 0 8px 24px ${z(y,12)}; }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${w}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${BG}; color: ${DG}; }
.oc-sdk-option-check { color: ${y}; }
.oc-sdk-option[data-destructive="true"] { color: ${FG}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${z(V("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${Z}; }
.oc-sdk-popup-empty { color: ${Z}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${c}; border-radius: 4px; color: ${y}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${z(y,60,c)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${c}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${p}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${d}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${WT} }
.oc-sdk-check-desc { color: ${Z}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${z(y,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${Z}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${y}; }
.oc-sdk-tab[aria-selected="true"] { color: ${DG}; background: ${BG}; border-color: ${c}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${t}; background: ${OS}; border-color: transparent; ${ZG} }
.oc-sdk-tab-count { color: ${Z}; }

.oc-sdk-badge { border-radius: 9999px; background: ${w}; color: ${Z}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${z("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${w}; }
.oc-sdk-row[aria-selected="true"] { background: ${BG}; color: ${DG}; }
.oc-sdk-row-lead { font-family: ${$G}; color: ${Z}; }
.oc-sdk-row-sub { color: ${Z}; }
.oc-sdk-row-meta { color: ${Z}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${Z}; }

.oc-sdk-empty-body { color: ${Z}; }

.oc-sdk-spinner { color: ${Z}; }
.oc-sdk-spinner-ring { border-color: ${c}; border-top-color: ${d}; border-radius: 9999px; }

.oc-sdk-banner { border-color: ${z("var(--oc-sdk-tone)",40)}; border-radius: 8px; background: ${z("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${Z}; }

.oc-sdk-separator { color: ${Z}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${z(c,40)}; }

.oc-sdk-progress-label { color: ${Z}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${c}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${d}); }

.oc-sdk-text a { color: ${WG}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${z(c,60)}; }
`,k=`
${hS}
${qT}
${YT}`;var QT="oc-sdk-ui-style";var H=(S)=>{let _=document.getElementById(QT);if(_ instanceof HTMLStyleElement){if(_.textContent!==S)_.textContent=S;return}mS(document);let M=document.createElement("style");M.id=QT,M.textContent=S,document.head.appendChild(M)},J=(S,_)=>{let M=document.createElement(S);if(_)M.className=_;return M},u=(S)=>{let _=J("button",S);return _.type="button",_},b=(S,_)=>{let M=_??"";if(S.textContent!==M)S.textContent=M},e=(S,_,M)=>{if(M===void 0||M===null||M==="")S.removeAttribute(_);else if(S.getAttribute(_)!==M)S.setAttribute(_,M)};var yT=()=>{let S=document.createElement("span");return S.className="oc-sdk-spinner-ring",S.setAttribute("aria-hidden","true"),S},SS=(S,_)=>{H(k);let M=_,C=u("oc-sdk oc-sdk-btn"),B=yT(),D=document.createElement("span");C.append(D),S.append(C);let K=()=>{if(C.dataset.variant=M.variant??"default",C.dataset.size=M.size??"default",C.disabled=Boolean(M.disabled)||Boolean(M.loading),C.dataset.loading=M.loading?"true":"false",C.setAttribute("aria-busy",M.loading?"true":"false"),M.loading&&B.parentNode!==C)C.prepend(B);else if(!M.loading&&B.parentNode===C)B.remove();b(D,M.label)},Q=()=>{if(M.disabled||M.loading)return;M.onClick()};return C.addEventListener("click",Q),K(),{update:(I)=>{M={...M,...I},K()},dispose:()=>{C.removeEventListener("click",Q),C.remove()}}};var zG=(S,_)=>{H(k);let M=_,C=J("label","oc-sdk oc-sdk-field"),B=J("span","oc-sdk-field-label"),D=M.multiline?J("textarea","oc-sdk-input"):J("input","oc-sdk-input"),K=J("span","oc-sdk-field-note");C.append(B,D,K),S.append(C);let Q=()=>{if(b(B,M.label),B.hidden=!M.label,D instanceof HTMLInputElement)D.type=M.password?"password":"text";else D.rows=M.rows??3;if(D.value!==M.value)D.value=M.value;D.disabled=Boolean(M.disabled),e(D,"placeholder",M.placeholder),D.dataset.mono=M.mono?"true":"false";let x=Boolean(M.error);C.dataset.invalid=x?"true":"false",D.setAttribute("aria-invalid",x?"true":"false");let v=M.error??M.helper??"";b(K,v),K.hidden=v===""},I=()=>{M.onChange(D.value)};return D.addEventListener("input",I),Q(),{update:(x)=>{M={...M,...x},Q()},dispose:()=>{D.removeEventListener("input",I),C.remove()}}};var JG=PG(),zT=document.querySelector("#root");if(!zT)throw Error("Missing root");var ZT=!1;JG.onReady((S)=>{if(CG(S,document.documentElement),ZT)return;ZT=!0;let _=document.createElement("div");_.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",zT.append(_);let M="",C=document.createElement("div");C.style.flex="1",_.append(C);let B=zG(C,{value:M,placeholder:"https://example.com",mono:!0,onChange:(Q)=>{M=Q,B.update({value:Q})}}),D=SS(_,{label:"Go",size:"sm",onClick:()=>{if(!M.trim())return;D.update({loading:!0}),JG.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:M.trim()})}).then(()=>K()).finally(()=>D.update({loading:!1}))}}),K=async()=>{try{let Q=await JG.serviceRequest({method:"GET",path:"/state"}),I=JSON.parse(Q.body);if(String(I.url)===I.url&&I.url!==M)M=I.url==="about:blank"?"":I.url,B.update({value:M})}catch{}};K(),setInterval(()=>{K()},2000)});})();
